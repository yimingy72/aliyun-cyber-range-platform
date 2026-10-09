import { Logger } from '@nestjs/common';
import { BillingService } from '../src/admin/billing.service';
import { BillingSyncService } from '../src/admin/billing-sync.service';
import { BillingBssClient } from '../src/admin/billing-bss-client';
import { releaseRangeInstanceBillingLedger } from '../src/admin/billing-ledger-sync';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';
import type { SystemConfigService } from '../src/admin/system-config.service';

const DAY = '2026-10-01';
const CONTEXT = { provider: 'alibaba_cloud', accountUid: '100001', accountUidResolved: true, cloudAccountContextId: 'test-cloud', defaultRegion: 'cn-hangzhou', defaultZoneId: 'cn-hangzhou-h', accessKeyId: 'test-key', accessKeySecret: 'test-secret', imageImportBucket: 'test-bucket' };
const config = { getAccountContext: async () => ({ ...CONTEXT }) } as unknown as SystemConfigService;
const row = (overrides: Record<string, unknown> = {}) => ({ OwnerID: CONTEXT.accountUid, Region: 'cn-hangzhou', ProductCode: 'ecs', CommodityCode: 'ecs', BillingItemCode: 'cpu', BillingItem: 'CPU', InstanceID: 'i-test', PretaxAmount: 10, Currency: 'CNY', Item: 'PayAsYouGoBill', ...overrides });
const response = (payload: unknown, ok = true) => ({ ok, status: ok ? 200 : 503, json: async () => payload }) as Response;
const originalFetch = global.fetch;

async function fixture() {
  const repository = createMemoryAdminRepository();
  const ledger = await repository.createBillingLedgerResource({ cloudAccountUid: CONTEXT.accountUid, regionId: 'cn-hangzhou', cloudResourceId: 'i-test', cloudResourceType: 'ecs', billingScope: 'platform', billingStartAt: new Date('2026-01-01') });
  const sync = (items: Record<string, unknown>[], context = config) => new BillingSyncService(repository, { listDailyBillingItems: async () => items } as unknown as BillingBssClient, context);
  return { repository, ledger, sync };
}

afterEach(() => { global.fetch = originalFetch; jest.useRealTimers(); jest.restoreAllMocks(); });

