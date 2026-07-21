# 阿里云综合靶场竞赛平台

阿里云综合靶场竞赛平台面向管理员、平台用户和自动化 Agent，提供从在线拓扑编排、实例开通到费用查看的统一管理能力。平台将用户在后台维护的拓扑编译为 OpenTofu 执行规格，并由容器化 worker 异步执行资源任务。

> 默认的 `opentofu` 模式会创建并计费阿里云资源。仅验证平台流程时，请在 `.env` 中显式设置 `RANGE_PROVISIONER_MODE=dry-run`，并不要填写真实云凭据。

## 平台能力

| 模块 | 说明 |
| --- | --- |
| 靶场编排 | 在线编辑网络与 ECS 拓扑，保存草稿、发布模板并从模板生成综合靶场。 |
| 靶场实例 | 查看综合靶场实例、任务、运行状态和访问入口；支持生命周期管理。 |
| 实例管理 | 基于平台镜像批量创建单实例，支持规格校验、任务重试、重启、VNC、镜像打包与自动到期销毁。 |
| 镜像中心 | 管理平台镜像、个人镜像、阿里云自定义镜像和公共镜像来源。 |
| 账单费用 | 展示平台总应付与公共费用；按一次成功开通分组查看用户或平台费用，展开可审计资源账单项。 |
| 用户与基础配置 | 管理平台用户、资源归属和云账号基础配置。 |
| MCP Gateway | 通过受 OIDC 保护的 Streamable HTTP MCP 服务，将平台能力接入 Codex、Claude Code 或其他 MCP 客户端。 |

## 架构概览

```text
管理员 Web ───────┐
                  ├── API ── PostgreSQL
MCP 客户端 ── MCP ┘    │
       │          │    └── ProvisionJob ── provisioner-worker ── OpenTofu / 阿里云
       └── Keycloak ─── OIDC Token 验证与 Token Exchange
```

- `apps/web`：Next.js 管理后台。
- `apps/api`：NestJS API，负责模板、实例、镜像、账单、用户和任务接口。
- `provisioner-worker`：独立容器，认领并执行资源任务。
- `apps/mcp`：MCP Gateway，验证入站 OIDC token，并以调用者身份访问平台 API。
- `packages/database`：Prisma 与 PostgreSQL 数据模型。
- `infra/opentofu`：综合靶场和单实例相关的 OpenTofu 模块。

## 快速开始

### 1. 准备环境变量

```bash
cp .env.example .env
```

本地仅演练平台流程时，保持阿里云凭据为空并设置：

```dotenv
RANGE_PROVISIONER_MODE=dry-run
```

需要执行真实云资源任务时，按实际环境填写 `.env` 中的云凭据、管理员密码和 OIDC / MCP secret；不要提交 `.env` 或任何真实 token。

### 2. 准备 OpenTofu provider 缓存

API 与 worker 会以只读方式挂载宿主机 provider mirror。启动前执行：

```bash
pnpm provider:download
```

缓存默认写入 `.local/provider-mirror/`。如缓存位于其他位置，可通过 `OPENTOFU_PROVIDER_MIRROR_HOST_PATH` 指定。

### 3. 启动完整容器环境

```bash
pnpm compose:up
```

该命令使用 Docker Compose 构建并启动 PostgreSQL、Keycloak、API、worker、Web 和 MCP。当前 Docker Desktop 环境下，脚本会关闭 Bake 模式以避免已知兼容问题。

### 4. 检查服务

| 服务 | 默认地址 | 检查方式 |
| --- | --- | --- |
| Web 后台 | `http://localhost:3000/admin/login` | 浏览器打开后台。 |
| API | `http://localhost:3001` | `curl -fsS http://127.0.0.1:3001/health` |
| MCP | `http://localhost:8787/mcp` | `curl -fsS http://127.0.0.1:8787/healthz` |
| Keycloak | `http://localhost:8080` | 浏览器或 OIDC discovery。 |

常用运维命令：

```bash
pnpm compose:logs
pnpm compose:down
docker compose ps
```

`pnpm compose:down` 会停止并移除容器与网络，但不会删除命名数据卷。如确需清除本地测试数据，请在确认目标后另行执行卷清理操作。

### 5. 配置镜像导入 Bucket（可选）

管理员可在后台“基础配置 → 云配置”填写“自定义 OSS 存储桶名”。平台只使用管理员已创建的 Bucket：保存时通过 STS 校验账号，并对填写的 Bucket 发起只读 `HEAD` 验证；不会创建 Bucket，也不会修改 ACL、CORS 或其他策略。

- 留空：云账号仍可保存和切换，镜像上传入口关闭；
- 已存在且当前凭据可访问：开放镜像上传；
- 不存在、地域不匹配或不可访问：云账号仍可使用，镜像上传关闭并显示原因。

镜像直传由浏览器完成，因此 Bucket 管理员还需要自行配置允许平台 Web 来源执行 `PUT` 的 CORS，并为当前凭据授予上传、查询和清理临时对象所需的权限。

## MCP 连接

MCP 服务使用 Streamable HTTP：`POST /mcp`，健康检查为 `GET /healthz`。生产接入使用 OIDC Bearer access token；Gateway 会验证 token，并为下游平台 API 执行 token exchange。静态 Bearer Token 只应用于受控的本地 stub / smoke 场景。

完整的客户端配置、认证、工具范围和排错指南见：[MCP 客户端接入手册](docs/product/2026-07-15-MCP客户端接入示例.md)。

## 文档导航

- [MCP 客户端接入手册](docs/product/2026-07-15-MCP客户端接入示例.md)
- [MCP 服务开发说明](apps/mcp/README.md)
- [当前系统部署说明](deploy/current-system/README.md)
- [产品规划与系统能力说明](docs/product/2026-07-08-综合靶场平台-产品规划与系统能力说明.md)
- [设计文档](docs/superpowers/specs/)
- [实施计划](docs/superpowers/plans/)

## 安全与运行边界

- 所有前端、后端、worker 和 OpenTofu 验证默认通过 Docker 容器完成。
- 真实阿里云 smoke 仅能在获得明确授权后执行，并必须使用最小资源集且立即清理。
- MCP 调用同时受 scope、用户角色、资源归属和平台操作控制约束；不要把 access token、密码、SSH / VNC 凭据交给不受信任的客户端或 Agent。
- 平台账单用于费用可见性和归属审计；原始云账单与实际结算仍以云厂商账单为准。
