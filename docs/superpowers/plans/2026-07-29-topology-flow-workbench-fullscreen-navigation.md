# 拓扑工作区全屏与导航图实施计划

> **前置设计：** `docs/superpowers/specs/2026-07-29-topology-flow-workbench-fullscreen-navigation-design.md`
>
> **执行方式：** 主线按测试先行逐项实施；子代理只做独立审阅，不与主线并行修改同一文件。

## 目标

在模板创建和编辑页的 `TopologyFlowCanvas` 中移除“选中自动布局”，将“切换专注模式”替换为真实的工作区全屏编辑，并把常驻 MiniMap 改为默认隐藏、按需展开的 `120 × 80` 导航图。

## 范围与约束

- 仅修改 Web 前端和对应测试、样式、设计文档。
- 不改实例详情页的 `TemplateCanvas`，不改后端 API、拓扑数据、草稿缓存或云资源行为。
- 全部回归、构建与页面验证通过 Docker 容器完成。
- 不调用保存、发布、创建或销毁云资源的操作。

## 任务 1：先定义失败的交互与样式测试

**文件：**

- 修改：`apps/web/components/admin/template-editor/topology-flow-canvas.test.tsx`

1. 将测试夹具中的 `onLayoutSelection` 删除，使 TypeScript 先约束调用方不再依赖该回调。
2. 更新默认渲染断言：初始不应存在 `flow-mini-map`，但必须存在 `显示导航图` 按钮。
3. 新增导航图切换测试：
   - 点击 `显示导航图` 后出现 `flow-mini-map`，按钮改为 `隐藏导航图`，`aria-pressed="true"`。
   - 再次点击后 MiniMap 消失，按钮恢复初始无障碍状态。
4. 为 JSDOM 配置可控的 `document.fullscreenElement`、`HTMLElement.prototype.requestFullscreen` 与 `document.exitFullscreen` mock。
5. 新增全屏状态测试：
   - 初始存在 `进入全屏编辑模式`，点击后请求根 `topology-flow-workbench` 的全屏。
   - 手动更新 mock 的 `fullscreenElement` 并派发 `fullscreenchange` 后，按钮变为 `退出全屏编辑模式`，`aria-pressed="true"`。
   - 模拟外部退出并再次派发事件后，按钮恢复进入状态。
6. 将工具栏契约测试改为只验证“全部自动布局”仍触发回调；断言页面不存在“选中自动布局”和“切换专注模式”。
7. 更新 CSS 契约：要求存在 `.topology-flow-workbench:fullscreen`、导航图开关与 `120px × 80px` 规则，且不再出现 `data-focus-mode`。

**失败验证：**

```bash
docker compose run --rm --no-deps -e NODE_ENV=test web \
  pnpm --filter @aliyun-cyber-range/web exec vitest run \
  components/admin/template-editor/topology-flow-canvas.test.tsx
```

预期：测试因当前 MiniMap 常驻、旧专注模式按钮和旧 `onLayoutSelection` 契约而失败，而不是因测试环境或 mock 配置错误。

## 任务 2：实现画布本地状态与全屏 API

**文件：**

- 修改：`apps/web/components/admin/template-editor/topology-flow-canvas.tsx`

1. 从 Lucide 导入中移除 `Focus`，保留适应视图使用的 `Maximize`，并新增 `Maximize2`、`Minimize2` 和导航图图标。
2. 从组件 Props 与参数解构中删除 `onLayoutSelection`。
3. 将根工作区绑定到 `workbenchRef`，新增 `isFullscreen` 和 `isMiniMapVisible`，其中导航图初始状态必须为 `false`。
4. 添加 `fullscreenchange` 监听和 cleanup。每次监听回调基于 `document.fullscreenElement === workbenchRef.current` 同步状态；挂载后立即同步一次。
5. 添加异步全屏切换处理：
   - 根工作区已经全屏时调用 `document.exitFullscreen()`。
   - 否则调用根元素 `requestFullscreen()`。
   - API 缺失或 Promise 拒绝时不更新本地全屏状态，也不影响编辑。
