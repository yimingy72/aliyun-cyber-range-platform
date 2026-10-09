# 基础配置

管理后续资源创建使用的默认地域、可用区和云账号配置，仅管理员可调用。

## MCP 工具与参数

| 操作 | MCP 工具 | 必填参数 | 可选参数 | Scope |
|---|---|---|---|---|
| 查询配置 | `cloud_config_get` | — | — | `settings:read` |
| 更新配置 | `cloud_config_update` | 至少一个 `defaultRegion`、`defaultZoneId`、`accessKeyId`、敏感 `accessKeySecret` | 操作元数据 | `settings:write` |
| 查询云账号 | `cloud_account_context_list` | — | `includeInactive` | `settings:read` |
| 验证并保存腾讯云账号 | `tencent_cloud_account_save` | `provider`（固定为 tencent_cloud）、`regionId`、`zoneId`、敏感 `accessKeyId`、敏感 `accessKeySecret` | 操作元数据 | `settings:write` |
| 查询腾讯云地域与可用区 | `tencent_cloud_region_list` | `regionIds`、敏感 `accessKeyId`、敏感 `accessKeySecret` | — | `settings:read` |
| 查询腾讯云镜像目录 | `tencent_cloud_image_list` | `cloudAccountContextId`、`scope` | `offset`、`limit` | `settings:read`、`images:read` |
| 查询账号可售机型 | `cloud_account_instance_type_availability` | `cloudAccountContextId`、`cpu`、`memory` | — | `settings:read` |

## 操作规则

1. 先调用 `cloud_config_get`；脱敏密钥只能说明已配置，不能回写或复用。
2. 仅传用户明确要求的字段，并在执行前确认影响范围。
   跨地域变更时同时提供属于新地域的 `defaultZoneId`；不会沿用旧地域可用区或猜测新默认值。
3. 更新后重新读取非敏感字段核对结果。不得在对话、日志或 Skill 文件中保存密钥。
4. 腾讯云账号仅验证并加密保存为未激活状态，当前可查询地域、镜像及机型，尚未开放实例创建、编排和账单同步。不得据查询成功声称已支持资源创建。
5. 腾讯云账号查询使用 `cloud_account_context_list({ includeInactive: true })`；核对 `provider=tencent_cloud`、账号 UID 和地域后再使用准确 ID。`cloud_config_get/update` 继续对应当前阿里云配置，腾讯云密钥不得传入这些工具。
6. 地域查询只接受明确指定的 1 至 3 个不同 `regionIds`；不会保存凭据或默认选择地域。镜像查询 `scope` 为 `public/custom`，`offset` 为 0 至 100000、`limit` 为 1 至 100；机型查询使用已保存账号可用区，`cpu` 为 1 至 1024、`memory` 为 1 至 4096。
7. 腾讯云账号保存具有操作确认与幂等参数，首次受理可能返回 `CONFIRMATION_REQUIRED`。保留原业务参数，用户确认后传服务端实际 `confirmationId` 与相同 `idempotencyKey`；脱敏密钥不能回写或复用。账号列表及保存结果只返回非敏感状态，禁止回显 SecretId/SecretKey。
