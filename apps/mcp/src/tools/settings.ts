import type { ToolDefinition } from './tool-context';

const operation = (args: { idempotencyKey?: string; confirmationId?: string }) => ({
  idempotencyKey: args.idempotencyKey,
  confirmationId: args.confirmationId,
});

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
      return context.client.saveCloudConfig(args as Record<string, unknown>, operation(args as { idempotencyKey?: string; confirmationId?: string }));
    },
  },
];
