# 账单费用

查询、同步和导出平台账单。账单金额以平台已同步的阿里云 BSS / 腾讯云官方费用明细和本地归属台账为准。

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
- 所有概览、明细、用户费用和导出仅统计有平台创建来源证明的资源账单，再按用户或平台公共资源分配。收录外部镜像、配置现有 Bucket 或仅有平台标签，不等于平台创建；外部资源费用不纳入平台账单。
- OSS 需要资源级账单与平台创建、专属使用的归属证明，覆盖可证明的平台存储、流量和请求费用。仅有当前镜像导入 Bucket 配置或包含地域和存储类型的账号聚合账单不足以归属；混用存储桶不得把整桶费用归入平台。
- 快照费用必须关联平台创建快照或平台创建来源链的官方明细金额；仅带标签或只有地域级聚合金额不足以归属，不按容量或数量估算真实费用。
- 资源归因优先读分组，确需逐条账单时再读明细；`billing_anomaly_list` 仅返回已证明平台创建的精确异常账单。账户级聚合费用不展示为平台待分配金额；已知平台资源暂时缺少细分账单或归属证明时，必须保留对账提示，不能据此声称平台费用已全部对齐。
- `billing_sync` 显式提供日期时精确刷新该范围；省略日期时重新同步最近 7 个完整账期，覆盖迟到的账单和调整。同步以当前已验证云账号 UID 和日期为界，原子替换本账号该日的数据，不覆盖其它账号历史；未知 UID 历史仅在已有台账明确证明归属时回填。
- API 默认每六小时重刷上月及本月已结束的账日，覆盖月结修订；worker 不启动重复定时器。更早历史调整仍需按明确日期补刷。
- 概览 `billingScope=platform_resources` 确认统计范围仅为平台创建资源；缺失时范围未知，不能把旧接口的账号级金额重新标为平台支出。`billingStatus=provisional` 表示金额仍可能随 BSS 出账、退款或调整变化；`unallocatedCurrencyTotals` 和 `anomalyCount` 仅包含已证明属于平台但尚未完成分配的精确费用，不加到用户或平台公共金额。`resourcesWithoutBillCount` 仅统计选定时间范围内平台创建台账尚未匹配账单的可能计费资源；`reconciliationIssues` 按快照或 OSS 类型列出已知平台资源的待核对数量与原因；`unknown` 表示平台创建链已知但历史账号或归属来源待核验，均不包含账号聚合金额。字段缺失表示未知，待出账不代表免费。应付费用采用 BSS `PretaxAmount`，不把现金支付、优惠券抵扣或原价重复相加。
- 账期采用 UTC+8（上海）。今天和未来日期不会替换已有账单，响应会返回 `deferredDates`。阿里云 BSS 数据有延迟，初次查询新资源没有账单不能判定费用为零；费用验证应优先选择至少两天前的完整账期，并与实际 BSS 资源 ID、账号、用户、批次/实例归属逐项核对。
- 多币种费用不换算、不相加。`currencyTotals`/`amounts` 按币种返回金额；单币种保留数字汇总并附 `currency`，多币种的总金额为 `null`。用户列表先按币种、再在同币种内按费用排序。CSV 同样按币种分列。
- CSV 仅在用户明确要求导出时生成；只报告文件名、行数和非敏感摘要。

## 腾讯云费用明细

- 国内站通过 `DescribeBillDetail` 拉取完整月度官方费用明细，再按 UTC+8 `BillDay` 精确刷新请求的已结束账日。使用费用账单，不使用消耗摊销、价格估算或用量试算代替官方账单。分页最多 300 行，携带上一页 `Context`；`Total` 有 24 小时缓存，可能少于实际记录数，因此以完整末页结束，重复行、缺页、账号或日期冲突均保留旧数据。接口仅提供最近 18 个月的数据。参见 [官方费用明细 API](https://cloud.tencent.com/document/api/555/19182)。
- 逐收费组件保存 `ComponentSet.RealCost`，该字段是优惠后总价，国内站单位为元（CNY）。退款和调整保留官方正负号；原价、现金、代金券、赠送金、分成金均不重复加入优惠后总价。CVM 系统盘组件保留在其官方 `ResourceId=ins-*` 明细下，不编造系统盘 ID 或另算一遍费用；独立 CBS 明细只精确匹配 `disk-*` 台账。已核验产品编码见 [官方产品账单示例](https://cloud.tencent.com/document/product/555/93162)。参见 [字段说明](https://cloud.tencent.com/document/product/555/44144) 与 [账单组件数据结构](https://cloud.tencent.com/document/product/555/19183)。
- 归属必须同时具有腾讯云平台创建台账、同实例的来源作业、冻结的 provider/UIN/地域以及包含准确资源 ID 的创建清单。CVM、CBS、EIP、NAT 按官方产品和资源 ID 核验；未知产品、地域冲突或缺少创建来源不计费用。现有或混用 COS Bucket、账号或地域汇总、仅有标签的资源不能整体归入平台；平台快照/COS 来源链或资源级账单尚不完整时保留待对账提示，不按零费用处理。腾讯云镜像打包须核对冻结账号、同一平台实例与物理源盘清单以及准确 backing snapshot ID；导入镜像须具有官方任务 ID、已核验上传对象和专属创建 Bucket 的完整来源链。
- 明细、异常、指纹和日替换均按云空间 + provider + UIN 隔离；腾讯云写入必须显式声明 provider，不能覆盖同 UID 的阿里云或其它空间历史。金额超出账单库的小数精度或现有数字响应精度时拒绝该日替换并保留旧记录。
- 腾讯云 L3 明细在扣费后约半小时出账，L0–L2 通常 T+1；上月账单于次月 1 日 19 点完成最终出账，延迟用量仍可能补扣或重结。未出账金额始终标记 `provisional`，API 定时刷新上月和本月完整账日以覆盖修订。参见 [账单出账与延迟说明](https://cloud.tencent.com/document/faq/555/7465)。

- 腾讯云 COS 只统计平台新创建的私有专属导入桶，并精确匹配官方资源 ID 的完整 `BucketName-APPID`。来源表保留云空间、provider、UID、APPID、配置 ID、地域、创建者、预创建 404、原子 nonce 标签、官方 Owner/ACL/创建时间和请求 ID；标签或现有 Bucket 配置单独均不足以归属。已知混用、公开访问策略或历史分片/版本来源不完整时保留待核对，不将整桶金额纳入平台公共费用。存储、流量和请求金额只读取官方 `RealCost` 组件，不按对象大小估算。参见 [COS 资源账单](https://cloud.tencent.com/document/product/436/30357) 与 [存储桶计费](https://cloud.tencent.com/document/product/436/6241)。
- COS 桶名称可以复用；已确认释放后出现的账单只有在官方 `FeeBeginTime` / `FeeEndTime` 明确属于原资源生命周期时才归属，不能把重建资源的费用自动计入旧平台记录。未知创建结果保留原名称和 nonce，只核对原请求结果；未知删除结果只验证桶是否已消失。回收前必须确认没有活动任务或有效上传授权，且对象、历史版本、删除标记及未完成上传分片的完整分页清单均为空。
