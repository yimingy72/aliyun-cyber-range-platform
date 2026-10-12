import { BillingSyncService } from '../src/admin/billing-sync.service';
import { BillingService } from '../src/admin/billing.service';
import type { BillingBssClient } from '../src/admin/billing-bss-client';
import type { SystemConfigService } from '../src/admin/system-config.service';
import * as bindings from '../src/admin/billing-oss-binding-proof';
import { runInCloudWorkspace } from '../src/auth/cloud-workspace-scope';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';

const DAY = '2026-10-10', UID = '123456', START = '2026-09-30T16:00:00.000Z';
const scope = { cloudWorkspaceId: 'space-owned', provider: 'alibaba_cloud' as const, accountUid: UID, cloudAccountContextId: 'context-owned',
  actorUserId: 'admin-owned', isPlatformManager: true, isReadOnly: false };
const bill = (overrides: Record<string, unknown> = {}) => ({ OwnerID: UID, Region: '华东1（杭州）', ProductCode: 'oss', InstanceID: 'cn-hangzhou;standard',
  Currency: 'CNY', PretaxAmount: '0.3', BillingDate: DAY, Item: 'PayAsYouGoBill', BillingItem: '标准存储', BillingItemCode: 'Storage', ...overrides });
async function fixture() {
  process.env.PLATFORM_BILLING_STARTED_AT = START;
  jest.useFakeTimers().setSystemTime(new Date('2026-10-12T10:00:00Z'));
  const repository = createMemoryAdminRepository();
  const proof: bindings.AliyunOssDedicatedBillingProof = { version: 1, dedicated: true, ...scope,
    bucketName: 'platform-owned-bucket', regionId: 'cn-hangzhou', bucketCreatedAt: '2026-09-01T00:00:00.000Z', verifiedAt: new Date().toISOString(),
    declaredAt: new Date().toISOString(), declaredByUserId: scope.actorUserId, cloudAccountUid: UID, officialRequestId: 'request-owned', effectiveStartAt: START, effectiveEndAt: null };
  const ledger = await runInCloudWorkspace(scope, () => repository.createBillingLedgerResource({ cloudAccountUid: UID, regionId: proof.regionId, cloudResourceId: proof.bucketName,
    cloudResourceType: 'oss_bucket', billingScope: 'platform', billingStartAt: new Date(START), tagsSnapshot: { [bindings.ALIYUN_OSS_DEDICATED_BILLING_KEY]: proof } }));
  const bss = { listDailyBillingItems: jest.fn(async () => [bill()]), listDailySplitBillingItems: jest.fn(async () => [
    bill({ SplitItemID: proof.bucketName, PretaxAmount: '0.1' }), bill({ SplitItemID: 'another-business-bucket', PretaxAmount: '0.2' })]) };
  const verification = jest.spyOn(bindings, 'refreshAliyunOssBindingVerification').mockResolvedValue({ verified: true, reason: null });
  const sync = new BillingSyncService(repository, bss as unknown as BillingBssClient, { getAccountContext: async () => ({ provider: 'alibaba_cloud', accountUid: UID,
    accountUidResolved: true, cloudAccountContextId: scope.cloudAccountContextId, defaultRegion: 'cn-hangzhou' }) } as unknown as SystemConfigService);
  return { repository, proof, ledger, bss, verification, sync, service: new BillingService(repository) };
}
const oldStart = process.env.PLATFORM_BILLING_STARTED_AT;
afterEach(() => { if (oldStart === undefined) delete process.env.PLATFORM_BILLING_STARTED_AT; else process.env.PLATFORM_BILLING_STARTED_AT = oldStart; jest.restoreAllMocks(); jest.useRealTimers(); });
describe('Alibaba dedicated OSS official fee attribution', () => {
  it('keeps corrections pending without attributing a prior-business usage period to the new dedicated interval', async () => {
    const f = await fixture();
    f.bss.listDailyBillingItems.mockResolvedValue([bill({ Item: 'Refund' })]);
    f.bss.listDailySplitBillingItems.mockResolvedValue([bill({ Item: 'Refund', SplitItemID: f.proof.bucketName, PretaxAmount: '0.1' }),
      bill({ Item: 'Refund', SplitItemID: 'another-business-bucket', PretaxAmount: '0.2' })]);
    await runInCloudWorkspace(scope, async () => {
      await f.sync.syncRange({ startAt: DAY, endAt: DAY });
      expect(await f.repository.listBillingLineItems()).toEqual([]);
      expect((await f.service.getSummary({ startAt: DAY, endAt: DAY })).reconciliationIssues).toEqual([expect.objectContaining({ resourceType: 'oss', resourceCount: 1 })]);
    });
  });
  it('imports only exact dedicated-bucket splits, refreshes official identity, and does not count twice', async () => {
    const f = await fixture();
    await runInCloudWorkspace(scope, async () => {
      for (let i = 0; i < 2; i++) await f.sync.syncRange({ startAt: DAY, endAt: DAY });
      expect(await f.repository.listBillingLineItems()).toEqual([expect.objectContaining({ matchedLedgerId: f.ledger.id, cloudResourceId: f.proof.bucketName,
        cloudResourceType: 'oss_bucket', billingScope: 'platform', ownerUserId: null, pretaxAmount: 0.1 })]);
      expect(await f.service.getSummary({ startAt: DAY, endAt: DAY })).toMatchObject({ totalPretaxAmount: 0.1, platformPretaxAmount: 0.1, resourcesWithoutBillCount: 0 });
    });
    expect(f.verification).toHaveBeenCalledTimes(2);
  });
  it('keeps missing details pending and automatically imports when complete official splits appear', async () => {
    const f = await fixture(), rows = await f.bss.listDailySplitBillingItems();
    f.bss.listDailySplitBillingItems.mockResolvedValue([]);
    await runInCloudWorkspace(scope, async () => {
      await f.sync.syncRange({ startAt: DAY, endAt: DAY });
      expect(await f.repository.listBillingLineItems()).toEqual([]);
      expect(await f.service.getSummary({ startAt: DAY, endAt: DAY })).toMatchObject({ totalPretaxAmount: 0, resourcesWithoutBillCount: 1,
        reconciliationIssues: [expect.objectContaining({ resourceType: 'oss', resourceCount: 1 })] });
      f.bss.listDailySplitBillingItems.mockResolvedValue(rows);
      await f.sync.syncRange({ startAt: DAY, endAt: DAY });
      expect(await f.service.getSummary({ startAt: DAY, endAt: DAY })).toMatchObject({ totalPretaxAmount: 0.1, resourcesWithoutBillCount: 0, reconciliationIssues: [] });
    });
  });
  it('retains the last verified revision when the bucket identity changes or official totals do not reconcile', async () => {
    const f = await fixture();
    await runInCloudWorkspace(scope, async () => {
      await f.sync.syncRange({ startAt: DAY, endAt: DAY });
      f.verification.mockResolvedValue({ verified: false, reason: 'OSS_BUCKET_RECREATED' });
      await f.sync.syncRange({ startAt: DAY, endAt: DAY });
      expect(await f.repository.listBillingLineItems()).toEqual([expect.objectContaining({ pretaxAmount: 0.1, rawPayload: expect.objectContaining({ __platformBillingSyncDeferred: true }) })]);
      expect((await f.service.getSummary({ startAt: DAY, endAt: DAY })).reconciliationIssues).toEqual([expect.objectContaining({ resourceType: 'oss', resourceCount: 1 })]);
    });
  });
  it('does not include a partial dedicated day or other cloud account', async () => {
    const f = await fixture();
    await runInCloudWorkspace(scope, async () => {
      await f.repository.updateBillingLedgerResource(f.ledger.id, { tagsSnapshot: { [bindings.ALIYUN_OSS_DEDICATED_BILLING_KEY]: { ...f.proof, effectiveEndAt: '2026-10-10T04:00:00.000Z' } } });
      await f.sync.syncRange({ startAt: DAY, endAt: DAY });
      expect(await f.repository.listBillingLineItems()).toEqual([]);
      expect(await f.service.getSummary({ startAt: DAY, endAt: DAY })).toMatchObject({ totalPretaxAmount: 0,
        reconciliationIssues: [expect.objectContaining({ resourceType: 'oss', resourceCount: 1 })] });
    });
    await runInCloudWorkspace({ ...scope, cloudWorkspaceId: 'space-other', accountUid: '654321' }, async () => {
      expect((await f.service.getSummary({ startAt: DAY, endAt: DAY })).totalPretaxAmount).toBe(0);
    });
    expect(f.verification).not.toHaveBeenCalled();
  });
  it('retains verified fees when native split geography is unknown instead of bypassing bucket identity refresh', async () => {
    const f = await fixture();
    await runInCloudWorkspace(scope, async () => {
      await f.sync.syncRange({ startAt: DAY, endAt: DAY });
      f.verification.mockResolvedValue({ verified: false, reason: 'OSS_BUCKET_RECREATED' });
      f.bss.listDailyBillingItems.mockResolvedValue([bill({ Region: '未知地域', InstanceID: 'unresolved-source' })]);
      f.bss.listDailySplitBillingItems.mockResolvedValue([bill({ Region: '未知地域', InstanceID: 'unresolved-source', SplitItemID: f.proof.bucketName, PretaxAmount: '0.15' }),
        bill({ Region: '未知地域', InstanceID: 'unresolved-source', SplitItemID: 'another-business-bucket', PretaxAmount: '0.15' })]);
      await f.sync.syncRange({ startAt: DAY, endAt: DAY });
      expect(await f.repository.listBillingLineItems()).toEqual([expect.objectContaining({ pretaxAmount: 0.1, rawPayload: expect.objectContaining({ __platformBillingSyncDeferred: true }) })]);
      expect((await f.service.getSummary({ startAt: DAY, endAt: DAY })).totalPretaxAmount).toBe(0.1);
    });
  });
});
