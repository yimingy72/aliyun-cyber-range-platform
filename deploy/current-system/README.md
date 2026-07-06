# 当前系统部署目录

这个目录用于集中存放“部署当前系统”时最常需要翻到的部署文件快照，方便后续独立部署或交接时快速定位。

## 当前说明

- 这里优先提交可复用的部署源码与说明文档
- `images/*.tar.gz` 这类离线镜像包属于本地导出产物，默认不纳入 Git
- 如果需要离线部署，请在当前机器重新执行导出，或把导出的镜像包单独随交付物传输

## 目录内容

- [docker-compose.yml](/Users/yym/Documents/阿里云For综合靶场竞赛平台/deploy/current-system/docker-compose.yml)
- [docker-compose.images.yml](/Users/yym/Documents/阿里云For综合靶场竞赛平台/deploy/current-system/docker-compose.images.yml)
- [apps/api/Dockerfile](/Users/yym/Documents/阿里云For综合靶场竞赛平台/deploy/current-system/apps/api/Dockerfile)
- [apps/web/Dockerfile](/Users/yym/Documents/阿里云For综合靶场竞赛平台/deploy/current-system/apps/web/Dockerfile)
- [scripts/docker/seed-provider-mirror.sh](/Users/yym/Documents/阿里云For综合靶场竞赛平台/deploy/current-system/scripts/docker/seed-provider-mirror.sh)
- [.env.example](/Users/yym/Documents/阿里云For综合靶场竞赛平台/deploy/current-system/.env.example)
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
- `OPENTOFU_INSTANCE_PASSWORD`
- `ADMIN_USERNAME`
- `ADMIN_PASSWORD`
- `ADMIN_TOKEN`

5. 启动系统：

```bash
docker compose up -d --build
```

## 使用已导出镜像部署

如果目标机器不打算重新构建，可以使用本目录 `images/` 下另行准备的导出镜像包。

1. 进入目录：

```bash
cd deploy/current-system
```

2. 如果当前目录已有导出镜像包，导入镜像：

```bash
docker load -i images/current-system-images-2026-07-03.tar.gz
```

如需校验包完整性：

```bash
shasum -a 256 -c images/current-system-images-2026-07-03.tar.gz.sha256
```

3. 复制环境变量模板：

```bash
cp .env.example .env
```

4. 使用镜像版 compose 启动：

```bash
docker compose -f docker-compose.images.yml up -d
```

镜像版 compose 默认使用以下标签：

- `cyber-range-api:2026-07-03`
- `cyber-range-provisioner-worker:2026-07-03`
- `cyber-range-web:2026-07-03`

## 部署说明

- 这个目录下的 `docker-compose.yml` 已经改成使用仓库根目录作为 build context：
  - `context: ../..`
- 因此它可以直接引用当前仓库中的：
  - `apps/`
  - `packages/`
  - `infra/`
  - `deploy/current-system/`
- 如果使用已导出的镜像：
  - 优先使用 `docker-compose.images.yml`
  - 不依赖源码构建

## 启动后的服务

- `web`
  - 默认端口：`3000`
- `api`
  - 默认端口：`3001`
- `provisioner-worker`
  - 负责 OpenTofu 执行与资源任务处理
- `postgres`
  - 默认端口：`5432`

## 持久化卷

- `postgres-data`
  - 数据库数据
- `opentofu-workspaces`
  - OpenTofu 工作目录、plan、state、outputs
- `provider-mirror`
  - 阿里云 provider mirror

## 常用检查命令

```bash
docker compose config
docker compose ps
docker compose logs -f api
docker compose logs -f provisioner-worker
docker compose logs -f web
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
