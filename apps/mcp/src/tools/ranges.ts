import type { RangeInstanceNodeActionPayload } from '@aliyun-cyber-range/platform-api-client';
import type { ScenarioGraphDraft } from '@aliyun-cyber-range/scenario-runtime';

import {
  compileTemplateTopology,
  type TemplateAuthoringMetadata,
} from './template-authoring';
import {
  rangeDeleteFailedInputSchema,
  rangeDestroyInputSchema,
  rangeInstanceIdInputSchema,
  rangeLaunchInputSchema,
  rangeListInputSchema,
  rangeNodeActionInputSchema,
  rangeNodeOpenVncInputSchema,
  rangeRetryInputSchema,
  rangeTopologyChangeInputSchema,
} from './input-schemas';
import type { ToolDefinition } from './tool-context';

const operation = (args: { idempotencyKey?: string; confirmationId?: string }) => ({
  idempotencyKey: args.idempotencyKey,
  confirmationId: args.confirmationId,
});

export const rangeTools: ToolDefinition[] = [
  {
    name: 'range_instance_list',
    title: '查询编排实例',
    description: '对应编排实例页的“实例列表/实例历史”。查询当前用户可见的综合靶场实例；view=active 查询未销毁实例，view=history 查询已销毁历史。',
    requiredScopes: ['ranges:read'],
    readOnlyHint: true,
    inputSchema: rangeListInputSchema,
    async call(context, args) {
      return redactRangeInstanceSecrets(
        await context.client.listRangeInstances((args as { view?: 'active' | 'history' }).view ?? 'active'),
      );
    },
  },
  {
    name: 'range_instance_get',
    title: '获取编排实例详情',
    description: '对应编排实例页的“查看详情”。返回实例状态、已保存的运行拓扑和资源摘要；运行凭据与密码不会在此工具返回。',
    requiredScopes: ['ranges:read'],
    readOnlyHint: true,
    inputSchema: rangeInstanceIdInputSchema,
    async call(context, args) {
      return redactRangeInstanceSecrets(
        await context.client.getRangeInstance((args as { rangeInstanceId: string }).rangeInstanceId),
      );
    },
  },
  {
    name: 'range_instance_get_access',
    title: '获取编排实例访问入口',
    description: '获取综合靶场的 SSH、VNC 或运行凭据等敏感访问数据。仅在用户明确要求访问时调用，结果不得转发或记录到非必要位置。',
    requiredScopes: ['ranges:read', 'instances:credentials:read'],
    readOnlyHint: true,
    inputSchema: rangeInstanceIdInputSchema,
    call(context, args) {
      return context.client.getRangeInstanceAccess((args as { rangeInstanceId: string }).rangeInstanceId);
    },
  },
  {
    name: 'range_instance_launch',
    title: '启动编排实例',
    description: '对应从模板“生成实例”。基于已发布到平台或当前用户可使用的模板启动一整套综合靶场，必须提供名称和到期时间；该操作会创建云资源，调用前必须取得用户确认。',
    requiredScopes: ['ranges:create'],
    annotations: { destructiveHint: false, idempotentHint: false },
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
    name: 'range_instance_topology_save',
    title: '保存编排实例变更',
    description: '对应编排实例详情页“保存草稿”。接收完整 topologyGraph，在 MCP 内部编译为运行拓扑和部署规格后保存，不会立即修改云资源。',
    requiredScopes: ['ranges:write'],
    annotations: { idempotentHint: false },
    inputSchema: rangeTopologyChangeInputSchema,
    async call(context, args) {
      const input = args as RangeTopologyChangeInput;
      const saved = await saveRangeInstanceTopology(context, input);
      return redactRangeInstanceSecrets(saved);
    },
  },
  {
    name: 'range_instance_topology_apply',
    title: '应用编排实例变更',
    description: '对应编排实例详情页“应用变更”。先编译并保存完整 topologyGraph，再提交更新作业把变更应用到运行中的综合靶场；会修改云资源，调用前必须取得用户确认。',
    requiredScopes: ['ranges:write', 'ranges:control'],
    annotations: { destructiveHint: false, idempotentHint: false },
    inputSchema: rangeTopologyChangeInputSchema,
    async call(context, args) {
      const input = args as RangeTopologyChangeInput;
      await saveRangeInstanceTopology(context, input);
      return context.client.applyRangeInstanceDraft(input.rangeInstanceId, operation(input));
    },
  },
  {
    name: 'range_instance_sync_template',
    title: '同步实例变更到模板',
    description: '对应编排实例详情页“更新编排拓扑”。先编译并保存完整 topologyGraph，再将当前实例配置同步回其来源模板的已保存拓扑；不会自动修改运行实例，调用前必须取得用户确认。',
    requiredScopes: ['ranges:write', 'templates:write'],
    annotations: { destructiveHint: false, idempotentHint: false },
    inputSchema: rangeTopologyChangeInputSchema,
    async call(context, args) {
      const input = args as RangeTopologyChangeInput;
      await saveRangeInstanceTopology(context, input);
      return context.client.syncRangeInstanceTemplate(input.rangeInstanceId, operation(input));
    },
  },
  {
    name: 'range_instance_retry',
    title: '重试编排实例任务',
    description: '对应编排实例页失败后的“重试”。仅在创建或销毁失败时重试最近的开通/回收任务；会再次执行云资源操作，调用前必须取得用户确认。',
    requiredScopes: ['ranges:control'],
    annotations: { destructiveHint: false, idempotentHint: false },
    inputSchema: rangeRetryInputSchema,
    call(context, args) {
      const input = args as RangeOperationInput;
      return context.client.retryRangeInstance(input.rangeInstanceId, operation(input));
    },
  },
  nodeActionTool('range_instance_node_start', '开机编排节点', 'start', '对应实例详情中 ECS 节点“开机”。向阿里云提交开机指令，调用前必须取得用户确认。'),
  nodeActionTool('range_instance_node_stop', '关机编排节点', 'stop', '对应实例详情中 ECS 节点“关机”。向阿里云提交强制关机指令，调用前必须取得用户确认。'),
  nodeActionTool('range_instance_node_reboot', '重启编排节点', 'reboot', '对应实例详情中 ECS 节点“重启”。向阿里云提交强制重启指令，调用前必须取得用户确认。'),
  {
    name: 'range_instance_node_open_vnc',
    title: '打开编排节点 VNC',
    description: '对应实例详情中 ECS 节点“VNC”。返回临时 VNC 访问地址，属于敏感访问数据；仅在用户明确请求时调用。',
    requiredScopes: ['ranges:read', 'instances:credentials:read'],
    readOnlyHint: true,
    inputSchema: rangeNodeOpenVncInputSchema,
    call(context, args) {
      const input = args as { rangeInstanceId: string; nodeId: string };
      return context.client.runRangeInstanceNodeAction(input.rangeInstanceId, input.nodeId, 'open-vnc');
    },
  },
  {
    name: 'range_instance_node_pack_image',
    title: '打包编排节点镜像',
    description: '对应实例详情中 ECS 节点“打包镜像”。从节点创建私有平台镜像；可选提供镜像名称、默认主机名、默认密码和描述。该操作创建云镜像资产，调用前必须取得用户确认。',
    requiredScopes: ['ranges:control', 'images:write'],
    annotations: { destructiveHint: false, idempotentHint: false },
    inputSchema: rangeNodeActionInputSchema,
    async call(context, args) {
      const input = args as RangeNodeActionInput;
      return redactRangeInstanceSecrets(
        await context.client.runRangeInstanceNodeAction(
          input.rangeInstanceId,
          input.nodeId,
          'pack-image',
          nodeActionPayload(input),
          operation(input),
        ),
      );
    },
  },
  {
    name: 'range_instance_destroy',
    title: '销毁编排实例',
    description: '对应编排实例页“关闭/销毁”。提交整套综合靶场的回收任务，释放其云资源；该操作不可逆，调用前必须取得用户确认。',
    requiredScopes: ['ranges:destroy'],
    annotations: { destructiveHint: true, idempotentHint: false },
    inputSchema: rangeDestroyInputSchema,
    call(context, args) {
      const input = args as { rangeInstanceId: string; idempotencyKey?: string; confirmationId?: string };
      return context.client.destroyRange(input.rangeInstanceId, operation(input));
    },
  },
  {
    name: 'range_instance_delete_failed',
    title: '删除创建失败的编排实例',
    description: '对应编排实例页中创建失败记录的“删除”。仅能删除 create_failed 状态且尚未形成可运行环境的实例记录；该操作不可恢复，调用前必须取得用户确认。',
    requiredScopes: ['ranges:delete'],
    annotations: { destructiveHint: true, idempotentHint: false },
    inputSchema: rangeDeleteFailedInputSchema,
    async call(context, args) {
      const input = args as RangeOperationInput;
      await context.client.removeFailedRangeInstance(input.rangeInstanceId, operation(input));
      return { removed: true, rangeInstanceId: input.rangeInstanceId };
    },
  },
];

