import { createHash, randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import { ADMIN_REPOSITORY, type AdminRepository, type RangeInstanceRecord } from '../admin/admin.repository';
import { buildAliyunTagParameters } from '../admin/billing-tagging';
import { syncRangeInstanceBillingLedger } from '../admin/billing-ledger-sync';
import { signAliyunRpcQuery } from '../admin/image-catalog-rpc-signer';
import { SystemConfigService, type SystemCloudAccountContext } from '../admin/system-config.service';
import { describeTencentResourceInventory, type TencentResource, type TencentResourceKind } from '../admin/tencent-cloud-resources';
import { readRecordedDisks } from '../admin/instance-disk-inventory';

const ALICLOUD_ECS_API_VERSION = '2014-05-26';
const ALICLOUD_SIGNATURE_METHOD = 'HMAC-SHA1';
const ALICLOUD_SIGNATURE_VERSION = '1.0';
const ALICLOUD_PAGE_SIZE = 100;

const safeAliyunErrorCodes = new Set(['InvalidAccessKeyId.NotFound', 'InvalidAccessKeyId', 'InvalidAccessKeySecret',
  'SignatureDoesNotMatch', 'SignatureNonceUsed', 'SignatureExpired', 'Forbidden', 'Forbidden.RAM', 'Forbidden.SubUser',
  'Forbidden.RiskControl', 'Throttling', 'Throttling.User', 'Throttling.Api', 'InvalidRegionId', 'InvalidRegionId.NotFound',
  'InvalidAction.NotFound', 'InvalidVersion', 'MissingParameter', 'InvalidParameter', 'InternalError', 'ServiceUnavailable']);
export class AliyunResourceRequestError extends Error {
  readonly code: string;
  readonly action: string;
  readonly regionId: string | undefined;
  constructor(action: string, readonly httpStatus: number, regionId: string, body: unknown) {
    super(`Aliyun resource query failed with status ${httpStatus}`);
    this.name = 'AliyunResourceRequestError';
    this.action = ['DescribeInstances', 'DescribeDisks', 'TagResources'].includes(action) ? action : 'EcsRequest';
    this.regionId = /^(cn|ap|eu|us|me|na|sa)-[a-z0-9-]{1,48}$/.test(regionId) ? regionId : undefined;
    const code = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>).Code : null;
    this.code = typeof code === 'string' && safeAliyunErrorCodes.has(code) ? code : `ALIYUN_HTTP_${httpStatus}`;
  }
}

export type AliyunEcsCredentials = {
  provider?: 'alibaba_cloud' | 'tencent_cloud';
  accessKeyId: string;
  accessKeySecret: string;
  regionId: string;
  accountUid?: string | null;
  cloudAccountContextId?: string | null;
  accountUidResolved?: boolean;
};

export type AliyunEcsInstanceResource = {
  instanceId: string;
  diskIds: string[];
  tags: Record<string, string>;
};

type AliyunDescribeInstancesResponse = {
  TotalCount?: number | string;
  Instances?: {
    Instance?: AliyunInstance[] | AliyunInstance;
  };
};

type AliyunInstance = {
  InstanceId?: string;
  Tags?: {
    Tag?: Array<{ TagKey?: string; TagValue?: string }> | { TagKey?: string; TagValue?: string };
  };
};

@Injectable()
export class AliyunEcsResourceClient {
  constructor(private readonly systemConfigService: SystemConfigService) {}

  async getDefaultCredentials(): Promise<AliyunEcsCredentials | null> {
    const config = await this.systemConfigService.getExecutionAccountContext();
    const accessKeyId = config.accessKeyId.trim();
    const accessKeySecret = config.accessKeySecret.trim();

    if (!accessKeyId || !accessKeySecret) {
      return null;
    }

    return {
      provider: config.provider,
      accessKeyId,
      accessKeySecret,
      regionId: config.defaultRegion,
      accountUid: config.accountUid,
      cloudAccountContextId: config.cloudAccountContextId,
      accountUidResolved: config.accountUidResolved,
    };
  }

