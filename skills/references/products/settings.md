# 基础配置

绑定云厂商主账号并显式切换对应的平台数据；各工作空间独立保存镜像、靶场、实例、用户和账单。绑定或编辑云账号仅平台超管可执行。

## MCP 工具与参数

| 操作 | MCP 工具 | 必填参数 | 可选参数 | Scope |
|---|---|---|---|---|
| 查询可选工作空间 | `cloud_workspace_list` | — | — | `settings:read` |
| 显式切换默认工作空间 | `cloud_workspace_switch` | `cloudWorkspaceId` | — | `settings:write` |
| 绑定或更新厂商账号 | `cloud_account_bind` | `provider`、`regionId`、`zoneId`、敏感 `accessKeyId`、敏感 `accessKeySecret` | `cloudWorkspaceId`、`displayName`、`imageImportBucket`、操作元数据 | `settings:write`，仅平台超管 |
| 删除云账号绑定 | `cloud_account_remove` | `cloudWorkspaceId` | 操作元数据 | `settings:write`，仅平台超管 |
| 查询配置 | `cloud_config_get` | — | — | `settings:read` |
| 更新配置 | `cloud_config_update` | 至少一个 `defaultRegion`、`defaultZoneId`、`imageImportBucket`、`accessKeyId`、敏感 `accessKeySecret` | 操作元数据 | `settings:write`，仅平台超管 |
| 查询云账号 | `cloud_account_context_list` | — | `includeInactive` | `settings:read`，仅管理员 |
| 验证并保存腾讯云账号 | `tencent_cloud_account_save` | `provider`（固定为 tencent_cloud）、`regionId`、`zoneId`、敏感 `accessKeyId`、敏感 `accessKeySecret` | 操作元数据 | `settings:write`，仅平台超管 |
| 查询腾讯云地域与可用区 | `tencent_cloud_region_list` | `regionIds`、敏感 `accessKeyId`、敏感 `accessKeySecret` | — | `settings:read`，仅管理员 |
| 查询账号可售机型 | `cloud_account_instance_type_availability` | `cloudAccountContextId`、`cpu`、`memory` | — | `settings:read`，仅管理员 |

## 操作规则

1. 先调用 `cloud_workspace_list`，核对用户指定的厂商、主账号 UID 和空间 ID。普通用户只可访问其绑定空间，不能凭管理员角色推断平台超管身份。切换回来只恢复对应数据，不创建或销毁云资源。
   显式 `x-cloud-workspace-id` 请求头优先于用户默认空间；`cloud_workspace_switch` 修改用户默认选择，不覆盖已固定请求头的连接。切换后核对返回空间，后续请求保持同一空间；需要修改固定连接时重新指定其请求头。错误或不可访问 ID 必须停止，不回落到其它账号。
   `cloud_config_get` 返回当前空间的地域与凭据配置状态；脱敏密钥只能说明已配置，不能回写或复用。
2. 仅传用户明确要求的字段，并在执行前确认影响范围。
   阿里云 `imageImportBucket` 可单独配置，不需要回传已保存凭据；普通导入桶配置不声明专用计费。费用归属须按账单参考调用 `billing_oss_bucket_bind` 明确专用用途、生效时间并核验官方身份。
   跨地域变更时同时提供属于新地域的 `defaultZoneId`；不会沿用旧地域可用区或猜测新默认值。
3. 更新后重新读取非敏感字段核对结果。不得在对话、日志或 Skill 文件中保存密钥。
4. `cloud_account_bind` 支持阿里云与腾讯云，身份校验后加密保存凭据，保存不会切换当前数据空间。编辑必须传准确目标 `cloudWorkspaceId`，凭据的主账号 UID 和厂商必须匹配该空间。两个凭据字段必须重新显式填写；不传脱敏值。`displayName` 最多 80 字符，`imageImportBucket` 最多 63 字符。
   腾讯云已接入镜像目录、OpenTofu 单实例批次、模板编排、镜像生命周期与官方账单同步。真实编排开通受 `capabilities.rangeProvisioning` 控制；以当前工作空间 `capabilities` 为准，不能按账号全局 `isActive` 或查询成功判断资源创建能力。只读历史空间不可写业务资源。
5. 腾讯云账号查询使用 `cloud_account_context_list({ includeInactive: true })`；核对 `provider=tencent_cloud`、账号 UID、工作空间与地域后使用准确 ID。镜像查询属于镜像中心，配置页面只处理账号与默认地域。`cloud_config_get` 可显示当前厂商；兼容的 `cloud_config_update` 仅维护阿里云当前空间，腾讯云凭据必须使用 `cloud_account_bind` 或兼容的 `tencent_cloud_account_save`。
6. 地域查询只接受明确指定的 1 至 3 个不同 `regionIds`；不会保存凭据或默认选择地域。腾讯云镜像目录查询属于镜像中心，参数见该参考；机型查询使用已保存账号可用区，`cpu` 为 1 至 1024、`memory` 为 1 至 4096。
7. 腾讯云账号保存具有操作确认与幂等参数，首次受理可能返回 `CONFIRMATION_REQUIRED`。保留原业务参数，核对摘要属于已有授权后传服务端实际 `confirmationId` 与相同 `idempotencyKey`；脱敏密钥不能回写或复用。账号列表及保存结果只返回非敏感状态，禁止回显 SecretId/SecretKey。
8. 删除账号仅清除平台保存的凭据与绑定，不调用云端删除，也不删除镜像、用户、靶场、实例、账单或审计历史。当前账号必须先切换到其他账号或历史空间；历史空间本身不能删除。有未回收资源、未释放台账、失败实例或待清理的导入、打包、托管网络和 COS 桶时拒绝删除。删除须核对准确空间 ID 并取得授权，MCP 使用二阶段确认。删除会停止该账号后续账单同步；未出账费用须重新绑定后同步。重新绑定同厂商同主账号恢复原数据空间与台账归属。
   `legacy-unbound`（旧名称“历史未绑定来源”，基础配置中单独显示为“历史数据”）是系统保留的只读分区，用于存放旧版本中无法确认云账号归属的记录，并提供无绑定账号时的历史查看入口。它没有云账号 UID 或可用凭据，不是失效的账号绑定；不要尝试删除或猜测归属后迁移其中数据。“查看历史”仅切换数据视图，不启动云资源。
