import { BillingBssClient } from '../src/admin/billing-bss-client';
import { BillingDiagnosticsService } from '../src/admin/billing-diagnostics.service';
import { runInCloudWorkspace } from '../src/auth/cloud-workspace-scope';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';
import { createProvenBillingLedger } from './support/create-billing-fixture';

const context: any = { provider: 'alibaba_cloud', accountUid: '100001', accountUidResolved: true, cloudAccountContextId: 'context',
  defaultRegion: 'cn-beijing', accessKeyId: 'fixture-key', accessKeySecret: 'fixture-secret' };
const scope: any = { cloudWorkspaceId: 'workspace', provider: context.provider, accountUid: context.accountUid };
const originalFetch = global.fetch;
afterEach(() => { global.fetch = originalFetch; jest.restoreAllMocks(); });
const row = { OwnerID: context.accountUid, ProductCode: 'eip', RecordID: 'record-1', Status: 'NoSettle', PretaxAmount: '0', PretaxGrossAmount: '0.003' };
const response = (data: Record<string, unknown>): Response => ({ ok: true, status: 200, json: async () => ({
  Success: true, Code: 'Success', RequestId: 'request-settlement',
  Data: { AccountID: context.accountUid, BillingCycle: '2026-10', PageNum: 1, PageSize: 300, ...data },
}) }) as Response;

