# 阿里云综合靶场竞赛平台实施计划

- 日期：2026-06-23
- 状态：当前有效实施基线
- 最近更新：2026-06-24
- 关联设计文档：[2026-06-23-cloud-cyber-range-saas-design.md](/Users/yym/Documents/阿里云For综合靶场竞赛平台/docs/superpowers/specs/2026-06-23-cloud-cyber-range-saas-design.md)
- 当前活跃子计划：[2026-06-23-enterprise-range-bootstrap-plan.md](/Users/yym/Documents/阿里云For综合靶场竞赛平台/docs/superpowers/plans/2026-06-23-enterprise-range-bootstrap-plan.md)

## 1. 计划目标

本计划的目标，不是把平台一次性做成完整 SaaS，而是按最短可验证路径交付一个真正符合需求的第一阶段闭环：

`比赛 -> 队伍 -> 模板 -> 独立企业网络型靶场 -> 公网入口 / 状态 / 日志 -> 整套销毁`

从现在开始，任何实施顺序都必须服从这件事：

- 先做企业网络型靶场骨架
- 再做模板表达能力
- 再做编排与状态日志
- 最后再补后台可视化和可选增强

## 1.1 2026-06-24 进度快照

### 已完成

- 企业网络型 `OpenTofu` 主线已切到 `alicloud-enterprise-range`
- `RangeTemplate.topologySpec` 已能表达固定拓扑蓝图骨架
- `RangeInstance.accessEntry / resourceSummary / errorSummary` 已打通模型、仓储与回写链路
- `ProvisionJob / ProvisionJobStepLog` 已支持详情查询与步骤日志展示
- Worker 已具备原子 claim 能力，同一 `ProvisionJob` 并发执行时不会重复触发底层 provisioner
- 本地 smoke 脚本已兼容 `ALICLOUD_IMAGE_ID` 与 `OPENTOFU_IMAGE_ID` 两套镜像变量口径
- `OpenTofu` 真实执行链路已补 `validate` 预校验步骤，Runner、Provisioner 与 smoke 脚本已统一为 `init -> validate -> plan -> apply/output -> destroy`
- 已新增非破坏性 `plan-only` smoke 入口，可先验证 `init / validate / plan` 再决定是否放行真实创建
- 2026-06-24 已完成一次真实阿里云 RAM 非破坏性联调：
  - `sts GetCallerIdentity` 成功
  - `cn-hangzhou` / `cn-hangzhou-h` 可读
  - 公共镜像查询成功
  - `pnpm iac:smoke:plan` 成功产出 12 个待创建资源的企业网络型靶场执行计划
- 2026-06-24 已完成一次真实阿里云受控创建/销毁联调：
  - 首次 `apply` 暴露出 `cn-hangzhou-h` 不支持 `ecs.c7.large`
  - 切换到 `ecs.t6-c1m2.large` 后，成功创建并销毁：
    - 1 个 VPC
    - 3 个 vSwitch
    - 3 台 ECS
    - 1 个 DMZ EIP 与绑定关系
  - 创建阶段曾得到真实公网入口 `47.98.149.209`
  - 销毁完成后 `terraform.tfstate` 资源数已回到 `0`
- 已将实例规格默认策略从硬编码规格切换为 `auto`：
  - smoke 脚本和 API provisioner 均支持按可用区动态解析真实可售的 ECS 规格
  - 预校验基于 `aliyun ecs DescribeAvailableResource`
  - 若配置了偏好列表，则优先选择偏好列表中当前可售的规格
  - 若偏好列表没有命中，则回退到该可用区返回的首个可售规格
- smoke 清理链路已补强：
  - 即使 `apply` 中途失败，只要 state 中发现残留资源，退出时也会尝试自动 `destroy`
- 管理后台已具备：
  - 比赛、队伍、模板、实例基础管理
  - 实例详情查看
  - 任务中心列表
  - 任务详情与步骤日志查看
  - 直接触发实例 `create / destroy`

### 进行中

