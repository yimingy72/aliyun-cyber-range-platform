import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { AdminUsersService } from '../src/admin/admin-users.service';
import { runInCloudWorkspace } from '../src/auth/cloud-workspace-scope';

const first = { cloudWorkspaceId: 'workspace-a', provider: 'alibaba_cloud' as const, accountUid: 'account-a' };
const second = { cloudWorkspaceId: 'workspace-b', provider: 'tencent_cloud' as const, accountUid: 'account-b' };
const input = { username: 'alice', password: 'SyntheticPassword123!', role: 'user' as const };

function setup() {
  const rows: any[] = [];
  const matches = (row: any, where: Record<string, unknown>) => Object.entries(where).every(([key, value]) => row[key] === value);
  const tx = { $executeRaw: jest.fn(), platformUser: {
    findFirst: jest.fn(async ({ where }) => rows.find((row) => matches(row, where)) ?? null),
    count: jest.fn(async ({ where }) => rows.filter((row) => matches(row, where)).length),
    create: jest.fn(async ({ data }) => { const row = { ...data, createdAt: new Date(), updatedAt: new Date() }; rows.push(row); return row; }),
    update: jest.fn(async ({ where, data }) => { const row = rows.find((entry) => matches(entry, where)); if (!row) throw new Error('No matching user'); Object.assign(row, data); return row; }),
  } };
  const prisma = { $transaction: jest.fn(async (work) => work(tx)) };
  const identities = new Map<string, { subject: string; password: string; status: string; role: string }>();
  const bySubject = (subject: string) => [...identities.values()].find((entry) => entry.subject === subject)!;
  const keycloak = {
    createUser: jest.fn(async (user) => { if (identities.has(user.loginUsername)) throw new Error('Username already exists'); const subject = `subject-${identities.size}`; identities.set(user.loginUsername, { subject, password: user.password, status: user.status, role: user.role }); return subject; }),
    deleteUser: jest.fn(),
    updateUserRole: jest.fn(async ({ subject, role }) => { bySubject(subject).role = role; }),
    updateUserStatus: jest.fn(async ({ subject, status }) => { bySubject(subject).status = status; }),
    resetUserPassword: jest.fn(async ({ subject, password }) => { bySubject(subject).password = password; }),
  };
  const repository = {
    listPlatformUsers: jest.fn(async () => rows),
    getPlatformUserById: jest.fn(async (id) => rows.find((row) => row.id === id) ?? null),
    updatePlatformUser: jest.fn(async (id, data) => { const row = rows.find((entry) => entry.id === id); Object.assign(row, data); return row; }),
  };
  const service = new AdminUsersService(repository as never, prisma as never, keycloak as never);
  return { rows, tx, identities, keycloak, repository, service };
}

