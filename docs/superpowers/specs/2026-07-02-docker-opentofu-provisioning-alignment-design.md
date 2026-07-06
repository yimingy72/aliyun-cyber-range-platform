# Docker/OpenTofu Provisioning Alignment Design

日期：2026-07-02
最近更新：2026-07-06
状态：Active

## 当前状态快照

本设计对应的主链路已经不再停留在方案阶段，当前仓库中已落地的核心内容包括：

1. API / worker 角色拆分，`provisioner-worker` 已作为独立容器运行
2. OpenTofu 执行改为基于 workspace wrapper 的 Docker 容器链路
3. 云配置已经进入数据库持久化，而非单纯依赖进程环境变量
4. 编排模板实例化时会走任务入队与 worker 认领，而不是 API 进程内直接执行
5. 部署快照已沉淀到 `deploy/current-system/`

当前还未彻底收口的点：

- 实例规格与前端 CPU/内存语义之间的实时校验与最终映射
- 更多针对真实阿里云账号的 smoke 回归覆盖
- 部分旧默认值文案与部署快照仍需持续同步

- 日期：2026-07-02
- 状态：提案已确认，待按计划实施
- 设计流程：`superpowers:brainstorming` 复审 + Docker 部署导向收口
- 目标范围：平台内 `靶场编排 -> 创建实例 -> OpenTofu -> 阿里云` 执行链路，限定第一阶段 `单 VPC + 多 switch + 多 ECS`

## 1. 目标

把当前平台内“基于拓扑创建实例”的执行方式，收敛成和 README 中已验证通过的真实阿里云 smoke 链路一致的 Docker 化形态。

这次设计解决的不是前端画布，而是部署执行面的四个问题：

- 平台运行的 OpenTofu 形态与历史成功 smoke 不一致
- 云配置只存在进程内存，容器重启即丢失
- API 与 OpenTofu 执行耦合过紧，不利于 Docker 化和后续并发
- provider/runtime 依赖外部网络与宿主机环境，稳定性不足

## 2. 当前事实

### 2.1 已经成立的部分

- 前端已经能产出：
  - `topologyGraph`
  - `topologySpec`
  - `scenarioTemplateSpec`
  - `compiledProvisionSpec`
  - `compiledSpec`
- `compiledProvisionSpec` 已经足以表达：
  - 任意数量 `switch`
  - 任意数量 `ecs`
  - `natGateways / eips / snatEntries / dnatEntries`
- `buildEnterpriseProvisionPlan()` 已经过渡到可兼容 `zone-1 / zone-2 / ...` 这类通用逻辑区
- OpenTofu module 本体已经支持通用结构输入，不只支持 `dmz/office/server`

### 2.2 当前仍然不成立的部分

- 平台运行时不是沿用 README 中真实成功的“example-root 调 module”模式，而是更接近“直接执行 module 目录”
- `SystemConfigService` 仍通过 `process.env` 读写 AK/SK、地域、可用区，不适合容器重启后的持久化
- Docker Compose 只有 `web/api/postgres` 三个服务，没有独立的 provisioning worker
- API 容器没有稳定、内建、可复用的 OpenTofu + provider mirror 方案

## 3. OpenTofu 在本项目中的真实分层

### 3.1 Root module

Root module 是 OpenTofu 直接进入并执行的最外层工程。

本仓库里，历史 smoke 路径对应的 root module 是：

- [infra/opentofu/examples/alicloud-enterprise-range/main.tf](/Users/yym/Documents/阿里云For综合靶场竞赛平台/infra/opentofu/examples/alicloud-enterprise-range/main.tf)

它做三件事：

1. 配置 `provider "alicloud"`
2. 读取 root 变量
3. 通过 `module "range"` 调用真正的资源模块

### 3.2 Child module

真正定义阿里云资源的，是：

- [infra/opentofu/modules/alicloud-enterprise-range/main.tf](/Users/yym/Documents/阿里云For综合靶场竞赛平台/infra/opentofu/modules/alicloud-enterprise-range/main.tf)

