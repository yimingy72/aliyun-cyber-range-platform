import type { PlatformApiClientLike } from '@aliyun-cyber-range/platform-api-client';
import type * as z from 'zod/v4';

export type PlatformScope =
  | 'templates:read'
  | 'templates:write'
  | 'templates:publish'
  | 'templates:delete'
  | 'images:read'
  | 'images:write'
  | 'ranges:read'
  | 'ranges:create'
  | 'ranges:write'
  | 'ranges:control'
  | 'ranges:destroy'
  | 'instances:read'
  | 'instances:create'
  | 'instances:destroy'
  | 'instances:control'
  | 'instances:credentials:read'
  | 'jobs:read'
  | 'users:read'
  | 'users:write'
  | 'billing:read'
  | 'billing:sync'
  | 'settings:read'
  | 'settings:write';

export type ToolContext = {
  client: PlatformApiClientLike;
  scopes: Set<string>;
};

export type ToolDefinition<TArgs = Record<string, unknown>> = {
  name: string;
  title?: string;
  description: string;
  requiredScopes: PlatformScope[];
  readOnlyHint?: boolean;
  annotations?: {
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  inputSchema: z.ZodType;
  outputSchema?: z.ZodType;
  call(context: ToolContext, args: TArgs): Promise<unknown>;
};
