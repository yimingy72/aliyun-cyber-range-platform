import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';

import type { PlatformApiClientLike } from '@aliyun-cyber-range/platform-api-client';

import { createToolRegistry } from './server';

const allScopes = [
  'templates:read',
  'images:read',
  'ranges:read',
  'ranges:create',
  'ranges:destroy',
  'instances:read',
  'instances:create',
  'instances:destroy',
  'instances:control',
  'instances:credentials:read',
  'jobs:read',
] as const;

export function createSdkServer(client: PlatformApiClientLike, scopes: string[] = [...allScopes]) {
  const registry = createToolRegistry(client);
  const server = new McpServer({
    name: 'aliyun-cyber-range-platform',
    version: '0.0.0',
  });

  for (const tool of registry.listTools(scopes)) {
    server.registerTool(
      tool.name,
      {
        title: tool.name,
        description: tool.description,
        inputSchema: z.object({}).passthrough(),
        annotations: {
          readOnlyHint: tool.annotations.readOnlyHint,
        },
      },
      async (args, extra) => {
        const authScopes = pickScopes(extra.authInfo);
        return registry.callTool(tool.name, authScopes.length > 0 ? authScopes : scopes, args as Record<string, unknown>);
      },
    );
  }

  return server;
}

function pickScopes(authInfo: unknown) {
  if (!authInfo || typeof authInfo !== 'object' || !('scopes' in authInfo)) {
    return [];
  }

  const scopes = (authInfo as { scopes?: unknown }).scopes;

  return Array.isArray(scopes) ? scopes.filter((item): item is string => typeof item === 'string') : [];
}
