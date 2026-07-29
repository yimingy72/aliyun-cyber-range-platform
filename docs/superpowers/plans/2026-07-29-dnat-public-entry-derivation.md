# DNAT 公网入口推导 Implementation Plan

**目标：** 将创建拓扑的公网入口完全改由交换机 DNAT 目标推导，并在编译输出中自动标记唯一入口 ECS。

**架构：** 解析器从各交换机 `nat.dnatMappings` 收集并验证目标 ECS。前端同步层与 Web 编译器消费解析结果生成 `topologySpec` 和编译产物；运行时编译器与场景模板生成器使用同一语义作最终校验。画布节点不被回写。

**范围：** 仅桌面端行为与数据编译契约；不调用保存、检测、发布或云资源，不优化移动端。

## 任务 1：锁定前端 DNAT 入口契约

**文件：**
- 修改：`apps/web/lib/template-topology-sync.test.ts`
- 修改：`apps/web/lib/template-compiler.test.ts`
- 修改：`apps/web/components/admin/template-editor/template-editor-screen.test.tsx`

1. 为合法单目标 DNAT 写失败测试：`publicEntry.hostKey` 和执行策略来源于 DNAT，入口协议保留既有默认值，入口 ECS 在编译输出中为 `exposePublic: true`。
2. 为无 DNAT 与多目标 DNAT 写失败测试：旧 `exposePublic`/角色不再决定入口，错误指向 DNAT 配置。
3. 为编辑器早期检测写失败测试：显示“请在交换机中为一台 ECS 配置至少一条 DNAT 端口映射，该 ECS 将作为公网入口。”。
4. 在 Docker Web 测试容器中运行上述测试，确认因旧 flag/role 逻辑失败。

## 任务 2：实现前端同步与编译

**文件：**
- 修改：`apps/web/lib/template-topology-sync.ts`
- 修改：`apps/web/lib/template-compiler.ts`
- 修改：`apps/web/components/admin/template-editor/template-editor-screen.tsx`

1. 提炼可复用的前端 DNAT 唯一入口解析函数，保留错误原因。
2. 将 `topologySpec.publicEntry.hostKey` 与执行策略切换为解析结果，保留既有入口协议默认值。
3. 将 Web 编译主机输出的 `exposePublic` 改为“节点 id 等于 DNAT 目标”。
4. 用解析结果替换编辑器的 flag/role 早期检测，并保持用户文案。
5. 在 Docker Web 测试容器中重新运行相关测试，确认通过。

## 任务 3：锁定运行时编译契约

**文件：**
- 修改：`apps/mcp/test/read-tools.spec.ts`

1. 为无 DNAT、多目标、无效目标、目标未连接交换机和合法单目标写失败测试。
2. 断言运行时输出的入口 ECS 自动获得 `exposePublic: true`，非入口 ECS 不获得该标记。
3. 通过 MCP Docker 测试容器运行真实创建调用链，确认因旧逻辑失败。

## 任务 4：实现运行时推导与最终校验

**文件：**
- 修改：`packages/scenario-runtime/src/scenario-graph.ts` 或相关运行时共享模块
- 修改：`packages/scenario-runtime/src/template-topology-compiler.ts`
- 修改：`packages/scenario-runtime/src/topology-graph-to-scenario-template.ts`
- 修改：`apps/mcp/src/tools/template-schemas.ts`
- 修改：`apps/mcp/src/tools/templates.ts`

1. 在运行时共享模块中提供 DNAT 唯一入口解析与结构校验。
2. 移除入口选择对 `exposePublic`/`role` 的依赖。
3. 令拓扑编译器和场景模板生成器从解析结果建立入口主机、协议及编译输出标记。
4. 将 MCP 的 `exposePublic` 入参改为可选，并把工具说明改为 DNAT 唯一目标规则。
5. 运行 MCP、运行时、Web 和 API 相关测试，确认通过。

## 任务 5：容器态回归与交付

**验证：**

1. Docker 中运行 Web 全量测试。
2. Docker 中运行受影响的 API/运行时测试与全仓测试。
3. 重建 `web`、`api` 与 `provisioner-worker` 镜像。
4. 通过 Docker Compose 启动/替换受影响容器，检查服务健康与 `/admin/scenarios` HTTP 响应。
5. 复核 `git diff`，只提交本功能文件、规格与计划。
6. 将功能分支合并回 `codex/template-state-machine`，推送两个分支。
