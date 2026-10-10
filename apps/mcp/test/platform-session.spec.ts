import { afterEach, describe, expect, it, vi } from 'vitest';
import { OidcJwtVerifier } from '../src/oidc-jwt-verifier';
import { exchangePlatformApiToken, resolvePlatformApiToken } from '../src/platform-session';

const config = { host: '127.0.0.1', port: 8787, platformApiBaseUrl: 'https://platform.example',
  oidcTokenEndpoint: 'https://issuer.example/token', oidcClientId: 'mcp-gateway', oidcClientSecret: 'fixture-secret' };
const principal = { issuer: 'https://issuer.example', subject: 'alice' };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
function setup(claims: import('../src/oidc-jwt-verifier').VerifiedOidcJwtClaims = { ...principal, audience: ['platform-api'], authorizedParty: 'mcp-gateway' }) {
  const verify = vi.spyOn(OidcJwtVerifier.prototype, 'verifyAccessToken').mockResolvedValue(claims);
  vi.stubEnv('OIDC_ISSUER', principal.issuer); vi.stubEnv('OIDC_JWKS_URL', 'https://issuer.example/jwks');
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ access_token: 'exchanged-token', token_type: 'Bearer' })));
  return { verify, fetchMock };
}
describe('platform token exchange', () => {
  it('exchanges and verifies the same human identity rather than forwarding the inbound token', async () => {
    const { verify, fetchMock } = setup();
    expect(await exchangePlatformApiToken(config, 'inbound-token', principal)).toBe('exchanged-token');
    expect(verify).toHaveBeenCalledWith('exchanged-token');
    const init = fetchMock.mock.calls[0][1]!;
    expect(init.redirect).toBe('error'); expect(init.signal).toBeInstanceOf(AbortSignal);
    const body = init.body as URLSearchParams;
    expect(body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:token-exchange');
    expect(body.get('audience')).toBe('platform-api'); expect(body.get('subject_token')).toBe('inbound-token');
  });
  it.each([{ ...principal, subject: 'service-account' }, { ...principal, issuer: 'another-issuer' }])('rejects changed identity', async changed => {
    setup({ ...changed, audience: ['platform-api'], authorizedParty: 'mcp-gateway' });
    await expect(exchangePlatformApiToken(config, 'inbound-token', principal)).rejects.toThrow('identity mismatch');
  });
  it('rejects an exchange token issued to another OAuth client', async () => {
    setup({ ...principal, audience: ['platform-api'], authorizedParty: 'other-client' });
    await expect(exchangePlatformApiToken(config, 'inbound-token', principal)).rejects.toThrow('identity mismatch');
  });
  it('rejects an explicitly denied scope set before token exchange', async () => {
    const { fetchMock } = setup();
    await expect(exchangePlatformApiToken(config, 'inbound-token', { ...principal, allowedScopes: [] })).rejects.toMatchObject({ status: 403 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('does not fall back to a shared service token', async () => {
    vi.stubEnv('PLATFORM_API_TOKEN', 'shared-token');
    await expect(resolvePlatformApiToken(config)).rejects.toThrow('Missing verified OIDC identity');
    await expect(resolvePlatformApiToken(config, { token: 'static', clientId: 'service', scopes: [], extra: { authType: 'static' } })).rejects.toThrow('Missing verified OIDC identity');
  });
  it('preserves explicit least-privilege scopes during exchange', async () => {
    const { verify, fetchMock } = setup(); verify.mockResolvedValue({ ...principal, audience: ['platform-api'], authorizedParty: 'mcp-gateway', scopes: ['images:read'] });
    expect(await exchangePlatformApiToken(config, 'inbound-token', { ...principal, allowedScopes: ['images:read'] })).toBe('exchanged-token');
    expect((fetchMock.mock.calls[0][1]!.body as URLSearchParams).get('scope')).toBe('images:read');
  });
  it.each([undefined, ['users:write'], ['images:read', 'settings:write']])('rejects omitted or broadened scope from exchange', async scopes => {
    const { verify } = setup(); verify.mockResolvedValue({ ...principal, audience: ['platform-api'], authorizedParty: 'mcp-gateway', scopes });
    await expect(exchangePlatformApiToken(config, 'inbound-token', { ...principal, allowedScopes: ['images:read'] })).rejects.toThrow('scope mismatch');
  });
  it('requires Bearer token_type', async () => {
    const { fetchMock } = setup(); fetchMock.mockResolvedValue(new Response(JSON.stringify({ access_token: 'token', token_type: 'other' })));
    await expect(exchangePlatformApiToken(config, 'inbound-token', principal)).rejects.toThrow('response is invalid');
  });
  it('reports exchange outages without surfacing network details', async () => {
    const { fetchMock } = setup(); fetchMock.mockRejectedValue(new Error('secret-endpoint-request-details'));
    await expect(exchangePlatformApiToken(config, 'inbound-token', principal)).rejects.toMatchObject({ status: 503, message: 'Platform authentication is unavailable' });
  });
  it.each([400, 401, 403, 502])('maps token exchange status %s without leaking the response', async status => {
    const { fetchMock } = setup(); fetchMock.mockResolvedValue(new Response('secret-detail', { status }));
    await expect(exchangePlatformApiToken(config, 'inbound-token', principal)).rejects.toMatchObject({ status: status < 500 ? 401 : 503, message: 'Platform authentication failed' });
  });
});
