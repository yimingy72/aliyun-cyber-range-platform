# 镜像中心

管理平台镜像资产、云镜像目录和镜像导入任务。

## MCP 工具与参数

除非行内说明，写工具可按运行时 schema 接收 `idempotencyKey` 和 `confirmationId`。

| 操作 | MCP 工具 | 必填参数 | 可选参数 | Scope |
|---|---|---|---|---|
| 查询平台镜像 | `platform_image_list` | — | `view: platform\|mine`，默认 `platform` | `images:read` |
| 查询平台容器镜像 | `platform_container_image_list` | — | — | `images:read` |
| 预览墨攻容器收录 | `mogong_container_collect_preview` | — | — | `images:read`，仅管理员 |
| 批量收录墨攻容器 | `mogong_container_collect_all` | `catalogDigest` | 操作元数据 | `images:write`，仅管理员 |
| 查询标签字典 | `platform_image_tag_list` | — | — | `images:read`，已认证用户 |
| 创建标签定义 | `platform_image_tag_create` | `name`（1–32字符） | 操作元数据 | `images:write`，仅管理员 |
| 删除标签定义 | `platform_image_tag_delete` | `platformImageTagId` | 操作元数据 | `images:write`，仅管理员 |
| 替换资产标签关联 | `platform_image_tags_set` | `platformImageAssetId`、完整 `tagIds` | 操作元数据 | `images:write`，owner或管理员 |
| 收录云快照 | `platform_image_collect` | `snapshotId`、`displayName` | 操作元数据 | `images:write`，仅管理员 |
| 重命名 | `platform_image_rename` | `platformImageAssetId`、`displayName` | 操作元数据 | `images:write` |
| 启用 | `platform_image_enable` | `platformImageAssetId` | 操作元数据 | `images:write` |
| 停用 | `platform_image_disable` | `platformImageAssetId` | 操作元数据 | `images:write` |
| 平台发布 | `platform_image_publish` | `platformImageAssetId` | 操作元数据 | `images:write`，仅管理员 |
| 取消平台发布 | `platform_image_unpublish` | `platformImageAssetId` | 操作元数据 | `images:write`，仅管理员 |
| 删除平台镜像资产 | `platform_image_remove` | `platformImageAssetId` | 操作元数据 | `images:write` |
| 查询镜像目录 | `image_catalog_list` | `scope: public\|custom` | — | `images:read` |
| 查询腾讯云镜像目录 | `tencent_cloud_image_list` | `cloudAccountContextId`、`scope` | `offset`、`limit` | `settings:read`、`images:read`，仅管理员 |
| 同步镜像目录 | `image_catalog_sync` | `scope: public\|custom` | — | `images:read` |
| 删除自定义云镜像 | `image_catalog_custom_delete` | `snapshotId` | `deleteOwnedSnapshots`（默认 `false`）、操作元数据 | `images:write` |
| 查询导入任务 | `image_import_job_list` | — | — | `images:read` |
| 重试导入任务 | `image_import_job_retry` | `imageImportJobId` | 不接受操作元数据 | `images:write` |

## 意图与规则

