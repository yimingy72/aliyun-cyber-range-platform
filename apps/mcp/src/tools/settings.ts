import type { ToolDefinition } from './tool-context';

export const settingsTools: ToolDefinition[] = [
  {
    name: 'cloud_config_get',
    description: 'Get current cloud config snapshot.',
    requiredScopes: ['settings:read'],
    readOnlyHint: true,
    call(context) {
      return context.client.fetchCloudConfig();
    },
  },
  {
    name: 'cloud_config_update',
    description: 'Update cloud config snapshot.',
    requiredScopes: ['settings:write'],
    call(context, args) {
      return context.client.saveCloudConfig(args as Record<string, unknown>);
    },
  },
];
