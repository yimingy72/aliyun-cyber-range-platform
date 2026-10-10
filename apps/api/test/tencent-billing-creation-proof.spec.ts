import type { SingleInstanceConfig } from '../src/admin/admin.repository';
import { loadPlatformBillingProof } from '../src/admin/billing-platform-scope';
import { releaseRangeInstanceBillingLedger, syncRangeInstanceBillingLedger } from '../src/admin/billing-ledger-sync';
import { BillingService } from '../src/admin/billing.service';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';
import { tencentPackBaselineFixture } from './support/tencent-pack-baseline-fixture';
import { createTencentBillingProof, signedTencentBillingResponse, tencentBill, tencentBillingSync, TENCENT_BILLING_WINDOW as WINDOW } from './support/create-tencent-billing-fixture';

async function fixture(single = false) {
  const repository = createMemoryAdminRepository();
  const source = await createTencentBillingProof(repository, { ownerUserId: 'owner-1' });
  const context = source.instance.resourceSummary!.executionContext!;
  if (single) source.instance = await repository.updateRangeInstance(source.instance.id, { instanceMode: 'single', singleInstanceConfig: {
    cloudAccountContextId: context.cloudAccountContextId, cloudAccountUid: context.cloudAccountUid, regionId: context.regionId, zoneId: context.zoneId,
    baseName: 'fixture', quantityIndex: 0, hostKey: 'host', hostName: null, platformImageAssetId: 'fixture-image', imageId: 'img-fixture', imageDisplayName: 'fixture', cpu: 1, memory: 1, systemDiskSize: 50,
  } as SingleInstanceConfig });
  await syncRangeInstanceBillingLedger({ repository, instance: source.instance, regionId: context.regionId, cloudAccountUid: context.cloudAccountUid,
    resourceSummary: source.instance.resourceSummary, sourceProvisionJobId: source.job.id, billingStartAt: source.instance.createdAt });
  return { repository, ...source };
}

afterEach(() => jest.restoreAllMocks());
describe('Tencent durable creation inventory and delayed bill attribution', () => {
  it('accepts a single frozen config without inventing a provider field and keeps a bounded nonsecret inventory', async () => {
    const { repository, instance, job, ledgers } = await fixture(true);
    expect((await loadPlatformBillingProof(repository)).createdLedgerIds.has(ledgers[0].id)).toBe(true);
    await syncRangeInstanceBillingLedger({ repository, instance, regionId: 'ap-shanghai', cloudAccountUid: '100001', resourceSummary: instance.resourceSummary,
      sourceProvisionJobId: job.id, billingStartAt: instance.createdAt });
    const logs = await repository.listProvisionJobStepLogs(job.id);
    expect(logs).toHaveLength(1);
    const inventory = JSON.parse(logs[0].message!);
    expect(Object.keys(inventory).sort()).toEqual(['cloudProvider','cloudWorkspaceId','diskAttachments','executionContext','ownerUserId','rangeInstanceId','resources','sourceJobId','version'].sort());
    expect(inventory.resources).toEqual(expect.arrayContaining([{ cloudResourceId: 'ins-owned', cloudResourceType: 'ecs' }, { cloudResourceId: 'disk-system', cloudResourceType: 'disk' }]));
    expect(logs[0].stdoutExcerpt).toBeNull(); expect(logs[0].stderrExcerpt).toBeNull();
  });

  it.each([false, true])('attributes later official components after %s-mode cleanup cleared the active summary', async single => {
    const { repository, instance, ledgers } = await fixture(single);
    await releaseRangeInstanceBillingLedger(repository, instance.id, new Date('2026-09-10'));
    await repository.updateRangeInstance(instance.id, { resourceSummary: null, status: 'destroyed' });
    expect((await loadPlatformBillingProof(repository)).createdLedgerIds.has(ledgers[0].id)).toBe(true);
    jest.spyOn(global, 'fetch').mockResolvedValue(signedTencentBillingResponse([tencentBill()]));
    await tencentBillingSync(repository).syncRange(WINDOW);
    expect((await new BillingService(repository).getSummary(WINDOW)).totalPretaxAmount).toBe(0.300000003);
  });

  it.each(['cloudAccountContextId','cloudAccountUid','regionId','zoneId'])('rejects a conflicting single config %s before accepting current or saved inventory', async field => {
    const { repository, instance, ledgers } = await fixture(true);
    await repository.updateRangeInstance(instance.id, { singleInstanceConfig: { ...instance.singleInstanceConfig!, [field]: 'foreign' } });
    expect((await loadPlatformBillingProof(repository)).createdLedgerIds.has(ledgers[0].id)).toBe(false);
  });

  it.each(['cloudProvider','cloudWorkspaceId','rangeInstanceId','sourceJobId','ownerUserId','provider','cloudAccountUid','regionId'])('rejects mismatched durable provenance %s after cleanup', async field => {
    const { repository, instance, job, ledgers } = await fixture();
    await repository.updateRangeInstance(instance.id, { resourceSummary: null, status: 'destroyed' });
    const logs = await repository.listProvisionJobStepLogs(job.id), inventory = JSON.parse(logs[0].message!);
    if (['provider','cloudAccountUid','regionId'].includes(field)) inventory.executionContext[field] = 'foreign'; else inventory[field] = 'foreign';
    jest.spyOn(repository, 'listProvisionJobStepLogs').mockResolvedValue([{ ...logs[0], message: JSON.stringify(inventory) }]);
    const proof = await loadPlatformBillingProof(repository);
    expect(proof.createdLedgerIds.has(ledgers[0].id)).toBe(false); expect(proof.unverifiedSourceLedgerIds.has(ledgers[0].id)).toBe(true);
  });

  it('keeps packed image and backing snapshot provenance after its original source instance was cleaned', async () => {
    const { repository, instance, ledgers } = await fixture(true);
    const input = { id: 'packed-history-artifact', cloudProvider: 'tencent_cloud' as const, cloudAccountContextId: 'fixture-context', cloudAccountUid: '100001', regionId: 'ap-shanghai',
      ownerUserId: 'owner-1', sourceRangeInstanceId: instance.id, sourceHostKey: 'host', sourceInstanceId: 'ins-owned', sourceDiskIds: ['disk-system'] };
    const artifact = await repository.createPackedImageArtifact({ ...input, sourceSnapshotBaseline: tencentPackBaselineFixture(input) });
    await repository.updatePackedImageArtifact(artifact.id, { imageId: 'img-packed', backingSnapshotIds: ['snap-packed'] });
    const snapshot = await repository.createBillingLedgerResource({ cloudProvider: 'tencent_cloud', cloudAccountUid: '100001', regionId: 'ap-shanghai', cloudResourceId: 'snap-packed', cloudResourceType: 'snapshot',
      billingScope: 'user', ownerUserId: 'owner-1', rangeInstanceId: instance.id, billingStartAt: new Date('2026-09-01'), tagsSnapshot: { PlatformPackedImageArtifactId: artifact.id } });
    await releaseRangeInstanceBillingLedger(repository, instance.id, new Date('2026-09-10'));
    await repository.updateRangeInstance(instance.id, { resourceSummary: null, status: 'destroyed' });
    const proof = await loadPlatformBillingProof(repository);
    expect(proof.createdLedgerIds.has(ledgers[0].id)).toBe(true); expect(proof.createdLedgerIds.has(snapshot.id)).toBe(true);
  });
});
