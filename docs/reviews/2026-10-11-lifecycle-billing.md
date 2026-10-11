# 靶机生命周期与账单代码审查

审查基线：`062330497978375a99fa3b12c8d2396713547348`。日期：2026-10-11。

## 范围与证据边界

本轮以全仓文件清点、风险检索及既有容器测试为基础，重点跟读 API 受理、单实例批次执行、worker、OpenTofu、资源对账、账单入库和持久化之间的调用链。非重点模块的文件清点、检索或测试通过，不等同于逐行完成全部语义审查。

没有连接生产数据库，没有使用真实云账号创建、删除资源，也没有验证云厂商实际结算金额。模拟接口、离线 OpenTofu 和容器回归只能证明测试所覆盖的代码行为，不能证明云端不存在遗留资源。

## 已确认的问题与修复

### R1 / P1：终态单实例凭可复制的标签新增计费归属

位置：`apps/api/src/provisioning/platform-resource-reconciliation.service.ts`，`reconcileCompletedOpenTofuMember`。

正常运行分支会核对持久化 `hostIds` 和磁盘库存，但 `create_failed`、`destroy_failed`、`destroyed` 分支在该检查之前就调用 `syncRangeInstanceBillingLedger`。即使云端物理 ECS ID 从未出现在该实例的持久化库存中，只要标签指向一个存在的创建任务，也可以生成该用户的 ECS 台账。同时，该分支会将未经重新验证的历史磁盘 IDs 传给同步逻辑，后者会把 `releasedAt` 重新置空。

触发条件：对账看到复制了合法平台标签但物理 ID 不匹配的 ECS；或者失败实例的历史磁盘库存已经失效。标签可用于发现候选资源，但不能单独证明资源是平台实际创建的。

影响：外部资源可能被纳入用户资源台账；已释放或归属未验证的磁盘可能重新显示为未释放。这里不是云厂商重复扣款的证据，而是平台归属和释放状态错误。

修复：终态分支必须匹配持久化物理 ID，或匹配同账号、同用户、同实例、同批次、同原始创建任务的既有 ECS 台账；无法证明时只记录 critical drift，不认领、不删除、不改生命周期。磁盘只有在原有库存验证通过后才参与本次台账同步。已有证据证明的真实残留 ECS 仍保持计费台账开放。

合并前补充审查发现：应急回收库存可能记录多个物理 ECS，例如 `ecs:i-a` 和 `ecs-recovery-1:i-b`。当前 ECS 的磁盘验证通过，只能证明这一台主机的磁盘；若把整个恢复库存交给同步，会让未观察到的其它恢复 ECS、系统盘或数据盘重新开账。终态和正常 `running` 分支现在都只同步本次观察到的物理 ECS，以及它对应且已经核验的系统盘、数据盘子集。磁盘映射原有 key、完整持久化库存、原始账本来源和实例生命周期保持不变；其它恢复资源既不会因本次观察被认领，也不会被标记释放。

回归：复制标签、清空运行库存、历史台账账号/用户/实例/批次/来源任务冲突、未验证磁盘不重新开放，以及真实已记录残留资源的正向恢复。多物理主机用例通过真实磁盘核验函数检查请求中的准确磁盘 ID：覆盖 `running`、`create_failed`、`destroy_failed`、`destroyed`，确认其它主机原有已释放台账不变、未观察磁盘不新增归属，以及凭既有物理台账恢复第二台主机时只重开其实际核验资源。

### R2 / P2：不完整的空账单响应可以覆盖已保存的日账单

位置：`apps/api/src/admin/billing-bss-client.ts`，`listDailyBillingItems`；后续写入为 `BillingSyncService.syncRange` → `PrismaAdminRepository.replaceBillingDay`。

普通账单客户端把 `TotalCount` 当成可选项。带正确账号和账期但缺少总数的 `Items: []` 会被视为完整的空修订；同步逻辑随后可以执行日账单替换，删除已有费用。后续页缺少总数也会被接受。带新 token 的空页或已达到总数却仍有 token 的响应没有提前停止。

修复：每页都要求非负安全整数总数且各页一致；拒绝无进展和越过总数的继续分页；末页必须满足实际行数与声明总数一致；在请求前校验日日期。只有明确验证过的零行修订才允许清空旧账单。

回归：缺失/无效总数、末页缺失总数、矛盾 token、完整多页退款修订、明确零行修订、非法日期。原有三个计数测试还补齐了正确账号和账期，避免它们实际上只覆盖账号校验而未触及计数分支。

官方合同：
- https://www.alibabacloud.com/help/en/user-center/developer-reference/api-bssopenapi-2017-12-14-describeinstancebill
- https://www.alibabacloud.com/help/en/user-center/developer-reference/api-bssopenapi-2017-12-14-describesplititembill

