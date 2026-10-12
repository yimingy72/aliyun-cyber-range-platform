import { ForbiddenException } from '@nestjs/common';
import { validate } from 'class-validator';

import { runInCloudWorkspace } from '../src/auth/cloud-workspace-scope';
import { BillingOssBindingController } from '../src/admin/billing-oss-binding.controller';
import { aliyunOssBindingCoversBillingDay, readAliyunOssDedicatedBilling, refreshAliyunOssBindingVerification } from '../src/admin/billing-oss-binding-proof';
import { BillingOssBindingService } from '../src/admin/billing-oss-binding.service';
import { BindBillingOssBucketDto } from '../src/admin/dto/billing-oss-binding.dto';
import { PrismaAdminRepository } from '../src/database/prisma-admin.repository';
import type { OperationControlService } from '../src/operations/operation-control.service';
import type { SystemCloudAccountContext, SystemConfigService } from '../src/admin/system-config.service';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';

const scope = { cloudWorkspaceId: 'oss-space', provider: 'alibaba_cloud' as const, accountUid: '1672470067548805',
  cloudAccountContextId: 'context-oss', actorUserId: 'manager', isPlatformManager: true };
const context: SystemCloudAccountContext = { provider: 'alibaba_cloud', accountUid: scope.accountUid, accountUidResolved: true,
  cloudAccountContextId: scope.cloudAccountContextId, defaultRegion: 'cn-hangzhou', defaultZoneId: 'cn-hangzhou-h',
  imageImportBucket: 'platform-only', accessKeyId: 'fixture-key', accessKeySecret: 'fixture-secret' };
const payload: BindBillingOssBucketDto = { bucketName: 'platform-only', dedicated: true, effectiveStartAt: '2026-09-01T00:00:00+08:00' };
function bucketXml(overrides: Partial<{ bucket: string; uid: string; region: string; birth: string }> = {}) {
  return `<?xml version="1.0"?><BucketInfo><Bucket><Name>${overrides.bucket ?? 'platform-only'}</Name><Location>oss-${overrides.region ?? 'cn-hangzhou'}</Location><CreationDate>${overrides.birth ?? '2026-08-01T00:00:00.000Z'}</CreationDate><Owner><ID>${overrides.uid ?? scope.accountUid}</ID></Owner></Bucket></BucketInfo>`;
}
function fixture() {
  const repository = createMemoryAdminRepository();
  const config = { getSelectedAccountContext: jest.fn(async () => ({ ...context })) } as unknown as SystemConfigService;
  const service = new BillingOssBindingService(repository, config);
  const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(bucketXml(), { status: 200, headers: { 'x-oss-request-id': 'official-request' } }));
  return { repository, config, service, fetchMock, bind: (input = payload) => runInCloudWorkspace(scope, () => service.bind(input)),
    ledger: () => runInCloudWorkspace(scope, async () => (await repository.listBillingLedgerResources())[0]) };
}
const originalStart = process.env.PLATFORM_BILLING_STARTED_AT;
beforeEach(() => { jest.useFakeTimers().setSystemTime(new Date('2026-10-12T00:00:00Z')); process.env.PLATFORM_BILLING_STARTED_AT = '2026-09-30T16:00:00.000Z'; });
afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); if (originalStart === undefined) delete process.env.PLATFORM_BILLING_STARTED_AT; else process.env.PLATFORM_BILLING_STARTED_AT = originalStart; });

it('uses the verified active account for ordinary workspace requests while refusing an explicit mismatched context', async () => {
  const f = fixture();
  expect(await runInCloudWorkspace({ ...scope, cloudAccountContextId: undefined }, () => f.service.contextForWrite(false))).toMatchObject({
    cloudAccountContextId: context.cloudAccountContextId, accountUid: scope.accountUid });
  await expect(runInCloudWorkspace({ ...scope, cloudAccountContextId: 'context-other' }, () => f.service.contextForWrite(false))).rejects.toThrow('请选择已验证');
  expect(f.fetchMock).not.toHaveBeenCalled();
});

it('does not infer ownership from configured bucket; binds only verified dedicated statement and preserves immutable evidence', async () => {
  const f = fixture();
  expect(await runInCloudWorkspace(scope, () => f.service.list())).toEqual([]);
  const bound = await f.bind();
  const ledger = await f.ledger();
  expect(bound).toMatchObject({ bucketName: payload.bucketName, cloudAccountUid: scope.accountUid, effectiveStartAt: '2026-09-30T16:00:00.000Z', status: 'active' });
  expect(ledger).toMatchObject({ cloudWorkspaceId: scope.cloudWorkspaceId, billingScope: 'platform', ownerUserId: null,
    rangeInstanceId: null, sourceProvisionJobId: null, releasedAt: null });
  const proof = readAliyunOssDedicatedBilling(ledger)!;
  expect(proof).toMatchObject({ version: 1, dedicated: true, bucketCreatedAt: '2026-08-01T00:00:00.000Z', officialRequestId: 'official-request', declaredByUserId: 'manager' });
  expect(await f.bind()).toEqual(bound);
  expect(await f.ledger()).toEqual(ledger);
  const [url, options] = f.fetchMock.mock.calls[0];
  expect(url).toBe('https://platform-only.oss-cn-hangzhou.aliyuncs.com/?bucketInfo');
  expect(options).toMatchObject({ method: 'GET', redirect: 'error', headers: { Authorization: expect.stringMatching(/^OSS fixture-key:/) } });
});

