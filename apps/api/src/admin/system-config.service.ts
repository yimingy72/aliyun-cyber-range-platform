import { randomUUID } from 'node:crypto';

import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { getCurrentCloudWorkspaceScope, runInCloudWorkspace, runInSystemCloudWorkspaceScope } from '../auth/cloud-workspace-scope';

import { CloudAccountContextsService } from './cloud-account-contexts.service';
import { resolvePreferredInstanceTypes } from '../provisioning/instance-type-catalog';
import { PrismaService } from '../database/prisma.service';
import { signAliyunRpcQuery } from './image-catalog-rpc-signer';
import { requestTencentCloud, TencentCloudRequestError } from './tencent-cloud-client';

export type SystemCloudConfig = {
  provider: 'alibaba_cloud';
  defaultRegion: string;
  defaultZoneId: string;
  accessKeyId: string;
  accessKeySecret: string;
  imageImportBucket: string;
};

export type SystemCloudAccountContext = Omit<SystemCloudConfig, 'provider'> & {
  provider: 'alibaba_cloud' | 'tencent_cloud';
  cloudAccountContextId?: string | null;
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
    accessKeyId: snapshot.accessKeyId ? MASKED_SYSTEM_CLOUD_SECRET : '',
    accessKeySecret: snapshot.accessKeySecret ? MASKED_SYSTEM_CLOUD_SECRET : '',
  };
}

