import { createHmac, randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import { resolveFixedInstanceType } from '../../../../packages/scenario-runtime/src/instance-type-catalog';
import {
  ADMIN_REPOSITORY,
  type AdminRepository,
  type ProvisionJobRecord,
  type RangeAccessEntry,
  type RangeInstanceRecord,
  type RangeResourceSummary,
} from './admin.repository';
import { SystemConfigService } from './system-config.service';

const ALICLOUD_ECS_API_VERSION = '2014-05-26';
const ALICLOUD_SIGNATURE_METHOD = 'HMAC-SHA1';
const ALICLOUD_SIGNATURE_VERSION = '1.0';
const DEFAULT_SYSTEM_DISK_CATEGORY = 'cloud_essd';
const DEFAULT_INTERNET_MAX_BANDWIDTH_OUT = 10;
const DESCRIBE_INSTANCE_ATTEMPTS = 10;
const DESCRIBE_INSTANCE_INTERVAL_MS = 2_000;
const DESTROY_RETRYABLE_ERROR_CODE = 'IncorrectInstanceStatus.Initializing';
const DEFAULT_DESTROY_RETRY_INTERVAL_MS = 5_000;
const DESTROY_RETRY_ATTEMPTS = 12;

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

  async executeCreateBatch(items: SingleInstanceExecutionItem[]) {
    return this.runWithSlot(async () => {
      if (!items.length) {
        return;
      }

      const snapshot = await this.systemConfigService.getSnapshot();
      const firstInstance = items[0].instance;
      const firstConfig = firstInstance.singleInstanceConfig;

      if (!firstConfig) {
        throw new Error('Single instance config missing');
      }

      const profile = await this.adminRepository.getSingleInstanceNetworkProfile({
        provider: firstInstance.cloudProvider,
        regionId: snapshot.defaultRegion,
        zoneId: snapshot.defaultZoneId,
      });

      if (!profile) {
        throw new Error('Single instance network profile missing');
      }

      const resolvedInstanceType = resolveFixedInstanceType(firstConfig.cpu, firstConfig.memory);

      if (!resolvedInstanceType) {
        await this.markCreateFailure(items, 'No fixed instance type mapping is available for the requested CPU / memory.');
        return;
      }

      const itemsByVswitch = groupItemsByVswitch(items);

      for (const group of itemsByVswitch) {
        try {
          const runResponse = await this.performAliyunRpcRequest<AliyunRunInstancesResponse>({
            accessKeyId: snapshot.accessKeyId,
            accessKeySecret: snapshot.accessKeySecret,
            regionId: snapshot.defaultRegion,
            action: 'RunInstances',
            method: 'POST',
            parameters: {
              ImageId: group[0].instance.singleInstanceConfig!.imageId,
              InstanceType: resolvedInstanceType,
              SecurityGroupId: profile.securityGroupId,
              VSwitchId: group[0].instance.singleInstanceConfig!.assignedVswitchId ?? profile.vswitchIds[0],
              Amount: String(group.length),
              Password: readRuntimePassword(group[0].instance),
              InstanceChargeType: 'PostPaid',
              InternetMaxBandwidthOut: String(readInternetMaxBandwidthOut()),
              'SystemDisk.Category': readSystemDiskCategory(),
              'SystemDisk.Size': String(group[0].instance.singleInstanceConfig!.systemDiskSize),
              InstanceName: buildAliyunIndexedPattern(
                group[0].instance.singleInstanceConfig!.baseName,
                group[0].instance.singleInstanceConfig!.quantityIndex,
                group.length,
              ),
              HostName: buildAliyunIndexedPattern(
                deriveHostBaseName(group[0].instance),
                group[0].instance.singleInstanceConfig!.quantityIndex,
                group.length,
              ),
            },
          });

          const instanceIds = normalizeStringArray(runResponse.InstanceIdSets?.InstanceIdSet);

          if (instanceIds.length !== group.length) {
            throw new Error(`RunInstances returned ${instanceIds.length} instance ids for ${group.length} requested instances.`);
          }

          const details = await this.waitForInstancesVisible({
            regionId: snapshot.defaultRegion,
            instanceIds,
            requirePublicIp: true,
          });
          const orderedDetails = orderDetailsByInstanceName(details, group);

          for (let index = 0; index < group.length; index += 1) {
            const detail = orderedDetails[index];

            if (!detail?.instanceId) {
              throw new Error('RunInstances did not return enough describable ECS instances.');
            }

            if (detail.instanceName !== group[index].instance.name || detail.hostName !== group[index].instance.singleInstanceConfig?.hostName) {
              await this.performAliyunRpcRequest({
                accessKeyId: snapshot.accessKeyId,
                accessKeySecret: snapshot.accessKeySecret,
                regionId: snapshot.defaultRegion,
                action: 'ModifyInstanceAttribute',
                method: 'POST',
                parameters: {
                  InstanceId: detail.instanceId,
                  InstanceName: group[index].instance.name,
                  HostName: group[index].instance.singleInstanceConfig?.hostName ?? group[index].instance.name,
                },
              });
            }

            await this.markCreateSuccess({
              item: group[index],
              detail,
              profile,
              resolvedInstanceType,
            });
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown single-instance batch create error';
          await this.markCreateFailure(group, message);
        }
      }
    });
  }

  async executeDestroyBatch(items: SingleInstanceExecutionItem[]) {
    return this.runWithSlot(async () => {
      if (!items.length) {
        return;
      }

      const snapshot = await this.systemConfigService.getSnapshot();
      const instanceIds = items
        .map((item) => resolveHostInstanceId(item.instance))
        .filter((value): value is string => Boolean(value));

      if (!instanceIds.length) {
        await this.markDestroyFailure(items, 'Single-instance ECS instance id is missing from resourceSummary.hostIds.');
        return;
      }

      try {
        await this.deleteInstancesWithRetry({
          accessKeyId: snapshot.accessKeyId,
          accessKeySecret: snapshot.accessKeySecret,
          regionId: snapshot.defaultRegion,
          instanceIds,
        });

        for (const item of items) {
          await this.adminRepository.updateRangeInstance(item.instance.id, {
            status: 'destroyed',
            accessEntry: null,
            resourceSummary: null,
            errorSummary: null,
          });
          await this.adminRepository.updateProvisionJob(item.job.id, {
            status: 'succeeded',
            finishedAt: new Date(),
            errorSummary: null,
          });
        }
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

        if (!detail?.instanceId || !detail.publicIp) {
          throw new Error('Timed out waiting for the single-instance public IP to become available.');
        }

        const hostKey = item.instance.singleInstanceConfig?.hostKey ?? 'single-ecs';
        const currentAccessEntry = item.instance.accessEntry;

        await this.adminRepository.updateRangeInstance(item.instance.id, {
          accessEntry: {
            hostRole: currentAccessEntry?.hostRole ?? hostKey,
            publicIp: detail.publicIp,
            privateIp: detail.privateIp,
            ssh: `ssh root@${detail.publicIp}`,
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
    let lastError: unknown;

    for (let attempt = 0; attempt < DESTROY_RETRY_ATTEMPTS; attempt += 1) {
      try {
        await this.performAliyunRpcRequest({
          accessKeyId: input.accessKeyId,
          accessKeySecret: input.accessKeySecret,
          regionId: input.regionId,
          action: 'DeleteInstances',
          method: 'POST',
          parameters: {
            Force: 'true',
            ...buildAliyunArrayParameters('InstanceId', input.instanceIds),
          },
        });
        return;
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message : 'Unknown single-instance batch destroy error';

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
  }) {
    let lastVisibleDetails: NormalizedInstanceDetail[] = [];

    for (let attempt = 0; attempt < DESCRIBE_INSTANCE_ATTEMPTS; attempt += 1) {
      const details = await this.describeInstances(input);
      const visibleDetails = details.filter((detail) => input.instanceIds.includes(detail.instanceId));

      if (visibleDetails.length >= input.instanceIds.length) {
        lastVisibleDetails = visibleDetails;

        if (!input.requirePublicIp || visibleDetails.every((detail) => Boolean(detail.publicIp))) {
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

  private async markCreateSuccess(input: {
    item: SingleInstanceExecutionItem;
    detail: NormalizedInstanceDetail;
    profile: Awaited<ReturnType<AdminRepository['getSingleInstanceNetworkProfile']>>;
    resolvedInstanceType: string;
  }) {
    const hostKey = input.item.instance.singleInstanceConfig?.hostKey ?? 'single-ecs';
    const resourceSummary: RangeResourceSummary = {
      mode: 'ecs-native',
      vpcId: input.profile?.vpcId ?? null,
      subnetIds: input.item.instance.singleInstanceConfig?.assignedVswitchId
        ? { [hostKey]: input.item.instance.singleInstanceConfig.assignedVswitchId }
        : null,
      hostIds: { [hostKey]: input.detail.instanceId },
      resolvedInstanceType: input.resolvedInstanceType,
      resolvedImageId: input.item.instance.singleInstanceConfig?.imageId ?? null,
    };
    const accessEntry: RangeAccessEntry = {
      hostRole: hostKey,
      publicIp: input.detail.publicIp,
      privateIp: input.detail.privateIp,
      ssh: input.detail.publicIp ? `ssh root@${input.detail.publicIp}` : null,
    };

    await this.adminRepository.updateRangeInstance(input.item.instance.id, {
      status: 'running',
      accessEntry,
      resourceSummary,
      runtimeTopologyGraph: patchRuntimeTopologyGraph(input.item.instance.runtimeTopologyGraph, hostKey, input.detail),
      runtimeScenarioTemplateSpec: patchRuntimeScenarioTemplate(input.item.instance.runtimeScenarioTemplateSpec, hostKey, input.detail),
      runtimeCompiledProvisionSpec: patchRuntimeCompiledProvisionSpec(
        input.item.instance.runtimeCompiledProvisionSpec,
        hostKey,
        input.detail,
      ),
      errorSummary: null,
    });
    await this.adminRepository.updateProvisionJob(input.item.job.id, {
      status: 'succeeded',
      finishedAt: new Date(),
      errorSummary: null,
    });
  }

  private async markCreateFailure(items: SingleInstanceExecutionItem[], message: string) {
    for (const item of items) {
      await this.adminRepository.updateRangeInstance(item.instance.id, {
        status: 'create_failed',
        errorSummary: message,
      });
      await this.adminRepository.updateProvisionJob(item.job.id, {
        status: 'failed',
        finishedAt: new Date(),
        errorSummary: message,
      });
    }
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

function groupItemsByVswitch(items: SingleInstanceExecutionItem[]) {
  const groups = new Map<string, SingleInstanceExecutionItem[]>();

  for (const item of items.slice().sort(compareByQuantityIndex)) {
    const vswitchId = item.instance.singleInstanceConfig?.assignedVswitchId?.trim() || 'default-vswitch';
    const group = groups.get(vswitchId) ?? [];
    group.push(item);
    groups.set(vswitchId, group);
  }

  return Array.from(groups.values());
}

function compareByQuantityIndex(left: SingleInstanceExecutionItem, right: SingleInstanceExecutionItem) {
  return (
    (left.instance.singleInstanceConfig?.quantityIndex ?? 0) -
    (right.instance.singleInstanceConfig?.quantityIndex ?? 0)
  );
}

function buildAliyunIndexedPattern(base: string, startIndex: number, amount: number) {
  if (amount <= 1) {
    return `${base}-${String(startIndex).padStart(2, '0')}`;
  }

  return `${base}-[${startIndex},2]`;
}

function deriveHostBaseName(instance: RangeInstanceRecord) {
  const hostName = instance.singleInstanceConfig?.hostName?.trim() || instance.name;
  const quantityIndex = instance.singleInstanceConfig?.quantityIndex ?? 1;
  const suffix = `-${String(quantityIndex).padStart(2, '0')}`;

  return hostName.endsWith(suffix) ? hostName.slice(0, -suffix.length) : hostName;
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
        privateIp: normalizeStringArray(instance.VpcAttributes?.PrivateIpAddress?.IpAddress)[0] ?? null,
        publicIp: normalizeStringArray(instance.PublicIpAddress?.IpAddress)[0] ?? null,
        status: instance.Status?.trim() || null,
      },
    ];
  });
}

function orderDetailsByInstanceName(details: NormalizedInstanceDetail[], group: SingleInstanceExecutionItem[]) {
  const sortedDetails = details
    .slice()
    .sort((left, right) => left.instanceName.localeCompare(right.instanceName));
  const sortedItems = group.slice().sort(compareByQuantityIndex);

  return sortedItems.map((_, index) => sortedDetails[index] ?? null);
}

function resolveHostInstanceId(instance: RangeInstanceRecord) {
  const hostKey = instance.singleInstanceConfig?.hostKey ?? '';
  return hostKey ? instance.resourceSummary?.hostIds?.[hostKey] ?? null : null;
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

function readDestroyRetryIntervalMs() {
  const value = Number(process.env.SINGLE_INSTANCE_DESTROY_RETRY_INTERVAL_MS ?? DEFAULT_DESTROY_RETRY_INTERVAL_MS);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_DESTROY_RETRY_INTERVAL_MS;
}
