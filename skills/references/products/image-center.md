# 镜像中心

管理平台镜像资产、云镜像目录和镜像导入任务。

## MCP 工具与参数

除非行内说明，写工具可按运行时 schema 接收 `idempotencyKey` 和 `confirmationId`。

| 操作 | MCP 工具 | 必填参数 | 可选参数 | Scope |
|---|---|---|---|---|
| 查询平台镜像 | `platform_image_list` | — | `view: platform\|mine`，默认 `platform` | `images:read` |
| 收录云快照 | `platform_image_collect` | `snapshotId`、`displayName` | 操作元数据 | `images:write` |
| 重命名 | `platform_image_rename` | `platformImageAssetId`、`displayName` | 操作元数据 | `images:write` |
| 启用 | `platform_image_enable` | `platformImageAssetId` | 操作元数据 | `images:write` |
| 停用 | `platform_image_disable` | `platformImageAssetId` | 操作元数据 | `images:write` |
| 平台发布 | `platform_image_publish` | `platformImageAssetId` | 操作元数据 | `images:write` |
| 取消平台发布 | `platform_image_unpublish` | `platformImageAssetId` | 操作元数据 | `images:write` |
| 删除平台镜像资产 | `platform_image_remove` | `platformImageAssetId` | 操作元数据 | `images:write` |
| 查询镜像目录 | `image_catalog_list` | `scope: public\|custom` | — | `images:read` |
| 同步镜像目录 | `image_catalog_sync` | `scope: public\|custom` | — | `images:read` |
| 删除自定义云镜像 | `image_catalog_custom_delete` | `snapshotId` | 不接受操作元数据 | `images:write` |
| 查询导入任务 | `image_import_job_list` | — | — | `images:read` |
| 重试导入任务 | `image_import_job_retry` | `imageImportJobId` | 不接受操作元数据 | `images:write` |

## 意图与规则

- “可用镜像、我的镜像、选镜像”使用 `platform_image_list`。独立实例使用资产 `id`（`platformImageAssetId`）；模板转换必须同时写入资产 `id`（`platformImageAssetId`）和其云镜像 `imageId`。
- 业务镜像名必须精确匹配一个当前可见、已启用的资产。无匹配、重名或停用时停止；转换后将资产的 `displayName` 写入 ECS `image`/`imageName`，将资产 `id` 写入 `platformImageAssetId`，将云镜像 ID 写入 `imageId` 与 `imageStrategy.imageId`。
- “收录快照”先用 `image_catalog_list({ scope: 'custom' })` 或 `image_catalog_sync` 确认 `snapshotId`，再经确认调用 `platform_image_collect`。
- `enable`/`disable` 控制能否用于后续创建；`publish`/`unpublish` 控制其他用户能否看见。两者不可混用，且都不销毁已有资源。
- 删除平台资产前确认其未被已发布拓扑引用；删除自定义云镜像会删除云端镜像及关联资产。
- 导入任务仅对 `failed` 状态使用 `image_import_job_retry`。`available` 后才可稳定使用。
- 本地 QCOW2、RAW、VHD 上传不由 MCP 提供：JSON 工具不能承载二进制，预签名上传地址也不能作为普通工具结果处理。通过平台上传后，用导入任务工具跟踪。

从运行实例生成镜像不属于本模块：独立实例使用 `single_instance_pack_image`，编排节点使用 `range_instance_node_pack_image`。
