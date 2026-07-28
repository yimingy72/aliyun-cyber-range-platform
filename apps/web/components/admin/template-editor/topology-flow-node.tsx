'use client';

import React from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';

import type { TopologyFlowNode as TopologyFlowNodeModel } from './topology-flow-types';
import type { TemplateNode } from '../../../lib/scenario-graph';

function readNodeIcon(kind: TemplateNode['kind']) {
  switch (kind) {
    case 'router':
      return '/topology-icons/router.svg';
    case 'switch':
      return '/topology-icons/switch.svg';
    case 'ecs':
      return '/topology-icons/server.svg';
  }
}

function readNodeMeta(node: TemplateNode) {
  switch (node.kind) {
    case 'router':
      return 'VPC 根节点';
    case 'switch':
      return node.cidr;
    case 'ecs':
      return node.nics?.find((nic) => nic.privateIp.trim().length > 0)?.privateIp
        ?? node.networkInterfaces.find((networkInterface) => networkInterface.privateIp.trim().length > 0)?.privateIp
        ?? node.privateIp;
  }
}

export const TopologyFlowNode = React.memo(function TopologyFlowNode({
  data,
  selected,
  isConnectable,
}: NodeProps<TopologyFlowNodeModel>) {
  const { topologyNode, connectMode } = data;

  return (
    <div
      className="topology-flow-node"
      data-kind={topologyNode.kind}
      data-selected={selected ? 'true' : 'false'}
      data-testid="topology-flow-node"
    >
      {connectMode ? (
        <Handle
          data-testid="topology-flow-target-handle"
          isConnectable={isConnectable}
          position={Position.Left}
          type="target"
        />
      ) : null}
      <img
        alt=""
        aria-hidden="true"
        className="topology-flow-node-icon"
        data-testid="topology-flow-node-icon"
        src={readNodeIcon(topologyNode.kind)}
      />
      <span className="topology-flow-node-copy">
        <strong>{topologyNode.label}</strong>
        <span>{readNodeMeta(topologyNode)}</span>
      </span>
      {connectMode ? (
        <Handle
          data-testid="topology-flow-source-handle"
          isConnectable={isConnectable}
          position={Position.Right}
          type="source"
        />
      ) : null}
    </div>
  );
});
