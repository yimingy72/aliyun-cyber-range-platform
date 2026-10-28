# 阿里云综合靶场竞赛平台

阿里云综合靶场竞赛平台面向管理员、平台用户和自动化 Agent，提供从在线拓扑编排、实例开通到费用查看的统一管理能力。平台将用户在后台维护的拓扑编译为 OpenTofu 执行规格，并由容器化 worker 异步执行资源任务。

> 默认的 `opentofu` 模式会创建并计费阿里云资源。仅验证平台流程时，请在 `.env` 中显式设置 `RANGE_PROVISIONER_MODE=dry-run`，并不要填写真实云凭据。

## 平台能力

| 模块 | 说明 |
| --- | --- |
| 靶场编排 | 在线编辑网络与 ECS 拓扑，保存草稿、发布模板并从模板生成综合靶场。 |
| 靶场实例 | 查看综合靶场实例、任务、运行状态和访问入口；支持生命周期管理。 |
| 实例管理 | 基于平台镜像批量创建单实例，支持规格校验、任务重试、重启、VNC、镜像打包与自动到期销毁。 |
| 镜像中心 | 管理平台镜像、个人镜像、阿里云与腾讯云自定义镜像和公共镜像来源。 |
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
pnpm provider:build
```

当前运行版本使用定制 provider，先运行 `pnpm provider:build` 在 Docker 中构建并验证。镜像默认写入 `.local/provider-fast-wait/mirror/`，通过 `OPENTOFU_PROVIDER_MIRROR_HOST_PATH` 可指定其它位置。

腾讯云运行时同样需要经过核验的 provider 缓存：执行 `sh scripts/provider/tencentcloud-idempotency/build.sh`，默认写入 `.local/tencentcloud-idempotency/mirror/`，通过 `TENCENTCLOUD_PROVIDER_MIRROR_HOST_PATH` 指定挂载目录。新 Compose 同时挂载两家 provider；不能用官方 ZIP 替换定制版本。

`provider:download` 仍下载官方 1.282.0，供旧版本回滚使用；新模块精确要求 1.282.0-range.1，不能将官方 ZIP 重命名作为定制版本。

### 3. 启动完整容器环境

```bash
pnpm compose:up
```

该命令使用 Docker Compose 构建并启动 PostgreSQL、Keycloak、API、worker、Web 和 MCP。当前 Docker Desktop 环境下，脚本会关闭 Bake 模式以避免已知兼容问题。

### OpenTofu 版本与任务并发

容器固定为 OpenTofu **1.13.1**，阿里云 provider 使用基于官方 1.282.0 的 **1.282.0-range.1**。定制补丁仅将 ECS 创建首次状态检查等待从 10 秒缩短至 2 秒，删除等待和原有状态判定、重试仍保留。固定源码、补丁、可复现 Docker 构建与摘要见 [provider 构建说明](scripts/provider/alicloud-fast-wait/README.md)。

腾讯云使用 **1.83.34-range.1**。补丁将持久 ClientToken 和云端到期终止时间随 CVM 创建原子提交，并禁止平台 NAT 未知结果的自动重复创建，详见 [腾讯云 provider 补丁](scripts/provider/tencentcloud-idempotency/README.md)。腾讯云单实例也由 OpenTofu 批次工作区创建；真实编排开通默认由 `TENCENTCLOUD_RANGE_NAT_EXECUTION_ENABLED=0` 关闭，完成受控回收实测后再启用。

API 负责校验并入队，资源任务统一由 worker 执行。每个 worker 默认同时执行 **2 个编排任务**、**3 个单实例批次任务**。新单实例通过 OpenTofu 创建和销毁：同批冻结账号与网络、共享一个状态工作区，以平台实例 ID 管理独立 ECS。数据库批次租约和逐成员认领防止多个 worker 拆分或重复执行同一状态图。已有 API 实例保留兼容回收路径。状态刷新每次只读一次，未就绪时延迟入队并释放执行名额。

```dotenv
PROVISIONING_WORKER_RANGE_CONCURRENCY=2
PROVISIONING_WORKER_SINGLE_BATCH_CONCURRENCY=3
```

这两个上限按 worker 生效。编排图并发默认 10（`OPENTOFU_PARALLELISM`），独立实例批次图并发默认 20（`OPENTOFU_SINGLE_INSTANCE_PARALLELISM`）；两种图并发均允许 1–32，非法值会拒绝启动对应执行器。3 个单实例批次可产生最多约 60 个 ECS 资源并发操作，同一云账号的限流额度仍共享。变更配置后需在无在途资源任务时重建容器。

独立实例成员在 provider 发出完成事件、平台独立核验 Running、公网 IP 和完整归属后，即可提前显示可用；整批作业与账单仍等完整 apply 和状态核验完成。创建期间的销毁、重启和打包会被拦截。账单同步按实例索引查询历史，避免每台扫描全站台账。

升级运行时前应等待资源任务结束，备份工作区状态卷，并保留旧镜像。不同版本的已保存 plan 不跨版本复用，新的任务会重新生成 plan。升级说明与验证记录见 [OpenTofu 升级与并发优化](docs/operations/2026-10-09-opentofu-performance.md)。

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

### 公网免费演示

没有可用域名时，可启用 Cloudflare Quick Tunnel 获取一个临时 HTTPS 地址：

```bash
COMPOSE_PROFILES=quick-tunnel docker compose up -d
docker compose logs -f cloudflared
```

日志中的 `https://*.trycloudflare.com` 是临时公网入口。将它写入 `WEB_PUBLIC_URL`、`KEYCLOAK_HOSTNAME`、`OIDC_ISSUER`、`NEXT_PUBLIC_OIDC_ISSUER` 和 `MCP_PUBLIC_URL`，并将 API 地址设为 `${入口}/api` 后重新构建 Web。Quick Tunnel 无需域名或付费账号，但地址会在隧道重建后变化，仅适合演示和联调。

