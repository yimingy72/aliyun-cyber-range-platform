import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { OpenTofuRunner, type OpenTofuCommandResult, type OpenTofuWorkspaceCommandOptions, type OpenTofuPlanOptions, type OpenTofuApplyOptions } from '@aliyun-cyber-range/iac-runner';
import type { AdminRepository, RangeInstanceRecord, SingleInstanceBatchWithInstancesRecord, SingleInstanceConfig, RangeResourceSummary, HostCloudReleaseDeadline } from './admin.repository';
import { SingleInstanceBatchExecutionService, patchRuntimeTopologyGraph, type SingleInstanceExecutionItem, type NormalizedInstanceDetail, patchRuntimeScenarioTemplate, patchRuntimeCompiledProvisionSpec } from './single-instance-batch-execution.service';
import { SystemConfigService, type SystemCloudAccountContext } from './system-config.service';
import { buildBillingTags } from './billing-tagging';
import { syncRangeInstanceBillingLedger, releaseRangeInstanceBillingLedger } from './billing-ledger-sync';
import { readProvenSingleInstanceIds } from './single-instance-resource-origin';
import { assertTencentImagesAvailable } from '../provisioning/tencent-cloud-zone-instance-scheduler';
import { describeTencentResourceInventory } from './tencent-cloud-resources';
import { buildTencentSingleCreationIntent } from '../provisioning/tencent-cloud-identity';
import { TencentCloudOpenTofuRenderer, TENCENTCLOUD_PROVIDER_VERSION } from '../provisioning/renderers/tencent-cloud-opentofu-renderer';
import * as mirrors from '../provisioning/provider-mirror-publication';
import { createHostCloudReleaseDeadline, assertCloudReleaseDeadlineCanCreate, verifyCloudReleaseDeadlines } from '../provisioning/cloud-release-deadlines';
import { hasVerifiedSystemDiskReleasePolicy } from './instance-disk-inventory';

export type SingleInstanceOpenTofuBatchLease = { batchId: string; assertCurrent(): Promise<void>; signal: AbortSignal };
type CommandOptions = OpenTofuWorkspaceCommandOptions & { signal?: AbortSignal; upgrade?: boolean };
type ResourceAppliedEvent = { address: string; resourceType: string; action: 'create' | 'update' | 'delete'; resourceId: string };
type PlanOptions = OpenTofuPlanOptions & { signal?: AbortSignal; targets?: string[]; destroy?: boolean };
type BatchRunner = {
  init(options: CommandOptions): Promise<OpenTofuCommandResult>;
  plan(options: PlanOptions): Promise<OpenTofuCommandResult>;
  apply(options: OpenTofuApplyOptions & { signal?: AbortSignal; onResourceApplied?: (event: ResourceAppliedEvent) => void }): Promise<OpenTofuCommandResult>;
  showPlan?<T>(options: CommandOptions & { planFilePath: string }): Promise<T>;
  output<T>(options: CommandOptions): Promise<T>;
};
export type SingleInstanceOpenTofuExecutionOptions = { projectRootDir?: string; workspacesRootDir?: string; env?: NodeJS.ProcessEnv; runner?: BatchRunner };
type Config = SingleInstanceConfig & { executionBackend?: string };
type Identity = { provider?: 'tencent_cloud'; vpcId?: string; batchId: string; ownerId: string | null; contextId: string; accountUid: string; region: string; zone: string; profileId: string; securityGroupId: string };
type Definition = { instance_name: string; host_name: string; instance_type: string; image_id: string; vswitch_id: string;
  system_disk_category: string; client_token?: string; system_disk_size: number; internet_max_bandwidth_out: number; auto_release_time: string; tags: Record<string, string> };
type CatalogMember = { definition: Definition; password: string; hostKey: string; sourceJobId: string; cloudReleaseDeadline?: HostCloudReleaseDeadline };
type PendingOperation = { submittedAt?: string; kind: 'create' | 'destroy'; ids: string[]; jobIds: string[]; recoveryIds?: string[]; createIds?: string[]; knownIds?: Record<string, string[]> };
type Manifest = { schemaVersion: 1; identity: Identity; members: Record<string, CatalogMember>; pending?: PendingOperation };
type StateMember = { id: string; diskId: string; privateIp: string | null; publicIp: string | null; status: string; tainted: boolean; tags: Record<string, string> };
type Plan = { format_version: string; resource_changes?: Array<{ address: string; type: string; mode?: string; change: { actions: string[] } }> };
type Context = { lease: SingleInstanceOpenTofuBatchLease; items: SingleInstanceExecutionItem[]; batch: SingleInstanceBatchWithInstancesRecord;
  account: SystemCloudAccountContext; manifest: Manifest; workspace: string; secrets: string[]; env: NodeJS.ProcessEnv; state: Map<string, StateMember>; knownIds: Map<string, string[]> };
const MODULE_PATH = 'infra/opentofu/modules/alicloud-single-instance-batch';
function modulePath(context: Context) { return context.manifest.identity.provider === 'tencent_cloud' ? 'infra/opentofu/modules/tencentcloud-single-instance-batch' : MODULE_PATH; }
function batchResourceSummary(context: Context): RangeResourceSummary {
  const identity = context.manifest.identity;
  return { mode: 'opentofu', modulePath: modulePath(context), workspaceDir: context.workspace,
    executionContext: { provider: identity.provider ?? 'alibaba_cloud', cloudAccountContextId: identity.contextId, cloudAccountUid: identity.accountUid, regionId: identity.region, zoneId: identity.zone } };
}
function resourceType(context: Context) { return context.manifest.identity.provider === 'tencent_cloud' ? 'tencentcloud_instance' : 'alicloud_instance'; }
function validCloudId(context: Context, id: string) { return (context.manifest.identity.provider === 'tencent_cloud' ? /^ins-[a-z0-9]+$/ : /^i-[A-Za-z0-9-]{1,125}$/).test(id); }
const MANIFEST_FILE = 'single-batch-manifest.json';
const APPLY_MARKER = '.single-batch-apply-started';
const CURRENT_STATUSES = new Set(['pending_create', 'creating', 'running']);

export class SingleInstanceOpenTofuLeaseLostError extends Error {}
class UnsafeSimulationError extends Error {}
export class SingleInstanceOpenTofuExecutionService {
  private readonly runner: BatchRunner;
  private readonly env: NodeJS.ProcessEnv;
  private readonly projectRoot: string;
  private readonly workspaceRoot: string;
  constructor(private readonly repository: AdminRepository, private readonly config: SystemConfigService,
    private readonly native: SingleInstanceBatchExecutionService, options: SingleInstanceOpenTofuExecutionOptions = {}) {
    this.env = { ...process.env, ...options.env };
    this.projectRoot = options.projectRootDir ?? process.cwd();
    this.workspaceRoot = options.workspacesRootDir ?? path.resolve(this.projectRoot, this.env.OPENTOFU_WORKSPACES_ROOT ?? '.local/opentofu-workspaces');
    this.runner = options.runner ?? new OpenTofuRunner({ binaryPath: this.env.OPENTOFU_BINARY ?? 'tofu',
      parallelism: Number(this.env.OPENTOFU_SINGLE_INSTANCE_PARALLELISM?.trim() || 20) }) as BatchRunner;
  }

  async executeCreateBatch(items: SingleInstanceExecutionItem[], lease: SingleInstanceOpenTofuBatchLease) {
    if (!items.length) return;
    let context: Context | undefined;
    try {
      context = await this.prepare(items, lease);
      if (this.env.RANGE_PROVISIONER_MODE === 'dry-run') { await this.assertSimulationSafe(context); await this.simulate(context, false); return; }
      const valid = [] as SingleInstanceExecutionItem[];
      for (const item of items) if (await this.itemCurrent(item)) valid.push(item);
      if (!valid.length) return;
      if (valid.some(item => isExpired(item.instance))) throw new Error('Single-instance launch expired before OpenTofu creation');
      if (context.account.provider === 'tencent_cloud') {
        const metadata = await this.command(context, () => assertTencentImagesAvailable(context!.account,valid.map(item => item.instance.singleInstanceConfig!.imageId)));
        if (valid.some(item => item.instance.singleInstanceConfig!.systemDiskSize < metadata[item.instance.singleInstanceConfig!.imageId].minimumSystemDiskSize)) throw new Error('Frozen Tencent system disk is smaller than the current image minimum');
      }
      if (context.manifest.pending || await exists(path.join(context.workspace, APPLY_MARKER))) {
        await this.recoverPartialCreate(context, valid, 'Interrupted OpenTofu operation requires recovery before creation');
        return;
      }
      if (valid.some(item => !context!.state.has(item.instance.id) && (context!.knownIds.get(item.instance.id)?.length ?? 0) > 0)) {
        await this.cleanupUntracked(context, valid, 'Known OpenTofu members have lost their durable state');
        await this.finishOperation(context);
        return;
      }
      if (!context.state.size && context.batch.instances.some(member => Object.keys(member.resourceSummary?.hostIds ?? {}).length)) {
        throw new Error('Existing OpenTofu resources have lost batch state; recovery is required before new creation');
      }
      for (const item of valid) if (!context.state.has(item.instance.id)) {
        const member = context.manifest.members[item.instance.id];
        member.sourceJobId = item.job.id;
        member.definition.tags.PlatformCreateJobId = item.job.id;
        if (context.manifest.identity.provider === 'tencent_cloud') {
          member.definition.client_token = buildTencentSingleCreationIntent(item.instance, item.job.id);
          member.definition.tags.CreationIntentId = member.definition.client_token;
        }
      }
      await this.writeInputs(context);
      const prepared = context;
      await this.command(prepared, () => this.runner.init({ ...this.commandOptions(prepared), upgrade: true }));
      await this.freezeHostDeadlines(context, valid);
      await this.writeInputs(context);
      const ids = valid.map(item => item.instance.id);
      await this.applyPlan(context, ids, false);
      context.state = await this.readState(context);
      await this.completeCreated(context, valid, false);
      await this.finishOperation(context);
    } catch (error) {
      if (error instanceof SingleInstanceOpenTofuLeaseLostError) throw error;
      if (error instanceof UnsafeSimulationError) { await this.assertLease(lease); await this.markFailures(items, error.message, true); return; }
      if (!context) { await this.assertLease(lease); await this.markFailures(items, 'OpenTofu batch preparation failed; frozen resource material was preserved', true); return; }
      await this.assertLease(context.lease);
      await this.recoverPartialCreate(context, items, sanitize(error, context.secrets));
    }
  }

