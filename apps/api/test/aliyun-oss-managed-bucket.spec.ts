import { ForbiddenException } from '@nestjs/common';
import { validate } from 'class-validator';
import { runInCloudWorkspace } from '../src/auth/cloud-workspace-scope';
import { AliyunOssManagedBucketService } from '../src/admin/aliyun-oss-managed-bucket.service';
import { BillingOssBindingController } from '../src/admin/billing-oss-binding.controller';
import { BillingOssBindingService } from '../src/admin/billing-oss-binding.service';
import { aliyunOssBindingCoversBillingDay, readAliyunOssDedicatedBilling } from '../src/admin/billing-oss-binding-proof';
import { CreateBillingOssBucketDto } from '../src/admin/dto/billing-oss-binding.dto';
import type { SystemCloudAccountContext } from '../src/admin/system-config.service';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';

const scope = { cloudWorkspaceId: 'create-oss-space', provider: 'alibaba_cloud' as const, accountUid: '1672470067548805',
  cloudAccountContextId: 'create-oss-context', actorUserId: 'manager', isPlatformManager: true };
const payload = { dedicated: true as const };
const cutoff = process.env.PLATFORM_BILLING_STARTED_AT;
const CORS = '<CORSConfiguration><CORSRule><AllowedOrigin>*</AllowedOrigin><AllowedMethod>PUT</AllowedMethod><AllowedMethod>GET</AllowedMethod><AllowedMethod>HEAD</AllowedMethod><AllowedHeader>*</AllowedHeader><ExposeHeader>ETag</ExposeHeader></CORSRule></CORSConfiguration>';

