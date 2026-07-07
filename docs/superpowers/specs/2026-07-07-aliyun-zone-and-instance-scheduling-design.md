# Alibaba Cloud Zone And Instance Scheduling Design

- 日期：2026-07-07
- 状态：提案已确认，待评审后拆 implementation plan
- 范围：`靶场编排 -> 创建实例 -> zone 调度 -> ECS 规格选择 -> OpenTofu/阿里云创建`

## Goal

把当前“固定 `defaultZoneId` + 固定实例规格映射”的创建链路，升级成：

- `region` 固定绑定平台基础配置中的 `defaultRegion`
- 默认优先使用 `defaultZoneId`
- 默认 zone 不可用时，仅在同一 `region` 内动态选择其他 `zone`
- ECS 规格优先使用 `经济型 e family`
- 在候选 `zone` 中按“纯可创建优先，价格次级排序”选择最终落点

目标不是引入跨地域调度，也不是做跨 zone 拓扑；目标是让单个靶场实例仍保持“单 region / 单 zone”一致，同时显著提升可创建率并控制成本。

## Current State

### 已有能力

- 平台基础配置已持久化：
  - `defaultRegion`
  - `defaultZoneId`
  - `accessKeyId`
  - `accessKeySecret`
- ECS 属性面板已支持：
  - 输入 `CPU/内存`
  - 调用后端查询当前默认 zone 下是否存在精确匹配的 `X86 + 按量 + VPC` 规格
- OpenTofu 创建链路已支持：
  - 多 `switch`
  - 多 `ECS`
  - 同一实例内所有 `vSwitch / ECS / ENI` 绑定到单一 `zone`

### 当前问题

当前链路的主要限制有三类：

1. `zone` 选择过于刚性  
   当前创建时实际依赖单一 `defaultZoneId`，默认 zone 不可用时，没有完整的“同 region 动态回退”机制。

2. 规格策略过于静态  
   当前更接近“固定 `CPU/内存 -> instanceType`”或“默认偏好列表取首个可用项”，没有把 `经济型 family` 作为明确的一等优先级。

3. 同规格多 SKU 时缺少统一调度规则  
   例如 `2C2G` 可能同时存在：
   - `ecs.e-c1m1.large`
   - `ecs.u1-c1m1.large`
   - `ecs.t6-c1m1.large`
   - `ecs.ic5.large`

   当前平台缺少“经济型优先 + 价格次级排序”的稳定策略。

## Product Constraints

本设计确认以下硬约束：

1. `region` 固定  
   创建靶场实例时，所有资源仅允许落在平台基础配置里的 `defaultRegion`。  
   例如当前配置是 `cn-hangzhou`，则本次实例创建过程中绝不跨出 `cn-hangzhou`。

2. 单实例保持单 zone  
   同一个靶场实例中的：
   - `vSwitch`
   - `ECS`
   - `ENI`
   - `NAT / EIP`

   都必须绑定到同一个最终选中的 `zone`。  
   本设计不引入跨 zone 拓扑。

3. 默认 zone 优先  
   平台始终优先尝试 `defaultZoneId`。只有默认 zone 不可承载当前拓扑时，才进入动态 zone 调度。

4. 规格选择目标  
   在满足可创建的前提下，平台默认优先选择 `经济型 e family` 规格。

## Scheduling Strategy

### 1. Fast Path

创建靶场实例时，平台先读取：

- `defaultRegion`
- `defaultZoneId`
- 本次拓扑中每台 ECS 的目标 `CPU/内存`
- 每台 ECS 的镜像约束

然后直接对 `defaultZoneId` 做一次“整套拓扑是否可创建”的预判：

- 该 zone 下本次拓扑里的每台 ECS 是否都存在可售候选规格
- 候选规格必须满足：
  - `X86`
  - `按量付费`
  - `VPC`
  - 与该 ECS 目标 `CPU/内存` 兼容
- 镜像在当前 `region` 内可用

如果默认 zone 满足所有 ECS，直接使用该 zone，不再查询其他 zone。

### 2. Dynamic Fallback

只有当 `defaultZoneId` 无法承载本次拓扑时，平台才进入动态 zone 调度。

动态调度步骤：

1. 实时发现当前 `defaultRegion` 下当前账号可见的 `zone`
2. 排除：
   - 当前已经失败的 `defaultZoneId`
   - 状态异常或不可用的 `zone`
3. 对剩余候选 zone 做整套拓扑级评估

## Zone Discovery And Scoring

### Discovery

候选 `zone` 不通过静态配置维护，而通过阿里云实时发现。

原因：

- 切换阿里云账号后，可见的 `zone` 集可能变化
- 不同账号、不同资源权限、不同资源状态下，固定字母排序不可靠

### Zone Feasibility

对每个候选 `zone`，平台不只检查“是否能起一台 ECS”，而是检查：

- 本次拓扑里的每台 ECS，在该 zone 是否都能找到至少一个可售候选规格

只要有任意一台 ECS 在该 zone 无法满足，整个 zone 直接判定为：

- `canCreateAllHosts = false`

### Zone Ranking

候选 `zone` 的排序规则固定为两层：

1. 纯可创建优先  
   不能承载整套拓扑的 zone 直接淘汰。

2. 价格次级排序  
   对能完整承载整套拓扑的 zone，计算该 zone 下“整套拓扑所有 ECS 的预估总价”，总价越低越优先。

