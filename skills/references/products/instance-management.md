# 实例管理

管理基于平台镜像创建的独立训练靶机和批次。基于模板启动整套环境时，路由到 [编排实例](./range-instances.md)。

## MCP 工具与参数

除非行内说明，写工具可按运行时 schema 接收 `idempotencyKey` 和 `confirmationId`。

| 操作 | MCP 工具 | 必填参数 | 可选参数 | Scope |
|---|---|---|---|---|
| 查询共享网络 | `single_instance_network_list` | — | — | `settings:read`，仅管理员 |
| 登记本轮网络回收 | `single_instance_network_cleanup_register` | `networkProfileId`、`runId`、带时区 `createdAfter`、明确 `ownerUserIds` | — | `settings:write`，仅管理员 |
| 回收空闲共享网络 | `single_instance_network_destroy` | `networkProfileId`、`cleanupRunId` | 操作元数据 | `settings:write`、`instances:destroy`，仅管理员 |
| 查询单实例/批次 | `single_instance_list` | — | `view: active\|history`，默认 `active` | `instances:read` |
| 查询单实例详情 | `single_instance_get` | `singleInstanceId` | — | `instances:read` |
| 核验云端 ECS | `single_instance_cloud_resource_status` | `singleInstanceId` | — | `instances:read` |
| 查询访问凭据 | `single_instance_get_access` | `singleInstanceId` | — | `instances:read`、`instances:credentials:read` |
| 校验规格 | `single_instance_spec_check` | 正整数 `cpu`、`memory`（GiB） | — | `instances:read` |
| 创建批次 | `single_instance_batch_launch` | `name`、`platformImageAssetId`、`cpu`、`memory`、`quantity`（1–99）、带时区 `expiresAt` | `hostName`、`systemDiskSize`（整数且至少 20）、敏感 `password`、`remark`、操作元数据 | `instances:read`、`instances:create` |
| 销毁单台 | `single_instance_destroy` | `singleInstanceId` | 操作元数据 | `instances:destroy` |
| 销毁整批 | `single_instance_batch_destroy` | `batchId` | 操作元数据 | `instances:destroy` |
| 重试失败任务 | `single_instance_retry` | `singleInstanceId` | 操作元数据 | `instances:control` |
| 重启 | `single_instance_reboot` | `singleInstanceId` | `displayName`、`defaultHostName`、敏感 `defaultPassword`、`description`、操作元数据 | `instances:control` |
| 打开 VNC | `single_instance_open_vnc` | `singleInstanceId` | `displayName`、`defaultHostName`、敏感 `defaultPassword`、`description` | `instances:control`、`instances:credentials:read` |
| 打包镜像 | `single_instance_pack_image` | `singleInstanceId` | `displayName`、`defaultHostName`、敏感 `defaultPassword`、`description`、操作元数据 | `instances:control` |
| 导出凭据 CSV | `single_instance_batch_export_csv` | `batchId` | `view: active\|history` | `instances:read`、`instances:credentials:read` |

## 操作规则

- 查询状态使用 `list`/`get`；密码、SSH、VNC 和 CSV 必须有用户明确请求并具备 `instances:credentials:read`。
- 云端 ECS 核验按 `RangeInstanceId` 标签只读查询实例启动时绑定的地域；返回匹配 ECS ID 和真实云标签白名单（PlatformUserId 对应 owner、RangeInstanceId、SingleInstanceBatchId、CreatedBy、PlatformScope），完整核验响应与分页，不会创建、停止或释放资源。
- 创建前先从 `platform_image_list` 选择可见且启用的 `platformImageAssetId`，再用完全相同的 CPU/内存调用 `single_instance_spec_check`。仅 `exactAvailable: true` 可创建。
- `expiresAt` 必填，必须是带时区的 ISO-8601 未来时间；不得猜测默认到期时间。`quantity` 为 1–99；省略 `systemDiskSize` 时服务端默认 40 GiB。
- 当前候选规格仅为 2c2g、2c4g、4c8g、8c16g。规格校验不预留库存，CPU 或内存变化后必须重新校验。
- 经确认调用 `single_instance_batch_launch` 后，用实例详情或 `provision_job_get` 跟踪终态。
- 单实例创建请求失败后，平台会按该实例的 `RangeInstanceId` 云标签查询并回收可能已经落地的 ECS；共享 VPC、交换机和安全组不会被删除。未创建资源或自动回收成功的记录会归档为 `create_failed` 并进入实例历史；自动回收失败则保留为 `destroy_failed`，继续显示在实例列表中，直到完成回收。
- `retry` 仅处理创建或销毁失败；`reboot` 仅针对运行中的单台实例。销毁前确认单台 `singleInstanceId` 或整批 `batchId`。
- `single_instance_pack_image` 会创建私有镜像资产；`open_vnc`、访问凭据和 CSV 按敏感输出规则处理。

- 新实例固定云账号 UID、地域、网络 profile 和精确可售规格。两个平台用户共享网络但 ECS 按 owner/batch/RangeInstanceId 隔离，私网 IP 由 ECS 分配。
- 普通查询不返回运行密码；敏感凭据必须使用访问工具。批次仍在创建时不能销毁；重复销毁不新增任务。
- 测试结束，先销毁全部成员并核验云端不存在，再由管理员 list 取得本次新建 profile 的准确 ID，确认后 network_destroy；旧未绑定网络、任何活动引用/作业或云端 ECS 均会阻止回收。

- 仅本轮createdAfter之后由声明owner创建的managed新profile可登记回收。登记管理员须保存runId；network_destroy使用同一cleanupRunId。测试前存在的profile和legacy不得登记/销毁。
打包操作只表示请求已接受：返回 `packedImageArtifactId` 后，按同一资产的 `sourceSnapshotAvailable` 跟踪可用状态。测试结束回收打包产物时，使用 `image_catalog_custom_delete({ snapshotId, deleteOwnedSnapshots: true })`，按镜像中心规则确认全部 backing snapshots 已消失；销毁源实例不会删除保留镜像和快照。
