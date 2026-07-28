# 拓扑 React Flow 画布实施计划

> **面向代理执行者：** 必须使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 逐项执行。每一步均使用复选框跟踪。

**目标：** 用 React Flow 无限画布替换靶场模板创建与编辑页的自定义画布，同时保留现有拓扑数据、节点属性、校验和显式保存流程。

**架构：** 在 `template-editor` 下新增独立的 `topology-flow` 模块，将领域节点与连线转换为 React Flow 数据，并把完成的用户动作回传给 `TemplateEditorScreen`。节点、边、历史和布局保持纯函数且可单测；新画布只用于创建与编辑页，实例详情页继续使用现有 `TemplateCanvas`。

**技术栈：** Next.js 15、React 19、TypeScript、Vitest、Testing Library、`@xyflow/react`、`@dagrejs/dagre`、Docker Compose。

---

## 文件边界

| 文件 | 职责 |
| --- | --- |
| `topology-flow-types.ts` | Flow 节点、边、视口、选择和历史快照类型。 |
| `topology-flow-adapter.ts` | 领域图与 React Flow 图之间的纯转换、视口读取和写入。 |
| `topology-flow-history.ts` | 不可变撤销/重做历史。 |
| `topology-flow-layout.ts` | Router → Switch → ECS 的确定性横向布局。 |
| `topology-flow-node.tsx` | 可记忆化节点卡片和连线 Handle。 |
| `topology-flow-resource-rail.tsx` | 默认收缩的资源工具轨、浮层和拖放数据。 |
| `topology-flow-canvas.tsx` | React Flow、视口、小地图、选择、快捷键、工具栏和完成动作回调。 |
| `template-editor-screen.tsx` | 新画布接入、现有领域校验、保存视口、历史与批量动作。 |
| `template-property-panel.tsx` | 可选的属性栏收起动作。 |
| `globals.css` | 沉浸式工作台、覆盖式属性栏和响应式样式。 |

### 任务 1：建立 Flow 类型与数据适配层

**文件：**
- 新建：`apps/web/components/admin/template-editor/topology-flow-types.ts`
- 新建：`apps/web/components/admin/template-editor/topology-flow-adapter.ts`
- 新建：`apps/web/components/admin/template-editor/topology-flow-adapter.test.ts`
- 修改：`apps/web/package.json`
- 修改：`pnpm-lock.yaml`

- [ ] **步骤 1：先编写失败的适配器测试**

```ts
import { describe, expect, it } from 'vitest';

import type { TemplateEdge } from './template-editor-screen';
import type { TemplateNode } from '../../../lib/scenario-graph';
import {
  fromFlowNodes,
  readTopologyViewport,
  toFlowEdges,
  toFlowNodes,
  writeTopologyViewport,
} from './topology-flow-adapter';

describe('topology flow adapter', () => {
  it('保留领域节点字段与负坐标', () => {
    const nodes: TemplateNode[] = [{
      id: 'switch-dmz',
      kind: 'switch',
      label: 'DMZ 交换机',
      position: { x: -240, y: 180 },
      zoneKey: 'dmz',
      cidr: '10.70.10.0/24',
      purpose: 'dmz',
      aclRules: [],
      nat: { snatEnabled: false, dnatMappings: [] },
    }];

    const flowNodes = toFlowNodes(nodes);

    expect(flowNodes[0]).toMatchObject({
      id: 'switch-dmz',
      type: 'topology-switch',
      position: { x: -240, y: 180 },
      data: { topologyNode: nodes[0] },
    });
    expect(fromFlowNodes(flowNodes)).toEqual(nodes);
  });

  it('只转换显式边，不推导额外关系', () => {
    const edges: TemplateEdge[] = [{
      id: 'edge-router-dmz',
      fromNodeId: 'router-1',
      toNodeId: 'switch-dmz',
      relationType: 'manual',
      label: 'router -> dmz',
    }];

    expect(toFlowEdges(edges)).toMatchObject([{
      id: 'edge-router-dmz',
      source: 'router-1',
      target: 'switch-dmz',
      data: { topologyEdge: edges[0] },
    }]);
  });

  it('只接受有限数值视口，并兼容无视口旧图', () => {
    expect(readTopologyViewport({ x: -120.5, y: 88, zoom: 1.25 })).toEqual({
      x: -120.5, y: 88, zoom: 1.25,
    });
    expect(readTopologyViewport({ x: 'bad', y: 88, zoom: 1.25 })).toBeNull();
    expect(writeTopologyViewport({ schemaVersion: '2.0.0', nodes: [], edges: [] }, {
      x: 40, y: -20, zoom: 0.8,
    })).toMatchObject({ viewport: { x: 40, y: -20, zoom: 0.8 } });
  });
});
```

