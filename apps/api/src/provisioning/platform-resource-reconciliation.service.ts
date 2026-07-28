import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import { ADMIN_REPOSITORY, type AdminRepository, type RangeInstanceRecord } from '../admin/admin.repository';
import { buildAliyunTagParameters, buildBillingTags } from '../admin/billing-tagging';
import { syncRangeInstanceBillingLedger } from '../admin/billing-ledger-sync';
import { signAliyunRpcQuery } from '../admin/image-catalog-rpc-signer';
import { SystemConfigService } from '../admin/system-config.service';

const ALICLOUD_ECS_API_VERSION = '2014-05-26';
const ALICLOUD_SIGNATURE_METHOD = 'HMAC-SHA1';
const ALICLOUD_SIGNATURE_VERSION = '1.0';
const ALICLOUD_PAGE_SIZE = 100;

export type AliyunEcsCredentials = {
  accessKeyId: string;
  accessKeySecret: string;
  regionId: string;
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
  BlockDeviceMappings?: {
    BlockDeviceMapping?: Array<{ DiskId?: string }> | { DiskId?: string };
  };
  Tags?: {
    Tag?: Array<{ TagKey?: string; TagValue?: string }> | { TagKey?: string; TagValue?: string };
  };
};

@Injectable()
export class AliyunEcsResourceClient {
  constructor(private readonly systemConfigService: SystemConfigService) {}

  async getDefaultCredentials(): Promise<AliyunEcsCredentials | null> {
    const config = await this.systemConfigService.getSnapshot();
    const accessKeyId = config.accessKeyId.trim();
    const accessKeySecret = config.accessKeySecret.trim();

    if (!accessKeyId || !accessKeySecret) {
      return null;
    }

    return {
      accessKeyId,
      accessKeySecret,
      regionId: config.defaultRegion,
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
    const response = await fetch(`https://ecs.${input.credentials.regionId}.aliyuncs.com/?${query}`);

    if (!response.ok) {
      throw new Error(`Aliyun ${input.action} request failed with status ${response.status}`);
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

      if (platformInstance.status === 'destroyed') {
        drifts += 1;
        await this.recordDrift({
          cloudInstance,
          rangeInstanceId,
          reason: 'Platform database marks the range instance as destroyed, but the tagged ECS still exists in Alibaba Cloud.',
          regionId: credentials.regionId,
          observedAt: now,
        });
        continue;
      }

      const hostKey = readTag(cloudInstance.tags, 'PlatformHostKey');

      if (!hostKey) {
        drifts += 1;
        await this.recordDrift({
          cloudInstance,
          rangeInstanceId,
          reason: 'Platform-managed ECS has no PlatformHostKey tag, so its host mapping cannot be restored safely.',
          regionId: credentials.regionId,
          observedAt: now,
        });
        continue;
      }

      const existingHostId = platformInstance.resourceSummary?.hostIds?.[hostKey] ?? null;

      if (existingHostId && existingHostId !== cloudInstance.instanceId) {
        drifts += 1;
        await this.recordDrift({
          cloudInstance,
          rangeInstanceId,
          reason: `Platform host ${hostKey} is recorded as ${existingHostId}, but Alibaba Cloud reports ${cloudInstance.instanceId}.`,
          regionId: credentials.regionId,
          observedAt: now,
        });
        continue;
      }

      const existingSystemDiskId = platformInstance.resourceSummary?.systemDiskIds?.[hostKey] ?? null;
      const needsSummaryRecovery = !existingHostId || (!existingSystemDiskId && cloudInstance.diskIds.length > 0);

      if (needsSummaryRecovery) {
        await this.restoreResourceSummary(platformInstance, hostKey, cloudInstance);
        recovered += 1;
      }

      try {
        await this.tagKnownInstanceDisks(credentials, platformInstance, hostKey, cloudInstance);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown disk tagging error';

        for (const diskId of cloudInstance.diskIds) {
          drifts += 1;
          await this.adminRepository.upsertCloudResourceDrift({
            regionId: credentials.regionId,
            cloudResourceType: 'disk',
            cloudResourceId: diskId,
            rangeInstanceId,
            severity: 'critical',
            reason: `Platform-managed ECS disk could not be tagged during reconciliation: ${message}`,
            tagsSnapshot: cloudInstance.tags,
            observedAt: now,
          });
        }
      }

      const reconciledInstance = needsSummaryRecovery
        ? await this.adminRepository.getRangeInstanceById(platformInstance.id)
        : platformInstance;
      if (reconciledInstance) {
        await syncRangeInstanceBillingLedger({
          repository: this.adminRepository,
          instance: reconciledInstance,
          regionId: credentials.regionId,
          resourceSummary: reconciledInstance.resourceSummary,
          billingStartAt: now,
        });
      }

      await this.adminRepository.resolveCloudResourceDrift({
        regionId: credentials.regionId,
        cloudResourceType: 'ecs',
        cloudResourceId: cloudInstance.instanceId,
        resolvedAt: now,
      });
    }

    return { recovered, drifts, skipped: false };
  }

  private async restoreResourceSummary(
    instance: RangeInstanceRecord,
    hostKey: string,
    cloudInstance: AliyunEcsInstanceResource,
  ) {
    const currentSummary = instance.resourceSummary;
    await this.adminRepository.updateRangeInstance(instance.id, {
      resourceSummary: {
        ...(currentSummary ?? {}),
        mode: currentSummary?.mode ?? (instance.instanceMode === 'single' ? 'ecs-native' : 'opentofu'),
        hostIds: {
          ...(currentSummary?.hostIds ?? {}),
          [hostKey]: cloudInstance.instanceId,
        },
        ...(cloudInstance.diskIds[0]
          ? {
              systemDiskIds: {
                ...(currentSummary?.systemDiskIds ?? {}),
                [hostKey]: cloudInstance.diskIds[0],
              },
            }
          : {}),
      },
      errorSummary: null,
    });
  }

  private async tagKnownInstanceDisks(
    credentials: AliyunEcsCredentials,
    instance: RangeInstanceRecord,
    hostKey: string,
    cloudInstance: AliyunEcsInstanceResource,
  ) {
    await this.aliyunEcsResourceClient.tagResources({
      credentials,
      resourceType: 'disk',
      resourceIds: cloudInstance.diskIds,
      tags: buildBillingTags({
        billingScope: instance.ownerUserId ? 'user' : 'platform',
        ownerUserId: instance.ownerUserId,
        rangeInstanceId: instance.id,
        singleInstanceBatchId: instance.singleInstanceBatchId ?? null,
        platformResourceType: 'disk',
        platformHostKey: hostKey,
        billingStartAt: instance.createdAt,
      }),
    });
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
        diskIds: normalizeDiskIds(instance.BlockDeviceMappings?.BlockDeviceMapping),
        tags: normalizeTags(instance.Tags?.Tag),
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
