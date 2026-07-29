import type { TemplateEdge } from './template-editor-screen';
import type { TemplateNode } from '../../../lib/scenario-graph';
import type { TopologyFlowEdge, TopologyFlowNode, TopologyViewport } from './topology-flow-types';

const nodeTypeByKind = {
  router: 'topology-router',
  switch: 'topology-switch',
  ecs: 'topology-ecs',
} as const;

export function toFlowNodes(nodes: TemplateNode[], connectMode = false): TopologyFlowNode[] {
  return nodes.map((topologyNode, index) => ({
    id: topologyNode.id,
    type: nodeTypeByKind[topologyNode.kind],
    position: topologyNode.position ?? { x: 120 + index * 220, y: 180 },
    data: { topologyNode, connectMode },
  }));
}

export function fromFlowNodes(nodes: TopologyFlowNode[]): TemplateNode[] {
  return nodes.map(({ data, position }) => ({ ...data.topologyNode, position }));
}

export function toFlowEdges(edges: TemplateEdge[]): TopologyFlowEdge[] {
  return edges.map((topologyEdge) => ({
    id: topologyEdge.id,
    type: 'smoothstep',
    source: topologyEdge.fromNodeId,
    target: topologyEdge.toNodeId,
    data: { topologyEdge },
  }));
}

export function readTopologyViewport(value: unknown): TopologyViewport | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const viewport = value as Record<string, unknown>;

  return typeof viewport.x === 'number' && Number.isFinite(viewport.x)
    && typeof viewport.y === 'number' && Number.isFinite(viewport.y)
    && typeof viewport.zoom === 'number' && Number.isFinite(viewport.zoom) && viewport.zoom > 0
    ? { x: viewport.x, y: viewport.y, zoom: viewport.zoom }
    : null;
}

export function writeTopologyViewport<T extends Record<string, unknown>>(
  graph: T,
  viewport: TopologyViewport | null,
): T & { viewport?: TopologyViewport } {
  return viewport ? { ...graph, viewport } : graph;
}
