# 多网卡拓扑连线可读性实施计划

> **面向代理执行者：** 必须使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 逐项执行。每一步均使用复选框跟踪。

**目标：** 将多网卡 ECS 的共享折线改为使用稳定分离端点的平滑曲线，使自动布局后每条交换机连线仍可清楚辨认。

**架构：** 适配层从现有 `TemplateNode` 与 `TemplateEdge` 计算仅用于 React Flow 的端点布局；节点组件渲染这些无文字端点；画布将边切换为原生 `bezier` 并在边变化时同步端点。端点 ID 与位置不会进入草稿、保存接口或后端拓扑 JSON。

**技术栈：** Next.js 15、React 19、TypeScript、Vitest、Testing Library、`@xyflow/react`、Docker Compose。

---

## 文件边界

| 文件 | 职责 |
| --- | --- |
| `apps/web/components/admin/template-editor/topology-flow-types.ts` | Flow 节点数据中的端点类型，以及 `bezier` 边类型。 |
| `apps/web/components/admin/template-editor/topology-flow-adapter.ts` | 根据领域边确定性地分配端点，并转换为 React Flow 节点和边。 |
| `apps/web/components/admin/template-editor/topology-flow-adapter.test.ts` | 端点分配、输入顺序稳定性和边转换的纯函数测试。 |
| `apps/web/components/admin/template-editor/topology-flow-node.tsx` | 渲染默认连接句柄及已占用的无文字端点。 |
| `apps/web/components/admin/template-editor/topology-flow-node.test.tsx` | 节点端点的渲染和 React Flow 内部刷新测试。 |
| `apps/web/components/admin/template-editor/topology-flow-canvas.tsx` | 将节点、边同步到带端点布局的适配器结果。 |
| `apps/web/components/admin/template-editor/topology-flow-canvas.test.tsx` | 画布对 `bezier` 边、独立端点和边变更同步的测试。 |
| `apps/web/app/globals.css` | 分离端点在选择、连线和非连线模式下的低干扰样式。 |

### 任务 1：在适配层确定性分配端点

**文件：**
- 修改：`apps/web/components/admin/template-editor/topology-flow-types.ts`
- 修改：`apps/web/components/admin/template-editor/topology-flow-adapter.ts`
- 修改：`apps/web/components/admin/template-editor/topology-flow-adapter.test.ts`

- [ ] **步骤 1：补充失败测试，定义多交换机接入同一 ECS 的端点**

在 `topology-flow-adapter.test.ts` 的 `describe` 上方加入完整夹具：

```ts
const switchA: TemplateNode = {
  id: 'switch-a',
  kind: 'switch',
  label: '交换机 A',
  zoneKey: 'zone-a',
  cidr: '10.70.10.0/24',
  purpose: 'business',
};
const switchB: TemplateNode = {
  id: 'switch-b',
  kind: 'switch',
  label: '交换机 B',
  zoneKey: 'zone-b',
  cidr: '10.70.20.0/24',
};
const ecs: TemplateNode = {
  id: 'ecs-1',
  kind: 'ecs',
  label: 'ECS 1',
  zoneKey: 'zone-a',
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
};
const edgeA: TemplateEdge = {
  id: 'edge-switch-a-ecs',
  fromNodeId: 'switch-a',
  toNodeId: 'ecs-1',
  relationType: 'manual',
};
const edgeB: TemplateEdge = {
  id: 'edge-switch-b-ecs',
  fromNodeId: 'switch-b',
  toNodeId: 'ecs-1',
  relationType: 'manual',
};
```

写入以下断言：

