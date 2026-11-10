import type { TemplateEdge } from './template-editor-screen';
import type { TemplateNode } from '../../../lib/scenario-graph';
import type { TopologyFlowEdge, TopologyFlowNode, TopologyFlowPort, TopologyViewport } from './topology-flow-types';
import { indexTopologyEdges, readNetworkRegions, readTopologyNetworks, topologyNodeSize } from './topology-network-model';
import { routeTopologyConnections, type PortSide, type RouteBox, type RoutePoint } from './topology-edge-routing';

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

function readKnownEdges(nodes: TemplateNode[], edges: TemplateEdge[]) {
  const knownNodeIds = new Set(nodes.map((node) => node.id));

  return edges.filter(
    (edge) => knownNodeIds.has(edge.fromNodeId) && knownNodeIds.has(edge.toNodeId),
  );
}

function readFlowGeometry(nodes: TemplateNode[], edges: TemplateEdge[]) {
  const networks = readTopologyNetworks(nodes, edges);
  const boxes = new Map(nodes.map((node, index) => [node.id, { id: node.id,
    ...(node.position ?? { x: 120 + index * 220, y: 180 }), ...topologyNodeSize(node, networks.memberships.get(node.id)) }]));
  const nodeMap = new Map(nodes.map(node => [node.id, node]));
  const edgesByDirection = { source: indexTopologyEdges(edges, 'fromNodeId'), target: indexTopologyEdges(edges, 'toNodeId') };
  const ports = new Map<string, { source: TopologyFlowPort[]; target: TopologyFlowPort[] }>();
  for (const node of nodes) {
    const box = boxes.get(node.id)!;
    const result = { source: [] as TopologyFlowPort[], target: [] as TopologyFlowPort[] };
    for (const direction of ['source', 'target'] as const) {
      const connected = (edgesByDirection[direction].get(node.id) ?? []).map(edge => {
        const peerId = direction === 'source' ? edge.toNodeId : edge.fromNodeId, peer = boxes.get(peerId)!;
        const positioned = node.position && nodeMap.get(peerId)?.position;
        const vertical = positioned && Math.abs(peer.y - box.y) >= 96;
        const side: PortSide = !positioned ? direction === 'source' ? 'right' : 'left'
          : vertical ? peer.y > box.y ? 'bottom' : 'top' : peer.x + peer.width / 2 > box.x + box.width / 2 ? 'right' : 'left';
        return { edge, peer, peerId, side };
      });
      for (const side of ['top', 'right', 'bottom', 'left'] as const) {
        const onSide = connected.filter(item => item.side === side).sort((a, b) => {
          const coordinate = side === 'top' || side === 'bottom' ? 'x' : 'y';
          return (nodeMap.get(a.peerId)?.position && nodeMap.get(b.peerId)?.position ? a.peer[coordinate] - b.peer[coordinate] : 0)
            || a.peerId.localeCompare(b.peerId) || a.edge.id.localeCompare(b.edge.id);
        });
        onSide.forEach((item, index) => result[direction].push({ id: `${direction === 'source' ? sourceHandlePrefix : targetHandlePrefix}${item.edge.id}`, side, offset: readPortOffset(index, onSide.length) }));
      }
    }
    ports.set(node.id, result);
  }
  return { networks, boxes, ports };
}

function portPoint(box: RouteBox, port: TopologyFlowPort): RoutePoint {
  // React Flow anchors an assigned 8px handle at its outward edge, not its center.
  return { x: box.x + (port.side === 'left' ? -4 : port.side === 'right' ? box.width + 4 : box.width * port.offset / 100),
    y: box.y + (port.side === 'top' ? -4 : port.side === 'bottom' ? box.height + 4 : box.height * port.offset / 100) };
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
  const { networks, boxes, ports } = readFlowGeometry(nodes, knownEdges);

  return nodes.map((topologyNode) => ({
    id: topologyNode.id,
    type: nodeTypeByKind[topologyNode.kind],
    position: { x: boxes.get(topologyNode.id)!.x, y: boxes.get(topologyNode.id)!.y },
    style: { width: boxes.get(topologyNode.id)!.width, height: boxes.get(topologyNode.id)!.height },
    data: {
      topologyNode,
      connectMode: resolvedConnectMode,
      sourcePorts: ports.get(topologyNode.id)!.source,
      targetPorts: ports.get(topologyNode.id)!.target,
      networks: networks.memberships.get(topologyNode.id),
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

  const nodes = edges ? nodesOrEdges as TemplateNode[] : [];
  const geometry = readFlowGeometry(nodes, knownEdges);
  const connections = nodes.length ? knownEdges.map(edge => {
    const source = geometry.ports.get(edge.fromNodeId)!.source.find(port => port.id === `${sourceHandlePrefix}${edge.id}`)!;
    const target = geometry.ports.get(edge.toNodeId)!.target.find(port => port.id === `${targetHandlePrefix}${edge.id}`)!;
    return { id: edge.id, source: portPoint(geometry.boxes.get(edge.fromNodeId)!, source), target: portPoint(geometry.boxes.get(edge.toNodeId)!, target), sourceSide: source.side!, targetSide: target.side! };
  }) : [];
  const headings = readNetworkRegions(nodes, knownEdges).map(region => ({ id: `heading/${region.id}`, x: region.x + 16, y: region.y + 10,
    width: Math.min(region.width - 32, region.id.startsWith('zone/') ? 160 : 320), height: 40 }));
  const routes = routeTopologyConnections([...geometry.boxes.values(), ...headings], connections);
  const nodesById = new Map(nodes.map(node => [node.id, node]));
  const zonesById = new Map(geometry.networks.zones.map(zone => [zone.node.id, zone]));

  return knownEdges.map((topologyEdge) => {
    const source = nodesById.get(topologyEdge.fromNodeId), target = nodesById.get(topologyEdge.toNodeId);
    const network = zonesById.get(topologyEdge.fromNodeId);
    const nic = geometry.networks.memberships.get(topologyEdge.toNodeId)?.find(link => link.switchId === source?.id);
    const description = `${source?.label ?? topologyEdge.fromNodeId} → ${target?.label ?? topologyEdge.toNodeId}${nic?.nics.length ? ` · ${nic.nics.map(item => `网卡 ${item.ordinal}: ${item.privateIp}`).join(' / ')}` : ''}`;

    return {
      id: topologyEdge.id,
      type: 'topology-network' as const,
      source: topologyEdge.fromNodeId,
      sourceHandle: nodes.length ? `${sourceHandlePrefix}${topologyEdge.id}` : 'source-default',
      target: topologyEdge.toNodeId,
      targetHandle: nodes.length ? `${targetHandlePrefix}${topologyEdge.id}` : 'target-default',
      selectable: true,
      focusable: true,
      interactionWidth: 24,
      ariaLabel: description,
      data: { topologyEdge, route: routes.get(topologyEdge.id), color: network?.color ?? '#71859c', description },
    };
  });
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