type RangeOperationInput = {
  rangeInstanceId: string;
  idempotencyKey?: string;
  confirmationId?: string;
};

type RangeTopologyChangeInput = RangeOperationInput & {
  topologyGraph: ScenarioGraphDraft;
  primaryVpcCidr?: string;
  secondaryVpcCidrs?: string[];
  publicEntryProtocols?: TemplateAuthoringMetadata['publicEntryProtocols'];
};

type RangeNodeActionInput = RangeOperationInput & {
  nodeId: string;
} & RangeInstanceNodeActionPayload;

function nodeActionTool(
  name: string,
  title: string,
  action: 'start' | 'stop' | 'reboot',
  description: string,
): ToolDefinition {
  return {
    name,
    title,
    description,
    requiredScopes: ['ranges:control'],
    annotations: { destructiveHint: action === 'stop', idempotentHint: false },
    inputSchema: rangeNodeActionInputSchema,
    call(context, args) {
      const input = args as RangeNodeActionInput;
      return context.client.runRangeInstanceNodeAction(
        input.rangeInstanceId,
        input.nodeId,
        action,
        nodeActionPayload(input),
        operation(input),
      );
    },
  };
}

async function saveRangeInstanceTopology(
  context: Parameters<ToolDefinition['call']>[0],
  input: RangeTopologyChangeInput,
) {
  const instance = await context.client.getRangeInstance(input.rangeInstanceId);
  const metadata = {
    ...metadataFromRangeInstance(instance),
    ...(input.primaryVpcCidr ? { primaryVpcCidr: input.primaryVpcCidr } : {}),
    ...(input.secondaryVpcCidrs ? { secondaryVpcCidrs: input.secondaryVpcCidrs } : {}),
    ...(input.publicEntryProtocols ? { publicEntryProtocols: input.publicEntryProtocols } : {}),
  };
  const compiled = compileTemplateTopology(input.topologyGraph, metadata);

  return context.client.saveRangeInstanceDraft(
    input.rangeInstanceId,
    {
      draftTopologyGraph: compiled.topologyGraph,
      draftScenarioTemplateSpec: compiled.scenarioTemplateSpec,
      draftCompiledProvisionSpec: compiled.compiledProvisionSpec,
    },
    operation(input),
  );
}

