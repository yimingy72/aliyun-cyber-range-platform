import { BillingSyncService } from '../src/admin/billing-sync.service';
import type { BillingBssClient } from '../src/admin/billing-bss-client';
import type { SystemConfigService } from '../src/admin/system-config.service';
import { isPlatformCreatedLedger, loadPlatformBillingProof, pendingPlatformBillingEvidence } from '../src/admin/billing-platform-scope';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';
import { createProvenBillingLedger } from './support/create-billing-fixture';

const DAY = '2026-10-01';
const UID = 'platform-cloud';
const base = { cloudAccountUid: UID, regionId: 'cn-hangzhou', cloudResourceId: 'i-owned', cloudResourceType: 'ecs' as const,
  billingScope: 'platform' as const, billingStartAt: new Date('2026-09-01') };
const bill = (overrides: Record<string, unknown> = {}) => ({ OwnerID: UID, Region: 'cn-hangzhou', ProductCode: 'ecs', InstanceID: 'i-owned', Currency: 'CNY', PretaxAmount: 1, BillingDate: DAY, ...overrides });
const sync = (repository: ReturnType<typeof createMemoryAdminRepository>, rows: Record<string, unknown>[]) => new BillingSyncService(repository,
  { listDailyBillingItems: async () => rows } as unknown as BillingBssClient,
  { getAccountContext: async () => ({ accountUid: UID, accountUidResolved: true, defaultRegion: 'cn-hangzhou', imageImportBucket: 'configured-shared-bucket' }) } as unknown as SystemConfigService).syncRange({ startAt: DAY, endAt: DAY });

async function snapshotFixture() {
  const repository = createMemoryAdminRepository();
  const artifact = await repository.createPackedImageArtifact({ cloudAccountContextId: 'context', cloudAccountUid: UID, regionId: 'cn-hangzhou', ownerUserId: 'user-1', sourceRangeInstanceId: 'source-range', sourceHostKey: 'host', sourceInstanceId: 'i-owned', sourceDiskIds: ['d-owned'] });
  await repository.updatePackedImageArtifact(artifact.id, { imageId: 'm-owned', backingSnapshotIds: ['s-owned'] });
  const ledger = await repository.createBillingLedgerResource({ ...base, cloudResourceId: 's-owned', cloudResourceType: 'snapshot', billingScope: 'user', ownerUserId: 'user-1', rangeInstanceId: 'source-range', billingStartAt: artifact.createdAt });
  return { repository, artifact, ledger };
}

afterEach(() => jest.useRealTimers());

