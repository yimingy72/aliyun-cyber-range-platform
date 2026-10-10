import type { McpConfig } from './config';
import { OidcJwtVerifier } from './oidc-jwt-verifier';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';

export class PlatformAuthenticationError extends Error {
  constructor(readonly status: 401 | 403 | 503, message: string) { super(message); }
}

const downstreamVerifiers = new WeakMap<McpConfig, OidcJwtVerifier>();

type Principal = { issuer: string; subject: string; allowedScopes?: string[] };

export async function resolvePlatformApiToken(config: McpConfig, auth?: AuthInfo) {
  if (auth?.extra?.authType !== 'oidc' || typeof auth.extra.issuer !== 'string' || typeof auth.extra.subject !== 'string') {
    throw new PlatformAuthenticationError(401, 'Missing verified OIDC identity');
  }
  return exchangePlatformApiToken(config, auth.token, { issuer: auth.extra.issuer, subject: auth.extra.subject,
    ...(auth.extra.businessScopeRestricted === true ? { allowedScopes: auth.scopes } : {}) });
}

export async function exchangePlatformApiToken(config: McpConfig, subjectToken: string, principal: Principal) {
  if (!config.oidcTokenEndpoint || !config.oidcClientId || !config.oidcClientSecret) {
    throw new PlatformAuthenticationError(503, 'Platform authentication is unavailable');
  }

  if (principal.allowedScopes?.length === 0) throw new PlatformAuthenticationError(403, 'Platform authentication scope is invalid');

  const response = await fetch(config.oidcTokenEndpoint, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      client_id: config.oidcClientId,
      client_secret: config.oidcClientSecret,
      subject_token: subjectToken,
      subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      audience: config.platformApiAudience || 'platform-api',
      ...(principal.allowedScopes ? { scope: principal.allowedScopes.join(' ') } : {}),
    }),
  }).catch(() => { throw new PlatformAuthenticationError(503, 'Platform authentication is unavailable'); });

  if (!response.ok) {
    throw new PlatformAuthenticationError([400, 401, 403].includes(response.status) ? 401 : 503, 'Platform authentication failed');
  }
  const payload = await response.json().catch(() => null) as { access_token?: unknown; token_type?: unknown } | null;
  if (!payload || typeof payload.access_token !== 'string' || !payload.access_token || payload.token_type !== 'Bearer') {
    throw new PlatformAuthenticationError(503, 'Platform authentication response is invalid');
  }

  let verifier = downstreamVerifiers.get(config);
  if (!verifier) {
    verifier = new OidcJwtVerifier(config.platformApiAudience || 'platform-api');
    downstreamVerifiers.set(config, verifier);
  }
  const claims = await verifier.verifyAccessToken(payload.access_token)
    .catch(() => { throw new PlatformAuthenticationError(401, 'Platform authentication token is invalid'); });
  if (claims.issuer !== principal.issuer || claims.subject !== principal.subject || claims.authorizedParty !== config.oidcClientId) {
    throw new PlatformAuthenticationError(401, 'Platform authentication identity mismatch');
  }
  if (principal.allowedScopes) {
    const returnedScopes = claims.scopes?.filter(scope => scope.includes(':'));
    if (!returnedScopes?.length || returnedScopes.some(scope => !principal.allowedScopes!.includes(scope))) {
      throw new PlatformAuthenticationError(401, 'Platform authentication scope mismatch');
    }
  }
  return payload.access_token;
}
