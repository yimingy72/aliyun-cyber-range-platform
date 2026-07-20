# 阿里云综合靶场竞赛平台

一个面向管理员的阿里云综合靶场编排与实例管理平台。当前主线已经从“固定示例靶场”切到“平台内在线编排拓扑 -> 编译为场景模板 -> 经 Docker 容器内 OpenTofu worker 下发阿里云资源”的链路。

## 当前项目状态

- 已完成后台核心模块收敛：`靶场编排`、`靶场实例`、`镜像中心`、`基础配置`
- 已完成多账号后台主链路：`admin / user` 登录、用户管理、资源 owner 归属、平台可见 / 个人可见
- 已完成三栏式在线编排器主框架：资源面板、拓扑画布、属性面板
- 已完成镜像中心三层语义拆分：`平台收录镜像`、`阿里云自定义镜像`、`阿里云公共镜像`
- 已完成 API / worker 拆分：实例创建与销毁任务由独立 `provisioner-worker` 轮询执行
- 已完成 Docker 化 OpenTofu 运行链路，workspace 使用持久卷，provider mirror 使用宿主机只读缓存
- 已完成平台镜像资产接入，编排页 ECS 镜像选择只消费平台收录镜像
- 已完成单实例 ECS 原生链路：批量创建、异步公网 IP 刷新、导出镜像、镜像再创建、自动到期销毁
- 已完成列表页首屏减载：`实例管理`、`靶场编排`、`编排实例`、`镜像中心` 首屏已改为按视图懒加载与轻量 DTO

当前仍在持续收尾的方向：

- 靶场实例“查看详情”页准备重构
- 实例规格实时校验与 CPU/内存到阿里云 x86 实例规格的映射仍需继续完善
- 更多真实阿里云 smoke 覆盖还需要补齐

最近新增的重要链路：

- 模板页 `生成实例` 已切换为 `实例名 + 到期时间` 弹窗
- `靶场实例 -> 查看详情` 已切到独立路由页
- 实例 draft / apply / auto-expire / node actions 主链路已接通
- `实例管理` 已拆成单实例专属入口，支持 `实例列表 / 实例历史` 与批次视图
- `镜像中心` 已支持从平台镜像直接创建实例、显示创建人、个人镜像发布到平台 / 回退为私有
- 单实例创建时默认规则已收口为：`显式主机名 > 镜像默认主机名 > 阿里云随机主机名`
- 小于 30 分钟的单实例到期时间走平台 `auto-expire`，大于等于 30 分钟会同时下发阿里云 `AutoReleaseTime`
- 后台 Web 登录已切到 `1 周 SSO session + 短期 access token 自动续期`
- `镜像中心`、`实例管理`、`靶场列表`、`编排实例`、`用户管理` 已统一为同一套前端分页控件

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

### 4. 单实例批量链路

1. 管理员或普通用户在 `实例管理` 里选择平台镜像并创建单实例批次
2. API 为每台实例生成独立记录、归属用户、运行时凭据与单实例蓝图
3. Worker 走 ECS 原生 `RunInstances` 下发实例，创建请求带稳定 `ClientToken`
4. 创建提交流程只等待阿里云受理并回写 `instanceId`，公网 IP 与运行中状态通过异步刷新任务补齐
5. 到期销毁优先依赖平台 `expiresAt -> system:auto-expire`；满足阿里云限制时再附加 `AutoReleaseTime` 作为云上兜底

## 最近一轮能力更新（2026-07-14）

- 多用户资源归属规则已经贯通到：模板、编排实例、单实例、平台镜像、个人镜像
- 普通用户默认可查看所有平台镜像与平台拓扑，但只能维护自己拥有的私有/已发布资源
- 用户管理页已改成管理员专属，并支持创建、禁用、角色切换与密码重置
- `平台镜像` / `我的镜像` / `用户管理` 的操作区已统一为紧凑按钮布局，主操作保留行内，次级动作放入 `更多操作`
- 核心列表接口的真实响应体积已显著缩小：
  - `GET /admin/instances?view=active`：约 `1.29 MB -> 291 KB`
  - `GET /admin/ranges?view=history`：约 `92 KB -> 8.7 KB`
  - `GET /admin/scenarios?view=mine`：约 `156 KB -> 1.5 KB`
  - `GET /admin/image-catalog/public`：约 `170 KB -> 90 KB`

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
- `ALICLOUD_ACCESS_KEY`
- `ALICLOUD_SECRET_KEY`

`RANGE_PROVISIONER_MODE` 默认值为 `opentofu`：创建靶场实例会实际创建并计费阿里云资源。仅用于本地流程演练时，请在 `.env` 中显式设为 `dry-run`。

### 2. 下载 OpenTofu provider 缓存

在构建或启动容器前运行：

```bash
pnpm provider:download
```

脚本会下载并校验 Alibaba Cloud provider 到 `.local/provider-mirror/`，API 与 worker 以只读方式挂载此目录。

### 3. 启动整栈

```bash
pnpm compose:up
```

当前默认脚本会显式带上 `COMPOSE_BAKE=false`，避免当前 Docker Desktop 环境下 bake builder 的 header 问题。

默认启动服务：

- `postgres`
- `api`：`http://localhost:3001`
- `provisioner-worker`
- `web`：`http://localhost:3000`
- `mcp`：`http://localhost:8787/mcp`

### 4. 登录后台

- 地址：`http://localhost:3000/admin/login`
- 默认开发账号来自 `.env.example`
- 登录成功后默认保留 `1 周` 浏览器会话；前端会在 access token 即将过期时自动续期

### 5. 常用命令

```bash
pnpm compose:logs
pnpm compose:smoke:mcp
pnpm compose:down
docker compose config
```

### 6. MCP 联调

完整对外接入手册见：[MCP 客户端接入示例](docs/product/2026-07-15-MCP客户端接入示例.md)。

该文档现在已经包含：

- Codex / Claude Code / 通用 MCP client 配置示例
- MCP 全部 tool list
- 每个 tool 的用途说明
- agent 调用提示词
- 当前权限模型
- 已完成的黑盒权限验证结论
- 审计 / 日志说明

`mcp` 服务现在要求入站为 OIDC access token，并在服务端做 token exchange 换取下游 `platform-api` token。

如果你想从宿主机直接验证：

```bash
TOKEN=$(curl -sS http://127.0.0.1:8080/realms/cyber-range/protocol/openid-connect/token \
  -H 'content-type: application/x-www-form-urlencoded' \
  --data-urlencode 'grant_type=client_credentials' \
  --data-urlencode 'client_id=mcp-smoke-sa' \
  --data-urlencode 'client_secret=mcp-smoke-secret' | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.parse(s).access_token||''))")

MCP_URL=http://127.0.0.1:8787/mcp \
MCP_BEARER_TOKEN="$TOKEN" \
pnpm --filter @aliyun-cyber-range/mcp smoke:http
```

或直接跑 compose 级 smoke：

```bash
pnpm compose:smoke:mcp
```

如果 `api` / `mcp` 已经在跑，想跳过重建：

```bash
MCP_SMOKE_SKIP_UP=1 pnpm compose:smoke:mcp
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