describe('billing safety', () => {
  it.each([
    { Success: false, Code: 'Throttling', Message: 'failed' },
    { Success: true, Code: 'Success' },
    { Success: true, Code: 'Success', Data: { Items: [null] } },
  ])('rejects invalid business responses without changing previous bills: %j', async payload => {
    const f = await fixture();
    await f.sync([row()]).syncRange({ startAt: DAY, endAt: DAY });
    const previous = await f.repository.listBillingLineItems();
    global.fetch = jest.fn().mockResolvedValue(response(payload));
    const service = new BillingSyncService(f.repository, new BillingBssClient(config), config);
    await expect(service.syncRange({ startAt: DAY, endAt: DAY })).rejects.toThrow();
    expect(await f.repository.listBillingLineItems()).toEqual(previous);
  });

  it('retains old data for invalid JSON, a failed later page, and repeating tokens', async () => {
    const f = await fixture();
    await f.sync([row()]).syncRange({ startAt: DAY, endAt: DAY });
    const previous = await f.repository.listBillingLineItems();
    const service = new BillingSyncService(f.repository, new BillingBssClient(config), config);
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => { throw new Error('bad JSON'); } });
    await expect(service.syncRange({ startAt: DAY, endAt: DAY })).rejects.toThrow('invalid JSON');
    global.fetch = jest.fn().mockResolvedValueOnce(response({ Success: true, Code: 'Success', Data: { Items: [row()], NextToken: 'next' } })).mockRejectedValueOnce(new Error('page failed'));
    await expect(service.syncRange({ startAt: DAY, endAt: DAY })).rejects.toThrow('page failed');
    global.fetch = jest.fn().mockResolvedValue(response({ Success: true, Code: 'Success', Data: { Items: [row()], NextToken: 'same' } }));
    await expect(service.syncRange({ startAt: DAY, endAt: DAY })).rejects.toThrow('pagination token');
    expect(await f.repository.listBillingLineItems()).toEqual(previous);
  });

  it('retains charge/refund/adjustment and commodity dimensions while deduplicating repeated identical rows', async () => {
    const f = await fixture();
    const lines = [row(), row({ Item: 'Refund', PretaxAmount: -2 }), row({ Item: 'Adjustment', PretaxAmount: 3 }), row({ CommodityCode: 'ecs-special', PretaxAmount: 4 })];
    const service = f.sync([...lines, lines[0]]);
    const result = await service.syncRange({ startAt: DAY, endAt: DAY });
    expect(result.importedLineItems).toBe(4);
    expect(await f.repository.listBillingLineItems()).toHaveLength(4);
    expect((await new BillingService(f.repository).getSummary({ startAt: DAY, endAt: DAY })).totalPretaxAmount).toBe(15);
    await service.syncRange({ startAt: DAY, endAt: DAY });
    expect(await f.repository.listBillingLineItems()).toHaveLength(4);
  });

  it('revisits earlier days after a later bill has arrived so delayed charges are not lost', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-08T04:00:00Z'));
    const f = await fixture();
    await f.sync([row()]).syncRange({ startAt: '2026-10-07', endAt: '2026-10-07' });
    const dates: string[] = [];
    const service = new BillingSyncService(f.repository, { listDailyBillingItems: async ({ billingDate }: { billingDate: string }) => {
      dates.push(billingDate); return [row({ PretaxAmount: billingDate === DAY ? 4 : 1 })];
    } } as unknown as BillingBssClient, config);
    await service.syncRecentDays(7);
    expect(dates).toEqual(['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07']);
    expect((await f.repository.listBillingLineItems({ startAt: DAY, endAt: DAY }))[0].pretaxAmount).toBe(4);
  });

  it.each([
    { Items: [row()], TotalCount: 2 },
    { Items: [], TotalCount: -1 },
    { Items: [], TotalCount: 0.5 },
  ])('retains previous bills when the BSS result is truncated or has invalid row counts: %j', async data => {
    const f = await fixture();
    await f.sync([row()]).syncRange({ startAt: DAY, endAt: DAY });
    const previous = await f.repository.listBillingLineItems();
    global.fetch = jest.fn().mockResolvedValue(response({ Success: true, Code: 'Success', Data: data }));
    await expect(new BillingSyncService(f.repository, new BillingBssClient(config), config).syncRange({ startAt: DAY, endAt: DAY })).rejects.toThrow();
    expect(await f.repository.listBillingLineItems()).toEqual(previous);
  });

  it('rejects a changed total between pages and bills for a different day', async () => {
    const f = await fixture();
    await f.sync([row()]).syncRange({ startAt: DAY, endAt: DAY });
    const previous = await f.repository.listBillingLineItems();
    global.fetch = jest.fn().mockResolvedValueOnce(response({ Success: true, Code: 'Success', Data: { Items: [row()], TotalCount: 2, NextToken: 'next' } }))
      .mockResolvedValueOnce(response({ Success: true, Code: 'Success', Data: { Items: [row()], TotalCount: 3 } }));
    await expect(new BillingSyncService(f.repository, new BillingBssClient(config), config).syncRange({ startAt: DAY, endAt: DAY })).rejects.toThrow('inconsistent row count');
    await expect(f.sync([row({ BillingDate: '2026-09-30' })]).syncRange({ startAt: DAY, endAt: DAY })).rejects.toThrow('different billing date');
    expect(await f.repository.listBillingLineItems()).toEqual(previous);
  });

  it('shows unallocated charges and resources awaiting bills without assigning them to users or treating them as free', async () => {
    const f = await fixture();
    await f.sync([row({ ProductCode: 'snapshot', InstanceID: 'cn-hangzhou', PretaxAmount: 3 }),
      row({ ProductCode: 'oss', InstanceID: 'cn-hangzhou;standard', PretaxAmount: 2, Currency: 'USD' })]).syncRange({ startAt: DAY, endAt: DAY });
    const summary = await new BillingService(f.repository).getSummary({ startAt: DAY, endAt: DAY });
    expect(summary).toMatchObject({ totalPretaxAmount: 0, platformPretaxAmount: 0, billingStatus: 'provisional', resourcesWithoutBillCount: 1,
      unallocatedCurrencyTotals: [{ currency: 'CNY', pretaxAmount: 3 }, { currency: 'USD', pretaxAmount: 2 }] });
    expect((await new BillingService(f.repository).listPlatformItems({ startAt: DAY, endAt: DAY }))).toEqual([]);
  });

  it('keeps payable costs separate from cash, coupon and original-price dimensions', async () => {
    const f = await fixture();
    await f.sync([row({ PretaxAmount: 7, PretaxGrossAmount: 20, PaymentAmount: 4, CashAmount: 4, DeductedByCashCoupons: 3, InvoiceDiscount: 13 })])
      .syncRange({ startAt: DAY, endAt: DAY });
    expect((await new BillingService(f.repository).getSummary({ startAt: DAY, endAt: DAY })).totalPretaxAmount).toBe(7);
    expect((await f.repository.listBillingLineItems())[0].rawPayload).toMatchObject({ PretaxGrossAmount: 20, PaymentAmount: 4, DeductedByCashCoupons: 3 });
  });

  it('does not trust a platform tag that claims a different cloud account', async () => {
    const f = await fixture();
    await f.sync([row({ InstanceID: 'i-wrong-account', Tag: 'key:CreatedBy value:cyber-range-platform; key:PlatformScope value:platform; key:CloudAccountUid value:100002' })])
      .syncRange({ startAt: DAY, endAt: DAY });
    expect(await f.repository.listBillingLineItems()).toEqual([]);
    expect(await f.repository.listBillingAnomalies()).toHaveLength(1);
  });

  it('retains a resource ID with a conflicting explicit region as unallocated', async () => {
    const f = await fixture();
    await f.sync([row({ Region: 'cn-beijing' })]).syncRange({ startAt: DAY, endAt: DAY });
    expect(await f.repository.listBillingLineItems()).toEqual([]);
    expect(await f.repository.listBillingAnomalies()).toHaveLength(1);
  });

  it.each([null, '100002'])('does not let an unproven %s ledger collision block other bills for the day', async uid => {
    const f = await fixture();
    await f.repository.createBillingLedgerResource({ cloudAccountUid: uid, regionId: 'cn-hangzhou', cloudResourceId: 'i-collision',
      cloudResourceType: 'ecs', billingScope: 'platform', billingStartAt: new Date('2026-01-01') });
    await f.sync([row(), row({ InstanceID: 'i-collision', Tag: 'key:CreatedBy value:cyber-range-platform; key:PlatformScope value:platform' })])
      .syncRange({ startAt: DAY, endAt: DAY });
    expect(await f.repository.listBillingLineItems()).toHaveLength(1);
    expect(await f.repository.listBillingAnomalies()).toHaveLength(1);
    expect((await f.repository.listBillingLedgerResources()).find(item => item.cloudResourceId === 'i-collision')?.cloudAccountUid).toBe(uid);
  });

  it('separates account progress and never replaces the other account history', async () => {
    const f = await fixture();
    await f.sync([row()]).syncRange({ startAt: DAY, endAt: DAY });
    const secondConfig = { getAccountContext: async () => ({ ...CONTEXT, accountUid: '100002' }) } as unknown as SystemConfigService;
    await f.repository.createBillingLedgerResource({ cloudAccountUid: '100002', regionId: 'cn-hangzhou', cloudResourceId: 'i-second', cloudResourceType: 'ecs', billingScope: 'platform', billingStartAt: new Date('2026-01-01') });
    const dates: string[] = [];
    const second = new BillingSyncService(f.repository, { listDailyBillingItems: async ({ billingDate }: { billingDate: string }) => { dates.push(billingDate); return [row({ OwnerID: '100002', InstanceID: 'i-second', PretaxAmount: 20 })]; } } as unknown as BillingBssClient, secondConfig);
    await second.syncRange({ startAt: '2026-09-30', endAt: DAY });
    expect(dates).toEqual(['2026-09-30', '2026-10-01']);
    expect(await f.repository.listBillingLineItems({ cloudAccountUid: '100001' })).toHaveLength(1);
    expect(await f.repository.listBillingLineItems({ cloudAccountUid: '100002' })).toHaveLength(2);
    expect((await new BillingService(f.repository).getSummary({ startAt: DAY, endAt: DAY })).totalPretaxAmount).toBe(30);
  });

  it('does not claim an unknown region or another user from unverified tags', async () => {
    const f = await fixture();
    const tag = 'key:CreatedBy value:cyber-range-platform; key:PlatformScope value:platform; key:BillingStartAt value:2026-01-01';
    await f.sync([row({ InstanceID: 'i-singapore', Region: 'ap-southeast-1', Tag: tag }), row({ InstanceID: 'i-unknown', Region: 'Unknown human label', Tag: tag }), row({ InstanceID: 'i-forged', Tag: tag.replace('value:platform;', 'value:user;') + '; key:PlatformUserId value:unknown-user' })]).syncRange({ startAt: DAY, endAt: DAY });
    const singapore = (await f.repository.listBillingLedgerResources()).find(item => item.cloudResourceId === 'i-singapore');
    expect(singapore).toMatchObject({ regionId: 'ap-southeast-1', cloudAccountUid: CONTEXT.accountUid });
    expect(await f.repository.listBillingAnomalies()).toHaveLength(2);
  });

  it('defers unfinished dates and still accepts refunds after the original resource release', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-08T04:00:00Z'));
    const f = await fixture();
    await f.repository.updateBillingLedgerResource(f.ledger.id, { releasedAt: new Date('2026-09-01') });
    await f.sync([row({ Item: 'Refund', PretaxAmount: -2 })]).syncRange({ startAt: DAY, endAt: DAY });
    expect((await f.repository.listBillingLineItems())[0].pretaxAmount).toBe(-2);
    const before = await f.repository.listBillingLineItems();
    const result = await f.sync([]).syncRange({ startAt: '2026-10-08', endAt: '2026-10-09' });
    expect(result).toMatchObject({ syncedDays: 0, deferredCount: 2, deferredDates: ['2026-10-08', '2026-10-09'] });
    expect(await f.repository.listBillingLineItems()).toEqual(before);
  });

  it('uses the Shanghai day at UTC midnight boundaries and resumes this account complete days only', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-07T18:00:00Z'));
    const f = await fixture();
    const dates: string[] = [];
    const service = new BillingSyncService(f.repository, { listDailyBillingItems: async ({ billingDate }: { billingDate: string }) => { dates.push(billingDate); return []; } } as unknown as BillingBssClient, config);
    await service.syncRecentDays(7);
    expect(dates).toEqual(['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07']);
  });

  it('retains packed images and snapshots after the original instance is released', async () => {
    const f = await fixture();
    for (const [cloudResourceId, cloudResourceType] of [['m-packed', 'image'], ['s-packed', 'snapshot']] as const) {
      await f.repository.createBillingLedgerResource({ cloudAccountUid: CONTEXT.accountUid, regionId: 'cn-hangzhou', cloudResourceId, cloudResourceType, billingScope: 'platform', rangeInstanceId: 'source-instance', billingStartAt: new Date('2026-01-01') });
    }
    await releaseRangeInstanceBillingLedger(f.repository, 'source-instance', new Date('2026-09-01'));
    expect((await f.repository.listBillingLedgerResources()).filter(item => item.rangeInstanceId === 'source-instance').every(item => item.releasedAt === null)).toBe(true);
    await f.sync([row({ ProductCode: 'snapshot', BillingItem: 'snapshot storage', InstanceID: 's-packed', PretaxAmount: 2 })]).syncRange({ startAt: DAY, endAt: DAY });
    expect((await f.repository.listBillingLineItems())[0].pretaxAmount).toBe(2);
  });

  it('uses calendar boundaries and rejects partial or invalid date ranges', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-08T12:00:00Z'));
    const f = await fixture();
    const record = { cloudAccountUid: CONTEXT.accountUid, syncBatchId: 'date-test', sourceFingerprint: 'first', billCycle: '2026-09', billingDate: '2026-09-09', productCode: 'ecs', billItem: 'CPU', cloudResourceId: 'i-test', cloudResourceType: 'ecs' as const, pretaxAmount: 10, currency: 'CNY', billingScope: 'platform' as const, matchedLedgerId: f.ledger.id };
    await f.repository.upsertBillingLineItems([record, { ...record, sourceFingerprint: 'future', billingDate: '2026-10-09', pretaxAmount: 99 }]);
    const service = new BillingService(f.repository);
    expect((await service.getSummary({})).totalPretaxAmount).toBe(10);
    await expect(service.getSummary({ startAt: DAY })).rejects.toThrow('同时提供');
    await expect(service.getSummary({ startAt: '2026-02-30', endAt: DAY })).rejects.toThrow('有效');
    await expect(service.getSummary({ startAt: DAY, endAt: '2026-09-30' })).rejects.toThrow('晚于');
  });

  it('keeps mixed currency amounts separate in totals, groups and CSV', async () => {
    const f = await fixture();
    await f.sync([row({ PretaxAmount: 0.1 }), row({ BillingItem: 'RAM', PretaxAmount: 0.2 }), row({ Currency: 'USD', PretaxAmount: 20 })]).syncRange({ startAt: DAY, endAt: DAY });
    const service = new BillingService(f.repository);
    const summary = await service.getSummary({ startAt: DAY, endAt: DAY });
    expect(summary.totalPretaxAmount).toBeNull();
    expect(summary.currency).toBeNull();
    expect(summary.currencyTotals).toEqual([{ currency: 'CNY', totalPretaxAmount: 0.3, platformPretaxAmount: 0.3 }, { currency: 'USD', totalPretaxAmount: 20, platformPretaxAmount: 20 }]);
    const groups = await service.listPlatformGroups({ startAt: DAY, endAt: DAY });
    expect(groups.items.map(item => [item.currency, item.pretaxAmount])).toEqual([['CNY', 0.3], ['USD', 20]]);
    const csv = await service.exportPlatformCsv({ startAt: DAY, endAt: DAY });
    expect(csv).toContain('CNY,0.3,0.3');
    expect(csv).toContain('USD,20,20');
    expect(csv).not.toContain('20.3');
  });

  it('catches scheduled failures and runs the next scheduled synchronization', async () => {
    const previous = process.env.BILLING_SYNC_INTERVAL_MS;
    jest.useFakeTimers();
    process.env.BILLING_SYNC_INTERVAL_MS = '10';
    const f = await fixture();
    const service = f.sync([]);
    const logger = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const sync = jest.spyOn(service, 'syncRecentDays').mockRejectedValueOnce(new Error('transient failure')).mockResolvedValue({ syncedDays: 1, importedLineItems: 0, anomalyCount: 0, deferredCount: 0 });
    try {
      service.onModuleInit();
      await jest.advanceTimersByTimeAsync(20);
      expect(sync).toHaveBeenCalledTimes(2);
      expect(logger).toHaveBeenCalledTimes(1);
    } finally {
      service.onModuleDestroy();
      if (previous === undefined) delete process.env.BILLING_SYNC_INTERVAL_MS; else process.env.BILLING_SYNC_INTERVAL_MS = previous;
    }
  });
});