function fixture() {
  const context: SystemCloudAccountContext = { provider: 'alibaba_cloud', accountUid: scope.accountUid, accountUidResolved: true,
    cloudAccountContextId: scope.cloudAccountContextId, defaultRegion: 'cn-hangzhou', defaultZoneId: 'cn-hangzhou-h',
    imageImportBucket: '', accessKeyId: 'fixture-key', accessKeySecret: 'fixture-secret' };
  let row: any = null;
  const copy = (value: any) => value && structuredClone(value);
  const prisma = { cloudImageImportBucket: {
    findUnique: jest.fn(async ({ where }: any) => row && Object.entries(where).every(([key, value]) => row[key] === value) ? copy(row) : null),
    create: jest.fn(async ({ data }: any) => {
      if (row) throw { code: 'P2002' };
      row = { id: 'oss-create-id', status: 'pending', preflightAbsentAt: null, creationStartedAt: null, creationRequestId: null,
        leaseToken: null, leaseExpiresAt: null, deletedAt: null, createdAt: new Date(), updatedAt: new Date(), ...data };
      return copy(row);
    }),
    updateMany: jest.fn(async ({ where, data }: any) => {
      const matched = row && Object.entries(where).every(([key, value]: any) => key === 'OR' ? value.some((predicate: any) =>
        predicate.leaseToken === null ? row.leaseToken === null : row.leaseExpiresAt <= predicate.leaseExpiresAt.lte)
        : key === 'leaseExpiresAt' ? row.leaseExpiresAt > value.gt : row[key] === value);
      if (!matched) return { count: 0 };
      Object.assign(row, data, { updatedAt: new Date() }); return { count: 1 };
    }),
  }, cloudAccountContext: { updateMany: jest.fn(async ({ where, data }: any) => {
    if (where.cloudWorkspaceId !== scope.cloudWorkspaceId || where.accountUid !== context.accountUid || where.regionId !== context.defaultRegion
      || where.id !== context.cloudAccountContextId || where.imageImportBucket !== context.imageImportBucket) return { count: 0 };
    context.imageImportBucket = data.imageImportBucket; return { count: 1 };
  }) } };
  const repository = createMemoryAdminRepository();
  const config = { getSelectedAccountContext: jest.fn(async () => ({ ...context })) };
  const bindings = new BillingOssBindingService(repository, config as never);
  const service = new AliyunOssManagedBucketService(prisma as never, bindings);
  let remoteName = '', birth = '2026-10-12T03:04:00.000Z', owner = scope.accountUid, privateAcl = true;
  let unknown = false, unknownAbsent = false, rejected = false, corsFail = false, stsOwner = scope.accountUid, preExisting = false, nonEmpty = false;
  let remoteTags: Record<string, string> = {}, overrideTags: Record<string, string> | null = null;
  let creates = 0;
  const xml = (name: string) => `<BucketInfo><Bucket><Name>${name}</Name><Location>oss-cn-hangzhou</Location><StorageClass>Standard</StorageClass><CreationDate>${birth}</CreationDate><Owner><ID>${owner}</ID></Owner></Bucket></BucketInfo>`;
  const response = (body: string, status = 200) => new Response(body, { status, headers: { 'x-oss-request-id': `fixture-${status}` } });
  const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, options) => {
    const url = new URL(String(input));
    if (url.hostname === 'sts.aliyuncs.com') return new Response(JSON.stringify({ AccountId: stsOwner, RequestId: 'sts-proof' }));
    const name = url.hostname.split('.')[0]!;
    if (options?.method === 'PUT' && !url.search) {
      creates++;
      if (rejected) return response('<Error><Code>BucketAlreadyExists</Code></Error>', 409);
      if (!unknownAbsent) {
        remoteName = name;
        remoteTags = Object.fromEntries(new URLSearchParams((options?.headers as Record<string, string>)['x-oss-bucket-tagging']));
      }
      if (unknown) { unknown = false; throw new Error('timeout'); }
      return response('');
    }
    if (url.search === '?bucketInfo') return remoteName === name || preExisting ? response(xml(name)) : response('<Error><Code>NoSuchBucket</Code></Error>', 404);
    if (url.search === '?acl') return response(`<AccessControlPolicy><Owner><ID>${owner}</ID></Owner><AccessControlList><Grant>${privateAcl ? 'private' : 'public-read'}</Grant></AccessControlList></AccessControlPolicy>`);
    if (url.search === '?tagging') return response(`<Tagging><TagSet>${Object.entries(overrideTags ?? remoteTags).map(([key, value]) => `<Tag><Key>${key}</Key><Value>${value}</Value></Tag>`).join('')}</TagSet></Tagging>`);
    if (url.search === '?cors' && options?.method === 'PUT') return response('', corsFail ? 403 : 200);
    if (url.search === '?cors') return response(CORS);
    if (!url.search && options?.method === 'GET') return response(`<ListBucketResult><Name>${name}</Name><IsTruncated>false</IsTruncated>${nonEmpty ? '<Contents><Key>other-business</Key></Contents>' : ''}</ListBucketResult>`);
    throw new Error('Unexpected OSS request');
  });
  return { service, bindings, repository, prisma, context, fetchMock, row: () => copy(row), creates: () => creates,
    create: () => runInCloudWorkspace(scope, () => service.create(payload)),
    ledger: () => runInCloudWorkspace(scope, async () => (await repository.listBillingLedgerResources())[0]),
    settings: (values: { unknown?: boolean; unknownAbsent?: boolean; rejected?: boolean; corsFail?: boolean; stsOwner?: string; owner?: string; privateAcl?: boolean; preExisting?: boolean; birth?: string; nonEmpty?: boolean; tags?: Record<string, string> }) => {
      if (values.unknown !== undefined) unknown = values.unknown; if (values.unknownAbsent !== undefined) unknownAbsent = values.unknownAbsent;
      if (values.rejected !== undefined) rejected = values.rejected; if (values.corsFail !== undefined) corsFail = values.corsFail;
      if (values.stsOwner !== undefined) stsOwner = values.stsOwner; if (values.owner !== undefined) owner = values.owner;
      if (values.privateAcl !== undefined) privateAcl = values.privateAcl; if (values.preExisting !== undefined) preExisting = values.preExisting;
      if (values.birth !== undefined) birth = values.birth;
      if (values.nonEmpty !== undefined) nonEmpty = values.nonEmpty;
      if (values.tags !== undefined) overrideTags = values.tags;
    } };
}

