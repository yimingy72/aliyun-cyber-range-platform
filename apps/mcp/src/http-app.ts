import { createServer } from 'node:http';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';

import type { PlatformApiClientLike } from '@aliyun-cyber-range/platform-api-client';
import { PlatformApiClient } from '@aliyun-cyber-range/platform-api-client';

import type { McpConfig } from './config';
import { authenticateRequest } from './auth';
import { PlatformAuthenticationError, resolvePlatformApiToken } from './platform-session';
import { createSdkServer, pickRole } from './sdk-server';

type HttpAppDependencies = {
  authenticateRequest?: typeof authenticateRequest;
  client?: PlatformApiClientLike;
  resolvePlatformApiToken?: typeof resolvePlatformApiToken;
};

export function createHttpApp(config: McpConfig, dependencies: HttpAppDependencies = {}) {
  const authenticate = dependencies.authenticateRequest ?? authenticateRequest;
  const publicUrl = config.publicUrl ? new URL(config.publicUrl) : undefined;
  if (publicUrl && (publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash || publicUrl.pathname !== '/mcp' || !['http:', 'https:'].includes(publicUrl.protocol))) {
    throw new Error('MCP_PUBLIC_URL must be an absolute HTTP(S) /mcp URL');
  }
  const app = createServer(async (req, res) => {
    if (!isTrustedConnection(req, config, app.address())) {
      sendError(res, 403, -32001, 'Untrusted host or origin');
      return;
    }
    if (!req.url) {
      res.statusCode = 404;
      res.end();
      return;
    }

    if (req.url === '/.well-known/oauth-protected-resource/mcp' && req.method === 'GET' && publicUrl && config.oidcIssuer) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ resource: publicUrl.href, authorization_servers: [config.oidcIssuer], bearer_methods_supported: ['header'] }));
      return;
    }

    if (req.url === '/healthz') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.url !== '/mcp' || req.method !== 'POST') {
      res.statusCode = req.url === '/mcp' ? 405 : 404;
      if (req.url === '/mcp') res.setHeader('Allow', 'POST');
      res.end();
      return;
    }

    let server: ReturnType<typeof createSdkServer> | undefined;
    let transport: StreamableHTTPServerTransport | undefined;

    try {
      const auth = await authenticate(req);

      if (!auth) {
        res.setHeader('WWW-Authenticate', bearerChallenge(config, 'invalid_token'));
        sendError(res, 401, -32001, 'Missing or invalid platform token');
        return;
      }

      const workspace = req.headers['x-cloud-workspace-id'];
      if (workspace !== undefined && (typeof workspace !== 'string' || !/^[A-Za-z0-9_-]{1,192}$/.test(workspace))) {
        sendError(res, 400, -32600, 'Invalid cloud workspace header');
        return;
      }
      (req as typeof req & { auth?: AuthInfo }).auth = auth;

      const client =
        dependencies.client ??
        new PlatformApiClient({
          baseUrl: config.platformApiBaseUrl,
          token: await (dependencies.resolvePlatformApiToken ?? resolvePlatformApiToken)(config, auth),
          cloudWorkspaceId: workspace as string | undefined,
        });

      server = createSdkServer(client, auth.scopes, pickRole(auth));
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      if (!res.headersSent) {
        const status = error instanceof PlatformAuthenticationError ? error.status : 500;
        if (status === 401 || status === 403) res.setHeader('WWW-Authenticate', bearerChallenge(config, status === 403 ? 'insufficient_scope' : 'invalid_token'));
        sendError(res, status, status === 401 || status === 403 ? -32001 : -32603,
          status === 403 ? 'Insufficient platform permissions' : status === 401 ? 'Platform authentication failed' : 'MCP request could not be completed');
      }
    } finally {
      await Promise.allSettled([transport?.close(), server?.close()]);
    }
  });
  return app;
}

function sendError(res: import('node:http').ServerResponse, status: number, code: number, message: string) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
}

function bearerChallenge(config: McpConfig, error: string) {
  const metadata = config.publicUrl ? new URL('/.well-known/oauth-protected-resource/mcp', config.publicUrl).href : undefined;
  return `Bearer error="${error}"${metadata ? `, resource_metadata="${metadata}"` : ''}`;
}

function isTrustedConnection(req: import('node:http').IncomingMessage, config: McpConfig, address: ReturnType<import('node:http').Server['address']>) {
  const port = address && typeof address === 'object' ? address.port : config.port;
  const loopbackHosts = [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`];
  const publicUrl = config.publicUrl ? new URL(config.publicUrl) : undefined;
  const counts = new Map<string, number>();
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i].toLowerCase();
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  if (['host', 'origin', 'authorization', 'x-cloud-workspace-id'].some(name => (counts.get(name) ?? 0) > 1)) return false;
  const hosts = new Set([...loopbackHosts, ...(publicUrl ? [publicUrl.host] : []), ...(config.allowedHosts ?? []).map(host => host.toLowerCase())]);
  if (typeof req.headers.host !== 'string' || !hosts.has(req.headers.host.toLowerCase())) return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  const origins = new Set([...loopbackHosts.map(host => `http://${host}`), ...(publicUrl ? [publicUrl.origin] : []), ...(config.allowedOrigins ?? [])]);
  return typeof origin === 'string' && origins.has(origin);
}
