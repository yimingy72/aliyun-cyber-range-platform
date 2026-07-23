# 用户管理

仅管理员可管理平台用户；实际权限由用户明确授权、scope 和服务端 admin 校验共同决定。

## MCP 工具与参数

| 操作 | MCP 工具 | 必填参数 | 可选参数 | Scope |
|---|---|---|---|---|
| 查询用户 | `admin_user_list` | — | — | `users:read` |
| 创建用户 | `admin_user_create` | `username`、敏感 `password`、`role: admin\|user` | 操作元数据 | `users:write` |
| 修改角色 | `admin_user_update_role` | `userId`、`role: admin\|user` | 操作元数据 | `users:write` |
| 启用/禁用 | `admin_user_update_status` | `userId`、`status: active\|disabled` | 操作元数据 | `users:write` |
| 重置密码 | `admin_user_reset_password` | `userId`、敏感 `password` | 操作元数据 | `users:write` |

## 操作规则

- 先用 `admin_user_list` 取得准确 `userId`；用户名不能代替 ID。
- 创建、角色调整、账号状态变更和密码重置均需确认目标与权限影响。
- 只传用户明确要求变更的字段。密码只作为敏感输入处理，不在摘要中复述。
