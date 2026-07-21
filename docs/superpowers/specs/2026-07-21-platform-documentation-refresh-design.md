# 平台说明与 MCP 连接文档更新设计

**日期：** 2026-07-21
**状态：** 已确认，待实施

## 目标

将仓库文档整理为一个清晰的平台入口和一个唯一的 MCP 对外接入手册，使部署运维者与 MCP 客户端使用者无需阅读源码即可完成本地启动、健康检查和安全连接。

## 文档结构

| 文档 | 定位 | 维护边界 |
| --- | --- | --- |
| `README.md` | 平台说明首页 | 平台能力、架构、快速启动、安全边界和文档导航；不复制完整 MCP 配置或工具列表。 |
| `docs/product/2026-07-15-MCP客户端接入示例.md` | MCP 连接唯一详细手册 | 端点、认证、客户端配置、连通性验证、权限模型和操作安全说明。 |
| `apps/mcp/README.md` | MCP 服务开发说明 | 运行变量、容器端点、开发与 smoke 命令；链接到详细接入手册。 |
| `deploy/current-system/README.md` | 部署交接说明 | 部署后的 MCP 地址、外部 OIDC issuer 与容器内 JWKS / token exchange 地址区分。 |

## README 重写内容

根 README 将按以下顺序介绍当前平台：

1. 平台定位：面向综合靶场编排、实例生命周期和费用可见性的管理平台。
2. 核心能力：靶场编排、靶场实例、单实例、镜像中心、账单费用、用户与基础配置。
3. 系统架构：Web、API、provisioner worker、PostgreSQL、Keycloak、MCP Gateway、OpenTofu 的职责和数据流。
4. 快速启动：环境变量、provider mirror、`pnpm compose:up`、后台地址与健康检查。
5. 安全与资源边界：`opentofu` 会创建计费资源，流程演练使用 `dry-run`；不提交密钥；MCP 写操作受权限与确认约束。
6. 文档导航：部署、MCP 连接、设计与计划文档的入口。

## MCP 连接手册

接入手册以可执行的“快速连接”开头，并提供详细章节：

- MCP 服务使用 Streamable HTTP：`POST /mcp`；健康检查：`GET /healthz`。
- 本地默认地址为 `http://127.0.0.1:8787`；远程部署必须改为客户端可访问的 HTTPS 地址。
- 正式入站认证为 OIDC Bearer access token，MCP Gateway 验证其 issuer、签名、有效期和 audience，并交换为下游 `platform-api` token。
- 静态 Bearer Token 仅用于受控本地 stub / smoke，不作为生产接入方案。
- 提供 Codex、Claude Code / 通用远程 MCP 客户端与原始 HTTP 健康检查示例。
- 清楚区分客户端侧 token 获取、服务端环境变量、Compose 内部地址与对外地址；示例不写入真实 token、密码或生产 secret。
- 说明 scope、资源归属、写操作确认和审计的共同作用；敏感访问数据只在具有相应权限时返回。

## 一致性规则

- MCP 工具完整清单只在专项接入手册维护；其他文档只链接，不复制清单。
- 端点、环境变量和认证描述以 `apps/mcp` 的运行时配置、根 `docker-compose.yml` 与当前 Keycloak 配置为事实来源。
- 所有命令以 Docker Compose 为默认验证方式；文档不引导用户以本地开发进程替代容器环境。
- 文档只描述连接和运行，不创建、销毁或修改任何云资源。

## 验证

1. 检查 Markdown 链接、文件路径和命令名称存在。
2. 通过 Docker Compose 验证 API、Web、MCP 健康端点与文档一致。
3. 搜索文档，确保完整 MCP 工具清单没有在 README 和 `apps/mcp/README.md` 中重复维护。

## 非目标

- 不改变 MCP 的传输协议、认证实现、scope、工具或 API 行为。
- 不更新历史设计与实施计划中的当时快照。
- 不复制或提交任何真实凭据。
