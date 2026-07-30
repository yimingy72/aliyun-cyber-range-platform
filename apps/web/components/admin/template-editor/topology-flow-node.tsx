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
  const {
    topologyNode,
    connectMode,
    sourcePorts = [],
    targetPorts = [],
  } = data;
  const updateNodeInternals = useUpdateNodeInternals();
  const portSignature = [
    connectMode ? 'connect' : 'select',
    ...sourcePorts.map((port) => `source:${port.id}:${port.offset}`),
    ...targetPorts.map((port) => `target:${port.id}:${port.offset}`),
  ].join('|');
  const previousPortSignature = React.useRef(portSignature);

  React.useEffect(() => {
    if (previousPortSignature.current !== portSignature) {
      updateNodeInternals(id);
    }

    previousPortSignature.current = portSignature;
  }, [id, portSignature, updateNodeInternals]);

  return (
    <div
      className="topology-flow-node"
      data-connect-mode={connectMode ? 'true' : 'false'}
      data-has-multiple-sources={sourcePorts.length > 1 ? 'true' : 'false'}
      data-has-multiple-targets={targetPorts.length > 1 ? 'true' : 'false'}
      data-kind={topologyNode.kind}
      data-selected={selected ? 'true' : 'false'}
      data-testid="topology-flow-node"
    >
      <Handle
        className="topology-flow-node-default-handle"
        data-testid="topology-flow-target-handle"
        id="target-default"
        isConnectable={connectMode && isConnectable}
        position={Position.Left}
        type="target"
      />
      {targetPorts.map((port) => (
        <Handle
          className="topology-flow-node-assigned-handle topology-flow-node-target-port"
          data-handle-id={port.id}
          data-testid="topology-flow-assigned-target-handle"
          id={port.id}
          isConnectable={connectMode && isConnectable}
          key={port.id}
          position={Position.Left}
          style={{ top: `${port.offset}%` }}
          type="target"
        />
      ))}
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
      {sourcePorts.map((port) => (
        <Handle
          className="topology-flow-node-assigned-handle topology-flow-node-source-port"
          data-handle-id={port.id}
          data-testid="topology-flow-assigned-source-handle"
          id={port.id}
          isConnectable={connectMode && isConnectable}
          key={port.id}
          position={Position.Right}
          style={{ top: `${port.offset}%` }}
          type="source"
        />
      ))}
      <Handle
        className="topology-flow-node-default-handle"
        data-testid="topology-flow-source-handle"
        id="source-default"
        isConnectable={connectMode && isConnectable}
        position={Position.Right}
        type="source"
      />
    </div>
  );
});