- [ ] **步骤 2：在容器中确认测试因模块不存在而失败**

```bash
docker compose build web
docker compose run --rm --no-deps web pnpm --filter @aliyun-cyber-range/web test -- components/admin/template-editor/topology-flow-adapter.test.ts
```

预期：Vitest 报告无法解析 `./topology-flow-adapter`。

- [ ] **步骤 3：加入运行时依赖**

```bash
pnpm --filter @aliyun-cyber-range/web add @xyflow/react @dagrejs/dagre
```

确认 `apps/web/package.json` 将两个包列入 `dependencies`，`pnpm-lock.yaml` 只出现对应锁定变动。

- [ ] **步骤 4：实现类型和适配函数**

```ts
// topology-flow-types.ts
import type { Edge, Node, Viewport } from '@xyflow/react';
import type { TemplateEdge } from './template-editor-screen';
import type { TemplateNode } from '../../../lib/scenario-graph';

export type TopologyFlowNodeType = 'topology-router' | 'topology-switch' | 'topology-ecs';
export type TopologyFlowNodeData = { topologyNode: TemplateNode; connectMode: boolean };
export type TopologyFlowNode = Node<TopologyFlowNodeData, TopologyFlowNodeType>;
export type TopologyFlowEdge = Edge<{ topologyEdge: TemplateEdge }, 'smoothstep'>;
export type TopologyViewport = Pick<Viewport, 'x' | 'y' | 'zoom'>;
export type TopologySnapshot = {
  nodes: TemplateNode[];
  edges: TemplateEdge[];
  viewport: TopologyViewport | null;
};
export type TopologySelection = { nodeIds: string[]; edgeIds: string[] };
```

```ts
// topology-flow-adapter.ts
const nodeTypeByKind = {
  router: 'topology-router',
  switch: 'topology-switch',
  ecs: 'topology-ecs',
} as const;

export function toFlowNodes(nodes: TemplateNode[], connectMode = false): TopologyFlowNode[] {
  return nodes.map((topologyNode, index) => ({
    id: topologyNode.id,
    type: nodeTypeByKind[topologyNode.kind],
    position: topologyNode.position ?? { x: 120 + index * 220, y: 180 },
    data: { topologyNode, connectMode },
  }));
}

export function fromFlowNodes(nodes: TopologyFlowNode[]): TemplateNode[] {
  return nodes.map(({ data, position }) => ({ ...data.topologyNode, position }));
}

export function toFlowEdges(edges: TemplateEdge[]): TopologyFlowEdge[] {
  return edges.map((topologyEdge) => ({
    id: topologyEdge.id,
    type: 'smoothstep',
    source: topologyEdge.fromNodeId,
    target: topologyEdge.toNodeId,
    data: { topologyEdge },
  }));
}

export function readTopologyViewport(value: unknown): TopologyViewport | null {
  if (!value || typeof value !== 'object') return null;
  const viewport = value as Record<string, unknown>;
  return typeof viewport.x === 'number' && Number.isFinite(viewport.x)
    && typeof viewport.y === 'number' && Number.isFinite(viewport.y)
    && typeof viewport.zoom === 'number' && Number.isFinite(viewport.zoom) && viewport.zoom > 0
    ? { x: viewport.x, y: viewport.y, zoom: viewport.zoom }
    : null;
}

export function writeTopologyViewport<T extends Record<string, unknown>>(
  graph: T,
  viewport: TopologyViewport | null,
): T & { viewport?: TopologyViewport } {
  return viewport ? { ...graph, viewport } : graph;
}
```

- [ ] **步骤 5：在容器中运行适配器测试**

```bash
docker compose build web
docker compose run --rm --no-deps web pnpm --filter @aliyun-cyber-range/web test -- components/admin/template-editor/topology-flow-adapter.test.ts
```

预期：三个测试全部通过。

- [ ] **步骤 6：提交适配边界**

```bash
git add apps/web/package.json pnpm-lock.yaml \
  apps/web/components/admin/template-editor/topology-flow-types.ts \
  apps/web/components/admin/template-editor/topology-flow-adapter.ts \
  apps/web/components/admin/template-editor/topology-flow-adapter.test.ts
git commit -m "feat(web): add topology flow adapters"
```

### 任务 2：实现自动布局与撤销/重做

**文件：**
- 新建：`apps/web/components/admin/template-editor/topology-flow-layout.ts`
- 新建：`apps/web/components/admin/template-editor/topology-flow-layout.test.ts`
- 新建：`apps/web/components/admin/template-editor/topology-flow-history.ts`
- 新建：`apps/web/components/admin/template-editor/topology-flow-history.test.ts`