  async describeInstances(
    credentials: AliyunEcsCredentials,
    instanceIds: string[],
  ): Promise<AliyunEcsInstanceResource[]> {
    if (instanceIds.length === 0) {
      return [];
    }

    const response = await this.performRequest<AliyunDescribeInstancesResponse>({
      credentials,
      action: 'DescribeInstances',
      parameters: {
        InstanceIds: JSON.stringify(instanceIds),
      },
    });

    return normalizeInstances(response);
  }

  async listPlatformManagedInstances(credentials: AliyunEcsCredentials): Promise<AliyunEcsInstanceResource[]> {
    const [managed, legacy] = await Promise.all([
      this.listInstancesByTag(credentials, 'PlatformManaged', 'true'),
      this.listInstancesByTag(credentials, 'CreatedBy', 'cyber-range-platform'),
    ]);

    return [...new Map([...managed, ...legacy].map((instance) => [instance.instanceId, instance])).values()];
  }

  async verifyRecordedDisks(credentials: AliyunEcsCredentials, instance: RangeInstanceRecord, cloudInstanceId: string) {
    const ids = recordedHostDiskIds(instance, cloudInstanceId);
    if (!ids.length || !Object.values(instance.resourceSummary?.diskInventoryHostIds ?? {}).includes(cloudInstanceId)) return false;
    const expected = { CreatedBy:'cyber-range-platform',RangeInstanceId:instance.id,PlatformScope:instance.ownerUserId?'user':'platform',
      CloudAccountUid:credentials.accountUid,CloudAccountContextId:credentials.cloudAccountContextId,
      ...(instance.ownerUserId ? {PlatformUserId:instance.ownerUserId} : {}) };
    const disks = await readRecordedDisks((action, parameters) => this.performRequest({credentials,action,parameters}), ids);
    if (disks.length !== ids.length) return false;
    return disks.every(disk => {
      const rows = disk.Tags?.Tag ?? [];
      if (!Array.isArray(rows) || rows.some(tag => !tag || typeof tag.TagKey !== 'string' || typeof tag.TagValue !== 'string')
        || new Set(rows.map(tag=>tag.TagKey)).size !== rows.length) return false;
      const tags = Object.fromEntries(rows.map(tag=>[tag.TagKey,tag.TagValue]));
      return disk.InstanceId === cloudInstanceId && ['system','data'].includes(disk.Type)
        && !(instance.ownerUserId === null && tags.PlatformUserId)
        && Object.entries(expected).every(([key,value])=>tags[key] === undefined || tags[key] === value);
    });
  }

  async tagResources(input: {
    credentials: AliyunEcsCredentials;
    resourceType: 'disk' | 'image' | 'snapshot';
    resourceIds: string[];
    tags: Record<string, string>;
  }) {
    if (input.resourceIds.length === 0) {
      return;
    }

    await this.performRequest({
      credentials: input.credentials,
      action: 'TagResources',
      parameters: {
        ResourceType: input.resourceType,
        ...buildAliyunArrayParameters('ResourceId', input.resourceIds),
        ...buildAliyunTagParameters(input.tags),
      },
    });
  }

  private async listInstancesByTag(
    credentials: AliyunEcsCredentials,
    tagKey: string,
    tagValue: string,
  ): Promise<AliyunEcsInstanceResource[]> {
    const instances: AliyunEcsInstanceResource[] = [];
    let pageNumber = 1;
    let totalCount = 0;

    do {
      const response = await this.performRequest<AliyunDescribeInstancesResponse>({
        credentials,
        action: 'DescribeInstances',
        parameters: {
          'Tag.1.Key': tagKey,
          'Tag.1.Value': tagValue,
          PageNumber: String(pageNumber),
          PageSize: String(ALICLOUD_PAGE_SIZE),
        },
      });
      instances.push(...normalizeInstances(response));
      totalCount = normalizeNumber(response.TotalCount);
      pageNumber += 1;
    } while ((pageNumber - 1) * ALICLOUD_PAGE_SIZE < totalCount);

    return instances;
  }

