import type { ToolDefinition } from './tool-context';
import * as z from 'zod/v4';

const operation = (args: { idempotencyKey?: string; confirmationId?: string }) => ({
  idempotencyKey: args.idempotencyKey,
  confirmationId: args.confirmationId,
});

function escapeCsvCell(value: string) {
  const normalizedValue = value.replaceAll('"', '""');
  return /[",\n]/.test(normalizedValue) ? `"${normalizedValue}"` : normalizedValue;
}

function readSingleInstanceCredential(instance: Record<string, unknown>) {
  const config = (instance.singleInstanceConfig ?? null) as Record<string, unknown> | null;
  const runtimeCredentials = (instance.runtimeCredentials ?? null) as Record<string, Record<string, unknown>> | null;
  const hostKey = typeof config?.hostKey === 'string' && config.hostKey.trim() ? config.hostKey.trim() : Object.keys(runtimeCredentials ?? {})[0] ?? '';
  const credential = hostKey ? runtimeCredentials?.[hostKey] : null;
  const username = typeof credential?.username === 'string' ? credential.username.trim() : '';
  const password = typeof credential?.password === 'string' ? credential.password.trim() : '';
  const imageName = String(config?.imageDisplayName ?? config?.imageId ?? '').toLowerCase();
  const normalizedUsername = username === 'root' && imageName.includes('windows') ? 'Administrator' : username;

  return {
    username: normalizedUsername || '暂无',
    password: password || '暂无',
  };
}

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
    name: 'single_instance_spec_check',
    description:
      'Validate that an exact CPU and memory specification is supported by the single-instance executor and currently available in the configured zone before launch. exactAvailable=false means launch must not be requested; a successful check does not reserve capacity.',
    requiredScopes: ['instances:read'],
    readOnlyHint: true,
    inputSchema: z.object({
      cpu: z.number().int().positive().describe('CPU cores'),
      memory: z.number().int().positive().describe('Memory in GiB'),
    }),
    call(context, args) {
      const input = args as { cpu: number; memory: number };
      return context.client.getInstanceTypeAvailability(input.cpu, input.memory);
    },
  },
  {
    name: 'single_instance_batch_launch',
    description:
      'Launch one or more single instances from an image. expiresAt is optional and defaults to eight hours from the first request; when confirmation is required, repeat the exact expiresAt returned in the confirmation summary. The server validates the exact CPU and memory specification again before forwarding the launch request.',
    requiredScopes: ['instances:read', 'instances:create'],
    async call(context, args) {
      const input = args as {
        name: string;
        hostName?: string;
        platformImageAssetId: string;
        cpu: number;
        memory: number;
        systemDiskSize?: number;
        expiresAt?: string;
        password?: string;
        quantity: number;
        remark?: string;
        idempotencyKey?: string;
        confirmationId?: string;
      };
      const availability = await context.client.getInstanceTypeAvailability(input.cpu, input.memory);

      if (availability.exactAvailable !== true) {
        throw new Error(
          availability.warning ?? `The requested ${input.cpu} CPU / ${input.memory} GiB specification is not currently available.`,
        );
      }

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
  {
    name: 'single_instance_batch_export_csv',
    description: 'Export a batch of single instances as CSV.',
    requiredScopes: ['instances:read', 'instances:credentials:read'],
    readOnlyHint: true,
    async call(context, args) {
      const input = args as { batchId: string; view?: 'active' | 'history' };
      const lists = input.view ? [await context.client.listSingleInstances(input.view)] : await Promise.all([
        context.client.listSingleInstances('active'),
        context.client.listSingleInstances('history'),
      ]);
      const group = lists.flatMap((list) => list.batches).find((entry) => entry.batch.id === input.batchId);

      if (!group) {
        throw new Error('Single instance batch not found');
      }

      const rows = group.instances.map((instance) => {
        const credential = readSingleInstanceCredential(instance as Record<string, unknown>);
        const accessEntry = (instance.accessEntry ?? null) as Record<string, unknown> | null;
        const publicIp = typeof accessEntry?.publicIp === 'string' && accessEntry.publicIp.trim() ? accessEntry.publicIp.trim() : '暂无';
        const name = typeof instance.name === 'string' && instance.name.trim() ? instance.name.trim() : instance.id;

        return [name, publicIp, credential.username, credential.password].map(escapeCsvCell).join(',');
      });
      const csv = [['实例名', '公网 IP', '账号', '密码'].join(','), ...rows].join('\n');
      const batchName = typeof group.batch.name === 'string' && group.batch.name.trim() ? group.batch.name.trim() : group.batch.id;

      return {
        batchId: group.batch.id,
        batchName,
        fileName: `${batchName}-instances.csv`,
        rowCount: group.instances.length,
        csv,
      };
    },
  },
];
