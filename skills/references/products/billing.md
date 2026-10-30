# 账单费用

仅平台管理员查询、同步和导出当前工作空间账单。账单金额以平台已同步的阿里云 BSS / 腾讯云官方费用明细和本地归属台账为准。

## MCP 工具与参数

`startAt` 与 `endAt` 均为 `YYYY-MM-DD`，必须同时提供或同时省略，且起始日不晚于结束日。`billing_user_list`、`billing_user_group_list` 和 `billing_platform_group_list` 支持 `page`（正整数，默认 1）与 `pageSize`（20、50 或 100，默认 20）。其他查询与导出不接受分页参数。

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
| 查询阿里云专用桶费用归属 | `billing_oss_bucket_binding_list` | — | — | `billing:read` |
| 声明阿里云专用桶费用归属 | `billing_oss_bucket_bind` | `bucketName`、`effectiveStartAt`（带时区固定 ISO）、`dedicated: true` | 按服务端确认合同传操作元数据 | `billing:sync` + `settings:write` |
| 创建阿里云平台专用桶 | `billing_oss_bucket_create` | `dedicated: true` | 按服务端确认合同传操作元数据 | `billing:sync` + `settings:write` |
| 结束阿里云专用桶费用归属 | `billing_oss_bucket_binding_end` | `ledgerId` | 按服务端确认合同传操作元数据 | `billing:sync` + `settings:write` |
| 导出平台费用 | `billing_export_platform_csv` | — | `startAt`、`endAt` | `billing:read` |
| 导出用户费用 | `billing_export_users_csv` | — | `startAt`、`endAt` | `billing:read` |
| 导出用户明细 | `billing_export_user_csv` | `userId` | `startAt`、`endAt` | `billing:read` |

## 操作规则

- 部署配置 `PLATFORM_BILLING_STARTED_AT` 后，概览返回 `platformBillingStartedAt`，当前查询、分组、导出和同步只纳入固定起点后由平台实际创建的资源，以及不早于该起点的已核验阿里云专用桶声明区间。按出生来源或明确专用区间划分，不按出账日期认领：旧资源迟到账不计入当前费用；新快照或动态新增节点仍独立核验其新创建来源。起点不随重启或更新滚动，未配置时保持原有全历史行为。
- 历史资源台账和已同步账单保留作审计，但不纳入当前范围；当前账单按固定起点隔离同步批次，重刷当天不得覆盖历史分区。账户和地域聚合费用仍须精确归属，不能因为日期较新就认领。

- `billing_user_*` 使用准确 `userId`，先从 `billing_user_list` 或 `admin_user_list` 获取。
- 所有概览、明细、用户费用和导出仅统计有平台创建来源证明的资源账单，以及平台超管明确声明、官方身份已核验的阿里云专用 OSS 桶费用，再按用户或平台公共资源分配。收录外部镜像、普通配置现有 Bucket 或仅有平台标签，不等于费用归属证明；外部资源费用不纳入平台账单。
- 阿里云 OSS 专用桶必须由平台超管明确声明用途与固定生效时间，核对当前配置、官方 Owner、地域、桶名、出生时间和请求 ID，并保留声明人及审计。生效时间不早于全局计费起点或桶出生时间；只认整个账日均位于专用区间内的精确桶级官方分账，覆盖存储、流量和请求费用。同步重新核验桶出生信息，防止同名桶删除重建后混账。普通配置、账号/地域汇总、混用桶或部分专用账日均不能认领整桶金额。终止声明保留历史费用，不删除桶、对象或伪造云回收；终止后不自动恢复旧声明。
- 快照可使用精确快照 ID 分账，或在完整来源证据下使用官方源 ECS 分账。源 ECS 路径要求打包提交时保存的完整快照/自动策略基线及覆盖源主机出生至账日结束的官方 ActionTrail 分页审计，全部当日计费快照均须有平台创建来源且属于当前范围。已删除手工快照、自动策略、外盘变更、审计不足或未知来源均继续待对账；旧主机本身不重新认领费用，新快照独立核验。源 ECS 金额只记录一次，并保存关联快照集合，不按容量、数量或相邻日差额拆算；退款/调账缺原始用量区间时保持待核对。
- 官方分账未返回、未对平或身份/审计暂不可核验时保留待对账，并保留上次已核验金额；现有定时同步取得完整官方明细和归属证据后自动补入，重复同步不重复计费。历史记录缺提交时基线不能事后补造证据。
- 需要新桶时使用 `billing_oss_bucket_create`：创建前核验主账号身份并持久记录目标名称/nonce/创建意图，私有 Standard 桶出生信息与费用台账保留；不生成费用估算。未知创建结果只恢复原名称，不新建替代桶；配置/CORS失败也保留已创建资源及台账。新桶不追溯到全局起点之前或出生之前；有完整原生成功创建证明时，出生当天的费用也只来自新平台桶，否则部分账日继续待核对。此为平台持续使用资源，不能当临时 smoke 资源擅自删除。
  成功与未知恢复都须核验创建时原子写入的 nonce/managed ID/空间标签，以及原创建请求附近的官方出生时间；不能接管后来人工创建的同名桶。相同失败幂等键只查询已缓存失败；需要恢复时发起新的确认请求和幂等键，服务仍复用持久原名称与意图，不再次发送创建 PUT。
