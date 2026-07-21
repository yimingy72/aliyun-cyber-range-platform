import type { CreateRangeTemplateInput, OperationRequest, UpdateRangeTemplateInput } from '@aliyun-cyber-range/platform-api-client';
import type { ScenarioGraphDraft, ScenarioGraphEdge, TemplateNode } from '@aliyun-cyber-range/scenario-runtime';

import {
  applyTemplateChangeset,
  compileTemplateTopology,
  graphFromTemplate,
  metadataFromTemplate,
  type TemplateAuthoringMetadata,
  type TemplateGraphChangeset,
} from './template-authoring';
import {
  templateChangesetInputSchema,
  templateCloneInputSchema,
  templateCreateInputSchema,
  templateDetectInputSchema,
  templateEdgeAddInputSchema,
  templateEdgeRemoveInputSchema,
  templateGetInputSchema,
  templateLifecycleInputSchema,
  templateListInputSchema,
  templateNodeAddInputSchema,
  templateNodeRemoveInputSchema,
  templateNodeUpdateInputSchema,
  templateUpdateInputSchema,
  templateValidateInputSchema,
} from './template-schemas';
import type { ToolDefinition } from './tool-context';

type TemplateOperation = { idempotencyKey?: string; confirmationId?: string };
type TemplateWriteInput = TemplateOperation & { templateId: string };
type CreateInput = TemplateOperation & TemplateAuthoringMetadata & {
  topologyGraph: ScenarioGraphDraft;
  variableSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  defaultNetworkPolicy?: Record<string, unknown>;
};

const operation = (input: TemplateOperation): OperationRequest => ({
  idempotencyKey: input.idempotencyKey,
  confirmationId: input.confirmationId,
});

