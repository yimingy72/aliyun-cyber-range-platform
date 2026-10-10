import { Prisma } from '@aliyun-cyber-range/database/generated/client';
import { AdminUsersService } from '../src/admin/admin-users.service';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';
import { runInCloudWorkspace } from '../src/auth/cloud-workspace-scope';
const workspace = { cloudWorkspaceId: 'workspace-a', provider: 'alibaba_cloud' as const, accountUid: 'synthetic-account-a' };

const input = { username: 'alice', password: 'SyntheticTestPassword123!', role: 'user' as const };
const user = { cloudWorkspaceId: 'workspace-a', loginUsername: 'alice', isPlatformManager: false, id: 'alice-id', username: 'alice', passwordHash: 'synthetic-hash', role: 'admin' as const, status: 'active' as const, oidcSubject: 'subject-alice', oidcIssuer: 'https://issuer.invalid', createdAt: new Date(), updatedAt: new Date() };

function setup() {
  let persisted = { ...user };
  let rejectCommit = false;
  const tx = {
    $executeRaw: jest.fn(),
    platformUser: {
      findFirst: jest.fn(async () => persisted),
      count: jest.fn(async () => 2),
      update: jest.fn(async ({ data }) => { persisted = { ...persisted, ...data }; return persisted; }),
      create: jest.fn(),
    },
  };
  const prisma = { $transaction: jest.fn(async (operation) => {
    const before = { ...persisted };
    try {
      const result = await operation(tx);
      if (rejectCommit) { rejectCommit = false; throw new Prisma.PrismaClientKnownRequestError('Commit failed', { code: 'P2034', clientVersion: 'test' }); }
      return result;
    } catch (error) { persisted = before; throw error; }
  }) };
  const keycloak = { createUser: jest.fn(), deleteUser: jest.fn(), updateUserRole: jest.fn(), updateUserStatus: jest.fn(), resetUserPassword: jest.fn() };
  const repository = { getPlatformUserById: jest.fn(async () => persisted), updatePlatformUser: jest.fn(async ({}) => persisted) };
  return { tx, prisma, keycloak, repository, service: new AdminUsersService(repository as never, prisma as never, keycloak as never), rejectNextCommit: () => { rejectCommit = true; }, getUser: () => persisted };
}

describe('AdminUsersService Keycloak sync', () => {
  it('stores the oidc identity returned by Keycloak when creating a user', async () => runInCloudWorkspace(workspace, async () => {
    const repository = createMemoryAdminRepository();
    const tx = { $executeRaw: jest.fn(), platformUser: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn(({ data }) => repository.createPlatformUser(data)) } };
    const prisma = { $transaction: jest.fn((operation) => operation(tx)) };
    const keycloak = { createUser: jest.fn().mockResolvedValue('keycloak-alice-subject') };
    const service = new AdminUsersService(repository, prisma as never, keycloak as never);
    await service.createUser(input);
    await expect(repository.getPlatformUserByUsername('alice')).resolves.toEqual(expect.objectContaining({ username: 'alice', oidcSubject: 'keycloak-alice-subject' }));
    expect(keycloak.createUser).toHaveBeenCalledWith({ ...input, loginUsername: expect.stringMatching(/^alice\.[a-f0-9]{64}$/), status: 'active' });
  }));

  it('removes only the newly created identity when the database write fails, permitting a retry', async () => runInCloudWorkspace(workspace, async () => {
    const s = setup(); const occupied = new Set<string>();
    s.tx.platformUser.findFirst.mockResolvedValue(null as never);
    s.keycloak.createUser.mockImplementation(async () => { if (occupied.size) throw new Error('Username already exists'); occupied.add('new-subject'); return 'new-subject'; });
    s.keycloak.deleteUser.mockImplementation(async (subject) => { occupied.delete(subject); });
    s.tx.platformUser.create.mockRejectedValueOnce(new Error('DB write failed')).mockResolvedValueOnce({ ...user, role: 'user', oidcSubject: 'new-subject' });
    await expect(s.service.createUser(input)).rejects.toThrow('DB write failed');
    expect(occupied.size).toBe(0); expect(s.keycloak.deleteUser).toHaveBeenCalledWith('new-subject');
    await expect(s.service.createUser(input)).resolves.toMatchObject({ username: 'alice', role: 'user' });
  }));

  it('does not create or remove an identity for an existing platform username', async () => runInCloudWorkspace(workspace, async () => {
    const s = setup(); await expect(s.service.createUser(input)).rejects.toThrow('Username already exists');
    expect(s.keycloak.createUser).not.toHaveBeenCalled(); expect(s.keycloak.deleteUser).not.toHaveBeenCalled();
  }));

  it.each(['role', 'status'] as const)('restores identity %s after commit failure, without retrying the external mutation', async (field) => runInCloudWorkspace(workspace, async () => {
    const s = setup(); s.rejectNextCommit();
    const write = field === 'role' ? s.keycloak.updateUserRole : s.keycloak.updateUserStatus;
    const target = field === 'role' ? 'user' : 'disabled';
    await expect(field === 'role' ? s.service.updateUserRole(user.id, 'user') : s.service.updateUserStatus(user.id, 'disabled')).rejects.toThrow('Commit failed');
    expect(write.mock.calls.map(([value]) => value[field])).toEqual([target, user[field]]);
    expect(s.getUser()[field]).toBe(user[field]); expect(s.prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(s.prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }));
  }));

  it.each(['role', 'status'] as const)('rejects a last-admin %s change before writing to the identity provider', async (field) => runInCloudWorkspace(workspace, async () => {
    const s = setup(); s.tx.platformUser.count.mockResolvedValue(1);
    await expect(field === 'role' ? s.service.updateUserRole(user.id, 'user') : s.service.updateUserStatus(user.id, 'disabled')).rejects.toThrow(/last active admin/);
    expect(s.keycloak.updateUserRole).not.toHaveBeenCalled(); expect(s.keycloak.updateUserStatus).not.toHaveBeenCalled();
  }));

  it('resynchronizes the identity even when its requested status already matches the database', async () => runInCloudWorkspace(workspace, async () => {
    const s = setup(); await s.service.updateUserStatus(user.id, 'active');
    expect(s.tx.platformUser.update).not.toHaveBeenCalled(); expect(s.keycloak.updateUserStatus).toHaveBeenCalledWith({ subject: user.oidcSubject, status: 'active' });
  }));

  it('reports an explicit recovery failure when a provider is still unavailable', async () => runInCloudWorkspace(workspace, async () => {
    const s = setup(); s.keycloak.updateUserStatus.mockRejectedValue(new Error('Provider unavailable'));
    await expect(s.service.updateUserStatus(user.id, 'disabled')).rejects.toThrow('User identity recovery failed');
    expect(s.getUser().status).toBe('active');
  }));

  it('reports the completed OIDC password reset when local hash metadata cannot be written', async () => runInCloudWorkspace(workspace, async () => {
    const s = setup(); s.repository.updatePlatformUser.mockRejectedValue(new Error('DB unavailable'));
    await expect(s.service.resetUserPassword(user.id, input.password)).resolves.toMatchObject({ id: user.id });
    expect(s.keycloak.resetUserPassword).toHaveBeenCalledWith({ subject: user.oidcSubject, password: input.password });
  }));
});
