import { randomUUID } from 'node:crypto';
import { PrismaAdminRepository } from '../src/database/prisma-admin.repository';
import { PrismaService } from '../src/database/prisma.service';
import { runInCloudWorkspace, runInSystemCloudWorkspaceScope } from '../src/auth/cloud-workspace-scope';

const url = process.env.WORKER_TRANSACTION_TEST_DATABASE_URL;
if (url && (new URL(url).hostname !== 'worker-transaction-test-postgres' || new URL(url).pathname !== '/worker_transaction_test'))
  throw new Error('Worker claim/readiness regression requires its isolated Docker database');
function gate() {
  let release!: () => void;
  return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
}
(url ? describe : describe.skip)('worker claim/readiness recovery across PostgreSQL connections', () => {
  let first: PrismaService, second: PrismaService, a: PrismaAdminRepository, b: PrismaAdminRepository;
  let scope: { cloudWorkspaceId: string; provider: 'alibaba_cloud'; accountUid: string };
  beforeAll(async () => {
    first = new PrismaService({ datasourceUrl: url }); second = new PrismaService({ datasourceUrl: url });
    await Promise.all([first.$connect(), second.$connect()]); a = new PrismaAdminRepository(first); b = new PrismaAdminRepository(second);
    scope = { cloudWorkspaceId: `worker-recovery-${randomUUID()}`, provider: 'alibaba_cloud', accountUid: randomUUID() };
    await runInSystemCloudWorkspaceScope(() => first.cloudWorkspace.create({ data: { id: scope.cloudWorkspaceId,
      provider: scope.provider, accountUid: scope.accountUid, displayName: 'isolated worker recovery' } }));
  });
  const cleanup = () => runInCloudWorkspace(scope, () => first.rangeInstance.deleteMany());
  beforeEach(cleanup);
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    try { await cleanup(); await runInSystemCloudWorkspaceScope(() => first.cloudWorkspace.delete({ where: { id: scope.cloudWorkspaceId } })); }
    finally { await Promise.all([first.$disconnect(), second.$disconnect()]); }
  });
  async function member(status: 'creating' | 'pending_create' = 'creating', terminal = true) {
    const instance = await a.createRangeInstance({ name: 'member', instanceMode: 'single', status,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      singleInstanceConfig: { executionBackend: 'opentofu', cloudAccountUid: scope.accountUid,
        cloudAccountContextId: 'context-source', regionId: 'cn-hangzhou', zoneId: 'cn-hangzhou-h', hostKey: 'host' } as any,
      resourceSummary: { mode: 'opentofu', hostIds: { host: 'i-recorded' } },
      accessEntry: { hostRole: 'host', publicIp: null, privateIp: '10.0.1.1', ssh: null } });
    const job = await a.createProvisionJob({ rangeInstanceId: instance.id, jobType: 'create', triggeredBy: 'fixture',
      status: terminal ? 'succeeded' : 'pending' });
    await a.updateRangeInstance(instance.id, { lastJobId: job.id });
    return { instance, job };
  }
  it('returns no claim after a real update/read gap lets another worker requeue and reclaim the job', async () => runInCloudWorkspace(scope, async () => {
    const f = await member('pending_create', false), started = gate(), paused = gate();
    const read = a.getProvisionJobById.bind(a);
    jest.spyOn(a, 'getProvisionJobById').mockImplementationOnce(async id => { started.release(); await paused.promise; return read(id); });
    const old = a.claimProvisionJob(f.job.id, new Date());
    await started.promise;
    let next;
    try {
      await b.requeueInterruptedProvisionJobs(new Date(Date.now() + 1_000));
      next = await b.claimProvisionJob(f.job.id, new Date(Date.now() + 2_000));
    } finally { paused.release(); }
    expect(await old).toBeNull();
    expect(next).not.toBeNull();
    expect(await b.commitSingleInstanceClaim(next!, { status: 'creating' })).toBe(true);
  }));
  it('repairs a terminal create/readiness gap exactly once across two workers', async () => runInCloudWorkspace(scope, async () => {
    const f = await member();
    await Promise.all([a.requeueInterruptedProvisionJobs(new Date(0)), b.requeueInterruptedProvisionJobs(new Date(0))]);
    const current = await a.getRangeInstanceById(f.instance.id);
    const refresh = await a.getProvisionJobById(current!.lastJobId!);
    expect(refresh).toMatchObject({ jobType: 'refresh_status', status: 'pending', cloudWorkspaceId: scope.cloudWorkspaceId });
    expect(refresh!.id).not.toBe(f.job.id);
    expect(await first.provisionJob.count()).toBe(2);
    await a.requeueInterruptedProvisionJobs(new Date(0));
    expect(await first.provisionJob.count()).toBe(2);
    expect(await a.getProvisionJobById(f.job.id)).toMatchObject({ status: 'succeeded' });
  }));
  it.each(['destroyed', 'expired', 'missing-host', 'missing-binding', 'active-job', 'failed-create'] as const)
    ('does not refresh %s material', async scenario => runInCloudWorkspace(scope, async () => {
      const f = await member();
      if (scenario === 'destroyed') await a.updateRangeInstance(f.instance.id, { status: 'destroyed' });
      if (scenario === 'expired') await first.rangeInstance.update({ where: { id: f.instance.id }, data: { expiresAt: new Date(0) } });
      if (scenario === 'missing-host') await a.updateRangeInstance(f.instance.id, { resourceSummary: { mode: 'opentofu', hostIds: {} } });
      if (scenario === 'missing-binding') await a.updateRangeInstance(f.instance.id, { singleInstanceConfig: { hostKey: 'host' } as any });
      if (scenario === 'active-job') await a.createProvisionJob({ rangeInstanceId: f.instance.id, jobType: 'destroy', triggeredBy: 'fixture' });
      if (scenario === 'failed-create') await a.updateProvisionJob(f.job.id, { status: 'failed' });
      const count = await first.provisionJob.count();
      await a.requeueInterruptedProvisionJobs(new Date(0));
      expect(await first.provisionJob.count()).toBe(count);
      expect((await a.getRangeInstanceById(f.instance.id))!.lastJobId).toBe(f.job.id);
    }));
  it('rechecks a candidate after expiry supersedes it rather than overwriting the destroy job', async () => runInCloudWorkspace(scope, async () => {
    const f = await member(), selected = gate(), paused = gate();
    const find = first.rangeInstance.findMany.bind(first.rangeInstance);
    jest.spyOn(first.rangeInstance as any, 'findMany').mockImplementationOnce(async (input: any) => {
      const candidates = await find(input); selected.release(); await paused.promise; return candidates;
    });
    const recovering = a.requeueInterruptedProvisionJobs(new Date(0));
    await selected.promise;
    let destroy;
    try {
      await second.rangeInstance.update({ where: { id: f.instance.id }, data: { expiresAt: new Date(0) } });
      destroy = await b.queueExpiredSingleInstanceDestroy({ rangeInstanceId: f.instance.id, now: new Date() });
    } finally { paused.release(); }
    await recovering;
    expect(destroy).not.toBeNull();
    expect(await a.getRangeInstanceById(f.instance.id)).toMatchObject({ status: 'pending_destroy', lastJobId: destroy!.id });
    expect(await first.provisionJob.count({ where: { jobType: 'refresh_status' } })).toBe(0);
  }));
  it('does not wait behind a cloud intake control lock and repairs on the next tick', async () => runInCloudWorkspace(scope, async () => {
    const f = await member();
    await b.withSingleInstanceControlLock(async () => {
      await a.requeueInterruptedProvisionJobs(new Date(0));
      expect((await a.getRangeInstanceById(f.instance.id))!.lastJobId).toBe(f.job.id);
    });
    await a.requeueInterruptedProvisionJobs(new Date(0));
    expect((await a.getRangeInstanceById(f.instance.id))!.lastJobId).not.toBe(f.job.id);
  }));
});
