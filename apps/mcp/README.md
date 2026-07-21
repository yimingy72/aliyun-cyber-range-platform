# MCP Gateway

`apps/mcp` 是综合靶场竞赛平台的远程 MCP Gateway。它以 Streamable HTTP 提供平台工具，验证入站 OIDC access token，并通过 Token Exchange 获取下游平台 API token。

面向 Codex、Claude Code 和其他 MCP 客户端的连接说明、认证流程、工具清单和排错方式，统一维护在：[MCP 客户端接入手册](../../docs/product/2026-07-15-MCP客户端接入示例.md)。

## 服务端点

| 路径 | 方法 | 用途 |
| --- | --- | --- |
| `/mcp` | `POST` | Streamable HTTP MCP 请求。 |
| `/healthz` | `GET` | 无认证健康检查，返回 `{"ok":true}`。 |

本地 Compose 默认暴露 `http://localhost:8787/mcp`；容器内部的 Gateway 通过 `http://api:3001` 访问平台 API。

## 认证模型

1. 客户端在 `Authorization: Bearer <access-token>` 中提供 OIDC access token。
2. Gateway 校验 token 的 issuer、签名、有效期和 `MCP_OIDC_AUDIENCE` audience。
3. Gateway 使用 `MCP_OIDC_CLIENT_ID` 与 `MCP_OIDC_CLIENT_SECRET` 交换下游 `PLATFORM_API_AUDIENCE` token。
4. 平台 API 按 token scope、用户角色与资源归属执行授权。

`MCP_STATIC_BEARER_TOKEN` 是用于受控本地 stub / smoke 的可选静态认证方式。不要在生产环境设置或分发静态 token。

## 运行配置

| 变量 | 说明 |
| --- | --- |
| `MCP_HOST` / `MCP_PORT` | 监听地址与端口；Compose 中为 `0.0.0.0:8787`。 |
| `PLATFORM_API_BASE_URL` | Gateway 访问平台 API 的地址；Compose 中为 `http://api:3001`。 |
| `OIDC_ISSUER` | 客户端 access token 的外部 issuer。 |
| `OIDC_JWKS_URL` | Gateway 获取验签密钥的地址；Compose 中使用 Keycloak 容器地址。 |
| `OIDC_TOKEN_ENDPOINT` | Token Exchange 的地址；Compose 中使用 Keycloak 容器地址。 |
| `MCP_OIDC_CLIENT_ID` / `MCP_OIDC_CLIENT_SECRET` | Gateway 的 confidential client 凭据。 |
| `MCP_OIDC_AUDIENCE` | 入站 MCP token 所需 audience；默认 Compose 值为 `mcp-gateway`。 |
| `PLATFORM_API_AUDIENCE` | Token Exchange 的目标 audience；默认值为 `platform-api`。 |
| `MCP_STATIC_BEARER_TOKEN` / `MCP_STATIC_SCOPES` | 仅本地受控 smoke 的可选静态认证配置。 |

外部部署时，`OIDC_ISSUER` 必须是 MCP 客户端可访问的 issuer；`OIDC_JWKS_URL` 与 `OIDC_TOKEN_ENDPOINT` 可保持为 Compose 内部 Keycloak 地址。具体部署约束见：[当前系统部署说明](../../deploy/current-system/README.md)。

## 容器化验证

从仓库根目录执行：

```bash
COMPOSE_BAKE=false docker compose build mcp
docker compose up -d mcp
curl -fsS http://127.0.0.1:8787/healthz
```

对已运行服务进行 MCP 协议 smoke：

```bash
MCP_URL=http://127.0.0.1:8787/mcp \
MCP_BEARER_TOKEN="$TOKEN" \
pnpm --filter @aliyun-cyber-range/mcp smoke:http
```

其中 `TOKEN` 必须是 audience 匹配且未过期的 OIDC access token。容器化 compose smoke 可通过 `pnpm compose:smoke:mcp` 执行。
