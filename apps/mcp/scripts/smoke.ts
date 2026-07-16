import { once } from 'node:events';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { createHttpApp } from '../src/http-app';

async function main() {
  const apiBaseUrl = requireEnv('PLATFORM_API_BASE_URL');
  const host = process.env.MCP_HOST?.trim() || '127.0.0.1';
  const token = await getSmokeBearerToken();

  process.env.MCP_STATIC_BEARER_TOKEN = token;
  const server = createHttpApp({
    host,
    port: 0,
    platformApiBaseUrl: apiBaseUrl,
    oidcIssuer: requireEnv('OIDC_ISSUER'),
    oidcJwksUrl: requireEnv('OIDC_JWKS_URL'),
    oidcTokenEndpoint: requireEnv('OIDC_TOKEN_ENDPOINT'),
    oidcClientId: requireEnv('MCP_OIDC_CLIENT_ID'),
    oidcClientSecret: requireEnv('MCP_OIDC_CLIENT_SECRET'),
    mcpOidcAudience: process.env.MCP_OIDC_AUDIENCE?.trim() || 'mcp-gateway',
    platformApiAudience: process.env.PLATFORM_API_AUDIENCE?.trim() || 'platform-api',
  });

  server.listen(0, host);
  await once(server, 'listening');

  try {
    const address = server.address();

    if (!address || typeof address === 'string') {
      throw new Error('Expected bound server address');
    }

    const client = new Client({ name: 'mcp-smoke-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`http://${host}:${address.port}/mcp`), {
      requestInit: {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    });

    await client.connect(transport);

    const tools = await client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name).sort();

    if (!toolNames.includes('range_template_list')) {
      throw new Error('Smoke failed: missing range_template_list');
    }

    const listResult = await client.callTool({
      name: 'range_template_list',
      arguments: {
        view: 'platform',
      },
    });

    process.stdout.write(`tools=${toolNames.length}\n`);
    process.stdout.write(`${JSON.stringify({ toolNames, listResult: listResult.structuredContent ?? null }, null, 2)}\n`);

    await transport.close();
    await client.close();
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }
}

async function getSmokeBearerToken() {
  const existingToken = process.env.MCP_BEARER_TOKEN?.trim();

  if (existingToken) {
    return existingToken;
  }

  const username = process.env.MCP_SMOKE_USERNAME?.trim() || requireEnv('ADMIN_USERNAME');
  const password = process.env.MCP_SMOKE_PASSWORD || requireEnv('ADMIN_PASSWORD');
  const tokenEndpoint = requireEnv('OIDC_TOKEN_ENDPOINT');
  const clientId = process.env.MCP_SMOKE_OIDC_CLIENT_ID?.trim() || 'smoke-conf';
  const clientSecret = process.env.MCP_SMOKE_OIDC_CLIENT_SECRET?.trim() || 'smoke-secret';

  const response = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'password',
      client_id: clientId,
      client_secret: clientSecret,
      username,
      password,
    }),
  });

  if (!response.ok) {
    throw new Error(`OIDC password grant failed with status ${response.status}`);
  }

  const payload = (await response.json()) as { access_token?: unknown };

  if (typeof payload.access_token !== 'string' || payload.access_token.length === 0) {
    throw new Error('OIDC token response missing access_token');
  }

  return payload.access_token;
}

function requireEnv(name: string) {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

void main();
