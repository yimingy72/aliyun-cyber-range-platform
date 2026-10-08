# 账单费用

查询、同步和导出平台账单。账单金额以平台已同步的阿里云 BSS 数据和本地归属台账为准。

## MCP 工具与参数

`startAt` 与 `endAt` 均为 `YYYY-MM-DD`，必须同时提供或同时省略。`billing_user_list`、`billing_user_group_list` 和 `billing_platform_group_list` 支持 `page`（正整数，默认 1）与 `pageSize`（20、50 或 100，默认 20）。其他查询与导出不接受分页参数。

| 操作 | MCP 工具 | 必填参数 | 可选参数 | Scope |
|---|---|---|---|---|
| 费用概览 | `billing_summary_get` | — | `startAt`、`endAt` | `billing:read` |
| 用户费用列表 | `billing_user_list` | — | `startAt`、`endAt`、`page`、`pageSize` | `billing:read` |
| 单个用户概览 | `billing_user_summary_get` | `userId` | `startAt`、`endAt` | `billing:read` |
| 用户费用分组 | `billing_user_group_list` | — | `userId`、`startAt`、`endAt`、`page`、`pageSize` | `billing:read` |
| 平台费用分组 | `billing_platform_group_list` | — | `startAt`、`endAt`、`page`、`pageSize` | `billing:read` |
| 用户费用明细 | `billing_user_item_list` | `userId` | `startAt`、`endAt` | `billing:read` |
| 平台费用明细 | `billing_platform_item_list` | — | `startAt`、`endAt` | `billing:read` |
| 异常列表 | `billing_anomaly_list` | — | `startAt`、`endAt` | `billing:read` |
| 同步账单 | `billing_sync` | — | `startAt`、`endAt`；不接受操作元数据 | `billing:sync` |
| 导出平台费用 | `billing_export_platform_csv` | — | `startAt`、`endAt` | `billing:read` |
| 导出用户费用 | `billing_export_users_csv` | — | `startAt`、`endAt` | `billing:read` |
| 导出用户明细 | `billing_export_user_csv` | `userId` | `startAt`、`endAt` | `billing:read` |

## 操作规则

- `billing_user_*` 使用准确 `userId`，先从 `billing_user_list` 或 `admin_user_list` 获取。
- 概览和导出仅统计已关联本地资源台账的账单。带 `CreatedBy=cyber-range-platform` 和 `PlatformScope` 标记的具体资源会自动补齐台账并归属到用户或平台。
- OSS 仅在 BSS 明确给出当前镜像导入 Bucket 的标识时计入该平台桶，覆盖存储、流量和请求等账单项；只包含地域和存储类型的 OSS 聚合行不会入账。
- 地域级快照链容量只有在 BSS 明确给出带平台标记的具体快照资源时才入账；未提供具体资源标识的地域聚合行不会计入平台费用。
- 资源归因优先读分组，确需逐条账单时再读明细；`billing_anomaly_list` 可用于查看未归属的聚合费用。
- `billing_sync` 显式提供日期时精确刷新该范围；省略日期时默认最近 7 个完整账期，并从该云账号已落库账单的最新 `billingDate`（包含该日）增量同步。同步以当前已验证云账号 UID 和日期为界，原子替换本账号该日的数据，不覆盖其它账号历史；未知 UID 历史仅在已有台账明确证明归属时回填。
- 账期采用 UTC+8（上海）。今天和未来日期不会替换已有账单，响应会返回 `deferredDates`。阿里云 BSS 数据有延迟，初次查询新资源没有账单不能判定费用为零；费用验证应优先选择至少两天前的完整账期，并与实际 BSS 资源 ID、账号、用户、批次/实例归属逐项核对。
- 多币种费用不换算、不相加。`currencyTotals`/`amounts` 按币种返回金额；单币种保留数字汇总并附 `currency`，多币种的总金额为 `null`。用户列表先按币种、再在同币种内按费用排序。CSV 同样按币种分列。
- CSV 仅在用户明确要求导出时生成；只报告文件名、行数和非敏感摘要。
