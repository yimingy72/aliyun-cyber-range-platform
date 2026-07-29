# 实例详情页同步 Flow 拓扑画布实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将实例详情页升级为与创建页同源的 Flow 无限画布，并使运行中实例的草稿保存、应用变更及回写模板遵循同一套强校验和修订冲突保护。

**Architecture:** `TopologyFlowCanvas` 继续作为不包含实例业务的通用受控画布；实例详情通过工作区适配层传入图、视口、选择和编辑回调。前端与 API 都调用 `@aliyun-cyber-range/scenario-runtime` 的 `compileTemplateTopology` 生成规范化的派生产物，API 保存、应用和回写时均重新编译，拒绝图与规格不一致的请求。

**Tech Stack:** Next.js 15、React、`@xyflow/react`、Vitest、NestJS、Jest、Prisma repository、Docker Compose、TypeScript。

---

## 文件结构

| 文件 | 职责 |
| --- | --- |
| `apps/web/components/admin/template-editor/topology-flow-canvas.tsx` | 为共享画布增加只读能力和可配置的全屏容器。 |
| `apps/web/components/admin/template-editor/topology-flow-resource-rail.tsx` | 在只读模式下禁用资源创建和拖放。 |
| `apps/web/components/admin/template-editor/topology-flow-canvas.test.tsx` | 验证共享画布的只读、全屏和编辑行为。 |
| `apps/web/lib/topology-draft-payload.ts` | Web 端统一把 Flow 图、视口和元数据编译为四份规范化产物。 |
| `apps/web/lib/topology-draft-payload.test.ts` | 验证 DNAT、NIC、图结构和派生产物的公共编译规则。 |
| `apps/web/components/admin/template-editor/template-editor-screen.tsx` | 改为调用公共草稿编译器，避免创建页与实例页规则分叉。 |
| `apps/web/components/admin/template-editor/template-property-panel.tsx` | 将“实例详情显示运行状态”与“禁用编辑字段”拆开。 |
| `apps/web/components/admin/range-instance-topology-workspace.tsx` | 用 `TopologyFlowCanvas` 和三栏全屏容器替换旧 `TemplateCanvas`。 |
| `apps/web/components/admin/range-instance-topology-workspace.test.tsx` | 验证实例工作区画布、属性面板和只读边界。 |
| `apps/web/components/admin/range-instance-detail-screen.tsx` | 管理实例草稿历史、结构编辑、保存、应用、确认回写模板和状态反馈。 |
| `apps/web/components/admin/range-instance-detail-screen.test.tsx` | 覆盖完整编辑、保存/应用顺序、回写模板确认、刷新恢复和历史只读。 |
| `apps/web/lib/admin-api.ts`、`apps/web/lib/admin-types.ts` | 支持来源模板修订号和回写请求体。 |
| `packages/platform-api-client/src/types.ts`、`packages/platform-api-client/src/client.ts` | 同步平台 API 客户端契约。 |
| `apps/api/src/admin/dto/range-instance-sync-template.dto.ts` | 声明模板回写所需的期望模板修订号。 |
| `apps/api/src/admin/dto/range-instance-draft.dto.ts` | 声明保存草稿所需的期望草稿修订号。 |
| `apps/api/src/admin/dto/range-instance-apply.dto.ts` | 声明应用实例草稿所需的期望草稿修订号。 |
| `apps/api/src/admin/ranges.controller.ts` | 将现有回写路由接入 DTO。 |
| `apps/api/src/admin/range-instance-draft.validation.ts` | 用共享编译器严格验证和比较实例草稿。 |
| `apps/api/src/admin/range-instances.service.ts` | 保存规范化草稿、应用前复核、回写模板时要求已保存草稿和修订一致。 |
| `apps/api/src/admin/admin.repository.ts`、`apps/api/src/database/prisma-admin.repository.ts` | 原子比较并递增实例草稿修订号。 |
| `apps/api/test/support/create-memory-admin-repository.ts` | 在 API 测试内复刻实例草稿修订号语义。 |
| `packages/database/prisma/schema.prisma`、`packages/database/prisma/migrations/*/migration.sql` | 为编排实例增加完整草稿、修订号，并为变更任务增加不可变拓扑快照。 |
| `packages/scenario-runtime/package.json`、`packages/scenario-runtime/tsconfig.build.json` | 提供可供 Node 生产进程加载的 `./compiled` JavaScript 导出，保持 Web/MCP 的 TypeScript 源码入口不变。 |
| `apps/api/package.json`、`apps/api/Dockerfile`、`pnpm-lock.yaml` | 声明 API 对 `scenario-runtime/compiled` 的工作区依赖，并让生产 Docker 安装、构建阶段生成可执行共享编译器。 |
| `apps/api/src/provisioning/provisioning-worker.service.ts` | 在实例更新任务中只消费不可变草稿快照，保留排队期间的新草稿。 |
| `apps/api/test/range-instance-draft.e2e-spec.ts` | 覆盖草稿规范化、非法图和所有权/状态限制。 |
| `apps/api/test/range-instance-apply.e2e-spec.ts` | 覆盖应用草稿修订、任务快照和模板修订冲突。 |
| `apps/api/test/provisioning-worker-concurrency.e2e-spec.ts` | 覆盖任务执行期间新草稿不会被旧任务消费或清除。 |
| `apps/web/app/globals.css` | 适配实例详情三栏 Flow 工作台与全屏状态。 |

## Task 1: 为共享 Flow 画布建立只读和全屏容器能力

**Files:**
- Modify: `apps/web/components/admin/template-editor/topology-flow-canvas.tsx:61-606`
- Modify: `apps/web/components/admin/template-editor/topology-flow-resource-rail.tsx:18-105`
- Modify: `apps/web/components/admin/template-editor/topology-flow-canvas.test.tsx`
- Modify: `apps/web/components/admin/template-editor/topology-flow-resource-rail.test.tsx`

- [x] **Step 1: 写出失败的画布能力测试**

在 `topology-flow-canvas.test.tsx` 增加下列用例：只读画布能选择、平移和全屏，但不渲染连线模式、撤销/重做、自动布局和资源新增；编辑画布仍会提交节点拖动和连线；传入实例全屏选择器时，请求全屏的元素是实例三栏容器。

```tsx
it('keeps navigation but disables structural mutations in read-only mode', async () => {
  render(
    <div className="range-instance-topology-grid">
      <TopologyFlowCanvas {...editableProps} mode="readonly" fullscreenTargetSelector=".range-instance-topology-grid" />
    </div>,
  );

  expect(screen.queryByRole('button', { name: '连线模式' })).toBeNull();
  expect(screen.queryByRole('button', { name: '全部自动布局' })).toBeNull();
  expect(screen.getByRole('button', { name: '适应视图' })).toBeTruthy();
  expect(screen.getByRole('button', { name: '进入全屏编辑模式' })).toBeTruthy();
  expect(screen.getByTestId('topology-resource-entry')).toHaveAttribute('aria-disabled', 'true');
});
```

- [x] **Step 2: 在容器中确认测试为红**

Run:

```bash
COMPOSE_BAKE=false docker compose build web
docker compose run --rm --no-deps -e NODE_ENV=test web \
  pnpm --filter @aliyun-cyber-range/web test -- \
  components/admin/template-editor/topology-flow-canvas.test.tsx \
  components/admin/template-editor/topology-flow-resource-rail.test.tsx \
  --pool=forks --maxWorkers=1
```

Expected: FAIL，提示 `mode`、`fullscreenTargetSelector` 或只读 DOM 断言尚不存在。

- [x] **Step 3: 在画布和资源面板实现最小通用能力**

给 `TopologyFlowCanvasProps` 增加：

```ts
type TopologyFlowCanvasProps = {
  mode?: 'edit' | 'readonly';
  fullscreenTargetSelector?: string;
};
```

实现规则：

```tsx
const isReadOnly = mode === 'readonly';

function readFullscreenTarget() {
  const workbench = workbenchRef.current;
  return fullscreenTargetSelector
    ? workbench?.closest<HTMLElement>(fullscreenTargetSelector) ?? workbench
    : workbench?.closest<HTMLElement>('.template-editor-grid') ?? workbench;
}

<ReactFlow
  nodesConnectable={!isReadOnly}
  nodesDraggable={!isReadOnly}
  onConnect={isReadOnly ? undefined : handleConnect}
  onDrop={isReadOnly ? undefined : handleDrop}
  onNodeDragStop={isReadOnly ? undefined : handlePositionsCommit}
  panOnDrag={connectMode && !isReadOnly ? [1] : [0, 1]}
/>
```

只读时隐藏所有会改变图的工具按钮，保留适应视图、全屏和导航图；`Escape` 仍可清除选择。资源面板新增 `disabled?: boolean`，创建按钮设置 `disabled`、`aria-disabled` 并取消 `draggable`，但展开/收起按钮保持可用。

- [x] **Step 4: 在容器中验证画布与资源面板回归**

Run:

```bash
COMPOSE_BAKE=false docker compose build web
docker compose run --rm --no-deps -e NODE_ENV=test web \
  pnpm --filter @aliyun-cyber-range/web test -- \
  components/admin/template-editor/topology-flow-canvas.test.tsx \
  components/admin/template-editor/topology-flow-resource-rail.test.tsx \
  --pool=forks --maxWorkers=1
```

Expected: PASS，现有编辑画布测试和新增只读/全屏测试全部通过。

- [x] **Step 5: 提交共享画布能力**

```bash
git add \
  apps/web/components/admin/template-editor/topology-flow-canvas.tsx \
  apps/web/components/admin/template-editor/topology-flow-resource-rail.tsx \
  apps/web/components/admin/template-editor/topology-flow-canvas.test.tsx \
  apps/web/components/admin/template-editor/topology-flow-resource-rail.test.tsx
git commit -m "feat(web): support readonly flow canvases"
```

## Task 2: 统一创建页与实例页的拓扑草稿编译器

**Files:**
- Create: `apps/web/lib/topology-draft-payload.ts`
- Create: `apps/web/lib/topology-draft-payload.test.ts`
- Modify: `apps/web/components/admin/template-editor/template-editor-screen.tsx:1192-1406`
- Modify: `apps/web/components/admin/template-editor/template-editor-screen.test.tsx`

- [x] **Step 1: 写出公共编译器的失败测试**

测试文件顶部定义 `validGraph`：一个 Router、一个 `10.77.10.0/24` 交换机、一个首网卡绑定该交换机的 ECS，以及指向该 ECS 的 TCP/22 DNAT。定义 `validMetadata` 为模板名、slug、版本、`alibaba_cloud`、`opentofu`、模块路径和 `10.77.0.0/16` 主 VPC。公共函数必须把含 `viewport` 的图传入 `compileTemplateTopology`，返回图、拓扑规格、场景规格、运行规格和编译规格；无 DNAT、多 DNAT 目标、重复公网端口和未连接交换机的 DNAT 目标都必须抛出当前精确错误。

```ts
it('derives all topology artifacts from one DNAT entry host', () => {
  const payload = buildTopologyDraftPayload({
    graph: validGraph,
    metadata: validMetadata,
    viewport: { x: 48, y: -32, zoom: 0.9 },
  });

  expect(payload.topologyGraph.viewport).toEqual({ x: 48, y: -32, zoom: 0.9 });
  expect(payload.topologySpec.publicEntry.hostKey).toBe('ecs-entry');
  expect(payload.compiledProvisionSpec.topology.entryHostKey).toBe('ecs-entry');
  expect(payload.compiledSpec.resources).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: 'ecs-entry', config: expect.objectContaining({ exposePublic: true }) }),
    ]),
  );
});
```

- [x] **Step 2: 在容器中确认公共编译器测试为红**

Run:

```bash
COMPOSE_BAKE=false docker compose build web
docker compose run --rm --no-deps -e NODE_ENV=test web \
  pnpm --filter @aliyun-cyber-range/web test -- \
  lib/topology-draft-payload.test.ts \
  --pool=forks --maxWorkers=1
```

Expected: FAIL，提示 `buildTopologyDraftPayload` 尚未导出。

- [x] **Step 3: 实现公共 Web 编译适配**

在 `topology-draft-payload.ts` 封装运行时共享编译器，而不是复制创建页的产物推导：

```ts
import { compileTemplateTopology, type TemplateAuthoringMetadata } from '@aliyun-cyber-range/scenario-runtime';
import { writeTopologyViewport } from '../components/admin/template-editor/topology-flow-adapter';

export function buildTopologyDraftPayload(input: {
  graph: ScenarioGraphDraft;
  metadata: TemplateAuthoringMetadata;
  viewport: TopologyViewport | null;
}) {
  const compiled = compileTemplateTopology(
    writeTopologyViewport(input.graph, input.viewport),
    input.metadata,
  );
  return {
    ...compiled,
    topologyGraph: writeTopologyViewport(compiled.topologyGraph, input.viewport),
  };
}
```

保留创建页已有的镜像、密码、NIC IP 和实例规格 UI 校验；通过这些校验后，用公共函数一次性得到 `topologyGraph`、`topologySpec`、`scenarioTemplateSpec`、`compiledProvisionSpec` 和 `compiledSpec`。删除 `buildValidatedDraftPayload` 内部重复的四份产物构建，不改变创建页的状态提示文本。

- [x] **Step 4: 在容器中验证公共编译器与创建页**

Run:

```bash
COMPOSE_BAKE=false docker compose build web
docker compose run --rm --no-deps -e NODE_ENV=test web \
  pnpm --filter @aliyun-cyber-range/web test -- \
  lib/topology-draft-payload.test.ts \
  lib/template-compiler.test.ts \
  lib/template-topology-sync.test.ts \
  components/admin/template-editor/template-editor-screen.test.tsx \
  --pool=forks --maxWorkers=1
```

Expected: PASS，创建页现有 DNAT、校验、检测保存和发布测试保持通过。

- [x] **Step 5: 提交公共草稿编译器**

```bash
git add \
  apps/web/lib/topology-draft-payload.ts \
  apps/web/lib/topology-draft-payload.test.ts \
  apps/web/components/admin/template-editor/template-editor-screen.tsx \
  apps/web/components/admin/template-editor/template-editor-screen.test.tsx
git commit -m "refactor(web): share topology draft compilation"
```

