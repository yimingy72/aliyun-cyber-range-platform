import React from 'react';

type RangeInstanceWorkbenchNode = {
  id: string;
  label: string;
  kind: string;
};

type RangeInstanceTopologyWorkbenchProps = {
  nodes: RangeInstanceWorkbenchNode[];
  onSelectNode?: (nodeId: string) => void;
};

export function RangeInstanceTopologyWorkbench({ nodes, onSelectNode }: RangeInstanceTopologyWorkbenchProps) {
  return (
    <div className="range-instance-topology-workbench">
      <div className="range-instance-topology-canvas">
        {nodes.map((node) => (
          <div
            key={node.id}
            className="range-instance-topology-node"
            role="button"
            tabIndex={0}
            onClick={() => onSelectNode?.(node.id)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onSelectNode?.(node.id);
              }
            }}
          >
            <strong>{node.label}</strong>
            <span>{node.kind}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
