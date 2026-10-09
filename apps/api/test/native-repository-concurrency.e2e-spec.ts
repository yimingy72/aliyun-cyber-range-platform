import { PrismaService } from '../src/database/prisma.service';
import { PrismaAdminRepository } from '../src/database/prisma-admin.repository';
const enabled = Boolean(process.env.NATIVE_BATCH_TEST_DATABASE_URL);
(enabled ? describe : describe.skip)('native repository with two real PostgreSQL connections', () => {
  const first = new PrismaService({ datasourceUrl: process.env.NATIVE_BATCH_TEST_DATABASE_URL });
  const second = new PrismaService({ datasourceUrl: process.env.NATIVE_BATCH_TEST_DATABASE_URL });
  const a = new PrismaAdminRepository(first);
  const b = new PrismaAdminRepository(second);
  afterAll(async () => { await first.$disconnect(); await second.$disconnect(); });
  it('holds a nonblocking batch execution lock across connections and releases it after completion or rejection', async () => {
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const running = a.tryWithSingleInstanceBatchProvisionLock('synthetic-queue-batch', async () => { entered(); await gate; return 1; });
    await started;
    try {
      const blockedWork = jest.fn();
      expect(await b.tryWithSingleInstanceBatchProvisionLock('synthetic-queue-batch', blockedWork)).toEqual({ acquired: false });
      expect(blockedWork).not.toHaveBeenCalled();
      expect(await b.tryWithSingleInstanceBatchProvisionLock('synthetic-other-batch', async () => 2)).toEqual({ acquired: true, result: 2 });
    } finally { release(); await running; }
    await expect(a.tryWithSingleInstanceBatchProvisionLock('synthetic-queue-batch', async () => { throw new Error('synthetic rollback'); })).rejects.toThrow('synthetic rollback');
    expect(await b.tryWithSingleInstanceBatchProvisionLock('synthetic-queue-batch', async () => 3)).toEqual({ acquired: true, result: 3 });
  });
  it('serializes control intake across connections and scopes profiles by account UID', async () => {
    const order: string[] = [];
    await Promise.all([a.withSingleInstanceControlLock(async () => { order.push('first-enter'); await first.$executeRaw `SELECT pg_sleep(0.03)`; order.push('first-exit'); }), b.withSingleInstanceControlLock(async () => { order.push('second-enter'); order.push('second-exit'); })]);
    expect(order[1]).toBe(order[0].replace('enter', 'exit'));
    const input = { provider: 'alibaba_cloud' as const, regionId: 'cn-test', zoneId: 'cn-test-a', vpcId: 'vpc-test', vpcCidr: '10.88.0.0/16', vswitchIds: ['vsw-test'], vswitchCidrs: ['10.88.1.0/24'], securityGroupId: 'sg-test', securityGroupName: 'test' };
    const [p, q] = await Promise.all([a.upsertSingleInstanceNetworkProfile({ ...input, cloudAccountUid: 'synthetic-a' }), b.upsertSingleInstanceNetworkProfile({ ...input, cloudAccountUid: 'synthetic-b' })]);
    expect(p.id).not.toBe(q.id);
    const launchIdentity = { ...input, cloudAccountUid: 'synthetic-a', cloudAccountContextId: 'synthetic-context', createdByUserId: 'synthetic-user' };
    expect((await a.getSingleInstanceNetworkProfile(launchIdentity))?.id).toBe(p.id);
    expect((await b.getSingleInstanceNetworkProfile({ ...launchIdentity, cloudAccountUid: 'synthetic-b' }))?.id).toBe(q.id);
    await a.deleteSingleInstanceNetworkProfile(p.id);
    await b.deleteSingleInstanceNetworkProfile(q.id);
  });
  it('queries pending FIFO pages and expired live instances without hydrating runtime secrets', async () => {
    const expiredAt = new Date('2000-01-01T00:00:00Z');
    const instance = await a.createRangeInstance({ name: 'queue-db-fixture', instanceMode: 'single', status: 'creating', expiresAt: expiredAt.toISOString(),
      runtimeCredentials: { host: { username: 'synthetic', password: 'synthetic-fixture-only' } } });
    try {
      const jobs = [];
      for (let index = 0; index < 3; index++) {
        jobs.push(await first.provisionJob.create({ data: { id: `queue-synthetic-${index}`, rangeInstanceId: instance.id,
          jobType: 'create', triggeredBy: 'synthetic', createdAt: expiredAt, topologySnapshot: { synthetic: true } } }));
      }
      const firstPage = await a.listPendingProvisionJobs({ limit: 2 });
      expect(firstPage.map(job => job.id)).toEqual(jobs.slice(0, 2).map(job => job.id));
      const next = await b.listPendingProvisionJobs({ limit: 1, after: firstPage[1] });
      expect(next.map(job => job.id)).toEqual([jobs[2].id]);
      expect(firstPage[0]).not.toHaveProperty('topologySnapshot');
      const selected = await a.listProvisioningInstancesByIds([instance.id, instance.id]);
      expect(selected).toHaveLength(1);
      expect(selected[0]).not.toHaveProperty('runtimeCredentials');
      expect((await b.listExpiredRangeInstances(new Date())).map(value => value.id)).toContain(instance.id);
      await a.updateRangeInstance(instance.id, { status: 'destroyed' });
      expect((await b.listExpiredRangeInstances(new Date())).map(value => value.id)).not.toContain(instance.id);
    } finally { await first.rangeInstance.delete({ where: { id: instance.id } }); }
  });
  it('atomically rejects a lost lease and a replaced lastJobId', async () => {
    const instance = await a.createRangeInstance({ name: 'native-db-test', instanceMode: 'single', status: 'pending_create' });
    const job = await a.createProvisionJob({ rangeInstanceId: instance.id, jobType: 'create', triggeredBy: 'synthetic' });
    await a.updateRangeInstance(instance.id, { lastJobId: job.id });
    const old = await a.claimProvisionJob(job.id, new Date());
    expect(await a.commitSingleInstanceClaim(old!, { status: 'creating' })).toBe(true);
    await b.requeueInterruptedProvisionJobs(new Date(Date.now() + 1000));
    const next = await b.claimProvisionJob(job.id, new Date(Date.now() + 2000));
    expect(await a.commitSingleInstanceClaim(old!, { status: 'create_failed' })).toBe(false);
    expect(await b.commitSingleInstanceClaim(next!, { status: 'creating' })).toBe(true);
    const destroy = await a.createProvisionJob({ rangeInstanceId: instance.id, jobType: 'destroy', triggeredBy: 'synthetic' });
    await a.updateRangeInstance(instance.id, { lastJobId: destroy.id, status: 'pending_destroy' });
    expect(await b.commitSingleInstanceClaim(next!, { status: 'running' })).toBe(false);
    await first.rangeInstance.delete({ where: { id: instance.id } });
  });
});