```ts
it('为同一 ECS 的多条交换机连线分配不同且稳定的端点', () => {
  const nodes = [switchA, switchB, ecs];
  const edges = [edgeA, edgeB];

  const flowEcs = toFlowNodes(nodes, edges).find((node) => node.id === 'ecs-1');
  const flowEdges = toFlowEdges(nodes, edges);

  expect(flowEcs?.data.targetPorts).toEqual([
    { id: 'target-edge-switch-a-ecs', offset: 26 },
    { id: 'target-edge-switch-b-ecs', offset: 74 },
  ]);
  expect(flowEdges).toMatchObject([{
    id: 'edge-switch-a-ecs',
    type: 'bezier',
    sourceHandle: 'source-edge-switch-a-ecs',
    targetHandle: 'target-edge-switch-a-ecs',
  }, {
    id: 'edge-switch-b-ecs',
    type: 'bezier',
    sourceHandle: 'source-edge-switch-b-ecs',
    targetHandle: 'target-edge-switch-b-ecs',
  }]);
});

it('端点分配不受节点和边输入顺序影响', () => {
  const ordered = toFlowNodes([switchA, switchB, ecs], [edgeA, edgeB]);
  const reordered = toFlowNodes([ecs, switchB, switchA], [edgeB, edgeA]);

  expect(reordered.find((node) => node.id === 'ecs-1')?.data.targetPorts)
    .toEqual(ordered.find((node) => node.id === 'ecs-1')?.data.targetPorts);
});
```

- [ ] **步骤 2：在容器中确认新增测试失败**

```bash
COMPOSE_BAKE=false docker compose build web
docker compose run --rm --no-deps web \
  pnpm --filter @aliyun-cyber-range/web exec vitest run \
  components/admin/template-editor/topology-flow-adapter.test.ts
```

预期：测试失败，原因是现有 `TopologyFlowNodeData` 不含 `targetPorts`，且边仍是 `smoothstep`、不含专属句柄。

- [ ] **步骤 3：扩展 Flow 类型**

在 `topology-flow-types.ts` 以以下定义替换节点数据和边类型：

```ts
export type TopologyFlowPort = {
  id: string;
  offset: number;
};

export type TopologyFlowNodeData = {
  topologyNode: TemplateNode;
  connectMode: boolean;
  sourcePorts: TopologyFlowPort[];
  targetPorts: TopologyFlowPort[];
};

export type TopologyFlowNode = Node<TopologyFlowNodeData, TopologyFlowNodeType>;
export type TopologyFlowEdge = Edge<{ topologyEdge: TemplateEdge }, 'bezier'>;
```

- [ ] **步骤 4：实现端点和 `bezier` 边转换**

在 `topology-flow-adapter.ts` 定义固定 ID 和端点位置；单条边为中心，多条边在节点可用区域内均匀排列：

```ts
const sourceHandlePrefix = 'source-';
const targetHandlePrefix = 'target-';
const firstPortOffset = 26;
const lastPortOffset = 74;

function readPortOffset(index: number, count: number) {
  if (count <= 1) {
    return 50;
  }

  return firstPortOffset + ((lastPortOffset - firstPortOffset) * index) / (count - 1);
}

function compareConnectedEdges(direction: 'source' | 'target', left: TemplateEdge, right: TemplateEdge) {
  const leftPeerId = direction === 'source' ? left.toNodeId : left.fromNodeId;
  const rightPeerId = direction === 'source' ? right.toNodeId : right.fromNodeId;

  return leftPeerId.localeCompare(rightPeerId) || left.id.localeCompare(right.id);
}
```

将 `toFlowNodes` 签名改为 `toFlowNodes(nodes, edges = [], connectMode = false)`。先构造有效边，确保端点不存在的旧缓存边不会生成悬空端点：

```ts
const knownNodeIds = new Set(nodes.map((node) => node.id));
const knownEdges = edges.filter(
  (edge) => knownNodeIds.has(edge.fromNodeId) && knownNodeIds.has(edge.toNodeId),
);
```

对每个节点从 `knownEdges` 筛选源边和目标边、按 `compareConnectedEdges` 排序：

```ts
const sourceEdges = knownEdges
  .filter((edge) => edge.fromNodeId === topologyNode.id)
  .sort((left, right) => compareConnectedEdges('source', left, right));
const targetEdges = knownEdges
  .filter((edge) => edge.toNodeId === topologyNode.id)
  .sort((left, right) => compareConnectedEdges('target', left, right));
```

再写入：