function metadataFromRangeInstance(instance: Record<string, unknown>): TemplateAuthoringMetadata {
  const scenarioTemplateSpec =
    asRecord(instance.draftScenarioTemplateSpec) ??
    asRecord(instance.runtimeScenarioTemplateSpec) ??
    {};
  const metadata = asRecord(scenarioTemplateSpec.metadata) ?? {};
  const topology = asRecord(scenarioTemplateSpec.topology) ?? {};

  return {
    name: readString(metadata.name) ?? readString(instance.name) ?? 'range-instance',
    slug: readString(metadata.slug) ?? readString(instance.id) ?? 'range-instance',
    version: readString(metadata.version) ?? 'v1',
    cloudProvider: metadata.cloudProvider === 'alibaba_cloud' ? 'alibaba_cloud' : 'alibaba_cloud',
    iacType: metadata.iacType === 'terraform' ? 'terraform' : 'opentofu',
    description: readString(metadata.description),
    modulePathOrRef: 'runtime/range-instance',
    primaryVpcCidr: readString(topology.vpcCidr),
    secondaryVpcCidrs: Array.isArray(topology.secondaryVpcCidrs)
      ? topology.secondaryVpcCidrs.filter((value): value is string => typeof value === 'string')
      : undefined,
    defaultRegion: readString(topology.defaultRegion),
    defaultZoneId: readString(topology.defaultZoneId),
  };
}

function nodeActionPayload(input: RangeNodeActionInput): RangeInstanceNodeActionPayload {
  return {
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.defaultHostName ? { defaultHostName: input.defaultHostName } : {}),
    ...(input.defaultPassword ? { defaultPassword: input.defaultPassword } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readString(value: unknown) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function redactRangeInstanceSecrets<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(redactRangeInstanceSecrets) as T;
  }
  if (!value || typeof value !== 'object') {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key.toLowerCase() !== 'runtimecredentials')
      .filter(([key]) => !['password', 'custompassword', 'defaultpassword'].includes(key.toLowerCase()))
      .map(([key, child]) => [key, redactRangeInstanceSecrets(child)]),
  ) as T;
}
