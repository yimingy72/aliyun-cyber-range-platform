import { PrismaService } from '../src/database/prisma.service';
import { PrismaAdminRepository } from '../src/database/prisma-admin.repository';

// Opt-in isolated PostgreSQL only; never point this variable at a production database.
const enabled = Boolean(process.env.NATIVE_BATCH_TEST_DATABASE_URL);
(enabled ? describe : describe.skip)('atomic automatic-destroy intake with real PostgreSQL', () => {
  const first = new PrismaService({ datasourceUrl: process.env.NATIVE_BATCH_TEST_DATABASE_URL });
  const second = new PrismaService({ datasourceUrl: process.env.NATIVE_BATCH_TEST_DATABASE_URL });
  const a = new PrismaAdminRepository(first), b = new PrismaAdminRepository(second);
  afterAll(async () => { await first.$disconnect(); await second.$disconnect(); });
  async function fixture() {
    const instance = await a.createRangeInstance({ name: 'expiry-transaction-fixture', instanceMode: 'single',
      status: 'creating', expiresAt: '2000-01-01T00:00:00Z' });
    const job = await a.createProvisionJob({ rangeInstanceId: instance.id, jobType: 'refresh_status', triggeredBy: 'fixture' });
    await a.claimProvisionJob(job.id, new Date());
    await a.updateRangeInstance(instance.id, { lastJobId: job.id });
    return { instance, job };
  }
  it('rolls back supersession and new job insertion when the final instance write fails', async () => {
    const f = await fixture();
    const failing = first.$extends({ query: { rangeInstance: { async update({ args, query }) {
      if (args.where.id === f.instance.id && args.data.status === 'pending_destroy') throw new Error('fixture final write failure');
      return query(args);
    } } } });
    try {
      await expect(new PrismaAdminRepository(failing as unknown as PrismaService)
        .queueExpiredSingleInstanceDestroy({ rangeInstanceId: f.instance.id, now: new Date() })).rejects.toThrow('fixture final write failure');
      expect(await b.getProvisionJobById(f.job.id)).toMatchObject({ status: 'running' });
      expect(await b.getRangeInstanceById(f.instance.id)).toMatchObject({ status: 'creating', lastJobId: f.job.id });
      expect(await second.provisionJob.count({ where: { rangeInstanceId: f.instance.id } })).toBe(1);
      const queued = await b.queueExpiredSingleInstanceDestroy({ rangeInstanceId: f.instance.id, now: new Date() });
      expect(queued).toMatchObject({ jobType: 'destroy', triggeredBy: 'system:auto-expire' });
      expect(await a.getProvisionJobById(f.job.id)).toMatchObject({ status: 'failed' });
      expect(await a.getRangeInstanceById(f.instance.id)).toMatchObject({ status: 'pending_destroy', lastJobId: queued!.id });
      expect(await a.queueExpiredSingleInstanceDestroy({ rangeInstanceId: f.instance.id, now: new Date() })).toBeNull();
      expect(await second.provisionJob.count({ where: { rangeInstanceId: f.instance.id } })).toBe(2);
    } finally { await first.rangeInstance.delete({ where: { id: f.instance.id } }); }
  });
  it('does not wait for another connection holding the manual-intake lock', async () => {
    const f = await fixture();
    let release!: () => void, entered!: () => void;
    const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
    const held = a.withSingleInstanceControlLock(async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); });
    await enteredPromise;
    try {
      expect(await b.queueExpiredSingleInstanceDestroy({ rangeInstanceId: f.instance.id, now: new Date() })).toBeNull();
      expect(await second.provisionJob.count({ where: { rangeInstanceId: f.instance.id } })).toBe(1);
    } finally { release(); await held; await first.rangeInstance.delete({ where: { id: f.instance.id } }); }
  });
  it('allows only one destroy intake when two connections race', async () => {
    const f = await fixture();
    try {
      const results = await Promise.all([a, b].map(repository => repository.queueExpiredSingleInstanceDestroy({ rangeInstanceId: f.instance.id, now: new Date() })));
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await second.provisionJob.count({ where: { rangeInstanceId: f.instance.id, jobType: 'destroy' } })).toBe(1);
    } finally { await first.rangeInstance.delete({ where: { id: f.instance.id } }); }
  });
});
