import { PlatformApiError, type PlatformApiClientLike } from '@aliyun-cyber-range/platform-api-client';
import * as z from 'zod/v4';

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
const genericOutputSchema = z.object({}).passthrough();

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

      const parsed = tool.inputSchema.safeParse(args);

      if (!parsed.success) {
        const details = parsed.error.issues
          .map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`)
          .join('; ');
        throw new Error(`Invalid input for ${name}: ${details}`);
      }

      try {
        const result = await tool.call({ client, scopes: scopeSet } satisfies ToolContext, parsed.data);
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
    title: tool.title ?? tool.name,
    description: tool.description,
    annotations: {
      readOnlyHint: tool.readOnlyHint === true,
      destructiveHint: tool.annotations?.destructiveHint ?? false,
      idempotentHint: tool.annotations?.idempotentHint ?? tool.readOnlyHint === true,
      openWorldHint: tool.annotations?.openWorldHint ?? false,
    },
    requiredScopes: tool.requiredScopes,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema ?? genericOutputSchema,
  };
}
