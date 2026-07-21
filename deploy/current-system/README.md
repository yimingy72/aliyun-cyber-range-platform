# 当前系统部署目录

这个目录用于集中存放“部署当前系统”时最常需要翻到的部署文件快照，方便后续独立部署或交接时快速定位。

## 当前说明

- 这里优先提交可复用的部署源码与说明文档
- `images/*.tar.gz` 这类离线镜像包属于本地导出产物，默认不纳入 Git
- 如果需要离线部署，请在当前机器重新执行导出，或把导出的镜像包单独随交付物传输

当前部署快照对应的系统能力已经包含：

- 多账号登录与用户管理
- 平台镜像 / 我的镜像 / 云上镜像来源三层镜像视角
- 平台拓扑 / 我的拓扑双视角
- 单实例专属 `实例管理` 页与批量创建 / 历史 / 自动到期销毁
- 独立 `provisioner-worker` 容器执行创建、销毁、状态刷新和 auto-expire
- Keycloak OIDC 登录、Token Exchange 与平台用户同步
- 独立 `mcp` Gateway，提供受 OIDC 保护的 Streamable HTTP MCP endpoint

## 目录内容

- [docker-compose.yml](./docker-compose.yml)
- [docker-compose.images.yml](./docker-compose.images.yml)
- [apps/api/Dockerfile](./apps/api/Dockerfile)
- [apps/web/Dockerfile](./apps/web/Dockerfile)
- [apps/mcp/Dockerfile](./apps/mcp/Dockerfile)
- [scripts/docker/seed-provider-mirror.sh](./scripts/docker/seed-provider-mirror.sh)
- [.env.example](./.env.example)
- `images/image-manifest.txt`

## 使用方式

这套部署文件默认配合当前仓库源码一起使用。

推荐步骤：

1. 在目标机器上准备完整仓库源码。
2. 进入目录：

```bash
cd deploy/current-system
```

3. 复制环境变量模板并填写真实配置：

```bash
cp .env.example .env
```

4. 至少补充以下字段：

- `ALICLOUD_ACCESS_KEY`
- `ALICLOUD_SECRET_KEY`
- `ADMIN_USERNAME`
- `ADMIN_PASSWORD`
- `ADMIN_TOKEN`
- `KEYCLOAK_ADMIN_PASSWORD`
- `MCP_OIDC_CLIENT_SECRET`

`RANGE_PROVISIONER_MODE` 默认使用 `opentofu`，会实际创建并计费阿里云资源；如仅需演练平台流程，请在 `.env` 中显式设置为 `dry-run`。

`OIDC_ISSUER` 和 `KEYCLOAK_HOSTNAME` 必须是浏览器与 MCP 客户端可访问的外部地址；若使用非默认端口，`KEYCLOAK_HOSTNAME` 必须是完整 URL（例如 `http://localhost:18080`），并与 `OIDC_ISSUER` 完全一致。Compose 内部的 JWKS、Token Exchange 和 Keycloak Admin 调用固定使用 `keycloak:8080`，不应配置为容器内的 `localhost`。

5. 下载并校验宿主机 OpenTofu provider 缓存：

```bash
sh ../../scripts/dev/download-alicloud-provider.sh
```

缓存位于仓库根目录 `.local/provider-mirror/`，会以只读方式挂载到 API 和 worker。可在 `.env` 中通过 `OPENTOFU_PROVIDER_MIRROR_HOST_PATH` 覆盖其位置。

6. 启动系统：

```bash
COMPOSE_BAKE=false docker compose up -d --build
```

`COMPOSE_BAKE=false` 与根目录启动脚本保持一致，用于规避部分 Docker Desktop 版本的 Bake builder 请求头兼容问题。

## 使用已导出镜像部署

如果目标机器不打算重新构建，可以使用本目录 `images/` 下另行准备的导出镜像包。

注意：

- 当前部署标签默认对齐到 `2026-07-19`（可通过 `CYBER_RANGE_IMAGE_TAG` 覆盖）
- 离线包需要包含 PostgreSQL、Keycloak、API、worker、Web 和 MCP 镜像
- 如果你要部署“当前代码”，请先在当前机器重新导出一份新的离线包，再拷贝到目标机器

1. 进入目录：

```bash
cd deploy/current-system
```

2. 如果你已经重新导出当前版本镜像包，导入镜像：

```bash
docker load -i images/current-system-images-2026-07-19.tar.gz
```

如需校验包完整性：

```bash
shasum -a 256 -c images/current-system-images-2026-07-19.tar.gz.sha256
```

3. 复制环境变量模板：

```bash
cp .env.example .env
```

4. 下载并校验宿主机 OpenTofu provider 缓存：

```bash
sh ../../scripts/dev/download-alicloud-provider.sh
```

5. 使用镜像版 compose 启动：

```bash
docker compose -f docker-compose.images.yml up -d
```

镜像版 compose 默认使用以下标签：

