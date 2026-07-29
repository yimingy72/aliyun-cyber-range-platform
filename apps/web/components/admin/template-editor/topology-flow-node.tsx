'use client';

import React from 'react';
import { Handle, Position, type NodeProps, useUpdateNodeInternals } from '@xyflow/react';

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

function readFirstPrivateIp(value: unknown) {
  if (!Array.isArray(value)) {
    return null;
  }

  for (const item of value) {
    if (!item || typeof item !== 'object') {
      continue;
    }

    const privateIp = (item as { privateIp?: unknown }).privateIp;

    if (typeof privateIp === 'string' && privateIp.trim().length > 0) {
      return privateIp;
    }
  }

  return null;
}

function readNodeMeta(node: TemplateNode) {
  switch (node.kind) {
    case 'router':
      return 'VPC 根节点';
    case 'switch':
      return node.cidr;
    case 'ecs':
      return readFirstPrivateIp(node.nics)
        ?? readFirstPrivateIp(node.networkInterfaces)
        ?? (typeof node.privateIp === 'string' ? node.privateIp : '');
  }
}

export const TopologyFlowNode = React.memo(function TopologyFlowNode({
  id,
  data,
  selected,
  isConnectable,
}: NodeProps<TopologyFlowNodeModel>) {
  const { topologyNode, connectMode } = data;
  const updateNodeInternals = useUpdateNodeInternals();
  const previousConnectMode = React.useRef(connectMode);

  React.useEffect(() => {
    if (previousConnectMode.current !== connectMode) {
      updateNodeInternals(id);
    }

    previousConnectMode.current = connectMode;
  }, [connectMode, id, updateNodeInternals]);

  return (
    <div
      className="topology-flow-node"
      data-connect-mode={connectMode ? 'true' : 'false'}
      data-kind={topologyNode.kind}
      data-selected={selected ? 'true' : 'false'}
      data-testid="topology-flow-node"
    >
      <Handle
        data-testid="topology-flow-target-handle"
        isConnectable={connectMode && isConnectable}
        position={Position.Left}
        type="target"
      />
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
      <Handle
        data-testid="topology-flow-source-handle"
        isConnectable={connectMode && isConnectable}
        position={Position.Right}
        type="source"
      />
    </div>
  );
});