export const templateTools: ToolDefinition[] = [
  {
    name: 'range_template_list',
    description: 'List published or owned range templates.',
    requiredScopes: ['templates:read'],
    readOnlyHint: true,
    inputSchema: templateListInputSchema,
    async call(context, args) {
      const templates = await context.client.listRangeTemplates((args as { view?: 'platform' | 'mine' }).view ?? 'platform');
      return templates.map(redactTemplateSecrets);
    },
  },
  {
    name: 'range_template_get',
    description: 'Get a range template, including the owner draft topology graph when authorized.',
    requiredScopes: ['templates:read'],
    readOnlyHint: true,
    inputSchema: templateGetInputSchema,
    async call(context, args) {
      const template = await context.client.getRangeTemplate((args as { templateId: string }).templateId);
      return template ? redactTemplateSecrets(template) : null;
    },
  },
  {
    name: 'range_template_create',
    description: 'Create a complete range template from a topology graph. The server payload is compiled from the graph; do not provide compiled fields.',
    requiredScopes: ['templates:write'],
    inputSchema: templateCreateInputSchema,
    async call(context, args) {
      const input = args as CreateInput;
      const compiled = compileTemplateTopology(input.topologyGraph, input);
      const payload: CreateRangeTemplateInput = {
        name: input.name,
        description: input.description,
        slug: input.slug,
        version: input.version,
        cloudProvider: input.cloudProvider,
        iacType: input.iacType,
        modulePathOrRef: input.modulePathOrRef,
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
    description: 'Update template metadata, or replace its complete topologyGraph. A graph replacement is compiled before it is saved.',
    requiredScopes: ['templates:write'],
    inputSchema: templateUpdateInputSchema,
    async call(context, args) {
      const input = args as TemplateWriteInput & { updates: UpdateRangeTemplateInput & { topologyGraph?: ScenarioGraphDraft; vpcCidr?: string; publicEntryProtocols?: TemplateAuthoringMetadata['publicEntryProtocols'] } };
      const updates = { ...input.updates };
      assertNoCallerCompiledFields(updates);
      if (updates.topologyGraph) {
        const current = await requireTemplate(context.client.getRangeTemplate(input.templateId), input.templateId);
        const metadata = { ...metadataFromTemplate(current), ...pickMetadata(updates) };
        const topologyGraph = preserveRedactedCustomPasswords(graphFromTemplate(current), updates.topologyGraph);
        const compiled = compileTemplateTopology(topologyGraph, metadata);
        delete updates.vpcCidr;
        delete updates.publicEntryProtocols;
        Object.assign(updates, compiled);
      }
      return redactTemplateSecrets(await context.client.updateRangeTemplate(input.templateId, updates, operation(input)));
    },
  },
  {
    name: 'range_template_clone',
    description: 'Clone a readable template into a new private draft.',
    requiredScopes: ['templates:write'],
    inputSchema: templateCloneInputSchema,
    async call(context, args) {
      const input = args as TemplateWriteInput;
      return redactTemplateSecrets(await context.client.cloneRangeTemplate(input.templateId, operation(input)));
    },
  },
  {
    name: 'range_template_validate',
    description: 'Validate a saved template draft using the platform publish prechecks.',
    requiredScopes: ['templates:write'],
    inputSchema: templateValidateInputSchema,
    call(context, args) {
      const input = args as TemplateWriteInput;
      return context.client.validateRangeTemplate(input.templateId, operation(input));
    },
  },
  {
    name: 'range_template_topology_detect',
    description: 'Compile and validate a complete topology graph in memory without saving it, or preflight the current template draft.',
    requiredScopes: ['templates:write'],
    inputSchema: templateDetectInputSchema,
    async call(context, args) {
      const input = args as TemplateOperation & { templateId?: string; topologyGraph?: ScenarioGraphDraft } & Partial<TemplateAuthoringMetadata>;
      const current = input.templateId ? await requireTemplate(context.client.getRangeTemplate(input.templateId), input.templateId) : null;
      const topologyGraph = input.topologyGraph ?? (current ? graphFromTemplate(current) : null);
      if (!topologyGraph) {
        throw new Error('templateId 或 topologyGraph 必须提供一个');
      }
      const metadata = { ...(current ? metadataFromTemplate(current) : {}), ...pickMetadata(input) } as TemplateAuthoringMetadata;
      const compiled = compileTemplateTopology(topologyGraph, metadata);
      return redactTemplateSecrets({ valid: true, ...compiled });
    },
  },
  nodeTool('range_template_node_add', 'add-node', 'Add a node and save only after the complete resulting graph passes compilation.'),
  nodeTool('range_template_node_update', 'update-node', 'Update one node and save only after the complete resulting graph passes compilation.'),
  nodeTool('range_template_node_remove', 'remove-node', 'Remove one node and its visual edges, then save if the complete graph remains valid.'),
  edgeTool('range_template_edge_add', 'add-edge', 'Add one manual router-to-switch or switch-to-ECS edge and save the validated graph.'),
  edgeTool('range_template_edge_remove', 'remove-edge', 'Remove one manual edge and save the validated graph.'),
  {
    name: 'range_template_changeset_apply',
    description: 'Apply ordered node and edge changes atomically in memory, then compile and save once. Use for changes with invalid intermediate states.',
    requiredScopes: ['templates:write'],
    inputSchema: templateChangesetInputSchema,
    call(context, args) {
      const input = args as TemplateWriteInput & { changes: TemplateGraphChangeset; vpcCidr?: string; publicEntryProtocols?: TemplateAuthoringMetadata['publicEntryProtocols'] };
      return updateGraph(context, input, input.changes);
    },
  },
  {
    name: 'range_template_publish',
    description: 'Publish a validated template. MCP requires the platform confirmation response before visibility changes.',
    requiredScopes: ['templates:publish'],
    inputSchema: templateLifecycleInputSchema,
    async call(context, args) {
      const input = args as TemplateWriteInput;
      return redactTemplateSecrets(await context.client.publishRangeTemplate(input.templateId, operation(input)));
    },
  },
  {
    name: 'range_template_unpublish',
    description: 'Unpublish a template. MCP requires platform confirmation.',
    requiredScopes: ['templates:publish'],
    inputSchema: templateLifecycleInputSchema,
    async call(context, args) {
      const input = args as TemplateWriteInput;
      return redactTemplateSecrets(await context.client.unpublishRangeTemplate(input.templateId, operation(input)));
    },
  },
  {
    name: 'range_template_share',
    description: 'Share an owned template to the platform. MCP requires platform confirmation.',
    requiredScopes: ['templates:publish'],
    inputSchema: templateLifecycleInputSchema,
    async call(context, args) {
      const input = args as TemplateWriteInput;
      return redactTemplateSecrets(await context.client.shareRangeTemplate(input.templateId, operation(input)));
    },
  },
  {
    name: 'range_template_unshare',
    description: 'Remove a template from platform sharing. MCP requires platform confirmation.',
    requiredScopes: ['templates:publish'],
    inputSchema: templateLifecycleInputSchema,
    async call(context, args) {
      const input = args as TemplateWriteInput;
      return redactTemplateSecrets(await context.client.unshareRangeTemplate(input.templateId, operation(input)));
    },
  },
  {
    name: 'range_template_delete',
    description: 'Delete an owned template after platform confirmation. Deletion is blocked while active range instances reference it.',
    requiredScopes: ['templates:delete'],
    inputSchema: templateLifecycleInputSchema,
    async call(context, args) {
      const input = args as TemplateWriteInput;
      await context.client.removeRangeTemplate(input.templateId, operation(input));
      return { removed: true, templateId: input.templateId };
    },
  },
];

function nodeTool(name: string, op: Extract<TemplateGraphChangeset[number], { op: 'add-node' | 'update-node' | 'remove-node' }>['op'], description: string): ToolDefinition {
  const inputSchema = op === 'add-node'
    ? templateNodeAddInputSchema
    : op === 'update-node'
      ? templateNodeUpdateInputSchema
      : templateNodeRemoveInputSchema;

  return {
    name,
    description,
    requiredScopes: ['templates:write'],
    inputSchema,
    call(context, args) {
      const input = args as TemplateWriteInput & { node?: TemplateNode; nodeId?: string; patch?: Partial<TemplateNode>; vpcCidr?: string; publicEntryProtocols?: TemplateAuthoringMetadata['publicEntryProtocols'] };
      const change = op === 'add-node'
        ? { op, node: required(input.node, 'node') }
        : op === 'update-node'
          ? { op, nodeId: required(input.nodeId, 'nodeId'), patch: required(input.patch, 'patch') }
          : { op, nodeId: required(input.nodeId, 'nodeId') };
      return updateGraph(context, input, [change] as TemplateGraphChangeset);
    },
  };
}

function edgeTool(name: string, op: 'add-edge' | 'remove-edge', description: string): ToolDefinition {
  return {
    name,
    description,
    requiredScopes: ['templates:write'],
    inputSchema: op === 'add-edge' ? templateEdgeAddInputSchema : templateEdgeRemoveInputSchema,
    call(context, args) {
      const input = args as TemplateWriteInput & { edge?: ScenarioGraphEdge; edgeId?: string; vpcCidr?: string; publicEntryProtocols?: TemplateAuthoringMetadata['publicEntryProtocols'] };
      const change = op === 'add-edge' ? { op, edge: required(input.edge, 'edge') } : { op, edgeId: required(input.edgeId, 'edgeId') };
      return updateGraph(context, input, [change] as TemplateGraphChangeset);
    },
  };
}

async function updateGraph(
  context: Parameters<ToolDefinition['call']>[0],
  input: TemplateWriteInput & Partial<TemplateAuthoringMetadata>,
  changes: TemplateGraphChangeset,
) {
  const current = await requireTemplate(context.client.getRangeTemplate(input.templateId), input.templateId);
  const graph = applyTemplateChangeset(graphFromTemplate(current), changes);
  const compiled = compileTemplateTopology(graph, { ...metadataFromTemplate(current), ...pickMetadata(input) });
  return redactTemplateSecrets(await context.client.updateRangeTemplate(input.templateId, compiled, operation(input)));
}

function pickMetadata(input: Record<string, unknown>) {
  const keys = ['name', 'slug', 'version', 'description', 'cloudProvider', 'iacType', 'modulePathOrRef', 'vpcCidr', 'defaultRegion', 'defaultZoneId', 'publicEntryProtocols'] as const;
  return Object.fromEntries(keys.filter((key) => input[key] !== undefined).map((key) => [key, input[key]]));
}

async function requireTemplate(template: Promise<Record<string, unknown> | null>, templateId: string) {
  const result = await template;
  if (!result) {
    throw new Error(`模板不存在或无访问权限：${templateId}`);
  }
  return result;
}

function required<T>(value: T | undefined, name: string): T {
  if (value === undefined) {
    throw new Error(`${name} 是必填参数`);
  }
  return value;
}

function assertNoCallerCompiledFields(updates: Record<string, unknown>) {
  const derivedField = ['topologySpec', 'scenarioTemplateSpec', 'compiledProvisionSpec', 'compiledSpec'].find((key) => key in updates);
  if (derivedField) {
    throw new Error(`${derivedField} 由 MCP 从 topologyGraph 自动生成；请勿手工传入`);
  }
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
