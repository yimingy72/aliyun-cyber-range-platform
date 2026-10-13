'use client';

import { Button } from '@/components/ui/button';

import React from 'react';
import { Box, Network, Router, Server, X, type LucideIcon } from 'lucide-react';

export const topologyResourceKinds = ['router', 'switch', 'ecs'] as const;
export type TopologyResourceKind = (typeof topologyResourceKinds)[number];

const resourcePaletteId = 'topology-resource-palette';

type ResourceEntry = {
  kind: TopologyResourceKind;
  label: string;
  description: string;
  Icon: LucideIcon;
};

type TopologyFlowResourceRailProps = {
  disabled?: boolean;
  initialExpanded?: boolean;
  onAddNode: (kind: TopologyResourceKind) => void;
  onDragStart?: (event: React.DragEvent<HTMLButtonElement>, kind: TopologyResourceKind) => void;
};

const resourceEntries: readonly ResourceEntry[] = [
  {
    kind: 'router',
    label: '路由器',
    description: 'VPC 根节点',
    Icon: Router,
  },
  {
    kind: 'switch',
    label: '交换机',
    description: '网络隔离子网',
    Icon: Network,
  },
  {
    kind: 'ecs',
    label: 'ECS 主机',
    description: '虚拟计算节点',
    Icon: Server,
  },
];

export function TopologyFlowResourceRail({
  disabled = false,
  initialExpanded = false,
  onAddNode,
  onDragStart,
}: TopologyFlowResourceRailProps) {
  const [expanded, setExpanded] = React.useState(initialExpanded);

  function handleDragStart(event: React.DragEvent<HTMLButtonElement>, kind: TopologyResourceKind) {
    if (disabled) {
      return;
    }

    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('application/x-topology-node-kind', kind);
    onDragStart?.(event, kind);
  }

  return (
    <aside
      className="topology-resource-rail"
      data-expanded={expanded ? 'true' : 'false'}
      data-testid="topology-resource-rail"
    >
      <Button variant="ghost"
        aria-label={expanded ? '关闭资源面板' : '打开资源面板'}
        aria-controls={resourcePaletteId}
        aria-expanded={expanded}
        className="topology-resource-rail-toggle"
        onClick={() => setExpanded((value) => !value)}
        title={expanded ? '关闭资源面板' : '打开资源面板'}
        type="button"
      >
        {expanded ? <X aria-hidden="true" /> : <Box aria-hidden="true" />}
      </Button>
      {expanded ? (
        <div
          className="topology-resource-palette"
          data-testid="topology-resource-palette"
          id={resourcePaletteId}
        >
          {resourceEntries.map(({ kind, label, description, Icon }) => (
            <Button variant="ghost"
              aria-label={label}
              aria-describedby={`topology-resource-description-${kind}`}
              className="topology-resource-entry"
              data-kind={kind}
              data-testid="topology-resource-entry"
              disabled={disabled}
              draggable={!disabled}
              key={kind}
              onClick={() => {
                if (!disabled) {
                  onAddNode(kind);
                }
              }}
              onDragStart={(event) => handleDragStart(event, kind)}
              type="button"
            >
              <Icon aria-hidden="true" />
              <span>
                <strong>{label}</strong>
                <small id={`topology-resource-description-${kind}`}>{description}</small>
              </span>
            </Button>
          ))}
        </div>
      ) : null}
    </aside>
  );
}
