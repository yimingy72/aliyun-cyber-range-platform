import type { ScenarioGraphEdge, TemplateNode } from './scenario-graph';

type ValidateManualEdgeInput = {
  sourceNode: TemplateNode;
  targetNode: TemplateNode;
  edges: ScenarioGraphEdge[];
};

type ValidateManualEdgeResult =
  | { ok: true }
  | { ok: false; reason: string };

export function normalizeManualEdgePair(sourceNode: TemplateNode, targetNode: TemplateNode) {
  if (
    (sourceNode.kind === 'router' && targetNode.kind === 'switch') ||
    (sourceNode.kind === 'switch' && targetNode.kind === 'router')
  ) {
    return {
      fromNode: sourceNode.kind === 'router' ? sourceNode : targetNode,
      toNode: sourceNode.kind === 'switch' ? sourceNode : targetNode,
    };
  }

  if (
    (sourceNode.kind === 'switch' && targetNode.kind === 'ecs') ||
    (sourceNode.kind === 'ecs' && targetNode.kind === 'switch')
  ) {
    return {
      fromNode: sourceNode.kind === 'switch' ? sourceNode : targetNode,
      toNode: sourceNode.kind === 'ecs' ? sourceNode : targetNode,
    };
  }

  return null;
}

export function validateManualEdge(input: ValidateManualEdgeInput): ValidateManualEdgeResult {
  if (input.sourceNode.id === input.targetNode.id) {
    return { ok: false, reason: '不能将节点连接到自己' };
  }

  const normalized = normalizeManualEdgePair(input.sourceNode, input.targetNode);

  if (!normalized) {
    return { ok: false, reason: '第一阶段仅允许 Router -> Switch 或 Switch -> ECS 连线' };
  }

  const duplicate = input.edges.some(
    (edge) => edge.fromNodeId === normalized.fromNode.id && edge.toNodeId === normalized.toNode.id,
  );

  if (duplicate) {
    return { ok: false, reason: '已存在相同连线' };
  }

  return { ok: true };
}
