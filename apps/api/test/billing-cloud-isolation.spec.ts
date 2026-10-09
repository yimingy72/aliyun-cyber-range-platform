import type { BillingLedgerResourceRecord, CloudProvider, CreateBillingLineItemInput } from '../src/admin/admin.repository';
import { BillingBssClient } from '../src/admin/billing-bss-client';
import { isPlatformCreatedLedger, loadPlatformBillingProof, pendingPlatformBillingEvidence } from '../src/admin/billing-platform-scope';
import { BillingService } from '../src/admin/billing.service';
import { BillingSyncService } from '../src/admin/billing-sync.service';
import type { SystemCloudAccountContext, SystemConfigService } from '../src/admin/system-config.service';
import { createProvenBillingLedger } from './support/create-billing-fixture';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';

const UID = '100001';
const WINDOW = { startAt: '2026-10-01', endAt: '2026-10-01' };
const CONTEXT = { provider: 'alibaba_cloud', accountUid: UID, accountUidResolved: true,
  accessKeyId: 'test-key', accessKeySecret: 'test-secret' } as SystemCloudAccountContext;
const base = { cloudAccountUid: UID, regionId: 'ap-shanghai', cloudResourceId: 'same-resource-id',
  cloudResourceType: 'ecs' as const, billingScope: 'platform' as const, billingStartAt: new Date('2026-09-01') };
const config = (context: unknown) => ({ getAccountContext: async () => context }) as unknown as SystemConfigService;
const row = { OwnerID: UID, Region: base.regionId, ProductCode: 'ecs', InstanceID: base.cloudResourceId,
  Currency: 'CNY', PretaxAmount: 1, BillingDate: WINDOW.startAt };
const originalFetch = global.fetch;
afterEach(() => { global.fetch = originalFetch; jest.restoreAllMocks(); });

async function tencentLedger(repository: ReturnType<typeof createMemoryAdminRepository>) {
  const provider = 'tencent_cloud' as CloudProvider;
  const instance = await repository.createRangeInstance({ name: 'Tencent source',
    resourceSummary: { mode: 'opentofu', executionContext: { provider, cloudAccountUid: UID, cloudAccountContextId: 'Tencent account', regionId: base.regionId, zoneId: 'ap-shanghai-1' }, hostIds: { host: base.cloudResourceId } } } as Parameters<typeof repository.createRangeInstance>[0]);
  const list = repository.listRangeInstances.bind(repository);
  jest.spyOn(repository, 'listRangeInstances').mockImplementation(async () => (await list())
    .map(value => value.id === instance.id ? { ...value, cloudProvider: provider } : value));
  const job = await repository.createProvisionJob({ rangeInstanceId: instance.id, jobType: 'create', triggeredBy: 'admin' });
  return repository.createBillingLedgerResource({ ...base, cloudProvider: provider, rangeInstanceId: instance.id, sourceProvisionJobId: job.id });
}

function item(ledger: BillingLedgerResourceRecord, marker?: unknown): CreateBillingLineItemInput {
  return { cloudAccountUid: UID, syncBatchId: 'history', sourceFingerprint: `history-${ledger.id}`, billCycle: '2026-10',
    billingDate: WINDOW.startAt, productCode: 'ecs', billItem: 'CPU', cloudResourceId: ledger.cloudResourceId,
    cloudResourceType: 'ecs', pretaxAmount: 123, currency: 'CNY', billingScope: 'platform', matchedLedgerId: ledger.id,
    rawPayload: { ...row, ...(marker !== undefined ? { __platformCloudProvider: marker } : {}) } };
}

