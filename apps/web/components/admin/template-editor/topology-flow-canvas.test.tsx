// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TopologyFlowCanvas } from './topology-flow-canvas';
import type { TemplateEdge } from './template-editor-screen';
import type { TemplateNode } from '../../../lib/scenario-graph';

const flowState = vi.hoisted(() => ({
  props: null as Record<string, any> | null,
  fitView: vi.fn(),
  nodeChanges: vi.fn(),
  screenToFlowPosition: vi.fn(({ x, y }: { x: number; y: number }) => ({ x: x - 40, y: y + 20 })),
  setViewport: vi.fn(),
}));

vi.mock('@xyflow/react', async () => {
  const ReactModule = await import('react');

  return {
    Background: () => <div data-testid="flow-background" />,
    Controls: () => <div data-testid="flow-controls" />,
    Handle: () => null,
    MiniMap: () => <div data-testid="flow-mini-map" />,
    Position: { Left: 'left', Right: 'right' },
    ReactFlow: ({ children, ...props }: { children: React.ReactNode }) => {
      flowState.props = props;
      return <div data-testid="react-flow">{children}</div>;
    },
    ReactFlowProvider: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="react-flow-provider">{children}</div>
    ),
    useNodesState: (initialNodes: Array<Record<string, any>>) => {
      const [localNodes, setLocalNodes] = ReactModule.useState(initialNodes);

      function onNodesChange(changes: Array<Record<string, any>>) {
        flowState.nodeChanges(changes);
        setLocalNodes((currentNodes) => currentNodes.map((node) => {
          const change = changes.find((item) => item.id === node.id);
          if (!change) {
            return node;
          }

          if (change.type === 'position' && change.position) {
            return { ...node, position: change.position };
          }

          if (change.type === 'select') {
            return { ...node, selected: change.selected };
          }

          return node;
        }));
      }

      return [localNodes, setLocalNodes, onNodesChange];
    },
    useReactFlow: () => ({
      fitView: flowState.fitView,
      screenToFlowPosition: flowState.screenToFlowPosition,
      setViewport: flowState.setViewport,
    }),
    useUpdateNodeInternals: () => vi.fn(),
  };
});

const nodes: TemplateNode[] = [
  {
    id: 'switch-1',
    kind: 'switch',
    label: 'DMZ 交换机',
    zoneKey: 'dmz',
    cidr: '10.70.10.0/24',
    purpose: 'dmz',
    position: { x: 120, y: 80 },
  },
  {
    id: 'ecs-1',
    kind: 'ecs',
    label: 'Web ECS',
    zoneKey: 'dmz',
    role: 'web',
    privateIp: '10.70.10.10',
    exposePublic: false,
    image: 'aliyun_linux_3_x64_20G_alibase',
    dnatMappings: [],
    networkInterfaces: [],
    portGroups: [],
    initScript: '',
    imageStrategy: { mode: 'fixed', imageId: 'aliyun_linux_3_x64_20G_alibase' },
    instanceTypeStrategy: { mode: 'auto' },
    position: { x: 440, y: 210 },
  },
];

const edges: TemplateEdge[] = [{
  id: 'edge-switch-ecs',
  fromNodeId: 'switch-1',
  toNodeId: 'ecs-1',
  relationType: 'manual',
}];

function createCanvasProps() {
  return {
    edges,
    nodes,
    onAddNode: vi.fn(),
    onConnect: vi.fn(),
    onDeleteSelection: vi.fn(),
    onLayoutAll: vi.fn(),
    onLayoutSelection: vi.fn(),
    onPositionsCommit: vi.fn(),
    onRedo: vi.fn(),
    onSelectionChange: vi.fn(),
    onUndo: vi.fn(),
    onViewportCommit: vi.fn(),
    viewport: { x: -80, y: 40, zoom: 1.2 },
  };
}

afterEach(() => {
  cleanup();
  flowState.props = null;
  flowState.fitView.mockReset();
  flowState.nodeChanges.mockReset();
  flowState.screenToFlowPosition.mockClear();
  flowState.setViewport.mockReset();
});

