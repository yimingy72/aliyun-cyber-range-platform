import { BillingBssClient } from '../src/admin/billing-bss-client';
import { BillingSyncService } from '../src/admin/billing-sync.service';
import { BillingReconciliationService } from '../src/admin/billing-reconciliation.service';
import { BillingLifecycleController } from '../src/admin/billing-lifecycle.controller';
import { loadPlatformBillingProof, billRegionConflict } from '../src/admin/billing-platform-scope';
import { cdtBillingIdentity } from '../src/admin/billing-classifier';
import { aliyunPackSnapshotBaselineIssue } from '../src/admin/aliyun-snapshot-ecs-evidence';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';
import { createProvenBillingLedger } from './support/create-billing-fixture';
import { runInCloudWorkspace } from '../src/auth/cloud-workspace-scope';

const day = '2026-10-14';
const scope = { cloudWorkspaceId: 'network-bill-paths', provider: 'alibaba_cloud' as const, accountUid: '100001', actorUserId: 'alice', isPlatformManager: true };
const context: any = { provider: scope.provider, accountUid: scope.accountUid, accountUidResolved: true, cloudAccountContextId: 'fixture-context', defaultRegion: 'cn-beijing', accessKeyId: 'fixture-key', accessKeySecret: 'fixture-secret' };
const config: any = { getAccountContext: async () => context, getExecutionAccountContext: async () => context };
const inScope = <T>(work: () => Promise<T>) => runInCloudWorkspace(scope, work);
const line = (overrides = {}) => ({ OwnerID: scope.accountUid, BillingDate: day, SplitBillingDate: day, ProductCode: 'cbwp', InstanceID: 'cbwp-parent', Region: 'cn-beijing', Currency: 'CNY', CommodityCode: 'cbwp', BillingItemCode: 'Bandwidth', Item: 'PayAsYouGoBill', PretaxAmount: 2, ...overrides });
const response = (rows: unknown[]) => new Response(JSON.stringify({ Success: true, Code: 'Success', RequestId: 'official-filter', Data: { AccountID: scope.accountUid, BillingCycle: '2026-10', TotalCount: rows.length, Items: rows } }));
async function fixture() {
  const repository = createMemoryAdminRepository();
  const origin = await createProvenBillingLedger(repository, { cloudAccountUid: scope.accountUid, cloudResourceId: 'eip-owned', cloudResourceType: 'eip', regionId: 'cn-beijing', ownerUserId: 'alice', billingScope: 'user', billingStartAt: new Date(day) });
  const bss = { listDailyBillingItems: jest.fn().mockResolvedValue([]), listDailySplitBillingItems: jest.fn().mockResolvedValue([]) };
  const sync = new BillingSyncService(repository, bss as any, config);
  const store: any = { snapshotArchive: async () => null, enqueue: jest.fn().mockResolvedValue({ id: 'planner' }), setMode: jest.fn(), settings: async () => ({ mode: 'resource' }) };
  const data: any = { entries: [{ id: 'entry', resources: [{ ledgerId: origin.ledger.id }] }], scope, settings: { workspace: { provider: scope.provider }, mode: 'resource', generation: 0 }, window: { startAtText: day, endAtText: day } };
  store.tasks = async () => data.tasks ?? [];
  const service = new BillingReconciliationService(store, { load: async () => data, loadProof: async () => data } as any, repository, config, bss as any, sync);
  const task: any = { id: 'query', kind: 'direct', billingDate: new Date(day), instanceId: 'eip-owned', cloudAccountUid: scope.accountUid, regionId: 'cn-beijing', targetLedgerIds: [origin.ledger.id] };
  return { repository, origin, bss, sync, store, service, task, data };
}
describe('resource-filtered EIP and snapshot billing paths', () => {
  beforeEach(() => jest.useFakeTimers().setSystemTime(new Date(day)));
  afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });
  it('discovers the EIP split across products while keeping the exact resource, date and account filters', async () => {
    const fetcher = jest.spyOn(global, 'fetch').mockResolvedValue(response([line({ SplitItemID: 'eip-owned' })]));
    const client = new BillingBssClient(config);
    await client.listDailySplitBillingItems({ billingDate: day, splitItemId: 'eip-owned' }, context);
    const params = new URL(String(fetcher.mock.calls[0][0])).searchParams;
    expect(params.get('SplitItemID')).toBe('eip-owned'); expect(params.has('ProductCode')).toBe(false);
    expect(params.get('BillOwnerId')).toBe(scope.accountUid); expect(params.get('IsHideZeroCharge')).toBe('false');
    await expect(client.listDailySplitBillingItems({ billingDate: day }, context)).rejects.toThrow('Invalid split');
  });
  it.each(['resource', 'account', 'date'])('rejects an unrelated %s in a filtered EIP split response', async mismatch => {
    jest.spyOn(global, 'fetch').mockResolvedValue(response([line({ SplitItemID: mismatch === 'resource' ? 'eip-foreign' : 'eip-owned', OwnerID: mismatch === 'account' ? '200002' : scope.accountUid, SplitBillingDate: mismatch === 'date' ? '2026-10-15' : day })]));
    await expect(new BillingBssClient(config).listDailySplitBillingItems({ billingDate: day, splitItemId: 'eip-owned' }, context)).rejects.toThrow();
  });
  it('limits historical native-ID discovery to the original range tag', async () => {
    const fetcher = jest.spyOn(global, 'fetch').mockResolvedValue(response([]));
    await new BillingBssClient(config).listDailySplitBillingItems({ billingDate: day, tagFilter: { key: 'RangeInstanceId', value: 'original-range' } }, context);
    const params = new URL(String(fetcher.mock.calls[0][0])).searchParams;
    expect(params.get('TagFilter.1.TagKey')).toBe('RangeInstanceId'); expect(params.get('TagFilter.1.TagValues.1')).toBe('original-range');
    expect(params.get('BillOwnerId')).toBe(scope.accountUid);
  });
  it.each(['matching', 'foreign', 'missing'])('validates the returned original range tag: %s', async state => {
    jest.spyOn(global, 'fetch').mockResolvedValue(response([line({ SplitItemID: 'eip-owned', Tag: state === 'missing' ? undefined : `key:RangeInstanceId value:${state === 'matching' ? 'original-range' : 'foreign-range'}; key:CloudProvider value:alibaba_cloud` })]));
    const read = new BillingBssClient(config).listDailySplitBillingItems({ billingDate: day, tagFilter: { key: 'RangeInstanceId', value: 'original-range' } }, context);
    if (state === 'matching') await expect(read).resolves.toHaveLength(1);
    else await expect(read).rejects.toThrow('BILLING_TAG_FILTER_UNVERIFIED');
  });
  it('adopts only the exact EIP share after the entire parent group balances, including an external remainder', async () => inScope(async () => {
    const f = await fixture();
    f.bss.listDailySplitBillingItems.mockResolvedValue([line({ SplitItemID: 'eip-owned', PretaxAmount: 0.75 }), line({ SplitItemID: 'eip-external', PretaxAmount: 1.25 })]);
    const result = await f.sync.prepareScopedRows({ billingDate: day, context, items: [line()], splitInstanceId: 'cbwp-parent', splitProducts: ['cbwp'] });
    expect(result.issue).toBeUndefined(); expect(result.groups.flatMap(g => g.items)).toMatchObject([{ cloudResourceId: 'eip-owned', pretaxAmount: 0.75 }]);
    expect(result.coveredCategories?.[f.origin.ledger.id]).toEqual(['network_usage']);
    f.bss.listDailySplitBillingItems.mockResolvedValue([line({ SplitItemID: 'eip-owned', PretaxAmount: 0.75 })]);
    const unsafe = await f.sync.prepareScopedRows({ billingDate: day, context, items: [line()], splitInstanceId: 'cbwp-parent', splitProducts: ['cbwp'] });
    expect(unsafe.issue?.code).toBe('ALLOCATION_PENDING'); expect(unsafe.groups).toEqual([]);
  }));
  it('finds shared-bandwidth fees when the native EIP bill is empty without querying all account bills', async () => inScope(async () => {
    const f = await fixture(); const proof = await loadPlatformBillingProof(f.repository);
    f.bss.listDailyBillingItems.mockImplementation(async input => input.instanceId === 'cbwp-parent' ? [line()] : []);
    f.bss.listDailySplitBillingItems.mockImplementation(async input => input.splitItemId ? [line({ SplitItemID: 'eip-owned', PretaxAmount: 0.75 })] : [line({ SplitItemID: 'eip-owned', PretaxAmount: 0.75 }), line({ SplitItemID: 'eip-external', PretaxAmount: 1.25 })]);
    const result = await (f.service as any).query({ task: f.task }, context, proof);
    expect(result.coveredLedgerIds).toEqual([f.origin.ledger.id]); expect(result.groups.flatMap((g: any) => g.items)).toMatchObject([{ pretaxAmount: 0.75 }]);
    expect(f.bss.listDailySplitBillingItems).toHaveBeenCalledWith({ billingDate: day, splitItemId: 'eip-owned' }, context);
    expect(f.bss.listDailyBillingItems.mock.calls.every(([input]) => Boolean(input.instanceId))).toBe(true);
  }));
  it('keeps a no-row EIP result unknown after both native and split queries', async () => inScope(async () => {
    const f = await fixture(); const result = await (f.service as any).query({ task: f.task }, context, await loadPlatformBillingProof(f.repository));
    expect(result).toMatchObject({ groups: [], coveredLedgerIds: [], rowCount: 0, evidence: { emptyReason: 'EIP_BILL_NOT_RETURNED' } });
  }));
  it('discovers single-VM traffic from an exact historical CDT ID without mixing in snapshot or another host fees', async () => inScope(async () => {
    const f=await fixture();
    const source=await createProvenBillingLedger(f.repository,{cloudAccountUid:scope.accountUid,cloudResourceId:'i-network',cloudResourceType:'ecs',regionId:'cn-beijing',ownerUserId:'alice',billingScope:'user',billingStartAt:new Date(day)});
    const nativeId='i-network;cn-beijing;BGP;0';
    const raw=line({ProductCode:'cdt',CommodityCode:'cdt',InstanceID:nativeId,SplitItemID:'i-network',PretaxAmount:0.125});
    f.bss.listDailyBillingItems.mockImplementation(async input=>input.instanceId===nativeId?[raw]:[]);
    f.bss.listDailySplitBillingItems.mockImplementation(async input=>input.tagFilter?[raw,{...raw,InstanceID:'i-other;cn-beijing;BGP;0',SplitItemID:'i-other'}]:input.instanceId===nativeId?[raw]:[]);
    const task={...f.task,kind:'discovery',productCode:'cdt',instanceId:'i-network',targetLedgerIds:[source.ledger.id]};
    const result=await (f.service as any).query({task},context,await loadPlatformBillingProof(f.repository));
    expect(result.groups.flatMap((group:any)=>group.items)).toMatchObject([{cloudResourceId:'i-network',pretaxAmount:0.125,billingScope:'user',ownerUserId:'alice'}]);
    expect(f.bss.listDailyBillingItems.mock.calls.every(([input])=>Boolean(input.instanceId)&&input.productCode==='cdt')).toBe(true);
    expect(f.bss.listDailySplitBillingItems.mock.calls.every(([input])=>input.productCode==='cdt')).toBe(true);
  }));
  it('discovers and matches an exact historical CDT compound ID without guessing aliases or taking another EIP fee', async () => inScope(async () => {
    const f = await fixture(), nativeId = 'eip-owned;cn-beijing;BGP;0';
    const raw = line({ ProductCode: 'cdt', CommodityCode: 'cdt', InstanceID: nativeId, SplitItemID: 'UNSPLIT_ITEM', PretaxAmount: 0.0625 });
    f.bss.listDailyBillingItems.mockImplementation(async input => input.instanceId === nativeId ? [raw] : []);
    f.bss.listDailySplitBillingItems.mockImplementation(async input => input.tagFilter ? [raw, { ...raw, InstanceID: 'eip-external;cn-beijing;BGP;0' }] : input.instanceId === nativeId ? [raw] : []);
    const result = await (f.service as any).query({ task: f.task }, context, await loadPlatformBillingProof(f.repository));
    expect(result.issue).toBeUndefined(); expect(result.groups.flatMap((g: any) => g.items)).toMatchObject([{ cloudResourceId: 'eip-owned', pretaxAmount: 0.0625 }]);
    expect(f.bss.listDailySplitBillingItems).toHaveBeenCalledWith({ billingDate: day, tagFilter: { key: 'RangeInstanceId', value: f.origin.instance.id } }, context);
    expect(f.bss.listDailyBillingItems.mock.calls.every(([input]) => Boolean(input.instanceId))).toBe(true);
    expect(f.bss.listDailyBillingItems).not.toHaveBeenCalledWith(expect.objectContaining({ instanceId: 'eip-external;cn-beijing;BGP;0' }), context);
  }));
  it('retains an official zero CDT compound bill and rejects conflicting regions or malformed identities', async () => inScope(async () => {
    const f = await fixture(), raw = line({ ProductCode: 'cdt', CommodityCode: 'cdt', InstanceID: 'eip-owned;cn-beijing;BGP;0', Region: undefined, PretaxAmount: 0 });
    f.bss.listDailySplitBillingItems.mockResolvedValue([{ ...raw, SplitItemID: 'UNSPLIT_ITEM' }]);
    const result = await f.sync.prepareScopedRows({ billingDate: day, context, items: [raw], splitInstanceId: raw.InstanceID, splitProducts: ['cdt'] });
    expect(result.groups.flatMap(g => g.items)).toMatchObject([{ cloudResourceId: 'eip-owned', pretaxAmount: 0 }]);
    expect(billRegionConflict({ ...raw, RegionId: 'cn-shanghai' })).toBe(true);
    for (const id of ['eip-owned;cn-beijing;BGP;0;other', 'eip-owned;unknown;BGP;0', 'eip-owned;cn-beijing;BGP;0junk']) expect(cdtBillingIdentity(id)).toBeNull();
  }));
  it('retains the native 18-month query path outside the shorter split-bill history', async () => inScope(async () => {
    const f = await fixture(); jest.setSystemTime(new Date('2027-11-01'));
    await (f.service as any).query({ task: f.task }, context, await loadPlatformBillingProof(f.repository));
    expect(f.bss.listDailyBillingItems).toHaveBeenCalled(); expect(f.bss.listDailySplitBillingItems).not.toHaveBeenCalled();
  }));
  it('does not count a native EIP financial group twice when the same group is also returned through splits', async () => inScope(async () => {
    const f = await fixture(), raw = line({ ProductCode: 'eip', CommodityCode: 'eip', InstanceID: 'eip-owned', PretaxAmount: 1 });
    f.bss.listDailyBillingItems.mockResolvedValue([raw]); f.bss.listDailySplitBillingItems.mockResolvedValue([{ ...raw, SplitItemID: 'eip-owned' }]);
    const result = await (f.service as any).query({ task: f.task }, context, await loadPlatformBillingProof(f.repository));
    expect(result.groups).toHaveLength(1); expect(result.groups[0].items).toHaveLength(1); expect(result.groups[0].items[0].pretaxAmount).toBe(1);
  }));
  it('checks an exact snapshot bill before attempting source-ECS allocation', async () => inScope(async () => {
    const f = await fixture();
    const artifact = await f.repository.createPackedImageArtifact({ cloudAccountContextId: 'fixture-context', cloudAccountUid: scope.accountUid, regionId: 'cn-beijing', ownerUserId: 'alice', sourceRangeInstanceId: f.origin.instance.id, sourceHostKey: 'host', sourceInstanceId: 'i-source', sourceDiskIds: ['d-source'] });
    await f.repository.updatePackedImageArtifact(artifact.id, { imageId: 'm-owned', backingSnapshotIds: ['s-owned'] });
    const snapshot = await f.repository.createBillingLedgerResource({ cloudAccountUid: scope.accountUid, regionId: 'cn-beijing', cloudResourceType: 'snapshot', cloudResourceId: 's-owned', billingScope: 'user', ownerUserId: 'alice', rangeInstanceId: f.origin.instance.id, billingStartAt: new Date(day) });
    const task = { ...f.task, kind: 'snapshot_source', productCode: 'snapshot', instanceId: 'i-source', splitItemId: 's-owned', targetLedgerIds: [snapshot.id] };
    f.bss.listDailyBillingItems.mockResolvedValue([line({ ProductCode: 'snapshot', InstanceID: 's-owned', PretaxAmount: 0.125 })]);
    const result = await (f.service as any).query({ task }, context, await loadPlatformBillingProof(f.repository));
    expect(result.coveredLedgerIds).toEqual([snapshot.id]); expect(f.bss.listDailySplitBillingItems).not.toHaveBeenCalled();
    f.bss.listDailyBillingItems.mockResolvedValue([]);
    f.bss.listDailySplitBillingItems.mockImplementation(async input => input.splitItemId === 'i-source' ? [line({ ProductCode: 'snapshot', SplitItemID: 'i-source' })] : []);
    const blocked = await (f.service as any).query({ task }, context, await loadPlatformBillingProof(f.repository));
    expect(blocked.issue?.code).toBe('SNAPSHOT_BASELINE_MISSING'); expect(blocked.groups).toEqual([]);
    expect(f.bss.listDailyBillingItems.mock.calls.at(-1)?.[0]).toMatchObject({ instanceId: 's-owned' });
    expect(aliyunPackSnapshotBaselineIssue(artifact, day)).toBe('SNAPSHOT_BASELINE_MISSING');
  }));
  it('queues only the requested visible resource IDs and rejects another resource before switching legacy mode', async () => inScope(async () => {
    const f = await fixture();
    await f.service.request({ startAt: day, endAt: day, ledgerIds: [f.origin.ledger.id] });
    expect(f.store.enqueue.mock.calls[0][0].targetLedgerIds).toEqual([f.origin.ledger.id]);
    f.data.settings.mode = 'legacy';
    await expect(f.service.request({ startAt: day, endAt: day, ledgerIds: ['foreign-ledger'] })).rejects.toThrow('资源不在');
    expect(f.store.setMode).not.toHaveBeenCalled();
    const controller = new BillingLifecycleController({} as any, f.service);
    expect(() => controller.schedule({ ledgerIds: [f.origin.ledger.id, f.origin.ledger.id] })).toThrow('准确账目');
  }));
  it('reports only queries for the selected resources, period and latest original planner attempt', async () => inScope(async () => {
    const f = await fixture(), ledger = f.origin.ledger;
    f.data.ledgers = [ledger]; f.data.proof = { packedImages: [] };
    const task: any = { id: 'planner', kind: 'planner', status: 'planned', billingDate: new Date(day), targetLedgerIds: [ledger.id], queryPlan: { input: { startAt: day, endAt: day } } };
    f.store.task = async () => task;
    f.store.attempts = async () => [{ id: 'attempt', startedAt: new Date(day), evidence: {} }];
    const child = { ...task, id: 'query', kind: 'direct', status: 'empty', lastQueriedAt: new Date(day + 'T01:00:00Z'), queryPlan: { resourceQueryVersion: 2 } };
    f.data.tasks = [child, { ...child, targetLedgerIds: ['foreign-ledger'] }, { ...child, billingDate: new Date('2026-10-13') }, { ...child, queryPlan: { resourceQueryVersion: 2, transactionProbe: true } }];
    const details = await f.service.taskDetails('planner');
    expect(details.resourceRecheck).toMatchObject({ targetResources: 1, resourceDayQueries: 1, queriedResourceDays: 1, queriedResources: 1, outcomes: { empty: 1 } });
  }));
});
