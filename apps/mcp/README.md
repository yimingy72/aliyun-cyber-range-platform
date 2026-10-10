# MCP Gateway

`apps/mcp` 为阿里云、腾讯云综合靶场平台提供 Streamable HTTP MCP。入站使用 OIDC access token，下游通过 Token Exchange 保持同一用户身份；不使用静态 Bearer 或共用平台 API token。

客户端接入与排错见 [MCP 客户端接入手册](../../docs/product/2026-07-15-MCP客户端接入示例.md)。产品操作和完整参数表维护在 [项目 Skill](../../skills/SKILL.md)；当前会话的 `tools/list` 与 schema 优先于静态文档。

## 服务端点

| 路径 | 方法 | 用途 |
|---|---|---|
| `/mcp` | `POST` | Streamable HTTP MCP 请求；必须带 OIDC Bearer。 |
| `/healthz` | `GET` | 无认证健康检查，返回 `{"ok":true}`。 |

本地 Compose 默认地址为 `http://localhost:8787/mcp`，Gateway 内部访问 `http://api:3001`。MCP 是协议接口，不接受平台浏览器 session token，也不提供绕过工具鉴权的业务 REST 入口。

## 认证、scope 与空间

1. Gateway 校验 issuer、签名、有效期与 `MCP_OIDC_AUDIENCE`。
2. 使用 confidential client 交换 `PLATFORM_API_AUDIENCE` token，绑定原 subject，不接受共用身份 fallback。
3. 每次请求重新验证平台用户状态/角色，并创建独立 API client/空间上下文，不共享用户 session token。工具 scope、平台角色/启用状态、资源 owner/visibility、云账号工作空间分别校验；scope 不授予管理员或平台超管身份。
4. `tools/list` 只反映当前权限下可调用的集合；调用时仍重新校验。工具 annotations 是客户端提示，不代替授权。

兼容只有身份 scope 的旧 OAuth token，业务权限仍受当前角色限制；token 一旦声明业务 scope，则只使用其与当前角色权限的交集，未知 scope 不授予权限，Token Exchange 不能扩权。

显式 `x-cloud-workspace-id` 优先于用户默认空间。`cloud_workspace_switch` 改变默认选择，不能覆盖固定请求头；切换后重新核对工具和数据空间。已受理任务冻结原厂商、主账号与地域，不随默认空间切换。不可访问 ID 不回落到其它账号。

工具响应为 `structuredContent: { result: ... }`。平台失败与 `CONFIRMATION_REQUIRED` 挑战使用 `{ result: { error: ... } }` 并设置 `isError: true`；检查错误码后再解释业务结果。确认摘要属于已有用户授权时，保持业务参数并回传服务端确认 ID/幂等键，无需额外重复人工确认。

## 运行配置

| 变量 | 说明 |
|---|---|
| `MCP_HOST` / `MCP_PORT` | 监听地址与端口；Compose 为 `0.0.0.0:8787`。 |
| `PLATFORM_API_BASE_URL` | 下游平台 API 地址。 |
| `OIDC_ISSUER` | token 中的公开 issuer。 |
| `OIDC_JWKS_URL` | Gateway 验签密钥地址，可为容器内部 Keycloak。 |
| `OIDC_TOKEN_ENDPOINT` | Token Exchange 地址，可为容器内部 Keycloak。 |
| `MCP_OIDC_CLIENT_ID` / `MCP_OIDC_CLIENT_SECRET` | Gateway confidential client 凭据，禁止写入日志或客户端配置。 |
| `MCP_OIDC_AUDIENCE` | 入站 MCP audience。 |
| `PLATFORM_API_AUDIENCE` | 下游 Token Exchange audience。 |
| `MCP_PUBLIC_URL` | 客户端公开 `/mcp` 地址，也是公开 Host/Origin 允许列表来源。 |
| `MCP_ALLOWED_HOSTS` | 额外允许的 `host:port`，逗号分隔、精确匹配。 |
| `MCP_ALLOWED_ORIGINS` | 额外允许的 `scheme://host:port`，逗号分隔、精确匹配。 |

默认允许精确本机 loopback 与已配置公开地址；容器内部服务名如 `mcp:8787` 须加入 `MCP_ALLOWED_HOSTS`。浏览器 Origin 和请求 Host 使用允许列表；不信任任意 `Forwarded`/`X-Forwarded-Host`，不配置通配 CORS。代理部署须显式配置实际公开地址及必要 Host/Origin，而非扩大到任意域名。废弃的 `MCP_STATIC_BEARER_TOKEN`、`MCP_STATIC_SCOPES`、`PLATFORM_API_TOKEN` 不能作为认证方案。

## 功能合同

- 运行拓扑先保存完整草稿，再预览准确版本，应用原版本和短期 preview token。worker 的实际 OpenTofu plan 继续保护既有主机；失败不自动创建替代实例。
- 另存草稿使用稳定幂等键，新建私有模板，原模板和云资源不变。
- DNS 是主机 `dns` 结构化配置；内部脚本与用户 `initScript` 分开。核验/重新下发工具不接受任意命令，失败不重建。
- 删除账号绑定只清除保存凭据、保留业务与账单历史；未回收资源或清理任务阻止删除。
- 账单只统计有平台创建来源证明的官方费用。`provisional`、待核对资源和延期日期不表示零费用；未实现的生命周期账单 UI 不属于当前工具能力。

## 容器化验证

从仓库根目录重建并启动相关服务：

```bash
COMPOSE_BAKE=false docker compose build mcp
docker compose up -d mcp
curl -fsS http://127.0.0.1:8787/healthz
```

协议 smoke 使用 OIDC 登录与交换后的当前用户身份，按 [客户端手册](../../docs/product/2026-07-15-MCP客户端接入示例.md) 在 Docker 中运行项目 SDK 脚本。不在本机起开发进程代替容器验证，不调用付费云操作作为普通网关回归。