  async executeDestroyBatch(items: SingleInstanceExecutionItem[], lease: SingleInstanceOpenTofuBatchLease) {
    const legacy = items.filter(item => backend(item.instance) !== 'opentofu');
    if (legacy.length) await this.native.executeDestroyBatch(legacy);
    const targets = items.filter(item => backend(item.instance) === 'opentofu');
    if (!targets.length) return;
    let context: Context | undefined;
    try {
      context = await this.prepare(targets, lease);
      if (this.env.RANGE_PROVISIONER_MODE === 'dry-run' || targets.every(item => item.instance.resourceSummary?.mode === 'dry-run')) {
        await this.assertSimulationSafe(context);
        await this.simulate(context, true); return;
      }
      const valid: SingleInstanceExecutionItem[] = [];
      for (const item of targets) if (await this.itemCurrent(item)) valid.push(item);
      if (!valid.length) return;
      const tracked = valid.filter(item => context!.state.has(item.instance.id));
      if (tracked.length) {
        await this.rememberTrackedResources(context, tracked, true);
        await this.writeInputs(context);
        const prepared = context;
        await this.command(prepared, () => this.runner.init({ ...this.commandOptions(prepared), upgrade: true }));
        await this.applyPlan(context, tracked.map(item => item.instance.id), true);
        context.state = await this.readState(context);
      }
      for (const item of tracked) {
        await this.assertLease(lease);
        if (!await this.itemCurrent(item)) continue;
        if (context.state.has(item.instance.id)) throw new Error('OpenTofu state still contains the requested member');
        await this.assertAbsent(context, item);
        await this.finishDestroyed(item);
      }
      await this.cleanupUntracked(context, valid.filter(item => !tracked.includes(item)), 'OpenTofu state is unavailable for requested member destruction', true);
      await this.finishOperation(context);
    } catch (error) {
      if (error instanceof SingleInstanceOpenTofuLeaseLostError) throw error;
      if (context) await this.assertLease(context.lease);
      await this.assertLease(lease);
      await this.markFailures(targets, context ? sanitize(error, context.secrets) : 'OpenTofu batch preparation failed; frozen resource material was preserved', true);
    }
  }

  private async prepare(items: SingleInstanceExecutionItem[], lease: SingleInstanceOpenTofuBatchLease): Promise<Context> {
    await this.assertLease(lease);
    const first = items[0].instance;
    if (!first.singleInstanceBatchId || lease.batchId !== first.singleInstanceBatchId || items.some(item => item.instance.singleInstanceBatchId !== lease.batchId
      || item.job.rangeInstanceId !== item.instance.id || backend(item.instance) !== 'opentofu')) {
      throw new Error('A bound OpenTofu batch and its active lease are required');
    }
    const batch = await this.getBatch(lease.batchId);
    if (!batch) throw new Error('OpenTofu batch not found');
    const account = await this.native.resolveInstanceAccount(first);
    const cfg = first.singleInstanceConfig as Config;
    if (!account.accountUid || !account.cloudAccountContextId || !account.accountUidResolved || !cfg.networkProfileId) throw new Error('OpenTofu launch must have a verified frozen account and network profile');
    const profile = await this.repository.getSingleInstanceNetworkProfileById(cfg.networkProfileId);
    if (!['alibaba_cloud', 'tencent_cloud'].includes(account.provider) || first.cloudProvider !== account.provider) throw new Error('OpenTofu batch cloud provider differs from frozen account');
    if (!profile || profile.provider !== account.provider || profile.status !== 'ready' || profile.cloudAccountUid !== account.accountUid || profile.regionId !== account.defaultRegion
      || profile.zoneId !== cfg.zoneId || profile.cloudAccountContextId !== account.cloudAccountContextId) throw new Error('OpenTofu network does not match frozen launch identity');
    const identity: Identity = { ...(account.provider === 'tencent_cloud' ? { provider: 'tencent_cloud' as const, vpcId: profile.vpcId } : {}), batchId: lease.batchId, ownerId: batch.batch.ownerUserId, contextId: account.cloudAccountContextId,
      accountUid: account.accountUid, region: account.defaultRegion, zone: profile.zoneId, profileId: profile.id, securityGroupId: profile.securityGroupId };
    for (const member of batch.instances) {
      const config = member.singleInstanceConfig as Config | null;
      if (member.cloudProvider !== account.provider || !config || backend(member) !== 'opentofu' || member.ownerUserId !== identity.ownerId || config.cloudAccountContextId !== identity.contextId
        || config.cloudAccountUid !== identity.accountUid || config.regionId !== identity.region || config.zoneId !== identity.zone || config.networkProfileId !== profile.id
        || !config.assignedVswitchId || !profile.vswitchIds.includes(config.assignedVswitchId)) throw new Error('Batch contains a member outside its immutable owner/account/network scope');
    }
    const key = `single-instance-batch-${createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 40)}`;
    const workspace = path.join(this.workspaceRoot, key);
    await this.assertLease(lease);
    if (await exists(path.join(workspace, '.terraform.tfstate.lock.info'))) throw new Error('OpenTofu workspace has an active or unrecovered state lock');
    await this.assertCompleteStateMaterial(workspace);
    let manifest = await readJson<Manifest>(path.join(workspace, MANIFEST_FILE));
    if (!manifest && await exists(path.join(workspace, 'terraform.tfstate'))) throw new Error('Unregistered state cannot be adopted by a new batch');
    if (manifest && (manifest.schemaVersion !== 1 || !manifest.members || typeof manifest.members !== 'object' || Array.isArray(manifest.members)
      || JSON.stringify(manifest.identity) !== JSON.stringify(identity))) throw new Error('OpenTofu workspace identity differs from this batch');
    manifest ??= { schemaVersion: 1, identity, members: {} };
    for (const item of items) {
      if (!batch.instances.some(member => member.id === item.instance.id)) throw new Error('Execution item is not a member of this batch');
      manifest.members[item.instance.id] ??= this.definition(item, identity);
    }
    for (const member of batch.instances) {
      if ((CURRENT_STATUSES.has(member.status) || member.singleInstanceConfig?.opentofuCreateJobId) && !manifest.members[member.id]) {
        const job = member.lastJobId ? await this.repository.getProvisionJobById(member.lastJobId) : null;
        if (!job || job.rangeInstanceId !== member.id) throw new Error('Active sibling has no frozen OpenTofu creation job');
        manifest.members[member.id] = this.definition({ instance: member, job }, identity);
      }
      if (manifest.members[member.id]) {
        await this.restoreFrozenDeadline(member, manifest.members[member.id], items, account, lease);
        this.validateFrozenDefinition(member, manifest.members[member.id]);
      }
    }
    const marker = await readJson<PendingOperation>(path.join(workspace, APPLY_MARKER));
    for (const pending of [manifest.pending, marker]) {
      if (!pending) continue;
      if (pending.submittedAt !== undefined && (typeof pending.submittedAt !== 'string' || !Number.isFinite(Date.parse(pending.submittedAt))) || !['create', 'destroy'].includes(pending.kind) || !Array.isArray(pending.ids) || !Array.isArray(pending.jobIds)
        || pending.ids.some(id => typeof id !== 'string' || !manifest!.members[id])
        || pending.createIds !== undefined && (!Array.isArray(pending.createIds) || pending.createIds.some(id => typeof id !== 'string' || !manifest!.members[id]))
        || pending.knownIds !== undefined && (!pending.knownIds || typeof pending.knownIds !== 'object' || Array.isArray(pending.knownIds)
          || Object.entries(pending.knownIds).some(([id, values]) => !manifest!.members[id] || !Array.isArray(values) || values.some(value => typeof value !== 'string' || !(identity.provider === 'tencent_cloud' ? /^ins-[a-z0-9]+$/ : /^i-[A-Za-z0-9-]{1,125}$/).test(value))))
        || pending.recoveryIds !== undefined && (!Array.isArray(pending.recoveryIds) || pending.recoveryIds.some(id => typeof id !== 'string' || !manifest!.members[id]))) {
        throw new Error('OpenTofu recovery marker is malformed');
      }
    }
    if (marker) manifest.pending = { ...(manifest.pending ?? marker), knownIds: Object.fromEntries(Object.keys(manifest.members).map(id => [id,
      [...new Set([...(manifest!.pending?.knownIds?.[id] ?? []), ...(marker.knownIds?.[id] ?? [])])]])), createIds: [...new Set([
      ...pendingCreateIds(manifest.pending), ...pendingCreateIds(marker),
    ])], recoveryIds: [...new Set([
      ...(manifest.pending?.recoveryIds ?? []), ...(manifest.pending?.ids ?? []), ...(marker.recoveryIds ?? []), ...marker.ids,
    ])] };
    const secrets = [...collectSecrets(batch.instances.map(instance => ({ instance }))), account.accessKeyId, account.accessKeySecret,
      ...Object.values(manifest.members).map(member => member.password)].filter(Boolean);
    const context: Context = { lease, items, batch, account, manifest, workspace, secrets, env: {}, state: new Map(),
      knownIds: new Map(batch.instances.map(member => [member.id, [...new Set([
        ...Object.values(member.resourceSummary?.hostIds ?? {}).filter((id): id is string => Boolean(id)), ...(manifest!.pending?.knownIds?.[member.id] ?? []),
      ])]])) };
    context.state = await this.readState(context);
    for (const [id, member] of context.state) context.knownIds.set(id, [...new Set([...(context.knownIds.get(id) ?? []), member.id])]);
    const missingAppliedIds = batch.instances.filter(member => member.singleInstanceConfig?.opentofuCreateJobId && !context.state.has(member.id)).map(member => member.id);
    if (missingAppliedIds.length) {
      const prior = manifest.pending;
      manifest.pending = { kind: prior?.kind ?? 'create', ids: prior?.ids ?? missingAppliedIds, jobIds: prior?.jobIds ?? [],
        knownIds: Object.fromEntries(context.knownIds), createIds: [...new Set([...pendingCreateIds(prior), ...missingAppliedIds])],
        recoveryIds: [...new Set([...(prior?.recoveryIds ?? prior?.ids ?? []), ...missingAppliedIds])] };
    }
    await this.assertLease(lease);
    await fs.mkdir(workspace, { recursive: true, mode: 0o700 });
    await this.atomicJson(context, MANIFEST_FILE, manifest);
    const providerEnv = this.env.RANGE_PROVISIONER_MODE === 'dry-run' ? {} : await mirrors.prepareOpenTofuProviderEnv({ provider: account.provider, providerZipPath: account.provider === 'tencent_cloud' ? this.env.TENCENTCLOUD_PROVIDER_ZIP_PATH : this.env.ALICLOUD_PROVIDER_ZIP_PATH,
      workspacesRootDir: this.workspaceRoot, unpackedMirrorRootDir: account.provider === 'tencent_cloud' ? this.env.TENCENTCLOUD_PROVIDER_UNPACKED_MIRROR_ROOT : this.env.OPENTOFU_PROVIDER_UNPACKED_MIRROR_ROOT });
    context.env = { PATH: this.env.PATH, ...providerEnv, ...(account.provider === 'tencent_cloud' ? { TENCENTCLOUD_SECRET_ID: account.accessKeyId, TENCENTCLOUD_SECRET_KEY: account.accessKeySecret, TENCENTCLOUD_REGION: identity.region } : { ALICLOUD_ACCESS_KEY: account.accessKeyId, ALICLOUD_SECRET_KEY: account.accessKeySecret, ALICLOUD_REGION: identity.region }) };
    return context;
  }

