import fs from 'node:fs/promises';
import path from 'node:path';
import { APPLY_PENDING_FILE, assertWorkspaceCanApply, readWorkspaceState, readPendingApplyEvidence, recordApplyPlan, completeApply, hasUnresolvedApply, assertDestroyComplete, fileExists, type WorkspaceState } from './opentofu-state-evidence';
import { prepareOpenTofuProviderEnv, migrateAliCloudWorkspaceProvider } from './provider-mirror-publication';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { requestTencentCloud } from '../admin/tencent-cloud-client';
import { assertApprovedRangeUpdatePlan, assertRangeStateOwnership, assertRangeStateMatchesInventory, preserveDeployedRangeHostFacts } from './range-update-plan-safety';

import {
  OpenTofuRunner,
  type OpenTofuInitOptions,
  type OpenTofuApplyOptions,
  type OpenTofuDestroyOptions,
  type OpenTofuCommandResult,
  type OpenTofuPlanOptions,
  type OpenTofuValidateOptions,
  type OpenTofuShowPlanOptions,
  type OpenTofuImportOptions,
  type OpenTofuWorkspaceCommandOptions,
} from '@aliyun-cyber-range/iac-runner';

import type {
  RangeRuntimeCredentials,
  RangeResourceSummary,
  RangeTemplateCompiledSpec,
  SingleInstanceConfig,
  SingleInstanceNetworkProfileRecord,
} from '../admin/admin.repository';
import { selectZoneAndHostInstanceTypes } from './aliyun-zone-instance-scheduler';
import { DryRunRangeProvisioner } from './dry-run-range-provisioner';
import { describeTencentResourceInventory } from '../admin/tencent-cloud-resources';
import type { SystemCloudAccountContext } from '../admin/system-config.service';
import { renderTencentRangeVariables } from './renderers/tencent-cloud-range-renderer';
import { selectTencentHostInstanceTypes, assertTencentImagesAvailable } from './tencent-cloud-zone-instance-scheduler';
import { buildEnterpriseProvisionPlan } from './enterprise-provision-plan';
import { resolvePreferredInstanceTypes } from './instance-type-catalog';
import { AlibabaCloudOpenTofuRenderer } from './renderers/alibaba-cloud-opentofu-renderer';
import { buildRootWrapperFiles } from './root-wrapper-template';
import { buildSingleInstanceRootWrapperFiles } from './single-instance-root-wrapper-template';
import {
  type ProvisioningAttemptedZoneSummary,
  type RangeProvisionCreateInput,
  type RangeProvisionCreateResult,
  type RangeProvisionDestroyInput,
  type RangeProvisioner,
  type ResolvedProvisioningRuntimeConfig,
  type RangeProvisionStepReporter,
} from './provisioning.types';

type OpenTofuProvisionerEnv = Partial<
  Pick<
    NodeJS.ProcessEnv,
    | 'TENCENTCLOUD_RANGE_NAT_EXECUTION_ENABLED'
    | 'TENCENTCLOUD_PROVIDER_ZIP_PATH'
    | 'TENCENTCLOUD_PROVIDER_UNPACKED_MIRROR_ROOT'
    | 'TENCENTCLOUD_SYSTEM_DISK_TYPE'
    | 'ALICLOUD_ACCESS_KEY'
    | 'ALICLOUD_SECRET_KEY'
    | 'ALICLOUD_REGION'
    | 'ALICLOUD_ZONE_ID'
    | 'ALICLOUD_IMAGE_ID'
    | 'ALICLOUD_IMAGE_ID_PREFERENCES'
    | 'ALICLOUD_INSTANCE_TYPE'
    | 'ALICLOUD_INSTANCE_TYPE_PREFERENCES'
    | 'ALICLOUD_PROVIDER_ZIP_PATH'
    | 'OPENTOFU_PROVIDER_UNPACKED_MIRROR_ROOT'
    | 'RANGE_PROVISIONER_MODE'
    | 'OPENTOFU_BINARY'
    | 'OPENTOFU_WORKSPACES_ROOT'
    | 'PATH'
    | 'TF_CLI_CONFIG_FILE'
    | 'OPENTOFU_INSTANCE_TYPE'
    | 'OPENTOFU_INSTANCE_TYPE_PREFERENCES'
    | 'OPENTOFU_IMAGE_ID'
    | 'OPENTOFU_IMAGE_ID_PREFERENCES'
    | 'OPENTOFU_ALLOWED_INGRESS_CIDR'
    | 'OPENTOFU_SYSTEM_DISK_CATEGORY'
    | 'OPENTOFU_SYSTEM_DISK_SIZE'
    | 'OPENTOFU_INTERNET_MAX_BANDWIDTH_OUT'
    | 'OPENTOFU_PASSTHROUGH_PROXY'
    | 'HTTPS_PROXY'
    | 'HTTP_PROXY'
    | 'ALL_PROXY'
    | 'https_proxy'
    | 'http_proxy'
    | 'all_proxy'
    | 'NO_PROXY'
    | 'no_proxy'
  >
>;

type OpenTofuOutputValue<T> = {
  value: T;
};

type OpenTofuOutputs = {
  public_entry?: OpenTofuOutputValue<{
    host_role?: string;
    public_ip?: string;
    private_ip?: string;
    ssh?: string;
    url?: string;
  }>;
  resource_summary?: OpenTofuOutputValue<{
    vpc_id?: string;
    route_table_ids?: Record<string, string>;
    subnet_ids?: Record<string, string>;
    network_acl_ids?: Record<string, string>;
    security_group_ids?: Record<string, string>;
    host_ids?: Record<string, string>;
    secondary_network_interface_ids?: Record<string, string>;
    nat_gateway_ids?: Record<string, string>;
    snat_entry_ids?: Record<string, string>;
    dnat_entry_ids?: Record<string, string>;
    eip_allocation_id?: string;
    eip_allocation_ids?: Record<string, string>;
    bootstrap_host_keys?: string[];
    runtime_selections?: Record<string, unknown>;
    selected_zone_id?: string;
    attempted_zones?: Array<{
      zone_id?: string;
      can_create_all_hosts?: boolean;
      estimated_total_price?: number | null;
      reason?: string;
    }>;
    resolved_instance_type?: string;
    resolved_image_id?: string;
    resolved_image_ids?: Record<string, string>;
  }>;
};

type OpenTofuRunnerLike = {
  init(options: OpenTofuInitOptions): Promise<OpenTofuCommandResult>;
  validate(options: OpenTofuValidateOptions): Promise<OpenTofuCommandResult>;
  plan(options: OpenTofuPlanOptions): Promise<OpenTofuCommandResult>;
  apply(options: OpenTofuApplyOptions): Promise<OpenTofuCommandResult>;
  output<T>(options: OpenTofuWorkspaceCommandOptions): Promise<T>;
  destroy(options: OpenTofuDestroyOptions): Promise<OpenTofuCommandResult>;
  importResource?(options: OpenTofuImportOptions): Promise<OpenTofuCommandResult>;
  showPlan<T>(options: OpenTofuShowPlanOptions): Promise<T>;
};

type OpenTofuRangeProvisionerOptions = {
  runner?: OpenTofuRunnerLike;
  projectRootDir?: string;
  workspacesRootDir?: string;
  env?: OpenTofuProvisionerEnv;
  enableZoneScheduling?: boolean;
  availableInstanceTypeResolver?: AvailableInstanceTypeResolver;
  availableImageIdResolver?: AvailableImageIdResolver;
};

type CreateRangeProvisionerFromEnvOptions = OpenTofuRangeProvisionerOptions;

type PreparedWorkspace = {
  workspaceDir: string;
  planFilePath: string;
  outputsFilePath: string;
  varsFilePath: string;
  runnerEnv: NodeJS.ProcessEnv;
  priorState?: WorkspaceState;
  priorVariables?: Record<string, any>;
  renderedVariables?: Record<string, any>;
};

type AvailableInstanceTypeResolverInput = {
  accessKey: string;
  secretKey: string;
  regionId: string;
  zoneId: string;
  systemDiskCategory?: string;
  preferredInstanceTypes: string[];
  strictPreferredInstanceTypes?: boolean;
};

type AvailableInstanceTypeResolver = (
  input: AvailableInstanceTypeResolverInput,
) => Promise<string>;

type AvailableImageIdResolverInput = {
  accessKey: string;
  secretKey: string;
  regionId: string;
  requestedImageId?: string;
  preferredImageIds: string[];
};

type AvailableImageIdResolver = (input: AvailableImageIdResolverInput) => Promise<string>;

type HostInstanceResolutionHint = {
  instanceTypePolicyKey?: string;
  requestedCpu?: number;
  requestedMemoryGiB?: number;
  finalInstanceType?: string;
  finalImageId?: string;
  instanceTypeStrategy?: {
    mode?: string;
    instanceType?: string;
    preferredInstanceTypes: string[];
  };
};

const DEFAULT_WORKSPACES_ROOT = '.local/opentofu-workspaces';
const APPLY_STARTED_FILE = APPLY_PENDING_FILE;
const WORKSPACE_STATE_FILES = ['terraform.tfstate', 'terraform.tfstate.backup', 'errored.tfstate'];
const DESTROY_PLACEHOLDER_PASSWORD = 'DestroyOnly123!';

const DEFAULT_AUTO_INSTANCE_TYPE_PREFERENCES = [
  'ecs.u1-c1m2.large',
  'ecs.e-c1m2.large',
  'ecs.t6-c1m2.large',
  'ecs.c6t.large',
  'ecs.hfc6.large',
  'ecs.sn1ne.large',
  'ecs.sn1.medium',
  'ecs.n1.medium',
  'ecs.c7.large',
  'ecs.g7.large',
  'ecs.c6.large',
  'ecs.g6.large',
];
const DEFAULT_AUTO_IMAGE_ID_PREFERENCES = [
  'ubuntu_24_04_x64_20G_alibase_20260615.vhd',
  'ubuntu_22_04_x64_20G_alibase_20260615.vhd',
  'debian_12_14_x64_20G_alibase_20260609.vhd',
  'centos_stream_9_x64_20G_alibase_20260616.vhd',
];
const PROXY_ENV_KEYS = [
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'ALL_PROXY',
  'https_proxy',
  'http_proxy',
  'all_proxy',
  'NO_PROXY',
  'no_proxy',
] as const;
const RUNNER_ENV_KEYS = ['PATH', 'TF_CLI_CONFIG_FILE'] as const;
const ALICLOUD_RPC_FORMAT = 'JSON';
const ALICLOUD_RPC_SIGNATURE_METHOD = 'HMAC-SHA1';
const ALICLOUD_RPC_SIGNATURE_VERSION = '1.0';
const ALICLOUD_RPC_API_VERSION = '2014-05-26';

export function createRangeProvisionerFromEnv(
  options: CreateRangeProvisionerFromEnvOptions = {},
): RangeProvisioner {
  const env = options.env ?? process.env;
  const mode = env.RANGE_PROVISIONER_MODE ?? 'opentofu';

  if (mode === 'dry-run') {
    return new DryRunRangeProvisioner();
  }

  if (mode === 'opentofu') {
    return new OpenTofuRangeProvisioner(options);
  }

  throw new Error(`Unsupported RANGE_PROVISIONER_MODE: ${mode}`);
}

export class OpenTofuRangeProvisioner implements RangeProvisioner {
  readonly mode = 'opentofu' as const;
  private readonly runner: OpenTofuRunnerLike;
  private readonly projectRootDir: string;
  private readonly workspacesRootDir: string;
  private readonly env: OpenTofuProvisionerEnv;
  private readonly enableZoneScheduling: boolean;
  private readonly availableInstanceTypeResolver: AvailableInstanceTypeResolver;
  private readonly availableImageIdResolver: AvailableImageIdResolver;
  private readonly renderer: AlibabaCloudOpenTofuRenderer;

  constructor(options: OpenTofuRangeProvisionerOptions = {}) {
    this.env = {
      ...process.env,
      ...options.env,
    };
    this.projectRootDir = options.projectRootDir ?? process.cwd();
    this.workspacesRootDir = resolveWorkspaceRootDir({
      projectRootDir: this.projectRootDir,
      workspacesRootDir: options.workspacesRootDir,
      env: this.env,
    });
    this.enableZoneScheduling = options.enableZoneScheduling ?? true;
    this.runner =
      options.runner ??
      new OpenTofuRunner({
        binaryPath: this.env.OPENTOFU_BINARY || 'tofu',
      });
    this.availableInstanceTypeResolver =
      options.availableInstanceTypeResolver ?? resolveAvailableAliyunInstanceType;
    this.availableImageIdResolver =
      options.availableImageIdResolver ?? resolveAvailableAliyunImageId;
    this.renderer = new AlibabaCloudOpenTofuRenderer();
  }

  async renderSingleInstanceWorkspace(input: {
    rangeInstanceId: string;
    runtimeCredentials?: RangeRuntimeCredentials;
    singleInstanceConfig: SingleInstanceConfig;
    singleNetworkProfile: SingleInstanceNetworkProfileRecord;
    billingTags?: Record<string, string>;
  }) {
    return {
      files: await this.buildSingleInstanceWorkspaceFiles({
        moduleSource: 'infra/opentofu/modules/alicloud-vpc-single-ecs',
        ...input,
      }),
    };
  }

