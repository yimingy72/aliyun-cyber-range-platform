# 到期回收与历史费用风险：深入审查及修复

审查日期：2026-10-12。基线：`dba463f204cbe11354fba73c7d73017d13ee9cce`（已合入 PR #22）。

本次范围是上一轮的剩余风险：worker 停顿与回收延迟、单实例过期入队的一致性、原生释放时限，以及历史台账/迟到账单的核查。不是重新宣称全仓逐行审计或真实云费用已验证。

用户明确要求先提交 PR、不进行容器测试。本次没有运行 Docker、云 smoke、生产数据库操作或部署。使用提交级 `[skip ci]` 避免自动触发仓库的容器流水线；不关闭或削弱仓库已有 CI 配置。未执行的测试不视为通过。

## F1 / P1：整轮资源对账会阻塞过期扫描和作业领取（已修复）

位置：`apps/api/src/provisioning/provisioning-worker.service.ts` 的 `runLoop`、`reconcilePlatformResourcesIfDue`。

原逻辑启动时先等待对账，循环中也在任务领取前等待全部工作空间/地域对账。PR #22 的 30 秒是每次 ECS HTTP 请求上限，不是全部分页、资源类型和账号的总耗时上限。多个慢请求串行累积仍会延迟销毁受理与创建任务领取。

改动：先进行过期扫描和任务领取，再启动独立的对账 Promise。一个 worker 实例只允许一个实际对账任务在途；只有原任务真正结束才释放槽位，不使用超时 `Promise.race` 假装完成并产生重叠扫描。失败被捕获，顶层日志不输出未经脱敏的异常消息。

核对了现有对账写入边界：阿里云编排/旧后端与腾讯云对账仅记录诊断、不直接改写生命周期；OpenTofu 单实例仍在既有控制锁内重读实例/最后作业，并检查云读取之后的更新。因此没有删除原来的归属证明或作业 fencing。

边界：这不是独立进程，也不是跨副本分布式对账锁。数据库故障、进程死亡或整个调度循环自身的异常仍需要进程监管；不会因为本改动就保证到期必达或账单封顶。

## F2 / P1：单实例自动回收入队不是原子事务（已修复）

位置：同一 worker 的 `processExpiredInstance`、`retryExpiredDestroy`，以及 `PrismaAdminRepository.withSingleInstanceControlLock`。

原来持有 advisory lock 的事务只执行锁操作，传入的 `work()` 仍通过外层 Prisma delegates 分别提交写入。因此“将刷新作业标为失败 → 创建 destroy 作业 → 更新实例的 status/lastJobId”之间的数据库失败会留下部分受理状态。下一轮可能再次入队，或新作业被判定 superseded；既有云资源不会因数据库受理失败自动免费。

新增 `queueExpiredSingleInstanceDestroy`，将控制锁、当前实例与原作业重读、资格检查、旧作业结束、新作业插入、实例指针更新放进**同一个 Prisma transaction client**。最后一次实例写入失败时，旧作业状态和新作业插入一起回滚。

使用与手工单实例操作相同的 advisory lock key，但通过 `pg_try_advisory_xact_lock` 非阻塞获取。锁忙返回 null，保留记录供下一轮处理，不把销毁作业错误地标为已完成。它也不释放台账或删除任何云资源。

事务内重新核对到期时间、状态、lastJobId、作业所属实例/工作空间和其他在途作业；不取消正在执行的 create/update/retry/destroy，不替换已受理的 pending destroy。仅过期 refresh 或尚未执行的非 destroy 请求可以被替代。

自动销毁失败重试同样使用该事务入口，保留原来的 transient 白名单、未知归属/凭据等失败黑名单、最多 3 次重试和 1/2/4 分钟退避；并拒绝无效重试计数、缺失/无效完成时间及缺失冻结账号绑定。手工失败不会自动变成自动重试。

没有迁移已有孤立作业或自动修复历史状态，也没有扩大编排实例的自动删除资格。

## F3 / P2：历史释放和账单归属需要证据核查，而不是批量改账（增加只读审计工具）

新增 `scripts/audit/lifecycle-billing.sql`，供授权运维在只读数据库快照/副本上人工核查。必须传入准确 `workspace_id`，参数缺失或空间不存在时退出。事务为 REPEATABLE READ / READ ONLY；限定查询及锁等待时间，不输出密码、云密钥、runtimeCredentials、rawPayload 或完整拓扑。

四类候选记录：

1. 已到期或终态实例的 ECS/磁盘/EIP/NAT 台账仍未记录释放。镜像、快照、导入桶生命周期独立，不因此标为必须删除。
2. 实例、原始创建作业、owner、厂商或批次与台账不一致/来源缺失。
3. 官方账单日期晚于释放日的正费用行。释放日按 Asia/Shanghai 转换；退款不当作泄漏，币种不混加。
4. 已入账行的厂商、账号、物理 ID、类型或归属与其链接台账不一致。

每类最多展示 500 行，并提供完整候选计数。该工具是候选清单，不代替应用中的平台创建证明、云 API 实时库存或官方账单核对；未命中不证明一切安全。正费用的账单日期不等于费用实际发生时间，迟结算/调账也可能落在释放之后。不得据此自动把 releasedAt 补成 expiresAt，或删除历史账单、移动用户费用、重置创建来源。

示例（本次未执行）：