  private async performRequest<ResponsePayload>(input: {
    credentials: AliyunEcsCredentials;
    action: string;
    parameters?: Record<string, string>;
  }): Promise<ResponsePayload> {
    if (input.credentials.provider === 'tencent_cloud') throw new Error('Tencent credentials cannot be sent to the Aliyun resource API');
    const query = signAliyunRpcQuery(
      {
        Action: input.action,
        AccessKeyId: input.credentials.accessKeyId,
        Format: 'JSON',
        RegionId: input.credentials.regionId,
        SignatureMethod: ALICLOUD_SIGNATURE_METHOD,
        SignatureNonce: randomUUID(),
        SignatureVersion: ALICLOUD_SIGNATURE_VERSION,
        Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
        Version: ALICLOUD_ECS_API_VERSION,
        ...(input.parameters ?? {}),
      },
      input.credentials.accessKeySecret,
    );
    const response = await fetch(`https://ecs.${input.credentials.regionId}.aliyuncs.com/?${query}`, {
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      throw new AliyunResourceRequestError(input.action, response.status, input.credentials.regionId, await response.json().catch(() => null));
    }

    return (await response.json()) as ResponsePayload;
  }
}

@Injectable()
export class PlatformResourceReconciliationService {
  constructor(
    @Inject(ADMIN_REPOSITORY) private readonly adminRepository: AdminRepository,
    private readonly aliyunEcsResourceClient: AliyunEcsResourceClient,
  ) {}

  async reconcile(now: Date = new Date()) {
    const credentials = await this.aliyunEcsResourceClient.getDefaultCredentials();

    if (!credentials) {
      return { recovered: 0, drifts: 0, skipped: true };
    }

    if (credentials.provider === 'tencent_cloud') return this.reconcileTencent(credentials, now);
    const cloudReadStartedAt = new Date();
    const [instances, cloudInstances] = await Promise.all([
      this.adminRepository.listRangeInstances(),
      this.aliyunEcsResourceClient.listPlatformManagedInstances(credentials),
    ]);
    const platformInstancesById = new Map(instances.map((instance) => [instance.id, instance]));
    let recovered = 0;
    let drifts = 0;

    for (const cloudInstance of cloudInstances) {
      const rangeInstanceId = readTag(cloudInstance.tags, 'RangeInstanceId');

      if (!rangeInstanceId) {
        drifts += 1;
        await this.recordDrift({
          cloudInstance,
          reason: 'Platform-managed ECS has no RangeInstanceId tag and cannot be matched to a platform record.',
          regionId: credentials.regionId,
          observedAt: now,
        });
        continue;
      }

      const platformInstance = platformInstancesById.get(rangeInstanceId);

      if (!platformInstance) {
        drifts += 1;
        await this.recordDrift({
          cloudInstance,
          rangeInstanceId,
          reason: 'Platform-managed ECS references a RangeInstanceId that does not exist in the platform database.',
          regionId: credentials.regionId,
          observedAt: now,
        });
        continue;
      }

      if (platformInstance.instanceMode === 'single' && platformInstance.singleInstanceConfig?.executionBackend === 'opentofu') {
        const disksVerified = await this.verifySavedDisks(credentials, platformInstance, cloudInstance.instanceId);
        const result = await this.reconcileCompletedOpenTofuMember(credentials, platformInstance.id, cloudInstance, now, cloudReadStartedAt, disksVerified);
        recovered += result.recovered;
        drifts += result.drifts;
        continue;
      }

      // Legacy/range observations never rewrite lifecycle state or cloud tags outside a fenced provisioning job.
      const current = await this.adminRepository.getRangeInstanceById(platformInstance.id);
      if (!current || current.updatedAt > cloudReadStartedAt || !current.lastJobId) continue;
      const lastJob = await this.adminRepository.getProvisionJobById(current.lastJobId);
      if (!lastJob || !['succeeded','failed'].includes(lastJob.status)) continue;
      const source = current.instanceMode === 'range' ? current.resourceSummary?.executionContext : current.singleInstanceConfig;
      const boundContext = source?.cloudAccountContextId;
      const boundUid = source?.cloudAccountUid;
      const tags = cloudInstance.tags;
      const hostKey = readTag(tags, 'PlatformHostKey');
      const owned = credentials.accountUidResolved && credentials.accountUid && credentials.cloudAccountContextId
        && boundContext === credentials.cloudAccountContextId && boundUid === credentials.accountUid
        && source?.regionId === credentials.regionId && tags.CloudAccountContextId === boundContext && tags.CloudAccountUid === boundUid
        && tags.CreatedBy === 'cyber-range-platform' && tags.PlatformManaged === 'true'
        && tags.RangeInstanceId === current.id && (tags.PlatformUserId ?? null) === current.ownerUserId
        && tags.PlatformScope === (current.ownerUserId ? 'user' : 'platform') && tags.PlatformResourceType === 'ecs'
        && (current.instanceMode !== 'single' || tags.SingleInstanceBatchId === current.singleInstanceBatchId);
      const idsMatch = hostKey && current.resourceSummary?.hostIds?.[hostKey] === cloudInstance.instanceId
        && owned && await this.verifySavedDisks(credentials, current, cloudInstance.instanceId);
      const ledgers = owned && idsMatch ? await this.adminRepository.listBillingLedgerResources({ rangeInstanceId: current.id }) : [];
      const tracked = [cloudInstance.instanceId, ...recordedHostDiskIds(current, cloudInstance.instanceId)].every(id => ledgers.some(ledger =>
        ledger.cloudResourceId === id && ledger.cloudAccountUid === boundUid && ledger.regionId === credentials.regionId
        && ledger.ownerUserId === current.ownerUserId && !ledger.releasedAt));
      if (!owned || !idsMatch || !tracked || current.status !== 'running' || lastJob.status !== 'succeeded') {
        drifts += 1;
        await this.recordDrift({ cloudInstance, rangeInstanceId: current.id, regionId: credentials.regionId, observedAt: now,
          reason: !owned ? 'Tagged ECS has no complete frozen account and owner proof; lifecycle and billing ownership were left unchanged.'
            : 'Owned ECS still exists but lifecycle, resource inventory or billing ledger needs recovery; no automatic state rewrite was performed.' });
      }

    }

    return { recovered, drifts, skipped: false };
  }

