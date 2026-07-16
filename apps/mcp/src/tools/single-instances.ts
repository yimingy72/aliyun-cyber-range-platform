import type { ToolDefinition } from './tool-context';

const operation = (args: { idempotencyKey?: string; confirmationId?: string }) => ({
  idempotencyKey: args.idempotencyKey,
  confirmationId: args.confirmationId,
});

export const singleInstanceTools: ToolDefinition[] = [
  {
    name: 'single_instance_list',
    description: 'List single instances and batches.',
    requiredScopes: ['instances:read'],
    readOnlyHint: true,
    call(context, args) {
      return context.client.listSingleInstances((args as { view?: 'active' | 'history' }).view ?? 'active');
    },
  },
  {
    name: 'single_instance_get',
    description: 'Get a single instance by id.',
    requiredScopes: ['instances:read'],
    readOnlyHint: true,
    call(context, args) {
      return context.client.getSingleInstance((args as { singleInstanceId: string }).singleInstanceId);
    },
  },
  {
    name: 'single_instance_get_access',
    description: 'Get access metadata for a single instance.',
    requiredScopes: ['instances:read', 'instances:credentials:read'],
    readOnlyHint: true,
    call(context, args) {
      return context.client.getSingleInstanceAccess((args as { singleInstanceId: string }).singleInstanceId);
    },
  },
  {
    name: 'single_instance_batch_launch',
    description: 'Launch one or more single instances from an image.',
    requiredScopes: ['instances:create'],
    call(context, args) {
      const input = args as {
        name: string;
        hostName?: string;
        platformImageAssetId: string;
        cpu: number;
        memory: number;
        systemDiskSize?: number;
        expiresAt: string;
        password?: string;
        quantity: number;
        remark?: string;
        idempotencyKey?: string;
        confirmationId?: string;
      };
      return context.client.launchSingleInstances(
        {
          name: input.name,
          hostName: input.hostName,
          platformImageAssetId: input.platformImageAssetId,
          cpu: input.cpu,
          memory: input.memory,
          systemDiskSize: input.systemDiskSize,
          expiresAt: input.expiresAt,
          password: input.password,
          quantity: input.quantity,
          remark: input.remark,
        },
        operation(input),
      );
    },
  },
  {
    name: 'single_instance_destroy',
    description: 'Destroy a single instance.',
    requiredScopes: ['instances:destroy'],
    call(context, args) {
      const input = args as { singleInstanceId: string; idempotencyKey?: string; confirmationId?: string };
      return context.client.destroySingleInstance(input.singleInstanceId, operation(input));
    },
  },
  {
    name: 'single_instance_batch_destroy',
    description: 'Destroy all instances in a batch.',
    requiredScopes: ['instances:destroy'],
    call(context, args) {
      const input = args as { batchId: string; idempotencyKey?: string; confirmationId?: string };
      return context.client.destroySingleInstanceBatch(input.batchId, operation(input));
    },
  },
  {
    name: 'single_instance_retry',
    description: 'Retry a failed single instance job.',
    requiredScopes: ['instances:control'],
    call(context, args) {
      const input = args as { singleInstanceId: string; idempotencyKey?: string; confirmationId?: string };
      return context.client.retrySingleInstance(input.singleInstanceId, operation(input));
    },
  },
  {
    name: 'single_instance_reboot',
    description: 'Reboot a single instance.',
    requiredScopes: ['instances:control'],
    call(context, args) {
      const input = args as {
        singleInstanceId: string;
        displayName?: string;
        defaultHostName?: string;
        defaultPassword?: string;
        description?: string;
        idempotencyKey?: string;
        confirmationId?: string;
      };
      return context.client.rebootSingleInstance(
        input.singleInstanceId,
        {
          displayName: input.displayName,
          defaultHostName: input.defaultHostName,
          defaultPassword: input.defaultPassword,
          description: input.description,
        },
        operation(input),
      );
    },
  },
  {
    name: 'single_instance_open_vnc',
    description: 'Open VNC for a single instance.',
    requiredScopes: ['instances:control', 'instances:credentials:read'],
    call(context, args) {
      const input = args as {
        singleInstanceId: string;
        displayName?: string;
        defaultHostName?: string;
        defaultPassword?: string;
        description?: string;
      };
      return context.client.openSingleInstanceVnc(input.singleInstanceId, {
        displayName: input.displayName,
        defaultHostName: input.defaultHostName,
        defaultPassword: input.defaultPassword,
        description: input.description,
      });
    },
  },
  {
    name: 'single_instance_pack_image',
    description: 'Pack a single instance into an image.',
    requiredScopes: ['instances:control'],
    call(context, args) {
      const input = args as {
        singleInstanceId: string;
        displayName?: string;
        defaultHostName?: string;
        defaultPassword?: string;
        description?: string;
        idempotencyKey?: string;
        confirmationId?: string;
      };
      return context.client.packSingleInstanceImage(
        input.singleInstanceId,
        {
          displayName: input.displayName,
          defaultHostName: input.defaultHostName,
          defaultPassword: input.defaultPassword,
          description: input.description,
        },
        operation(input),
      );
    },
  },
];
