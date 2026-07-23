import type { ToolDefinition } from './tool-context';
import { cloudConfigGetInputSchema, cloudConfigUpdateInputSchema } from './input-schemas';

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
    inputSchema: cloudConfigGetInputSchema,
    call(context) {
      return context.client.fetchCloudConfig();
    },
  },
  {
    name: 'cloud_config_update',
    description: 'Update cloud config snapshot.',
    requiredScopes: ['settings:write'],
    inputSchema: cloudConfigUpdateInputSchema,
    call(context, args) {
      const { idempotencyKey, confirmationId, ...payload } = args as Record<string, unknown> & {
        idempotencyKey?: string;
        confirmationId?: string;
      };
      return context.client.saveCloudConfig(payload, operation({ idempotencyKey, confirmationId }));
    },
  },
];