- [ ] **步骤 1：先写失败测试**

```ts
it('让 router、switch、ecs 按从左到右确定性排列', () => {
  const result = layoutTopology(nodes, [
    { id: 'router-switch', fromNodeId: 'router-1', toNodeId: 'switch-1', relationType: 'manual' },
    { id: 'switch-ecs', fromNodeId: 'switch-1', toNodeId: 'ecs-1', relationType: 'manual' },
  ]);

  expect(result.find((node) => node.id === 'router-1')!.position!.x)
    .toBeLessThan(result.find((node) => node.id === 'switch-1')!.position!.x);
  expect(result.find((node) => node.id === 'switch-1')!.position!.x)
    .toBeLessThan(result.find((node) => node.id === 'ecs-1')!.position!.x);
});

it('撤销完成动作并在新动作后清空重做分支', () => {
  const initial = createTopologyHistory(first);
  const moved = pushTopologySnapshot(initial, second);
  const undone = undoTopology(moved);
  const branched = pushTopologySnapshot(undone, third);

  expect(undone.present).toEqual(first);
  expect(redoTopology(undone).present).toEqual(second);
  expect(branched.future).toEqual([]);
});
```

- [ ] **步骤 2：在容器中确认缺失模块失败**

```bash
docker compose build web
docker compose run --rm --no-deps web pnpm --filter @aliyun-cyber-range/web test -- components/admin/template-editor/topology-flow-layout.test.ts components/admin/template-editor/topology-flow-history.test.ts
```

- [ ] **步骤 3：实现布局与历史**

```ts
// topology-flow-layout.ts
import { graphlib, layout } from '@dagrejs/dagre';

const nodeWidth = 176;
const nodeHeight = 60;

export function layoutTopology(nodes: TemplateNode[], edges: TemplateEdge[]): TemplateNode[] {
  const graph = new graphlib.Graph();
  graph.setDefaultEdgeLabel(() => ({}));
  graph.setGraph({ rankdir: 'LR', ranksep: 140, nodesep: 84, marginx: 80, marginy: 80 });
  nodes.forEach((node) => graph.setNode(node.id, { width: nodeWidth, height: nodeHeight }));
  edges.forEach((edge) => graph.setEdge(edge.fromNodeId, edge.toNodeId));
  layout(graph);
  return nodes.map((node) => {
    const position = graph.node(node.id);
    return position
      ? { ...node, position: { x: position.x - nodeWidth / 2, y: position.y - nodeHeight / 2 } }
      : node;
  });
}
```

```ts
// topology-flow-history.ts
export type TopologyHistory = {
  past: TopologySnapshot[];
  present: TopologySnapshot;
  future: TopologySnapshot[];
};

export function createTopologyHistory(present: TopologySnapshot): TopologyHistory {
  return { past: [], present, future: [] };
}

export function pushTopologySnapshot(history: TopologyHistory, next: TopologySnapshot): TopologyHistory {
  return JSON.stringify(history.present) === JSON.stringify(next)
    ? history
    : { past: [...history.past, history.present], present: next, future: [] };
}

export function undoTopology(history: TopologyHistory): TopologyHistory {
  const previous = history.past.at(-1);
  return previous
    ? { past: history.past.slice(0, -1), present: previous, future: [history.present, ...history.future] }
    : history;
}

export function redoTopology(history: TopologyHistory): TopologyHistory {
  const next = history.future[0];
  return next
    ? { past: [...history.past, history.present], present: next, future: history.future.slice(1) }
    : history;
}
```

- [ ] **步骤 4：验证并提交**

```bash
docker compose build web
docker compose run --rm --no-deps web pnpm --filter @aliyun-cyber-range/web test -- components/admin/template-editor/topology-flow-layout.test.ts components/admin/template-editor/topology-flow-history.test.ts
git add apps/web/components/admin/template-editor/topology-flow-layout.ts \
  apps/web/components/admin/template-editor/topology-flow-layout.test.ts \
  apps/web/components/admin/template-editor/topology-flow-history.ts \
  apps/web/components/admin/template-editor/topology-flow-history.test.ts
git commit -m "feat(web): add topology layout history"
```

预期：布局与历史测试全部通过。

### 任务 3：实现自定义节点与默认收缩资源工具轨

**文件：**
- 新建：`apps/web/components/admin/template-editor/topology-flow-node.tsx`
- 新建：`apps/web/components/admin/template-editor/topology-flow-node.test.tsx`
- 新建：`apps/web/components/admin/template-editor/topology-flow-resource-rail.tsx`
- 新建：`apps/web/components/admin/template-editor/topology-flow-resource-rail.test.tsx`

