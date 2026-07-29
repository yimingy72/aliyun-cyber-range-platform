# 编排实例

管理由模板启动的一整套综合靶场环境。基于平台镜像、CPU、内存和数量创建独立训练主机时，路由到 [实例管理](./instance-management.md)。

## MCP 工具与参数

保存、应用或同步实例拓扑时，必须先经过本文件的“实例拓扑转换 Skill”。转换 Skill 只能提交完整 `topologyGraph` 与下表允许的访问摘要元数据，不能提交 VPC CIDR 或内部派生字段。

实例拓扑沿用平台固定网络：`10.0.0.0/16` 主 VPC 和 `172.16.0.0/16`、`192.168.0.0/16` 两个附加 CIDR。交换机 CIDR 必须完整落在这三段之一。

除非行内说明，写工具可按运行时 schema 接收 `idempotencyKey` 和 `confirmationId`。

| 操作 | MCP 工具 | 必填参数 | 可选参数 | Scope |
|---|---|---|---|---|
| 实例列表/实例历史 | `range_instance_list` | — | `view: active\|history`，默认 `active` | `ranges:read` |
| 查看详情 | `range_instance_get` | `rangeInstanceId` | — | `ranges:read` |
| 获取访问入口 | `range_instance_get_access` | `rangeInstanceId` | — | `ranges:read`、`instances:credentials:read` |
| 生成实例 | `range_instance_launch` | `templateId`、`name`、带时区 ISO-8601 `expiresAt` | 操作元数据 | `ranges:create` |
| 保存变更 | `range_instance_topology_save` | `rangeInstanceId`、完整 `topologyGraph` | `publicEntryProtocols`、操作元数据 | `ranges:write` |
| 应用变更 | `range_instance_topology_apply` | `rangeInstanceId`、完整 `topologyGraph` | `publicEntryProtocols`、操作元数据 | `ranges:write`、`ranges:control` |
| 更新编排拓扑 | `range_instance_sync_template` | `rangeInstanceId`、完整 `topologyGraph` | `publicEntryProtocols`、操作元数据 | `ranges:write`、`templates:write` |
| 失败重试 | `range_instance_retry` | `rangeInstanceId` | 操作元数据 | `ranges:control` |
| ECS 开机 | `range_instance_node_start` | `rangeInstanceId`、`nodeId` | `displayName`、`defaultHostName`、敏感 `defaultPassword`、`description`、操作元数据 | `ranges:control` |
| ECS 关机 | `range_instance_node_stop` | `rangeInstanceId`、`nodeId` | `displayName`、`defaultHostName`、敏感 `defaultPassword`、`description`、操作元数据 | `ranges:control` |
| ECS 重启 | `range_instance_node_reboot` | `rangeInstanceId`、`nodeId` | `displayName`、`defaultHostName`、敏感 `defaultPassword`、`description`、操作元数据 | `ranges:control` |
| ECS VNC | `range_instance_node_open_vnc` | `rangeInstanceId`、`nodeId` | — | `ranges:read`、`instances:credentials:read` |
| ECS 打包镜像 | `range_instance_node_pack_image` | `rangeInstanceId`、`nodeId` | `displayName`、`defaultHostName`、敏感 `defaultPassword`、`description`、操作元数据 | `ranges:control`、`images:write` |
| 关闭/销毁 | `range_instance_destroy` | `rangeInstanceId` | 操作元数据 | `ranges:destroy` |

## 实例拓扑转换 Skill

保存、应用或同步实例拓扑必须经过：

```text
实例详情 + 用户明确的修改 -> 实例拓扑转换 Skill -> range_instance_topology_*
```

转换 Skill 的输入是：

1. `range_instance_get` 返回的当前实例详情。
2. 用户明确要求修改的节点、网络、ACL、安全组、SNAT、DNAT、镜像或初始化配置。
3. 必要时显式指定主/附加 VPC CIDR 与入口协议。

转换 Skill 必须输出完整 `topologyGraph`，而不是节点补丁或派生部署规格。MCP 从当前实例读取模板元数据并重新编译内部规格；调用方不能提交这些内部字段。用户只需查看、访问、节点开关机或销毁时，不进入转换 Skill。

## 操作流程

### 生成实例

1. 用 `range_template_list({ view: 'platform' })` 或自己的模板列表定位可用 `templateId`。
2. 取得实例名称和带时区的 ISO-8601 `expiresAt`，不能猜测到期时间。
3. 说明将创建的整套网络、ECS、NAT 和公网入口，得到用户确认。
4. 调用 `range_instance_launch`；若返回 `CONFIRMATION_REQUIRED`，按入口的二阶段流程使用同一业务参数、幂等键（如被要求）和 `confirmationId` 完成调用。
5. 用 `range_instance_get` 或 `provision_job_get` 跟踪终态。

### 保存、应用与同步

- 用户只想保留实例配置调整：调用 `range_instance_topology_save`。
- 用户要将调整下发到运行实例：调用 `range_instance_topology_apply`，它先保存完整图，再提交更新作业。
- 用户要把实例当前配置回写到模板：调用 `range_instance_sync_template`，它先保存实例配置，再更新来源模板；不会自动改动已运行资源。

应用、同步需要入口规定的危险操作确认；同步会影响后续由该模板生成的实例。

### 节点操作、访问与镜像

- 开机、关机、重启必须提供准确 `rangeInstanceId` 与 ECS `nodeId`，并取得用户确认。
- `range_instance_get_access` 和 `range_instance_node_open_vnc` 仅在用户明确要求访问时调用，输出遵守入口的敏感规则。
- 打包镜像可提供 `displayName`、`defaultHostName`、`defaultPassword`、`description`。密码仅在用户明确指定时传入，响应按敏感数据处理。

### 失败与回收

- 编排创建进入 OpenTofu 后发生失败时，平台会立即在同一 workspace 执行销毁，回收已部分创建的 VPC、交换机、ACL、EIP、NAT 和 ECS。未创建资源或自动回收成功的记录会归档为 `create_failed`；自动回收失败则标记为 `destroy_failed`，保留在实例列表中并同时记录创建失败和回收失败原因。
- 创建或销毁失败：先读取详情确认状态，再用 `range_instance_retry`。
- 创建失败记录会保留在实例历史中，用于审计、排障和账单归属，不能物理删除。
- 释放运行环境：使用 `range_instance_destroy`。它回收整套资源，不是节点关机的替代。

重试、关机、重启、打包镜像和销毁均须确认。授权 smoke test 成功后应立即销毁对应编排实例并确认终态。
