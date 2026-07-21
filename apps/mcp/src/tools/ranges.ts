import type { ToolDefinition } from './tool-context';
import {
  rangeDestroyInputSchema,
  rangeInstanceIdInputSchema,
  rangeLaunchInputSchema,
  rangeListInputSchema,
} from './input-schemas';

const operation = (args: { idempotencyKey?: string; confirmationId?: string }) => ({
  idempotencyKey: args.idempotencyKey,
  confirmationId: args.confirmationId,
});

export const rangeTools: ToolDefinition[] = [
  {
    name: 'range_instance_list',
    description: 'List range instances.',
    requiredScopes: ['ranges:read'],
    readOnlyHint: true,
    inputSchema: rangeListInputSchema,
    call(context, args) {
      return context.client.listRangeInstances((args as { view?: 'active' | 'history' }).view ?? 'active');
    },
  },
  {
    name: 'range_instance_get',
    description: 'Get a range instance by id.',
    requiredScopes: ['ranges:read'],
    readOnlyHint: true,
    inputSchema: rangeInstanceIdInputSchema,
    call(context, args) {
      return context.client.getRangeInstance((args as { rangeInstanceId: string }).rangeInstanceId);
    },
  },
  {
    name: 'range_instance_get_access',
    description: 'Get access metadata for a range instance.',
    requiredScopes: ['ranges:read', 'instances:credentials:read'],
    readOnlyHint: true,
    inputSchema: rangeInstanceIdInputSchema,
    call(context, args) {
      return context.client.getRangeInstanceAccess((args as { rangeInstanceId: string }).rangeInstanceId);
    },
  },
  {
    name: 'range_instance_launch',
    description: 'Launch a new range instance from a template.',
    requiredScopes: ['ranges:create'],
    inputSchema: rangeLaunchInputSchema,
    call(context, args) {
      const input = args as { templateId: string; name: string; expiresAt: string; idempotencyKey?: string; confirmationId?: string };
      return context.client.launchRange(
        { templateId: input.templateId, name: input.name, expiresAt: input.expiresAt },
        operation(input),
      );
    },
  },
  {
    name: 'range_instance_destroy',
    description: 'Destroy a range instance.',
    requiredScopes: ['ranges:destroy'],
    inputSchema: rangeDestroyInputSchema,
    call(context, args) {
      const input = args as { rangeInstanceId: string; idempotencyKey?: string; confirmationId?: string };
      return context.client.destroyRange(input.rangeInstanceId, operation(input));
    },
  },
];