beforeEach(() => { jest.useFakeTimers().setSystemTime(new Date('2026-10-12T03:04:00.123Z')); process.env.PLATFORM_BILLING_STARTED_AT = '2026-09-30T16:00:00.000Z'; });
afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); if (cutoff === undefined) delete process.env.PLATFORM_BILLING_STARTED_AT; else process.env.PLATFORM_BILLING_STARTED_AT = cutoff; });

it('creates one private Standard bucket, freezes actual origin, registers billing before CORS, then binds import configuration', async () => {
  const f = fixture();
  const bound = await f.create();
  const row = f.row();
  expect(row).toMatchObject({ appId: 'not-applicable', status: 'available', cloudProvider: 'alibaba_cloud', cloudWorkspaceId: scope.cloudWorkspaceId,
    creatorUserId: scope.actorUserId, creationRequestId: 'fixture-200', leaseToken: null });
  expect(bound).toMatchObject({ bucketName: row.bucketName, effectiveStartAt: '2026-10-12T03:04:00.000Z' });
  expect(f.context.imageImportBucket).toBe(row.bucketName);
  expect(f.prisma.cloudAccountContext.updateMany).toHaveBeenCalledWith({ where: expect.objectContaining({ cloudWorkspaceId: scope.cloudWorkspaceId,
    provider: 'alibaba_cloud', accountUid: scope.accountUid, regionId: 'cn-hangzhou', imageImportBucket: '' }), data: expect.objectContaining({ imageImportBucket: row.bucketName, bucketStatus: 'ready' }) });
  const proof = readAliyunOssDedicatedBilling(await f.ledger())!;
  expect(proof.platformCreation).toMatchObject({ managedBucketId: row.id, creationRequestId: 'fixture-200', preflightRequestId: 'fixture-404', storageClass: 'Standard' });
  expect(aliyunOssBindingCoversBillingDay(proof, '2026-10-11')).toBe(false);
  expect(aliyunOssBindingCoversBillingDay(proof, '2026-10-12')).toBe(true);
  expect(await f.create()).toEqual(bound);
  expect(f.creates()).toBe(1);
  const [, put] = f.fetchMock.mock.calls.find(([url, options]) => options?.method === 'PUT' && !new URL(String(url)).search)!;
  expect(put).toMatchObject({ body: expect.stringContaining('<StorageClass>Standard</StorageClass>'), redirect: 'error',
    headers: { 'x-oss-acl': 'private', 'x-oss-bucket-tagging': expect.stringContaining(row.creationNonce), 'Content-MD5': expect.any(String) } });
  expect(bound).not.toHaveProperty('creationNonce'); expect(bound).not.toHaveProperty('leaseToken');
});

it('accepted timeout recovers only matching atomically tagged original name and nonce; unconfirmed first day remains pending', async () => {
  const f = fixture(); f.settings({ unknown: true });
  await expect(f.create()).rejects.toThrow('结果未知');
  const original = f.row();
  const recovered = await f.create();
  expect(recovered.bucketName).toBe(original.bucketName); expect(f.creates()).toBe(1);
  const proof = readAliyunOssDedicatedBilling(await f.ledger())!;
  expect(proof.platformCreation!.creationRequestId).toBeNull();
  expect(aliyunOssBindingCoversBillingDay(proof, '2026-10-12')).toBe(false);
  expect(aliyunOssBindingCoversBillingDay(proof, '2026-10-13')).toBe(true);
  expect(proof.platformCreation).toMatchObject({ taggingRequestId: 'fixture-200', taggingVerifiedAt: expect.any(String),
    atomicTags: { PlatformManagedBucketId: original.id, PlatformCreationNonce: original.creationNonce, CloudWorkspaceId: scope.cloudWorkspaceId } });
});

