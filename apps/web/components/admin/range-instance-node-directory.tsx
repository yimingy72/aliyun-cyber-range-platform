import React from 'react';

type RangeInstanceWorkbenchNode = {
  id: string;
  label: string;
  kind: string;
};

type RangeInstanceNodeDirectoryProps = {
  nodes: RangeInstanceWorkbenchNode[];
  onSelectNode?: (nodeId: string) => void;
};

export function RangeInstanceNodeDirectory({ nodes, onSelectNode }: RangeInstanceNodeDirectoryProps) {
  return (
    <div className="range-instance-node-directory">
      {nodes.map((node) => (
        <article
          key={node.id}
          className="range-instance-node-card"
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
        </article>
      ))}
    </div>
  );
}
