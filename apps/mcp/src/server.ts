import { PlatformApiError, type PlatformApiClientLike } from '@aliyun-cyber-range/platform-api-client';

import { adminUserTools } from './tools/admin-users';
import { imageTools } from './tools/images';
import { jobTools } from './tools/jobs';
import { rangeTools } from './tools/ranges';
import { settingsTools } from './tools/settings';
import { singleInstanceTools } from './tools/single-instances';
import { templateTools } from './tools/templates';
import type { ToolContext, ToolDefinition } from './tools/tool-context';
import { toToolResult } from './tools/tool-result';

const tools = [...templateTools, ...imageTools, ...rangeTools, ...singleInstanceTools, ...jobTools, ...adminUserTools, ...settingsTools];

export function createToolRegistry(client: PlatformApiClientLike) {
  return {
    listTools(scopes: string[]) {
      const scopeSet = new Set(scopes);

      return tools.filter((tool) => canAccess(tool, scopeSet)).map((tool) => describe(tool));
    },
    async callTool(name: string, scopes: string[], args: Record<string, unknown>) {
      const tool = tools.find((item) => item.name === name);

      if (!tool) {
        throw new Error(`Unknown tool: ${name}`);
      }

      const scopeSet = new Set(scopes);

      if (!canAccess(tool, scopeSet)) {
        throw new Error(`Forbidden tool: ${name}`);
      }

      try {
        const result = await tool.call({ client, scopes: scopeSet } satisfies ToolContext, args);
        return toToolResult(result);
      } catch (error) {
        if (error instanceof PlatformApiError) {
          return toToolResult(
            {
              error: error.details ?? { status: error.status, message: error.message },
            },
            true,
          );
        }

        throw error;
      }
    },
  };
}

function canAccess(tool: ToolDefinition, scopes: Set<string>) {
  return tool.requiredScopes.every((scope) => scopes.has(scope));
}

function describe(tool: ToolDefinition) {
  return {
    name: tool.name,
    description: tool.description,
    annotations: {
      readOnlyHint: tool.readOnlyHint === true,
    },
    requiredScopes: tool.requiredScopes,
    inputSchema: tool.inputSchema,
  };
}
