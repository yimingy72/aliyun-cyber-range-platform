import type { TopologyRegion } from '@aliyun-cyber-range/scenario-runtime';
import type { Edge, Node, Viewport } from '@xyflow/react';

import type { TemplateEdge } from './template-editor-screen';
import type { TemplateNode } from '../../../lib/scenario-graph';
import type { NetworkMembership } from './topology-network-model';
import type { PortSide, RoutePoint } from './topology-edge-routing';

export type TopologyFlowNodeType = 'topology-router' | 'topology-switch' | 'topology-ecs';

export type TopologyFlowPort = {
  id: string;
  offset: number;
  side?: PortSide;
};

export type TopologyFlowNodeData = {
  topologyNode: TemplateNode;
  connectMode: boolean;
  sourcePorts: TopologyFlowPort[];
  targetPorts: TopologyFlowPort[];
  networks?: NetworkMembership[];
};

export type TopologyFlowNode = Node<TopologyFlowNodeData, TopologyFlowNodeType>;
export type TopologyFlowEdge = Edge<{ topologyEdge: TemplateEdge; route?: RoutePoint[]; color?: string; description?: string }, 'topology-network'>;
export type TopologyViewport = Pick<Viewport, 'x' | 'y' | 'zoom'>;

export type TopologySnapshot = {
  nodes: TemplateNode[];
  edges: TemplateEdge[];
  viewport: TopologyViewport | null;
  regions?: TopologyRegion[];
};

export type TopologySelection = {
  nodeIds: string[];
  edgeIds: string[];
  regionKey?: string;
};

export function hasSameTopologySelection(left: TopologySelection, right: TopologySelection) {
  if (left.regionKey !== right.regionKey || left.nodeIds.length !== right.nodeIds.length || left.edgeIds.length !== right.edgeIds.length) {
    return false;
  }
  const leftNodeIds = new Set(left.nodeIds);
  const leftEdgeIds = new Set(left.edgeIds);
  return right.nodeIds.every(id => leftNodeIds.has(id)) && right.edgeIds.every(id => leftEdgeIds.has(id));
}

export function clearTopologyObjects(selection: TopologySelection): TopologySelection {
  return { nodeIds: [], edgeIds: [], ...(selection.regionKey ? { regionKey: selection.regionKey } : {}) };
}
