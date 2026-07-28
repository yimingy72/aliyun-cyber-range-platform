import { graphlib, layout } from '@dagrejs/dagre';

import type { TemplateEdge } from './template-editor-screen';
import type { TemplateNode } from '../../../lib/scenario-graph';

const nodeWidth = 176;
const nodeHeight = 60;

export function layoutTopology(nodes: TemplateNode[], edges: TemplateEdge[]): TemplateNode[] {
  const graph = new graphlib.Graph();

  graph.setDefaultEdgeLabel(() => ({}));
  graph.setGraph({
    rankdir: 'LR',
    ranksep: 140,
    nodesep: 84,
    marginx: 80,
    marginy: 80,
  });

  nodes.forEach((node) => {
    graph.setNode(node.id, { width: nodeWidth, height: nodeHeight });
  });
  edges.forEach((edge) => {
    graph.setEdge(edge.fromNodeId, edge.toNodeId);
  });

  layout(graph);

  return nodes.map((node) => {
    const position = graph.node(node.id) as { x?: number; y?: number } | undefined;

    return typeof position?.x === 'number' && typeof position.y === 'number'
      ? {
        ...node,
        position: {
          x: position.x - nodeWidth / 2,
          y: position.y - nodeHeight / 2,
        },
      }
      : node;
  });
}
