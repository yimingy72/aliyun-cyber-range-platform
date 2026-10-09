import { BillingSyncService } from '../src/admin/billing-sync.service';
import { BillingSplitBillUnavailableError, type BillingBssClient } from '../src/admin/billing-bss-client';
import type { SystemConfigService } from '../src/admin/system-config.service';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';

const UID = 'split-cloud';
const DAY = '2026-10-01';
const line = (overrides: Record<string, unknown> = {}) => ({ OwnerID: UID, Region: 'cn-hangzhou', ProductCode: 'snapshot', InstanceID: 'cn-hangzhou', Currency: 'CNY', PretaxAmount: 3, Item: 'PayAsYouGoBill', BillingItem: 'storage', ...overrides });
const config = { getAccountContext: async () => ({ accountUid: UID, accountUidResolved: true, defaultRegion: 'cn-hangzhou' }) } as unknown as SystemConfigService;

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

describe('platform-only split reconciliation', () => {
  it('uses an exact owned snapshot split without charging the external remainder or the aggregate twice', async () => {
    const f = await fixture();
    await f.service([line()], [line({ SplitItemID: 's-owned', PretaxAmount: 1 }), line({ SplitItemID: 's-external', PretaxAmount: 2 })]).syncRange({ startAt: DAY, endAt: DAY });
    const bills = await f.repository.listBillingLineItems();
    expect(bills).toHaveLength(1);
    expect(bills[0]).toMatchObject({ cloudResourceId: 's-owned', pretaxAmount: 1, ownerUserId: 'user-1', rawPayload: { InstanceID: 'cn-hangzhou', SplitItemID: 's-owned' } });
    expect(await f.repository.listBillingAnomalies()).toEqual([]);
  });

  it('does not claim an ECS-wide snapshot split that might include console-created snapshots', async () => {
    const f = await fixture();
    await f.service([line()], [line({ SplitItemID: 'i-source', PretaxAmount: 1 }), line({ SplitItemID: 'i-external', PretaxAmount: 2 })]).syncRange({ startAt: DAY, endAt: DAY });
    expect(await f.repository.listBillingLineItems()).toEqual([]);
    const anomalies = await f.repository.listBillingAnomalies();
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0].rawPayload).toMatchObject({ SplitItemID: 'i-source', __platformBillingScope: { kind: 'aggregate_pending', ledgerIds: [f.ledger.id] } });
  });

  it.each(['unavailable', 'empty', 'amount', 'currency', 'commodity', 'item'] as const)('preserves prior proven exact splits on %s and keeps unresolved source evidence', async failure => {
    const f = await fixture();
    await f.service([line()], [line({ SplitItemID: 's-owned' })]).syncRange({ startAt: DAY, endAt: DAY });
    const previous = await f.repository.listBillingLineItems();
    const split = failure === 'unavailable' ? new BillingSplitBillUnavailableError('NotEnabled') : failure === 'empty' ? [] : [line({ SplitItemID: 's-owned',
      ...(failure === 'amount' ? { PretaxAmount: 9 } : failure === 'currency' ? { Currency: 'USD' } : failure === 'commodity' ? { CommodityCode: 'different' } : { Item: 'Refund' }) })];
    await f.service([line()], split).syncRange({ startAt: DAY, endAt: DAY });
    expect((await f.repository.listBillingLineItems()).map(item => item.sourceFingerprint)).toEqual(previous.map(item => item.sourceFingerprint));
    expect(await f.repository.listBillingAnomalies()).toHaveLength(1);
  });

  it('does not claim a shared import bucket and drops unrelated bucket splits', async () => {
    const f = await fixture();
    f.repository.listBillingImageImportResources = async () => [{ id: 'import-1', cloudAccountUid: UID, regionId: 'cn-hangzhou', imageImportBucket: 'shared-bucket', objectKey: 'image-imports/user/object.qcow2', imageId: null, backingSnapshotIds: [], cloudImageDeletedAt: null, snapshotCleanupCompletedAt: null, createdAt: new Date('2026-09-01'), uploadCompletedAt: new Date('2026-09-01'), temporaryObjectDeletedAt: null }];
    await f.service([line({ ProductCode: 'oss', InstanceID: 'cn-hangzhou;standard' })], [line({ ProductCode: 'oss', InstanceID: 'cn-hangzhou;standard', SplitItemID: 'shared-bucket', PretaxAmount: 1 }), line({ ProductCode: 'oss', InstanceID: 'cn-hangzhou;standard', SplitItemID: 'external-bucket', PretaxAmount: 2 })]).syncRange({ startAt: DAY, endAt: DAY });
    expect(await f.repository.listBillingLineItems()).toEqual([]);
    const pending = await f.repository.listBillingAnomalies();
    expect(pending).toHaveLength(1);
    expect(pending[0].rawPayload).toMatchObject({ SplitItemID: 'shared-bucket', __platformBillingScope: { kind: 'aggregate_pending', imageImportJobIds: ['import-1'] } });
  });
});
