import { PrismaService } from '../src/database/prisma.service';
import { PrismaAdminRepository } from '../src/database/prisma-admin.repository';
const enabled = Boolean(process.env.NATIVE_BATCH_TEST_DATABASE_URL);
(enabled ? describe : describe.skip)('native repository with two real PostgreSQL connections', () => {
  const first = new PrismaService({ datasourceUrl: process.env.NATIVE_BATCH_TEST_DATABASE_URL });
  const second = new PrismaService({ datasourceUrl: process.env.NATIVE_BATCH_TEST_DATABASE_URL });
  const a = new PrismaAdminRepository(first);
  const b = new PrismaAdminRepository(second);
  afterAll(async () => { await first.$disconnect(); await second.$disconnect(); });
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