  private definition(item: SingleInstanceExecutionItem, identity: Identity): CatalogMember {
    const config = item.instance.singleInstanceConfig!;
    const password = item.instance.runtimeCredentials?.[config.hostKey]?.password;
    if (!password || !config.resolvedInstanceType) throw new Error('Frozen password and exact instance type are required');
    const sourceJobId = config.opentofuCreateJobId ?? item.job.id;
    return { password, hostKey: config.hostKey, sourceJobId, ...(config.cloudReleaseDeadline ? { cloudReleaseDeadline: structuredClone(config.cloudReleaseDeadline) } : {}), definition: { instance_name: identity.provider === 'tencent_cloud' ? Array.from(instanceName(item.instance.name)).slice(0, 60).join('') : instanceName(item.instance.name),
      host_name: config.hostName ?? '', instance_type: config.resolvedInstanceType, image_id: config.imageId, vswitch_id: config.assignedVswitchId!,
      system_disk_category: identity.provider === 'tencent_cloud' ? this.env.TENCENTCLOUD_SYSTEM_DISK_TYPE ?? 'CLOUD_PREMIUM' : this.env.OPENTOFU_SYSTEM_DISK_CATEGORY ?? 'cloud_essd', system_disk_size: config.systemDiskSize,
      internet_max_bandwidth_out: Number(this.env.OPENTOFU_INTERNET_MAX_BANDWIDTH_OUT ?? 10), auto_release_time: config.autoReleaseTime ?? '',
      tags: { ...buildBillingTags({ billingScope: item.instance.ownerUserId ? 'user' : 'platform', ownerUserId: item.instance.ownerUserId,
        rangeInstanceId: item.instance.id, singleInstanceBatchId: identity.batchId, platformResourceType: 'ecs', platformHostKey: config.hostKey, billingStartAt: item.instance.createdAt }),
        CloudAccountUid: identity.accountUid, CloudAccountContextId: identity.contextId, ExecutionBackend: 'opentofu', PlatformCreateJobId: sourceJobId,
        ...(identity.provider === 'tencent_cloud' ? { CloudProvider: 'tencent_cloud', OwnerUserId: item.instance.ownerUserId ?? 'platform', PlatformResourceType: 'ecs', CreationIntentId: buildTencentSingleCreationIntent(item.instance, sourceJobId) } : {}) },
      ...(identity.provider === 'tencent_cloud' ? { client_token: buildTencentSingleCreationIntent(item.instance, sourceJobId) } : {}) } };
  }
  private validateFrozenDefinition(instance: RangeInstanceRecord, member: CatalogMember) {
    const config = instance.singleInstanceConfig!;
    const definition = member?.definition;
    if (!definition || member.hostKey !== config.hostKey || member.password !== instance.runtimeCredentials?.[config.hostKey]?.password
      || definition.host_name !== (config.hostName ?? '') || definition.image_id !== config.imageId
      || definition.instance_type !== config.resolvedInstanceType || definition.vswitch_id !== config.assignedVswitchId
      || instance.cloudProvider === 'tencent_cloud' && (definition.client_token !== buildTencentSingleCreationIntent(instance, member.sourceJobId) || definition.tags.CreationIntentId !== definition.client_token)
      || member.cloudReleaseDeadline && (!config.cloudReleaseDeadline || !sameDeadline(member.cloudReleaseDeadline, config.cloudReleaseDeadline))
      || definition.system_disk_size !== config.systemDiskSize || definition.auto_release_time !== (config.autoReleaseTime ?? '')) {
      throw new Error('A member immutable launch definition changed after its workspace was frozen');
    }
  }

  private async restoreFrozenDeadline(instance: RangeInstanceRecord, member: CatalogMember, items: SingleInstanceExecutionItem[], account: SystemCloudAccountContext, lease: SingleInstanceOpenTofuBatchLease) {
    const config = instance.singleInstanceConfig!;
    const record = member.cloudReleaseDeadline ?? config.cloudReleaseDeadline;
    if (!record) return;
    if (record.provider !== account.provider || !instance.expiresAt || Date.parse(record.platformExpiresAt) !== instance.expiresAt.getTime()
      || !Number.isFinite(Date.parse(record.creationPhaseStartedAt)) || !Number.isFinite(Date.parse(record.cloudReleaseAt))
      || member.cloudReleaseDeadline && member.definition.auto_release_time !== record.cloudReleaseAt
      || config.cloudReleaseDeadline && (!sameDeadline(config.cloudReleaseDeadline, record) || config.autoReleaseTime !== record.cloudReleaseAt))
      throw new Error('Persisted single-instance deadline conflicts with its frozen account or expiry');
    const source = await this.repository.getProvisionJobById(record.sourceProvisionJobId);
    if (!source?.startedAt || source.rangeInstanceId !== instance.id || !['create','retry'].includes(source.jobType)
      || (source.cloudWorkspaceId ?? 'legacy-unbound') !== (instance.cloudWorkspaceId ?? 'legacy-unbound'))
      throw new Error('Persisted single-instance deadline has no original creation job proof');
    if (!member.cloudReleaseDeadline) {
      if (member.definition.auto_release_time !== record.cloudReleaseAt) throw new Error('Frozen definition differs from the persisted absolute deadline');
      member.cloudReleaseDeadline = structuredClone(record);
    }
    if (!config.cloudReleaseDeadline) {
      const item = items.find(item => item.instance.id === instance.id);
      if (!item || config.opentofuCreateJobId || Object.keys(instance.resourceSummary?.hostIds ?? {}).length)
        throw new Error('Incomplete deadline persistence requires its original pre-apply claim');
      await this.assertLease(lease);
      if (!await this.itemCurrent(item)) throw new SingleInstanceOpenTofuLeaseLostError('Deadline recovery claim is no longer active');
      const restored = { ...config, autoReleaseTime: record.cloudReleaseAt, cloudReleaseDeadline: structuredClone(record) };
      if (!await this.repository.commitSingleInstanceClaim(item.job, { singleInstanceConfig: restored, resourceSummary: { ...instance.resourceSummary,
        mode: 'opentofu', cloudReleaseDeadlines: { ...instance.resourceSummary?.cloudReleaseDeadlines, [member.hostKey]: record } } }))
        throw new SingleInstanceOpenTofuLeaseLostError('Deadline recovery claim was lost');
      instance.singleInstanceConfig = restored; item.instance.singleInstanceConfig = restored;
    }
  }

