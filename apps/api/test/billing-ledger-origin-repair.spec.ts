import type { SingleInstanceConfig } from '../src/admin/admin.repository';
import type { BillingBssClient } from '../src/admin/billing-bss-client';
import { BillingSyncService } from '../src/admin/billing-sync.service';
import { loadPlatformBillingProof } from '../src/admin/billing-platform-scope';
import type { SystemConfigService } from '../src/admin/system-config.service';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';

const UID = 'billing-test-account';
const DAY = '2026-10-09';
const REGION = 'cn-hangzhou';
const ZONE = 'cn-hangzhou-h';

async function fixture() {
  jest.useFakeTimers().setSystemTime(new Date('2026-10-09T06:48:00Z'));
  const repository = createMemoryAdminRepository();
  const instances = [], jobs = [], ledgers = [], rows: Record<string, unknown>[] = [];
  for (let index = 1; index <= 2; index++) {
    const instance = await repository.createRangeInstance({ name: `tofu-bill-${index}`, instanceMode: 'single', cloudProvider: 'alibaba_cloud',
      ownerUserId: 'owner', singleInstanceBatchId: 'batch', status: 'destroyed', resourceSummary: null,
      singleInstanceConfig: { executionBackend: 'opentofu', cloudAccountUid: UID, cloudAccountContextId: 'frozen-context', regionId: REGION, zoneId: ZONE,
        hostKey: `host-${index}`, opentofuCreateJobId: null } as SingleInstanceConfig });
    const job = await repository.createProvisionJob({ rangeInstanceId: instance.id, jobType: 'create', triggeredBy: 'owner' });
    await repository.updateProvisionJob(job.id, { status: 'failed' });
    const ledger = await repository.createBillingLedgerResource({ cloudProvider: 'alibaba_cloud', cloudAccountUid: UID, regionId: REGION,
      cloudResourceId: `i-owned-${index}`, cloudResourceType: 'ecs', billingScope: 'user', ownerUserId: 'owner', rangeInstanceId: instance.id,
      singleInstanceBatchId: 'batch', sourceProvisionJobId: null, billingStartAt: instance.createdAt, releasedAt: new Date('2026-10-09T07:00:00Z') });
    await repository.createBillingLedgerResource({ cloudProvider: 'alibaba_cloud', cloudAccountUid: UID, regionId: REGION,
      cloudResourceId: `d-owned-${index}`, cloudResourceType: 'disk', billingScope: 'user', ownerUserId: 'owner', rangeInstanceId: instance.id,
      singleInstanceBatchId: 'batch', sourceProvisionJobId: null, billingStartAt: instance.createdAt, releasedAt: ledger.releasedAt });
    const tags = { CreatedBy: 'cyber-range-platform', PlatformManaged: 'true', PlatformTagVersion: '1', CloudAccountUid: UID,
      CloudAccountContextId: 'frozen-context', PlatformHostKey: `host-${index}`, RangeInstanceId: instance.id, PlatformCreateJobId: job.id,
      SingleInstanceBatchId: 'batch', ExecutionBackend: 'opentofu', PlatformResourceType: 'ecs', PlatformScope: 'user', PlatformUserId: 'owner', BillingStartAt: DAY };
    const amounts = index === 1 ? ['0.002963352', '0.0002528', '0.012382578'] : ['0.010663296', '0.044557344', '0.0003256'];
    for (const [component, amount] of amounts.entries()) rows.push({ OwnerID: UID, BillAccountID: UID, BillingDate: DAY, ProductCode: 'ecs',
      InstanceID: ledger.cloudResourceId, Region: '华东1（杭州）', Zone: ZONE, Currency: 'CNY', PretaxAmount: amount,
      BillingItem: `component-${component}`, Tag: Object.entries(tags).map(([key, value]) => `key:${key} value:${value}`).join('; ') });
    instances.push(instance); jobs.push(job); ledgers.push(ledger);
  }
  jest.setSystemTime(new Date('2026-10-12T01:00:00Z'));
  const bss = { listDailyBillingItems: jest.fn(async () => rows) } as unknown as BillingBssClient;
  const config = { getAccountContext: async () => ({ provider: 'alibaba_cloud', accountUid: UID, accountUidResolved: true, defaultRegion: REGION }) } as unknown as SystemConfigService;
  const service = new BillingSyncService(repository, bss, config);
  return { repository, instances, jobs, ledgers, rows, service, sync: () => service.syncRange({ startAt: DAY, endAt: DAY }) };
}

afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });

it('repairs the two missing original failed sources using official bills plus frozen requests, idempotently without reopening released resources', async () => {
  const f = await fixture();
  expect((await loadPlatformBillingProof(f.repository)).createdLedgerIds.size).toBe(0);
  await f.sync();
  const records = await f.repository.listBillingLedgerResources();
  for (const [index, ledger] of f.ledgers.entries()) {
    const updated = records.find(row => row.id === ledger.id)!;
    expect({ ...updated, updatedAt: ledger.updatedAt }).toEqual({ ...ledger, sourceProvisionJobId: f.jobs[index].id });
  }
  expect(records.filter(row => row.cloudResourceType === 'disk').every(row => row.sourceProvisionJobId === null)).toBe(true);
  const bills = await f.repository.listBillingLineItems();
  expect(bills).toHaveLength(6);
  expect(bills.reduce((sum, row) => sum + row.pretaxAmount, 0)).toBeCloseTo(0.071144970, 12);
  for (const job of f.jobs) {
    const logs = await f.repository.listProvisionJobStepLogs(job.id);
    expect(logs).toHaveLength(1);
    expect(logs[0].stepName).toBe('platform_billing_origin_repair');
    expect(JSON.parse(logs[0].message!)).toMatchObject({ evidence: 'official_bill_existing_physical_ledger_frozen_single_request', sourceProvisionJobId: job.id, cloudAccountUid: UID });
  }
  await f.sync();
  const stableBills = (records: typeof bills) => records.map(({ id, createdAt, updatedAt, ...row }) => row);
  expect(stableBills(await f.repository.listBillingLineItems())).toEqual(stableBills(bills));
  for (const job of f.jobs) expect(await f.repository.listProvisionJobStepLogs(job.id)).toHaveLength(1);
});

it.each(['physical-id', 'zone', 'region', 'context', 'owner', 'batch', 'host', 'source', 'duplicate-tags', 'frozen-source', 'workspace', 'billing-time', 'post-lifecycle'] as const)(
  'does not adopt external or contradictory historical evidence: %s', async kind => {
    const f = await fixture();
    f.rows.splice(3);
    for (const row of f.rows) {
      if (kind === 'physical-id') row.InstanceID = 'i-external';
      if (kind === 'zone') row.Zone = 'cn-beijing-a';
      if (kind === 'region') row.RegionId = 'cn-beijing';
      if (kind === 'context') row.Tag = String(row.Tag).replace('value:frozen-context', 'value:other-context');
      if (kind === 'owner') row.Tag = String(row.Tag).replace('key:PlatformUserId value:owner', 'key:PlatformUserId value:other');
      if (kind === 'batch') row.Tag = String(row.Tag).replace('key:SingleInstanceBatchId value:batch', 'key:SingleInstanceBatchId value:other');
      if (kind === 'host') row.Tag = String(row.Tag).replace('key:PlatformHostKey value:host-1', 'key:PlatformHostKey value:other');
      if (kind === 'source') row.Tag = String(row.Tag).replace(`value:${f.jobs[0].id}`, `value:${f.jobs[1].id}`);
      if (kind === 'duplicate-tags') row.Tag = `key:PlatformCreateJobId value:foreign; ${row.Tag}`;
    }
    if (kind === 'frozen-source') await f.repository.updateRangeInstance(f.instances[0].id, { singleInstanceConfig: { ...f.instances[0].singleInstanceConfig!, opentofuCreateJobId: f.jobs[1].id } });
    if (kind === 'workspace') jest.spyOn(f.repository, 'listProvisionJobs').mockResolvedValue(f.jobs.map(job => ({ ...job, cloudWorkspaceId: 'foreign' })));
    if (kind === 'billing-time') await f.repository.updateBillingLedgerResource(f.ledgers[0].id, { billingStartAt: new Date('2026-10-10') });
    if (kind === 'post-lifecycle') await f.repository.updateBillingLedgerResource(f.ledgers[0].id, { releasedAt: new Date('2026-10-07') });
    const before = await f.repository.listBillingLedgerResources();
    await f.sync();
    expect(await f.repository.listBillingLedgerResources()).toEqual(before);
    expect(await f.repository.listBillingLineItems()).toEqual([]);
    for (const job of f.jobs) expect(await f.repository.listProvisionJobStepLogs(job.id)).toEqual([]);
  });

