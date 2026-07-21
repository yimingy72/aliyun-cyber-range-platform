import { createHmac, randomUUID } from 'node:crypto';

import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../database/prisma.service';
import { signAliyunRpcQuery } from './image-catalog-rpc-signer';

const ALICLOUD_SIGNATURE_METHOD = 'HMAC-SHA1';
const ALICLOUD_SIGNATURE_VERSION = '1.0';
const ALICLOUD_STS_API_VERSION = '2015-04-01';

export type CloudAccountContextCredentials = {
  id: string;
  provider: 'alibaba_cloud';
  accountUid: string;
  regionId: string;
  zoneId: string;
  accessKeyId: string;
  accessKeySecret: string;
  imageImportBucket: string;
  status: 'provisioning' | 'ready' | 'degraded' | 'disabled';
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
    const contexts = await this.prisma.cloudAccountContext.findMany({
      where: options.includeInactive ? undefined : { isActive: true, status: 'ready' },
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

    if (options.requireReady && context.status !== 'ready') {
      throw new BadRequestException('当前阿里云账号不可用，请先在云配置中修复。');
    }

    if (options.requireActive && (!context.isActive || context.status !== 'ready')) {
      throw new BadRequestException('请选择当前已启用且可用的阿里云账号。');
    }

    if (options.requireImageImportBucket) {
      if (!context.imageImportBucket.trim() || context.bucketStatus === 'unconfigured') {
        throw new BadRequestException('当前阿里云账号未配置镜像导入 Bucket，请先在云配置中填写自定义 OSS 存储桶名。');
      }

      if (context.bucketStatus !== 'ready') {
        throw new BadRequestException('配置的镜像导入 Bucket 不可用，请检查名称、地域和权限。');
      }
    }

    return {
      id: context.id,
      provider: 'alibaba_cloud',
      accountUid: context.accountUid,
      regionId: context.regionId,
      zoneId: context.zoneId,
      accessKeyId: context.accessKeyId,
      accessKeySecret: context.accessKeySecret,
      imageImportBucket: context.imageImportBucket,
      status: context.status,
    };
  }

  async saveFromCloudConfig(input: SaveCloudConfigInput): Promise<CloudAccountContextView> {
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
    const context = existing
      ? await this.prisma.cloudAccountContext.update({
          where: { id: existing.id },
          data: {
            displayName,
            zoneId: normalized.zoneId,
            accessKeyId: normalized.accessKeyId,
            accessKeySecret: normalized.accessKeySecret,
            imageImportBucket,
            status: 'ready',
            ...bucketVerification,
          },
        })
      : await this.prisma.cloudAccountContext.create({
          data: {
            displayName,
            provider: 'alibaba_cloud',
            accountUid,
            regionId: normalized.regionId,
            zoneId: normalized.zoneId,
            accessKeyId: normalized.accessKeyId,
            accessKeySecret: normalized.accessKeySecret,
            imageImportBucket,
            isActive: (await this.prisma.cloudAccountContext.count()) === 0,
            status: 'ready',
            ...bucketVerification,
          },
        });

    return context.isActive ? this.toView(context) : this.activate(context.id);
  }

  async activate(id: string): Promise<CloudAccountContextView> {
    const context = await this.prisma.cloudAccountContext.findUnique({ where: { id } });

    if (!context) {
      throw new NotFoundException('Cloud account context not found');
    }

    if (context.status !== 'ready') {
      throw new BadRequestException('当前阿里云账号不可用，无法切换。');
    }

    if (context.isActive) {
      return this.toView(context);
    }

    const [liveInstanceCount, activeProvisionJobCount] = await Promise.all([
      this.prisma.rangeInstance.count({
        where: {
          status: { not: 'destroyed' },
        },
      }),
      this.prisma.provisionJob.count({
        where: {
          status: { in: ['pending', 'running'] },
        },
      }),
    ]);

    if (liveInstanceCount > 0 || activeProvisionJobCount > 0) {
      throw new ConflictException(
        '当前仍存在未销毁实例或执行中的资源任务。为避免跨阿里云账号误操作，请先完成销毁并等待任务结束后再切换账号。',
      );
    }

    await this.prisma.$transaction([
      this.prisma.cloudAccountContext.updateMany({ data: { isActive: false } }),
      this.prisma.cloudAccountContext.update({ where: { id }, data: { isActive: true } }),
    ]);
    return this.toView(await this.prisma.cloudAccountContext.findUniqueOrThrow({ where: { id } }));
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
      const response = await this.ossRequest({
        url: this.getBucketEndpoint(input.bucket, input.regionId),
        method: 'HEAD',
        bucket: input.bucket,
        resource: `/${input.bucket}/`,
        accessKeyId: input.accessKeyId,
        accessKeySecret: input.accessKeySecret,
      });

      if (!response.ok) {
        return {
          bucketStatus: 'unavailable',
          lastError: `无法验证镜像导入 Bucket（HTTP ${response.status}）。`,
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

  private assertImageImportBucketName(bucket: string) {
    if (bucket && !/^[a-z0-9](?:[a-z0-9-]{1,61})[a-z0-9]$/.test(bucket)) {
      throw new BadRequestException('自定义 OSS 存储桶名格式无效。');
    }
  }

  private async assertImageImportBucketCanChange(
    existing: { id: string; imageImportBucket: string } | null,
    imageImportBucket: string,
  ) {
    if (!existing || existing.imageImportBucket === imageImportBucket) {
      return;
    }

    const pendingJobCount = await this.prisma.imageImportJob.count({
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
    bucket: string;
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

  private toView(context: {
    id: string;
    displayName: string;
    provider: 'alibaba_cloud';
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