### Tie Break

如果多个 `zone` 都可以完整创建且总价相同：

- 使用稳定顺序作为最终 tie-break
- 推荐使用阿里云返回顺序或平台内部固定排序，避免每次抖动

## Instance Type Selection

### Core Rule

平台不把“同一 `CPU/内存` 只映射成唯一一个永久 SKU”作为唯一真理，而是引入：

- 默认首选 SKU
- 候选回退 SKU

### Family Priority

默认优先级如下：

1. `e` 经济型 family
2. `u1`
3. `t6`
4. 其它同档位 X86 通用型/计算型候选

### Example Candidate Sets

示例候选：

- `2C2G`
  - `ecs.e-c1m1.large`
  - `ecs.u1-c1m1.large`
  - `ecs.t6-c1m1.large`
  - 其它同档位 X86 候选

- `4C8G`
  - `ecs.e-c1m2.xlarge`
  - 其它同档位 X86 候选

- `8C16G`
  - `ecs.e-c1m2.2xlarge`
  - 其它同档位 X86 候选

### Selection Within One Zone

对某个候选 `zone` 中的某一台 ECS，规格选择顺序为：

1. 过滤不可售规格
2. 过滤非 X86
3. 过滤非按量付费
4. 按 family 优先级排序
5. 在同 family 候选中按实时价格升序排序
6. 同价时按平台内置稳定顺序选中

### “热门推荐”标签

控制台里的“热门推荐”仅作为人类观察参考，不作为调度主逻辑。

原因：

- 更像控制台展示语义
- 不适合作为后端稳定契约

后端主判断仍是：

- 可售
- X86
- 按量付费
- family 优先级
- 实时价格

## Runtime Pricing

价格只在以下场景参与：

- `defaultZoneId` 失败后
- 候选 `zone` 之间比较
- 候选规格之间比较

价格不是第一层过滤条件，只是第二层排序条件。

这意味着：

- 默认 zone 命中时，不额外做大规模比价
- 只有动态 fallback 阶段才做价格比较
- 这样可以把调度耗时控制在较低范围

### Expected Latency

工程预估：

- 默认 zone 快路径：`0.5s - 2s`
- fallback 到候选 zone 动态排序：`2s - 5s`

不建议做“每次创建都全 region 穷举所有 zone + 所有规格 + 所有价格”的全量探测，否则延迟会显著增加，但收益有限。

## Retry State Machine

### Stage 1

尝试 `defaultZoneId`

- 成功预判：直接创建
- 失败预判：进入候选 zone 动态调度

### Stage 2

选出最优候选 `zone`

- 绑定本次实例所有 `vSwitch / ECS / ENI / NAT / EIP`

### Stage 3

真实创建

即使预判通过，真实创建阶段仍可能因库存瞬时变化失败，因此需要重试状态机。

### Retryable Failures

可重试失败包括但不限于：

- 目标实例规格库存不足
- 当前 zone 临时不可售
- zone 内资源瞬时不足

### Non-Retryable Failures

不可重试失败包括但不限于：

- 模板配置错误
- 镜像 ID 无效
- AK/SK 或权限错误
- 硬性配额问题导致整个 `region` 都无法创建

### Retry Policy

当发生可重试失败时：

- 当前 zone 标记失败
- 切到下一个候选 zone
- 重新执行整套创建流程

当发生不可重试失败时：

- 立即终止
- 不继续切 zone

### Retry Bound

- 每个 zone 只尝试一次
- 候选 zone 耗尽后，实例进入 `create_failed`
- 错误信息需带：
  - 已尝试的 zone 列表
  - 每个 zone 的失败摘要
  - 最终失败原因

## Observability

平台实例详情 / 任务日志中，至少应保留：

- `requestedRegion`
- `defaultZoneId`
- `attemptedZones`
- `selectedZone`
- 每个 zone 的：
  - 可创建结论
  - 估算总价
  - 失败摘要
- 每台 ECS 的：
  - 请求 `CPU/内存`
  - 候选规格列表
  - 最终选中的 `instanceType`
  - 选择原因

## Non-Goals

本设计明确不覆盖：

- 跨 region 调度
- 一个靶场实例跨多个 zone 混布
- 基于控制台“热门推荐”标签直接驱动调度
- 完整资源容量预测（例如提前精确保证后续所有创建百分百成功）

## Rollout Suggestion

推荐按两阶段落地：

### Phase 1

- 固定 `defaultRegion`
- 默认 `defaultZoneId` 快路径
- 默认 zone 失败后，启用同 region 动态 zone 发现
- 规格优先使用 `e family`

### Phase 2

- 引入更细粒度的价格排序
- 引入更完整的 zone 评分与失败归因
- 补实例详情中的调度过程可观测性

## Acceptance Criteria

满足以下条件视为设计目标达成：

1. 平台创建实例时只使用平台基础配置中的 `defaultRegion`
2. 默认优先使用 `defaultZoneId`
3. 默认 zone 不可用时，平台能自动发现同 region 其它 zone 并排序
4. 排序遵循：
   - 纯可创建优先
   - 价格次级排序
5. 规格选择默认优先 `经济型 e family`
6. 单个靶场实例中的所有 `vSwitch / ECS / ENI` 保持单 zone 一致
7. 真实创建时若发生库存类失败，平台能自动切换下一个候选 zone 重试
8. 平台能记录每次 zone 选择、失败与最终落点