describe('platform-created billing scope', () => {
  it.each(['ecs', 'disk', 'eip', 'nat_gateway'] as const)('matches actual source jobs for %s resources, including failed launches', async type => {
    const repository = createMemoryAdminRepository();
    const f = await createProvenBillingLedger(repository, { ...base, cloudResourceType: type });
    await repository.updateProvisionJob(f.job.id, { status: 'failed' });
    const proof = await loadPlatformBillingProof(repository);
    expect(isPlatformCreatedLedger(f.ledger, proof)).toBe(true);
  });

  it('does not accept tagged external resources or a forged range reference without a creation job', async () => {
    const repository = createMemoryAdminRepository();
    await repository.createBillingLedgerResource({ ...base, rangeInstanceId: 'some-range', tagsSnapshot: { CreatedBy: 'cyber-range-platform' } });
    await sync(repository, [bill({ Tag: 'key:CreatedBy value:cyber-range-platform; key:PlatformScope value:platform' })]);
    expect(await repository.listBillingLineItems()).toEqual([]);
    expect(await repository.listBillingAnomalies()).toEqual([]);
  });

  it('requires the recorded account and region and refuses an unrelated job', async () => {
    const repository = createMemoryAdminRepository();
    const f = await createProvenBillingLedger(repository, base);
    await repository.updateBillingLedgerResource(f.ledger.id, { cloudAccountUid: 'other-account' });
    expect((await loadPlatformBillingProof(repository)).createdLedgerIds.size).toBe(0);
    await repository.updateBillingLedgerResource(f.ledger.id, { cloudAccountUid: UID, sourceProvisionJobId: 'made-up-job' });
    expect((await loadPlatformBillingProof(repository)).createdLedgerIds.size).toBe(0);
  });

  it('keeps historical creation proof when successful cleanup cleared the resource summary', async () => {
    const repository = createMemoryAdminRepository();
    const f = await createProvenBillingLedger(repository, base);
    await repository.updateRangeInstance(f.instance.id, { resourceSummary: null, status: 'destroyed' });
    expect((await loadPlatformBillingProof(repository)).createdLedgerIds.has(f.ledger.id)).toBe(true);
    await sync(repository, [bill()]);
    expect(await repository.listBillingLineItems()).toHaveLength(1);
  });

  it('does not claim an imported catalog image, its tagged snapshot, or an entire configured bucket', async () => {
    const repository = createMemoryAdminRepository();
    for (const [cloudResourceId, cloudResourceType] of [['m-collected', 'image'], ['s-collected', 'snapshot'], ['configured-shared-bucket', 'oss_bucket']] as const) {
      await repository.createBillingLedgerResource({ ...base, cloudResourceId, cloudResourceType, platformImageAssetId: 'collected-asset', tagsSnapshot: { PlatformImageAssetId: 'collected-asset', PlatformImageImportJobId: 'forged' } });
    }
    await sync(repository, [bill({ ProductCode: 'image', InstanceID: 'm-collected' }), bill({ ProductCode: 'snapshot', InstanceID: 's-collected' }), bill({ ProductCode: 'oss', InstanceID: 'configured-shared-bucket;standard' })]);
    expect(await repository.listBillingLineItems()).toEqual([]);
    expect(await repository.listBillingAnomalies()).toEqual([]);
  });

  it('charges proven resources after local release and applies refunds without double-counted anomalies', async () => {
    const repository = createMemoryAdminRepository();
    const f = await createProvenBillingLedger(repository, { ...base, releasedAt: new Date('2026-09-02') });
    await sync(repository, [bill(), bill({ Item: 'Refund', PretaxAmount: -0.4 })]);
    expect(await repository.listBillingLineItems()).toEqual(expect.arrayContaining([expect.objectContaining({ pretaxAmount: -0.4, matchedLedgerId: f.ledger.id }), expect.objectContaining({ pretaxAmount: 1, matchedLedgerId: f.ledger.id, rawPayload: expect.objectContaining({ __platformPostReleaseCharge: true }) })]));
    expect(await repository.listBillingAnomalies()).toEqual([]);
  });

  it('ignores external aggregates without platform snapshot or upload candidates', async () => {
    const repository = createMemoryAdminRepository();
    await createProvenBillingLedger(repository, base);
    await sync(repository, [bill({ ProductCode: 'snapshot', InstanceID: 'cn-hangzhou' }), bill({ ProductCode: 'oss', InstanceID: 'cn-hangzhou;standard' })]);
    expect(await repository.listBillingAnomalies()).toEqual([]);
  });

  it('retains only same-account same-region live snapshot candidates and preserves their source proof after ECS release', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-01'));
    const { repository, ledger } = await snapshotFixture();
    const proof = await loadPlatformBillingProof(repository);
    const evidence = pendingPlatformBillingEvidence({ line: bill({ ProductCode: 'snapshot', InstanceID: 'cn-hangzhou', SplitItemID: 'i-owned' }), cloudAccountUid: UID, billingDate: DAY, proof });
    expect(evidence).toEqual({ kind: 'aggregate_pending', ledgerIds: [ledger.id], imageImportJobIds: [] });
    for (const line of [bill({ ProductCode: 'snapshot', InstanceID: 'cn-beijing', Region: 'cn-beijing' }), bill({ ProductCode: 'snapshot', InstanceID: 'cn-hangzhou', SplitItemID: 'i-external' })]) {
      expect(pendingPlatformBillingEvidence({ line, cloudAccountUid: UID, billingDate: DAY, proof })).toBeNull();
    }
  });

  it('repairs catalog-overwritten image attribution from exact persisted pack artifacts without reopening released resources', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-01'));
    const { repository, ledger } = await snapshotFixture();
    await repository.updateBillingLedgerResource(ledger.id, { billingScope: 'platform', ownerUserId: null, rangeInstanceId: null, releasedAt: new Date('2026-09-30') });
    jest.setSystemTime(new Date('2026-10-09'));
    await sync(repository, [bill({ ProductCode: 'snapshot', InstanceID: 's-owned' })]);
    expect(await repository.listBillingLineItems()).toEqual([expect.objectContaining({ ownerUserId: 'user-1', billingScope: 'user' })]);
    expect((await repository.listBillingLedgerResources())[0].releasedAt).toEqual(new Date('2026-09-30'));
  });

  it('rejects contradictory region fields without losing the known platform-resource investigation', async () => {
    const repository = createMemoryAdminRepository();
    await createProvenBillingLedger(repository, base);
    await sync(repository, [bill({ RegionId: 'cn-beijing' })]);
    expect(await repository.listBillingLineItems()).toEqual([]);
    expect(await repository.listBillingAnomalies()).toHaveLength(1);
  });
});
