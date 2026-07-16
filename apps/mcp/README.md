# MCP Gateway

接入示例见：`/Users/yym/Documents/阿里云For综合靶场竞赛平台/docs/product/2026-07-15-MCP客户端接入示例.md:1`

完整的以下内容都统一维护在上面的产品文档里：

- MCP 客户端配置示例
- Codex / Claude Code 提示词
- 当前全部 MCP tool list
- 每个工具的用途说明
- 当前权限模型与黑盒验证结论
- 审计与日志说明

如果只想快速了解当前开放工具，列表如下：

- `range_template_list`
- `range_template_get`
- `platform_image_list`
- `range_instance_list`
- `range_instance_get`
- `range_instance_get_access`
- `range_instance_launch`
- `range_instance_destroy`
- `single_instance_list`
- `single_instance_get`
- `single_instance_get_access`
- `single_instance_batch_launch`
- `single_instance_destroy`
- `single_instance_batch_destroy`
- `single_instance_retry`
- `single_instance_reboot`
- `single_instance_open_vnc`
- `single_instance_pack_image`
- `provision_job_get`

## Required env

- `PLATFORM_API_BASE_URL`: platform admin API base URL, for example `http://127.0.0.1:3001`
- `OIDC_ISSUER`: issuer for inbound human OIDC access tokens
- `OIDC_JWKS_URL`: JWKS URL for inbound token signature verification
- `OIDC_TOKEN_ENDPOINT`: token endpoint used for RFC 8693 token exchange
- `MCP_OIDC_CLIENT_ID`: confidential MCP gateway client, defaults to `mcp-gateway`
- `MCP_OIDC_CLIENT_SECRET`: secret for the MCP gateway client
- `MCP_OIDC_AUDIENCE`: expected audience on inbound access token, defaults to the gateway client id
- `PLATFORM_API_AUDIENCE`: requested downstream audience, defaults to `platform-api`
- `PLATFORM_API_TOKEN`: optional static fallback token used only for local stub / transition smoke
- `MCP_HOST`: optional, defaults to `127.0.0.1`
- `MCP_PORT`: optional, defaults to `8787`

## Run

```bash
pnpm --filter @aliyun-cyber-range/mcp dev
```

## Docker

```bash
docker build -f apps/mcp/Dockerfile -t aliyun-cyber-range-mcp:test .
docker run --rm -p 8787:8787 \
  -e PLATFORM_API_BASE_URL=http://host.docker.internal:3001 \
  -e PLATFORM_API_TOKEN=... \
  aliyun-cyber-range-mcp:test
```

Server endpoints:

- `POST /mcp`
- `GET /healthz`

Inbound authentication now accepts human OIDC access tokens for the MCP audience, then exchanges them into a downstream `platform-api` token.
Static bearer remains only for local stub smoke; legacy platform session-token auth is no longer accepted by MCP.

## Smoke

This logs into the platform, starts a local MCP server, then runs `tools/list` and `range_template_list` through the official MCP client.

```bash
PLATFORM_API_BASE_URL=http://127.0.0.1:3001 \
ADMIN_USERNAME=admin \
ADMIN_PASSWORD=change-me \
pnpm --filter @aliyun-cyber-range/mcp smoke
```

Optional overrides:

- `MCP_SMOKE_USERNAME`
- `MCP_SMOKE_PASSWORD`

By default `scripts/dev/smoke-mcp-compose.sh` uses the `mcp-smoke-sa` Keycloak service-account
client and bootstraps its OIDC subject into the platform database for client-credentials smoke.

For an already-running MCP server:

```bash
MCP_URL=http://127.0.0.1:8787/mcp \
MCP_BEARER_TOKEN=... \
pnpm --filter @aliyun-cyber-range/mcp smoke:http
```

## Optional static auth for local smoke

When you need to test MCP against a stub API, you can enable a fixed inbound token:

- `MCP_STATIC_BEARER_TOKEN`
- `MCP_STATIC_SCOPES` (comma-separated, optional)
