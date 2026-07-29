import type { ToolDefinition } from './tool-context';
import * as z from 'zod/v4';
import {
  singleInstanceBatchDestroyInputSchema,
  singleInstanceBatchExportCsvInputSchema,
  singleInstanceDestroyInputSchema,
  singleInstanceIdInputSchema,
  singleInstanceLaunchInputSchema,
  singleInstanceListInputSchema,
  singleInstanceOpenVncInputSchema,
  singleInstancePackImageInputSchema,
  singleInstanceRebootInputSchema,
  singleInstanceRetryInputSchema,
} from './input-schemas';
import {
  actionOutputSchema,
  csvExportOutputSchema,
  nullableResourceOutputSchema,
  resourceSchema,
  resultOutputSchema,
} from './output-schemas';

const operation = (args: { idempotencyKey?: string; confirmationId?: string }) => ({
  idempotencyKey: args.idempotencyKey,
  confirmationId: args.confirmationId,
});

const singleInstanceListOutputSchema = resultOutputSchema(
  z.object({
    batches: z.array(
      z.object({
        batch: resourceSchema.describe('实例批次信息。'),
        instances: z.array(resourceSchema).describe('该批次中的独立实例。'),
      }),
    ),
    standaloneInstances: z.array(resourceSchema).describe('不属于批次的独立实例。'),
  }),
);

const singleInstanceAccessOutputSchema = resultOutputSchema(
  z.object({
    publicIp: z.string().nullable().optional().describe('公网访问地址。'),
    privateIp: z.string().nullable().optional().describe('私网地址。'),
  }).passthrough(),
);

