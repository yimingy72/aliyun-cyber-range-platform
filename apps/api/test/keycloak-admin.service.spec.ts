describe('KeycloakAdminService', () => {
  it('creates a user with a permanent password and platform role', async () => {
    let serviceModule: { KeycloakAdminService?: new () => { createUser: (input: unknown) => Promise<string> } } | null;

    try {
      serviceModule = require('../src/admin/keycloak-admin.service');
    } catch {
      serviceModule = null;
    }

    expect(serviceModule?.KeycloakAdminService).toEqual(expect.any(Function));

    if (!serviceModule?.KeycloakAdminService) {
      return;
    }

    const previousEnvironment = {
      KEYCLOAK_ADMIN_BASE_URL: process.env.KEYCLOAK_ADMIN_BASE_URL,
      KEYCLOAK_ADMIN_CLIENT_ID: process.env.KEYCLOAK_ADMIN_CLIENT_ID,
      KEYCLOAK_ADMIN_CLIENT_SECRET: process.env.KEYCLOAK_ADMIN_CLIENT_SECRET,
      KEYCLOAK_REALM: process.env.KEYCLOAK_REALM,
    };
    process.env.KEYCLOAK_ADMIN_BASE_URL = 'https://keycloak.example';
    process.env.KEYCLOAK_ADMIN_CLIENT_ID = 'platform-admin';
    process.env.KEYCLOAK_ADMIN_CLIENT_SECRET = 'test-secret';
    process.env.KEYCLOAK_REALM = 'cyber-range';
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'admin-token' }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(null, {
          status: 201,
          headers: { location: 'https://keycloak.example/admin/realms/cyber-range/users/keycloak-alice' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'role-user-id', name: 'user', clientRole: false, composite: false }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    try {
      const service = new serviceModule.KeycloakAdminService();
      const subject = await service.createUser({
        username: 'alice',
        password: 'TemporaryPassword123!',
        role: 'user',
        status: 'active',
      });

      expect(subject).toBe('keycloak-alice');
      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(fetchMock).toHaveBeenNthCalledWith(
        1,
        'https://keycloak.example/realms/cyber-range/protocol/openid-connect/token',
        expect.objectContaining({ method: 'POST' }),
      );
      expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual(
        expect.objectContaining({
          username: 'alice',
          enabled: true,
          emailVerified: true,
          firstName: 'Platform',
          lastName: 'User',
          email: 'alice@example.local',
          credentials: [{ type: 'password', value: 'TemporaryPassword123!', temporary: false }],
          requiredActions: [],
        }),
      );
      expect(fetchMock).toHaveBeenNthCalledWith(
        3,
        'https://keycloak.example/admin/realms/cyber-range/roles/user',
        expect.objectContaining({ method: 'GET' }),
      );
      expect(fetchMock).toHaveBeenNthCalledWith(
        4,
        'https://keycloak.example/admin/realms/cyber-range/users/keycloak-alice/role-mappings/realm',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify([{ id: 'role-user-id', name: 'user', clientRole: false, composite: false }]),
        }),
      );
    } finally {
      fetchMock.mockRestore();
      Object.assign(process.env, previousEnvironment);
    }
  });
});