6. 删除“选中自动布局”按钮；保留“全部自动布局”。
7. 用动态名称、标题、图标和 `aria-pressed` 的“进入/退出全屏编辑模式”按钮替换旧“切换专注模式”按钮。
8. 在工作区右下角渲染导航图开关。只有 `isMiniMapVisible` 为真时，才渲染带专用 class、`width={120}`、`height={80}`、`pannable` 和 `zoomable` 的 `MiniMap`。

## 任务 3：删除编辑器中的废弃调用链

**文件：**

- 修改：`apps/web/components/admin/template-editor/template-editor-screen.tsx`

1. 移除只服务于局部“选中自动布局”的 `handleLayoutSelection`。
2. 删除传给 `TopologyFlowCanvas` 的 `onLayoutSelection`。
3. 不改 `handleLayoutAll`、历史记录或选择状态逻辑。

## 任务 4：实现全屏与紧凑导航图样式

**文件：**

- 修改：`apps/web/app/globals.css`

1. 删除所有 `data-focus-mode` 选择器和“专注模式”隐藏侧栏的规则。
2. 新增 `.topology-flow-workbench:fullscreen`：全视口尺寸、无圆角、无外边框，并保留画布及其工具覆盖层。
3. 新增导航图开关的绝对定位、`32px` 固定尺寸、悬停和键盘 focus 样式。
4. 为专用 MiniMap class 固定 `120px × 80px`，放在右下角开关上方，保留边框、背景和阴影。
5. 核对窄屏规则仍让 React Flow 底部面板避开属性面板；导航图隐藏时只显示开关。

## 任务 5：从红到绿并完成回归

1. 完成任务 1 后先运行单文件 Docker Vitest，确认失败原因符合预期。
2. 实施任务 2 至任务 4 的最小代码。
3. 再次运行单文件 Docker Vitest，确认新增测试通过。
4. 运行完整相关回归：

```bash
docker compose run --rm --no-deps -e NODE_ENV=test web \
  pnpm --filter @aliyun-cyber-range/web exec vitest run \
  components/admin/template-editor components/admin/templates-screen.test.tsx
```

5. 执行静态检查：

```bash
git diff --check
```

## 任务 6：重建容器并进行登录态页面验收

1. 构建 Web 镜像：

```bash
NEXT_PUBLIC_API_BASE_URL=http://localhost:13001 \
NEXT_PUBLIC_OIDC_ISSUER=http://localhost:18080/realms/cyber-range \
docker compose build web
```

2. 以隔离端口强制重建 Web 服务：

```bash
POSTGRES_PORT=15432 KEYCLOAK_PORT=18080 API_PORT=13001 WEB_PORT=13000 MCP_PORT=18787 \
WEB_PUBLIC_URL=http://localhost:13000 \
KEYCLOAK_HOSTNAME=http://localhost:18080 \
OIDC_ISSUER=http://localhost:18080/realms/cyber-range \
NEXT_PUBLIC_OIDC_ISSUER=http://localhost:18080/realms/cyber-range \
NEXT_PUBLIC_API_BASE_URL=http://localhost:13001 \
IMAGE_IMPORT_ALLOWED_ORIGINS=http://localhost:13000 \
OPENTOFU_PROVIDER_MIRROR_HOST_PATH=/Users/yym/Documents/阿里云For综合靶场竞赛平台/.local/provider-mirror \
RANGE_PROVISIONER_MODE=dry-run \
docker compose up -d --no-deps --force-recreate web
```

3. 在已登录浏览器中打开模板创建或编辑页，且不保存：
   - 工具栏不存在“选中自动布局”和“切换专注模式”。
   - 导航图默认隐藏，点击后以紧凑尺寸显示，再次点击收起。
   - 点击全屏按钮后只有工作区占满屏幕；再次点击或按 `Esc` 后退出，按钮状态同步。
   - 确认资源工具轨、属性面板、平移、缩放和已有连线保持正常。

## 任务 7：独立审阅与收尾

1. 收集子代理的只读审阅结论。
2. 处理本轮改动引入的 P1/P2 问题，或在交付中说明残余风险。
3. 检查工作区状态，只提交本轮源码、测试、样式和文档变更。
