import type { CreateRangeTemplateInput, OperationRequest, UpdateRangeTemplateInput } from '@aliyun-cyber-range/platform-api-client';
import type { ScenarioGraphDraft } from '@aliyun-cyber-range/scenario-runtime';
import * as z from 'zod/v4';

import {
  compileTemplateTopology,
  graphFromTemplate,
  metadataFromTemplate,
  type TemplateAuthoringMetadata,
} from './template-authoring';
import { resolveToolImageOsHints } from './template-image-os-hints';
import {
  templateCloneInputSchema,
  templateCreateInputSchema,
  templateDetectAndSaveInputSchema,
  templateGetInputSchema,
  templateLifecycleInputSchema,
  templateListInputSchema,
  templateUpdateInputSchema,
} from './template-schemas';
import {
  nullableResourceOutputSchema,
  removedOutputSchema,
  resourceSchema,
  resourceListOutputSchema,
  resourceOutputSchema,
  resultOutputSchema,
} from './output-schemas';
import type { ToolDefinition } from './tool-context';

type TemplateOperation = { idempotencyKey?: string; confirmationId?: string };
type TemplateWriteInput = TemplateOperation & { templateId: string };
type CreateInput = TemplateOperation & {
  name: string;
  description?: string;
  publicEntryProtocols?: TemplateAuthoringMetadata['publicEntryProtocols'];
  topologyGraph: ScenarioGraphDraft;
  variableSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  defaultNetworkPolicy?: Record<string, unknown>;
};

const operation = (input: TemplateOperation): OperationRequest => ({
  idempotencyKey: input.idempotencyKey,
  confirmationId: input.confirmationId,
});

const internalCreateMetadata = {
  slug: 'mcp-template',
  version: 'v1',
  iacType: 'opentofu' as const,
};