这里才定义了：

- `alicloud_vpc`
- `alicloud_vswitch`
- `alicloud_instance`
- `alicloud_nat_gateway`
- `alicloud_eip_address`
- `alicloud_snat_entry`
- `alicloud_forward_entry`

### 3.3 平台应该生成什么

平台不应该“每次生成一整套完全不同的 OpenTofu 工程”。

平台应该生成的是：

- 某次实例创建所需的结构化变量数据

也就是：

- `compiledProvisionSpec`
- 再渲染成 `range.auto.tfvars.json`

Root module 壳保持固定，变量内容随拓扑变化。

## 4. 方案比较

### 方案 A：固定 Root module 壳 + 平台生成 tfvars + 独立 worker 容器

特点：

- 平台每次只生成变量
- worker 生成一个固定结构的 root wrapper
- wrapper 再调用 `modules/alicloud-enterprise-range`
- OpenTofu 在独立 worker 容器中执行

优点：

- 与 README 历史成功 smoke 路径一致
- 平台拓扑变化不需要重造 OpenTofu 结构
- 最适合 Docker 化与后续并发
- API 不会被 `tofu apply/destroy` 长时间阻塞

缺点：

- 需要引入 worker 服务
- 需要补数据库持久化配置
- 需要补 Docker volumes 与 provider mirror 策略

### 方案 B：API 容器内嵌 OpenTofu，仍由 API 直接执行

优点：

- 改动表面上更少
- 短期可继续复用现有 service 代码

缺点：

- API 与执行器耦合
- 容器职责混乱
- 后续扩容、限流、并发、日志隔离都更差

### 方案 C：平台动态生成完整 `.tf` 工程

优点：

- 最灵活

缺点：

- 不必要地重
- 平台要承担更多 Terraform/OpenTofu 结构细节
- 与既有 module 复用价值相冲突

### 结论

采用 **方案 A**。

## 5. 目标架构

最终 Docker 形态调整为：

- `web`
- `api`
- `provisioner-worker`
- `postgres`
- `opentofu-workspaces` 持久卷
- `provider-mirror` 持久卷

### 5.1 各服务职责

#### `web`

- 后台 UI
- 不直接接触 OpenTofu

#### `api`

- 登录与后台 API
- 模板持久化
- 拓扑编译
- 实例与任务创建
- 查询任务状态与输出结果

#### `provisioner-worker`

- 轮询或接收 provisioning 任务
- 生成 root wrapper workspace
- 运行 `tofu init/validate/plan/apply/destroy`
- 回写实例状态、步骤日志、输出摘要

#### `postgres`

- 存模板、实例、任务、云配置

### 5.2 卷职责

#### `opentofu-workspaces`

保存每个实例的：

- root wrapper 文件
- `range.auto.tfvars.json`
- `.terraform.lock.hcl`
- state
- plan
- outputs

#### `provider-mirror`

保存阿里云 provider mirror，避免运行时外网下载。

## 6. Root wrapper 设计

### 6.1 为什么要有 wrapper

平台执行方式要和历史 smoke 路径一致。

因此，worker 不再直接把 `modules/alicloud-enterprise-range` 当 root 执行，而是为每个实例生成一个临时 root wrapper。

### 6.2 wrapper 结构

每个 workspace 至少包含：

- `main.tf`
- `variables.tf`
- `outputs.tf`
- `versions.tf`
- `range.auto.tfvars.json`

其中：

- `main.tf`：配置 provider，并 `module "range"` 指向 `/app/infra/opentofu/modules/alicloud-enterprise-range`
- `variables.tf`：暴露 root 输入变量
- `outputs.tf`：转发 `module.range.public_entry` 与 `module.range.resource_summary`
- `range.auto.tfvars.json`：平台渲染出来的当前实例变量

### 6.3 wrapper 的原则

- wrapper 结构固定
- 变量结构固定
- 平台只改变变量值，不改变工程形状

## 7. 数据流

### 7.1 创建实例

