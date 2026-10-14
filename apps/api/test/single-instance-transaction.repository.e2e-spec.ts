import { randomUUID } from 'node:crypto';
import { PrismaAdminRepository } from '../src/database/prisma-admin.repository';
import { PrismaService } from '../src/database/prisma.service';
import type { AdminRepository } from '../src/admin/admin.repository';
import { runInCloudWorkspace, runInSystemCloudWorkspaceScope } from '../src/auth/cloud-workspace-scope';

const url = process.env.WORKER_TRANSACTION_TEST_DATABASE_URL;
if (url && (new URL(url).hostname !== 'worker-transaction-test-postgres'
  || new URL(url).pathname !== '/worker_transaction_test')) throw new Error('Transaction regression requires its isolated Docker database');

(url ? describe : describe.skip)('single-instance short transaction with real PostgreSQL', () => {
  let first: PrismaService, second: PrismaService;
  let repository: PrismaAdminRepository;
  let scope: { cloudWorkspaceId: string; provider: 'alibaba_cloud'; accountUid: string };
  beforeAll(async () => {
    first = new PrismaService({ datasourceUrl: url }); second = new PrismaService({ datasourceUrl: url });
    await Promise.all([first.$connect(), second.$connect()]);
    repository = new PrismaAdminRepository(first);
    scope = { cloudWorkspaceId: `transaction-${randomUUID()}`, provider: 'alibaba_cloud', accountUid: randomUUID() };
    await runInSystemCloudWorkspaceScope(() => first.cloudWorkspace.create({ data: { id: scope.cloudWorkspaceId,
      provider: scope.provider, accountUid: scope.accountUid, displayName: 'isolated transaction regression' } }));
  });
  const cleanup = () => runInCloudWorkspace(scope, async () => {
    await first.rangeInstance.deleteMany(); await first.singleInstanceBatch.deleteMany();
  });
  beforeEach(cleanup);
  afterAll(async () => {
    try { await cleanup(); await runInSystemCloudWorkspaceScope(() => first.cloudWorkspace.delete({ where: { id: scope.cloudWorkspaceId } })); }
    finally { await Promise.all([first.$disconnect(), second.$disconnect()]); }
  });
  const transaction = <T>(work: (txRepository: AdminRepository) => Promise<T>): Promise<T> =>
    (repository as any).withSingleInstanceTransaction(work);
  async function insertBatch(repo: AdminRepository, afterFirst?: () => Promise<void>) {
    const batch = await repo.createSingleInstanceBatch({ name: 'atomic batch', platformImageAssetId: 'fixture-image',
      imageId: 'm-fixture', imageDisplayName: 'fixture', cpu: 2, memory: 4, systemDiskSize: 40, quantity: 2 });
    const instances = [];
    for (let index = 0; index < 2; index++) {
      const instance = await repo.createRangeInstance({ name: `member-${index}`, instanceMode: 'single',
        singleInstanceBatchId: batch.id, status: 'pending_create' });
      const job = await repo.createProvisionJob({ rangeInstanceId: instance.id, jobType: 'create', triggeredBy: 'fixture' });
      instances.push(await repo.updateRangeInstance(instance.id, { lastJobId: job.id }));
      if (index === 0) await afterFirst?.();
    }
    return { batch, instances };
  }
  it('commits all members/jobs/lastJobId together while preserving workspace and the outer control lock', async () => runInCloudWorkspace(scope, async () => {
    let release!: () => void, entered!: () => void;
    const pause = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const writing = repository.withSingleInstanceControlLock(() => transaction(repo => insertBatch(repo, async () => { entered(); await pause; })));
    await started;
    try {
      expect(await second.singleInstanceBatch.count()).toBe(0);
      expect(await second.rangeInstance.count()).toBe(0);
      expect(await second.provisionJob.count()).toBe(0);
    } finally { release(); }
    const result = await writing;
    expect(result.batch.cloudWorkspaceId).toBe(scope.cloudWorkspaceId);
    expect(result.instances).toHaveLength(2);
    for (const instance of result.instances) {
      const job = await second.provisionJob.findUniqueOrThrow({ where: { id: instance.lastJobId! } });
      expect(job).toMatchObject({ rangeInstanceId: instance.id, cloudWorkspaceId: scope.cloudWorkspaceId, status: 'pending' });
    }
    expect(await second.singleInstanceBatch.count()).toBe(1);
    expect(await second.rangeInstance.count()).toBe(2);
    expect(await second.provisionJob.count()).toBe(2);
  }));
  it('rolls back the whole batch when a later member write fails', async () => runInCloudWorkspace(scope, async () => {
    await expect(transaction(repo => insertBatch(repo, async () => { throw new Error('injected later intake failure'); })))
      .rejects.toThrow('injected later intake failure');
    expect(await second.singleInstanceBatch.count()).toBe(0);
    expect(await second.rangeInstance.count()).toBe(0);
    expect(await second.provisionJob.count()).toBe(0);
  }));
  it('rolls back intake when its database connection is terminated like an API exit', async () => runInCloudWorkspace(scope, async () => {
    await expect(transaction(async repo => {
      await insertBatch(repo);
      const [{ pid }] = await (repo as any).prisma.$queryRaw`SELECT pg_backend_pid() AS pid`;
      const [{ terminated }] = await second.$queryRaw<Array<{ terminated: boolean }>>`SELECT pg_terminate_backend(${pid}::int) AS terminated`;
      expect(terminated).toBe(true);
    })).rejects.toThrow();
    expect(await second.singleInstanceBatch.count()).toBe(0);
    expect(await second.rangeInstance.count()).toBe(0);
    expect(await second.provisionJob.count()).toBe(0);
  }));
  it('keeps scoped identity checks inside the transaction and rolls back a foreign provider write', async () => runInCloudWorkspace(scope, async () => {
    await expect(transaction(async repo => {
      await insertBatch(repo);
      await repo.createRangeInstance({ name: 'foreign', cloudProvider: 'tencent_cloud' });
    })).rejects.toThrow();
    expect(await second.singleInstanceBatch.count()).toBe(0);
    expect(await second.rangeInstance.count()).toBe(0);
    expect(await second.provisionJob.count()).toBe(0);
  }));
});