  private async reconcileTencent(credentials: AliyunEcsCredentials, now: Date) {
    const account: SystemCloudAccountContext = { provider: 'tencent_cloud', defaultRegion: credentials.regionId, defaultZoneId: '', imageImportBucket: '',
      accountUid: credentials.accountUid ?? null, cloudAccountContextId: credentials.cloudAccountContextId,
      accountUidResolved: credentials.accountUidResolved === true, accessKeyId: credentials.accessKeyId, accessKeySecret: credentials.accessKeySecret };
    const readStartedAt = new Date();
    const instances = await this.adminRepository.listRangeInstances();
    const sources = instances.filter(instance => {
      const source = instance.instanceMode === 'single' ? instance.singleInstanceConfig : instance.resourceSummary?.executionContext;
      return instance.cloudProvider === 'tencent_cloud' && source?.cloudAccountUid === account.accountUid
        && source.cloudAccountContextId === account.cloudAccountContextId && source.regionId === account.defaultRegion;
    });
    const inventory = new Map<string, TencentResource>();
    const observe = (resource: TencentResource) => inventory.set(`${resource.kind}:${resource.id}`, resource);
    for (const kind of ['ecs', 'disk', 'vpc', 'vswitch', 'security_group', 'eni', 'nat', 'eip'] as TencentResourceKind[]) {
      // Tag observations are audit evidence only; they never establish lifecycle or billing ownership.
      for (const resource of await describeTencentResourceInventory(account, kind, { tags: { CreatedBy: 'cyber-range-platform' } })) observe(resource);
      const recordedIds = [...new Set(sources.flatMap(instance => recordedTencentResourceIds(instance, kind)))];
      for (const resource of await describeTencentResourceInventory(account, kind, { ids: recordedIds })) observe(resource);
    }
    const snapshotIds = (await this.adminRepository.listBillingLedgerResources()).filter(ledger => ledger.cloudProvider === 'tencent_cloud'
      && ledger.cloudAccountUid === account.accountUid && ledger.regionId === account.defaultRegion && ledger.cloudResourceType === 'snapshot').map(ledger => ledger.cloudResourceId);
    for (const resource of await describeTencentResourceInventory(account, 'snapshot', { ids: snapshotIds })) observe(resource);
    const aclIds = [...new Set(sources.flatMap(instance => recordedTencentResourceIds(instance, 'network_acl')))];
    for (const resource of await describeTencentResourceInventory(account, 'network_acl', { ids: aclIds })) observe(resource);
    for (const vpcId of [...new Set(sources.map(instance => instance.resourceSummary?.vpcId).filter((id): id is string => Boolean(id)))]) {
      for (const resource of await describeTencentResourceInventory(account, 'network_acl', { vpcId })) observe(resource);
    }
    let drifts = 0;
    for (const resource of inventory.values()) {
      const rangeInstanceId = resource.tags.RangeInstanceId;
      const instance = rangeInstanceId ? await this.adminRepository.getRangeInstanceById(rangeInstanceId) : null;
      const source = instance?.instanceMode === 'single' ? instance.singleInstanceConfig : instance?.resourceSummary?.executionContext;
      const currentJob = instance?.lastJobId ? await this.adminRepository.getProvisionJobById(instance.lastJobId) : null;
      if (instance && (instance.updatedAt > readStartedAt || currentJob && ['pending', 'running'].includes(currentJob.status))) continue;
      const sourceJobId = resource.tags.PlatformCreateJobId;
      const sourceJob = sourceJobId ? await this.adminRepository.getProvisionJobById(sourceJobId) : null;
      const tags = resource.tags;
      const owned = instance?.cloudProvider === 'tencent_cloud' && source?.cloudAccountUid === account.accountUid
        && source.cloudAccountContextId === account.cloudAccountContextId && source.regionId === account.defaultRegion
        && tags.CloudAccountUid === account.accountUid && tags.CloudAccountContextId === account.cloudAccountContextId
        && tags.CreatedBy === 'cyber-range-platform' && tags.PlatformManaged === 'true' && tags.ExecutionBackend === 'opentofu'
        && tags.RangeInstanceId === instance.id && (tags.PlatformUserId ?? null) === instance.ownerUserId
        && tags.PlatformScope === (instance.ownerUserId ? 'user' : 'platform')
        && (instance.instanceMode !== 'single' || tags.SingleInstanceBatchId === instance.singleInstanceBatchId)
        && sourceJob?.rangeInstanceId === instance.id
        && (sourceJob.cloudWorkspaceId ?? 'legacy-unbound') === (instance.cloudWorkspaceId ?? 'legacy-unbound')
        && (['create', 'retry'].includes(sourceJob.jobType) || instance.instanceMode === 'range' && sourceJob.jobType === 'update'
          && Boolean(sourceJob.startedAt) && sourceJob.topologySnapshot?.operation === 'update')
        && (instance.instanceMode !== 'single' || instance.singleInstanceConfig?.opentofuCreateJobId === sourceJobId
          && tags.CreationIntentId === createHash('sha256').update(JSON.stringify(['tencent_cloud', source.cloudAccountContextId, source.cloudAccountUid,
            source.regionId, instance.singleInstanceConfig?.zoneId, instance.singleInstanceBatchId, instance.id, sourceJobId])).digest('hex').slice(0, 32))
        && recordedTencentResourceIds(instance, resource.kind).includes(resource.id);
      const ledgers = owned && instance ? await this.adminRepository.listBillingLedgerResources({ rangeInstanceId: instance.id }) : [];
      const tracked = ledgers.some(ledger => ledger.cloudProvider === 'tencent_cloud' && ledger.cloudResourceId === resource.id
        && ledger.cloudAccountUid === account.accountUid && ledger.regionId === account.defaultRegion && !ledger.releasedAt
        && ledger.ownerUserId === instance?.ownerUserId);
      const freeResource = ['vpc', 'vswitch', 'security_group', 'network_acl', 'eni'].includes(resource.kind);
      const verified = owned && (tracked || freeResource) && instance?.status === 'running' && currentJob?.status === 'succeeded';
      await this.adminRepository.upsertCloudResourceDrift({ cloudProvider: 'tencent_cloud', regionId: account.defaultRegion,
        cloudResourceType: resource.kind === 'nat' ? 'nat_gateway' : resource.kind, cloudResourceId: resource.id,
        rangeInstanceId: instance?.id ?? null, severity: 'critical', observedAt: now,
        reason: verified ? 'Frozen Tencent resource inventory matches durable platform ownership and existing billing evidence.'
          : 'Tencent resource exists without complete durable platform lifecycle, creation and billing proof; no resource was adopted, deleted or marked released.',
        tagsSnapshot: { ...resource.tags, providerEvidence: resource.evidence, observedInstanceId: resource.instanceId, observedVpcId: resource.vpcId } });
      if (verified) await this.adminRepository.resolveCloudResourceDrift({ cloudProvider: 'tencent_cloud', regionId: account.defaultRegion,
        cloudResourceType: resource.kind === 'nat' ? 'nat_gateway' : resource.kind, cloudResourceId: resource.id, resolvedAt: now });
      else drifts++;
    }
    return { recovered: 0, drifts, skipped: false };
  }

