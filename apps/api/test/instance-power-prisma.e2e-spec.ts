import { PrismaService } from '../src/database/prisma.service';
import { PrismaAdminRepository } from '../src/database/prisma-admin.repository';
import { runInCloudWorkspace, runInSystemCloudWorkspaceScope } from '../src/auth/cloud-workspace-scope';
const url = process.env.POWER_TEST_DATABASE_URL;
if (url && (new URL(url).hostname !== 'eco-stop-db' || new URL(url).pathname !== '/power_test'))
  throw new Error('Power regression requires its isolated Docker database');
const databaseDescribe = url ? describe : describe.skip;
const scope = { cloudWorkspaceId: 'power-repository-test', provider: 'alibaba_cloud' as const, accountUid: '100001' };
databaseDescribe('power migration, CAS and worker claims', () => {
  const prisma = new PrismaService({ datasources: { db: { url } } }), repository = new PrismaAdminRepository(prisma);
  beforeAll(async () => runInSystemCloudWorkspaceScope(async () => {
    await prisma.cloudWorkspace.create({ data: { id: scope.cloudWorkspaceId, provider: scope.provider, accountUid: scope.accountUid, displayName: 'Ephemeral power test' } });
  }));
  afterAll(async () => {
    await runInSystemCloudWorkspaceScope(async () => {
      await prisma.rangeInstance.updateMany({ where: { cloudWorkspaceId: scope.cloudWorkspaceId }, data: { lastJobId: null } });
      await prisma.provisionJobStepLog.deleteMany({ where: { cloudWorkspaceId: scope.cloudWorkspaceId } });
      await prisma.provisionJob.deleteMany({ where: { cloudWorkspaceId: scope.cloudWorkspaceId } });
      await prisma.rangeInstance.deleteMany({ where: { cloudWorkspaceId: scope.cloudWorkspaceId } });
      await prisma.cloudWorkspace.delete({ where: { id: scope.cloudWorkspaceId } });
    }); await prisma.$disconnect();
  });
  it.each(['single', 'range'] as const)('atomically queues and completes only the owned %s power claim', async instanceMode => runInCloudWorkspace(scope, async () => {
    const row = await repository.createRangeInstance({ name: 'power-CAS', status: 'running', instanceMode });
    const queued = await Promise.allSettled(Array.from({ length: 4 }, () => repository.saveInstancePowerControl(row.id, row.updatedAt,
      { version: 1, state: 'running', phase: 'stopping' }, { rangeInstanceId: row.id, jobType: 'economical_stop', triggeredBy: 'fixture' })));
    const success = queued.flatMap(result => result.status === 'fulfilled' && result.value ? [result.value] : []); expect(success).toHaveLength(1);
    const job = instanceMode === 'range' ? await repository.claimRangeProvisionJob(success[0].job!.id, new Date()) : await repository.claimProvisionJob(success[0].job!.id, new Date());
    expect(job).toBeTruthy();
    expect(await repository.updateInstancePowerForClaim(job!.id, new Date(0), { powerControl: { version: 1, state: 'unknown' } }, { status: 'failed' })).toBe(false);
    expect(await repository.updateInstancePowerForClaim(job!.id, job!.startedAt!, { powerControl: { version: 1, state: 'economical_stopped' } }, { status: 'succeeded', finishedAt: new Date() })).toBe(true);
    expect(await repository.getRangeInstanceById(row.id)).toMatchObject({ status: 'running', powerControl: { state: 'economical_stopped' } });
    expect(await runInCloudWorkspace({ ...scope, cloudWorkspaceId: 'foreign' }, () => repository.getRangeInstanceById(row.id))).toBeNull();
  }));
  it('rolls back batch enqueue if any member CAS fails', async () => runInCloudWorkspace(scope, async () => {
    const one = await repository.createRangeInstance({ name: 'one', status: 'running', instanceMode: 'single' });
    const two = await repository.createRangeInstance({ name: 'two', status: 'running', instanceMode: 'single' });
    await expect(repository.withSingleInstanceTransaction(async tx => {
      await tx.saveInstancePowerControl(one.id, one.updatedAt, { version: 1, state: 'running', phase: 'stopping' }, { rangeInstanceId: one.id, jobType: 'economical_stop', triggeredBy: 'fixture' });
      if (!await tx.saveInstancePowerControl(two.id, new Date(0), { version: 1, state: 'running' })) throw new Error('stale');
    })).rejects.toThrow('stale');
    expect((await repository.listProvisionJobs()).filter(job => job.rangeInstanceId === one.id)).toHaveLength(0);
    expect((await repository.getRangeInstanceById(one.id))?.powerControl).toBeNull();
  }));
  it('finds persisted due schedules without dispatching future or cancelled appointments', async () => runInCloudWorkspace(scope, async () => {
    const row = await repository.createRangeInstance({ name: 'schedule-query', status: 'running', instanceMode: 'single' });
    const at = new Date(Date.now() + 60_000).toISOString();
    const control = { version: 1 as const, state: 'running' as const, schedule: { id: 'schedule', revision: 1, at, triggeredBy: 'fixture',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: 'scheduled' as const, plan: {} as any } };
    const saved = await repository.saveInstancePowerControl(row.id, row.updatedAt, control);
    expect((await repository.listDuePowerSchedules(new Date())).some(item => item.id === row.id)).toBe(false);
    expect((await repository.listDuePowerSchedules(new Date(at))).some(item => item.id === row.id)).toBe(true);
    await repository.saveInstancePowerControl(row.id, saved!.instance.updatedAt, { ...control, schedule: { ...control.schedule, status: 'cancelled', revision: 2 } });
    expect((await repository.listDuePowerSchedules(new Date(at))).some(item => item.id === row.id)).toBe(false);
  }));
});
