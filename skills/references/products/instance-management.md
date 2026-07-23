# 实例管理

管理基于平台镜像创建的独立训练靶机和批次。它不同于基于靶场模板启动整套环境；后者见 [编排实例](./range-instances.md)。

## 工具与权限

| 操作 | MCP 工具 | Scope |
|---|---|---|
| 查询单实例/批次 | `single_instance_list`、`single_instance_get` | `instances:read` |
| 查询访问凭据 | `single_instance_get_access` | `instances:read` + `instances:credentials:read` |
| 校验规格 | `single_instance_spec_check` | `instances:read` |
| 创建批次 | `single_instance_batch_launch` | `instances:read` + `instances:create` |
| 销毁单台/整批 | `single_instance_destroy`、`single_instance_batch_destroy` | `instances:destroy` |
| 重试/重启 | `single_instance_retry`、`single_instance_reboot` | `instances:control` |
| 打开 VNC | `single_instance_open_vnc` | `instances:control` + `instances:credentials:read` |
| 打包镜像 | `single_instance_pack_image` | `instances:control` |
| 导出凭据 CSV | `single_instance_batch_export_csv` | `instances:read` + `instances:credentials:read` |

## 产品内意图路由

| 用户意图 | 工具与流程 | 参数约束 |
|---|---|---|
| “查实例、批次或历史记录” | `single_instance_list` / `single_instance_get` | `view` 为 `active` 或 `history`；详情需要 `singleInstanceId`。创建者/管理员的详情可能含自身运行时凭据，按敏感输出处理。 |
| “看密码、SSH、VNC、导出凭据” | `get_access`、`open_vnc` 或 CSV 导出 | 必须有明确的凭据请求及 `instances:credentials:read`；属于敏感输出。 |
| “创建一台/一批靶机” | [创建独立靶机](#创建独立靶机) | 镜像、CPU、内存、数量和最终到期时间必须明确；先做规格校验。 |
| “销毁、重试、重启” | [生命周期与状态](#生命周期与状态) | 区分单台 `singleInstanceId` 与整批 `batchId`；`retry` 不等于重启。 |
| “将实例打成镜像” | `single_instance_pack_image` | 要求 `singleInstanceId`；这是创建私有镜像资产，不是导出文件。 |

## 创建独立靶机

1. 用 `platform_image_list` 选择调用者可见且启用的平台镜像。
2. 向用户确认镜像 ID、CPU、内存、数量、到期时间和影响范围；不要从历史实例或云厂商习惯推断。`quantity` 为 1–99，系统盘省略时服务端默认 40 GiB。用户未给到期时间时，Skill 计算当前时间加 8 小时并将得到的 ISO-8601 `expiresAt` 显式传入；这不是服务端默认值，确认摘要必须展示该实际到期时间。
3. 以完全相同的 CPU/内存调用 `single_instance_spec_check`。只有 `exactAvailable: true` 才能立即创建；校验失败、报错、超时或规格改变时均停止。
4. 取得危险操作确认后调用 `single_instance_batch_launch`。若服务端要求确认，按 [confirmation.md](../confirmation.md) 的二阶段流程重试。
5. 返回批次/实例/作业 ID 仅代表受理；查询实例或 `provision_job_get` 至终态。

### 创建参数与规格边界

`single_instance_spec_check(cpu, memory)` 校验默认地域、可用区、VPC、按量付费与系统盘类型下的精确 X86 规格；成功不预留库存，也不保证镜像兼容性或配额。当前候选组合为：

| CPU | 内存 | 候选实例族 |
|---:|---:|---|
| 2 核 | 2 GiB | `ecs.e-c1m1.large`、`ecs.u1-c1m1.large`、`ecs.t6-c1m1.large` |
| 2 核 | 4 GiB | `ecs.e-c1m2.large`、`ecs.u1-c1m2.large` |
| 4 核 | 8 GiB | `ecs.e-c1m2.xlarge`、`ecs.u1-c1m2.xlarge` |
| 8 核 | 16 GiB | `ecs.e-c1m2.2xlarge`、`ecs.u1-c1m2.2xlarge` |

不要使用表外组合或绕过校验。`systemDiskSize` 显式传入时必须是整数且至少 20 GiB；`hostName`、`password` 和 `remark` 仅在用户明确要求时传入。密码是敏感输入，创建响应或后续摘要中不得回显。

## 生命周期与状态

- `retry` 只用于创建或销毁失败的实例；先刷新状态，不能把它当成普通重启。
- `reboot` 只对运行中的单台实例使用；它不接受镜像或创建参数。`displayName`、`defaultHostName`、`defaultPassword`、`description` 等可选动作字段仅在用户明确要求时传入。
- 销毁需确认范围是单台还是整个 `batchId`，并跟踪销毁终态。
- `single_instance_pack_image` 会从单实例创建私有镜像资产；它不是简单导出，且可能涉及默认凭据。

## 敏感访问与导出

`get_access`、VNC、凭据 CSV 和打包镜像可能返回秘密。仅在用户明确要求访问数据且 scope 足够时调用；详细规则见 [sensitive-outputs.md](../sensitive-outputs.md)。
