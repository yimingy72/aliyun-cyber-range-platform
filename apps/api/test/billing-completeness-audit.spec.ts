import { BillingBssClient } from '../src/admin/billing-bss-client';
import { BillingSyncService } from '../src/admin/billing-sync.service';
import { BillingLifecycleService, billingAmounts } from '../src/admin/billing-lifecycle.service';
import { BillingService } from '../src/admin/billing.service';
import type { BillingQueryEvidence } from '../src/admin/billing-reconciliation-types';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';
import { createProvenBillingLedger } from './support/create-billing-fixture';
import { runInCloudWorkspace } from '../src/auth/cloud-workspace-scope';
import * as provenance from '../src/admin/billing-platform-scope';

const day = '2026-10-14';
const scope = { cloudWorkspaceId: 'complete-billing-audit', provider: 'alibaba_cloud' as const, accountUid: '100001', actorUserId: 'alice', isPlatformManager: true };
const context: any = { provider: scope.provider, accountUid: scope.accountUid, accountUidResolved: true, cloudAccountContextId: 'test-context',
  defaultRegion: 'cn-beijing', accessKeyId: 'fixture-key', accessKeySecret: 'fixture-secret' };
const config: any = { getAccountContext: async () => context };
const raw = (overrides = {}) => ({ OwnerID: scope.accountUid, BillingDate: day, ProductCode: 'ecs', InstanceID: 'i-audit', Region: 'cn-beijing', Currency: 'CNY', PretaxAmount: 2, ...overrides });
const response = (items: unknown[], overrides = {}) => new Response(JSON.stringify({ Success: true, Code: 'Success', RequestId: 'official-audit',
  Data: { AccountID: scope.accountUid, BillingCycle: '2026-10', Items: items, TotalCount: items.length, ...overrides } }));
const evidence = (): BillingQueryEvidence => ({ requestIds: [], rowCount: 0, pageCount: 0, complete: false });
const inScope = <T>(work: () => Promise<T>) => runInCloudWorkspace(scope, work);
async function fixture() {
  const repository = createMemoryAdminRepository();
  await repository.createPlatformUser({ id: 'alice', username: 'Alice', role: 'user', passwordHash: 'fixture' });
  const source = await createProvenBillingLedger(repository, { cloudAccountUid: scope.accountUid, cloudResourceId: 'i-audit', cloudResourceType: 'ecs', regionId: 'cn-beijing',
    ownerUserId: 'alice', billingScope: 'user', billingStartAt: new Date(day) });
  const store: any = { units: async () => [], tasks: async () => [], settings: async () => ({ mode: 'resource', generation: 0 }) };
  return { repository, source, store, service: new BillingLifecycleService(repository, store), bss: new BillingBssClient(config) };
}
const upload = (id = 'upload-one') => ({ id, cloudProvider: 'alibaba_cloud' as const, cloudWorkspaceId: scope.cloudWorkspaceId,
  cloudAccountContextId: context.cloudAccountContextId, ownerUserId: 'alice', cloudAccountUid: scope.accountUid, regionId: 'cn-beijing',
  imageImportBucket: 'existing-upload-bucket', objectKey: 'private-object-do-not-display', imageId: null, backingSnapshotIds: [],
  cloudImageDeletedAt: null, snapshotCleanupCompletedAt: null, createdAt: new Date(day), uploadCompletedAt: new Date(day + 'T01:00:00Z'),
  temporaryObjectDeletedAt: new Date('2026-10-16T01:00:00Z') });
