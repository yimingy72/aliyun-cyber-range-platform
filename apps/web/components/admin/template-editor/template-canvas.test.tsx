// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TemplateEdge } from './template-editor-screen';
import { TemplateCanvas } from './template-canvas';
import type { TemplateNode } from '../../../lib/scenario-graph';

afterEach(() => {
  cleanup();
});

describe('TemplateCanvas', () => {
  it('renders positioned nodes on a freeform board instead of only lane lists', () => {
    const onSelectNode = vi.fn();
    const nodes: TemplateNode[] = [
      {
        id: 'router-1',
        kind: 'router',
        label: '主路由器',
        position: { x: 80, y: 120 },
        description: '根 VPC',
        routeRole: 'core',
        egressType: 'internet',
        bindEip: false,
      },
      {
        id: 'switch-1',
        kind: 'switch',
        label: '业务交换机',
        position: { x: 320, y: 120 },
        zoneKey: 'core',
        cidr: '10.70.10.0/24',
        purpose: 'business-zone',
        description: '默认业务网段',
        aclRules: [],
        nat: {
          snatEnabled: false,
          dnatMappings: [],
        },
      },
    ];
    const edges: TemplateEdge[] = [
      {
        id: 'edge-router-switch',
        fromNodeId: 'router-1',
        toNodeId: 'switch-1',
        relationType: 'manual',
        label: '主路由器 -> 业务交换机',
      },
    ];

    render(
      <TemplateCanvas
        topologyGraph={{ schemaVersion: '1.0.0', nodes, edges }}
        nodes={nodes}
        edges={edges}
        selectedNodeId={null}
        pendingLinkSourceNodeId={null}
        onSelectNode={onSelectNode}
        onOpenNode={vi.fn()}
      />,
    );

    const routerButton = screen.getByRole('button', { name: /主路由器/ });
    const switchButton = screen.getByRole('button', { name: /业务交换机/ });

    expect(routerButton.getAttribute('style')).toContain('left: 80px');
    expect(routerButton.getAttribute('style')).toContain('top: 120px');
    expect(switchButton.getAttribute('style')).toContain('left: 320px');
    expect(switchButton.getAttribute('style')).toContain('top: 120px');
    expect(screen.getByTestId('template-canvas-board')).toBeTruthy();
    expect(screen.getByTestId('template-canvas-edge-edge-router-switch')).toBeTruthy();
    expect(screen.getByTestId('template-canvas-icon-router-1')).toBeTruthy();
    expect(screen.getByTestId('template-canvas-icon-switch-1')).toBeTruthy();
    expect(routerButton.getAttribute('aria-label')).toContain('VPC 根节点');
    expect(screen.queryByText('Router 层')).toBeNull();

    fireEvent.click(routerButton);
    expect(onSelectNode).toHaveBeenCalledWith('router-1');
  });

  it('shows the primary ecs ip under the node title when nic data exists', () => {
    const nodes: TemplateNode[] = [
      {
        id: 'ecs-1',
        kind: 'ecs',
        label: 'ECS 1',
        position: { x: 620, y: 220 },
        instanceName: 'ecs-1',
        hostName: 'ecs-1',
        zoneKey: 'core',
        role: 'entry',
        privateIp: '',
        exposePublic: true,
        image: 'aliyun_linux_3_x64_20G_alibase',
        imageName: 'aliyun_linux_3_x64_20G_alibase',
        imageId: 'aliyun_linux_3_x64_20G_alibase',
        cpu: 2,
        memory: 4,
        description: '',
        bootPriority: 1,
        bootWaitSeconds: 0,
        dnatMappings: [],
        networkInterfaces: [{ zoneKey: 'core', privateIp: '10.0.0.13' }],
        portGroups: [],
        nics: [
          {
            id: 'ecs-1-nic-1',
            switchId: 'switch-1',
            privateIp: '10.0.0.13',
            secondaryIps: [],
            securityGroupRules: [],
          },
        ],
        initScript: '',
        imageStrategy: { mode: 'fixed', imageId: 'aliyun_linux_3_x64_20G_alibase' },
        instanceTypeStrategy: { mode: 'auto', preferredInstanceTypes: [] },
      },
    ];

    render(
      <TemplateCanvas
        topologyGraph={{ schemaVersion: '2.0.0', nodes, edges: [] }}
        nodes={nodes}
        edges={[]}
        selectedNodeId={null}
        pendingLinkSourceNodeId={null}
        onSelectNode={vi.fn()}
        onOpenNode={vi.fn()}
      />,
    );

    expect(screen.getByText('10.0.0.13')).toBeTruthy();
  });

  it('reports node movement while dragging on the board', () => {
    const onMoveNode = vi.fn();
    const nodes: TemplateNode[] = [
      {
        id: 'ecs-1',
        kind: 'ecs',
        label: '业务 ECS',
        position: { x: 620, y: 220 },
        instanceName: 'ecs-1',
        hostName: 'ecs-1',
        zoneKey: 'core',
        role: 'entry',
        privateIp: '10.70.10.10',
        exposePublic: true,
        image: 'aliyun_linux_3_x64_20G_alibase',
        imageName: 'aliyun_linux_3_x64_20G_alibase',
        imageId: 'aliyun_linux_3_x64_20G_alibase',
        cpu: 2,
        memory: 4,
        description: '',
        bootPriority: 1,
        bootWaitSeconds: 0,
        dnatMappings: [],
        networkInterfaces: [{ zoneKey: 'core', privateIp: '10.70.10.10' }],
        portGroups: [],
        nics: [
          {
            id: 'ecs-1-nic-1',
            switchId: 'switch-core',
            privateIp: '10.70.10.10',
            secondaryIps: [],
            securityGroupRules: [],
          },
        ],
        initScript: '',
        imageStrategy: { mode: 'fixed', imageId: 'aliyun_linux_3_x64_20G_alibase' },
        instanceTypeStrategy: { mode: 'auto', preferredInstanceTypes: [] },
      },
    ];

    render(
      <TemplateCanvas
        topologyGraph={{ schemaVersion: '1.0.0', nodes, edges: [] }}
        nodes={nodes}
        edges={[]}
        selectedNodeId={null}
        pendingLinkSourceNodeId={null}
        onSelectNode={vi.fn()}
        onOpenNode={vi.fn()}
        onMoveNode={onMoveNode}
      />,
    );

    const node = screen.getByRole('button', { name: /业务 ECS/ });
    fireEvent.mouseDown(node, { clientX: 620, clientY: 220, button: 0 });
    fireEvent.mouseMove(window, { clientX: 700, clientY: 260 });
    fireEvent.mouseUp(window);

    expect(onMoveNode).toHaveBeenCalledWith('ecs-1', {
      x: 700,
      y: 260,
    });
  });

  it('updates the dragged node preview immediately before mouseup so edge clipping does not lag behind', () => {
    const onMoveNode = vi.fn();
    const nodes: TemplateNode[] = [
      {
        id: 'ecs-1',
        kind: 'ecs',
        label: '业务 ECS',
        position: { x: 620, y: 220 },
        instanceName: 'ecs-1',
        hostName: 'ecs-1',
        zoneKey: 'core',
        role: 'entry',
        privateIp: '10.70.10.10',
        exposePublic: true,
        image: 'aliyun_linux_3_x64_20G_alibase',
        imageName: 'aliyun_linux_3_x64_20G_alibase',
        imageId: 'aliyun_linux_3_x64_20G_alibase',
        cpu: 2,
        memory: 4,
        description: '',
        bootPriority: 1,
        bootWaitSeconds: 0,
        dnatMappings: [],
        networkInterfaces: [{ zoneKey: 'core', privateIp: '10.70.10.10' }],
        portGroups: [],
        nics: [
          {
            id: 'ecs-1-nic-1',
            switchId: 'switch-core',
            privateIp: '10.70.10.10',
            secondaryIps: [],
            securityGroupRules: [],
          },
        ],
        initScript: '',
        imageStrategy: { mode: 'fixed', imageId: 'aliyun_linux_3_x64_20G_alibase' },
        instanceTypeStrategy: { mode: 'auto', preferredInstanceTypes: [] },
      },
    ];

    render(
      <TemplateCanvas
        topologyGraph={{ schemaVersion: '2.0.0', nodes, edges: [] }}
        nodes={nodes}
        edges={[]}
        selectedNodeId={null}
        pendingLinkSourceNodeId={null}
        onSelectNode={vi.fn()}
        onOpenNode={vi.fn()}
        onMoveNode={onMoveNode}
      />,
    );

    const node = screen.getByRole('button', { name: /业务 ECS/ });
    fireEvent.mouseDown(node, { clientX: 620, clientY: 220, button: 0 });
    fireEvent.mouseMove(window, { clientX: 700, clientY: 320 });

    expect(node.getAttribute('style')).toContain('left: 700px');
    expect(node.getAttribute('style')).toContain('top: 320px');
  });

  it('keeps scene bounds stable during drag so moving left actually shifts the preview left instead of hitting an early wall', () => {
    const onMoveNode = vi.fn();
    const nodes: TemplateNode[] = [
      {
        id: 'router-1',
        kind: 'router',
        label: 'Router',
        position: { x: 80, y: 120 },
        description: '根 VPC',
        routeRole: 'core',
        egressType: 'internet',
        bindEip: false,
      },
    ];

    render(
      <TemplateCanvas
        topologyGraph={{ schemaVersion: '2.0.0', nodes, edges: [] }}
        nodes={nodes}
        edges={[]}
        selectedNodeId={null}
        pendingLinkSourceNodeId={null}
        onSelectNode={vi.fn()}
        onOpenNode={vi.fn()}
        onMoveNode={onMoveNode}
      />,
    );

    const node = screen.getByRole('button', { name: /Router/ });
    expect(node.getAttribute('style')).toContain('left: 80px');

    fireEvent.mouseDown(node, { clientX: 300, clientY: 200, button: 0 });
    fireEvent.mouseMove(window, { clientX: 200, clientY: 200 });

    expect(node.getAttribute('style')).toContain('left: -20px');
  });

  it('marks the board as dragging so the canvas can temporarily avoid clipping during live drag', () => {
    const onMoveNode = vi.fn();
    const nodes: TemplateNode[] = [
      {
        id: 'ecs-1',
        kind: 'ecs',
        label: '业务 ECS',
        position: { x: 620, y: 220 },
        instanceName: 'ecs-1',
        hostName: 'ecs-1',
        zoneKey: 'core',
        role: 'entry',
        privateIp: '10.70.10.10',
        exposePublic: true,
        image: 'aliyun_linux_3_x64_20G_alibase',
        imageName: 'aliyun_linux_3_x64_20G_alibase',
        imageId: 'aliyun_linux_3_x64_20G_alibase',
        cpu: 2,
        memory: 4,
        description: '',
        bootPriority: 1,
        bootWaitSeconds: 0,
        dnatMappings: [],
        networkInterfaces: [{ zoneKey: 'core', privateIp: '10.70.10.10' }],
        portGroups: [],
        nics: [
          {
            id: 'ecs-1-nic-1',
            switchId: 'switch-core',
            privateIp: '10.70.10.10',
            secondaryIps: [],
            securityGroupRules: [],
          },
        ],
        initScript: '',
        imageStrategy: { mode: 'fixed', imageId: 'aliyun_linux_3_x64_20G_alibase' },
        instanceTypeStrategy: { mode: 'auto', preferredInstanceTypes: [] },
      },
    ];

    render(
      <TemplateCanvas
        topologyGraph={{ schemaVersion: '2.0.0', nodes, edges: [] }}
        nodes={nodes}
        edges={[]}
        selectedNodeId={null}
        pendingLinkSourceNodeId={null}
        onSelectNode={vi.fn()}
        onOpenNode={vi.fn()}
        onMoveNode={onMoveNode}
      />,
    );

    const board = screen.getByTestId('template-canvas-board');
    const node = screen.getByRole('button', { name: /业务 ECS/ });

    expect(board.getAttribute('data-dragging')).toBe('false');
    fireEvent.mouseDown(node, { clientX: 620, clientY: 220, button: 0 });
    expect(board.getAttribute('data-dragging')).toBe('true');
    fireEvent.mouseUp(window);
    expect(board.getAttribute('data-dragging')).toBe('false');
  });

  it('marks the board as panning so whole-topology dragging also avoids temporary clipping', () => {
    const nodes: TemplateNode[] = [
      {
        id: 'router-1',
        kind: 'router',
        label: '主路由器',
        position: { x: 80, y: 120 },
        description: '根 VPC',
        routeRole: 'core',
        egressType: 'internet',
        bindEip: false,
      },
    ];

    render(
      <TemplateCanvas
        topologyGraph={{ schemaVersion: '2.0.0', nodes, edges: [] }}
        nodes={nodes}
        edges={[]}
        selectedNodeId={null}
        pendingLinkSourceNodeId={null}
        onSelectNode={vi.fn()}
        onOpenNode={vi.fn()}
        onMoveNode={vi.fn()}
      />,
    );

    const board = screen.getByTestId('template-canvas-board');

    expect(board.getAttribute('data-panning')).toBe('false');
    vi.useFakeTimers();
    fireEvent.mouseDown(board, { clientX: 120, clientY: 120, button: 0 });
    vi.advanceTimersByTime(200);
    fireEvent.mouseMove(window, { clientX: 140, clientY: 140 });
    expect(board.getAttribute('data-panning')).toBe('true');
    fireEvent.mouseUp(window);
    expect(board.getAttribute('data-panning')).toBe('false');
    vi.useRealTimers();
  });

  it('keeps a dedicated status row when the transient status message is cleared so the canvas body does not collapse', () => {
    const nodes: TemplateNode[] = [
      {
        id: 'router-1',
        kind: 'router',
        label: 'Router',
        position: { x: 120, y: 180 },
        description: '根 VPC',
        routeRole: 'core',
        egressType: 'internet',
        bindEip: false,
      },
    ];

    const { rerender } = render(
      <TemplateCanvas
        topologyGraph={{ schemaVersion: '2.0.0', nodes, edges: [] }}
        nodes={nodes}
        edges={[]}
        selectedNodeId={null}
        pendingLinkSourceNodeId={null}
        statusMessage="已删除节点：ECS 2"
        onSelectNode={vi.fn()}
        onOpenNode={vi.fn()}
        onMoveNode={vi.fn()}
      />,
    );

    expect(screen.getByTestId('template-canvas-status-slot').textContent).toContain('已删除节点：ECS 2');

    rerender(
      <TemplateCanvas
        topologyGraph={{ schemaVersion: '2.0.0', nodes, edges: [] }}
        nodes={nodes}
        edges={[]}
        selectedNodeId={null}
        pendingLinkSourceNodeId={null}
        onSelectNode={vi.fn()}
        onOpenNode={vi.fn()}
        onMoveNode={vi.fn()}
      />,
    );

    const statusSlot = screen.getByTestId('template-canvas-status-slot');
    expect(statusSlot).toBeTruthy();
    expect(statusSlot.textContent?.trim()).toBe('');
  });

  it('renders transient canvas status inline with the canvas title instead of taking a separate row', () => {
    const nodes: TemplateNode[] = [
      {
        id: 'router-1',
        kind: 'router',
        label: 'Router',
        position: { x: 120, y: 180 },
        description: '根 VPC',
        routeRole: 'core',
        egressType: 'internet',
        bindEip: false,
      },
    ];

    render(
      <TemplateCanvas
        topologyGraph={{ schemaVersion: '2.0.0', nodes, edges: [] }}
        nodes={nodes}
        edges={[]}
        selectedNodeId={null}
        pendingLinkSourceNodeId={null}
        statusMessage="已选择连线起点，请点击目标节点完成连接。"
        onSelectNode={vi.fn()}
        onOpenNode={vi.fn()}
        onMoveNode={vi.fn()}
      />,
    );

    const heading = screen.getByTestId('template-canvas-heading');
    expect(heading.textContent).toContain('拓扑画布');
    expect(heading.textContent).toContain('已选择连线起点，请点击目标节点完成连接。');
  });

  it('does not render the old empty-canvas helper copy', () => {
    render(
      <TemplateCanvas
        topologyGraph={{ schemaVersion: '2.0.0', nodes: [], edges: [] }}
        nodes={[]}
        edges={[]}
        selectedNodeId={null}
        pendingLinkSourceNodeId={null}
        onSelectNode={vi.fn()}
        onOpenNode={vi.fn()}
        onMoveNode={vi.fn()}
      />,
    );

    expect(screen.queryByText('还没有节点。')).toBeNull();
  });

  it('keeps a fixed viewport and supports panning plus zooming the topology scene', () => {
    const nodes: TemplateNode[] = [
      {
        id: 'router-1',
        kind: 'router',
        label: '主路由器',
        position: { x: 80, y: 120 },
        description: '根 VPC',
        routeRole: 'core',
        egressType: 'internet',
        bindEip: false,
      },
    ];

    render(
      <TemplateCanvas
        topologyGraph={{ schemaVersion: '2.0.0', nodes, edges: [] }}
        nodes={nodes}
        edges={[]}
        selectedNodeId={null}
        pendingLinkSourceNodeId={null}
        onSelectNode={vi.fn()}
        onOpenNode={vi.fn()}
        onMoveNode={vi.fn()}
      />,
    );

    const board = screen.getByTestId('template-canvas-board');
    const scene = screen.getByTestId('template-canvas-scene');
    expect(board.getAttribute('style') ?? '').not.toContain('width:');
    expect(scene.style.transform).toContain('translate(0px, 0px)');

    vi.useFakeTimers();
    fireEvent.mouseDown(board, { clientX: 120, clientY: 120, button: 0 });
    vi.advanceTimersByTime(200);
    fireEvent.mouseMove(window, { clientX: 170, clientY: 150 });
    fireEvent.mouseUp(window);
    vi.useRealTimers();
    expect(scene.style.transform).toContain('translate(50px, 30px)');

    fireEvent.wheel(board, { deltaY: -120 });
    expect(scene.getAttribute('data-scale')).toBe('1.1');
  });

  it('zooms around the pointer so the scene does not behave like the whole canvas is scaling', () => {
    const nodes: TemplateNode[] = [
      {
        id: 'router-1',
        kind: 'router',
        label: '主路由器',
        position: { x: 80, y: 120 },
        description: '根 VPC',
        routeRole: 'core',
        egressType: 'internet',
        bindEip: false,
      },
    ];

    render(
      <TemplateCanvas
        topologyGraph={{ schemaVersion: '2.0.0', nodes, edges: [] }}
        nodes={nodes}
        edges={[]}
        selectedNodeId={null}
        pendingLinkSourceNodeId={null}
        onSelectNode={vi.fn()}
        onOpenNode={vi.fn()}
        onMoveNode={vi.fn()}
      />,
    );

    const board = screen.getByTestId('template-canvas-board');
    const scene = screen.getByTestId('template-canvas-scene');
    vi.spyOn(board, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 1000,
      bottom: 600,
      width: 1000,
      height: 600,
      toJSON: () => ({}),
    });

    fireEvent.wheel(board, { clientX: 500, clientY: 300, deltaY: -120 });

    expect(scene.getAttribute('data-scale')).toBe('1.1');
    expect(scene.style.transform).toContain('translate(-50px, -30px)');
  });

  it('stretches the canvas workspace to the available panel height so bottom nodes are not clipped early', () => {
    const nodes: TemplateNode[] = [
      {
        id: 'ecs-8',
        kind: 'ecs',
        label: 'ECS 8',
        position: { x: 640, y: 760 },
        instanceName: 'ecs-8',
        hostName: 'ecs-8',
        zoneKey: 'core',
        role: 'entry',
        privateIp: '10.70.10.18',
        exposePublic: false,
        image: 'aliyun_linux_3_x64_20G_alibase',
        imageName: 'aliyun_linux_3_x64_20G_alibase',
        imageId: 'aliyun_linux_3_x64_20G_alibase',
        cpu: 2,
        memory: 4,
        description: '',
        bootPriority: 1,
        bootWaitSeconds: 0,
        dnatMappings: [],
        networkInterfaces: [{ zoneKey: 'core', privateIp: '10.70.10.18' }],
        portGroups: [],
        nics: [
          {
            id: 'ecs-8-nic-1',
            switchId: 'switch-core',
            privateIp: '10.70.10.18',
            secondaryIps: [],
            securityGroupRules: [],
          },
        ],
        initScript: '',
        imageStrategy: { mode: 'fixed', imageId: 'aliyun_linux_3_x64_20G_alibase' },
        instanceTypeStrategy: { mode: 'auto', preferredInstanceTypes: [] },
      },
    ];

    render(
      <TemplateCanvas
        topologyGraph={{ schemaVersion: '2.0.0', nodes, edges: [] }}
        nodes={nodes}
        edges={[]}
        selectedNodeId={null}
        pendingLinkSourceNodeId={null}
        onSelectNode={vi.fn()}
        onOpenNode={vi.fn()}
        onMoveNode={vi.fn()}
      />,
    );

    expect(screen.getByTestId('template-canvas-placeholder').getAttribute('style')).toContain('height: 100%');
    expect(screen.getByTestId('template-canvas-board').getAttribute('style')).toContain('height: 100%');
    expect(screen.getByTestId('template-canvas-scene').getAttribute('style')).toContain('height: 1420px');
  });

  it('adjusts node dragging by zoom scale', () => {
    const onMoveNode = vi.fn();
    const nodes: TemplateNode[] = [
      {
        id: 'ecs-1',
        kind: 'ecs',
        label: '业务 ECS',
        position: { x: 620, y: 220 },
        instanceName: 'ecs-1',
        hostName: 'ecs-1',
        zoneKey: 'core',
        role: 'entry',
        privateIp: '10.70.10.10',
        exposePublic: true,
        image: 'aliyun_linux_3_x64_20G_alibase',
        imageName: 'aliyun_linux_3_x64_20G_alibase',
        imageId: 'aliyun_linux_3_x64_20G_alibase',
        cpu: 2,
        memory: 4,
        description: '',
        bootPriority: 1,
        bootWaitSeconds: 0,
        dnatMappings: [],
        networkInterfaces: [{ zoneKey: 'core', privateIp: '10.70.10.10' }],
        portGroups: [],
        nics: [
          {
            id: 'ecs-1-nic-1',
            switchId: 'switch-core',
            privateIp: '10.70.10.10',
            secondaryIps: [],
            securityGroupRules: [],
          },
        ],
        initScript: '',
        imageStrategy: { mode: 'fixed', imageId: 'aliyun_linux_3_x64_20G_alibase' },
        instanceTypeStrategy: { mode: 'auto', preferredInstanceTypes: [] },
      },
    ];

    render(
      <TemplateCanvas
        topologyGraph={{ schemaVersion: '2.0.0', nodes, edges: [] }}
        nodes={nodes}
        edges={[]}
        selectedNodeId={null}
        pendingLinkSourceNodeId={null}
        onSelectNode={vi.fn()}
        onOpenNode={vi.fn()}
        onMoveNode={onMoveNode}
      />,
    );

    const board = screen.getByTestId('template-canvas-board');
    const node = screen.getByRole('button', { name: /业务 ECS/ });
    fireEvent.wheel(board, { deltaY: -120 });
    fireEvent.mouseDown(node, { clientX: 620, clientY: 220, button: 0 });
    fireEvent.mouseMove(window, { clientX: 730, clientY: 275 });
    fireEvent.mouseUp(window);

    const [, position] = onMoveNode.mock.calls.at(-1) ?? [];
    expect(position.x).toBeCloseTo(720, 0);
    expect(position.y).toBeCloseTo(270, 0);
  });

  it('lets a node be dragged past the visible board height instead of clamping to the viewport', () => {
    const onMoveNode = vi.fn();
    const nodes: TemplateNode[] = [
      {
        id: 'ecs-1',
        kind: 'ecs',
        label: '业务 ECS',
        position: { x: 620, y: 220 },
        instanceName: 'ecs-1',
        hostName: 'ecs-1',
        zoneKey: 'core',
        role: 'entry',
        privateIp: '10.70.10.10',
        exposePublic: true,
        image: 'aliyun_linux_3_x64_20G_alibase',
        imageName: 'aliyun_linux_3_x64_20G_alibase',
        imageId: 'aliyun_linux_3_x64_20G_alibase',
        cpu: 2,
        memory: 4,
        description: '',
        bootPriority: 1,
        bootWaitSeconds: 0,
        dnatMappings: [],
        networkInterfaces: [{ zoneKey: 'core', privateIp: '10.70.10.10' }],
        portGroups: [],
        nics: [
          {
            id: 'ecs-1-nic-1',
            switchId: 'switch-core',
            privateIp: '10.70.10.10',
            secondaryIps: [],
            securityGroupRules: [],
          },
        ],
        initScript: '',
        imageStrategy: { mode: 'fixed', imageId: 'aliyun_linux_3_x64_20G_alibase' },
        instanceTypeStrategy: { mode: 'auto', preferredInstanceTypes: [] },
      },
    ];

    render(
      <TemplateCanvas
        topologyGraph={{ schemaVersion: '2.0.0', nodes, edges: [] }}
        nodes={nodes}
        edges={[]}
        selectedNodeId={null}
        pendingLinkSourceNodeId={null}
        onSelectNode={vi.fn()}
        onOpenNode={vi.fn()}
        onMoveNode={onMoveNode}
      />,
    );

    const board = screen.getByTestId('template-canvas-board');
    vi.spyOn(board, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 1200,
      bottom: 700,
      width: 1200,
      height: 700,
      toJSON: () => ({}),
    });

    const node = screen.getByRole('button', { name: /业务 ECS/ });
    fireEvent.mouseDown(node, { clientX: 620, clientY: 220, button: 0 });
    fireEvent.mouseMove(window, { clientX: 620, clientY: 900 });
    fireEvent.mouseUp(window);

    expect(onMoveNode).toHaveBeenLastCalledWith('ecs-1', {
      x: 620,
      y: 900,
    });
  });

  it('allows dragging nodes past the top-left origin instead of clamping them inside the viewport', () => {
    const onMoveNode = vi.fn();
    const nodes: TemplateNode[] = [
      {
        id: 'switch-1',
        kind: 'switch',
        label: '业务交换机',
        position: { x: 80, y: 120 },
        zoneKey: 'core',
        cidr: '10.70.10.0/24',
        purpose: 'business-zone',
        description: '默认业务网段',
        aclRules: [],
        nat: {
          snatEnabled: false,
          dnatMappings: [],
        },
      },
    ];

    render(
      <TemplateCanvas
        topologyGraph={{ schemaVersion: '2.0.0', nodes, edges: [] }}
        nodes={nodes}
        edges={[]}
        selectedNodeId={null}
        pendingLinkSourceNodeId={null}
        onSelectNode={vi.fn()}
        onOpenNode={vi.fn()}
        onMoveNode={onMoveNode}
      />,
    );

    const node = screen.getByRole('button', { name: /业务交换机/ });
    fireEvent.mouseDown(node, { clientX: 80, clientY: 120, button: 0 });
    fireEvent.mouseMove(window, { clientX: -40, clientY: -30 });
    fireEvent.mouseUp(window);

    expect(onMoveNode).toHaveBeenCalledWith('switch-1', {
      x: -40,
      y: -30,
    });
  });

  it('keeps the dropped node visually left of its previous slot instead of snapping it back to the default gutter', () => {
    const onMoveNode = vi.fn();
    const nodes: TemplateNode[] = [
      {
        id: 'router-1',
        kind: 'router',
        label: 'Router',
        position: { x: 80, y: 120 },
        description: '根 VPC',
        routeRole: 'core',
        egressType: 'internet',
        bindEip: false,
      },
    ];

    const { rerender } = render(
      <TemplateCanvas
        topologyGraph={{ schemaVersion: '2.0.0', nodes, edges: [] }}
        nodes={nodes}
        edges={[]}
        selectedNodeId={null}
        pendingLinkSourceNodeId={null}
        onSelectNode={vi.fn()}
        onOpenNode={vi.fn()}
        onMoveNode={onMoveNode}
      />,
    );

    const node = screen.getByRole('button', { name: /Router/ });
    expect(node.getAttribute('style')).toContain('left: 80px');

    fireEvent.mouseDown(node, { clientX: 300, clientY: 200, button: 0 });
    fireEvent.mouseMove(window, { clientX: 180, clientY: 200 });
    fireEvent.mouseUp(window);

    expect(onMoveNode).toHaveBeenCalledWith('router-1', {
      x: -40,
      y: 120,
    });

    rerender(
      <TemplateCanvas
        topologyGraph={{
          schemaVersion: '2.0.0',
          nodes: [
            {
              ...nodes[0],
              position: { x: -40, y: 120 },
            },
          ],
          edges: [],
        }}
        nodes={[
          {
            ...nodes[0],
            position: { x: -40, y: 120 },
          },
        ]}
        edges={[]}
        selectedNodeId={null}
        pendingLinkSourceNodeId={null}
        onSelectNode={vi.fn()}
        onOpenNode={vi.fn()}
        onMoveNode={onMoveNode}
      />,
    );

    expect(screen.getByRole('button', { name: /Router/ }).getAttribute('style')).toContain('left: -40px');
  });

  it('does not clamp whole-scene panning against the current node bounds', () => {
    const nodes: TemplateNode[] = [
      {
        id: 'ecs-1',
        kind: 'ecs',
        label: '业务 ECS',
        position: { x: 620, y: 220 },
        instanceName: 'ecs-1',
        hostName: 'ecs-1',
        zoneKey: 'core',
        role: 'entry',
        privateIp: '10.70.10.10',
        exposePublic: true,
        image: 'aliyun_linux_3_x64_20G_alibase',
        imageName: 'aliyun_linux_3_x64_20G_alibase',
        imageId: 'aliyun_linux_3_x64_20G_alibase',
        cpu: 2,
        memory: 4,
        description: '',
        bootPriority: 1,
        bootWaitSeconds: 0,
        dnatMappings: [],
        networkInterfaces: [{ zoneKey: 'core', privateIp: '10.70.10.10' }],
        portGroups: [],
        nics: [
          {
            id: 'ecs-1-nic-1',
            switchId: 'switch-core',
            privateIp: '10.70.10.10',
            secondaryIps: [],
            securityGroupRules: [],
          },
        ],
        initScript: '',
        imageStrategy: { mode: 'fixed', imageId: 'aliyun_linux_3_x64_20G_alibase' },
        instanceTypeStrategy: { mode: 'auto', preferredInstanceTypes: [] },
      },
    ];

    render(
      <TemplateCanvas
        topologyGraph={{ schemaVersion: '2.0.0', nodes, edges: [] }}
        nodes={nodes}
        edges={[]}
        selectedNodeId={null}
        pendingLinkSourceNodeId={null}
        onSelectNode={vi.fn()}
        onOpenNode={vi.fn()}
        onMoveNode={vi.fn()}
      />,
    );

    const board = screen.getByTestId('template-canvas-board');
    const scene = screen.getByTestId('template-canvas-scene');
    vi.spyOn(board, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 1000,
      bottom: 700,
      width: 1000,
      height: 700,
      toJSON: () => ({}),
    });

    vi.useFakeTimers();
    fireEvent.mouseDown(board, { clientX: 120, clientY: 120, button: 0 });
    vi.advanceTimersByTime(200);
    fireEvent.mouseMove(window, { clientX: 120, clientY: 360 });
    fireEvent.mouseUp(window);
    vi.useRealTimers();

    expect(scene.style.transform).toContain('translate(0px, 240px)');
  });

  it('renders only explicit topology edges instead of inferred relations', () => {
    const nodes: TemplateNode[] = [
      {
        id: 'router-1',
        kind: 'router',
        label: '主路由器',
        position: { x: 80, y: 120 },
        description: '根 VPC',
        routeRole: 'core',
        egressType: 'internet',
        bindEip: false,
      },
      {
        id: 'switch-1',
        kind: 'switch',
        label: '业务交换机',
        position: { x: 320, y: 120 },
        zoneKey: 'core',
        cidr: '10.70.10.0/24',
        purpose: 'business-zone',
        description: '默认业务网段',
        aclRules: [],
        nat: {
          snatEnabled: false,
          dnatMappings: [],
        },
      },
      {
        id: 'ecs-1',
        kind: 'ecs',
        label: '业务 ECS',
        position: { x: 560, y: 120 },
        instanceName: 'ecs-1',
        hostName: 'ecs-1',
        zoneKey: 'core',
        role: 'entry',
        privateIp: '10.70.10.10',
        exposePublic: true,
        image: 'aliyun_linux_3_x64_20G_alibase',
        imageName: 'aliyun_linux_3_x64_20G_alibase',
        imageId: 'aliyun_linux_3_x64_20G_alibase',
        cpu: 2,
        memory: 4,
        description: '',
        bootPriority: 1,
        bootWaitSeconds: 0,
        dnatMappings: [],
        networkInterfaces: [{ zoneKey: 'core', privateIp: '10.70.10.10' }],
        portGroups: [],
        nics: [
          {
            id: 'ecs-1-nic-1',
            switchId: 'switch-1',
            privateIp: '10.70.10.10',
            secondaryIps: [],
            securityGroupRules: [],
          },
        ],
        initScript: '',
        imageStrategy: { mode: 'fixed', imageId: 'aliyun_linux_3_x64_20G_alibase' },
        instanceTypeStrategy: { mode: 'auto', preferredInstanceTypes: [] },
      },
    ];

    render(
      <TemplateCanvas
        topologyGraph={{ schemaVersion: '1.0.0', nodes, edges: [] }}
        nodes={nodes}
        edges={[]}
        selectedNodeId={null}
        pendingLinkSourceNodeId={null}
        onSelectNode={vi.fn()}
        onOpenNode={vi.fn()}
        onMoveNode={vi.fn()}
      />,
    );

    expect(screen.queryByTestId(/template-canvas-edge/)).toBeNull();
  });
});