it('requires every component for a physical resource to corroborate the same source and never fabricates a missing ledger', async () => {
  const f = await fixture(); f.rows.splice(3); f.rows[1].Zone = 'cn-beijing-a';
  f.rows.push({ ...f.rows[0], InstanceID: 'i-external-tagged-like-platform' });
  const before = await f.repository.listBillingLedgerResources();
  await f.sync();
  expect(await f.repository.listBillingLedgerResources()).toEqual(before);
  expect(await f.repository.listBillingLineItems()).toEqual([]);
});

it('keeps a birth source filled by another writer and emits no successful repair audit for the lost race', async () => {
  const f = await fixture(); f.rows.splice(3);
  const cas = f.repository.repairBillingLedgerOrigin.bind(f.repository);
  jest.spyOn(f.repository, 'repairBillingLedgerOrigin').mockImplementation(async input => {
    await f.repository.updateBillingLedgerResource(input.expected.id, { sourceProvisionJobId: 'concurrent-birth-job' });
    return cas(input);
  });
  await f.sync();
  expect((await f.repository.listBillingLedgerResources()).find(row => row.id === f.ledgers[0].id)!.sourceProvisionJobId).toBe('concurrent-birth-job');
  expect(await f.repository.listProvisionJobStepLogs(f.jobs[0].id)).toEqual([]);
  expect(await f.repository.listBillingLineItems()).toEqual([]);
});

it('does not write successful audit or bill rows when the atomic origin write fails', async () => {
  const f = await fixture();
  const before = await f.repository.listBillingLedgerResources();
  jest.spyOn(f.repository, 'repairBillingLedgerOrigin').mockRejectedValue(new Error('atomic origin write failed'));
  await expect(f.sync()).rejects.toThrow('atomic origin write failed');
  expect(await f.repository.listBillingLedgerResources()).toEqual(before);
  for (const job of f.jobs) expect(await f.repository.listProvisionJobStepLogs(job.id)).toEqual([]);
  expect(await f.repository.listBillingLineItems()).toEqual([]);
});

it('refreshes source proof after a competing worker supplies the valid origin so the same sync includes the official fees', async () => {
  const f = await fixture(); f.rows.splice(3);
  const cas = f.repository.repairBillingLedgerOrigin.bind(f.repository);
  jest.spyOn(f.repository, 'repairBillingLedgerOrigin').mockImplementation(async input => {
    await f.repository.updateBillingLedgerResource(input.expected.id, { sourceProvisionJobId: f.jobs[0].id });
    return cas(input);
  });
  await f.sync();
  expect(await f.repository.listBillingLineItems()).toHaveLength(3);
  expect((await f.repository.listBillingLineItems()).reduce((sum, row) => sum + row.pretaxAmount, 0)).toBeCloseTo(0.015598730, 12);
  expect(await f.repository.listProvisionJobStepLogs(f.jobs[0].id)).toEqual([]);
});