describe('billing source and displayed totals completeness', () => {
  beforeEach(() => jest.useFakeTimers().setSystemTime(new Date('2026-10-28T00:00:00Z')));
  afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });
  it('retains returned unsupported product records instead of losing them when allocation is blocked', async () => inScope(async () => {
    const f = await fixture(), receipt = evidence();
    jest.spyOn(global, 'fetch').mockResolvedValue(response([raw({ ProductCode: 'new_product', PretaxAmount: '3.125' })]));
    const sync = new BillingSyncService(f.repository, f.bss, config);
    const result = await f.bss.captureQuery(receipt, async () => sync.prepareScopedRows({ context, billingDate: day,
      items: await f.bss.listDailyBillingItems({ billingDate: day, instanceId: 'i-audit' }, context) }));
    expect(result.issue?.code).toBe('ALLOCATION_PENDING');
    expect(receipt.datasets).toMatchObject([{ complete: true, rows: [{ InstanceID: 'i-audit', ProductCode: 'new_product', PretaxAmount: '3.125' }] }]);
    expect(await f.repository.listBillingLineItems()).toEqual([]);
  }));
  it('keeps unallocated upload-bucket fees as a single source entry with the original upload events', async () => inScope(async () => {
    const f = await fixture();
    jest.spyOn(f.repository, 'listBillingImageImportResources').mockResolvedValue([upload(), upload('upload-two')]);
    const list = await f.service.list({ startAt: day, endAt: '2026-10-16', view: 'platform' });
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ kind: 'platform_import', reconciliationStatus: 'source_pending', resourceCount: 0, amounts: [],
      issueMessage: '上传桶费用归属待核验', sourceImportJobIds: ['upload-one','upload-two'] });
    const detail = await f.service.detail(list.items[0].id, { startAt: day, endAt: '2026-10-16' });
    expect(detail.events.filter(event => event.type === 'image_upload')).toHaveLength(6);
    expect(JSON.stringify(detail)).not.toContain('private-object-do-not-display');
    expect(await f.repository.listBillingLedgerResources()).toHaveLength(1);
  }));
  it('does not treat a whole-period dedicated bucket as another unknown upload source', async () => inScope(async () => {
    const f = await fixture();
    jest.spyOn(f.repository, 'listBillingImageImportResources').mockResolvedValue([upload()]);
    await f.repository.createBillingLedgerResource({ cloudAccountUid: scope.accountUid, regionId: 'cn-beijing', cloudResourceId: 'existing-upload-bucket', cloudResourceType: 'oss_bucket',
      billingScope: 'platform', billingStartAt: new Date('2026-10-14T00:00:00+08:00'), tagsSnapshot: { aliyunOssDedicatedBilling: { version: 1, dedicated: true,
        cloudWorkspaceId: scope.cloudWorkspaceId, cloudAccountUid: scope.accountUid, cloudAccountContextId: context.cloudAccountContextId, bucketName: 'existing-upload-bucket', regionId: 'cn-beijing',
        bucketCreatedAt: '2026-01-01T00:00:00.000Z', verifiedAt: '2026-10-28T00:00:00.000Z', officialRequestId: 'verified-owner', declaredAt: '2026-10-14T00:00:00.000Z',
        declaredByUserId: 'alice', effectiveStartAt: '2026-10-13T16:00:00.000Z', effectiveEndAt: null } } });
    const list = await f.service.list({ startAt: day, endAt: '2026-10-16', view: 'platform' });
    expect(list.items).toHaveLength(1);
    expect(list.items[0].kind).toBe('platform_bucket');
    expect(list.items[0].issueMessage).toBeNull();
  }));
  it('does not expose another upload source through a non-manager billing view', async () => inScope(async () => {
    const f = await fixture();
    jest.spyOn(f.repository, 'listBillingImageImportResources').mockResolvedValue([upload()]);
    const list = await runInCloudWorkspace({ ...scope, isPlatformManager: false }, () => f.service.list({ startAt: day, endAt: '2026-10-16', view: 'platform' }));
    expect(list.items).toEqual([]);
  }));
  it('keeps the original monetary literal and rejects an unsafe rounded value', async () => inScope(async () => {
    const f = await fixture(), receipt = evidence();
    const body = JSON.stringify({ Success: true, Code: 'Success', RequestId: 'official-precision', Data: { AccountID: scope.accountUid, BillingCycle: '2026-10', TotalCount: 1,
      Items: [raw({ PretaxAmount: 'REPLACE_LITERAL' })] } }).replace('"REPLACE_LITERAL"', '0.123456789012345678');
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response(body));
    const sync = new BillingSyncService(f.repository, f.bss, config);
    await expect(f.bss.captureQuery(receipt, async () => sync.prepareScopedRows({ context, billingDate: day,
      items: await f.bss.listDailyBillingItems({ billingDate: day, instanceId: 'i-audit' }, context) }))).rejects.toThrow('precision');
    expect(receipt.complete).toBe(false);
    expect(receipt.datasets).toMatchObject([{ complete: true, rows: [{ PretaxAmount: '0.123456789012345678' }] }]);
  }));
  it('retains a validated first page when the next official page fails', async () => inScope(async () => {
    const f = await fixture(), receipt = evidence();
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(response([raw()], { TotalCount: 2, NextToken: 'next-page' })).mockRejectedValueOnce(new Error('network unavailable'));
    await expect(f.bss.captureQuery(receipt, () => f.bss.listDailyBillingItems({ billingDate: day, instanceId: 'i-audit' }, context))).rejects.toThrow();
    expect(receipt.complete).toBe(false);
    expect(receipt.datasets).toMatchObject([{ complete: false, rows: [{ InstanceID: 'i-audit', PretaxAmount: 2 }] }]);
  }));
  it('does not archive foreign account rows or arbitrary secret fields', async () => inScope(async () => {
    const f = await fixture(), receipt = evidence();
    jest.spyOn(global, 'fetch').mockResolvedValue(response([raw({ Message: context.accessKeySecret }), raw({ OwnerID: 'foreign-owner', InstanceID: 'i-foreign' })]));
    await f.bss.captureQuery(receipt, () => f.bss.listDailyBillingItems({ billingDate: day }, context));
    expect(receipt.datasets![0].rows).toHaveLength(1);
    expect(receipt.datasets![0].complete).toBe(false);
    expect(JSON.stringify(receipt.datasets)).not.toMatch(/fixture-secret|i-foreign|Message/);
  }));
  it.each(['', 'cny', 'bad currency'])('rejects an unverified currency %j without assigning CNY', async currency => inScope(async () => {
    const f = await fixture(), sync = new BillingSyncService(f.repository, f.bss, config);
    await expect(sync.prepareScopedRows({ context, billingDate: day, items: [raw({ Currency: currency })] })).rejects.toThrow('Currency');
  }));
  it('represents every booked line, including a real charge for a normally unbilled image', async () => inScope(async () => {
    const f = await fixture();
    const image = await f.repository.createBillingLedgerResource({ cloudAccountUid: scope.accountUid, regionId: 'cn-beijing', cloudResourceId: 'm-paid', cloudResourceType: 'image',
      ownerUserId: 'alice', billingScope: 'user', rangeInstanceId: f.source.instance.id, sourceProvisionJobId: f.source.job.id, billingStartAt: new Date(day) });
    jest.spyOn(provenance, 'loadPlatformBillingProof').mockResolvedValue({ ledgers: [f.source.ledger, image], imageImports: [], packedImages: [], cosBuckets: [],
      createdLedgerIds: new Set([f.source.ledger.id, image.id]), unverifiedSourceLedgerIds: new Set() });
    for (const [id, amount, currency] of [[f.source.ledger.id, 2, 'CNY'], [image.id, 4, 'CNY'], [f.source.ledger.id, -0.25, 'CNY'], [f.source.ledger.id, 1.2, 'USD']] as const) {
      const ledger = id === image.id ? image : f.source.ledger;
      await f.repository.upsertBillingLineItems([{ cloudAccountUid: scope.accountUid, syncBatchId: 'fixture', sourceFingerprint: id + '-' + amount + currency, billCycle: '2026-10', billingDate: day,
        productCode: ledger.cloudResourceType === 'image' ? 'image' : 'ecs', billItem: 'fee', cloudResourceId: ledger.cloudResourceId, cloudResourceType: ledger.cloudResourceType,
        pretaxAmount: amount, currency, billingScope: 'user', ownerUserId: 'alice', matchedLedgerId: id, rawPayload: { OwnerID: scope.accountUid, Region: 'cn-beijing', InstanceID: ledger.cloudResourceId } }]);
    }
    const list = await f.service.list({ startAt: day, endAt: day });
    expect(list.integrity).toEqual({ bookedRows: 4, representedRows: 4, unrepresentedRows: 0 });
    expect(list.filteredAmounts).toEqual([{ currency: 'CNY', pretaxAmount: 1.75 }, { currency: 'USD', pretaxAmount: 1.2 }]);
    expect(billingAmounts(list.items.flatMap(row => row.amounts))).toEqual(list.filteredAmounts);
    expect(list.items[0].resourceCount).toBe(1);
    const platform = await f.service.list({ startAt: day, endAt: day, view: 'platform' });
    expect(platform.filteredAmounts).toEqual([{ currency: 'CNY', pretaxAmount: 4 }]);
  }));
  it('does not count foreign account money even if a historical row has the current workspace ID', async () => inScope(async () => {
    const f = await fixture();
    const other = await createProvenBillingLedger(f.repository, { cloudAccountUid: 'foreign-account', cloudResourceId: 'i-foreign', cloudResourceType: 'ecs',
      regionId: 'cn-beijing', ownerUserId: 'alice', billingScope: 'user', billingStartAt: new Date(day) });
    await f.repository.upsertBillingLineItems([{ cloudAccountUid: 'foreign-account', syncBatchId: 'fixture', sourceFingerprint: 'foreign-booked', billCycle: '2026-10', billingDate: day,
      productCode: 'ecs', billItem: 'fee', cloudResourceId: 'i-foreign', cloudResourceType: 'ecs', pretaxAmount: 99, currency: 'CNY', billingScope: 'user', ownerUserId: 'alice',
      matchedLedgerId: other.ledger.id, rawPayload: { OwnerID: 'foreign-account', Region: 'cn-beijing', InstanceID: 'i-foreign' } }]);
    const list = await f.service.list({ startAt: day, endAt: day });
    expect(list.currencyTotals).toEqual([]);
    expect(list.items.find(row => row.id === 'instance:' + other.instance.id)).toMatchObject({ reconciliationStatus: 'source_pending', amounts: [] });
  }));
  it('keeps an old bill with missing account UID when its exact creation ledger proves the selected account', async () => inScope(async () => {
    const f = await fixture();
    await f.repository.upsertBillingLineItems([{ cloudAccountUid: null, syncBatchId: 'legacy', sourceFingerprint: 'old-account-uid', billCycle: '2026-10', billingDate: day,
      productCode: 'ecs', billItem: 'fee', cloudResourceId: 'i-audit', cloudResourceType: 'ecs', pretaxAmount: 2, currency: 'CNY', billingScope: 'user', ownerUserId: 'alice',
      matchedLedgerId: f.source.ledger.id, rawPayload: { OwnerID: scope.accountUid, Region: 'cn-beijing', InstanceID: 'i-audit' } }]);
    expect((await f.service.list({ startAt: day, endAt: day })).filteredAmounts).toEqual([{ currency: 'CNY', pretaxAmount: 2 }]);
  }));
  it('keeps aggregate fractions in the API and CSV instead of rounding them out', async () => inScope(async () => {
    const f = await fixture();
    for (const [index, amount] of [99999999999, 1e-18, -2e-18].entries()) await f.repository.upsertBillingLineItems([{ cloudAccountUid: scope.accountUid, syncBatchId: 'fixture', sourceFingerprint: 'exact-' + index,
      billCycle: '2026-10', billingDate: day, productCode: 'ecs', billItem: 'fee', cloudResourceId: 'i-audit', cloudResourceType: 'ecs', pretaxAmount: amount, currency: 'CNY',
      billingScope: 'user', ownerUserId: 'alice', matchedLedgerId: f.source.ledger.id, rawPayload: { OwnerID: scope.accountUid, Region: 'cn-beijing', InstanceID: 'i-audit' } }]);
    const list = await f.service.list({ startAt: day, endAt: day });
    const exact = '99999999998.999999999999999999';
    expect(list.items[0].amounts[0].pretaxAmountExact).toBe(exact);
    expect(list.filteredAmounts[0].pretaxAmountExact).toBe(exact);
    expect(await new BillingService(f.repository).exportUsersCsv({ startAt: day, endAt: day })).toContain(exact);
    expect(await new BillingService(f.repository).exportPlatformCsv({ startAt: day, endAt: day })).toContain(exact);
  }));
});
