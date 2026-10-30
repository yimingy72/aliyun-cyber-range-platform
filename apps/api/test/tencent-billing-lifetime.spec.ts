import { BillingService } from '../src/admin/billing.service';
import { loadPlatformBillingProof, tencentCosBillLifetimeMatches } from '../src/admin/billing-platform-scope';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';
import { ownedCosFixture } from './support/owned-cos-proof-fixture';
import { signedTencentBillingResponse, tencentBill, tencentBillingSync, TENCENT_BILLING_WINDOW as WINDOW } from './support/create-tencent-billing-fixture';

async function fixture() {
  const repository = createMemoryAdminRepository(), bucket = ownedCosFixture();
  bucket.ownershipProof = { ...bucket.ownershipProof as Record<string, unknown>, verifiedAt: '2026-10-01T00:00:01.000Z', billingObservedThrough: '2026-10-01T00:00:00.000Z' };
  jest.spyOn(repository, 'listBillingManagedCosBuckets').mockImplementation(async () => [bucket]);
  const ledger = await repository.createBillingLedgerResource({ cloudProvider: 'tencent_cloud', cloudAccountUid: '100001', regionId: 'ap-shanghai', cloudResourceId: bucket.bucketName,
    cloudResourceType: 'oss_bucket', billingScope: 'platform', billingStartAt: new Date('2026-09-01T00:00:02Z'), tagsSnapshot: { PlatformManagedImportBucketId: bucket.id } });
  const row = (extra: Record<string, unknown> = {}) => tencentBill({ BusinessCode: 'p_cos', ResourceId: bucket.bucketName,
    FeeBeginTime: '2026-09-30 08:00:01', FeeEndTime: '2026-09-30 09:00:00', ...extra });
  return { repository, bucket, ledger, row, service: new BillingService(repository) };
}
afterEach(() => jest.restoreAllMocks());

