# OIDC MCP 授权架构设计

**状态：已确认**  
**日期：2026-07-15**

## 目标

将平台从自研会话认证迁移到 Keycloak OIDC，并使 Codex、Claude Code 等 MCP 客户端通过浏览器 OAuth 登录后，以真实平台用户身份操作资源。

第一期只支持有用户参与的交互式 Agent；不实现无人值守 service account。

## 范围与非目标

- 开发环境在 Docker Compose 中运行 Keycloak；生产通过环境变量对接外部 Keycloak。
- Keycloak 成为唯一的用户身份和密码系统。
- 平台保留用户资料、角色、资源归属和业务授权规则。
- 不保留旧 `/admin/session` 认证作为长期兼容路径。
- 不实现邮件找回密码、PAT、静态 MCP Bearer token 或自动化机器人账号。

## 身份模型

Keycloak 的 subject 与平台用户建立唯一映射：

```
issuer + subject -> PlatformUser.id
```

`PlatformUser.id` 继续作为模板、镜像、综合靶场、单实例、批次和任务的 owner 标识。平台不依赖用户名进行身份关联。

平台管理员仍从平台用户管理页管理用户生命周期，API 同步调用 Keycloak Admin API：

- 创建用户：创建 Keycloak 用户、设置管理员提供的一次性临时密码、要求首次登录修改密码。
- 修改角色：平台用户角色是授权来源，并同步 Keycloak realm/client role 作为身份侧镜像。
- 禁用用户：禁用 Keycloak 用户并使其平台访问立即失效。
- 重置密码：设置新的临时密码并再次要求修改。

现有用户迁移时创建对应 Keycloak 账号并设置临时密码。旧 scrypt 密码哈希不可迁移；迁移完成后删除平台密码校验和旧会话端点。

## OAuth 与令牌边界

Keycloak realm 为 `cyber-range`，使用以下逻辑客户端：

- `platform-web`：浏览器 Web 登录，Authorization Code + PKCE。
- `mcp-resource`：MCP OAuth Protected Resource 的 audience `mcp`。
- `mcp-gateway`：confidential client，仅用于 token exchange。
- `platform-api`：API resource audience `platform-api`。

MCP 对外提供 Streamable HTTP endpoint 和 OAuth Protected Resource Metadata。Keycloak 启用受限的 RFC 7591 动态客户端注册策略，只允许 Authorization Code + PKCE、公网 HTTPS redirect URI 和受控 client metadata，使 Codex / Claude Code 能以标准 MCP OAuth 流程打开浏览器登录。

令牌流：

1. MCP 客户端发现 MCP resource metadata 并跳转 Keycloak。
2. Keycloak 签发短期 access token，要求 `iss` 为配置 issuer、`aud=mcp`，并带用户 subject、角色和客户端标识。
3. MCP 通过 Keycloak JWKS 校验签名、issuer、audience、expiry、subject 和客户端标识。
4. MCP 使用 `mcp-gateway` 以 RFC 8693 token exchange 获取 `aud=platform-api` 的下游 token。
5. 下游 token 保留原用户 subject，并包含调用链客户端标识。
6. MCP 使用该 token 调用平台 API；平台 API 不接受 MCP token，也不接受共享管理员凭据。

MCP 不保存用户密码或 refresh token。用户 OAuth refresh token 仅由 MCP client 和 Keycloak 管理。

## API 授权

API 的新 JWT guard 只接受 `aud=platform-api` 的 Keycloak JWT，并通过 `issuer + subject` 映射出 `PlatformUser`。

平台 API 是唯一资源授权点：

- `admin` 可以跨用户访问资源。
- `user` 只能访问本人资源、已发布的平台模板和平台镜像。
- 所有写操作在 API 内再次执行资源归属校验；MCP scope 不能绕过此检查。

平台数据库中的 `PlatformUser.role` 是角色授权的最终来源，Keycloak role 仅为同步镜像；平台数据库中的 owner 关系用于细粒度授权。MCP 可以按 scope 隐藏不适用工具，但 API 校验是最终决定。

## MCP 行为

移除生产 MCP 的以下配置与代码路径：

- `PLATFORM_API_USERNAME`
- `PLATFORM_API_PASSWORD`
- `PLATFORM_API_TOKEN`
- `MCP_STATIC_BEARER_TOKEN`
- 自研 session token 校验和直连 Prisma 用户查询

每个 MCP 请求使用入站 token 关联的用户完成 token exchange。可以按入站 token 的到期时间做内存级下游 token 缓存；缓存失效后重新 exchange，不持久化。

工具输入使用精确 Zod schema。普通列表、详情与创建响应不返回 `runtimeCredentials`、默认密码或 VNC URL；敏感信息只由独立 access/VNC 工具返回，并受对应 scope 与资源归属校验。

## 写操作、审计与敏感数据

创建、销毁、重启和打包镜像由平台 API 实现确认挑战和持久化幂等键。首次调用返回短期确认挑战；确认后由同一用户、同一请求摘要和幂等键执行。

获取账号密码和 VNC 不需要二次确认。

API 统一记录审计事件：

- actor platform user id
- source (`web`、`mcp`、`system`)
- OAuth client / authorized party
- 工具或业务操作、资源类型和资源 id
- 结果、错误摘要、关联 id、幂等键和时间

审计不得记录密码、runtime credentials、VNC URL、access token、refresh token 或原始敏感请求/响应体。

API 从经过验证的 token 的 authorized party / actor chain 推导 `source=mcp`，不得信任可由外部调用方伪造的 HTTP header。

## 部署与迁移

开发 Compose 新增 Keycloak 与独立 Keycloak PostgreSQL 数据库。生产不启动本地 Keycloak，改为配置：

- `OIDC_ISSUER`
- `OIDC_JWKS_URL`
- `OIDC_TOKEN_ENDPOINT`
- `KEYCLOAK_ADMIN_BASE_URL`
- `KEYCLOAK_ADMIN_CLIENT_ID`
- `KEYCLOAK_ADMIN_CLIENT_SECRET`
- `MCP_PUBLIC_URL`

切换采用一次发布窗口：部署 Keycloak 配置和用户迁移、更新 Web/API/MCP 到 OIDC、验证首个管理员登录，然后下线旧 session 路径与共享 MCP 管理员凭据。

## 实施顺序

1. Keycloak Compose、realm、client、环境配置和平台用户身份映射。
2. Keycloak Admin API 用户生命周期同步与现有用户迁移命令。
3. API JWT guard、principal abstraction、资源授权与统一审计。
4. Web OIDC 登录和旧 session 删除。
5. MCP OAuth metadata、JWT 校验、token exchange、工具 schema 与敏感 DTO 收敛。
6. 客户端接入文档与旧认证配置清理。

## 验证策略

只执行关键容器验证：Keycloak 启动、管理员和普通用户登录、普通用户本人资源允许/他人资源拒绝、MCP OAuth 只读调用、一次确认式写调用和审计脱敏检查。不扩展与该迁移无关的大规模测试套件。