### R3 / P2：资源对账 HTTP 请求没有应用级超时，会阻塞 worker 调度

位置：`apps/api/src/provisioning/platform-resource-reconciliation.service.ts`，`AliyunEcsResourceClient.performRequest`；调用方 `ProvisioningWorkerService.runLoop`。

worker 启动时和周期内都会等待资源对账结束，再继续领取任务或执行下一轮到期回收。共享 RPC 方法的 `fetch` 没有超时/取消信号，远端请求不能及时结束时，调度也无法及时继续。阿里云编排及没有原生自动释放时间的短时单实例尤其不能把平台 TTL 当作云端计费的绝对上限。

修复：为共享 RPC 请求添加 30 秒 `AbortSignal.timeout`。超时按既有失败路径上报，不将未知云状态当成空库存，也不自动重建或认领资源。该修改限制单次请求等待，不代表整个多账号对账过程有 30 秒的总耗时上限。

回归：DescribeInstances、标签分页查询、TagResources 的挂起请求都能被取消；对账中断不更改实例生命周期、原始台账或 drift 证据。

## 重点链路中已核对的现有保护

这些是基线中已有的设计，不应重复作为“本 PR 修复”：

- 创建使用冻结账号与工作空间，单实例批次有数据库租约、持久化 manifest、apply marker 和目标计划检查；未知结果优先恢复，不盲目重建。
- 创建在 worker apply 前再次检查到期时间；腾讯 CVM 模块带稳定创建意图和原生终止时间。单实例固定 IP 计算并未直接成为批次模块的实际分配参数，不据此报告 IP 冲突。
- 回收路径保留物理库存与失败证据，并进行云端残留确认；claim 失效后不能继续宣告任务成功。共享网络不是任一单实例独占，不能随单台回收直接删除。
- 账单按账号、工作空间、厂商隔离；每日替换在数据库事务和日粒度锁内完成。退款保留负金额，多币种分开汇总，CSV 已有公式注入防护。
- 腾讯账单遍历不以可能滞后的 cached Total 作为提前结束条件；阿里云分账已有更严格的分页检查。

## 未在本 PR 扩大的事项

1. **云上故障注入与灾难恢复演练**：真实 create 超时、worker/数据库同时中断、状态卷丢失、EIP/NAT/磁盘残留及云端最终一致性，仍需要有额度限制、独立测试工作空间和立即清理的受控验证。本轮没有执行这些付费操作。
2. **对账与到期调度的架构隔离**：单请求超时只是最小修复。多账号/多地域大量分页仍可能延迟后续调度，应进一步评估独立对账作业及总时间预算；本 PR 不引入新的任务架构。
3. **历史归属数据修复**：R1 防止新错误认领，并不会自动删除既有台账。对可能已经产生的错误归属，应保留审计记录，根据创建任务、状态库存和官方原始账单人工核对，不能用标签批量重写历史。
4. **原生过期兜底**：阿里云编排模块未像腾讯模块一样设置每台主机的原生终止时间；平台到期回收仍依赖 worker。是否增加云端兜底，需要单独确定最小可用 TTL、更新时是否允许延长以及相关云接口合同。
5. **账单延迟**：`destroyed` / `releasedAt` 仅描述资源回收证据，不代表官方费用已结清。未出账不能显示为免费，分账延迟也不能通过比例分摊或零费用覆盖历史来掩盖。

## 验证方式

新增测试：
- `apps/api/test/billing-bss-integrity.spec.ts`
- `apps/api/test/aliyun-reconciliation-timeout.spec.ts`
- 扩展 `apps/api/test/platform-resource-reconciliation.service.spec.ts`
- 校正 `apps/api/test/billing-safety.spec.ts` 的分页与身份夹具

所有测试和构建通过 Docker 执行。定向回归需要分别在修复代码与原始基线源文件上运行，以确认用例不是仅重复既有绿灯。全量验证入口保持 `bash scripts/ci/verify-docker.sh`，涵盖 workspace 测试、生产构建、数据库迁移以及离线 IaC 验证。

实际运行结论、提交 SHA 和 CI 链接以 PR 描述及 GitHub Actions 记录为准；本文件不将“添加测试”视为“测试已通过”。

合并前磁盘范围补修的离线容器验证以 PR 初始头 `676220162ad30065bb08cadc114a91a8a862b618` 为基线：API 生产构建通过；对账及请求截止两个测试文件共 53 项通过；同一组新增多物理主机测试替换回初始源文件后 5 项全部失败。这些数字仅描述该补修验证，不替代与最新 `master` 合并后的完整验证和 CI 结论。