it('starts no earlier than new bucket birth even when current platform cutoff is earlier', async () => {
  const f = fixture(); f.fetchMock.mockImplementation(async () => new Response(bucketXml({ birth: '2026-10-03T03:04:00Z' }), { headers: { 'x-oss-request-id': 'birth' } }));
  const bound = await f.bind();
  expect(bound.effectiveStartAt).toBe('2026-10-03T03:04:00.000Z');
  const proof = readAliyunOssDedicatedBilling(await f.ledger())!;
  expect(aliyunOssBindingCoversBillingDay(proof, '2026-10-03')).toBe(false);
  expect(aliyunOssBindingCoversBillingDay(proof, '2026-10-04')).toBe(true);
});

it.each([{ uid: '999' }, { bucket: 'other-business' }, { region: 'cn-beijing' }, { birth: '2027-01-01T00:00:00Z' }])('rejects mismatched official bucket identity %j', async overrides => {
  const f = fixture(); f.fetchMock.mockImplementation(async () => new Response(bucketXml(overrides), { headers: { 'x-oss-request-id': 'id' } }));
  await expect(f.bind()).rejects.toThrow('未绑定费用');
  expect(await f.ledger()).toBeUndefined();
});

it.each([
  { ...payload, bucketName: 'other-business' }, { ...payload, dedicated: false }, { ...payload, effectiveStartAt: 'now' },
  { ...payload, effectiveStartAt: '2027-01-01T00:00:00Z' }, { ...payload, bucketName: 'bad/path' },
])('rejects statements outside configured dedicated bucket/date %j before cloud access', async input => {
  const f = fixture(); await expect(f.bind(input as BindBillingOssBucketDto)).rejects.toThrow(); expect(f.fetchMock).not.toHaveBeenCalled();
});

it('rejects non-managers, read-only spaces and frozen UID/context mismatch before any write', async () => {
  const f = fixture();
  await expect(runInCloudWorkspace({ ...scope, isPlatformManager: false }, () => f.service.bind(payload))).rejects.toBeInstanceOf(ForbiddenException);
  await expect(runInCloudWorkspace({ ...scope, isReadOnly: true }, () => f.service.bind(payload))).rejects.toBeInstanceOf(ForbiddenException);
  await expect(runInCloudWorkspace({ ...scope, accountUid: 'different' }, () => f.service.bind(payload))).rejects.toThrow('已验证');
  await expect(runInCloudWorkspace({ ...scope, cloudAccountContextId: 'different' }, () => f.service.bind(payload))).rejects.toThrow('已验证');
  expect(f.fetchMock).not.toHaveBeenCalled();
});

it('will not take over existing unproved ledger or overwrite a prior declaration date', async () => {
  const f = fixture(); await f.bind(); const before = await f.ledger();
  await expect(f.bind({ ...payload, effectiveStartAt: '2026-10-02T00:00:00+08:00' })).rejects.toThrow('不能覆盖历史');
  expect(await f.ledger()).toEqual(before);
  await runInCloudWorkspace(scope, () => f.repository.updateBillingLedgerResource(before.id, { tagsSnapshot: { unrelated: true } }));
  await expect(f.bind()).rejects.toThrow('不能覆盖历史');
});

it('terminates statement without pretending bucket was deleted; first terminal time cannot move in a later CAS race', async () => {
  const f = fixture(); const bound = await f.bind(); const stale = await f.ledger();
  const ended = await runInCloudWorkspace(scope, () => f.service.end(bound.ledgerId));
  expect(ended).toMatchObject({ status: 'ended', effectiveEndAt: '2026-10-12T00:00:00.000Z' });
  jest.setSystemTime(new Date('2026-10-13T00:00:00Z'));
  expect(await runInCloudWorkspace(scope, () => f.repository.endOssBillingBinding(stale, new Date()))).toBe(false);
  expect(await runInCloudWorkspace(scope, () => f.service.end(bound.ledgerId))).toEqual(ended);
  const ledger = await f.ledger(); expect(ledger.releasedAt).toBeNull();
  const proof = readAliyunOssDedicatedBilling(ledger)!;
  expect(aliyunOssBindingCoversBillingDay(proof, '2026-09-30')).toBe(false);
  expect(aliyunOssBindingCoversBillingDay(proof, '2026-10-01')).toBe(true);
  expect(aliyunOssBindingCoversBillingDay(proof, '2026-10-11')).toBe(true);
  expect(aliyunOssBindingCoversBillingDay(proof, '2026-10-12')).toBe(false);
  await expect(f.bind()).rejects.toThrow('已终止');
  expect(await runInCloudWorkspace({ ...scope, cloudWorkspaceId: 'different' }, () => f.service.list())).toEqual([]);
  await expect(runInCloudWorkspace({ ...scope, cloudWorkspaceId: 'different' }, () => f.service.end(bound.ledgerId))).rejects.toThrow('当前工作空间');
});