1. 用户在平台中完成编排并通过“检测拓扑”
2. 平台保存：
   - `topologyGraph`
   - `compiledProvisionSpec`
   - `compiledSpec`
3. 用户点击“创建实例”
4. API 创建 `RangeInstance` 与 `ProvisionJob`
5. worker 读取模板当前草稿版本
6. worker 基于 `compiledProvisionSpec` 构建 `EnterpriseProvisionPlan`
7. worker 生成 root wrapper workspace
8. worker 运行：
   - `tofu init`
   - `tofu validate`
   - `tofu plan`
   - `tofu apply`
9. worker 读取 outputs
10. API/worker 回写：
    - `accessEntry`
    - `resourceSummary`
    - 步骤日志
    - 最终实例状态

### 7.2 销毁实例

1. 用户点击“销毁”
2. API 创建 destroy job
3. worker 进入该实例 workspace
4. 运行 `tofu destroy`
5. 回写状态与日志

## 8. 云配置持久化

当前 `SystemConfigService` 基于 `process.env` 的方式只适合开发态，不适合 Docker 生产。

### 8.1 要持久化的配置

- provider
- defaultRegion
- defaultZoneId
- accessKeyId
- accessKeySecret

### 8.2 运行时注入方式

- 配置写入数据库
- API 返回给前端时对敏感字段做遮罩
- worker 在执行任务前从数据库读取完整配置

### 8.3 不放进平台可编辑配置的项

这些更适合部署级 env：

- `OPENTOFU_INSTANCE_PASSWORD`
- provider mirror 路径
- OpenTofu binary 路径
- worker 并发与超时

## 9. Docker 运行时策略

### 9.1 OpenTofu

最终不要依赖宿主机脚本或宿主机二进制。

worker 容器内必须有稳定 OpenTofu 运行时。

### 9.2 Provider

最终不要依赖运行时从 GitHub 或 registry 拉 provider。

推荐：

- 镜像内预置 provider 包
- 启动时将 provider mirror 初始化到共享卷

### 9.3 阿里云 CLI

如果实例规格 / 镜像选择仍依赖 `aliyun` CLI 自动探测：

- worker 容器内一并提供 `aliyun` CLI

如果改为平台固定配置：

- 可以移除 CLI 依赖

## 10. 安全与可观测性

### 10.1 密钥

- 前端不回显完整 `accessKeySecret`
- API 只接受替换写入，不默认全文返回

### 10.2 日志

- `ProvisionJobStepLog` 继续作为任务排障主入口
- stderr/stdout 摘要保留，但不存过长原文

### 10.3 状态恢复

- worker 重启后，已创建的 workspace 和 state 仍在卷里
- destroy/retry 可以继续复用

## 11. 迁移原则

### 11.1 不动的部分

- 前端拓扑与编译契约
- 当前 `compiledProvisionSpec` 主体结构
- 现有 OpenTofu module 主体

### 11.2 要替换的部分

- `OpenTofuRangeProvisioner.prepareWorkspace()` 当前“直接复制 module”的模式
- API 内存态系统配置
- Compose 单 `api` 执行 provisioning 的模式

## 12. 验证标准

完成后必须能证明：

1. `test` 这类 `zone-1 + 多 ECS` 拓扑能成功构建 workspace
2. 平台内创建实例链路至少通过：
   - `tofu init`
   - `tofu validate`
   - `tofu plan`
3. 在授权窗口内，至少一次真实阿里云 `apply -> outputs -> destroy` 成功
4. Docker 重启后：
   - 云配置不丢失
   - workspace/state 不丢失
   - destroy/retry 仍能继续

## 13. 设计结论

为了让平台真正和你以后“任意自定义拓扑”的形态对齐，平台最终不应该生成一堆不同形状的 OpenTofu 工程，而应该：

- 保持固定的 root wrapper
- 只让平台生成拓扑变量
- 用独立 worker 容器执行 OpenTofu
- 用数据库 + 持久卷承接运行态

这既复用了你以前已经跑通过的 smoke 路径，也最适合最终 Docker 部署。
