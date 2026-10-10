import { AdminUsersService } from '../src/admin/admin-users.service';
import { KeycloakAdminService } from '../src/admin/keycloak-admin.service';
import { PrismaService } from '../src/database/prisma.service';
import { PrismaAdminRepository } from '../src/database/prisma-admin.repository';
import { runInCloudWorkspace, runInSystemCloudWorkspaceScope } from '../src/auth/cloud-workspace-scope';

// Both opt-ins are restricted to the disposable Docker fixture, never application configuration.
const baseUrl = process.env.USER_AUTH_TEST_KEYCLOAK_BASE_URL;
const databaseUrl = process.env.USER_AUTH_TEST_DATABASE_URL;
const isolated = baseUrl === 'http://user-review-keycloak:8080'
  && databaseUrl === 'postgresql://synthetic_user:synthetic_password@user-review-postgres:5432/user_review';
const contract = isolated ? describe : describe.skip;
contract('Default Keycloak 26.1.4 user profile and scoped PostgreSQL contract', () => {
  const realm = 'synthetic-user-review';
  const workspaceA = { cloudWorkspaceId: 'synthetic-user-alibaba', provider: 'alibaba_cloud' as const, accountUid: 'synthetic-alpha' };
  const workspaceB = { cloudWorkspaceId: 'synthetic-user-tencent', provider: 'tencent_cloud' as const, accountUid: 'synthetic-tencent' };
  const environment = { ...process.env };
  let prisma: PrismaService, identities: KeycloakAdminService, service: AdminUsersService, adminToken: string;
  const subjects: string[] = [];
  async function admin(path: string, method = 'GET', body?: unknown) {
    const response = await fetch(`${baseUrl}/admin/realms/${realm}${path}`, { method,
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!response.ok) throw new Error(`Synthetic identity setup HTTP ${response.status}`);
    return response.status === 204 || response.status === 201 ? null : response.json();
  }
  beforeAll(async () => {
    const tokenResponse = await fetch(`${baseUrl}/realms/master/protocol/openid-connect/token`, { method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username: 'synthetic-admin', password: 'SyntheticAdminPassword123!' }) });
    expect(tokenResponse.status).toBe(200); adminToken = (await tokenResponse.json() as any).access_token;
    const realmResponse = await fetch(`${baseUrl}/admin/realms`, { method: 'POST', headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ realm, enabled: true, roles: { realm: [{ name: 'admin' }, { name: 'user' }] } }) });
    expect(realmResponse.status).toBe(201);
    await admin('/clients', 'POST', { clientId: 'synthetic-platform-client', secret: 'synthetic-client-secret', enabled: true, publicClient: false,
      clientAuthenticatorType: 'client-secret', serviceAccountsEnabled: true, directAccessGrantsEnabled: true, protocol: 'openid-connect' });
    const [client] = await admin('/clients?clientId=synthetic-platform-client') as any[];
    const [management] = await admin('/clients?clientId=realm-management') as any[];
    const account = await admin(`/clients/${client.id}/service-account-user`) as any;
    const role = await admin(`/clients/${management.id}/roles/realm-admin`);
    await admin(`/users/${account.id}/role-mappings/clients/${management.id}`, 'POST', [role]);
    process.env.KEYCLOAK_ADMIN_BASE_URL = baseUrl; process.env.KEYCLOAK_ADMIN_CLIENT_ID = 'synthetic-platform-client';
    process.env.KEYCLOAK_ADMIN_CLIENT_SECRET = 'synthetic-client-secret'; process.env.KEYCLOAK_REALM = realm; process.env.OIDC_ISSUER = `${baseUrl}/realms/${realm}`;
    prisma = new PrismaService({ datasources: { db: { url: databaseUrl! } } }); identities = new KeycloakAdminService();
    service = new AdminUsersService(new PrismaAdminRepository(prisma), prisma, identities);
    await runInSystemCloudWorkspaceScope(async () => {
      for (const scope of [workspaceA, workspaceB]) await prisma.cloudWorkspace.upsert({ where: { id: scope.cloudWorkspaceId }, create: { id: scope.cloudWorkspaceId, provider: scope.provider, accountUid: scope.accountUid, displayName: 'Synthetic user contract fixture' }, update: {} });
    });
  }, 30_000);
  afterAll(async () => {
    if (identities) for (const subject of subjects) await identities.deleteUser(subject);
    if (prisma) { await runInSystemCloudWorkspaceScope(async () => { await prisma.platformUser.deleteMany({ where: { cloudWorkspaceId: { in: [workspaceA.cloudWorkspaceId, workspaceB.cloudWorkspaceId] } } }); }); await prisma.$disconnect(); }
    process.env = environment;
  });
  it('proves the old tilde alias is rejected before identity creation', async () => {
    const response = await fetch(`${baseUrl}/admin/realms/${realm}/users`, { method: 'POST', headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'synthetic-user~workspace-hash', enabled: true }) });
    expect(response.status).toBe(400);
    await expect(identities.findUserSubjectByUsername('synthetic-user~workspace-hash')).resolves.toBeNull();
  });
  it('creates real identities with legal scoped aliases and independent passwords through the production service', async () => {
    const passwordA = 'SyntheticPasswordA123!', passwordB = 'SyntheticPasswordB123!';
    const a = await runInCloudWorkspace(workspaceA, () => service.createUser({ username: 'synthetic-user-a', password: passwordA, role: 'user' }));
    const b = await runInCloudWorkspace(workspaceB, () => service.createUser({ username: 'synthetic-user-a', password: passwordB, role: 'user' }));
    expect(a.loginUsername).toMatch(/^synthetic-user-a\.[a-f0-9]{64}$/); expect(a.loginUsername).not.toBe(b.loginUsername);
    for (const [scope, user, password] of [[workspaceA, a, passwordA], [workspaceB, b, passwordB]] as const) {
      const row = await runInCloudWorkspace(scope, () => prisma.platformUser.findUnique({ where: { id: user.id } }));
      expect(row).toMatchObject({ cloudWorkspaceId: scope.cloudWorkspaceId, username: user.username, loginUsername: user.loginUsername });
      subjects.push(row!.oidcSubject!); expect(await identities.findUserSubjectByUsername(user.loginUsername)).toBe(row!.oidcSubject);
      const roles = await admin(`/users/${row!.oidcSubject}/role-mappings/realm`) as any[]; expect(roles.some(role => role.name === 'user')).toBe(true);
      const response = await fetch(`${baseUrl}/realms/${realm}/protocol/openid-connect/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'password', client_id: 'synthetic-platform-client', client_secret: 'synthetic-client-secret', username: user.loginUsername, password }) });
      expect(response.status).toBe(200);
    }
    await expect(runInCloudWorkspace(workspaceA, () => service.updateUserStatus(b.id, 'disabled'))).rejects.toThrow('not found');
  });
  it('removes only its new Keycloak identity after PostgreSQL rejects creation, then permits known clean retry', async () => {
    await runInSystemCloudWorkspaceScope(() => prisma.$executeRaw`ALTER TABLE "PlatformUser" ADD CONSTRAINT synthetic_keycloak_user_rejection CHECK (username <> 'synthetic-rollback-user')`);
    const createdAliases: string[] = []; const create = identities.createUser.bind(identities);
    const spy = jest.spyOn(identities, 'createUser').mockImplementation(async input => { createdAliases.push(input.loginUsername!); return create(input); });
    try {
      await expect(runInCloudWorkspace(workspaceB, () => service.createUser({ username: 'synthetic-rollback-user', password: 'SyntheticPassword123!', role: 'user' }))).rejects.toThrow();
      expect(createdAliases).toHaveLength(1); await expect(identities.findUserSubjectByUsername(createdAliases[0])).resolves.toBeNull();
    } finally { await runInSystemCloudWorkspaceScope(() => prisma.$executeRaw`ALTER TABLE "PlatformUser" DROP CONSTRAINT synthetic_keycloak_user_rejection`); spy.mockRestore(); }
    const user = await runInCloudWorkspace(workspaceB, () => service.createUser({ username: 'synthetic-rollback-user', password: 'SyntheticPassword123!', role: 'user' }));
    expect(user.loginUsername).toBe(createdAliases[0]); subjects.push((await identities.findUserSubjectByUsername(user.loginUsername))!);
  });
});