- “可用镜像、我的镜像、选镜像”使用 `platform_image_list`。默认 `view: platform` 只包含平台可见资产，使用自有私有镜像时显式 `view: mine`；两个视图按资产 ID 去重，名称重复时不能猜选。独立实例使用资产 `id`（`platformImageAssetId`）；模板转换必须同时写入资产 `id`（`platformImageAssetId`）和其云镜像 `imageId`。
- 容器镜像单独使用 `platform_container_image_list`，不属于 ECS 镜像，当前不能创建容器实例。批量收录先运行 `mogong_container_collect_preview`，再用其 `digest` 调用 `mogong_container_collect_all`，确认摘要与用户授权一致后完成服务端确认；同一请求保持幂等键。该操作只保存来源仓库引用，不复制镜像或创建云资源；停用、废弃和未成功的来源不会收录。引用待核验的资产不得用于未来实例创建，仓库镜像被删除后引用也可能失效。
- 业务镜像名必须精确匹配一个当前可见、已启用的资产。无匹配、重名或停用时停止；转换后将资产的 `displayName` 写入 ECS `image`/`imageName`，将资产 `id` 写入 `platformImageAssetId`，将云镜像 ID 写入 `imageId` 与 `imageStrategy.imageId`。
- “收录快照”先用 `image_catalog_list({ scope: 'custom' })` 或 `image_catalog_sync` 确认 `snapshotId`，由管理员再经确认调用 `platform_image_collect`。
- 收录只建立平台目录，不代表该云镜像或快照由平台创建，不写入平台创建标签、不接管其费用。平台打包/导入已有的费用账本保留原来源、owner 和回收时间，重新收录只更新目录关联。
- `enable`/`disable` 控制能否用于后续创建；`publish`/`unpublish` 控制其他用户能否看见。两者不可混用，且都不销毁已有资源。
- 收录、发布和取消发布仅管理员可执行。发布或取消发布前，必须检查资产返回的 `canChangeVisibility`。只有 owner-backed 资产可切换可见性；从公共或自定义云镜像目录收录的资产可能已固定为 `platform` 且 `canChangeVisibility: false`，此时不得调用发布/取消发布工具或重试，应如实说明平台限制。
- `platform_image_remove` 仅移出平台目录，保留云镜像、快照和仍计费的台账；删除前确认未被已发布拓扑引用。
- `image_catalog_custom_delete` 默认只允许管理员删除云镜像及关联平台资产，保留 backing snapshots 和快照费用。MCP 使用二阶段确认及相同的业务参数、操作元数据。
- 云镜像删除保护当前模板草稿、当前仍公开的发布版本及未销毁实例的运行/草稿引用；仅历史版本引用不阻止删除。没有活动实例也可能存在有效模板引用，此时应在模板中替换镜像并检测保存；公开发布版本仍引用时，还需重新发布或回退为私有。仅删除平台目录的保护仍针对已发布拓扑。
- MCP删除预确认也检查有效引用，阻塞时管理员会收到`references`（kind/id/name/ownerId/basis）以定位准确模板或实例；不包含凭据，也不访问云端。首次请求若返回确认要求只表示预检通过，不能当作已经删除；仅诊断引用时不要重放`confirmationId`。
- 完整回收本次平台打包镜像时显式设置 `deleteOwnedSnapshots: true`。仅 owner 或管理员可操作，且必须有新打包生成的持久化来源记录、云账号 UID、地域、owner、全部源磁盘、镜像绑定快照、唯一来源标签和台账证明；旧镜像、外部或共享快照拒绝自动回收。删除不用 Force，每个云资源确认消失后才释放对应台账；仅 `removed: true` 且 `status: deleted` 表示全部完成。
- 镜像中心的云上自定义镜像删除弹窗默认“仅删除镜像”；有完整平台打包来源记录时可明确选择“同时清理所属快照”。仅删除云镜像后仍有所属快照的记录保留为“快照待回收”，可继续使用相同目标回收。列表资格提示不替代服务端实时所有权、引用和删除确认检查。
- 清理失败保留确切镜像/快照清单和已删除进度，使用相同 `snapshotId` 重试；不得改成其它镜像、强制删除或删掉审计材料。worker 也会继续恢复已开始的清理。
- `snapshotId` 使用目录来源行的 `id` 或资产的 `sourceSnapshotId`；完整回收结果中的 `snapshotIds` 和 `deletedSnapshotIds` 是对应厂商的真实 backing snapshot ID。若前一次已确认操作进入 `failed`，保持业务目标不变，用新的幂等键重新取得确认再重试；同一次二阶段确认必须复用相同幂等键。
- 打包返回 `packedImageArtifactId` 与初始 `imageReady: false`。用 `platform_image_list({ view: 'mine' })` 跟踪同一资产；仅 `sourceSnapshotAvailable: true` 且 `enabled: true` 可以创建实例。创建中、失败、云端消失或清理中的资产不可启用/重复收录；重复收录保留 owner、默认配置和现有启停状态。
- 目录同步查询全部云状态并完整校验分页。云端消失的来源会保留为不可用记录并停用关联资产；错误、业务失败或不完整响应保留原目录。
- 导入任务仅对 `failed` 状态使用 `image_import_job_retry`。云端明确拒绝且未返回 ImageId 时可显式重试；超时/断连等未知提交只按原任务唯一标记恢复，不能当成未创建，也不会自动重新提交。`available` 后才可稳定使用。
- 导入冻结云账号、地域和上传 Bucket，失败清理先核验本任务镜像与完整快照清单，非强制删除镜像后逐个删除无其它引用的自有快照，并确认消失后释放各自费用台账。失败、未知或旧记录缺少证明时保留恢复材料和费用台账，不报告全部回收。
- 平台“打包镜像”调用 CreateImage，会为实例磁盘生成依赖快照；目前平台未实现 ExportImage。保留云镜像用于后续启动时必须保留依赖快照并计费。若另外在阿里云导出到 OSS，导出文件还涉及 OSS 存储、请求与下载流量费用；导出完成不代表原镜像/快照或 OSS 文件已删除。
- 本地 QCOW2、RAW、VHD（腾讯云另支持 VMDK）上传不由 MCP 提供：JSON 工具不能承载二进制，预签名上传地址也不能作为普通工具结果处理。通过平台上传后，用导入任务工具跟踪。

