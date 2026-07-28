// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TopologyFlowCanvas } from './topology-flow-canvas';
import type { TemplateEdge } from './template-editor-screen';
import type { TemplateNode } from '../../../lib/scenario-graph';

const flowState = vi.hoisted(() => ({
  props: null as Record<string, any> | null,
  fitView: vi.fn(),
  screenToFlowPosition: vi.fn(({ x, y }: { x: number; y: number }) => ({ x: x - 40, y: y + 20 })),
}));

vi.mock('@xyflow/react', () => ({
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
  useReactFlow: () => ({
    fitView: flowState.fitView,
    screenToFlowPosition: flowState.screenToFlowPosition,
  }),
  useUpdateNodeInternals: () => vi.fn(),
}));

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
  flowState.screenToFlowPosition.mockClear();
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
      onlyRenderVisibleElements: true,
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