```sh
psql "$AUDIT_DATABASE_URL" -X -v workspace_id=EXACT_WORKSPACE_ID \
  -f scripts/audit/lifecycle-billing.sql
```

## F4 / 剩余高优先级风险：原生释放不是简单添加一个时间字段（已审查，未改自动删除合同）

当前阿里云单实例在受理时仅为距离到期至少 30 分钟的请求保存 autoReleaseTime；编排实例未配置同等原生截止时间。队列等待和供应商创建时延可能进一步消耗该余量。不能把前端到期时间、保存过 autoReleaseTime 或平台 destroyed 标记当作云端释放回执。

阿里云 RunInstances 的 AutoReleaseTime 最早须为当前时间 30 分钟后，秒数会被截到分钟；最晚不能超过三年。仅把 expiresAt 原样传给短时靶机可能导致创建失败。为了“通过验证”每次重试都改成 now+30min 则会不断推后云端截止时间，而且改变原幂等请求。参考：

- [RunInstances 合同](https://www.alibabacloud.com/help/en/ecs/developer-reference/api-ecs-2014-05-26-runinstances)
- [auto_release_time provider 合同](https://help.aliyun.com/zh/terraform/alicloud-instance)
- [释放 ECS 后独立磁盘、EIP、快照仍可能收费](https://www.alibabacloud.com/help/en/ecs/user-guide/release-an-instance)

后续原生兜底方案应冻结每个创建意图的绝对截止时间，明确短于供应商最小周期时的产品规则，在真正 apply 前重新验证剩余余量，既不在重试时续期，也不在更新/销毁旧实例时清空其定时释放。应分别验证持久化 intent、供应商接受/读取回执和故障后恢复；网络变更不能通过整套重建恢复 timer。

EIP/NAT/独立磁盘及保留镜像需要各自的资源库存和回收闭环，ECS 的原生自动释放并不保证这些资源一起停止计费。实际进程宕机场景还需要独立于该 worker 的持久化过期监测/恢复机制，并按原账号、地域和创建证据执行，不能仅按可复制标签广泛删除。

本 PR 没有改变短时靶机的可创建范围、偷偷延长 TTL、给现有资源加自动删除期限、部署新的云服务，或宣称费用已经封顶。这里的原生兜底和历史修复仍是待完成工作，不混记为本次已修复。

## 验证记录

已执行（非容器）：

- `node --test test/automatic-destroy-policy.test.mjs`：41 项通过、0 失败。直接转译并执行本次新增的纯策略代码，覆盖到期边界、在途作业、跨空间/实例来源、退避、重试上限、无效输入和不改写输入。当前环境通过 NODE_PATH 使用已安装的 TypeScript；标准仓库安装后使用 API workspace 的 TypeScript。
- 新策略文件的独立 strict TypeScript 检查通过。
- 补丁的 `git diff --check` 通过。

已补用例、未执行：

- `worker-reconciliation-isolation.spec.ts`：慢启动对账不阻塞扫描/领取、单任务在途、失败脱敏与槽位释放。
- `expiry-intake-atomicity.e2e-spec.ts`：隔离 PostgreSQL 上的末次写入失败回滚、两连接竞争和锁忙不等待。需要 `NATIVE_BATCH_TEST_DATABASE_URL` 指向隔离测试数据库，不能指向生产。
- 既有自动回收、并发、工作空间隔离、完整 API/Web/MCP、构建与 IaC 回归本次没有重跑。纯策略通过不代表 Prisma 事务或完整应用构建已经通过。
- 只读 SQL 未连接数据库执行；未核验实际余额或结算金额。

只提交分支和 PR，不合并、不部署。合并前仍需完成未执行的应用/数据库验证；本次尊重先审查提交、不跑容器测试的范围。

## PR #23 合并前复核（2026-10-12）

本节记录后续用户授权的 Docker 复核，不覆盖上面的原始提交验证记录。

1. 修复过期入队与单实例刷新完成的反向行锁顺序。`commitSingleInstanceClaim` 先锁作业、再锁实例，原 PR 的过期事务顺序相反；真实 PostgreSQL 两连接竞争可稳定触发 `40P01 deadlock detected`。过期入队现在也先锁原作业，再锁实例，并在锁定后重新核对 `lastJobId`。原代码运行新增回归失败，修复后通过；不会取消已经完成的刷新或重复插入销毁。
2. 修复 SQL 审计的失败退出。PostgreSQL 16 的 `psql` 会忽略 `\quit 2` 的参数并返回成功。参数缺失或工作空间不存在现在显式抛出只读校验错误，由 `ON_ERROR_STOP` 返回非零状态；已知工作空间审计仍成功。
3. 补充真实数据库工作空间隔离回归：在阿里云空间尝试受理腾讯云空间的过期实例返回空，另一空间的实例和作业保持原值；本空间新销毁作业保留准确工作空间。

Docker 验证使用 `cyber-range-pr23-review:20261012`，基于已缓存的仓库 CI 镜像构建本分支源码；PostgreSQL 16 位于独立内部网络、临时数据库和 tmpfs 中，不连接本地平台业务库，不调用真实云接口。相关 worker、生命周期、资源对账、并发和真实事务回归共 9 套、149 项通过（含真实 PostgreSQL 的 5 项）；纯策略 41 项通过，API TypeScript 构建通过。SQL 在同一个隔离数据库验证已知空间退出 0、缺失参数退出 3、未知空间退出 3。合并和本地平台部署由主任务在完整集成验证后完成。
