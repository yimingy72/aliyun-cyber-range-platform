import { createHmac, randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import { resolveFixedInstanceType } from '../../../../packages/scenario-runtime/src/instance-type-catalog';
import {
  ADMIN_REPOSITORY,
  type AdminRepository,
  type ProvisionJobRecord,
  type RangeInstanceRecord,
} from './admin.repository';
import { buildAliyunTagParameters, buildBillingTags } from './billing-tagging';
import { releaseRangeInstanceBillingLedger, syncRangeInstanceBillingLedger } from './billing-ledger-sync';
import { SystemConfigService } from './system-config.service';

const ALICLOUD_ECS_API_VERSION = '2014-05-26';
const ALICLOUD_SIGNATURE_METHOD = 'HMAC-SHA1';
const ALICLOUD_SIGNATURE_VERSION = '1.0';
const DEFAULT_SYSTEM_DISK_CATEGORY = 'cloud_essd';
const DEFAULT_INTERNET_MAX_BANDWIDTH_OUT = 10;
const DESCRIBE_INSTANCE_ATTEMPTS = 30;
const DESCRIBE_INSTANCE_INTERVAL_MS = 2_000;
const CREATE_ITEM_CONCURRENCY = 10;
const AUTO_RELEASE_MIN_DELAY_MS = 30 * 60 * 1_000;
const DESTROY_RETRYABLE_ERROR_CODE = 'IncorrectInstanceStatus.Initializing';
const DESTROY_ALREADY_GONE_ERROR_CODES = [
  'InvalidInstanceId.NotFound',
  'InvalidInstanceIds.NotFound',
];
const DEFAULT_DESTROY_RETRY_INTERVAL_MS = 5_000;
const DESTROY_RETRY_ATTEMPTS = 12;
const ALIYUN_INSTANCE_NAME_PREFIX = 'cr-';
const ALIYUN_INSTANCE_NAME_MAX_LENGTH = 128;
const ALIYUN_INSTANCE_NAME_START_PATTERN = /^[A-Za-z\u3400-\u9FFF]/u;
const ALIYUN_INSTANCE_NAME_DISALLOWED_CHARACTERS_PATTERN = /[^A-Za-z0-9._\-\u3400-\u9FFF]+/gu;

type SingleInstanceExecutionItem = {
  instance: RangeInstanceRecord;
  job: ProvisionJobRecord;
};

type AliyunRunInstancesResponse = {
  InstanceIdSets?: {
    InstanceIdSet?: string[] | string;
  };
};

type AliyunDescribeInstancesResponse = {
  Instances?: {
    Instance?: AliyunInstanceDetail[] | AliyunInstanceDetail;
  };
};

type AliyunInstanceDetail = {
  InstanceId?: string;
  InstanceName?: string;
  HostName?: string;
  Status?: string;
  BlockDeviceMappings?: {
    BlockDeviceMapping?: Array<{ DiskId?: string }> | { DiskId?: string };
  };
  VpcAttributes?: {
    PrivateIpAddress?: {
      IpAddress?: string[] | string;
    };
  };
  PublicIpAddress?: {
    IpAddress?: string[] | string;
  };
};

@Injectable()
export class SingleInstanceBatchExecutionService {
  // ponytail: one shared slot pool for create/destroy/refresh; split pools only if ECS throttling shows up.
  private readonly maxConcurrency = 3;
  private inFlight = 0;
  private queue: Array<() => void> = [];

  constructor(
    @Inject(ADMIN_REPOSITORY) private readonly adminRepository: AdminRepository,
    private readonly systemConfigService: SystemConfigService,
  ) {}

  async runWithSlot<T>(work: () => Promise<T>): Promise<T> {
    if (this.inFlight >= this.maxConcurrency) {
      await new Promise<void>((resolve) => {
        this.queue.push(resolve);
      });
    }

    this.inFlight += 1;

    try {
      return await work();
    } finally {
      this.inFlight -= 1;
      this.queue.shift()?.();
    }
  }

  async findCloudInstanceIdsByRangeInstanceId(rangeInstanceId: string) {
    return this.runWithSlot(async () => {
      const accountContext = await this.resolveAccountContext();
      const instanceIds = await this.findSingleInstanceIdsByRangeInstanceTag({
        accessKeyId: accountContext.accessKeyId,
        accessKeySecret: accountContext.accessKeySecret,
        regionId: accountContext.defaultRegion,
        rangeInstanceId,
      });

      return {
        regionId: accountContext.defaultRegion,
        instanceIds,
      };
    });
  }

  async executeCreateBatch(items: SingleInstanceExecutionItem[]) {
    return this.runWithSlot(async () => {
      if (!items.length) {
        return;
      }

      const accountContext = await this.resolveAccountContext();
      const firstInstance = items[0].instance;
      const firstConfig = firstInstance.singleInstanceConfig;

      if (!firstConfig) {
        throw new Error('Single instance config missing');
      }

      const profile = await this.adminRepository.getSingleInstanceNetworkProfile({
        provider: firstInstance.cloudProvider,
        regionId: accountContext.defaultRegion,
        zoneId: accountContext.defaultZoneId,
      });

      if (!profile) {
        throw new Error('Single instance network profile missing');
      }

      const resolvedInstanceType = resolveFixedInstanceType(firstConfig.cpu, firstConfig.memory);

      if (!resolvedInstanceType) {
        await this.markCreateFailure(items, 'No fixed instance type mapping is available for the requested CPU / memory.');
        return;
      }

      const orderedItems = items.slice().sort(compareByQuantityIndex);

      await processWithConcurrency(orderedItems, CREATE_ITEM_CONCURRENCY, async (item) => {
        let createRequestStarted = false;

        try {
          const autoReleaseTime = resolveAliyunAutoReleaseTime(item.instance.expiresAt);
          const expectedHostName = item.instance.singleInstanceConfig?.hostName?.trim() || null;
          createRequestStarted = true;
          const runResponse = await this.performAliyunRpcRequest<AliyunRunInstancesResponse>({
            accessKeyId: accountContext.accessKeyId,
            accessKeySecret: accountContext.accessKeySecret,
            regionId: accountContext.defaultRegion,
            action: 'RunInstances',
            method: 'POST',
            parameters: {
              ImageId: item.instance.singleInstanceConfig!.imageId,
              InstanceType: resolvedInstanceType,
              SecurityGroupId: profile.securityGroupId,
              VSwitchId: item.instance.singleInstanceConfig!.assignedVswitchId ?? profile.vswitchIds[0],
              Amount: '1',
              ClientToken: item.instance.id,
              Password: readRuntimePassword(item.instance),
              InstanceChargeType: 'PostPaid',
              InternetMaxBandwidthOut: String(readInternetMaxBandwidthOut()),
              'SystemDisk.Category': readSystemDiskCategory(),
              'SystemDisk.Size': String(item.instance.singleInstanceConfig!.systemDiskSize),
              InstanceName: resolveAliyunInstanceName(item.instance.name),
              ...(expectedHostName ? { HostName: expectedHostName } : {}),
              ...(autoReleaseTime ? { AutoReleaseTime: autoReleaseTime } : {}),
              ...buildAliyunTagParameters(
                buildBillingTags({
                  billingScope: item.instance.ownerUserId ? 'user' : 'platform',
                  ownerUserId: item.instance.ownerUserId,
                  rangeInstanceId: item.instance.id,
                  singleInstanceBatchId: item.instance.singleInstanceBatchId ?? null,
                  platformResourceType: 'ecs',
                  platformHostKey: item.instance.singleInstanceConfig!.hostKey,
                  billingStartAt: new Date(),
                }),
              ),
            },
          });

          const instanceIds = normalizeStringArray(runResponse.InstanceIdSets?.InstanceIdSet);

          if (instanceIds.length !== 1) {
            throw new Error(`RunInstances returned ${instanceIds.length} instance ids for a single-instance request.`);
          }

          const [instanceDetail] = await this.waitForInstancesVisible({
            regionId: accountContext.defaultRegion,
            instanceIds,
            requireDiskIds: true,
          });

          if (!instanceDetail || instanceDetail.diskIds.length === 0) {
            throw new Error('Created ECS instance has no visible disks to tag.');
          }

          const hostKey = item.instance.singleInstanceConfig!.hostKey;
          await this.tagAliyunResources({
            accountContext,
            resourceType: 'disk',
            resourceIds: instanceDetail.diskIds,
            tags: buildBillingTags({
              billingScope: item.instance.ownerUserId ? 'user' : 'platform',
              ownerUserId: item.instance.ownerUserId,
              rangeInstanceId: item.instance.id,
              singleInstanceBatchId: item.instance.singleInstanceBatchId ?? null,
              platformResourceType: 'disk',
              platformHostKey: hostKey,
              billingStartAt: new Date(),
            }),
          });

          await this.markCreateSubmitted({
            item,
            instanceId: instanceIds[0],
            systemDiskIds: instanceDetail.diskIds,
            profile,
            resolvedInstanceType,
            accountContext,
          });
        } catch (error) {
          const createFailureMessage =
            error instanceof Error ? error.message : 'Unknown single-instance batch create error';
          const cleanupFailureMessage = createRequestStarted
            ? await this.cleanupFailedSingleInstanceCreate(item, accountContext)
            : null;
          await this.markCreateFailure(
            [item],
            appendCleanupFailureMessage(createFailureMessage, cleanupFailureMessage),
            createRequestStarted && !cleanupFailureMessage,
            createRequestStarted && Boolean(cleanupFailureMessage),
          );
        }
      });
    });
  }

  async executeDestroyBatch(items: SingleInstanceExecutionItem[]) {
    return this.runWithSlot(async () => {
      if (!items.length) {
        return;
      }

      const accountContext = await this.resolveAccountContext();
      const instanceIds = [
        ...new Set(
          (
            await Promise.all(
              items.map(async (item) => {
                const knownInstanceId = resolveHostInstanceId(item.instance);

                if (knownInstanceId) {
                  return [knownInstanceId];
                }

                return this.findSingleInstanceIdsByRangeInstanceTag({
                  accessKeyId: accountContext.accessKeyId,
                  accessKeySecret: accountContext.accessKeySecret,
                  regionId: accountContext.defaultRegion,
                  rangeInstanceId: item.instance.id,
                });
              }),
            )
          ).flat(),
        ),
      ];

      if (!instanceIds.length) {
        await this.markDestroySucceeded(items);
        return;
      }

      try {
        await this.deleteInstancesWithRetry({
          accessKeyId: accountContext.accessKeyId,
          accessKeySecret: accountContext.accessKeySecret,
          regionId: accountContext.defaultRegion,
          instanceIds,
        });

        await this.markDestroySucceeded(items);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown single-instance batch destroy error';
        await this.markDestroyFailure(items, message);
      }
    });
  }

  async refreshSingleInstanceAccessEntry(item: SingleInstanceExecutionItem) {
    return this.runWithSlot(async () => {
      const snapshot = await this.systemConfigService.getSnapshot();
      const instanceId = resolveHostInstanceId(item.instance);

      if (!instanceId) {
        await this.adminRepository.updateProvisionJob(item.job.id, {
          status: 'failed',
          finishedAt: new Date(),
          errorSummary: 'Single-instance ECS instance id is missing from resourceSummary.hostIds.',
        });
        return;
      }

      try {
        const [detail] = await this.waitForInstancesVisible({
          regionId: snapshot.defaultRegion,
          instanceIds: [instanceId],
          requirePublicIp: true,
        });

        if (!detail?.instanceId) {
          throw new Error('Timed out waiting for the single-instance to become visible.');
        }

        const hostKey = item.instance.singleInstanceConfig?.hostKey ?? 'single-ecs';
        const currentAccessEntry = item.instance.accessEntry;
        const currentResourceSummary = item.instance.resourceSummary;

        await this.adminRepository.updateRangeInstance(item.instance.id, {
          status: detail.publicIp ? 'running' : 'creating',
          accessEntry: {
            hostRole: currentAccessEntry?.hostRole ?? hostKey,
            publicIp: detail.publicIp,
            privateIp: detail.privateIp,
            ssh: detail.publicIp ? `ssh root@${detail.publicIp}` : null,
          },
          resourceSummary: {
            ...(currentResourceSummary ?? {}),
            mode: 'ecs-native',
            hostIds: {
              ...(currentResourceSummary?.hostIds ?? {}),
              [hostKey]: detail.instanceId,
            },
          },
          runtimeTopologyGraph: patchRuntimeTopologyGraph(item.instance.runtimeTopologyGraph, hostKey, detail),
          runtimeScenarioTemplateSpec: patchRuntimeScenarioTemplate(
            item.instance.runtimeScenarioTemplateSpec,
            hostKey,
            detail,
          ),
          runtimeCompiledProvisionSpec: patchRuntimeCompiledProvisionSpec(
            item.instance.runtimeCompiledProvisionSpec,
            hostKey,
            detail,
          ),
          errorSummary: null,
        });
        await this.adminRepository.updateProvisionJob(item.job.id, {
          status: 'succeeded',
          finishedAt: new Date(),
          errorSummary: null,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown single-instance access-entry refresh error';
        await this.adminRepository.updateProvisionJob(item.job.id, {
          status: 'failed',
          finishedAt: new Date(),
          errorSummary: message,
        });
      }
    });
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
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message : 'Unknown single-instance batch destroy error';

        if (isAlreadyGoneDestroyError(message)) {
          pendingInstanceIds = await this.listExistingInstanceIds({
            regionId: input.regionId,
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
    regionId: string;
    instanceIds: string[];
    requirePublicIp?: boolean;
    requireDiskIds?: boolean;
  }) {
    let lastVisibleDetails: NormalizedInstanceDetail[] = [];

    for (let attempt = 0; attempt < DESCRIBE_INSTANCE_ATTEMPTS; attempt += 1) {
      const details = await this.describeInstances(input);
      const visibleDetails = details.filter((detail) => input.instanceIds.includes(detail.instanceId));

      if (visibleDetails.length >= input.instanceIds.length) {
        lastVisibleDetails = visibleDetails;

        if (
          (!input.requirePublicIp || visibleDetails.every((detail) => Boolean(detail.publicIp))) &&
          (!input.requireDiskIds || visibleDetails.every((detail) => detail.diskIds.length > 0))
        ) {
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

  private async describeInstances(input: { regionId: string; instanceIds: string[] }) {
    const snapshot = await this.systemConfigService.getSnapshot();
    const response = await this.performAliyunRpcRequest<AliyunDescribeInstancesResponse>({
      accessKeyId: snapshot.accessKeyId,
      accessKeySecret: snapshot.accessKeySecret,
      regionId: input.regionId,
      action: 'DescribeInstances',
      parameters: {
        InstanceIds: JSON.stringify(input.instanceIds),
      },
    });

    return normalizeInstanceDetails(response);
  }

  private async listExistingInstanceIds(input: { regionId: string; instanceIds: string[] }) {
    const details = await this.describeInstances(input);
    const expectedIds = new Set(input.instanceIds);

    return details
      .map((detail) => detail.instanceId)
      .filter((instanceId) => expectedIds.has(instanceId));
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

    await this.adminRepository.updateRangeInstance(input.item.instance.id, {
      status: 'creating',
      accessEntry: {
        hostRole: hostKey,
        publicIp: null,
        privateIp: null,
        ssh: null,
      },
      resourceSummary,
      errorSummary: null,
    });
    await syncRangeInstanceBillingLedger({
      repository: this.adminRepository,
      instance: input.item.instance,
      regionId: input.accountContext.defaultRegion,
      cloudAccountUid: input.accountContext.accountUid,
      resourceSummary,
      sourceProvisionJobId: input.item.job.id,
      billingStartAt: new Date(),
    });
    await this.adminRepository.updateProvisionJob(input.item.job.id, {
      status: 'succeeded',
      finishedAt: new Date(),
      errorSummary: null,
    });
  }

  private async markCreateFailure(
    items: SingleInstanceExecutionItem[],
    message: string,
    clearRecoveredResourceState = false,
    cleanupFailed = false,
  ) {
    for (const item of items) {
      await this.adminRepository.updateRangeInstance(item.instance.id, {
        status: cleanupFailed ? 'destroy_failed' : 'create_failed',
        errorSummary: message,
        ...(clearRecoveredResourceState
          ? {
              accessEntry: null,
              resourceSummary: null,
            }
          : {}),
      });
      if (clearRecoveredResourceState) {
        await releaseRangeInstanceBillingLedger(this.adminRepository, item.instance.id, new Date());
      }
      await this.adminRepository.updateProvisionJob(item.job.id, {
        status: 'failed',
        finishedAt: new Date(),
        errorSummary: message,
      });
    }
  }

  private async cleanupFailedSingleInstanceCreate(
    item: SingleInstanceExecutionItem,
    accountContext: Awaited<ReturnType<SystemConfigService['getAccountContext']>>,
  ) {
    try {
      const instanceIds = await this.findSingleInstanceIdsByRangeInstanceTag({
        accessKeyId: accountContext.accessKeyId,
        accessKeySecret: accountContext.accessKeySecret,
        regionId: accountContext.defaultRegion,
        rangeInstanceId: item.instance.id,
      });

      if (instanceIds.length > 0) {
        await this.deleteInstancesWithRetry({
          accessKeyId: accountContext.accessKeyId,
          accessKeySecret: accountContext.accessKeySecret,
          regionId: accountContext.defaultRegion,
          instanceIds,
        });
      }

      return null;
    } catch (error) {
      return error instanceof Error ? error.message : 'Unknown automatic cleanup failure';
    }
  }

  private async findSingleInstanceIdsByRangeInstanceTag(input: {
    accessKeyId: string;
    accessKeySecret: string;
    regionId: string;
    rangeInstanceId: string;
  }) {
    const response = await this.performAliyunRpcRequest<AliyunDescribeInstancesResponse>({
      accessKeyId: input.accessKeyId,
      accessKeySecret: input.accessKeySecret,
      regionId: input.regionId,
      action: 'DescribeInstances',
      parameters: {
        'Tag.1.Key': 'RangeInstanceId',
        'Tag.1.Value': input.rangeInstanceId,
      },
    });

    return normalizeInstanceDetails(response).map((detail) => detail.instanceId);
  }

  private async markDestroyFailure(items: SingleInstanceExecutionItem[], message: string) {
    for (const item of items) {
      await this.adminRepository.updateRangeInstance(item.instance.id, {
        status: 'destroy_failed',
        errorSummary: message,
      });
      await this.adminRepository.updateProvisionJob(item.job.id, {
        status: 'failed',
        finishedAt: new Date(),
        errorSummary: message,
      });
    }
  }

  private async markDestroySucceeded(items: SingleInstanceExecutionItem[]) {
    for (const item of items) {
      await this.adminRepository.updateRangeInstance(item.instance.id, {
        status: 'destroyed',
        errorSummary: null,
      });
      await releaseRangeInstanceBillingLedger(this.adminRepository, item.instance.id, new Date());
      await this.adminRepository.updateProvisionJob(item.job.id, {
        status: 'succeeded',
        finishedAt: new Date(),
        errorSummary: null,
      });
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
    const signedQuery = signAliyunRpcRequest(
      {
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
      },
      input.accessKeySecret,
      method,
    );
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

    return (await response.json()) as ResponsePayload;
  }
}

function signAliyunRpcRequest(
  parameters: Record<string, string>,
  accessKeySecret: string,
  method: 'GET' | 'POST',
) {
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
  diskIds: string[];
  privateIp: string | null;
  publicIp: string | null;
  status: string | null;
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
  return (
    (left.instance.singleInstanceConfig?.quantityIndex ?? 0) -
    (right.instance.singleInstanceConfig?.quantityIndex ?? 0)
  );
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
        diskIds: normalizeDiskIds(instance.BlockDeviceMappings?.BlockDeviceMapping),
        privateIp: normalizeStringArray(instance.VpcAttributes?.PrivateIpAddress?.IpAddress)[0] ?? null,
        publicIp: normalizeStringArray(instance.PublicIpAddress?.IpAddress)[0] ?? null,
        status: instance.Status?.trim() || null,
      },
    ];
  });
}

function normalizeDiskIds(
  value: Array<{ DiskId?: string }> | { DiskId?: string } | null | undefined,
) {
  const mappings = Array.isArray(value) ? value : value ? [value] : [];
  return mappings.map((mapping) => mapping.DiskId?.trim() ?? '').filter(Boolean);
}

function resolveHostInstanceId(instance: RangeInstanceRecord) {
  const hostKey = instance.singleInstanceConfig?.hostKey ?? '';
  return hostKey ? instance.resourceSummary?.hostIds?.[hostKey] ?? null : null;
}

function resolveAliyunAutoReleaseTime(expiresAt: Date | null) {
  if (!expiresAt) {
    return null;
  }

  if (expiresAt.getTime() - Date.now() < AUTO_RELEASE_MIN_DELAY_MS) {
    return null;
  }

  return formatAliyunTimestamp(expiresAt);
}

function formatAliyunTimestamp(date: Date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function patchRuntimeTopologyGraph(
  graph: Record<string, unknown> | null,
  hostKey: string,
  detail: NormalizedInstanceDetail,
) {
  if (!graph || !Array.isArray(graph.nodes)) {
    return graph;
  }

  return {
    ...graph,
    nodes: graph.nodes.map((value) => {
      if (!value || typeof value !== 'object' || (value as { id?: unknown }).id !== hostKey) {
        return value;
      }

      const node = value as { data?: Record<string, unknown> };
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

function patchRuntimeScenarioTemplate(
  scenarioTemplateSpec: Record<string, unknown> | null,
  hostKey: string,
  detail: NormalizedInstanceDetail,
) {
  if (!scenarioTemplateSpec || !Array.isArray(scenarioTemplateSpec.hosts)) {
    return scenarioTemplateSpec;
  }

  return {
    ...scenarioTemplateSpec,
    hosts: scenarioTemplateSpec.hosts.map((value) => {
      if (!value || typeof value !== 'object' || (value as { key?: unknown }).key !== hostKey) {
        return value;
      }

      return {
        ...value,
        primaryPrivateIp: detail.privateIp,
      };
    }),
  };
}

function patchRuntimeCompiledProvisionSpec(
  compiledProvisionSpec: Record<string, unknown> | null,
  hostKey: string,
  detail: NormalizedInstanceDetail,
) {
  if (!compiledProvisionSpec || !Array.isArray(compiledProvisionSpec.hosts)) {
    return compiledProvisionSpec;
  }

  return {
    ...compiledProvisionSpec,
    hosts: compiledProvisionSpec.hosts.map((value) => {
      if (!value || typeof value !== 'object' || (value as { key?: unknown }).key !== hostKey) {
        return value;
      }

      const host = value as { networkInterfaces?: Array<Record<string, unknown>> };
      const networkInterfaces = Array.isArray(host.networkInterfaces) ? host.networkInterfaces : [];

      return {
        ...value,
        primaryPrivateIp: detail.privateIp,
        networkInterfaces: networkInterfaces.map((networkInterface, index) =>
          index === 0
            ? {
                ...networkInterface,
                privateIp: detail.privateIp,
              }
            : networkInterface,
        ),
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
  return Object.fromEntries(
    values.map((value, index) => [`${prefix}.${index + 1}`, value]),
  );
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

async function processWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
) {
  const runnerCount = Math.max(1, Math.min(concurrency, items.length));
  let index = 0;

  await Promise.all(
    Array.from({ length: runnerCount }, async () => {
      while (index < items.length) {
        const item = items[index];
        index += 1;
        await worker(item);
      }
    }),
  );
}
