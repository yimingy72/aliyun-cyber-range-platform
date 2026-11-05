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
const row = { InstanceID: 'i-owned', OwnerId: 100001, Region: 'cn-beijing', ProductCode: 'ecs',
  CreateTime: '2026-10-01T00:00:00Z', ReleaseTime: '2026-10-20T14:04:00Z', ExpectedReleaseTime: '2026-10-20T14:05:00Z',
  EndTime: '2999-01-01T00:00:00Z', Status: 'Expired', Private: context.accessKeySecret };
const response = (data: Record<string, unknown>): Response => ({ ok: true, status: 200, json: async () => ({
  Success: true, Code: 'Success', RequestId: 'request-lifecycle', Data: { PageNum: 1, PageSize: 100, ...data },
}) }) as Response;

describe('exact billing instance lifecycle reads', () => {
  it('exposes only network product presence and zero/nonzero discount markers from the owner-verified overview', () => runInCloudWorkspace(scope, async () => {
    const repository = createMemoryAdminRepository();
    const { ledger } = await createProvenBillingLedger(repository, { cloudAccountUid: context.accountUid, cloudResourceId: 'eip-owned', cloudResourceType: 'eip',
      regionId: context.defaultRegion, billingScope: 'platform', billingStartAt: new Date('2026-10-01T00:00:00Z'), tagsSnapshot: { CloudAccountContextId: 'context' } });
    const config: any = { getAccountContextById: async () => context };
    global.fetch = jest.fn(async (url: string | URL | Request) => {
      const action = new URL(String(url)).searchParams.get('Action');
      if (action === 'QueryAvailableInstances') return response({ TotalCount: 0, InstanceList: [] });
      if (action === 'QueryBillOverview') return response({ AccountID: context.accountUid, BillingCycle: '2026-10', Items: { Item: [
        { ProductCode: 'eip', CommodityCode: 'eip', OwnerID: context.accountUid, PretaxAmount: '0', PretaxGrossAmount: '0.003', RoundDownDiscount: '0.003', Private: context.accessKeySecret },
        { ProductCode: 'ecs', OwnerID: context.accountUid, PretaxAmount: '98765.4321', InstanceID: 'external-private' },
      ] } });
      return response({ AccountID: context.accountUid, BillingCycle: '2026-10', TotalCount: 0, Items: [] });
    }) as typeof global.fetch;
    const result = await new BillingDiagnosticsService(repository, new BillingBssClient(config), config).monthly({ billingCycle: '2026-10', ledgerIds: ledger.id });
    expect(result.accountNetworkOverview).toMatchObject({ complete: true, rowCount: 2, platformAttribution: false,
      productInventory: [{ ProductCode: 'eip', amountKinds: { PretaxAmount: 'zero', PretaxGrossAmount: 'nonzero', RoundDownDiscount: 'nonzero' } }] });
    expect(JSON.stringify(result.accountNetworkOverview)).not.toMatch(/0\.003|98765|external-private|fixture-secret|Private/);
  }));
  it('requests only the recorded native IDs and keeps actual and expected release times separate', async () => {
    global.fetch = jest.fn().mockResolvedValue(response({ TotalCount: 1, InstanceList: [row] }));
    const evidence = { requestIds: [] as string[], pageCount: 0, rowCount: 0, complete: false };
    const bss = new BillingBssClient({} as any);
    const result = await bss.captureQuery(evidence, () => bss.listInstanceLifecycle(['i-owned'], context));
    expect(result[0]).toMatchObject({ ReleaseTime: row.ReleaseTime, ExpectedReleaseTime: row.ExpectedReleaseTime });
    expect(evidence).toEqual({ requestIds: ['request-lifecycle'], pageCount: 1, rowCount: 1, complete: true });
    const params = new URL((global.fetch as jest.Mock).mock.calls[0][0]).searchParams;
    expect(params.get('Action')).toBe('QueryAvailableInstances'); expect(params.get('InstanceIDs')).toBe('i-owned');
    expect(params.has('EndTimeEnd')).toBe(false); expect(params.has('Region')).toBe(false);
  });
  it.each([
    { TotalCount: 1, InstanceList: [] }, { TotalCount: 0, InstanceList: [row] }, { TotalCount: 2, InstanceList: [row] },
    { TotalCount: 0, PageNum: 2 }, { TotalCount: 0, PageSize: 20 }, { InstanceList: [] },
    { TotalCount: 1, InstanceList: [{ ...row, InstanceID: 'i-foreign' }] },
    { TotalCount: 1, InstanceList: [{ ...row, OwnerId: 'other' }] },
    { TotalCount: 1, InstanceList: [{ ...row, Region: 'cn-hangzhou' }] },
    { TotalCount: 1, InstanceList: [{ ...row, OwnerId: undefined }] },
  ])('rejects incomplete or foreign records: %j', async data => {
    global.fetch = jest.fn().mockResolvedValue(response(data));
    await expect(new BillingBssClient({} as any).listInstanceLifecycle(['i-owned'], context)).rejects.toThrow();
  });
  it.each([[], ['i-owned', 'i-owned'], ['../../secret'], Array.from({ length: 101 }, (_, i) => 'i-' + i)].map(ids => ({ ids })))('rejects unsafe selection before signing: %j', async ({ ids }) => {
    global.fetch = jest.fn(); await expect(new BillingBssClient({} as any).listInstanceLifecycle(ids, context)).rejects.toThrow();
    expect(global.fetch).not.toHaveBeenCalled();
  });
  it('returns a complete empty query without inventing a release receipt', async () => {
    global.fetch = jest.fn().mockResolvedValue(response({ TotalCount: 0, InstanceList: [] }));
    await expect(new BillingBssClient({} as any).listInstanceLifecycle(['i-owned'], context)).resolves.toEqual([]);
  });
  it.each([false, true])('preserves financial history and hides raw lifecycle data (permission failure: %s)', denied => runInCloudWorkspace(scope, async () => {
    const repository = createMemoryAdminRepository();
    const { ledger } = await createProvenBillingLedger(repository, { cloudAccountUid: context.accountUid, cloudResourceId: 'i-owned', cloudResourceType: 'ecs',
      regionId: context.defaultRegion, billingScope: 'platform', billingStartAt: new Date('2026-10-01T00:00:00Z'),
      releasedAt: new Date('2026-10-28T02:13:33Z'), tagsSnapshot: { CloudAccountContextId: 'context' } });
    const config: any = { getAccountContextById: async () => context };
    const replace = jest.spyOn(repository, 'replaceBillingDay'), update = jest.spyOn(repository, 'updateBillingLedgerResource');
    global.fetch = jest.fn(async (url: string | URL | Request) => {
      if (new URL(String(url)).searchParams.get('Action') !== 'QueryAvailableInstances')
        return response({ AccountID: context.accountUid, BillingCycle: '2026-10', TotalCount: 0, Items: [] });
      return denied ? ({ ok: false, status: 403, json: async () => ({ Code: 'NoPermission', Success: false, RequestId: 'request-denied', Message: context.accessKeySecret }) } as Response)
        : response({ TotalCount: 1, InstanceList: [row] });
    }) as typeof global.fetch;
    const result = await new BillingDiagnosticsService(repository, new BillingBssClient(config), config).monthly({ billingCycle: '2026-10', ledgerIds: ledger.id });
    expect(result.complete).toBe(true);
    if (denied) expect(result.instanceLifecycle).toMatchObject({ complete: false, errorCode: 'NoPermission', requestIds: ['request-denied'] });
    else expect(result.instanceLifecycle).toMatchObject({ complete: true, rowCount: 1, automaticLedgerChanges: false,
      resources: [{ cloudResourceId: 'i-owned', returned: true, record: { ReleaseTime: row.ReleaseTime, ExpectedReleaseTime: row.ExpectedReleaseTime } }] });
    expect(JSON.stringify(result.instanceLifecycle)).not.toMatch(/Private|fixture-key|fixture-secret|OwnerId/);
    expect(replace).not.toHaveBeenCalled(); expect(update).not.toHaveBeenCalled();
    expect((await repository.listBillingLedgerResources())[0].releasedAt).toEqual(ledger.releasedAt);
  }));
});

describe('account overview identity', () => {
  it.each([
    { AccountID: 'other', BillingCycle: '2026-10', Items: { Item: [] } },
    { AccountID: context.accountUid, BillingCycle: '2026-09', Items: { Item: [] } },
    { AccountID: context.accountUid, BillingCycle: '2026-10', Items: {} },
    { AccountID: context.accountUid, BillingCycle: '2026-10', Items: { Item: [{ OwnerID: 'other' }] } },
  ])('rejects unverified account, cycle or shape: %j', async data => {
    global.fetch = jest.fn().mockResolvedValue(response(data));
    await expect(new BillingBssClient({} as any).listMonthlyOverview('2026-10', context)).rejects.toThrow();
  });
});
