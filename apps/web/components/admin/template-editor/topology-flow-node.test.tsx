// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { ReactFlow } from '@xyflow/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TopologyFlowNode } from './topology-flow-node';
import type { TemplateNode } from '../../../lib/scenario-graph';

class TestResizeObserver {
  observe() {}

  unobserve() {}

  disconnect() {}
}

vi.stubGlobal('ResizeObserver', TestResizeObserver);
vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
  callback(0);
  return 1;
});
vi.stubGlobal('cancelAnimationFrame', () => {});

afterEach(() => {
  cleanup();
});

const routerNode: TemplateNode = {
  id: 'router-1',
  kind: 'router',
  label: '主路由器',
  routeRole: 'core',
  egressType: 'internet',
  bindEip: true,
};

const switchNode: TemplateNode = {
  id: 'switch-dmz',
  kind: 'switch',
  label: 'DMZ 交换机',
  zoneKey: 'dmz',
  cidr: '10.70.10.0/24',
  purpose: 'dmz',
};

const ecsNode: TemplateNode = {
  id: 'ecs-web',
  kind: 'ecs',
  label: 'Web ECS',
  zoneKey: 'dmz',
  role: 'web',
  privateIp: '10.70.10.10',
  exposePublic: false,
  image: 'aliyun_linux_3_x64_20G_alibase',
  dnatMappings: [],
  networkInterfaces: [{ zoneKey: 'dmz', privateIp: '10.70.10.10' }],
  portGroups: [],
  nics: [{
    id: 'ecs-web-nic-1',
    switchId: 'switch-dmz',
    privateIp: '10.70.10.10',
    secondaryIps: [],
    securityGroupRules: [],
  }],
  initScript: '',
  imageStrategy: { mode: 'fixed', imageId: 'aliyun_linux_3_x64_20G_alibase' },
  instanceTypeStrategy: { mode: 'auto' },
};

function renderFlowNode(topologyNode: TemplateNode, connectMode: boolean) {
  render(
    <div style={{ height: 400, width: 640 }}>
      <ReactFlow
        nodes={[{
          id: topologyNode.id,
          type: 'topology',
          position: { x: 120, y: 100 },
          data: { topologyNode, connectMode },
        }]}
        nodeTypes={{ topology: TopologyFlowNode }}
        nodesDraggable={false}
      />
    </div>,
  );
}

describe('TopologyFlowNode', () => {
  it.each([
    [routerNode, 'VPC 根节点', '/topology-icons/router.svg'],
    [switchNode, '10.70.10.0/24', '/topology-icons/switch.svg'],
    [ecsNode, '10.70.10.10', '/topology-icons/server.svg'],
  ] as const)('呈现 %s 类型节点的名称、元数据和既有图标', (node, metadata, iconSrc) => {
    renderFlowNode(node, false);

    expect(screen.getByTestId('topology-flow-node').getAttribute('data-kind')).toBe(node.kind);
    expect(screen.getByText(node.label)).toBeTruthy();
    expect(screen.getByText(metadata)).toBeTruthy();
    expect(screen.getByTestId('topology-flow-node-icon').getAttribute('src')).toBe(iconSrc);
  });

  it('只在连线模式显示 source 和 target Handle', () => {
    renderFlowNode(ecsNode, false);

    expect(screen.queryByTestId('topology-flow-source-handle')).toBeNull();
    expect(screen.queryByTestId('topology-flow-target-handle')).toBeNull();

    cleanup();
    renderFlowNode(ecsNode, true);

    expect(screen.getByTestId('topology-flow-source-handle')).toBeTruthy();
    expect(screen.getByTestId('topology-flow-target-handle')).toBeTruthy();
  });
});