it('timeout without actual creation never re-dispatches, and a later untagged manually created namesake is not adopted', async () => {
  const f = fixture(); f.settings({ unknown: true, unknownAbsent: true });
  await expect(f.create()).rejects.toThrow('结果未知');
  const original = f.row();
  await expect(f.create()).rejects.toThrow('尚待身份核验');
  f.settings({ preExisting: true });
  await expect(f.create()).rejects.toThrow('原子创建标签');
  expect(f.creates()).toBe(1); expect(f.row().creationNonce).toBe(original.creationNonce);
  expect(await f.ledger()).toBeUndefined(); expect(f.context.imageImportBucket).toBe('');
  expect(f.fetchMock.mock.calls.some(([url, options]) => new URL(String(url)).search === '?cors' && options?.method === 'PUT')).toBe(false);
});

it.each(['missing', 'nonce', 'late_birth'] as const)('unknown recovery rejects unrelated namesake evidence: %s', async failure => {
  const f = fixture(); f.settings({ unknown: true }); await expect(f.create()).rejects.toThrow('结果未知');
  const original = f.row();
  if (failure === 'missing') f.settings({ tags: {} });
  if (failure === 'nonce') f.settings({ tags: { PlatformManagedBucketId: original.id, PlatformCreationNonce: 'wrong-nonce', CloudWorkspaceId: scope.cloudWorkspaceId } });
  if (failure === 'late_birth') { f.settings({ birth: '2026-10-12T03:10:00.000Z' }); jest.setSystemTime(new Date('2026-10-12T04:00:00Z')); }
  await expect(f.create()).rejects.toThrow();
  expect(f.creates()).toBe(1); expect(f.row().status).toBe('unknown'); expect(await f.ledger()).toBeUndefined();
  expect(f.context.imageImportBucket).toBe(''); expect(f.prisma.cloudAccountContext.updateMany).not.toHaveBeenCalled();
  expect(f.fetchMock.mock.calls.some(([url]) => new URL(String(url)).search === '?cors')).toBe(false);
});

it('successful PUT still requires official matching atomic tags before CORS, configuration or ledger registration', async () => {
  const f = fixture(); f.settings({ tags: {} });
  await expect(f.create()).rejects.toThrow('原子创建标签');
  expect(f.row().creationRequestId).toBe('fixture-200'); expect(f.creates()).toBe(1);
  expect(await f.ledger()).toBeUndefined(); expect(f.prisma.cloudAccountContext.updateMany).not.toHaveBeenCalled();
  expect(f.fetchMock.mock.calls.some(([url]) => new URL(String(url)).search === '?cors')).toBe(false);
});

it('CORS failure retains exact resource and billing evidence and restores configuration without another create', async () => {
  const f = fixture(); f.settings({ corsFail: true });
  await expect(f.create()).rejects.toThrow('已创建并登记费用');
  const original = f.row(); const ledger = await f.ledger();
  expect(readAliyunOssDedicatedBilling(ledger)).not.toBeNull(); expect(f.context.imageImportBucket).toBe('');
  f.settings({ corsFail: false });
  expect((await f.create()).ledgerId).toBe(ledger.id); expect(f.creates()).toBe(1); expect(f.row().id).toBe(original.id);
});

it.each([{ rejected: true }, { preExisting: true }])('never takes over an existing name or retries a rejected create %j', async settings => {
  const f = fixture(); f.settings(settings);
  await expect(f.create()).rejects.toThrow(); const attempted = f.creates();
  expect(f.row().status).toBe('rejected'); expect(await f.ledger()).toBeUndefined();
  await expect(f.create()).rejects.toThrow('不会接管'); expect(f.creates()).toBe(attempted);
});