- [ ] **步骤 1：编写失败组件测试**

```tsx
it('在连线模式中显示 ECS 元数据和两端 Handle', () => {
  render(<TopologyFlowNode {...flowNodeProps} data={{
    connectMode: true,
    topologyNode: ecsNode,
  }} />);

  expect(screen.getByText('Web ECS')).toBeTruthy();
  expect(screen.getByText('10.70.10.10')).toBeTruthy();
  expect(screen.getByTestId('topology-flow-source-handle')).toBeTruthy();
  expect(screen.getByTestId('topology-flow-target-handle')).toBeTruthy();
});

it('默认保持资源工具轨收缩，展开后可请求添加 ECS', () => {
  const onAddNode = vi.fn();
  render(<TopologyFlowResourceRail onAddNode={onAddNode} />);

  expect(screen.getByTestId('topology-resource-rail')).toHaveAttribute('data-expanded', 'false');
  fireEvent.click(screen.getByRole('button', { name: '打开资源面板' }));
  fireEvent.click(screen.getByRole('button', { name: /ECS 主机/ }));
  expect(onAddNode).toHaveBeenCalledWith('ecs');
});
```

- [ ] **步骤 2：确认新组件尚不存在**

```bash
docker compose build web
docker compose run --rm --no-deps web pnpm --filter @aliyun-cyber-range/web test -- components/admin/template-editor/topology-flow-node.test.tsx components/admin/template-editor/topology-flow-resource-rail.test.tsx
```

- [ ] **步骤 3：实现节点与工具轨**

```tsx
export const TopologyFlowNode = React.memo(function TopologyFlowNode({
  data,
  selected,
  isConnectable,
}: NodeProps<TopologyFlowNodeData>) {
  const { topologyNode, connectMode } = data;
  return (
    <div className="topology-flow-node" data-kind={topologyNode.kind} data-selected={selected ? 'true' : 'false'}>
      {connectMode ? <Handle data-testid="topology-flow-target-handle" isConnectable={isConnectable} position={Position.Left} type="target" /> : null}
      <img alt="" aria-hidden="true" className="topology-flow-node-icon" src={readNodeIcon(topologyNode.kind)} />
      <span className="topology-flow-node-copy">
        <strong>{topologyNode.label}</strong>
        <span>{readNodeMeta(topologyNode)}</span>
      </span>
      {connectMode ? <Handle data-testid="topology-flow-source-handle" isConnectable={isConnectable} position={Position.Right} type="source" /> : null}
    </div>
  );
});
```

```tsx
export function TopologyFlowResourceRail({ onAddNode, onDragStart }: Props) {
  const [expanded, setExpanded] = React.useState(false);
  return (
    <aside className="topology-resource-rail" data-expanded={expanded} data-testid="topology-resource-rail">
      <button aria-label={expanded ? '关闭资源面板' : '打开资源面板'} onClick={() => setExpanded((value) => !value)} type="button">
        {expanded ? <X aria-hidden="true" /> : <Box aria-hidden="true" />}
      </button>
      {expanded ? <div className="topology-resource-palette">
        {entries.map(({ kind, label, description, Icon }) => (
          <button draggable key={kind} onClick={() => onAddNode(kind)}
            onDragStart={(event) => onDragStart?.(event, kind)} type="button">
            <Icon aria-hidden="true" />
            <span><strong>{label}</strong><small>{description}</small></span>
          </button>
        ))}
      </div> : null}
    </aside>
  );
}
```

- [ ] **步骤 4：验证并提交**

```bash
docker compose build web
docker compose run --rm --no-deps web pnpm --filter @aliyun-cyber-range/web test -- components/admin/template-editor/topology-flow-node.test.tsx components/admin/template-editor/topology-flow-resource-rail.test.tsx
git add apps/web/components/admin/template-editor/topology-flow-node.tsx \
  apps/web/components/admin/template-editor/topology-flow-node.test.tsx \
  apps/web/components/admin/template-editor/topology-flow-resource-rail.tsx \
  apps/web/components/admin/template-editor/topology-flow-resource-rail.test.tsx
git commit -m "feat(web): add topology flow nodes"
```

### 任务 4：实现 React Flow 无限画布

**文件：**
- 新建：`apps/web/components/admin/template-editor/topology-flow-canvas.tsx`
- 新建：`apps/web/components/admin/template-editor/topology-flow-canvas.test.tsx`

- [ ] **步骤 1：编写失败的画布回调测试**

