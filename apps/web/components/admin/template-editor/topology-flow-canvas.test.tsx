// @vitest-environment jsdom
import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TopologyFlowCanvas } from './topology-flow-canvas';
import { AdminPageCache } from '../admin-page-cache';
import type { TemplateEdge } from './template-editor-screen';
import type { TemplateNode } from '../../../lib/scenario-graph';

function getRuleBlock(styles: string, selector: string) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = styles.match(new RegExp(`${escapedSelector}\\s*\\{[\\s\\S]*?\\}`, 'm'));

  return match?.[0] ?? '';
}

function getAtRuleBlock(styles: string, atRule: string) {
  const atRuleStart = styles.indexOf(atRule);
  const openingBrace = styles.indexOf('{', atRuleStart);

  if (atRuleStart === -1 || openingBrace === -1) {
    return '';
  }

  let depth = 0;

  for (let index = openingBrace; index < styles.length; index += 1) {
    if (styles[index] === '{') {
      depth += 1;
    } else if (styles[index] === '}') {
      depth -= 1;

      if (depth === 0) {
        return styles.slice(openingBrace + 1, index);
      }
    }
  }

  return '';
}

const flowState = vi.hoisted(() => ({
  emitSelectionEvents: false,
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
    MiniMap: ({
      className,
      pannable,
      zoomable,
    }: {
      className?: string;
      pannable?: boolean;
      zoomable?: boolean;
    }) => (
      <div
        data-class-name={className}
        data-pannable={pannable}
        data-testid="flow-mini-map"
        data-zoomable={zoomable}
      />
    ),
    Position: { Left: 'left', Right: 'right' },
    ReactFlow: ({ children, ...props }: { children: React.ReactNode } & Record<string, any>) => {
      flowState.props = props;

      ReactModule.useEffect(() => {
        if (!flowState.emitSelectionEvents) {
          return;
        }

        props.onSelectionChange?.({
          edges: props.edges.filter((edge: Record<string, any>) => edge.selected),
          nodes: props.nodes.filter((node: Record<string, any>) => node.selected),
        });
      }, [props.edges, props.nodes, props.onSelectionChange]);

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

const multiNetworkNodes: TemplateNode[] = [{
  ...nodes[0]!,
  id: 'switch-a',
  label: '交换机 A',
  position: { x: 120, y: 80 },
}, {
  ...nodes[0]!,
  id: 'switch-b',
  label: '交换机 B',
  zoneKey: 'office',
  cidr: '10.70.20.0/24',
  position: { x: 120, y: 280 },
}, {
  ...nodes[1]!,
  id: 'ecs-1',
  label: '双网卡 ECS',
  position: { x: 440, y: 180 },
}];

const multiNetworkEdges: TemplateEdge[] = [{
  id: 'edge-switch-a-ecs',
  fromNodeId: 'switch-a',
  toNodeId: 'ecs-1',
  relationType: 'manual',
}, {
  id: 'edge-switch-b-ecs',
  fromNodeId: 'switch-b',
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
    onNodeActivate: vi.fn(),
    onPositionsCommit: vi.fn(),
    onRedo: vi.fn(),
    onSelectionChange: vi.fn(),
    onUndo: vi.fn(),
    onViewportCommit: vi.fn(),
    selection: { nodeIds: [], edgeIds: [] },
    viewport: { x: -80, y: 40, zoom: 1.2 },
  };
}

let fullscreenElement: Element | null = null;
let fullscreenRequestTarget: Element | null = null;
const requestFullscreen = vi.fn();
const exitFullscreen = vi.fn();

beforeEach(() => {
  fullscreenElement = null;
  fullscreenRequestTarget = null;
  requestFullscreen.mockImplementation(function requestFullscreenMock(this: Element) {
    fullscreenRequestTarget = this;
  });
  Object.defineProperty(document, 'fullscreenElement', {
    configurable: true,
    get: () => fullscreenElement,
  });
  Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', {
    configurable: true,
    value: requestFullscreen,
  });
  Object.defineProperty(document, 'exitFullscreen', {
    configurable: true,
    value: exitFullscreen,
  });
});

afterEach(() => {
  cleanup();
  flowState.emitSelectionEvents = false;
  fullscreenElement = null;
  fullscreenRequestTarget = null;
  requestFullscreen.mockReset();
  exitFullscreen.mockReset();
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
    expect(screen.queryByTestId('flow-mini-map')).toBeNull();
    expect(screen.getByRole('button', { name: '显示导航图' }).getAttribute('aria-pressed')).toBe('false');
    expect(flowState.props).toMatchObject({
      multiSelectionKeyCode: 'Shift',
      minZoom: 0.25,
      onlyRenderVisibleElements: true,
      panActivationKeyCode: 'Space',
      panOnDrag: [0, 1],
      selectionOnDrag: false,
    });
  });

  it('新建空拓扑自动展开资源面板，并使用较保守的初始适应视图', () => {
    const canvasProps = createCanvasProps();
    render(<TopologyFlowCanvas {...canvasProps} nodes={[]} />);

    expect(screen.getByTestId('topology-resource-rail').getAttribute('data-expanded')).toBe('true');
    expect(flowState.props?.fitViewOptions).toMatchObject({
      maxZoom: 1.2,
      padding: 0.45,
    });
  });

  it('将多交换机到同一 ECS 的边作为独立 bezier 端点传给 React Flow', () => {
    render(
      <TopologyFlowCanvas
        {...createCanvasProps()}
        nodes={multiNetworkNodes}
        edges={multiNetworkEdges}
      />,
    );

    expect(flowState.props?.edges).toMatchObject([{
      id: 'edge-switch-a-ecs',
      type: 'bezier',
      targetHandle: 'target-edge-switch-a-ecs',
    }, {
      id: 'edge-switch-b-ecs',
      type: 'bezier',
      targetHandle: 'target-edge-switch-b-ecs',
    }]);
    expect(flowState.props?.nodes.find((node: { id: string }) => node.id === 'ecs-1')?.data.targetPorts)
      .toHaveLength(2);
  });

  it('边变化时同步节点端点布局', async () => {
    const { rerender } = render(
      <TopologyFlowCanvas
        {...createCanvasProps()}
        nodes={multiNetworkNodes}
        edges={[multiNetworkEdges[0]!]}
      />,
    );

    rerender(
      <TopologyFlowCanvas
        {...createCanvasProps()}
        nodes={multiNetworkNodes}
        edges={multiNetworkEdges}
      />,
    );

    await waitFor(() => {
      expect(flowState.props?.nodes.find((node: { id: string }) => node.id === 'ecs-1')?.data.targetPorts)
        .toHaveLength(2);
    });
  });

  it('declares a viewport-filling editor grid and compact navigation map layout contract', () => {
    const styles = readFileSync(resolve(process.cwd(), 'app/globals.css'), 'utf8');
    const desktopRules = getAtRuleBlock(styles, '@media (min-width: 1024px)');
    const editorGrid = getRuleBlock(styles, '.template-editor-grid');
    const loadingGrid = getRuleBlock(styles, '.template-editor-grid:not(:has(.topology-flow-workbench))');
    const transition = getRuleBlock(styles, '.admin-content-transition:has(.template-editor-screen)');
    const workbench = getRuleBlock(styles, '.topology-flow-workbench');
    const desktopMainShell = getRuleBlock(
      desktopRules,
      ".admin-workspace[data-topology-editor='true'] .admin-main-shell",
    );

    expect(styles).toContain('@import url("@xyflow/react/dist/style.css");');
    expect(transition).toContain('height: 100%');
    expect(editorGrid).toContain('grid-template-columns: minmax(0, 1fr)');
    expect(editorGrid).toContain('height: 100%');
    expect(editorGrid).toContain('min-height: 0');
    expect(editorGrid).not.toContain('height: max(680px, calc(100dvh - 176px))');
    expect(loadingGrid).toContain('height: 100%');
    expect(loadingGrid).not.toContain('height: calc(100vh - 176px)');
    expect(workbench).toContain('min-height: 0');
    expect(styles).toContain('.template-editor-grid:fullscreen');
    expect(styles).toContain(".admin-workspace[data-topology-editor='true'] .admin-topbar");
    expect(desktopMainShell).toContain('grid-template-rows: minmax(0, 1fr)');
    expect(styles).toContain('.topology-flow-mini-map-toggle');
    expect(styles).toContain('.topology-flow-node-assigned-handle');
    expect(styles).toContain(".topology-flow-node[data-connect-mode='false'] .topology-flow-node-default-handle");
    expect(styles).toContain("[data-has-multiple-targets='true'] .topology-flow-node-target-port");
    expect(styles).toMatch(
      /\.topology-flow-mini-map\s*\{[\s\S]*?width:\s*120px;[\s\S]*?height:\s*80px;/,
    );
    expect(styles).toContain(
      '.template-editor-grid:has(.template-property-panel) .topology-flow-mini-map-toggle',
    );
    expect(styles).not.toContain('data-focus-mode');
    expect(styles).not.toContain('.topology-flow-workbench:fullscreen');
    expect(styles).toMatch(
      /@media \(max-width: 1180px\)\s*\{[\s\S]*?\.template-editor-grid:has\(\.topology-flow-workbench\) > \.template-property-panel\s*\{[\s\S]*?bottom:\s*0;/,
    );
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

  it('点击连线时只选中该边，并保留可点击命中区', () => {
    const canvasProps = createCanvasProps();
    render(<TopologyFlowCanvas {...canvasProps} />);

    expect(flowState.props?.edges[0]).toMatchObject({
      id: 'edge-switch-ecs',
      selectable: true,
      focusable: true,
      interactionWidth: 24,
    });
    expect(flowState.props?.onEdgeClick).toEqual(expect.any(Function));

    flowState.props?.onEdgeClick?.(
      { ctrlKey: false, metaKey: false, shiftKey: false },
      { id: 'edge-switch-ecs' },
    );

    expect(canvasProps.onSelectionChange).toHaveBeenCalledWith({
      edgeIds: ['edge-switch-ecs'],
      nodeIds: [],
    });
  });

  it('同步父编辑器的节点选择，保持新增资源的属性面板选择状态', async () => {
    const canvasProps = createCanvasProps();
    const { rerender } = render(
      <TopologyFlowCanvas
        {...canvasProps}
        selection={{ nodeIds: ['switch-1'], edgeIds: [] }}
      />,
    );

    await waitFor(() => expect(flowState.props?.nodes[0].selected).toBe(true));
    expect(flowState.props?.nodes[1].selected).toBe(false);

    rerender(
      <TopologyFlowCanvas
        {...canvasProps}
        selection={{ nodeIds: ['ecs-1'], edgeIds: [] }}
      />,
    );

    await waitFor(() => expect(flowState.props?.nodes[0].selected).toBe(false));
    expect(flowState.props?.nodes[1].selected).toBe(true);
  });

  it('同步父级选中态时不将 React Flow 回调反向写回编辑器', async () => {
    flowState.emitSelectionEvents = true;
    const canvasProps = createCanvasProps();

    render(
      <TopologyFlowCanvas
        {...canvasProps}
        selection={{ nodeIds: ['switch-1'], edgeIds: [] }}
      />,
    );

    await waitFor(() => expect(flowState.props?.nodes[0].selected).toBe(true));
    expect(canvasProps.onSelectionChange).not.toHaveBeenCalled();
  });

  it('新增资源并选中时不将 React Flow 回调反向写回编辑器', async () => {
    const canvasProps = createCanvasProps();
    const { rerender } = render(
      <TopologyFlowCanvas
        {...canvasProps}
        nodes={[nodes[0]!]}
        selection={{ nodeIds: [], edgeIds: [] }}
      />,
    );

    await waitFor(() => expect(flowState.props?.nodes).toHaveLength(1));
    flowState.emitSelectionEvents = true;

    rerender(
      <TopologyFlowCanvas
        {...canvasProps}
        nodes={nodes}
        selection={{ nodeIds: ['ecs-1'], edgeIds: [] }}
      />,
    );

    await waitFor(() => expect(flowState.props?.nodes[1].selected).toBe(true));
    expect(flowState.props?.nodes[0].selected).toBe(false);
    expect(canvasProps.onSelectionChange).not.toHaveBeenCalled();
  });

  it('同步父编辑器选择时保留尚未提交的节点位置', async () => {
    const canvasProps = createCanvasProps();
    const { rerender } = render(<TopologyFlowCanvas {...canvasProps} />);

    flowState.props?.onNodesChange([{
      id: 'switch-1',
      position: { x: 260, y: 140 },
      type: 'position',
    }]);

    await waitFor(() => expect(flowState.props?.nodes[0].position).toEqual({ x: 260, y: 140 }));

    rerender(
      <TopologyFlowCanvas
        {...canvasProps}
        selection={{ nodeIds: ['switch-1'], edgeIds: [] }}
      />,
    );

    await waitFor(() => expect(flowState.props?.nodes[0].selected).toBe(true));
    expect(flowState.props?.nodes[0].position).toEqual({ x: 260, y: 140 });
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
    expect(canvasProps.onNodeActivate).toHaveBeenCalledWith('switch-1');

    canvasProps.onSelectionChange.mockClear();
    canvasProps.onNodeActivate.mockClear();

    for (const modifier of ['shiftKey', 'ctrlKey', 'metaKey'] as const) {
      flowState.props?.onNodeClick?.(
        { ctrlKey: false, metaKey: false, shiftKey: false, [modifier]: true },
        { id: 'ecs-1' },
      );
    }

    expect(canvasProps.onSelectionChange).not.toHaveBeenCalled();
    expect(canvasProps.onNodeActivate).not.toHaveBeenCalled();
  });

  it('将 Delete、撤销和重做快捷键转交给动作回调', () => {
    const canvasProps = createCanvasProps();
    render(<TopologyFlowCanvas {...canvasProps} />);
    const flow = screen.getByTestId('react-flow');

    fireEvent.keyDown(flow, { key: 'Delete' });
    fireEvent.keyDown(flow, { key: 'Backspace' });
    fireEvent.keyDown(flow, { key: 'z', metaKey: true });
    fireEvent.keyDown(flow, { key: 'z', metaKey: true, shiftKey: true });

    expect(canvasProps.onDeleteSelection).toHaveBeenCalledTimes(2);
    expect(canvasProps.onUndo).toHaveBeenCalledOnce();
    expect(canvasProps.onRedo).toHaveBeenCalledOnce();
  });

  it('在窗口级监听删除快捷键，避免未聚焦时无法删除选中资源', () => {
    const canvasProps = createCanvasProps();
    render(
      <TopologyFlowCanvas
        {...canvasProps}
        selection={{ nodeIds: [], edgeIds: ['edge-switch-ecs'] }}
      />,
    );

    fireEvent.keyDown(window, { key: 'Delete' });
    fireEvent.keyDown(window, { key: 'Backspace' });

    expect(canvasProps.onDeleteSelection).toHaveBeenCalledTimes(2);
  });

  it('只删除当前可见保留编辑器中的选择，不修改隐藏页面', () => {
    const first = createCanvasProps();
    const second = createCanvasProps();
    const createPage = (route: string) => <TopologyFlowCanvas {...(route.endsWith('/a') ? first : second)} />;
    const { rerender } = render(
      <AdminPageCache createPage={createPage} pathname="/admin/scenarios/a">{null}</AdminPageCache>,
    );
    rerender(<AdminPageCache createPage={createPage} pathname="/admin/scenarios/b">{null}</AdminPageCache>);

    fireEvent.keyDown(window, { key: 'Delete' });
    expect(first.onDeleteSelection).not.toHaveBeenCalled();
    expect(second.onDeleteSelection).toHaveBeenCalledOnce();

    rerender(<AdminPageCache createPage={createPage} pathname="/admin/scenarios/a">{null}</AdminPageCache>);
    fireEvent.keyDown(window, { key: 'Backspace' });
    expect(first.onDeleteSelection).toHaveBeenCalledOnce();
    expect(second.onDeleteSelection).toHaveBeenCalledOnce();
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

  it('连线模式传入节点，工具栏保留全部布局并移除局部布局与专注模式', async () => {
    const canvasProps = createCanvasProps();
    const { rerender } = render(<TopologyFlowCanvas {...canvasProps} />);
    const initialNodeTypes = flowState.props?.nodeTypes;
    const workbench = screen.getByTestId('topology-flow-workbench');

    fireEvent.click(screen.getByRole('button', { name: '连线模式' }));

    expect(workbench.getAttribute('data-connect-mode')).toBe('true');
    expect(flowState.props?.nodes[0].data.connectMode).toBe(true);
    expect(flowState.props?.panOnDrag).toEqual([1]);
    expect(flowState.props?.selectionOnDrag).toBe(false);
    expect(screen.getByRole('button', { name: '选择模式' }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('button', { name: '连线模式' }).getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: '选择模式' }));
    expect(screen.getByRole('button', { name: '选择模式' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: '连线模式' }).getAttribute('aria-pressed')).toBe('false');
    expect(flowState.props?.panOnDrag).toEqual([0, 1]);

    fireEvent.click(screen.getByRole('button', { name: '全部自动布局' }));

    expect(canvasProps.onLayoutAll).toHaveBeenCalledOnce();
    await waitFor(() => expect(flowState.fitView).toHaveBeenCalledWith({
      duration: 180,
      maxZoom: 1.2,
      padding: 0.45,
    }));

    fireEvent.click(screen.getByRole('button', { name: '适应视图' }));
    expect(flowState.fitView).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('button', { name: '选中自动布局' })).toBeNull();
    expect(screen.queryByRole('button', { name: '切换专注模式' })).toBeNull();

    rerender(<TopologyFlowCanvas {...canvasProps} nodes={[...nodes]} />);
    expect(flowState.props?.nodeTypes).toBe(initialNodeTypes);

    for (const name of ['选择模式', '连线模式', '全部自动布局', '撤销', '重做', '适应视图', '进入全屏编辑模式', '显示导航图']) {
      const button = screen.getByRole('button', { name });
      expect(button.getAttribute('title')).toBe(name);
      expect(button.getAttribute('aria-label')).toBe(name);
    }
  });

  it('按需显示紧凑导航图', () => {
    const canvasProps = createCanvasProps();
    render(<TopologyFlowCanvas {...canvasProps} />);

    fireEvent.click(screen.getByRole('button', { name: '显示导航图' }));

    expect(screen.getByTestId('flow-mini-map')).toMatchObject({
      dataset: {
        className: 'topology-flow-mini-map',
        pannable: 'true',
        zoomable: 'true',
      },
    });
    expect(screen.getByRole('button', { name: '隐藏导航图' }).getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: '隐藏导航图' }));

    expect(screen.queryByTestId('flow-mini-map')).toBeNull();
    expect(screen.getByRole('button', { name: '显示导航图' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('只读模式保留选择、平移、缩放、全屏和导航图，并禁止结构编辑', async () => {
    const canvasProps = createCanvasProps();
    render(
      <div className="instance-detail-three-column" data-testid="instance-detail-three-column">
        <TopologyFlowCanvas
          {...canvasProps}
          fullscreenTargetSelector=".instance-detail-three-column"
          mode="readonly"
        />
      </div>,
    );

    const workbench = screen.getByTestId('topology-flow-workbench');
    expect(workbench.getAttribute('data-mode')).toBe('readonly');
    expect(flowState.props).toMatchObject({
      nodesConnectable: false,
      nodesDraggable: false,
      panOnDrag: [0, 1],
    });
    expect(screen.queryByRole('button', { name: '连线模式' })).toBeNull();
    expect(screen.queryByRole('button', { name: '全部自动布局' })).toBeNull();
    expect(screen.queryByRole('button', { name: '撤销' })).toBeNull();
    expect(screen.queryByRole('button', { name: '重做' })).toBeNull();

    flowState.props?.onConnect({ source: 'switch-1', target: 'ecs-1' });
    flowState.props?.onDrop({
      clientX: 240,
      clientY: 180,
      dataTransfer: { getData: () => 'ecs' },
      preventDefault: vi.fn(),
    });
    flowState.props?.onNodeDragStop(new MouseEvent('mouseup'), {}, [
      { id: 'switch-1', position: { x: 260, y: 140 } },
    ]);
    fireEvent.keyDown(workbench, { key: 'Delete' });
    fireEvent.keyDown(workbench, { key: 'z', metaKey: true });

    expect(canvasProps.onConnect).not.toHaveBeenCalled();
    expect(canvasProps.onAddNode).not.toHaveBeenCalled();
    expect(canvasProps.onPositionsCommit).not.toHaveBeenCalled();
    expect(canvasProps.onDeleteSelection).not.toHaveBeenCalled();
    expect(canvasProps.onUndo).not.toHaveBeenCalled();

    flowState.props?.onSelectionChange({
      edges: [],
      nodes: [{ id: 'switch-1' }],
    });
    expect(canvasProps.onSelectionChange).toHaveBeenCalledWith({
      edgeIds: [],
      nodeIds: ['switch-1'],
    });

    fireEvent.keyDown(workbench, { key: 'Escape' });
    await waitFor(() => expect(canvasProps.onSelectionChange).toHaveBeenLastCalledWith({
      edgeIds: [],
      nodeIds: [],
    }));

    fireEvent.click(screen.getByRole('button', { name: '显示导航图' }));
    expect(screen.getByTestId('flow-mini-map')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '进入全屏编辑模式' }));
    expect(fullscreenRequestTarget).toBe(screen.getByTestId('instance-detail-three-column'));
  });

  it('没有编辑网格容器时回退工作区全屏，并根据浏览器状态切换按钮', () => {
    const canvasProps = createCanvasProps();
    render(<TopologyFlowCanvas {...canvasProps} />);
    const workbench = screen.getByTestId('topology-flow-workbench');

    fireEvent.click(screen.getByRole('button', { name: '进入全屏编辑模式' }));
    expect(requestFullscreen).toHaveBeenCalledOnce();
    expect(fullscreenRequestTarget).toBe(workbench);

    fullscreenElement = workbench;
    fireEvent(document, new Event('fullscreenchange'));

    expect(screen.getByRole('button', { name: '退出全屏编辑模式' }).getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: '退出全屏编辑模式' }));
    expect(exitFullscreen).toHaveBeenCalledOnce();

    fullscreenElement = null;
    fireEvent(document, new Event('fullscreenchange'));

    expect(screen.getByRole('button', { name: '进入全屏编辑模式' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('在编辑网格内请求全屏并根据网格状态显示属性面板所需的退出按钮', () => {
    const canvasProps = createCanvasProps();
    render(
      <div className="template-editor-grid" data-testid="template-editor-grid">
        <TopologyFlowCanvas {...canvasProps} />
        <aside className="template-property-panel">属性面板</aside>
      </div>,
    );
    const editorGrid = screen.getByTestId('template-editor-grid');

    fireEvent.click(screen.getByRole('button', { name: '进入全屏编辑模式' }));

    expect(fullscreenRequestTarget).toBe(editorGrid);

    fullscreenElement = editorGrid;
    fireEvent(document, new Event('fullscreenchange'));

    expect(screen.getByRole('button', { name: '退出全屏编辑模式' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('属性面板')).toBeTruthy();
  });

  it('全屏编辑时将 Escape 留给浏览器退出全屏', () => {
    const canvasProps = createCanvasProps();
    render(<TopologyFlowCanvas {...canvasProps} />);
    const workbench = screen.getByTestId('topology-flow-workbench');

    fullscreenElement = workbench;
    fireEvent(document, new Event('fullscreenchange'));

    expect(fireEvent.keyDown(workbench, { key: 'Escape' })).toBe(true);
    expect(canvasProps.onSelectionChange).not.toHaveBeenCalled();
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
    render(<TopologyFlowCanvas {...canvasProps} nodes={[]} />);
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

    fireEvent.click(screen.getByRole('button', { name: /ECS 主机/ }));

    expect(flowState.screenToFlowPosition).toHaveBeenCalledWith({ x: 320, y: 230 });
    expect(canvasProps.onAddNode).toHaveBeenCalledWith('ecs', { x: 280, y: 250 });
  });

  it('点击资源时避开画布中心已有节点', () => {
    const canvasProps = createCanvasProps();
    render(
      <TopologyFlowCanvas
        {...canvasProps}
        nodes={nodes.map((node) => (
          node.id === 'switch-1'
            ? { ...node, position: { x: 280, y: 250 } }
            : { ...node, position: { x: -1000, y: -1000 } }
        ))}
      />,
    );
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

    expect(canvasProps.onAddNode).toHaveBeenCalledWith('ecs', { x: 520, y: 250 });
  });

  it('连续添加多个资源时持续寻找未占用位置', () => {
    const canvasProps = createCanvasProps();
    const activeNodes: TemplateNode[] = [];
    const { rerender } = render(<TopologyFlowCanvas {...canvasProps} nodes={activeNodes} />);
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

    const placements: Array<{ x: number; y: number }> = [];

    for (let index = 0; index < 11; index += 1) {
      fireEvent.click(screen.getByRole('button', { name: /ECS 主机/ }));
      const position = canvasProps.onAddNode.mock.calls.at(-1)?.[1];
      placements.push(position);
      activeNodes.push({
        ...nodes[1]!,
        id: `ecs-placement-${index + 1}`,
        position,
      });
      rerender(<TopologyFlowCanvas {...canvasProps} nodes={[...activeNodes]} />);
    }

    expect(new Set(placements.map((position) => `${position.x}:${position.y}`)).size).toBe(11);
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