  async create(input: RangeProvisionCreateInput): Promise<RangeProvisionCreateResult> {
    if (input.runtimeConfig?.provider === 'tencent_cloud' && input.instanceMode === 'single') throw new Error('Tencent single instances must use the frozen batch executor');
    const plan =
      input.instanceMode === 'single'
        ? null
        : buildEnterpriseProvisionPlan({
            rangeInstanceId: input.rangeInstanceId,
            templateModulePath: input.templateModulePath,
            topologySpec: input.topologySpec,
            compiledProvisionSpec: input.compiledProvisionSpec,
            compiledSpec: input.compiledSpec,
            allocatedCidr: input.allocatedCidr,
          });

    const workspace = await runProvisionStep(input.reportStep, 'render_template', async () => {
      const preparedWorkspace = await this.prepareWorkspace(input, {
        preserveWorkspaceState: input.preserveWorkspaceState === true,
        requireRuntimePasswords: true,
      });

      return {
        result: preparedWorkspace,
        message: `Rendered OpenTofu workspace at ${preparedWorkspace.workspaceDir}`,
      };
    });

    await runProvisionStep(input.reportStep, 'tofu_init', async () => {
      const command = await this.runner.init({
        workspaceDir: workspace.workspaceDir,
        signal: input.signal,
        env: workspace.runnerEnv,
        upgrade: true,
      });

      return {
        result: command,
        message: 'OpenTofu init completed.',
        stdoutExcerpt: command.stdout,
        stderrExcerpt: command.stderr,
      };
    });
    await runProvisionStep(input.reportStep, 'tofu_plan', async () => {
      const command = await this.runner.plan({
        workspaceDir: workspace.workspaceDir,
        signal: input.signal,
        env: workspace.runnerEnv,
        planFilePath: workspace.planFilePath,
        varsFilePath: workspace.varsFilePath,
      });

      return {
        result: command,
        message: 'OpenTofu plan completed.',
        stdoutExcerpt: command.stdout,
        stderrExcerpt: command.stderr,
      };
    });
    await runProvisionStep(input.reportStep, 'tofu_apply', async () => {
      const planned = await this.runner.showPlan({ workspaceDir: workspace.workspaceDir,
        signal: input.signal, env: workspace.runnerEnv, planFilePath: workspace.planFilePath });
      if (input.instanceMode !== 'single' && workspace.priorState?.instances.some(resource => ['alicloud_instance','tencentcloud_instance'].includes(resource.type))) {
        assertApprovedRangeUpdatePlan({ plan: planned, state: workspace.priorState, priorVariables: workspace.priorVariables!,
          nextVariables: workspace.renderedVariables!, approval: input.changeApproval!, account: input.runtimeConfig!, rangeInstanceId: input.rangeInstanceId, billingTags: input.billingTags, knownResourceSummary: input.knownResourceSummary });
      }
      await input.onApplyStart?.();
      await recordApplyPlan(workspace.workspaceDir, planned,input.billingTags?.PlatformCreateJobId);
      const command = await this.runner.apply({
        workspaceDir: workspace.workspaceDir,
        signal: input.signal,
        env: workspace.runnerEnv,
        planFilePath: workspace.planFilePath,
      });

      await completeApply(workspace.workspaceDir);
      return {
        result: command,
        message: 'OpenTofu apply completed.',
        stdoutExcerpt: command.stdout,
        stderrExcerpt: command.stderr,
      };
    });

    const outputs = await runProvisionStep(input.reportStep, 'collect_outputs', async () => {
      const collectedOutputs = await this.runner.output<OpenTofuOutputs>({
        workspaceDir: workspace.workspaceDir,
        signal: input.signal,
        env: workspace.runnerEnv,
      });

      const collectedResourceSummary = readOutputValue(collectedOutputs.resource_summary);
      const collectOutputTags = [
        collectedResourceSummary?.resolved_instance_type
          ? `instanceType=${collectedResourceSummary.resolved_instance_type}`
          : null,
        collectedResourceSummary?.resolved_image_id ? `imageId=${collectedResourceSummary.resolved_image_id}` : null,
        collectedResourceSummary?.snat_entry_ids
          ? `snat=${Object.keys(collectedResourceSummary.snat_entry_ids).join(',')}`
          : null,
        collectedResourceSummary?.dnat_entry_ids
          ? `dnat=${Object.keys(collectedResourceSummary.dnat_entry_ids).join(',')}`
          : null,
      ].filter((value): value is string => Boolean(value));

      await fs.writeFile(
        workspace.outputsFilePath,
        `${JSON.stringify(collectedOutputs, null, 2)}\n`,
        'utf8',
      );

      return {
        result: collectedOutputs,
        message: `Collected OpenTofu outputs into ${workspace.outputsFilePath}${collectOutputTags.length > 0 ? ` (${collectOutputTags.join(' | ')})` : ''}`,
      };
    });

    const publicEntry = readOutputValue(outputs.public_entry);
    const resourceSummary = readOutputValue(outputs.resource_summary);
    const stateResources = await this.inspectResources(input);
    const mergeIds = (outputs: Record<string, string> | null | undefined, state: Record<string, string> | null | undefined) => {
      for (const [key, id] of Object.entries(state ?? {})) {
        if (outputs?.[key] && outputs[key] !== id) throw new Error('OpenTofu outputs conflict with persisted resource identity');
      }
      return outputs || state ? { ...outputs, ...state } : null;
    };
    if (resourceSummary?.vpc_id && stateResources?.vpcId && resourceSummary.vpc_id !== stateResources.vpcId)
      throw new Error('OpenTofu outputs conflict with persisted VPC identity');
    const routeTableIds = mergeIds(resourceSummary?.route_table_ids, stateResources?.routeTableIds);

    return {
      accessEntry: {
        hostRole: publicEntry?.host_role ?? 'dmz',
        publicIp: publicEntry?.public_ip ?? null,
        privateIp: publicEntry?.private_ip ?? null,
        ssh: input.runtimeConfig?.provider === 'tencent_cloud' && input.runtimeCredentials?.[publicEntry?.host_role ?? '']?.username === 'Administrator' ? null : publicEntry?.ssh ?? null,
        ...(publicEntry?.url ? { url: publicEntry.url } : {}),
      },
      resourceSummary: {
        mode: 'opentofu',
        workspaceDir: workspace.workspaceDir,
        outputFilePath: workspace.outputsFilePath,
        vpcId: stateResources?.vpcId ?? resourceSummary?.vpc_id ?? null,
        ...(routeTableIds ? { routeTableIds } : {}),
        subnetIds: mergeIds(resourceSummary?.subnet_ids, stateResources?.subnetIds),
        networkAclIds: mergeIds(resourceSummary?.network_acl_ids, stateResources?.networkAclIds),
        securityGroupIds: mergeIds(resourceSummary?.security_group_ids, stateResources?.securityGroupIds),
        hostIds: mergeIds(resourceSummary?.host_ids, stateResources?.hostIds),
        ...(stateResources?.systemDiskIds ? { systemDiskIds: stateResources.systemDiskIds } : {}),
        secondaryNetworkInterfaceIds: mergeIds(resourceSummary?.secondary_network_interface_ids, stateResources?.secondaryNetworkInterfaceIds),
        natGatewayIds: mergeIds(resourceSummary?.nat_gateway_ids, stateResources?.natGatewayIds),
        snatEntryIds: mergeIds(resourceSummary?.snat_entry_ids, stateResources?.snatEntryIds),
        dnatEntryIds: mergeIds(resourceSummary?.dnat_entry_ids, stateResources?.dnatEntryIds),
        eipAllocationId: resourceSummary?.eip_allocation_id ?? null,
        eipAllocationIds: mergeIds(resourceSummary?.eip_allocation_ids, stateResources?.eipAllocationIds),
        bootstrapHostKeys: resourceSummary?.bootstrap_host_keys ?? null,
        runtimeSelections: resourceSummary?.runtime_selections ?? null,
        selectedZoneId: resourceSummary?.selected_zone_id ?? null,
        attemptedZones: resourceSummary?.attempted_zones?.map((zone) => ({
          zoneId: zone.zone_id ?? '',
          canCreateAllHosts: zone.can_create_all_hosts ?? false,
          estimatedTotalPrice: zone.estimated_total_price ?? null,
          ...(zone.reason ? { reason: zone.reason } : {}),
        })) ?? null,
        resolvedInstanceType: resourceSummary?.resolved_instance_type ?? null,
        resolvedImageId: resourceSummary?.resolved_image_id ?? null,
        resolvedImageIds: resourceSummary?.resolved_image_ids ?? null,
        ...(plan ? { topologySpec: plan.topologySummary } : {}),
      },
    };
  }

  async destroy(input: RangeProvisionDestroyInput): Promise<void> {
    const workspace = await runProvisionStep(input.reportStep, 'render_template', async () => {
      const preparedWorkspace = await this.prepareDestroyWorkspace(input);

      return {
        result: preparedWorkspace,
        message: preparedWorkspace
          ? `Reusing persisted destroy workspace at ${preparedWorkspace.workspaceDir}`
          : 'No local state or apply attempt exists; nothing to destroy.',
      };
    });

    if (!workspace) {
      return;
    }

    await runProvisionStep(input.reportStep, 'tofu_init', async () => {
      const command = await this.runner.init({
        workspaceDir: workspace.workspaceDir,
        signal: input.signal,
        env: workspace.runnerEnv,
        upgrade: true,
      });

      return {
        result: command,
        message: 'OpenTofu init completed before destroy.',
        stdoutExcerpt: command.stdout,
        stderrExcerpt: command.stderr,
      };
    });
    const priorState = (await readWorkspaceState(workspace.workspaceDir, true))!;
    const unresolvedApply = await hasUnresolvedApply(workspace.workspaceDir, priorState);
    await runProvisionStep(input.reportStep, 'destroy', async () => {
      const command = await this.runner.destroy({
        workspaceDir: workspace.workspaceDir,
        signal: input.signal,
        env: workspace.runnerEnv,
        varsFilePath: workspace.varsFilePath,
      });

      let absenceProof = input.runtimeConfig?.provider === 'tencent_cloud'
        ? await this.readTencentAbsenceProof(workspace.workspaceDir,input,priorState) : false;
      if (unresolvedApply && input.runtimeConfig?.provider === 'alibaba_cloud' && input.verifyUnresolvedApplyAbsence) {
        const empty = await readWorkspaceState(workspace.workspaceDir, true);
        if (!empty || empty.lineage !== priorState.lineage || empty.serial < priorState.serial || empty.instances.length)
          throw new Error('Alibaba absence recovery requires a verified empty state in its original lineage');
        const pending = await readPendingApplyEvidence(workspace.workspaceDir);
        const variables = JSON.parse(await fs.readFile(workspace.varsFilePath, 'utf8'));
        const tags = variables.tags;
        if (input.instanceMode === 'single' || input.templateModulePath !== 'infra/opentofu/modules/alicloud-enterprise-range'
          || !pending?.sourceProvisionJobId || !pending.submittedAt || !Number.isFinite(Date.parse(pending.submittedAt))
          || variables.resource_name_prefix !== input.rangeInstanceId || variables.zone_id !== input.runtimeConfig.defaultZoneId
          || !tags || tags.CloudProvider !== 'alibaba_cloud' || tags.CreatedBy !== 'cyber-range-platform' || tags.PlatformManaged !== 'true'
          || tags.RangeInstanceId !== input.rangeInstanceId || tags.CloudAccountUid !== input.runtimeConfig.accountUid
          || tags.CloudAccountContextId !== input.runtimeConfig.cloudAccountContextId || tags.PlatformCreateJobId !== pending.sourceProvisionJobId
          || ['PlatformScope','PlatformUserId'].some(key => input.billingTags?.[key] !== undefined && tags[key] !== input.billingTags[key])
          || !Array.isArray(variables.hosts) || !variables.hosts.length || variables.hosts.some((host: any) => typeof host?.key !== 'string' || !host.key)
          || !Array.isArray(variables.eips) || variables.eips.some((eip: any) => typeof eip?.name !== 'string' || !eip.name))
          throw new Error('Alibaba absence recovery intent differs from its original frozen submission');
        await input.verifyUnresolvedApplyAbsence({ sourceProvisionJobId: pending.sourceProvisionJobId, submittedAt: pending.submittedAt,
          hostKeys: variables.hosts.map((host: any) => host.key), eipNames: variables.eips.map((eip: any) => eip.name.replaceAll(' ', '-').slice(0,128)) });
        if (JSON.stringify(await readPendingApplyEvidence(workspace.workspaceDir)) !== JSON.stringify(pending))
          throw new Error('Alibaba pending apply generation changed during absence recovery');
        absenceProof = true;
      }
      await assertDestroyComplete(workspace.workspaceDir, priorState, unresolvedApply && !absenceProof);
      await fs.rm(path.join(workspace.workspaceDir,'.tencent-apply-absence-proved.json'),{force:true});
      return {
        result: command,
        message: 'OpenTofu destroy completed.',
        stdoutExcerpt: command.stdout,
        stderrExcerpt: command.stderr,
      };
    });
  }

