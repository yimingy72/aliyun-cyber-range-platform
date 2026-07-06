import React from 'react';
import { useState } from 'react';

type RangeInstanceWorkbenchNode = {
  id: string;
  label: string;
  kind: string;
};

type RangeInstanceNodeDirectoryProps = {
  nodes: RangeInstanceWorkbenchNode[];
  onSelectNode?: (nodeId: string) => void;
  onNodeAction?: (nodeId: string, action: 'stop' | 'reboot' | 'open-vnc' | 'pack-image') => void;
};

export function RangeInstanceNodeDirectory({
  nodes,
  onSelectNode,
  onNodeAction,
}: RangeInstanceNodeDirectoryProps) {
  const [expandedNodeId, setExpandedNodeId] = useState<string | null>(null);

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
          {node.kind === 'ecs' ? (
            <div className="range-instance-node-card-actions">
              <button type="button" onClick={() => onNodeAction?.(node.id, 'stop')}>
                关机
              </button>
              <button type="button" onClick={() => onNodeAction?.(node.id, 'reboot')}>
                重启
              </button>
              <button type="button" onClick={() => onNodeAction?.(node.id, 'open-vnc')}>
                打开VNC
              </button>
              <button
                type="button"
                onClick={() => setExpandedNodeId((current) => (current === node.id ? null : node.id))}
              >
                更多
              </button>
              {expandedNodeId === node.id ? (
                <div className="range-instance-node-card-more">
                  <button type="button">重置</button>
                  <button type="button" onClick={() => onNodeAction?.(node.id, 'pack-image')}>
                    二次打包镜像
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
        </article>
      ))}
    </div>
  );
}