- Milestone 3 后端编排主链路仍在继续收口
- 当前已经具备“后台触发任务 + 详情回写 + 步骤日志可见 + OpenTofu 预校验 + 真实云 plan-only 验证”的基础闭环
- 还没有完全收口到“真实阿里云创建/销毁 + 稳定输出解析 + 失败日志固化 + apply/destroy 级别可重复验证”的程度

### 未完成

- 更多地域/可用区下的真实 OpenTofu `apply / destroy` 回归验证
- 真实云输出到 `accessEntry / resourceSummary` 的完整映射验证
- 更稳健的任务重试、执行保护和异常补偿
- 生产化的异步执行形态、过期回收和更完整运维能力

### 下一步建议顺序

1. 把“实例规格预校验/自动解析”的结果继续暴露到任务日志与实例详情
2. 继续做更多地域/可用区的真实回归验证，校准默认偏好列表
3. 视联调结果决定是否把模板级规格偏好纳入 `RangeTemplate.topologySpec`
4. 在后端链路稳定后，再扩展更完整的运维、重试和回收能力

## 2. 当前仓库现实

截至 2026-06-23，仓库里已经存在一些有价值的基础能力，但其中一部分只代表“技术通路验证”，不应继续被当作当前主线。

### 2.1 已有基础

- monorepo、API、Web、Prisma、测试基线已建立
- 后台对象管理已具备基础骨架
- `RangeInstance / ProvisionJob / ProvisionJobStepLog` 已有初步代码结构
- OpenTofu Runner 与阿里云 Provider 验证链路已具备雏形

### 2.2 已有但需要降级定位的内容

- `alicloud-vpc-single-ecs` 模块
- `single-ecs` 示例 root module
- 以 `allocatedCidr` 为中心的部分实现

这些内容可以保留为历史通路验证，但不应再驱动后续里程碑排序。

### 2.3 当前最关键的纠偏点

1. IaC 主线要从 `single-ecs` 切换到 `enterprise-range`
2. `RangeTemplate` 要从“模块壳”升级为“靶场蓝图”
3. `DMZ + EIP` 公网入口要进入核心模型
4. `CIDR 池优先` 要降级为可选增强

## 3. 里程碑重排

### Milestone 0：工程 Bootstrap

状态：已有基础，可视为历史完成阶段

目标：

- 保持工作区、数据库、API、Web 的基础开发体验稳定

### Milestone 1：后台对象与数据基线

状态：核心基线已完成，后续仅按真实编排需求微调

目标：

- `Competition`
- `Team`
- `RangeTemplate`
- `RangeInstance`
- `ProvisionJob`
- `ProvisionJobStepLog`

验收重点：

- 管理后台能稳定管理核心对象
- 实例与任务对象不再停留在“字段存在”，而是服务于真实企业网络靶场场景

### Milestone 2：企业网络型 IaC Bootstrap

状态：骨架已完成，后续进入真实云验证与模块细化

目标：

- 用 OpenTofu 落下第一版真实企业网络型靶场骨架
- 模块目标从 `single-ecs` 升级为：
  - `single-vpc`
  - `multi-vswitch`
  - `multi-ecs`
  - `dmz-eip`

验收重点：

- 示例 root module 能通过 `fmt` 与 `validate`
- 模块输出能明确表达公网入口与资源摘要

### Milestone 3：模板表达与编排主链路

状态：进行中，当前主线

目标：

- 扩展 `RangeTemplate`，表达固定拓扑蓝图
- 将后台操作真正打通到任务系统
- 回写 `accessEntry / resourceSummary / errorSummary`

验收重点：

- 创建任务可为某队伍生成一整套实例
- 后台可看到步骤日志、错误摘要和公网入口
- 真实 OpenTofu 执行结果能稳定回写到实例详情

### Milestone 4：后台可视化与运维操作

状态：部分完成，仍需继续补运维动作

目标：

- 实例列表
- 实例详情
- 任务中心
- 步骤日志页
- 重试与回收操作

