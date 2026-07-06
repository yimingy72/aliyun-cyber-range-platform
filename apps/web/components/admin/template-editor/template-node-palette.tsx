'use client';

import React from 'react';

const HOST_NODE_TYPES = [
  { key: 'ecs', label: '虚拟主机', description: 'virtual client', iconSrc: '/topology-icons/server.svg' },
] as const;

const NETWORK_NODE_TYPES = [
  { key: 'router', label: '路由器', description: 'router', iconSrc: '/topology-icons/router.svg' },
  { key: 'switch', label: '交换机', description: 'switch', iconSrc: '/topology-icons/switch.svg' },
] as const;

type TemplateNodePaletteProps = {
  onAddNode: (kind: string) => void;
};

export function TemplateNodePalette({ onAddNode }: TemplateNodePaletteProps) {
  return (
    <aside className="template-editor-panel">
      <div className="admin-section-header">
        <h2>资源面板</h2>
      </div>

      <div className="template-node-palette">
        <div className="template-node-group">
          <strong className="template-node-group-title">主机设备</strong>
          {HOST_NODE_TYPES.map((nodeType) => (
            <button
              key={nodeType.key}
              type="button"
              className="template-node-card"
              onClick={() => onAddNode(nodeType.key)}
            >
              <img
                src={nodeType.iconSrc}
                alt=""
                aria-hidden="true"
                className="template-node-card-icon"
                data-testid={`template-node-palette-icon-${nodeType.key}`}
              />
              <span className="template-node-card-copy">
                <strong>{nodeType.label}</strong>
                <span>{nodeType.description}</span>
              </span>
            </button>
          ))}
        </div>
        <div className="template-node-group">
          <strong className="template-node-group-title">网络设备</strong>
          {NETWORK_NODE_TYPES.map((nodeType) => (
            <button
              key={nodeType.key}
              type="button"
              className="template-node-card"
              onClick={() => onAddNode(nodeType.key)}
            >
              <img
                src={nodeType.iconSrc}
                alt=""
                aria-hidden="true"
                className="template-node-card-icon"
                data-testid={`template-node-palette-icon-${nodeType.key}`}
              />
              <span className="template-node-card-copy">
                <strong>{nodeType.label}</strong>
                <span>{nodeType.description}</span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </aside>
  );
}