@Injectable()
export class SystemConfigService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cloudAccountContextsService: CloudAccountContextsService,
  ) {}

  async getSnapshot(): Promise<SystemCloudConfig> {
    const selected = await this.readSelectedContext();
    if (selected) {
      if (selected.provider !== 'alibaba_cloud') throw new BadRequestException('该云厂商的资源执行尚未开放。');
      return { ...selected, provider: 'alibaba_cloud' };
    }
    const activeContext = await this.prisma.cloudAccountContext.findFirst({
      where: { isActive: true, status: 'ready' },
      orderBy: { updatedAt: 'desc' },
    });

    if (activeContext) {
      const snapshot = this.toSnapshot({
        provider: activeContext.provider,
        defaultRegion: activeContext.regionId,
        defaultZoneId: activeContext.zoneId,
        accessKeyId: activeContext.accessKeyId,
        accessKeySecret: typeof activeContext.accessKeySecret === 'string' && activeContext.accessKeySecret.startsWith('cloud-credential:v1:')
          ? (await this.cloudAccountContextsService.getCredentials(activeContext.id)).accessKeySecret : activeContext.accessKeySecret,
        imageImportBucket: activeContext.imageImportBucket,
      });
      this.syncProcessEnv(snapshot);
      return snapshot;
    }

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
        ...this.toPersistedSnapshot(snapshot),
      },
      create: {
        id: SYSTEM_CLOUD_CONFIG_ROW_ID,
        ...this.toPersistedSnapshot(snapshot),
      },
    });
    this.syncProcessEnv(snapshot);

    return snapshot;
  }

  async updateSnapshot(payload: Partial<Omit<SystemCloudConfig, 'provider'>> & { provider?: SystemCloudAccountContext['provider'] }): Promise<SystemCloudConfig> {
    if (payload.provider !== undefined && payload.provider !== 'alibaba_cloud') {
      throw new BadRequestException('当前版本仅支持阿里云全局配置；腾讯云账号请通过独立云账号入口保存，暂不能启用为全局账号。');
    }
    const scope = getCurrentCloudWorkspaceScope();
    if (scope && !('system' in scope)) {
      if (!scope.isPlatformManager) throw new ForbiddenException('仅平台超管可更新云账号配置。');
      const current = await this.getAccountContext();
      const next = { provider: 'alibaba_cloud' as const,
        regionId: payload.defaultRegion !== undefined ? normalizeValue(payload.defaultRegion) : current.defaultRegion,
        zoneId: payload.defaultZoneId !== undefined ? normalizeValue(payload.defaultZoneId) : current.defaultZoneId,
        accessKeyId: payload.accessKeyId !== undefined ? normalizeValue(payload.accessKeyId) : current.accessKeyId,
        accessKeySecret: this.resolveSecretValue(payload.accessKeySecret, current.accessKeySecret),
        imageImportBucket: payload.imageImportBucket !== undefined ? normalizeValue(payload.imageImportBucket) : current.imageImportBucket,
        cloudWorkspaceId: scope.cloudWorkspaceId };
      const saved = await this.cloudAccountContextsService.saveAccountBinding(next);
      return { provider: 'alibaba_cloud', defaultRegion: saved.regionId, defaultZoneId: saved.zoneId,
        accessKeyId: next.accessKeyId, accessKeySecret: next.accessKeySecret, imageImportBucket: saved.imageImportBucket };
    }
    const current = await this.getSnapshot();
    const snapshot: SystemCloudConfig = {
      provider: 'alibaba_cloud',
      defaultRegion:
        payload.defaultRegion !== undefined ? normalizeValue(payload.defaultRegion) : current.defaultRegion,
      defaultZoneId:
        payload.defaultZoneId !== undefined ? normalizeValue(payload.defaultZoneId) : current.defaultZoneId,
      accessKeyId: payload.accessKeyId !== undefined ? normalizeValue(payload.accessKeyId) : current.accessKeyId,
      accessKeySecret: this.resolveSecretValue(payload.accessKeySecret, current.accessKeySecret),
      imageImportBucket:
        payload.imageImportBucket !== undefined ? normalizeValue(payload.imageImportBucket) : current.imageImportBucket,
    };

    const context = await this.cloudAccountContextsService.saveFromCloudConfig(snapshot);
    const nextSnapshot = { ...snapshot, imageImportBucket: context.imageImportBucket ?? snapshot.imageImportBucket };
    this.syncProcessEnv(nextSnapshot);

    return nextSnapshot;
  }

  async getAccountContext(): Promise<SystemCloudAccountContext & { provider: 'alibaba_cloud' }> {
    const selected = await this.readSelectedContext();
    if (selected) {
      if (selected.provider !== 'alibaba_cloud') throw new BadRequestException('该云厂商的资源执行尚未开放。');
      return { ...selected, provider: 'alibaba_cloud' };
    }
    const activeContext = await this.prisma.cloudAccountContext.findFirst({
      where: { isActive: true, status: 'ready' },
      orderBy: { updatedAt: 'desc' },
    });

    if (activeContext) {
      const snapshot = this.toSnapshot({
        provider: activeContext.provider,
        defaultRegion: activeContext.regionId,
        defaultZoneId: activeContext.zoneId,
        accessKeyId: activeContext.accessKeyId,
        accessKeySecret: typeof activeContext.accessKeySecret === 'string' && activeContext.accessKeySecret.startsWith('cloud-credential:v1:')
          ? (await this.cloudAccountContextsService.getCredentials(activeContext.id)).accessKeySecret : activeContext.accessKeySecret,
        imageImportBucket: activeContext.imageImportBucket,
      });
      return {
        ...snapshot,
        cloudAccountContextId: activeContext.id,
        accountUid: activeContext.accountUid,
        accountUidResolved: true,
      };
    }

    const snapshot = await this.getSnapshot();

    return {
      ...snapshot,
      cloudAccountContextId: null,
      accountUid: null,
      accountUidResolved: false,
    };
  }

  async getInstanceTypeAvailability(input: {
    cpu: number;
    memory: number;
  }): Promise<InstanceTypeAvailabilitySnapshot> {
    const accountContext = await this.getSelectedAccountContext();
    return this.getInstanceTypeAvailabilityInContext(input, accountContext);
  }

  async getInstanceTypeAvailabilityInContext(input: { cpu: number; memory: number }, accountContext: SystemCloudAccountContext): Promise<InstanceTypeAvailabilitySnapshot> {
    if (accountContext.provider === 'tencent_cloud') {
      return this.getTencentInstanceTypeAvailability(input, accountContext);
    }
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

  async getAccountContextById(id: string): Promise<SystemCloudAccountContext> {
    const context = await this.cloudAccountContextsService.getCredentials(id, { requireReady: true });
    return { provider: context.provider, cloudAccountContextId: context.id,
      accountUid: context.accountUid, accountUidResolved: true,
      defaultRegion: context.regionId, defaultZoneId: context.zoneId,
      accessKeyId: context.accessKeyId, accessKeySecret: context.accessKeySecret,
      imageImportBucket: context.imageImportBucket };
  }

  async getSelectedAccountContext(): Promise<SystemCloudAccountContext> {
    return await this.readSelectedContext() ?? this.getAccountContext();
  }

  async getExecutionAccountContext(options: { cloudAccountContextId?: string | null } = {}): Promise<SystemCloudAccountContext> {
    const scope = getCurrentCloudWorkspaceScope();
    if (scope && !('system' in scope) && scope.isReadOnly) {
      throw new BadRequestException('历史待核验空间不能执行云资源操作。');
    }
    const hasFrozenContext = Object.hasOwn(options, 'cloudAccountContextId');
    if (hasFrozenContext && (typeof options.cloudAccountContextId !== 'string'
      || !options.cloudAccountContextId.trim() || options.cloudAccountContextId.length > 192)) {
      throw new BadRequestException('执行任务缺少有效的冻结账号配置。');
    }
    const context = hasFrozenContext
      ? await this.getAccountContextById(options.cloudAccountContextId!.trim())
      : await this.getSelectedAccountContext();
    if (!context.cloudAccountContextId || !context.accountUidResolved || !context.accountUid
      || !context.defaultRegion || !context.defaultZoneId
      || !context.accessKeyId || !context.accessKeySecret) {
      throw new BadRequestException('云资源执行缺少已验证且冻结的云账号配置。');
    }
    if (scope && !('system' in scope)
      && (context.provider !== scope.provider || context.accountUid !== scope.accountUid)) {
      throw new BadRequestException('执行账号与原云厂商工作空间不一致。');
    }
    return { ...context };
  }

  async getDisplaySnapshot() {
    const snapshot = await this.getSelectedAccountContext();
    return { provider: snapshot.provider, defaultRegion: snapshot.defaultRegion, defaultZoneId: snapshot.defaultZoneId,
      accessKeyId: snapshot.accessKeyId ? '********' : '', accessKeySecret: snapshot.accessKeySecret ? '********' : '',
      imageImportBucket: snapshot.imageImportBucket };
  }

  async runInWorkspace<T>(id: string | null | undefined, work: () => Promise<T>): Promise<T> {
    if (!id) {
      if (process.env.NODE_ENV === 'test') return work();
      throw new BadRequestException('后台任务缺少冻结的云账号工作空间。');
    }
    const space = await runInSystemCloudWorkspaceScope(() => this.prisma.cloudWorkspace.findUnique({ where: { id } }));
    if (!space || !space.accountUid || space.isReadOnly) throw new BadRequestException('后台任务的云账号工作空间未核验，已保留原任务与资源记录。');
    return runInCloudWorkspace({ cloudWorkspaceId: space.id, provider: space.provider, accountUid: space.accountUid,
      isReadOnly: space.isReadOnly, actorUserId: 'system:worker' }, work);
  }

  async listExecutionCloudWorkspaces() {
    return runInSystemCloudWorkspaceScope(() => this.prisma.cloudWorkspace.findMany({
      where: { isReadOnly: false, provider: { in: ['alibaba_cloud', 'tencent_cloud'] }, accountUid: { not: null }, activeCloudAccountContextId: { not: null } },
      select: { id: true, provider: true, accountUid: true, isReadOnly: true }, orderBy: { id: 'asc' },
    }));
  }

  async listWorkspaceAccountContextIds() {
    const scope = getCurrentCloudWorkspaceScope();
    if (!scope || 'system' in scope || !scope.accountUid) throw new BadRequestException('资源核对缺少云账号工作空间。');
    return (await this.prisma.cloudAccountContext.findMany({
      where: { cloudWorkspaceId: scope.cloudWorkspaceId, provider: scope.provider, accountUid: scope.accountUid, status: 'ready' },
      select: { id: true }, orderBy: { id: 'asc' },
    })).map(context => context.id);
  }

  async runInAccountContext<T>(id: string, work: () => Promise<T>): Promise<T> {
    const scope = getCurrentCloudWorkspaceScope();
    if (!scope || 'system' in scope || scope.isReadOnly) throw new BadRequestException('资源核对缺少已验证云账号工作空间。');
    await this.getAccountContextById(id);
    return runInCloudWorkspace({ ...scope, cloudAccountContextId: id }, work);
  }

  private async readSelectedContext(): Promise<SystemCloudAccountContext | null> {
    const scope = getCurrentCloudWorkspaceScope();
    if (!scope || 'system' in scope) return null;
    const space = await this.prisma.cloudWorkspace.findUnique({ where: { id: scope.cloudWorkspaceId } });
    if (!space || space.provider !== scope.provider || space.accountUid !== scope.accountUid) {
      throw new BadRequestException('当前云账号工作空间已变化，请重新选择。');
    }
    const selectedContextId = scope.cloudAccountContextId ?? space.activeCloudAccountContextId;
    if (!selectedContextId) {
      if (space.isReadOnly && !space.accountUid) return { provider: space.provider, cloudAccountContextId: null,
        accountUid: null, accountUidResolved: false, defaultRegion: '', defaultZoneId: '', accessKeyId: '', accessKeySecret: '', imageImportBucket: '' };
      throw new BadRequestException('当前工作空间未绑定可用的云账号配置。');
    }
    const context = await this.getAccountContextById(selectedContextId);
    if (context.provider !== space.provider || context.accountUid !== space.accountUid) throw new BadRequestException('云账号配置与当前数据空间不匹配。');
    return context;
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
      imageImportBucket: '',
    };
  }

  private toSnapshot(config: {
    provider: string;
    defaultRegion: string;
    defaultZoneId: string;
    accessKeyId: string;
    accessKeySecret: string;
    imageImportBucket?: string;
  }): SystemCloudConfig {
    if (config.provider !== 'alibaba_cloud') {
      throw new BadRequestException('当前版本尚未开放腾讯云全局活跃配置，请保留阿里云全局账号并通过独立入口验证腾讯云。');
    }
    return {
      provider: 'alibaba_cloud',
      defaultRegion: normalizeValue(config.defaultRegion),
      defaultZoneId: normalizeValue(config.defaultZoneId),
      accessKeyId: normalizeValue(config.accessKeyId),
      accessKeySecret: normalizeValue(config.accessKeySecret),
      imageImportBucket: normalizeValue(config.imageImportBucket),
    };
  }

  private toPersistedSnapshot(snapshot: SystemCloudConfig) {
    return {
      provider: snapshot.provider,
      defaultRegion: snapshot.defaultRegion,
      defaultZoneId: snapshot.defaultZoneId,
      accessKeyId: snapshot.accessKeyId,
      accessKeySecret: snapshot.accessKeySecret,
    };
  }

  private syncProcessEnv(snapshot: SystemCloudConfig) {
    process.env.ALICLOUD_REGION = snapshot.defaultRegion;
    process.env.ALICLOUD_ZONE_ID = snapshot.defaultZoneId;
    process.env.ALICLOUD_ACCESS_KEY = snapshot.accessKeyId;
    process.env.ALICLOUD_SECRET_KEY = snapshot.accessKeySecret;
  }

  private async getTencentInstanceTypeAvailability(input: { cpu: number; memory: number }, context: SystemCloudAccountContext): Promise<InstanceTypeAvailabilitySnapshot> {
    if (!Number.isSafeInteger(input.cpu) || input.cpu <= 0 || !Number.isSafeInteger(input.memory) || input.memory <= 0) {
      throw new BadRequestException('cpu 和 memory 必须是大于 0 的整数');
    }
    let payload: { InstanceTypeQuotaSet?: unknown };
    try {
      payload = await requestTencentCloud({
        service: 'cvm', version: '2017-03-12', action: 'DescribeZoneInstanceConfigInfos',
        regionId: context.defaultRegion, accessKeyId: context.accessKeyId, accessKeySecret: context.accessKeySecret,
        parameters: { Filters: [
          { Name: 'zone', Values: [context.defaultZoneId] },
          { Name: 'instance-charge-type', Values: ['POSTPAID_BY_HOUR'] },
        ] },
      });
    } catch (error) {
      if (error instanceof TencentCloudRequestError) throw new BadRequestException(`腾讯云可售机型查询失败（${error.code}）。`);
      throw error;
    }
    if (!Array.isArray(payload.InstanceTypeQuotaSet)) {
      throw new BadRequestException('腾讯云可售机型响应无效，无法确认库存。');
    }
    const matches: InstanceTypeAvailabilityMatch[] = [];
    const seen = new Set<string>();
    for (const raw of payload.InstanceTypeQuotaSet) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new BadRequestException('腾讯云可售机型响应无效，无法确认库存。');
      const item = raw as { Zone?: unknown; InstanceType?: unknown; InstanceChargeType?: unknown; Status?: unknown; Cpu?: unknown; Memory?: unknown; InstanceFamily?: unknown; CpuType?: unknown };
      if (item.Zone !== context.defaultZoneId || item.InstanceChargeType !== 'POSTPAID_BY_HOUR'
        || item.Status !== 'SELL' || item.Cpu !== input.cpu || item.Memory !== input.memory) continue;
      if (typeof item.InstanceType !== 'string' || !/^[A-Za-z0-9]+\.[A-Za-z0-9]+$/.test(item.InstanceType)) {
        throw new BadRequestException('腾讯云可售机型响应缺少准确的实例规格。');
      }
      if (seen.has(item.InstanceType)) continue;
      seen.add(item.InstanceType);
      const processor = typeof item.CpuType === 'string' ? item.CpuType : '';
      matches.push({
        instanceTypeId: item.InstanceType, cpu: input.cpu, memoryGiB: input.memory,
        family: typeof item.InstanceFamily === 'string' ? item.InstanceFamily : '', generation: '',
        architecture: /\b(?:intel|amd|hygon)\b/i.test(processor) ? 'X86_64' : /\b(?:arm|ampere)\b/i.test(processor) ? 'ARM64' : 'UNKNOWN',
      });
    }
    return {
      cpu: input.cpu, memory: input.memory, regionId: context.defaultRegion, zoneId: context.defaultZoneId,
      exactAvailable: matches.length > 0, matches,
      warning: matches.length ? '腾讯云机型库存已核验；创建前会再次校验所选账号、镜像与规格。' : `当前腾讯云可用区 ${context.defaultZoneId} 没有可售的 ${input.cpu}C${input.memory}G 按量付费实例规格。`,
    };
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
