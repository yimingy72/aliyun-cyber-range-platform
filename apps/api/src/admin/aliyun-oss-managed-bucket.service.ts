import { BadGatewayException, BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { Prisma, type CloudImageImportBucket } from '@aliyun-cyber-range/database/generated/client';
import { createHash, createHmac, randomUUID } from 'node:crypto';

import { getCurrentCloudWorkspaceScope } from '../auth/cloud-workspace-scope';
import { PrismaService } from '../database/prisma.service';
import { BillingOssBindingService } from './billing-oss-binding.service';
import { readAliyunOssBucketIdentity, type AliyunOssPlatformCreationProof } from './billing-oss-binding-proof';
import type { CreateBillingOssBucketDto } from './dto/billing-oss-binding.dto';
import { signAliyunRpcQuery } from './image-catalog-rpc-signer';
import type { SystemCloudAccountContext } from './system-config.service';
import { parseCosXml, xmlChildren, xmlOne, xmlText } from './tencent-cos-xml';

const LEASE_MS = 300_000;
const json = (value: unknown) => value as Prisma.InputJsonValue;
const CORS = '<CORSConfiguration><CORSRule><AllowedOrigin>*</AllowedOrigin><AllowedMethod>PUT</AllowedMethod><AllowedMethod>GET</AllowedMethod><AllowedMethod>HEAD</AllowedMethod><AllowedHeader>*</AllowedHeader><ExposeHeader>ETag</ExposeHeader><MaxAgeSeconds>600</MaxAgeSeconds></CORSRule></CORSConfiguration>';
const atomicTags = (bucket: CloudImageImportBucket) => ({ PlatformManagedBucketId: bucket.id,
  PlatformCreationNonce: bucket.creationNonce, CloudWorkspaceId: bucket.cloudWorkspaceId });
const requestId = (response: Response) => {
  const id = response.headers.get('x-oss-request-id');
  if (!id) throw new BadGatewayException('OSS 官方请求证明不完整。');
  return id;
};
function conflict(message: string): never { throw new ConflictException(message); }

// OSS PUT Bucket also changes an existing bucket's metadata. Never retry a dispatched create.
async function requestOss(context: SystemCloudAccountContext, bucketName: string, method: 'GET' | 'PUT',
  subresource = '', body = '', extraHeaders: Record<string, string> = {}) {
  const date = new Date().toUTCString();
  const headers: Record<string, string> = { Date: date, ...extraHeaders };
  if (body) { headers['Content-Type'] = 'application/xml'; headers['Content-MD5'] = createHash('md5').update(body).digest('base64'); }
  const canonicalHeaders = Object.entries(headers).filter(([key]) => key.toLowerCase().startsWith('x-oss-'))
    .map(([key, value]) => [key.toLowerCase(), value.trim()]).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, value]) => `${key}:${value}\n`).join('');
  const canonicalResource = `/${bucketName}/${subresource ? `?${subresource}` : ''}`;
  const signature = createHmac('sha1', context.accessKeySecret).update(`${method}\n${headers['Content-MD5'] ?? ''}\n${headers['Content-Type'] ?? ''}\n${date}\n${canonicalHeaders}${canonicalResource}`).digest('base64');
  headers.Authorization = `OSS ${context.accessKeyId}:${signature}`;
  return fetch(`https://${bucketName}.oss-${context.defaultRegion}.aliyuncs.com/${subresource ? `?${subresource}` : ''}`,
    { method, headers, ...(body ? { body } : {}), redirect: 'error', signal: AbortSignal.timeout(30_000) });
}

@Injectable()
export class AliyunOssManagedBucketService {
  constructor(private readonly prisma: PrismaService, private readonly bindings: BillingOssBindingService) {}

  private async context(payload: CreateBillingOssBucketDto) {
    if (payload.dedicated !== true) throw new BadRequestException('必须确认新桶仅供平台使用。');
    return this.bindings.contextForWrite(false);
  }

