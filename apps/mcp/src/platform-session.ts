import type { McpConfig } from './config';

import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';

export async function resolvePlatformApiToken(config: McpConfig, auth?: AuthInfo) {
  if (auth?.extra && typeof auth.extra === 'object' && 'authType' in auth.extra) {
    if (auth.extra.authType === 'oidc') {
      return exchangePlatformApiToken(config, auth.token);
    }
  }

  if (config.platformApiToken) {
    return config.platformApiToken;
  }

  throw new Error('Missing downstream platform API authentication: provide an inbound OIDC token or PLATFORM_API_TOKEN');
}

export async function exchangePlatformApiToken(config: McpConfig, subjectToken: string) {
  if (!config.oidcTokenEndpoint || !config.oidcClientId || !config.oidcClientSecret) {
    throw new Error('Missing OIDC token exchange configuration');
  }

  const response = await fetch(config.oidcTokenEndpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      client_id: config.oidcClientId,
      client_secret: config.oidcClientSecret,
      subject_token: subjectToken,
      subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      audience: config.platformApiAudience || 'platform-api',
    }),
  });

  if (!response.ok) {
    throw new Error(`OIDC token exchange failed with status ${response.status}`);
  }

  const payload = (await response.json()) as { access_token?: unknown };

  if (typeof payload.access_token !== 'string' || payload.access_token.length === 0) {
    throw new Error('OIDC token exchange response missing access_token');
  }

  return payload.access_token;
}