在本文件内 mock `@xyflow/react`，由 mock 保存接收到的 props；不 mock 领域适配器和资源工具轨。

```tsx
it('仅在视口动作结束后提交视口，并把有效连线交给编辑器', () => {
  const onConnect = vi.fn();
  const onViewportCommit = vi.fn();
  render(<TopologyFlowCanvas {...canvasProps} onConnect={onConnect} onViewportCommit={onViewportCommit} />);

  fireEvent.keyDown(screen.getByTestId('react-flow'), { key: 'c' });
  fireEvent.keyDown(screen.getByTestId('react-flow'), { key: 'v' });

  expect(screen.getByTestId('topology-resource-rail')).toHaveAttribute('data-expanded', 'false');
  expect(onConnect).toHaveBeenCalledWith({ source: 'switch-1', target: 'ecs-1' });
  expect(onViewportCommit).toHaveBeenCalledWith({ x: -80, y: 40, zoom: 1.2 });
});

it('在节点拖动结束时一次提交所有移动节点的位置', () => {
  render(<TopologyFlowCanvas {...canvasProps} />);
  flowProps.onNodeDragStop(new MouseEvent('mouseup'), flowNode, [
    { id: 'switch-1', position: { x: 120, y: 80 } },
    { id: 'ecs-1', position: { x: 440, y: 210 } },
  ]);
  expect(canvasProps.onPositionsCommit).toHaveBeenCalledWith([
    { id: 'switch-1', position: { x: 120, y: 80 } },
    { id: 'ecs-1', position: { x: 440, y: 210 } },
  ]);
});
```

- [ ] **步骤 2：确认画布模块尚不存在**

```bash
docker compose build web
docker compose run --rm --no-deps web pnpm --filter @aliyun-cyber-range/web test -- components/admin/template-editor/topology-flow-canvas.test.tsx
```

- [ ] **步骤 3：实现画布与完成动作回调**

```tsx
const nodeTypes = {
  'topology-router': TopologyFlowNode,
  'topology-switch': TopologyFlowNode,
  'topology-ecs': TopologyFlowNode,
} satisfies NodeTypes;

<ReactFlow
  defaultViewport={viewport ?? undefined}
  edges={toFlowEdges(edges)}
  fitView={!viewport}
  nodes={toFlowNodes(nodes, connectMode)}
  nodeTypes={nodeTypes}
  onlyRenderVisibleElements
  onConnect={(connection) => {
    if (connection.source && connection.target) {
      onConnect({ source: connection.source, target: connection.target });
    }
  }}
  onMoveEnd={(_event, nextViewport) => onViewportCommit(nextViewport)}
  onNodeDragStop={(_event, _node, movedNodes) => {
    onPositionsCommit(movedNodes.map((node) => ({ id: node.id, position: node.position })));
  }}
  onSelectionChange={({ nodes: selectedNodes, edges: selectedEdges }) => {
    onSelectionChange({
      nodeIds: selectedNodes.map((node) => node.id),
      edgeIds: selectedEdges.map((edge) => edge.id),
    });
  }}
  onDrop={(event) => {
    event.preventDefault();
    const kind = event.dataTransfer.getData('application/x-topology-node-kind');
    if (kind === 'router' || kind === 'switch' || kind === 'ecs') {
      onAddNode(kind, flowRef.current?.screenToFlowPosition({ x: event.clientX, y: event.clientY }));
    }
  }}
  onDragOver={(event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }}
  panOnDrag={[1]}
  selectionOnDrag
>
  <Background gap={20} size={1} />
  <Controls showInteractive={false} />
  <MiniMap pannable zoomable />
</ReactFlow>
```

工具栏必须使用带 `title` 与 `aria-label` 的 lucide 图标按钮，提供选择/连线模式、全部/选择布局、撤销、重做、适应视图和专注模式。资源工具轨渲染在工作区内，展开的浮层不能改变图视口尺寸。

- [ ] **步骤 4：补全键盘、删除与拖放测试**

```tsx
it('将 Delete、撤销和重做快捷键转交给动作回调', () => {
  render(<TopologyFlowCanvas {...canvasProps} />);
  const flow = screen.getByTestId('react-flow');
  fireEvent.keyDown(flow, { key: 'Delete' });
  fireEvent.keyDown(flow, { key: 'z', metaKey: true });
  fireEvent.keyDown(flow, { key: 'z', metaKey: true, shiftKey: true });
  expect(canvasProps.onDeleteSelection).toHaveBeenCalledOnce();
  expect(canvasProps.onUndo).toHaveBeenCalledOnce();
  expect(canvasProps.onRedo).toHaveBeenCalledOnce();
});

it('把 ECS 拖放坐标转换为世界坐标后请求添加', () => {
  render(<TopologyFlowCanvas {...canvasProps} />);
  flowProps.onDrop({
    preventDefault: vi.fn(),
    clientX: 240,
    clientY: 180,
    dataTransfer: { getData: () => 'ecs' },
  });
  expect(canvasProps.onAddNode).toHaveBeenCalledWith('ecs', { x: 240, y: 180 });
});
```

