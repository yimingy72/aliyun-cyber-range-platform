import { PrismaService } from '../src/database/prisma.service';
import { PrismaAdminRepository } from '../src/database/prisma-admin.repository';
import { runInCloudWorkspace, runInSystemCloudWorkspaceScope } from '../src/auth/cloud-workspace-scope';
import type { ProvisionJobTopologySnapshot } from '../src/admin/admin.repository';
const url = process.env.EXPIRY_TEST_DATABASE_URL;
if (url && (new URL(url).hostname !== 'expiry-postgres' || new URL(url).pathname !== '/expiry_test'))
  throw new Error('Expiry regression requires the isolated Docker PostgreSQL fixture');
const scope = { cloudWorkspaceId: 'expiry-repository-space', provider: 'alibaba_cloud' as const, accountUid: 'fixture-account' };
(url ? describe : describe.skip)('expiry transactions and recovery fences', () => {
  const prisma = new PrismaService({ datasourceUrl: url }), repo = new PrismaAdminRepository(prisma);
  const second = new PrismaService({ datasourceUrl: url }), other = new PrismaAdminRepository(second);
  beforeAll(async () => runInSystemCloudWorkspaceScope(async () => {
    await prisma.cloudWorkspace.create({ data: { id: scope.cloudWorkspaceId, provider: scope.provider, accountUid: scope.accountUid, displayName: 'Expiry fixture' } });
  }));
  afterAll(async () => { await prisma.$disconnect(); await second.$disconnect(); });
  const inSpace = <T>(work: () => Promise<T>) => runInCloudWorkspace(scope, work);
  async function fixture(mode: 'single' | 'range' = 'single') {
    const row = await repo.createRangeInstance({ name: 'expiry-test', status: 'running', instanceMode: mode,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(), resourceSummary: { mode: 'ecs-native' } });
    const snapshot = { expiryPlan: { instanceId: row.id, effectiveExpiresAt: row.expiresAt!.toISOString() } } as ProvisionJobTopologySnapshot;
    return { row, input: { rangeInstanceId: row.id, jobType: 'change_expiry' as const, triggeredBy: 'fixture', topologySnapshot: snapshot } };
  }
  it.each(['single', 'range'] as const)('queues one %s job under concurrent submissions, and commits only the owned claim', async mode => inSpace(async () => {
    const f = await fixture(mode), results = await Promise.allSettled([repo, other].map(r => r.queueInstanceExpiryJob(f.row.id, f.row.updatedAt, f.input, f.row.expiresAt!)));
    const accepted = results.flatMap(result => result.status === 'fulfilled' && result.value ? [result.value] : []);
    expect(accepted).toHaveLength(1);
    const job = mode === 'range' ? await repo.claimRangeProvisionJob(accepted[0].id, new Date()) : await repo.claimProvisionJob(accepted[0].id, new Date());
    const at = new Date(Date.now() + 7200_000);
    expect(await repo.updateInstancePowerForClaim(job!.id, new Date(0), { expiresAt: at }, { status: 'succeeded' })).toBe(false);
    expect(await repo.updateInstancePowerForClaim(job!.id, job!.startedAt!, { expiresAt: at }, { status: 'succeeded', finishedAt: new Date() })).toBe(true);
    expect((await repo.getRangeInstanceById(f.row.id))?.expiresAt).toEqual(at);
  }));
  it('rolls back all batch members when one CAS is stale', async () => inSpace(async () => {
    const one = await fixture(), two = await fixture(), at = new Date(Date.now() + 40 * 60_000);
    await expect(repo.withSingleInstanceTransaction(async tx => {
      await tx.queueInstanceExpiryJob(one.row.id, one.row.updatedAt, one.input, at);
      if (!await tx.queueInstanceExpiryJob(two.row.id, new Date(0), two.input, at)) throw new Error('stale batch');
    })).rejects.toThrow('stale batch');
    expect((await repo.getRangeInstanceById(one.row.id))?.expiresAt).toEqual(one.row.expiresAt);
    expect((await repo.listProvisionJobs()).filter(job => job.rangeInstanceId === one.row.id)).toHaveLength(0);
  }));
  it('rejects a stale automatic range-destroy scan after an expiry change', async () => inSpace(async () => {
    const f = await fixture('range');
    await repo.updateRangeInstance(f.row.id, { expiresAt: new Date(Date.now() + 7200_000) });
    expect(await repo.queueRangeInstanceJob({ rangeInstanceId: f.row.id, jobType: 'destroy', triggeredBy: 'system:auto-expire',
      expectedStatus: 'running', expectedOwnerUserId: f.row.ownerUserId, expectedUpdatedAt: f.row.updatedAt, nextStatus: 'pending_destroy' })).toBeNull();
  }));
  it('never queues an expiry after a destroy won the race', async () => inSpace(async () => {
    const f = await fixture('range');
    await repo.queueRangeInstanceJob({ rangeInstanceId: f.row.id, jobType: 'destroy', triggeredBy: 'fixture',
      expectedStatus: 'running', expectedOwnerUserId: f.row.ownerUserId, nextStatus: 'pending_destroy' });
    expect(await repo.queueInstanceExpiryJob(f.row.id, f.row.updatedAt, f.input, f.row.expiresAt!)).toBeNull();
  }));
  it('fences recovery against concurrent status changes and keeps it observe-only', async () => inSpace(async () => {
    const f = await fixture(), accepted = await repo.queueInstanceExpiryJob(f.row.id, f.row.updatedAt, f.input, f.row.expiresAt!);
    const job = await repo.claimProvisionJob(accepted!.id, new Date());
    await repo.updateInstancePowerForClaim(job!.id, job!.startedAt!, {}, { status: 'failed', finishedAt: new Date() });
    const row = (await repo.getRangeInstanceById(f.row.id))!, failed = (await repo.getProvisionJobById(job!.id))!;
    const results = await Promise.all([repo, other].map(r => r.requeueInstanceExpiryJob(job!.id, row.updatedAt, failed.updatedAt)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await repo.getProvisionJobById(job!.id)).toMatchObject({ status: 'pending', topologySnapshot: { expiryObserveOnly: true } });
  }));
  it('rejects foreign and read-only workspace mutation', async () => inSpace(async () => {
    const f = await fixture();
    expect(await runInCloudWorkspace({ ...scope, cloudWorkspaceId: 'foreign' }, () => repo.queueInstanceExpiryJob(f.row.id, f.row.updatedAt, f.input, f.row.expiresAt!))).toBeNull();
    await expect(runInCloudWorkspace({ ...scope, isReadOnly: true }, () => repo.queueInstanceExpiryJob(f.row.id, f.row.updatedAt, f.input, f.row.expiresAt!))).rejects.toThrow();
  }));
});
