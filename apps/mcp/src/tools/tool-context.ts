import type { PlatformApiClientLike } from '@aliyun-cyber-range/platform-api-client';
import type * as z from 'zod/v4';

export type PlatformScope =
  | 'templates:read'
  | 'images:read'
  | 'images:write'
  | 'ranges:read'
  | 'ranges:create'
  | 'ranges:destroy'
  | 'instances:read'
  | 'instances:create'
  | 'instances:destroy'
  | 'instances:control'
  | 'instances:credentials:read'
  | 'jobs:read'
  | 'users:read'
  | 'users:write'
  | 'settings:read'
  | 'settings:write';

export type ToolContext = {
  client: PlatformApiClientLike;
  scopes: Set<string>;
};

export type ToolDefinition<TArgs = Record<string, unknown>> = {
  name: string;
  description: string;
  requiredScopes: PlatformScope[];
  readOnlyHint?: boolean;
  inputSchema?: z.ZodType;
  call(context: ToolContext, args: TArgs): Promise<unknown>;
};
