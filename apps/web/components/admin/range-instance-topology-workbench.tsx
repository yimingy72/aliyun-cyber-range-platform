import React from 'react';

type RangeInstanceWorkbenchNode = {
  id: string;
  label: string;
  kind: string;
  typeLabel?: string;
  subtitle?: string;
  x?: number;
  y?: number;
};

type RangeInstanceTopologyWorkbenchProps = {
  nodes: RangeInstanceWorkbenchNode[];
  edges?: Array<{ id: string; fromNodeId: string; toNodeId: string }>;
  onSelectNode?: (nodeId: string) => void;
  selectedNodeId?: string | null;
};

export function RangeInstanceTopologyWorkbench({
  nodes,
  edges = [],
  onSelectNode,
  selectedNodeId,
}: RangeInstanceTopologyWorkbenchProps) {
  const bounds = readBounds(nodes);
  const normalizedNodes = nodes.map((node) => ({
    ...node,
    left: normalizeCoordinate(node.x ?? 0, bounds.minX, bounds.maxX, 120, 680),
    top: normalizeCoordinate(node.y ?? 0, bounds.minY, bounds.maxY, 90, 420),
  }));

  return (
    <div className="range-instance-topology-workbench">
      <div className="range-instance-topology-legend">
        <span>主机设备</span>
        <span>交换机</span>
        <span>路由器</span>
      </div>
      <div className="range-instance-topology-canvas">
        <svg className="range-instance-topology-lines" aria-hidden="true">
          {edges.map((edge) => {
            const fromNode = normalizedNodes.find((node) => node.id === edge.fromNodeId);
            const toNode = normalizedNodes.find((node) => node.id === edge.toNodeId);

            if (!fromNode || !toNode) {
              return null;
            }

            return (
              <line
                key={edge.id}
                x1={fromNode.left + 42}
                y1={fromNode.top + 42}
                x2={toNode.left + 42}
                y2={toNode.top + 42}
              />
            );
          })}
        </svg>

        {normalizedNodes.map((node) => (
          <div
            key={node.id}
            className={`range-instance-topology-node kind-${node.kind}${selectedNodeId === node.id ? ' is-selected' : ''}`}
            role="button"
            tabIndex={0}
            style={{ left: `${node.left}px`, top: `${node.top}px` }}
            onClick={() => onSelectNode?.(node.id)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onSelectNode?.(node.id);
              }
            }}
          >
            <div className="range-instance-topology-node-icon" />
            <div className="range-instance-topology-node-copy">
              <strong>{node.label}</strong>
              <span>{node.subtitle ?? node.typeLabel ?? node.kind}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function readBounds(nodes: RangeInstanceWorkbenchNode[]) {
  if (!nodes.length) {
    return { minX: 0, maxX: 1, minY: 0, maxY: 1 };
  }

  const xs = nodes.map((node) => node.x ?? 0);
  const ys = nodes.map((node) => node.y ?? 0);

  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
  };
}

function normalizeCoordinate(value: number, min: number, max: number, start: number, end: number) {
  if (min === max) {
    return (start + end) / 2;
  }

  const ratio = (value - min) / (max - min);
  return start + ratio * (end - start);
}