describe('billing cloud isolation', () => {
  it.each(['tencent_cloud', 'other_cloud', undefined, null])('blocks Aliyun requests for provider %s before signing', async provider => {
    global.fetch = jest.fn();
    const context = { ...CONTEXT, provider } as unknown as SystemCloudAccountContext;
    const client = new BillingBssClient(config(context));
    await expect(client.listDailyBillingItems({ billingDate: WINDOW.startAt })).rejects.toThrow('尚未接入');
    await expect(client.listDailySplitBillingItems({ billingDate: WINDOW.startAt, productCode: 'snapshot' }, context)).rejects.toThrow('尚未接入');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it.each(['tencent_cloud', 'other_cloud', undefined])('blocks sync writes and retains all historical bills for provider %s', async provider => {
    const repository = createMemoryAdminRepository();
    const { ledger } = await createProvenBillingLedger(repository, base);
    await repository.upsertBillingLineItems([item(ledger)]);
    const previous = await repository.listBillingLineItems();
    const read = jest.spyOn(repository, 'listBillingLedgerResources');
    const replace = jest.spyOn(repository, 'replaceBillingDay');
    const client = { listDailyBillingItems: jest.fn() } as unknown as BillingBssClient;
    await expect(new BillingSyncService(repository, client, config({ ...CONTEXT, provider })).syncRange(WINDOW)).rejects.toThrow('尚未接入');
    expect(read).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    expect(client.listDailyBillingItems).not.toHaveBeenCalled();
    expect(await repository.listBillingLineItems()).toEqual(previous);
  });

  it('requires source instance and frozen execution cloud to agree with the ledger provider', async () => {
    const repository = createMemoryAdminRepository();
    const { ledger, instance } = await createProvenBillingLedger(repository, { ...base, cloudProvider: 'tencent_cloud' as CloudProvider });
    expect((await loadPlatformBillingProof(repository)).createdLedgerIds.has(ledger.id)).toBe(false);
    const list = repository.listRangeInstances.bind(repository);
    jest.spyOn(repository, 'listRangeInstances').mockImplementation(async () => (await list())
      .map(value => value.id === instance.id ? { ...value, cloudProvider: 'tencent_cloud' as CloudProvider } : value));
    await repository.updateRangeInstance(instance.id, {
      resourceSummary: { mode: 'opentofu', executionContext: { provider: 'alibaba_cloud', cloudAccountUid: UID, regionId: base.regionId,
        zoneId: 'ap-shanghai-1', cloudAccountContextId: 'cloud' } } } as Parameters<typeof repository.updateRangeInstance>[1]);
    expect((await loadPlatformBillingProof(repository)).createdLedgerIds.has(ledger.id)).toBe(false);
  });

  it('matches an Aliyun bill only to Aliyun when physical ID, account UID and region collide across clouds', async () => {
    const repository = createMemoryAdminRepository();
    const foreign = await tencentLedger(repository);
    const { ledger } = await createProvenBillingLedger(repository, base);
    expect(isPlatformCreatedLedger(foreign, await loadPlatformBillingProof(repository))).toBe(true);
    const client = { listDailyBillingItems: async () => [row] } as unknown as BillingBssClient;
    await new BillingSyncService(repository, client, config(CONTEXT)).syncRange(WINDOW);
    expect(await repository.listBillingLineItems()).toEqual([expect.objectContaining({ matchedLedgerId: ledger.id,
      syncBatchId: `billing-sync:alibaba_cloud:${UID}:${WINDOW.startAt}`,
      rawPayload: expect.objectContaining({ __platformCloudProvider: 'alibaba_cloud' }) })]);
  });

  it.each([undefined, 'tencent_cloud', 'other_cloud', null])('does not reinterpret a historical foreign line with marker %s as Aliyun fees', async marker => {
    const repository = createMemoryAdminRepository();
    const foreign = await tencentLedger(repository);
    await repository.upsertBillingLineItems([item(foreign, marker)]);
    const service = new BillingService(repository);
    expect((await service.getSummary(WINDOW)).totalPretaxAmount).toBe(0);
    expect(await service.listPlatformItems(WINDOW)).toEqual([]);
    expect(await service.exportPlatformCsv(WINDOW)).not.toContain('123');
    expect(pendingPlatformBillingEvidence({ line: item(foreign, marker).rawPayload!, cloudAccountUid: UID,
      billingDate: WINDOW.startAt, proof: await loadPlatformBillingProof(repository) })).toBeNull();
  });

  it.each(['tencent_cloud', 'other_cloud', null])('ignores contradictory raw cloud markers %s even on a proven Aliyun ledger', async marker => {
    const repository = createMemoryAdminRepository();
    const { ledger } = await createProvenBillingLedger(repository, base);
    await repository.upsertBillingLineItems([item(ledger, marker)]);
    expect((await new BillingService(repository).getSummary(WINDOW)).totalPretaxAmount).toBe(0);
  });

  it('rejects a Tencent billing source even when its provider marker is missing', async () => {
    const repository = createMemoryAdminRepository();
    const { ledger } = await createProvenBillingLedger(repository, base);
    const foreign = item(ledger);
    foreign.rawPayload!.__platformBillingSource = 'DescribeBillDetail';
    await repository.upsertBillingLineItems([foreign]);
    expect(await new BillingService(repository).listPlatformItems(WINDOW)).toEqual([]);
    const client = { listDailyBillingItems: async () => [foreign.rawPayload!] } as unknown as BillingBssClient;
    const replace = jest.spyOn(repository, 'replaceBillingDay');
    await expect(new BillingSyncService(repository, client, config(CONTEXT)).syncRange(WINDOW)).rejects.toThrow('different cloud provider');
    expect(replace).not.toHaveBeenCalled();
  });

  it('cannot use an Aliyun pack artifact to prove or repair a Tencent snapshot with the same physical ID', async () => {
    const repository = createMemoryAdminRepository();
    const artifact = await repository.createPackedImageArtifact({ cloudAccountContextId: 'Aliyun context', cloudAccountUid: UID,
      regionId: base.regionId, ownerUserId: 'alice', sourceRangeInstanceId: 'Aliyun range', sourceHostKey: 'host', sourceInstanceId: 'i-source', sourceDiskIds: ['d-source'] });
    await repository.updatePackedImageArtifact(artifact.id, { imageId: 'm-image', backingSnapshotIds: ['s-snapshot'] });
    const ledger = await repository.createBillingLedgerResource({ ...base, cloudProvider: 'tencent_cloud' as CloudProvider,
      cloudResourceId: 's-snapshot', cloudResourceType: 'snapshot', ownerUserId: 'alice', billingScope: 'user', rangeInstanceId: 'Aliyun range' });
    expect((await loadPlatformBillingProof(repository)).createdLedgerIds.has(ledger.id)).toBe(false);
    const update = jest.spyOn(repository, 'updateBillingLedgerResource');
    await new BillingSyncService(repository, { listDailyBillingItems: async () => [] } as unknown as BillingBssClient, config(CONTEXT)).syncRange(WINDOW);
    expect(update).not.toHaveBeenCalled();
  });
});
