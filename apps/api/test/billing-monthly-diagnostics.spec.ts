import { BillingBssClient } from '../src/admin/billing-bss-client';
import { BillingDiagnosticsService } from '../src/admin/billing-diagnostics.service';
import { runInCloudWorkspace } from '../src/auth/cloud-workspace-scope';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';
import { createProvenBillingLedger } from './support/create-billing-fixture';
import { assertDelegatedApiScopes, resolveDelegatedScopes } from '../src/auth/delegated-api-scopes';

const scope = { cloudWorkspaceId: 'workspace', provider: 'alibaba_cloud' as const, accountUid: '100001' };
const context: any = { provider: scope.provider, accountUid: scope.accountUid, accountUidResolved: true, cloudAccountContextId: 'context',
  defaultRegion: 'cn-beijing', accessKeyId: 'fixture-key', accessKeySecret: 'fixture-secret' };
const response = (data: Record<string, unknown>, requestId = 'request-1'): Response => ({ ok: true, status: 200, json: async () => ({
  Success: true, Code: 'Success', RequestId: requestId, Data: { AccountID: scope.accountUid, BillingCycle: '2026-10', ...data },
}) }) as Response;
const row = { ProductCode: 'eip', InstanceID: 'eip-owned', OwnerID: scope.accountUid, Currency: 'CNY', PretaxAmount: '0' };
const savedFetch = global.fetch, savedStart = process.env.PLATFORM_BILLING_STARTED_AT;
beforeEach(() => { delete process.env.PLATFORM_BILLING_STARTED_AT; });
afterEach(() => { global.fetch = savedFetch; jest.restoreAllMocks(); if (savedStart === undefined) delete process.env.PLATFORM_BILLING_STARTED_AT; else process.env.PLATFORM_BILLING_STARTED_AT = savedStart; });

async function fixture() {
  const repository = createMemoryAdminRepository();
  const { ledger } = await createProvenBillingLedger(repository, { cloudResourceId: 'eip-owned', cloudResourceType: 'eip',
    cloudAccountUid: scope.accountUid, regionId: context.defaultRegion, billingScope: 'platform',
    billingStartAt: new Date('2026-10-01T00:00:00Z'), releasedAt: new Date('2026-10-02T00:00:00Z'), tagsSnapshot: { CloudAccountContextId: 'context' } });
  const config: any = { getAccountContextById: jest.fn(async () => context) };
  const bss = new BillingBssClient(config), service = new BillingDiagnosticsService(repository, bss, config);
  return { repository, ledger, bss, config, service, input: { billingCycle: '2026-10', ledgerIds: ledger.id } };
}

