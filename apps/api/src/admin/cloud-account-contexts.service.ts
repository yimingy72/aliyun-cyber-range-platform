import { createHash, createHmac, randomUUID } from 'node:crypto';

import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../database/prisma.service';
import type { Prisma } from '@aliyun-cyber-range/database/generated/client';
import { FAILED_CREATE_CLEANUP_PROOF_STEP, FAILED_CREATE_SWITCH_PROOF_STEP, readFailedCreateCleanupProof, type FailedCreateCleanupProof } from './failed-create-cleanup-evidence';
import { signAliyunRpcQuery } from './image-catalog-rpc-signer';
import type { SaveCloudAccountContextDto } from './dto/cloud-account-context.dto';
import { decryptCloudCredential, encryptCloudCredential, readCloudCredentialEncryptionKey } from './cloud-credential-encryption';
import { requestTencentCloud, TencentCloudRequestError } from './tencent-cloud-client';
import { getCurrentCloudWorkspaceScope, runInSystemCloudWorkspaceScope } from '../auth/cloud-workspace-scope';

const ALICLOUD_SIGNATURE_METHOD = 'HMAC-SHA1';
const ALICLOUD_SIGNATURE_VERSION = '1.0';
const ALICLOUD_STS_API_VERSION = '2015-04-01';

export type CloudAccountContextCredentials = {
  id: string;
  provider: 'alibaba_cloud' | 'tencent_cloud';
  accountUid: string;
  regionId: string;
  zoneId: string;
  accessKeyId: string;
  accessKeySecret: string;
  imageImportBucket: string;
  status: 'provisioning' | 'ready' | 'degraded' | 'disabled';
  cloudWorkspaceId?: string;
};

