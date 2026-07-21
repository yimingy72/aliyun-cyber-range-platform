# 模板拓扑 ECS 独立安全组实施计划

**目标：** 仅为综合靶场模板拓扑中的每台 ECS 创建独立安全组；在编辑器中展示、编辑和删除平台默认 SSH/HTTP 规则，并确保创建、更新、删除与整套销毁同步管理安全组资源。单实例网络保持原样。

**架构：** 在 ECS 主网卡的 JSON 图数据中增加 `default`／`custom` 规则模式。图编译器把默认模式物化为两条规则，自定义空数组保留为空。企业范围 OpenTofu 模块按 ECS 键创建安全组、把规则绑定到目标 ECS 的安全组，并让实例及现有辅助网卡使用该 ECS 的安全组。安全组资源地址以 ECS 键稳定，交给现有工作区、apply 与 destroy 生命周期管理。

**验证：** 所有测试先失败再实现；使用 Docker Compose 构建并从容器中运行。不会新建阿里云资源或执行云端 smoke test。

---

## 任务 1：定义默认／自定义规则数据语义

**文件：**

- 修改：`packages/scenario-runtime/src/scenario-graph.ts`
- 修改：`apps/web/lib/scenario-graph.ts`
- 修改：`apps/web/components/admin/template-editor/template-editor-screen.tsx`
- 修改：`apps/web/lib/template-topology-skeleton.ts`
- 测试：`apps/web/components/admin/template-editor/template-editor-screen.test.tsx`
- 测试：`apps/web/lib/template-topology-sync.test.ts`

- [ ] 先为新建 ECS 和企业范围骨架补充失败测试：主网卡保存 `securityGroupRulesMode: 'default'`，但规则数组仍允许为空。
- [ ] 在两个图类型定义中加入 `SecurityGroupRulesMode` 和网卡的可选 `securityGroupRulesMode` 字段。
- [ ] 更新 ECS 创建、骨架创建与旧拓扑反序列化：缺少模式且已有规则时按 `custom`，缺少模式且规则为空时按 `default`。
- [ ] 在 Docker 容器中运行上述测试，确认新增断言因字段／归一化逻辑缺失而失败。
- [ ] 实现最小类型与归一化逻辑，再在容器中重跑至通过。

## 任务 2：在属性面板展示并持久化有效规则

**文件：**

- 修改：`apps/web/components/admin/template-editor/template-property-panel.tsx`
- 修改：`apps/web/app/globals.css`（仅在现有样式无法表达“平台默认”标签时）
- 测试：`apps/web/components/admin/template-editor/template-property-panel.test.tsx`

- [ ] 先添加失败测试：默认模式的 ECS 显示 TCP 22 与 TCP 80、`0.0.0.0/0` 和“平台默认”标识。
- [ ] 添加失败测试：编辑、添加或删除任一默认规则后，回调中的网卡改为 `custom` 并保存完整规则；删除全部规则仍保存 `custom` 空数组。
- [ ] 使用容器测试命令验证测试因当前空数组展示而失败。
- [ ] 提取纯函数以返回默认规则的不可共享副本；面板在默认模式下用该函数渲染有效规则。
- [ ] 让所有规则变更路径先物化默认规则，再切换为 `custom`，并保留现有规则编辑交互。
- [ ] 重跑该测试文件，确认通过。

## 任务 3：在编译产物中物化每台 ECS 的有效规则

**文件：**

- 修改：`packages/scenario-runtime/src/topology-graph-to-scenario-template.ts`
- 修改：`apps/web/lib/topology-graph-to-scenario-template.ts`（如该前端副本仍为独立实现）
- 修改：相关图／模板编译测试
- 测试：`apps/web/lib/topology-graph-to-scenario-template.test.ts`
- 测试：`packages/scenario-runtime` 对应测试（如存在）

- [ ] 先添加失败测试：空规则的旧模板和显式 `default` 模式各为目标 ECS 编译出稳定键的 SSH/HTTP 两条规则。
- [ ] 添加失败测试：`custom` 空数组不产生规则，`custom` 规则只保留该 ECS 的规则。
- [ ] 在容器中运行测试并确认失败原因是尚未物化默认规则。
- [ ] 实现按目标 ECS 键生成的默认规则（每台 ECS 各有唯一键）；保持 ACL 处理完全不变。
- [ ] 运行编译器测试至通过，并运行相关模板编译回归测试。

## 任务 4：改造企业范围 OpenTofu 为每 ECS 独立安全组

**文件：**

- 修改：`infra/opentofu/modules/alicloud-enterprise-range/main.tf`
- 修改：`infra/opentofu/modules/alicloud-enterprise-range/variables.tf`（仅在类型或说明需同步时）
- 修改：`apps/api/src/provisioning/root-wrapper-template.ts`（仅在模块输入契约需同步时）
- 测试：`test/opentofu-bootstrap.test.mjs`
- 测试：`apps/api/test/alibaba-cloud-opentofu-renderer.e2e-spec.ts` 或现有企业范围渲染测试

- [ ] 先添加失败断言：模块对 `local.host_map` 创建安全组，实例和辅助网卡按 `host_key` 绑定对应安全组，安全组规则按 `target_host_key` 选择安全组；不存在空列表全局 SSH/HTTP 兜底。
- [ ] 在容器中运行 OpenTofu 静态测试并确认其因现有共享 `alicloud_security_group.range` 失败。
- [ ] 将共享安全组替换为 `for_each = local.host_map` 的资源；使用 ECS 键稳定命名和标签。
- [ ] 将主实例和辅助网卡的 `security_groups`／`security_group_ids` 改为其 `host_key` 对应的安全组。
- [ ] 将安全组规则资源绑定到 `alicloud_security_group.hosts[each.value.target_host_key]`，并移除全局回退规则。
- [ ] 运行模块静态测试、`tofu validate` 与渲染测试至通过。

## 任务 5：验证更新与销毁生命周期

**文件：**

- 修改：`apps/api/test/open-tofu-range-provisioner.e2e-spec.ts`（或现有 apply／destroy 生命周期测试）
- 修改：`apps/api/test/enterprise-provision-plan.spec.ts`（如需补充规则／主机映射断言）

- [ ] 先添加失败测试：双 ECS 模板的渲染输入包含两套不同安全组地址和规则目标。
- [ ] 添加失败测试：从双 ECS 拓扑移除一台 ECS 后，计划仅移除其安全组／规则；保留 ECS 的地址不改变。
- [ ] 添加失败测试：整套 destroy 计划包含每个 ECS 的安全组及规则资源。
- [ ] 使用现有 OpenTofu runner 假实现或离线 plan fixture 运行测试，确认在共享安全组实现下失败。
- [ ] 仅通过 IaC 资源地址和依赖修复测试；不添加破坏性生命周期旁路。
- [ ] 重跑生命周期测试至通过。

## 任务 6：容器态回归与交付检查

- [ ] 重建受影响服务镜像：`docker compose build web api provisioner-worker`。
- [ ] 以 `NODE_ENV=test` 在容器内运行所有受影响的前端、运行时、API 与 OpenTofu 测试，避免生产 React 构建导致测试运行时不兼容。
- [ ] 执行 `docker compose config`、企业范围 `tofu validate` 和镜像健康检查。
- [ ] 核对单实例网络模块及 `test/opentofu-bootstrap.test.mjs` 中与单实例共享安全组／全端口开放相关断言没有回归。
- [ ] 不运行阿里云 smoke test；当前验证只使用容器内的静态、单元和离线 OpenTofu 验证。
