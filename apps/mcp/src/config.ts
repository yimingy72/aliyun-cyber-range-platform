export type McpConfig = {
  port: number;
  host: string;
  platformApiBaseUrl: string;
  platformApiToken?: string;
  oidcIssuer?: string;
  oidcJwksUrl?: string;
  oidcTokenEndpoint?: string;
  oidcClientId?: string;
  oidcClientSecret?: string;
  mcpOidcAudience?: string;
  platformApiAudience?: string;
};

export function readConfig(env: NodeJS.ProcessEnv = process.env): McpConfig {
  return {
    port: Number(env.MCP_PORT ?? '8787'),
    host: env.MCP_HOST ?? '127.0.0.1',
    platformApiBaseUrl: requireEnv(env, 'PLATFORM_API_BASE_URL'),
    platformApiToken: env.PLATFORM_API_TOKEN?.trim() || undefined,
    oidcIssuer: env.OIDC_ISSUER?.trim() || undefined,
    oidcJwksUrl: env.OIDC_JWKS_URL?.trim() || undefined,
    oidcTokenEndpoint: env.OIDC_TOKEN_ENDPOINT?.trim() || undefined,
    oidcClientId: env.MCP_OIDC_CLIENT_ID?.trim() || env.KEYCLOAK_ADMIN_CLIENT_ID?.trim() || undefined,
    oidcClientSecret: env.MCP_OIDC_CLIENT_SECRET?.trim() || env.KEYCLOAK_ADMIN_CLIENT_SECRET?.trim() || undefined,
    mcpOidcAudience: env.MCP_OIDC_AUDIENCE?.trim() || 'mcp',
    platformApiAudience: env.PLATFORM_API_AUDIENCE?.trim() || 'platform-api',
  };
}

function requireEnv(env: NodeJS.ProcessEnv, name: string) {
  const value = env[name]?.trim();

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}