export type CloudAccountContextView = Omit<CloudAccountContextCredentials, 'accessKeyId' | 'accessKeySecret'> & {
  displayName: string;
  isActive: boolean;
  bucketStatus: string;
  lastError: string | null;
  lastVerifiedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type SaveCloudConfigInput = {
  provider?: 'alibaba_cloud' | 'tencent_cloud';
  defaultRegion: string;
  defaultZoneId: string;
  accessKeyId: string;
  accessKeySecret: string;
  imageImportBucket?: string;
};

@Injectable()
export class CloudAccountContextsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(options: { includeInactive?: boolean } = {}): Promise<CloudAccountContextView[]> {
    const scope = getCurrentCloudWorkspaceScope();
    const contexts = await this.prisma.cloudAccountContext.findMany({
      where: scope && !('system' in scope)
        ? { cloudWorkspaceId: scope.cloudWorkspaceId, ...(options.includeInactive ? {} : { status: 'ready' as const }) }
        : options.includeInactive ? undefined : { isActive: true, status: 'ready' },
      orderBy: [{ updatedAt: 'desc' }],
    });

    return contexts.map((context) => this.toView(context));
  }

  async getCredentials(
    id: string,
    options: { requireReady?: boolean; requireActive?: boolean; requireImageImportBucket?: boolean } = {},
  ): Promise<CloudAccountContextCredentials> {
    const context = await this.prisma.cloudAccountContext.findUnique({ where: { id } });

    if (!context) {
      throw new NotFoundException('Cloud account context not found');
    }

    const scope = getCurrentCloudWorkspaceScope();
    if (scope && !('system' in scope) && (context.cloudWorkspaceId !== scope.cloudWorkspaceId
      || context.provider !== scope.provider || context.accountUid !== scope.accountUid)) {
      throw new NotFoundException('Cloud account context not found in the selected workspace');
    }

    if (options.requireReady && context.status !== 'ready') {
      throw new BadRequestException(`当前${context.provider === 'tencent_cloud' ? '腾讯云' : '阿里云'}账号不可用，请先在云配置中修复。`);
    }

    const selectedActive = scope && !('system' in scope)
      ? (await this.prisma.cloudWorkspace.findUnique({ where: { id: scope.cloudWorkspaceId } }))?.activeCloudAccountContextId === context.id
      : context.isActive;
    if (options.requireActive && (!selectedActive || context.status !== 'ready')) {
      throw new BadRequestException('请选择当前已启用且可用的云账号。');
    }

    if (options.requireImageImportBucket) {
      if (context.provider === 'tencent_cloud') {
        throw new BadRequestException('当前版本暂未支持腾讯云镜像导入。');
      }
      if (!context.imageImportBucket.trim() || context.bucketStatus === 'unconfigured') {
        throw new BadRequestException('当前阿里云账号未配置镜像导入 Bucket，请先在云配置中填写自定义 OSS 存储桶名。');
      }

      if (context.bucketStatus !== 'ready') {
        throw new BadRequestException('配置的镜像导入 Bucket 不可用，请检查名称、地域和权限。');
      }
    }

    return {
      id: context.id,
      provider: context.provider,
      accountUid: context.accountUid,
      regionId: context.regionId,
      zoneId: context.zoneId,
      accessKeyId: context.accessKeyId,
      accessKeySecret: context.provider === 'tencent_cloud' ? decryptCloudCredential(context.accessKeySecret, { ...context, provider: 'tencent_cloud' }) : context.accessKeySecret,
      imageImportBucket: context.imageImportBucket,
      status: context.status,
      ...(context.cloudWorkspaceId ? { cloudWorkspaceId: context.cloudWorkspaceId } : {}),
    };
  }

  async saveTencentCloudContext(input: SaveCloudAccountContextDto): Promise<CloudAccountContextView> {
    if (!input || input.provider !== 'tencent_cloud') {
      throw new BadRequestException('新增云账号接口仅接受腾讯云账号；阿里云配置请使用现有云配置入口。');
    }
    const normalized = {
      regionId: typeof input.regionId === 'string' ? input.regionId.trim() : '',
      zoneId: typeof input.zoneId === 'string' ? input.zoneId.trim() : '',
      accessKeyId: typeof input.accessKeyId === 'string' ? input.accessKeyId.trim() : '',
      accessKeySecret: typeof input.accessKeySecret === 'string' ? input.accessKeySecret.trim() : '',
    };
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/.test(normalized.regionId)
      || !normalized.zoneId.startsWith(`${normalized.regionId}-`)
      || !/^[1-9]\d*$/.test(normalized.zoneId.slice(normalized.regionId.length + 1))) {
      throw new BadRequestException('腾讯云可用区必须属于所填写的地域，请同时填写地域和可用区。');
    }
    if (!normalized.accessKeyId || !normalized.accessKeySecret
      || normalized.accessKeyId === '********' || normalized.accessKeySecret === '********'
      || normalized.accessKeyId.length > 128 || normalized.accessKeySecret.length > 128
      || /\s/.test(normalized.accessKeyId) || /\s/.test(normalized.accessKeySecret)) {
      throw new BadRequestException('请显式填写有效的腾讯云 SecretId 和 SecretKey，不支持沿用其它云账号凭据。');
    }
    // Validate encryption before any cloud request or persistence.
    const encryptionKey = readCloudCredentialEncryptionKey();
    let accountUid: string;
    try {
      const identity = await requestTencentCloud<{ AccountId?: unknown }>({
        service: 'sts', version: '2018-08-13', action: 'GetCallerIdentity',
        accessKeyId: normalized.accessKeyId, accessKeySecret: normalized.accessKeySecret,
      });
      if (typeof identity.AccountId !== 'string' || !/^[1-9]\d{0,19}$/.test(identity.AccountId)) {
        throw new BadRequestException('腾讯云身份校验未返回有效的主账号 AccountId。');
      }
      accountUid = identity.AccountId;
      const zones = await requestTencentCloud<{ TotalCount?: unknown; ZoneSet?: unknown }>({
        service: 'cvm', version: '2017-03-12', action: 'DescribeZones',
        regionId: normalized.regionId, accessKeyId: normalized.accessKeyId, accessKeySecret: normalized.accessKeySecret,
      });
      if (!Number.isSafeInteger(zones.TotalCount) || !Array.isArray(zones.ZoneSet)
        || zones.TotalCount !== zones.ZoneSet.length
        || zones.ZoneSet.filter((item) => item && typeof item === 'object'
          && item.Zone === normalized.zoneId && item.ZoneState === 'AVAILABLE').length !== 1) {
        throw new BadRequestException('腾讯云可用区未通过云端校验，请检查地域、可用区和 CVM 查询权限。');
      }
    } catch (error) {
      if (error instanceof TencentCloudRequestError) {
        throw new BadRequestException(`腾讯云账号只读校验失败（${error.code}），请检查凭据、查询权限和网络。`);
      }
      throw error;
    }
    const cloudWorkspace = await this.resolveBindingWorkspace('tencent_cloud', accountUid, input);
    const data = {
      provider: 'tencent_cloud' as const, accountUid, regionId: normalized.regionId,
      cloudWorkspaceId: cloudWorkspace.id,
      zoneId: normalized.zoneId, accessKeyId: normalized.accessKeyId,
      accessKeySecret: encryptCloudCredential(normalized.accessKeySecret, { provider: 'tencent_cloud', accountUid, regionId: normalized.regionId, accessKeyId: normalized.accessKeyId }, encryptionKey),
      displayName: `腾讯云 ${accountUid} · ${normalized.regionId}`,
      isActive: false, status: 'ready' as const, imageImportBucket: '',
      bucketStatus: 'unconfigured', lastError: null, lastVerifiedAt: new Date(),
    };
    const context = await this.prisma.cloudAccountContext.upsert({
      where: { provider_accountUid_regionId: { provider: 'tencent_cloud', accountUid, regionId: normalized.regionId } },
      create: data, update: data,
    });
    await this.setWorkspaceDefaultContext(cloudWorkspace.id, context.id, input.cloudWorkspaceId !== undefined);
    return this.toView(context);
  }

  async saveAccountBinding(input: SaveCloudAccountContextDto): Promise<CloudAccountContextView> {
    return runInSystemCloudWorkspaceScope(async () => {
      if (input.provider === 'tencent_cloud') return this.saveTencentCloudContext(input);
      if (input.provider !== 'alibaba_cloud') throw new BadRequestException('不支持该云厂商。');
      const values = { regionId: input.regionId.trim(), zoneId: input.zoneId.trim(), accessKeyId: input.accessKeyId.trim(), accessKeySecret: input.accessKeySecret.trim() };
      if (!values.accessKeyId || !values.accessKeySecret || values.accessKeyId === '********' || values.accessKeySecret === '********'
        || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/.test(values.regionId)
        || !values.zoneId.startsWith(values.regionId) || !/^-?[a-z][a-z0-9]*$/.test(values.zoneId.slice(values.regionId.length))) {
        throw new BadRequestException('请填写有效的阿里云地域、可用区和两个访问凭据。');
      }
      const accountUid = await this.resolveAccountUid(values.accessKeyId, values.accessKeySecret);
      const space = await this.resolveBindingWorkspace('alibaba_cloud', accountUid, input);
      const existing = await this.prisma.cloudAccountContext.findUnique({ where: { provider_accountUid_regionId: { provider: 'alibaba_cloud', accountUid, regionId: values.regionId } } });
      const imageImportBucket = input.imageImportBucket?.trim() ?? existing?.imageImportBucket ?? '';
      this.assertImageImportBucketName(imageImportBucket);
      await this.assertImageImportBucketCanChange(existing, imageImportBucket);
      const bucketVerification = await this.verifyImageImportBucket({ bucket: imageImportBucket, ...values });
      const data = { ...values, provider: 'alibaba_cloud' as const, accountUid, cloudWorkspaceId: space.id,
        displayName: `阿里云 ${accountUid} · ${values.regionId}`, imageImportBucket, status: 'ready' as const,
        lastError: null, lastVerifiedAt: new Date(), ...bucketVerification };
      const context = await this.prisma.cloudAccountContext.upsert({
        where: { provider_accountUid_regionId: { provider: 'alibaba_cloud', accountUid, regionId: values.regionId } },
        update: data, create: { ...data, isActive: false },
      });
      await this.setWorkspaceDefaultContext(space.id, context.id, input.cloudWorkspaceId !== undefined);
      return this.toView(context);
    });
  }

  private async resolveBindingWorkspace(provider: 'alibaba_cloud' | 'tencent_cloud', accountUid: string, input: SaveCloudAccountContextDto) {
    if (input.cloudWorkspaceId) {
      const target = await this.prisma.cloudWorkspace.findUnique({ where: { id: input.cloudWorkspaceId } });
      if (!target || target.isReadOnly || target.provider !== provider || target.accountUid !== accountUid) {
        throw new ConflictException('输入的云凭据不属于正在编辑的账号，原工作空间和配置未更改。');
      }
    }
    return this.prisma.cloudWorkspace.upsert({
      where: { provider_accountUid: { provider, accountUid } },
      create: { provider, accountUid, displayName: input.displayName?.trim() || `${provider === 'alibaba_cloud' ? '阿里云' : '腾讯云'} ${accountUid}` },
      update: input.displayName ? { displayName: input.displayName.trim() } : {},
    });
  }

  private async setWorkspaceDefaultContext(cloudWorkspaceId: string, contextId: string, editing: boolean) {
    const workspace = await this.prisma.cloudWorkspace.findUniqueOrThrow({ where: { id: cloudWorkspaceId } });
    if (!workspace.activeCloudAccountContextId || editing) {
      await this.prisma.cloudWorkspace.update({ where: { id: cloudWorkspaceId }, data: { activeCloudAccountContextId: contextId } });
    }
  }

  async saveFromCloudConfig(input: SaveCloudConfigInput): Promise<CloudAccountContextView> {
    if (input.provider !== undefined && input.provider !== 'alibaba_cloud') {
      throw new BadRequestException('腾讯云账号请通过独立云账号入口保存，不能写入阿里云全局配置。');
    }
    const requestedImageImportBucket = input.imageImportBucket?.trim();
    const normalized = {
      regionId: input.defaultRegion.trim(),
      zoneId: input.defaultZoneId.trim(),
      accessKeyId: input.accessKeyId.trim(),
      accessKeySecret: input.accessKeySecret.trim(),
    };

    if (!normalized.regionId || !normalized.zoneId || !normalized.accessKeyId || !normalized.accessKeySecret) {
      throw new BadRequestException('保存云配置前，请填写地域、可用区和阿里云访问凭据。');
    }
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/.test(normalized.regionId)
      || !normalized.zoneId.startsWith(normalized.regionId)
      || !/^-?[a-z][a-z0-9]*$/.test(normalized.zoneId.slice(normalized.regionId.length))) {
      throw new BadRequestException('默认可用区必须属于默认地域；修改地域时请同时指定匹配的可用区。');
    }

    this.assertImageImportBucketName(requestedImageImportBucket ?? '');

    const accountUid = await this.resolveAccountUid(normalized.accessKeyId, normalized.accessKeySecret);
    const existing = await this.prisma.cloudAccountContext.findUnique({
      where: {
        provider_accountUid_regionId: {
          provider: 'alibaba_cloud',
          accountUid,
          regionId: normalized.regionId,
        },
      },
    });
    const displayName = `阿里云 ${accountUid} · ${normalized.regionId}`;
    const imageImportBucket = requestedImageImportBucket ?? existing?.imageImportBucket.trim() ?? '';

    this.assertImageImportBucketName(imageImportBucket);
    await this.assertImageImportBucketCanChange(existing, imageImportBucket);
    const bucketVerification = await this.verifyImageImportBucket({
      bucket: imageImportBucket,
      regionId: normalized.regionId,
      accessKeyId: normalized.accessKeyId,
      accessKeySecret: normalized.accessKeySecret,
    });
    return this.commitCloudConfig({
      existing,
      data: {
        displayName,
        provider: 'alibaba_cloud',
        accountUid,
        ...normalized,
        imageImportBucket,
        status: 'ready',
        ...bucketVerification,
      },
    });
  }

  async activate(id: string): Promise<CloudAccountContextView> {
    const context = await this.prisma.cloudAccountContext.findUnique({ where: { id } });
    if (!context) {
      throw new NotFoundException('Cloud account context not found');
    }
    if (context.provider !== 'alibaba_cloud') {
      throw new BadRequestException('当前版本仅支持将阿里云账号设为全局活跃账号；腾讯云账号可保存并进行只读验证。');
    }
    if (context.status !== 'ready') {
      throw new BadRequestException('当前阿里云账号不可用，无法切换。');
    }
    return this.commitCloudConfig({ existing: context, data: context });
  }

  private async readSwitchState(db: Prisma.TransactionClient | PrismaService) {
    const [activeContexts, instances, activeJobCount, knownContexts] = await Promise.all([
      db.cloudAccountContext.findMany({ where: { isActive: true }, orderBy: { id: 'asc' } }),
      db.rangeInstance.findMany({
        where: { status: { not: 'destroyed' } },
        include: { lastJob: { include: { stepLogs: { orderBy: { id: 'asc' } } } }, jobs: { select: { id: true }, orderBy: { id: 'asc' } } },
        orderBy: { id: 'asc' },
      }),
      db.provisionJob.count({ where: { status: { in: ['pending', 'running'] } } }),
      db.cloudAccountContext.findMany({ orderBy: { id: 'asc' } }),
    ]);
    if (activeContexts.length > 1) {
      throw new ConflictException('当前云配置存在多个启用账号，请先修复配置状态后再切换。');
    }
    return { activeContexts, instances, activeJobCount, knownContexts };
  }

  private async verifySwitch(
    state: Awaited<ReturnType<CloudAccountContextsService['readSwitchState']>>,
    target: { accountUid: string; regionId: string; accessKeyId: string; accessKeySecret: string },
  ) {
    if (state.activeJobCount > 0) {
      this.throwActiveResourcesConflict();
    }
    const active = state.activeContexts[0];
    const proofs: FailedCreateCleanupProof[] = [];
    for (const instance of state.instances) {
      if (instance.status === 'draft' && instance.jobs.length === 0
        && instance.accessEntry === null && instance.resourceSummary === null) {
        continue;
      }
      const job = instance.lastJob;
      if (instance.status !== 'create_failed' || instance.accessEntry !== null || instance.resourceSummary !== null
        || !job || job.status !== 'failed' || !job.startedAt || job.rangeInstanceId !== instance.id
        || !['create', 'retry'].includes(job.jobType)) {
        this.throwActiveResourcesConflict();
      }
      const sourceRegion = instance.instanceMode === 'single' ? this.readPersistedSourceRegion(instance) : null;
      const singleConfig = instance.singleInstanceConfig;
      if (instance.instanceMode === 'single' && (!singleConfig || typeof singleConfig !== 'object' || Array.isArray(singleConfig)
        || typeof singleConfig.assignedVswitchId !== 'string' || !singleConfig.assignedVswitchId.trim())) {
        throw new ConflictException('失败单实例缺少持久指定交换机，无法确认来源，云配置未切换。');
      }
      const trustedProof = job.stepLogs.some((step) => {
        if (step.status !== 'succeeded' || !step.finishedAt
          || ![FAILED_CREATE_CLEANUP_PROOF_STEP, FAILED_CREATE_SWITCH_PROOF_STEP].includes(step.stepName)) {
          return false;
        }
        const proof = readFailedCreateCleanupProof(step.message);
        return proof?.rangeInstanceId === instance.id && proof.provisionJobId === job.id
          && proof.claimStartedAt === job.startedAt!.toISOString()
          && step.finishedAt >= job.startedAt!
          && (sourceRegion === null || proof.regionId === sourceRegion)
          && state.knownContexts.some((context) => context.provider === 'alibaba_cloud' && context.id === proof.cloudAccountContextId
            && context.accountUid === proof.cloudAccountUid && context.regionId === proof.regionId
            && context.createdAt <= job.startedAt!);
      });
      if (trustedProof) {
        continue;
      }
      // ECS absence cannot prove that an unknown OpenTofu range has no VPC/NAT/EIP resources.
      if (instance.instanceMode !== 'single') {
        this.throwActiveResourcesConflict();
      }
      const sources = state.knownContexts.filter((context) => context.provider === 'alibaba_cloud' && context.regionId === sourceRegion);
      if (sources.length !== 1) {
        throw new ConflictException('失败实例的来源账号缺失或存在歧义，云配置未切换。');
      }
      const source = sources[0];
      if (source.createdAt > job.startedAt) {
        throw new ConflictException('失败实例执行时的来源账号历史无法确认，云配置未切换。');
      }
      await this.assertNoTaggedInstances({
        rangeInstanceId: instance.id,
        regionId: source.regionId,
        accessKeyId: source.accountUid === target.accountUid ? target.accessKeyId : source.accessKeyId,
        accessKeySecret: source.accountUid === target.accountUid ? target.accessKeySecret : source.accessKeySecret,
      });
      proofs.push({
        version: 1,
        rangeInstanceId: instance.id,
        provisionJobId: job.id,
        claimStartedAt: job.startedAt.toISOString(),
        cloudAccountContextId: source.id,
        cloudAccountUid: source.accountUid,
        regionId: source.regionId,
      });
    }
    if (active && await this.prisma.billingLedgerResource.count({
      where: { cloudAccountUid: active.accountUid, releasedAt: null },
    }) > 0) {
      throw new ConflictException('当前阿里云账号仍有未释放的计费资源。请先删除相关镜像、快照或实例并完成台账关闭后再切换账号。');
    }
    return proofs;
  }

  private readPersistedSourceRegion(instance: { runtimeScenarioTemplateSpec: Prisma.JsonValue; runtimeCompiledProvisionSpec: Prisma.JsonValue }) {
    const readRegion = (snapshot: Prisma.JsonValue) => {
      if (snapshot === null) {
        return null;
      }
      if (typeof snapshot !== 'object' || Array.isArray(snapshot)) {
        throw new ConflictException('失败实例的持久来源快照无效，云配置未切换。');
      }
      const topology = snapshot.topology;
      if (topology === undefined) {
        return null;
      }
      if (!topology || typeof topology !== 'object' || Array.isArray(topology)) {
        throw new ConflictException('失败实例的持久来源快照无效，云配置未切换。');
      }
      if (!Object.hasOwn(topology, 'defaultRegion')) {
        return null;
      }
      const region = topology.defaultRegion;
      if (typeof region !== 'string' || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/.test(region.trim())) {
        throw new ConflictException('失败实例的持久来源地域无效，云配置未切换。');
      }
      return region.trim();
    };
    const regions = [readRegion(instance.runtimeScenarioTemplateSpec), readRegion(instance.runtimeCompiledProvisionSpec)].filter((region): region is string => region !== null);
    if (regions.length === 0 || new Set(regions).size !== 1) {
      throw new ConflictException('失败实例缺少一致的持久来源地域，云配置未切换。');
    }
    return regions[0];
  }

  private throwActiveResourcesConflict(): never {
    throw new ConflictException('当前仍存在未销毁实例、未经确认清理的失败实例或执行中的资源任务。请先完成销毁并等待任务结束后再切换账号。');
  }

  private fingerprint(value: unknown) {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
  }

  private async commitCloudConfig(input: {
    existing: Prisma.CloudAccountContextGetPayload<Record<string, never>> | null;
    data: Omit<Prisma.CloudAccountContextCreateInput, 'isActive'> & { accountUid: string; regionId: string; zoneId: string; accessKeyId: string; accessKeySecret: string; imageImportBucket: string };
  }) {
    const state = await this.readSwitchState(this.prisma);
    const switching = !input.existing?.isActive;
    const proofs = switching ? await this.verifySwitch(state, input.data) : [];
    try {
      return await this.prisma.$transaction(async (tx) => {
        // Cover existing launch/worker DML too; validation never holds these locks during a cloud request.
        await tx.$executeRaw`LOCK TABLE "CloudAccountContext", "SystemCloudConfig", "RangeInstance", "ProvisionJob", "BillingLedgerResource", "ImageImportJob", "ProvisionJobStepLog" IN SHARE ROW EXCLUSIVE MODE NOWAIT`;
        const current = await this.readSwitchState(tx);
        const existing = await tx.cloudAccountContext.findUnique({
          where: { provider_accountUid_regionId: { provider: 'alibaba_cloud', accountUid: input.data.accountUid, regionId: input.data.regionId } },
        });
        if (this.fingerprint(current) !== this.fingerprint(state)
          || this.fingerprint(existing) !== this.fingerprint(input.existing)) {
          throw new ConflictException('云配置、实例或资源任务已变化，请刷新后重新校验并保存。');
        }
        if (switching && current.activeJobCount > 0) {
          this.throwActiveResourcesConflict();
        }
        if (switching && current.activeContexts[0] && await tx.billingLedgerResource.count({
          where: { cloudAccountUid: current.activeContexts[0].accountUid, releasedAt: null },
        }) > 0) {
          throw new ConflictException('当前阿里云账号仍有未释放的计费资源，暂不能切换账号。');
        }
        await this.assertImageImportBucketCanChange(existing, input.data.imageImportBucket, tx);
        const { id: _id, isActive: _isActive, createdAt: _createdAt, updatedAt: _updatedAt, ...data } = input.data as typeof input.data & { id?: string; isActive?: boolean; createdAt?: Date; updatedAt?: Date };
        const context = await tx.cloudAccountContext.upsert({
          where: { provider_accountUid_regionId: { provider: 'alibaba_cloud', accountUid: data.accountUid, regionId: data.regionId } },
          update: data,
          create: { ...data, isActive: false },
        });
        await tx.cloudAccountContext.updateMany({ where: { isActive: true }, data: { isActive: false } });
        const activeContext = await tx.cloudAccountContext.update({ where: { id: context.id }, data: { isActive: true } });
        const config = { provider: 'alibaba_cloud', defaultRegion: data.regionId, defaultZoneId: data.zoneId, accessKeyId: data.accessKeyId, accessKeySecret: data.accessKeySecret };
        await tx.systemCloudConfig.upsert({ where: { id: 'default' }, update: config, create: { id: 'default', ...config } });
        for (const proof of proofs) {
          const verifiedAt = new Date();
          await tx.provisionJobStepLog.create({ data: { jobId: proof.provisionJobId, stepName: FAILED_CREATE_SWITCH_PROOF_STEP, status: 'succeeded', message: JSON.stringify(proof), startedAt: verifiedAt, finishedAt: verifiedAt } });
        }
        return this.toView(activeContext);
      }, { timeout: 10_000 });
    } catch (error) {
      const databaseCode = (error as { meta?: { code?: string }; code?: string })?.meta?.code;
      if (databaseCode === '55P03' || databaseCode === '40P01' || (error as { code?: string })?.code === 'P2034') {
        throw new ConflictException('云配置或资源任务正在变化，请等待任务稳定后重新保存。');
      }
      throw error;
    }
  }

  private async assertNoTaggedInstances(input: { rangeInstanceId: string; regionId: string; accessKeyId: string; accessKeySecret: string }) {
    const query = signAliyunRpcQuery({
      Action: 'DescribeInstances', AccessKeyId: input.accessKeyId, RegionId: input.regionId,
      Format: 'JSON', SignatureMethod: ALICLOUD_SIGNATURE_METHOD, SignatureNonce: randomUUID(),
      SignatureVersion: ALICLOUD_SIGNATURE_VERSION, Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      Version: '2014-05-26', PageNumber: '1', PageSize: '1',
      'Tag.1.Key': 'RangeInstanceId', 'Tag.1.Value': input.rangeInstanceId,
    }, input.accessKeySecret);
    let payload: unknown;
    try {
      const response = await fetch(`https://ecs.${input.regionId}.aliyuncs.com/?${query}`, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) {
        throw new Error('ECS verification request rejected');
      }
      payload = await response.json();
    } catch {
      throw new ConflictException('无法只读确认旧地域失败实例已清理，云配置未切换。请检查旧地域访问权限与网络后重试。');
    }
    const value = payload as { Code?: unknown; RequestId?: unknown; TotalCount?: unknown; PageNumber?: unknown; PageSize?: unknown; Instances?: { Instance?: unknown } } | null;
    if (!value || typeof value !== 'object' || value.Code !== undefined || typeof value.RequestId !== 'string' || !value.RequestId.trim()
      || !Number.isSafeInteger(value.TotalCount) || (value.TotalCount as number) < 0 || value.PageNumber !== 1 || value.PageSize !== 1
      || !value.Instances || !Array.isArray(value.Instances.Instance)) {
      throw new ConflictException('旧地域实例查询响应无法证明资源已清理，云配置未切换。');
    }
    if (value.TotalCount !== 0 || value.Instances.Instance.length !== 0) {
      this.throwActiveResourcesConflict();
    }
  }

  private async resolveAccountUid(accessKeyId: string, accessKeySecret: string) {
    const query = signAliyunRpcQuery(
      {
        Action: 'GetCallerIdentity',
        AccessKeyId: accessKeyId,
        Format: 'JSON',
        SignatureMethod: ALICLOUD_SIGNATURE_METHOD,
        SignatureNonce: randomUUID(),
        SignatureVersion: ALICLOUD_SIGNATURE_VERSION,
        Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
        Version: ALICLOUD_STS_API_VERSION,
      },
      accessKeySecret,
    );
    let response: Response;

    try {
      response = await fetch(`https://sts.aliyuncs.com/?${query}`);
    } catch {
      throw new BadRequestException('阿里云账号身份校验请求失败，请检查网络和访问凭据。');
    }

    if (!response.ok) {
      throw new BadRequestException(`阿里云账号身份校验失败（HTTP ${response.status}）。`);
    }

    const payload = (await response.json()) as { AccountId?: string | number };
    const accountUid = String(payload.AccountId ?? '').trim();

    if (!accountUid) {
      throw new BadRequestException('阿里云账号身份校验未返回 AccountId。');
    }

    return accountUid;
  }

  private async verifyImageImportBucket(input: {
    bucket: string;
    regionId: string;
    accessKeyId: string;
    accessKeySecret: string;
  }) {
    if (!input.bucket) {
      return {
        bucketStatus: 'unconfigured',
        lastError: null,
        lastVerifiedAt: null,
      };
    }

    try {
      const verificationObjectKey = `image-imports/.verification/${randomUUID()}`;
      const response = await this.ossRequest({
        url: this.getObjectEndpoint(input.bucket, input.regionId, verificationObjectKey),
        method: 'HEAD',
        resource: `/${input.bucket}/${verificationObjectKey}`,
        accessKeyId: input.accessKeyId,
        accessKeySecret: input.accessKeySecret,
      });

      // A missing object proves that the configured credentials can read the
      // import prefix. Bucket-level HEAD requests require bucket ownership and
      // reject otherwise-authorized RAM users.
      if (!response.ok && !(response.status === 404 && this.readOssHeadErrorCode(response) === 'NoSuchKey')) {
        return {
          bucketStatus: 'unavailable',
          lastError: `无法验证镜像导入 Bucket 的对象读取权限（HTTP ${response.status}）。`,
          lastVerifiedAt: null,
        };
      }

      return {
        bucketStatus: 'ready',
        lastError: null,
        lastVerifiedAt: new Date(),
      };
    } catch {
      return {
        bucketStatus: 'unavailable',
        lastError: '无法连接 OSS 验证镜像导入 Bucket。',
        lastVerifiedAt: null,
      };
    }
  }

  private readOssHeadErrorCode(response: Response): string | null {
    const encoded = response.headers.get('x-oss-err');
    if (!encoded || encoded.length > 16_384 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
      return null;
    }
    const xml = Buffer.from(encoded, 'base64').toString('utf8');
    const codes = [...xml.matchAll(/<Code>\s*([A-Za-z][A-Za-z0-9]*)\s*<\/Code>/g)];
    // HEAD has no error body; OSS supplies the base64 XML Error in this header.
    return /^\s*(?:<\?xml[^>]*>\s*)?<Error(?:\s[^>]*)?>[\s\S]*<\/Error>\s*$/.test(xml) && codes.length === 1
      ? codes[0][1]
      : null;
  }

  private assertImageImportBucketName(bucket: string) {
    if (bucket && !/^[a-z0-9](?:[a-z0-9-]{1,61})[a-z0-9]$/.test(bucket)) {
      throw new BadRequestException('自定义 OSS 存储桶名格式无效。');
    }
  }

  private async assertImageImportBucketCanChange(
    existing: { id: string; imageImportBucket: string } | null,
    imageImportBucket: string,
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ) {
    if (!existing || existing.imageImportBucket === imageImportBucket) {
      return;
    }

    const pendingJobCount = await db.imageImportJob.count({
      where: {
        cloudAccountContextId: existing.id,
        temporaryObjectDeletedAt: null,
      },
    });

    if (pendingJobCount > 0) {
      throw new ConflictException('当前账号仍有待完成或待清理的镜像导入任务，暂不能更换或清空镜像导入 Bucket。');
    }
  }

  private async ossRequest(input: {
    url: string;
    method: 'HEAD';
    resource: string;
    accessKeyId: string;
    accessKeySecret: string;
  }) {
    const date = new Date().toUTCString();
    const headers = { Date: date };
    const authorization = this.signOssRequest({
      method: input.method,
      headers,
      resource: input.resource,
      accessKeyId: input.accessKeyId,
      accessKeySecret: input.accessKeySecret,
    });

    return fetch(input.url, {
      method: input.method,
      headers: { ...headers, Authorization: authorization },
    });
  }

  private signOssRequest(input: {
    method: string;
    headers: Record<string, string>;
    resource: string;
    accessKeyId: string;
    accessKeySecret: string;
  }) {
    const normalizedHeaders = Object.entries(input.headers)
      .map(([key, value]) => [key.toLowerCase(), value.trim()] as const)
      .sort(([left], [right]) => left.localeCompare(right));
    const contentMd5 = normalizedHeaders.find(([key]) => key === 'content-md5')?.[1] ?? '';
    const contentType = normalizedHeaders.find(([key]) => key === 'content-type')?.[1] ?? '';
    const date = normalizedHeaders.find(([key]) => key === 'date')?.[1] ?? '';
    const canonicalizedOssHeaders = normalizedHeaders
      .filter(([key]) => key.startsWith('x-oss-'))
      .map(([key, value]) => `${key}:${value}\n`)
      .join('');
    const stringToSign = `${input.method}\n${contentMd5}\n${contentType}\n${date}\n${canonicalizedOssHeaders}${input.resource}`;
    const signature = createHmac('sha1', input.accessKeySecret).update(stringToSign).digest('base64');

    return `OSS ${input.accessKeyId}:${signature}`;
  }

  private getBucketEndpoint(bucket: string, regionId: string) {
    return `https://${bucket}.oss-${regionId}.aliyuncs.com/`;
  }

  private getObjectEndpoint(bucket: string, regionId: string, objectKey: string) {
    const encodedObjectKey = objectKey.split('/').map(encodeURIComponent).join('/');
    return `${this.getBucketEndpoint(bucket, regionId)}${encodedObjectKey}`;
  }

  private toView(context: {
    cloudWorkspaceId?: string;
    id: string;
    displayName: string;
    provider: 'alibaba_cloud' | 'tencent_cloud';
    accountUid: string;
    regionId: string;
    zoneId: string;
    imageImportBucket: string;
    isActive: boolean;
    status: 'provisioning' | 'ready' | 'degraded' | 'disabled';
    bucketStatus: string;
    lastError: string | null;
    lastVerifiedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }): CloudAccountContextView {
    return {
      ...(context.cloudWorkspaceId ? { cloudWorkspaceId: context.cloudWorkspaceId } : {}),
      id: context.id,
      displayName: context.displayName,
      provider: context.provider,
      accountUid: context.accountUid,
      regionId: context.regionId,
      zoneId: context.zoneId,
      imageImportBucket: context.imageImportBucket,
      isActive: context.isActive,
      status: context.status,
      bucketStatus: context.bucketStatus,
      lastError: context.lastError,
      lastVerifiedAt: context.lastVerifiedAt,
      createdAt: context.createdAt,
      updatedAt: context.updatedAt,
    };
  }
}
