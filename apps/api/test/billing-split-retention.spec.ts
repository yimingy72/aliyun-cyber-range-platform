import { createProvenBillingLedger } from './support/create-billing-fixture';
import { BillingSyncService } from '../src/admin/billing-sync.service';
import { BillingSplitBillUnavailableError, type BillingBssClient } from '../src/admin/billing-bss-client';
import type { SystemConfigService } from '../src/admin/system-config.service';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';

const UID = 'split-cloud';
const DAY = '2026-10-01';
const line = (overrides: Record<string, unknown> = {}) => ({ OwnerID: UID, Region: 'cn-hangzhou', ProductCode: 'snapshot', InstanceID: 'cn-hangzhou', Currency: 'CNY', PretaxAmount: 3, Item: 'PayAsYouGoBill', BillingItem: 'storage', ...overrides });
const config = { getAccountContext: async () => ({ provider: 'alibaba_cloud', accountUid: UID, accountUidResolved: true, defaultRegion: 'cn-hangzhou' }) } as unknown as SystemConfigService;

async function fixture() {
  jest.useFakeTimers().setSystemTime(new Date('2026-09-01'));
  const repository = createMemoryAdminRepository();
  const artifact = await repository.createPackedImageArtifact({ cloudAccountContextId: 'context', cloudAccountUid: UID, regionId: 'cn-hangzhou', ownerUserId: 'user-1', sourceRangeInstanceId: 'source-range', sourceHostKey: 'host', sourceInstanceId: 'i-source', sourceDiskIds: ['d-source'] });
  await repository.updatePackedImageArtifact(artifact.id, { imageId: 'm-owned', backingSnapshotIds: ['s-owned'] });
  const ledger = await repository.createBillingLedgerResource({ cloudAccountUid: UID, regionId: 'cn-hangzhou', cloudResourceId: 's-owned', cloudResourceType: 'snapshot', billingScope: 'user', ownerUserId: 'user-1', rangeInstanceId: 'source-range', billingStartAt: artifact.createdAt });
  jest.setSystemTime(new Date('2026-10-09'));
  const service = (original: Record<string, unknown>[], split: Record<string, unknown>[] | Error) => new BillingSyncService(repository, {
    listDailyBillingItems: async () => original,
    listDailySplitBillingItems: async () => { if (split instanceof Error) throw split; return split; },
  } as unknown as BillingBssClient, config);
  return { repository, ledger, service };
}

afterEach(() => jest.useRealTimers());

describe('coherent split-bill retention', () => {
  async function seed() {
    const f = await fixture();
    await f.service([line()], [line({ SplitItemID: 's-owned' })]).syncRange({ startAt: DAY, endAt: DAY });
    return f;
  }

  it('retains verified split charges when the original product disappears while other products refresh', async () => {
    const f = await seed();
    await createProvenBillingLedger(f.repository, { cloudAccountUid: UID, regionId: 'cn-hangzhou', cloudResourceId: 'i-owned', cloudResourceType: 'ecs', billingScope: 'platform', billingStartAt: new Date('2026-09-01') });
    const before = (await f.repository.listBillingLineItems())[0];
    await f.service([line({ ProductCode: 'ecs', InstanceID: 'i-owned', PretaxAmount: 7 })], new Error('not available')).syncRange({ startAt: DAY, endAt: DAY });
    const bills = await f.repository.listBillingLineItems();
    expect(bills).toHaveLength(2);
    expect(bills.find(bill => bill.productCode === 'ecs')?.pretaxAmount).toBe(7);
    expect(bills.find(bill => bill.productCode === 'snapshot')).toMatchObject({ sourceFingerprint: before.sourceFingerprint, pretaxAmount: 3, rawPayload: { __platformBillingSyncDeferred: true } });
  });

  it('does not clear verified split charges on a successful wholly empty instance bill', async () => {
    const f = await seed();
    await f.service([], new Error('unavailable')).syncRange({ startAt: DAY, endAt: DAY });
    expect(await f.repository.listBillingLineItems()).toEqual([expect.objectContaining({ pretaxAmount: 3, rawPayload: expect.objectContaining({ __platformBillingSyncDeferred: true }) })]);
  });

  it('does not add new direct charges to retained split charges for a mixed product', async () => {
    const f = await seed();
    await f.service([line({ InstanceID: 's-owned', PretaxAmount: 1 }), line({ PretaxAmount: 2 })], [line({ SplitItemID: 's-owned' })]).syncRange({ startAt: DAY, endAt: DAY });
    expect(await f.repository.listBillingLineItems()).toEqual([expect.objectContaining({ pretaxAmount: 3, rawPayload: expect.objectContaining({ __platformBillingSyncDeferred: true }) })]);
    expect(await f.repository.listBillingAnomalies()).toHaveLength(1);
  });

  it('retains the complete prior product revision including direct bills when mixed sources cannot reconcile', async () => {
    const f = await fixture();
    await f.service([line({ InstanceID: 's-owned', PretaxAmount: 1 })], []).syncRange({ startAt: DAY, endAt: DAY });
    await f.service([line({ InstanceID: 's-owned', PretaxAmount: 2 }), line({ PretaxAmount: 3 })], new Error('not enabled')).syncRange({ startAt: DAY, endAt: DAY });
    expect(await f.repository.listBillingLineItems()).toEqual([expect.objectContaining({ pretaxAmount: 1, rawPayload: expect.objectContaining({ __platformBillingSyncDeferred: true }) })]);
  });

  it('keeps prior split charges after release even when there are no active aggregation candidates', async () => {
    const f = await seed();
    await f.repository.updateBillingLedgerResource(f.ledger.id, { releasedAt: new Date('2026-09-01') });
    await f.service([line()], new Error('temporarily unavailable')).syncRange({ startAt: DAY, endAt: DAY });
    expect(await f.repository.listBillingLineItems()).toEqual([expect.objectContaining({ pretaxAmount: 3, rawPayload: expect.objectContaining({ __platformBillingSyncDeferred: true }) })]);
  });

  it('retains already verified charges when the instance-bill source itself fails', async () => {
    const f = await seed();
    const before = await f.repository.listBillingLineItems();
    const failed = new BillingSyncService(f.repository, { listDailyBillingItems: async () => { throw new Error('source unavailable'); } } as unknown as BillingBssClient, config);
    await expect(failed.syncRange({ startAt: DAY, endAt: DAY })).rejects.toThrow('source unavailable');
    expect(await f.repository.listBillingLineItems()).toEqual(before);
  });

  it('replaces the entire retained revision after complete source reconciliation and clears the deferred marker', async () => {
    const f = await seed();
    await f.service([], new Error('unavailable')).syncRange({ startAt: DAY, endAt: DAY });
    await f.service([line()], [line({ SplitItemID: 's-owned', PretaxAmount: 2 }), line({ SplitItemID: 's-external', PretaxAmount: 1 })]).syncRange({ startAt: DAY, endAt: DAY });
    const bills = await f.repository.listBillingLineItems();
    expect(bills).toHaveLength(1);
    expect(bills[0].pretaxAmount).toBe(2);
    expect(bills[0].rawPayload.__platformBillingSyncDeferred).toBeUndefined();
  });
});
