import React from 'react';

type RangeInstanceWorkbenchNode = {
  id: string;
  label: string;
  kind: string;
};

type RangeInstanceNodeDirectoryProps = {
  nodes: RangeInstanceWorkbenchNode[];
};

export function RangeInstanceNodeDirectory({ nodes }: RangeInstanceNodeDirectoryProps) {
  return (
    <div className="range-instance-node-directory">
      {nodes.map((node) => (
        <article key={node.id} className="range-instance-node-card">
          <strong>{node.label}</strong>
          <span>{node.kind}</span>
        </article>
      ))}
    </div>
  );
}
