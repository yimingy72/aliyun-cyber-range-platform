import { AdminAuthGuard } from '../src/admin/admin-auth.guard';
import { assertDelegatedApiScopes, resolveDelegatedScopes } from '../src/auth/delegated-api-scopes';
import { McpResponseInterceptor, redactMcpMetadata } from '../src/auth/mcp-response.interceptor';
import { lastValueFrom, of } from 'rxjs';

describe('delegated API permission boundary', () => {
  const check = (method: string, path: string, scopes: string[]) => assertDelegatedApiScopes(method, path, resolveDelegatedScopes('admin', scopes));
  it.each([
    ['POST', '/admin/ranges/r1/destroy', ['ranges:read']],
    ['POST', '/admin/billing/sync', ['billing:read']],
    ['POST', '/admin/cloud-workspaces/ws1/switch', ['settings:read']],
    ['POST', '/admin/instances/s1/actions/pack-image', ['instances:control']],
    ['POST', '/admin/ranges/r1/nodes/n1/actions/pack-image', ['ranges:control']],
    ['GET', '/admin/instances/s1/access', ['instances:read']],
    ['POST', '/admin/ranges/r1/nodes/n1/actions/open-vnc', ['ranges:read']],
    ['POST', '/admin/ranges', ['ranges:create']],
    ['POST', '/admin/ranges/r1/create', ['ranges:create']],
    ['POST', '/admin/ranges/r1/actions/anything', ['ranges:control']],
    ['GET', '/admin/scenarios-unsafe', ['templates:read']],
  ])('rejects %s %s without the operation permissions', (method, path, scopes) => {
    expect(() => check(method as string, path as string, scopes as string[])).toThrow('Delegated token lacks permission');
  });
  it('allows the exact credential endpoint only with both scopes', () => {
    expect(() => check('GET', '/admin/instances/s1/access', ['instances:read', 'instances:credentials:read'])).not.toThrow();
    expect(() => check('POST', '/admin/instances/s1/actions/pack-image', ['instances:control', 'images:write'])).not.toThrow();
  });
  it('allows safe metadata needed by a composite write without granting its credential endpoint', () => {
    expect(() => check('GET', '/admin/scenarios/t1', ['templates:write'])).not.toThrow();
    expect(() => check('GET', '/admin/ranges/r1', ['ranges:write'])).not.toThrow();
    expect(() => check('GET', '/admin/ranges/r1/access', ['ranges:write'])).toThrow();
  });
  it('never turns unknown business scopes into the legacy full role', () => {
    expect(resolveDelegatedScopes('admin', ['openid', 'ranges:unknown']).size).toBe(0);
    expect(resolveDelegatedScopes('user', ['billing:sync']).size).toBe(0);
    expect(resolveDelegatedScopes('user', ['openid', 'profile']).has('ranges:create')).toBe(true);
  });
  it.each(['mcp-gateway', 'platform-web'])('enforces verified scoped JWT for %s before controller side effects', async azp => {
    const guard = new AdminAuthGuard({ verifyAccessToken: async () => ({ issuer: 'https://issuer', subject: 's1', authorizedParty: azp, scopes: ['ranges:read'] }) } as never,
      { resolve: async () => ({ id: 'u1', username: 'reader', role: 'admin', isPlatformManager: true }) } as never);
    const request = { headers: { authorization: 'Bearer a.b.c' }, originalUrl: '/admin/ranges/r1/destroy', method: 'POST' };
    await expect(guard.canActivate({ switchToHttp: () => ({ getRequest: () => request }) } as never)).rejects.toThrow('Delegated token lacks permission');
  });
});

describe('MCP API metadata redaction', () => {
  const response = { id: 's1', status: 'running', runtimeCredentials: { password: 'guest-secret' },
    accessEntry: { publicIp: '203.0.113.10', ssh: 'guest-secret', vnc_url: 'ticket-secret' },
    graph: { nodes: [{ id: 'n1', customPassword: 'secret', label: 'host' }] }, previewToken: 'opaque-preview',
    createdAt: new Date('2026-10-11T00:00:00Z') };
  it('keeps IDs, expiry timestamps and preview capabilities while removing nested credentials', () => {
    const result = redactMcpMetadata(response);
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(result).toEqual({ id: 's1', status: 'running', accessEntry: { publicIp: '203.0.113.10' },
      graph: { nodes: [{ id: 'n1', label: 'host' }] }, previewToken: 'opaque-preview', createdAt: '2026-10-11T00:00:00.000Z' });
  });
  const read = (source: string, method: string, path: string) => lastValueFrom(new McpResponseInterceptor().intercept({
    switchToHttp: () => ({ getRequest: () => ({ authContext: { source }, method, originalUrl: path }) }),
  } as never, { handle: () => of(response) }));
  it('redacts actual metadata responses, while preserving dedicated credentials and browser behavior', async () => {
    expect(JSON.stringify(await read('mcp', 'GET', '/admin/instances/s1'))).not.toContain('guest-secret');
    expect(await read('mcp', 'GET', '/admin/instances/s1/access')).toBe(response);
    expect(await read('mcp', 'POST', '/admin/ranges/r1/nodes/n1/actions/open-vnc')).toBe(response);
    expect(await read('web', 'GET', '/admin/instances/s1')).toBe(response);
  });
});
