import { randomUUID } from 'node:crypto';
import { PrismaAdminRepository } from '../src/database/prisma-admin.repository';
import { PrismaService } from '../src/database/prisma.service';
import { runInCloudWorkspace, runInSystemCloudWorkspaceScope } from '../src/auth/cloud-workspace-scope';

const url = process.env.WORKSPACE_TEST_DATABASE_URL;
if (url && (!['postgres', 'workspace-test-postgres'].includes(new URL(url).hostname)
  || new URL(url).pathname !== '/cyber_range_workspace_test')) throw new Error('Batch receipt regression requires isolated PostgreSQL');

(url ? describe : describe.skip)('range launch receipt projection in PostgreSQL', () => {
  let prisma: PrismaService, repository: PrismaAdminRepository;
  const first = { cloudWorkspaceId: `batch-${randomUUID()}`, provider: 'alibaba_cloud' as const, accountUid: 'fixture-a' };
  const other = { cloudWorkspaceId: `batch-${randomUUID()}`, provider: 'alibaba_cloud' as const, accountUid: 'fixture-b' };
  beforeAll(async () => {
    prisma = new PrismaService({ datasources: { db: { url } } }); await prisma.$connect();
    repository = new PrismaAdminRepository(prisma);
    for (const scope of [first, other]) await runInSystemCloudWorkspaceScope(() => prisma.cloudWorkspace.create({ data: {
      id: scope.cloudWorkspaceId, provider: scope.provider, accountUid: scope.accountUid, displayName: 'isolated batch receipt fixture' } }));
    for (const scope of [first, other]) await runInCloudWorkspace(scope, async () => {
      for (const [index, toolName, status] of [[1, 'web_range_instance_launch', 'succeeded'], [2, 'web_range_instance_launch', 'failed'],
        [3, 'web_single_instance_batch_launch', 'succeeded']] as const) {
        await prisma.idempotentOperation.create({ data: { actorUserId: 'fixture-user', toolName, status,
          idempotencyKey: `${scope.cloudWorkspaceId}-${index}`, argumentsHash: 'fixture', operationId: randomUUID(),
          result: { id: `range-${index}`, runtimeCredentials: { host: { password: 'fixture-secret' } } } } });
      }
    });
  });
  afterAll(async () => {
    try { await runInSystemCloudWorkspaceScope(async () => {
      const ids = [first.cloudWorkspaceId, other.cloudWorkspaceId];
      await prisma.idempotentOperation.deleteMany({ where: { cloudWorkspaceId: { in: ids } } });
      await prisma.cloudWorkspace.deleteMany({ where: { id: { in: ids } } });
    }); } finally { await prisma.$disconnect(); }
  });
  it('filters workspace, operation, status and requested IDs while returning no saved response', async () => runInCloudWorkspace(first, async () => {
    expect(await repository.listRangeLaunchReceipts(['range-1', 'range-2', 'range-3', 'range-1'])).toEqual([{
      cloudWorkspaceId: first.cloudWorkspaceId, actorUserId: 'fixture-user', rangeInstanceId: 'range-1', idempotencyKey: `${first.cloudWorkspaceId}-1`,
    }]);
    expect(await repository.listRangeLaunchReceipts(["range-1') OR TRUE --"])).toEqual([]);
    expect(await repository.listRangeLaunchReceipts(['not-found'])).toEqual([]);
  }));
  it('uses the caller workspace even for identical result IDs', async () => runInCloudWorkspace(other, async () => {
    const receipts = await repository.listRangeLaunchReceipts(['range-1']);
    expect(receipts).toHaveLength(1); expect(receipts[0].cloudWorkspaceId).toBe(other.cloudWorkspaceId);
  }));
  it('fails closed without a workspace and avoids a query for empty lists', async () => {
    await expect(repository.listRangeLaunchReceipts(['range-1'])).rejects.toThrow();
    expect(await repository.listRangeLaunchReceipts([])).toEqual([]);
  });
});