```ts
data: {
  topologyNode,
  connectMode,
  sourcePorts: sourceEdges.map((edge, index) => ({
    id: `${sourceHandlePrefix}${edge.id}`,
    offset: readPortOffset(index, sourceEdges.length),
  })),
  targetPorts: targetEdges.map((edge, index) => ({
    id: `${targetHandlePrefix}${edge.id}`,
    offset: readPortOffset(index, targetEdges.length),
  })),
},
```

将 `toFlowEdges` 签名改为 `toFlowEdges(nodes, edges)`，先以节点 ID 集合排除端点不存在的边，再输出：

```ts
return edges
  .filter((edge) => knownNodeIds.has(edge.fromNodeId) && knownNodeIds.has(edge.toNodeId))
  .map((topologyEdge) => ({
    id: topologyEdge.id,
    type: 'bezier' as const,
    source: topologyEdge.fromNodeId,
    sourceHandle: `${sourceHandlePrefix}${topologyEdge.id}`,
    target: topologyEdge.toNodeId,
    targetHandle: `${targetHandlePrefix}${topologyEdge.id}`,
    data: { topologyEdge },
  }));
```

保留 `fromFlowNodes`，它只能回写 `data.topologyNode` 和位置，不得把临时端点写回领域节点。

- [ ] **步骤 5：在容器中运行适配器测试**

```bash
COMPOSE_BAKE=false docker compose build web
docker compose run --rm --no-deps web \
  pnpm --filter @aliyun-cyber-range/web exec vitest run \
  components/admin/template-editor/topology-flow-adapter.test.ts
```

预期：`topology-flow-adapter.test.ts` 全部通过；既有视口读写和领域节点转换断言仍通过。

- [ ] **步骤 6：提交适配层**

```bash
git add \
  apps/web/components/admin/template-editor/topology-flow-types.ts \
  apps/web/components/admin/template-editor/topology-flow-adapter.ts \
  apps/web/components/admin/template-editor/topology-flow-adapter.test.ts
git commit -m "feat(web): separate topology edge endpoints"
```

### 任务 2：渲染无文字的已占用端点

**文件：**
- 修改：`apps/web/components/admin/template-editor/topology-flow-node.tsx`
- 修改：`apps/web/components/admin/template-editor/topology-flow-node.test.tsx`

- [ ] **步骤 1：先写失败测试，锁定端点渲染与刷新**

让 `createFlowNode` 可接收 `sourcePorts`、`targetPorts`，并始终为没有端点的旧测试提供空数组：

```tsx
import type { TopologyFlowNodeData } from './topology-flow-types';

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
    </div>
  );
}

function renderFlowNode(
  topologyNode: TemplateNode,
  connectMode: boolean,
  ports: Partial<Pick<TopologyFlowNodeData, 'sourcePorts' | 'targetPorts'>> = {},
) {
  return render(createFlowNode(topologyNode, connectMode, ports));
}
```

加入以下测试：

```tsx
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
```

- [ ] **步骤 2：在容器中确认节点测试失败**

```bash
COMPOSE_BAKE=false docker compose build web
docker compose run --rm --no-deps web \
  pnpm --filter @aliyun-cyber-range/web exec vitest run \
  components/admin/template-editor/topology-flow-node.test.tsx
```

预期：测试失败，原因是节点只渲染单一默认句柄，没有 `data-has-multiple-targets` 或已占用端点。

- [ ] **步骤 3：渲染默认句柄与端点列表**

在 `topology-flow-node.tsx` 使用 `data.sourcePorts`、`data.targetPorts`，并保持现有默认句柄的测试 ID：

```tsx
const portSignature = [
  connectMode ? 'connect' : 'select',
  ...sourcePorts.map((port) => `source:${port.id}:${port.offset}`),
  ...targetPorts.map((port) => `target:${port.id}:${port.offset}`),
].join('|');
```

以 `portSignature` 代替仅比较 `connectMode` 的 ref；签名变化时调用 `updateNodeInternals(id)`。节点根元素添加：

