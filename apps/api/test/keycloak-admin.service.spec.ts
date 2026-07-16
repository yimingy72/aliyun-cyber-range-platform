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