it.each([{ owner: '999' }, { privateAcl: false }, { birth: '2026-10-11T00:00:00.000Z' }, { nonEmpty: true }])('rejects wrong cloud ownership, ACL, birth or unproved contents without registering fees %j', async settings => {
  const f = fixture(); f.settings(settings); await expect(f.create()).rejects.toThrow();
  expect(await f.ledger()).toBeUndefined(); expect(f.context.imageImportBucket).toBe(''); expect(f.creates()).toBe(1);
});

it('rejects wrong STS owner and non-manager before any creation intent or OSS write', async () => {
  const f = fixture(); f.settings({ stsOwner: '999' }); await expect(f.create()).rejects.toThrow('主账号身份未确认');
  expect(f.row()).toBeNull(); expect(f.creates()).toBe(0);
  await expect(runInCloudWorkspace({ ...scope, isPlatformManager: false }, () => f.service.create(payload))).rejects.toBeInstanceOf(ForbiddenException);
});

it('confirmation requires explicit dedicated declaration and reports retained resource without dispatching cloud operations', async () => {
  const f = fixture();
  expect(await validate(Object.assign(new CreateBillingOssBucketDto(), payload))).toHaveLength(0);
  expect(await validate(Object.assign(new CreateBillingOssBucketDto(), {}))).not.toHaveLength(0);
  expect(await runInCloudWorkspace(scope, () => f.service.confirmation(payload))).toMatchObject({ summary: { quantity: 1, retainedForPlatform: true } });
  expect(f.fetchMock).not.toHaveBeenCalled(); expect(f.row()).toBeNull();
  const operations = { executeConfirmed: jest.fn(async (input: any) => input.toolName), audit: jest.fn() };
  const controller = new BillingOssBindingController(f.bindings, operations as never, f.service);
  const request = { headers: {}, adminUser: { id: 'manager', isPlatformManager: true }, authContext: { source: 'mcp', oauthClientId: 'mcp' } };
  expect(await runInCloudWorkspace(scope, () => controller.create(request as never, payload))).toBe('billing_oss_bucket_create');
  expect(operations.executeConfirmed).toHaveBeenCalledWith(expect.objectContaining({ toolName: 'billing_oss_bucket_create', arguments: payload }));
});

it('holds one lease for simultaneous creates and never assigns a configured unrelated bucket', async () => {
  const f = fixture();
  const results = await Promise.allSettled([f.create(), f.create()]);
  expect(results.filter(value => value.status === 'fulfilled')).toHaveLength(1); expect(f.creates()).toBe(1);
  const foreign = fixture(); foreign.context.imageImportBucket = 'another-business';
  await expect(foreign.create()).rejects.toThrow('其他 OSS 桶'); expect(foreign.creates()).toBe(0); expect(foreign.row()).toBeNull();
});

it.each(['creationNonce', 'preflightRequestId', 'creationStartedAt', 'ownerUid', 'storageClass'] as const)('cannot use malformed creation evidence to cover first-day fees: %s', async key => {
  const f = fixture(); await f.create(); const ledger = await f.ledger();
  const proof = ledger.tagsSnapshot.aliyunOssDedicatedBilling as any;
  const broken = { ...proof, platformCreation: { ...proof.platformCreation, [key]: key === 'preflightRequestId' ? '' : 'unrelated' } };
  expect(readAliyunOssDedicatedBilling({ ...ledger, tagsSnapshot: { aliyunOssDedicatedBilling: broken } })).toBeNull();
  expect(aliyunOssBindingCoversBillingDay(broken, '2026-10-12')).toBe(false);
});

it('never uses native creation proof to backfill beyond the global cutoff or into another billing day', async () => {
  const f = fixture(); await f.create(); const proof = readAliyunOssDedicatedBilling(await f.ledger())!;
  expect(aliyunOssBindingCoversBillingDay({ ...proof, effectiveStartAt: '2026-10-12T04:00:00.000Z' }, '2026-10-12')).toBe(false);
  expect(aliyunOssBindingCoversBillingDay(proof, '2026-10-11')).toBe(false);
});