  private async reconcileCompletedOpenTofuMember(credentials: AliyunEcsCredentials, instanceId: string,
    cloudInstance: AliyunEcsInstanceResource, now: Date, cloudReadStartedAt: Date, disksVerified: boolean) {
    // Intake takes this same lock. Recheck after the cloud read so a newly queued destroy cannot be overwritten.
    return this.adminRepository.withSingleInstanceControlLock(async () => {
      const instance = await this.adminRepository.getRangeInstanceById(instanceId);
      const config = instance?.singleInstanceConfig;
      const skipped = { recovered: 0, drifts: 0 };
      if (!instance || instance.instanceMode !== 'single' || config?.executionBackend !== 'opentofu'
        || !['running', 'create_failed', 'destroy_failed', 'destroyed'].includes(instance.status)
        || !instance.lastJobId || instance.updatedAt > cloudReadStartedAt) return skipped;
      const job = await this.adminRepository.getProvisionJobById(instance.lastJobId);
      if (!job || job.rangeInstanceId !== instance.id || !['succeeded', 'failed'].includes(job.status)) return skipped;
      const unverifiedOwnership = async (reason = 'Tagged ECS ownership does not match the frozen platform account, user, batch, host or creation job; no user bill was assigned.') => {
        await this.recordDrift({ cloudInstance, rangeInstanceId: instance.id, regionId: credentials.regionId, observedAt: now,
          reason });
        return { recovered: 0, drifts: 1 };
      };
      if (!credentials.accountUidResolved || !credentials.accountUid || !credentials.cloudAccountContextId
        || config.cloudAccountUid !== credentials.accountUid || config.cloudAccountContextId !== credentials.cloudAccountContextId
        || config.regionId !== credentials.regionId || !instance.singleInstanceBatchId) return unverifiedOwnership();
      const tags = cloudInstance.tags;
      if (tags.CreatedBy !== 'cyber-range-platform' || tags.PlatformManaged !== 'true' || tags.ExecutionBackend !== 'opentofu'
        || tags.CloudAccountUid !== config.cloudAccountUid || tags.CloudAccountContextId !== config.cloudAccountContextId
        || tags.RangeInstanceId !== instance.id || tags.SingleInstanceBatchId !== instance.singleInstanceBatchId
        || (tags.PlatformUserId ?? null) !== instance.ownerUserId || tags.PlatformScope !== (instance.ownerUserId ? 'user' : 'platform')
        || tags.PlatformResourceType !== 'ecs' || tags.PlatformHostKey !== config.hostKey || !tags.PlatformCreateJobId) return unverifiedOwnership();
      const sourceJob = await this.adminRepository.getProvisionJobById(tags.PlatformCreateJobId);
      if (!sourceJob || sourceJob.rangeInstanceId !== instance.id || !['create', 'retry'].includes(sourceJob.jobType)) return unverifiedOwnership();
      // Recovery inventory can contain several physical ECS; this observation proves only one host and its disks.
      const diskIds = new Set(disksVerified ? recordedHostDiskIds(instance, cloudInstance.instanceId) : []);
      const observedSummary = { mode: 'opentofu' as const, hostIds: { [config.hostKey]: cloudInstance.instanceId },
        systemDiskIds: Object.fromEntries(Object.entries(instance.resourceSummary?.systemDiskIds ?? {}).filter(([, id]) => diskIds.has(id))),
        dataDiskIds: Object.fromEntries(Object.entries(instance.resourceSummary?.dataDiskIds ?? {}).filter(([, id]) => diskIds.has(id))) };
      if (instance.status !== 'running' || job.status !== 'succeeded') {
        // Tags locate a candidate; only durable physical identity proves who created it.
        if (instance.resourceSummary?.hostIds?.[config.hostKey] !== cloudInstance.instanceId) {
          const ledger = await this.adminRepository.findBillingLedgerResource({ cloudProvider: 'alibaba_cloud',
            regionId: credentials.regionId, cloudResourceId: cloudInstance.instanceId, cloudResourceType: 'ecs' });
          if (!ledger || ledger.cloudAccountUid !== config.cloudAccountUid || ledger.ownerUserId !== instance.ownerUserId
            || ledger.rangeInstanceId !== instance.id || ledger.singleInstanceBatchId !== instance.singleInstanceBatchId
            || ledger.sourceProvisionJobId !== sourceJob.id) {
            return unverifiedOwnership('Tagged ECS has no matching persisted physical identity or original billing ledger; no resource was adopted.');
          }
        }
        // A failed job does not make a proven surviving cloud resource free. Do not revive its lifecycle.
        await syncRangeInstanceBillingLedger({ repository: this.adminRepository, instance,
          regionId: credentials.regionId, cloudAccountUid: credentials.accountUid,
          resourceSummary: observedSummary,
          billingStartAt: instance.createdAt, sourceProvisionJobId: sourceJob.id });
        await this.recordDrift({ cloudInstance, rangeInstanceId: instance.id, regionId: credentials.regionId, observedAt: now,
          reason: `Platform instance is ${instance.status} but its owned ECS still exists; billing remains open until cloud deletion is verified.` });
        return { recovered: 0, drifts: 1 };
      }
      if (instance.resourceSummary?.hostIds?.[config.hostKey] !== cloudInstance.instanceId || !disksVerified)
        return unverifiedOwnership('Persisted disk inventory is missing, incomplete or conflicts with cloud evidence; no unrecorded attached disk was adopted.');
      // OpenTofu owns volume_tags; this path performs no cloud mutations while holding the intake lock.
      await syncRangeInstanceBillingLedger({ repository: this.adminRepository, instance,
        regionId: credentials.regionId, cloudAccountUid: credentials.accountUid,
        resourceSummary: observedSummary, billingStartAt: instance.createdAt,
        sourceProvisionJobId: ['create', 'retry'].includes(job.jobType) ? job.id : null });
      await this.adminRepository.resolveCloudResourceDrift({ regionId: credentials.regionId, cloudResourceType: 'ecs',
        cloudResourceId: cloudInstance.instanceId, resolvedAt: now });
      return { recovered: 0, drifts: 0 };
    });
  }