describe('Keycloak user write recovery', () => {
  const environment = { ...process.env };
  beforeEach(() => {
    process.env.KEYCLOAK_ADMIN_BASE_URL = 'https://keycloak.invalid';
    process.env.KEYCLOAK_ADMIN_CLIENT_ID = 'synthetic-client';
    process.env.KEYCLOAK_ADMIN_CLIENT_SECRET = 'synthetic-secret';
  });
  afterEach(() => { jest.restoreAllMocks(); process.env = { ...environment }; });

  function setup(failure: 'assign' | 'remove' | 'create-role' | 'cleanup' | 'reset' | 'reset-cleanup' | 'reset-cleanup-network' | 'create-network' | null = null) {
    const { KeycloakAdminService } = require('../src/admin/keycloak-admin.service');
    const roles = new Set(['admin']); let exists = false; let failed = false; let passwordChanged = false;
    const realmRole = (name: string) => ({ id: `role-${name}`, name, clientRole: false, composite: false });
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const path = String(url); const method = init?.method ?? 'GET';
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      if (path.endsWith('/token')) return new Response(JSON.stringify({ access_token: 'synthetic-token' }), { status: 200 });
      if (path.endsWith('/users') && method === 'POST') { exists = true; if (failure === 'create-network') throw new Error('Synthetic unknown transport outcome'); roles.clear(); return new Response(null, { status: 201, headers: { location: 'https://keycloak.invalid/users/new-subject' } }); }
      if (path.endsWith('/users/new-subject') && method === 'DELETE') { if (failure === 'cleanup') return new Response(null, { status: 500 }); exists = false; return new Response(null, { status: 204 }); }
      if (path.includes('/roles/')) { if ((failure === 'create-role' || failure === 'cleanup') && path.endsWith('/user')) return new Response(null, { status: 500 }); return new Response(JSON.stringify(realmRole(path.split('/').pop()!)), { status: 200 }); }
      if (path.endsWith('/role-mappings/realm')) {
        if (method === 'GET') return new Response(JSON.stringify([...roles].map(realmRole)), { status: 200 });
        const changes = JSON.parse(String(init?.body)) as Array<{ name: string }>;
        if (method === 'POST') {
          if (failure === 'assign' && !failed) { failed = true; return new Response(null, { status: 500 }); }
          changes.forEach((role) => roles.add(role.name));
        } else {
          changes.forEach((role) => roles.delete(role.name));
          if (failure === 'remove' && !failed) { failed = true; return new Response(null, { status: 500 }); }
        }
        return new Response(null, { status: 204 });
      }
      if (path.endsWith('/reset-password')) { if (failure === 'reset') return new Response(null, { status: 500 }); passwordChanged = true; return new Response(null, { status: 204 }); }
      if (method === 'PUT') { if (failure === 'reset-cleanup-network') throw new Error('Synthetic network failure'); return new Response(null, { status: failure === 'reset-cleanup' ? 500 : 204 }); }
      throw new Error('Unexpected synthetic request');
    });
    return { service: new KeycloakAdminService(), roles, fetchMock, exists: () => exists, passwordChanged: () => passwordChanged };
  }

  it('keeps the old role when assigning its replacement fails', async () => {
    const s = setup('assign'); await expect(s.service.updateUserRole({ subject: 'subject', role: 'user' })).rejects.toThrow('Failed to assign'); expect([...s.roles]).toEqual(['admin']);
  });
  it('restores the old role even if a failed DELETE had already removed it', async () => {
    const s = setup('remove'); await expect(s.service.updateUserRole({ subject: 'subject', role: 'user' })).rejects.toThrow('Failed to clear'); expect([...s.roles]).toEqual(['admin']);
  });
  it('accepts a role change only after assigning the new role and removing the old one', async () => {
    const s = setup(); await s.service.updateUserRole({ subject: 'subject', role: 'user' }); expect([...s.roles]).toEqual(['user']);
    expect(s.fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/role-mappings/realm')).map(([, init]) => init?.method ?? 'GET')).toEqual(['GET', 'POST', 'DELETE']);
  });
  it('clearly reports creation transport failures as an unknown outcome', async () => {
    const s = setup('create-network'); await expect(s.service.createUser({ username: 'synthetic-user', password: 'SyntheticPassword123!', role: 'user', status: 'active' })).rejects.toThrow('Identity creation outcome is unknown');
    expect(s.exists()).toBe(true);
  });
  it('deletes a newly created user if assigning its role fails', async () => {
    const s = setup('create-role'); await expect(s.service.createUser({ username: 'synthetic-user', password: 'SyntheticPassword123!', role: 'user', status: 'active' })).rejects.toThrow('Failed to resolve'); expect(s.exists()).toBe(false);
  });
  it('clearly reports failed cleanup rather than a normal username conflict', async () => {
    const s = setup('cleanup'); await expect(s.service.createUser({ username: 'synthetic-user', password: 'SyntheticPassword123!', role: 'user', status: 'active' })).rejects.toThrow('Created identity cleanup failed'); expect(s.exists()).toBe(true);
  });
  it.each(['reset-cleanup', 'reset-cleanup-network'] as const)('keeps successful password reset semantics after %s failure', async (failure) => {
    const s = setup(failure); await expect(s.service.resetUserPassword({ subject: 'subject', password: 'SyntheticPassword123!' })).resolves.toBeUndefined(); expect(s.passwordChanged()).toBe(true);
  });
  it('rejects a failed password reset before attempting required-action cleanup', async () => {
    const s = setup('reset'); await expect(s.service.resetUserPassword({ subject: 'subject', password: 'SyntheticPassword123!' })).rejects.toThrow('Failed to reset'); expect(s.passwordChanged()).toBe(false); expect(s.fetchMock).toHaveBeenCalledTimes(2);
  });
});