describe('Tencent COS bill incarnation evidence', () => {
  it.each([
    [undefined, undefined], ['2026-09-02 00:00:00', undefined], [undefined, '2026-09-02 01:00:00'],
    ['2026-09-01 08:00:01', '2026-09-01 08:00:03'],
    ['2026-09-30 08:00:01', '2026-09-30 09:00:00'], ['2026-09-30 07:00:00', '2026-09-30 09:00:00'],
    ['2026-09-02 01:00:00', '2026-09-02 00:00:00'], ['2026-09-31 00:00:00', '2026-09-31 01:00:00'],
    ['2026-09-02T00:00:00Z', '2026-09-02T01:00:00Z'],
  ])('keeps invalid or cross-incarnation interval %s / %s pending', async (FeeBeginTime, FeeEndTime) => {
    const f = await fixture(); f.bucket.status = 'deleted'; f.bucket.deletedAt = new Date('2026-09-30T00:00:00Z');
    f.bucket.ownershipProof = { ...f.bucket.ownershipProof as Record<string, unknown>, deletionRequestedAt: f.bucket.deletedAt.toISOString(), deletionOutcome: 'accepted' };
    await f.repository.updateBillingLedgerResource(f.ledger.id, { releasedAt: f.bucket.deletedAt });
    jest.spyOn(global, 'fetch').mockImplementation(async () => signedTencentBillingResponse([f.row({ FeeBeginTime, FeeEndTime })]));
    await tencentBillingSync(f.repository).syncRange(WINDOW);
    expect(await f.repository.listBillingLineItems()).toEqual([]);
    const anomalies = await f.repository.listBillingAnomalies();
    expect(anomalies).toHaveLength(2);
    expect(anomalies.every(item => (item.rawPayload.__platformBillingScope as { kind: string }).kind === 'source_pending')).toBe(true);
    expect(await f.service.getSummary(WINDOW)).toMatchObject({ totalPretaxAmount: 0, anomalyCount: 0,
      reconciliationIssues: expect.arrayContaining([expect.objectContaining({ resourceType: 'unknown', resourceCount: 1 })]) });
    expect(await f.service.exportPlatformCsv(WINDOW)).toContain('unknown,1,');
  });
  it.each(['pending', 'unknown', 'accepted', 'observed-late'])('uses original %s DELETE intent and revalidates stored rows', async outcome => {
    const f = await fixture(); const fetch = jest.spyOn(global, 'fetch').mockImplementation(async () => signedTencentBillingResponse([f.row()]));
    await tencentBillingSync(f.repository).syncRange(WINDOW);
    expect((await f.service.getSummary(WINDOW)).totalPretaxAmount).toBe(0.300000003);
    f.bucket.status = outcome === 'observed-late' ? 'deleted' : 'deleting';
    f.bucket.ownershipProof = { ...f.bucket.ownershipProof as Record<string, unknown>, deletionRequestedAt: '2026-09-30T00:00:00.000Z', deletionOutcome: outcome === 'observed-late' ? 'accepted' : outcome };
    if (outcome === 'observed-late') await f.repository.updateBillingLedgerResource(f.ledger.id, { releasedAt: new Date('2026-09-30T02:00:00Z') });
    expect(await f.service.listPlatformItems(WINDOW)).toEqual([]);
    expect(await f.repository.listBillingLineItems()).toHaveLength(2);
    await tencentBillingSync(f.repository).syncRange(WINDOW);
    expect(await f.repository.listBillingLineItems()).toEqual([]);
    fetch.mockImplementation(async () => signedTencentBillingResponse([f.row({ FeeBeginTime: '2026-09-29 00:00:00', FeeEndTime: '2026-09-29 23:59:59' })]));
    await tencentBillingSync(f.repository).syncRange(WINDOW);
    expect((await f.service.getSummary(WINDOW)).totalPretaxAmount).toBe(0.300000003);
  });
  it('requires a persisted full observation rather than an open historical proof', async () => {
    const f = await fixture(), original = f.bucket.ownershipProof as Record<string, unknown>;
    jest.spyOn(global, 'fetch').mockImplementation(async () => signedTencentBillingResponse([f.row()]));
    for (const billingObservedThrough of [undefined, 'invalid', '2026-09-29T00:00:00.000Z']) {
      f.bucket.ownershipProof = { ...original, billingObservedThrough };
      await tencentBillingSync(f.repository).syncRange(WINDOW);
      expect(await f.service.listPlatformItems(WINDOW)).toEqual([]);
    }
    f.bucket.ownershipProof = original;
    await tencentBillingSync(f.repository).syncRange(WINDOW);
    expect((await f.service.getSummary(WINDOW)).totalPretaxAmount).toBe(0.300000003);
    f.bucket.ownershipProof = { ...original, billingObservedThrough: '2026-09-29T00:00:00.000Z' };
    expect(await f.service.listPlatformItems(WINDOW)).toEqual([]);
  });
  it.each([undefined, 'invalid', '2026-09-30 08:00:00', '2026-09-01T00:00:01.000Z'])('refuses deletion without reliable intent %s', async requested => {
    const f = await fixture(); f.bucket.status = 'deleting';
    f.bucket.ownershipProof = { ...f.bucket.ownershipProof as Record<string, unknown>, deletionRequestedAt: requested, deletionOutcome: 'unknown' };
    expect(tencentCosBillLifetimeMatches(f.ledger, f.row(), await loadPlatformBillingProof(f.repository))).toBe(false);
  });
  it('requires exact birth time, accepts exact UTC+8 boundaries and does not treat rejection as release', async () => {
    const f = await fixture(); const proof = await loadPlatformBillingProof(f.repository);
    expect(tencentCosBillLifetimeMatches({ ...f.ledger, releasedAt: new Date('2026-09-30T00:00:00Z') }, f.row({ FeeBeginTime: '2026-09-01 08:00:02', FeeEndTime: '2026-09-30 08:00:00' }), proof)).toBe(true);
    expect(tencentCosBillLifetimeMatches(f.ledger, f.row({ FeeBeginTime: '2026-09-31 00:00:00', FeeEndTime: '2026-09-31 01:00:00' }), proof)).toBe(false);
    expect(tencentCosBillLifetimeMatches({ ...f.ledger, cloudResourceType: 'ecs' }, {}, proof)).toBe(true);
    expect(tencentCosBillLifetimeMatches({ ...f.ledger, cloudProvider: 'alibaba_cloud' }, {}, proof)).toBe(true);
    f.bucket.status = 'deleting'; f.bucket.ownershipProof = { ...f.bucket.ownershipProof as Record<string, unknown>, deletionRequestedAt: '2026-09-20T00:00:00.000Z', deletionOutcome: 'rejected' };
    expect(tencentCosBillLifetimeMatches(f.ledger, f.row(), await loadPlatformBillingProof(f.repository))).toBe(true);
    await f.repository.updateBillingLedgerResource(f.ledger.id, { billingStartAt: new Date('2026-09-01T00:00:00Z') });
    expect((await loadPlatformBillingProof(f.repository)).createdLedgerIds.has(f.ledger.id)).toBe(false);
  });
});
