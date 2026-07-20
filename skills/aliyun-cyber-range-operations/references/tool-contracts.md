# 工具契约

当前 Server 发布 35 个规范工具名。多数 MCP 输入 schema 为宽松通配 schema；`single_instance_spec_check` 已发布 CPU/内存的类型化 schema。本文件补充其余已验证的参数契约。工具列表、工具可见性和类型化 schema 仍以当前会话为准。

表中标为**写操作**的工具都需要用户对准确目标和影响范围的明确授权。`idempotencyKey` 与 `confirmationId` 当前均为可选操作元数据：只在当前服务 schema 或响应实际要求时传入；不要自行假定平台会返回二阶段确认。

独立靶机的 CPU/内存、磁盘、数量和动态可售性规则见 [instance-specifications.md](./instance-specifications.md)。

## 模板与综合靶场

| 工具 | 必填参数 | 可选参数 | Scope | 说明 |
|---|---|---|---|---|
| `range_template_list` | — | `view: platform|mine` | `templates:read` | 默认 `platform`。 |
| `range_template_get` | `templateId` | — | `templates:read` | 返回可读模板详情。 |
| `range_instance_list` | — | `view: active|history` | `ranges:read` | 默认 `active`。 |
| `range_instance_get` | `rangeInstanceId` | — | `ranges:read` | 不返回凭据。 |
| `range_instance_get_access` | `rangeInstanceId` | — | `ranges:read`、`instances:credentials:read` | 敏感输出。 |
| `range_instance_launch` | `templateId`、`name`、ISO-8601 `expiresAt` | 操作元数据 | `ranges:create` | **写操作**；异步执行。 |
| `range_instance_destroy` | `rangeInstanceId` | 操作元数据 | `ranges:destroy` | **写操作**；完整销毁而非关机。 |

## 镜像

| 工具 | 必填参数 | Scope | 说明 |
|---|---|---|---|
| `platform_image_list` | — | `images:read` | 可选 `view: platform|mine`；默认 `platform`。 |
| `platform_image_collect` | `snapshotId`、`displayName` | `images:write` | **写操作**；当前没有列出源快照的 MCP 工具。 |
| `platform_image_rename` | `platformImageAssetId`、`displayName` | `images:write` | **写操作**。 |
| `platform_image_enable` | `platformImageAssetId` | `images:write` | **写操作**。 |
| `platform_image_disable` | `platformImageAssetId` | `images:write` | **写操作**。 |
| `platform_image_publish` | `platformImageAssetId` | `images:write` | **写操作**；将自有资产公开给平台。 |
| `platform_image_unpublish` | `platformImageAssetId` | `images:write` | **写操作**；将自有资产恢复为私有。 |
| `platform_image_remove` | `platformImageAssetId` | `images:write` | **写操作**；破坏性操作。 |

## 单实例

| 工具 | 必填参数 | 可选参数 | Scope | 说明 |
|---|---|---|---|---|
| `single_instance_list` | — | `view: active|history` | `instances:read` | 默认 `active`。 |
| `single_instance_get` | `singleInstanceId` | — | `instances:read` | 不返回凭据。 |
| `single_instance_get_access` | `singleInstanceId` | — | `instances:read`、`instances:credentials:read` | 敏感输出。 |
| `single_instance_spec_check` | 正整数 `cpu`、正整数 `memory`（GiB） | — | `instances:read` | **只读**；校验单实例执行器支持的精确规格是否在默认地域/可用区可售；`exactAvailable: true` 不预留库存。 |
| `single_instance_batch_launch` | `name`、`platformImageAssetId`、整数 `cpu`、整数 `memory`、ISO-8601 `expiresAt`、整数 `quantity` | `hostName`、最小 20 的 `systemDiskSize`、`password`、`remark`、操作元数据 | `instances:read`、`instances:create` | **写操作**；数量为 1–99；首次调用前必须用相同 CPU/内存执行规格校验；服务端也会再次校验。 |
| `single_instance_destroy` | `singleInstanceId` | 操作元数据 | `instances:destroy` | **写操作**。 |
| `single_instance_batch_destroy` | `batchId` | 操作元数据 | `instances:destroy` | **写操作**；针对当前整批实例。 |
| `single_instance_retry` | `singleInstanceId` | 操作元数据 | `instances:control` | **写操作**；仅用于创建/销毁失败。 |
| `single_instance_reboot` | `singleInstanceId` | 操作元数据 | `instances:control` | **写操作**；不要传镜像元数据。 |
| `single_instance_open_vnc` | `singleInstanceId` | — | `instances:control`、`instances:credentials:read` | 敏感 VNC URL；必须有用户明确意图。 |
| `single_instance_pack_image` | `singleInstanceId` | `displayName`、`defaultHostName`、`defaultPassword`、`description`、操作元数据 | `instances:control` | **写操作**；创建私有镜像资产，可能返回密码。 |
| `single_instance_batch_export_csv` | `batchId` | `view: active|history` | `instances:read`、`instances:credentials:read` | 含公网 IP 和密码的敏感 CSV。 |

## 作业、用户与配置

| 工具 | 必填参数 | Scope | 说明 |
|---|---|---|---|
| `provision_job_get` | `provisionJobId` | `jobs:read` | 查询作业状态和失败详情。 |
| `admin_user_list` | — | `users:read` | 仅管理员。 |
| `admin_user_create` | `username`、`password`、`role: admin|user` | `users:write` | 仅管理员；**写操作**。 |
| `admin_user_update_role` | `userId`、`role: admin|user` | `users:write` | 仅管理员；**写操作**。 |
| `admin_user_update_status` | `userId`、`status: active|disabled` | `users:write` | 仅管理员；**写操作**。 |
| `admin_user_reset_password` | `userId`、`password` | `users:write` | 仅管理员；**写操作**且敏感。 |
| `cloud_config_get` | — | `settings:read` | 仅管理员；密钥会脱敏。 |
| `cloud_config_update` | 部分云配置字段 | 操作元数据 | `settings:write` | 仅管理员；**写操作**；只传需要更新的字段。 |
