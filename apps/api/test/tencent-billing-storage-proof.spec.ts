import { BillingService } from '../src/admin/billing.service';
import { loadPlatformBillingProof } from '../src/admin/billing-platform-scope';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';
import { ownedCosFixture } from './support/owned-cos-proof-fixture';
import { createTencentBillingProof, signedTencentBillingResponse, tencentBill, tencentBillingSync, TENCENT_BILLING_WINDOW as WINDOW } from './support/create-tencent-billing-fixture';
const start = new Date('2026-09-01T00:00:02Z');
afterEach(() => jest.restoreAllMocks());

async function storage() {
  const repository = createMemoryAdminRepository(); const bucket = ownedCosFixture();
  jest.spyOn(repository, 'listBillingManagedCosBuckets').mockImplementation(async () => [bucket]);
  const ledger = await repository.createBillingLedgerResource({ cloudProvider: 'tencent_cloud', cloudAccountUid: '100001', regionId: 'ap-shanghai', cloudResourceId: bucket.bucketName,
    cloudResourceType: 'oss_bucket', billingScope: 'platform', billingStartAt: start, tagsSnapshot: { PlatformManagedImportBucketId: bucket.id } });
  return { repository, bucket, ledger };
}
describe('Tencent platform storage creation proof', () => {
  it('imports only complete official bucket IDs on a proven private dedicated bucket, without summing account aggregates', async () => {
    const { repository, bucket } = await storage();
    const fetch = jest.spyOn(global, 'fetch').mockImplementation(async () => signedTencentBillingResponse([
      tencentBill({ Id: 'owned-cos', BusinessCode: 'p_cos', ResourceId: bucket.bucketName, ComponentSet: [{ RealCost: '0.400000001', CashPayAmount: '999' }] }),
      tencentBill({ Id: 'other-bucket', BusinessCode: 'p_cos', ResourceId: 'external-bucket-1250000000', ComponentSet: [{ RealCost: '999' }] }),
      tencentBill({ Id: 'aggregate', BusinessCode: 'p_cos', ResourceId: '100001;ap-shanghai;STANDARD', ComponentSet: [{ RealCost: '777' }] }),
    ]));
    await tencentBillingSync(repository).syncRange(WINDOW);
    expect(await new BillingService(repository).getSummary(WINDOW)).toMatchObject({ totalPretaxAmount: 0.400000001, platformPretaxAmount: 0.400000001, anomalyCount: 0, resourcesWithoutBillCount: 0 });
    expect(await repository.listBillingLineItems()).toHaveLength(1); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each(['creationNonce', 'cloudAccountUid', 'cloudAccountContextId', 'appId', 'cloudWorkspaceId', 'exclusiveUsage', 'verificationPending'])('rejects a missing/conflicting private bucket proof field %s and keeps reconciliation visible', async key => {
    const { repository, bucket, ledger } = await storage();
    (bucket.ownershipProof as Record<string,unknown>)[key] = key === 'exclusiveUsage' ? false : key === 'verificationPending' ? true : 'foreign';
    expect((await loadPlatformBillingProof(repository)).createdLedgerIds.has(ledger.id)).toBe(false);
    jest.spyOn(global, 'fetch').mockImplementation(async () => signedTencentBillingResponse([tencentBill({ BusinessCode: 'p_cos', ResourceId: bucket.bucketName })]));
    await tencentBillingSync(repository).syncRange(WINDOW);
    expect(await new BillingService(repository).getSummary(WINDOW)).toMatchObject({ totalPretaxAmount: 0, reconciliationIssues: [expect.objectContaining({ resourceType: 'unknown' })] });
  });
  it('keeps a reused deleted bucket name out of costs unless official usage time belongs to its proven lifetime', async () => {
    const { repository, bucket, ledger } = await storage(); bucket.status = 'deleted'; bucket.deletedAt = new Date('2026-09-20T00:00:00Z');
    await repository.updateBillingLedgerResource(ledger.id, { releasedAt: bucket.deletedAt });
    const fetch = jest.spyOn(global, 'fetch').mockImplementation(async () => signedTencentBillingResponse([tencentBill({ BusinessCode: 'p_cos', ResourceId: bucket.bucketName })]));
    await tencentBillingSync(repository).syncRange(WINDOW);
    expect((await new BillingService(repository).getSummary(WINDOW)).totalPretaxAmount).toBe(0);
    fetch.mockImplementation(async () => signedTencentBillingResponse([tencentBill({ BusinessCode: 'p_cos', ResourceId: bucket.bucketName,
      FeeBeginTime: '2026-09-02 00:00:00', FeeEndTime: '2026-09-02 23:59:59' })]));
    await tencentBillingSync(repository).syncRange(WINDOW);
    expect((await new BillingService(repository).getSummary(WINDOW)).totalPretaxAmount).toBe(0.300000003);
  });
  it('proves an imported Tencent backing snapshot only through the exact task, uploaded object and managed bucket chain', async () => {
    const { repository, bucket } = await storage();
    const job = { id: 'import-job', cloudWorkspaceId: 'legacy-unbound', cloudProvider: 'tencent_cloud' as const, cloudAccountContextId: 'fixture-context', cloudAccountUid: '100001', regionId: 'ap-shanghai',
      managedBucketId: bucket.id, imageImportBucket: bucket.bucketName, objectKey: 'import/file.qcow2', ownerUserId: 'import-owner', sourceSizeBytes: '5', taskId: 'import-task', imageId: 'img-imported', backingSnapshotIds: ['snap-imported'],
      cloudImageDeletedAt: null, snapshotCleanupCompletedAt: null, createdAt: start, uploadCompletedAt: start, temporaryObjectDeletedAt: null,
      sourceObjectProof: { provider: 'tencent_cloud', bucketId: bucket.id, bucketName: bucket.bucketName, objectKey: 'import/file.qcow2', jobId: 'import-job', ownerUserId: 'import-owner',
        cloudAccountContextId: 'fixture-context', cloudAccountUid: '100001', regionId: 'ap-shanghai', contentLength: 5, etag: 'fixture-etag', verifiedAt: start.toISOString() } };
    jest.spyOn(repository, 'listBillingImageImportResources').mockImplementation(async () => [job]);
    const ledger = await repository.createBillingLedgerResource({ cloudProvider: 'tencent_cloud', cloudAccountUid: '100001', regionId: 'ap-shanghai', cloudResourceId: 'snap-imported', cloudResourceType: 'snapshot', billingScope: 'platform', billingStartAt: start, tagsSnapshot: { PlatformImageImportJobId: job.id } });
    expect((await loadPlatformBillingProof(repository)).createdLedgerIds.has(ledger.id)).toBe(true);
    job.sourceObjectProof.ownerUserId = 'foreign';
    expect((await loadPlatformBillingProof(repository)).createdLedgerIds.has(ledger.id)).toBe(false);
  });
  it('proves a packed snapshot only from the same Tencent source instance and physical disk inventory', async () => {
    const repository = createMemoryAdminRepository(); const source = await createTencentBillingProof(repository, { ownerUserId: 'owner-1' });
    const artifact = await repository.createPackedImageArtifact({ cloudProvider: 'tencent_cloud', cloudAccountContextId: 'fixture-context', cloudAccountUid: '100001', regionId: 'ap-shanghai',
      ownerUserId: 'owner-1', sourceRangeInstanceId: source.instance.id, sourceHostKey: 'host', sourceInstanceId: 'ins-owned', sourceDiskIds: ['disk-system'] });
    await repository.updatePackedImageArtifact(artifact.id, { imageId: 'img-packed', backingSnapshotIds: ['snap-packed'] });
    const ledger = await repository.createBillingLedgerResource({ cloudProvider: 'tencent_cloud', cloudAccountUid: '100001', regionId: 'ap-shanghai', cloudResourceId: 'snap-packed', cloudResourceType: 'snapshot', billingScope: 'user', ownerUserId: 'owner-1', rangeInstanceId: source.instance.id, billingStartAt: start, tagsSnapshot: { PlatformPackedImageArtifactId: artifact.id } });
    expect((await loadPlatformBillingProof(repository)).createdLedgerIds.has(ledger.id)).toBe(true);
    const list = repository.listPackedImageArtifacts.bind(repository); jest.spyOn(repository, 'listPackedImageArtifacts').mockImplementation(async () => (await list()).map(item => ({ ...item, sourceDiskIds: ['disk-foreign'] })));
    expect((await loadPlatformBillingProof(repository)).createdLedgerIds.has(ledger.id)).toBe(false);
  });
});