it.each(['cloudWorkspaceId', 'cloudAccountUid', 'cloudResourceId', 'regionId', 'billingScope', 'ownerUserId', 'sourceProvisionJobId'] as const)('proof rejects mismatched ledger %s', async key => {
  const f = fixture(); await f.bind(); const ledger = await f.ledger();
  expect(readAliyunOssDedicatedBilling({ ...ledger, [key]: 'external' })).toBeNull();
});

it('rejects recreated names and unavailable re-verification without modifying statement or historical amount', async () => {
  const f = fixture(); await f.bind(); const ledger = await f.ledger();
  expect(await refreshAliyunOssBindingVerification(ledger, context)).toEqual({ verified: true, reason: null });
  f.fetchMock.mockImplementation(async () => new Response(bucketXml({ birth: '2026-10-11T00:00:00Z' }), { headers: { 'x-oss-request-id': 'recreated' } }));
  expect(await refreshAliyunOssBindingVerification(ledger, context)).toEqual({ verified: false, reason: 'OSS_BUCKET_RECREATED' });
  f.fetchMock.mockImplementation(async () => new Response('denied', { status: 403 }));
  expect(await refreshAliyunOssBindingVerification(ledger, context)).toEqual({ verified: false, reason: 'OSS_BUCKET_VERIFY_HTTP_403' });
  expect(await f.ledger()).toEqual(ledger);
});

it('strict DTO requires explicit true dedicated declaration and fixed ISO offset', async () => {
  expect(await validate(Object.assign(new BindBillingOssBucketDto(), payload))).toHaveLength(0);
  expect(await validate(Object.assign(new BindBillingOssBucketDto(), { ...payload, dedicated: undefined, effectiveStartAt: '2026-10-01' }))).not.toHaveLength(0);
});

it('Prisma terminal CAS predicates identity and complete evidence and never marks cloud release', async () => {
  const f = fixture(); await f.bind(); const ledger = await f.ledger();
  const prisma = { billingLedgerResource: { updateMany: jest.fn(async () => ({ count: 1 })) } };
  const repository = new PrismaAdminRepository(prisma as never);
  expect(await runInCloudWorkspace(scope, () => repository.endOssBillingBinding(ledger, new Date()))).toBe(true);
  expect(prisma.billingLedgerResource.updateMany).toHaveBeenCalledWith({ where: expect.objectContaining({ id: ledger.id,
    cloudWorkspaceId: scope.cloudWorkspaceId, cloudAccountUid: scope.accountUid, cloudResourceType: 'oss_bucket', releasedAt: null,
    sourceProvisionJobId: null, tagsSnapshot: { equals: ledger.tagsSnapshot } }), data: { tagsSnapshot: expect.objectContaining({
      aliyunOssDedicatedBilling: expect.objectContaining({ effectiveEndAt: '2026-10-12T00:00:00.000Z' }) }) } });
  prisma.billingLedgerResource.updateMany.mockClear();
  expect(await runInCloudWorkspace({ ...scope, cloudWorkspaceId: 'foreign' }, () => repository.endOssBillingBinding(ledger, new Date()))).toBe(false);
  expect(prisma.billingLedgerResource.updateMany).not.toHaveBeenCalled();
});

it('controller requires manager and sends MCP mutation through existing confirmation contract', async () => {
  const f = fixture();
  const operations = { executeConfirmed: jest.fn(async input => ({ confirmed: input.toolName })), audit: jest.fn(async () => null) };
  const controller = new BillingOssBindingController(f.service, operations as unknown as OperationControlService);
  const request = { headers: {}, adminUser: { id: 'manager', role: 'admin', isPlatformManager: true },
    authContext: { user: { id: 'manager', role: 'admin' }, source: 'mcp', oauthClientId: 'mcp-gateway' } };
  await expect(controller.bind({ ...request, adminUser: { ...request.adminUser, isPlatformManager: false } } as never, payload)).rejects.toBeInstanceOf(ForbiddenException);
  expect(await controller.bind(request as never, payload)).toEqual({ confirmed: 'billing_oss_bucket_bind' });
  expect(operations.executeConfirmed).toHaveBeenCalledWith(expect.objectContaining({ arguments: payload, targetType: 'billing_oss_bucket_binding' }));
  expect(f.fetchMock).not.toHaveBeenCalled();
});
