import { BillingService } from '../src/admin/billing.service';
import { BillingSyncService } from '../src/admin/billing-sync.service';
import type { BillingBssClient } from '../src/admin/billing-bss-client';
import type { SystemConfigService } from '../src/admin/system-config.service';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';
import { createProvenBillingLedger } from './support/create-billing-fixture';
import { createTencentBillingProof, signedTencentBillingResponse, tencentBill, tencentBillingSync, TENCENT_BILLING_WINDOW as WINDOW } from './support/create-tencent-billing-fixture';
const error = { response: { code: 'BILLING_AGGREGATE_PRECISION' } };
async function aliyun(costs: Array<{ amount: string; currency?: string }>, ownerUserId?: string) {
  const repository = createMemoryAdminRepository();
  await createProvenBillingLedger(repository, { cloudAccountUid: '100001', regionId: 'cn-hangzhou', cloudResourceId: 'i-owned', cloudResourceType: 'ecs', billingScope: ownerUserId ? 'user' : 'platform', ownerUserId, billingStartAt: new Date('2026-09-01') });
  const bss = { listDailyBillingItems: async () => costs.map((cost, index) => ({ OwnerID: '100001', Region: 'cn-hangzhou', ProductCode: 'ecs', InstanceID: 'i-owned', BillingItem: `component-${index}`, Item: 'PayAsYouGoBill', PretaxAmount: cost.amount, Currency: cost.currency ?? 'CNY' })) } as unknown as BillingBssClient;
  const config = { getExecutionAccountContext: async () => ({ provider: 'alibaba_cloud', accountUid: '100001', accountUidResolved: true }) } as unknown as SystemConfigService;
  await new BillingSyncService(repository, bss, config).syncRange(WINDOW);
  return { repository, service: new BillingService(repository) };
}
afterEach(() => jest.restoreAllMocks());
describe('numeric aggregate precision', () => {
  it.each([undefined, 'owner-1'])('rejects rounded totals but retains exact items for %s', async owner => {
    const { repository, service } = await aliyun([{ amount: '1' }, { amount: '0.000000000000000001' }], owner);
    const before = await repository.listBillingLineItems();
    expect(before.map(row => row.pretaxAmount).sort((a,b) => a-b)).toEqual([1e-18, 1]);
    await expect(service.getSummary(WINDOW)).rejects.toMatchObject(error);
    await expect(service.exportPlatformCsv(WINDOW)).rejects.toMatchObject(error);
    if (owner) {
      await expect(service.getUserSummary(owner, WINDOW)).rejects.toMatchObject(error);
      await expect(service.listUsers(WINDOW)).rejects.toMatchObject(error);
      await expect(service.listUserGroups(WINDOW)).rejects.toMatchObject(error);
      await expect(service.exportUsersCsv(WINDOW)).rejects.toMatchObject(error);
      expect(await service.listUserItems(owner, WINDOW)).toHaveLength(2);
      expect(await service.exportUserItemsCsv(owner, WINDOW)).toContain('1e-18,CNY');
    } else { await expect(service.listPlatformGroups(WINDOW)).rejects.toMatchObject(error); expect(await service.listPlatformItems(WINDOW)).toHaveLength(2); }
    expect(await repository.listBillingLineItems()).toEqual(before);
  });
  it.each([
    [['0.1', '0.2'], 0.3], [['99999999999', '0.000000000000000001', '-99999999999'], 1e-18],
    [['99999999999', '99999999999'], 199999999998], [['-0.100000001', '-0.200000002'], -0.300000003],
  ] as const)('preserves exact sum of %j', async (amounts, total) => {
    const { service } = await aliyun(amounts.map(amount => ({ amount })));
    expect((await service.getSummary(WINDOW)).totalPretaxAmount).toBe(total);
    expect(await service.exportPlatformCsv(WINDOW)).toContain(`totalPretaxAmount,${total}\n`);
  });
  it('does not sum currencies', async () => {
    const { service } = await aliyun([{ amount: '1', currency: 'CNY' }, { amount: '0.000000000000000001', currency: 'USD' }]);
    expect(await service.getSummary(WINDOW)).toMatchObject({ totalPretaxAmount: null, currency: null, currencyTotals: [{ currency: 'CNY', totalPretaxAmount: 1 }, { currency: 'USD', totalPretaxAmount: 1e-18 }] });
  });
  it('retains synced Tencent components even when a numeric aggregate is not representable', async () => {
    const repository = createMemoryAdminRepository(); await createTencentBillingProof(repository);
    jest.spyOn(global, 'fetch').mockImplementation(async () => signedTencentBillingResponse([tencentBill({ ComponentSet: [{ RealCost: '1' }, { RealCost: '0.000000000000000001' }] })]));
    expect(await tencentBillingSync(repository).syncRange(WINDOW)).toMatchObject({ importedLineItems: 2 });
    const before = await repository.listBillingLineItems(), service = new BillingService(repository);
    await expect(service.getSummary(WINDOW)).rejects.toMatchObject(error); await expect(service.exportPlatformCsv(WINDOW)).rejects.toMatchObject(error);
    expect(await service.listPlatformItems(WINDOW)).toHaveLength(2); expect(await repository.listBillingLineItems()).toEqual(before);
  });
});
