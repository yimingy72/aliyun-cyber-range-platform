import { ServiceUnavailableException } from '@nestjs/common';
import { KeycloakIdentityService } from '../src/auth/keycloak-identity.service';

const originalEnv = { ...process.env };
const originalFetch = global.fetch;

beforeEach(() => {
  Object.assign(process.env, {
    OIDC_UNIFIED_CLIENT_ID: 'cyber-range',
    OIDC_UNIFIED_CLIENT_UUID: 'fixture-client',
    OIDC_UNIFIED_CLIENT_SECRET: 'fixture-secret',
    OIDC_TOKEN_ENDPOINT: 'https://identity.example/token',
    KEYCLOAK_ADMIN_BASE_URL: 'https://identity.example',
    KEYCLOAK_REALM: 'cyber-range',
    OIDC_WORKSPACE_GROUP_MAP: '{"fixture-group":"fixture-workspace"}',
  });
});
afterEach(() => {
  process.env = { ...originalEnv };
  global.fetch = originalFetch;
});

it('requests the Keycloak admin audience only for its read-only identity service token', async () => {
  const fetch = jest.fn().mockImplementation(async (url: string) => {
    if (url.endsWith('/introspect')) return Response.json({ active: true, sub: 'member' });
    if (url.endsWith('/token')) return Response.json({ access_token: 'service-token', expires_in: 120 });
    if (url.endsWith('/composite')) return Response.json([{ name: 'user' }]);
    if (url.includes('/groups?')) return Response.json([{ id: 'fixture-group' }]);
    return Response.json({ id: 'member', username: 'member', enabled: true });
  });
  global.fetch = fetch;
  const service = new KeycloakIdentityService();
  await expect(service.resolve('member', 'web-token')).resolves.toEqual({
    username: 'member', role: 'user', workspaceIds: ['fixture-workspace'],
  });
  await service.resolve('member', 'web-token');
  const grants = fetch.mock.calls.filter(([url]) => url === process.env.OIDC_TOKEN_ENDPOINT);
  expect(grants).toHaveLength(1);
  expect(Object.fromEntries(grants[0][1].body)).toEqual({
    grant_type: 'client_credentials', scope: 'kc-admin-api', client_id: 'cyber-range', client_secret: 'fixture-secret',
  });
  const introspections = fetch.mock.calls.filter(([url]) => url.endsWith('/introspect'));
  expect(introspections).toHaveLength(2);
  expect(introspections.every(([, init]) => !init.body.has('scope'))).toBe(true);
});

it('rejects an unavailable identity service instead of trusting the old local role', async () => {
  global.fetch = jest.fn().mockResolvedValue(new Response(null, { status: 401 }));
  await expect(new KeycloakIdentityService().resolve('member')).rejects.toBeInstanceOf(ServiceUnavailableException);
});
