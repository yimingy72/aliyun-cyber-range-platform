# 账单费用

严格对应前端“账单费用”页面，仅管理员可见、可调用。账单数据来自平台已同步的阿里云 BSS 数据和本地资源归属台账；不能用实例价格、云厂商 CLI 或猜测值代替账单工具。

## MCP 工具与参数

日期窗口中的 `startAt` 与 `endAt` 均为 `YYYY-MM-DD`，必须同时提供或同时省略。`limit` 范围为 1–500。

| 前端功能 | MCP 工具 | 必填参数 | 可选参数 | Scope |
|---|---|---|---|---|
| 费用概览 | `billing_summary_get` | — | 日期窗口 | `billing:read` |
| 用户费用列表 | `billing_user_list` | — | 日期窗口、`limit` | `billing:read` |
| 单个用户概览 | `billing_user_summary_get` | `userId` | 日期窗口、`limit` | `billing:read` |
| 用户费用分组 | `billing_user_group_list` | — | `userId`、日期窗口、`limit` | `billing:read` |
| 平台费用分组 | `billing_platform_group_list` | — | 日期窗口、`limit` | `billing:read` |
| 用户费用明细 | `billing_user_item_list` | `userId` | 日期窗口、`limit` | `billing:read` |
| 平台费用明细 | `billing_platform_item_list` | — | 日期窗口、`limit` | `billing:read` |
| 异常列表 | `billing_anomaly_list` | — | 日期窗口、`limit` | `billing:read` |
| 同步账单 | `billing_sync` | — | 日期窗口；不接受操作元数据 | `billing:sync` |
| 导出平台费用 | `billing_export_platform_csv` | — | 日期窗口 | `billing:read` |
| 导出用户费用 | `billing_export_users_csv` | — | 日期窗口 | `billing:read` |
| 导出用户明细 | `billing_export_user_csv` | `userId` | 日期窗口 | `billing:read` |

## 参数约束

- `billing_user_*` 需要准确 `userId`；先从 `billing_user_list` 或 `admin_user_list` 获取，不能用用户名代替。
- `billing_sync` 省略日期范围时同步最近 7 天；传入日期范围时按该范围同步。同步会刷新本地归属数据，但不创建、修改或销毁云资源。
- 所有工具的结构化结果在 `result` 下，具体字段以运行时 `outputSchema` 为准。

## 产品内意图路由

| 用户意图 | 工具与流程 |
|---|---|
| “总费用、趋势、资源类型费用” | `billing_summary_get` |
| “哪个用户花了多少、某个用户费用” | `billing_user_list`，必要时 `billing_user_summary_get` |
| “费用对应哪次启动、资源明细” | 用户范围使用 `billing_user_group_list` / `billing_user_item_list`；平台范围使用 `billing_platform_group_list` / `billing_platform_item_list` |
| “异常费用、无法归属费用” | `billing_anomaly_list` |
| “刷新、同步账单” | `billing_sync`；先展示日期范围并获得确认 |
| “导出账单 CSV” | 对应 `billing_export_*`；只在用户明确要求导出时调用 |

## 推荐流程

1. 确认调用者具备管理员身份以及 `billing:read` 或 `billing:sync` scope。
2. 需要概览时先调用 `billing_summary_get`；需要用户维度时再调用 `billing_user_list`。
3. 需要资源归因时优先读分组；只有确实需要逐条账单时才读明细，避免扩大数据范围。
4. 同步前展示精确日期范围和影响，取得用户确认后调用 `billing_sync`；同步成功后重新查询概览或明细。
5. 导出时仅报告文件名、行数和非敏感摘要；不要在普通回复中粘贴完整 CSV。