```tsx
data-has-multiple-sources={sourcePorts.length > 1 ? 'true' : 'false'}
data-has-multiple-targets={targetPorts.length > 1 ? 'true' : 'false'}
```

在默认目标句柄后、图标前渲染目标端点：

```tsx
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
```

在默认源句柄前以相同结构渲染 `sourcePorts`，仅替换为：

```tsx
className="topology-flow-node-assigned-handle topology-flow-node-source-port"
data-testid="topology-flow-assigned-source-handle"
position={Position.Right}
type="source"
```

默认句柄分别增加 `className="topology-flow-node-default-handle"` 与稳定 ID `target-default`、`source-default`。未进入连线模式时默认句柄继续不可连接；进入连线模式后默认与已占用端点均可创建连接，`onConnect` 仍只上报源、目标节点 ID。

- [ ] **步骤 4：在容器中运行节点测试**

```bash
COMPOSE_BAKE=false docker compose build web
docker compose run --rm --no-deps web \
  pnpm --filter @aliyun-cyber-range/web exec vitest run \
  components/admin/template-editor/topology-flow-node.test.tsx
```

预期：节点图标、元数据、默认句柄和既有缓存容错测试全部通过；新增端点测试通过。

- [ ] **步骤 5：提交节点端点渲染**

```bash
git add \
  apps/web/components/admin/template-editor/topology-flow-node.tsx \
  apps/web/components/admin/template-editor/topology-flow-node.test.tsx
git commit -m "feat(web): render topology edge ports"
```

### 任务 3：接入画布、样式与容器态回归

**文件：**
- 修改：`apps/web/components/admin/template-editor/topology-flow-canvas.tsx`
- 修改：`apps/web/components/admin/template-editor/topology-flow-canvas.test.tsx`
- 修改：`apps/web/app/globals.css`

- [ ] **步骤 1：先写失败测试，定义画布边和边变更同步**

在 `topology-flow-canvas.test.tsx` 的既有 `nodes`、`edges` 常量之后加入夹具：

```tsx
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
```

加入以下测试：

```tsx
it('将多交换机到同一 ECS 的边作为独立 bezier 端点传给 React Flow', () => {
  render(<TopologyFlowCanvas {...createCanvasProps()} nodes={multiNetworkNodes} edges={multiNetworkEdges} />);

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
    <TopologyFlowCanvas {...createCanvasProps()} nodes={multiNetworkNodes} edges={[multiNetworkEdges[0]!]} />,
  );

  rerender(<TopologyFlowCanvas {...createCanvasProps()} nodes={multiNetworkNodes} edges={multiNetworkEdges} />);

  await waitFor(() => {
    expect(flowState.props?.nodes.find((node: { id: string }) => node.id === 'ecs-1')?.data.targetPorts)
      .toHaveLength(2);
  });
});
```

同一测试文件的样式契约增加：

```ts
expect(styles).toContain('.topology-flow-node-assigned-handle');
expect(styles).toContain(".topology-flow-node[data-connect-mode='false'] .topology-flow-node-default-handle");
expect(styles).toContain("[data-has-multiple-targets='true'] .topology-flow-node-target-port");
```

- [ ] **步骤 2：在容器中确认画布测试失败**

```bash
COMPOSE_BAKE=false docker compose build web
docker compose run --rm --no-deps web \
  pnpm --filter @aliyun-cyber-range/web exec vitest run \
  components/admin/template-editor/topology-flow-canvas.test.tsx
```

预期：测试失败，原因是画布仍调用旧的 `toFlowNodes(nodes, isConnectMode)` 和 `toFlowEdges(edges)`，不能将端点交给 React Flow。

- [ ] **步骤 3：让画布按边同步节点端点**

在 `topology-flow-canvas.tsx` 统一使用适配器的新签名：

```tsx
const topologyFlowNodes = React.useMemo(
  () => toFlowNodes(nodes, edges, isConnectMode),
  [edges, isConnectMode, nodes],
);

const flowEdges = React.useMemo(() => {
  const selectedEdgeIds = new Set(selection.edgeIds);

  return toFlowEdges(nodes, edges).map((edge) => ({
    ...edge,
    selected: selectedEdgeIds.has(edge.id),
  }));
}, [edges, nodes, selection.edgeIds]);
```

