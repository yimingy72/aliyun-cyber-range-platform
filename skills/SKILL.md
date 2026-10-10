---
name: aliyun-cyber-range-operations
description: 通过 aliyun-cyber-range-platform MCP 操作阿里云或腾讯云综合靶场平台，涵盖镜像、单实例、模板编排、运行拓扑、用户、账单和云账号工作空间。创建或编辑拓扑时按项目设计合同转换完整图；查询和管理已有资源不要求提交 RangeDesign。
---

# 综合靶场平台操作

通过 `aliyun-cyber-range-platform` MCP 管理平台业务资源。阿里云与腾讯云使用同一套产品工具，执行能力由所选云账号工作空间决定。

**先读取当前会话的 `tools/list`。运行时 `inputSchema`、`outputSchema`、`annotations`、scope 和服务端资源权限是合同事实源。** 下列产品参考帮助选择工具和解释状态，不替代运行时 schema；工具数量和可见集合随部署、scope、角色而变化。

## 按操作目标选择参考

按用户要做的动作路由，不能仅凭“VPC”“模板”“DNS”等词强制进入创建流程。只读取本次所需产品参考；跨模块任务可依次使用多个参考。

| 前端模块 | 路由标识 | 参考 |
|---|---|---|
| 镜像中心 | `image-center` | [镜像资产、云目录、标签和导入](./references/products/image-center.md) |
| 实例管理 | `instance-management` | [独立主机、批次和共享网络](./references/products/instance-management.md) |
| 靶场编排 | `range-authoring` | [模板查询、设计转换和模板管理](./references/products/range-authoring.md) |
| 编排实例 | `range-instances` | [启动、运行拓扑草稿、预览应用、DNS 和回收](./references/products/range-instances.md) |
| 用户管理 | `user-management` | [空间内用户、角色和状态](./references/products/user-management.md) |
| 账单费用 | `billing` | [官方费用、平台归属和待核对状态](./references/products/billing.md) |
| 基础配置 | `settings` | [账号绑定、工作空间切换和地域](./references/products/settings.md) |

- 查询已有模板、查看 VPC/ACL、管理模板名称或发布状态：直接走相应只读/管理工具，无需 `RangeDesign/v1`。
- 新建或替换模板拓扑：先读靶场编排参考。用户提供 YAML 时严格解析 `RangeDesign/v1`，拒绝重复键、截断字段和歧义；使用可见平台镜像转换为完整 `topologyGraph`。既有完整图可基于最新详情修改，不要求往返重写成 YAML。
- 修改已启动编排的规则或节点：走编排实例参考，以当前详情为基线保存草稿、预览准确版本、应用；不能通过重建整套实例实现修改。
- “创建实例”无法从上下文判断是镜像单实例还是模板编排时，先澄清这一个区别。删除、回收和关闭必须能确定单台、批次或整套范围。
- DNS 表单数据使用独立 `dns` 字段；平台生成的 DNS 设置/核验脚本属于内部执行内容，不写回用户 `initScript`。DNS 核验失败不能作为重建理由。

## 工作空间与权限

厂商和主账号共同确定数据空间，镜像、模板、实例、用户和账单 ID 不可跨空间复用。必要时用 `cloud_workspace_list` 定位空间；显式 `x-cloud-workspace-id` 请求头优先于用户默认空间。`cloud_workspace_switch` 仅改变默认选择，不覆盖连接固定的请求头，也不改变已受理作业冻结的账号。

用当前会话已有的最小 `list`/`get` 事实确认准确 ID、状态、owner 和可见性，不反复查询已有新鲜事实。工具可见、scope 足够、管理员角色和平台超管身份是不同条件。不可访问的空间或目标必须停止，不能回落到其它账号。

仅通过 MCP 操作平台业务资源；不得绕过网关改用 HTTP API、数据库或云 CLI。代码开发、离线合同测试和用户明确授权的网络数据面探测不属于此业务接口限制，仍按项目 Docker 和测试范围要求执行。

## 用户授权与平台确认

用户对动作、目标和影响范围的明确授权持续有效。已授权的受控测试包含约定范围内的创建、变更与立即清理；不因每一步或每个服务端挑战重复询问。平台服务端确认仍须完成，授权不会放宽 scope、所有权、草稿版本或幂等合同。

首次调用可能直接受理，也可能返回 `isError: true` 且 `result.error.code=CONFIRMATION_REQUIRED`。核对服务端摘要与已获授权一致后，使用完全相同业务参数、返回的 `confirmationId` 和要求的 `idempotencyKey` 完成第二阶段。若新增资源规模、删除范围、发布可见性或敏感输出超出已有授权，先展示具体变化，再取得所缺授权。

- `confirmationId` 只能取服务端实际返回值，不能猜测、跨用户/空间/目标使用。
- 同一请求及未知结果恢复保持原幂等键；新业务请求使用新键。只在 schema 或响应要求/支持时传入操作元数据。
- 写入模板或运行草稿本身不创建云资源，但仍须属于用户请求；真正应用、启动和销毁按各工具合同执行。
- 用户明确索要密码、SSH、VNC 或凭据 CSV 时读取 [敏感输出](./references/sensitive-outputs.md)。授权云测试不自动授权披露全部凭据。

## 执行结果与异步证据

工具结构化结果为 `{ result: ... }`，成功业务字段和 `{ result: { error: ... } }` 失败/确认挑战都由 `outputSchema` 描述。读取 `isError` 与错误码后再解释结果；不能把符合 schema 的错误 envelope 当成成功。

创建、应用、销毁和打包返回 ID 或作业只表示已受理。调用响应可能使用 `jobId`、`provisionJobId` 或 `lastJobId`；取得实际作业 ID 后统一传给下表的 `provisionJobId` 参数。超时或结果未知先读原资源/作业，不盲目重试创建或更换幂等键。

| 操作 | MCP 工具 | 必填参数 | 可选参数 | Scope | 用途 |
|---|---|---|---|---|---|
| 查询异步任务 | `provision_job_get` | `provisionJobId` | `includeEvidence: boolean` | `jobs:read` | 查看状态与脱敏失败摘要；证据包括同来源库存、固定阶段、相关作业和资源台账释放时间。 |

证据、DNS 核验、云网络诊断和正式账单各有不同含义：云资源 Running 不证明客体 DNS 生效；网络诊断完成不证明流量连通；`verify_destroy`/`releasedAt` 不证明官方费用已结清；未出账不等于免费。只报告当前证据能支持的结论。

受控测试完成立即销毁约定测试云资源并核对回收终态，保留历史作业和计费来源。失败、UNKNOWN 或库存冲突时先定位原请求与剩余资源，按 [错误处理](./references/error-handling.md) 恢复，不能清除审计记录或通过新建替代回收。