export const templateTools: ToolDefinition[] = [
  {
    name: 'range_template_list',
    title: '查询靶场模板',
    description: '查询当前有权限查看的靶场模板。view=platform 仅返回已发布到平台且可供使用的模板；view=mine 返回当前用户拥有的可编辑模板；view=all 仅管理员可用，返回当前云账号工作空间内所有模板（含其他用户私有草稿）。',
    requiredScopes: ['templates:read'],
    readOnlyHint: true,
    inputSchema: templateListInputSchema,
    outputSchema: resourceListOutputSchema,
    async call(context, args) {
      const templates = await context.client.listRangeTemplates((args as { view?: 'platform' | 'mine' | 'all' }).view ?? 'platform');
      return templates.map(redactTemplateSecrets);
    },
  },
  {
    name: 'range_template_get',
    title: '获取靶场模板详情',
    description: '获取单个靶场模板及其拓扑。密码等敏感字段会被脱敏；读取结果不可直接作为写入参数回传。',
    requiredScopes: ['templates:read'],
    readOnlyHint: true,
    inputSchema: templateGetInputSchema,
    outputSchema: nullableResourceOutputSchema,
    async call(context, args) {
      const template = await context.client.getRangeTemplate((args as { templateId: string }).templateId);
      return template ? redactTemplateSecrets(template) : null;
    },
  },
  {
    name: 'range_template_create',
    title: '创建靶场模板',
    description: '根据设计转换 Skill 产出的完整 topologyGraph 创建并保存靶场模板。平台固定创建 10.0.0.0/16 主 VPC，并附加 172.16.0.0/16、192.168.0.0/16；交换机必须落在这三段内。转换必须将镜像显示名解析为 platformImageAssetId 与 imageId；image 填显示名，imageId 与 imageStrategy.imageId 填当前云厂商的准确镜像 ID。ECS 顶层 privateIp 必须与第一张 NIC 一致；端口全开统一填写 1/65535，平台会按当前云厂商转换端口范围。交换机 DNAT 可为空，或按不同公网端口映射到多台 ECS；每个目标必须有该交换机上的网卡。公网入口由实际 DNAT 派生，无需设置 exposePublic。默认地域和可用区由后端基础配置注入，调用方不得查询或传入。仅传名称、描述和拓扑；slug、云厂商、IaC、模块路径及其他派生元数据由平台管理。MCP 会重新编译拓扑，调用方不得传 topologySpec、scenarioTemplateSpec、compiledProvisionSpec 或 compiledSpec。',
    requiredScopes: ['templates:write'],
    inputSchema: templateCreateInputSchema,
    outputSchema: resourceOutputSchema,
    async call(context, args) {
      const input = args as CreateInput;
      const workspace = await context.client.getCurrentCloudWorkspace();
      const active = Array.isArray(workspace?.contexts) ? workspace.contexts.find(account => account.id === workspace.activeCloudAccountContextId) : null;
      if (!workspace || workspace.isReadOnly || !workspace.accountUid || !workspace.activeCloudAccountContextId
        || !['alibaba_cloud', 'tencent_cloud'].includes(workspace.provider) || !workspace.capabilities?.provisioning
        || !active || active.status !== 'ready' || active.provider !== workspace.provider || active.accountUid !== workspace.accountUid
        || active.cloudWorkspaceId != null && active.cloudWorkspaceId !== workspace.id) {
        throw new Error('模板创建需要当前已验证且可执行的云账号工作空间。');
      }
      const imageOsHints = await resolveToolImageOsHints(context.client, input.topologyGraph as Record<string, unknown>);
      const compiled = compileTemplateTopology(input.topologyGraph, metadataForTemplateCreation(input, workspace.provider), imageOsHints);
      const payload: CreateRangeTemplateInput = {
        name: input.name,
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...compiled,
        ...(input.variableSchema ? { variableSchema: input.variableSchema } : {}),
        ...(input.outputSchema ? { outputSchema: input.outputSchema } : {}),
        ...(input.defaultNetworkPolicy ? { defaultNetworkPolicy: input.defaultNetworkPolicy } : {}),
      };
      return redactTemplateSecrets(await context.client.createRangeTemplate(payload, operation(input)));
    },
  },
  {
    name: 'range_template_update',
    title: '更新靶场模板',
    description: '更新前端“编辑信息”可修改的模板名称或描述。拓扑变更必须使用“检测并保存拓扑”，派生编译字段不接受调用方传入。',
    requiredScopes: ['templates:write'],
    inputSchema: templateUpdateInputSchema,
    outputSchema: resourceOutputSchema,
    async call(context, args) {
      const input = args as TemplateWriteInput & { updates: UpdateRangeTemplateInput; expectedRevision: number };
      return redactTemplateSecrets(
        await context.client.updateRangeTemplate(
          input.templateId,
          { ...input.updates, expectedRevision: input.expectedRevision },
          operation(input),
        ),
      );
    },
  },
  {
    name: 'range_template_clone',
    title: '复制靶场模板',
    description: '将当前有权限读取的模板复制为一个归当前用户所有、已保存但未发布的可编辑模板。复制不会发布到平台。',
    requiredScopes: ['templates:write'],
    inputSchema: templateCloneInputSchema,
    outputSchema: resourceOutputSchema,
    async call(context, args) {
      const input = args as TemplateWriteInput;
      return redactTemplateSecrets(await context.client.cloneRangeTemplate(input.templateId, operation(input)));
    },
  },
  {
    name: 'range_template_topology_detect_and_save',
    title: '检测并保存拓扑',
    description: '对应平台“检测并保存”。将设计转换 Skill 产出的完整 topologyGraph 与当前模板元数据合并后编译、校验；仅在全部通过时保存。此操作不会发布到平台。',
    requiredScopes: ['templates:write'],
    inputSchema: templateDetectAndSaveInputSchema,
    outputSchema: resultOutputSchema(
      z.object({
        valid: z.literal(true).describe('拓扑已通过编译校验并保存。'),
        template: resourceSchema.describe('保存后的靶场模板。'),
      }),
    ),
    async call(context, args) {
      const input = args as TemplateWriteInput & {
        topologyGraph: ScenarioGraphDraft;
        expectedRevision: number;
        publicEntryProtocols?: TemplateAuthoringMetadata['publicEntryProtocols'];
      };
      const current = await requireTemplate(context.client.getRangeTemplate(input.templateId), input.templateId);
      if (readTemplateRevision(current) !== input.expectedRevision) {
        throw new Error('模板版本已变化，请刷新后再保存；未覆盖新拓扑');
      }
      const topologyGraph = preserveRedactedCustomPasswords(graphFromTemplate(current), input.topologyGraph);
      const imageOsHints = await resolveToolImageOsHints(
        context.client,
        topologyGraph as Record<string, unknown>,
        graphFromTemplate(current) as Record<string, unknown>,
      );
      const compiled = compileTemplateTopology(topologyGraph, {
        ...withoutLegacyVpcMetadata(metadataFromTemplate(withServerOwnedMetadata(current))),
        ...pickTopologyMetadata(input),
      }, imageOsHints);
      const template = await context.client.saveRangeTemplateTopology(
        input.templateId,
        { ...compiled, expectedRevision: input.expectedRevision },
        operation(input),
      );
      return redactTemplateSecrets({ valid: true, template });
    },
  },
  {
    name: 'range_template_publish',
    title: '发布模板到平台',
    description: '对应平台“发布到平台”。校验当前已保存拓扑后，将模板设为平台可见，其他用户随后可查看和使用；平台会在内部固定此次发布所使用的拓扑快照。调用前必须取得用户确认；平台要求时需携带 confirmationId。',
    requiredScopes: ['templates:publish'],
    annotations: { destructiveHint: false, idempotentHint: false },
    inputSchema: templateLifecycleInputSchema,
    outputSchema: resourceOutputSchema,
    async call(context, args) {
      const input = args as TemplateWriteInput;
      const current = await requireTemplate(context.client.getRangeTemplate(input.templateId), input.templateId);
      return redactTemplateSecrets(
        await context.client.publishRangeTemplate(input.templateId, readTemplateRevision(current), operation(input)),
      );
    },
  },
  {
    name: 'range_template_return_to_private',
    title: '回退模板为私有',
    description: '对应平台“回退为私有”。从平台列表隐藏模板并停止向其他用户提供使用，但不会删除模板及其已保存拓扑。调用前必须取得用户确认；平台要求时需携带 confirmationId。',
    requiredScopes: ['templates:publish'],
    annotations: { destructiveHint: false, idempotentHint: false },
    inputSchema: templateLifecycleInputSchema,
    outputSchema: resourceOutputSchema,
    async call(context, args) {
      const input = args as TemplateWriteInput;
      const current = await requireTemplate(context.client.getRangeTemplate(input.templateId), input.templateId);
      return redactTemplateSecrets(
        await context.client.returnRangeTemplateToPrivate(input.templateId, readTemplateRevision(current), operation(input)),
      );
    },
  },
  {
    name: 'range_template_delete',
    title: '删除靶场模板',
    description: '删除当前用户拥有的靶场模板。活动中的编排实例仍引用该模板时会被平台拒绝；该操作不可恢复，调用前必须取得用户确认。',
    requiredScopes: ['templates:delete'],
    annotations: { destructiveHint: true, idempotentHint: false },
    inputSchema: templateLifecycleInputSchema,
    outputSchema: removedOutputSchema('templateId'),
    async call(context, args) {
      const input = args as TemplateWriteInput;
      await context.client.removeRangeTemplate(input.templateId, operation(input));
      return { removed: true, templateId: input.templateId };
    },
  },
];

