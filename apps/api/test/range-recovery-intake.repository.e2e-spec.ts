import { randomUUID } from 'node:crypto';
import { PrismaAdminRepository } from '../src/database/prisma-admin.repository';
import { PrismaService } from '../src/database/prisma.service';
import { runInCloudWorkspace, runInSystemCloudWorkspaceScope } from '../src/auth/cloud-workspace-scope';
import type { CreateIdempotentOperationInput, QueueRangeInstanceJobInput } from '../src/admin/admin.repository';

const url = process.env.WORKSPACE_TEST_DATABASE_URL;
if (url && (!['postgres', 'workspace-test-postgres'].includes(new URL(url).hostname)
  || !['/cyber_range_workspace_test', '/workspace_audit'].includes(new URL(url).pathname))) throw new Error('Recovery intake regression requires isolated PostgreSQL');

(url ? describe : describe.skip)('range recovery intake atomicity in PostgreSQL', () => {
  let first: PrismaService, second: PrismaService, repository: PrismaAdminRepository, peer: PrismaAdminRepository;
  const workspaceId = `recovery-${randomUUID()}`;
  const scope = { cloudWorkspaceId: workspaceId, provider: 'alibaba_cloud' as const, accountUid: randomUUID() };
  let rangeId: string;
  beforeAll(async () => {
    first = new PrismaService({ datasources: { db: { url } } });
    second = new PrismaService({ datasources: { db: { url } } });
    await Promise.all([first.$connect(), second.$connect()]);
    repository = new PrismaAdminRepository(first); peer = new PrismaAdminRepository(second);
    await runInSystemCloudWorkspaceScope(() => first.cloudWorkspace.create({ data: { id: workspaceId,
      provider: scope.provider, accountUid: scope.accountUid, displayName: 'recovery transaction fixture' } }));
  });
  const cleanup = () => runInCloudWorkspace(scope, async () => {
    await first.operationAuditEvent.deleteMany(); await first.idempotentOperation.deleteMany();
    await first.rangeInstance.updateMany({ data: { lastJobId: null } });
    await first.provisionJobStepLog.deleteMany(); await first.provisionJob.deleteMany(); await first.rangeInstance.deleteMany();
  });
  beforeEach(async () => {
    await cleanup();
    rangeId = (await runInCloudWorkspace(scope, () => repository.createRangeInstance({ name: 'recovery fixture',
      instanceMode: 'range', status: 'create_failed' }))).id;
  });
  afterAll(async () => {
    try { await cleanup(); await runInSystemCloudWorkspaceScope(() => first.cloudWorkspace.deleteMany({ where: { id: workspaceId } })); }
    finally { await Promise.all([first.$disconnect(), second.$disconnect()]); }
  });
  function operation(key = 'recovery-key'): CreateIdempotentOperationInput {
    return { cloudWorkspaceId: workspaceId, actorUserId: 'recovery-actor', toolName: 'web_range_instance_retry',
      idempotencyKey: key, argumentsHash: 'same-range-and-action-hash', operationId: randomUUID() };
  }
  function input(op: CreateIdempotentOperationInput): QueueRangeInstanceJobInput {
    return { rangeInstanceId: rangeId, jobType: 'retry', triggeredBy: op.actorUserId, expectedStatus: 'create_failed',
      expectedOwnerUserId: null, nextStatus: 'pending_create', intakeOperation: op };
  }
  it('admits only one job for concurrent same-key requests and retains the receipt after job failure', async () => runInCloudWorkspace(scope, async () => {
    const original = operation();
    const [a, b] = await Promise.all([repository.queueRangeInstanceJob(input(original)), peer.queueRangeInstanceJob(input({ ...original, operationId: randomUUID() }))]);
    expect(a!.id).toBe(b!.id);
    expect(await first.provisionJob.count()).toBe(1);
    expect(await first.idempotentOperation.findFirst()).toMatchObject({ status: 'succeeded', result: { id: a!.id } });
    await first.provisionJob.update({ where: { id: a!.id }, data: { status: 'failed' } });
    await first.rangeInstance.update({ where: { id: rangeId }, data: { status: 'create_failed' } });
    expect((await peer.queueRangeInstanceJob(input(original)))!.id).toBe(a!.id);
    expect(await first.provisionJob.count()).toBe(1);
  }));
  it('preserves an accepted result when a same-key late handler reports rejection', async () => runInCloudWorkspace(scope, async () => {
    const op = operation();
    const job = await repository.queueRangeInstanceJob(input(op));
    expect(await peer.rejectRangeInstanceIntake({ ...op, operationId: randomUUID() }, 'HTTP_400')).toMatchObject({ status: 'succeeded', result: { id: job!.id } });
  }));
  it('makes a definitive rejection a barrier to the delayed original handler', async () => runInCloudWorkspace(scope, async () => {
    const op = operation();
    await peer.rejectRangeInstanceIntake({ ...op, operationId: randomUUID() }, 'HTTP_400');
    expect(await repository.queueRangeInstanceJob(input(op))).toBeNull();
    expect(await first.provisionJob.count()).toBe(0);
    expect((await first.rangeInstance.findUniqueOrThrow({ where: { id: rangeId } })).status).toBe('create_failed');
  }));
  it('rolls back the job and lastJobId if the receipt cannot be inserted', async () => runInCloudWorkspace(scope, async () => {
    await first.$executeRawUnsafe('ALTER TABLE "IdempotentOperation" ADD CONSTRAINT "recovery_test_abort" CHECK ("idempotencyKey" <> \'abort-proof\')');
    try {
      await expect(repository.queueRangeInstanceJob(input(operation('abort-proof')))).rejects.toThrow();
      expect(await first.provisionJob.count()).toBe(0);
      expect(await first.idempotentOperation.count()).toBe(0);
      expect(await first.rangeInstance.findUniqueOrThrow({ where: { id: rangeId } })).toMatchObject({ status: 'create_failed', lastJobId: null });
    } finally { await first.$executeRawUnsafe('ALTER TABLE "IdempotentOperation" DROP CONSTRAINT "recovery_test_abort"'); }
  }));
  it('rejects key reuse with another request hash without changing its accepted result', async () => runInCloudWorkspace(scope, async () => {
    const op = operation();
    const job = await repository.queueRangeInstanceJob(input(op));
    await expect(peer.queueRangeInstanceJob(input({ ...op, argumentsHash: 'different-range-or-action', operationId: randomUUID() }))).rejects.toThrow('另一恢复请求');
    expect(await first.provisionJob.count()).toBe(1);
    expect((await first.idempotentOperation.findFirst())!.result).toEqual({ id: job!.id });
  }));
});