describe('read-only monthly diagnostic boundary', () => {
  it('reads complete ordinary and split inventories, keeps zero/refund precision and hides unrelated IDs, amounts and raw payloads', () => runInCloudWorkspace(scope, async () => {
    const { repository, service, input, ledger } = await fixture();
    const replace = jest.spyOn(repository, 'replaceBillingDay'), release = jest.spyOn(repository, 'updateBillingLedgerResource');
    global.fetch = jest.fn()
      .mockResolvedValueOnce(response({ TotalCount: 3, Items: [row], NextToken: 'page-2' }))
      .mockResolvedValueOnce(response({ TotalCount: 3, Items: [{ ...row, Item: 'Refund', PretaxAmount: '-0.000000000000000001' },
        { ProductCode: 'external_product', InstanceID: 'external-private', PretaxAmount: '98765.4321', Password: context.accessKeySecret }] }, 'request-2'))
      .mockResolvedValueOnce(response({ TotalCount: 1, Items: [{ ...row, InstanceID: 'bandwidth-parent', SplitItemID: 'eip-owned', Private: context.accessKeyId }] }, 'request-3'))
      .mockResolvedValue(response({ TotalCount: 0 }));
    const result = await service.monthly(input);
    expect(result).toMatchObject({ complete: true, billingWrites: 0, queries: [
      { complete: true, pageCount: 2, rowCount: 3, requestIds: ['request-1', 'request-2'], resources: [{ rowCount: 2, rows: [
        { PretaxAmount: '0' }, { PretaxAmount: '-0.000000000000000001' },
      ] }] },
      { complete: true, resources: [{ rowCount: 1, rows: [{ InstanceID: 'bandwidth-parent', SplitItemID: 'eip-owned' }] }] },
      { complete: true, productCode: 'cdt', resources: [{ rowCount: 0 }] }, { complete: true, productCode: 'cbwp', resources: [{ rowCount: 0 }] },
    ] });
    expect(JSON.stringify(result)).not.toMatch(/external-private|98765|fixture-key|fixture-secret|Password|Private/);
    expect(result.queries[0]).toMatchObject({ productInventory: expect.arrayContaining([{ ProductCode: 'external_product', rowCount: 1 }]) });
    expect(replace).not.toHaveBeenCalled(); expect(release).not.toHaveBeenCalled();
    expect((await repository.listBillingLedgerResources()).find(r => r.id === ledger.id)?.releasedAt).toEqual(ledger.releasedAt);
    for (const [url] of (global.fetch as jest.Mock).mock.calls) {
      const params = new URL(url).searchParams;
      if (params.get('Action') === 'GetResourceConfigurationTimeline') {
        expect(params.get('ResourceId')).toBe('eip-owned'); expect(params.get('Region')).toBe('cn-beijing'); continue;
      }
      if (params.get('Action') === 'QueryAvailableInstances') {
        expect(params.get('InstanceIDs')).toBe('eip-owned'); continue;
      }
      if (params.get('Action') === 'QueryBillOverview') {
        expect(params.get('BillingCycle')).toBe('2026-10'); expect(params.get('BillOwnerId')).toBe(scope.accountUid); continue;
      }
      if (['QueryBill', 'QuerySettleBill', 'QueryAccountBill'].includes(params.get('Action') ?? '')) {
        expect(params.get('BillingCycle')).toBe('2026-10'); expect(params.get('BillOwnerId')).toBe(scope.accountUid);
        if (params.get('Action') !== 'QueryAccountBill') expect(params.get('IsHideZeroCharge')).toBe('false');
        expect(params.has('Status')).toBe(false); continue;
      }
      expect(params.get('Granularity')).toBe('MONTHLY'); expect(params.get('IsHideZeroCharge')).toBe('false');
      expect(params.get('BillOwnerId')).toBe(scope.accountUid); expect(params.has('BillingDate')).toBe(false);
    }
  }));
  it.each([{ billingCycle: '2026-13' }, { billingCycle: '2026-09' }, { billingCycle: '2026-11' }, { ledgerIds: '' },
    { ledgerIds: '../external' }, { extra: true }, { ledgerIds: 'foreign-ledger' }])('rejects unscoped input %j before any cloud query', extra => runInCloudWorkspace(scope, async () => {
    const { service, input } = await fixture(); global.fetch = jest.fn();
    await expect(service.monthly({ ...input, ...extra })).rejects.toThrow(); expect(global.fetch).not.toHaveBeenCalled();
  }));
  it('rejects duplicate IDs, changed original identity and absent workspace', async () => {
    await runInCloudWorkspace(scope, async () => {
      const { service, config, input } = await fixture(); global.fetch = jest.fn();
      await expect(service.monthly({ ...input, ledgerIds: input.ledgerIds + ',' + input.ledgerIds })).rejects.toThrow();
      config.getAccountContextById.mockResolvedValue({ ...context, accountUid: 'other' });
      await expect(service.monthly(input)).rejects.toThrow('changed'); expect(global.fetch).not.toHaveBeenCalled();
    });
    const { service, input } = await fixture(); await expect(service.monthly(input)).rejects.toThrow('workspace');
  });
  it('reports an incomplete query as a failure rather than an empty verified bill', () => runInCloudWorkspace(scope, async () => {
    const { service, input } = await fixture(); global.fetch = jest.fn()
      .mockResolvedValueOnce(response({ TotalCount: 2, Items: [row] }))
      .mockResolvedValue(response({ TotalCount: 0, Items: [] }));
    const result = await service.monthly(input);
    expect(result.complete).toBe(false); expect(result.queries[0]).toMatchObject({ complete: false, errorCode: 'BILLING_DIAGNOSTIC_INCOMPLETE' });
    expect(result.queries[0]).not.toHaveProperty('resources');
    expect(result.queries[1]).toMatchObject({ complete: true, resources: [{ rowCount: 0 }] });
  }));
  it('distinguishes authorization failure and retains its safe native request ID', () => runInCloudWorkspace(scope, async () => {
    const { service, input } = await fixture(); global.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: false, status: 403, json: async () => ({ Success: false, Code: 'NoPermission', RequestId: 'request-denied', Message: context.accessKeySecret }) })
      .mockResolvedValue(response({ TotalCount: 0 }));
    const result = await service.monthly(input);
    expect(result.complete).toBe(false); expect(result.queries[0]).toMatchObject({ errorCode: 'NoPermission', requestIds: ['request-denied'] });
    expect(result.queries.slice(1).every(query => query.complete)).toBe(true);
  }));
  it('does not adopt another CDT region or a name-only reference as an exact resource match', () => runInCloudWorkspace(scope, async () => {
    const { service, input } = await fixture(); global.fetch = jest.fn()
      .mockResolvedValueOnce(response({ TotalCount: 3, Items: [
        { ...row, ProductCode: 'cdt', InstanceID: 'eip-owned;cn-hangzhou;EIP;1' },
        { ...row, InstanceID: 'external-private', ItemName: 'eip-owned' },
        { ...row, InstanceID: 'eip-owned-suffix' },
      ] })).mockResolvedValue(response({ TotalCount: 0 }));
    const result = await service.monthly(input);
    expect(result.queries[0]).toMatchObject({ resources: [{ rowCount: 0, referenceMatchFields: ['InstanceID', 'ItemName'] }] });
    expect(JSON.stringify(result)).not.toContain('external-private');
  }));
  it('requires billing read at the delegated API boundary', () => {
    const path = '/admin/billing/diagnostics/monthly';
    expect(() => assertDelegatedApiScopes('GET', path, resolveDelegatedScopes('admin', ['jobs:read']))).toThrow();
    expect(() => assertDelegatedApiScopes('GET', path, resolveDelegatedScopes('admin', ['billing:read']))).not.toThrow();
  });
});

describe('monthly inventory integrity', () => {
  it.each([
    { TotalCount: 1, Items: [] }, { TotalCount: 0, Items: [], NextToken: 'bad' }, { Items: [] },
    { AccountID: 'foreign', TotalCount: 0 }, { BillingCycle: '2026-09', TotalCount: 0 },
    { TotalCount: 1, Items: [{ ...row, OwnerID: 'foreign' }] }, { TotalCount: 1, Items: [{ ...row, SplitAccountID: 'foreign' }] },
    { TotalCount: 1, Items: [{ ...row, SplitBillingCycle: '2026-09' }] }, { TotalCount: 2, Items: [row, row] },
    { TotalCount: 30_001, Items: [] },
  ])('rejects incomplete or inconsistent inventory %j', async data => {
    global.fetch = jest.fn().mockResolvedValue(response(data));
    await expect(new BillingBssClient({} as any).listMonthlyDiagnosticItems('2026-10', 'DescribeInstanceBill', context)).rejects.toThrow();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