describe('TopologyFlowCanvas', () => {
  it('默认保持资源工具轨收缩，并使用 React Flow 无限画布部件', () => {
    const canvasProps = createCanvasProps();
    render(<TopologyFlowCanvas {...canvasProps} />);

    expect(screen.getByTestId('react-flow-provider')).toBeTruthy();
    expect(screen.getByTestId('topology-resource-rail').getAttribute('data-expanded')).toBe('false');
    expect(screen.getByTestId('flow-background')).toBeTruthy();
    expect(screen.getByTestId('flow-controls')).toBeTruthy();
    expect(screen.getByTestId('flow-mini-map')).toBeTruthy();
    expect(flowState.props).toMatchObject({
      multiSelectionKeyCode: 'Shift',
      onlyRenderVisibleElements: true,
      panActivationKeyCode: 'Space',
      panOnDrag: [1],
      selectionOnDrag: true,
    });
  });

  it('仅在视口动作结束后提交视口，并把有效连线交给编辑器', () => {
    const canvasProps = createCanvasProps();
    render(<TopologyFlowCanvas {...canvasProps} />);

    expect(flowState.props?.onMove).toBeUndefined();
    flowState.props?.onConnect({ source: 'switch-1', target: 'ecs-1' });
    flowState.props?.onConnect({ source: null, target: 'ecs-1' });
    flowState.props?.onMoveEnd(null, { x: -80, y: 40, zoom: 1.2 });

    expect(canvasProps.onConnect).toHaveBeenCalledOnce();
    expect(canvasProps.onConnect).toHaveBeenCalledWith({ source: 'switch-1', target: 'ecs-1' });
    expect(canvasProps.onViewportCommit).toHaveBeenCalledOnce();
    expect(canvasProps.onViewportCommit).toHaveBeenCalledWith({ x: -80, y: 40, zoom: 1.2 });
  });

  it('在节点拖动结束时一次提交所有移动节点的位置', () => {
    const canvasProps = createCanvasProps();
    render(<TopologyFlowCanvas {...canvasProps} />);

    flowState.props?.onNodeDragStop(new MouseEvent('mouseup'), {}, [
      { id: 'switch-1', position: { x: 120, y: 80 } },
      { id: 'ecs-1', position: { x: 440, y: 210 } },
    ]);

    expect(canvasProps.onPositionsCommit).toHaveBeenCalledWith([
      { id: 'switch-1', position: { x: 120, y: 80 } },
      { id: 'ecs-1', position: { x: 440, y: 210 } },
    ]);
  });

  it('使用本地受控节点状态处理拖动和选择，并在外部节点或连线模式变更时同步', async () => {
    const canvasProps = createCanvasProps();
    const { rerender } = render(<TopologyFlowCanvas {...canvasProps} />);

    flowState.props?.onNodesChange([{
      id: 'switch-1',
      position: { x: 260, y: 140 },
      type: 'position',
    }]);

    await waitFor(() => expect(flowState.props?.nodes[0].position).toEqual({ x: 260, y: 140 }));
    expect(flowState.nodeChanges).toHaveBeenCalledOnce();
    expect(canvasProps.onPositionsCommit).not.toHaveBeenCalled();

    const externalNodes = nodes.map((node) => node.id === 'switch-1'
      ? { ...node, position: { x: 320, y: 180 } }
      : node);
    rerender(<TopologyFlowCanvas {...canvasProps} nodes={externalNodes} />);

    await waitFor(() => expect(flowState.props?.nodes[0].position).toEqual({ x: 320, y: 180 }));

    fireEvent.click(screen.getByRole('button', { name: '连线模式' }));
    await waitFor(() => expect(flowState.props?.nodes[0].data.connectMode).toBe(true));
  });

  it('把选中的节点和边上报给编辑器', () => {
    const canvasProps = createCanvasProps();
    render(<TopologyFlowCanvas {...canvasProps} />);

    flowState.props?.onSelectionChange({
      edges: [{ id: 'edge-switch-ecs' }],
      nodes: [{ id: 'switch-1' }, { id: 'ecs-1' }],
    });

    expect(canvasProps.onSelectionChange).toHaveBeenCalledWith({
      edgeIds: ['edge-switch-ecs'],
      nodeIds: ['switch-1', 'ecs-1'],
    });
  });

  it('通过普通节点点击重新上报单选，并保留带修饰键的多选操作', () => {
    const canvasProps = createCanvasProps();
    render(<TopologyFlowCanvas {...canvasProps} />);

    expect(flowState.props?.onNodeClick).toEqual(expect.any(Function));

    flowState.props?.onNodeClick?.(
      { ctrlKey: false, metaKey: false, shiftKey: false },
      { id: 'switch-1' },
    );

    expect(canvasProps.onSelectionChange).toHaveBeenCalledWith({
      edgeIds: [],
      nodeIds: ['switch-1'],
    });

    canvasProps.onSelectionChange.mockClear();

    for (const modifier of ['shiftKey', 'ctrlKey', 'metaKey'] as const) {
      flowState.props?.onNodeClick?.(
        { ctrlKey: false, metaKey: false, shiftKey: false, [modifier]: true },
        { id: 'ecs-1' },
      );
    }

    expect(canvasProps.onSelectionChange).not.toHaveBeenCalled();
  });

  it('将 Delete、撤销和重做快捷键转交给动作回调', () => {
    const canvasProps = createCanvasProps();
    render(<TopologyFlowCanvas {...canvasProps} />);
    const flow = screen.getByTestId('react-flow');

    fireEvent.keyDown(flow, { key: 'Delete' });
    fireEvent.keyDown(flow, { key: 'z', metaKey: true });
    fireEvent.keyDown(flow, { key: 'z', metaKey: true, shiftKey: true });

    expect(canvasProps.onDeleteSelection).toHaveBeenCalledOnce();
    expect(canvasProps.onUndo).toHaveBeenCalledOnce();
    expect(canvasProps.onRedo).toHaveBeenCalledOnce();
  });

  it('按 Escape 清空本地节点选中并上报空选择', async () => {
    const canvasProps = createCanvasProps();
    render(<TopologyFlowCanvas {...canvasProps} />);

    flowState.props?.onNodesChange([{ id: 'switch-1', selected: true, type: 'select' }]);
    await waitFor(() => expect(flowState.props?.nodes[0].selected).toBe(true));

    fireEvent.keyDown(screen.getByTestId('react-flow'), { key: 'Escape' });

    await waitFor(() => expect(flowState.props?.nodes[0].selected).toBe(false));
    expect(canvasProps.onSelectionChange).toHaveBeenCalledWith({ edgeIds: [], nodeIds: [] });
    expect(canvasProps.onDeleteSelection).not.toHaveBeenCalled();
    expect(canvasProps.onUndo).not.toHaveBeenCalled();
    expect(canvasProps.onRedo).not.toHaveBeenCalled();
    expect(flowState.fitView).not.toHaveBeenCalled();
  });

  it('将资源拖放坐标转换为世界坐标后请求添加，并拒绝其他 MIME 类型', () => {
    const canvasProps = createCanvasProps();
    render(<TopologyFlowCanvas {...canvasProps} />);

    const preventDefault = vi.fn();
    const getData = vi.fn((format: string) => format === 'application/x-topology-node-kind' ? 'ecs' : '');
    flowState.props?.onDrop({
      clientX: 240,
      clientY: 180,
      dataTransfer: { getData },
      preventDefault,
    });

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(getData).toHaveBeenCalledWith('application/x-topology-node-kind');
    expect(flowState.screenToFlowPosition).toHaveBeenCalledWith({ x: 240, y: 180 });
    expect(canvasProps.onAddNode).toHaveBeenCalledWith('ecs', { x: 200, y: 200 });

    flowState.props?.onDrop({
      clientX: 80,
      clientY: 60,
      dataTransfer: { getData: () => 'unknown' },
      preventDefault: vi.fn(),
    });
    expect(canvasProps.onAddNode).toHaveBeenCalledOnce();
  });

  it('连线模式传入节点，工具栏按钮保持可访问并支持布局与适应视图', () => {
    const canvasProps = createCanvasProps();
    const { rerender } = render(<TopologyFlowCanvas {...canvasProps} />);
    const initialNodeTypes = flowState.props?.nodeTypes;

    fireEvent.click(screen.getByRole('button', { name: '连线模式' }));

    expect(screen.getByTestId('topology-flow-workbench').getAttribute('data-connect-mode')).toBe('true');
    expect(flowState.props?.nodes[0].data.connectMode).toBe(true);
    expect(screen.getByRole('button', { name: '选择模式' }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('button', { name: '连线模式' }).getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: '切换专注模式' }));
    expect(screen.getByRole('button', { name: '切换专注模式' }).getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: '选择模式' }));
    expect(screen.getByRole('button', { name: '选择模式' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: '连线模式' }).getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(screen.getByRole('button', { name: '全部自动布局' }));
    fireEvent.click(screen.getByRole('button', { name: '选中自动布局' }));
    fireEvent.click(screen.getByRole('button', { name: '适应视图' }));

    expect(canvasProps.onLayoutAll).toHaveBeenCalledOnce();
    expect(canvasProps.onLayoutSelection).toHaveBeenCalledOnce();
    expect(flowState.fitView).toHaveBeenCalledOnce();

    rerender(<TopologyFlowCanvas {...canvasProps} nodes={[...nodes]} />);
    expect(flowState.props?.nodeTypes).toBe(initialNodeTypes);

    for (const name of ['选择模式', '连线模式', '全部自动布局', '选中自动布局', '撤销', '重做', '适应视图', '切换专注模式']) {
      const button = screen.getByRole('button', { name });
      expect(button.getAttribute('title')).toBe(name);
      expect(button.getAttribute('aria-label')).toBe(name);
    }
  });

  it('外部视口变更时同步画布，用户移动结束后不会形成视口反馈循环', async () => {
    const canvasProps = createCanvasProps();
    const { rerender } = render(<TopologyFlowCanvas {...canvasProps} />);

    flowState.props?.onMoveEnd(null, { x: -20, y: 10, zoom: 1.4 });
    expect(canvasProps.onViewportCommit).toHaveBeenCalledOnce();
    expect(flowState.setViewport).not.toHaveBeenCalled();

    rerender(<TopologyFlowCanvas {...canvasProps} viewport={{ x: -20, y: 10, zoom: 1.4 }} />);
    expect(flowState.setViewport).not.toHaveBeenCalled();

    rerender(<TopologyFlowCanvas {...canvasProps} viewport={{ x: 80, y: -40, zoom: 0.8 }} />);
    await waitFor(() => expect(flowState.setViewport).toHaveBeenCalledWith({ x: 80, y: -40, zoom: 0.8 }));
    flowState.props?.onMoveEnd(null, { x: 80, y: -40, zoom: 0.8 });
    expect(canvasProps.onViewportCommit).toHaveBeenCalledOnce();

    rerender(<TopologyFlowCanvas {...canvasProps} viewport={null} />);
    await waitFor(() => expect(flowState.fitView).toHaveBeenCalled());
  });

  it('点击资源时将画布容器中心转换为世界坐标', () => {
    const canvasProps = createCanvasProps();
    render(<TopologyFlowCanvas {...canvasProps} />);
    const canvas = screen.getByTestId('topology-flow-canvas');
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
      bottom: 430,
      height: 400,
      left: 20,
      right: 620,
      toJSON: () => ({}),
      top: 30,
      width: 600,
      x: 20,
      y: 30,
    });

    fireEvent.click(screen.getByRole('button', { name: '打开资源面板' }));
    fireEvent.click(screen.getByRole('button', { name: /ECS 主机/ }));

    expect(flowState.screenToFlowPosition).toHaveBeenCalledWith({ x: 320, y: 230 });
    expect(canvasProps.onAddNode).toHaveBeenCalledWith('ecs', { x: 280, y: 250 });
  });

  it('展开资源面板不提交或重置画布视口', () => {
    const canvasProps = createCanvasProps();
    render(<TopologyFlowCanvas {...canvasProps} />);
    const defaultViewport = flowState.props?.defaultViewport;

    fireEvent.click(screen.getByRole('button', { name: '打开资源面板' }));

    expect(screen.getByTestId('topology-resource-rail').getAttribute('data-expanded')).toBe('true');
    expect(flowState.props?.defaultViewport).toBe(defaultViewport);
    expect(canvasProps.onViewportCommit).not.toHaveBeenCalled();
  });
});