- 资源归因优先读分组，确需逐条账单时再读明细；`billing_anomaly_list` 仅返回已证明平台创建的精确异常账单。账户级聚合费用不展示为平台待分配金额；已知平台资源暂时缺少细分账单或归属证明时，必须保留对账提示，不能据此声称平台费用已全部对齐。
- `billing_sync` 显式提供日期时精确刷新该范围；省略日期时重新同步最近 7 个完整账期，覆盖迟到的账单和调整。同步以当前已验证云账号 UID 和日期为界，原子替换本账号该日的数据，不覆盖其它账号历史；未知 UID 历史仅在已有台账明确证明归属时回填。
- API 默认每六小时重刷上月及本月已结束的账日，覆盖月结修订；worker 不启动重复定时器。更早历史调整仍需按明确日期补刷。
- 概览 `billingScope=platform_resources` 确认统计范围仅为平台创建资源；缺失时范围未知，不能把旧接口的账号级金额重新标为平台支出。`billingStatus=provisional` 表示金额仍可能随 BSS 出账、退款或调整变化；`unallocatedCurrencyTotals` 和 `anomalyCount` 仅包含已证明属于平台但尚未完成分配的精确费用，不加到用户或平台公共金额。`resourcesWithoutBillCount` 统计选定时间范围内平台资源缺少独立费用明细的数量，页面显示“资源费用明细待补齐”；不含 SNAT/DNAT、阿里云镜像，以及有准确盘→主机关系且官方主机系统盘组件已出账的系统盘。阿里云镜像由 backing snapshot 费用核对，不等待独立镜像账单。`reconciliationIssues` 按快照或 OSS 类型列出待细分数量与原因；`unknown` 表示历史账号或创建来源待核验；`disk` 表示同实例主机已有系统盘收费组件，但历史盘与主机的准确映射缺失或冲突，已确认释放的历史映射提示不在当前账单概览展示，但台账及 MCP 诊断仍保留供审计；仍在用、释放时间未知/无效/在未来或诊断清单不完整的记录继续显示“磁盘映射待核验”。这些映射诊断不包含在独立明细待补齐数量中，也不能因此声称每块盘已出账。所有提示均不包含账号聚合金额、不重复加费用。字段缺失表示未知，缺明细不等于云端未出账或免费。应付费用采用 BSS `PretaxAmount`，不把现金支付、优惠券抵扣或原价重复相加。
- 账期采用 UTC+8（上海）。今天和未来日期不会替换已有账单，响应会返回 `deferredDates`。阿里云 BSS 数据有延迟，初次查询新资源没有账单不能判定费用为零；费用验证应优先选择至少两天前的完整账期，并与实际 BSS 资源 ID、账号、用户、批次/实例归属逐项核对。
- 多币种费用不换算、不相加。`currencyTotals`/`amounts` 按币种返回金额；单币种保留数字汇总并附 `currency`，多币种的总金额为 `null`。用户列表先按币种、再在同币种内按费用排序。CSV 同样按币种分列。
- 官方资源金额原样保留至 18 位小数，不将合法的 10 位费用或负退款截断为 9 位；金额必须满足现有数字接口的无损往返及绝对值小于 `1e11`（原币）的范围。平台相关金额超出支持范围时保留旧账；无平台归属的外部费用不因存储精度阻塞平台同步。OSS/快照源总额与所有分账金额仍完整核对，不先剔除外部分账凑齐差额。参见 [阿里云金额字段](https://help.aliyun.com/zh/user-center/developer-reference/api-bssopenapi-2017-12-14-describeinstancebill)。
- 汇总先以 Decimal 加减再检查数字往返，无法无损表达时返回 `BILLING_AGGREGATE_PRECISION`，不静默舍入；逐条明细及其 CSV、账单写入不受影响，合计不额外套用单条存储上限。
- CSV 仅在用户明确要求导出时生成；只报告文件名、行数和非敏感摘要。

## 腾讯云费用明细

- 国内站通过 `DescribeBillDetail` 拉取完整月度官方费用明细，再按 UTC+8 `BillDay` 精确刷新请求的已结束账日。使用费用账单，不使用消耗摊销、价格估算或用量试算代替官方账单。分页最多 300 行，携带上一页 `Context`；`Total` 有 24 小时缓存，可能少于实际记录数，因此以完整末页结束，重复行、缺页、账号或日期冲突均保留旧数据。接口仅提供最近 18 个月的数据。参见 [官方费用明细 API](https://cloud.tencent.com/document/api/555/19182)。
- 逐收费组件保存 `ComponentSet.RealCost`，该字段是优惠后总价，国内站单位为元（CNY）。退款和调整保留官方正负号；原价、现金、代金券、赠送金、分成金均不重复加入优惠后总价。CVM 系统盘组件保留在其官方 `ResourceId=ins-*` 明细下，不编造系统盘 ID 或另算一遍费用；独立 CBS 明细只精确匹配 `disk-*` 台账。已核验产品编码见 [官方产品账单示例](https://cloud.tencent.com/document/product/555/93162)。参见 [字段说明](https://cloud.tencent.com/document/product/555/44144) 与 [账单组件数据结构](https://cloud.tencent.com/document/product/555/19183)。
- 归属必须同时具有腾讯云平台创建台账、同实例的来源作业、冻结的 provider/UIN/地域以及包含准确资源 ID 的创建清单。CVM、CBS、EIP、NAT 按官方产品和资源 ID 核验；未知产品、地域冲突或缺少创建来源不计费用。现有或混用 COS Bucket、账号或地域汇总、仅有标签的资源不能整体归入平台；平台快照/COS 来源链或资源级账单尚不完整时保留待对账提示，不按零费用处理。腾讯云镜像打包须核对冻结账号、同一平台实例与物理源盘清单以及准确 backing snapshot ID；导入镜像须具有官方任务 ID、已核验上传对象和专属创建 Bucket 的完整来源链。
- 明细、异常、指纹和日替换均按云空间 + provider + UIN 隔离；腾讯云写入必须显式声明 provider，不能覆盖同 UID 的阿里云或其它空间历史。金额超出账单库的小数精度或现有数字响应精度时拒绝该日替换并保留旧记录。
- 腾讯云 L3 明细在扣费后约半小时出账，L0–L2 通常 T+1；上月账单于次月 1 日 19 点完成最终出账，延迟用量仍可能补扣或重结。未出账金额始终标记 `provisional`，API 定时刷新上月和本月完整账日以覆盖修订。参见 [账单出账与延迟说明](https://cloud.tencent.com/document/faq/555/7465)。

- 腾讯云 COS 只统计平台新创建的私有专属导入桶，并精确匹配官方资源 ID 的完整 `BucketName-APPID`。来源表保留云空间、provider、UID、APPID、配置 ID、地域、创建者、预创建 404、原子 nonce 标签、官方 Owner/ACL/创建时间和请求 ID；标签或现有 Bucket 配置单独均不足以归属。已知混用、公开访问策略或历史分片/版本来源不完整时保留待核对，不将整桶金额纳入平台公共费用。存储、流量和请求金额只读取官方 `RealCost` 组件，不按对象大小估算。参见 [COS 资源账单](https://cloud.tencent.com/document/product/436/30357) 与 [存储桶计费](https://cloud.tencent.com/document/product/436/6241)。
- COS 桶名称可以复用；所有账日必须以严格 UTC+8 `FeeBeginTime` / `FeeEndTime` 完整落入原桶已证明的生存区间。台账出生时间须与官方创建时间精确相等。结束不得晚于已完整核验并 CAS 保存的 `billingObservedThrough`，以及原删除请求/释放时间的较早者。新观察界取完整云身份与专属性核验开始时点，仅原创建时间、nonce、Owner、ACL、标签及对象来源全部通过才发布；不是本地读时间或 generation ID。旧 proof 缺此新字段须由既有导入/空闲清理核验续证；activeJobs 跳过后台且后续导入尚未续证的区间仍待核对。未知删除不续期、不以迟到404延长生存界；明确rejected不视作已释放。缺失/非法/跨边界区间保留 source_pending，不把未知当零或按时长猜测分摊。参见[官方时区](https://cloud.tencent.com/document/product/555/7465)及[使用时间](https://cloud.tencent.com/document/api/555/19183#BillDetail)。未知创建结果保留原名称和 nonce，只核对原请求结果；未知删除结果只验证桶是否已消失。回收前必须确认没有活动任务或有效上传授权，且对象、历史版本、删除标记及未完成上传分片的完整分页清单均为空。

## 当前待核对能力边界

现有工具返回已同步的官方账单和资源归属诊断。它们尚不提供“资源一创建就新建账单行”的生命周期账单模型，也不返回统一的“未出账/部分出账/已出账至某日”资源状态。不要把产品方案写成已实现能力，或因列表暂时为空宣称没有费用。

- 新创建及动态新增资源：通过 `provision_job_get` 的同来源库存和 `billingResources` 核对 provider、账号、地域、owner、原生资源 ID、出生作业和释放时间。已有资源的规则变更不新建主机费用，也不把旧资源来源改成更新作业。
- 删除节点和整套回收后：保留创建与释放台账，核对被删除主机、系统盘及付费网络是否释放；资源释放时间不等于最终出账金额。腾讯云系统盘包含于 CVM 组件时不另算一遍。
- 公共费用以实际 `billingScope=platform` 和完整创建/使用证据为准；私有镜像或快照不因资源类型而自动变为公共费用。发布后的历史归属切换仍需以已实现的服务端来源/owner 逻辑为准，不能承诺按日期重新分摊。
- OSS/COS 精确 Bucket、快照 ID、镜像与 backing snapshot 来源链可帮助解释已同步官方金额；厂商只提供源主机、地域或账号聚合金额时保留待核对，不能按容量拆算、按数量平均分配或重复计费。
