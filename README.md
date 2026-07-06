# 阿里云综合靶场竞赛平台

一个面向管理员的阿里云综合靶场编排与实例管理平台。当前主线已经从“固定示例靶场”切到“平台内在线编排拓扑 -> 编译为场景模板 -> 经 Docker 容器内 OpenTofu worker 下发阿里云资源”的链路。

## 当前项目状态

- 已完成后台核心模块收敛：`靶场编排`、`靶场实例`、`镜像中心`、`基础配置`
- 已完成三栏式在线编排器主框架：资源面板、拓扑画布、属性面板
- 已完成镜像中心三层语义拆分：`平台收录镜像`、`阿里云自定义镜像`、`阿里云公共镜像`
- 已完成 API / worker 拆分：实例创建与销毁任务由独立 `provisioner-worker` 轮询执行
- 已完成 Docker 化 OpenTofu 运行链路，workspace / provider mirror 挂载到持久卷
- 已完成平台镜像资产接入，编排页 ECS 镜像选择只消费平台收录镜像

当前仍在持续收尾的方向：

- 靶场实例“查看详情”页准备重构
- 实例规格实时校验与 CPU/内存到阿里云 x86 实例规格的映射仍需继续完善
- 更多真实阿里云 smoke 覆盖还需要补齐

最近新增的重要链路：

- 模板页 `生成实例` 已切换为 `实例名 + 到期时间` 弹窗
- `靶场实例 -> 查看详情` 已切到独立路由页
- 实例 draft / apply / auto-expire / node actions 主链路已接通

## 系统架构

### Web

- `apps/web`
- Next.js 管理后台
- 负责管理员登录、模板列表、在线编排、镜像中心、实例列表与历史

### API

- `apps/api`
- NestJS 后端
- 负责模板/实例/镜像/系统配置接口、拓扑校验、任务入队、状态回写

### Provisioner Worker

- `apps/api/src/worker-main.ts`
- 与 API 使用同一代码库、独立容器启动
- 负责认领 `ProvisionJob` 并执行 `tofu init / plan / apply / destroy`

### Database

- `packages/database`
- Prisma + PostgreSQL
- 保存管理员配置、模板版本、实例记录、镜像快照、平台镜像资产、任务状态

### IaC / OpenTofu

- `infra/opentofu/modules/alicloud-enterprise-range`
- 平台不会直接手写一套固定 root module，而是由后端把拓扑编译为中间规格，再渲染 wrapper workspace 调用现有模块

## 关键业务链路

### 1. 在线编排

1. 管理员在 `靶场编排` 页面创建 Router / Switch / ECS 拓扑
2. 前端把画布图、节点属性、连线关系保存为拓扑 graph
3. 后端把拓扑 graph 编译为 `ScenarioTemplateSpec` / `CompiledProvisionSpec`
4. 草稿与发布状态只表示模板共享可见性，不直接等价于“是否能启动”

### 2. 镜像选择

1. 阿里云公共镜像/自定义镜像先同步为 `CloudImageSnapshot`
2. 管理员把需要的镜像“收录到平台”
3. 平台生成 `PlatformImageAsset`
4. ECS 属性面板镜像选择器只展示已收录且启用的镜像资产

### 3. 实例创建

1. `靶场实例` 页或模板页触发创建实例
2. API 基于模板当前草稿/发布版本生成实例记录与 `ProvisionJob`
3. `provisioner-worker` 在 Docker 容器内渲染 OpenTofu wrapper workspace
4. Worker 调用 OpenTofu 与阿里云 provider 创建/销毁资源，并把结果写回数据库

## 目录速览

- [apps/web](/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/web)
- [apps/api](/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api)
- [packages/database](/Users/yym/Documents/阿里云For综合靶场竞赛平台/packages/database)
- [infra/opentofu](/Users/yym/Documents/阿里云For综合靶场竞赛平台/infra/opentofu)
- [docs/superpowers/specs](/Users/yym/Documents/阿里云For综合靶场竞赛平台/docs/superpowers/specs)
- [docs/superpowers/plans](/Users/yym/Documents/阿里云For综合靶场竞赛平台/docs/superpowers/plans)
- [deploy/current-system](/Users/yym/Documents/阿里云For综合靶场竞赛平台/deploy/current-system)

## Docker 启动

### 1. 准备环境变量

```bash
cp .env.example .env
```

至少需要按实际环境填写：

- `ADMIN_USERNAME`
- `ADMIN_PASSWORD`
- `ADMIN_TOKEN`
- `OPENTOFU_INSTANCE_PASSWORD`
- `ALICLOUD_ACCESS_KEY`
- `ALICLOUD_SECRET_KEY`

### 2. 启动整栈

```bash
pnpm compose:up
```

当前默认脚本会显式带上 `COMPOSE_BAKE=false`，避免当前 Docker Desktop 环境下 bake builder 的 header 问题。

默认启动服务：

- `postgres`
- `api`：`http://localhost:3001`
- `provisioner-worker`
- `web`：`http://localhost:3000`

### 3. 登录后台

- 地址：`http://localhost:3000/admin/login`
- 默认开发账号来自 `.env.example`

### 4. 常用命令

```bash
pnpm compose:logs
pnpm compose:down
docker compose config
```

### 5. 端口冲突时

```bash
WEB_PORT=3100 API_PORT=3101 NEXT_PUBLIC_API_BASE_URL=http://localhost:3101 docker compose up -d --build
```

## 部署说明

当前部署快照放在：

- [deploy/current-system/README.md](/Users/yym/Documents/阿里云For综合靶场竞赛平台/deploy/current-system/README.md)

其中包含：

- compose 文件
- Dockerfile 快照
- provider mirror 初始化脚本
- 镜像导出/离线部署说明

## 计划与设计文档

当前最重要的计划/设计文档：

- [Docker/OpenTofu Provisioning Alignment Design](/Users/yym/Documents/阿里云For综合靶场竞赛平台/docs/superpowers/specs/2026-07-02-docker-opentofu-provisioning-alignment-design.md)
- [Docker/OpenTofu Provisioning Alignment Implementation Plan](/Users/yym/Documents/阿里云For综合靶场竞赛平台/docs/superpowers/plans/2026-07-02-docker-opentofu-provisioning-alignment-implementation-plan.md)
- [Image Center Platform Assets Design](/Users/yym/Documents/阿里云For综合靶场竞赛平台/docs/superpowers/specs/2026-07-06-image-center-platform-assets-design.md)
- [Image Center Platform Assets Implementation Plan](/Users/yym/Documents/阿里云For综合靶场竞赛平台/docs/superpowers/plans/2026-07-06-image-center-platform-assets-implementation-plan.md)

## 约束

- 后续前端、后端、worker、OpenTofu 相关验证默认都走 Docker 容器，不以本地 dev server 代替
- 阿里云 smoke test 仅允许一次受控验证，并要求测试后立即销毁临时资源
- 不提交真实密钥、`.env`、本地索引目录或导出的超大镜像包
