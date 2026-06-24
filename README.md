# 阿里云综合靶场竞赛平台

第一阶段聚焦于阿里云综合靶场编排后台：

- 管理员登录
- 比赛 / 队伍 / 模板管理
- 靶场实例与编排任务总览
- 本地 Docker 一键启动

## 本地容器启动

1. 准备环境变量

```bash
cp .env.example .env
```

2. 启动整栈

```bash
pnpm compose:up
```

默认会启动三个服务：

- `postgres`：PostgreSQL
- `api`：NestJS 后端，默认 `http://localhost:3001`
- `web`：Next.js 管理后台，默认 `http://localhost:3000`

3. 登录后台

- 管理后台地址：`http://localhost:3000/admin/login`
- 选手入口地址：`http://localhost:3000/login`
- 默认开发账号：`admin`
- 默认开发密码：`change-me`

对应默认值来自 `.env.example` 中的：

- `ADMIN_USERNAME`
- `ADMIN_PASSWORD`
- `ADMIN_TOKEN`

4. 查看日志

```bash
pnpm compose:logs
```

5. 停止整栈

```bash
pnpm compose:down
```

## 端口冲突时的启动方式

如果本机已有服务占用 `3000/3001`，可以覆盖端口：

```bash
WEB_PORT=3100 API_PORT=3101 NEXT_PUBLIC_API_BASE_URL=http://localhost:3101 docker compose up -d --build
```

此时后台地址为：

- `http://localhost:3100/admin/login`

## 当前 Docker 文件

- API 镜像：[apps/api/Dockerfile](/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api/Dockerfile)
- Web 镜像：[apps/web/Dockerfile](/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/web/Dockerfile)
- Compose 编排：[docker-compose.yml](/Users/yym/Documents/阿里云For综合靶场竞赛平台/docker-compose.yml)

## 阿里云联调说明

当前仓库已保留阿里云与 OpenTofu 所需环境变量，但本轮验证按当前约束只进行了非破坏性本地整栈验证。真实云资源创建建议在单独 smoke 配置下执行。
