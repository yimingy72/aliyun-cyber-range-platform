# 编排实例

管理由靶场模板创建的一整套综合靶场环境。它不是独立训练靶机；若用户给出平台镜像、CPU、内存和数量，应转到 [实例管理](./instance-management.md)。

## 工具与权限

| 操作 | MCP 工具 | Scope |
|---|---|---|
| 查询运行中/历史靶场 | `range_instance_list` | `ranges:read` |
| 查询靶场详情 | `range_instance_get` | `ranges:read` |
| 获取访问入口 | `range_instance_get_access` | `ranges:read` + `instances:credentials:read` |
| 启动整套靶场 | `range_instance_launch` | `ranges:create` |
| 完整销毁靶场 | `range_instance_destroy` | `ranges:destroy` |

## 产品内意图路由

| 用户意图 | 工具与流程 | 参数约束 |
|---|---|---|
| “查正在运行或历史靶场” | `range_instance_list` / `range_instance_get` | `view` 为 `active` 或 `history`；详情使用 `rangeInstanceId`。创建者/管理员的详情可能含自身运行时凭据或入口信息，按敏感输出处理。 |
| “访问靶场入口、SSH、密码” | `range_instance_get_access` | 先有准确 `rangeInstanceId`、明确访问意图和 `instances:credentials:read`。 |
| “基于模板启动整套靶场” | [启动流程](#启动流程) | 需要可见的 `templateId`、名称和 ISO-8601 `expiresAt`。 |
| “释放整套靶场” | [访问与销毁](#访问与销毁) | 使用 `rangeInstanceId`；没有通用“关机”替代操作。 |
| “编辑模板或拓扑” | 转到 [靶场编排](./range-authoring.md) | 启动实例不会修改模板。 |

## 启动流程

1. 用 `range_template_list` / `range_template_get` 定位调用者可见、适合启动的 `templateId`。
2. 向用户确认模板、实例名称和 ISO-8601 `expiresAt`；不要猜测到期时间。
3. 展示将创建整套拓扑与云资源的影响范围，取得确认后调用 `range_instance_launch`。
4. 若服务端返回确认要求，使用相同业务参数、同一幂等键和 `confirmationId` 完成二阶段调用。
5. 查询靶场详情或 `provision_job_get`，仅在终态后报告成功或失败。

启动前不应通过草稿、节点或连线工具临时修改模板来满足某个运行实例；需要不同拓扑时，应先在靶场编排域创建或更新模板并校验。

## 访问与销毁

- `range_instance_get` 可用于常规详情，但资源创建者或管理员的返回可能已含自身运行时凭据或入口信息，必须按 [sensitive-outputs.md](../sensitive-outputs.md) 脱敏处理；明确请求独立访问数据时使用 `range_instance_get_access`，它还需要 `instances:credentials:read`。
- 平台没有“关机”替代工具。用户要求释放整套环境时，确认 `rangeInstanceId` 后使用 `range_instance_destroy`。
- 销毁是完整回收；授权 smoke test 成功后立即销毁，并确认终态。
