import type { BillingLedgerResourceRecord, CreateBillingLineItemInput } from '../src/admin/admin.repository';
import type { BillingBssClient } from '../src/admin/billing-bss-client';
import type { SystemConfigService } from '../src/admin/system-config.service';
import { currentBillingRows, currentPlatformBillingProof, readPlatformBillingStartedAt } from '../src/admin/billing-current-scope';
import { loadPlatformBillingProof } from '../src/admin/billing-platform-scope';
import { BillingService } from '../src/admin/billing.service';
import { BillingSyncService } from '../src/admin/billing-sync.service';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';
import { createProvenBillingLedger } from './support/create-billing-fixture';
import { createTencentBillingProof, signedTencentBillingResponse, tencentBill, tencentBillingSync } from './support/create-tencent-billing-fixture';
import { runInCloudWorkspace } from '../src/auth/cloud-workspace-scope';

const START = '2026-10-01T04:00:00.000Z';
const OLD = new Date('2026-10-01T03:00:00.000Z');
const NEW = new Date('2026-10-01T05:00:00.000Z');
const WINDOW = { startAt: '2026-09-30', endAt: '2026-10-02' };
const config = { getAccountContext: async () => ({ provider: 'alibaba_cloud', accountUid: '100001', accountUidResolved: true }) } as unknown as SystemConfigService;
const official = (id: string, amount: number, day = '2026-10-01') => ({ OwnerID: '100001', BillingDate: day,
  ProductCode: 'ecs', InstanceID: id, Region: 'cn-hangzhou', BillingItem: 'CPU', Currency: 'CNY', PretaxAmount: amount });
const base = { cloudAccountUid: '100001', regionId: 'cn-hangzhou', cloudResourceType: 'ecs' as const, billingScope: 'platform' as const };
const oldEnv = process.env.PLATFORM_BILLING_STARTED_AT;
beforeEach(() => { process.env.PLATFORM_BILLING_STARTED_AT = START; jest.useFakeTimers(); });
afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); if (oldEnv === undefined) delete process.env.PLATFORM_BILLING_STARTED_AT; else process.env.PLATFORM_BILLING_STARTED_AT = oldEnv; });

async function source(repository: ReturnType<typeof createMemoryAdminRepository>, id: string, at: Date, ownerUserId?: string) {
  jest.setSystemTime(at);
  return createProvenBillingLedger(repository, { ...base, cloudResourceId: id, billingStartAt: at,
    ...(ownerUserId ? { ownerUserId, billingScope: 'user' as const } : {}) });
}
function history(ledger: BillingLedgerResourceRecord): CreateBillingLineItemInput {
  return { cloudAccountUid: '100001', syncBatchId: 'old-history', sourceFingerprint: `old-${ledger.id}`, billCycle: '2026-10',
    billingDate: '2026-10-02', productCode: 'ecs', billItem: 'CPU', cloudResourceId: ledger.cloudResourceId,
    cloudResourceType: 'ecs', pretaxAmount: 99, currency: 'CNY', billingScope: ledger.billingScope,
    ownerUserId: ledger.ownerUserId, matchedLedgerId: ledger.id, rawPayload: official(ledger.cloudResourceId, 99, '2026-10-02') };
}