### 公网 IP HTTPS

若接受浏览器首次访问时的自签名证书提示，可直接使用公网 IP，避免 Quick Tunnel 的跨境绕行：

```dotenv
COMPOSE_PROFILES=direct-tls
CADDY_PUBLIC_HOST=203.0.113.10
WEB_PUBLIC_URL=https://203.0.113.10
NEXT_PUBLIC_API_BASE_URL=https://203.0.113.10/api
NEXT_PUBLIC_OIDC_ISSUER=https://203.0.113.10/realms/cyber-range
KEYCLOAK_HOSTNAME=https://203.0.113.10
OIDC_ISSUER=https://203.0.113.10/realms/cyber-range
MCP_PUBLIC_URL=https://203.0.113.10/mcp
```

同时需在安全组中放行 TCP `80` 和 `443`。Caddy 为 IP 生成本地 CA 证书，浏览器手动继续后即可在 HTTPS 安全上下文中完成 PKCE 登录。

### 5. 配置镜像导入 Bucket（可选）

管理员可在后台“基础配置 → 云配置”填写“自定义 OSS 存储桶名”。平台只使用管理员已创建的 Bucket：保存时通过 STS 校验账号，并对填写的 Bucket 发起只读 `HEAD` 验证；不会创建 Bucket，也不会修改 ACL、CORS 或其他策略。

- 留空：云账号仍可保存和切换，镜像上传入口关闭；
- 已存在且当前凭据可访问：开放镜像上传；
- 不存在、地域不匹配或不可访问：云账号仍可使用，镜像上传关闭并显示原因。

镜像直传由浏览器完成，因此 Bucket 管理员还需要自行配置允许平台 Web 来源执行 `PUT` 的 CORS，并为当前凭据授予上传、查询和清理临时对象所需的权限。

腾讯云导入使用平台新建的私有专属 COS Bucket，按冻结账号、APPID、地域及创建来源核验，不复用现有混用桶。临时对象与空闲桶逐项确认消失后释放台账；打包镜像及其依赖快照保留期间仍可能计费。详细边界见 [腾讯云镜像生命周期](docs/operations/tencent-image-lifecycle.md)。

### 墨攻镜像中心

管理员可在阿里云工作空间的镜像中心查看墨攻目录快照，按名称或 ID 搜索。目录仅显示与当前工作空间和地域中已同步的阿里云自定义镜像精确匹配的记录；先同步云镜像，再收录可用的虚拟机。停用、名称标注废弃或弃用、未完成处理及容器镜像不会从该入口收录。

目录是独立的私有快照，并非实时同步。更新时在已登录墨攻的 OpenCLI 浏览器会话中设置 `OPENCLI_PROFILE`，执行 `scripts/dev/snapshot-mogong-images.sh`；默认写入 `.local/mogong/image-catalog.json`，也可用 `MOGONG_IMAGE_CATALOG_OUTPUT` 指定路径。Compose 将该目录只读挂载到 API，替换快照后无需重建镜像；部署到其他主机时须将快照安全传到该主机的挂载目录，或用 `MOGONG_CATALOG_HOST_PATH` 指定目录。快照不提交到公开仓库，只保存目录 ID、名称、创建人、类型、状态和阿里云镜像 ID，不保存墨攻凭据、密码或备注。

收录后平台资产直接关联当前工作空间的阿里云镜像记录，删除墨攻目录快照或入口不会删除平台资产。阿里云原镜像仍须存在且可用；如果墨攻操作同时删除了阿里云镜像，该平台资产也会受到影响。

## MCP 连接

MCP 服务使用 Streamable HTTP：`POST /mcp`，健康检查为 `GET /healthz`。生产接入使用 OIDC Bearer access token；Gateway 会验证 token，并为下游平台 API 执行 token exchange。静态 Bearer Token 只应用于受控的本地 stub / smoke 场景。

完整的客户端配置、认证、工具范围和排错指南见：[MCP 客户端接入手册](docs/product/2026-07-15-MCP客户端接入示例.md)。

## 文档导航

| 文档 | 定位 |
| --- | --- |
| [PRODUCT.md](PRODUCT.md) | 产品定位、体验原则与当前交付快照 |
| [产品规划与系统能力说明](docs/product/2026-07-08-综合靶场平台-产品规划与系统能力说明.md) | **当前能力完成度与模块看板**（以代码为准） |
| [DESIGN.md](DESIGN.md) | 后台 UI 设计规范 |
| [MCP 客户端接入手册](docs/product/2026-07-15-MCP客户端接入示例.md) | MCP 连接唯一详细手册 |
| [MCP 服务开发说明](apps/mcp/README.md) | MCP 服务开发与 smoke |
| [当前系统部署说明](deploy/current-system/README.md) | 部署交接 |
| [历史设计快照](docs/superpowers/specs/) | 当时决策上下文，**不是**当前完成度事实源 |
| [历史实施计划](docs/superpowers/plans/) | 当时排期上下文，可能落后于实现 |

## 安全与运行边界

- 所有前端、后端、worker 和 OpenTofu 验证默认通过 Docker 容器完成。
- 真实阿里云 smoke 仅能在获得明确授权后执行，并必须使用最小资源集且立即清理。
- MCP 调用同时受 scope、用户角色、资源归属和平台操作控制约束；不要把 access token、密码、SSH / VNC 凭据交给不受信任的客户端或 Agent。
- 平台账单用于费用可见性和归属审计；原始云账单与实际结算仍以云厂商账单为准。
