import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma, type CloudImageImportBucket } from '@aliyun-cyber-range/database/generated/client';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { PrismaService } from '../database/prisma.service';
import { getCurrentCloudWorkspaceScope } from '../auth/cloud-workspace-scope';
import { SystemConfigService } from './system-config.service';
import { requestTencentCloud } from './tencent-cloud-client';
import { assertCosContext, CosContextCredentials, CosObjectRequestInput, CosPresignInput, presignCosObject, requestCos, requestCosObject, TencentCosRequestError } from './tencent-cos-client';
import { COS_BUCKET_MARKER, COS_BUCKET_PROOF_KIND, expectedCosBucketTags, ownedCosBucketProof } from './tencent-cos-proof';
import { parseCosXml, xmlChildren, xmlOne, xmlOptionalText, xmlText } from './tencent-cos-xml';

export const TENCENT_COS_BUCKETS = 'TENCENT_COS_BUCKETS';
export type ManagedCosBucket = Pick<CloudImageImportBucket, 'id' | 'bucketName' | 'cloudWorkspaceId' | 'cloudAccountContextId' | 'cloudAccountUid' | 'appId' | 'regionId'> & { cloudProvider: 'tencent_cloud' };
type BucketRequest = { bucketId: string; cloudAccountContextId: string; cloudAccountUid: string; regionId: string };
type ImportBucketRequest = { cloudAccountContextId: string; creatorUserId: string };
const requestId = (response: Response) => response.headers.get('x-cos-request-id')!;
const LEASE_MS = 300_000;
function conflict(message: string): never { throw new ConflictException(message); }
const json = (value: unknown) => value as Prisma.InputJsonValue;

@Injectable()
export class TencentCosManagedBucketService {
  private readonly importLease = new AsyncLocalStorage<{ id: string; token: string }>();
  constructor(private readonly prisma: PrismaService, private readonly config: SystemConfigService) {}

