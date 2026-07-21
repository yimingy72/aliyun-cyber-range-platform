# 独立靶机规格

仅在创建独立靶机，或用户询问 CPU、内存、磁盘、数量、到期时间或可用规格时读取本文件。

## 可用性校验

创建前使用 `single_instance_spec_check(cpu, memory)`。它只读检查默认地域、可用区、VPC、按量付费和系统盘类型下，单实例执行器支持的精确 X86 规格。

- 仅当返回 `exactAvailable: true` 时才可紧邻发起首次 `single_instance_batch_launch`。
- 返回 `false`、工具报错或超时，均不得创建；向用户说明原因并请求其重新选择。
- CPU 或内存变化后必须重新校验；不能复用旧结果。
- 成功结果不预留库存，亦不保证镜像兼容性、配额或发起创建瞬间仍有库存。MCP 服务端会在每次创建调用时再次校验。

下列静态组合定义了当前单实例执行器支持的候选 SKU；动态校验只会在该范围内返回可创建结果。

| CPU | 内存 | 当前候选实例族 |
|---:|---:|---|
| 2 核 | 2 GiB | `ecs.e-c1m1.large`、`ecs.u1-c1m1.large`、`ecs.t6-c1m1.large` |
| 2 核 | 4 GiB | `ecs.e-c1m2.large`、`ecs.u1-c1m2.large` |
| 4 核 | 8 GiB | `ecs.e-c1m2.xlarge`、`ecs.u1-c1m2.xlarge` |
| 8 核 | 16 GiB | `ecs.e-c1m2.2xlarge` |

不要使用表外 CPU/内存组合：`single_instance_spec_check` 会明确拒绝，不能绕过校验直接创建。

## 其他创建参数

| 参数 | 规则 |
|---|---|
| `systemDiskSize` | 可省略；服务端默认 40 GiB。显式传入时必须是整数且至少 20 GiB。 |
| `quantity` | 必填，整数 1–99。仅当用户明确说“一个/一台”时才可取 1。 |
| `expiresAt` | 可省略；服务端默认首次请求后 8 小时。显式传入时必须是 ISO-8601 的未来时点。若服务端要求二次确认，必须使用确认摘要返回的精确 `expiresAt` 重放，不能在第二次调用重新计算。 |
| `hostName`、`password`、`remark` | 可选；仅在用户明确需要时传入。 |

## 创建策略

1. 先用 `platform_image_list` 选择调用者可消费且已启用的平台镜像。
2. 向用户确认 CPU/内存、数量和到期时间；用户未指定到期时间时，可使用服务端默认的 8 小时，并在确认摘要中向用户展示精确到期时刻。
3. 用相同 CPU/内存调用 `single_instance_spec_check`；只有 `exactAvailable: true` 才继续。
4. 以稳定 `idempotencyKey` 发起首次 `single_instance_batch_launch`。若服务端返回 `confirmationId`，展示目标、镜像、规格、数量、到期时间和影响摘要，取得用户确认后，用完全相同的业务参数、同一幂等键和该 `confirmationId` 第二次调用。
5. 不要在校验与首次创建之间改动 CPU/内存；改动后重新校验。不要把校验结果或 `confirmationId` 当作用户授权。
