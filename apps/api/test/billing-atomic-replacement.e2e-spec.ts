import { PrismaService } from '../src/database/prisma.service';
import { PrismaAdminRepository } from '../src/database/prisma-admin.repository';
import { BillingService } from '../src/admin/billing.service';
import { BillingSyncService } from '../src/admin/billing-sync.service';
import type { BillingBssClient } from '../src/admin/billing-bss-client';
import type { SystemConfigService } from '../src/admin/system-config.service';
import type { CreateBillingLineItemInput } from '../src/admin/admin.repository';
import { createProvenBillingLedger } from './support/create-billing-fixture';

const url = process.env.BILLING_TEST_DATABASE_URL;
if (url) {
  const parsed = new URL(url);
  if (!['postgres', 'billing-test-postgres'].includes(parsed.hostname) || parsed.pathname !== '/billing_test') {
    throw new Error('Billing DB verification requires the isolated billing_test database');
  }
}
const describeDb = url ? describe : describe.skip;
const DAY = '2026-10-01';

describeDb('billing atomic replacement in isolated PostgreSQL', () => {
  const prisma = new PrismaService({ datasources: { db: { url } } });
  const repository = new PrismaAdminRepository(prisma);
  const record = (uid: string, fingerprint: string, amount: number): CreateBillingLineItemInput => ({
    cloudAccountUid: uid, syncBatchId: `billing-sync:${uid}:${DAY}`, sourceFingerprint: `${uid}:${fingerprint}`,
    billCycle: '2026-10', billingDate: DAY, productCode: 'ecs', billItem: fingerprint,
    cloudResourceId: 'i-fixture', cloudResourceType: 'ecs', pretaxAmount: amount, currency: 'CNY', billingScope: 'platform',
  });

  beforeAll(async () => { await prisma.$connect(); });
  afterAll(async () => { await prisma.$disconnect(); });
  beforeEach(async () => {
    await prisma.billingLineItem.deleteMany();
    await prisma.billingAnomaly.deleteMany();
    await prisma.billingLedgerResource.deleteMany();
    await prisma.provisionJob.deleteMany();
    await prisma.rangeInstance.deleteMany();
    await prisma.singleInstanceBatch.deleteMany();
    await prisma.platformUser.deleteMany();
  });

  it('rolls back both old lines and anomalies if bulk insertion fails', async () => {
    const line = record('100001', 'before', 10);
    await repository.replaceBillingDay({ cloudAccountUid: '100001', billingDate: DAY, lineItems: [line], anomalies: [{ cloudAccountUid: '100001', syncBatchId: line.syncBatchId, sourceFingerprint: 'anomaly-before', billCycle: '2026-10', billingDate: DAY, cloudResourceId: 'snapshot-region', cloudResourceType: 'snapshot_region', pretaxAmount: 3, currency: 'CNY', reason: 'fixture' }] });
    const previousLines = await repository.listBillingLineItems();
    const previousAnomalies = await repository.listBillingAnomalies();
    await expect(repository.replaceBillingDay({ cloudAccountUid: '100001', billingDate: DAY, lineItems: [{ ...record('100001', 'after', 20), currency: null } as unknown as CreateBillingLineItemInput], anomalies: [] })).rejects.toThrow();
    expect(await repository.listBillingLineItems()).toEqual(previousLines);
    expect(await repository.listBillingAnomalies()).toEqual(previousAnomalies);
  });

  it('preserves official ten-to-eighteen-decimal amounts through PostgreSQL, summaries and exports', async () => {
    await createProvenBillingLedger(repository, { cloudAccountUid: '100001', regionId: 'cn-hangzhou', cloudResourceId: 'i-precision',
      cloudResourceType: 'ecs', billingScope: 'platform', billingStartAt: new Date(DAY) });
    const config = { getAccountContext: async () => ({ provider: 'alibaba_cloud', accountUid: '100001', accountUidResolved: true }) } as unknown as SystemConfigService;
    const bill = { OwnerID: '100001', ProductCode: 'ecs', InstanceID: 'i-precision', BillingItem: 'CPU', Currency: 'CNY', Region: 'cn-hangzhou' };
    const items = [{ ...bill, PretaxAmount: 0.1325781504 }, { ...bill, Item: 'Refund', PretaxAmount: '-0.0000000001' },
      { ...bill, Currency: 'USD', PretaxAmount: '1e-18' }, { ...bill, Region: 'cn-beijing', PretaxAmount: 0.13257815049 }];
    await new BillingSyncService(repository, { listDailyBillingItems: async () => items } as unknown as BillingBssClient, config).syncRange({ startAt: DAY, endAt: DAY });
    expect((await prisma.billingLineItem.findMany()).map(item => item.pretaxAmount.toFixed())).toEqual(expect.arrayContaining(['0.1325781504', '-0.0000000001', '0.000000000000000001']));
    expect((await prisma.billingAnomaly.findFirst())!.pretaxAmount.toFixed()).toBe('0.13257815049');
    const service = new BillingService(repository);
    expect((await service.getSummary({ startAt: DAY, endAt: DAY })).currencyTotals).toEqual([
      { currency: 'CNY', totalPretaxAmount: 0.1325781503, platformPretaxAmount: 0.1325781503 },
      { currency: 'USD', totalPretaxAmount: 1e-18, platformPretaxAmount: 1e-18 },
    ]);
    const csv = await service.exportPlatformCsv({ startAt: DAY, endAt: DAY });
    expect(csv).toContain('CNY,0.1325781503,0.1325781503\n');
    expect(csv).toContain('USD,1e-18,1e-18\n');
  });

  it('serializes simultaneous whole-day versions while retaining another account and unknown history', async () => {
    await repository.upsertBillingLineItems([{ ...record('100002', 'other-account', 100) }, { ...record('legacy', 'unknown-history', 5), cloudAccountUid: null }]);
    const versions = [[record('100001', 'a-CPU', 10), record('100001', 'a-RAM', 20)], [record('100001', 'b-CPU', 11), record('100001', 'b-RAM', 21)]];
    for (let attempt = 0; attempt < 5; attempt++) {
      await Promise.all(versions.map(lineItems => repository.replaceBillingDay({ cloudAccountUid: '100001', billingDate: DAY, lineItems, anomalies: [] })));
      const rows = await repository.listBillingLineItems({ cloudAccountUid: '100001' });
      expect(rows).toHaveLength(2);
      expect([30, 32]).toContain(rows.reduce((sum, item) => sum + item.pretaxAmount, 0));
    }
    expect(await repository.listBillingLineItems({ cloudAccountUid: '100002' })).toHaveLength(1);
    expect(await repository.listBillingLineItems({ cloudAccountUid: null })).toHaveLength(1);
  });

  it('replaces legacy rows only after their existing ledger proves the account', async () => {
    const ledger = await repository.createBillingLedgerResource({ cloudAccountUid: '100001', regionId: 'cn-hangzhou', cloudResourceId: 'i-known', cloudResourceType: 'ecs', billingScope: 'platform', billingStartAt: new Date(DAY) });
    await repository.upsertBillingLineItems([{ ...record('legacy', 'proved-history', 10), cloudAccountUid: null, cloudResourceId: ledger.cloudResourceId, matchedLedgerId: ledger.id }, { ...record('legacy', 'unproved-history', 5), cloudAccountUid: null }]);
    await repository.replaceBillingDay({ cloudAccountUid: '100001', billingDate: DAY, lineItems: [record('100001', 'fresh', 20)], anomalies: [] });
    expect((await repository.listBillingLineItems({ cloudAccountUid: '100001' }))[0].pretaxAmount).toBe(20);
    const unknown = await repository.listBillingLineItems({ cloudAccountUid: null });
    expect(unknown).toHaveLength(1);
    expect(unknown[0].pretaxAmount).toBe(5);
  });

  it('keeps separate platform users, batch/range/source-job ownership and mixed currencies correct', async () => {
    for (const [id, username] of [['owner-a', 'alice'], ['owner-b', 'bob']] as const) {
      await prisma.platformUser.create({ data: { id, username, loginUsername: username, cloudWorkspaceId: 'legacy-unbound', passwordHash: 'fixture-not-a-credential', role: 'user' } });
    }
    const batch = await prisma.singleInstanceBatch.create({ data: { name: 'fixture-batch', ownerUserId: 'owner-a', platformImageAssetId: 'fixture-image', imageId: 'fixture-cloud-image', imageDisplayName: 'fixture', cpu: 1, memory: 1, systemDiskSize: 40, quantity: 1 } });
    const single = await prisma.rangeInstance.create({ data: { name: 'alice-single', ownerUserId: 'owner-a', instanceMode: 'single', singleInstanceBatchId: batch.id, status: 'running' } });
    const range = await prisma.rangeInstance.create({ data: { name: 'bob-range', ownerUserId: 'owner-b', instanceMode: 'range', status: 'running' } });
    const jobs = await Promise.all([single, range].map(instance => prisma.provisionJob.create({ data: { rangeInstanceId: instance.id, jobType: 'create', status: 'succeeded', triggeredBy: instance.ownerUserId!, finishedAt: new Date('2026-10-01T00:00:00Z') } })));
    for (const [index, instance] of [single, range].entries()) {
      await repository.createBillingLedgerResource({ cloudAccountUid: '100001', regionId: 'cn-hangzhou', cloudResourceId: `i-owner-${index}`, cloudResourceType: 'ecs', billingScope: 'user', ownerUserId: instance.ownerUserId, rangeInstanceId: instance.id, singleInstanceBatchId: instance.singleInstanceBatchId, sourceProvisionJobId: jobs[index].id, billingStartAt: new Date('2026-10-01') });
    }
    const config = { getAccountContext: async () => ({ provider: 'alibaba_cloud', accountUid: '100001', accountUidResolved: true, defaultRegion: 'cn-hangzhou', imageImportBucket: '' }) } as unknown as SystemConfigService;
    const bill = (index: number, currency: string, amount: number) => ({ OwnerID: '100001', ProductCode: 'ecs', InstanceID: `i-owner-${index}`, BillingItem: 'CPU', PretaxAmount: amount, Currency: currency });
    await new BillingSyncService(repository, { listDailyBillingItems: async () => [bill(0, 'CNY', 10), bill(0, 'USD', 2), bill(1, 'CNY', 20)] } as unknown as BillingBssClient, config).syncRange({ startAt: DAY, endAt: DAY });
    const service = new BillingService(repository);
    const alice = await service.getUserSummary('owner-a', { startAt: DAY, endAt: DAY });
    const bob = await service.getUserSummary('owner-b', { startAt: DAY, endAt: DAY });
    expect(alice).toMatchObject({ pretaxAmount: null, launchCount: 1, amounts: [{ currency: 'CNY', pretaxAmount: 10 }, { currency: 'USD', pretaxAmount: 2 }] });
    expect(bob).toMatchObject({ pretaxAmount: 20, currency: 'CNY', launchCount: 1 });
    const groups = await service.listUserGroups({ userId: 'owner-a', startAt: DAY, endAt: DAY });
    expect(groups.items).toHaveLength(2);
    expect(groups.items.every(group => group.ownerUserId === 'owner-a' && group.instance?.batchId === batch.id && group.sourceProvisionJobId === jobs[0].id && group.title === '开启单实例')).toBe(true);
    expect((await service.listUserGroups({ userId: 'owner-b', startAt: DAY, endAt: DAY })).items[0]).toMatchObject({ kind: 'range_launch', title: '开启编排实例', ownerUserId: 'owner-b', pretaxAmount: 20 });
  });

  it('atomically fills a null billing origin once across concurrent writers and preserves release state', async () => {
    const f = await createProvenBillingLedger(repository, { cloudAccountUid: '100001', regionId: 'cn-hangzhou', cloudResourceId: 'i-origin',
      cloudResourceType: 'ecs', billingScope: 'platform', billingStartAt: new Date(DAY), releasedAt: new Date(`${DAY}T08:00:00Z`) });
    await repository.updateProvisionJob(f.job.id, { status: 'failed' });
    const alternate = await repository.createProvisionJob({ rangeInstanceId: f.instance.id, jobType: 'retry', triggeredBy: 'fixture-admin' });
    const expected = await repository.updateBillingLedgerResource(f.ledger.id, { sourceProvisionJobId: null });
    const outcomes = await Promise.all([f.job.id, alternate.id].map(sourceProvisionJobId => repository.repairBillingLedgerOrigin({ expected, sourceProvisionJobId, auditMessage: 'verified fixture creation evidence' })));
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    const final = (await repository.listBillingLedgerResources())[0];
    expect([f.job.id, alternate.id]).toContain(final.sourceProvisionJobId);
    expect(final.releasedAt).toEqual(expected.releasedAt);
    const logs = await prisma.provisionJobStepLog.findMany({ where: { stepName: 'platform_billing_origin_repair' } });
    expect(logs).toHaveLength(1); expect(logs[0].jobId).toBe(final.sourceProvisionJobId);
    expect(await repository.repairBillingLedgerOrigin({ expected, sourceProvisionJobId: f.job.id, auditMessage: 'stale losing writer' })).toBe(false);
    expect(await prisma.provisionJobStepLog.count({ where: { stepName: 'platform_billing_origin_repair' } })).toBe(1);
  });

  it('rolls back the billing origin when its success audit cannot be inserted', async () => {
    const f = await createProvenBillingLedger(repository, { cloudAccountUid: '100001', regionId: 'cn-hangzhou', cloudResourceId: 'i-rollback',
      cloudResourceType: 'ecs', billingScope: 'platform', billingStartAt: new Date(DAY) });
    const expected = await repository.updateBillingLedgerResource(f.ledger.id, { sourceProvisionJobId: null });
    await expect(repository.repairBillingLedgerOrigin({ expected, sourceProvisionJobId: f.job.id, auditMessage: { invalid: 'must be a string' } as unknown as string })).rejects.toThrow();
    expect((await repository.listBillingLedgerResources())[0]).toEqual(expected);
    expect(await prisma.provisionJobStepLog.count({ where: { stepName: 'platform_billing_origin_repair' } })).toBe(0);
  });
});
