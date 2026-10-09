import type { BillingLedgerResourceRecord, CreateBillingLineItemInput } from '../src/admin/admin.repository';
import { BillingService } from '../src/admin/billing.service';
import { createProvenBillingLedger } from './support/create-billing-fixture';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';

const UID = '1234567890';
const WINDOW = { startAt: '2026-10-01', endAt: '2026-10-01' };
const baseLedger = { cloudAccountUid: UID, regionId: 'cn-hangzhou', billingStartAt: new Date('2026-09-01'), tagsSnapshot: {} };

function bill(ledger: BillingLedgerResourceRecord, overrides: Partial<CreateBillingLineItemInput> = {}): CreateBillingLineItemInput {
  return { cloudAccountUid: UID, syncBatchId: 'sync', sourceFingerprint: ledger.cloudResourceId, billCycle: '2026-10',
    billingDate: WINDOW.startAt, productCode: ledger.cloudResourceType, billItem: 'resource charge',
    cloudResourceId: ledger.cloudResourceId, cloudResourceType: ledger.cloudResourceType, pretaxAmount: 1.25,
    currency: 'CNY', billingScope: ledger.billingScope, ownerUserId: ledger.ownerUserId, matchedLedgerId: ledger.id,
    rawPayload: { OwnerID: UID, Region: 'cn-hangzhou' }, ...overrides };
}

async function fixture() {
  const repository = createMemoryAdminRepository();
  await repository.createPlatformUser({ id: 'alice', username: 'alice', passwordHash: 'unused', role: 'user' });
  await repository.createPlatformUser({ id: 'bob', username: 'bob', passwordHash: 'unused', role: 'user' });
  return { repository, service: new BillingService(repository) };
}

