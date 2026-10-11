import { BillingBssClient } from '../src/admin/billing-bss-client';
import { BillingSyncService } from '../src/admin/billing-sync.service';
import type { SystemCloudAccountContext, SystemConfigService } from '../src/admin/system-config.service';
import { createProvenBillingLedger } from './support/create-billing-fixture';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';

const DAY = '2026-10-01';
const context = { provider: 'alibaba_cloud', accountUid: '100001', accountUidResolved: true,
  accessKeyId: 'fixture-key', accessKeySecret: 'fixture-secret' } as SystemCloudAccountContext;
const config = { getAccountContext: async () => context } as unknown as SystemConfigService;
const row = { OwnerID: context.accountUid, Region: 'cn-hangzhou', ProductCode: 'ecs', InstanceID: 'i-integrity',
  BillingDate: DAY, Currency: 'CNY', PretaxAmount: 5 };
const response = (data: Record<string, unknown>) => ({ ok: true, status: 200, json: async () => ({
  Success: true, Code: 'Success', Data: { AccountID: context.accountUid, BillingCycle: '2026-10', ...data },
}) }) as Response;
const originalFetch = global.fetch;
afterEach(() => { global.fetch = originalFetch; jest.restoreAllMocks(); });

async function existingDay() {
  const repository = createMemoryAdminRepository();
  await createProvenBillingLedger(repository, { cloudAccountUid: context.accountUid, regionId: 'cn-hangzhou',
    cloudResourceId: row.InstanceID, cloudResourceType: 'ecs', billingScope: 'platform', billingStartAt: new Date('2026-01-01') });
  global.fetch = jest.fn().mockResolvedValue(response({ Items: [row], TotalCount: 1 }));
  const service = new BillingSyncService(repository, new BillingBssClient(config), config);
  await service.syncRange({ startAt: DAY, endAt: DAY });
  return { repository, service, previous: await repository.listBillingLineItems() };
}

describe('daily BSS revision completeness', () => {
  it.each([
    { Items: [] },
    { Items: [row] },
    { Items: [], TotalCount: null },
  ])('retains existing charges when the total is missing or unverified: %j', async data => {
    const { repository, service, previous } = await existingDay();
    const replace = jest.spyOn(repository, 'replaceBillingDay');
    global.fetch = jest.fn().mockResolvedValue(response(data));
    await expect(service.syncRange({ startAt: DAY, endAt: DAY })).rejects.toThrow('inconsistent row count');
    expect(replace).not.toHaveBeenCalled();
    expect(await repository.listBillingLineItems()).toEqual(previous);
  });

  it('requires the same verified total on every page, including the final page', async () => {
    const { repository, service, previous } = await existingDay();
    global.fetch = jest.fn()
      .mockResolvedValueOnce(response({ Items: [row], TotalCount: 2, NextToken: 'second' }))
      .mockResolvedValueOnce(response({ Items: [{ ...row, PretaxAmount: 3 }] }));
    await expect(service.syncRange({ startAt: DAY, endAt: DAY })).rejects.toThrow('inconsistent row count');
    expect(await repository.listBillingLineItems()).toEqual(previous);
  });

  it.each([
    { Items: [], TotalCount: 1, NextToken: 'no-progress' },
    { Items: [row], TotalCount: 1, NextToken: 'over-total' },
    { Items: [], TotalCount: 0, NextToken: 'empty-continuation' },
  ])('stops contradictory pagination before another request and retains the old day: %j', async data => {
    const { repository, service, previous } = await existingDay();
    global.fetch = jest.fn().mockResolvedValueOnce(response(data))
      .mockRejectedValue(new Error('must not request another page'));
    await expect(service.syncRange({ startAt: DAY, endAt: DAY })).rejects.toThrow('pagination token');
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(await repository.listBillingLineItems()).toEqual(previous);
  });

  it('accepts a complete multi-page correction, then an explicitly verified empty day', async () => {
    const { repository, service } = await existingDay();
    global.fetch = jest.fn()
      .mockResolvedValueOnce(response({ Items: [row], TotalCount: 2, NextToken: 'second' }))
      .mockResolvedValueOnce(response({ Items: [{ ...row, Item: 'Refund', PretaxAmount: -2 }], TotalCount: 2 }));
    await service.syncRange({ startAt: DAY, endAt: DAY });
    expect((await repository.listBillingLineItems()).map(item => item.pretaxAmount).sort()).toEqual([-2, 5]);
    const secondUrl = (global.fetch as jest.Mock).mock.calls[1][0];
    expect(new URL(secondUrl).searchParams.get('NextToken')).toBe('second');
    global.fetch = jest.fn().mockResolvedValue(response({ TotalCount: 0 }));
    await service.syncRange({ startAt: DAY, endAt: DAY });
    expect(await repository.listBillingLineItems()).toEqual([]);
  });

  it.each(['2026-02-30', '2026-2-01', 'not-a-date', '2026-10-01T00:00:00Z'])('rejects invalid query date %s before fetching', async billingDate => {
    global.fetch = jest.fn();
    await expect(new BillingBssClient(config).listDailyBillingItems({ billingDate })).rejects.toThrow('Invalid daily bill query');
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