- [ ] **步骤 5：验证并提交**

```bash
docker compose build web
docker compose run --rm --no-deps web pnpm --filter @aliyun-cyber-range/web test -- components/admin/template-editor/topology-flow-canvas.test.tsx
git add apps/web/components/admin/template-editor/topology-flow-canvas.tsx \
  apps/web/components/admin/template-editor/topology-flow-canvas.test.tsx
git commit -m "feat(web): add topology flow canvas"
```

### 任务 5：接入模板编辑器、领域校验和属性栏收起

**文件：**
- 修改：`apps/web/components/admin/template-editor/template-editor-screen.tsx`
- 修改：`apps/web/components/admin/template-editor/template-editor-screen.test.tsx`
- 修改：`apps/web/components/admin/template-editor/template-property-panel.tsx`
- 修改：`apps/web/components/admin/template-editor/template-property-panel.test.tsx`

- [ ] **步骤 1：写失败的编辑器集成测试**

在 `template-editor-screen.test.tsx` 中只 mock `TopologyFlowCanvas` 边界，让测试真实调用编辑器的添加、连线、校验和缓存处理函数。

```tsx
vi.mock('./topology-flow-canvas', () => ({
  TopologyFlowCanvas: (props: any) => (
    <div data-testid="topology-flow-canvas" data-viewport={JSON.stringify(props.viewport)}>
      <button onClick={() => props.onAddNode('switch')} type="button">flow add switch</button>
      <button onClick={() => props.onAddNode('ecs')} type="button">flow add ecs</button>
      <button onClick={() => props.onConnect({ source: 'switch-1', target: 'ecs-2' })} type="button">flow connect valid</button>
      <button onClick={() => props.onConnect({ source: 'ecs-2', target: 'switch-1' })} type="button">flow connect invalid</button>
      <button onClick={() => props.onViewportCommit({ x: -80, y: 40, zoom: 1.2 })} type="button">flow commit viewport</button>
    </div>
  ),
}));

it('编辑页渲染新画布而非旧 TemplateCanvas', () => {
  render(<TemplateEditorScreen template={editorTemplate} />);
  expect(screen.getByTestId('topology-flow-canvas')).toBeTruthy();
  expect(screen.queryByTestId('template-canvas-board')).toBeNull();
});

it('有效 switch 到 ecs 连线只在显式保存后发送至后端', async () => {
  render(<TemplateEditorScreen template={editorTemplate} />);
  fireEvent.click(screen.getByRole('button', { name: 'flow add switch' }));
  fireEvent.click(screen.getByRole('button', { name: 'flow add ecs' }));
  fireEvent.click(screen.getByRole('button', { name: 'flow connect valid' }));
  expect(validateAndSaveRangeTemplateMock).not.toHaveBeenCalled();

  fireEvent.change(screen.getByLabelText('镜像名'), { target: { value: 'Ubuntu 24.04 LTS' } });
  fireEvent.click(await screen.findByRole('option', { name: 'Ubuntu 24.04 LTS' }));
  fireEvent.change(screen.getByLabelText('私网 IP 1'), { target: { value: '10.0.0.12' } });
  fireEvent.change(screen.getByLabelText('自定义密码'), { target: { value: 'Valid123!' } });
  fireEvent.click(screen.getByRole('button', { name: '检测与保存' }));

  await waitFor(() => expect(validateAndSaveRangeTemplateMock).toHaveBeenCalledTimes(1));
  expect(validateAndSaveRangeTemplateMock.mock.calls[0]?.[3].topologyGraph.edges)
    .toEqual(expect.arrayContaining([
      expect.objectContaining({ fromNodeId: 'switch-1', toNodeId: 'ecs-2' }),
    ]));
});

it('拒绝非法连线且保留草稿', () => {
  render(<TemplateEditorScreen template={editorTemplate} />);
  fireEvent.click(screen.getByRole('button', { name: 'flow add switch' }));
  fireEvent.click(screen.getByRole('button', { name: 'flow add ecs' }));
  fireEvent.click(screen.getByRole('button', { name: 'flow connect invalid' }));
  expect(screen.getByText(/不允许|不能|无效/)).toBeTruthy();
});
```

