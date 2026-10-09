import { performance } from 'node:perf_hooks';
import { PrismaService } from '../src/database/prisma.service';
import { PrismaAdminRepository } from '../src/database/prisma-admin.repository';
import { releaseRangeInstanceBillingLedger, syncRangeInstanceBillingLedger } from '../src/admin/billing-ledger-sync';

const url = process.env.BILLING_TEST_DATABASE_URL;
if (url) {
  const parsed = new URL(url);
  if (!['postgres', 'billing-test-postgres'].includes(parsed.hostname) || parsed.pathname !== '/billing_test') {
    throw new Error('Billing batch verification requires the isolated billing_test database');
  }
}
const describeDb = url ? describe : describe.skip;

describeDb('billing ledger batch workload in isolated PostgreSQL', () => {
  const prisma = new PrismaService({ datasources: { db: { url } } });
  const repository = new PrismaAdminRepository(prisma);
  const started = new Date('2026-10-09T00:00:00Z');
  beforeAll(async () => { await prisma.$connect(); });
  afterAll(async () => { await prisma.$disconnect(); });
  beforeEach(async () => {
    await prisma.billingLedgerResource.deleteMany();
    for (const owner of ['alice', 'bob']) await prisma.platformUser.upsert({
      where: { id: owner }, update: {}, create: { id: owner, username: `billing-fixture-${owner}`, passwordHash: 'fixture-only', role: 'user' },
    });
  });

  it('keeps 50 member sync and release reads proportional to their own resources with 10,000 unrelated ledgers', async () => {
    await prisma.billingLedgerResource.createMany({ data: Array.from({ length: 10_000 }, (_, index) => ({
      cloudAccountUid: 'other-account', regionId: 'cn-hangzhou', cloudResourceId: `background-${index}`,
      cloudResourceType: 'ecs' as const, billingScope: 'user' as const, ownerUserId: 'other-owner',
      rangeInstanceId: `background-range-${index}`, billingStartAt: started,
    })) });
    const instances = await Promise.all(Array.from({ length: 50 }, (_, index) => repository.createRangeInstance({
      name: `billing-batch-${index}`, ownerUserId: index % 2 ? 'alice' : 'bob', instanceMode: 'single', status: 'running',
    })));
    const input = (instance: typeof instances[number], index: number) => ({
      repository, instance, regionId: 'cn-hangzhou', cloudAccountUid: index % 2 ? 'account-a' : 'account-b', billingStartAt: started,
      resourceSummary: { mode: 'opentofu' as const, hostIds: { app: `i-batch-${index}` }, systemDiskIds: { app: `d-batch-${index}` } },
    });
    const originalList = repository.listBillingLedgerResources.bind(repository);
    let rowsRead = 0;
    const list = jest.spyOn(repository, 'listBillingLedgerResources').mockImplementation(async filter => {
      expect(filter?.rangeInstanceId).toBeDefined();
      const rows = await originalList(filter); rowsRead += rows.length; return rows;
    });
    const keyedLookup = jest.spyOn(repository, 'findBillingLedgerResource');
    const createStart = performance.now();
    for (const [index, instance] of instances.entries()) await syncRangeInstanceBillingLedger(input(instance, index));
    const createMs = performance.now() - createStart;
    expect(list).toHaveBeenCalledTimes(50);
    expect(keyedLookup).toHaveBeenCalledTimes(150);
    expect(rowsRead).toBe(0);
    for (const [index, instance] of instances.entries()) await syncRangeInstanceBillingLedger(input(instance, index));
    expect(rowsRead).toBe(100);
    for (const instance of instances) await releaseRangeInstanceBillingLedger(repository, instance.id, new Date('2026-10-09T01:00:00Z'));
    expect(rowsRead).toBe(200);
    list.mockRestore(); keyedLookup.mockRestore();
    const actual = await originalList();
    expect(actual.filter(row => row.cloudAccountUid === 'other-account')).toHaveLength(10_000);
    expect(actual.filter(row => row.cloudAccountUid === 'other-account').every(row => row.releasedAt === null && row.ownerUserId === 'other-owner')).toBe(true);
    for (const [index, instance] of instances.entries()) {
      const rows = actual.filter(row => row.rangeInstanceId === instance.id);
      expect(rows).toHaveLength(2);
      expect(rows.every(row => row.ownerUserId === instance.ownerUserId && row.cloudAccountUid === (index % 2 ? 'account-a' : 'account-b') && row.billingStartAt.getTime() === started.getTime() && row.releasedAt !== null)).toBe(true);
    }
    // Compare only the old and new history-read step; this is not a cloud provisioning benchmark.
    const oldStart = performance.now();
    let oldRows = 0;
    for (const _instance of instances) oldRows += (await originalList()).length;
    const oldReadMs = performance.now() - oldStart;
    const scopedStart = performance.now();
    let scopedRows = 0;
    for (const instance of instances) scopedRows += (await originalList({ rangeInstanceId: instance.id })).length;
    console.info(JSON.stringify({ benchmark: 'billing-ledger-50-members', backgroundRows: 10_000, historyReadQueries: 50,
      oldRows, scopedRows, oldReadMs: Math.round(oldReadMs), scopedReadMs: Math.round(performance.now() - scopedStart), createSyncMs: Math.round(createMs) }));
    expect(oldRows).toBe(505_000);
    expect(scopedRows).toBe(100);
    await prisma.rangeInstance.deleteMany({ where: { id: { in: instances.map(instance => instance.id) } } });
  }, 60_000);

  it('handles simultaneous same-resource inserts idempotently and preserves successful launch provenance', async () => {
    const instance = await repository.createRangeInstance({ name: 'concurrent-ledger', ownerUserId: 'alice', status: 'running' });
    const job = await repository.createProvisionJob({ rangeInstanceId: instance.id, jobType: 'create', triggeredBy: 'alice' });
    await repository.updateProvisionJob(job.id, { status: 'succeeded', finishedAt: started });
    const input = { repository, instance, regionId: 'cn-hangzhou', cloudAccountUid: 'account-a', sourceProvisionJobId: job.id,
      resourceSummary: { mode: 'opentofu' as const, hostIds: { app: 'i-concurrent' }, systemDiskIds: { app: 'd-concurrent' } }, billingStartAt: started };
    await Promise.all(Array.from({ length: 10 }, () => syncRangeInstanceBillingLedger(input)));
    const rows = await repository.listBillingLedgerResources({ rangeInstanceId: instance.id });
    expect(rows).toHaveLength(2);
    expect(rows.every(row => row.ownerUserId === 'alice' && row.cloudAccountUid === 'account-a' && row.sourceProvisionJobId === job.id && row.billingStartAt.getTime() === started.getTime())).toBe(true);
    await expect(syncRangeInstanceBillingLedger({ ...input, cloudAccountUid: 'account-b' })).rejects.toThrow('ownership conflicts');
    expect(await repository.listBillingLedgerResources({ rangeInstanceId: instance.id })).toEqual(rows);
    await prisma.provisionJob.deleteMany({ where: { rangeInstanceId: instance.id } });
    await prisma.rangeInstance.delete({ where: { id: instance.id } });
  });
});
