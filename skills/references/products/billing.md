# 账单费用

严格对应前端“账单费用”页面，仅管理员可见、可调用。账单数据来自平台已同步的阿里云 BSS 数据和本地资源归属台账；不能用实例价格、云厂商 CLI 或猜测值代替账单工具。

## 工具与权限

| 前端功能 | MCP 工具 | Scope | 说明 |
|---|---|---|---|
| 费用概览 | `billing_summary_get` | `billing:read` | 总费用、平台费用、异常数、按资源类型和日期汇总。 |
| 用户费用列表 | `billing_user_list` | `billing:read` | 按费用降序返回用户汇总。 |
| 单个用户概览 | `billing_user_summary_get` | `billing:read` | 指定用户的费用、条目数和启动次数。 |
| 用户费用分组 | `billing_user_group_list` | `billing:read` | 按启动记录和未归属项分组，可选按用户过滤。 |
| 平台费用分组 | `billing_platform_group_list` | `billing:read` | 平台归属资源的费用分组。 |
| 用户费用明细 | `billing_user_item_list` | `billing:read` | 指定用户的原始费用条目。 |
| 平台费用明细 | `billing_platform_item_list` | `billing:read` | 平台归属资源的原始费用条目。 |
| 异常列表 | `billing_anomaly_list` | `billing:read` | 未能正常归属的账单条目及原因。 |
| 同步账单 | `billing_sync` | `billing:sync` | 从阿里云 BSS 刷新日期范围内的本地账单。 |
| 导出平台费用 | `billing_export_platform_csv` | `billing:read` | 平台费用概览 CSV。 |
| 导出用户费用 | `billing_export_users_csv` | `billing:read` | 用户费用汇总 CSV。 |
| 导出用户明细 | `billing_export_user_csv` | `billing:read` | 指定用户的费用条目 CSV。 |

## 参数约束

- 所有费用查询和导出都可传 `startAt`、`endAt`，格式为 `YYYY-MM-DD`；两者必须同时提供或同时省略。查询省略时使用平台默认统计窗口。
- 分组、明细和用户列表可传 `limit`，范围为 1–500。
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
