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

注意：

- 当前部署标签已经对齐到 `2026-07-08`
- 本仓库里现存的 `2026-07-03` 离线包没有随这轮代码一起重导出
- 如果你要部署“当前代码”，请先在当前机器重新导出一份新的离线包，再拷贝到目标机器

1. 进入目录：

```bash
cd deploy/current-system
```

2. 如果你已经重新导出当前版本镜像包，导入镜像：

```bash
docker load -i images/current-system-images-2026-07-08.tar.gz
```

如需校验包完整性：

```bash
shasum -a 256 -c images/current-system-images-2026-07-08.tar.gz.sha256
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

- `cyber-range-api:2026-07-08`
- `cyber-range-provisioner-worker:2026-07-08`
- `cyber-range-web:2026-07-08`

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

## 当前前端加载策略

为了缩短后台首屏时间，当前运行包已经采用按视图惰性加载：

- `实例管理`：默认只拉 active 单实例数据，不再首屏拉历史与 jobs
- `靶场编排`：默认只拉当前 tab 模板列表
- `编排实例`：不再走整包 bootstrap，按视图拉轻量实例列表
- `镜像中心`：按 tab 加载平台镜像、我的镜像和云上镜像来源

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