  async recoverUntrackedResources(input: RangeProvisionDestroyInput, assertCurrent: () => Promise<void>, persist: (summary: RangeResourceSummary, sourceProvisionJobId: string) => Promise<void>) {
    if (input.runtimeConfig?.provider !== 'tencent_cloud') return;
    const account = input.runtimeConfig as SystemCloudAccountContext;
    const dir = path.join(this.workspacesRootDir,input.rangeInstanceId);
    const pending = await readPendingApplyEvidence(dir);
    if (!pending) return;
    await this.assertTencentWorkspaceIdentity(dir,input);
    const state = await readWorkspaceState(dir,true);
    if (!state || !pending.sourceProvisionJobId || !pending.submittedAt || !Number.isFinite(Date.parse(pending.submittedAt))) throw new Error('Tencent recovery requires the original durable submission and state lineage');
    if (!input.assertRecoverySourceJob) throw new Error('Tencent recovery requires the original submitted platform source job proof');
    const verifiedSourceJobs = new Set<string>();
    const verifySourceJob = async (id: unknown) => {
      if (typeof id !== 'string' || !id) throw new Error('Tencent recovery resource has no original submitted platform source job');
      if (!verifiedSourceJobs.has(id)) { await input.assertRecoverySourceJob!(id); verifiedSourceJobs.add(id); }
    };
    await verifySourceJob(pending.sourceProvisionJobId);
    const variables = JSON.parse(await fs.readFile(path.join(dir,'range.auto.tfvars.json'),'utf8'));
    const tags = variables.tags as Record<string,string>;
    if (!tags || tags.PlatformCreateJobId !== pending.sourceProvisionJobId || tags.CloudAccountContextId !== account.cloudAccountContextId || tags.CloudAccountUid !== account.accountUid || tags.RangeInstanceId !== input.rangeInstanceId) throw new Error('Tencent recovery intent differs from its original source job');
    const vpc = state.instances.find(resource => resource.type === 'tencentcloud_vpc');
    const originalVpcId = vpc ? String(vpc.attributes.id) : input.knownResourceSummary?.vpcId;
    if (!originalVpcId) throw new Error('Tencent recovery cannot adopt a network without its original persisted VPC identity');
    const ownedVpcs = await describeTencentResourceInventory(account,'vpc',{ ids: [originalVpcId] });
    if (!ownedVpcs.length) {
      await this.proveTencentUnknownApplyAbsent(input,dir,pending,state,tags,originalVpcId,assertCurrent);
      return;
    }
    if (!vpc) throw new Error('Tencent recovery cannot adopt a network without its original persisted VPC identity');
    const tagKeys = ['CloudProvider','PlatformManaged','CreatedBy','PlatformScope','PlatformUserId','CloudAccountUid','CloudAccountContextId','RangeInstanceId','PlatformCreateJobId'];
    const owns = (actual: Record<string,string>) => tagKeys.every(key => tags[key] === undefined ? actual[key] === undefined : actual[key] === tags[key]);
    const ownsExisting = async (resource: { id: string; tags: Record<string,string> }, original: WorkspaceState['instances'][number], recordedIds: string[]) => {
      const originalTags = original.attributes.tags as Record<string,string> | undefined;
      const identityKeys = tagKeys.filter(key => key !== 'PlatformCreateJobId');
      if (!originalTags || original.module !== 'module.range' || original.attributes.id !== resource.id || !recordedIds.includes(resource.id)
        || identityKeys.some(key => originalTags[key] !== tags[key] || resource.tags[key] !== tags[key])
        || ![originalTags.PlatformCreateJobId,pending.sourceProvisionJobId].includes(resource.tags.PlatformCreateJobId))
        throw new Error('Tencent existing recovery resource differs from its frozen state and platform ownership inventory');
      await verifySourceJob(originalTags.PlatformCreateJobId); await verifySourceJob(resource.tags.PlatformCreateJobId);
    };
    if (ownedVpcs.length !== 1 || input.knownResourceSummary?.mode !== 'opentofu' || !input.knownResourceSummary.executionContext
      || input.knownResourceSummary.executionContext.provider !== 'tencent_cloud'
      || input.knownResourceSummary.executionContext.cloudAccountUid !== account.accountUid
      || input.knownResourceSummary.executionContext.cloudAccountContextId !== account.cloudAccountContextId
      || input.knownResourceSummary.executionContext.regionId !== account.defaultRegion
      || input.knownResourceSummary.executionContext.zoneId !== account.defaultZoneId)
      throw new Error('Tencent recovery VPC ownership cannot be independently verified');
    await ownsExisting(ownedVpcs[0],vpc,input.knownResourceSummary.vpcId ? [input.knownResourceSummary.vpcId] : []);
    const expected = [
      ...variables.eips.map((value: any) => ({ kind: 'eip' as const, type: 'tencentcloud_eip', name: 'range', value })),
      ...variables.nat_gateways.map((value: any) => ({ kind: 'nat' as const, type: 'tencentcloud_nat_gateway', name: 'shared', value })),
    ];
    const missing = expected.filter(entry => {
      const address = `module.range.${entry.type}.${entry.name}[${JSON.stringify(entry.value.key)}]`;
      return pending.createAddresses.includes(address) && !state.instances.some(resource => resource.address === address);
    });
    if (!missing.length) {
      // A partial first apply can be fully represented in state while outputs
      // and creation billing evidence were never persisted. Record that proven
      // birth job even when no native resource needs state import.
      await assertCurrent();
      await persist({ mode: 'opentofu' }, pending.sourceProvisionJobId);
      return;
    }
    if (!this.runner.importResource) throw new Error('Tencent recovery requires fenced OpenTofu state import support');
    // EIPs being removed can remain in partial state. They are cleanup evidence, not inputs of the new NAT.
    const allEipIds = state.instances.filter(resource => resource.type === 'tencentcloud_eip'
      && variables.eips.some((value: any) => value.key === resourceInstanceKey(resource.address))).map(resource => String(resource.attributes.id));
    const eips = allEipIds.length ? await describeTencentResourceInventory(account,'eip',{ ids: allEipIds }) : [];
    if (eips.length !== allEipIds.length || new Set(eips.map(eip => eip.id)).size !== eips.length
      || eips.some(eip => !allEipIds.includes(eip.id))) throw new Error('Tencent existing recovery EIP inventory is incomplete');
    for (const eip of eips) {
      const original = state.instances.find(resource => resource.type === 'tencentcloud_eip' && resource.attributes.id === eip.id)!;
      const allocation = variables.eips.filter((value: any) => value.key === resourceInstanceKey(original.address));
      const intent = allocation[0]?.creation_intent_id;
      await ownsExisting(eip,original,Object.values(input.knownResourceSummary.eipAllocationIds ?? {}));
      if (allocation.length !== 1 || typeof intent !== 'string' || !/^[a-f0-9]{32}$/.test(intent)
        || original.attributes.client_token !== intent || (original.attributes.tags as Record<string,string>).CreationIntentId !== intent
        || eip.tags.CreationIntentId !== intent || original.attributes.name !== `${variables.resource_name_prefix}-${intent.slice(0,16)}`
        || eip.name !== original.attributes.name || eip.bandwidth !== allocation[0].bandwidth || !eip.publicIp)
        throw new Error('Tencent existing recovery EIP differs from its frozen allocation intent');
    }
    const recovered: Array<{ address: string; id: string; field: 'eipAllocationIds'|'natGatewayIds'; key: string }> = [];
    for (const entry of missing) {
      await assertCurrent(); input.signal?.throwIfAborted();
      const intent = entry.value.creation_intent_id;
      if (typeof intent !== 'string' || !/^[a-f0-9]{32}$/.test(intent)) throw new Error('Tencent recovery has no exact atomic creation nonce');
      const candidates = await describeTencentResourceInventory(account,entry.kind,{ tags: { RangeInstanceId: input.rangeInstanceId, CreationIntentId: intent }, ...(entry.kind === 'nat' ? { vpcId: ownedVpcs[0].id } : {}) });
      const candidate = candidates[0];
      const expectedName = `${variables.resource_name_prefix}-${intent.slice(0,16)}`;
      if (candidates.length !== 1 || !candidate || !owns(candidate.tags) || candidate.tags.CreationIntentId !== intent || candidate.name !== expectedName) throw new Error('Tencent submitted resource has no unique independently proven recovery match');
      if (entry.kind === 'eip') {
        if (!candidate.publicIp || candidate.bandwidth !== entry.value.bandwidth) throw new Error('Tencent EIP recovery does not match its frozen allocation');
        eips.push(candidate);
      } else {
        const expectedAddresses = eips.map(eip => eip.publicIp).filter(Boolean);
        if (candidate.vpcId !== ownedVpcs[0].id || candidate.natProductVersion !== 2 || candidate.bandwidth !== 5000 || candidate.maxConcurrent !== 2000000 || !Array.isArray(candidate.publicIpAddresses) || !expectedAddresses.length || candidate.publicIpAddresses.length !== expectedAddresses.length || candidate.publicIpAddresses.some(ip => !expectedAddresses.includes(ip))) throw new Error('Tencent NAT recovery does not match its original VPC, EIPs and specifications');
      }
      recovered.push({ address: `module.range.${entry.type}.${entry.name}[${JSON.stringify(entry.value.key)}]`, id: candidate.id, key: entry.value.key, field: entry.kind === 'nat' ? 'natGatewayIds' : 'eipAllocationIds' });
    }
    const summary: RangeResourceSummary = { mode: 'opentofu', natGatewayIds: {}, eipAllocationIds: {} };
    for (const entry of recovered) summary[entry.field]![entry.key] = entry.id;
    await assertCurrent();
    await persist(summary,pending.sourceProvisionJobId);
    const env = await this.buildRunnerEnv(account);
    await this.runner.init({ workspaceDir: dir, env, signal: input.signal, upgrade: true });
    for (const entry of recovered) {
      await assertCurrent(); input.signal?.throwIfAborted();
      await this.runner.importResource({ workspaceDir: dir, env, signal: input.signal, varsFilePath: path.join(dir,'range.auto.tfvars.json'), address: entry.address, resourceId: entry.id });
      const imported = await readWorkspaceState(dir,true);
      if (imported?.lineage !== state.lineage || imported.instances.find(resource => resource.address === entry.address)?.attributes.id !== entry.id) throw new Error('Tencent recovery import did not persist its exact original identity');
    }
    await assertCurrent();
  }

  private async proveTencentUnknownApplyAbsent(input: RangeProvisionDestroyInput, dir: string,
    pending: NonNullable<Awaited<ReturnType<typeof readPendingApplyEvidence>>>, state: NonNullable<Awaited<ReturnType<typeof readWorkspaceState>>>,
    tags: Record<string,string>, vpcId: string, assertCurrent: () => Promise<void>) {
    const account = input.runtimeConfig as SystemCloudAccountContext;
    const bound = input.knownResourceSummary?.executionContext;
    if (!bound || bound.provider !== 'tencent_cloud' || bound.cloudAccountUid !== account.accountUid || bound.cloudAccountContextId !== account.cloudAccountContextId
      || bound.regionId !== account.defaultRegion || bound.zoneId !== account.defaultZoneId || input.knownResourceSummary?.vpcId !== vpcId
      || tags.CloudProvider !== 'tencent_cloud' || tags.CreatedBy !== 'cyber-range-platform' || tags.PlatformManaged !== 'true'
      || !['user','platform'].includes(tags.PlatformScope) || tags.PlatformScope === 'user' && !tags.PlatformUserId
      || tags.PlatformScope === 'platform' && Boolean(tags.PlatformUserId)
      || ['PlatformScope','PlatformUserId'].some(key => input.billingTags?.[key] !== undefined && input.billingTags[key] !== tags[key]))
      throw new Error('Tencent absence recovery requires its original frozen resource inventory and owner');
    const fields = { ecs:'hostIds',disk:'systemDiskIds',vpc:'vpcId',vswitch:'subnetIds',security_group:'securityGroupIds',network_acl:'networkAclIds',eni:'secondaryNetworkInterfaceIds',nat:'natGatewayIds',eip:'eipAllocationIds' } as const;
    const stateKinds = { ecs:'tencentcloud_instance',vpc:'tencentcloud_vpc',vswitch:'tencentcloud_subnet',security_group:'tencentcloud_security_group',network_acl:'tencentcloud_vpc_acl',eni:'tencentcloud_eni',nat:'tencentcloud_nat_gateway',eip:'tencentcloud_eip' };
    const ids = (kind: keyof typeof fields): string[] => {
      const collect = (summary: RangeResourceSummary): string[] => {
        if (!summary.executionContext || ['provider','cloudAccountUid','cloudAccountContextId','regionId','zoneId'].some(key => (summary.executionContext as any)[key] !== (bound as any)[key]))
          throw new Error('Tencent absence recovery inventory has conflicting frozen identities');
        const value = summary[fields[kind]];
        return [...(typeof value === 'string' ? [value] : Object.values(value ?? {})),
          ...(kind === 'disk' ? Object.values(summary.dataDiskIds ?? {}) : []), ...(kind === 'eip' && summary.eipAllocationId ? [summary.eipAllocationId] : []),
          ...(summary.retiredResources ? collect(summary.retiredResources) : [])];
      };
      const stateIds = kind === 'disk' ? state.instances.filter(entry => entry.type === 'tencentcloud_instance').map(entry => entry.attributes.system_disk_id)
        : state.instances.filter(entry => entry.type === stateKinds[kind]).map(entry => entry.attributes.id);
      return [...new Set([...collect(input.knownResourceSummary!), ...stateIds.filter((value): value is string => typeof value === 'string' && Boolean(value))])];
    };
    const scopeTags = Object.fromEntries(['CloudProvider','PlatformManaged','CreatedBy','PlatformScope','PlatformUserId','CloudAccountUid','CloudAccountContextId','RangeInstanceId']
      .filter(key => tags[key] !== undefined).map(key => [key,tags[key]]));
    const verifyAccountInventory = async (action:'DescribeNetworkAcls'|'DescribeRouteTables', setKey:'NetworkAclSet'|'RouteTableSet', idKey:'NetworkAclId'|'RouteTableId', known:string[]) => {
      const seen = new Set<string>(); let total: number | undefined;
      for (let page=0;page<100;page++) {
        await assertCurrent(); input.signal?.throwIfAborted();
        const response = await requestTencentCloud<Record<string,unknown>>({service:'vpc',version:'2017-03-12',action,regionId:account.defaultRegion,
          accessKeyId:account.accessKeyId,accessKeySecret:account.accessKeySecret,parameters: action === 'DescribeRouteTables' ? {Offset:String(seen.size),Limit:'100'} : {Offset:seen.size,Limit:100}});
        const rows = response[setKey];
        if (typeof response.RequestId !== 'string' || !response.RequestId.trim() || response.Error || response.NextToken
          || !Number.isSafeInteger(response.TotalCount) || Number(response.TotalCount)<0 || !Array.isArray(rows) || rows.length>100
          || total !== undefined && total !== response.TotalCount) throw new Error('Tencent account inventory is incomplete during absence recovery');
        total=Number(response.TotalCount);
        for (const raw of rows) {
          if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Tencent account inventory contains malformed resources');
          const row=raw as Record<string,unknown>; const id=row[idKey];
          if (typeof id !== 'string' || !(action === 'DescribeNetworkAcls' ? /^acl-[A-Za-z0-9]+$/ : /^rtb-[A-Za-z0-9]+$/).test(id) || seen.has(id)
            || typeof row.VpcId !== 'string' || !/^vpc-[A-Za-z0-9]+$/.test(row.VpcId)) throw new Error('Tencent account inventory identities are incomplete or duplicated');
          seen.add(id);
          const actualTags:Record<string,string>=Object.create(null);
          if (row.TagSet !== undefined && row.TagSet !== null) {
            if (!Array.isArray(row.TagSet)) throw new Error('Tencent account inventory tags are malformed');
            for (const tag of row.TagSet) {
              if (!tag || typeof tag !== 'object' || typeof tag.Key !== 'string' || !tag.Key || typeof tag.Value !== 'string' || Object.hasOwn(actualTags,tag.Key))
                throw new Error('Tencent account inventory tags are malformed');
              actualTags[tag.Key]=tag.Value;
            }
          }
          if (known.includes(id) || row.VpcId === vpcId || Object.entries(scopeTags).every(([key,value]) => actualTags[key] === value))
            throw new Error('Tencent original network resources remain in complete account inventory');
        }
        if (seen.size>total || seen.size<total && !rows.length) throw new Error('Tencent account inventory pagination is incomplete');
        if (seen.size === total) return;
      }
      throw new Error('Tencent account inventory pagination exceeded its recovery bound');
    };
    for (let round = 0; round < 2; round++) {
      await assertCurrent(); input.signal?.throwIfAborted();
      for (const kind of Object.keys(fields) as Array<keyof typeof fields>) {
        const known = ids(kind);
        if (known.length && (await describeTencentResourceInventory(account,kind,{ids:known})).length)
          throw new Error('Tencent original tracked resources remain; preserve unknown apply recovery material');
        if (kind === 'network_acl') await verifyAccountInventory('DescribeNetworkAcls','NetworkAclSet','NetworkAclId',known);
        else if ((await describeTencentResourceInventory(account,kind,{tags:scopeTags})).length) throw new Error('Tencent original range resources remain; preserve unknown apply recovery material');
      }
      const recordedRoutes = (summary: RangeResourceSummary): string[] => [...Object.values(summary.routeTableIds ?? {}), ...(summary.retiredResources ? recordedRoutes(summary.retiredResources) : [])];
      const routeIds = [...new Set([...recordedRoutes(input.knownResourceSummary!), ...state.instances.filter(entry => entry.type === 'tencentcloud_route_table').map(entry => String(entry.attributes.id))])];
      await verifyAccountInventory('DescribeRouteTables','RouteTableSet','RouteTableId',routeIds);
    }
    await assertCurrent();
    const proof = { version:1, identity:this.tencentWorkspaceIdentity(input), pendingHash:createHash('sha256').update(JSON.stringify(pending)).digest('hex'),
      lineage:state.lineage, serial:state.serial, observedAt:new Date().toISOString() };
    const file = path.join(dir,'.tencent-apply-absence-proved.json');
    await fs.writeFile(`${file}.tmp`,JSON.stringify(proof),{mode:0o600});
    await assertCurrent(); await fs.rename(`${file}.tmp`,file);
  }

