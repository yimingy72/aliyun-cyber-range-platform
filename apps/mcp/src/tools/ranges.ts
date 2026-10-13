import type { RangeInstanceNodeActionPayload } from '@aliyun-cyber-range/platform-api-client';
import type { ScenarioGraphDraft } from '@aliyun-cyber-range/scenario-runtime';

import {
  compileTemplateTopology,
  type TemplateAuthoringMetadata,
} from './template-authoring';
import { resolveToolImageOsHints } from './template-image-os-hints';
import {
  rangeDestroyInputSchema,
  rangeInstanceIdInputSchema,
  rangeInstanceGetInputSchema,
  rangeLaunchInputSchema,
  rangeListInputSchema,
  rangeNodeActionInputSchema,
  rangeNodePackImageInputSchema,
  rangeNodeVerifyDnsInputSchema,
  rangeNodeOpenVncInputSchema,
  rangeNodePackImageValidateInputSchema,
  rangeRetryInputSchema,
  rangeTopologyChangeInputSchema,
  rangeSyncTemplateInputSchema,
  rangeSaveAsTemplateInputSchema,
  rangeTopologyPreviewInputSchema,
  rangeTopologyApplyInputSchema,
} from './input-schemas';
import {
  actionOutputSchema,
  rangeInstanceDetailOutputSchema,
  resourceListOutputSchema,
  resourceOutputSchema,
  resultOutputSchema,
} from './output-schemas';
import type { ToolDefinition } from './tool-context';
import * as z from 'zod/v4';

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
    outputSchema: resourceListOutputSchema,
    async call(context, args) {
      return redactRangeInstanceSecrets(
        await context.client.listRangeInstances((args as { view?: 'active' | 'history' }).view ?? 'active'),
      );
    },
  },
  {
    name: 'range_instance_get',
    title: '获取编排实例详情',
    description: '对应编排实例页的“查看详情”。返回实例状态、已保存拓扑和资源摘要，以及同来源打包的安全阶段/错误类别与每个原源盘的快照候选和官方 RequestId；候选所有权未确认，不等于可接管或已完整清理。includeNetworkDiagnostics=true 时附加原账号/地域只读网络诊断。由服务端校验 owner/admin，不接受任意云资源 ID，运行凭据与密码不返回。',
    requiredScopes: ['ranges:read'],
    readOnlyHint: true,
    inputSchema: rangeInstanceGetInputSchema,
    outputSchema: rangeInstanceDetailOutputSchema,
    async call(context, args) {
      const input = args as { rangeInstanceId: string; includeNetworkDiagnostics?: boolean };
      return redactRangeInstanceSecrets(
        await context.client.getRangeInstance(input.rangeInstanceId, input.includeNetworkDiagnostics === undefined
          ? undefined
          : { includeNetworkDiagnostics: input.includeNetworkDiagnostics }),
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
    outputSchema: resultOutputSchema(
      z.object({
        publicIp: z.string().nullable().optional().describe('公网访问地址。'),
        privateIp: z.string().nullable().optional().describe('私网地址。'),
      }).passthrough(),
    ),
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
    outputSchema: resourceOutputSchema,
    async call(context, args) {
      const input = args as { templateId: string; name: string; expiresAt: string; idempotencyKey?: string; confirmationId?: string };
      return withResourceId(
        await context.client.launchRange(
          { templateId: input.templateId, name: input.name, expiresAt: input.expiresAt },
          operation(input),
        ),
        'rangeInstanceId',
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
    outputSchema: resourceOutputSchema,
    async call(context, args) {
      const input = args as RangeTopologyChangeInput;
      const { saved } = await saveRangeInstanceTopology(context, input);
      return redactRangeInstanceSecrets(saved);
    },
  },
  {
    name: 'range_instance_topology_discard',
    title: '放弃编排实例草稿',
    description: '放弃指定准确版本的已保存草稿；不会应用云资源、修改运行拓扑或来源模板。草稿版本已变化时拒绝，刷新后再决定。',
    requiredScopes: ['ranges:write'],
    annotations: { destructiveHint: true, idempotentHint: false },
    inputSchema: rangeTopologyPreviewInputSchema,
    outputSchema: resourceOutputSchema,
    async call(context, args) {
      if (!context.client.discardRangeInstanceDraft) throw new Error('草稿放弃服务尚未配置');
      const input = args as { rangeInstanceId: string; expectedDraftRevision: number };
      return redactRangeInstanceSecrets(await context.client.discardRangeInstanceDraft(input.rangeInstanceId, input.expectedDraftRevision));
    },
  },
  {
    name: 'range_instance_topology_preview',
    title: '预览编排实例变更',
    description: '预览准确已保存草稿的预期主机增删、网络规则和 NAT/EIP 变化；这是平台配置差异摘要，不是实际 OpenTofu plan。生成五分钟有效的当前用户/账号空间预览令牌，随后确认应用。不会调用云 API 或创建云资源。',
    requiredScopes: ['ranges:read'], readOnlyHint: true,
    inputSchema: rangeTopologyPreviewInputSchema, outputSchema: resourceOutputSchema,
    call(context, args) {
      const input = args as { rangeInstanceId: string; expectedDraftRevision: number };
      return context.client.previewRangeInstanceDraft(input.rangeInstanceId, input.expectedDraftRevision);
    },
  },
  {
    name: 'range_instance_topology_apply',
    title: '应用已预览的编排实例变更',
    description: '应用准确已保存、已预览且确认的草稿；必须传原草稿版本和 previewToken，不接收新拓扑图。令牌失效或当前资源/配置变化时停止并重新预览。云更新失败不自动重新创建。',
    requiredScopes: ['ranges:write', 'ranges:control'],
    annotations: { destructiveHint: true, idempotentHint: false },
    inputSchema: rangeTopologyApplyInputSchema, outputSchema: actionOutputSchema,
    call(context, args) {
      const input = args as { rangeInstanceId: string; expectedDraftRevision: number; previewToken: string; idempotencyKey?: string; confirmationId?: string };
      return context.client.applyRangeInstanceDraft(input.rangeInstanceId, input.expectedDraftRevision, input.previewToken, operation(input));
    },
  },
  {
    name: 'range_instance_save_as_template',
    title: '另存实例草稿为新编排拓扑',
    description: '将准确已保存草稿另存为当前账号空间的新私有模板。不会修改来源模板、实例配置或云资源，也不复制云资源 ID、状态文件和运行密码；超时重放必须复用同一幂等键。',
    requiredScopes: ['ranges:read', 'templates:write'],
    annotations: { destructiveHint: false, idempotentHint: true },
    inputSchema: rangeSaveAsTemplateInputSchema,
    outputSchema: resourceOutputSchema,
    call(context, args) {
      const { rangeInstanceId, idempotencyKey, ...payload } = args as { rangeInstanceId: string; name: string; description?: string; expectedDraftRevision: number; idempotencyKey: string };
      return context.client.saveRangeInstanceAsTemplate(rangeInstanceId, payload, { idempotencyKey });
    },
  },
  {
    name: 'range_instance_sync_template',
    title: '同步已保存草稿到来源模板',
    description: '按准确草稿版本和来源模板版本，将已保存草稿同步回来源模板；先通过保存草稿工具完成编辑。本工具不接收新图、不隐式保存、不修改运行云资源。确认和重放保持相同版本，任一版本变化即拒绝。',
    requiredScopes: ['ranges:write', 'templates:write'],
    annotations: { destructiveHint: true, idempotentHint: false },
    inputSchema: rangeSyncTemplateInputSchema,
    outputSchema: resourceOutputSchema,
    async call(context, args) {
      const input = args as RangeOperationInput & { expectedDraftRevision: number; expectedTemplateRevision: number };
      return withResourceId(await context.client.syncRangeInstanceTemplate(
        input.rangeInstanceId, input.expectedDraftRevision, input.expectedTemplateRevision, operation(input),
      ), 'templateId');
    },
  },
  {
    name: 'range_instance_retry',
    title: '重试编排实例任务',
    description: '对应编排实例页失败后的“重试”。仅在创建或销毁失败时重试最近的开通/回收任务；会再次执行云资源操作，调用前必须取得用户确认。',
    requiredScopes: ['ranges:control'],
    annotations: { destructiveHint: false, idempotentHint: false },
    inputSchema: rangeRetryInputSchema,
    outputSchema: actionOutputSchema,
    call(context, args) {
      const input = args as RangeOperationInput;
      return context.client.retryRangeInstance(input.rangeInstanceId, operation(input));
    },
  },
  nodeActionTool('range_instance_node_start', '开机编排节点', 'start', '对应实例详情中 ECS 节点“开机”。向实例绑定的云厂商提交开机指令，调用前必须取得用户确认。'),
  nodeActionTool('range_instance_node_stop', '关机编排节点', 'stop', '对应实例详情中 ECS 节点“关机”。向实例绑定的云厂商提交强制关机指令，调用前必须取得用户确认。'),
  nodeActionTool('range_instance_node_reboot', '重启编排节点', 'reboot', '对应实例详情中 ECS 节点“重启”。向实例绑定的云厂商提交强制重启指令，调用前必须取得用户确认。'),
  {
    name: 'range_instance_node_verify_dns',
    title: '核验编排节点 DNS',
    description: '读取指定 Windows 节点客体网卡的实际 DNS，并按配置核验域控 SRV 记录。仅执行平台固定只读核验，不改变 DNS、不重建实例，不接受任意命令或云资源 ID；核验状态独立于实例运行状态。调用前取得准确节点的用户确认。',
    requiredScopes: ['ranges:control'],
    annotations: { destructiveHint: false, idempotentHint: false },
    inputSchema: rangeNodeVerifyDnsInputSchema,
    outputSchema: actionOutputSchema,
    call(context, args) {
      const input = args as RangeOperationInput & { nodeId: string };
      return context.client.runRangeInstanceNodeAction(input.rangeInstanceId, input.nodeId, 'verify-dns', {}, operation(input));
    },
  },
  {
    name: 'range_instance_node_apply_dns',
    title: '重新下发编排节点 DNS',
    description: '将已部署拓扑中的 DNS 重新设置到指定 Windows 节点选定网卡，然后读取实际 DNS 并核验已配置的域控 SRV。只接受准确平台实例和节点，不接受任意命令、DNS 参数或云资源 ID；不创建、销毁或重建实例，失败仅记录 DNS 状态。调用前取得准确节点的用户确认。',
    requiredScopes: ['ranges:control'],
    annotations: { destructiveHint: true, idempotentHint: false },
    inputSchema: rangeNodeVerifyDnsInputSchema,
    outputSchema: actionOutputSchema,
    call(context, args) {
      const input = args as RangeOperationInput & { nodeId: string };
      return context.client.runRangeInstanceNodeAction(input.rangeInstanceId, input.nodeId, 'apply-dns', {}, operation(input));
    },
  },
  {
    name: 'range_instance_node_open_vnc',
    title: '打开编排节点 VNC',
    description: '对应实例详情中 ECS 节点“VNC”。返回临时 VNC 访问地址，属于敏感访问数据；仅在用户明确请求时调用。',
    requiredScopes: ['ranges:read', 'instances:credentials:read'],
    annotations: { idempotentHint: false },
    inputSchema: rangeNodeOpenVncInputSchema,
    outputSchema: actionOutputSchema,
    call(context, args) {
      const input = args as { rangeInstanceId: string; nodeId: string };
      return context.client.runRangeInstanceNodeAction(input.rangeInstanceId, input.nodeId, 'open-vnc');
    },
  },
  {
    name: 'range_instance_node_pack_image_validate',
    title: '只读核验腾讯节点镜像参数',
    description: '对当前运行中的腾讯云编排节点调用官方 CreateImage DryRun=true，只验证拟打包的准确名称/描述和同一组平台来源标签，不创建镜像、快照、目录资产或打包记录。原来源有 UNKNOWN/进行中打包时拒绝；成功核验不能代替之后的用户创建确认或创建结果。',
    requiredScopes: ['ranges:read', 'images:read'],
    readOnlyHint: true,
    inputSchema: rangeNodePackImageValidateInputSchema,
    outputSchema: resultOutputSchema(z.object({ status: z.enum(['validated', 'rejected', 'unverified']), dryRun: z.literal(true) }).passthrough()),
    call(context, args) {
      if (!context.client.validateRangeInstanceNodePackImage) throw new Error('官方镜像参数核验服务尚未配置');
      const input = args as { rangeInstanceId: string; nodeId: string; displayName: string; description?: string };
      return context.client.validateRangeInstanceNodePackImage(input.rangeInstanceId, input.nodeId, { displayName: input.displayName, ...(input.description === undefined ? {} : { description: input.description }) });
    },
  },
  {
    name: 'range_instance_node_pack_image',
    title: '打包编排节点镜像',
    description: '对应实例详情中 ECS 节点“打包镜像”。从节点创建私有平台镜像；可选提供镜像名称、默认主机名、默认密码和描述。该操作创建云镜像资产，调用前必须取得用户确认。',
    requiredScopes: ['ranges:control', 'images:write'],
    annotations: { destructiveHint: false, idempotentHint: false },
    inputSchema: rangeNodePackImageInputSchema,
    outputSchema: actionOutputSchema,
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
    outputSchema: actionOutputSchema,
    call(context, args) {
      const input = args as { rangeInstanceId: string; idempotencyKey?: string; confirmationId?: string };
      return context.client.destroyRange(input.rangeInstanceId, operation(input));
    },
  },
];

type RangeOperationInput = {
  rangeInstanceId: string;
  idempotencyKey?: string;
  confirmationId?: string;
};

type RangeTopologyChangeInput = {
  rangeInstanceId: string;
  expectedDraftRevision: number;
  topologyGraph: ScenarioGraphDraft;
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
    annotations: { destructiveHint: action === 'stop' || action === 'reboot', idempotentHint: false },
    inputSchema: rangeNodeActionInputSchema,
    outputSchema: actionOutputSchema,
    call(context, args) {
      const input = args as RangeNodeActionInput;
      return context.client.runRangeInstanceNodeAction(
        input.rangeInstanceId,
        input.nodeId,
        action,
        {},
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
  if (readDraftRevision(instance.draftRevision) !== input.expectedDraftRevision) {
    throw new Error('实例草稿版本已变化，请刷新后再保存；未覆盖新草稿');
  }
  const metadata = {
    ...metadataFromRangeInstance(instance),
    ...(input.publicEntryProtocols ? { publicEntryProtocols: input.publicEntryProtocols } : {}),
  };
  const imageOsHints = await resolveToolImageOsHints(
    context.client,
    input.topologyGraph as Record<string, unknown>,
    instance.draftTopologyGraph as Record<string, unknown> | null,
  );
  const compiled = JSON.parse(JSON.stringify(compileTemplateTopology(input.topologyGraph, metadata, imageOsHints))) as
    ReturnType<typeof compileTemplateTopology>;

  const saved = await context.client.saveRangeInstanceDraft(
    input.rangeInstanceId,
    {
      draftTopologyGraph: compiled.topologyGraph,
      draftTopologySpec: compiled.topologySpec,
      draftScenarioTemplateSpec: compiled.scenarioTemplateSpec,
      draftCompiledProvisionSpec: compiled.compiledProvisionSpec,
      expectedDraftRevision: input.expectedDraftRevision,
    },
  );

  return { saved };
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
    cloudProvider: metadata.cloudProvider === 'tencent_cloud' || instance.cloudProvider === 'tencent_cloud' ? 'tencent_cloud' : 'alibaba_cloud',
    iacType: metadata.iacType === 'terraform' ? 'terraform' : 'opentofu',
    description: readString(metadata.description),
    modulePathOrRef: 'runtime/range-instance',
    primaryVpcCidr: readString(topology.vpcCidr),
    publicEntryProtocols: (asRecord(asRecord(instance.draftTopologySpec ?? instance.runtimeTopologySpec)?.publicEntry)?.protocols) as TemplateAuthoringMetadata['publicEntryProtocols'],
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

function readDraftRevision(value: unknown) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw new Error('实例详情缺少有效草稿版本，无法安全保存');
  return value;
}

function withResourceId(value: unknown, resultIdField: 'rangeInstanceId' | 'templateId') {
  const record = asRecord(value);

  if (!record) {
    return value;
  }

  const id = readString(record.id) ?? readString(record[resultIdField]);
  return id ? { ...record, id } : record;
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
      .filter(([key]) => !['password', 'custompassword', 'defaultpassword', 'ssh', 'vncurl', 'accesskeyid', 'accesskeysecret', 'token'].includes(key.toLowerCase()))
      .map(([key, child]) => [key, redactRangeInstanceSecrets(child)]),
  ) as T;
}
