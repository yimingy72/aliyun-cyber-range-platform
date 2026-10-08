import { createServer } from 'node:http';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';

import type { PlatformApiClientLike } from '@aliyun-cyber-range/platform-api-client';
import { PlatformApiClient } from '@aliyun-cyber-range/platform-api-client';

import type { McpConfig } from './config';
import { authenticateRequest } from './auth';
import { resolvePlatformApiToken } from './platform-session';
import { createSdkServer } from './sdk-server';

type HttpAppDependencies = {
  authenticateRequest?: typeof authenticateRequest;
  client?: PlatformApiClientLike;
};

export function createHttpApp(config: McpConfig, dependencies: HttpAppDependencies = {}) {
  const authenticate = dependencies.authenticateRequest ?? authenticateRequest;
  return createServer(async (req, res) => {
    if (!req.url) {
      res.statusCode = 404;
      res.end();
      return;
    }

    if (req.url === '/healthz') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.url !== '/mcp' || req.method !== 'POST') {
      res.statusCode = req.url === '/mcp' ? 405 : 404;
      res.end();
      return;
    }

    let server: ReturnType<typeof createSdkServer> | undefined;
    let transport: StreamableHTTPServerTransport | undefined;

    try {
      const auth = await authenticate(req);

      if (!auth) {
        res.statusCode = 401;
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: {
              code: -32001,
              message: 'Missing or invalid platform token',
            },
            id: null,
          }),
        );
        return;
      }

      (req as typeof req & { auth?: AuthInfo }).auth = auth;

      const client =
        dependencies.client ??
        new PlatformApiClient({
          baseUrl: config.platformApiBaseUrl,
          token: await resolvePlatformApiToken(config, auth),
        });

      server = createSdkServer(client, auth.scopes);
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: {
              code: -32603,
              message: error instanceof Error ? error.message : 'Internal server error',
            },
            id: null,
          }),
        );
      }
    } finally {
      await Promise.allSettled([transport?.close(), server?.close()]);
    }
  });
}
