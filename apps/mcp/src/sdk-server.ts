import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { PlatformApiClientLike } from '@aliyun-cyber-range/platform-api-client';

import { createToolRegistry } from './server';

const allScopes = [
  'templates:read',
  'templates:write',
  'templates:publish',
  'templates:delete',
  'images:read',
  'images:write',
  'ranges:read',
  'ranges:create',
  'ranges:write',
  'ranges:control',
  'ranges:destroy',
  'ranges:delete',
  'instances:read',
  'instances:create',
  'instances:destroy',
  'instances:control',
  'instances:credentials:read',
  'jobs:read',
  'users:read',
  'users:write',
  'billing:read',
  'billing:sync',
  'settings:read',
  'settings:write',
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
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        annotations: tool.annotations,
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
