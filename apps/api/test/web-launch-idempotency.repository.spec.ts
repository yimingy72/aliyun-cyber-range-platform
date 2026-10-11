import { randomUUID } from 'node:crypto';
import { PrismaAdminRepository } from '../src/database/prisma-admin.repository';
import { PrismaService } from '../src/database/prisma.service';
import { runInCloudWorkspace, runInSystemCloudWorkspaceScope } from '../src/auth/cloud-workspace-scope';
import { OperationControlService } from '../src/operations/operation-control.service';

const suite = process.env.DATABASE_URL ? describe : describe.skip;
suite('Web launch idempotency across API processes (PostgreSQL)', () => {
  let prisma: PrismaService;
  let repository: PrismaAdminRepository;
  let scope: { cloudWorkspaceId: string; provider: 'alibaba_cloud'; accountUid: string };
  beforeAll(async () => { prisma = new PrismaService(); await prisma.$connect(); repository = new PrismaAdminRepository(prisma); });
  afterAll(async () => { await prisma.$disconnect(); });
  beforeEach(async () => {
    scope = { cloudWorkspaceId: `launch-${randomUUID()}`, provider: 'alibaba_cloud', accountUid: 'fixture-account' };
    await runInSystemCloudWorkspaceScope(() => prisma.cloudWorkspace.create({ data: { id: scope.cloudWorkspaceId,
      provider: scope.provider, accountUid: scope.accountUid, displayName: 'isolated launch receipt test' } }));
  });
  afterEach(async () => runInSystemCloudWorkspaceScope(async () => {
    await prisma.operationAuditEvent.deleteMany({ where: { cloudWorkspaceId: scope.cloudWorkspaceId } });
    await prisma.idempotentOperation.deleteMany({ where: { cloudWorkspaceId: scope.cloudWorkspaceId } });
    await prisma.cloudWorkspace.delete({ where: { id: scope.cloudWorkspaceId } });
  }));

  it.each(['web_single_instance_batch_launch', 'web_range_instance_launch'])('creates one receipt and one intake for simultaneous %s requests', async toolName => runInCloudWorkspace(scope, async () => {
    let release!: () => void;
    let signal!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { signal = resolve; });
    const execute = jest.fn(async () => { signal(); await pending; return { id: 'allocated-once', status: 'pending_create' }; });
    const input = { context: { user: { id: 'fixture-user', username: 'fixture-user', role: 'user' as const }, source: 'web' as const, oauthClientId: 'platform-web' },
      metadata: { requestId: randomUUID(), idempotencyKey: 'stable-key', confirmationId: null }, toolName,
      arguments: { name: 'same launch', quantity: 50 }, targetType: 'instance', execute };
    const first = new OperationControlService(repository).executeIdempotent(input);
    await started;
    try {
      await expect(new OperationControlService(new PrismaAdminRepository(prisma)).executeIdempotent(input)).rejects.toMatchObject({ status: 409 });
    } finally { release(); }
    expect(await first).toEqual({ id: 'allocated-once', status: 'pending_create' });
    const replay = new OperationControlService(new PrismaAdminRepository(prisma));
    expect(await replay.executeIdempotent(input)).toEqual({ id: 'allocated-once', status: 'pending_create' });
    await expect(replay.executeIdempotent({ ...input, arguments: { name: 'other launch', quantity: 99 } })).rejects.toMatchObject({ status: 409 });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(await prisma.idempotentOperation.count()).toBe(1);
  }));
});
