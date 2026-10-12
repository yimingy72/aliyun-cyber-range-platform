import { BillingSyncService } from '../src/admin/billing-sync.service';
import { BillingService } from '../src/admin/billing.service';
import type { BillingBssClient } from '../src/admin/billing-bss-client';
import type { SystemConfigService } from '../src/admin/system-config.service';
import * as evidence from '../src/admin/aliyun-snapshot-ecs-evidence';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';
import { createProvenBillingLedger } from './support/create-billing-fixture';
import { runInCloudWorkspace } from '../src/auth/cloud-workspace-scope';

const DAY = '2026-10-10', UID = '123456';
const baseBill = (value: Record<string, unknown> = {}) => ({ OwnerID: UID, SplitAccountID: UID, Region: '华东1（杭州）', ProductCode: 'snapshot', InstanceID: 'cn-hangzhou',
  Currency: 'CNY', PretaxAmount: '0.4', BillingDate: DAY, Item: 'PayAsYouGoBill', BillingItem: '快照容量', BillingItemCode: 'Size', ...value });
async function fixture(withBaseline = true, parentBorn = '2026-10-09T00:00:00Z') {
  jest.useFakeTimers().setSystemTime(new Date(parentBorn));
  const repository = createMemoryAdminRepository();
  const f = await createProvenBillingLedger(repository, { cloudAccountUid: UID, regionId: 'cn-hangzhou', cloudResourceId: 'i-owned', cloudResourceType: 'ecs',
    billingScope: 'user', ownerUserId: 'user-owned', billingStartAt: new Date() });
  await repository.updateProvisionJob(f.job.id, { startedAt: new Date(), status: 'succeeded' });
  await repository.createBillingLedgerResource({ cloudAccountUid: UID, regionId: 'cn-hangzhou', cloudResourceId: 'd-owned', cloudResourceType: 'disk',
    billingScope: 'user', ownerUserId: 'user-owned', rangeInstanceId: f.instance.id, sourceProvisionJobId: f.job.id, billingStartAt: new Date() });
  jest.setSystemTime(new Date('2026-10-09T01:00:00Z'));
  const source = { id: 'artifact-owned', cloudProvider: 'alibaba_cloud' as const, cloudWorkspaceId: f.ledger.cloudWorkspaceId ?? 'legacy-unbound',
    cloudAccountContextId: 'test-context', cloudAccountUid: UID, regionId: 'cn-hangzhou', ownerUserId: 'user-owned',
    sourceRangeInstanceId: f.instance.id, sourceHostKey: 'host', sourceInstanceId: 'i-owned', sourceDiskIds: ['d-owned'] };
  const artifact = await repository.createPackedImageArtifact({ ...source, sourceSnapshotBaseline: withBaseline ? { ...source, kind: evidence.ALIYUN_PACK_SNAPSHOT_BASELINE_KIND,
    observedAt: '2026-10-09T00:59:50Z', sourceDisks: [{ sourceDiskId: 'd-owned', snapshotIds: [], requestIds: ['snapshot-request'] }],
    autoSnapshotPolicyIds: [], policyRequestIds: ['policy-request'] } : undefined });
  await repository.updatePackedImageArtifact(artifact.id, { imageId: 'm-owned', backingSnapshotIds: ['s-owned'] });
  await repository.createBillingLedgerResource({ cloudAccountUid: UID, regionId: 'cn-hangzhou', cloudResourceId: 's-owned', cloudResourceType: 'snapshot',
    billingScope: 'user', ownerUserId: 'user-owned', rangeInstanceId: f.instance.id, billingStartAt: new Date(), releasedAt: new Date('2026-10-10T01:00:00Z') });
  await repository.updateBillingLedgerResource(f.ledger.id, { releasedAt: new Date('2026-10-09T01:30:00Z') });
  jest.setSystemTime(new Date('2026-10-12T02:00:00Z'));
  const history: evidence.AliyunSnapshotHistory = { version: 1, provider: 'alibaba_cloud', cloudWorkspaceId: artifact.cloudWorkspaceId ?? 'legacy-unbound', cloudAccountUid: UID,
    regionId: 'cn-hangzhou', sourceInstanceId: 'i-owned', startAt: new Date(Date.parse(parentBorn) - 1000).toISOString(), endAt: '2026-10-10T15:59:59Z', observedAt: new Date().toISOString(), requestIds: ['history-request'], events: [
      { id: 'event-birth', name: 'RunInstances', type: 'ApiCall', failed: false, time: parentBorn, requestResourceIds: [], responseResourceIds: ['i-owned'], resourceIds: [] },
      { id: 'event-pack', name: 'CreateImage', type: 'ApiCall', failed: false, time: '2026-10-09T01:00:01Z', requestResourceIds: ['i-owned'], responseResourceIds: ['m-owned'], resourceIds: [] }] };
  const collect = jest.spyOn(evidence, 'collectAliyunSnapshotHistory').mockResolvedValue(history);
  const bss = { listDailyBillingItems: jest.fn(async () => [baseBill()]), listDailySplitBillingItems: jest.fn(async () => [
    baseBill({ SplitItemID: 'i-owned', PretaxAmount: '0.1' }), baseBill({ SplitItemID: 'i-otherbusiness', PretaxAmount: '0.3' })]) };
  const sync = new BillingSyncService(repository, bss as unknown as BillingBssClient, { getAccountContext: async () => ({ provider: 'alibaba_cloud', accountUid: UID,
    accountUidResolved: true, defaultRegion: 'cn-hangzhou', cloudAccountContextId: 'test-context', accessKeyId: 'fixture-key', accessKeySecret: 'fixture-secret' }) } as unknown as SystemConfigService);
  return { repository, artifact, source: f.ledger, collect, history, bss, sync, service: new BillingService(repository) };
}
afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });
describe('source ECS snapshot automatic reconciliation', () => {
  it('imports only the proven source fee after parent deletion and does not duplicate on repeat', async () => {
    const f = await fixture();
    for (let i = 0; i < 2; i++) await f.sync.syncRange({ startAt: DAY, endAt: DAY });
    const rows = await f.repository.listBillingLineItems();
    expect(rows).toEqual([expect.objectContaining({ cloudResourceId: 'i-owned', cloudResourceType: 'ecs', productCode: 'snapshot', pretaxAmount: 0.1,
      rawPayload: expect.objectContaining({ __platformSnapshotEcsScope: expect.objectContaining({ snapshotIds: ['s-owned'] }) }) })]);
    expect(await f.service.getSummary({ startAt: DAY, endAt: DAY })).toMatchObject({ totalPretaxAmount: 0.1,
      resourceTypeTotals: [{ resourceType: 'snapshot', pretaxAmount: 0.1, currency: 'CNY' }] });
  });
  it('keeps unverified history pending, automatically imports later, and retains verified money during outages', async () => {
    const f = await fixture();
    f.collect.mockResolvedValue(null);
    await f.sync.syncRange({ startAt: DAY, endAt: DAY });
    expect(await f.repository.listBillingLineItems()).toEqual([]);
    expect((await f.service.getSummary({ startAt: DAY, endAt: DAY })).reconciliationIssues).toEqual(expect.arrayContaining([expect.objectContaining({ resourceType: 'snapshot', resourceCount: 1 })]));
    f.collect.mockResolvedValue(f.history);
    await f.sync.syncRange({ startAt: DAY, endAt: DAY });
    f.collect.mockResolvedValue(null);
    await f.sync.syncRange({ startAt: DAY, endAt: DAY });
    expect(await f.repository.listBillingLineItems()).toEqual([expect.objectContaining({ pretaxAmount: 0.1, rawPayload: expect.objectContaining({ __platformBillingSyncDeferred: true }) })]);
    expect((await f.service.getSummary({ startAt: DAY, endAt: DAY })).reconciliationIssues).toEqual(expect.arrayContaining([expect.objectContaining({ resourceType: 'snapshot', resourceCount: 1 })]));
  });
  it('does not query audit history to backfill a baseline for old artifacts', async () => {
    const f = await fixture(false);
    await f.sync.syncRange({ startAt: DAY, endAt: DAY });
    expect(f.collect).not.toHaveBeenCalled();
    expect(await f.repository.listBillingLineItems()).toEqual([]);
  });
  it('does not let a later daily source fee hide an earlier snapshot with no bill for its own lifetime', async () => {
    const f = await fixture();
    jest.setSystemTime(new Date('2026-10-09T00:30:00Z'));
    const oldSource = { id: 'artifact-earlier', cloudProvider: 'alibaba_cloud' as const, cloudWorkspaceId: f.source.cloudWorkspaceId ?? 'legacy-unbound', cloudAccountContextId: 'test-context', cloudAccountUid: UID,
      regionId: 'cn-hangzhou', ownerUserId: 'user-owned', sourceRangeInstanceId: f.source.rangeInstanceId!, sourceHostKey: 'host', sourceInstanceId: 'i-owned', sourceDiskIds: ['d-owned'] };
    const earlier = await f.repository.createPackedImageArtifact({ ...oldSource, sourceSnapshotBaseline: { ...oldSource, kind: evidence.ALIYUN_PACK_SNAPSHOT_BASELINE_KIND,
      observedAt: '2026-10-09T00:29:50Z', sourceDisks: [{ sourceDiskId: 'd-owned', snapshotIds: [], requestIds: ['earlier-request'] }],
      autoSnapshotPolicyIds: [], policyRequestIds: ['policy-earlier'] } });
    await f.repository.updatePackedImageArtifact(earlier.id, { imageId: 'm-earlier', backingSnapshotIds: ['s-earlier'] });
    const old = await f.repository.createBillingLedgerResource({ cloudAccountUid: UID, regionId: 'cn-hangzhou', cloudResourceId: 's-earlier', cloudResourceType: 'snapshot',
      billingScope: 'user', ownerUserId: 'user-owned', rangeInstanceId: f.source.rangeInstanceId!, billingStartAt: new Date(), releasedAt: new Date('2026-10-09T00:50:00Z') });
    f.history.events.push({ id: 'event-earlier', name: 'CreateImage', type: 'ApiCall', failed: false, time: '2026-10-09T00:30:01Z',
      requestResourceIds: ['i-owned'], responseResourceIds: ['m-earlier'], resourceIds: [] });
    jest.setSystemTime(new Date('2026-10-12T02:00:00Z'));
    await f.sync.syncRange({ startAt: DAY, endAt: DAY });
    const summary = await runInCloudWorkspace({ cloudWorkspaceId: 'legacy-unbound', provider: 'alibaba_cloud', accountUid: UID, cloudAccountContextId: 'test-context',
      actorUserId: 'fixture-admin', isPlatformManager: true, isReadOnly: false }, () => f.service.getSummary({ startAt: '2026-10-09', endAt: DAY }));
    const issue = summary.reconciliationIssues.find(row => row.resourceType === 'snapshot')!;
    expect(issue).toMatchObject({ resourceCount: 1, resources: [expect.objectContaining({ ledgerId: old.id, cloudResourceId: 's-earlier' })] });
  });
  it('includes a new snapshot from an old platform ECS without including the old ECS charge', async () => {
    const previous = process.env.PLATFORM_BILLING_STARTED_AT;
    process.env.PLATFORM_BILLING_STARTED_AT = '2026-09-30T16:00:00.000Z';
    try {
      const f = await fixture(true, '2026-09-01T00:00:00Z');
      f.bss.listDailyBillingItems.mockResolvedValue([baseBill(), baseBill({ ProductCode: 'ecs', InstanceID: 'i-owned', PretaxAmount: '99' })]);
      await f.sync.syncRange({ startAt: DAY, endAt: DAY });
      expect(await f.service.getSummary({ startAt: DAY, endAt: DAY })).toMatchObject({ totalPretaxAmount: 0.1, resourcesWithoutBillCount: 0 });
      f.collect.mockResolvedValue(null);
      await f.sync.syncRange({ startAt: DAY, endAt: DAY });
      expect((await f.service.getSummary({ startAt: DAY, endAt: DAY })).totalPretaxAmount).toBe(0.1);
    } finally { if (previous === undefined) delete process.env.PLATFORM_BILLING_STARTED_AT; else process.env.PLATFORM_BILLING_STARTED_AT = previous; }
  });
});
