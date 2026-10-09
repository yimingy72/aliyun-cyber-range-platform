# 镜像中心

管理平台镜像资产、云镜像目录和镜像导入任务。

## MCP 工具与参数

除非行内说明，写工具可按运行时 schema 接收 `idempotencyKey` 和 `confirmationId`。

| 操作 | MCP 工具 | 必填参数 | 可选参数 | Scope |
|---|---|---|---|---|
| 查询平台镜像 | `platform_image_list` | — | `view: platform\|mine`，默认 `platform` | `images:read` |
| 查询标签字典 | `platform_image_tag_list` | — | — | `images:read`，已认证用户 |
| 创建标签定义 | `platform_image_tag_create` | `name`（1–32字符） | 操作元数据 | `images:write`，仅管理员 |
| 替换资产标签关联 | `platform_image_tags_set` | `platformImageAssetId`、完整 `tagIds` | 操作元数据 | `images:write`，owner或管理员 |
| 收录云快照 | `platform_image_collect` | `snapshotId`、`displayName` | 操作元数据 | `images:write`，仅管理员 |
| 重命名 | `platform_image_rename` | `platformImageAssetId`、`displayName` | 操作元数据 | `images:write` |
| 启用 | `platform_image_enable` | `platformImageAssetId` | 操作元数据 | `images:write` |
| 停用 | `platform_image_disable` | `platformImageAssetId` | 操作元数据 | `images:write` |
| 平台发布 | `platform_image_publish` | `platformImageAssetId` | 操作元数据 | `images:write`，仅管理员 |
| 取消平台发布 | `platform_image_unpublish` | `platformImageAssetId` | 操作元数据 | `images:write`，仅管理员 |
| 删除平台镜像资产 | `platform_image_remove` | `platformImageAssetId` | 操作元数据 | `images:write` |
| 查询镜像目录 | `image_catalog_list` | `scope: public\|custom` | — | `images:read` |
| 同步镜像目录 | `image_catalog_sync` | `scope: public\|custom` | — | `images:read` |
| 删除自定义云镜像 | `image_catalog_custom_delete` | `snapshotId` | `deleteOwnedSnapshots`（默认 `false`）、操作元数据 | `images:write` |
| 查询导入任务 | `image_import_job_list` | — | — | `images:read` |
| 重试导入任务 | `image_import_job_retry` | `imageImportJobId` | 不接受操作元数据 | `images:write` |

## 意图与规则

- “可用镜像、我的镜像、选镜像”使用 `platform_image_list`。独立实例使用资产 `id`（`platformImageAssetId`）；模板转换必须同时写入资产 `id`（`platformImageAssetId`）和其云镜像 `imageId`。
- 业务镜像名必须精确匹配一个当前可见、已启用的资产。无匹配、重名或停用时停止；转换后将资产的 `displayName` 写入 ECS `image`/`imageName`，将资产 `id` 写入 `platformImageAssetId`，将云镜像 ID 写入 `imageId` 与 `imageStrategy.imageId`。
- “收录快照”先用 `image_catalog_list({ scope: 'custom' })` 或 `image_catalog_sync` 确认 `snapshotId`，由管理员再经确认调用 `platform_image_collect`。
- `enable`/`disable` 控制能否用于后续创建；`publish`/`unpublish` 控制其他用户能否看见。两者不可混用，且都不销毁已有资源。
- 收录、发布和取消发布仅管理员可执行。发布或取消发布前，必须检查资产返回的 `canChangeVisibility`。只有 owner-backed 资产可切换可见性；从公共或自定义云镜像目录收录的资产可能已固定为 `platform` 且 `canChangeVisibility: false`，此时不得调用发布/取消发布工具或重试，应如实说明平台限制。
- `platform_image_remove` 仅移出平台目录，保留云镜像、快照和仍计费的台账；删除前确认未被已发布拓扑引用。
- `image_catalog_custom_delete` 默认只允许管理员删除云镜像及关联平台资产，保留 backing snapshots 和快照费用。MCP 使用二阶段确认及相同的业务参数、操作元数据。
- 云镜像删除保护当前模板草稿、当前仍公开的发布版本及未销毁实例的运行/草稿引用；仅历史版本引用不阻止删除。没有活动实例也可能存在有效模板引用，此时应在模板中替换镜像并检测保存；公开发布版本仍引用时，还需重新发布或回退为私有。仅删除平台目录的保护仍针对已发布拓扑。
- MCP删除预确认也检查有效引用，阻塞时管理员会收到`references`（kind/id/name/ownerId/basis）以定位准确模板或实例；不包含凭据，也不访问云端。首次请求若返回确认要求只表示预检通过，不能当作已经删除；仅诊断引用时不要重放`confirmationId`。
- 完整回收本次平台打包镜像时显式设置 `deleteOwnedSnapshots: true`。仅 owner 或管理员可操作，且必须有新打包生成的持久化来源记录、云账号 UID、地域、owner、全部源磁盘、镜像绑定快照、唯一来源标签和台账证明；旧镜像、外部或共享快照拒绝自动回收。删除不用 Force，每个云资源确认消失后才释放对应台账；仅 `removed: true` 且 `status: deleted` 表示全部完成。
- 清理失败保留确切镜像/快照清单和已删除进度，使用相同 `snapshotId` 重试；不得改成其它镜像、强制删除或删掉审计材料。worker 也会继续恢复已开始的清理。
- `snapshotId` 使用目录来源行的 `id` 或资产的 `sourceSnapshotId`；完整回收结果中的 `snapshotIds` 和 `deletedSnapshotIds` 是真实阿里云 backing snapshot ID。若前一次已确认操作进入 `failed`，保持业务目标不变，用新的幂等键重新取得确认再重试；同一次二阶段确认必须复用相同幂等键。
- 打包返回 `packedImageArtifactId` 与初始 `imageReady: false`。用 `platform_image_list({ view: 'mine' })` 跟踪同一资产；仅 `sourceSnapshotAvailable: true` 且 `enabled: true` 可以创建实例。创建中、失败、云端消失或清理中的资产不可启用/重复收录；重复收录保留 owner、默认配置和现有启停状态。
- 目录同步查询全部云状态并完整校验分页。云端消失的来源会保留为不可用记录并停用关联资产；错误、业务失败或不完整响应保留原目录。
- 导入任务仅对 `failed` 状态使用 `image_import_job_retry`。`available` 后才可稳定使用。
- 本地 QCOW2、RAW、VHD 上传不由 MCP 提供：JSON 工具不能承载二进制，预签名上传地址也不能作为普通工具结果处理。通过平台上传后，用导入任务工具跟踪。

从运行实例生成镜像不属于本模块：独立实例使用 `single_instance_pack_image`，编排节点使用 `range_instance_node_pack_image`。

标签字典当前只有查询和创建，没有全局标签重命名或删除能力。资产标签关联采用完整集合替换：先用 `platform_image_tag_list` 取得已有定义ID，再传完整目标 `tagIds`；`[]` 仅清空该资产关联，标签定义继续保留。普通用户只可修改自己的当前账号/地域资产关联；公开可见的他人资产仍不可修改。全局创建与关联替换按MCP二阶段确认，执行时重新验证角色/owner和标签存在性；不修改阿里云资源标签。

受控测试复用正式字典已有标签并在结束时恢复原关联。新标签创建的成功、重复、并发唯一性测试放在Docker独立PG；当前平台仅验证已有名称重复拒绝，不创建无法通过现有接口删除的临时定义。
