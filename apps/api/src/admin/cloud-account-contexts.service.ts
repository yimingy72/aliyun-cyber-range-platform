import { createHash, createHmac, randomUUID } from 'node:crypto';

import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../database/prisma.service';
import { signAliyunRpcQuery } from './image-catalog-rpc-signer';
import type { CreateCloudAccountContextDto } from './dto/cloud-account-context.dto';

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
    options: { requireReady?: boolean; requireActive?: boolean } = {},
  ): Promise<CloudAccountContextCredentials> {
    const context = await this.prisma.cloudAccountContext.findUnique({ where: { id } });

    if (!context) {
      throw new NotFoundException('Cloud account context not found');
    }

    if (options.requireReady && context.status !== 'ready') {
      throw new BadRequestException('当前云账号的镜像导入 Bucket 未就绪，请先在云配置中修复。');
    }

    if (options.requireActive && (!context.isActive || context.status !== 'ready')) {
      throw new BadRequestException('请选择当前已启用且 Bucket 已就绪的阿里云账号。');
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

  async create(input: CreateCloudAccountContextDto): Promise<CloudAccountContextView> {
    const normalized = {
      displayName: input.displayName.trim(),
      regionId: input.regionId.trim(),
      zoneId: input.zoneId.trim(),
      accessKeyId: input.accessKeyId.trim(),
      accessKeySecret: input.accessKeySecret.trim(),
      imageImportBucket: input.imageImportBucket?.trim() || '',
    };
    const accountUid = await this.resolveAccountUid(normalized.accessKeyId, normalized.accessKeySecret);
    const imageImportBucket = normalized.imageImportBucket || this.buildBucketName(accountUid, normalized.regionId);

    const existing = await this.prisma.cloudAccountContext.findUnique({
      where: {
        provider_accountUid_regionId: {
          provider: 'alibaba_cloud',
          accountUid,
          regionId: normalized.regionId,
        },
      },
    });

    if (existing) {
      throw new BadRequestException('该阿里云账号和地域已经配置，请在已有配置上执行修复。');
    }

    const configuredContextCount = await this.prisma.cloudAccountContext.count();

    const context = await this.prisma.cloudAccountContext.create({
      data: {
        displayName: normalized.displayName,
        provider: 'alibaba_cloud',
        accountUid,
        regionId: normalized.regionId,
        zoneId: normalized.zoneId,
        accessKeyId: normalized.accessKeyId,
        accessKeySecret: normalized.accessKeySecret,
        imageImportBucket,
        isActive: configuredContextCount === 0,
        status: 'provisioning',
        bucketStatus: 'creating',
      },
    });

    return this.ensureBucket(context.id);
  }

  async ensureBucket(id: string): Promise<CloudAccountContextView> {
    const context = await this.prisma.cloudAccountContext.findUnique({ where: { id } });

    if (!context) {
      throw new NotFoundException('Cloud account context not found');
    }

    try {
      await this.ensurePrivateImportBucket({
        bucket: context.imageImportBucket,
        regionId: context.regionId,
        accessKeyId: context.accessKeyId,
        accessKeySecret: context.accessKeySecret,
      });
      const ready = await this.prisma.cloudAccountContext.update({
        where: { id },
        data: {
          status: 'ready',
          bucketStatus: 'ready',
          lastError: null,
          lastVerifiedAt: new Date(),
        },
      });
      return this.toView(ready);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown OSS Bucket initialization error';
      const degraded = await this.prisma.cloudAccountContext.update({
        where: { id },
        data: {
          status: 'degraded',
          bucketStatus: 'failed',
          lastError: message,
        },
      });
      return this.toView(degraded);
    }
  }

  async activate(id: string): Promise<CloudAccountContextView> {
    const context = await this.prisma.cloudAccountContext.findUnique({ where: { id } });

    if (!context) {
      throw new NotFoundException('Cloud account context not found');
    }

    if (context.status !== 'ready') {
      throw new BadRequestException('当前云账号的镜像导入 Bucket 未就绪，无法切换。');
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
    const response = await fetch(`https://sts.aliyuncs.com/?${query}`);

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

  private async ensurePrivateImportBucket(input: {
    bucket: string;
    regionId: string;
    accessKeyId: string;
    accessKeySecret: string;
  }) {
    const endpoint = this.getBucketEndpoint(input.bucket, input.regionId);
    const createResponse = await this.ossRequest({
      url: endpoint,
      method: 'PUT',
      bucket: input.bucket,
      resource: `/${input.bucket}/`,
      accessKeyId: input.accessKeyId,
      accessKeySecret: input.accessKeySecret,
      headers: { 'x-oss-acl': 'private' },
    });

    if (!createResponse.ok && createResponse.status !== 409) {
      throw new Error(`创建 OSS Bucket 失败（HTTP ${createResponse.status}）：${await createResponse.text()}`);
    }

    const importCorsRule = [
      '<CORSRule>',
      ...this.getAllowedCorsOrigins().map((origin) => `<AllowedOrigin>${origin}</AllowedOrigin>`),
      '<AllowedMethod>PUT</AllowedMethod>',
      '<AllowedHeader>*</AllowedHeader>',
      '<ExposeHeader>ETag</ExposeHeader>',
      '<MaxAgeSeconds>900</MaxAgeSeconds>',
      '</CORSRule>',
    ].join('');
    const corsBody = createResponse.ok
      ? this.createCorsConfiguration(importCorsRule)
      : await this.mergeImportCorsRule({
          endpoint,
          bucket: input.bucket,
          accessKeyId: input.accessKeyId,
          accessKeySecret: input.accessKeySecret,
          importCorsRule,
        });

    if (!corsBody) {
      return;
    }

    const corsResponse = await this.ossRequest({
      url: `${endpoint}?cors`,
      method: 'PUT',
      bucket: input.bucket,
      resource: `/${input.bucket}/?cors`,
      accessKeyId: input.accessKeyId,
      accessKeySecret: input.accessKeySecret,
      headers: { 'Content-Type': 'application/xml' },
      body: corsBody,
    });

    if (!corsResponse.ok) {
      throw new Error(`配置 OSS Bucket CORS 失败（HTTP ${corsResponse.status}）：${await corsResponse.text()}`);
    }
  }

  private createCorsConfiguration(corsRule: string) {
    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<CORSConfiguration>',
      corsRule,
      '</CORSConfiguration>',
    ].join('');
  }

  private async mergeImportCorsRule(input: {
    endpoint: string;
    bucket: string;
    accessKeyId: string;
    accessKeySecret: string;
    importCorsRule: string;
  }) {
    const existingResponse = await this.ossRequest({
      url: `${input.endpoint}?cors`,
      method: 'GET',
      bucket: input.bucket,
      resource: `/${input.bucket}/?cors`,
      accessKeyId: input.accessKeyId,
      accessKeySecret: input.accessKeySecret,
    });

    if (existingResponse.status === 404) {
      return this.createCorsConfiguration(input.importCorsRule);
    }

    if (!existingResponse.ok) {
      throw new Error(`读取 OSS Bucket CORS 失败（HTTP ${existingResponse.status}）：${await existingResponse.text()}`);
    }

    const existingXml = await existingResponse.text();
    const compactExistingXml = existingXml.replace(/\s+/g, '');
    const compactImportRule = input.importCorsRule.replace(/\s+/g, '');

    if (compactExistingXml.includes(compactImportRule)) {
      return null;
    }

    const closingTag = '</CORSConfiguration>';
    const closingTagIndex = existingXml.lastIndexOf(closingTag);

    if (closingTagIndex < 0) {
      throw new Error('读取到的 OSS Bucket CORS 配置格式无效。');
    }

    return `${existingXml.slice(0, closingTagIndex)}${input.importCorsRule}${existingXml.slice(closingTagIndex)}`;
  }

  private async ossRequest(input: {
    url: string;
    method: 'PUT' | 'GET' | 'HEAD';
    bucket: string;
    resource: string;
    accessKeyId: string;
    accessKeySecret: string;
    headers?: Record<string, string>;
    body?: string;
  }) {
    const date = new Date().toUTCString();
    const headers = { Date: date, ...(input.headers ?? {}) };
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
      ...(input.body !== undefined ? { body: input.body } : {}),
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

  private getAllowedCorsOrigins() {
    const configured = process.env.IMAGE_IMPORT_ALLOWED_ORIGINS?.split(',') ?? [];
    const candidates = configured.length > 0 ? configured : ['http://localhost:3000'];
    const origins = candidates
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => {
        try {
          const url = new URL(value);

          if (url.protocol !== 'http:' && url.protocol !== 'https:') {
            return null;
          }

          return url.origin;
        } catch {
          return null;
        }
      })
      .filter((value): value is string => Boolean(value));

    if (origins.length === 0) {
      throw new BadRequestException('IMAGE_IMPORT_ALLOWED_ORIGINS 必须包含至少一个有效的 HTTP(S) 来源。');
    }

    return [...new Set(origins)];
  }

  private buildBucketName(accountUid: string, regionId: string) {
    const accountHash = createHash('sha256').update(accountUid).digest('hex').slice(0, 10);
    const regionSlug = regionId.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 24);
    const randomSuffix = randomUUID().replace(/-/g, '').slice(0, 8);
    return `cyber-range-image-${accountHash}-${regionSlug}-${randomSuffix}`.slice(0, 63);
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
