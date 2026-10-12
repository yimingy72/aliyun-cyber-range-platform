import { PrismaService } from '../src/database/prisma.service';
import { PrismaAdminRepository } from '../src/database/prisma-admin.repository';
import { runInCloudWorkspace } from '../src/auth/cloud-workspace-scope';

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
  it('does not deadlock with a refresh completion that already holds its job row', async () => {
    const f = await fixture();
    let enter!: (pid: number) => void, release!: () => void;
    const entered = new Promise<number>(resolve => { enter = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const completion = second.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "ProvisionJob" WHERE id = ${f.job.id} FOR UPDATE`;
      const [backend] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
      enter(backend.pid);
      await gate;
      // This is the existing commitSingleInstanceClaim order: job -> instance.
      await tx.$queryRaw`SELECT id FROM "RangeInstance" WHERE id = ${f.instance.id} FOR UPDATE`;
      await tx.provisionJob.update({ where: { id: f.job.id }, data: { status: 'succeeded', finishedAt: new Date() } });
    }, { timeout: 10_000 });
    const completionOutcome = completion.then(() => ({ error: null }), error => ({ error }));
    const holderPid = await entered;
    const queued = a.queueExpiredSingleInstanceDestroy({ rangeInstanceId: f.instance.id, now: new Date() });
    const queuedOutcome = queued.then(result => ({ result, error: null }), error => ({ result: null, error }));
    try {
      // Observe the real lock wait, instead of guessing scheduling with a sleep.
      let waiting = false;
      const deadline = Date.now() + 3_000;
      while (!waiting && Date.now() < deadline) {
        const [lock] = await second.$queryRaw<Array<{ waiting: boolean }>>`SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity WHERE ${holderPid} = ANY(pg_blocking_pids(pid))
        ) AS waiting`;
        waiting = lock.waiting;
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      release();
      expect(await completionOutcome).toEqual({ error: null });
      expect(await queuedOutcome).toMatchObject({ error: null, result: { jobType: 'destroy' } });
      expect(await a.getProvisionJobById(f.job.id)).toMatchObject({ status: 'succeeded' });
      expect(await second.provisionJob.count({ where: { rangeInstanceId: f.instance.id, jobType: 'destroy' } })).toBe(1);
    } finally {
      release();
      await Promise.all([completionOutcome, queuedOutcome]);
      await first.rangeInstance.delete({ where: { id: f.instance.id } });
    }
  });
  it('keeps expired intake and its new job inside the selected workspace', async () => {
    const spaces = await Promise.all(['alibaba_cloud', 'tencent_cloud'].map(provider => first.cloudWorkspace.create({
      data: { provider: provider as 'alibaba_cloud' | 'tencent_cloud', accountUid: String(Date.now()), displayName: 'expiry-scope-fixture' },
    })));
    const scopes = spaces.map(space => ({ cloudWorkspaceId: space.id, provider: space.provider, accountUid: space.accountUid }));
    const instances = await Promise.all(scopes.map(scope => runInCloudWorkspace(scope, () => a.createRangeInstance({
      name: 'expiry-scoped', instanceMode: 'single', status: 'running', expiresAt: '2000-01-01T00:00:00Z',
    }))));
    try {
      await expect(runInCloudWorkspace(scopes[0], () => a.queueExpiredSingleInstanceDestroy({
        rangeInstanceId: instances[1].id, now: new Date(),
      }))).resolves.toBeNull();
      const queued = await runInCloudWorkspace(scopes[0], () => a.queueExpiredSingleInstanceDestroy({
        rangeInstanceId: instances[0].id, now: new Date(),
      }));
      expect(queued).toMatchObject({ cloudWorkspaceId: spaces[0].id, rangeInstanceId: instances[0].id, jobType: 'destroy' });
      expect(await second.rangeInstance.findUnique({ where: { id: instances[1].id } })).toMatchObject({ status: 'running', lastJobId: null });
      expect(await second.provisionJob.count({ where: { cloudWorkspaceId: spaces[1].id } })).toBe(0);
    } finally {
      await first.rangeInstance.deleteMany({ where: { id: { in: instances.map(instance => instance.id) } } });
      await first.cloudWorkspace.deleteMany({ where: { id: { in: spaces.map(space => space.id) } } });
    }
  });
});