  private scope() {
    const scope = getCurrentCloudWorkspaceScope();
    if (!scope || 'system' in scope || scope.isReadOnly || scope.provider !== 'tencent_cloud' || !scope.accountUid) conflict('COS 操作需要已验证的腾讯云工作空间。');
    return scope;
  }
  private async credentials(contextId: string) {
    const scope = this.scope();
    const context = await this.config.getExecutionAccountContext({ cloudAccountContextId: contextId });
    if (context.provider !== 'tencent_cloud' || context.accountUid !== scope.accountUid || context.cloudAccountContextId !== contextId) conflict('COS 冻结账号与工作空间不一致。');
    const credentials: CosContextCredentials = Object.freeze({ id: contextId, provider: context.provider, accountUid: context.accountUid,
      regionId: context.defaultRegion, accessKeyId: context.accessKeyId, accessKeySecret: context.accessKeySecret });
    assertCosContext(credentials);
    const iam = await requestTencentCloud<{ OwnerUin?: string; Uin?: string; AppId?: number; RequestId?: string }>({ service: 'cam', version: '2019-01-16', action: 'GetUserAppId',
      accessKeyId: credentials.accessKeyId, accessKeySecret: credentials.accessKeySecret, parameters: {} });
    if (iam.OwnerUin !== credentials.accountUid || typeof iam.Uin !== 'string' || !/^\d+$/.test(iam.Uin) || !Number.isSafeInteger(iam.AppId) || !iam.AppId || iam.AppId <= 0 || !iam.RequestId) conflict('COS UID 与官方 APPID 身份未核验。');
    return { credentials: Object.freeze({ ...credentials, appId: String(iam.AppId) }), iamRequestId: iam.RequestId };
  }
  private assertIdentity(bucket: CloudImageImportBucket, credentials: CosContextCredentials) {
    const scope = this.scope();
    if (bucket.cloudWorkspaceId !== scope.cloudWorkspaceId || bucket.cloudProvider !== 'tencent_cloud' || bucket.cloudAccountUid !== scope.accountUid
      || bucket.cloudAccountUid !== credentials.accountUid || bucket.cloudAccountContextId !== credentials.id || bucket.appId !== credentials.appId
      || bucket.regionId !== credentials.regionId) conflict('COS 创建来源、UID、APPID、地域或冻结配置存在冲突。');
    assertCosContext(credentials, bucket.bucketName);
  }
  private view(bucket: CloudImageImportBucket): ManagedCosBucket {
    return { id: bucket.id, bucketName: bucket.bucketName, cloudWorkspaceId: bucket.cloudWorkspaceId, cloudProvider: 'tencent_cloud',
      cloudAccountContextId: bucket.cloudAccountContextId, cloudAccountUid: bucket.cloudAccountUid, appId: bucket.appId, regionId: bucket.regionId };
  }
  private async claim(bucket: CloudImageImportBucket) {
    const token = randomUUID();
    const claimed = await this.prisma.cloudImageImportBucket.updateMany({ where: { id: bucket.id, status: bucket.status, activeSlot: bucket.activeSlot,
      OR: [{ leaseToken: null }, { leaseExpiresAt: { lte: new Date() } }] }, data: { leaseToken: token, leaseExpiresAt: new Date(Date.now() + LEASE_MS) } });
    if (claimed.count !== 1) conflict('COS 导入桶正在处理，请稍后重试。');
    return token;
  }
  private async update(bucket: CloudImageImportBucket, token: string, data: Prisma.CloudImageImportBucketUpdateManyMutationInput) {
    const changed = await this.prisma.cloudImageImportBucket.updateMany({ where: { id: bucket.id, leaseToken: token, leaseExpiresAt: { gt: new Date() } }, data });
    if (changed.count !== 1) conflict('COS 桶租约已失效，停止云操作。');
    return (await this.prisma.cloudImageImportBucket.findUnique({ where: { id: bucket.id } }))!;
  }
  private async leased<T>(bucket: CloudImageImportBucket, callback: (token: string) => Promise<T>) {
    const token = await this.claim(bucket); let lost = false;
    const timer = setInterval(() => { void this.prisma.cloudImageImportBucket.updateMany({ where: { id: bucket.id, leaseToken: token, leaseExpiresAt: { gt: new Date() } }, data: { leaseExpiresAt: new Date(Date.now() + LEASE_MS) } })
      .then(result => { if (result.count !== 1) lost = true; }).catch(() => { lost = true; }); }, 30_000); timer.unref();
    try { const result = await this.importLease.run({ id: bucket.id, token }, () => callback(token)); if (lost) conflict('COS 桶租约已变化。'); return result; }
    finally { clearInterval(timer); await this.prisma.cloudImageImportBucket.updateMany({ where: { id: bucket.id, leaseToken: token }, data: { leaseToken: null, leaseExpiresAt: null } }); }
  }
  async ensureImportBucket(input: ImportBucketRequest) { return this.withImportBucket(input, async bucket => bucket); }
  async withImportBucket<T>(input: ImportBucketRequest, callback: (bucket: ManagedCosBucket) => Promise<T>) {
    const scope = this.scope();
    if (!input.creatorUserId || scope.actorUserId && scope.actorUserId !== input.creatorUserId) conflict('COS 创建者与当前登录身份不一致。');
    const context = await this.credentials(input.cloudAccountContextId);
    const activeSlot = createHash('sha256').update(JSON.stringify([scope.cloudWorkspaceId, 'tencent_cloud', scope.accountUid, context.credentials.regionId])).digest('hex');
    let bucket = await this.prisma.cloudImageImportBucket.findUnique({ where: { activeSlot } });
    if (!bucket) {
      const nonce = randomUUID();
      try { bucket = await this.prisma.cloudImageImportBucket.create({ data: { cloudWorkspaceId: scope.cloudWorkspaceId, cloudProvider: 'tencent_cloud', cloudAccountContextId: input.cloudAccountContextId,
        cloudAccountUid: scope.accountUid!, appId: context.credentials.appId!, regionId: context.credentials.regionId, bucketName: `for-import-${nonce.replaceAll('-', '')}-${context.credentials.appId}`,
        creationNonce: nonce, creatorUserId: input.creatorUserId, activeSlot, ownershipMarkerKey: COS_BUCKET_MARKER } }); }
      catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'P2002')) throw error;
        bucket = await this.prisma.cloudImageImportBucket.findUnique({ where: { activeSlot } }); if (!bucket) throw error; }
    }
    this.assertIdentity(bucket, context.credentials);
    return this.leased(bucket, async token => {
      const ready = await this.prepare(bucket!, context, token);
      await this.update(ready, token, { leaseExpiresAt: new Date(Date.now() + LEASE_MS) });
      return callback(this.view(ready));
    });
  }
  private async prepare(bucket: CloudImageImportBucket, context: Awaited<ReturnType<TencentCosManagedBucketService['credentials']>>, token: string) {
    if (bucket.status === 'deleted' || bucket.status === 'deleting') conflict('COS 桶正在回收，不能追加导入任务。');
    if (bucket.status === 'available' && !this.originProof(bucket)) conflict('COS 专属来源已发生冲突，不能重新接管整桶费用。');
    const { credentials } = context;
    if (!bucket.creationStartedAt) {
      const preflight = await requestCos({ contextCredentials: credentials, bucketName: bucket.bucketName, method: 'HEAD' });
      if (preflight.status !== 404) conflict('COS 目标名称已存在，不能将外部桶收录为平台创建。');
      const preflightAt = new Date();
      bucket = await this.update(bucket, token, { status: 'creating', preflightAbsentAt: preflightAt, creationStartedAt: preflightAt,
        ownershipProof: json({ preflightRequestId: requestId(preflight) }) });
      try {
        const result = await requestCos({ contextCredentials: credentials, bucketName: bucket.bucketName, method: 'PUT', body: '',
          headers: { 'x-cos-acl': 'private', 'x-cos-tagging': Object.entries(expectedCosBucketTags(bucket)).map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&') } });
        if (!result.ok) throw new TencentCosRequestError(`HTTP_${result.status}`, result.status);
        bucket = await this.update(bucket, token, { creationRequestId: requestId(result) });
      } catch {
        await this.update(bucket, token, { status: 'unknown', errorMessage: 'COS 创建结果尚待核对；保持原名称与 nonce，不重复创建。' });
        conflict('COS 创建结果尚待核对，请稍后重试原导入请求。');
      }
    }
    const proof = await this.verify(bucket, context);
    bucket = await this.acceptVerification(bucket, token, proof);
    // The new bucket can incur fees before browser access is ready; keep its proven billing identity on a CORS failure.
    await this.ledger(bucket);
    await this.update(bucket, token, { leaseExpiresAt: new Date(Date.now() + LEASE_MS) });
    const configured = await requestCos({ contextCredentials: credentials, bucketName: bucket.bucketName, method: 'PUT', query: { cors: '' }, headers: { 'content-type': 'application/xml' },
      body: '<CORSConfiguration><CORSRule><AllowedOrigin>*</AllowedOrigin><AllowedMethod>PUT</AllowedMethod><AllowedMethod>GET</AllowedMethod><AllowedMethod>HEAD</AllowedMethod><AllowedHeader>*</AllowedHeader><ExposeHeader>ETag</ExposeHeader><MaxAgeSeconds>600</MaxAgeSeconds></CORSRule></CORSConfiguration>' });
    if (!configured.ok) conflict('COS 浏览器上传跨域配置尚未确认，未返回上传地址。');
    const corsResponse = await requestCos({ contextCredentials: credentials, bucketName: bucket.bucketName, method: 'GET', query: { cors: '' } });
    if (!corsResponse.ok) conflict('COS 浏览器上传跨域配置读回失败，未返回上传地址。');
    const cors = parseCosXml(await corsResponse.text(), 'CORSConfiguration');
    const verified = xmlChildren(cors, 'CORSRule').some(rule => {
      const values = (name: string) => xmlChildren(rule, name).map(node => node.text.trim());
      const methods = values('AllowedMethod');
      return values('AllowedOrigin').includes('*') && ['PUT', 'GET', 'HEAD'].every(method => methods.includes(method))
        && values('AllowedHeader').includes('*') && values('ExposeHeader').some(header => header.toLowerCase() === 'etag');
    });
    if (!verified) conflict('COS 浏览器上传跨域配置未匹配需要的方法与签名头，未返回上传地址。');
    return bucket;
  }
  private async verify(bucket: CloudImageImportBucket, context: Awaited<ReturnType<TencentCosManagedBucketService['credentials']>>) {
    try { return await this.verifyRemote(bucket, context); }
    catch (error) {
      if (this.originProof(bucket)) {
        const transient = error instanceof TencentCosRequestError;
        await this.prisma.cloudImageImportBucket.updateMany({ where: { id: bucket.id, status: bucket.status, ownershipProof: { equals: json(bucket.ownershipProof) } },
          data: { errorMessage: 'COS 当前身份或专属使用证明待核实。', ownershipProof: json({ ...bucket.ownershipProof as Record<string, unknown>, verificationPending: transient, ...(transient ? {} : { exclusiveUsage: false }) }) } });
      }
      throw error;
    }
  }
  private async verifyRemote(bucket: CloudImageImportBucket, context: Awaited<ReturnType<TencentCosManagedBucketService['credentials']>>) {
    this.assertIdentity(bucket, context.credentials);
    const head = await requestCos({ contextCredentials: context.credentials, bucketName: bucket.bucketName, method: 'HEAD' });
    if (head.status === 404) throw new TencentCosRequestError('BUCKET_NOT_FOUND', 404);
    if (!head.ok || !bucket.preflightAbsentAt || !bucket.creationStartedAt) conflict('COS 创建来源缺少预创建 404 或当前桶身份。');
    const aclResponse = await requestCos({ contextCredentials: context.credentials, bucketName: bucket.bucketName, method: 'GET', query: { acl: '' } });
    const acl = parseCosXml(await aclResponse.text(), 'AccessControlPolicy');
    const owner = `qcs::cam::uin/${bucket.cloudAccountUid}:uin/${bucket.cloudAccountUid}`;
    const grants = xmlChildren(xmlOne(acl, 'AccessControlList'), 'Grant');
    if (xmlText(xmlOne(acl, 'Owner'), 'ID') !== owner || !grants.length || grants.some(grant => xmlText(xmlOne(grant, 'Grantee'), 'ID') !== owner || xmlText(grant, 'Permission') !== 'FULL_CONTROL')) conflict('COS 桶不属于已核验主账号或并非私有专属桶。');
    const policy = await requestCos({ contextCredentials: context.credentials, bucketName: bucket.bucketName, method: 'GET', query: { policy: '' } });
    if (policy.status !== 404) conflict('COS 桶存在额外访问策略，尚不能作为私有专属来源。');
    const tagResponse = await requestCos({ contextCredentials: context.credentials, bucketName: bucket.bucketName, method: 'GET', query: { tagging: '' } });
    const tagging = parseCosXml(await tagResponse.text(), 'Tagging'); const tags: Record<string, string> = Object.create(null);
    for (const tag of xmlChildren(xmlOne(tagging, 'TagSet'), 'Tag')) { const key = xmlText(tag, 'Key'); if (key in tags) conflict('COS 来源标签重复。'); tags[key] = xmlText(tag, 'Value'); }
    if (Object.entries(expectedCosBucketTags(bucket)).some(([key, value]) => tags[key] !== value)) conflict('COS 原子创建 nonce、账号或专属用途标签不一致。');
    let marker: string | null = null, creationDate: string | null = null, serviceRequestId: string | null = null;
    const seen = new Set<string>();
    do {
      const result = await requestCos({ contextCredentials: context.credentials, method: 'GET', query: { tagkey: bucket.ownershipMarkerKey, tagvalue: bucket.creationNonce, region: bucket.regionId, 'max-keys': '1000', ...(marker ? { marker } : {}) } });
      const data = parseCosXml(await result.text(), 'ListAllMyBucketsResult'); serviceRequestId = requestId(result);
      if (xmlText(xmlOne(data, 'Owner'), 'ID') !== owner) conflict('COS 列表的主账号身份不一致。');
      for (const row of xmlChildren(xmlOne(data, 'Buckets'), 'Bucket')) {
        if (xmlText(row, 'Name') !== bucket.bucketName) conflict('COS nonce 查询返回了其它资源。');
        if (creationDate || xmlText(row, 'Location') !== bucket.regionId) conflict('COS 创建来源或地域不唯一。');
        const value = xmlText(row, 'CreationDate'); if (!Number.isFinite(Date.parse(value))) conflict('COS 创建时间不完整。'); creationDate = new Date(value).toISOString();
      }
      marker = xmlOptionalText(data, 'NextMarker'); if (marker && (seen.has(marker) || seen.size >= 100)) conflict('COS 列表分页不完整。'); if (marker) seen.add(marker);
    } while (marker);
    if (!creationDate) conflict('COS 官方创建时间尚未取得，不能确认归属。');
    await this.verifyExclusiveObjects(bucket, context.credentials);
    const previous = bucket.ownershipProof && typeof bucket.ownershipProof === 'object' ? bucket.ownershipProof as Record<string,unknown> : null;
    if (typeof previous?.cloudCreationAt === 'string' && previous.cloudCreationAt !== creationDate) conflict('COS 同名桶的创建时间已变化，拒绝接管重建资源。');
    const preflight = bucket.ownershipProof && typeof bucket.ownershipProof === 'object' ? bucket.ownershipProof as Record<string,unknown> : {};
    const proof = { ...preflight, kind: COS_BUCKET_PROOF_KIND, bucketId: bucket.id, cloudWorkspaceId: bucket.cloudWorkspaceId, cloudProvider: 'tencent_cloud', cloudAccountContextId: bucket.cloudAccountContextId,
      cloudAccountUid: bucket.cloudAccountUid, appId: bucket.appId, regionId: bucket.regionId, bucketName: bucket.bucketName, creationNonce: bucket.creationNonce,
      creatorUserId: bucket.creatorUserId, ownershipMarkerKey: bucket.ownershipMarkerKey, preflightAbsentAt: bucket.preflightAbsentAt.toISOString(), creationStartedAt: bucket.creationStartedAt.toISOString(),
      cloudCreationAt: creationDate, ownerId: owner, aclPrivate: true, policyAbsent: true, exclusiveUsage: true, verificationPending: false, atomicTags: tags, verifiedAt: new Date().toISOString(),
      iamRequestId: context.iamRequestId, headRequestId: requestId(head), aclRequestId: requestId(aclResponse), tagRequestId: requestId(tagResponse), serviceRequestId };
    if (!ownedCosBucketProof({ ...bucket, status: 'available', ownershipProof: proof })) conflict('COS 创建证明的时间或身份范围不完整。');
    return proof;
  }
  private async acceptVerification(bucket: CloudImageImportBucket, token: string, proof: Record<string,unknown>) {
    const changed = await this.prisma.cloudImageImportBucket.updateMany({ where: { id: bucket.id, leaseToken: token, leaseExpiresAt: { gt: new Date() }, status: bucket.status,
      ownershipProof: { equals: json(bucket.ownershipProof) } }, data: { status: bucket.status === 'deleting' ? 'deleting' : 'available', ownershipProof: json(proof), errorMessage: null } });
    if (changed.count !== 1) conflict('COS 来源证明或租约在核验期间已变化。');
    return (await this.prisma.cloudImageImportBucket.findUnique({ where: { id: bucket.id } }))!;
  }
  private async ledger(bucket: CloudImageImportBucket, releasedAt?: Date) {
    if (!ownedCosBucketProof(bucket)) conflict('COS 计费台账需要准确的平台创建证明。');
    const where = { cloudWorkspaceId_cloudProvider_regionId_cloudResourceId_cloudResourceType: { cloudWorkspaceId: bucket.cloudWorkspaceId, cloudProvider: 'tencent_cloud' as const,
      regionId: bucket.regionId, cloudResourceId: bucket.bucketName, cloudResourceType: 'oss_bucket' as const } };
    const existing = await this.prisma.billingLedgerResource.findUnique({ where });
    if (existing) {
      const tags = existing.tagsSnapshot as Record<string,unknown>;
      if (existing.cloudAccountUid !== bucket.cloudAccountUid || existing.billingScope !== 'platform' || existing.ownerUserId || tags.PlatformManagedImportBucketId !== bucket.id) conflict('COS 计费来源与已有台账冲突。');
      if (releasedAt) await this.prisma.billingLedgerResource.update({ where: { id: existing.id }, data: { releasedAt } });
    } else await this.prisma.billingLedgerResource.create({ data: { cloudWorkspaceId: bucket.cloudWorkspaceId, cloudProvider: 'tencent_cloud', cloudAccountUid: bucket.cloudAccountUid,
      regionId: bucket.regionId, cloudResourceId: bucket.bucketName, cloudResourceType: 'oss_bucket', billingScope: 'platform', billingStartAt: new Date(String(ownedCosBucketProof(bucket)!.cloudCreationAt)),
      ...(releasedAt ? { releasedAt } : {}), tagsSnapshot: { PlatformManagedImportBucketId: bucket.id } } });
  }
  async getOwnedBucket(input: BucketRequest): Promise<ManagedCosBucket> {
    this.scope();
    const bucket = await this.prisma.cloudImageImportBucket.findUnique({ where: { id: input.bucketId } });
    if (!bucket || !['available', 'deleting'].includes(bucket.status) || !this.originProof(bucket)
      || bucket.cloudAccountContextId !== input.cloudAccountContextId || bucket.cloudAccountUid !== input.cloudAccountUid || bucket.regionId !== input.regionId) conflict('COS 持久来源证明或冻结身份不一致。');
    const context = await this.credentials(input.cloudAccountContextId);
    const proof = await this.verify(bucket, context);
    if ((bucket.ownershipProof as Record<string,unknown>).verificationPending === true) {
      const restored = await this.prisma.cloudImageImportBucket.updateMany({ where: { id: bucket.id, status: bucket.status, ownershipProof: { equals: json(bucket.ownershipProof) } }, data: { ownershipProof: json(proof), errorMessage: null } });
      if (restored.count !== 1) conflict('COS 来源证明在核验期间已变化，请重新读取。');
    }
    const current = await this.prisma.cloudImageImportBucket.findUnique({ where: { id: bucket.id } });
    if (!current || !ownedCosBucketProof(current)) conflict('COS 来源证明在核验期间已变化，请重新读取。');
    return this.view(current);
  }
  private originProof(bucket: CloudImageImportBucket) {
    const proof = bucket.ownershipProof;
    if (!proof || typeof proof !== 'object' || Array.isArray(proof)) return null;
    return ownedCosBucketProof({ ...bucket, ownershipProof: { ...proof, verificationPending: false } });
  }
  private async objectBucket(input: CosObjectRequestInput | CosPresignInput) {
    this.scope(); const bucket = await this.prisma.cloudImageImportBucket.findUnique({ where: { bucketName: input.bucketName } });
    if (!bucket || !ownedCosBucketProof(bucket) || !['available', 'deleting'].includes(bucket.status)) conflict('COS 对象缺少平台创建来源。');
    const held = this.importLease.getStore();
    if (held?.id === bucket.id && (bucket.leaseToken !== held.token || !bucket.leaseExpiresAt || bucket.leaseExpiresAt <= new Date())) conflict('COS 导入回调租约已失效。');
    if (input.contextCredentials.appId && input.contextCredentials.appId !== bucket.appId) conflict('COS 对象 APPID 与持久来源不一致。');
    const credentials = Object.freeze({ ...input.contextCredentials, appId: bucket.appId }); this.assertIdentity(bucket, credentials);
    if ('expiresAt' in input && input.method === 'PUT' && bucket.status !== 'available') conflict('COS 桶回收期间不能上传。');
    return credentials;
  }
  async presignObject(input: CosPresignInput) { return presignCosObject({ ...input, contextCredentials: await this.objectBucket(input) }); }
  async requestObject(input: CosObjectRequestInput) { return requestCosObject({ ...input, contextCredentials: await this.objectBucket(input) }); }
  private async verifyExclusiveObjects(bucket: CloudImageImportBucket, credentials: CosContextCredentials) {
    const jobs = await this.prisma.imageImportJob.findMany({ where: { managedBucketId: bucket.id } });
    let marker: string | null = null; const seen = new Set<string>(); const currentEtags = new Map<string,string>();
    do {
      const response = await requestCos({ contextCredentials: credentials, bucketName: bucket.bucketName, method: 'GET', query: { 'max-keys': '1000', ...(marker ? { marker } : {}) } });
      const data = parseCosXml(await response.text(), 'ListBucketResult');
      if (xmlText(data, 'Name') !== bucket.bucketName) conflict('COS 专属使用清单身份不一致。');
      for (const object of xmlChildren(data, 'Contents')) {
        const key = xmlText(object, 'Key');
        const job = jobs.find(job => job.objectKey === key && job.cloudProvider === 'tencent_cloud' && job.cloudWorkspaceId === bucket.cloudWorkspaceId
          && job.cloudAccountContextId === bucket.cloudAccountContextId && job.cloudAccountUid === bucket.cloudAccountUid && job.regionId === bucket.regionId && job.imageImportBucket === bucket.bucketName);
        if (!job) conflict('COS 桶中存在未归属平台导入任务的对象，不能将整桶费用归平台。');
        const head = await requestCosObject({ contextCredentials: credentials, bucketName: bucket.bucketName, objectKey: key, method: 'HEAD' });
        const proof = job.sourceObjectProof && typeof job.sourceObjectProof === 'object' ? job.sourceObjectProof as Record<string,unknown> : null;
        if (!head.ok || head.headers.get('x-cos-meta-platform-image-job') !== job.id || head.headers.get('x-cos-meta-platform-image-owner') !== job.ownerUserId
          || head.headers.get('x-cos-meta-platform-cloud-context') !== job.cloudAccountContextId || Number(head.headers.get('content-length')) !== Number(job.sourceSizeBytes)
          || !head.headers.get('etag') || proof?.etag && proof.etag !== head.headers.get('etag')) conflict('COS 对象大小、owner 或任务来源不完整。');
        currentEtags.set(key, head.headers.get('etag')!);
      }
      const truncated = xmlText(data, 'IsTruncated'); if (!['true', 'false'].includes(truncated)) conflict('COS 专属清单分页不完整。');
      if (truncated === 'false') break;
      marker = xmlOptionalText(data, 'NextMarker'); if (!marker || seen.has(marker) || seen.size >= 100) conflict('COS 专属清单分页缺失。'); seen.add(marker);
    } while (marker);
    // List versions can include the unversioned current object; historical versions and deletion markers are unverified usage.
    let keyMarker: string | null = null, versionMarker: string | null = null; const versionPages = new Set<string>();
    do {
      const response = await requestCos({ contextCredentials: credentials, bucketName: bucket.bucketName, method: 'GET', query: { versions: '', 'max-keys': '1000',
        ...(keyMarker ? { 'key-marker': keyMarker } : {}), ...(versionMarker ? { 'version-id-marker': versionMarker } : {}) } });
      const versions = parseCosXml(await response.text(), 'ListVersionsResult');
      if (xmlText(versions, 'Name') !== bucket.bucketName || xmlChildren(versions, 'DeleteMarker').length) conflict('COS 存在未核验的历史删除标记。');
      for (const version of xmlChildren(versions, 'Version')) {
        const key = xmlText(version, 'Key');
        if (xmlText(version, 'IsLatest') !== 'true' || xmlText(version, 'VersionId') !== 'null' || !currentEtags.has(key) || xmlText(version, 'ETag') !== currentEtags.get(key)) conflict('COS 历史版本或当前对象证明不一致。');
      }
      const truncated = xmlText(versions, 'IsTruncated'); if (!['true', 'false'].includes(truncated)) conflict('COS 版本清单分页不完整。'); if (truncated === 'false') break;
      keyMarker = xmlOptionalText(versions, 'NextKeyMarker'); versionMarker = xmlOptionalText(versions, 'NextVersionIdMarker');
      const page = JSON.stringify([keyMarker, versionMarker]); if (!keyMarker || versionPages.has(page) || versionPages.size >= 100) conflict('COS 版本清单分页缺失。'); versionPages.add(page);
    } while (keyMarker);
    if (!await this.emptyInventory(bucket, credentials, 'uploads')) conflict('COS 存在未完成分片，专属使用尚待核对。');
  }

  private async activeJobs(bucket: CloudImageImportBucket) {
    return this.prisma.imageImportJob.count({ where: { managedBucketId: bucket.id, OR: [{ status: { in: ['awaiting_upload', 'importing'] } },
      { temporaryObjectDeletedAt: null }, { uploadExpiresAt: { gt: new Date() } }] } });
  }
  private async emptyInventory(bucket: CloudImageImportBucket, credentials: CosContextCredentials, kind: 'objects' | 'versions' | 'uploads') {
    let marker: string | null = null, secondMarker: string | null = null; const seen = new Set<string>();
    do {
      const query: Record<string,string> = kind === 'versions' ? { versions: '', 'max-keys': '1000', ...(marker ? { 'key-marker': marker } : {}), ...(secondMarker ? { 'version-id-marker': secondMarker } : {}) }
        : kind === 'uploads' ? { uploads: '', 'max-uploads': '1000', ...(marker ? { 'key-marker': marker } : {}), ...(secondMarker ? { 'upload-id-marker': secondMarker } : {}) }
        : { 'max-keys': '1000', ...(marker ? { marker } : {}) };
      const response = await requestCos({ contextCredentials: credentials, bucketName: bucket.bucketName, method: 'GET', query });
      if (!response.ok) conflict('COS 桶清单尚未完整核验，保留来源记录。');
      const root = parseCosXml(await response.text(), kind === 'versions' ? 'ListVersionsResult' : kind === 'uploads' ? 'ListMultipartUploadsResult' : 'ListBucketResult');
      if (xmlText(root, kind === 'uploads' ? 'Bucket' : 'Name') !== bucket.bucketName) conflict('COS 桶清单身份不一致。');
      const count = kind === 'objects' ? xmlChildren(root, 'Contents').length
        : kind === 'versions' ? xmlChildren(root, 'Version').length + xmlChildren(root, 'DeleteMarker').length : xmlChildren(root, 'Upload').length;
      if (count) return false;
      const truncated = xmlText(root, 'IsTruncated'); if (!['true', 'false'].includes(truncated)) conflict('COS 清单分页状态不完整。');
      if (truncated === 'false') return true;
      marker = xmlOptionalText(root, kind === 'objects' ? 'NextMarker' : 'NextKeyMarker');
      secondMarker = kind === 'objects' ? null : xmlOptionalText(root, kind === 'versions' ? 'NextVersionIdMarker' : 'NextUploadIdMarker');
      const key = JSON.stringify([marker, secondMarker]);
      if (!marker || seen.has(key) || seen.size >= 100) conflict('COS 清单分页缺失或重复，未删除桶。'); seen.add(key);
    } while (marker);
    return false;
  }
  async cleanupIfIdle(input: BucketRequest) {
    this.scope();
    const bucket = await this.prisma.cloudImageImportBucket.findUnique({ where: { id: input.bucketId } });
    if (!bucket || bucket.status === 'deleted') return { status: 'deleted' };
    if (bucket.cloudAccountContextId !== input.cloudAccountContextId || bucket.cloudAccountUid !== input.cloudAccountUid || bucket.regionId !== input.regionId) conflict('COS 回收目标与冻结来源不一致。');
    if (!ownedCosBucketProof(bucket)) return { status: 'pending_proof' };
    if (bucket.leaseToken && bucket.leaseExpiresAt && bucket.leaseExpiresAt > new Date()) return { status: 'busy' };
    const context = await this.credentials(input.cloudAccountContextId); this.assertIdentity(bucket, context.credentials);
    return this.leased(bucket, async token => {
      let current = bucket;
      if (await this.activeJobs(current)) return { status: 'active_jobs' };
      const head = await requestCos({ contextCredentials: context.credentials, bucketName: bucket.bucketName, method: 'HEAD' });
      if (head.status === 404) return this.finishDeletion(current, token);
      const proof = ownedCosBucketProof(current)!;
      // A timed-out DELETE may have reached COS; subsequent ticks only check absence, never issue it again.
      if (proof.deletionRequestedAt && proof.deletionOutcome !== 'rejected') return { status: 'deleting' };
      await this.verify(current, context);
      if (await this.activeJobs(current)) return { status: 'active_jobs' };
      for (const kind of ['objects', 'versions', 'uploads'] as const) {
        if (!await this.emptyInventory(current, context.credentials, kind)) return { status: `nonempty_${kind}` };
      }
      if (await this.activeJobs(current)) return { status: 'active_jobs' };
      current = await this.update(current, token, { status: 'deleting', ownershipProof: json({ ...proof, deletionRequestedAt: new Date().toISOString(), deletionOutcome: 'pending' }) });
      try {
        const result = await requestCos({ contextCredentials: context.credentials, bucketName: current.bucketName, method: 'DELETE' });
        current = await this.update(current, token, { ownershipProof: json({ ...current.ownershipProof as Record<string,unknown>, deletionRequestId: requestId(result), deletionOutcome: 'accepted' }) });
      } catch (error) {
        const rejected = error instanceof TencentCosRequestError && error.status && error.status >= 400 && error.status < 500;
        await this.update(current, token, { errorMessage: 'COS 桶删除结果尚待核对，来源记录保留。', ownershipProof: json({ ...current.ownershipProof as Record<string,unknown>, deletionOutcome: rejected ? 'rejected' : 'unknown' }) });
        return { status: 'deleting' };
      }
      const after = await requestCos({ contextCredentials: context.credentials, bucketName: current.bucketName, method: 'HEAD' });
      return after.status === 404 ? this.finishDeletion(current, token) : { status: 'deleting' };
    });
  }
  private async finishDeletion(bucket: CloudImageImportBucket, token: string) {
    const deletedAt = new Date();
    const changed = await this.update(bucket, token, { status: 'deleted', activeSlot: null, deletedAt, errorMessage: null });
    await this.ledger(changed, deletedAt);
    return { status: 'deleted' };
  }
  async refreshPendingBuckets() {
    const scope = getCurrentCloudWorkspaceScope();
    if (!scope) conflict('COS 恢复扫描需要明确系统或工作空间边界。');
    const rows = await this.prisma.cloudImageImportBucket.findMany({ where: { cloudProvider: 'tencent_cloud', activeSlot: { not: null }, status: { in: ['creating', 'unknown', 'available', 'deleting'] } }, orderBy: { updatedAt: 'asc' }, take: 100 });
    let reconciled = 0;
    for (const row of rows) {
      const work = async () => {
        const source = this.scope();
        if (source.cloudWorkspaceId !== row.cloudWorkspaceId || source.accountUid !== row.cloudAccountUid) conflict('COS 恢复扫描来源与工作空间不一致。');
        if (row.leaseToken && row.leaseExpiresAt && row.leaseExpiresAt > new Date()) return;
        if (['creating', 'unknown'].includes(row.status) || (this.originProof(row) && (row.ownershipProof as Record<string,unknown>)?.verificationPending === true)) {
          const context = await this.credentials(row.cloudAccountContextId); this.assertIdentity(row, context.credentials);
          await this.leased(row, async token => {
            const head = await requestCos({ contextCredentials: context.credentials, bucketName: row.bucketName, method: 'HEAD' });
            if (head.status === 404) {
              // An already-proven source can be released after confirmed absence; an unknown create is never retried.
              if (this.originProof(row) && !await this.activeJobs(row)) {
                const absent = await this.update(row, token, { ownershipProof: json({ ...row.ownershipProof as Record<string,unknown>, verificationPending: false }) });
                await this.finishDeletion(absent, token); reconciled++;
              }
              return;
            }
            const proof = await this.verify(row, context);
            const ready = await this.acceptVerification(row, token, proof);
            await this.ledger(ready); reconciled++;
          });
        }
        await this.cleanupIfIdle({ bucketId: row.id, cloudAccountContextId: row.cloudAccountContextId, cloudAccountUid: row.cloudAccountUid, regionId: row.regionId });
      };
      try { if ('system' in scope) await this.config.runInWorkspace(row.cloudWorkspaceId, work); else await work(); }
      catch { /* Durable pending state remains for the next verified worker tick. */ }
    }
    return { discovered: rows.length, reconciled };
  }
}