从运行实例生成镜像不属于本模块：独立实例使用 `single_instance_pack_image`，编排节点使用 `range_instance_node_pack_image`。

腾讯云导入必须显式选择官方支持的操作系统平台与版本，由平台创建私有专属 COS Bucket 并保留完整来源证明。当前单次上传最多 5 GiB，且不超过平台配置的上传上限；平台 COS 下载授权最多 24 小时，超出这些边界会在创建 Bucket 或上传任务前拒绝，不会默默切换到阿里云上传。未知导入或 Bucket 创建结果只恢复原请求，不重复创建；临时对象确认消失、上传授权过期且 Bucket 无活动任务、对象、版本或分片后才能回收桶。当前单实例创建仅支持可用的 x86_64 系统盘镜像，并实时核对镜像最小系统盘容量；带数据盘镜像拒绝创建，不能依赖目录缓存绕过核验。

腾讯云新打包在 CreateImage 前保存全部源盘的完整快照基线和官方 RequestId，基线绑定原空间、UID、配置、地域及 owner，创建后不可补写或替换。只接管不在该基线中的私有、非复制、无共享快照，且必须精确对应源盘并仅绑定原带原子来源标签的平台镜像。厂商未注明时区的 CreateTime 保留原文，不靠猜测 UTC 或 UTC+8 判断新旧。旧或未知打包没有基线时继续隔离核验，不能补基线后重建或将外部快照归属平台。

标签定义属于当前云账号工作空间，支持查询、管理员创建与删除，暂不支持重命名。`platform_image_tag_delete` 删除准确 ID 的定义及当前空间全部镜像的该标签关联，保留镜像、快照和云资源；不影响其他空间同名标签。调用前确认这个完整范围并完成 MCP 二阶段确认，相同确认与幂等键可恢复原结果。

资产标签关联采用完整集合替换：先用 `platform_image_tag_list` 取得已有定义 ID，再传完整目标 `tagIds`；`[]` 仅清空该资产关联，标签定义继续保留。普通用户只可修改自己的当前账号/地域资产关联，不能创建或删除标签定义。公开可见的他人资产仍不可修改。创建、删除与关联替换执行时重新验证角色/owner 和标签存在性；不修改云厂商资源标签。若并发删除导致标签不存在，刷新标签字典再提交，不重复创建同名定义。

受控测试复用正式字典已有标签并在结束时恢复原关联。标签定义创建、删除、关联回收、并发和跨空间隔离测试优先放在 Docker 独立 PostgreSQL；不删除未经用户指定的业务标签。