- [ ] **步骤 2：在容器中确认新集成测试失败**

```bash
docker compose build web
docker compose run --rm --no-deps web pnpm --filter @aliyun-cyber-range/web test -- components/admin/template-editor/template-editor-screen.test.tsx components/admin/template-editor/template-property-panel.test.tsx
```

- [ ] **步骤 3：将模板编辑器切换到新画布**

在 `TemplateEditorScreen` 中定义：

```tsx
type DraftTopologyGraph = ScenarioGraphDraft & { viewport?: TopologyViewport };

function snapshotTopology(): TopologySnapshot {
  return { nodes, edges, viewport };
}

function commitSnapshot(next: TopologySnapshot, message: string) {
  setNodes(next.nodes);
  setEdges(next.edges);
  setViewport(next.viewport);
  historyRef.current = pushTopologySnapshot(historyRef.current, next);
  setHistoryState(historyRef.current);
  setStatusMessage(message);
}

function handlePositionsCommit(positions: Array<{ id: string; position: { x: number; y: number } }>) {
  const positionsById = new Map(positions.map((item) => [item.id, item.position]));
  const nextNodes = nodes.map((node) => positionsById.has(node.id)
    ? { ...node, position: positionsById.get(node.id)! }
    : node);
  commitSnapshot({ nodes: nextNodes, edges, viewport }, '已移动选中节点。');
}
```

`handleFlowConnect` 必须沿用 `normalizeManualEdgePair` 和 `validateManualEdge`，在校验成功后构造现有 `TemplateEdge`，并在 `Switch -> ECS` 时调用 `syncHostNicsWithLinkedSwitch`。重复边、缺失节点和非法边只更新提示消息，不创建历史快照。

`handleFlowAddNode(kind, position?)` 必须沿用现有 Router 唯一约束、默认节点工厂与命名规则；当传入 `position` 时替换默认位置。添加、删除、移动、连线和自动布局均通过 `commitSnapshot` 写入历史。

将 `buildDraftUpdatePayload`、本地缓存读写、`readResolvedTopologyGraph` 和显式保存请求补充可选 `viewport`。`readGraphSignature(nodes, edges)` 保持不变，避免仅视口变化导致服务器版本缓存失效。

- [ ] **步骤 4：为属性栏增加可选收起动作**

```tsx
type TemplatePropertyPanelProps = {
  selectedNode: TemplateNode | null;
  allNodes: TemplateNode[];
  platformImageAssets?: PlatformImageAsset[];
  instanceTypeAvailability?: InstanceTypeAvailabilitySnapshot | null;
  linkedSwitchIdsByHostId?: Record<string, string[]>;
  onUpdateNode: (nodeId: string, nextNode: TemplateNode) => void;
  readOnly?: boolean;
  instanceDetailMode?: boolean;
  runtimeNodeStatus?: string | null;
  onClose?: () => void;
};

{onClose ? (
  <button aria-label="收起节点属性" className="template-property-panel-close" onClick={onClose} title="收起节点属性" type="button">
    <PanelRightClose aria-hidden="true" />
  </button>
) : null}
```

编辑器使用 `{ nodeIds, edgeIds }` 数组维护选择。仅当单选节点且没有边选中时渲染 `TemplatePropertyPanel`；多选时只展示批量移动、删除和自动布局操作。单选新节点时打开属性栏；用户主动收起后移除所有隐藏面板中的可聚焦控件。

- [ ] **步骤 5：验证并提交**

```bash
docker compose build web
docker compose run --rm --no-deps web pnpm --filter @aliyun-cyber-range/web test -- components/admin/template-editor/template-editor-screen.test.tsx components/admin/template-editor/template-property-panel.test.tsx
git add apps/web/components/admin/template-editor/template-editor-screen.tsx \
  apps/web/components/admin/template-editor/template-editor-screen.test.tsx \
  apps/web/components/admin/template-editor/template-property-panel.tsx \
  apps/web/components/admin/template-editor/template-property-panel.test.tsx
git commit -m "feat(web): integrate topology flow editor"
```

### 任务 6：实现沉浸式工作台与响应式状态

**文件：**
- 修改：`apps/web/app/globals.css`
- 修改：`apps/web/components/admin/template-editor/topology-flow-canvas.test.tsx`
- 修改：`apps/web/components/admin/template-editor/template-editor-screen.test.tsx`

- [ ] **步骤 1：添加布局状态失败测试**