  private async freezeHostDeadlines(context: Context, items: SingleInstanceExecutionItem[]) {
    const added = items.filter(item => !context.state.has(item.instance.id));
    if (!added.length) return;
    const startedAt = new Date().toISOString();
    for (const item of added) {
      await this.assertLease(context.lease);
      if (!await this.itemCurrent(item)) throw new SingleInstanceOpenTofuLeaseLostError('Host creation claim is no longer active');
      const current = await this.repository.getRangeInstanceById(item.instance.id);
      if (!current?.expiresAt || current.expiresAt <= new Date()) throw new Error('Single-instance launch expired before the host creation phase');
      const member = context.manifest.members[item.instance.id];
      const existing = member.cloudReleaseDeadline ?? current.singleInstanceConfig?.cloudReleaseDeadline;
      if (!existing && current.singleInstanceConfig?.opentofuCreateJobId) throw new Error('Previous host submission has no frozen deadline; recover its original resources before creating');
      member.cloudReleaseDeadline = existing ? { ...existing, status: 'unverified' } : createHostCloudReleaseDeadline({ provider: context.account.provider,
        platformExpiresAt: current.expiresAt.toISOString(), creationPhaseStartedAt: startedAt, sourceProvisionJobId: item.job.id });
      const record = member.cloudReleaseDeadline;
      delete record.instanceId; delete record.verifiedAt; delete record.lastCheckedAt; delete record.reason;
      if (record.provider !== context.account.provider || Date.parse(record.platformExpiresAt) !== current.expiresAt.getTime()) throw new Error('Host deadline differs from the current immutable expiry');
      assertCloudReleaseDeadlineCanCreate(record);
      member.definition.auto_release_time = record.cloudReleaseAt;
    }
    // The manifest survives a failed database commit; recovery restores this exact record, never a new C.
    await this.atomicJson(context, MANIFEST_FILE, context.manifest);
    for (const item of added) {
      await this.assertLease(context.lease);
      const record = context.manifest.members[item.instance.id].cloudReleaseDeadline!;
      const current = await this.repository.getRangeInstanceById(item.instance.id);
      if (!current || current.singleInstanceConfig?.cloudReleaseDeadline && !sameDeadline(current.singleInstanceConfig.cloudReleaseDeadline, record))
        throw new Error('Database host deadline differs from its persisted creation intent');
      const config = { ...current.singleInstanceConfig!, autoReleaseTime: record.cloudReleaseAt, cloudReleaseDeadline: structuredClone(record) };
      if (!await this.repository.commitSingleInstanceClaim(item.job, { singleInstanceConfig: config, resourceSummary: { ...current.resourceSummary,
        ...batchResourceSummary(context), cloudReleaseDeadlines: { ...current.resourceSummary?.cloudReleaseDeadlines, [config.hostKey]: record } } }))
        throw new SingleInstanceOpenTofuLeaseLostError('Host deadline claim was lost before applying its cloud request');
      item.instance.singleInstanceConfig = config;
      const sibling = context.batch.instances.find(member => member.id === item.instance.id); if (sibling) sibling.singleInstanceConfig = config;
      const now = new Date();
      await this.repository.createProvisionJobStepLog({ jobId: item.job.id, stepName: 'host_cloud_release_deadlines', status: 'succeeded',
        message: JSON.stringify({ version: 1, rangeInstanceId: item.instance.id, executionContext: batchResourceSummary(context).executionContext,
          deadlines: { [config.hostKey]: record } }), startedAt: now, finishedAt: now, stdoutExcerpt: null, stderrExcerpt: null });
    }
  }

  private async writeInputs(context: Context) {
    await this.assertLease(context.lease);
    const live = await this.getBatch(context.lease.batchId);
    if (!live) throw new Error('OpenTofu batch disappeared while its workspace was locked');
    const ids = new Set(live.instances.filter(member => CURRENT_STATUSES.has(member.status)).map(member => member.id));
    for (const member of live.instances) {
      if (member.singleInstanceBatchId !== context.lease.batchId || member.ownerUserId !== context.manifest.identity.ownerId
        || member.cloudProvider !== context.account.provider
        || member.singleInstanceConfig?.cloudAccountContextId !== context.manifest.identity.contextId
        || member.singleInstanceConfig?.cloudAccountUid !== context.manifest.identity.accountUid
        || member.singleInstanceConfig?.regionId !== context.manifest.identity.region || backend(member) !== 'opentofu'
        || member.singleInstanceConfig?.zoneId !== context.manifest.identity.zone
        || member.singleInstanceConfig?.networkProfileId !== context.manifest.identity.profileId) throw new Error('Batch membership changed outside its frozen execution scope');
      if (ids.has(member.id) && !context.manifest.members[member.id]) throw new Error('A desired member has no frozen workspace definition');
      if (context.manifest.members[member.id]) this.validateFrozenDefinition(member, context.manifest.members[member.id]);
    }
    const members = Object.fromEntries(Object.entries(context.manifest.members).filter(([id]) => ids.has(id)));
    if (context.manifest.identity.provider === 'tencent_cloud') {
      const identity = context.manifest.identity;
      const variables = new TencentCloudOpenTofuRenderer().render({ batchId: identity.batchId, cloudAccountUid: identity.accountUid,
        cloudAccountContextId: identity.contextId, region: identity.region, zoneId: identity.zone, vpcId: identity.vpcId!, securityGroupId: identity.securityGroupId,
        members: Object.entries(members).map(([id, member]) => ({ rangeInstanceId: id, ownerUserId: identity.ownerId ?? 'platform', creationIntentId: member.definition.client_token!, terminateAt: member.definition.auto_release_time,
          instanceName: member.definition.instance_name, hostName: member.definition.host_name, instanceType: member.definition.instance_type,
          imageId: member.definition.image_id, subnetId: member.definition.vswitch_id, systemDiskType: member.definition.system_disk_category as 'CLOUD_PREMIUM',
          systemDiskSize: member.definition.system_disk_size, internetMaxBandwidthOut: member.definition.internet_max_bandwidth_out, password: member.password,
          tags: member.definition.tags, windows: context.batch.instances.find(instance => instance.id === id)?.runtimeCredentials?.[member.hostKey]?.username === 'Administrator' })) });
      await this.atomicText(context, 'main.tf', `provider "tencentcloud" { region = var.region }\nmodule "single_batch" {\n  source = ${JSON.stringify(path.join(this.projectRoot, modulePath(context)))}\n  batch_id = var.batch_id\n  cloud_account_uid = var.cloud_account_uid\n  region = var.region\n  zone_id = var.zone_id\n  vpc_id = var.vpc_id\n  members = var.members\n  member_passwords = var.member_passwords\n  security_group_id = var.security_group_id\n}\noutput "members" { value = module.single_batch.members }\n`);
      await this.atomicText(context, 'variables.tf', 'variable "region" { type = string }\nvariable "batch_id" { type = string }\nvariable "cloud_account_uid" { type = string }\nvariable "zone_id" { type = string }\nvariable "vpc_id" { type = string }\nvariable "members" { type = any }\nvariable "security_group_id" { type = string }\nvariable "member_passwords" {\n type = map(string)\n sensitive = true\n}\n');
      await this.atomicText(context, 'versions.tf', `terraform {\n required_providers {\n  tencentcloud = { source = "tencentcloudstack/tencentcloud", version = "= ${TENCENTCLOUD_PROVIDER_VERSION}" }\n }\n}\n`);
      await this.atomicJson(context, 'terraform.tfvars.json', variables);
      return;
    }

    const wrapper = `provider "alicloud" { region = var.region_id }\nmodule "single_batch" {\n  source = ${JSON.stringify(path.join(this.projectRoot, MODULE_PATH))}\n  members = var.members\n  member_passwords = var.member_passwords\n  security_group_id = var.security_group_id\n}\noutput "members" { value = module.single_batch.members }\n`;
    const variables = 'variable "region_id" { type = string }\nvariable "members" { type = any }\nvariable "security_group_id" { type = string }\nvariable "member_passwords" {\n  type = map(string)\n  sensitive = true\n}\n';
    await this.atomicText(context, 'main.tf', wrapper);
    await this.atomicText(context, 'variables.tf', variables);
    await this.atomicText(context, 'versions.tf', 'terraform {\n  required_providers {\n    alicloud = { source = "aliyun/alicloud", version = "= 1.282.0-range.1" }\n  }\n}\n');
    await this.atomicJson(context, 'terraform.tfvars.json', { region_id: context.manifest.identity.region, security_group_id: context.manifest.identity.securityGroupId,
      members: Object.fromEntries(Object.entries(members).map(([id, member]) => [id, member.definition])), member_passwords: Object.fromEntries(Object.entries(members).map(([id, member]) => [id, member.password])) });
  }