验收重点：

- 管理员能知道实例现在是否可用、卡在哪一步、入口是什么、下一步该做什么

### Milestone 5：可选增强

目标：

- CIDR 池正式化
- 过期回收
- 混合云资源模板
- 更多资源类型
- 自动化补偿

说明：

- 只有在前四个里程碑稳定后，才进入这里

## 4. 从现在开始的推荐执行顺序

### 4.1 当前立刻要做

1. 继续把真实 OpenTofu `create / destroy` 执行链路跑通
2. 固化 `accessEntry / resourceSummary` 的真实输出映射
3. 引入阿里云 RAM 测试联调，做非破坏性 smoke test

### 4.2 随后要做

4. 继续补 Worker / Runner / StepLog 的稳定性与重试能力
5. 加强实例销毁、异常实例处理和任务防重入
6. 视联调结果补齐模块变量、初始化脚本与入口策略

### 4.3 最后再做

7. 更完整的管理台运维页面和异常处理视图
8. 可选增强，如自动过期回收、混合云资源、CIDR 池正式化

## 5. 代码结构方向

继续使用当前单仓结构，但主抽象要改为围绕“模板蓝图 + 实例编排”。

```text
apps/
  api/
  web/

packages/
  database/
  iac-runner/

infra/
  opentofu/
    modules/
      alicloud-enterprise-range/
    examples/
      alicloud-enterprise-range/
  packer/

docs/
  superpowers/
    specs/
    plans/
```

说明：

- `alicloud-vpc-single-ecs` 可以保留为历史验证模块
- 当前主验证入口应逐步切到 `alicloud-enterprise-range`

## 6. 当前阶段的验收门槛

### 6.1 Milestone 2 验收门槛

- 企业网络型模块具备多子网、多主机、DMZ EIP 骨架
- `tofu fmt -check -recursive infra/opentofu`
- `tofu validate infra/opentofu/examples/alicloud-enterprise-range`
- 输出中存在公网入口相关字段

### 6.2 Milestone 3 验收门槛

- 后台可创建实例和创建任务
- 任务执行可回写状态与步骤日志
- 实例详情明确展示公网入口和资源摘要
- 至少一条真实阿里云靶场创建/销毁链路完成受控验证

## 7. 明确延期的事项

以下内容不要抢跑：

- 高级 CIDR 池编排
- 完整多云抽象
- 拖拽式拓扑设计器
- 复杂消息队列和微服务拆分
- 判题系统和计分功能

## 8. 风险与应对

### 风险 1：继续沿用旧模块导致主线偏离

应对：

- 旧计划全部标记为历史/废弃基线
- 新实现优先围绕 `enterprise-range` 路径落地

### 风险 2：模板模型改得太晚，后端越做越偏

应对：

- 在编排收口前先升级模板表达能力
- 不要继续围绕 `modulePathOrRef + allocatedCidr` 单薄模型扩展

### 风险 3：把可选能力做成当前核心

应对：

- `CIDR 池`、混合云和自动补偿一律延后
- 先围绕固定拓扑和独立公网入口完成第一阶段闭环

## 9. 会话压缩后的恢复入口

如果后续会话被压缩，优先阅读：

1. [2026-06-23-cloud-cyber-range-saas-design.md](/Users/yym/Documents/阿里云For综合靶场竞赛平台/docs/superpowers/specs/2026-06-23-cloud-cyber-range-saas-design.md)
2. [2026-06-23-cloud-cyber-range-saas-implementation-plan.md](/Users/yym/Documents/阿里云For综合靶场竞赛平台/docs/superpowers/plans/2026-06-23-cloud-cyber-range-saas-implementation-plan.md)
3. [2026-06-23-enterprise-range-bootstrap-plan.md](/Users/yym/Documents/阿里云For综合靶场竞赛平台/docs/superpowers/plans/2026-06-23-enterprise-range-bootstrap-plan.md)

只要先看这三份，就不会再回到旧路线。
