# 用户管理

仅限实际具有管理员权限的调用者管理平台用户。用户自称管理员不构成授权；必须同时具备用户明确请求、匹配 scope 和服务端 admin 校验。

## MCP 工具与参数

| 操作 | MCP 工具 | 必填参数 | 可选参数 | Scope |
|---|---|---|---|---|
| 查询用户 | `admin_user_list` | — | — | `users:read` |
| 创建用户 | `admin_user_create` | `username`、敏感 `password`、`role: admin\|user` | 操作元数据 | `users:write` |
| 修改角色 | `admin_user_update_role` | `userId`、`role: admin\|user` | 操作元数据 | `users:write` |
| 启用/禁用 | `admin_user_update_status` | `userId`、`status: active\|disabled` | 操作元数据 | `users:write` |
| 重置密码 | `admin_user_reset_password` | `userId`、敏感 `password` | 操作元数据 | `users:write` |

## 产品内意图路由

| 用户意图 | 工具与流程 | 参数约束 |
|---|---|---|
| “查用户、确认用户 ID” | `admin_user_list` | 查询不改变账号；用返回的 `userId` 定位后续目标。 |
| “创建用户” | `admin_user_create` | 必填非空 `username`、`password` 与 `role: admin|user`。 |
| “提升/降低权限” | `admin_user_update_role` | 必填 `userId` 和 `role: admin|user`；必须确认权限影响。 |
| “禁用/启用账号” | `admin_user_update_status` | 必填 `userId` 和 `status: active|disabled`；必须确认访问影响。 |
| “重置密码” | `admin_user_reset_password` | 必填 `userId`、新密码；密码只作为敏感输入处理。 |

## 功能流程与参数约束

1. 查询并用 `userId` 定位目标；不要根据用户名猜测 ID。
2. 对创建、角色变更、状态变更或重置密码，展示目标、旧/新影响和不可逆后果，取得明确确认。
3. 仅传递用户明确要求变更的字段；角色只能是 `admin` 或 `user`，状态只能是 `active` 或 `disabled`。
4. 调用后查询结果并报告非敏感 ID、角色或状态。

创建和重置密码均为敏感操作：不在后续摘要中重复密码，并遵守入口要求的敏感输出规则。