describe('Workspace-specific platform users', () => {
  it('keeps matching business names as separate login identities and passwords', async () => {
    const s = setup();
    const a = await runInCloudWorkspace(first, () => s.service.createUser(input));
    const b = await runInCloudWorkspace(second, () => s.service.createUser({ ...input, password: 'OtherSyntheticPassword123!' }));
    expect(a.username).toBe(b.username);
    expect(a.loginUsername).not.toBe(b.loginUsername);
    expect(s.identities.size).toBe(2);
    expect(s.rows[0].oidcSubject).not.toBe(s.rows[1].oidcSubject);
    await runInCloudWorkspace(first, () => s.service.resetUserPassword(a.id, 'UpdatedSyntheticPassword123!'));
    expect(s.identities.get(a.loginUsername)?.password).toBe('UpdatedSyntheticPassword123!');
    expect(s.identities.get(b.loginUsername)?.password).toBe('OtherSyntheticPassword123!');
    await expect(runInCloudWorkspace(first, () => s.service.listUsers())).resolves.toEqual([expect.objectContaining({ id: a.id })]);
    await expect(runInCloudWorkspace(second, () => s.service.listUsers())).resolves.toEqual([expect.objectContaining({ id: b.id })]);
    await expect(runInCloudWorkspace(first, () => s.service.createUser(input))).rejects.toThrow('Username already exists');
    expect(s.keycloak.createUser).toHaveBeenCalledTimes(2);
  });

  it.each(['role', 'status', 'password'] as const)('rejects foreign-space %s writes before any identity mutation', async (field) => {
    const s = setup();
    const b = await runInCloudWorkspace(second, () => s.service.createUser(input));
    const action = () => field === 'role' ? s.service.updateUserRole(b.id, 'admin')
      : field === 'status' ? s.service.updateUserStatus(b.id, 'disabled') : s.service.resetUserPassword(b.id, 'ChangedPassword123!');
    await expect(runInCloudWorkspace(first, action)).rejects.toBeInstanceOf(NotFoundException);
    expect(s.keycloak.updateUserRole).not.toHaveBeenCalled();
    expect(s.keycloak.updateUserStatus).not.toHaveBeenCalled();
    expect(s.keycloak.resetUserPassword).not.toHaveBeenCalled();
  });

  it('counts active business administrators only within their workspace', async () => {
    const s = setup();
    const a = await runInCloudWorkspace(first, () => s.service.createUser({ ...input, role: 'admin' }));
    await runInCloudWorkspace(second, () => s.service.createUser({ ...input, role: 'admin' }));
    await expect(runInCloudWorkspace(first, () => s.service.updateUserRole(a.id, 'user'))).rejects.toThrow('last active admin');
    expect(s.tx.platformUser.count).toHaveBeenCalledWith({ where: { cloudWorkspaceId: first.cloudWorkspaceId, isPlatformManager: false, role: 'admin', status: 'active' } });
    expect(s.keycloak.updateUserRole).not.toHaveBeenCalled();
  });

  it('hides the global manager and rejects business admin mutation of its identity', async () => {
    const s = setup();
    s.rows.push({ id: 'root', username: 'root', loginUsername: 'root', cloudWorkspaceId: null, isPlatformManager: true, role: 'admin', status: 'active', oidcSubject: 'global-subject' });
    await expect(runInCloudWorkspace(first, () => s.service.listUsers())).resolves.toEqual([]);
    await expect(runInCloudWorkspace(first, () => s.service.updateUserRole('root', 'user'))).rejects.toBeInstanceOf(NotFoundException);
    await expect(runInCloudWorkspace(first, () => s.service.updateUserStatus('root', 'disabled'))).rejects.toBeInstanceOf(NotFoundException);
    await expect(runInCloudWorkspace(first, () => s.service.resetUserPassword('root', 'ChangedPassword123!'))).rejects.toBeInstanceOf(NotFoundException);
    expect(s.keycloak.resetUserPassword).not.toHaveBeenCalled();
  });

  it('allows only the global manager itself to reset its own password', async () => {
    const s = setup();
    s.rows.push({ id: 'root', username: 'root', loginUsername: 'root', cloudWorkspaceId: null, isPlatformManager: true, role: 'admin', status: 'active', oidcSubject: 'global-subject' });
    s.identities.set('root', { subject: 'global-subject', password: 'OldSyntheticPassword123!', status: 'active', role: 'admin' });
    await expect(runInCloudWorkspace({ ...first, isPlatformManager: true, actorUserId: 'root' }, () => s.service.resetUserPassword('root', 'ChangedPassword123!'))).resolves.toMatchObject({ id: 'root', loginUsername: 'root' });
    expect(s.identities.get('root')?.password).toBe('ChangedPassword123!');
    await expect(runInCloudWorkspace({ ...first, isPlatformManager: true, actorUserId: 'another-manager' }, () => s.service.resetUserPassword('root', 'OtherPassword123!'))).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects read-only and absent scopes before creating an identity', async () => {
    const s = setup();
    await expect(runInCloudWorkspace({ ...first, isReadOnly: true }, () => s.service.createUser(input))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(s.service.createUser(input)).rejects.toThrow('Cloud workspace scope is missing');
    expect(s.keycloak.createUser).not.toHaveBeenCalled();
  });

  it('retains a stable identity alias after an unknown external creation outcome', async () => {
    const s = setup();
    const create = s.keycloak.createUser.getMockImplementation()!;
    s.keycloak.createUser.mockImplementationOnce(async (user) => { await create(user); throw new Error('Identity creation outcome is unknown'); });
    await expect(runInCloudWorkspace(first, () => s.service.createUser(input))).rejects.toThrow('outcome is unknown');
    await expect(runInCloudWorkspace(first, () => s.service.createUser(input))).rejects.toThrow('Username already exists');
    expect(s.keycloak.createUser.mock.calls[0][0].loginUsername).toBe(s.keycloak.createUser.mock.calls[1][0].loginUsername);
    expect(s.identities.size).toBe(1);
    expect(s.rows).toHaveLength(0);
    expect(s.keycloak.deleteUser).not.toHaveBeenCalled();
  });
});
