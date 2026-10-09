import { createHash, createHmac, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ADMIN_REPOSITORY, type AdminRepository, type ProvisionJobRecord, type RangeInstanceRecord, } from './admin.repository';
import { buildAliyunTagParameters, buildBillingTags } from './billing-tagging';
import { releaseRangeInstanceBillingLedger, syncRangeInstanceBillingLedger } from './billing-ledger-sync';
import { SystemConfigService } from './system-config.service';
const ALICLOUD_ECS_API_VERSION = '2014-05-26';
const ALICLOUD_SIGNATURE_METHOD = 'HMAC-SHA1';
const ALICLOUD_SIGNATURE_VERSION = '1.0';
const DEFAULT_SYSTEM_DISK_CATEGORY = 'cloud_essd';
const DEFAULT_INTERNET_MAX_BANDWIDTH_OUT = 10;
const DESCRIBE_INSTANCE_ATTEMPTS = 30;
const DESCRIBE_INSTANCE_INTERVAL_MS = 2000;
const CREATE_ITEM_CONCURRENCY = 10;
const DESCRIBE_BATCH_WINDOW_MS = 5;
const DESCRIBE_BATCH_MAX_IDS = 100;
const DESTROY_RETRYABLE_ERROR_CODE = 'IncorrectInstanceStatus.Initializing';
const DESTROY_ALREADY_GONE_ERROR_CODES = [
  'InvalidInstanceId.NotFound',
  'InvalidInstanceIds.NotFound',
];
const DEFAULT_DESTROY_RETRY_INTERVAL_MS = 5000;
const DESTROY_RETRY_ATTEMPTS = 12;
const ALIYUN_INSTANCE_NAME_PREFIX = 'cr-';
const ALIYUN_INSTANCE_NAME_MAX_LENGTH = 128;
const ALIYUN_INSTANCE_NAME_START_PATTERN = /^[A-Za-z\u3400-\u9FFF]/u;
const ALIYUN_INSTANCE_NAME_DISALLOWED_CHARACTERS_PATTERN = /[^A-Za-z0-9._\-\u3400-\u9FFF]+/gu;
export type SingleInstanceExecutionItem = {
  instance: RangeInstanceRecord;
  job: ProvisionJobRecord;
};
type AliyunRunInstancesResponse = {
  InstanceIdSets?: {
    InstanceIdSet?: string[] | string;
  };
};
type AliyunDescribeInstancesResponse = {
  RequestId?:string;
  TotalCount?:number;
  PageNumber?:number;
  PageSize?:number;
  Instances?: {
    Instance?: AliyunInstanceDetail[] | AliyunInstanceDetail;
  };
};
type AliyunInstanceDetail = {
  InstanceId?: string;
  InstanceName?: string;
  HostName?: string;
  Status?: string;
  Tags?: {Tag?:Array<{TagKey?:string;TagValue?:string}>};
  VpcAttributes?: {
    PrivateIpAddress?: {
      IpAddress?: string[] | string;
    };
  };
  PublicIpAddress?: {
    IpAddress?: string[] | string;
  };
};
type InstanceDescribeInput = {
  accountContext: Awaited<ReturnType<SystemConfigService['getAccountContext']>>;
  instanceIds: string[];
};
type PendingInstanceDescribe = {
  input: InstanceDescribeInput;
  resolve: (details: NormalizedInstanceDetail[]) => void;
  reject: (error: unknown) => void;
};
@Injectable()
export class SingleInstanceBatchExecutionService {
  // ponytail: one shared slot pool for create/destroy/refresh; split pools only if ECS throttling shows up.
  private readonly maxConcurrency = 3;
  private inFlight = 0;
  private queue: Array<() => void> = [];
  private readonly pendingInstanceDescribes = new Map<string, PendingInstanceDescribe[]>();
  constructor(
    @Inject(ADMIN_REPOSITORY) private readonly adminRepository: AdminRepository,
    private readonly systemConfigService: SystemConfigService,
  ) {}
  async runWithSlot<T>(work: () => Promise<T>): Promise<T> {
    if (this.inFlight >= this.maxConcurrency) {
      await new Promise<void>((resolve) => {
        this.queue.push(resolve);
      });
    } else {
      this.inFlight += 1;
    }
    try {
      return await work();
    }
    finally {
      const next = this.queue.shift();
      if (next) next();
      else this.inFlight -= 1;
    }
  }
  async findCloudInstanceIdsByRangeInstanceId(rangeInstanceId: string, instance?: RangeInstanceRecord) {
    return this.runWithSlot(async () => {
      const accountContext = instance ? await this.resolveInstanceAccount(instance) : await this.resolveAccountContext();
      const details = await this.findSingleInstanceDetailsByRangeInstanceTag({
        accessKeyId: accountContext.accessKeyId,
        accessKeySecret: accountContext.accessKeySecret,
        regionId: accountContext.defaultRegion,
        rangeInstanceId,
      }, true);
      return {
        regionId: accountContext.defaultRegion,
        instanceIds:details.map(detail=>detail.instanceId),
        matchedInstances:details.map(detail=>({instanceId:detail.instanceId,ownerUserId:detail.tags.PlatformUserId??null,tags:detail.tags})),
      };
    });
  }
  async executeCreateBatch(items: SingleInstanceExecutionItem[]) {
    return this.runWithSlot(async () => {
      const groups = new Map<string, SingleInstanceExecutionItem[]>();
      for (const item of items) {
        const key = singleExecutionGroupKey(item.instance);
        groups.set(key, [...(groups.get(key) ?? []), item]);
      }
      for (const group of groups.values()) {
        try {
          const first = group[0].instance;
          const config = first.singleInstanceConfig;
          if (!config)
            throw new Error('Single instance config missing');
          const accountContext = await this.resolveInstanceAccount(first);
          const profile = config.networkProfileId
            ? await this.adminRepository.getSingleInstanceNetworkProfileById(config.networkProfileId)
            : await this.adminRepository.getSingleInstanceNetworkProfile({ provider: first.cloudProvider,
              cloudAccountUid: config.cloudAccountUid ?? undefined, regionId: accountContext.defaultRegion, zoneId: accountContext.defaultZoneId });
          if (!profile || profile.regionId !== accountContext.defaultRegion
            || (config.cloudAccountUid && profile.cloudAccountUid !== config.cloudAccountUid))
            throw new Error('Single instance network profile does not match its launch identity');
          const availability = await this.systemConfigService.getInstanceTypeAvailabilityInContext({ cpu: config.cpu, memory: config.memory }, accountContext);
          const type = availability.matches.find((match) => match.instanceTypeId === config.resolvedInstanceType)?.instanceTypeId
            ?? availability.matches[0]?.instanceTypeId;
          await processWithConcurrency(group.sort(compareByQuantityIndex), CREATE_ITEM_CONCURRENCY, async (item) => {
            const previousRequest = item.instance.singleInstanceConfig?.nativeCreateJobId === item.job.id;
            const memberType = previousRequest ? item.instance.singleInstanceConfig?.resolvedInstanceType : type;
            if (!memberType || !previousRequest && !availability.exactAvailable) {
              await this.markCreateFailure([item], availability.warning ?? 'Requested instance type is not available');
              return;
            }
            let createRequestStarted = false;
            let knownIds = Object.values(item.instance.resourceSummary?.hostIds ?? {});
            try {
              await this.assertCurrent(item);
              if (item.instance.expiresAt && item.instance.expiresAt <= new Date())
                throw new Error('Single instance has already expired');
              const expectedHostName = item.instance.singleInstanceConfig?.hostName?.trim();
              if (!previousRequest && !(await this.adminRepository.commitSingleInstanceClaim(item.job,{singleInstanceConfig:{...item.instance.singleInstanceConfig!,resolvedInstanceType:memberType,nativeCreateJobId:item.job.id}}))) throw new LostSingleInstanceClaimError();
              if (!knownIds.length) {
                createRequestStarted = true;
                const runResponse = await this.performAliyunRpcRequest<AliyunRunInstancesResponse>({
                  accessKeyId: accountContext.accessKeyId, accessKeySecret: accountContext.accessKeySecret,
                  regionId: accountContext.defaultRegion, action: 'RunInstances', method: 'POST', parameters: {
                    ImageId: item.instance.singleInstanceConfig!.imageId, InstanceType: memberType,
                    SecurityGroupId: profile.securityGroupId,
                    VSwitchId: item.instance.singleInstanceConfig!.assignedVswitchId ?? profile.vswitchIds[0],
                    Amount: '1', ClientToken: item.job.id, Password: readRuntimePassword(item.instance),
                    InstanceChargeType: 'PostPaid', InternetMaxBandwidthOut: String(readInternetMaxBandwidthOut()),
                    'SystemDisk.Category': readSystemDiskCategory(), 'SystemDisk.Size': String(item.instance.singleInstanceConfig!.systemDiskSize),
                    InstanceName: resolveAliyunInstanceName(item.instance.name), ...(expectedHostName ? { HostName: expectedHostName } : {}),
                    ...(item.instance.singleInstanceConfig?.autoReleaseTime ? { AutoReleaseTime: item.instance.singleInstanceConfig.autoReleaseTime } : {}),
                    ...buildAliyunTagParameters(buildBillingTags({ billingScope: item.instance.ownerUserId ? 'user' : 'platform',
                      ownerUserId: item.instance.ownerUserId, rangeInstanceId: item.instance.id,
                      singleInstanceBatchId: item.instance.singleInstanceBatchId, platformResourceType: 'ecs',
                      platformHostKey: item.instance.singleInstanceConfig!.hostKey, billingStartAt: item.instance.createdAt })),
                  },
                });
                knownIds = normalizeStringArray(runResponse.InstanceIdSets?.InstanceIdSet);
                if (knownIds.length !== 1)
                  throw new Error(`RunInstances returned ${knownIds.length} instance ids`);
                await this.assertCurrent(item);
                const saved = await this.adminRepository.commitSingleInstanceClaim(item.job, {
                  resourceSummary: { mode: 'ecs-native', vpcId: profile.vpcId, hostIds: { [item.instance.singleInstanceConfig!.hostKey]: knownIds[0] }, resolvedInstanceType: memberType },
                });
                if (!saved)
                  throw new LostSingleInstanceClaimError();
              }
              createRequestStarted = true;
              await this.waitForInstancesVisible({ accountContext, instanceIds: knownIds });
              const diskIds = await this.waitForSystemDisks(accountContext, knownIds[0]);
              await this.assertCurrent(item);
              await this.tagAliyunResources({ accountContext, resourceType: 'disk', resourceIds: diskIds,
                tags: buildBillingTags({ billingScope: item.instance.ownerUserId ? 'user' : 'platform', ownerUserId: item.instance.ownerUserId,
                  rangeInstanceId: item.instance.id, singleInstanceBatchId: item.instance.singleInstanceBatchId,
                  platformResourceType: 'disk', platformHostKey: item.instance.singleInstanceConfig!.hostKey, billingStartAt: item.instance.createdAt }) });
              await this.assertCurrent(item);
              await this.markCreateSubmitted({ item, instanceId: knownIds[0], systemDiskIds: diskIds, profile, resolvedInstanceType: memberType, accountContext });
            }
            catch (error) {
              if (error instanceof LostSingleInstanceClaimError || !(await this.isCurrent(item)))
                return;
              const message = error instanceof Error ? error.message : 'Unknown single-instance create error';
              const cleanupFailure = createRequestStarted ? await this.cleanupFailedSingleInstanceCreate(item, accountContext, knownIds) : null;
              await this.markCreateFailure([item], appendCleanupFailureMessage(message, cleanupFailure), createRequestStarted && !cleanupFailure, Boolean(cleanupFailure));
            }
          });
        }
        catch (error) {
          for (const item of group) {
            const current = await this.adminRepository.getRangeInstanceById(item.instance.id);
            await this.markCreateFailure([item], current?.errorSummary ?? (error instanceof Error ? error.message : 'Native batch preparation failed'), false, current?.status === 'destroy_failed' || Object.values(current?.resourceSummary?.hostIds ?? {}).length > 0);
          }
        }
      }
    });
  }
  async executeDestroyBatch(items: SingleInstanceExecutionItem[]) {
    return this.runWithSlot(async () => {
      // A failure for one owner/member must never complete or release another member's resources.
      await processWithConcurrency(items, CREATE_ITEM_CONCURRENCY, async (item) => {
        try {
          await this.assertCurrent(item);
          const accountContext = await this.resolveInstanceAccount(item.instance);
          const instanceIds = [...new Set([...Object.values(item.instance.resourceSummary?.hostIds ?? {}),
              ...await this.findSingleInstanceIdsByRangeInstanceTag({ accessKeyId: accountContext.accessKeyId,
                accessKeySecret: accountContext.accessKeySecret, regionId: accountContext.defaultRegion, rangeInstanceId: item.instance.id })])];
          await this.assertCurrent(item);
          if (instanceIds.length)
            await this.deleteInstancesWithRetry({ accessKeyId: accountContext.accessKeyId,
              accessKeySecret: accountContext.accessKeySecret, regionId: accountContext.defaultRegion, instanceIds });
          await this.verifyAbsent(item, accountContext, instanceIds);
          await this.assertCurrent(item);
          await this.markDestroySucceeded([item]);
        }
        catch (error) {
          if (error instanceof LostSingleInstanceClaimError || !(await this.isCurrent(item)))
            return;
          await this.markDestroyFailure([item], error instanceof Error ? error.message : 'Unknown native destroy error');
        }
      });
    });
  }
  async refreshSingleInstanceAccessEntry(item: SingleInstanceExecutionItem) {
    return this.runWithSlot(async () => {
      try {
        await this.assertCurrent(item);
        const accountContext = await this.resolveInstanceAccount(item.instance);
        const instanceId = resolveHostInstanceId(item.instance);
        if (!instanceId)
          throw new Error('Single-instance ECS instance id is missing');
        const [detail] = await this.waitForInstancesVisible({ accountContext, instanceIds: [instanceId], requirePublicIp: true, requireRunning: true });
        await this.assertCurrent(item);
        const hostKey = item.instance.singleInstanceConfig?.hostKey ?? 'single-ecs';
        const username = item.instance.runtimeCredentials?.[hostKey]?.username ?? 'root';
        await this.adminRepository.commitSingleInstanceClaim(item.job, {
          status: detail.status === 'Running' && detail.publicIp ? 'running' : 'creating',
          accessEntry: { hostRole: hostKey, publicIp: detail.publicIp, privateIp: detail.privateIp, ssh: detail.publicIp && username !== 'Administrator' ? `ssh ${username}@${detail.publicIp}` : null },
          runtimeTopologyGraph: patchRuntimeTopologyGraph(item.instance.runtimeTopologyGraph, hostKey, detail),
          runtimeScenarioTemplateSpec: patchRuntimeScenarioTemplate(item.instance.runtimeScenarioTemplateSpec, hostKey, detail),
          runtimeCompiledProvisionSpec: patchRuntimeCompiledProvisionSpec(item.instance.runtimeCompiledProvisionSpec, hostKey, detail), errorSummary: null,
        }, { status: 'succeeded', finishedAt: new Date(), errorSummary: null });
      }
      catch (error) {
        if (error instanceof LostSingleInstanceClaimError)
          return;
        await this.adminRepository.commitSingleInstanceClaim(item.job, {}, { status: 'failed', finishedAt: new Date(), errorSummary: error instanceof Error ? error.message : 'Refresh failed' });
      }
    });
  }
  async resolveInstanceAccount(instance: RangeInstanceRecord) {
    const config = instance.singleInstanceConfig;
    const account = config?.cloudAccountContextId
      ? await this.systemConfigService.getAccountContextById(config.cloudAccountContextId)
      : await this.resolveAccountContext();
    const topology = instance.runtimeScenarioTemplateSpec?.topology as {
      defaultRegion?: string;
    } | undefined;
    const region = config?.regionId ?? topology?.defaultRegion;
    if ((region && region !== account.defaultRegion) || (config?.cloudAccountUid && config.cloudAccountUid !== account.accountUid))
      throw new Error('Single instance cloud context differs from its immutable launch identity');
    return { ...account, defaultZoneId: config?.zoneId ?? account.defaultZoneId };
  }
  private async isCurrent(item: SingleInstanceExecutionItem) {
    const current = await this.adminRepository.getRangeInstanceById(item.instance.id);
    return current?.instanceMode === 'single' && !['destroyed', 'create_failed'].includes(current.status) && current.lastJobId === item.job.id && Boolean(item.job.startedAt)
      && await this.adminRepository.heartbeatProvisionJob(item.job.id, item.job.startedAt!, new Date());
  }
  private async assertCurrent(item: SingleInstanceExecutionItem) {
    if (!(await this.isCurrent(item)))
      throw new LostSingleInstanceClaimError();
  }
  private async waitForSystemDisks(accountContext: Awaited<ReturnType<SystemConfigService['getAccountContext']>>, instanceId: string) {
    for (let attempt = 0; attempt < DESCRIBE_INSTANCE_ATTEMPTS; attempt += 1) {
      const response = await this.performAliyunRpcRequest<{
        Disks?: {
          Disk?: Array<{
            DiskId?: string;
          }>;
        };
      }>({
        accessKeyId: accountContext.accessKeyId, accessKeySecret: accountContext.accessKeySecret, regionId: accountContext.defaultRegion,
        action: 'DescribeDisks', parameters: { InstanceId: instanceId, DiskType: 'system', PageSize: '100' },
      });
      if (!Array.isArray(response.Disks?.Disk))
        throw new Error('Malformed DescribeDisks response');
      const ids = response.Disks.Disk.map(disk => disk.DiskId?.trim() ?? '').filter(Boolean);
      if (ids.length)
        return ids;
      if (attempt < DESCRIBE_INSTANCE_ATTEMPTS - 1)
        await sleep(DESCRIBE_INSTANCE_INTERVAL_MS);
    }
    throw new Error('Created ECS instance has no visible system disk');
  }
  private async verifyAbsent(item: SingleInstanceExecutionItem, account: Awaited<ReturnType<SystemConfigService['getAccountContext']>>, knownIds: string[]) {
    let consecutiveEmpty = 0;
    for (let attempt = 0; attempt < DESTROY_RETRY_ATTEMPTS; attempt += 1) {
      await this.assertCurrent(item);
      const byId = knownIds.length ? await this.listExistingInstanceIds({ accountContext: account, instanceIds: knownIds }) : [];
      const byTag = await this.findSingleInstanceIdsByRangeInstanceTag({ accessKeyId: account.accessKeyId, accessKeySecret: account.accessKeySecret, regionId: account.defaultRegion, rangeInstanceId: item.instance.id });
      if (!byId.length && !byTag.length) {
        consecutiveEmpty += 1;
        if (consecutiveEmpty >= (knownIds.length ? 2 : DESTROY_RETRY_ATTEMPTS)) return;
      } else {
        consecutiveEmpty = 0;
        const lateIds = byTag.filter(id => !knownIds.includes(id));
        if (lateIds.length) {
          await this.assertCurrent(item);
          knownIds.push(...lateIds);
          if (!(await this.adminRepository.commitSingleInstanceClaim(item.job, {resourceSummary:{...(item.instance.resourceSummary??{}),mode:'ecs-native',hostIds:Object.fromEntries(knownIds.map((id,index)=>[index===0?item.instance.singleInstanceConfig!.hostKey:`cleanup-${index}`,id]))}}))) throw new LostSingleInstanceClaimError();
          await this.deleteInstancesWithRetry({accessKeyId:account.accessKeyId,accessKeySecret:account.accessKeySecret,regionId:account.defaultRegion,instanceIds:lateIds});
        }
      }
      if (attempt < DESTROY_RETRY_ATTEMPTS - 1)
        await sleep(readDestroyRetryIntervalMs());
    }
    throw new Error('ECS deletion could not be confirmed');
  }
  async assertNetworkUnused(profile: NonNullable<Awaited<ReturnType<AdminRepository['getSingleInstanceNetworkProfileById']>>>, account: Awaited<ReturnType<SystemConfigService['getAccountContext']>>) {
    if (!profile.vpcId)
      return;
    const response = await this.performAliyunRpcRequest<AliyunDescribeInstancesResponse>({ accessKeyId: account.accessKeyId, accessKeySecret: account.accessKeySecret, regionId: account.defaultRegion, action: 'DescribeInstances', parameters: { VpcId: profile.vpcId, PageSize: '100' } });
    if (normalizeInstanceDetails(response).length)
      throw new Error('Default network still contains cloud ECS instances');
  }
  private async deleteInstancesWithRetry(input: {
    accessKeyId: string;
    accessKeySecret: string;
    regionId: string;
    instanceIds: string[];
  }) {
    let pendingInstanceIds = input.instanceIds.slice();
    let lastError: unknown;
    for (let attempt = 0; attempt < DESTROY_RETRY_ATTEMPTS; attempt += 1) {
      if (!pendingInstanceIds.length) {
        return;
      }
      try {
        await this.performAliyunRpcRequest({
          accessKeyId: input.accessKeyId,
          accessKeySecret: input.accessKeySecret,
          regionId: input.regionId,
          action: 'DeleteInstances',
          method: 'POST',
          parameters: {
            Force: 'true',
            ...buildAliyunArrayParameters('InstanceId', pendingInstanceIds),
          },
        });
        return;
      }
      catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message : 'Unknown single-instance batch destroy error';
        if (isAlreadyGoneDestroyError(message)) {
          pendingInstanceIds = await this.listExistingInstanceIds({
            accountContext: { defaultRegion: input.regionId, accessKeyId: input.accessKeyId, accessKeySecret: input.accessKeySecret } as Awaited<ReturnType<SystemConfigService['getAccountContext']>>,
            instanceIds: pendingInstanceIds,
          });
          if (!pendingInstanceIds.length) {
            return;
          }
          continue;
        }
        if (!isRetryableDestroyError(message) || attempt >= DESTROY_RETRY_ATTEMPTS - 1) {
          throw error;
        }
        await sleep(readDestroyRetryIntervalMs());
      }
    }
    throw lastError instanceof Error ? lastError : new Error('Single-instance batch destroy exhausted retry attempts.');
  }
  private async waitForInstancesVisible(input: {
    accountContext: Awaited<ReturnType<SystemConfigService['getAccountContext']>>;
    instanceIds: string[];
    requirePublicIp?: boolean;
    requireRunning?: boolean;
  }) {
    let lastVisibleDetails: NormalizedInstanceDetail[] = [];
    for (let attempt = 0; attempt < DESCRIBE_INSTANCE_ATTEMPTS; attempt += 1) {
      const details = await this.describeInstances(input);
      const visibleDetails = details.filter((detail) => input.instanceIds.includes(detail.instanceId));
      if (visibleDetails.length >= input.instanceIds.length) {
        lastVisibleDetails = visibleDetails;
        if ((!input.requirePublicIp || visibleDetails.every((detail) => Boolean(detail.publicIp))) &&
          (!input.requireRunning || visibleDetails.every((detail) => detail.status === 'Running'))) {
          return visibleDetails;
        }
      }
      if (attempt < DESCRIBE_INSTANCE_ATTEMPTS - 1) {
        await sleep(DESCRIBE_INSTANCE_INTERVAL_MS);
      }
    }
    if (lastVisibleDetails.length >= input.instanceIds.length) {
      return lastVisibleDetails;
    }
    throw new Error('Timed out waiting for ECS instances to become visible.');
  }
  private describeInstances(input: InstanceDescribeInput): Promise<NormalizedInstanceDetail[]> {
    if (!input.instanceIds.length) return Promise.resolve([]);
    const account = input.accountContext;
    if (!account.accountUid || !account.accountUidResolved || !account.cloudAccountContextId) {
      return this.requestInstanceDetails(input);
    }
    const key = createHash('sha256').update(JSON.stringify([account.provider, account.cloudAccountContextId,
      account.accountUid, account.defaultRegion, account.defaultZoneId, account.accessKeyId, account.accessKeySecret])).digest('hex');
    return new Promise((resolve, reject) => {
      let pending = this.pendingInstanceDescribes.get(key);
      if (!pending) {
        pending = [];
        this.pendingInstanceDescribes.set(key, pending);
        const batch = pending;
        setTimeout(() => void this.flushInstanceDescribes(key, batch), DESCRIBE_BATCH_WINDOW_MS);
      }
      pending.push({ input: { accountContext: { ...account }, instanceIds: [...new Set(input.instanceIds)] }, resolve, reject });
    });
  }
  private async flushInstanceDescribes(key: string, pending: PendingInstanceDescribe[]) {
    // No response cache or in-flight reuse: every subsequent verification round queries the cloud again.
    this.pendingInstanceDescribes.delete(key);
    const ids = [...new Set(pending.flatMap((request) => request.input.instanceIds))];
    try {
      const details: NormalizedInstanceDetail[] = [];
      for (let offset = 0; offset < ids.length; offset += DESCRIBE_BATCH_MAX_IDS) {
        details.push(...await this.requestInstanceDetails({ accountContext: pending[0].input.accountContext,
          instanceIds: ids.slice(offset, offset + DESCRIBE_BATCH_MAX_IDS) }));
      }
      for (const request of pending) {
        const requested = new Set(request.input.instanceIds);
        request.resolve(details.filter((detail) => requested.has(detail.instanceId))
          .map((detail) => ({ ...detail, tags: { ...detail.tags } })));
      }
    } catch (error) {
      for (const request of pending) request.reject(error);
    }
  }
  private async requestInstanceDetails(input: InstanceDescribeInput) {
    const account = input.accountContext;
    const response = await this.performAliyunRpcRequest<AliyunDescribeInstancesResponse>({ accessKeyId: account.accessKeyId,
      accessKeySecret: account.accessKeySecret, regionId: account.defaultRegion, action: 'DescribeInstances', parameters: { InstanceIds: JSON.stringify(input.instanceIds), PageSize: '100' } });
    const raw = response.Instances?.Instance;
    const rows = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [raw] : null;
    if (!rows || rows.some((row) => !row || typeof row !== 'object' || Array.isArray(row)
      || typeof row.InstanceId !== 'string' || !row.InstanceId.trim())) {
      throw new Error('DescribeInstances response contains malformed instance identities');
    }
    const details = normalizeInstanceDetails(response);
    if (response.TotalCount !== undefined && (!Number.isSafeInteger(response.TotalCount) || response.TotalCount !== details.length)
      || new Set(details.map((detail) => detail.instanceId)).size !== details.length
      || details.some((detail) => !input.instanceIds.includes(detail.instanceId))) {
      throw new Error('DescribeInstances response is incomplete or contains duplicate instance ids');
    }
    return details;
  }
  private async listExistingInstanceIds(input: {
    accountContext: Awaited<ReturnType<SystemConfigService['getAccountContext']>>;
    instanceIds: string[];
  }) {
    return (await this.describeInstances(input)).map(detail => detail.instanceId).filter(id => input.instanceIds.includes(id));
  }
  private async markCreateSubmitted(input: {
    item: SingleInstanceExecutionItem;
    instanceId: string;
    systemDiskIds: string[];
    profile: Awaited<ReturnType<AdminRepository['getSingleInstanceNetworkProfile']>>;
    resolvedInstanceType: string;
    accountContext: Awaited<ReturnType<SystemConfigService['getAccountContext']>>;
  }) {
    const hostKey = input.item.instance.singleInstanceConfig?.hostKey ?? 'single-ecs';
    const resourceSummary = {
      mode: 'ecs-native' as const,
      vpcId: input.profile?.vpcId ?? null,
      subnetIds: input.item.instance.singleInstanceConfig?.assignedVswitchId
        ? { [hostKey]: input.item.instance.singleInstanceConfig.assignedVswitchId }
        : null,
      hostIds: {
        [hostKey]: input.instanceId,
      },
      systemDiskIds: input.systemDiskIds.length > 0 ? { [hostKey]: input.systemDiskIds[0] } : null,
      resolvedInstanceType: input.resolvedInstanceType,
      resolvedImageId: input.item.instance.singleInstanceConfig?.imageId ?? null,
    };
    if (!(await this.adminRepository.commitSingleInstanceClaim(input.item.job, {
      status: 'creating',
      accessEntry: {
        hostRole: hostKey,
        publicIp: null,
        privateIp: null,
        ssh: null,
      },
      resourceSummary,
      errorSummary: null,
    })))
      throw new LostSingleInstanceClaimError();
    await this.assertCurrent(input.item);
    await syncRangeInstanceBillingLedger({
      repository: this.adminRepository,
      instance: input.item.instance,
      regionId: input.accountContext.defaultRegion,
      cloudAccountUid: input.accountContext.accountUid,
      resourceSummary,
      sourceProvisionJobId: input.item.job.id,
      billingStartAt: new Date(),
    });
    await this.adminRepository.commitSingleInstanceClaim(input.item.job, {}, {
      status: 'succeeded',
      finishedAt: new Date(),
      errorSummary: null,
    });
  }
  private async markCreateFailure(items: SingleInstanceExecutionItem[], message: string, clearRecoveredResourceState = false, cleanupFailed = false) {
    for (const item of items) {
      let saved = false;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          saved = await this.adminRepository.commitSingleInstanceClaim(item.job, { status: cleanupFailed ? 'destroy_failed' : 'create_failed', errorSummary: message,
            ...(clearRecoveredResourceState ? { accessEntry: null, resourceSummary: null } : {}) }, { status: 'failed', finishedAt: new Date(), errorSummary: message });
          break;
        }
        catch (error) {
          if (attempt === 1 || !(await this.isCurrent(item)))
            throw error;
        }
      }
      if (saved && clearRecoveredResourceState)
        await releaseRangeInstanceBillingLedger(this.adminRepository, item.instance.id, new Date());
    }
  }
  private async cleanupFailedSingleInstanceCreate(item: SingleInstanceExecutionItem, account: Awaited<ReturnType<SystemConfigService['getAccountContext']>>, knownIds: string[]) {
    try {
      await this.assertCurrent(item);
      const ids = [...new Set([...knownIds, ...await this.findSingleInstanceIdsByRangeInstanceTag({ accessKeyId: account.accessKeyId, accessKeySecret: account.accessKeySecret, regionId: account.defaultRegion, rangeInstanceId: item.instance.id })])];
      if (ids.length) {
        await this.assertCurrent(item);
        if (!(await this.adminRepository.commitSingleInstanceClaim(item.job, { resourceSummary: { ...(item.instance.resourceSummary ?? {}), mode: 'ecs-native', hostIds: Object.fromEntries(ids.map((id, index) => [index === 0 ? item.instance.singleInstanceConfig!.hostKey : `cleanup-${index}`, id])) } })))
          throw new LostSingleInstanceClaimError();
        await this.deleteInstancesWithRetry({ accessKeyId: account.accessKeyId, accessKeySecret: account.accessKeySecret, regionId: account.defaultRegion, instanceIds: ids });
      }
      await this.verifyAbsent(item, account, ids);
      return null;
    }
    catch (error) {
      return error instanceof Error ? error.message : 'Automatic cleanup failed';
    }
  }
  private async findSingleInstanceDetailsByRangeInstanceTag(input: {
    accessKeyId: string;
    accessKeySecret: string;
    regionId: string;
    rangeInstanceId: string;
  }, validateResponse=false) {
    const details: NormalizedInstanceDetail[] = [];
    let page = 1;
    let total = 0;
    do {
      const response = await this.performAliyunRpcRequest<AliyunDescribeInstancesResponse & {
        TotalCount?: number;
      }>({ accessKeyId: input.accessKeyId, accessKeySecret: input.accessKeySecret, regionId: input.regionId, action: 'DescribeInstances', parameters: { 'Tag.1.Key': 'RangeInstanceId', 'Tag.1.Value': input.rangeInstanceId, PageSize: '100', PageNumber: String(page) } });
      if(validateResponse) {
        if(!response.RequestId?.trim() || !Number.isSafeInteger(response.TotalCount) || response.TotalCount!<0
          || response.PageNumber!==page || response.PageSize!==100 || !Array.isArray(response.Instances?.Instance)
          || response.Instances.Instance.length>100 || response.Instances.Instance.some(value=>!value.InstanceId?.trim()
            || !Array.isArray(value.Tags?.Tag) || value.Tags.Tag.some(tag=>typeof tag.TagKey!=='string'||typeof tag.TagValue!=='string')
            || new Set(value.Tags.Tag.map(tag=>tag.TagKey)).size!==value.Tags.Tag.length)) throw new Error('Cloud status response is incomplete or malformed');
      }
      const pageDetails=normalizeInstanceDetails(response);
      if(validateResponse && pageDetails.some(detail=>detail.tags.RangeInstanceId!==input.rangeInstanceId)) throw new Error('Cloud status response does not match the requested RangeInstanceId');
      details.push(...pageDetails);
      total = Number(response.TotalCount ?? details.length);
      page += 1;
    } while ((page - 1) * 100 < total);
    if(validateResponse && (details.length!==total || new Set(details.map(detail=>detail.instanceId)).size!==details.length)) throw new Error('Cloud status pagination does not prove a complete result');
    return details;
  }
  private async findSingleInstanceIdsByRangeInstanceTag(input:{accessKeyId:string;accessKeySecret:string;regionId:string;rangeInstanceId:string}) {
    return (await this.findSingleInstanceDetailsByRangeInstanceTag(input)).map(detail=>detail.instanceId);
  }

  private async markDestroyFailure(items: SingleInstanceExecutionItem[], message: string) {
    for (const item of items)
      await this.adminRepository.commitSingleInstanceClaim(item.job, { status: 'destroy_failed', errorSummary: message }, { status: 'failed', finishedAt: new Date(), errorSummary: message });
  }
  private async markDestroySucceeded(items: SingleInstanceExecutionItem[]) {
    for (const item of items) {
      const saved = await this.adminRepository.commitSingleInstanceClaim(item.job, { status: 'destroyed', errorSummary: null }, { status: 'succeeded', finishedAt: new Date(), errorSummary: null });
      if (saved)
        await releaseRangeInstanceBillingLedger(this.adminRepository, item.instance.id, new Date());
    }
  }
  private async resolveAccountContext() {
    const service = this.systemConfigService as SystemConfigService & {
      getAccountContext?: () => Promise<{
        provider: 'alibaba_cloud';
        defaultRegion: string;
        defaultZoneId: string;
        accessKeyId: string;
        accessKeySecret: string;
        accountUid: string | null;
        accountUidResolved: boolean;
      }>;
    };
    if (typeof service.getAccountContext === 'function') {
      return service.getAccountContext();
    }
    const snapshot = await this.systemConfigService.getSnapshot();
    return {
      ...snapshot,
      accountUid: null,
      accountUidResolved: false,
    };
  }
  private async tagAliyunResources(input: {
    accountContext: Awaited<ReturnType<SystemConfigService['getAccountContext']>>;
    resourceType: 'disk';
    resourceIds: string[];
    tags: Record<string, string>;
  }) {
    if (input.resourceIds.length === 0) {
      return;
    }
    await this.performAliyunRpcRequest({
      accessKeyId: input.accountContext.accessKeyId,
      accessKeySecret: input.accountContext.accessKeySecret,
      regionId: input.accountContext.defaultRegion,
      action: 'TagResources',
      method: 'POST',
      parameters: {
        ResourceType: input.resourceType,
        ...buildAliyunArrayParameters('ResourceId', input.resourceIds),
        ...buildAliyunTagParameters(input.tags),
      },
    });
  }
  private async performAliyunRpcRequest<ResponsePayload>(input: {
    accessKeyId: string;
    accessKeySecret: string;
    regionId: string;
    action: string;
    method?: 'GET' | 'POST';
    parameters?: Record<string, string>;
  }): Promise<ResponsePayload> {
    const endpoint = `https://ecs.${input.regionId}.aliyuncs.com/`;
    const method = input.method ?? 'GET';
    const signedQuery = signAliyunRpcRequest({
      Action: input.action,
      AccessKeyId: input.accessKeyId,
      Format: 'JSON',
      RegionId: input.regionId,
      SignatureMethod: ALICLOUD_SIGNATURE_METHOD,
      SignatureNonce: randomUUID(),
      SignatureVersion: ALICLOUD_SIGNATURE_VERSION,
      Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      Version: ALICLOUD_ECS_API_VERSION,
      ...(input.parameters ?? {}),
    }, input.accessKeySecret, method);
    const response = await fetch(method === 'GET' ? `${endpoint}?${signedQuery}` : endpoint, {
      method,
      headers: {
        Accept: 'application/json',
        ...(method === 'POST'
          ? {
            'Content-Type': 'application/x-www-form-urlencoded',
          }
          : {}),
      },
      ...(method === 'POST'
        ? {
          body: signedQuery,
        }
        : {}),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Aliyun ${input.action} request failed with status ${response.status}${body ? ` - ${body}` : ''}`);
    }
    const payload = await response.json() as ResponsePayload & {
      Code?: string;
    };
    if (payload.Code)
      throw new Error(`Aliyun ${input.action} rejected: ${payload.Code}`);
    return payload;
  }
}
class LostSingleInstanceClaimError extends Error {
}
function singleExecutionGroupKey(instance: RangeInstanceRecord) {
  const config = instance.singleInstanceConfig;
  return JSON.stringify([instance.ownerUserId, instance.singleInstanceBatchId, config?.cloudAccountContextId, config?.cloudAccountUid, config?.regionId, config?.zoneId, config?.networkProfileId, config?.cpu, config?.memory]);
}
function signAliyunRpcRequest(parameters: Record<string, string>, accessKeySecret: string, method: 'GET' | 'POST') {
  const canonicalizedQuery = Object.entries(parameters)
    .sort(([leftKey], [rightKey]) => compareAliyunRpcKeys(leftKey, rightKey))
    .map(([key, value]) => `${percentEncode(key)}=${percentEncode(value)}`)
    .join('&');
  const stringToSign = `${method}&${percentEncode('/')}&${percentEncode(canonicalizedQuery)}`;
  const signature = createHmac('sha1', `${accessKeySecret}&`).update(stringToSign).digest('base64');
  return `${canonicalizedQuery}&Signature=${percentEncode(signature)}`;
}
function percentEncode(value: string) {
  return encodeURIComponent(value)
    .replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%7E/g, '~');
}
function compareAliyunRpcKeys(leftKey: string, rightKey: string) {
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}
type NormalizedInstanceDetail = {
  instanceId: string;
  instanceName: string;
  hostName: string;
  privateIp: string | null;
  publicIp: string | null;
  status: string | null;
  tags:Record<string,string>;
};
function readRuntimePassword(instance: RangeInstanceRecord) {
  const hostKey = instance.singleInstanceConfig?.hostKey;
  const password = hostKey ? instance.runtimeCredentials?.[hostKey]?.password?.trim() : '';
  if (!password) {
    throw new Error('Single-instance runtime password is missing.');
  }
  return password;
}
function resolveAliyunInstanceName(name: string) {
  const sanitized = name
    .normalize('NFKC')
    .trim()
    .replace(ALIYUN_INSTANCE_NAME_DISALLOWED_CHARACTERS_PATTERN, '-')
    .replace(/[-_.]{2,}/g, '-')
    .replace(/^[-_.]+|[-_.]+$/g, '');
  const prefixed = ALIYUN_INSTANCE_NAME_START_PATTERN.test(sanitized)
    ? sanitized
    : `${ALIYUN_INSTANCE_NAME_PREFIX}${sanitized || 'instance'}`;
  return Array.from(prefixed).slice(0, ALIYUN_INSTANCE_NAME_MAX_LENGTH).join('');
}
function appendCleanupFailureMessage(createFailureMessage: string, cleanupFailureMessage: string | null) {
  return cleanupFailureMessage
    ? `${createFailureMessage}\nAutomatic cleanup failed: ${cleanupFailureMessage}`
    : createFailureMessage;
}
function compareByQuantityIndex(left: SingleInstanceExecutionItem, right: SingleInstanceExecutionItem) {
  return ((left.instance.singleInstanceConfig?.quantityIndex ?? 0) -
    (right.instance.singleInstanceConfig?.quantityIndex ?? 0));
}
function normalizeStringArray(value: string[] | string | null | undefined) {
  if (Array.isArray(value)) {
    return value.map((item) => item.trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  return [];
}
function normalizeInstanceDetails(response: AliyunDescribeInstancesResponse): NormalizedInstanceDetail[] {
  const rawInstances = response.Instances?.Instance;
  if (!response.Instances || rawInstances === undefined)
    throw new Error('Malformed DescribeInstances response');
  const instances = Array.isArray(rawInstances) ? rawInstances : rawInstances ? [rawInstances] : [];
  return instances.flatMap((instance) => {
    const instanceId = instance.InstanceId?.trim();
    if (!instanceId) {
      return [];
    }
    return [
      {
        instanceId,
        instanceName: instance.InstanceName?.trim() || '',
        hostName: instance.HostName?.trim() || '',
        privateIp: normalizeStringArray(instance.VpcAttributes?.PrivateIpAddress?.IpAddress)[0] ?? null,
        publicIp: normalizeStringArray(instance.PublicIpAddress?.IpAddress)[0] ?? null,
        status: instance.Status?.trim() || null,
        tags:Object.fromEntries((instance.Tags?.Tag??[]).filter(tag=>['PlatformUserId','RangeInstanceId','SingleInstanceBatchId','CreatedBy','PlatformScope'].includes(tag.TagKey??'') && typeof tag.TagValue==='string').map(tag=>[tag.TagKey!,tag.TagValue!])),
      },
    ];
  });
}
function resolveHostInstanceId(instance: RangeInstanceRecord) {
  const hostKey = instance.singleInstanceConfig?.hostKey ?? '';
  return hostKey ? instance.resourceSummary?.hostIds?.[hostKey] ?? null : null;
}
function patchRuntimeTopologyGraph(graph: Record<string, unknown> | null, hostKey: string, detail: NormalizedInstanceDetail) {
  if (!graph || !Array.isArray(graph.nodes)) {
    return graph;
  }
  return {
    ...graph,
    nodes: graph.nodes.map((value) => {
      if (!value || typeof value !== 'object' || (value as {
        id?: unknown;
      }).id !== hostKey) {
        return value;
      }
      const node = value as {
        data?: Record<string, unknown>;
      };
      return {
        ...value,
        data: {
          ...(node.data ?? {}),
          privateIp: detail.privateIp,
        },
      };
    }),
  };
}
function patchRuntimeScenarioTemplate(scenarioTemplateSpec: Record<string, unknown> | null, hostKey: string, detail: NormalizedInstanceDetail) {
  if (!scenarioTemplateSpec || !Array.isArray(scenarioTemplateSpec.hosts)) {
    return scenarioTemplateSpec;
  }
  return {
    ...scenarioTemplateSpec,
    hosts: scenarioTemplateSpec.hosts.map((value) => {
      if (!value || typeof value !== 'object' || (value as {
        key?: unknown;
      }).key !== hostKey) {
        return value;
      }
      return {
        ...value,
        primaryPrivateIp: detail.privateIp,
      };
    }),
  };
}
function patchRuntimeCompiledProvisionSpec(compiledProvisionSpec: Record<string, unknown> | null, hostKey: string, detail: NormalizedInstanceDetail) {
  if (!compiledProvisionSpec || !Array.isArray(compiledProvisionSpec.hosts)) {
    return compiledProvisionSpec;
  }
  return {
    ...compiledProvisionSpec,
    hosts: compiledProvisionSpec.hosts.map((value) => {
      if (!value || typeof value !== 'object' || (value as {
        key?: unknown;
      }).key !== hostKey) {
        return value;
      }
      const host = value as {
        networkInterfaces?: Array<Record<string, unknown>>;
      };
      const networkInterfaces = Array.isArray(host.networkInterfaces) ? host.networkInterfaces : [];
      return {
        ...value,
        primaryPrivateIp: detail.privateIp,
        networkInterfaces: networkInterfaces.map((networkInterface, index) => index === 0
          ? {
            ...networkInterface,
            privateIp: detail.privateIp,
          }
          : networkInterface),
      };
    }),
  };
}
function readSystemDiskCategory() {
  const value = process.env.OPENTOFU_SYSTEM_DISK_CATEGORY?.trim();
  return value || DEFAULT_SYSTEM_DISK_CATEGORY;
}
function readInternetMaxBandwidthOut() {
  const value = Number(process.env.OPENTOFU_INTERNET_MAX_BANDWIDTH_OUT ?? DEFAULT_INTERNET_MAX_BANDWIDTH_OUT);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_INTERNET_MAX_BANDWIDTH_OUT;
}
function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function buildAliyunArrayParameters(prefix: string, values: string[]) {
  return Object.fromEntries(values.map((value, index) => [`${prefix}.${index + 1}`, value]));
}
function isRetryableDestroyError(message: string) {
  return message.includes(DESTROY_RETRYABLE_ERROR_CODE);
}
function isAlreadyGoneDestroyError(message: string) {
  return DESTROY_ALREADY_GONE_ERROR_CODES.some((errorCode) => message.includes(errorCode));
}
function readDestroyRetryIntervalMs() {
  const value = Number(process.env.SINGLE_INSTANCE_DESTROY_RETRY_INTERVAL_MS ?? DEFAULT_DESTROY_RETRY_INTERVAL_MS);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_DESTROY_RETRY_INTERVAL_MS;
}
async function processWithConcurrency<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>) {
  const runnerCount = Math.max(1, Math.min(concurrency, items.length));
  let index = 0;
  await Promise.all(Array.from({ length: runnerCount }, async () => {
    while (index < items.length) {
      const item = items[index];
      index += 1;
      await worker(item);
    }
  }));
}