```tsx
it('默认保持左侧工具轨收缩，并在选中节点后展示覆盖式属性栏', () => {
  render(<TemplateEditorScreen template={editorTemplate} />);
  expect(screen.getByTestId('topology-flow-workbench')).toHaveAttribute('data-resource-expanded', 'false');
  expect(screen.getByTestId('topology-flow-inspector')).toHaveAttribute('data-open', 'false');
  fireEvent.click(screen.getByRole('button', { name: 'flow add ecs' }));
  expect(screen.getByTestId('topology-flow-inspector')).toHaveAttribute('data-open', 'true');
});
```

- [ ] **步骤 2：在容器中确认布局测试失败**

```bash
docker compose build web
docker compose run --rm --no-deps web pnpm --filter @aliyun-cyber-range/web test -- components/admin/template-editor/template-editor-screen.test.tsx
```

- [ ] **步骤 3：添加作用域样式**

```css
.topology-flow-workbench {
  position: relative;
  min-height: 680px;
  overflow: hidden;
  border: 1px solid #dbe3ee;
  border-radius: 8px;
  background: #f8fafc;
}

.topology-flow-canvas {
  min-height: 680px;
  background-color: #f8fafc;
  background-image: radial-gradient(circle at 1px 1px, rgba(83, 108, 145, 0.16) 1px, transparent 0);
  background-size: 20px 20px;
}

.topology-resource-rail {
  position: absolute;
  inset: 16px auto 16px 16px;
  z-index: 8;
}

.topology-resource-palette,
.topology-flow-inspector {
  position: absolute;
  z-index: 9;
  background: #ffffff;
  box-shadow: 0 12px 28px rgba(30, 48, 78, 0.14);
}

.topology-flow-inspector {
  top: 16px;
  right: 16px;
  bottom: 16px;
  width: min(324px, calc(100% - 64px));
}
```

所有收起、专注、撤销、重做、适应视图和模式控制均采用固定尺寸的图标按钮，并附带 `title` 与 `aria-label`。视口宽度小于 `1180px` 时，属性栏改为全宽底部抽屉，画布保持首要交互区域。

- [ ] **步骤 4：验证并提交样式**

```bash
docker compose build web
docker compose run --rm --no-deps web pnpm --filter @aliyun-cyber-range/web test -- components/admin/template-editor/topology-flow-canvas.test.tsx components/admin/template-editor/template-editor-screen.test.tsx
git add apps/web/app/globals.css \
  apps/web/components/admin/template-editor/topology-flow-canvas.test.tsx \
  apps/web/components/admin/template-editor/template-editor-screen.test.tsx
git commit -m "style(web): add immersive topology workbench"
```

### 任务 7：容器回归、构建与真实页面烟测

**文件：**
- 仅当检查发现可复现回归时，修改本计划明确列出的 Web 文件。

- [ ] **步骤 1：在重建的 Web 容器中运行模板编辑器回归**

```bash
docker compose build web
docker compose run --rm --no-deps web pnpm --filter @aliyun-cyber-range/web test -- components/admin/template-editor
```

预期：全部模板编辑器测试通过，旧 `template-canvas.test.tsx` 继续保护未改动的实例详情画布。

- [ ] **步骤 2：在容器中运行完整 Web 测试与生产构建**

```bash
docker compose build web
docker compose run --rm --no-deps web pnpm --filter @aliyun-cyber-range/web test
docker compose run --rm --no-deps web pnpm --filter @aliyun-cyber-range/web build
```

预期：Vitest 与 `next build` 均以状态码 `0` 结束。

- [ ] **步骤 3：基于新镜像启动 Compose**

```bash
COMPOSE_BAKE=false docker compose up -d --build
docker compose ps
```

预期：`web`、`api`、`postgres`、`keycloak` 进入健康状态，`keycloak-bootstrap` 成功完成。

- [ ] **步骤 4：在真实创建页完成浏览器烟测**

访问 `http://localhost:3000/admin/scenarios/new`，逐项确认：

1. 默认可见窄资源工具轨、无限点阵画布、小地图和工具栏，浏览器控制台没有错误。
2. 展开资源面板不改变画布尺寸；拖放资源后节点留在投放的世界坐标。
3. 平移和缩放后节点与连线仍正常可见，且没有有限边界。
4. 选中节点显示右侧属性栏；收起后画布仍可用；专注模式能保留小地图与工具栏。
5. 有效 `Switch -> ECS` 连线出现；`Ctrl/Cmd + Z` 删除它；重做恢复它。
6. 自动布局将拓扑按横向层级重新排布。
7. 未点击“检测与保存”前，不向后端提交草稿。

分别截图桌面和移动视口，检查文本遮挡、裁剪标签、不可见控制、空白画布和重叠。