  async confirmation(payload: CreateBillingOssBucketDto) {
    const context = await this.context(payload);
    const scope = getCurrentCloudWorkspaceScope()!;
    if ('system' in scope) conflict('OSS 创建需要明确工作空间。');
    const bucket = await this.prisma.cloudImageImportBucket.findUnique({ where: { activeSlot: this.slot(context) } });
    this.assertConfigured(context, bucket);
    return { targetId: scope.cloudWorkspaceId, targetSnapshot: { cloudAccountContextId: context.cloudAccountContextId!,
      accountUid: context.accountUid!, regionId: context.defaultRegion, configuredBucketName: context.imageImportBucket,
      managedBucketId: bucket?.id ?? null, bucketName: bucket?.bucketName ?? null },
      summary: { accountUid: context.accountUid!, regionId: context.defaultRegion, createsPrivateStandardBucket: true,
        quantity: 1, dedicated: true, retainedForPlatform: true, includesStorageRequestsAndTraffic: true,
        resumesOriginalCreation: !!bucket, unknownCreationNeverRepeated: true } };
  }

  async create(payload: CreateBillingOssBucketDto) {
    const context = await this.context(payload);
    // Saved credentials may have changed after the account was bound. Verify their actual owner before a write.
    const stsRequestId = await this.verifyCaller(context);
    const scope = getCurrentCloudWorkspaceScope()!;
    if ('system' in scope || !scope.actorUserId) conflict('OSS 创建需要明确用户和工作空间。');
    const activeSlot = this.slot(context);
    let bucket = await this.prisma.cloudImageImportBucket.findUnique({ where: { activeSlot } });
    this.assertConfigured(context, bucket);
    if (!bucket) {
      const nonce = randomUUID();
      try {
        bucket = await this.prisma.cloudImageImportBucket.create({ data: { cloudWorkspaceId: scope.cloudWorkspaceId,
          cloudProvider: 'alibaba_cloud', cloudAccountContextId: context.cloudAccountContextId!, cloudAccountUid: context.accountUid!,
          appId: 'not-applicable', regionId: context.defaultRegion, bucketName: `for-platform-${nonce.replaceAll('-', '')}`,
          creationNonce: nonce, creatorUserId: scope.actorUserId, activeSlot, ownershipMarkerKey: 'PlatformCreationNonce',
          ownershipProof: { stsRequestId, intentRecordedAt: new Date().toISOString() } } });
      } catch (error) {
        if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'P2002') throw error;
        bucket = await this.prisma.cloudImageImportBucket.findUnique({ where: { activeSlot } });
        if (!bucket) throw error;
      }
    }
    this.assertIdentity(bucket, context);
    const token = randomUUID();
    const claimed = await this.prisma.cloudImageImportBucket.updateMany({ where: { id: bucket.id, status: bucket.status,
      activeSlot, OR: [{ leaseToken: null }, { leaseExpiresAt: { lte: new Date() } }] },
      data: { leaseToken: token, leaseExpiresAt: new Date(Date.now() + LEASE_MS) } });
    if (claimed.count !== 1) conflict('OSS 桶创建或配置正在处理，请稍后发起新的确认请求恢复原记录。');
    try { return await this.prepare(bucket, context, token); }
    catch (error) {
      await this.prisma.cloudImageImportBucket.updateMany({ where: { id: bucket.id, leaseToken: token, leaseExpiresAt: { gt: new Date() } },
        data: { errorMessage: 'OSS 当前步骤未完成；保留创建来源、原名称与费用证据，恢复时不会再次创建。' } });
      throw error;
    }
    finally { await this.prisma.cloudImageImportBucket.updateMany({ where: { id: bucket.id, leaseToken: token }, data: { leaseToken: null, leaseExpiresAt: null } }); }
  }

  private slot(context: SystemCloudAccountContext) {
    const scope = getCurrentCloudWorkspaceScope()!;
    if ('system' in scope) conflict('OSS 创建需要明确工作空间。');
    return createHash('sha256').update(JSON.stringify([scope.cloudWorkspaceId, 'alibaba_cloud', context.accountUid,
      context.defaultRegion, context.cloudAccountContextId])).digest('hex');
  }

  private assertConfigured(context: SystemCloudAccountContext, bucket: CloudImageImportBucket | null) {
    if (context.imageImportBucket && context.imageImportBucket !== bucket?.bucketName) conflict('当前账号已配置其他 OSS 桶，请使用已有桶的专用费用绑定。');
  }

  private assertIdentity(bucket: CloudImageImportBucket, context: SystemCloudAccountContext) {
    const scope = getCurrentCloudWorkspaceScope()!;
    if ('system' in scope || bucket.cloudWorkspaceId !== scope.cloudWorkspaceId || bucket.cloudProvider !== 'alibaba_cloud'
      || bucket.cloudAccountUid !== context.accountUid || bucket.cloudAccountContextId !== context.cloudAccountContextId
      || bucket.regionId !== context.defaultRegion || bucket.appId !== 'not-applicable'
      || bucket.bucketName !== `for-platform-${bucket.creationNonce.replaceAll('-', '')}` || bucket.activeSlot !== this.slot(context)) {
      conflict('OSS 持久创建来源与冻结工作空间身份不一致。');
    }
  }

  private async verifyCaller(context: SystemCloudAccountContext) {
    const query = signAliyunRpcQuery({ Action: 'GetCallerIdentity', AccessKeyId: context.accessKeyId, Format: 'JSON',
      SignatureMethod: 'HMAC-SHA1', SignatureNonce: randomUUID(), SignatureVersion: '1.0',
      Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), Version: '2015-04-01' }, context.accessKeySecret);
    try {
      const response = await fetch(`https://sts.aliyuncs.com/?${query}`, { redirect: 'error', signal: AbortSignal.timeout(15_000) });
      const data = await response.json() as { AccountId?: unknown; RequestId?: unknown; Code?: unknown };
      if (!response.ok || data.Code || typeof data.AccountId !== 'string' || data.AccountId !== context.accountUid
        || typeof data.RequestId !== 'string' || !data.RequestId) throw new Error('identity');
      return data.RequestId;
    } catch { throw new BadGatewayException('当前凭据的阿里云主账号身份未确认，未创建 OSS 桶。'); }
  }

  private async update(bucket: CloudImageImportBucket, token: string, data: Prisma.CloudImageImportBucketUpdateManyMutationInput) {
    const changed = await this.prisma.cloudImageImportBucket.updateMany({ where: { id: bucket.id, leaseToken: token,
      leaseExpiresAt: { gt: new Date() } }, data: { ...data, leaseExpiresAt: new Date(Date.now() + LEASE_MS) } });
    if (changed.count !== 1) conflict('OSS 桶租约已失效，停止后续云操作。');
    return (await this.prisma.cloudImageImportBucket.findUnique({ where: { id: bucket.id } }))!;
  }

  private proof(bucket: CloudImageImportBucket): Record<string, unknown> {
    return bucket.ownershipProof && typeof bucket.ownershipProof === 'object' && !Array.isArray(bucket.ownershipProof)
      ? bucket.ownershipProof as Record<string, unknown> : {};
  }

  private async prepare(bucket: CloudImageImportBucket, context: SystemCloudAccountContext, token: string) {
    if (['rejected', 'deleted', 'deleting'].includes(bucket.status)) conflict('该 OSS 创建来源已被拒绝或终止，不会接管或再次创建同名桶。');
    if (!bucket.creationStartedAt) {
      bucket = await this.update(bucket, token, { ownershipProof: json({ ...this.proof(bucket), stage: 'preflight' }) });
      const preflight = await requestOss(context, bucket.bucketName, 'GET', 'bucketInfo');
      if (preflight.ok || preflight.status === 409) {
        await this.update(bucket, token, { status: 'rejected', errorMessage: 'OSS 名称已经存在，拒绝接管其他来源。' });
        conflict('OSS 名称已经存在，未发送创建请求，不接管其他桶。');
      }
      const error = parseCosXml(await preflight.text(), 'Error');
      if (preflight.status !== 404 || xmlText(error, 'Code') !== 'NoSuchBucket') conflict('OSS 名称未确认不存在，未发送创建请求。');
      const preflightAt = new Date();
      bucket = await this.update(bucket, token, { status: 'creating', preflightAbsentAt: preflightAt, creationStartedAt: preflightAt,
        ownershipProof: json({ ...this.proof(bucket), preflightRequestId: requestId(preflight), createDispatchedAt: preflightAt.toISOString() }) });
      try {
        const tags = atomicTags(bucket);
        const response = await requestOss(context, bucket.bucketName, 'PUT', '',
          '<CreateBucketConfiguration><StorageClass>Standard</StorageClass><DataRedundancyType>LRS</DataRedundancyType></CreateBucketConfiguration>',
          { 'x-oss-acl': 'private', 'x-oss-bucket-tagging': Object.entries(tags).map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&') });
        if (!response.ok) {
          bucket = await this.update(bucket, token, { status: response.status >= 400 && response.status < 500 ? 'rejected' : 'unknown',
            errorMessage: 'OSS 创建未确认；持久保留原名称，不重复创建。',
            ownershipProof: json({ ...this.proof(bucket), createResponseStatus: response.status, createResponseRequestId: response.headers.get('x-oss-request-id') }) });
          conflict('OSS 创建未成功确认，保留原请求来源，禁止重试创建或接管同名桶。');
        }
        bucket = await this.update(bucket, token, { creationRequestId: requestId(response),
          ownershipProof: json({ ...this.proof(bucket), createAcceptedAt: new Date().toISOString() }) });
      } catch (error) {
        if (bucket.status !== 'rejected') await this.update(bucket, token, { status: 'unknown', errorMessage: 'OSS 创建结果未知；恢复时仅查询原名称，不重复 PUT。' });
        throw error instanceof ConflictException ? error : new ConflictException('OSS 创建结果未知；稍后发起新的确认请求恢复同一创建记录，不会新建替代桶。');
      }
    }
    bucket = await this.update(bucket, token, { ownershipProof: json({ ...this.proof(bucket), stage: 'verify_identity' }) });
    let identity;
    try { identity = await readAliyunOssBucketIdentity(context, bucket.bucketName); }
    catch { throw new ConflictException('OSS 创建结果尚待身份核验；保留原名称，不重复创建。'); }
    if (!bucket.preflightAbsentAt || !bucket.creationStartedAt || !this.proof(bucket).preflightRequestId
      || Date.parse(identity.bucketCreatedAt) + 1000 < bucket.creationStartedAt.getTime()
      || Date.parse(identity.bucketCreatedAt) > bucket.creationStartedAt.getTime() + 120_000
      || this.proof(bucket).bucketCreatedAt && this.proof(bucket).bucketCreatedAt !== identity.bucketCreatedAt) {
      conflict('OSS 官方出生时间与持久创建来源不一致，未登记费用或修改配置。');
    }
    const { preflightAbsentAt, creationStartedAt } = bucket;
    bucket = await this.update(bucket, token, { ownershipProof: json({ ...this.proof(bucket), stage: 'verify_atomic_tags' }) });
    const tagResponse = await requestOss(context, bucket.bucketName, 'GET', 'tagging');
    if (!tagResponse.ok) throw new BadGatewayException('OSS 平台原子创建标签尚待核验，未登记费用或修改配置。');
    const tagSet = xmlOne(parseCosXml(await tagResponse.text(), 'Tagging'), 'TagSet');
    const tags: Record<string, string> = Object.create(null);
    for (const tag of xmlChildren(tagSet, 'Tag')) {
      const key = xmlText(tag, 'Key');
      if (key in tags) conflict('OSS 创建标签重复，无法确认平台来源。');
      tags[key] = xmlText(tag, 'Value');
    }
    const expectedTags = atomicTags(bucket);
    if (Object.entries(expectedTags).some(([key, value]) => tags[key] !== value)) {
      conflict('OSS 原子创建标签与持久来源不一致，保留待核验，不接管同名桶。');
    }
    const taggingVerifiedAt = new Date().toISOString();
    const taggingRequestId = requestId(tagResponse);
    bucket = await this.update(bucket, token, { ownershipProof: json({ ...this.proof(bucket), taggingVerifiedAt, taggingRequestId, atomicTags: expectedTags }) });
    const info = await requestOss(context, bucket.bucketName, 'GET', 'bucketInfo');
    if (!info.ok) throw new BadGatewayException('OSS 存储类型尚待核验，创建来源保留。');
    const infoBucket = xmlOne(parseCosXml(await info.text(), 'BucketInfo'), 'Bucket');
    if (xmlText(infoBucket, 'Name') !== bucket.bucketName || xmlText(infoBucket, 'StorageClass') !== 'Standard'
      || new Date(xmlText(infoBucket, 'CreationDate')).toISOString() !== identity.bucketCreatedAt
      || xmlText(xmlOne(infoBucket, 'Owner'), 'ID') !== context.accountUid) conflict('OSS 官方身份或 Standard 存储类型不一致。');
    bucket = await this.update(bucket, token, { ownershipProof: json({ ...this.proof(bucket), stage: 'verify_private_acl' }) });
    const acl = await requestOss(context, bucket.bucketName, 'GET', 'acl');
    if (!acl.ok) throw new BadGatewayException('OSS 私有访问权限尚待核验，创建来源保留。');
    const aclXml = parseCosXml(await acl.text(), 'AccessControlPolicy');
    if (xmlText(xmlOne(aclXml, 'Owner'), 'ID') !== context.accountUid
      || xmlText(xmlOne(aclXml, 'AccessControlList'), 'Grant') !== 'private') conflict('OSS 桶的主账号或私有 ACL 不一致。');
    if (!this.proof(bucket).emptyVerifiedAt) {
      const listed = await requestOss(context, bucket.bucketName, 'GET');
      if (!listed.ok) throw new BadGatewayException('OSS 新桶空目录尚待核验。');
      const inventory = parseCosXml(await listed.text(), 'ListBucketResult');
      if (xmlText(inventory, 'Name') !== bucket.bucketName || xmlText(inventory, 'IsTruncated') !== 'false'
        || xmlChildren(inventory, 'Contents').length) conflict('OSS 新桶存在未核验对象，未接管整桶费用。');
      bucket = await this.update(bucket, token, { ownershipProof: json({ ...this.proof(bucket),
        emptyVerifiedAt: new Date().toISOString(), emptyInventoryRequestId: requestId(listed) }) });
    }
    const creation: AliyunOssPlatformCreationProof = { version: 1, managedBucketId: bucket.id, creationNonce: bucket.creationNonce,
      preflightAbsentAt: preflightAbsentAt.toISOString(), preflightRequestId: String(this.proof(bucket).preflightRequestId),
      creationStartedAt: creationStartedAt.toISOString(), creationRequestId: bucket.creationRequestId,
      aclVerifiedAt: new Date().toISOString(), aclRequestId: requestId(acl), ownerUid: identity.ownerUid, storageClass: 'Standard',
      taggingVerifiedAt, taggingRequestId, atomicTags: expectedTags };
    bucket = await this.update(bucket, token, { status: 'available', ownershipProof: json({ ...this.proof(bucket),
      bucketCreatedAt: identity.bucketCreatedAt, identityRequestId: identity.officialRequestId, storageInfoRequestId: requestId(info), platformCreation: creation, stage: 'billing_registration' }), errorMessage: null });
    // Resource expenses exist independently of import/CORS readiness. Register billing before those later steps.
    const binding = await this.bindings.bindPlatformCreated(context, identity, creation);
    try {
      bucket = await this.update(bucket, token, { ownershipProof: json({ ...this.proof(bucket), stage: 'configure_cors', ledgerId: binding.ledgerId }) });
      const cors = await requestOss(context, bucket.bucketName, 'PUT', 'cors', CORS);
      if (!cors.ok) throw new Error('CORS_WRITE');
      bucket = await this.update(bucket, token, { ownershipProof: json({ ...this.proof(bucket), corsWriteRequestId: requestId(cors) }) });
      const readback = await requestOss(context, bucket.bucketName, 'GET', 'cors');
      if (!readback.ok) throw new Error('CORS_READ');
      const rules = xmlChildren(parseCosXml(await readback.text(), 'CORSConfiguration'), 'CORSRule');
      if (!rules.some(rule => {
        const values = (name: string) => xmlChildren(rule, name).map(node => node.text.trim());
        return values('AllowedOrigin').includes('*') && ['PUT', 'GET', 'HEAD'].every(method => values('AllowedMethod').includes(method))
          && values('AllowedHeader').includes('*') && values('ExposeHeader').some(header => header.toLowerCase() === 'etag');
      })) throw new Error('CORS_MISMATCH');
      bucket = await this.update(bucket, token, { ownershipProof: json({ ...this.proof(bucket), corsReadRequestId: requestId(readback), stage: 'configure_import_bucket' }) });
      const configured = await this.prisma.cloudAccountContext.updateMany({ where: { id: context.cloudAccountContextId!,
        cloudWorkspaceId: bucket.cloudWorkspaceId, provider: 'alibaba_cloud', accountUid: bucket.cloudAccountUid,
        regionId: bucket.regionId, status: 'ready', imageImportBucket: context.imageImportBucket },
        data: { imageImportBucket: bucket.bucketName, bucketStatus: 'ready', lastVerifiedAt: new Date(), lastError: null } });
      if (configured.count !== 1) throw new Error('CONFIG_CHANGED');
      await this.update(bucket, token, { ownershipProof: json({ ...this.proof(bucket), configuredAt: new Date().toISOString(), ledgerId: binding.ledgerId, stage: 'ready' }), errorMessage: null });
      return binding;
    } catch {
      await this.update(bucket, token, { errorMessage: 'OSS 已创建并登记费用，浏览器跨域或导入配置尚待恢复；不会再次创建。' });
      throw new ConflictException('OSS 桶已创建并登记费用，但导入配置尚待恢复；发起新的确认请求将复用原创建记录，不会再次创建。');
    }
  }
}
