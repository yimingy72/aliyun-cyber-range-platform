import { describe, expect, it } from 'vitest';
import { readConfig } from '../src/config';

describe('MCP authentication configuration', () => {
  it('does not inherit identity administration credentials or a shared API token', () => {
    const config = readConfig({ PLATFORM_API_BASE_URL: 'https://platform.invalid', KEYCLOAK_ADMIN_CLIENT_ID: 'identity-admin', KEYCLOAK_ADMIN_CLIENT_SECRET: 'admin-secret', PLATFORM_API_TOKEN: 'service-token' });
    expect(config.oidcClientId).toBeUndefined(); expect(config.oidcClientSecret).toBeUndefined();
    expect(config).not.toHaveProperty('platformApiToken'); expect(config.mcpOidcAudience).toBe('mcp-gateway');
  });
  it('reads explicit public entry points', () => {
    expect(readConfig({ PLATFORM_API_BASE_URL: 'https://platform.invalid', MCP_PUBLIC_URL: 'https://gateway.example/mcp', MCP_ALLOWED_HOSTS: 'mcp:8787, gateway.example', MCP_ALLOWED_ORIGINS: 'https://console.example' })).toMatchObject({ publicUrl: 'https://gateway.example/mcp', allowedHosts: ['mcp:8787', 'gateway.example'], allowedOrigins: ['https://console.example'] });
  });
});
