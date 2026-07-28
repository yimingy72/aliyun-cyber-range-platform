import { graphlib, layout } from '@dagrejs/dagre';

import type { TemplateEdge } from './template-editor-screen';
import type { TemplateNode } from '../../../lib/scenario-graph';

const nodeWidth = 176;
const nodeHeight = 60;
const nodeXByKind: Record<TemplateNode['kind'], number> = {
  router: 80,
  switch: 396,
  ecs: 712,
};

function compareText(left: string, right: string) {
  return left === right ? 0 : left < right ? -1 : 1;
}

function compareEdges(left: TemplateEdge, right: TemplateEdge) {
  return compareText(left.fromNodeId, right.fromNodeId)
    || compareText(left.toNodeId, right.toNodeId)
    || compareText(left.id, right.id);
}

export function layoutTopology(nodes: TemplateNode[], edges: TemplateEdge[]): TemplateNode[] {
  const graph = new graphlib.Graph();
  const sortedNodes = [...nodes].sort((left, right) => compareText(left.id, right.id));
  const knownNodeIds = new Set(sortedNodes.map((node) => node.id));
  const sortedEdges = edges
    .filter((edge) => knownNodeIds.has(edge.fromNodeId) && knownNodeIds.has(edge.toNodeId))
    .sort(compareEdges);

  graph.setDefaultEdgeLabel(() => ({}));
  graph.setGraph({
    rankdir: 'LR',
    ranksep: 140,
    nodesep: 84,
    marginx: 80,
    marginy: 80,
  });

  sortedNodes.forEach((node) => {
    graph.setNode(node.id, { width: nodeWidth, height: nodeHeight });
  });
  sortedEdges.forEach((edge) => {
    graph.setEdge(edge.fromNodeId, edge.toNodeId);
  });

  layout(graph);

  return nodes.map((node) => {
    const position = graph.node(node.id) as { x?: number; y?: number } | undefined;

    return typeof position?.x === 'number' && typeof position.y === 'number'
      ? {
        ...node,
        position: {
          x: nodeXByKind[node.kind],
          y: position.y - nodeHeight / 2,
        },
      }
      : node;
  });
}
