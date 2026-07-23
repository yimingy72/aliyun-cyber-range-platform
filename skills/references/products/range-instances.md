# 编排实例

本产品严格对应前端“编排实例”列表和详情页面，管理由模板启动的一整套综合靶场环境。它不是“实例管理”页面的独立训练主机；用户给出平台镜像、CPU、内存、数量时，应转到 [实例管理](./instance-management.md)。

## 页面功能与 MCP 工具

| 前端功能 | MCP 工具 | Scope | 说明 |
|---|---|---|---|
| 实例列表/实例历史 | `range_instance_list` | `ranges:read` | `view=active` 或 `view=history`。 |
| 查看详情 | `range_instance_get` | `ranges:read` | 返回状态、拓扑、资源摘要，不返回运行密码。 |
| 获取访问入口 | `range_instance_get_access` | `ranges:read` + `instances:credentials:read` | SSH、VNC、运行凭据等敏感数据。 |
| 生成实例 | `range_instance_launch` | `ranges:create` | 基于模板启动整套环境。 |
| 保存草稿 | `range_instance_topology_save` | `ranges:write` | 保存实例详情页的拓扑与配置变更，不立即修改云资源。 |
| 应用变更 | `range_instance_topology_apply` | `ranges:write` + `ranges:control` | 保存变更后提交更新作业。 |
| 更新编排拓扑 | `range_instance_sync_template` | `ranges:write` + `templates:write` | 将实例当前配置同步回来源模板。 |
| 失败重试 | `range_instance_retry` | `ranges:control` | 仅创建或销毁失败时重试。 |
| ECS 开机/关机/重启 | `range_instance_node_start`、`range_instance_node_stop`、`range_instance_node_reboot` | `ranges:control` | 对详情页中指定 ECS 节点操作。 |
| ECS VNC | `range_instance_node_open_vnc` | `ranges:read` + `instances:credentials:read` | 返回临时 VNC 地址。 |
| ECS 打包镜像 | `range_instance_node_pack_image` | `ranges:control` + `images:write` | 从节点创建私有平台镜像。 |
| 关闭/销毁 | `range_instance_destroy` | `ranges:destroy` | 回收整套靶场云资源。 |
| 删除创建失败记录 | `range_instance_delete_failed` | `ranges:delete` | 仅允许 `create_failed` 状态。 |

页面“重置”目前未实现实际执行能力，MCP 也不得虚构对应工具。

## 实例拓扑转换 Skill

实例详情页的“保存草稿”“应用变更”“更新编排拓扑”都必须经过实例拓扑转换 Skill：

```text
实例详情 + 用户明确的修改 -> 实例拓扑转换 Skill -> range_instance_topology_*
```

转换 Skill 的输入是：

1. `range_instance_get` 返回的当前实例详情。
2. 用户明确要求修改的节点、网络、ACL、安全组、SNAT、DNAT、镜像或初始化配置。
3. 必要时显式指定主/附加 VPC CIDR 与入口协议。

转换 Skill 必须输出完整 `topologyGraph`，而不是节点补丁或派生部署规格。MCP 从当前实例读取模板元数据，重新编译 `draftScenarioTemplateSpec` 和 `draftCompiledProvisionSpec`，调用方不能提交这些内部字段。

若用户只需查看、访问、节点开关机或销毁，不进入转换 Skill。

## 操作流程

### 生成实例

1. 用 `range_template_list({ view: 'platform' })` 或自己的模板列表定位可用 `templateId`。
2. 取得实例名称和 ISO-8601 `expiresAt`，不能猜测到期时间。
3. 说明将创建的整套网络、ECS、NAT 和公网入口，得到用户确认。
4. 调用 `range_instance_launch`；若返回 `CONFIRMATION_REQUIRED`，使用同一业务参数、幂等键和 `confirmationId` 完成二阶段调用。
5. 用 `range_instance_get` 或 `provision_job_get` 跟踪终态。

### 保存、应用与同步

- 用户只想保留实例配置调整：调用 `range_instance_topology_save`。
- 用户要将调整下发到运行实例：调用 `range_instance_topology_apply`，它会先保存，再提交更新作业。
- 用户要把实例当前配置回写到模板：调用 `range_instance_sync_template`，它会先保存实例配置，再更新来源模板；不会自动改动已运行资源。

应用、同步需要用户确认；同步还会影响后续由该模板生成的实例。

### 节点操作和镜像

- 开机、关机、重启必须提供准确 `rangeInstanceId` 与 ECS `nodeId`，并取得用户确认。
- `range_instance_node_open_vnc` 只在用户明确要求访问时调用；VNC URL 不得在普通摘要中回显。
- 打包镜像可提供 `displayName`、`defaultHostName`、`defaultPassword`、`description`。密码仅在用户明确指定时传入，响应按敏感数据处理。

### 失败与回收

- 创建或销毁失败：先读取详情确认状态，再用 `range_instance_retry`。
- 创建失败且用户明确希望移除记录：使用 `range_instance_delete_failed`。
- 释放运行环境：使用 `range_instance_destroy`。它回收整套资源，不是节点关机的替代。

重试、关机、重启、打包镜像、销毁、删除失败记录均须确认。授权 smoke test 成功后应立即销毁对应编排实例并确认终态。
