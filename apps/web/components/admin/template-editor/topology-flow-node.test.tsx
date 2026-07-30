// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { ReactFlow } from '@xyflow/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TopologyFlowNode } from './topology-flow-node';
import type { TopologyFlowNodeData } from './topology-flow-types';
import type { TemplateNode } from '../../../lib/scenario-graph';

const updateNodeInternals = vi.hoisted(() => vi.fn());

vi.mock('@xyflow/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xyflow/react')>();

  return {
    ...actual,
    useUpdateNodeInternals: () => updateNodeInternals,
  };
});

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
  vi.clearAllMocks();
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

function createFlowNode(
  topologyNode: TemplateNode,
  connectMode: boolean,
  ports: Partial<Pick<TopologyFlowNodeData, 'sourcePorts' | 'targetPorts'>> = {},
) {
  return (
    <div style={{ height: 400, width: 640 }}>
      <ReactFlow
        nodes={[{
          id: topologyNode.id,
          type: 'topology',
          position: { x: 120, y: 100 },
          data: {
            topologyNode,
            connectMode,
            sourcePorts: ports.sourcePorts ?? [],
            targetPorts: ports.targetPorts ?? [],
          },
        }]}
        nodeTypes={{ topology: TopologyFlowNode }}
        nodesDraggable={false}
      />
    </div>,
  );
}

function renderFlowNode(
  topologyNode: TemplateNode,
  connectMode: boolean,
  ports: Partial<Pick<TopologyFlowNodeData, 'sourcePorts' | 'targetPorts'>> = {},
) {
  return render(createFlowNode(topologyNode, connectMode, ports));
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

  it('始终保留连线锚点，并在同一节点切换到连线模式时刷新 Handle', () => {
    const { rerender } = renderFlowNode(ecsNode, false);

    expect(screen.getByTestId('topology-flow-node').getAttribute('data-connect-mode')).toBe('false');
    expect(screen.getByTestId('topology-flow-source-handle')).toBeTruthy();
    expect(screen.getByTestId('topology-flow-target-handle')).toBeTruthy();
    expect(updateNodeInternals).not.toHaveBeenCalled();

    rerender(createFlowNode(ecsNode, true));

    expect(updateNodeInternals).toHaveBeenCalledWith('ecs-web');
    expect(screen.getByTestId('topology-flow-node').getAttribute('data-connect-mode')).toBe('true');
    expect(screen.getByTestId('topology-flow-source-handle')).toBeTruthy();
    expect(screen.getByTestId('topology-flow-target-handle')).toBeTruthy();
  });

  it('为多条已连接边渲染无文字的独立端点', () => {
    renderFlowNode(ecsNode, false, {
      targetPorts: [
        { id: 'target-edge-switch-a-ecs', offset: 26 },
        { id: 'target-edge-switch-b-ecs', offset: 74 },
      ],
    });

    const node = screen.getByTestId('topology-flow-node');
    const targetPorts = screen.getAllByTestId('topology-flow-assigned-target-handle');

    expect(node.getAttribute('data-has-multiple-targets')).toBe('true');
    expect(targetPorts).toHaveLength(2);
    expect(targetPorts.map((port) => port.getAttribute('data-handle-id'))).toEqual([
      'target-edge-switch-a-ecs',
      'target-edge-switch-b-ecs',
    ]);
  });

  it('端点布局变化时请求 React Flow 刷新节点内部结构', () => {
    const { rerender } = renderFlowNode(ecsNode, false);

    rerender(createFlowNode(ecsNode, false, {
      targetPorts: [{ id: 'target-edge-switch-a-ecs', offset: 50 }],
    }));

    expect(updateNodeInternals).toHaveBeenCalledWith('ecs-web');
  });

  it('忽略损坏缓存中的 NIC、网络接口和私网 IP', () => {
    const malformedNode = {
      ...ecsNode,
      nics: [null, { privateIp: 42 }, { privateIp: '' }],
      networkInterfaces: [undefined, { privateIp: false }, { privateIp: '10.70.10.20' }],
      privateIp: 80,
    } as unknown as TemplateNode;

    renderFlowNode(malformedNode, false);

    expect(screen.getByText('Web ECS')).toBeTruthy();
    expect(screen.getByText('10.70.10.20')).toBeTruthy();
  });

  it('在损坏缓存不存在有效私网 IP 时保持可渲染', () => {
    const malformedNode = {
      ...ecsNode,
      nics: [null, { privateIp: null }],
      networkInterfaces: [undefined, { privateIp: 80 }],
      privateIp: null,
    } as unknown as TemplateNode;

    expect(() => renderFlowNode(malformedNode, false)).not.toThrow();
    expect(screen.getByText('Web ECS')).toBeTruthy();
  });
});