const singleInstanceCloudResourceStatusOutputSchema = resultOutputSchema(
  z.object({
    singleInstanceId: z.string().describe('平台独立实例 ID。'),
    regionId: z.string().describe('执行阿里云查询的地域。'),
    exists: z.boolean().describe('阿里云中是否仍存在带该 RangeInstanceId 标签的 ECS。'),
    instanceIds: z.array(z.string()).describe('当前匹配标签的 ECS 实例 ID 列表。'),
    checkedAt: z.string().describe('平台完成云端查询的 ISO-8601 时间。'),
  }),
);

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
    title: '查询独立实例',
    description: '对应实例管理页的实例列表和历史。返回当前调用者可见的独立实例及其批次；view=active 查询当前实例，view=history 查询历史记录。',
    requiredScopes: ['instances:read'],
    readOnlyHint: true,
    inputSchema: singleInstanceListInputSchema,
    outputSchema: singleInstanceListOutputSchema,
    call(context, args) {
      return context.client.listSingleInstances((args as { view?: 'active' | 'history' }).view ?? 'active');
    },
  },
  {
    name: 'single_instance_get',
    title: '获取独立实例详情',
    description: '根据独立实例 ID 查询详情。详情不等同于访问凭据；需要 SSH、VNC 或密码时使用对应敏感工具。',
    requiredScopes: ['instances:read'],
    readOnlyHint: true,
    inputSchema: singleInstanceIdInputSchema,
    outputSchema: nullableResourceOutputSchema,
    call(context, args) {
      return context.client.getSingleInstance((args as { singleInstanceId: string }).singleInstanceId);
    },
  },
  {
    name: 'single_instance_cloud_resource_status',
    title: '核验独立实例云资源',
    description:
      '按独立实例的 RangeInstanceId 标签查询阿里云 ECS 是否仍存在。该工具只读取云资源状态，不会创建、停止或释放任何资源。',
    requiredScopes: ['instances:read'],
    readOnlyHint: true,
    inputSchema: singleInstanceIdInputSchema,
    outputSchema: singleInstanceCloudResourceStatusOutputSchema,
    call(context, args) {
      return context.client.getSingleInstanceCloudResourceStatus(
        (args as { singleInstanceId: string }).singleInstanceId,
      );
    },
  },
  {
    name: 'single_instance_get_access',
    title: '获取独立实例访问入口',
    description: '获取独立实例的 SSH、VNC 或运行凭据等敏感访问数据。仅在用户明确要求访问时调用，结果不得转发或记录到非必要位置。',
    requiredScopes: ['instances:read', 'instances:credentials:read'],
    readOnlyHint: true,
    inputSchema: singleInstanceIdInputSchema,
    outputSchema: singleInstanceAccessOutputSchema,
    call(context, args) {
      return context.client.getSingleInstanceAccess((args as { singleInstanceId: string }).singleInstanceId);
    },
  },
  {
    name: 'single_instance_spec_check',
    title: '校验独立实例规格',
    description:
      '在创建独立实例前校验指定 CPU 和内存是否存在精确匹配且在默认可用区可用的实例规格。exactAvailable=false 时不得提交创建；校验成功不代表预留库存。',
    requiredScopes: ['instances:read'],
    readOnlyHint: true,
    inputSchema: z.object({
      cpu: z.number().int().positive().describe('CPU cores'),
      memory: z.number().int().positive().describe('Memory in GiB'),
    }),
    outputSchema: resultOutputSchema(
      z.object({
        cpu: z.number().int().positive().describe('请求的 CPU 核数。'),
        memory: z.number().int().positive().describe('请求的内存 GiB。'),
        regionId: z.string().describe('已校验地域。'),
        zoneId: z.string().describe('已校验可用区。'),
        exactAvailable: z.boolean().describe('是否存在完全匹配且当前可用的规格。'),
        matches: z.array(z.object({ instanceTypeId: z.string(), cpu: z.number(), memoryGiB: z.number() }).passthrough()),
        warning: z.string().nullable().describe('不可用或风险说明。'),
      }),
    ),
    call(context, args) {
      const input = args as { cpu: number; memory: number };
      return context.client.getInstanceTypeAvailability(input.cpu, input.memory);
    },
  },
  {
    name: 'single_instance_batch_launch',
    title: '批量创建独立实例',
    description:
      '对应实例管理页的“创建实例”。基于平台镜像创建一台或多台独立靶机；必须先通过精确规格校验。该操作会创建云资源，调用前必须取得用户确认。',
    requiredScopes: ['instances:read', 'instances:create'],
    inputSchema: singleInstanceLaunchInputSchema,
    outputSchema: actionOutputSchema,
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
    title: '销毁独立实例',
    description: '对应实例管理页的单台“销毁”。提交回收任务并释放该实例的云资源；操作不可恢复，调用前必须取得用户确认。',
    requiredScopes: ['instances:destroy'],
    annotations: { destructiveHint: true, idempotentHint: false },
    inputSchema: singleInstanceDestroyInputSchema,
    outputSchema: actionOutputSchema,
    call(context, args) {
      const input = args as { singleInstanceId: string; idempotencyKey?: string; confirmationId?: string };
      return context.client.destroySingleInstance(input.singleInstanceId, operation(input));
    },
  },
  {
    name: 'single_instance_batch_destroy',
    title: '销毁独立实例批次',
    description: '对应实例管理页的批次“全部销毁”。回收指定批次中的全部独立实例；操作不可恢复，调用前必须取得用户确认。',
    requiredScopes: ['instances:destroy'],
    annotations: { destructiveHint: true, idempotentHint: false },
    inputSchema: singleInstanceBatchDestroyInputSchema,
    outputSchema: actionOutputSchema,
    call(context, args) {
      const input = args as { batchId: string; idempotencyKey?: string; confirmationId?: string };
      return context.client.destroySingleInstanceBatch(input.batchId, operation(input));
    },
  },
  {
    name: 'single_instance_retry',
    title: '重试独立实例任务',
    description: '对应实例管理页失败后的“重试”。仅用于创建或销毁失败的独立实例任务，不可替代正常重启；调用前必须取得用户确认。',
    requiredScopes: ['instances:control'],
    annotations: { idempotentHint: false },
    inputSchema: singleInstanceRetryInputSchema,
    outputSchema: actionOutputSchema,
    call(context, args) {
      const input = args as { singleInstanceId: string; idempotencyKey?: string; confirmationId?: string };
      return context.client.retrySingleInstance(input.singleInstanceId, operation(input));
    },
  },
  {
    name: 'single_instance_reboot',
    title: '重启独立实例',
    description: '对应实例管理页的“重启”。仅针对运行中的独立实例提交重启指令；调用前必须取得用户确认。',
    requiredScopes: ['instances:control'],
    annotations: { idempotentHint: false },
    inputSchema: singleInstanceRebootInputSchema,
    outputSchema: actionOutputSchema,
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
    title: '打开独立实例 VNC',
    description: '对应实例管理页的“VNC”。返回临时 VNC 访问数据，属于敏感输出；仅在用户明确请求访问时调用。',
    requiredScopes: ['instances:control', 'instances:credentials:read'],
    inputSchema: singleInstanceOpenVncInputSchema,
    outputSchema: actionOutputSchema,
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
    title: '打包独立实例镜像',
    description: '对应实例管理页的“打包镜像”。从独立实例创建私有平台镜像资产；可能创建云镜像，调用前必须取得用户确认。',
    requiredScopes: ['instances:control'],
    annotations: { idempotentHint: false },
    inputSchema: singleInstancePackImageInputSchema,
    outputSchema: actionOutputSchema,
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
    title: '导出独立实例凭据 CSV',
    description: '对应实例管理页的“导出凭据”。生成指定批次的实例名、IP、账号和密码 CSV，属于敏感输出；仅在用户明确授权导出时调用。',
    requiredScopes: ['instances:read', 'instances:credentials:read'],
    readOnlyHint: true,
    inputSchema: singleInstanceBatchExportCsvInputSchema,
    outputSchema: csvExportOutputSchema,
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