  private async applyPlan(context: Context, ids: string[], destroy: boolean) {
    await this.assertLease(context.lease);
    if (!this.runner.showPlan) throw new Error('OpenTofu plan JSON inspection runtime is required');
    const planFilePath = path.join(context.workspace, 'single-batch.tfplan');
    const targets = ids.map(id => `module.single_batch.${resourceType(context)}.members[${JSON.stringify(id)}]`);
    await this.command(context, () => this.runner.plan({ ...this.commandOptions(context), varsFilePath: path.join(context.workspace, 'terraform.tfvars.json'), planFilePath, targets, destroy }));
    const plan = await this.command(context, () => this.runner.showPlan!<Plan>({ ...this.commandOptions(context), planFilePath }));
    if (!plan || typeof plan.format_version !== 'string' || !plan.format_version
      || plan.resource_changes !== undefined && !Array.isArray(plan.resource_changes)) throw new Error('OpenTofu plan JSON is malformed');
    for (const change of plan.resource_changes ?? []) {
      if (!change?.change || !Array.isArray(change.change.actions) || !change.change.actions.length
        || change.change.actions.some(action => !['no-op', 'read', 'create', 'update', 'delete'].includes(action))) throw new Error('OpenTofu plan actions are malformed');
      if (change.change.actions.every(action => action === 'no-op' || action === 'read')) continue;
      if (change.type !== resourceType(context) || !targets.includes(change.address)
        || destroy && change.change.actions.some(action => action !== 'delete')) throw new Error('OpenTofu plan would change an unrequested batch resource');
      if (!destroy && change.change.actions.includes('delete')) throw new Error('Creation cannot replace a pre-existing batch member');
      if (!destroy && change.change.actions.includes('create')) {
        const id = ids.find(id => change.address === `module.single_batch.${resourceType(context)}.members[${JSON.stringify(id)}]`)!;
        if (context.state.has(id) || context.knownIds.get(id)?.length) throw new Error('Creation cannot recreate a previously tracked batch member');
        const record = context.manifest.members[id]?.cloudReleaseDeadline;
        if (!record) throw new Error('Host creation has no frozen absolute cloud deadline');
        assertCloudReleaseDeadlineCanCreate(record);
      }
    }
    if (!destroy && context.items.some(item => ids.includes(item.instance.id) && isExpired(item.instance))) {
      throw new Error('Single-instance launch expired while OpenTofu prepared the creation plan');
    }
    context.manifest.pending = { submittedAt: context.manifest.pending?.submittedAt ?? new Date().toISOString(), kind: destroy ? 'destroy' : 'create', ids, jobIds: context.items.map(item => item.job.id),
      createIds: [...new Set([...pendingCreateIds(context.manifest.pending), ...(destroy ? [] : ids)])],
      knownIds: Object.fromEntries(context.knownIds),
      recoveryIds: [...new Set([...(context.manifest.pending?.recoveryIds ?? []), ...(context.manifest.pending?.ids ?? []), ...ids])] };
    await this.atomicJson(context, MANIFEST_FILE, context.manifest);
    await this.atomicJson(context, APPLY_MARKER, context.manifest.pending);
    if (!destroy) for (const item of context.items.filter(item => ids.includes(item.instance.id))) {
      await this.assertLease(context.lease);
      const config = { ...item.instance.singleInstanceConfig!, opentofuCreateJobId: context.manifest.members[item.instance.id].sourceJobId };
      if (!await this.repository.commitSingleInstanceClaim(item.job, { singleInstanceConfig: config })) {
        throw new SingleInstanceOpenTofuLeaseLostError('Creation claim was lost before applying its cloud request');
      }
      item.instance.singleInstanceConfig = config;
    }
    const progress = destroy ? null : this.observeCreateProgress(context, ids);
    try {
      if (!destroy) for (const change of plan.resource_changes ?? []) if (change.change.actions.includes('create')) {
        const id = ids.find(id => change.address === `module.single_batch.${resourceType(context)}.members[${JSON.stringify(id)}]`)!;
        assertCloudReleaseDeadlineCanCreate(context.manifest.members[id].cloudReleaseDeadline!);
      }
      await this.command(context, () => this.runner.apply({ ...this.commandOptions(context), planFilePath,
        ...(progress ? { onResourceApplied: progress.onResourceApplied } : {}) }));
    } finally { await progress?.stop(); }
  }

  private observeCreateProgress(context: Context, ids: string[]) {
    const items = new Map(context.items.filter(item => ids.includes(item.instance.id)
      && (item.job.jobType !== 'retry' || item.job.topologySnapshot?.operation === 'create'))
      .map(item => [`module.single_batch.${resourceType(context)}.members[${JSON.stringify(item.instance.id)}]`, item]));
    const pending = new Map<string, { item: SingleInstanceExecutionItem; cloudId: string }>();
    const seen = new Map<string, string>();
    let stopped = false;
    let flushing = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let active = Promise.resolve();
    let receipts = Promise.resolve();
    let receiptFailure: unknown;
    const stopObserving = () => { stopped = true; clearTimeout(timer); timer = undefined; pending.clear(); };
    const schedule = (delay: number) => {
      if (stopped || flushing || timer || !pending.size) return;
      timer = setTimeout(() => {
        timer = undefined;
        flushing = true;
        active = flush().catch(error => {
          // Progress is optional; final durable-state verification remains authoritative.
          if (context.lease.signal.aborted || error instanceof SingleInstanceOpenTofuLeaseLostError) stopObserving();
        }).finally(() => { flushing = false; schedule(2000); });
      }, delay);
      timer.unref();
    };
    const flush = async () => {
      if (stopped) return;
      await this.assertLease(context.lease);
      const batch = [...pending.values()];
      const cloud = await this.native.readOpenTofuInstances(context.account, batch.map(entry => entry.cloudId));
      if (stopped) return;
      await this.assertLease(context.lease);
      if (new Set(cloud.map(detail => detail.instanceId)).size !== cloud.length
        || cloud.some(detail => !batch.some(entry => entry.cloudId === detail.instanceId))) return;
      for (const { item, cloudId } of batch) {
        if (stopped) return;
        await this.assertLease(context.lease);
        if (!await this.itemCurrent(item) || isExpired(item.instance)) { pending.delete(item.instance.id); continue; }
        const detail = cloud.find(value => value.instanceId === cloudId);
        if (!detail || detail.status !== 'Running' || !detail.publicIp || !matchesCloud(detail, item.instance)
          || detail.tags.PlatformCreateJobId !== context.manifest.members[item.instance.id].sourceJobId) continue;
        const hostKey = item.instance.singleInstanceConfig!.hostKey;
        await this.assertLease(context.lease);
        if (stopped || context.lease.signal.aborted || isExpired(item.instance)) return;
        // Keep the verified physical ID for crash recovery; this is not a durable-state or billing commit.
        const saved = await this.repository.commitSingleInstanceClaim(item.job, { status: 'running',
          resourceSummary: { ...batchResourceSummary(context), workspaceDir: context.workspace, hostIds: { [hostKey]: cloudId },
            ...memberDeadlineSummary(context, item),
            resolvedInstanceType: context.manifest.members[item.instance.id].definition.instance_type, resolvedImageId: item.instance.singleInstanceConfig!.imageId },
          runtimeTopologyGraph: patchRuntimeTopologyGraph(item.instance.runtimeTopologyGraph, hostKey, detail),
          runtimeScenarioTemplateSpec: patchRuntimeScenarioTemplate(item.instance.runtimeScenarioTemplateSpec, hostKey, detail),
          runtimeCompiledProvisionSpec: patchRuntimeCompiledProvisionSpec(item.instance.runtimeCompiledProvisionSpec, hostKey, detail),
          accessEntry: { hostRole: hostKey, publicIp: detail.publicIp, privateIp: detail.privateIp,
            ssh: item.instance.runtimeCredentials?.[hostKey]?.username !== 'Administrator' ? `ssh ${item.instance.runtimeCredentials?.[hostKey]?.username ?? 'root'}@${detail.publicIp}` : null }, errorSummary: null });
        if (saved) context.knownIds.set(item.instance.id, [...new Set([...(context.knownIds.get(item.instance.id) ?? []), cloudId])]);
        pending.delete(item.instance.id);
      }
    };
    context.lease.signal.addEventListener('abort', stopObserving, { once: true });
    return {
      onResourceApplied: (event: ResourceAppliedEvent) => {
        const item = items.get(event.address);
        if (stopped || context.lease.signal.aborted || !item || event.resourceType !== resourceType(context)
          || !['create', 'update'].includes(event.action) || !validCloudId(context, event.resourceId)) return;
        if (seen.has(item.instance.id)) {
          if (seen.get(item.instance.id) !== event.resourceId) stopObserving();
          return;
        }
        seen.set(item.instance.id, event.resourceId);
        if (event.action === 'create') {
          receipts = receipts.then(async () => {
            await this.assertLease(context.lease);
            const member = context.manifest.members[item.instance.id];
            const now = new Date();
            await this.repository.createProvisionJobStepLog({ jobId: member.sourceJobId, stepName: 'single_instance_creation_receipt', status: 'succeeded',
              message: JSON.stringify({ version: 1, cloudProvider: item.instance.cloudProvider, cloudWorkspaceId: item.instance.cloudWorkspaceId ?? 'legacy-unbound',
                rangeInstanceId: item.instance.id, sourceJobId: member.sourceJobId, ownerUserId: item.instance.ownerUserId,
                singleInstanceBatchId: item.instance.singleInstanceBatchId, executionContext: batchResourceSummary(context).executionContext,
                resources: { hostIds: { [member.hostKey]: event.resourceId } } }), startedAt: now, finishedAt: now, stdoutExcerpt: null, stderrExcerpt: null });
          }).catch(error => { receiptFailure = error; });
        }
        pending.set(item.instance.id, { item, cloudId: event.resourceId });
        schedule(250);
      },
      stop: async () => {
        stopObserving(); context.lease.signal.removeEventListener('abort', stopObserving); await active; await receipts;
        if (receiptFailure) throw new Error('Exact provider creation receipt could not be persisted; recovery material was preserved');
      },
    };
  }

