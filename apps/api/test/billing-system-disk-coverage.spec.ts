import type { BillingLedgerResourceRecord, CreateBillingLineItemInput, RangeResourceSummary } from '../src/admin/admin.repository';
import { BillingService } from '../src/admin/billing.service';
import { systemDiskBillingCoverage } from '../src/admin/billing-system-disk-coverage';
import { runInCloudWorkspace } from '../src/auth/cloud-workspace-scope';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';
import { createTencentBillingProof, signedTencentBillingResponse, tencentBill, tencentBillingSync, TENCENT_BILLING_WINDOW } from './support/create-tencent-billing-fixture';

const UID = '1672470067548805', REGION = 'cn-hangzhou';
const WINDOW = { startAt: '2026-10-09', endAt: '2026-10-09' };
const context = { provider: 'alibaba_cloud' as const, cloudAccountContextId: 'account-frozen', cloudAccountUid: UID, regionId: REGION, zoneId: 'cn-hangzhou-h' };

async function fixture(summary: Partial<RangeResourceSummary> = {}) {
  const repository = createMemoryAdminRepository();
  const instance = await repository.createRangeInstance({ name: 'disk-billing', cloudProvider: 'alibaba_cloud', ownerUserId: 'alice',
    resourceSummary: { mode: 'opentofu', executionContext: context, hostIds: { host: 'i-platform' }, systemDiskIds: { host: 'd-system' }, ...summary } });
  const job = await repository.createProvisionJob({ rangeInstanceId: instance.id, jobType: 'create', triggeredBy: 'alice' });
  const create = (cloudResourceId: string, cloudResourceType: BillingLedgerResourceRecord['cloudResourceType']) => repository.createBillingLedgerResource({
    cloudProvider: 'alibaba_cloud', cloudAccountUid: UID, regionId: REGION, cloudResourceId, cloudResourceType, billingScope: 'user',
    ownerUserId: 'alice', rangeInstanceId: instance.id, sourceProvisionJobId: job.id, billingStartAt: new Date('2026-10-09T00:00:00Z'),
    releasedAt: new Date('2026-10-09T01:00:00Z') });
  const host = await create('i-platform', 'ecs'), disk = await create('d-system', 'disk');
  const bill: CreateBillingLineItemInput = { cloudProvider: 'alibaba_cloud', cloudAccountUid: UID, cloudWorkspaceId: host.cloudWorkspaceId,
    syncBatchId: 'sync', sourceFingerprint: 'system-disk-charge', billCycle: '2026-10', billingDate: WINDOW.startAt, productCode: 'ecs',
    billItem: '系统盘', cloudResourceId: host.cloudResourceId, cloudResourceType: 'ecs', pretaxAmount: 0.013906704, currency: 'CNY',
    billingScope: 'user', ownerUserId: 'alice', matchedLedgerId: host.id,
    rawPayload: { ProductCode: 'ecs', InstanceID: host.cloudResourceId, OwnerID: UID, Region: REGION, BillingItemCode: 'SystemDiskSize', BillingItem: '系统盘' } };
  await repository.upsertBillingLineItems([bill]);
  return { repository, service: new BillingService(repository), instance, job, host, disk, create, bill };
}