  private async readTencentAbsenceProof(dir: string,input: RangeProvisionDestroyInput,state: NonNullable<Awaited<ReturnType<typeof readWorkspaceState>>>) {
    const file = path.join(dir,'.tencent-apply-absence-proved.json');
    if (!await fileExists(file)) return false;
    const proof = JSON.parse(await fs.readFile(file,'utf8'));
    const pending = await readPendingApplyEvidence(dir);
    return Boolean(pending && proof.version === 1 && proof.lineage === state.lineage && proof.serial === state.serial
      && JSON.stringify(proof.identity) === JSON.stringify(this.tencentWorkspaceIdentity(input))
      && proof.pendingHash === createHash('sha256').update(JSON.stringify(pending)).digest('hex')
      && Number.isFinite(Date.parse(proof.observedAt)) && Date.now()-Date.parse(proof.observedAt) >= 0 && Date.now()-Date.parse(proof.observedAt) < 5*60_000);
  }

  async inspectResources(input: RangeProvisionDestroyInput): Promise<RangeResourceSummary | null> {
    const dir = path.join(this.workspacesRootDir, input.rangeInstanceId);
    const state = await readWorkspaceState(dir, input.requirePersistedState === true);
    if (!state) return null;
    const summary: RangeResourceSummary = { mode: 'opentofu', workspaceDir: dir };
    const tencent = input.runtimeConfig?.provider === 'tencent_cloud';
    if (tencent) await this.assertTencentWorkspaceIdentity(dir, input);
    const fields: Record<string, keyof RangeResourceSummary> = {
      tencentcloud_route_table: 'routeTableIds',
      tencentcloud_subnet: 'subnetIds', tencentcloud_vpc_acl: 'networkAclIds', tencentcloud_security_group: 'securityGroupIds',
      tencentcloud_instance: 'hostIds', tencentcloud_eni: 'secondaryNetworkInterfaceIds',
      tencentcloud_nat_gateway: 'natGatewayIds', tencentcloud_nat_gateway_snat: 'snatEntryIds', tencentcloud_dnat: 'dnatEntryIds', tencentcloud_eip: 'eipAllocationIds',
      alicloud_vswitch: 'subnetIds', alicloud_network_acl: 'networkAclIds', alicloud_security_group: 'securityGroupIds',
      alicloud_instance: 'hostIds', alicloud_network_interface: 'secondaryNetworkInterfaceIds',
      alicloud_nat_gateway: 'natGatewayIds', alicloud_snat_entry: 'snatEntryIds', alicloud_forward_entry: 'dnatEntryIds',
      alicloud_eip_address: 'eipAllocationIds',
    };
    for (const instance of state.instances) {
      if (tencent) {
        const tagged = new Set(['tencentcloud_vpc','tencentcloud_subnet','tencentcloud_security_group','tencentcloud_instance','tencentcloud_eni','tencentcloud_vpc_acl','tencentcloud_eip','tencentcloud_nat_gateway','tencentcloud_route_table']);
        const relations = new Set(['tencentcloud_security_group_rule_set','tencentcloud_eni_attachment','tencentcloud_eni_ipv4_address','tencentcloud_vpc_acl_attachment','tencentcloud_route_table_entry','tencentcloud_nat_gateway_snat','tencentcloud_dnat','tencentcloud_route_table_association']);
        if (instance.module !== 'module.range' || !tagged.has(instance.type) && !relations.has(instance.type)) throw new Error('Tencent state contains resources outside this range');
        const tags = instance.attributes.tags as Record<string,string> | undefined;
        if (tagged.has(instance.type) && (!tags || tags.CloudProvider !== 'tencent_cloud' || tags.RangeInstanceId !== input.rangeInstanceId || tags.CloudAccountContextId !== input.runtimeConfig?.cloudAccountContextId || tags.CloudAccountUid !== input.runtimeConfig?.accountUid || tags.CreatedBy !== 'cyber-range-platform' || !tags.PlatformCreateJobId || ['PlatformScope','PlatformUserId'].some(key => input.billingTags?.[key] && tags[key] !== input.billingTags[key]))) throw new Error('Tencent range state ownership or creation source cannot be verified');
        if (instance.type === 'tencentcloud_instance' && (typeof instance.attributes.client_token !== 'string' || instance.attributes.client_token !== tags?.CreationIntentId || typeof instance.attributes.action_timer_terminate_at !== 'string')) throw new Error('Tencent CVM state lacks a frozen idempotent creation and termination intent');
      }
      if (instance.type.startsWith('alicloud_')) {
        const tagTypes = new Set(['alicloud_vpc', 'alicloud_vswitch', 'alicloud_network_acl', 'alicloud_security_group', 'alicloud_instance', 'alicloud_network_interface', 'alicloud_nat_gateway', 'alicloud_eip_address']);
        const relationTypes = new Set(['alicloud_vpc_ipv4_cidr_block', 'alicloud_security_group_rule', 'alicloud_network_interface_attachment', 'alicloud_eip_association', 'alicloud_snat_entry', 'alicloud_forward_entry']);
        if (instance.module !== 'module.range' || (!tagTypes.has(instance.type) && !relationTypes.has(instance.type)))
          throw new Error('OpenTofu state contains resources outside this range');
        const tags = instance.attributes.tags as Record<string, unknown> | undefined;
        if (tagTypes.has(instance.type) && tags?.range_instance_id !== input.rangeInstanceId && tags?.RangeInstanceId !== input.rangeInstanceId)
          throw new Error('OpenTofu range resource ownership could not be verified');
        if (tagTypes.has(instance.type) && ['CloudAccountContextId', 'CloudAccountUid'].some(key => input.billingTags?.[key] && tags?.[key] !== input.billingTags[key]))
          throw new Error('OpenTofu range resource source account could not be verified');
      }
      if (['alicloud_vpc','tencentcloud_vpc'].includes(instance.type)) {
        if (summary.vpcId && summary.vpcId !== instance.attributes.id) throw new Error('OpenTofu state contains multiple VPCs');
        summary.vpcId = instance.attributes.id as string;
      }
      const field = fields[instance.type];
      if (field) {
        const values = (summary[field] ?? Object.create(null)) as Record<string, string>;
        addResourceId(values, instance.address, instance.attributes.id as string);
        (summary as Record<string, unknown>)[field] = values;
      }
      if (['alicloud_instance','tencentcloud_instance'].includes(instance.type) && typeof instance.attributes.system_disk_id === 'string' && instance.attributes.system_disk_id)
        addResourceId(summary.systemDiskIds ??= Object.create(null), instance.address, instance.attributes.system_disk_id);
    }
    return summary;
  }

  private async prepareDestroyWorkspace(input: RangeProvisionDestroyInput): Promise<PreparedWorkspace | null> {
    const workspaceDir = path.join(this.workspacesRootDir, input.rangeInstanceId);
    if (!(await readWorkspaceState(workspaceDir, input.requirePersistedState === true))) {
      return null;
    }

    await this.inspectResources(input);
    const varsFileName = input.instanceMode === 'single' ? 'terraform.tfvars.json' : 'range.auto.tfvars.json';
    const varsFilePath = path.join(workspaceDir, varsFileName);
    for (const file of ['main.tf', 'variables.tf', 'outputs.tf', 'versions.tf', varsFileName]) {
      await assertFileExists(path.join(workspaceDir, file), 'Persisted OpenTofu destroy configuration is missing');
    }
    if (input.runtimeConfig?.provider !== 'tencent_cloud') await migrateAliCloudWorkspaceProvider(workspaceDir);
    else await this.assertTencentWorkspaceIdentity(workspaceDir, input);

    return {
      workspaceDir,
      planFilePath: path.join(workspaceDir, 'range.tfplan'),
      outputsFilePath: path.join(workspaceDir, 'outputs.json'),
      varsFilePath,
      runnerEnv: await this.buildRunnerEnv(input.runtimeConfig),
    };
  }

