import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { resolvePreferredInstanceTypes } from '../provisioning/instance-type-catalog';
import { PrismaService } from '../database/prisma.service';
import { signAliyunRpcQuery } from './image-catalog-rpc-signer';

export type SystemCloudConfig = {
  provider: 'alibaba_cloud';
  defaultRegion: string;
  defaultZoneId: string;
  accessKeyId: string;
  accessKeySecret: string;
};

export type SystemCloudAccountContext = SystemCloudConfig & {
  accountUid: string | null;
  accountUidResolved: boolean;
};

export type InstanceTypeAvailabilityMatch = {
  instanceTypeId: string;
  cpu: number;
  memoryGiB: number;
  family: string;
  generation: string;
  architecture: string;
};

export type InstanceTypeAvailabilitySnapshot = {
  cpu: number;
  memory: number;
  regionId: string;
  zoneId: string;
  exactAvailable: boolean;
  matches: InstanceTypeAvailabilityMatch[];
  warning: string | null;
};

export const MASKED_SYSTEM_CLOUD_SECRET = '********';

const SYSTEM_CLOUD_CONFIG_ROW_ID = 'default';
const ALICLOUD_ECS_API_VERSION = '2014-05-26';
const ALICLOUD_SIGNATURE_METHOD = 'HMAC-SHA1';
const ALICLOUD_SIGNATURE_VERSION = '1.0';
const ALICLOUD_PAGE_SIZE = 100;
const DEFAULT_SYSTEM_DISK_CATEGORY = 'cloud_essd';

type AliyunDescribeAvailableResourceResponse = {
  AvailableZones?: {
    AvailableZone?: AliyunAvailableZone[] | AliyunAvailableZone;
  };
};

type AliyunAvailableZone = {
  AvailableResources?: {
    AvailableResource?: AliyunAvailableResource[] | AliyunAvailableResource;
  };
};

type AliyunAvailableResource = {
  Type?: string;
  SupportedResources?: {
    SupportedResource?: AliyunSupportedResource[] | AliyunSupportedResource;
  };
};

type AliyunSupportedResource = {
  Status?: string;
  Value?: string;
};

type AliyunDescribeInstanceTypesResponse = {
  TotalCount?: number | string;
  PageNumber?: number | string;
  PageSize?: number | string;
  InstanceTypes?: {
    InstanceType?: AliyunInstanceType[] | AliyunInstanceType;
  };
};

type AliyunInstanceType = {
  InstanceTypeId?: string;
  CpuCoreCount?: number | string;
  MemorySize?: number | string;
  InstanceTypeFamily?: string;
  Generation?: string | number;
  CpuArchitecture?: string;
};

function normalizeValue(value: string | null | undefined) {
  return value?.trim() ?? '';
}

export function maskSystemCloudConfig(snapshot: SystemCloudConfig): SystemCloudConfig {
  return {
    ...snapshot,
    accessKeySecret: snapshot.accessKeySecret ? MASKED_SYSTEM_CLOUD_SECRET : '',
  };
}

@Injectable()
export class SystemConfigService {
  constructor(private readonly prisma: PrismaService) {}

  async getSnapshot(): Promise<SystemCloudConfig> {
    const existing = await this.prisma.systemCloudConfig.findUnique({
      where: { id: SYSTEM_CLOUD_CONFIG_ROW_ID },
    });

    if (existing) {
      const snapshot = this.toSnapshot(existing);
      this.syncProcessEnv(snapshot);
      return snapshot;
    }

    const snapshot = this.readEnvSnapshot();
    await this.prisma.systemCloudConfig.upsert({
      where: { id: SYSTEM_CLOUD_CONFIG_ROW_ID },
      update: {
        ...snapshot,
      },
      create: {
        id: SYSTEM_CLOUD_CONFIG_ROW_ID,
        ...snapshot,
      },
    });
    this.syncProcessEnv(snapshot);

    return snapshot;
  }

  async updateSnapshot(payload: Partial<SystemCloudConfig>): Promise<SystemCloudConfig> {
    const current = await this.getSnapshot();
    const snapshot: SystemCloudConfig = {
      provider: 'alibaba_cloud',
      defaultRegion:
        payload.defaultRegion !== undefined ? normalizeValue(payload.defaultRegion) : current.defaultRegion,
      defaultZoneId:
        payload.defaultZoneId !== undefined ? normalizeValue(payload.defaultZoneId) : current.defaultZoneId,
      accessKeyId: payload.accessKeyId !== undefined ? normalizeValue(payload.accessKeyId) : current.accessKeyId,
      accessKeySecret: this.resolveSecretValue(payload.accessKeySecret, current.accessKeySecret),
    };

    const saved = await this.prisma.systemCloudConfig.upsert({
      where: { id: SYSTEM_CLOUD_CONFIG_ROW_ID },
      update: {
        ...snapshot,
      },
      create: {
        id: SYSTEM_CLOUD_CONFIG_ROW_ID,
        ...snapshot,
      },
    });
    const nextSnapshot = this.toSnapshot(saved);
    this.syncProcessEnv(nextSnapshot);

    return nextSnapshot;
  }