- `cyber-range-api:2026-07-19`
- `cyber-range-provisioner-worker:2026-07-19`
- `cyber-range-web:2026-07-19`
- `cyber-range-mcp:2026-07-19`

## 部署说明

- 这个目录下的 `docker-compose.yml` 已经改成使用仓库根目录作为 build context：
  - `context: ../..`
- 因此它可以直接引用当前仓库中的：
  - `apps/`
  - `packages/`
  - `infra/`
  - `deploy/current-system/`
- Keycloak 的 realm、主题和 bootstrap 脚本通过仓库根目录挂载；镜像版 compose 不需要重新构建应用镜像，但仍需要完整仓库源码。
- 如果使用已导出的镜像：
  - 优先使用 `docker-compose.images.yml`
  - 不依赖源码构建应用镜像

## 启动后的服务

- `web`
  - 默认端口：`3000`
- `api`
  - 默认端口：`3001`
- `mcp`
  - 默认端口：`8787`，endpoint：`POST /mcp`
  - 健康检查：`GET /healthz`
- `keycloak`
  - 默认端口：`8080`，负责 Web 与 MCP 的 OIDC 登录和 Token Exchange
- `keycloak-bootstrap`
  - 一次性初始化 realm、MCP Gateway client 与 smoke service account
- `provisioner-worker`
  - 负责 OpenTofu 执行与资源任务处理
- `postgres`
  - 默认端口：`5432`

## 部署后连接 MCP

MCP Gateway 是面向外部 MCP 客户端的 Streamable HTTP 服务。部署完成后，客户端应连接部署暴露的 `/mcp` 地址，并携带 OIDC Bearer access token；建议令 `.env` 的 `MCP_PUBLIC_URL` 与该公开地址保持一致，方便交接与客户端配置。

- `MCP_PUBLIC_URL` 应记录客户端可访问的 HTTPS 地址，并以 `/mcp` 结尾。
- `OIDC_ISSUER` 是 token 中的公开 issuer，应与客户端可访问的 Keycloak / OIDC 地址一致。
- `OIDC_JWKS_URL` 与 `OIDC_TOKEN_ENDPOINT` 供 Gateway 在 Compose 网络内验签和 Token Exchange，可继续使用 `keycloak:8080`，不要改为容器内的 `localhost`。
- `MCP_OIDC_CLIENT_ID`、`MCP_OIDC_CLIENT_SECRET`、`MCP_OIDC_AUDIENCE` 和 `PLATFORM_API_AUDIENCE` 必须与 OIDC realm 配置一致。
- 生产环境不要设置 `MCP_STATIC_BEARER_TOKEN`，它仅用于受控的本地 stub / smoke。

部署后可依次验证：

```bash
curl -fsS http://127.0.0.1:8787/healthz
docker compose ps mcp api keycloak
```

客户端配置、token 要求、工具清单和排错说明见：[平台 MCP 客户端接入手册](../../docs/product/2026-07-15-MCP客户端接入示例.md)。

## 当前前端加载策略

为了缩短后台首屏时间，当前运行包已经采用按视图惰性加载：

- `实例管理`：默认只拉 active 单实例数据，不再首屏拉历史与 jobs
- `靶场编排`：默认只拉当前 tab 模板列表
- `编排实例`：不再走整包 bootstrap，按视图拉轻量实例列表
- `镜像中心`：按 tab 加载平台镜像、我的镜像和云上镜像来源

## 持久化卷

- `postgres-data`
  - 数据库数据
- `keycloak-postgres-data`
  - Keycloak 身份与授权数据
- `opentofu-workspaces`
  - OpenTofu 工作目录、plan、state、outputs

Alibaba Cloud provider mirror 是仓库 `.local/provider-mirror/` 下经 SHA-256 校验的宿主机缓存，以只读 bind mount 提供给 API 和 worker，不属于 Docker 命名卷。

## 常用检查命令

```bash
docker compose config
docker compose ps
docker compose logs -f api
docker compose logs -f keycloak
docker compose logs -f provisioner-worker
docker compose logs -f web
docker compose logs -f mcp
curl -fsS http://127.0.0.1:8787/healthz
```

## 说明

- 这里放的是“当前系统部署快照”，方便部署时集中查看
- 业务源码仍以仓库主目录为准
- 如果后面根目录里的部署逻辑继续变化，优先同步更新这里这套文件
- `images/image-manifest.txt` 用来记录最近一次本地导出的镜像信息；真正的镜像包不默认随仓库推送

## 实例详情工作台回归

上线前至少验证：

1. 模板页生成实例弹窗可输入实例名与到期时间
2. 实例详情页可查看节点目录和拓扑结构
3. 运行中实例可保存草稿并应用变更
4. 已销毁实例保持只读
5. 到期实例会自动进入销毁任务
6. `provisioner-worker` 必须等待 `api` healthy 后再启动，避免数据库迁移未完成时先读新列