function metadataForTemplateCreation(input: CreateInput, provider: 'alibaba_cloud' | 'tencent_cloud'): TemplateAuthoringMetadata {
  return {
    ...internalCreateMetadata,
    cloudProvider: provider,
    modulePathOrRef: templateModulePath(provider),
    name: input.name,
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...pickTopologyMetadata(input),
  };
}

function templateModulePath(provider: 'alibaba_cloud' | 'tencent_cloud') {
  return provider === 'tencent_cloud' ? 'infra/opentofu/modules/tencentcloud-enterprise-range' : 'infra/opentofu/modules/alicloud-enterprise-range';
}

function withServerOwnedMetadata(template: Record<string, unknown>) {
  const scenarioTemplateSpec = readRecord(template.scenarioTemplateSpec);
  const scenarioMetadata = readRecord(scenarioTemplateSpec?.metadata);

  return {
    ...template,
    version: readNonEmptyString(template.version) ?? readNonEmptyString(scenarioMetadata?.version) ?? internalCreateMetadata.version,
    modulePathOrRef: readNonEmptyString(template.modulePathOrRef) ?? templateModulePath(template.cloudProvider === 'tencent_cloud' ? 'tencent_cloud' : 'alibaba_cloud'),
  };
}

function pickTopologyMetadata(input: Record<string, unknown>) {
  const keys = ['publicEntryProtocols'] as const;
  return Object.fromEntries(keys.filter((key) => input[key] !== undefined).map((key) => [key, input[key]]));
}

function withoutLegacyVpcMetadata(metadata: TemplateAuthoringMetadata): TemplateAuthoringMetadata {
  const { primaryVpcCidr: _primaryVpcCidr, secondaryVpcCidrs: _secondaryVpcCidrs, vpcCidr: _vpcCidr, ...rest } = metadata;
  return rest;
}

function readRecord(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readNonEmptyString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function readTemplateRevision(template: Record<string, unknown>) {
  const revision = template.revision;

  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 1) {
    throw new Error('模板详情缺少有效 revision，无法安全写入');
  }

  return revision;
}

async function requireTemplate(template: Promise<Record<string, unknown> | null>, templateId: string) {
  const result = await template;
  if (!result) {
    throw new Error(`模板不存在或无访问权限：${templateId}`);
  }
  return result;
}

function redactTemplateSecrets<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(redactTemplateSecrets) as T;
  }
  if (!value || typeof value !== 'object') {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !isTemplateSecretKey(key))
      .map(([key, child]) => [key, redactTemplateSecrets(child)]),
  ) as T;
}

function isTemplateSecretKey(key: string) {
  return ['custompassword', 'password', 'defaultpassword'].includes(key.toLowerCase());
}

function preserveRedactedCustomPasswords(currentGraph: ScenarioGraphDraft, requestedGraph: ScenarioGraphDraft): ScenarioGraphDraft {
  const currentEcsById = new Map(
    currentGraph.nodes
      .filter((node) => node.kind === 'ecs')
      .map((node) => [node.id, node]),
  );

  return {
    ...requestedGraph,
    nodes: requestedGraph.nodes.map((node) => {
      if (node.kind !== 'ecs' || typeof node.customPassword === 'string') {
        return node;
      }

      const currentNode = currentEcsById.get(node.id);
      if (typeof currentNode?.customPassword !== 'string' || currentNode.customPassword.length === 0) {
        return node;
      }

      return { ...node, customPassword: currentNode.customPassword };
    }),
  };
}