## Task 3: 让 API 保存实例草稿时重新编译、规范化并保护修订号

**Files:**
- Modify: `apps/api/package.json`
- Modify: `apps/api/Dockerfile`
- Modify: `pnpm-lock.yaml`
- Modify: `packages/scenario-runtime/package.json`
- Create: `packages/scenario-runtime/tsconfig.build.json`
- Modify: `packages/database/prisma/schema.prisma`
- Create: `packages/database/prisma/migrations/20260729_add_range_instance_draft_revision/migration.sql`
- Modify: `apps/api/src/admin/admin.repository.ts`
- Modify: `apps/api/src/database/prisma-admin.repository.ts`
- Modify: `apps/api/test/support/create-memory-admin-repository.ts`
- Modify: `apps/api/src/admin/dto/range-instance-draft.dto.ts`
- Modify: `apps/api/src/admin/range-instance-draft.validation.ts`
- Modify: `apps/api/src/admin/range-instances.service.ts:275-375`
- Modify: `apps/web/lib/admin-api.ts:272-289`
- Modify: `apps/web/lib/admin-types.ts:246-278`
- Modify: `packages/platform-api-client/src/types.ts:145-149`
- Modify: `packages/platform-api-client/src/client.ts:224-230`
- Modify: `apps/mcp/src/tools/ranges.ts`
- Modify: `apps/mcp/test/read-tools.spec.ts`
- Modify: `apps/api/test/range-instance-draft.e2e-spec.ts`

- [x] **Step 1: 为 API 写出失败的规范化与拒绝测试**

在 `range-instance-draft.e2e-spec.ts` 定义 `validGraph`：一个 Router、一个 `10.77.10.0/24` 的 DMZ 交换机、一个首网卡绑定 DMZ 的 ECS，DNAT `22 -> 22/tcp` 唯一指向该 ECS。用 `compileTemplateTopology(validGraph, metadata)` 生成 `validDraftPayload` 的 `draftTopologyGraph`、`draftTopologySpec`、`draftScenarioTemplateSpec` 和 `draftCompiledProvisionSpec`，并覆盖两个关键契约：

```ts
it('saves only server-compiled artifacts for a valid running instance', async () => {
  const response = await request(app.getHttpServer())
    .patch(`/admin/ranges/${instanceId}/draft`)
    .set('authorization', `Bearer ${userToken}`)
    .send({ ...validDraftPayload, expectedDraftRevision: 0 })
    .expect(200);

  expect(response.body.draftTopologyGraph.viewport).toEqual({ x: 24, y: 48, zoom: 1 });
  expect(response.body.draftTopologySpec.publicEntry.hostKey).toBe('ecs-entry');
  expect(response.body.draftCompiledProvisionSpec.topology.entryHostKey).toBe('ecs-entry');
});

it('rejects a graph when client artifacts do not match its DNAT-derived entry host', async () => {
  await request(app.getHttpServer())
    .patch(`/admin/ranges/${instanceId}/draft`)
    .set('authorization', `Bearer ${userToken}`)
    .send({
      ...validDraftPayload,
      expectedDraftRevision: 0,
      draftCompiledProvisionSpec: staleCompiledProvisionSpec,
    })
    .expect(400);
});

it('rejects a stale draft revision without overwriting the newer draft', async () => {
  await request(app.getHttpServer())
    .patch(`/admin/ranges/${instanceId}/draft`)
    .set('authorization', `Bearer ${userToken}`)
    .send({ ...validDraftPayload, expectedDraftRevision: 0 })
    .expect(200);

  await request(app.getHttpServer())
    .patch(`/admin/ranges/${instanceId}/draft`)
    .set('authorization', `Bearer ${userToken}`)
    .send({ ...validDraftPayload, expectedDraftRevision: 0 })
    .expect(409);
});
```

- [x] **Step 2: 在容器中确认 API 测试为红**

Run:

```bash
COMPOSE_BAKE=false docker compose build api
docker compose run --rm --no-deps -e NODE_ENV=test --entrypoint sh api -lc \
  'pnpm --filter @aliyun-cyber-range/api exec jest --runInBand \
  test/range-instance-draft.e2e-spec.ts'
```

Expected: FAIL，现有浅校验会接受不一致产物，也没有草稿修订冲突保护。

- [x] **Step 3: 增加草稿修订存储并用运行时编译器替换浅校验**

