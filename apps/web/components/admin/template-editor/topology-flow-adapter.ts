import type { TemplateEdge } from './template-editor-screen';
import type { TemplateNode } from '../../../lib/scenario-graph';
import type { TopologyFlowEdge, TopologyFlowNode, TopologyViewport } from './topology-flow-types';

const nodeTypeByKind = {
  router: 'topology-router',
  switch: 'topology-switch',
  ecs: 'topology-ecs',
} as const;

const sourceHandlePrefix = 'source-';
const targetHandlePrefix = 'target-';
const firstPortOffset = 26;
const lastPortOffset = 74;

function readPortOffset(index: number, count: number) {
  if (count <= 1) {
    return 50;
  }

  return firstPortOffset + ((lastPortOffset - firstPortOffset) * index) / (count - 1);
}

function compareConnectedEdges(direction: 'source' | 'target', left: TemplateEdge, right: TemplateEdge) {
  const leftPeerId = direction === 'source' ? left.toNodeId : left.fromNodeId;
  const rightPeerId = direction === 'source' ? right.toNodeId : right.fromNodeId;

  return leftPeerId.localeCompare(rightPeerId) || left.id.localeCompare(right.id);
}

function readKnownEdges(nodes: TemplateNode[], edges: TemplateEdge[]) {
  const knownNodeIds = new Set(nodes.map((node) => node.id));

  return edges.filter(
    (edge) => knownNodeIds.has(edge.fromNodeId) && knownNodeIds.has(edge.toNodeId),
  );
}

export function toFlowNodes(nodes: TemplateNode[], connectMode?: boolean): TopologyFlowNode[];
export function toFlowNodes(
  nodes: TemplateNode[],
  edges?: TemplateEdge[],
  connectMode?: boolean,
): TopologyFlowNode[];
export function toFlowNodes(
  nodes: TemplateNode[],
  edgesOrConnectMode: TemplateEdge[] | boolean = [],
  connectMode = false,
): TopologyFlowNode[] {
  const edges = Array.isArray(edgesOrConnectMode) ? edgesOrConnectMode : [];
  const resolvedConnectMode = typeof edgesOrConnectMode === 'boolean'
    ? edgesOrConnectMode
    : connectMode;
  const knownEdges = readKnownEdges(nodes, edges);

  return nodes.map((topologyNode, index) => ({
    id: topologyNode.id,
    type: nodeTypeByKind[topologyNode.kind],
    position: topologyNode.position ?? { x: 120 + index * 220, y: 180 },
    data: {
      topologyNode,
      connectMode: resolvedConnectMode,
      sourcePorts: knownEdges
        .filter((edge) => edge.fromNodeId === topologyNode.id)
        .sort((left, right) => compareConnectedEdges('source', left, right))
        .map((edge, portIndex, sourceEdges) => ({
          id: `${sourceHandlePrefix}${edge.id}`,
          offset: readPortOffset(portIndex, sourceEdges.length),
        })),
      targetPorts: knownEdges
        .filter((edge) => edge.toNodeId === topologyNode.id)
        .sort((left, right) => compareConnectedEdges('target', left, right))
        .map((edge, portIndex, targetEdges) => ({
          id: `${targetHandlePrefix}${edge.id}`,
          offset: readPortOffset(portIndex, targetEdges.length),
        })),
    },
  }));
}

export function fromFlowNodes(nodes: TopologyFlowNode[]): TemplateNode[] {
  return nodes.map(({ data, position }) => ({ ...data.topologyNode, position }));
}

export function toFlowEdges(edges: TemplateEdge[]): TopologyFlowEdge[];
export function toFlowEdges(nodes: TemplateNode[], edges: TemplateEdge[]): TopologyFlowEdge[];
export function toFlowEdges(
  nodesOrEdges: TemplateNode[] | TemplateEdge[],
  edges?: TemplateEdge[],
): TopologyFlowEdge[] {
  const knownEdges = edges
    ? readKnownEdges(nodesOrEdges as TemplateNode[], edges)
    : nodesOrEdges as TemplateEdge[];

  return knownEdges.map((topologyEdge) => ({
    id: topologyEdge.id,
    type: 'bezier',
    source: topologyEdge.fromNodeId,
    sourceHandle: `${sourceHandlePrefix}${topologyEdge.id}`,
    target: topologyEdge.toNodeId,
    targetHandle: `${targetHandlePrefix}${topologyEdge.id}`,
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