describe('embedded system-disk billing coverage', () => {
  beforeEach(() => jest.useFakeTimers().setSystemTime(new Date('2026-10-09T00:00:00Z')));
  afterEach(() => jest.useRealTimers());

  it('does not count a proven system disk twice when the official component is billed under its host', async () => {
    const f = await fixture();
    await expect(f.service.getSummary(WINDOW)).resolves.toMatchObject({ totalPretaxAmount: 0.013906704, resourcesWithoutBillCount: 0, reconciliationIssues: [] });
    await expect(f.service.listUserItems('alice', WINDOW)).resolves.toEqual([expect.objectContaining({ cloudResourceId: 'i-platform', pretaxAmount: 0.013906704 })]);
  });

  it('recognizes Tencent root-disk components without hiding separately billed data disks', async () => {
    jest.setSystemTime(new Date('2026-09-01'));
    const repository = createMemoryAdminRepository();
    await createTencentBillingProof(repository, { ownerUserId: 'alice' });
    jest.setSystemTime(new Date('2026-10-09'));
    const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue(signedTencentBillingResponse([tencentBill()]));
    try {
      await tencentBillingSync(repository).syncRange(TENCENT_BILLING_WINDOW);
      await expect(new BillingService(repository).getSummary(TENCENT_BILLING_WINDOW)).resolves.toMatchObject({
        totalPretaxAmount: 0.300000003, resourcesWithoutBillCount: 3, reconciliationIssues: [] });
    } finally { fetch.mockRestore(); }
  });

  it('does not treat CPU, network or a different host component as a disk bill', async () => {
    const f = await fixture();
    await f.repository.upsertBillingLineItems([{ ...f.bill, rawPayload: { ...f.bill.rawPayload, BillingItemCode: 'InstanceType', BillingItem: '云服务器配置' } }]);
    await expect(f.service.getSummary(WINDOW)).resolves.toMatchObject({ resourcesWithoutBillCount: 1, reconciliationIssues: [] });
  });

  it('keeps an accurately identified data disk awaiting its independent bill', async () => {
    const f = await fixture({ systemDiskIds: {}, dataDiskIds: { data: 'd-system' } });
    await expect(f.service.getSummary(WINDOW)).resolves.toMatchObject({ resourcesWithoutBillCount: 1, reconciliationIssues: [] });
  });

  it('does not cover one host\'s disk using another host\'s system-disk component', async () => {
    const f = await fixture({ hostIds: { host: 'i-platform', other: 'i-other' }, systemDiskIds: { other: 'd-system' } });
    const coverage = await systemDiskBillingCoverage(f.repository, [f.disk], [f.host, f.disk], await f.repository.listBillingLineItems({}));
    expect(coverage.covered.size).toBe(0);
    expect(coverage.mappingPending.has(f.disk.id)).toBe(true);
  });

  it('does not use an official component from before the disk lifecycle', async () => {
    const f = await fixture();
    const disk = { ...f.disk, billingStartAt: new Date('2026-10-10T00:00:00Z'), releasedAt: null };
    const coverage = await systemDiskBillingCoverage(f.repository, [disk], [f.host, disk], await f.repository.listBillingLineItems({}));
    expect(coverage.covered.size).toBe(0);
    expect(coverage.mappingPending.size).toBe(0);
  });

  it('separates a lost historical mapping from an unbilled resource without inventing disk fees', async () => {
    const f = await fixture();
    await f.repository.updateRangeInstance(f.instance.id, { status: 'destroyed', resourceSummary: null });
    const result = await runInCloudWorkspace({ cloudWorkspaceId: f.instance.cloudWorkspaceId!, provider: 'alibaba_cloud', accountUid: UID,
      actorUserId: 'admin', isPlatformManager: true }, () => f.service.getSummary(WINDOW));
    expect(result).toMatchObject({ totalPretaxAmount: 0.013906704, resourcesWithoutBillCount: 0,
      reconciliationIssues: [{ resourceType: 'disk', resourceCount: 1, reason: expect.stringContaining('不能据此确认每块盘已出账'),
        resources: [{ ledgerId: f.disk.id, cloudResourceId: f.disk.cloudResourceId, sourceProvisionJobId: f.job.id, proofFailureReason: 'SYSTEM_DISK_MAPPING_UNVERIFIED' }] }] });
  });

  it('uses the original frozen inventory after runtime resources have been cleared', async () => {
    const f = await fixture();
    await f.repository.createProvisionJobStepLog({ jobId: f.job.id, stepName: 'range_resource_inventory', status: 'succeeded',
      message: JSON.stringify({ version: 1, rangeInstanceId: f.instance.id, executionContext: context,
        resources: { hostIds: { host: 'i-platform' }, systemDiskIds: { host: 'd-system' } } }), startedAt: new Date(), finishedAt: new Date(), stdoutExcerpt: null, stderrExcerpt: null });
    await f.repository.updateRangeInstance(f.instance.id, { status: 'destroyed', resourceSummary: null });
    await expect(f.service.getSummary(WINDOW)).resolves.toMatchObject({ resourcesWithoutBillCount: 0, reconciliationIssues: [] });
  });

  it.each([
    ['workspace', { cloudWorkspaceId: 'another-workspace' }], ['owner', { ownerUserId: 'bob' }],
    ['account', { executionContext: { ...context, cloudAccountUid: 'other-account' } }],
    ['provider', { executionContext: { ...context, provider: 'tencent_cloud' } }],
    ['region', { executionContext: { ...context, regionId: 'cn-beijing' } }],
    ['instance', { rangeInstanceId: 'other-instance' }], ['job', { sourceJobId: 'other-job' }],
    ['batch', { singleInstanceBatchId: 'other-batch' }],
  ])('does not cover a historical disk using an inventory with conflicting %s', async (_name, mismatch) => {
    const f = await fixture();
    await f.repository.createProvisionJobStepLog({ jobId: f.job.id, stepName: 'range_resource_inventory', status: 'succeeded',
      message: JSON.stringify({ version: 1, rangeInstanceId: f.instance.id, executionContext: context,
        resources: { hostIds: { host: 'i-platform' }, systemDiskIds: { host: 'd-system' } }, ...mismatch }),
      startedAt: new Date(), finishedAt: new Date(), stdoutExcerpt: null, stderrExcerpt: null });
    await f.repository.updateRangeInstance(f.instance.id, { status: 'destroyed', resourceSummary: null });
    const coverage = await systemDiskBillingCoverage(f.repository, [f.disk], [f.host, f.disk], await f.repository.listBillingLineItems({}));
    expect(coverage.covered.size).toBe(0);
    expect(coverage.mappingPending.has(f.disk.id)).toBe(true);
  });

  it.each([
    ['account', { cloudAccountUid: 'other-account' }], ['owner', { ownerUserId: 'bob' }],
    ['workspace', { cloudWorkspaceId: 'other-workspace' }], ['provider', { cloudProvider: 'tencent_cloud' as const }],
    ['region', { regionId: 'cn-beijing' }], ['source job', { sourceProvisionJobId: 'other-job' }],
    ['instance', { rangeInstanceId: 'other-instance' }], ['batch', { singleInstanceBatchId: 'other-batch' }],
  ])('does not use another %s ledger as the billed parent', async (_name, mismatch) => {
    const f = await fixture();
    const coverage = await systemDiskBillingCoverage(f.repository, [f.disk], [{ ...f.host, ...mismatch }, f.disk], await f.repository.listBillingLineItems({}));
    expect(coverage.covered.size).toBe(0);
    expect(coverage.mappingPending.size).toBe(0);
  });

  it('keeps conflicting system and data roles unverified', async () => {
    const f = await fixture({ dataDiskIds: { data: 'd-system' } });
    await expect(f.service.getSummary(WINDOW)).resolves.toMatchObject({ resourcesWithoutBillCount: 0,
      reconciliationIssues: [{ resourceType: 'disk', resourceCount: 1 }] });
  });

  it('reclassifies the 76-record case into 3 snapshot details and 54 historical disk mappings', async () => {
    const f = await fixture();
    const hostIds: Record<string, string> = {}, systemDiskIds: Record<string, string> = {};
    for (let index = 0; index < 70; index++) {
      const host = index ? await f.create(`i-platform-${index}`, 'ecs') : f.host;
      const disk = index ? await f.create(`d-system-${index}`, 'disk') : f.disk;
      hostIds[`host-${index}`] = host.cloudResourceId;
      if (index < 16) systemDiskIds[`host-${index}`] = disk.cloudResourceId;
      if (index) await f.repository.upsertBillingLineItems([{ ...f.bill, sourceFingerprint: `system-disk-${index}`,
        cloudResourceId: host.cloudResourceId, matchedLedgerId: host.id, rawPayload: { ...f.bill.rawPayload, InstanceID: host.cloudResourceId } }]);
    }
    await f.repository.updateRangeInstance(f.instance.id, { resourceSummary: { mode: 'opentofu', executionContext: context, hostIds, systemDiskIds } });
    for (let index = 0; index < 3; index++) {
      const artifact = await f.repository.createPackedImageArtifact({ cloudAccountContextId: context.cloudAccountContextId, cloudAccountUid: UID, regionId: REGION,
        ownerUserId: 'alice', sourceRangeInstanceId: f.instance.id, sourceHostKey: 'host-0', sourceInstanceId: f.host.cloudResourceId, sourceDiskIds: [f.disk.cloudResourceId] });
      await f.repository.updatePackedImageArtifact(artifact.id, { imageId: `m-platform-${index}`, backingSnapshotIds: [`s-platform-${index}`] });
      await f.create(`m-platform-${index}`, 'image');
      await f.create(`s-platform-${index}`, 'snapshot');
    }
    await f.repository.createBillingAnomaly({ cloudAccountUid: UID, syncBatchId: 'sync', sourceFingerprint: 'snapshot-region', billCycle: '2026-10',
      billingDate: WINDOW.startAt, cloudResourceId: REGION, cloudResourceType: 'snapshot_region', pretaxAmount: 1234, currency: 'CNY',
      reason: 'mixed regional snapshots', rawPayload: { ProductCode: 'snapshot', InstanceID: REGION, OwnerID: UID, Region: REGION } });
    const result = await f.service.getSummary(WINDOW);
    expect(result.resourcesWithoutBillCount).toBe(3);
    expect(result.reconciliationIssues).toEqual(expect.arrayContaining([
      expect.objectContaining({ resourceType: 'disk', resourceCount: 54 }), expect.objectContaining({ resourceType: 'snapshot', resourceCount: 3 }),
    ]));
    expect(result.totalPretaxAmount).toBe(0.97346928);
    expect(result.unallocatedCurrencyTotals).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('1234');
  });
});
