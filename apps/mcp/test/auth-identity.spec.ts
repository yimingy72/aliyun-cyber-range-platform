import { afterEach, describe, expect, it, vi } from 'vitest';

const { verify, lookup } = vi.hoisted(() => ({ verify: vi.fn(), lookup: vi.fn() }));
vi.mock('@aliyun-cyber-range/database/generated/client', () => ({ PrismaClient: class { platformUser = { findFirst: lookup }; } }));
vi.mock('../src/oidc-jwt-verifier', () => ({ OidcJwtVerifier: class { verifyAccessToken = verify; } }));
import { authenticateRequest } from '../src/auth';

const issuer = 'https://issuer.invalid';
const request = { headers: { authorization: 'Bearer header.payload.signature' } } as never;
const principal = (subject = 'alice') => ({ issuer, subject, audience: ['mcp-gateway'], authorizedParty: 'same-oauth-client' });
const user = (id = 'alice', role = 'user') => ({ id, username: id, role, cloudWorkspaceId: `workspace-${id}`, isPlatformManager: false });
afterEach(() => { verify.mockReset(); lookup.mockReset(); });

describe('MCP identity and live account authority', () => {
  it('keeps users of the same OAuth client distinct', async () => {
    verify.mockResolvedValueOnce(principal('alice')).mockResolvedValueOnce(principal('bob'));
    lookup.mockResolvedValueOnce(user('alice')).mockResolvedValueOnce(user('bob'));
    const a = await authenticateRequest(request); const b = await authenticateRequest(request);
    expect(a?.clientId).toBe(b?.clientId);
    expect(a?.extra).toMatchObject({ userId: 'alice', subject: 'alice', cloudWorkspaceId: 'workspace-alice' });
    expect(b?.extra).toMatchObject({ userId: 'bob', subject: 'bob', cloudWorkspaceId: 'workspace-bob' });
    expect(lookup).toHaveBeenNthCalledWith(2, { where: { oidcIssuer: issuer, oidcSubject: 'bob', status: 'active' } });
  });
  it('rejects a token without a signed OAuth client identity', async () => {
    verify.mockResolvedValue({ ...principal(), authorizedParty: null });
    expect(await authenticateRequest(request)).toBeNull(); expect(lookup).not.toHaveBeenCalled();
  });
  it('refreshes role and disabled status on every request without caching a session', async () => {
    verify.mockResolvedValue(principal());
    lookup.mockResolvedValueOnce(user('alice', 'admin')).mockResolvedValueOnce(user('alice', 'user')).mockResolvedValueOnce(null);
    expect((await authenticateRequest(request))?.scopes).toContain('users:write');
    expect((await authenticateRequest(request))?.scopes).not.toContain('users:write');
    expect(await authenticateRequest(request)).toBeNull(); expect(lookup).toHaveBeenCalledTimes(3);
  });
  it('does not let token scopes grant rights absent from the current platform role', async () => {
    verify.mockResolvedValue({ ...principal(), scopes: ['openid', 'images:read', 'settings:write'] }); lookup.mockResolvedValue(user());
    expect(await authenticateRequest(request)).toMatchObject({ scopes: ['images:read'], extra: { businessScopeRestricted: true } });
  });
  it('marks unknown non-identity scopes restricted rather than role fallback', async () => {
    verify.mockResolvedValue({ ...principal(), scopes: ['openid', 'unknown-scope'] }); lookup.mockResolvedValue(user('alice', 'admin'));
    expect(await authenticateRequest(request)).toMatchObject({ scopes: [], extra: { businessScopeRestricted: true } });
  });
  it.each(['Bearer header.payload.signature trailing', 'Bearer', 'Basic header.payload.signature'])('rejects malformed authorization %s', async authorization => {
    expect(await authenticateRequest({ headers: { authorization } } as never)).toBeNull(); expect(verify).not.toHaveBeenCalled();
  });
});
