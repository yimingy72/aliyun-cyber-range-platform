# 拓扑编辑工作台空间与全屏属性面板实施计划

> **前置设计：** `docs/superpowers/specs/2026-07-29-topology-editor-workspace-space-and-fullscreen-design.md`
>
> **执行方式：** 主线按测试先行实施；子代理只做独立审阅，不并行修改主线文件。

## 目标

在桌面模板创建和编辑页隐藏管理顶部栏；将浏览器全屏目标改为编辑网格，让属性面板在全屏内继续显示；并让选择模式下空白处左键拖动平移画布。

## 范围与约束

- 仅修改 Web 前端、对应测试、样式和中文文档。
- 顶栏隐藏仅作用于 `/admin/scenarios/new` 和 `/admin/scenarios/:scenarioId` 的桌面编辑页。
- 不改移动端布局、顶部栏、导航入口、后端接口、保存、检测、发布、草稿缓存或拓扑数据。
- 所有验证均通过 Docker 容器；浏览器验收不保存、不发布、不创建云资源。

## 任务 1：先定义失败测试

**文件：**

- 修改：`apps/web/components/admin/admin-workspace-shell.test.tsx`
- 修改：`apps/web/components/admin/template-editor/topology-flow-canvas.test.tsx`

1. 为 `AdminWorkspaceShell` 增加桌面拓扑编辑页标识测试：
   - 路径为 `/admin/scenarios/new` 与 `/admin/scenarios/example-id` 时，工作台根元素标记为拓扑编辑页。
   - 路径为 `/admin/scenarios`、`/admin/image-center` 时不标记，防止列表和其他页面丢失顶栏。
2. 调整 canvas 全屏 mock，使其记录 `requestFullscreen()` 调用的元素实例。
3. 新增全屏目标测试：
   - 画布位于 `.template-editor-grid` 内时，全屏请求目标必须是该网格。
   - 独立渲染画布时仍回退到 `.topology-flow-workbench`。
   - 将 mock `fullscreenElement` 设为网格并派发 `fullscreenchange` 后，全屏按钮显示退出状态。
4. 更新初始 React Flow 配置断言：
   - 选择模式为 `panOnDrag={[0, 1]}`。
   - `selectionOnDrag` 为 `false`。
   - 连线模式为 `panOnDrag={[1]}`，防止左键与连线手势冲突。
5. 更新样式契约：
   - 存在桌面断点下的拓扑编辑页顶栏隐藏规则。
   - 使用 `.template-editor-grid:fullscreen`，并让内部工作区填满全屏网格。
   - 不再要求 `.topology-flow-workbench:fullscreen` 作为全屏容器。

**失败验证：**

```bash
docker compose run --rm --no-deps -e NODE_ENV=test web \
  pnpm --filter @aliyun-cyber-range/web exec vitest run \
  components/admin/admin-workspace-shell.test.tsx \
  components/admin/template-editor/topology-flow-canvas.test.tsx
```

预期：当前顶栏没有路由标识、全屏请求工作区自身、选择模式仍只允许中键平移且启用框选，测试因此失败。

## 任务 2：实现桌面编辑页的顶栏收敛

**文件：**

- 修改：`apps/web/components/admin/admin-workspace-shell.tsx`
- 修改：`apps/web/app/globals.css`

1. 在工作台壳层以路径精确识别模板编辑路由，并在根元素上输出 `data-topology-editor`。
2. 在桌面媒体查询中隐藏该标识下的 `.admin-topbar`。
3. 不修改认证、续期、退出登录回调或移动端顶部栏结构。
4. 保持列表页和其他后台模块无此标识。

## 任务 3：让属性面板加入全屏层

**文件：**

- 修改：`apps/web/components/admin/template-editor/topology-flow-canvas.tsx`
- 修改：`apps/web/app/globals.css`

1. 为画布增加“最近编辑网格或工作区自身”的全屏目标读取逻辑。
2. `requestFullscreen`、`exitFullscreen` 与 `fullscreenchange` 全部基于该实际目标同步，不能乐观更新本地状态。
3. 将原 `.topology-flow-workbench:fullscreen` 样式迁移为：
   - `.template-editor-grid:fullscreen` 提供全视口的定位、尺寸与背景。
   - 全屏网格内 `.topology-flow-workbench` 填满空间并移除普通编辑边框与圆角。
   - 同级属性面板维持其覆盖式桌面布局、关闭按钮和焦点行为。
4. 保留导航图对属性面板的避让与全屏右下角定位。

## 任务 4：调整选择模式的平移手势

**文件：**

- 修改：`apps/web/components/admin/template-editor/topology-flow-canvas.tsx`

1. 选择模式下启用左键和中键平移。
2. 连线模式下仅保留中键平移。
3. 关闭空白处拖拽框选，保留节点点击、`Shift` 多选、`Space` 平移、滚轮缩放与节点拖动。
4. 不改节点位置的提交时机，仍只在拖动结束后提交领域状态。

## 任务 5：从红到绿并完成回归

1. 完成任务 1 后，在 Docker 测试容器中确认测试按预期失败。
2. 实施任务 2 至任务 4 的最小代码。
3. 重新构建 Web 镜像，运行任务 1 的单文件测试。
4. 运行完整相关回归：

```bash
docker compose run --rm --no-deps -e NODE_ENV=test web \
  pnpm --filter @aliyun-cyber-range/web exec vitest run \
  components/admin/admin-workspace-shell.test.tsx \
  components/admin/template-editor \
  components/admin/templates-screen.test.tsx
```

5. 执行 `git diff --check` 和废弃链路扫描。

## 任务 6：重建服务并进行登录态页面验收

1. 构建 Web 镜像：

```bash
NEXT_PUBLIC_API_BASE_URL=http://localhost:13001 \
NEXT_PUBLIC_OIDC_ISSUER=http://localhost:18080/realms/cyber-range \
docker compose build web
```

2. 使用隔离端口重建 Web 服务：

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

3. 在已登录浏览器中且不保存：
   - 创建和编辑页隐藏桌面顶栏；列表页仍显示。
   - 全屏后从资源面板新增一个资源，属性面板出现且可关闭。
   - 选择模式下从空白处左键拖动，确认视口平移；拖动节点时仅移动节点。
   - 连线模式、导航图和退出全屏保持正常。

## 任务 7：独立审阅与收尾

1. 收集子代理只读审阅结论。
2. 处理新增 P1/P2，或在交付中说明残余风险。
3. 仅提交本轮源码、测试、样式和中文文档。
