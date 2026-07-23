import type { CreateRangeTemplateInput, OperationRequest, UpdateRangeTemplateInput } from '@aliyun-cyber-range/platform-api-client';
import type { ScenarioGraphDraft } from '@aliyun-cyber-range/scenario-runtime';
import * as z from 'zod/v4';

import {
  compileTemplateTopology,
  graphFromTemplate,
  metadataFromTemplate,
  type TemplateAuthoringMetadata,
} from './template-authoring';
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
  primaryVpcCidr?: string;
  secondaryVpcCidrs?: string[];
  vpcCidr?: string;
  defaultRegion?: string;
  defaultZoneId?: string;
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
  cloudProvider: 'alibaba_cloud' as const,
  iacType: 'opentofu' as const,
  modulePathOrRef: 'infra/opentofu/modules/alicloud-enterprise-range',
};

export const templateTools: ToolDefinition[] = [
  {
    name: 'range_template_list',
    title: '查询靶场模板',
    description: '查询当前有权限查看的靶场模板。view=platform 仅返回已发布到平台且可供使用的模板；view=mine 返回当前用户拥有的可编辑模板。',
    requiredScopes: ['templates:read'],
    readOnlyHint: true,
    inputSchema: templateListInputSchema,
    outputSchema: resourceListOutputSchema,
    async call(context, args) {
      const templates = await context.client.listRangeTemplates((args as { view?: 'platform' | 'mine' }).view ?? 'platform');
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
    description: '根据设计转换 Skill 产出的完整 topologyGraph 创建并保存靶场模板。仅传名称、描述、网络元数据和拓扑；slug、版本、云厂商、IaC 与模块路径由平台生成。MCP 会重新编译拓扑，调用方不得传 topologySpec、scenarioTemplateSpec、compiledProvisionSpec 或 compiledSpec。',
    requiredScopes: ['templates:write'],
    inputSchema: templateCreateInputSchema,
    outputSchema: resourceOutputSchema,
    async call(context, args) {
      const input = args as CreateInput;
      const compiled = compileTemplateTopology(input.topologyGraph, metadataForTemplateCreation(input));
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
      const input = args as TemplateWriteInput & { updates: UpdateRangeTemplateInput };
      const current = await requireTemplate(context.client.getRangeTemplate(input.templateId), input.templateId);
      return redactTemplateSecrets(
        await context.client.updateRangeTemplate(
          input.templateId,
          { ...input.updates, expectedRevision: readTemplateRevision(current) },
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
    annotations: { idempotentHint: true },
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
        primaryVpcCidr?: string;
        secondaryVpcCidrs?: string[];
        vpcCidr?: string;
        publicEntryProtocols?: TemplateAuthoringMetadata['publicEntryProtocols'];
      };
      const current = await requireTemplate(context.client.getRangeTemplate(input.templateId), input.templateId);
      const topologyGraph = preserveRedactedCustomPasswords(graphFromTemplate(current), input.topologyGraph);
      const compiled = compileTemplateTopology(topologyGraph, { ...metadataFromTemplate(current), ...pickTopologyMetadata(input) });
      const template = await context.client.saveRangeTemplateTopology(
        input.templateId,
        { ...compiled, expectedRevision: readTemplateRevision(current) },
        operation(input),
      );
      return redactTemplateSecrets({ valid: true, template });
    },
  },
  {
    name: 'range_template_publish',
    title: '发布模板到平台',
    description: '对应平台“发布到平台”。校验当前已保存拓扑后生成可供使用的发布版本，并将模板设为平台可见，其他用户随后可查看和使用。调用前必须取得用户确认；平台要求时需携带 confirmationId。',
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
    name: 'range_template_unpublish',
    title: '取消发布模板',
    description: '对应平台“取消发布”。从平台列表隐藏模板并停止向其他用户提供使用，但不会删除模板及其已保存拓扑。调用前必须取得用户确认；平台要求时需携带 confirmationId。',
    requiredScopes: ['templates:publish'],
    annotations: { destructiveHint: false, idempotentHint: false },
    inputSchema: templateLifecycleInputSchema,
    outputSchema: resourceOutputSchema,
    async call(context, args) {
      const input = args as TemplateWriteInput;
      const current = await requireTemplate(context.client.getRangeTemplate(input.templateId), input.templateId);
      return redactTemplateSecrets(
        await context.client.unpublishRangeTemplate(input.templateId, readTemplateRevision(current), operation(input)),
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

function metadataForTemplateCreation(input: CreateInput): TemplateAuthoringMetadata {
  return {
    ...internalCreateMetadata,
    name: input.name,
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...pickTopologyMetadata(input),
  };
}

function pickTopologyMetadata(input: Record<string, unknown>) {
  const keys = ['primaryVpcCidr', 'secondaryVpcCidrs', 'vpcCidr', 'defaultRegion', 'defaultZoneId', 'publicEntryProtocols'] as const;
  return Object.fromEntries(keys.filter((key) => input[key] !== undefined).map((key) => [key, input[key]]));
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
