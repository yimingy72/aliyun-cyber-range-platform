# 基础配置

管理后续资源创建使用的默认地域、可用区和云账号配置，仅管理员可调用。

## MCP 工具与参数

| 操作 | MCP 工具 | 必填参数 | 可选参数 | Scope |
|---|---|---|---|---|
| 查询配置 | `cloud_config_get` | — | — | `settings:read` |
| 更新配置 | `cloud_config_update` | 至少一个 `defaultRegion`、`defaultZoneId`、`accessKeyId`、敏感 `accessKeySecret` | 操作元数据 | `settings:write` |

## 操作规则

1. 先调用 `cloud_config_get`；脱敏密钥只能说明已配置，不能回写或复用。
2. 仅传用户明确要求的字段，并在执行前确认影响范围。
   跨地域变更时同时提供属于新地域的 `defaultZoneId`；不会沿用旧地域可用区或猜测新默认值。
3. 更新后重新读取非敏感字段核对结果。不得在对话、日志或 Skill 文件中保存密钥。