describe('network settlement diagnostic', () => {
  it('uses complete native token pagination for the modern settlement API', async () => {
    global.fetch = jest.fn().mockResolvedValueOnce(response({ TotalCount: 2, MaxResults: 300, NextToken: 'page-2', Items: { Item: [row] } }))
      .mockResolvedValueOnce(response({ TotalCount: 2, MaxResults: 300, Items: { Item: [{ ...row, RecordID: 'record-2' }] } }));
    const bss = new BillingBssClient({} as any), evidence = { requestIds: [] as string[], pageCount: 0, rowCount: 0, complete: false };
    await bss.captureQuery(evidence, () => bss.listMonthlyNetworkBills('2026-10', 'eip', context, 'QuerySettleBill'));
    expect(evidence).toMatchObject({ complete: true, pageCount: 2, rowCount: 2 });
    for (const [index, [url]] of (global.fetch as jest.Mock).mock.calls.entries()) {
      const params = new URL(url).searchParams;
      expect(params.get('Action')).toBe('QuerySettleBill'); expect(params.get('MaxResults')).toBe('300');
      expect(params.get('NextToken')).toBe(index ? 'page-2' : null); expect(params.has('PageNum')).toBe(false);
    }
  });
  it('does not interpret a repeated token as a complete empty settlement query', async () => {
    global.fetch = jest.fn().mockResolvedValueOnce(response({ TotalCount: 3, NextToken: 'repeat', Items: { Item: [row] } }))
      .mockResolvedValueOnce(response({ TotalCount: 3, NextToken: 'repeat', Items: { Item: [{ ...row, RecordID: 'record-2' }] } }));
    await expect(new BillingBssClient({} as any).listMonthlyNetworkBills('2026-10', 'eip', context, 'QuerySettleBill')).rejects.toThrow('pagination');
  });
  it.each([{ TotalCount: 1, Items: { Item: [] } }, { TotalCount: 0, NextToken: 42 }, { TotalCount: 0, MaxResults: 20 },
    { TotalCount: 0, Items: [row] }])('rejects incomplete modern settlement data %j', async data => {
    global.fetch = jest.fn().mockResolvedValue(response(data));
    await expect(new BillingBssClient({} as any).listMonthlyNetworkBills('2026-10', 'eip', context, 'QuerySettleBill')).rejects.toThrow();
  });
  it('queries owner/product account totals separately without inventing a payment status', async () => {
    global.fetch = jest.fn().mockResolvedValue(response({ TotalCount: 1, Items: { Item: [{ ...row, Status: undefined }] } }));
    const result = await new BillingBssClient({} as any).listMonthlyNetworkBills('2026-10', 'eip', context, 'QueryAccountBill');
    expect(result[0].Status).toBeUndefined();
    const params = new URL((global.fetch as jest.Mock).mock.calls[0][0]).searchParams;
    expect(params.get('Action')).toBe('QueryAccountBill'); expect(params.get('IsGroupByProduct')).toBe('true');
    expect(params.get('Granularity')).toBe('MONTHLY'); expect(params.has('IsHideZeroCharge')).toBe(false);
  });
  it('reads complete pages with zero charges and every payment status included', async () => {
    global.fetch = jest.fn().mockResolvedValueOnce(response({ TotalCount: 2, Items: { Item: [row] } }))
      .mockResolvedValueOnce(response({ TotalCount: 2, PageNum: 2, Items: { Item: [{ ...row, RecordID: 'record-2', Status: 'PayUnsettle' }] } }));
    const bss = new BillingBssClient({} as any), evidence = { requestIds: [] as string[], pageCount: 0, rowCount: 0, complete: false };
    const result = await bss.captureQuery(evidence, () => bss.listMonthlyNetworkBills('2026-10', 'eip', context));
    expect(result.map(row => row.Status)).toEqual(['NoSettle', 'PayUnsettle']);
    expect(evidence).toMatchObject({ complete: true, pageCount: 2, rowCount: 2 });
    for (const [index, [url]] of (global.fetch as jest.Mock).mock.calls.entries()) {
      const params = new URL(url).searchParams;
      expect(params.get('Action')).toBe('QueryBill'); expect(params.get('BillOwnerId')).toBe(context.accountUid);
      expect(params.get('PageNum')).toBe(String(index + 1)); expect(params.get('IsHideZeroCharge')).toBe('false');
      expect(params.has('Type')).toBe(false); expect(params.has('SubscriptionType')).toBe(false);
    }
  });
  it('accepts a verified empty settlement result without inventing NoSettle records', async () => {
    global.fetch = jest.fn().mockResolvedValue(response({ TotalCount: 0 }));
    await expect(new BillingBssClient({} as any).listMonthlyNetworkBills('2026-10', 'eip', context)).resolves.toEqual([]);
  });
  it.each([
    { AccountID: 'other', TotalCount: 0 }, { BillingCycle: '2026-09', TotalCount: 0 }, { PageNum: 2, TotalCount: 0 },
    { PageSize: 20, TotalCount: 0 }, { TotalCount: 1, Items: { Item: [] } }, { TotalCount: 30001, Items: { Item: [] } },
    { TotalCount: 1, Items: { Item: [{ ...row, OwnerID: 'other' }] } },
    { TotalCount: 1, Items: { Item: [{ ...row, ProductCode: 'ecs' }] } },
    { TotalCount: 1, Items: { Item: [{ ...row, Status: undefined }] } }, { TotalCount: 2, Items: { Item: [row, row] } },
  ])('rejects incomplete, duplicated or foreign settlement data: %j', async data => {
    global.fetch = jest.fn().mockResolvedValue(response(data));
    await expect(new BillingBssClient({} as any).listMonthlyNetworkBills('2026-10', 'eip', context)).rejects.toThrow();
  });
  it('rejects scope or product changes before making a request', async () => {
    global.fetch = jest.fn(); const bss = new BillingBssClient({} as any);
    await expect(bss.listMonthlyNetworkBills('2026-13', 'eip', context)).rejects.toThrow();
    await expect(bss.listMonthlyNetworkBills('2026-10', 'ecs' as any, context)).rejects.toThrow();
    await expect(bss.listMonthlyNetworkBills('2026-10', 'eip', { ...context, accountUidResolved: false })).rejects.toThrow();
    expect(global.fetch).not.toHaveBeenCalled();
  });
  it.each([false, true])('compares the instance dimension, preserves financial data and reports settlement permission separately (%s)', denied => runInCloudWorkspace(scope, async () => {
    const repository = createMemoryAdminRepository();
    const { ledger } = await createProvenBillingLedger(repository, { cloudAccountUid: context.accountUid, cloudResourceId: 'eip-owned', cloudResourceType: 'eip',
      regionId: context.defaultRegion, billingScope: 'platform', billingStartAt: new Date('2026-10-01T00:00:00Z'), tagsSnapshot: { CloudAccountContextId: 'context' } });
    const config: any = { getAccountContextById: async () => context };
    const replace = jest.spyOn(repository, 'replaceBillingDay'), update = jest.spyOn(repository, 'updateBillingLedgerResource');
    global.fetch = jest.fn(async (url: string | URL | Request) => {
      const params = new URL(String(url)).searchParams, action = params.get('Action'), productCode = params.get('ProductCode');
      if (['QueryBill', 'QuerySettleBill', 'QueryAccountBill', 'GetResourceConfigurationTimeline'].includes(action ?? '')) {
        if (denied || action === 'GetResourceConfigurationTimeline') return { ok: false, status: 403,
          json: async () => ({ Code: 'NoPermission', RequestId: 'request-denied', Message: context.accessKeySecret }) } as Response;
        return response({ TotalCount: 1, Items: { Item: [{ ...row, ProductCode: productCode, InstanceID: 'external-private', Secret: context.accessKeySecret }] } });
      }
      if (action === 'QueryBillOverview') return response({ Items: { Item: [] } });
      if (action === 'QueryAvailableInstances') return response({ TotalCount: 0, PageSize: 100, InstanceList: [] });
      if (action === 'DescribeInstanceBill' && params.get('IsBillingItem') === 'false')
        return response({ TotalCount: 1, Items: [{ ...row, ProductCode: productCode, InstanceID: 'external-private', Secret: context.accessKeySecret }] });
      return response({ TotalCount: 0, Items: [] });
    }) as typeof global.fetch;
    const result = await new BillingDiagnosticsService(repository, new BillingBssClient(config), config).monthly({ billingCycle: '2026-10', ledgerIds: ledger.id });
    expect(result.complete).toBe(true); expect(result.billingWrites).toBe(0);
    const dimension: any = result.networkBillingDimensions;
    expect(dimension).toMatchObject({ complete: !denied, platformAttribution: false });
    expect(dimension.queries).toHaveLength(12);
    expect(dimension.queries[0]).toMatchObject({ action: 'DescribeInstanceBill', isBillingItem: false, productCode: 'eip', complete: true, rowCount: 1 });
    expect(dimension.queries[1]).toMatchObject(denied ? { complete: false, errorCode: 'NoPermission', requestIds: ['request-denied'] }
      : { action: 'QueryBill', complete: true, productInventory: [{ Status: 'NoSettle', amountKinds: { PretaxAmount: 'zero', PretaxGrossAmount: 'nonzero' } }] });
    expect(JSON.stringify(dimension)).not.toMatch(/0\.003|external-private|fixture-secret|Secret|RecordID/);
    expect(replace).not.toHaveBeenCalled(); expect(update).not.toHaveBeenCalled();
  }));
});
