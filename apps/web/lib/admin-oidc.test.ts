import { describe, expect, it } from 'vitest';

import { buildAdminOidcAuthorizeUrl, parseAdminOidcSessionPayload } from './admin-oidc';

describe('admin OIDC helpers', () => {
  it('builds an authorization url with PKCE values', async () => {
    const authorization = await buildAdminOidcAuthorizeUrl({
      issuer: 'http://localhost:8080/realms/cyber-range',
      clientId: 'platform-web',
      redirectUri: 'http://localhost:3000/admin/callback',
    });

    const url = new URL(authorization.url);
    expect(url.origin + url.pathname).toBe('http://localhost:8080/realms/cyber-range/protocol/openid-connect/auth');
    expect(url.searchParams.get('client_id')).toBe('platform-web');
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:3000/admin/callback');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe('openid profile email');
    expect(url.searchParams.get('state')).toBe(authorization.state);
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    expect(authorization.codeVerifier).toBeTruthy();
  });

  it('parses an access token into an admin session payload', () => {
    const token = [
      Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
      Buffer.from(
        JSON.stringify({
          sub: 'alice-subject',
          preferred_username: 'alice',
          realm_access: { roles: ['user'] },
        }),
      ).toString('base64url'),
      'signature',
    ].join('.');

    expect(parseAdminOidcSessionPayload({ access_token: token })).toEqual({
      token,
      profile: {
        id: 'alice-subject',
        username: 'alice',
        role: 'user',
      },
    });
  });
});