  async getAccountContext(): Promise<SystemCloudAccountContext> {
    const snapshot = await this.getSnapshot();

    return {
      ...snapshot,
      accountUid: null,
      accountUidResolved: false,
    };
  }

  async getInstanceTypeAvailability(input: {
    cpu: number;
    memory: number;
  }): Promise<InstanceTypeAvailabilitySnapshot> {
    const accountContext = await this.getAccountContext();
    const supportedInstanceTypeIds = new Set(resolvePreferredInstanceTypes(input.cpu, input.memory));

    if (supportedInstanceTypeIds.size === 0) {
      return {
        cpu: input.cpu,
        memory: input.memory,
        regionId: accountContext.defaultRegion,
        zoneId: accountContext.defaultZoneId,
        exactAvailable: false,
        matches: [],
        warning: `平台单实例执行器不支持 ${input.cpu}C${input.memory}G 规格。`,
      };
    }

    const availableInstanceTypeIds = await this.describeAvailableInstanceTypeIds(accountContext);

    if (availableInstanceTypeIds.length === 0) {
      return {
        cpu: input.cpu,
        memory: input.memory,
        regionId: accountContext.defaultRegion,
        zoneId: accountContext.defaultZoneId,
        exactAvailable: false,
        matches: [],
        warning: `当前默认可用区 ${accountContext.defaultZoneId} 没有可售的 X86 按量付费实例规格。`,
      };
    }

    const instanceTypes = await this.describeInstanceTypes(accountContext);
    const matches = instanceTypes.filter((item) => {
      if (!availableInstanceTypeIds.includes(item.instanceTypeId)) {
        return false;
      }

      if (!isX86Architecture(item.architecture)) {
        return false;
      }

      return (
        supportedInstanceTypeIds.has(item.instanceTypeId) &&
        item.cpu === input.cpu &&
        item.memoryGiB === input.memory
      );
    });

    return {
      cpu: input.cpu,
      memory: input.memory,
      regionId: accountContext.defaultRegion,
      zoneId: accountContext.defaultZoneId,
      exactAvailable: matches.length > 0,
      matches,
      warning:
        matches.length > 0
          ? null
          : `当前默认可用区 ${accountContext.defaultZoneId} 没有可供单实例执行器使用的 ${input.cpu}C${input.memory}G X86 按量付费实例规格。`,
    };
  }

  private resolveSecretValue(nextValue: string | null | undefined, currentValue: string) {
    const normalized = normalizeValue(nextValue);

    if (!normalized || normalized === MASKED_SYSTEM_CLOUD_SECRET) {
      return currentValue;
    }

    return normalized;
  }

  private readEnvSnapshot(): SystemCloudConfig {
    return {
      provider: 'alibaba_cloud',
      defaultRegion: normalizeValue(process.env.ALICLOUD_REGION),
      defaultZoneId: normalizeValue(process.env.ALICLOUD_ZONE_ID),
      accessKeyId: normalizeValue(process.env.ALICLOUD_ACCESS_KEY),
      accessKeySecret: normalizeValue(process.env.ALICLOUD_SECRET_KEY),
    };
  }

  private toSnapshot(config: {
    provider: string;
    defaultRegion: string;
    defaultZoneId: string;
    accessKeyId: string;
    accessKeySecret: string;
  }): SystemCloudConfig {
    return {
      provider: 'alibaba_cloud',
      defaultRegion: normalizeValue(config.defaultRegion),
      defaultZoneId: normalizeValue(config.defaultZoneId),
      accessKeyId: normalizeValue(config.accessKeyId),
      accessKeySecret: normalizeValue(config.accessKeySecret),
    };
  }

  private syncProcessEnv(snapshot: SystemCloudConfig) {
    process.env.ALICLOUD_REGION = snapshot.defaultRegion;
    process.env.ALICLOUD_ZONE_ID = snapshot.defaultZoneId;
    process.env.ALICLOUD_ACCESS_KEY = snapshot.accessKeyId;
    process.env.ALICLOUD_SECRET_KEY = snapshot.accessKeySecret;
  }