describe('fixed current platform billing scope', () => {
  it('keeps defaults unchanged and rejects invalid/moving start values', () => {
    delete process.env.PLATFORM_BILLING_STARTED_AT;
    expect(readPlatformBillingStartedAt()).toBeNull();
    expect(currentBillingRows([{ syncBatchId: 'history' }], null)).toHaveLength(1);
    for (const bad of ['now', '2026-10-01', '2026-10-01T04:00:00', '2026-02-30T04:00:00Z']) {
      process.env.PLATFORM_BILLING_STARTED_AT = bad;
      expect(() => new BillingService(createMemoryAdminRepository())).toThrow('fixed ISO');
    }
    process.env.PLATFORM_BILLING_STARTED_AT = '2026-10-01T12:00:00+08:00';
    expect(readPlatformBillingStartedAt()?.toISOString()).toBe(START);
  });

  it('excludes old resources even when billed after cutoff, preserves historical rows, and scopes every read surface', async () => {
    const repository = createMemoryAdminRepository();
    const old = await source(repository, 'i-old', OLD);
    const current = await source(repository, 'i-current', NEW);
    const user = await source(repository, 'i-user', NEW, 'alice');
    await repository.upsertBillingLineItems([history(old.ledger), { ...history(old.ledger), sourceFingerprint: 'old-null-uid', cloudAccountUid: null }]);
    const historicalRows = await repository.listBillingLineItems();
    jest.setSystemTime(new Date('2026-10-12T12:00:00Z'));
    const read = jest.fn(async ({ billingDate }: { billingDate: string }) => [official('i-old', 99, billingDate), official('i-current', 2, billingDate),
      { ...official('i-current', -0.5, billingDate), Item: 'Refund' }, official('i-user', 3, billingDate), official('i-other-business', 777, billingDate)]);
    const sync = new BillingSyncService(repository, { listDailyBillingItems: read } as unknown as BillingBssClient, config);
    for (let i = 0; i < 2; i++) expect(await sync.syncRange(WINDOW)).toMatchObject({ syncedDays: 2, importedLineItems: 6 });
    expect(read.mock.calls.map(([input]) => input.billingDate)).toEqual(['2026-10-01', '2026-10-02', '2026-10-01', '2026-10-02']);
    const persisted = await repository.listBillingLineItems();
    expect(persisted.filter(row => !row.syncBatchId.startsWith('billing-current:'))).toEqual(historicalRows);
    expect(persisted).toHaveLength(8);
    const service = new BillingService(repository);
    expect(await service.getSummary(WINDOW)).toMatchObject({ totalPretaxAmount: 9, platformPretaxAmount: 3,
      resourcesWithoutBillCount: 0, reconciliationIssues: [], platformBillingStartedAt: START });
    expect((await service.listPlatformItems(WINDOW)).every(row => row.matchedLedgerId === current.ledger.id)).toBe(true);
    expect((await service.listUserItems('alice', WINDOW)).every(row => row.matchedLedgerId === user.ledger.id)).toBe(true);
    expect((await service.listPlatformGroups(WINDOW)).items).toHaveLength(1);
    expect((await service.listUserGroups(WINDOW)).items).toHaveLength(1);
    expect(await service.getUserSummary('alice', WINDOW)).toMatchObject({ pretaxAmount: 6 });
    expect((await service.listUsers(WINDOW)).items.find(row => row.userId === 'alice')).toMatchObject({ pretaxAmount: 6 });
    expect(await service.exportPlatformCsv(WINDOW)).not.toContain('i-old');
    expect(await service.exportUsersCsv(WINDOW)).not.toContain('i-old');
    expect(await service.listAnomalies(WINDOW)).toEqual([]);
    read.mockClear();
    expect(await sync.syncRange({ startAt: '2026-09-01', endAt: '2026-09-30' })).toMatchObject({ syncedDays: 0 });
    expect(read).not.toHaveBeenCalled();
  });

  it('admits genuinely new retry resources under an old instance but never a later observation or old birth source', async () => {
    const repository = createMemoryAdminRepository();
    const old = await source(repository, 'i-old', OLD);
    jest.setSystemTime(NEW);
    const retry = await repository.createProvisionJob({ rangeInstanceId: old.instance.id, jobType: 'retry', triggeredBy: 'admin' });
    const created = await repository.createBillingLedgerResource({ ...base, cloudResourceId: 'i-retry-new', rangeInstanceId: old.instance.id,
      sourceProvisionJobId: retry.id, billingStartAt: OLD });
    const lateObserved = await repository.createBillingLedgerResource({ ...base, cloudResourceId: 'i-old-discovered-late', rangeInstanceId: old.instance.id,
      sourceProvisionJobId: old.job.id, billingStartAt: OLD });
    const destroy = await repository.createProvisionJob({ rangeInstanceId: old.instance.id, jobType: 'destroy', triggeredBy: 'admin' });
    const recovered = await repository.createBillingLedgerResource({ ...base, cloudResourceId: 'i-old-recovered', rangeInstanceId: old.instance.id,
      sourceProvisionJobId: destroy.id, billingStartAt: OLD });
    // Even a bad late source pointer cannot move a physical ledger that predates the job.
    await repository.updateBillingLedgerResource(old.ledger.id, { sourceProvisionJobId: retry.id });
    const proof = currentPlatformBillingProof(await loadPlatformBillingProof(repository), new Date(START));
    expect(proof.ledgers.map(row => row.id)).toEqual([created.id]);
    expect(proof.ledgers[0].billingStartAt).toEqual(NEW);
    expect(proof.createdLedgerIds.has(created.id)).toBe(true);
    expect([old.ledger.id, lateObserved.id, recovered.id].every(id => !proof.createdLedgerIds.has(id))).toBe(true);
  });

  it('keeps a new snapshot from an old source host while removing historical snapshot/old import diagnostics', async () => {
    const repository = createMemoryAdminRepository();
    const host = await source(repository, 'i-old-parent', OLD, 'alice');
    for (const [id, at] of [['old', OLD], ['new', NEW]] as const) {
      jest.setSystemTime(at);
      const artifact = await repository.createPackedImageArtifact({ cloudAccountContextId: 'ctx', cloudAccountUid: '100001', regionId: 'cn-hangzhou',
        ownerUserId: 'alice', sourceRangeInstanceId: host.instance.id, sourceHostKey: 'host', sourceInstanceId: host.ledger.cloudResourceId, sourceDiskIds: ['d-old'] });
      await repository.updatePackedImageArtifact(artifact.id, { imageId: `m-${id}`, backingSnapshotIds: [`s-${id}`] });
      await repository.createBillingLedgerResource({ ...base, cloudResourceId: `s-${id}`, cloudResourceType: 'snapshot', billingScope: 'user', ownerUserId: 'alice', rangeInstanceId: host.instance.id, billingStartAt: at });
    }
    jest.setSystemTime(new Date('2026-10-12T12:00:00Z'));
    const raw = { OwnerID: '100001', BillingDate: '2026-10-01', ProductCode: 'snapshot', InstanceID: 'cn-hangzhou', Currency: 'CNY', PretaxAmount: 999 };
    await new BillingSyncService(repository, { listDailyBillingItems: async () => [raw], listDailySplitBillingItems: async () => [] } as unknown as BillingBssClient, config)
      .syncRange({ startAt: '2026-10-01', endAt: '2026-10-01' });
    const summary = await new BillingService(repository).getSummary(WINDOW);
    expect(summary).toMatchObject({ totalPretaxAmount: 0, resourcesWithoutBillCount: 1,
      reconciliationIssues: [expect.objectContaining({ resourceType: 'snapshot', resourceCount: 1 })] });
    expect((await repository.listBillingAnomalies())[0].rawPayload.__platformBillingScope).toMatchObject({ ledgerIds: [expect.any(String)] });
    expect(currentPlatformBillingProof(await loadPlatformBillingProof(repository), new Date(START)).ledgers.map(row => row.cloudResourceId)).toEqual(['s-new']);
  });

  it('isolates Tencent current revisions from its historical records and includes no old CVM fees', async () => {
    const repository = createMemoryAdminRepository();
    const scope = { cloudWorkspaceId: 'current-tencent', provider: 'tencent_cloud' as const, accountUid: '100001', isPlatformManager: true };
    await runInCloudWorkspace(scope, async () => {
      jest.setSystemTime(NEW);
      const { ledgers } = await createTencentBillingProof(repository);
      await repository.upsertBillingLineItems([{ ...history(ledgers[0]), cloudProvider: 'tencent_cloud', rawPayload: {}, sourceFingerprint: 'old-tencent-line' }]);
      const before = await repository.listBillingLineItems();
      jest.setSystemTime(new Date('2026-10-12T12:00:00Z'));
      jest.spyOn(global, 'fetch').mockImplementation(async () => signedTencentBillingResponse([tencentBill({ BillDay: '2026-10-01 00:00:00', BillMonth: '2026-10-01 00:00:00' })]));
      const sync = tencentBillingSync(repository);
      for (let i = 0; i < 2; i++) await sync.syncRange({ startAt: '2026-10-01', endAt: '2026-10-01' });
      const rows = await repository.listBillingLineItems();
      expect(rows.filter(row => row.syncBatchId === 'old-history')).toEqual(before);
      expect(currentBillingRows(rows, new Date(START))).toHaveLength(2);
      expect((await new BillingService(repository).getSummary({ startAt: '2026-10-01', endAt: '2026-10-01' })).totalPretaxAmount).toBe(0.300000003);
    });
  });
});