在节点同步 effect 中增加边引用追踪：

```tsx
const syncedEdgesRef = React.useRef(edges);

// effect 内
const shouldSyncEdges = syncedEdgesRef.current !== edges;
syncedEdgesRef.current = edges;
const shouldSyncNodeData = (shouldSyncTopology || shouldSyncConnectMode || shouldSyncEdges)
  && (
    currentNode.type !== externalNode.type
    || currentNode.data.topologyNode !== externalNode.data.topologyNode
    || currentNode.data.connectMode !== externalNode.data.connectMode
    || currentNode.data.sourcePorts !== externalNode.data.sourcePorts
    || currentNode.data.targetPorts !== externalNode.data.targetPorts
  );
```

这保证添加、删除、撤销、重做或刷新恢复边时，即便节点数组引用不变，React Flow 也会重新测量端点。

- [ ] **步骤 4：添加端点可见性样式**

在 `globals.css` 保留现有颜色变量和边选中态，替换“非连线模式隐藏所有 Handle”的规则为：

```css
.topology-flow-canvas .react-flow__handle.topology-flow-node-assigned-handle {
  width: 8px;
  height: 8px;
  min-width: 8px;
  min-height: 8px;
  z-index: 2;
}

.topology-flow-node[data-connect-mode='false'] .topology-flow-node-default-handle {
  opacity: 0;
  pointer-events: none;
}

.topology-flow-node[data-connect-mode='false'] .topology-flow-node-assigned-handle {
  opacity: 0;
  pointer-events: none;
}

.topology-flow-node[data-connect-mode='false'][data-has-multiple-targets='true'] .topology-flow-node-target-port,
.topology-flow-node[data-connect-mode='false'][data-has-multiple-sources='true'] .topology-flow-node-source-port {
  opacity: 1;
}
```

该规则只在同一侧存在多条边时显示小圆点；单边保持原有低干扰外观。连线模式不命中上述隐藏规则，所有端点仍可用于创建连接。

- [ ] **步骤 5：在容器中运行画布及关联单测**

```bash
COMPOSE_BAKE=false docker compose build web
docker compose run --rm --no-deps web \
  pnpm --filter @aliyun-cyber-range/web exec vitest run \
  components/admin/template-editor/topology-flow-adapter.test.ts \
  components/admin/template-editor/topology-flow-node.test.tsx \
  components/admin/template-editor/topology-flow-canvas.test.tsx
```

预期：三组测试全部通过，且没有 React Flow 句柄缺失或 TypeScript 错误。

- [ ] **步骤 6：构建、替换并检查 Web 容器**

```bash
COMPOSE_BAKE=false docker compose build web
docker compose up -d --no-deps --force-recreate web
curl -fsSI --max-time 10 http://localhost:3000/admin/scenarios
```

预期：Web 镜像构建成功，容器运行，路由返回 `HTTP/1.1 200` 或认证重定向响应。

- [ ] **步骤 7：使用已登录浏览器进行不保存的验收**

1. 打开模板创建或编辑页，为一台 ECS 添加两张网卡并分别选择两个交换机。
2. 点击自动布局，确认两条线为独立平滑曲线，且在 ECS 左侧落到不同圆点，不出现公共折线主干。
3. 选中、删除、撤销和重做其中一条边，确认另一条边保持独立端点。
4. 刷新页面，确认缓存草稿恢复后的节点关系和曲线端点不变。

不得点击检测保存、发布、应用变更或任何会创建、修改、销毁云资源的操作。

- [ ] **步骤 8：提交画布接入**

```bash
git add \
  apps/web/app/globals.css \
  apps/web/components/admin/template-editor/topology-flow-canvas.tsx \
  apps/web/components/admin/template-editor/topology-flow-canvas.test.tsx
git commit -m "feat(web): clarify multi-network topology links"
```