为 `scenario-runtime` 创建可执行的构建入口。`packages/scenario-runtime/tsconfig.build.json`：

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    "outDir": "dist",
    "declaration": true,
    "types": ["node"]
  }
}
```

在 `packages/scenario-runtime/package.json` 增加：

```json
{
  "exports": {
    ".": "./src/index.ts",
    "./compiled": {
      "types": "./dist/index.d.ts",
      "require": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.build.json"
  }
}
```

在 `apps/api/package.json` 的 `dependencies` 增加：

```json
"@aliyun-cyber-range/scenario-runtime": "workspace:*"
```

将 API `build` 脚本调整为先执行 `pnpm --filter @aliyun-cyber-range/scenario-runtime build`，再执行 Prisma、`iac-runner` 和 API `tsc`。API 源码从 `@aliyun-cyber-range/scenario-runtime/compiled` 导入 `compileTemplateTopology`，禁止在生产 API 中导入包的 `.ts` 源码入口。

执行 `pnpm install --lockfile-only` 更新 `pnpm-lock.yaml`，使 API Dockerfile 的 `pnpm install --frozen-lockfile` 能解析共享运行时包。

在 API Dockerfile 的依赖清单复制阶段加入：

```dockerfile
COPY packages/scenario-runtime/package.json packages/scenario-runtime/package.json
```

源码复制完成后的 API 构建会先产生 `packages/scenario-runtime/dist`，因此 Node 运行 `apps/api/dist` 时可通过工作区软链接加载 `scenario-runtime/compiled`。

在 `RangeInstance` Prisma 模型新增：

```prisma
draftTopologySpec Json?
draftRevision Int @default(0)
```

迁移 `20260729_add_range_instance_draft_revision/migration.sql` 使用：

```sql
ALTER TABLE "RangeInstance"
ADD COLUMN "draftTopologySpec" JSONB,
ADD COLUMN "draftRevision" INTEGER NOT NULL DEFAULT 0;
```

将 `draftTopologySpec`、`draftRevision` 加入 `RangeInstanceRecord`、`CreateRangeInstanceInput`、`UpdateRangeInstanceInput`、Prisma 映射和内存仓储克隆。给 `AdminRepository` 新增原子方法：

```ts
saveRangeInstanceDraft(
  id: string,
  expectedDraftRevision: number,
  input: Pick<UpdateRangeInstanceInput,
    'draftTopologyGraph' | 'draftTopologySpec' | 'draftScenarioTemplateSpec' | 'draftCompiledProvisionSpec' |
    'draftUpdatedBy' | 'draftUpdatedAt'
  >,
): Promise<RangeInstanceRecord | null>;
```

Prisma 实现使用 `updateMany({ where: { id, draftRevision: expectedDraftRevision }, data: { ...input, draftRevision: { increment: 1 } } })`；更新数量为零时返回 `null`。内存实现只在修订匹配时更新并递增。`discardDraft` 同样必须以当前修订为条件原子清空四份草稿产物并递增 `draftRevision`，使已排队的旧 apply/sync 请求无法跨越丢弃操作。DTO 和平台客户端保存载荷增加：

```ts
expectedDraftRevision: number;
```

并为 DTO 增加：

```ts
@IsDefined()
@IsObject()
draftTopologySpec!: Record<string, unknown>;
```

`SaveRangeInstanceDraftDto` 除已有的三份产物外还必须接收 `draftTopologySpec`，并使用：

```ts
@IsInt()
@Min(0)
expectedDraftRevision!: number;
```

将 `validateRangeInstanceDraftPayload` 改为接收实例运行态元数据，调用 `compileTemplateTopology` 生成服务端权威产物并比较客户端提交值：

```ts
const compiled = compileTemplateTopology(input.draftTopologyGraph as ScenarioGraphDraft, metadata);

if (!isDeepStrictEqual(input.draftTopologySpec, compiled.topologySpec)) {
  throw new BadRequestException('draftTopologySpec does not match draftTopologyGraph');
}
if (!isDeepStrictEqual(input.draftScenarioTemplateSpec, compiled.scenarioTemplateSpec)) {
  throw new BadRequestException('draftScenarioTemplateSpec does not match draftTopologyGraph');
}
if (!isDeepStrictEqual(input.draftCompiledProvisionSpec, compiled.compiledProvisionSpec)) {
  throw new BadRequestException('draftCompiledProvisionSpec does not match draftTopologyGraph');
}
return compiled;
```

在 `RangeInstancesService.saveDraft` 中只保存 `compiled.topologyGraph`、`compiled.topologySpec`、`compiled.scenarioTemplateSpec` 和 `compiled.compiledProvisionSpec`，并调用原子仓储方法；返回 `null` 时抛出 `ConflictException('Range instance draft has changed; refresh before saving again')`。元数据从实例运行态场景规格、实例名称、模板模块路径及运行态 VPC 读取；缺失元数据时抛出明确 `ConflictException`，不得用空对象回退。

Web API 适配层和 `platform-api-client` 的 `SaveRangeInstanceDraftInput` 同步要求
`expectedDraftRevision`、`draftTopologySpec`、`draftScenarioTemplateSpec` 与
`draftCompiledProvisionSpec`；保存响应返回规范化图和新的 `draftRevision`。

MCP 的 `range_instance_topology_save` 在编译前读取实例，传入读取到的
`expectedDraftRevision`，并发送四份产物。更新 `read-tools.spec.ts` 断言 MCP 保存请求包含
`draftTopologySpec` 和修订号；本任务只改保存契约，apply 与模板回写的 MCP 参数在后续任务
对应接口落地时调整。

- [x] **Step 4: 在容器中验证 API 草稿与应用回归**

Run:

```bash
COMPOSE_BAKE=false docker compose build api mcp
docker compose run --rm --no-deps -e NODE_ENV=test --entrypoint sh api -lc \
  'pnpm --filter @aliyun-cyber-range/api exec jest --runInBand \
  test/range-instance-draft.e2e-spec.ts \
  test/range-templates-publish-precheck.e2e-spec.ts'
docker compose run --rm --no-deps mcp \
  pnpm --filter @aliyun-cyber-range/mcp test -- \
  test/read-tools.spec.ts
```

Expected: PASS，合法草稿被规范化，图/产物不一致和非法 DNAT 均被拒绝，旧草稿修订不会覆盖新草稿。

- [x] **Step 5: 提交 API 草稿强校验**

```bash
git add \
  apps/api/src/admin/range-instance-draft.validation.ts \
  apps/api/src/admin/range-instances.service.ts \
  apps/api/package.json \
  apps/api/Dockerfile \
  pnpm-lock.yaml \
  apps/api/src/admin/admin.repository.ts \
  apps/api/src/database/prisma-admin.repository.ts \
  apps/api/src/admin/dto/range-instance-draft.dto.ts \
  apps/api/test/support/create-memory-admin-repository.ts \
  packages/database/prisma/schema.prisma \
  packages/database/prisma/migrations/20260729_add_range_instance_draft_revision/migration.sql \
  apps/web/lib/admin-api.ts \
  apps/web/lib/admin-types.ts \
  packages/platform-api-client/src/types.ts \
  packages/platform-api-client/src/client.ts \
  apps/mcp/src/tools/ranges.ts \
  apps/mcp/test/read-tools.spec.ts \
  packages/scenario-runtime/package.json \
  packages/scenario-runtime/tsconfig.build.json \
  apps/api/test/range-instance-draft.e2e-spec.ts \
git commit -m "feat(api): validate instance topology drafts"
```

## Task 4: 将应用变更绑定为不可变任务快照

**Files:**
- Create: `apps/api/src/admin/dto/range-instance-apply.dto.ts`
- Modify: `apps/api/src/admin/ranges.controller.ts:123-132`
- Modify: `apps/api/src/admin/range-instances.service.ts:337-377`
- Modify: `apps/api/src/admin/admin.repository.ts`
- Modify: `apps/api/src/database/prisma-admin.repository.ts`
- Modify: `apps/api/test/support/create-memory-admin-repository.ts`
- Modify: `packages/database/prisma/schema.prisma`
- Create: `packages/database/prisma/migrations/20260729_add_provision_job_topology_snapshot/migration.sql`
- Modify: `apps/api/src/provisioning/provisioning-worker.service.ts:203-361`
- Modify: `apps/api/test/range-instance-apply.e2e-spec.ts`
- Modify: `apps/api/test/provisioning-worker-concurrency.e2e-spec.ts`
- Modify: `apps/api/test/range-instance-launch.e2e-spec.ts`
- Modify: `apps/web/lib/admin-api.ts`
- Modify: `packages/platform-api-client/src/types.ts`
- Modify: `packages/platform-api-client/src/client.ts`
- Modify: `apps/mcp/src/tools/ranges.ts`
- Modify: `apps/mcp/test/read-tools.spec.ts`

- [x] **Step 1: 写出应用任务快照与并发的失败测试**

在 `range-instance-apply.e2e-spec.ts` 覆盖下列契约：

```ts
it('creates an update job from exactly the requested saved draft revision', async () => {
  const response = await request(app.getHttpServer())
    .post(`/admin/ranges/${instance.id}/apply`)
    .set('authorization', `Bearer ${userToken}`)
    .send({ expectedDraftRevision: instance.draftRevision })
    .expect(201);

  const job = await repository.getProvisionJobById(response.body.id);
  expect(job?.topologySnapshot).toEqual(expect.objectContaining({
    draftRevision: instance.draftRevision,
    topologyGraph: instance.draftTopologyGraph,
    topologySpec: instance.draftTopologySpec,
    templateModulePath: 'templates/enterprise-range',
  }));
});

it('rejects an outdated apply revision without creating an update job', async () => {
  await request(app.getHttpServer())
    .post(`/admin/ranges/${instance.id}/apply`)
    .set('authorization', `Bearer ${userToken}`)
    .send({ expectedDraftRevision: instance.draftRevision - 1 })
    .expect(409);
});
```

在 `provisioning-worker-concurrency.e2e-spec.ts` 增加受控 update job：任务开始后保存
`draftRevision + 1` 的新草稿，再放行 provisioner。断言 worker 向 provisioner 传入的是
job 快照而非实例的新草稿；任务成功后运行态等于快照、较新的实例草稿仍存在且未被清空。

- [x] **Step 2: 在容器中确认快照测试为红**

Run:

```bash
COMPOSE_BAKE=false docker compose build api
docker compose run --rm --no-deps -e NODE_ENV=test --entrypoint sh api -lc \
  'pnpm --filter @aliyun-cyber-range/api exec jest --runInBand \
  test/range-instance-apply.e2e-spec.ts \
  test/provisioning-worker-concurrency.e2e-spec.ts'
```

Expected: FAIL，现有 apply 不接收草稿修订，也没有将草稿冻结到任务；worker 会读取可变的
`instance.draft*` 字段。

- [x] **Step 3: 持久化任务快照并只消费它**

新增 DTO：

```ts
export class ApplyRangeInstanceDraftDto {
  @IsInt()
  @Min(1)
  expectedDraftRevision!: number;
}
```

在 `ProvisionJob` 增加可空 `topologySnapshot Json?`，迁移仅新增该列。`ProvisionJobRecord`、
`CreateProvisionJobInput`、Prisma 映射和内存仓储均支持下列结构：

```ts
type InstanceTopologyJobSnapshot = {
  draftRevision: number;
  topologyGraph: Record<string, unknown>;
  topologySpec: Record<string, unknown>;
  scenarioTemplateSpec: Record<string, unknown>;
  compiledProvisionSpec: Record<string, unknown>;
  compiledSpec: Record<string, unknown>;
  templateModulePath: string;
};
```

控制器将 apply 请求 DTO 传给 `applyDraft`，Web API 和 `platform-api-client` 的
`applyRangeInstanceDraft` 同步改为接收 `{ expectedDraftRevision }` 并发送 JSON body。
MCP 的 `range_instance_topology_apply` 先保存草稿，再使用保存响应中的
`draftRevision` 调用 apply；更新 `read-tools.spec.ts` 断言二次调用携带该修订。

`RangeInstancesService.applyDraft` 必须：

1. 要求实例为 `running`，存在完整已保存草稿（包括 `draftTopologySpec`），且
   `instance.draftRevision === expectedDraftRevision`；
2. 用 Task 3 的服务端编译验证函数重新编译该草稿，拒绝任一已保存产物不一致的历史脏数据；
3. 解析实例启动时的模板模块路径：优先使用 `templateModulePathSnapshot`，缺失时仅从
   `sourceTemplateVersionId` 指向的版本读取一次，随后将该值冻结到快照；无法解析时拒绝创建任务。
   同时补齐启动实例时的 `templateNameSnapshot`、`templateSlugSnapshot`、
   `templateVersionSnapshot`、`templateModulePathSnapshot` 持久化，保证后续实例不再依赖当前模板草稿；
4. 用服务端规范化结果、`compiledSpec` 与该模块路径创建 `update` job 的 `topologySnapshot`；
5. 仅在 job 创建成功后设置 `lastJobId`、清除错误并 dispatch。草稿本身不在 apply 时清除。

为避免“读到 rev1、另一个保存写入 rev2、仍为 rev1 创建 job”的竞态，仓储新增
`createRangeInstanceApplyJob`。Prisma 实现在一个事务中先创建含快照的 job，再以
`id + expectedDraftRevision` 条件更新 `lastJobId`；条件更新未命中则抛出冲突并回滚新 job。
内存仓储实现相同的全有或全无语义。服务端的图重新编译可在事务前完成，但创建任务的修订号核验
必须在该事务内完成。

worker 在 `effectiveJobType === 'update'` 时必须要求并解析 `job.topologySnapshot`；缺少或无效
快照时将该任务标记失败且不得回退读取 `instance.draft*`、来源模板或来源模板版本。它向
provisioner 传入快照中的 `templateModulePath`、`topologyGraph`、`topologySpec`、
`compiledProvisionSpec` 和 `compiledSpec`。任务成功后将快照中的图、场景规格与运行规格写入实例运行态；仅当当前 `draftRevision` 等于快照修订号时，才清除
`draftTopologyGraph`、`draftTopologySpec`、`draftScenarioTemplateSpec`、
`draftCompiledProvisionSpec`、草稿操作者与时间。若修订更高，保留新草稿。

- [x] **Step 4: 在容器中验证应用快照与 worker 并发回归**

Run:

```bash
COMPOSE_BAKE=false docker compose build api mcp
docker compose run --rm --no-deps -e NODE_ENV=test --entrypoint sh api -lc \
  'pnpm --filter @aliyun-cyber-range/api exec jest --runInBand \
  test/range-instance-apply.e2e-spec.ts \
  test/provisioning-worker-concurrency.e2e-spec.ts \
  test/range-instance-launch.e2e-spec.ts \
  test/open-tofu-range-provisioner.e2e-spec.ts'
docker compose run --rm --no-deps mcp \
  pnpm --filter @aliyun-cyber-range/mcp test -- \
  test/read-tools.spec.ts
```

Expected: PASS，过期修订不创建任务，任务始终消费自身快照，旧任务完成不会覆盖或删除排队期间
保存的新草稿。

- [x] **Step 5: 提交应用任务快照**

```bash
git add \
  apps/api/src/admin/dto/range-instance-apply.dto.ts \
  apps/api/src/admin/ranges.controller.ts \
  apps/api/src/admin/range-instances.service.ts \
  apps/api/src/admin/admin.repository.ts \
  apps/api/src/database/prisma-admin.repository.ts \
  apps/api/src/provisioning/provisioning-worker.service.ts \
  apps/api/test/support/create-memory-admin-repository.ts \
  apps/api/test/range-instance-apply.e2e-spec.ts \
  apps/api/test/provisioning-worker-concurrency.e2e-spec.ts \
  apps/api/test/range-instance-launch.e2e-spec.ts \
  packages/database/prisma/schema.prisma \
  packages/database/prisma/migrations/20260729_add_provision_job_topology_snapshot/migration.sql \
  apps/web/lib/admin-api.ts \
  packages/platform-api-client/src/types.ts \
  packages/platform-api-client/src/client.ts \
  apps/mcp/src/tools/ranges.ts \
  apps/mcp/test/read-tools.spec.ts
git commit -m "feat(ranges): snapshot topology updates"
```

## Task 5: 收紧现有“更新编排拓扑”回写契约并保护模板修订

**Files:**
- Create: `apps/api/src/admin/dto/range-instance-sync-template.dto.ts`
- Modify: `apps/api/src/admin/ranges.controller.ts:134-143`
- Modify: `apps/api/src/admin/range-instances.service.ts:72-95`
- Modify: `apps/api/src/admin/range-instances.service.ts:377-434`
- Modify: `apps/api/src/admin/admin.repository.ts`
- Modify: `apps/api/src/database/prisma-admin.repository.ts`
- Modify: `apps/api/test/support/create-memory-admin-repository.ts`
- Modify: `apps/web/lib/admin-api.ts:309-316`
- Modify: `apps/web/lib/admin-types.ts:246-278`
- Modify: `packages/platform-api-client/src/types.ts:224-230`
- Modify: `packages/platform-api-client/src/client.ts:240-246`
- Modify: `apps/mcp/src/tools/ranges.ts`
- Modify: `apps/mcp/test/read-tools.spec.ts`
- Modify: `apps/api/test/range-instance-apply.e2e-spec.ts`

- [x] **Step 1: 写出模板回写的失败 API 测试**

为 `POST /admin/ranges/:id/sync-template` 增加三项测试：

```ts
it('requires a saved draft and never falls back to the runtime snapshot', async () => {
  await request(app.getHttpServer())
    .post(`/admin/ranges/${runtimeOnlyInstance.id}/sync-template`)
    .set('authorization', 'Bearer dev-admin-token')
    .send({ expectedDraftRevision: 0, expectedTemplateRevision: template.revision })
    .expect(409);
});

it('rejects an outdated source template revision without modifying the template', async () => {
  await request(app.getHttpServer())
    .post(`/admin/ranges/${instance.id}/sync-template`)
    .set('authorization', 'Bearer dev-admin-token')
    .send({
      expectedDraftRevision: instance.draftRevision,
      expectedTemplateRevision: template.revision - 1,
    })
    .expect(409);

  expect((await repository.getRangeTemplateById(template.id))?.revision).toBe(template.revision);
});

it('updates only the source template current draft and keeps its published version unchanged', async () => {
  const before = await repository.getRangeTemplateById(template.id);
  const response = await request(app.getHttpServer())
    .post(`/admin/ranges/${instance.id}/sync-template`)
    .set('authorization', 'Bearer dev-admin-token')
    .send({
      expectedDraftRevision: instance.draftRevision,
      expectedTemplateRevision: before!.revision,
    })
    .expect(201);
  const after = await repository.getRangeTemplateById(template.id);

  expect(response.body.revision).toBe(before!.revision + 1);
  expect(after?.currentPublishedVersionId).toBe(before!.currentPublishedVersionId);
  expect(after?.currentDraftVersion?.topologyGraph).toEqual(instance.draftTopologyGraph);
});
```

另增三项拒绝测试：历史实例返回 `409`；拥有实例但没有来源模板编辑权限的调用者返回
`403`；在草稿读取后保存了更高修订时，旧 `expectedDraftRevision` 返回 `409`，模板修订和
当前草稿均不改变。

- [x] **Step 2: 在容器中确认模板回写测试为红**

Run:

```bash
COMPOSE_BAKE=false docker compose build api
docker compose run --rm --no-deps -e NODE_ENV=test --entrypoint sh api -lc \
  'pnpm --filter @aliyun-cyber-range/api exec jest --runInBand \
  test/range-instance-apply.e2e-spec.ts'
```

Expected: FAIL，现有接口忽略请求体、允许运行态回退，且没有用户加载时的模板修订冲突保护。

- [x] **Step 3: 扩展现有回写路由和服务**

新增 DTO：

```ts
export class SyncRangeInstanceTemplateDto {
  @IsInt()
  @Min(1)
  expectedDraftRevision!: number;

  @IsInt()
  @Min(1)
  expectedTemplateRevision!: number;
}
```

控制器将 `@Body() body: SyncRangeInstanceTemplateDto` 传给服务。`syncTemplate` 实现以下前置条件：

```ts
if (instance.status !== 'running') {
  throw new ConflictException('Only running instances can sync topology back to a template');
}
if (
  !instance.draftTopologyGraph ||
  !instance.draftTopologySpec ||
  !instance.draftScenarioTemplateSpec ||
  !instance.draftCompiledProvisionSpec
) {
  throw new ConflictException('Range instance does not have a saved draft to sync');
}
if (instance.draftRevision !== input.expectedDraftRevision) {
  throw new ConflictException('Range instance draft has changed; refresh before syncing topology');
}
if (template.revision !== input.expectedTemplateRevision) {
  throw new ConflictException('Template has changed; refresh the instance detail before syncing topology');
}
```

随后复用 `RangeTemplatesService` 的正常化、权限及完整拓扑校验逻辑重新编译实例草稿。不得读取
`runtimeTopologyGraph`、不得创建云资源任务、不得发布模板。

为保证实例草稿与模板修订不会在两次读取之间穿透，仓储新增
`syncRangeInstanceDraftToTemplate`：在一个 Prisma transaction 内以
`instance.id + expectedDraftRevision` 检查实例草稿，以
`template.id + expectedTemplateRevision` 条件写入模板草稿。将现有
`saveRangeTemplateTopology` 的事务主体提取为可复用的 transaction helper，使回写与模板编辑
共享更新版本、递增 revision、保留已发布版本的同一持久化路径。任一条件未命中必须回滚，不得
只写其中一侧。内存仓储实现相同的原子语义。

`getById` 在实例有 `templateId` 时读取来源模板并在响应中加入 `sourceTemplateRevision`；
`saveDraft` 的成功响应也必须带上同一字段，避免前端用保存响应替换详情后丢失模板修订。
把该字段和 `draftRevision` 补充到 Web 类型和 `PlatformApiClientLike` 返回类型；
`syncRangeInstanceTemplate` 的 Web/客户端签名改为接收
`{ expectedDraftRevision: number; expectedTemplateRevision: number }` 并发送 JSON body。
MCP 的 `range_instance_sync_template` 先保存草稿，再用保存结果的 `draftRevision` 和详情读取的
`sourceTemplateRevision` 调用回写接口；为这一序列补充 `read-tools.spec.ts` 断言。

- [x] **Step 4: 在容器中验证模板回写和平台客户端契约**

Run:

```bash
COMPOSE_BAKE=false docker compose build api mcp
docker compose run --rm --no-deps -e NODE_ENV=test --entrypoint sh api -lc \
  'pnpm --filter @aliyun-cyber-range/api exec jest --runInBand \
  test/range-instance-apply.e2e-spec.ts \
  test/range-instance-draft.e2e-spec.ts'
docker compose run --rm --no-deps mcp \
  pnpm --filter @aliyun-cyber-range/mcp test
```

Expected: PASS，模板草稿修订正确递增，公开版本不变，旧修订和无草稿请求均被拒绝，MCP 客户端回归不受影响。

- [x] **Step 5: 提交模板回写契约**

```bash
git add \
  apps/api/src/admin/dto/range-instance-sync-template.dto.ts \
  apps/api/src/admin/ranges.controller.ts \
  apps/api/src/admin/range-instances.service.ts \
  apps/api/src/admin/admin.repository.ts \
  apps/api/src/database/prisma-admin.repository.ts \
  apps/api/test/support/create-memory-admin-repository.ts \
  apps/api/test/range-instance-apply.e2e-spec.ts \
  apps/web/lib/admin-api.ts \
  apps/web/lib/admin-types.ts \
  packages/platform-api-client/src/types.ts \
  packages/platform-api-client/src/client.ts \
  apps/mcp/src/tools/ranges.ts \
  apps/mcp/test/read-tools.spec.ts
git commit -m "feat(ranges): protect topology template sync"
```

## Task 6: 以 Flow 画布替换实例详情工作区并开放完整编辑

**Files:**
- Modify: `apps/web/components/admin/template-editor/template-property-panel.tsx:26-37`
- Modify: `apps/web/components/admin/range-instance-topology-workspace.tsx`
- Create: `apps/web/components/admin/range-instance-topology-workspace.test.tsx`
- Modify: `apps/web/app/globals.css:4857-4894`

- [x] **Step 1: 写出实例工作区失败测试**

新增工作区测试，验证运行中实例渲染共享 Flow 画布和资源面板，历史实例传入 `readonly`，属性面板在运行中实例允许完整拓扑字段编辑，在历史实例禁用字段：

```tsx
it('renders the shared flow workbench with an editable instance property panel', () => {
  render(<RangeInstanceTopologyWorkspace {...runningProps} />);

  expect(screen.getByTestId('topology-flow-workbench')).toBeTruthy();
  expect(screen.getByRole('button', { name: '连线模式' })).toBeTruthy();
  expect(screen.getByTestId('topology-resource-rail')).toBeTruthy();
  expect(screen.getByLabelText('名称')).not.toBeDisabled();
  expect(screen.getByLabelText('交换机标识 1')).not.toBeDisabled();
});
```

- [x] **Step 2: 在容器中确认实例工作区测试为红**

Run:

```bash
COMPOSE_BAKE=false docker compose build web
docker compose run --rm --no-deps -e NODE_ENV=test web \
  pnpm --filter @aliyun-cyber-range/web test -- \
  components/admin/range-instance-topology-workspace.test.tsx \
  --pool=forks --maxWorkers=1
```

Expected: FAIL，旧工作区仍渲染 `TemplateCanvas`，且实例详情模式仍禁用部分属性字段。

- [x] **Step 3: 实现实例三栏 Flow 适配层**

将工作区 props 改为完整受控 Flow 接口：

```ts
type RangeInstanceTopologyWorkspaceProps = {
  nodes: TemplateNode[];
  edges: TemplateEdge[];
  viewport: TopologyViewport | null;
  selection: TopologySelection;
  editable: boolean;
  onAddNode: (kind: TopologyResourceKind, position?: XYPosition) => void;
  onConnect: (connection: { source: string; target: string }) => void;
  onDeleteSelection: () => void;
  onLayoutAll: () => void;
  onNodeActivate: (nodeId: string) => void;
  onPositionsCommit: (positions: Array<{ id: string; position: XYPosition }>) => void;
  onViewportCommit: (viewport: TopologyViewport) => void;
  onSelectionChange: (selection: TopologySelection) => void;
  onUndo: () => void;
  onRedo: () => void;
  onUpdateNode: (nodeId: string, node: TemplateNode) => void;
  platformImageAssets: PlatformImageAsset[];
  instanceTypeAvailability: InstanceTypeAvailabilitySnapshot | null;
};
```

工作区使用：

```tsx
<section className="range-instance-topology-grid">
  <TopologyFlowCanvas
    {...flowCallbacks}
    mode={editable ? 'edit' : 'readonly'}
    fullscreenTargetSelector=".range-instance-topology-grid"
  />
  <TemplatePropertyPanel
    {...propertyPanelProps}
    platformImageAssets={platformImageAssets}
    instanceTypeAvailability={instanceTypeAvailability}
    readOnly={!editable}
    runtimeNodeStatus={runtimeNodeStatus}
  />
</section>
```

移除 `TemplatePropertyPanel` 对 `instanceDetailMode` 的写入限制；保留 `runtimeNodeStatus` 作为显示信息，运行中实例通过 `readOnly={false}` 获得与创建页一致的配置字段。CSS 将实例拓扑区域定义为资源面板、画布和属性面板三栏，并添加 `.range-instance-topology-grid:fullscreen` 规则，使高度、画布和属性面板滚动与创建页全屏规则一致。

- [x] **Step 4: 在容器中验证实例工作区与共享画布**

Run:

```bash
COMPOSE_BAKE=false docker compose build web
docker compose run --rm --no-deps -e NODE_ENV=test web \
  pnpm --filter @aliyun-cyber-range/web test -- \
  components/admin/range-instance-topology-workspace.test.tsx \
  components/admin/template-editor/template-property-panel.test.tsx \
  components/admin/template-editor/topology-flow-canvas.test.tsx \
  --pool=forks --maxWorkers=1
```

Expected: PASS，运行中实例可完整编辑，历史实例保持只读，属性面板在全屏容器中仍可用。

- [x] **Step 5: 提交实例 Flow 工作区**

```bash
git add \
  apps/web/components/admin/template-editor/template-property-panel.tsx \
  apps/web/components/admin/range-instance-topology-workspace.tsx \
  apps/web/components/admin/range-instance-topology-workspace.test.tsx \
  apps/web/app/globals.css
git commit -m "feat(web): use flow canvas in instance topology"
```

## Task 7: 在实例详情中接入完整图状态、草稿保存、应用与模板回写确认

**Files:**
- Modify: `apps/web/components/admin/range-instance-detail-screen.tsx:467-510`
- Modify: `apps/web/components/admin/range-instance-detail-screen.tsx:610-1269`
- Modify: `apps/web/components/admin/range-instance-detail-screen.test.tsx`

- [x] **Step 1: 写出实例详情的失败交互测试**

扩展详情页测试，分别覆盖结构编辑、视口、保存、应用和模板回写：

```tsx
it('saves the flow graph viewport before applying an instance update job', async () => {
  render(<RangeInstanceDetailScreen rangeId="range-1" />);
  fireEvent.mouseDown(await screen.findByRole('tab', { name: '拓扑结构' }));
  fireEvent.click(screen.getByRole('button', { name: '全部自动布局' }));
  fireEvent.click(screen.getByRole('button', { name: '应用变更' }));

  await waitFor(() => expect(saveRangeInstanceDraftMock).toHaveBeenCalledWith(
    expect.any(String),
    expect.any(String),
    'range-1',
    expect.objectContaining({
      draftTopologyGraph: expect.objectContaining({
        viewport: expect.objectContaining({ zoom: expect.any(Number) }),
      }),
    }),
  ));
  expect(applyRangeInstanceDraftMock).toHaveBeenCalledAfter(saveRangeInstanceDraftMock);
  expect(applyRangeInstanceDraftMock).toHaveBeenCalledWith(
    expect.any(String),
    expect.any(String),
    'range-1',
    { expectedDraftRevision: 8 },
  );
});

it('confirms and syncs only a saved draft with the displayed template revision', async () => {
  fetchRangeInstanceDetailMock.mockResolvedValue({ ...runningDetail, sourceTemplateRevision: 7 });
  fireEvent.click(screen.getByRole('button', { name: '更新编排拓扑' }));
  expect(screen.getByRole('dialog', { name: '更新编排拓扑' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '确认更新模板草稿' }));

  await waitFor(() => expect(syncRangeInstanceTemplateMock).toHaveBeenCalledWith(
    expect.any(String), expect.any(String), 'range-1', {
      expectedDraftRevision: 8,
      expectedTemplateRevision: 7,
    },
  ));
});
```

同时写历史实例断言：没有资源新增、连线、保存、应用或更新模板按钮，但能操作适应视图、全屏和导航图。

- [x] **Step 2: 在容器中确认实例详情测试为红**

Run:

```bash
COMPOSE_BAKE=false docker compose build web
docker compose run --rm --no-deps -e NODE_ENV=test web \
  pnpm --filter @aliyun-cyber-range/web test -- \
  components/admin/range-instance-detail-screen.test.tsx \
  --pool=forks --maxWorkers=1
```

Expected: FAIL，详情页尚未维护 `TopologyHistory`、视口、结构编辑回调、确认对话框或带修订号的回写调用。

- [x] **Step 3: 实现实例草稿状态和 Flow 回调**

将 `readTopologyGraphDraft` 扩展为读取 `viewport`，并用 `readTopologyViewport` / `writeTopologyViewport` 保存。初始化时创建：

```ts
const [selection, setSelection] = useState<TopologySelection>({ nodeIds: [], edgeIds: [] });
const historyRef = useRef<TopologyHistory | null>(null);
const [historyState, setHistoryState] = useState<TopologyHistory | null>(null);
const [isTemplateSyncDialogOpen, setIsTemplateSyncDialogOpen] = useState(false);
```

当服务端 `draftTopologyGraph` 或运行态图首次载入时，创建 `createTopologyHistory({ nodes, edges, viewport })`。运行中实例进入拓扑页后并行加载 `platform` 与 `mine` 镜像，按 ID 去重后传给属性面板；单选 ECS 的 CPU/内存变化时调用现有 `fetchInstanceTypeAvailability`，把结果传给属性面板。为新增、更新、连接、删除、位置提交和自动布局复制创建页的已验证逻辑：

```ts
function commitSnapshot(snapshot: TopologySnapshot, message: string) {
  const next = pushTopologySnapshot(historyRef.current!, snapshot);
  historyRef.current = next;
  setHistoryState(next);
  setDraftGraph(writeTopologyViewport({
    schemaVersion: '2.0.0',
    nodes: next.present.nodes,
    edges: next.present.edges,
  }, next.present.viewport));
  setSelection({ nodeIds: [], edgeIds: [] });
  setTopologyStatusMessage(message);
}
```

新增和连线沿用创建页的 Router 单例、默认节点、`validateManualEdge`、`normalizeManualEdgePair`、NIC 同步和引用清理规则。`handleSaveDraft` 通过 `buildTopologyDraftPayload` 保存公共编译器返回的规范化图和三份实例草稿规格（拓扑、场景、运行）；编译失败时在操作区附近展示错误并不调用 API。

“应用变更”保持先保存、后调用 `applyRangeInstanceDraft` 的顺序。每次保存用 `detail.draftRevision` 发送 `expectedDraftRevision`，并用 API 返回的递增值替换本地详情。替换原生 `window.confirm` 为已有确认对话框样式，说明“只覆盖来源模板当前草稿，不发布，不影响已运行实例”；确认后调用带 `expectedDraftRevision` 和 `expectedTemplateRevision` 的客户端函数。成功后显示返回模板的修订号；草稿或模板 `409` 均显示“草稿或模板已被更新，请刷新详情后重新确认”。

- [x] **Step 4: 在容器中验证实例详情全量交互**

Run:

```bash
COMPOSE_BAKE=false docker compose build web
docker compose run --rm --no-deps -e NODE_ENV=test web \
  pnpm --filter @aliyun-cyber-range/web test -- \
  components/admin/range-instance-detail-screen.test.tsx \
  components/admin/range-instance-topology-workspace.test.tsx \
  components/admin/template-editor/template-editor-screen.test.tsx \
  --pool=forks --maxWorkers=1
```

Expected: PASS，运行中实例完整编辑、保存/应用/回写顺序、草稿视口恢复和历史只读均通过。

- [x] **Step 5: 提交实例详情业务接入**

```bash
git add \
  apps/web/components/admin/range-instance-detail-screen.tsx \
  apps/web/components/admin/range-instance-detail-screen.test.tsx
git commit -m "feat(web): edit and sync instance topology drafts"
```

## Task 8: 合并后的容器构建与端到端回归

**Files:**
- No product files modified; this task verifies the merged implementation in Docker containers.

- [x] **Step 1: 重建所有受影响镜像**

Run:

```bash
COMPOSE_BAKE=false docker compose build web api provisioner-worker mcp
```

Expected: `web`、`api`、`provisioner-worker`、`mcp` 均显示 `Built`；API 构建实际加载
`@aliyun-cyber-range/scenario-runtime/compiled`，Web 构建完成类型检查。

- [x] **Step 2: 运行 Web 全量回归**

Run:

```bash
docker compose run --rm --no-deps -e NODE_ENV=test web \
  pnpm --filter @aliyun-cyber-range/web test -- \
  --pool=forks --maxWorkers=1
```

Expected: 所有 Web Vitest 文件通过，包含创建页和实例详情两个 Flow 画布消费者。

- [x] **Step 3: 运行 API、worker 与 MCP 回归**

Run:

```bash
docker compose run --rm --no-deps -e NODE_ENV=test --entrypoint sh api -lc \
  'pnpm --filter @aliyun-cyber-range/api exec jest --runInBand \
  test/range-instance-draft.e2e-spec.ts \
  test/range-instance-apply.e2e-spec.ts \
  test/provisioning-worker-concurrency.e2e-spec.ts \
  test/range-templates-publish-precheck.e2e-spec.ts \
  test/range-template-state-machine.spec.ts'
docker compose run --rm --no-deps mcp \
  pnpm --filter @aliyun-cyber-range/mcp test
```

Expected: 所有指定 API、worker 与 MCP 测试通过；不执行阿里云 smoke test。

- [x] **Step 4: 验证隔离生产 API 镜像**

Run:

```bash
export COMPOSE_PROJECT_NAME=codex-instance-topology-production
docker compose up -d postgres
API_PORT=13004 docker compose run --rm -d --no-deps --service-ports \
  -e NODE_ENV=production api
curl --retry 20 --retry-connrefused --retry-delay 1 -fsS \
  http://127.0.0.1:13004/health
docker compose down -v
unset COMPOSE_PROJECT_NAME
```

Expected: 返回 `{"status":"ok","service":"api"}`。该临时 compose 项目只包含新建的
`postgres` 卷，验证完成后必须清理；不要对日常开发 compose 项目执行 `down -v`。

- [x] **Step 5: 验证隔离生产 Web 镜像**

Run:

```bash
docker run --rm -d --name codex-instance-topology-web -p 127.0.0.1:13003:3000 \
  "$(docker compose images -q web)"
curl --retry 20 --retry-connrefused --retry-delay 1 -fsS \
  -o /tmp/codex-instance-topology.html -w 'HTTP %{http_code}\n' \
  http://127.0.0.1:13003/admin/scenarios
docker rm -f codex-instance-topology-web
```

Expected: `HTTP 200`，临时 Web 容器已停止并删除。