  private async describeAvailableInstanceTypeIds(
    accountContext: SystemCloudAccountContext,
  ): Promise<string[]> {
    const payload = await this.performAliyunRpcRequest<AliyunDescribeAvailableResourceResponse>({
      accessKeyId: accountContext.accessKeyId,
      accessKeySecret: accountContext.accessKeySecret,
      regionId: accountContext.defaultRegion,
      action: 'DescribeAvailableResource',
      parameters: {
        ZoneId: accountContext.defaultZoneId,
        DestinationResource: 'InstanceType',
        ResourceType: 'instance',
        InstanceChargeType: 'PostPaid',
        IoOptimized: 'optimized',
        NetworkCategory: 'vpc',
        SystemDiskCategory: process.env.OPENTOFU_SYSTEM_DISK_CATEGORY || DEFAULT_SYSTEM_DISK_CATEGORY,
      },
    });

    const availableZones = normalizeArray(payload.AvailableZones?.AvailableZone);

    return [
      ...new Set(
        availableZones.flatMap((zone) =>
          normalizeArray(zone.AvailableResources?.AvailableResource)
            .filter((resource) => resource.Type === 'InstanceType')
            .flatMap((resource) => normalizeArray(resource.SupportedResources?.SupportedResource))
            .filter((resource) => resource.Status === 'Available' && typeof resource.Value === 'string')
            .map((resource) => resource.Value!.trim())
            .filter(Boolean),
        ),
      ),
    ];
  }

  private async describeInstanceTypes(
    accountContext: SystemCloudAccountContext,
  ): Promise<InstanceTypeAvailabilityMatch[]> {
    const items: InstanceTypeAvailabilityMatch[] = [];
    let pageNumber = 1;
    let totalCount = 0;

    do {
      const payload = await this.performAliyunRpcRequest<AliyunDescribeInstanceTypesResponse>({
        accessKeyId: accountContext.accessKeyId,
        accessKeySecret: accountContext.accessKeySecret,
        regionId: accountContext.defaultRegion,
        action: 'DescribeInstanceTypes',
        parameters: {
          PageNumber: String(pageNumber),
          PageSize: String(ALICLOUD_PAGE_SIZE),
        },
      });
      const instanceTypes = normalizeArray(payload.InstanceTypes?.InstanceType);

      items.push(
        ...instanceTypes
          .map((item) => {
            const instanceTypeId = normalizeValue(item.InstanceTypeId);
            const cpu = toNumber(item.CpuCoreCount);
            const memoryGiB = toNumber(item.MemorySize);

            if (!instanceTypeId || !cpu || !memoryGiB) {
              return null;
            }

            return {
              instanceTypeId,
              cpu,
              memoryGiB,
              family: normalizeValue(item.InstanceTypeFamily),
              generation: typeof item.Generation === 'string' ? item.Generation.trim() : String(item.Generation ?? ''),
              architecture: normalizeValue(item.CpuArchitecture).toUpperCase(),
            } satisfies InstanceTypeAvailabilityMatch;
          })
          .filter((item): item is InstanceTypeAvailabilityMatch => item !== null),
      );

      totalCount = toNumber(payload.TotalCount);
      pageNumber += 1;
    } while ((pageNumber - 1) * ALICLOUD_PAGE_SIZE < totalCount);

    return items;
  }

  private async performAliyunRpcRequest<ResponsePayload>(input: {
    accessKeyId: string;
    accessKeySecret: string;
    regionId: string;
    action: string;
    parameters?: Record<string, string>;
  }): Promise<ResponsePayload> {
    const endpoint = `https://ecs.${input.regionId}.aliyuncs.com/`;
    const query = signAliyunRpcQuery(
      {
        Action: input.action,
        AccessKeyId: input.accessKeyId,
        Format: 'JSON',
        RegionId: input.regionId,
        SignatureMethod: ALICLOUD_SIGNATURE_METHOD,
        SignatureNonce: randomUUID(),
        SignatureVersion: ALICLOUD_SIGNATURE_VERSION,
        Timestamp: formatAliyunTimestamp(new Date()),
        Version: ALICLOUD_ECS_API_VERSION,
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
        payload &&
        typeof payload === 'object' &&
        'Code' in payload &&
        typeof (payload as { Code?: unknown }).Code === 'string'
          ? (payload as { Code: string }).Code
          : `HTTP_${response.status}`;
      const errorMessage =
        payload &&
        typeof payload === 'object' &&
        'Message' in payload &&
        typeof (payload as { Message?: unknown }).Message === 'string'
          ? (payload as { Message: string }).Message
          : `Aliyun RPC request failed with status ${response.status}`;

      throw new Error(`${input.action} failed: ${errorCode} - ${errorMessage}`);
    }

    return payload as ResponsePayload;
  }
}

function normalizeArray<T>(value: T | T[] | null | undefined) {
  if (!value) {
    return [] as T[];
  }

  return Array.isArray(value) ? value : [value];
}

function toNumber(value: number | string | undefined) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}

function formatAliyunTimestamp(value: Date) {
  return value.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function isX86Architecture(value: string) {
  return value.toUpperCase().includes('X86');
}