  private async verifySavedDisks(credentials: AliyunEcsCredentials, instance: RangeInstanceRecord, cloudInstanceId: string) {
    const source = instance.instanceMode === 'single' ? instance.singleInstanceConfig : instance.resourceSummary?.executionContext;
    if (!credentials.accountUidResolved || !credentials.accountUid || !credentials.cloudAccountContextId
      || source?.cloudAccountUid !== credentials.accountUid || source?.cloudAccountContextId !== credentials.cloudAccountContextId
      || source.regionId !== credentials.regionId || !instance.lastJobId) return false;
    const job = await this.adminRepository.getProvisionJobById(instance.lastJobId);
    if (!job || !['succeeded','failed'].includes(job.status)) return false;
    try { return await this.aliyunEcsResourceClient.verifyRecordedDisks(credentials,instance,cloudInstanceId); }
    catch { return false; }
  }

  private async recordDrift(input: {
    cloudInstance: AliyunEcsInstanceResource;
    rangeInstanceId?: string | null;
    reason: string;
    regionId: string;
    observedAt: Date;
  }) {
    await this.adminRepository.upsertCloudResourceDrift({
      regionId: input.regionId,
      cloudResourceType: 'ecs',
      cloudResourceId: input.cloudInstance.instanceId,
      rangeInstanceId: input.rangeInstanceId ?? null,
      severity: 'critical',
      reason: input.reason,
      tagsSnapshot: input.cloudInstance.tags,
      observedAt: input.observedAt,
    });
  }
}

function normalizeInstances(response: AliyunDescribeInstancesResponse): AliyunEcsInstanceResource[] {
  const rawInstances = response.Instances?.Instance;
  const instances = Array.isArray(rawInstances) ? rawInstances : rawInstances ? [rawInstances] : [];

  return instances.flatMap((instance) => {
    const instanceId = instance.InstanceId?.trim();

    if (!instanceId) {
      return [];
    }

    return [
      {
        instanceId,
        diskIds: [],
        tags: normalizeTags(instance.Tags?.Tag),
      },
    ];
  });
}

function recordedHostDiskIds(instance: RangeInstanceRecord, cloudInstanceId: string) {
  const summary = instance.resourceSummary;
  const hosts = new Set(Object.entries(summary?.hostIds ?? {}).filter(([,id])=>id===cloudInstanceId).map(([key])=>key));
  return [...new Set([...Object.entries(summary?.systemDiskIds ?? {}).filter(([key])=>hosts.has(key)).map(([,id])=>id),
    ...Object.values(summary?.dataDiskIds ?? {}).filter(id=>summary?.diskOwnershipProofs?.[id]?.instanceId===cloudInstanceId)])];
}

function normalizeTags(
  value: Array<{ TagKey?: string; TagValue?: string }> | { TagKey?: string; TagValue?: string } | null | undefined,
) {
  const tags = Array.isArray(value) ? value : value ? [value] : [];

  return Object.fromEntries(
    tags.flatMap((tag) => {
      const key = tag.TagKey?.trim() ?? '';
      const value = tag.TagValue?.trim() ?? '';
      return key && value ? [[key, value]] : [];
    }),
  );
}

function normalizeNumber(value: number | string | undefined) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function readTag(tags: Record<string, string>, key: string) {
  const value = tags[key]?.trim() ?? '';
  return value || null;
}

function buildAliyunArrayParameters(prefix: string, values: string[]) {
  return Object.fromEntries(values.map((value, index) => [`${prefix}.${index + 1}`, value]));
}

function recordedTencentResourceIds(instance: RangeInstanceRecord, kind: TencentResourceKind): string[] {
  const summary = instance.resourceSummary;
  const map: Partial<Record<TencentResourceKind, Record<string, string> | null | undefined>> = {
    ecs: summary?.hostIds, disk: { ...summary?.systemDiskIds, ...summary?.dataDiskIds }, vswitch: summary?.subnetIds,
    security_group: summary?.securityGroupIds, network_acl: summary?.networkAclIds, eni: summary?.secondaryNetworkInterfaceIds, nat: summary?.natGatewayIds,
  };
  if (kind === 'vpc') return summary?.vpcId ? [summary.vpcId] : [];
  if (kind === 'eip') return [...new Set([summary?.eipAllocationId, ...Object.values(summary?.eipAllocationIds ?? {})].filter((id): id is string => Boolean(id)))];
  return Object.values(map[kind] ?? {});
}
