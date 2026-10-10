import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { PlatformApiClientLike } from '@aliyun-cyber-range/platform-api-client';

import { createToolRegistry } from './server';

export function createSdkServer(client: PlatformApiClientLike, scopes: string[], role?: 'admin' | 'user') {
  const registry = createToolRegistry(client);
  const server = new McpServer({
    name: 'aliyun-cyber-range-platform',
    version: '0.0.0',
  });

  for (const tool of registry.listTools(scopes, role)) {
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
        const authScopes = extra.authInfo ? pickScopes(extra.authInfo).filter(scope => scopes.includes(scope)) : scopes;
        const requestRole = extra.authInfo ? pickRole(extra.authInfo) : role;
        return registry.callTool(tool.name, authScopes, args as Record<string, unknown>, role === 'user' ? 'user' : requestRole);
      },
    );
  }

  return server;
}

export function pickRole(authInfo: unknown): 'admin' | 'user' | undefined {
  const role = (authInfo as { extra?: { role?: unknown } } | undefined)?.extra?.role;
  return role === 'admin' || role === 'user' ? role : undefined;
}

function pickScopes(authInfo: unknown) {
  if (!authInfo || typeof authInfo !== 'object' || !('scopes' in authInfo)) {
    return [];
  }

  const scopes = (authInfo as { scopes?: unknown }).scopes;

  return Array.isArray(scopes) ? scopes.filter((item): item is string => typeof item === 'string') : [];
}
