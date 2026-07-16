import type { PlatformApiClientLike } from '@aliyun-cyber-range/platform-api-client';

export type PlatformScope =
  | 'templates:read'
  | 'images:read'
  | 'ranges:read'
  | 'ranges:create'
  | 'ranges:destroy'
  | 'instances:read'
  | 'instances:create'
  | 'instances:destroy'
  | 'instances:control'
  | 'instances:credentials:read'
  | 'jobs:read';

export type ToolContext = {
  client: PlatformApiClientLike;
  scopes: Set<string>;
};

export type ToolDefinition<TArgs = Record<string, unknown>> = {
  name: string;
  description: string;
  requiredScopes: PlatformScope[];
  readOnlyHint?: boolean;
  call(context: ToolContext, args: TArgs): Promise<unknown>;
};