  private async completeCreated(context: Context, items: SingleInstanceExecutionItem[], partial: boolean): Promise<SingleInstanceExecutionItem[]> {
    const known = items.filter(item => { const state = context.state.get(item.instance.id); return state && !state.tainted && Boolean(state.diskId) && !isExpired(item.instance); });
    const cloud = known.length ? await this.native.readOpenTofuInstances(context.account, known.map(item => context.state.get(item.instance.id)!.id)) : [];
    const intended = Object.fromEntries(known.flatMap(item => {
      const record = context.manifest.members[item.instance.id].cloudReleaseDeadline;
      return record ? [[item.instance.id, record]] : [];
    }));
    const checked = Object.keys(intended).length ? await verifyCloudReleaseDeadlines({ account: context.account,
      hostIds: Object.fromEntries(known.map(item => [item.instance.id, context.state.get(item.instance.id)!.id])), deadlines: intended }) : {};
    const completed: SingleInstanceExecutionItem[] = [];
    for (const item of known) {
      await this.assertLease(context.lease);
      if (!await this.itemCurrent(item)) continue;
      const state = context.state.get(item.instance.id)!;
      const detail = cloud.find(value => value.instanceId === state.id);
      if (!detail || !matchesCloud(detail, item.instance) || partial && detail.status !== 'Running') continue;
      const hostKey = item.instance.singleInstanceConfig!.hostKey;
      let summary: RangeResourceSummary = { ...batchResourceSummary(context), workspaceDir: context.workspace,
        hostIds: { [hostKey]: state.id }, systemDiskIds: { [hostKey]: state.diskId },
        resolvedInstanceType: context.manifest.members[item.instance.id].definition.instance_type, resolvedImageId: item.instance.singleInstanceConfig!.imageId };
      summary = await this.native.captureInstanceDisks(item, context.account, summary, false, () => this.assertLease(context.lease));
      const verified = checked[item.instance.id];
      if (verified) {
        if (verified.status === 'verified' && !hasVerifiedSystemDiskReleasePolicy(summary, state.id)) {
          verified.status = 'unverified'; verified.reason = 'system_disk_release_unverified'; delete verified.verifiedAt;
        }
        summary = { ...summary, cloudReleaseDeadlines: { [hostKey]: verified } };
      }
      const config = { ...item.instance.singleInstanceConfig!, ...(verified ? { cloudReleaseDeadline: verified } : {}) };
      if (!await this.repository.commitSingleInstanceClaim(item.job, { singleInstanceConfig: config, resourceSummary: summary, status: detail.status === 'Running' && detail.publicIp ? 'running' : 'creating',
        runtimeTopologyGraph: patchRuntimeTopologyGraph(item.instance.runtimeTopologyGraph, hostKey, detail),
        runtimeScenarioTemplateSpec: patchRuntimeScenarioTemplate(item.instance.runtimeScenarioTemplateSpec, hostKey, detail),
        runtimeCompiledProvisionSpec: patchRuntimeCompiledProvisionSpec(item.instance.runtimeCompiledProvisionSpec, hostKey, detail),
        accessEntry: { hostRole: hostKey, publicIp: detail.publicIp, privateIp: detail.privateIp, ssh: detail.publicIp && item.instance.runtimeCredentials?.[hostKey]?.username !== 'Administrator' ? `ssh ${item.instance.runtimeCredentials?.[hostKey]?.username ?? 'root'}@${detail.publicIp}` : null }, errorSummary: null })) continue;
      await this.assertLease(context.lease);
      await syncRangeInstanceBillingLedger({ repository: this.repository, instance: item.instance, regionId: context.account.defaultRegion,
        cloudAccountUid: context.account.accountUid, resourceSummary: summary, sourceProvisionJobId: context.manifest.members[item.instance.id].sourceJobId, billingStartAt: item.instance.createdAt });
      await this.assertLease(context.lease);
      if (await this.repository.commitSingleInstanceClaim(item.job, {}, { status: 'succeeded', finishedAt: new Date(), errorSummary: null })) completed.push(item);
    }
    if (!partial && completed.length !== items.length) throw new Error('OpenTofu did not prove every requested member complete');
    return completed;
  }

  private async recoverPartialCreate(context: Context, items: SingleInstanceExecutionItem[], message: string) {
    try {
      context.state = await this.readState(context);
      await this.rememberTrackedResources(context, items);
      const completed = await this.completeCreated(context, items, true);
      const failed: SingleInstanceExecutionItem[] = [];
      for (const item of items) if (!completed.includes(item) && await this.itemCurrent(item)) failed.push(item);
      if (!failed.length) { await this.finishOperation(context); return; }
      const tracked = failed.filter(item => context.state.has(item.instance.id));
      if (tracked.length) {
        await this.rememberTrackedResources(context, tracked, true);
        await this.writeInputs(context);
        await this.command(context, () => this.runner.init({ ...this.commandOptions(context), upgrade: true }));
        await this.applyPlan(context, tracked.map(item => item.instance.id), true);
        context.state = await this.readState(context);
      }
      for (const item of tracked) {
        if (context.state.has(item.instance.id)) throw new Error('Partial OpenTofu cleanup left a tracked member');
        await this.assertAbsent(context, item);
        await this.markFailures([item], message, false, true);
      }
      await this.cleanupUntracked(context, failed.filter(item => !tracked.includes(item)), message);
      await this.finishOperation(context);
    } catch (error) {
      if (error instanceof SingleInstanceOpenTofuLeaseLostError) throw error;
      await this.assertLease(context.lease);
      await this.markFailures(items, `${message}; ${sanitize(error, context.secrets)}`, true);
    }
  }
  private async rememberTrackedResources(context: Context, items: SingleInstanceExecutionItem[], destroying = false) {
    for (const item of items) {
      const state = context.state.get(item.instance.id);
      if (!state || !await this.itemCurrent(item)) continue;
      await this.assertLease(context.lease);
      const hostKey = item.instance.singleInstanceConfig!.hostKey;
      let summary: RangeResourceSummary = { ...batchResourceSummary(context),
        ...memberDeadlineSummary(context, item),
        workspaceDir: context.workspace, hostIds: { [hostKey]: state.id }, systemDiskIds: state.diskId ? { [hostKey]: state.diskId } : null,
        resolvedInstanceType: context.manifest.members[item.instance.id].definition.instance_type, resolvedImageId: item.instance.singleInstanceConfig!.imageId };
      summary = await this.native.captureInstanceDisks(item, context.account, summary, destroying, () => this.assertLease(context.lease));
      if (await this.repository.commitSingleInstanceClaim(item.job, { resourceSummary: summary })) await this.syncLedger(context, item, summary);
    }
  }

