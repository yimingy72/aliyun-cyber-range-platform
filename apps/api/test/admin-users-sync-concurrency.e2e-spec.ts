import { PrismaService } from '../src/database/prisma.service';
import { PrismaAdminRepository } from '../src/database/prisma-admin.repository';
import { AdminUsersService } from '../src/admin/admin-users.service';
import { runInCloudWorkspace, runInSystemCloudWorkspaceScope } from '../src/auth/cloud-workspace-scope';
const workspace = { cloudWorkspaceId: 'users-sync-test-workspace', provider: 'alibaba_cloud' as const, accountUid: 'synthetic-account' };

// Explicit opt-in prevents this destructive fixture from ever using the application's configured DB.
const databaseUrl = process.env.USER_AUTH_TEST_DATABASE_URL;
const isolatedDatabase = databaseUrl ? describe : describe.skip;
isolatedDatabase('User synchronization against isolated PostgreSQL', () => {
  let prisma: PrismaService;
  let repository: PrismaAdminRepository;
  beforeAll(async () => runInSystemCloudWorkspaceScope(async () => { prisma = new PrismaService({ datasources: { db: { url: databaseUrl! } } }); repository = new PrismaAdminRepository(prisma); await prisma.cloudWorkspace.upsert({ where: { id: workspace.cloudWorkspaceId }, create: { id: workspace.cloudWorkspaceId, provider: workspace.provider, accountUid: workspace.accountUid, displayName: 'Users sync test' }, update: {} }); }));
  beforeEach(async () => runInSystemCloudWorkspaceScope(async () => { await prisma.platformUser.deleteMany(); }));
  afterAll(async () => runInSystemCloudWorkspaceScope(async () => { await prisma.platformUser.deleteMany(); await prisma.$disconnect(); }));
  async function seed() {
    await prisma.platformUser.createMany({ data: ['first-admin', 'second-admin'].map((id) => ({ id, username: id, loginUsername: id, cloudWorkspaceId: workspace.cloudWorkspaceId, passwordHash: 'synthetic-hash', oidcIssuer: 'https://issuer.invalid', oidcSubject: `subject-${id}`, role: 'admin', status: 'active' })) });
  }
  it.each(['status', 'role'] as const)('serializes concurrent %s changes before touching the last administrator identity', async (field) => runInCloudWorkspace(workspace, async () => {
    await seed(); const identity = new Map([['subject-first-admin', { role: 'admin', status: 'active' }], ['subject-second-admin', { role: 'admin', status: 'active' }]]);
    const update = jest.fn(async (input) => { await new Promise((resolve) => setTimeout(resolve, 30)); identity.get(input.subject)![field] = input[field]; });
    const keycloak = field === 'status' ? { updateUserStatus: update } : { updateUserRole: update };
    const service = new AdminUsersService(repository, prisma, keycloak as never);
    const results = await Promise.allSettled(['first-admin', 'second-admin'].map((id) => field === 'status' ? service.updateUserStatus(id, 'disabled') : service.updateUserRole(id, 'user')));
    expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect((results.find((item) => item.status === 'rejected') as PromiseRejectedResult).reason.message).toMatch(/last active admin/);
    expect(update).toHaveBeenCalledTimes(1);
    expect(await prisma.platformUser.count({ where: { role: 'admin', status: 'active' } })).toBe(1);
    expect([...identity.values()].filter((item) => item.role === 'admin' && item.status === 'active')).toHaveLength(1);
  }));
  it('restores the identity after PostgreSQL aborts the transaction following its external write', async () => runInCloudWorkspace(workspace, async () => {
    await seed(); const identity = new Map([['subject-first-admin', 'active'], ['subject-second-admin', 'active']]);
    const keycloak = { updateUserStatus: jest.fn(async ({ subject, status }) => { identity.set(subject, status); }) };
    let fail = true;
    const faultPrisma = { $transaction: (operation: (tx: any) => Promise<unknown>, options: any) => prisma.$transaction(async (tx) => {
      const result = await operation(tx);
      if (fail) { fail = false; await tx.$executeRaw`SELECT 1 / 0`; }
      return result;
    }, options) };
    const service = new AdminUsersService(repository, faultPrisma as never, keycloak as never);
    await expect(service.updateUserStatus('first-admin', 'disabled')).rejects.toThrow();
    expect(await prisma.platformUser.findUnique({ where: { id: 'first-admin' } })).toMatchObject({ status: 'active' });
    expect(identity.get('subject-first-admin')).toBe('active');
    expect(keycloak.updateUserStatus.mock.calls.map(([value]) => value.status)).toEqual(['disabled', 'active']);
  }));
  it('cleans up a new identity when an actual DB constraint rejects creation and permits retry', async () => runInCloudWorkspace(workspace, async () => {
    const occupied = new Set<string>(); const keycloak = {
      createUser: jest.fn(async () => { if (occupied.size) throw new Error('Username already exists'); occupied.add('new-subject'); return 'new-subject'; }),
      deleteUser: jest.fn(async (subject) => { occupied.delete(subject); }),
    };
    const service = new AdminUsersService(repository, prisma, keycloak as never);
    await prisma.$executeRaw`ALTER TABLE "PlatformUser" ADD CONSTRAINT audited_creation_failure CHECK (username <> 'new-user')`;
    try { await expect(service.createUser({ username: 'new-user', password: 'SyntheticPassword123!', role: 'user' })).rejects.toThrow(); expect(occupied.size).toBe(0); }
    finally { await prisma.$executeRaw`ALTER TABLE "PlatformUser" DROP CONSTRAINT audited_creation_failure`; }
    await expect(service.createUser({ username: 'new-user', password: 'SyntheticPassword123!', role: 'user' })).resolves.toMatchObject({ username: 'new-user', status: 'active' });
  }));
});
