import React from 'react';

type RangeInstanceWorkbenchNode = {
  id: string;
  label: string;
  kind: string;
};

type RangeInstanceTopologyWorkbenchProps = {
  nodes: RangeInstanceWorkbenchNode[];
};

export function RangeInstanceTopologyWorkbench({ nodes }: RangeInstanceTopologyWorkbenchProps) {
  return (
    <div className="range-instance-topology-workbench">
      <div className="range-instance-topology-canvas">
        {nodes.map((node) => (
          <div key={node.id} className="range-instance-topology-node">
            <strong>{node.label}</strong>
            <span>{node.kind}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