  private async cleanupUntracked(context: Context, items: SingleInstanceExecutionItem[], message: string, destroy = false) {
    for (const item of items) {
      await this.assertLease(context.lease);
      if (!await this.itemCurrent(item)) continue;
      const [tagged, known] = await Promise.all([this.native.readOpenTofuInstancesByTag(item.instance),
        this.native.readOpenTofuInstances(context.account, context.knownIds.get(item.instance.id) ?? [])]);
      const details = [...new Map([...tagged, ...known].map(detail => [detail.instanceId, detail])).values()];
      if (details.some(detail => !matchesCloud(detail, item.instance))) throw new Error('Untracked cloud resource has an unproven owner or batch');
      if (details.length) {
        const current = await this.repository.getRangeInstanceById(item.instance.id) ?? item.instance;
        const proven = await readProvenSingleInstanceIds(this.repository, current);
        if (details.some(detail => !proven.has(detail.instanceId))) throw new Error('Tagged candidate has no independent persisted physical creation identity; recovery is required before cleanup');
        if (context.account.provider === 'tencent_cloud' && (!pendingCreateIds(context.manifest.pending).includes(item.instance.id) && !context.knownIds.get(item.instance.id)?.length || !item.instance.singleInstanceConfig?.opentofuCreateJobId)) throw new Error('Tencent untracked resources require durable submitted creation evidence');
        context.knownIds.set(item.instance.id, [...new Set([...(context.knownIds.get(item.instance.id) ?? []), ...details.map(detail => detail.instanceId)])]);
        if (context.manifest.pending) {
          context.manifest.pending.knownIds = Object.fromEntries(context.knownIds);
          await this.atomicJson(context, MANIFEST_FILE, context.manifest);
          await this.atomicJson(context, APPLY_MARKER, context.manifest.pending);
        }
        const hostKey = item.instance.singleInstanceConfig!.hostKey;
        await this.assertLease(context.lease);
        let summary: RangeResourceSummary = { ...batchResourceSummary(context), workspaceDir: context.workspace,
          hostIds: Object.fromEntries(details.map((detail, index) => [index ? `${hostKey}-recovery-${index}` : hostKey, detail.instanceId])) };
        if (context.account.provider === 'tencent_cloud') summary.systemDiskIds = await this.recoverTencentSystemDisks(context,item,details,hostKey);
        summary = await this.native.captureInstanceDisks(item, context.account, summary, true, () => this.assertLease(context.lease));
        if (await this.repository.commitSingleInstanceClaim(item.job, { resourceSummary: summary })) await this.syncLedger(context, item, summary);
        await this.native.deleteOwnedUntrackedOpenTofuInstances(item, details.map(detail => detail.instanceId), () => this.assertLease(context.lease));
        message = `${message}; emergency-api cleanup of exact bound, untracked member`;
      }
      await this.assertAbsent(context, item);
      if (destroy) await this.finishDestroyed(item);
      else await this.markFailures([item], message, false, true);
    }
  }
  private async recoverTencentSystemDisks(context: Context, item: SingleInstanceExecutionItem, details: NormalizedInstanceDetail[], hostKey: string) {
    const ids = details.map(detail => detail.systemDiskId).filter((id): id is string => Boolean(id));
    if (ids.length !== details.length || new Set(ids).size !== ids.length) throw new Error('Tencent recovery lacks exact system-disk identities');
    const persisted = new Set(Object.values(item.instance.resourceSummary?.systemDiskIds ?? {}));
    if (!ids.every(id => persisted.has(id))) {
      const submittedAt = Date.parse(context.manifest.pending?.submittedAt ?? '');
      if (!Number.isFinite(submittedAt)) throw new Error('Tencent recovery lacks the original submitted time');
      const disks = await this.command(context, () => describeTencentResourceInventory(context.account,'disk',{ ids }));
      if (disks.length !== ids.length) throw new Error('Tencent recovery system-disk response is incomplete');
      for (const disk of disks) {
        const createdAt = Date.parse(disk.createdAt ?? '');
        const attached = details.some(detail => detail.instanceId === disk.instanceId && detail.systemDiskId === disk.id);
        const boundedTime = disk.createdAt && /[zZ]$|[+-]\d{2}:?\d{2}$/.test(disk.createdAt) && Number.isFinite(createdAt) && createdAt >= submittedAt-5*60_000 && createdAt <= Date.now()+60_000;
        if (disk.shared || disk.diskUsage !== 'SYSTEM_DISK' || !attached || !boundedTime) throw new Error('Tencent recovery system disks have no matching source-job creation window and attachment');
      }
    }
    return Object.fromEntries(details.map((detail,index) => [index ? `${hostKey}-recovery-${index}` : hostKey,detail.systemDiskId!]));
  }

