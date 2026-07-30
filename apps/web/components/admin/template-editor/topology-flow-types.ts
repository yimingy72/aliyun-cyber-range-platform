import type { Edge, Node, Viewport } from '@xyflow/react';

import type { TemplateEdge } from './template-editor-screen';
import type { TemplateNode } from '../../../lib/scenario-graph';

export type TopologyFlowNodeType = 'topology-router' | 'topology-switch' | 'topology-ecs';

export type TopologyFlowPort = {
  id: string;
  offset: number;
};

export type TopologyFlowNodeData = {
  topologyNode: TemplateNode;
  connectMode: boolean;
  sourcePorts: TopologyFlowPort[];
  targetPorts: TopologyFlowPort[];
};

export type TopologyFlowNode = Node<TopologyFlowNodeData, TopologyFlowNodeType>;
export type TopologyFlowEdge = Edge<{ topologyEdge: TemplateEdge }, 'bezier'>;
export type TopologyViewport = Pick<Viewport, 'x' | 'y' | 'zoom'>;

export type TopologySnapshot = {
  nodes: TemplateNode[];
  edges: TemplateEdge[];
  viewport: TopologyViewport | null;
};

export type TopologySelection = {
  nodeIds: string[];
  edgeIds: string[];
};