describe('platform-created billing read scope', () => {
  beforeEach(() => jest.useFakeTimers().setSystemTime(new Date('2026-09-01')));
  afterEach(() => jest.useRealTimers());

  it('labels retained proven split charges as awaiting reconciliation without counting them twice', async () => {
    const { repository, service } = await fixture();
    const artifact = await repository.createPackedImageArtifact({ cloudAccountContextId: 'context', cloudAccountUid: UID,
      regionId: 'cn-hangzhou', ownerUserId: 'alice', sourceRangeInstanceId: 'source-range', sourceHostKey: 'host',
      sourceInstanceId: 'i-source', sourceDiskIds: ['d-source'] });
    await repository.updatePackedImageArtifact(artifact.id, { imageId: 'm-owned', backingSnapshotIds: ['s-owned'] });
    const ledger = await repository.createBillingLedgerResource({ ...baseLedger, cloudResourceId: 's-owned',
      cloudResourceType: 'snapshot', billingScope: 'user', ownerUserId: 'alice', rangeInstanceId: 'source-range' });
    await repository.upsertBillingLineItems([bill(ledger, { rawPayload: { OwnerID: UID, Region: 'cn-hangzhou',
      __platformBillingSource: 'DescribeSplitItemBill', __platformBillingSyncDeferred: true } })]);
    await expect(service.getSummary(WINDOW)).resolves.toMatchObject({ totalPretaxAmount: 1.25,
      unallocatedCurrencyTotals: [], reconciliationIssues: [{ resourceType: 'snapshot', resourceCount: 1,
        reason: expect.stringContaining('暂保留上次已核验金额') }] });
    expect(await service.exportPlatformCsv(WINDOW)).toContain('暂保留上次已核验金额');
  });

  it('excludes historical external ledgers and tagged whole-bucket charges from every read and export', async () => {
    const { repository, service } = await fixture();
    const owned = await createProvenBillingLedger(repository, { ...baseLedger, cloudResourceId: 'i-owned', cloudResourceType: 'ecs', billingScope: 'user', ownerUserId: 'alice' });
    const common = await createProvenBillingLedger(repository, { ...baseLedger, cloudResourceId: 'eip-owned', cloudResourceType: 'eip', billingScope: 'platform' });
    await repository.upsertBillingLineItems([bill(owned.ledger), bill(common.ledger, { pretaxAmount: 0.5 })]);
    const externalResources = [['i-external', 'ecs'], ['m-collected', 'image'], ['s-collected', 'snapshot'], ['shared-existing-bucket', 'oss_bucket']] as const;
    for (const [cloudResourceId, cloudResourceType] of externalResources) {
      const ledger = await repository.createBillingLedgerResource({ ...baseLedger, cloudResourceId, cloudResourceType,
        billingScope: cloudResourceType === 'ecs' ? 'user' : 'platform', ownerUserId: cloudResourceType === 'ecs' ? 'bob' : null,
        platformImageAssetId: cloudResourceType === 'image' || cloudResourceType === 'snapshot' ? 'collected-image' : null,
        tagsSnapshot: { CreatedBy: 'cyber-range-platform', PlatformScope: 'platform', PlatformImageImportJobId: 'forged-import' } });
      const line = bill(ledger, { pretaxAmount: 9876.54, productCode: cloudResourceType === 'oss_bucket' ? 'oss' : cloudResourceType });
      await repository.upsertBillingLineItems([line]);
      await repository.createBillingAnomaly({ ...line, sourceFingerprint: `anomaly-${cloudResourceId}`, reason: 'legacy unallocated external line' });
    }
    await expect(service.getSummary(WINDOW)).resolves.toMatchObject({ billingScope: 'platform_resources',
      totalPretaxAmount: 1.75, platformPretaxAmount: 0.5, anomalyCount: 0, unallocatedCurrencyTotals: [],
      resourcesWithoutBillCount: 0, reconciliationIssues: [] });
    await expect(service.listUsers(WINDOW)).resolves.toMatchObject({ total: 2, items: [
      { userId: 'alice', pretaxAmount: 1.25, itemCount: 1 }, { userId: 'bob', pretaxAmount: 0, itemCount: 0 },
    ] });
    await expect(service.getUserSummary('bob', WINDOW)).resolves.toMatchObject({ pretaxAmount: 0, itemCount: 0 });
    await expect(service.listUserGroups(WINDOW)).resolves.toMatchObject({ total: 1, items: [{ items: [{ cloudResourceId: 'i-owned' }] }] });
    await expect(service.listPlatformGroups(WINDOW)).resolves.toMatchObject({ total: 1, items: [{ items: [{ cloudResourceId: 'eip-owned' }] }] });
    await expect(service.listUserItems('alice', WINDOW)).resolves.toEqual([expect.objectContaining({ cloudResourceId: 'i-owned' })]);
    await expect(service.listUserItems('bob', WINDOW)).resolves.toEqual([]);
    await expect(service.listPlatformItems(WINDOW)).resolves.toEqual([expect.objectContaining({ cloudResourceId: 'eip-owned' })]);
    await expect(service.listAnomalies(WINDOW)).resolves.toEqual([]);
    for (const csv of await Promise.all([service.exportPlatformCsv(WINDOW), service.exportUsersCsv(WINDOW),
      service.exportUserItemsCsv('alice', WINDOW), service.exportUserItemsCsv('bob', WINDOW)])) {
      expect(csv).not.toContain('9876.54');
      for (const [cloudResourceId] of externalResources) expect(csv).not.toContain(cloudResourceId);
    }
    expect(await service.exportPlatformCsv(WINDOW)).toContain('totalPretaxAmount,1.75');
    expect(await service.exportUsersCsv(WINDOW)).toContain('alice,alice,CNY,1.25,1');
    expect(await service.exportUserItemsCsv('alice', WINDOW)).toContain('i-owned,1.25,CNY');
  });

  it.each(['create_failed', 'destroyed'] as const)('preserves real platform charges and corrections after %s', async status => {
    const { repository, service } = await fixture();
    const owned = await createProvenBillingLedger(repository, { ...baseLedger, cloudResourceId: 'i-owned', cloudResourceType: 'ecs',
      billingScope: 'user', ownerUserId: 'alice', releasedAt: new Date('2026-09-20') });
    await repository.updateRangeInstance(owned.instance.id, { status, resourceSummary: null });
    await repository.updateProvisionJob(owned.job.id, { status: status === 'create_failed' ? 'failed' : 'succeeded', finishedAt: new Date('2026-09-01') });
    await repository.upsertBillingLineItems([bill(owned.ledger), bill(owned.ledger, { sourceFingerprint: 'refund', pretaxAmount: -0.25,
      rawPayload: { OwnerID: UID, Region: 'cn-hangzhou', Item: 'Refund' } })]);
    await expect(service.getSummary(WINDOW)).resolves.toMatchObject({ totalPretaxAmount: 1, anomalyCount: 0 });
    await expect(service.getUserSummary('alice', WINDOW)).resolves.toMatchObject({ pretaxAmount: 1, itemCount: 2 });
    await expect(service.listUserGroups(WINDOW)).resolves.toMatchObject({ total: 1, items: [{
      id: owned.job.id, provisionJobStatus: status === 'create_failed' ? 'failed' : 'succeeded', pretaxAmount: 1, resourceCount: 1,
    }] });
    expect(await service.exportUserItemsCsv('alice', WINDOW)).toContain('i-owned,-0.25,CNY');
  });

  it.each(['user', 'platform'] as const)('uses the verified ledger %s scope and owner instead of stale line attribution', async billingScope => {
    const { repository, service } = await fixture();
    const owned = await createProvenBillingLedger(repository, { ...baseLedger, cloudResourceId: 'i-owned', cloudResourceType: 'ecs',
      billingScope, ownerUserId: billingScope === 'user' ? 'alice' : null });
    await repository.upsertBillingLineItems([bill(owned.ledger, { billingScope: 'user', ownerUserId: 'bob' })]);
    await expect(service.getUserSummary('bob', WINDOW)).resolves.toMatchObject({ pretaxAmount: 0, itemCount: 0 });
    await expect(service.listUserGroups({ ...WINDOW, userId: 'bob' })).resolves.toMatchObject({ items: [], total: 0 });
    await expect(service.listUserItems('bob', WINDOW)).resolves.toEqual([]);
    await expect(service.getUserSummary('alice', WINDOW)).resolves.toMatchObject({ pretaxAmount: billingScope === 'user' ? 1.25 : 0 });
    await expect(service.getSummary(WINDOW)).resolves.toMatchObject({ totalPretaxAmount: 1.25, platformPretaxAmount: billingScope === 'platform' ? 1.25 : 0 });
    const visible = billingScope === 'user' ? await service.listUserItems('alice', WINDOW) : await service.listPlatformItems(WINDOW);
    expect(visible).toEqual([expect.objectContaining({ billingScope, ownerUserId: billingScope === 'user' ? 'alice' : null })]);
    expect(await service.exportUserItemsCsv('bob', WINDOW)).not.toContain('i-owned');
  });

  it('keeps mixed snapshot aggregates as reconciliation issues without copying their amount to platform bills', async () => {
    const { repository, service } = await fixture();
    const artifact = await repository.createPackedImageArtifact({ cloudAccountContextId: 'context', cloudAccountUid: UID, regionId: 'cn-hangzhou',
      ownerUserId: 'alice', sourceRangeInstanceId: 'source-range', sourceHostKey: 'host', sourceInstanceId: 'i-source', sourceDiskIds: ['d-source'] });
    await repository.updatePackedImageArtifact(artifact.id, { imageId: 'm-platform', backingSnapshotIds: ['s-platform'] });
    await repository.createBillingLedgerResource({ ...baseLedger, cloudResourceId: 's-platform', cloudResourceType: 'snapshot',
      billingScope: 'user', ownerUserId: 'alice', rangeInstanceId: 'source-range' });
    await repository.createBillingAnomaly({ cloudAccountUid: UID, syncBatchId: 'sync', sourceFingerprint: 'snapshot-region',
      billCycle: '2026-10', billingDate: WINDOW.startAt, cloudResourceId: 'cn-hangzhou', cloudResourceType: 'snapshot_region',
      pretaxAmount: 2468.25, currency: 'CNY', reason: 'mixed cloud-account snapshot storage',
      rawPayload: { ProductCode: 'snapshot', InstanceID: 'cn-hangzhou', OwnerID: UID, Region: 'cn-hangzhou' } });
    const summary = await service.getSummary(WINDOW);
    expect(summary).toMatchObject({ billingScope: 'platform_resources', totalPretaxAmount: 0, anomalyCount: 0,
      unallocatedCurrencyTotals: [], resourcesWithoutBillCount: 1,
      reconciliationIssues: [{ resourceType: 'snapshot', resourceCount: 1, reason: expect.any(String) }] });
    expect(JSON.stringify(summary)).not.toContain('2468.25');
    await expect(service.listAnomalies(WINDOW)).resolves.toEqual([]);
    await expect(service.listUserItems('alice', WINDOW)).resolves.toEqual([]);
    expect(await service.exportPlatformCsv(WINDOW)).not.toContain('2468.25');
  });

  it('keeps an old imported image with missing snapshot inventory visible without charging account aggregates', async () => {
    const { repository, service } = await fixture();
    jest.spyOn(repository, 'listBillingImageImportResources').mockResolvedValue([{
      id: 'old-platform-import', cloudAccountUid: UID, regionId: 'cn-hangzhou', imageImportBucket: 'shared-import-bucket',
      objectKey: 'platform/image.raw', imageId: 'm-platform-imported', backingSnapshotIds: [], cloudImageDeletedAt: null,
      snapshotCleanupCompletedAt: null, createdAt: new Date('2026-09-01'), uploadCompletedAt: new Date('2026-09-01'),
      temporaryObjectDeletedAt: new Date('2026-09-02'),
    }]);
    await repository.createBillingAnomaly({ cloudAccountUid: UID, syncBatchId: 'sync', sourceFingerprint: 'mixed-snapshot-bill',
      billCycle: '2026-10', billingDate: WINDOW.startAt, cloudResourceId: 'cn-hangzhou', cloudResourceType: 'snapshot_region',
      pretaxAmount: 1234.56, currency: 'CNY', reason: 'snapshot inventory unavailable',
      rawPayload: { ProductCode: 'snapshot', InstanceID: 'cn-hangzhou', OwnerID: UID, Region: 'cn-hangzhou' } });
    await expect(service.getSummary(WINDOW)).resolves.toMatchObject({ billingScope: 'platform_resources', totalPretaxAmount: 0,
      anomalyCount: 0, unallocatedCurrencyTotals: [],
      reconciliationIssues: [{ resourceType: 'snapshot', resourceCount: 1, reason: expect.any(String) }],
    });
    await expect(service.listAnomalies(WINDOW)).resolves.toEqual([]);
    expect(await service.exportPlatformCsv(WINDOW)).not.toContain('1234.56');
  });

  it('keeps an exact proven platform anomaly separate from assigned amounts', async () => {
    const { repository, service } = await fixture();
    await createProvenBillingLedger(repository, { ...baseLedger, cloudResourceId: 'i-owned', cloudResourceType: 'ecs', billingScope: 'user', ownerUserId: 'alice' });
    await repository.createBillingAnomaly({ cloudAccountUid: UID, syncBatchId: 'sync', sourceFingerprint: 'exact-platform-pending',
      billCycle: '2026-10', billingDate: WINDOW.startAt, cloudResourceId: 'i-owned', cloudResourceType: 'ecs',
      pretaxAmount: 0.25, currency: 'CNY', reason: 'pending assignment', rawPayload: { OwnerID: UID, Region: 'cn-hangzhou' } });
    await expect(service.getSummary(WINDOW)).resolves.toMatchObject({ totalPretaxAmount: 0, anomalyCount: 1,
      unallocatedCurrencyTotals: [{ currency: 'CNY', pretaxAmount: 0.25 }], reconciliationIssues: [] });
    await expect(service.listAnomalies(WINDOW)).resolves.toEqual([expect.objectContaining({ cloudResourceId: 'i-owned', pretaxAmount: 0.25 })]);
    await expect(service.getUserSummary('alice', WINDOW)).resolves.toMatchObject({ pretaxAmount: 0 });
  });

  it.each([
    ['other account', { cloudAccountUid: 'another-cloud-account' }],
    ['conflicting owner', { rawPayload: { OwnerID: 'another-cloud-account', Region: 'cn-hangzhou' } }],
    ['other region', { rawPayload: { OwnerID: UID, Region: 'cn-beijing' } }],
    ['conflicting region', { rawPayload: { OwnerID: UID, Region: 'cn-hangzhou', RegionId: 'cn-beijing' } }],
  ] as const)('rejects old matched rows with %s and does not present them as precise pending costs', async (_name, overrides) => {
    const { repository, service } = await fixture();
    const owned = await createProvenBillingLedger(repository, { ...baseLedger, cloudResourceId: 'i-owned', cloudResourceType: 'ecs', billingScope: 'user', ownerUserId: 'alice' });
    const contradictoryLine = bill(owned.ledger, overrides);
    await repository.upsertBillingLineItems([contradictoryLine]);
    await repository.createBillingAnomaly({ ...contradictoryLine, reason: 'historical source contradiction' });
    await expect(service.getSummary(WINDOW)).resolves.toMatchObject({ totalPretaxAmount: 0, anomalyCount: 0, unallocatedCurrencyTotals: [] });
    await expect(service.listUserItems('alice', WINDOW)).resolves.toEqual([]);
    await expect(service.listAnomalies(WINDOW)).resolves.toEqual([]);
    expect(await service.exportUserItemsCsv('alice', WINDOW)).not.toContain('i-owned');
  });

  it('does not accept costs from before the proven creation date', async () => {
    const { repository, service } = await fixture();
    const owned = await createProvenBillingLedger(repository, { ...baseLedger, billingStartAt: new Date('2026-10-02'),
      cloudResourceId: 'i-owned', cloudResourceType: 'ecs', billingScope: 'user', ownerUserId: 'alice' });
    await repository.upsertBillingLineItems([bill(owned.ledger)]);
    await expect(service.getSummary(WINDOW)).resolves.toMatchObject({ totalPretaxAmount: 0, anomalyCount: 0, unallocatedCurrencyTotals: [], resourcesWithoutBillCount: 0 });
    await expect(service.listUserGroups(WINDOW)).resolves.toMatchObject({ items: [], total: 0 });
  });
});