  private async assertAbsent(context: Context, item: SingleInstanceExecutionItem) {
    // An accepted create can remain invisible after a lost response. Empty lists cannot close that uncertainty.
    if (pendingCreateIds(context.manifest.pending).includes(item.instance.id) && !context.knownIds.get(item.instance.id)?.length) {
      throw new Error('OpenTofu creation outcome is unknown; preserve recovery material until the physical resource is identified');
    }
    for (let round = 0; round < 2; round += 1) {
      await this.assertLease(context.lease);
      const [tagged, known] = await Promise.all([this.native.readOpenTofuInstancesByTag(item.instance),
        this.native.readOpenTofuInstances(context.account, context.knownIds.get(item.instance.id) ?? [])]);
      if (tagged.length || known.length) throw new Error('Cloud member deletion has not been confirmed');
      await this.native.assertInstanceDisksAbsent(item.instance, context.account);
    }
  }
  private async syncLedger(context: Context, item: SingleInstanceExecutionItem, summary: RangeResourceSummary) {
    await this.assertLease(context.lease);
    await syncRangeInstanceBillingLedger({ repository: this.repository, instance: item.instance, regionId: context.account.defaultRegion,
      cloudAccountUid: context.account.accountUid, resourceSummary: summary, sourceProvisionJobId: context.manifest.members[item.instance.id].sourceJobId,
      billingStartAt: item.instance.createdAt });
  }
  private async finishDestroyed(item: SingleInstanceExecutionItem) {
    if (!await this.itemCurrent(item)) return;
    await releaseRangeInstanceBillingLedger(this.repository, item.instance.id, new Date());
    await this.repository.commitSingleInstanceClaim(item.job, { status: 'destroyed', accessEntry: null, resourceSummary: null, errorSummary: null,
      singleInstanceConfig: { ...item.instance.singleInstanceConfig!, opentofuCreateJobId: null } },
      { status: 'succeeded', finishedAt: new Date(), errorSummary: null });
  }
  private async markFailures(items: SingleInstanceExecutionItem[], message: string, destroy: boolean, cleared = false) {
    for (const item of items) {
      if (!await this.itemCurrent(item)) continue;
      if (cleared) await releaseRangeInstanceBillingLedger(this.repository, item.instance.id, new Date());
      await this.repository.commitSingleInstanceClaim(item.job, { status: destroy ? 'destroy_failed' : 'create_failed', errorSummary: message,
        ...(cleared ? { resourceSummary: null, accessEntry: null, singleInstanceConfig: { ...item.instance.singleInstanceConfig!, opentofuCreateJobId: null } } : {}) }, { status: 'failed', finishedAt: new Date(), errorSummary: message });
    }
  }
  private async simulate(context: Context, destroy: boolean) {
    for (const item of context.items) {
      await this.assertLease(context.lease);
      if (!await this.itemCurrent(item)) continue;
      if (destroy) await this.finishDestroyed(item);
      else await this.repository.commitSingleInstanceClaim(item.job, { status: 'running', resourceSummary: { mode: 'dry-run', hostIds: { [item.instance.singleInstanceConfig!.hostKey]: `dry-run-${item.instance.id}` } }, accessEntry: null, errorSummary: null }, { status: 'succeeded', finishedAt: new Date(), errorSummary: null });
    }
  }
  private async assertSimulationSafe(context: Context) {
    if (context.state.size || context.manifest.pending || await exists(path.join(context.workspace, APPLY_MARKER))
      || [...context.knownIds.values()].flat().some(id => !id.startsWith('dry-run-'))
      || context.batch.instances.some(member => member.resourceSummary && member.resourceSummary.mode !== 'dry-run')) {
      throw new UnsafeSimulationError('Dry-run cannot adopt or release a real OpenTofu batch');
    }
  }
  private async readState(context: Context) {
    await this.assertCompleteStateMaterial(context.workspace);
    const state = await readJson<{ version: number; lineage: string; resources?: Array<{ mode: string; type: string; name: string; module: string; instances: Array<{ index_key: string; status?: string; deposed?: string; attributes: Record<string, unknown> }> }> }>(path.join(context.workspace, 'terraform.tfstate'));
    const members = new Map<string, StateMember>();
    if (!state) return members;
    if (state.version !== 4 || !state.lineage || !Array.isArray(state.resources)) throw new Error('OpenTofu batch state identity is malformed');
    for (const resource of state.resources) {
      if (resource.mode !== 'managed' || resource.type !== resourceType(context) || resource.name !== 'members' || resource.module !== 'module.single_batch' || !Array.isArray(resource.instances)) throw new Error('OpenTofu state contains resources outside this ECS batch');
      for (const entry of resource.instances) {
        const frozen = context.manifest.members[entry.index_key];
        const attrs = entry.attributes;
        const tags = attrs?.tags as Record<string, string> | undefined;
        if (!frozen || typeof attrs?.id !== 'string' || !validCloudId(context,attrs.id) || !tags || tags.CloudAccountUid !== context.manifest.identity.accountUid
          || tags.CloudAccountContextId !== context.manifest.identity.contextId || tags.ExecutionBackend !== 'opentofu'
          || context.manifest.identity.provider === 'tencent_cloud' && (attrs.client_token !== frozen.definition.client_token || tags.CreationIntentId !== frozen.definition.client_token || tags.CloudProvider !== 'tencent_cloud')
          || tags.PlatformCreateJobId !== frozen.sourceJobId
          || tags.RangeInstanceId !== entry.index_key || tags.SingleInstanceBatchId !== context.lease.batchId
          || tags.PlatformScope !== (context.manifest.identity.ownerId ? 'user' : 'platform')
          || (tags.PlatformUserId ?? null) !== context.manifest.identity.ownerId || tags.CreatedBy !== 'cyber-range-platform') throw new Error('OpenTofu member state ownership cannot be verified');
        if (members.has(entry.index_key)) throw new Error('OpenTofu member has multiple or deposed physical instances; recovery is required');
        members.set(entry.index_key, { id: attrs.id, diskId: typeof attrs.system_disk_id === 'string' ? attrs.system_disk_id : '',
          privateIp: typeof attrs.private_ip === 'string' && attrs.private_ip ? attrs.private_ip : null,
          publicIp: typeof attrs.public_ip === 'string' && attrs.public_ip ? attrs.public_ip : null,
          status: String(attrs.instance_status ?? attrs.status ?? ''), tainted: entry.status === 'tainted' || Boolean(entry.deposed), tags });
      }
    }
    if (new Set([...members.values()].map(member => member.id)).size !== members.size) throw new Error('OpenTofu batch has duplicate cloud IDs');
    for (const [id, member] of members) context.knownIds.set(id, [...new Set([...(context.knownIds.get(id) ?? []), member.id])]);
    return members;
  }
  private async assertCompleteStateMaterial(workspace: string) {
    if (await exists(path.join(workspace, 'errored.tfstate'))
      || !await exists(path.join(workspace, 'terraform.tfstate')) && await exists(path.join(workspace, 'terraform.tfstate.backup'))) {
      throw new Error('OpenTofu workspace has unresolved durable state recovery material');
    }
  }
  private async itemCurrent(item: SingleInstanceExecutionItem) {
    if (item.job.rangeInstanceId !== item.instance.id) return false;
    const current = await this.repository.getRangeInstanceById(item.instance.id);
    return Boolean(current?.instanceMode === 'single' && current.lastJobId === item.job.id && item.job.startedAt
      && await this.repository.heartbeatProvisionJob(item.job.id, item.job.startedAt!, new Date()));
  }
  private async getBatch(id: string) {
    return this.repository.getSingleInstanceBatchWithInstancesById(id);
  }
  private async assertLease(lease: SingleInstanceOpenTofuBatchLease) {
    if (!lease || !lease.batchId || typeof lease.assertCurrent !== 'function' || lease.signal?.aborted) throw new SingleInstanceOpenTofuLeaseLostError('OpenTofu batch lease is not active');
    try { await lease.assertCurrent(); } catch { throw new SingleInstanceOpenTofuLeaseLostError('OpenTofu batch lease was lost'); }
  }
  private commandOptions(context: Context): CommandOptions { return { workspaceDir: context.workspace, env: context.env, signal: context.lease.signal }; }
  private async command<T>(context: Context, work: () => Promise<T>): Promise<T> {
    await this.assertLease(context.lease);
    try { const result = await work(); await this.assertLease(context.lease); return result; }
    catch (error) { await this.assertLease(context.lease); throw new Error(sanitize(error, context.secrets)); }
  }
  private async atomicText(context: Context, name: string, contents: string) {
    await this.assertLease(context.lease);
    const temporary = path.join(context.workspace, `.${name}.${randomUUID()}.tmp`);
    try { await fs.writeFile(temporary, contents, { mode: 0o600 }); await this.assertLease(context.lease); await fs.rename(temporary, path.join(context.workspace, name)); }
    finally { await fs.rm(temporary, { force: true }); }
  }
  private atomicJson(context: Context, name: string, value: unknown) { return this.atomicText(context, name, `${JSON.stringify(value, null, 2)}\n`); }
  private async finishOperation(context: Context) {
    await this.assertLease(context.lease);
    // A superseded member may no longer be part of this claim. Do not erase the
    // recovery marker until every missing member from that apply is proven absent.
    for (const id of context.manifest.pending?.recoveryIds ?? context.manifest.pending?.ids ?? []) {
      if (context.state.has(id)) continue;
      const instance = context.batch.instances.find(member => member.id === id);
      if (!instance) throw new Error('Recovery marker refers to an unknown batch member');
      await this.assertAbsent(context, { instance, job: context.items[0].job });
    }
    delete context.manifest.pending;
    await this.atomicJson(context, MANIFEST_FILE, context.manifest);
    await fs.rm(path.join(context.workspace, APPLY_MARKER), { force: true });
  }
}
function backend(instance: RangeInstanceRecord) { return (instance.singleInstanceConfig as Config | null)?.executionBackend; }
function sameDeadline(a: HostCloudReleaseDeadline, b: HostCloudReleaseDeadline) {
  return ['provider','platformExpiresAt','creationPhaseStartedAt','cloudReleaseAt','sourceProvisionJobId'].every(key => (a as any)[key] === (b as any)[key]);
}
function memberDeadlineSummary(context: Context, item: SingleInstanceExecutionItem) {
  const member = context.manifest.members[item.instance.id];
  return member?.cloudReleaseDeadline ? { cloudReleaseDeadlines: { [member.hostKey]: member.cloudReleaseDeadline } } : {};
}
function pendingCreateIds(pending?: PendingOperation) { return pending?.createIds ?? (pending?.kind === 'create' ? pending.ids : []); }
function isExpired(instance: RangeInstanceRecord) { return Boolean(instance.expiresAt && instance.expiresAt <= new Date()); }
function matchesCloud(detail: NormalizedInstanceDetail, instance: RangeInstanceRecord) {
  return detail.tags.RangeInstanceId === instance.id && detail.tags.SingleInstanceBatchId === instance.singleInstanceBatchId
    && detail.tags.CloudAccountUid === instance.singleInstanceConfig?.cloudAccountUid
    && detail.tags.CloudAccountContextId === instance.singleInstanceConfig?.cloudAccountContextId && detail.tags.ExecutionBackend === 'opentofu'
    && detail.tags.PlatformCreateJobId === instance.singleInstanceConfig?.opentofuCreateJobId
    && (instance.cloudProvider !== 'tencent_cloud' || Boolean(instance.singleInstanceConfig?.opentofuCreateJobId) && detail.tags.PlatformCreateJobId === instance.singleInstanceConfig.opentofuCreateJobId && detail.tags.CreationIntentId === buildTencentSingleCreationIntent(instance,instance.singleInstanceConfig.opentofuCreateJobId) && detail.tags.CloudProvider === 'tencent_cloud')
    && detail.tags.CreatedBy === 'cyber-range-platform' && (detail.tags.PlatformUserId ?? null) === instance.ownerUserId
    && detail.tags.PlatformScope === (instance.ownerUserId ? 'user' : 'platform');
}
function collectSecrets(items: Array<{ instance: RangeInstanceRecord }>) { return items.flatMap(item => Object.values(item.instance.runtimeCredentials ?? {}).map(value => value.password)).filter(Boolean); }
function sanitize(error: unknown, secrets: string[]) {
  let text = error instanceof Error ? error.message : 'OpenTofu batch operation failed';
  const encoded = secrets.flatMap(value => [value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1)]).filter(Boolean).sort((a, b) => b.length - a.length);
  for (const secret of encoded) text = text.split(secret).join('[REDACTED]');
  return text;
}
async function readJson<T>(file: string): Promise<T | null> {
  const contents = await fs.readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw new Error('OpenTofu workspace material cannot be read'); });
  if (contents === null) return null;
  try {
    const value: unknown = JSON.parse(contents);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object');
    return value as T;
  } catch { throw new Error('OpenTofu workspace material is malformed'); }
}
async function exists(file: string) { return fs.access(file).then(() => true, () => false); }
function instanceName(value: string) {
  const clean = value.normalize('NFKC').trim().replace(/[^A-Za-z0-9._\-\u3400-\u9FFF]+/g, '-').replace(/[-_.]{2,}/g, '-').replace(/^[-_.]+|[-_.]+$/g, '');
  return Array.from(/^[A-Za-z\u3400-\u9FFF]/.test(clean) ? clean : `cr-${clean || 'instance'}`).slice(0, 128).join('');
}
