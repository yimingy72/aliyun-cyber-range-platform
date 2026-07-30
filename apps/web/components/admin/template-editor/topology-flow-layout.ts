import type { TemplateEdge } from './template-editor-screen';
import type { TemplateNode } from '../../../lib/scenario-graph';

const nodeHeight = 60;
const nodeYGap = 84;
const nodeXByKind: Record<TemplateNode['kind'], number> = {
  router: 80,
  switch: 396,
  ecs: 712,
};
const kindOrder: TemplateNode['kind'][] = ['router', 'switch', 'ecs'];

function compareText(left: string, right: string) {
  return left === right ? 0 : left < right ? -1 : 1;
}

function compareNodes(left: TemplateNode, right: TemplateNode) {
  return compareText(left.id, right.id) || compareText(left.label, right.label);
}

export function layoutTopology(nodes: TemplateNode[], edges: TemplateEdge[]): TemplateNode[] {
  void edges;

  const positionById = new Map<string, { x: number; y: number }>();

  for (const kind of kindOrder) {
    const columnNodes = nodes
      .filter((node) => node.kind === kind)
      .sort(compareNodes);

    columnNodes.forEach((node, index) => {
      positionById.set(node.id, {
        x: nodeXByKind[kind],
        y: 80 + index * (nodeHeight + nodeYGap),
      });
    });
  }

  return nodes.map((node) => {
    const position = positionById.get(node.id);

    return position
      ? {
        ...node,
        position,
      }
      : node;
  });
}