  private async prepareWorkspace(
    input: RangeProvisionCreateInput | RangeProvisionDestroyInput,
    options: {
      preserveWorkspaceState: boolean;
      requireRuntimePasswords: boolean;
    },
  ): Promise<PreparedWorkspace> {
    if (input.instanceMode === 'single') {
      return this.prepareSingleInstanceWorkspace(input, options);
    }

    const moduleDir = path.resolve(this.projectRootDir, input.templateModulePath);
    if (input.runtimeConfig?.provider === 'tencent_cloud' && input.templateModulePath !== 'infra/opentofu/modules/tencentcloud-enterprise-range') throw new Error('Tencent range module must match its cloud provider');
    const workspaceDir = path.join(this.workspacesRootDir, input.rangeInstanceId);
    const planFilePath = path.join(workspaceDir, 'range.tfplan');
    const outputsFilePath = path.join(workspaceDir, 'outputs.json');
    const varsFilePath = path.join(workspaceDir, 'range.auto.tfvars.json');
    let priorState: WorkspaceState | null = null;

    await assertDirectoryExists(moduleDir, 'OpenTofu module path does not exist');
    if (options.preserveWorkspaceState) {
      priorState = await assertWorkspaceCanApply(workspaceDir, input.requirePersistedState === true);
      if (input.runtimeConfig?.provider === 'tencent_cloud') await this.assertTencentWorkspaceIdentity(workspaceDir, input);
    } else {
      if (input.requirePersistedState) throw new Error('OpenTofu state recovery is required before proceeding; persisted workspace was preserved');
      await assertUnusedWorkspace(workspaceDir);
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
    await fs.mkdir(workspaceDir, { recursive: true });

    const wrapperFiles: Record<string,string> = input.runtimeConfig?.provider === 'tencent_cloud' ? {} : buildRootWrapperFiles(moduleDir);

    await Promise.all(
      Object.entries(wrapperFiles).map(async ([fileName, contents]) => {
        await fs.writeFile(path.join(workspaceDir, fileName), contents, 'utf8');
      }),
    );

    let priorVariables: Record<string, any> | undefined;
    if (priorState?.instances.some(resource => ['alicloud_instance', 'tencentcloud_instance'].includes(resource.type))) {
      try { priorVariables = JSON.parse(await fs.readFile(varsFilePath, 'utf8')); }
      catch { throw new Error('Existing host startup data cannot be verified; persisted variables were preserved'); }
      assertRangeStateOwnership(priorState, priorVariables!, input.runtimeConfig!, input.rangeInstanceId, input.billingTags);
      if (!('changeApproval' in input) || !input.changeApproval) throw new Error('Runtime topology update requires a confirmed preview; persisted variables were preserved');
      assertRangeStateMatchesInventory(priorState, input.knownResourceSummary, input.runtimeConfig!);
    }
    let variables = await this.buildVariables(input, {
      requireRuntimePasswords: options.requireRuntimePasswords,
      ...(priorState && priorVariables ? { priorState, priorVariables } : {}),
    });
    if (priorState && priorVariables) {
      variables = preserveDeployedRangeUserData(input, priorState, priorVariables, variables);
      variables = preserveDeployedRangeHostFacts(priorState, priorVariables, variables, input.runtimeConfig!);
    }
    await fs.writeFile(varsFilePath, `${JSON.stringify(variables, null, 2)}\n`, 'utf8');

    if (input.runtimeConfig?.provider === 'tencent_cloud') {
      const values = variables as Record<string,unknown>;
      const lines = Object.keys(values).map(key => `  ${key} = var.${key}`).join('\n');
      const files = {
        'main.tf': `provider "tencentcloud" { region = var.region }\nmodule "range" {\n source = ${JSON.stringify(moduleDir)}\n${lines}\n}\n`,
        'variables.tf': Object.keys(values).map(key => key === 'host_passwords' ? `variable "${key}" {\n type = map(string)\n sensitive = true\n}` : `variable "${key}" { type = any }`).join('\n'),
        'outputs.tf': 'output "public_entry" { value = module.range.public_entry }\noutput "resource_summary" { value = module.range.resource_summary }\n',
        'versions.tf': 'terraform {\n required_providers {\n  tencentcloud = { source = "tencentcloudstack/tencentcloud", version = "= 1.83.34-range.1" }\n }\n}\n',
        'tencent-range-identity.json': JSON.stringify(this.tencentWorkspaceIdentity(input)),
      };
      await Promise.all(Object.entries(files).map(([name,contents]) => fs.writeFile(path.join(workspaceDir,name),contents,{ mode: 0o600 })));
    }
    const runnerEnv = await this.buildRunnerEnv(input.runtimeConfig);

    return {
      workspaceDir,
      planFilePath,
      outputsFilePath,
      varsFilePath,
      runnerEnv,
      ...(priorState && priorVariables ? { priorState, priorVariables, renderedVariables: variables } : {}),
    };
  }

  private async prepareSingleInstanceWorkspace(
    input: RangeProvisionCreateInput | RangeProvisionDestroyInput,
    options: {
      preserveWorkspaceState: boolean;
      requireRuntimePasswords: boolean;
    },
  ): Promise<PreparedWorkspace> {
    const singleInstanceConfig = input.singleInstanceConfig;
    const singleNetworkProfile = input.singleNetworkProfile;

    if (!singleInstanceConfig) {
      throw new Error('Single instance config missing');
    }

    if (!singleNetworkProfile) {
      throw new Error('Single instance network profile missing');
    }

    const moduleDir = path.resolve(this.projectRootDir, input.templateModulePath);
    const workspaceDir = path.join(this.workspacesRootDir, input.rangeInstanceId);
    const planFilePath = path.join(workspaceDir, 'single-instance.tfplan');
    const outputsFilePath = path.join(workspaceDir, 'outputs.json');
    const varsFilePath = path.join(workspaceDir, 'terraform.tfvars.json');

    await assertDirectoryExists(moduleDir, 'OpenTofu module path does not exist');
    if (options.preserveWorkspaceState) {
      await assertWorkspaceCanApply(workspaceDir, input.requirePersistedState === true);
    } else {
      if (input.requirePersistedState) throw new Error('OpenTofu state recovery is required before proceeding; persisted workspace was preserved');
      await assertUnusedWorkspace(workspaceDir);
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
    await fs.mkdir(workspaceDir, { recursive: true });

    const files = await this.buildSingleInstanceWorkspaceFiles({
      moduleSource: moduleDir,
      rangeInstanceId: input.rangeInstanceId,
      runtimeConfig: input.runtimeConfig,
      runtimeCredentials: input.runtimeCredentials,
      requireRuntimePasswords: options.requireRuntimePasswords,
      singleInstanceConfig,
      singleNetworkProfile,
    });

    await Promise.all(
      Object.entries(files).map(async ([fileName, contents]) => {
        await fs.writeFile(path.join(workspaceDir, fileName), contents, 'utf8');
      }),
    );

    return {
      workspaceDir,
      planFilePath,
      outputsFilePath,
      varsFilePath,
      runnerEnv: await this.buildRunnerEnv(input.runtimeConfig),
    };
  }

  private async buildVariables(
    input: RangeProvisionCreateInput | RangeProvisionDestroyInput,
    options: { requireRuntimePasswords: boolean; priorState?: WorkspaceState; priorVariables?: Record<string, any> },
  ) {
    const plan = buildEnterpriseProvisionPlan({
      rangeInstanceId: input.rangeInstanceId,
      templateModulePath: input.templateModulePath,
      topologySpec: input.topologySpec,
      compiledProvisionSpec: input.compiledProvisionSpec,
      compiledSpec: input.compiledSpec,
      allocatedCidr: input.allocatedCidr,
    });
    const runtimeConfig = this.resolveRuntimeConfig(input.runtimeConfig);
    if (runtimeConfig.provider === 'tencent_cloud') return this.buildTencentVariables(input, plan, runtimeConfig, options);
    const hostProvisioningHints = buildHostInstanceResolutionHints(
      input.compiledProvisionSpec,
      input.compiledSpec,
      input.topologyGraph,
    );
    let zoneId = options.priorVariables?.zone_id ?? runtimeConfig.defaultZoneId;
    let attemptedZones: ProvisioningAttemptedZoneSummary[] = [];
    let hostInstanceTypes: Record<string, string>;
    const requestedInstanceType = normalizeOptionalEnvValue(
      this.env.OPENTOFU_INSTANCE_TYPE ?? this.env.ALICLOUD_INSTANCE_TYPE,
    );
    const systemDiskCategory = this.readSystemDiskCategory();
    const deployedKeys = new Set(options.priorState?.instances.filter(resource => resource.type === 'alicloud_instance').map(resource => resourceInstanceKey(resource.address)) ?? []);
    const newPlan = { ...plan, hostDefinitions: plan.hostDefinitions.filter(host => !deployedKeys.has(host.key)) };
    const hostInstanceTypeRequests = this.buildHostInstanceTypeRequests({
      plan: newPlan,
      hostProvisioningHints,
    });
    const requiresMultiNicCapacityScheduling = hostInstanceTypeRequests.some(
      (host) => (host.networkInterfaceCount ?? 1) > 2,
    );

    if (
      hostInstanceTypeRequests.length > 0 && (requiresMultiNicCapacityScheduling ||
      (this.enableZoneScheduling &&
        (!requestedInstanceType || requestedInstanceType.toLowerCase() === 'auto')))
    ) {
      const zoneSelection = await selectZoneAndHostInstanceTypes({
        regionId: runtimeConfig.defaultRegion,
        defaultZoneId: zoneId,
        ...(systemDiskCategory ? { systemDiskCategory } : {}),
        hostRequests: hostInstanceTypeRequests,
        account: {
          accessKeyId: runtimeConfig.accessKeyId,
          accessKeySecret: runtimeConfig.accessKeySecret,
        },
      });
      if (options.priorState && zoneSelection.selectedZoneId !== zoneId) throw new Error('No compatible new-host instance type is available in the original deployed zone; existing hosts were preserved');
      zoneId = zoneSelection.selectedZoneId;
      attemptedZones = zoneSelection.attemptedZones;
      hostInstanceTypes = zoneSelection.hostInstanceTypes;
    } else {
      hostInstanceTypes = await this.resolveHostInstanceTypes({
        plan: newPlan,
        hostProvisioningHints,
        runtimeConfig: { ...runtimeConfig, defaultZoneId: zoneId },
      });
    }
    for (const host of options.priorVariables?.hosts ?? []) if (deployedKeys.has(host.key)) hostInstanceTypes[host.key] = host.instance_type ?? options.priorVariables!.instance_type;

    const preferredHostInstanceType =
      hostInstanceTypes[plan.entryHostKey] ?? hostInstanceTypes[plan.hostDefinitions[0]?.key ?? ''];
    const instanceType = preferredHostInstanceType
      ? preferredHostInstanceType
      : options.priorVariables?.instance_type ?? await this.resolveInstanceType({ ...runtimeConfig, defaultZoneId: zoneId });
    const hostImageIds = resolveFinalHostImageIds({
      hostProvisioningHints,
      hostKeys: plan.hostDefinitions.map((host) => host.key),
      preferredHostKey: plan.entryHostKey,
    });
    for (const host of options.priorVariables?.hosts ?? []) if (deployedKeys.has(host.key) && hostImageIds) hostImageIds[host.key] = host.image_id ?? options.priorVariables!.image_id;
    const imageId =
      hostImageIds?.[plan.entryHostKey] ??
      Object.values(hostImageIds ?? {})[0] ??
      options.priorVariables?.image_id ?? (await this.resolveImageId(runtimeConfig));
    const hostWindows = options.requireRuntimePasswords
      ? { ...Object.fromEntries(plan.hostDefinitions.filter(host => deployedKeys.has(host.key) && host.dns).map(host => [host.key, true])), ...await resolveAliyunWindowsDnsHostImages({ hosts: newPlan.hostDefinitions, hostImageIds: hostImageIds ?? {}, fallbackImageId: imageId, runtimeConfig }) }
      : undefined;
    const hostPasswords = Object.fromEntries(
      plan.hostDefinitions.map((host) => [
        host.key,
        options.requireRuntimePasswords
          ? requireRuntimePassword(input.runtimeCredentials, host.key)
          : DESTROY_PLACEHOLDER_PASSWORD,
      ]),
    );
    const instancePassword = options.requireRuntimePasswords
      ? requireRuntimePassword(input.runtimeCredentials, plan.entryHostKey)
      : DESTROY_PLACEHOLDER_PASSWORD;
    return this.renderer.render({
      plan,
      rangeInstanceId: input.rangeInstanceId,
      zoneId,
      attemptedZones,
      instanceType,
      hostInstanceTypes,
      imageId,
      hostImageIds,
      ...(hostWindows ? { hostWindows } : {}),
      hostPasswords,
      instancePassword,
      tags: {
        range_instance_id: input.rangeInstanceId,
        ...(input.billingTags ?? {}),
      },
      allowedIngressCidr: this.env.OPENTOFU_ALLOWED_INGRESS_CIDR ?? '0.0.0.0/0',
      ...(this.env.OPENTOFU_INTERNET_MAX_BANDWIDTH_OUT
        ? {
            internetMaxBandwidthOut: Number(this.env.OPENTOFU_INTERNET_MAX_BANDWIDTH_OUT),
          }
        : {}),
      ...(systemDiskCategory
        ? {
            systemDiskCategory,
          }
        : {}),
      ...(this.env.OPENTOFU_SYSTEM_DISK_SIZE
        ? {
            systemDiskSize: Number(this.env.OPENTOFU_SYSTEM_DISK_SIZE),
          }
        : {}),
    });
  }

  private async buildSingleInstanceWorkspaceFiles(input: {
    moduleSource: string;
    rangeInstanceId: string;
    runtimeConfig?: ResolvedProvisioningRuntimeConfig;
    runtimeCredentials?: RangeRuntimeCredentials;
    requireRuntimePasswords?: boolean;
    singleInstanceConfig: SingleInstanceConfig;
    singleNetworkProfile: SingleInstanceNetworkProfileRecord;
    billingTags?: Record<string, string>;
  }) {
    const assignedVswitchId =
      input.singleInstanceConfig.assignedVswitchId?.trim() || input.singleNetworkProfile.vswitchIds[0];
    const assignedVswitchIndex = input.singleNetworkProfile.vswitchIds.indexOf(assignedVswitchId);

    if (assignedVswitchIndex < 0) {
      throw new Error(`Assigned single-instance vSwitch not found in persisted profile: ${assignedVswitchId}`);
    }

    const instancePassword = input.requireRuntimePasswords === false
      ? DESTROY_PLACEHOLDER_PASSWORD
      : requireRuntimePassword(input.runtimeCredentials, input.singleInstanceConfig.hostKey);
    const requestedInstanceType = normalizeOptionalEnvValue(
      this.env.OPENTOFU_INSTANCE_TYPE ?? this.env.ALICLOUD_INSTANCE_TYPE,
    );
    const preferredInstanceTypes = resolvePreferredInstanceTypes(
      input.singleInstanceConfig.cpu,
      input.singleInstanceConfig.memory,
    );
    const singleRuntimeConfig = input.runtimeConfig
      ? this.resolveRuntimeConfig(input.runtimeConfig)
      : this.resolveRuntimeConfig({
          accessKeyId: this.env.ALICLOUD_ACCESS_KEY ?? '',
          accessKeySecret: this.env.ALICLOUD_SECRET_KEY ?? '',
          defaultRegion: input.singleNetworkProfile.regionId,
          defaultZoneId: input.singleNetworkProfile.zoneId,
        });
    const instanceType =
      requestedInstanceType && requestedInstanceType.toLowerCase() !== 'auto'
        ? requestedInstanceType
        : await this.resolveInstanceType(singleRuntimeConfig, preferredInstanceTypes);
    const systemDiskCategory = this.readSystemDiskCategory();

    return {
      ...buildSingleInstanceRootWrapperFiles(input.moduleSource),
      'terraform.tfvars.json': JSON.stringify({
        resource_name_prefix: input.rangeInstanceId,
        instance_name: buildSingleInstanceName(input.singleInstanceConfig),
        host_name: input.singleInstanceConfig.hostName,
        host_key: input.singleInstanceConfig.hostKey,
        zone_id: input.singleNetworkProfile.zoneId,
        vpc_cidr: input.singleNetworkProfile.vpcCidr,
        vswitch_cidr: input.singleNetworkProfile.vswitchCidrs[assignedVswitchIndex],
        existing_vpc_id: input.singleNetworkProfile.vpcId,
        existing_vswitch_id: assignedVswitchId,
        existing_security_group_id: input.singleNetworkProfile.securityGroupId,
        image_id: input.singleInstanceConfig.imageId,
        instance_type: instanceType,
        instance_password: instancePassword,
        ...(this.env.OPENTOFU_ALLOWED_INGRESS_CIDR
          ? {
              allowed_ingress_cidr: this.env.OPENTOFU_ALLOWED_INGRESS_CIDR,
            }
          : {}),
        ...(this.env.OPENTOFU_INTERNET_MAX_BANDWIDTH_OUT
          ? {
              internet_max_bandwidth_out: Number(this.env.OPENTOFU_INTERNET_MAX_BANDWIDTH_OUT),
            }
          : {}),
        ...(systemDiskCategory
          ? {
              system_disk_category: systemDiskCategory,
            }
          : {}),
        system_disk_size: input.singleInstanceConfig.systemDiskSize,
        tags: {
          instance_mode: 'single',
          host_key: input.singleInstanceConfig.hostKey,
          base_name: input.singleInstanceConfig.baseName,
          ...(input.billingTags ?? {}),
        },
      }),
    };
  }

  private async resolveInstanceType(
    runtimeConfig: ResolvedProvisioningRuntimeConfig,
    preferredInstanceTypes?: readonly string[],
  ) {
    const requestedInstanceType = normalizeOptionalEnvValue(
      this.env.OPENTOFU_INSTANCE_TYPE ?? this.env.ALICLOUD_INSTANCE_TYPE,
    );

    if (requestedInstanceType && requestedInstanceType.toLowerCase() !== 'auto') {
      return requestedInstanceType;
    }
    const systemDiskCategory = this.readSystemDiskCategory();

    return this.availableInstanceTypeResolver({
      accessKey: runtimeConfig.accessKeyId,
      secretKey: runtimeConfig.accessKeySecret,
      regionId: runtimeConfig.defaultRegion,
      zoneId: runtimeConfig.defaultZoneId,
      ...(systemDiskCategory ? { systemDiskCategory } : {}),
      preferredInstanceTypes:
        preferredInstanceTypes && preferredInstanceTypes.length > 0
          ? [...preferredInstanceTypes]
          : readInstanceTypePreferences(this.env),
    });
  }

  private async resolveHostInstanceTypes(input: {
    plan: ReturnType<typeof buildEnterpriseProvisionPlan>;
    hostProvisioningHints: Map<string, HostInstanceResolutionHint>;
    runtimeConfig: ResolvedProvisioningRuntimeConfig;
  }) {
    const requestedInstanceType = normalizeOptionalEnvValue(
      this.env.OPENTOFU_INSTANCE_TYPE ?? this.env.ALICLOUD_INSTANCE_TYPE,
    );

    if (requestedInstanceType && requestedInstanceType.toLowerCase() !== 'auto') {
      return Object.fromEntries(
        input.plan.hostDefinitions.map((host) => [host.key, requestedInstanceType]),
      );
    }

    const systemDiskCategory = this.readSystemDiskCategory();
    const defaultPreferences = readInstanceTypePreferences(this.env);
    const resolutionCache = new Map<string, Promise<string>>();
    const resolvedHostInstanceTypes: Record<string, string> = {};

    for (const host of input.plan.hostDefinitions) {
      const resolutionPolicy = resolveHostInstanceTypePolicy({
        runtimeSelections: input.plan.runtimeSelections.instanceTypePolicies,
        runtimeHint: input.hostProvisioningHints.get(host.key),
      });
      if (resolutionPolicy.fixedInstanceType) {
        resolvedHostInstanceTypes[host.key] = resolutionPolicy.fixedInstanceType;
        continue;
      }

      const preferredInstanceTypes =
        resolutionPolicy.preferredInstanceTypes.length > 0
          ? resolutionPolicy.preferredInstanceTypes
          : defaultPreferences;
      const cacheKey = `${resolutionPolicy.strictPreferredInstanceTypes ? 'strict' : 'loose'}:${preferredInstanceTypes.join(',')}`;

      let resolutionPromise = resolutionCache.get(cacheKey);
      if (!resolutionPromise) {
        resolutionPromise = this.availableInstanceTypeResolver({
          accessKey: input.runtimeConfig.accessKeyId,
          secretKey: input.runtimeConfig.accessKeySecret,
          regionId: input.runtimeConfig.defaultRegion,
          zoneId: input.runtimeConfig.defaultZoneId,
          ...(systemDiskCategory ? { systemDiskCategory } : {}),
          preferredInstanceTypes,
          ...(resolutionPolicy.strictPreferredInstanceTypes
            ? { strictPreferredInstanceTypes: true }
            : {}),
        });
        resolutionCache.set(cacheKey, resolutionPromise);
      }

      resolvedHostInstanceTypes[host.key] = await resolutionPromise;
    }

    return resolvedHostInstanceTypes;
  }

  private buildHostInstanceTypeRequests(input: {
    plan: ReturnType<typeof buildEnterpriseProvisionPlan>;
    hostProvisioningHints: Map<string, HostInstanceResolutionHint>;
  }) {
    const requestedInstanceType = normalizeOptionalEnvValue(
      this.env.OPENTOFU_INSTANCE_TYPE ?? this.env.ALICLOUD_INSTANCE_TYPE,
    );
    const defaultPreferences = readInstanceTypePreferences(this.env);
    const networkInterfaceCountByHost = new Map(
      input.plan.hostNetworkInterfaces.map((hostNetworkInterfaces) => [
        hostNetworkInterfaces.hostKey,
        Math.max(1, hostNetworkInterfaces.interfaces.length),
      ]),
    );

    return input.plan.hostDefinitions.map((host) => {
      const runtimeHint = input.hostProvisioningHints.get(host.key);
      const networkInterfaceCount = networkInterfaceCountByHost.get(host.key) ?? 1;

      if (requestedInstanceType && requestedInstanceType.toLowerCase() !== 'auto') {
        return {
          hostKey: host.key,
          ...(typeof runtimeHint?.requestedCpu === 'number' ? { cpu: runtimeHint.requestedCpu } : {}),
          ...(typeof runtimeHint?.requestedMemoryGiB === 'number'
            ? { memoryGiB: runtimeHint.requestedMemoryGiB }
            : {}),
          networkInterfaceCount,
          preferredInstanceTypes: [requestedInstanceType],
          strictPreferredInstanceTypes: true,
        };
      }

      const resolutionPolicy = resolveHostInstanceTypePolicy({
        runtimeSelections: input.plan.runtimeSelections.instanceTypePolicies,
        runtimeHint,
      });

      return {
        hostKey: host.key,
        ...(typeof runtimeHint?.requestedCpu === 'number' ? { cpu: runtimeHint.requestedCpu } : {}),
        ...(typeof runtimeHint?.requestedMemoryGiB === 'number'
          ? { memoryGiB: runtimeHint.requestedMemoryGiB }
          : {}),
        networkInterfaceCount,
        ...(resolutionPolicy.strictPreferredInstanceTypes
          ? { strictPreferredInstanceTypes: true }
          : {}),
        preferredInstanceTypes: resolutionPolicy.fixedInstanceType
          ? [resolutionPolicy.fixedInstanceType]
          : resolutionPolicy.preferredInstanceTypes.length > 0
            ? resolutionPolicy.preferredInstanceTypes
            : [...defaultPreferences],
      };
    });
  }

  private async resolveImageId(runtimeConfig: ResolvedProvisioningRuntimeConfig) {
    const requestedImageId = normalizeOptionalEnvValue(
      this.env.OPENTOFU_IMAGE_ID ?? this.env.ALICLOUD_IMAGE_ID,
    );

    if (requestedImageId && requestedImageId.toLowerCase() !== 'auto') {
      return requestedImageId;
    }

    return this.availableImageIdResolver({
      accessKey: runtimeConfig.accessKeyId,
      secretKey: runtimeConfig.accessKeySecret,
      regionId: runtimeConfig.defaultRegion,
      ...(requestedImageId && requestedImageId.toLowerCase() !== 'auto'
        ? { requestedImageId }
        : {}),
      preferredImageIds: readImageIdPreferences(this.env),
    });
  }

  private async buildRunnerEnv(
    runtimeConfig: ResolvedProvisioningRuntimeConfig = this.resolveRuntimeConfig(),
  ): Promise<NodeJS.ProcessEnv> {
    const tencent = runtimeConfig.provider === 'tencent_cloud';
    const providerZipPath = (tencent ? this.env.TENCENTCLOUD_PROVIDER_ZIP_PATH : this.env.ALICLOUD_PROVIDER_ZIP_PATH)?.trim();

    const runnerEnv: NodeJS.ProcessEnv = {
      // ponytail: keep the runner env tiny; add keys here only for a concrete child-process need.
      ...pickEnv(process.env, RUNNER_ENV_KEYS),
      ...pickEnv(this.env, RUNNER_ENV_KEYS),
      ...(tencent ? { TENCENTCLOUD_SECRET_ID: runtimeConfig.accessKeyId, TENCENTCLOUD_SECRET_KEY: runtimeConfig.accessKeySecret, TENCENTCLOUD_REGION: runtimeConfig.defaultRegion } : { ALICLOUD_ACCESS_KEY: runtimeConfig.accessKeyId, ALICLOUD_SECRET_KEY: runtimeConfig.accessKeySecret, ALICLOUD_REGION: runtimeConfig.defaultRegion }),
    };

    if (normalizeOptionalEnvValue(this.env.OPENTOFU_PASSTHROUGH_PROXY) === '1') {
      Object.assign(runnerEnv, pickEnv(process.env, PROXY_ENV_KEYS), pickEnv(this.env, PROXY_ENV_KEYS));
    }

    return {
      ...runnerEnv,
      ...await prepareOpenTofuProviderEnv({
        provider: runtimeConfig.provider, providerZipPath,
        workspacesRootDir: this.workspacesRootDir,
        unpackedMirrorRootDir: (tencent ? this.env.TENCENTCLOUD_PROVIDER_UNPACKED_MIRROR_ROOT : this.env.OPENTOFU_PROVIDER_UNPACKED_MIRROR_ROOT)?.trim(),
      }),
    };
  }

  private resolveRuntimeConfig(
    runtimeConfig?: ResolvedProvisioningRuntimeConfig,
  ): ResolvedProvisioningRuntimeConfig {
    if (runtimeConfig?.provider === 'tencent_cloud' && (!runtimeConfig.accessKeyId || !runtimeConfig.accessKeySecret || !runtimeConfig.defaultRegion || !runtimeConfig.defaultZoneId || !runtimeConfig.cloudAccountContextId || !runtimeConfig.accountUid)) throw new Error('Tencent runtime requires a complete frozen account; environment fallback is forbidden');
    return {
      ...runtimeConfig,
      accessKeyId:
        normalizeOptionalEnvValue(runtimeConfig?.accessKeyId) ??
        requireEnvValue(this.env.ALICLOUD_ACCESS_KEY, 'ALICLOUD_ACCESS_KEY'),
      accessKeySecret:
        normalizeOptionalEnvValue(runtimeConfig?.accessKeySecret) ??
        requireEnvValue(this.env.ALICLOUD_SECRET_KEY, 'ALICLOUD_SECRET_KEY'),
      defaultRegion:
        normalizeOptionalEnvValue(runtimeConfig?.defaultRegion) ??
        requireEnvValue(this.env.ALICLOUD_REGION, 'ALICLOUD_REGION'),
      defaultZoneId:
        normalizeOptionalEnvValue(runtimeConfig?.defaultZoneId) ??
        requireEnvValue(this.env.ALICLOUD_ZONE_ID, 'ALICLOUD_ZONE_ID'),
    };
  }

  private tencentWorkspaceIdentity(input: RangeProvisionCreateInput | RangeProvisionDestroyInput) {
    const account = input.runtimeConfig;
    if (account?.provider !== 'tencent_cloud' || !account.cloudAccountContextId || !account.accountUid) throw new Error('Tencent workspace requires a verified frozen account');
    return { provider: account.provider, cloudAccountContextId: account.cloudAccountContextId, cloudAccountUid: account.accountUid, regionId: account.defaultRegion, zoneId: account.defaultZoneId, rangeInstanceId: input.rangeInstanceId };
  }

  private async assertTencentWorkspaceIdentity(dir: string, input: RangeProvisionCreateInput | RangeProvisionDestroyInput) {
    const actual = JSON.parse(await fs.readFile(path.join(dir,'tencent-range-identity.json'),'utf8'));
    if (JSON.stringify(actual) !== JSON.stringify(this.tencentWorkspaceIdentity(input))) throw new Error('Tencent workspace differs from frozen provider/account/region/zone identity');
  }

  private async buildTencentVariables(input: RangeProvisionCreateInput | RangeProvisionDestroyInput, plan: ReturnType<typeof buildEnterpriseProvisionPlan>, account: ResolvedProvisioningRuntimeConfig, options: { requireRuntimePasswords: boolean; priorState?: WorkspaceState; priorVariables?: Record<string, any> }) {
    if (plan.natGateways.length && this.env.TENCENTCLOUD_RANGE_NAT_EXECUTION_ENABLED !== '1') throw new Error('Tencent NAT execution is disabled until controlled recovery validation is complete');
    const hints = buildHostInstanceResolutionHints(input.compiledProvisionSpec,input.compiledSpec,input.topologyGraph);
    const deployedKeys = new Set(options.priorState?.instances.filter(resource => resource.type === 'tencentcloud_instance').map(resource => resourceInstanceKey(resource.address)) ?? []);
    const addedHosts = plan.hostDefinitions.filter(host => !deployedKeys.has(host.key));
    const types = addedHosts.length ? await selectTencentHostInstanceTypes(account,addedHosts.map(host => {
      const hint = hints.get(host.key);
      const policy = resolveHostInstanceTypePolicy({ runtimeHint: hint, runtimeSelections: plan.runtimeSelections.instanceTypePolicies });
      return { key: host.key, cpu: hint?.requestedCpu, memory: hint?.requestedMemoryGiB, instanceType: policy.fixedInstanceType, preferredInstanceTypes: policy.preferredInstanceTypes, strictPreferredInstanceTypes: policy.strictPreferredInstanceTypes };
    })) : {};
    const images = Object.fromEntries(plan.hostDefinitions.map(host => [host.key,hints.get(host.key)?.finalImageId ?? '']));
    const imageMetadata = addedHosts.length ? await assertTencentImagesAvailable(account,addedHosts.map(host => images[host.key])) : {};
    for (const old of options.priorVariables?.hosts ?? []) if (deployedKeys.has(old.key) && plan.hostDefinitions.some(host => host.key === old.key)) {
      images[old.key] = old.image_id;
      const cpu = hints.get(old.key)?.requestedCpu;
      if (typeof cpu !== 'number' || !Number.isSafeInteger(cpu) || cpu < 1) throw new Error('Original Tencent host CPU capacity cannot be verified');
      types[old.key] = { instanceType: old.instance_type, cpu };
    }
    for (const host of addedHosts) {
      if (host.dns && options.requireRuntimePasswords && (imageMetadata[images[host.key]]?.isWindows !== true || imageMetadata[images[host.key]]?.windowsUserDataSupported !== true)) throw new Error('Tencent host DNS requires an officially identified Windows Server 2012 R2 or newer image');
    }
    const rendered = renderTencentRangeVariables({ plan, rangeInstanceId: input.rangeInstanceId, account, hostInstanceTypes: types, hostImageIds: images,
      hostPasswords: Object.fromEntries(plan.hostDefinitions.map(host => [host.key,options.requireRuntimePasswords ? requireRuntimePassword(input.runtimeCredentials,host.key) : DESTROY_PLACEHOLDER_PASSWORD])),
      // Preserve the existing non-DNS login validation when legacy image metadata omits its OS.
      hostWindows: Object.fromEntries(plan.hostDefinitions.map(host => [host.key,deployedKeys.has(host.key) ? Boolean(host.dns || input.runtimeCredentials?.[host.key]?.username === 'Administrator') : imageMetadata[images[host.key]]?.isWindows ?? (!host.dns && input.runtimeCredentials?.[host.key]?.username === 'Administrator')])),
      expiresAt: input.expiresAt ?? '', tags: input.billingTags ?? {}, systemDiskType: this.env.TENCENTCLOUD_SYSTEM_DISK_TYPE,
      systemDiskSize: 50,
      hostSystemDiskSizes: Object.fromEntries(plan.hostDefinitions.map(host => [host.key, deployedKeys.has(host.key) ? options.priorVariables!.hosts.find((old: any) => old.key === host.key)?.system_disk_size : Math.max(50, imageMetadata[images[host.key]]?.minimumSystemDiskSize ?? 50)])) });
    const oldState = options.priorState ?? await readWorkspaceState(path.join(this.workspacesRootDir,input.rangeInstanceId));
    for (const entry of [...rendered.eips,...rendered.nat_gateways]) {
      const isEip = 'nat_key' in entry;
      const kind = isEip ? 'tencentcloud_eip' : 'tencentcloud_nat_gateway';
      const prior = oldState?.instances.find(resource => resource.type === kind && resourceInstanceKey(resource.address) === entry.key);
      if (!prior) continue;
      const original = options.priorVariables?.[isEip ? 'eips' : 'nat_gateways']?.filter((value: any) => value.key === entry.key);
      const priorIntent = original?.[0]?.creation_intent_id;
      const recordedId = input.knownResourceSummary?.[isEip ? 'eipAllocationIds' : 'natGatewayIds']?.[entry.key];
      if (original?.length !== 1 || typeof priorIntent !== 'string' || !/^[a-f0-9]{32}$/.test(priorIntent)
        || prior.module !== 'module.range' || prior.address !== `module.range.${kind}.${isEip ? 'range' : 'shared'}[${JSON.stringify(entry.key)}]`
        || prior.attributes.id !== recordedId || (prior.attributes.tags as Record<string,string> | undefined)?.CreationIntentId !== priorIntent
        || isEip && prior.attributes.client_token !== priorIntent
        || prior.attributes.name !== `${options.priorVariables!.resource_name_prefix}-${priorIntent.slice(0,16)}`)
        throw new Error('Existing Tencent NAT or EIP creation intent conflicts with frozen variables, state or platform inventory; cloud changes were not submitted');
      entry.creation_intent_id = priorIntent;
    }
    return rendered;

  }

  private readSystemDiskCategory() {
    return normalizeOptionalEnvValue(this.env.OPENTOFU_SYSTEM_DISK_CATEGORY);
  }
}

// Provider user-data changes can replace a live VM even when only our script generator changed.
export function preserveDeployedRangeUserData<T extends Record<string, any>>(
  input: RangeProvisionCreateInput | RangeProvisionDestroyInput,
  state: WorkspaceState,
  priorVariables: unknown,
  nextVariables: T,
) {
  const fail = (): never => { throw new Error('Existing host startup data or frozen ownership cannot be verified; persisted variables were preserved'); };
  const next = nextVariables as Record<string, any>;
  const account = input.runtimeConfig;
  const prior = readObjectRecord(priorVariables);
  const provider = account?.provider;
  const type = provider === 'tencent_cloud' ? 'tencentcloud_instance' : 'alicloud_instance';
  const resources = state.instances.filter(resource => ['alicloud_instance', 'tencentcloud_instance'].includes(resource.type));
  if (!resources.length) return nextVariables;
  if (!account?.accountUid || !account.cloudAccountContextId || !['alibaba_cloud', 'tencent_cloud'].includes(provider ?? '') || !prior || !Array.isArray(prior.hosts) || !Array.isArray(next.hosts)) fail();
  const owns = (tags: any) => tags && tags.CloudProvider === provider && tags.CloudAccountUid === account!.accountUid && tags.CloudAccountContextId === account!.cloudAccountContextId && (tags.RangeInstanceId === input.rangeInstanceId || tags.range_instance_id === input.rangeInstanceId) && ['RangeInstanceId', 'range_instance_id'].every(key => tags[key] === undefined || tags[key] === input.rangeInstanceId) && tags.CreatedBy === 'cyber-range-platform' && ['PlatformScope', 'PlatformUserId'].every(key => input.billingTags?.[key] === undefined || tags[key] === input.billingTags[key]);
  if (!owns(prior!.tags) || provider === 'tencent_cloud' && prior!.region !== account!.defaultRegion) fail();
  const deployed = new Set<string>();
  for (const resource of resources) {
    const key = resourceInstanceKey(resource.address);
    if (resource.type !== type || resource.module !== 'module.range' || resource.tainted || !resource.address.startsWith(`module.range.${type}.hosts[`) || deployed.has(key) || !owns(resource.attributes.tags)
      || typeof resource.attributes.availability_zone !== 'string' || !resource.attributes.availability_zone.startsWith(`${account!.defaultRegion}-`) || resource.attributes.availability_zone !== prior!.zone_id
      || typeof resource.attributes.id !== 'string' || !(provider === 'tencent_cloud' ? /^ins-[a-z0-9]+$/ : /^i-[a-z0-9]+$/).test(resource.attributes.id)) fail();
    const oldHosts = (prior!.hosts as any[]).filter(host => host?.key === key);
    if (oldHosts.length !== 1) fail();
    deployed.add(key);
  }
  if (provider === 'tencent_cloud') {
    next.hosts = next.hosts.map((host: any) => {
      if (!deployed.has(host.key)) return host;
      const old = (prior!.hosts as any[]).find(value => value.key === host.key);
      if (typeof old.user_data !== 'string') fail();
      return { ...host, user_data: old.user_data };
    });
  } else {
    const scripts = prior!.bootstrap_scripts as any[];
    if (!Array.isArray(scripts) || !Array.isArray(next.bootstrap_scripts) || scripts.some(script => !script || typeof script.key !== 'string' || typeof script.name !== 'string' || !['shell', 'powershell', 'cloud-init'].includes(script.type) || typeof script.content !== 'string' || !Array.isArray(script.target_host_keys) || script.target_host_keys.some((key: unknown) => typeof key !== 'string') || new Set(script.target_host_keys).size !== script.target_host_keys.length)) fail();
    const remaining = new Set(next.hosts.map((host: any) => host.key));
    next.bootstrap_scripts = [
      ...next.bootstrap_scripts.flatMap((script: any) => { const keys = script.target_host_keys.filter((key: string) => !deployed.has(key)); return keys.length ? [{ ...script, target_host_keys: keys }] : []; }),
      ...scripts.flatMap(script => { const keys = script.target_host_keys.filter((key: string) => deployed.has(key) && remaining.has(key)); return keys.length ? [{ ...script, target_host_keys: keys }] : []; }),
    ];
  }
  return nextVariables;
}

export async function resolveAliyunWindowsDnsHostImages(input: {
  hosts: Array<{ key: string; dns?: unknown }>;
  hostImageIds: Record<string, string>;
  fallbackImageId: string;
  runtimeConfig: ResolvedProvisioningRuntimeConfig;
}): Promise<Record<string, boolean> | undefined> {
  const hosts = input.hosts.filter(host => host.dns);
  if (!hosts.length) return undefined;
  const windowsByImage = new Map<string, boolean>();
  const result: Record<string, boolean> = {};
  for (const host of hosts) {
    const imageId = input.hostImageIds[host.key] ?? input.fallbackImageId;
    if (!windowsByImage.has(imageId)) {
      const payload = await performAliyunRpcRequest({ accessKeyId: input.runtimeConfig.accessKeyId, accessKeySecret: input.runtimeConfig.accessKeySecret, regionId: input.runtimeConfig.defaultRegion, action: 'DescribeImages', parameters: { ImageId: imageId, PageSize: '100', PageNumber: '1' } }) as { TotalCount?: unknown; Images?: { Image?: Array<{ ImageId?: unknown; Status?: unknown; OSType?: unknown; Platform?: unknown }> } };
      const images = payload?.Images?.Image;
      if (payload?.TotalCount !== 1 || !Array.isArray(images) || images.length !== 1 || images[0]?.ImageId !== imageId || images[0]?.Status !== 'Available' || images[0]?.OSType !== 'windows' || (images[0].Platform !== undefined && (typeof images[0].Platform !== 'string' || !/^(?:Microsoft\s+)?Windows\b/i.test(images[0].Platform)))) throw new Error('Alibaba host DNS requires an available officially identified Windows image');
      windowsByImage.set(imageId, true);
    }
    result[host.key] = true;
  }
  return result;
}

async function assertDirectoryExists(targetPath: string, message: string) {
  const stat = await fs.stat(targetPath).catch(() => null);

  if (!stat?.isDirectory()) {
    throw new Error(`${message}: ${targetPath}`);
  }
}

async function assertFileExists(targetPath: string, message: string) {
  const stat = await fs.stat(targetPath).catch(() => null);

  if (!stat?.isFile()) {
    throw new Error(`${message}: ${targetPath}`);
  }
}

async function pathExists(targetPath: string) {
  try {
    await fs.stat(targetPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function assertUnusedWorkspace(workspaceDir: string) {
  for (const file of [...WORKSPACE_STATE_FILES, APPLY_STARTED_FILE, '.range-apply-complete.json']) {
    if (await pathExists(path.join(workspaceDir, file))) {
      throw new Error('Cannot replace an OpenTofu workspace with persisted state or an apply attempt');
    }
  }
}

function requireEnvValue(value: string | null | undefined, name: string): string {
  const trimmed = normalizeOptionalEnvValue(value);

  if (!trimmed) {
    throw new Error(`Missing required OpenTofu setting: ${name}`);
  }

  return trimmed;
}

function requireRuntimePassword(runtimeCredentials: RangeRuntimeCredentials | undefined, hostKey: string): string {
  const password = normalizeOptionalEnvValue(runtimeCredentials?.[hostKey]?.password);

  if (!password) {
    throw new Error(`Missing persisted runtime password for host: ${hostKey}`);
  }

  return password;
}

function normalizeOptionalEnvValue(value: string | null | undefined) {
  const trimmed = value?.trim();

  return trimmed ? trimmed : null;
}

function buildSingleInstanceName(config: SingleInstanceConfig) {
  return config.quantityIndex <= 1
    ? config.baseName
    : `${config.baseName}-${String(config.quantityIndex).padStart(2, '0')}`;
}

function readInstanceTypePreferences(env: OpenTofuProvisionerEnv) {
  const configuredPreferences = normalizeOptionalEnvValue(
    env.OPENTOFU_INSTANCE_TYPE_PREFERENCES ?? env.ALICLOUD_INSTANCE_TYPE_PREFERENCES,
  );

  if (!configuredPreferences) {
    return DEFAULT_AUTO_INSTANCE_TYPE_PREFERENCES;
  }

  const preferences = configuredPreferences
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  return preferences.length > 0 ? preferences : DEFAULT_AUTO_INSTANCE_TYPE_PREFERENCES;
}

function deriveInstanceTypePreferencesForResources(
  cpu: number | undefined,
  memoryGiB: number | undefined,
) {
  return resolvePreferredInstanceTypes(cpu, memoryGiB);
}

function buildHostInstanceResolutionHints(
  compiledProvisionSpec: Record<string, unknown> | null | undefined,
  compiledSpec: RangeTemplateCompiledSpec | null | undefined,
  topologyGraph: Record<string, unknown> | null | undefined,
) {
  const hints = new Map<string, HostInstanceResolutionHint>();

  const compiledProvisionHosts = Array.isArray(compiledProvisionSpec?.hosts) ? compiledProvisionSpec.hosts : [];
  for (const hostValue of compiledProvisionHosts) {
    const hostRecord = readObjectRecord(hostValue);
    if (!hostRecord || typeof hostRecord.key !== 'string') {
      continue;
    }

    const existing = hints.get(hostRecord.key) ?? {};
    const finalImageId = resolveFinalImageIdFromRecord(hostRecord);
    hints.set(hostRecord.key, {
      ...existing,
      ...(typeof hostRecord.instanceTypePolicyKey === 'string'
        ? { instanceTypePolicyKey: hostRecord.instanceTypePolicyKey }
        : {}),
      ...(typeof hostRecord.instanceType === 'string'
        ? { finalInstanceType: hostRecord.instanceType }
        : {}),
      ...(finalImageId ? { finalImageId } : {}),
    });
  }

  const compiledResources = compiledSpec?.resources ?? [];
  for (const resource of compiledResources) {
    if (resource.type !== 'host') {
      continue;
    }

    const instanceTypeStrategy = normalizeHostInstanceTypeStrategy(resource.config.instanceTypeStrategy);
    const existing = hints.get(resource.id) ?? {};
    const finalImageId = resolveFinalImageIdFromRecord(resource.config);
    hints.set(resource.id, {
      ...existing,
      ...(typeof resource.config.cpu === 'number' ? { requestedCpu: resource.config.cpu } : {}),
      ...(typeof resource.config.memory === 'number' ? { requestedMemoryGiB: resource.config.memory } : {}),
      ...(typeof resource.config.instanceType === 'string'
        ? { finalInstanceType: resource.config.instanceType }
        : {}),
      ...(finalImageId ? { finalImageId } : {}),
      ...(instanceTypeStrategy ? { instanceTypeStrategy } : {}),
    });
  }

  const topologyNodes = Array.isArray(topologyGraph?.nodes) ? topologyGraph.nodes : [];
  for (const nodeValue of topologyNodes) {
    const node = readObjectRecord(nodeValue);
    const nodeData = readObjectRecord(node?.data) ?? node;

    if (!node || !nodeData || node.kind !== 'ecs' || typeof node.id !== 'string') {
      continue;
    }

    const existing = hints.get(node.id) ?? {};
    const finalImageId = resolveFinalImageIdFromRecord(nodeData);
    hints.set(node.id, {
      ...existing,
      ...(finalImageId ? { finalImageId } : {}),
    });
  }

  return hints;
}

function normalizeHostInstanceTypeStrategy(value: unknown) {
  const record = readObjectRecord(value);
  if (!record) {
    return undefined;
  }

  const preferredInstanceTypes = readStringArrayValue(record.preferredInstanceTypes);

  return {
    ...(typeof record.mode === 'string' ? { mode: record.mode } : {}),
    ...(typeof record.instanceType === 'string' ? { instanceType: record.instanceType } : {}),
    preferredInstanceTypes,
  };
}

function normalizeHostImageStrategy(value: unknown) {
  const record = readObjectRecord(value);
  if (!record) {
    return undefined;
  }

  return {
    ...(typeof record.mode === 'string' ? { mode: record.mode } : {}),
    ...(typeof record.imageId === 'string' ? { imageId: record.imageId } : {}),
  };
}

function resolveFinalImageIdFromRecord(record: Record<string, unknown>) {
  const fixedImageId = normalizeExplicitFinalImageId(
    typeof record.imageId === 'string' ? record.imageId : undefined,
  );
  if (fixedImageId) {
    return fixedImageId;
  }

  const imageStrategy = normalizeHostImageStrategy(record.imageStrategy);
  if (imageStrategy?.mode === 'fixed' && imageStrategy.imageId) {
    return normalizeExplicitFinalImageId(imageStrategy.imageId);
  }

  return undefined;
}

function normalizeExplicitFinalImageId(value: string | null | undefined) {
  const normalizedValue = normalizeOptionalEnvValue(value);
  if (!normalizedValue) {
    return undefined;
  }

  if (/\.vhd$/i.test(normalizedValue)) {
    return normalizedValue;
  }

  if (/^(?:m|img)-[a-z0-9]+$/i.test(normalizedValue)) {
    return normalizedValue;
  }

  return undefined;
}

function resolveHostInstanceTypePolicy(input: {
  runtimeSelections: Record<string, unknown>;
  runtimeHint: HostInstanceResolutionHint | undefined;
}) {
  const runtimeSelectionRecord =
    input.runtimeHint?.instanceTypePolicyKey
      ? readObjectRecord(input.runtimeSelections[input.runtimeHint.instanceTypePolicyKey])
      : null;
  const strategy = input.runtimeHint?.instanceTypeStrategy;
  const mode =
    (typeof runtimeSelectionRecord?.mode === 'string' ? runtimeSelectionRecord.mode : undefined) ??
    strategy?.mode ??
    'auto';
  const explicitInstanceType = normalizeOptionalEnvValue(
    (typeof runtimeSelectionRecord?.instanceType === 'string' ? runtimeSelectionRecord.instanceType : undefined) ??
      strategy?.instanceType,
  );
  const preferredInstanceTypes = [
    ...readStringArrayValue(runtimeSelectionRecord?.preferredInstanceTypes),
    ...(strategy?.preferredInstanceTypes ?? []),
  ].filter((value, index, items) => items.indexOf(value) === index);

  if (mode === 'fixed' && explicitInstanceType) {
    return {
      fixedInstanceType: explicitInstanceType,
      preferredInstanceTypes: [] as string[],
      strictPreferredInstanceTypes: true,
    };
  }

  if (preferredInstanceTypes.length > 0) {
    return {
      preferredInstanceTypes,
      strictPreferredInstanceTypes: mode === 'fixed',
    };
  }

  if (input.runtimeHint?.finalInstanceType) {
    return {
      fixedInstanceType: input.runtimeHint.finalInstanceType,
      preferredInstanceTypes: [] as string[],
      strictPreferredInstanceTypes: true,
    };
  }

  const derivedPreferences = deriveInstanceTypePreferencesForResources(
    input.runtimeHint?.requestedCpu,
    input.runtimeHint?.requestedMemoryGiB,
  );

  if (derivedPreferences.length > 0) {
    return {
      preferredInstanceTypes: [...derivedPreferences],
      strictPreferredInstanceTypes: false,
    };
  }

  return {
    preferredInstanceTypes: [] as string[],
    strictPreferredInstanceTypes: false,
  };
}

function resolveFinalHostImageIds(input: {
  hostProvisioningHints: Map<string, HostInstanceResolutionHint>;
  hostKeys: string[];
  preferredHostKey: string;
}) {
  const resolvedHostImageIds: Record<string, string> = {};

  for (const hostKey of input.hostKeys) {
    const imageId = input.hostProvisioningHints.get(hostKey)?.finalImageId;
    if (imageId) {
      resolvedHostImageIds[hostKey] = imageId;
    }
  }

  if (Object.keys(resolvedHostImageIds).length === 0) {
    return undefined;
  }

  const preferredImageId = resolvedHostImageIds[input.preferredHostKey];
  if (!preferredImageId) {
    return resolvedHostImageIds;
  }

  return {
    [input.preferredHostKey]: preferredImageId,
    ...resolvedHostImageIds,
  };
}

function readImageIdPreferences(env: OpenTofuProvisionerEnv) {
  const configuredPreferences = normalizeOptionalEnvValue(
    env.OPENTOFU_IMAGE_ID_PREFERENCES ?? env.ALICLOUD_IMAGE_ID_PREFERENCES,
  );

  if (!configuredPreferences) {
    return DEFAULT_AUTO_IMAGE_ID_PREFERENCES;
  }

  const preferences = configuredPreferences
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  return preferences.length > 0 ? preferences : DEFAULT_AUTO_IMAGE_ID_PREFERENCES;
}

async function resolveAvailableAliyunInstanceType(
  input: AvailableInstanceTypeResolverInput,
): Promise<string> {
  const payload = await performAliyunRpcRequest({
    accessKeyId: input.accessKey,
    accessKeySecret: input.secretKey,
    regionId: input.regionId,
    action: 'DescribeAvailableResource',
    parameters: {
      ZoneId: input.zoneId,
      DestinationResource: 'InstanceType',
      ResourceType: 'instance',
      InstanceChargeType: 'PostPaid',
      IoOptimized: 'optimized',
      NetworkCategory: 'vpc',
      ...(input.systemDiskCategory ? { SystemDiskCategory: input.systemDiskCategory } : {}),
    },
  });
  const availableInstanceTypes = extractAvailableInstanceTypes(
    payload,
  );
  const selectedInstanceType =
    input.preferredInstanceTypes.find((candidate) =>
      availableInstanceTypes.includes(candidate),
    ) ?? availableInstanceTypes[0];

  if (!selectedInstanceType) {
    throw new Error(
      `No saleable ECS instance type found for zone ${input.zoneId} in region ${input.regionId}`,
    );
  }

  if (
    input.strictPreferredInstanceTypes &&
    input.preferredInstanceTypes.length > 0 &&
    !input.preferredInstanceTypes.includes(selectedInstanceType)
  ) {
    throw new Error(
      `No saleable ECS instance type matched requested preferences for zone ${input.zoneId} in region ${input.regionId}`,
    );
  }

  return selectedInstanceType;
}

async function resolveAvailableAliyunImageId(
  input: AvailableImageIdResolverInput,
): Promise<string> {
  const payload = await performAliyunRpcRequest({
    accessKeyId: input.accessKey,
    accessKeySecret: input.secretKey,
    regionId: input.regionId,
    action: 'DescribeImages',
    parameters: {
      ImageOwnerAlias: 'system',
      Status: 'Available',
      OSType: 'linux',
      Architecture: 'x86_64',
      PageSize: '100',
    },
  });
  const availableImageIds = extractAvailableImageIds(payload);

  if (input.requestedImageId) {
    if (!availableImageIds.includes(input.requestedImageId)) {
      throw new Error(
        `Configured image ID is not available in region ${input.regionId}: ${input.requestedImageId}`,
      );
    }

    return input.requestedImageId;
  }

  const selectedImageId =
    input.preferredImageIds.find((candidate) => availableImageIds.includes(candidate)) ??
    availableImageIds[0];

  if (!selectedImageId) {
    throw new Error(`No saleable ECS system image found in region ${input.regionId}`);
  }

  return selectedImageId;
}

async function performAliyunRpcRequest(input: {
  accessKeyId: string;
  accessKeySecret: string;
  regionId: string;
  action: string;
  parameters?: Record<string, string>;
}) {
  const endpoint = `https://ecs.${input.regionId}.aliyuncs.com/`;
  const query = signAliyunRpcQuery(
    {
      Action: input.action,
      AccessKeyId: input.accessKeyId,
      Format: ALICLOUD_RPC_FORMAT,
      RegionId: input.regionId,
      SignatureMethod: ALICLOUD_RPC_SIGNATURE_METHOD,
      SignatureNonce: randomUUID(),
      SignatureVersion: ALICLOUD_RPC_SIGNATURE_VERSION,
      Timestamp: formatAliyunTimestamp(new Date()),
      Version: ALICLOUD_RPC_API_VERSION,
      ...(input.parameters ?? {}),
    },
    input.accessKeySecret,
  );

  const response = await fetch(`${endpoint}?${query}`, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
    },
  });

  let payload: unknown = null;

  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const errorCode =
      payload && typeof payload === 'object' && 'Code' in payload && typeof (payload as { Code?: unknown }).Code === 'string'
        ? (payload as { Code: string }).Code
        : `HTTP_${response.status}`;
    const errorMessage =
      payload && typeof payload === 'object' && 'Message' in payload && typeof (payload as { Message?: unknown }).Message === 'string'
        ? (payload as { Message: string }).Message
        : `Aliyun RPC request failed with status ${response.status}`;

    throw new Error(`${input.action} failed: ${errorCode} - ${errorMessage}`);
  }

  return payload;
}

function signAliyunRpcQuery(parameters: Record<string, string>, accessKeySecret: string) {
  const canonicalizedQuery = Object.entries(parameters)
    .sort(([leftKey], [rightKey]) => compareAliyunRpcKeys(leftKey, rightKey))
    .map(([key, value]) => `${percentEncodeAliyunRpc(key)}=${percentEncodeAliyunRpc(value)}`)
    .join('&');
  const stringToSign = `GET&${percentEncodeAliyunRpc('/')}&${percentEncodeAliyunRpc(canonicalizedQuery)}`;
  const signature = createHmac('sha1', `${accessKeySecret}&`).update(stringToSign).digest('base64');

  return `${canonicalizedQuery}&Signature=${percentEncodeAliyunRpc(signature)}`;
}

function percentEncodeAliyunRpc(value: string) {
  return encodeURIComponent(value)
    .replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%7E/g, '~');
}

function compareAliyunRpcKeys(leftKey: string, rightKey: string) {
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function formatAliyunTimestamp(value: Date) {
  return value.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function extractAvailableInstanceTypes(payload: unknown) {
  const availableZones = normalizeAliyunRpcArray(
    (payload as {
      AvailableZones?: {
        AvailableZone?:
          | {
              AvailableResources?: {
                AvailableResource?:
                  | {
                      Type?: string;
                      SupportedResources?: {
                        SupportedResource?:
                          | {
                              Status?: string;
                              Value?: string;
                            }
                          | Array<{
                              Status?: string;
                              Value?: string;
                            }>;
                      };
                    }
                  | Array<{
                      Type?: string;
                      SupportedResources?: {
                        SupportedResource?:
                          | {
                              Status?: string;
                              Value?: string;
                            }
                          | Array<{
                              Status?: string;
                              Value?: string;
                            }>;
                      };
                    }>;
              };
            }
          | Array<{
              AvailableResources?: {
                AvailableResource?:
                  | {
                      Type?: string;
                      SupportedResources?: {
                        SupportedResource?:
                          | {
                              Status?: string;
                              Value?: string;
                            }
                          | Array<{
                              Status?: string;
                              Value?: string;
                            }>;
                      };
                    }
                  | Array<{
                      Type?: string;
                      SupportedResources?: {
                        SupportedResource?:
                          | {
                              Status?: string;
                              Value?: string;
                            }
                          | Array<{
                              Status?: string;
                              Value?: string;
                            }>;
                      };
                    }>;
              };
            }>;
      };
    })?.AvailableZones?.AvailableZone,
  );

  return [
    ...new Set(
      availableZones.flatMap((zone) =>
        normalizeAliyunRpcArray(zone.AvailableResources?.AvailableResource)
          .filter((resource) => resource.Type === 'InstanceType')
          .flatMap((resource) => normalizeAliyunRpcArray(resource.SupportedResources?.SupportedResource))
          .filter((resource) => resource.Status === 'Available' && typeof resource.Value === 'string')
          .map((resource) => resource.Value!.trim())
          .filter(Boolean),
      ),
    ),
  ];
}

function extractAvailableImageIds(payload: unknown) {
  const images = normalizeAliyunRpcArray(
    (payload as {
      Images?: {
        Image?:
          | {
              ImageId?: string;
              Status?: string;
            }
          | Array<{
              ImageId?: string;
              Status?: string;
            }>;
      };
    })?.Images?.Image,
  );

  return images
    .filter((image) => image.Status === 'Available' && typeof image.ImageId === 'string')
    .map((image) => image.ImageId!.trim())
    .filter(Boolean);
}

function normalizeAliyunRpcArray<T>(value: T | T[] | null | undefined) {
  if (!value) {
    return [] as T[];
  }

  return Array.isArray(value) ? value : [value];
}

function readObjectRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function readStringArrayValue(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}

function pickEnv<K extends keyof NodeJS.ProcessEnv>(
  env: Partial<Pick<NodeJS.ProcessEnv, K>>,
  keys: readonly K[],
): NodeJS.ProcessEnv {
  const picked: NodeJS.ProcessEnv = {};

  for (const key of keys) {
    const value = env[key];

    if (value) {
      picked[key] = value;
    }
  }

  return picked;
}

function resolveWorkspaceRootDir(options: {
  projectRootDir: string;
  workspacesRootDir?: string;
  env: OpenTofuProvisionerEnv;
}) {
  const candidate =
    options.workspacesRootDir ?? options.env.OPENTOFU_WORKSPACES_ROOT ?? DEFAULT_WORKSPACES_ROOT;

  return path.isAbsolute(candidate)
    ? candidate
    : path.resolve(options.projectRootDir, candidate);
}

function readOutputValue<T>(output: OpenTofuOutputValue<T> | undefined): T | null {
  return output?.value ?? null;
}

async function runProvisionStep<T>(
  reportStep: RangeProvisionStepReporter | undefined,
  stepName: string,
  action: () => Promise<{
    result: T;
    message?: string | null;
    stdoutExcerpt?: string | null;
    stderrExcerpt?: string | null;
  }>,
): Promise<T> {
  await reportStep?.({
    stepName,
    status: 'running',
  });

  try {
    const outcome = await action();

    await reportStep?.({
      stepName,
      status: 'succeeded',
      message: outcome.message ?? null,
      stdoutExcerpt: trimExcerpt(outcome.stdoutExcerpt),
      stderrExcerpt: trimExcerpt(outcome.stderrExcerpt),
    });

    return outcome.result;
  } catch (error) {
    const failure = readStepFailure(error);

    await reportStep?.({
      stepName,
      status: 'failed',
      message: failure.message,
      stdoutExcerpt: trimExcerpt(failure.stdoutExcerpt),
      stderrExcerpt: trimExcerpt(failure.stderrExcerpt),
    });

    throw error;
  }
}

function readStepFailure(error: unknown) {
  if (error instanceof Error) {
    const failure = error as Error & {
      stdout?: string;
      stderr?: string;
    };

    return {
      message: failure.message,
      stdoutExcerpt: failure.stdout ?? null,
      stderrExcerpt: failure.stderr ?? null,
    };
  }

  return {
    message: 'Unknown OpenTofu step failure',
    stdoutExcerpt: null,
    stderrExcerpt: null,
  };
}

function trimExcerpt(value: string | null | undefined, limit = 4000) {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();

  if (!trimmed) {
    return null;
  }

  return trimmed.length <= limit ? trimmed : trimmed.slice(trimmed.length - limit);
}

function resourceInstanceKey(address: string) {
  const indexed = address.match(/\[("(?:[^"\\]|\\.)*"|\d+)\]$/);
  return indexed ? String(JSON.parse(indexed[1])) : address;
}

function addResourceId(values: Record<string, string>, address: string, id: string) {
  let key = resourceInstanceKey(address);
  let suffix = 1;
  while (values[key] && values[key] !== id) key = `${address}#${suffix++}`;
  values[key] = id;
}
