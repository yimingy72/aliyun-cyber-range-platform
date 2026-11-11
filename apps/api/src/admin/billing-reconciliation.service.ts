import { BadRequestException, ForbiddenException, Inject, Injectable, Logger } from '@nestjs/common';
import { ADMIN_REPOSITORY, type AdminRepository, type BillingLedgerResourceRecord } from './admin.repository';
import { BillingLifecycleService, expectedBillingCategories, type LifecycleWindow } from './billing-lifecycle.service';
import { BillingReconciliationRepository } from './billing-reconciliation.repository';
import { BillingBssClient, BillingRpcError, BillingSplitBillUnavailableError, type SplitBillingProduct } from './billing-bss-client';
import { BillingSyncService } from './billing-sync.service';
import { SystemConfigService, type SystemCloudAccountContext } from './system-config.service';
import { billingDayText } from './billing-window';
import { billingDates, billingKey, billingDateText, independentBillResource, BILLING_REASONS, type BillingQueryEvidence, type ScopedBillingResult, type BillingMode } from './billing-reconciliation-types';
import { isPlatformCreatedLedger, classifyPlatformBillLine, type PlatformBillingProof } from './billing-platform-scope';
import { aliyunPackSnapshotBaselineIssue } from './aliyun-snapshot-ecs-evidence';
import { readAliyunOssDedicatedBilling } from './billing-oss-binding-proof';
import { systemDiskBillingCoverage } from './billing-system-disk-coverage';
import { recoverBillingInventories } from './billing-inventory-recovery';
import { currentBillingRows, readPlatformBillingStartedAt } from './billing-current-scope';
import { platformBillingItems } from './billing.service';
import { getCurrentCloudWorkspaceScope, runInCloudWorkspace,runInSystemCloudWorkspaceScope } from '../auth/cloud-workspace-scope';
import { listExecutionCloudWorkspaces, runInExecutionCloudWorkspace } from '../auth/background-cloud-workspace';
const identityDigest = (row: BillingLedgerResourceRecord) => billingKey([row.id, row.cloudProvider, row.cloudAccountUid, row.regionId, row.cloudResourceId, row.cloudResourceType,
    row.ownerUserId, row.billingScope, row.sourceProvisionJobId, row.billingStartAt.toISOString(),
    row.tagsSnapshot.PlatformPackedImageArtifactId, row.tagsSnapshot.PlatformImageImportJobId, row.tagsSnapshot.CloudAccountContextId,
    readAliyunOssDedicatedBilling(row)?.bucketCreatedAt, readAliyunOssDedicatedBilling(row)?.effectiveStartAt, readAliyunOssDedicatedBilling(row)?.effectiveEndAt]);
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
type Claimed = NonNullable<Awaited<ReturnType<BillingReconciliationRepository['claim']>>>;
@Injectable()
export class BillingReconciliationService {
    private readonly logger = new Logger(BillingReconciliationService.name);
    private readonly plannedAt = new Map<string, number>();
    private readonly probedAt = new Map<string, number>();
    constructor(private readonly store: BillingReconciliationRepository, private readonly lifecycle: BillingLifecycleService,
    @Inject(ADMIN_REPOSITORY)
    private readonly repository: AdminRepository, private readonly config: SystemConfigService, private readonly bss: BillingBssClient, private readonly sync: BillingSyncService) { }
    async request(input: LifecycleWindow & {
        entryId?: string;
        ledgerIds?: string[];
    }) {
        const data = await this.lifecycle.load(input);
        if (data.scope.isReadOnly)
            throw new ForbiddenException('历史云账号空间为只读。');
        if (data.settings.workspace.provider !== 'alibaba_cloud')
            throw new BadRequestException('当前云账号保留原厂商账单同步，请使用原同步入口。');
        const entries = input.entryId ? data.entries.filter(row => row.id === input.entryId) : data.entries;
        if (input.entryId && !entries.length)
            throw new BadRequestException('该账目不存在或不在当前范围。');
        const visibleIds = new Set(entries.flatMap(row => row.resources.map(resource => resource.ledgerId)));
        if (input.ledgerIds && (!Array.isArray(input.ledgerIds) || !input.ledgerIds.length || input.ledgerIds.length > 100 || input.ledgerIds.some(id => !visibleIds.has(id))
            || new Set(input.ledgerIds).size !== input.ledgerIds.length)) throw new BadRequestException('资源不在当前账号、账期或所选账目范围。');
        if (data.settings.mode === 'legacy'&&!data.scope.isPlatformManager)
            throw new ForbiddenException('请由管理员先启用资源对账。');
        if (data.settings.mode === 'legacy')
            await this.store.setMode('shadow', data.settings.generation);
        const ids = [...(input.ledgerIds ?? visibleIds)].sort();
        const context = await this.config.getExecutionAccountContext();
        const actorId = data.scope.actorUserId ?? '';
        const task = await this.store.enqueue({ cloudProvider: 'alibaba_cloud', cloudAccountUid: context.accountUid!, cloudAccountContextId: context.cloudAccountContextId!,
            regionId: context.defaultRegion, billingDate: billingDayText(new Date()), groupKey: billingKey(['planner', ids, data.window.startAtText, data.window.endAtText, actorId]),
            kind: 'planner', targetLedgerIds: ids, queryPlan: { input: { startAt: data.window.startAtText, endAt: data.window.endAtText, entryId: input.entryId }, actorId } }, [], true);
        return { accepted: true, scheduledTasks: 1, plannerTaskId: task.id, targetResourceCount: ids.length,
            mode: (await this.store.settings()).mode, note: '已提交后台核对任务，正在按实际资源生成账日清单。' };
    }
    async schedule(input: LifecycleWindow & {
        entryId?: string;
    }, force = true, transactionProbe = false, allowedLedgerIds?: string[]) {
        const data = await this.lifecycle.load(input), scope = data.scope;
        if (scope.isReadOnly)
            throw new ForbiddenException('历史云账号空间为只读。');
        if (data.settings.mode === 'legacy')
            return {accepted:true,scheduledTasks:0,mode:'legacy',note:'当前由旧账单同步处理，未新增资源对账任务。'};
        const wanted = input.entryId ? data.entries.filter(row => row.id === input.entryId) : data.entries;
        if (input.entryId && !wanted.length)
            throw new BadRequestException('该账目不存在或不在当前账号和账期范围。');
        const knownPaid = new Set([...data.items.flatMap(row => row.matchedLedgerId ? [row.matchedLedgerId] : []),
            ...data.tasks.filter(row => row.kind !== 'planner').flatMap(row => row.targetLedgerIds)]);
        const ids = new Set(input.entryId ? wanted.flatMap(row => row.resources.map(resource => resource.ledgerId))
            : data.ledgers.filter(row => independentBillResource(row) || knownPaid.has(row.id)).map(row => row.id));
        const instances = await this.repository.listRangeInstances();
        let jobs: ReturnType<AdminRepository['listProvisionJobs']> | undefined;
        const logs = new Map<string, ReturnType<AdminRepository['listProvisionJobStepLogs']>>();
        const diskRepository = { listRangeInstances: async () => instances,
            listProvisionJobs: () => jobs ??= this.repository.listProvisionJobs(),
            listProvisionJobStepLogs: (id: string) => {
                if (!logs.has(id)) logs.set(id, this.repository.listProvisionJobStepLogs(id));
                return logs.get(id)!;
            } };
        const diskCoverage = new Map<string, ReturnType<typeof systemDiskBillingCoverage>>();
        const today = billingDayText(new Date()), lastComplete = new Date(Date.parse(today + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10);
        let scheduledTasks = 0;
        for (const ledger of data.ledgers.filter(row => ids.has(row.id) && (!allowedLedgerIds || allowedLedgerIds.includes(row.id)))) {
            const categories = transactionProbe ? ['probe:transactions'] : expectedBillingCategories(ledger), source = instances.find(row => row.id === ledger.rangeInstanceId);
            const artifact = data.proof.packedImages.find(row => row.backingSnapshotIds.includes(ledger.cloudResourceId));
            const imported = data.proof.imageImports.find(row => row.backingSnapshotIds.includes(ledger.cloudResourceId));
            const bucket = readAliyunOssDedicatedBilling(ledger);
            const binding = source?.instanceMode === 'single' ? source.singleInstanceConfig : source?.resourceSummary?.executionContext;
            const contextId = artifact?.cloudAccountContextId ?? imported?.cloudAccountContextId ?? bucket?.cloudAccountContextId
                ?? binding?.cloudAccountContextId ?? String(ledger.tagsSnapshot.CloudAccountContextId ?? '');
            const from = [data.window.startAtText, billingDayText(ledger.billingStartAt)].sort().at(-1)!;
            const lifecycleEnd = bucket?.effectiveEndAt ? billingDayText(new Date(bucket.effectiveEndAt)) : ledger.releasedAt ? billingDayText(ledger.releasedAt) : data.window.endAtText;
            const to = [data.window.endAtText, lastComplete, ...(transactionProbe ? [] : [lifecycleEnd])].sort()[0];
            for (const day of billingDates(from, to)) {
                const proven = isPlatformCreatedLedger(ledger, data.proof) && ledger.cloudProvider === 'alibaba_cloud'
                    && ledger.cloudProvider === scope.provider && ledger.cloudAccountUid === scope.accountUid && Boolean(contextId);
                await this.store.ensureUnits(ledger.id, day, categories, proven ? undefined : 'SOURCE_UNVERIFIED');
                if (!proven)
                    continue;
                if (ledger.cloudResourceType === 'ecs' && source?.instanceMode === 'single') {
                    const category = transactionProbe ? 'probe:network-transactions' : 'probe:network';
                    await this.store.ensureUnits(ledger.id, day, [category]);
                    await this.store.enqueue({ cloudProvider: 'alibaba_cloud', cloudAccountUid: ledger.cloudAccountUid!, cloudAccountContextId: contextId,
                        regionId: ledger.regionId, billingDate: day, groupKey: billingKey(['network',ledger.id,day,transactionProbe]), kind: 'discovery',
                        instanceId: ledger.cloudResourceId, productCode: 'cdt', targetLedgerIds: [ledger.id],
                        queryPlan: { identities: { [ledger.id]:identityDigest(ledger) }, transactionProbe } }, [{ledgerId:ledger.id,category}], force);
                }
                if (ledger.cloudResourceType === 'disk' && !transactionProbe) {
                    const daily = data.items.filter(row => billingDateText(row.billingDate) === day);
                    if (!diskCoverage.has(day)) diskCoverage.set(day, systemDiskBillingCoverage(diskRepository,
                        data.ledgers.filter(row => row.cloudResourceType === 'disk' && ids.has(row.id) && !daily.some(item => item.matchedLedgerId === row.id)), data.ledgers, daily));
                    const coverage = await diskCoverage.get(day)!;
                    if (coverage.covered.has(ledger.id)) {
                        const parentId = coverage.parents.get(ledger.id);
                        const parentUnit = data.units.find(unit => unit.ledgerId === parentId && billingDateText(unit.billingDate) === day && unit.state === 'issued' && unit.adoptedAttemptId);
                        const verified = Boolean(parentUnit);
                        await this.store.markCoverage(ledger.id, day, verified ? 'covered_by_parent' : 'awaiting_query', verified ? 'PARENT_COVERAGE' : 'WAITING_PARENT', verified ? BILLING_REASONS.PARENT_COVERAGE : '等待主机收费组件的本次核验。', data.ledgers.find(row => row.id === parentId)?.cloudResourceId,
                            parentUnit?{queryTaskId:parentUnit.queryTaskId,adoptedAttemptId:parentUnit.adoptedAttemptId,lastAttemptId:parentUnit.lastAttemptId,lastQueriedAt:parentUnit.lastQueriedAt,lastVerifiedAt:parentUnit.lastVerifiedAt}:undefined);
                        continue;
                    }
                    if (coverage.mappingPending.has(ledger.id)) {
                        await this.store.markCoverage(ledger.id, day, 'source_pending', 'DISK_MAPPING_PENDING', '系统盘与主机的准确对应关系仍待核验。');
                        continue;
                    }
                }
                const kind = ledger.cloudResourceType === 'snapshot' ? (artifact ? 'snapshot_source' : 'split') : ledger.cloudResourceType === 'oss_bucket' ? 'split' : 'direct';
                await this.store.enqueue({ cloudProvider: 'alibaba_cloud', cloudAccountUid: ledger.cloudAccountUid!, cloudAccountContextId: contextId, regionId: ledger.regionId,
                    billingDate: day, groupKey: billingKey(['query', ledger.id, day, kind, transactionProbe]), kind, instanceId: artifact?.sourceInstanceId ?? ledger.cloudResourceId,
                    splitItemId: ['snapshot', 'oss_bucket'].includes(ledger.cloudResourceType) ? ledger.cloudResourceId : null,
                    productCode: ledger.cloudResourceType === 'snapshot' ? 'snapshot' : ledger.cloudResourceType === 'oss_bucket' ? 'oss' : null,
                    targetLedgerIds: [ledger.id], queryPlan: { identities: { [ledger.id]: identityDigest(ledger) }, transactionProbe,
                        ...(['eip','snapshot'].includes(ledger.cloudResourceType) ? { resourceQueryVersion: 2 } : {}) } }, categories.map(category => ({ ledgerId: ledger.id, category })), force);
                scheduledTasks++;
            }
        }
        return { accepted: true, scheduledTasks, mode: (await this.store.settings()).mode, note: '已安排对应资源的账日核对；查询未返回明细时保留待核实状态。' };
    }
    async mode(mode: BillingMode, expectedGeneration: number) {
        const scope = getCurrentCloudWorkspaceScope();
        if (!scope || 'system' in scope || !scope.isPlatformManager)
            throw new ForbiddenException('仅管理员可切换账单写入方式。');
        if (!['legacy', 'shadow', 'resource'].includes(mode) || !Number.isInteger(expectedGeneration))
            throw new BadRequestException('账单模式或执行版本无效。');
        return this.store.setMode(mode, expectedGeneration);
    }
    async planDaily() {
        const data = await this.lifecycle.load({});
        const normallyUnbilled = data.ledgers.filter(row => !independentBillResource(row)).map(row => row.id);
        const paidHistory = normallyUnbilled.length ? platformBillingItems(currentBillingRows(await this.repository.listBillingLineItems({ matchedLedgerIds: normallyUnbilled }), readPlatformBillingStartedAt()), data.proof) : [];
        const paidIds = new Set(paidHistory.flatMap(row => row.matchedLedgerId ? [row.matchedLedgerId] : []));
        const ledgers = data.ledgers.filter(row => independentBillResource(row) || paidIds.has(row.id));
        if (!ledgers.length) return;
        const today = billingDayText(new Date()), clock = new Date(today + 'T00:00:00Z');
        const limit = new Date(Date.UTC(clock.getUTCFullYear(), clock.getUTCMonth() - 17, 1)).toISOString().slice(0, 10);
        const endAt = new Date(clock.getTime() - 86400000).toISOString().slice(0, 10);
        for (const row of ledgers.filter(row => billingDayText(row.billingStartAt) < limit))
            await this.store.ensureUnits(row.id, billingDayText(row.billingStartAt), expectedBillingCategories(row), 'HISTORY_UNAVAILABLE');
        const oldest = ledgers.map(row => billingDayText(row.billingStartAt)).sort()[0];
        for (let start = [oldest, limit].sort().at(-1)!; start <= endAt;) {
            const end = [new Date(Date.parse(start + 'T00:00:00Z') + 364 * 86400000).toISOString().slice(0, 10), endAt].sort()[0];
            await this.schedule({ startAt: start, endAt: end }, false);
            start = new Date(Date.parse(end + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
        }
    }
    async status() {
        const {settings,tasks}=await this.lifecycle.load({});
        return { mode: settings.mode, generation: settings.generation, queued: tasks.filter(row => ['pending', 'backoff'].includes(row.status)).length,
            running: tasks.filter(row => row.status === 'running').length, failed: tasks.filter(row => row.lastErrorCode).length };
    }
    async taskDetails(id: string) {
        const data = await this.lifecycle.loadProof(), task = await this.store.task(id);
        const visible = new Set(data.ledgers.map(row => row.id));
        if (!task || !task.targetLedgerIds.every(key => visible.has(key)))
            throw new ForbiddenException('无权查看该资源的对账任务。');
        const attempts = await this.store.attempts(id);
        const plan = (task.queryPlan as any).input;
        const tasks = task.kind === 'planner' && plan ? await this.store.tasks(task.targetLedgerIds, plan.startAt, plan.endAt) : [];
        const children = task.kind === 'planner' && plan ? tasks.filter(row => ['direct','split','snapshot_source'].includes(row.kind)
            && (row.queryPlan as any).transactionProbe !== true
            && billingDateText(row.billingDate) >= plan.startAt && billingDateText(row.billingDate) <= plan.endAt
            && row.targetLedgerIds.length && row.targetLedgerIds.every(key => task.targetLedgerIds.includes(key))) : [];
        const refreshed = attempts[0] ? children.filter(row => row.lastQueriedAt && row.lastQueriedAt >= attempts[0].startedAt) : [];
        return { id: task.id, status: task.status, billingDate: billingDateText(task.billingDate), kind: task.kind, nextQueryAt: task.availableAt,
            lastErrorCode: task.lastErrorCode, lastErrorMessage: task.lastErrorMessage,
            ...(task.kind === 'planner' ? { resourceRecheck: { targetResources: task.targetLedgerIds.length, resourceDayQueries: children.length,
                queriedResourceDays: refreshed.length, queriedResources: new Set(refreshed.flatMap(row => row.targetLedgerIds)).size,
                outcomes: Object.fromEntries([...new Set(refreshed.map(row => row.status))].map(status => [status, refreshed.filter(row => row.status === status).length])),
                reasons: Object.fromEntries([...new Set(refreshed.map(row => row.lastErrorCode).filter(Boolean))].map(code => [code!, refreshed.filter(row => row.lastErrorCode === code).length])) } } : {}),
            sourceEvidence: data.ledgers.filter(row => task.targetLedgerIds.includes(row.id) && row.cloudResourceType === 'snapshot').map(row => {
                const artifact = data.proof.packedImages.find(item => item.backingSnapshotIds.includes(row.cloudResourceId)
                    && item.cloudAccountUid === row.cloudAccountUid && item.regionId === row.regionId);
                return { ledgerId: row.id, snapshotId: row.cloudResourceId, sourceInstanceId: artifact?.sourceInstanceId ?? null,
                    baselineIssueCode: artifact ? aliyunPackSnapshotBaselineIssue(artifact, billingDateText(task.billingDate)) : 'SNAPSHOT_BASELINE_MISSING' };
            }),
            attempts: attempts.map(attempt => ({ id: attempt.id, startedAt: attempt.startedAt, finishedAt: attempt.finishedAt,
                outcome: attempt.outcome, requestIds: attempt.requestIds, pageCount: attempt.pageCount, rowCount: attempt.rowCount, complete: attempt.complete,
                errorCode: attempt.errorCode, errorMessage: attempt.errorMessage, datasetDigest: attempt.datasetDigest,
                officialDatasets: (Array.isArray((attempt.evidence as any).officialDatasets) ? (attempt.evidence as any).officialDatasets : []).map((dataset: any) => ({
                    action: dataset.action, billingDate: dataset.billingDate, instanceId: dataset.instanceId, splitItemId: dataset.splitItemId,
                    productCode: dataset.productCode, tagFilter: dataset.tagFilter, complete: dataset.complete === true,
                    rowCount: Array.isArray(dataset.rows) ? dataset.rows.length : 0 })),
                comparison: data.scope.isPlatformManager?(attempt.evidence as any).comparisons ?? []:[], applied: (attempt.evidence as any).applied === true })) };
    }
    private combineResults(results: ScopedBillingResult[], rowCount: number): ScopedBillingResult {
        const issue = results.find(row => row.issue)?.issue;
        const groups = new Map(results.flatMap(row => row.groups).map(group => [group.groupKey, group]));
        const categories: Record<string, string[]> = {};
        for (const row of results) for (const [id, values] of Object.entries(row.coveredCategories ?? {}))
            categories[id] = [...new Set([...(categories[id] ?? []), ...values])];
        return { groups: issue ? [] : [...groups.values()], coveredLedgerIds: issue ? [] : [...new Set(results.flatMap(row => row.coveredLedgerIds))],
            verifiedLedgerIds: [...new Set(results.flatMap(row => row.verifiedLedgerIds ?? []))], rowCount, issue, coveredCategories: categories,
            evidence: { snapshotHistories: Object.assign({}, ...results.map(row => row.evidence?.snapshotHistories ?? {})) } };
    }
    private async splitGroups(claim: Claimed, context: SystemCloudAccountContext, leaf: Array<Record<string, unknown>>): Promise<ScopedBillingResult> {
        const day = billingDateText(claim.task.billingDate);
        const parents = new Map(leaf.map(row => [JSON.stringify([row.ProductCode, row.InstanceID]), row]));
        if (parents.size > 20 || [...parents.values()].some(row => typeof row.InstanceID !== 'string' || !row.InstanceID || row.InstanceID.length > 1024))
            throw new Error('Unverified split parent identity');
        const results: ScopedBillingResult[] = [];
        for (const row of parents.values()) {
            const product = row.ProductCode as SplitBillingProduct;
            if (!['snapshot','oss','eip','cdt','cbwp'].includes(product))
                return { groups: [], coveredLedgerIds: [], rowCount: leaf.length, issue: { code: 'ALLOCATION_PENDING', message: '官方返回了尚不支持的分账产品，已保留查询凭证及原金额。' } };
            const id = row.InstanceID as string;
            const items = await this.bss.listDailyBillingItems({ billingDate: day, instanceId: id, productCode: product }, context);
            if (!items.length)
                return { groups: [], coveredLedgerIds: [], rowCount: leaf.length, issue: { code: 'ALLOCATION_PENDING', message: '资源分账已返回，但父收费组尚未完整返回，保留原金额。' } };
            results.push(await this.sync.prepareScopedRows({ billingDate: day, context, items, splitInstanceId: id,
                ...(['eip','cdt','cbwp'].includes(product) ? { splitProducts: [product] } : {}),
                getArchive: source => this.store.snapshotArchive(source) }));
        }
        return this.combineResults(results, leaf.length);
    }
    private async query(claim: Claimed, context: SystemCloudAccountContext, proof: PlatformBillingProof): Promise<ScopedBillingResult> {
        const { task } = claim, day = billingDateText(task.billingDate);
        if (task.kind === 'discovery' && task.productCode === 'cdt') {
            if (!task.instanceId || !/^i-/.test(task.instanceId)) throw new Error('SOURCE_UNVERIFIED');
            const native = await this.sync.prepareScopedRows({ billingDate:day, context,
                items:await this.bss.listDailyBillingItems({billingDate:day,instanceId:task.instanceId,productCode:'cdt'},context) });
            const month = new Date(billingDayText(new Date())+'T00:00:00Z');
            if (task.billingDate < new Date(Date.UTC(month.getUTCFullYear(),month.getUTCMonth()-11,1))) return native;
            let leaf = await this.bss.listDailySplitBillingItems({billingDate:day,productCode:'cdt',splitItemId:task.instanceId},context);
            const ledger = proof.ledgers.find(row=>task.targetLedgerIds.includes(row.id)&&row.cloudResourceId===task.instanceId);
            if (ledger?.rangeInstanceId) {
                const tagged = await this.bss.listDailySplitBillingItems({billingDate:day,productCode:'cdt',tagFilter:{key:'RangeInstanceId',value:ledger.rangeInstanceId}},context);
                leaf = [...leaf,...tagged.filter(row=>{const match=classifyPlatformBillLine({...row,__platformBillingSource:'DescribeSplitItemBill'});return match.kind==='direct'&&match.cloudResourceType==='ecs'&&match.cloudResourceId===task.instanceId;})];
            }
            return leaf.length ? this.combineResults([native,await this.splitGroups(claim,context,leaf)],native.rowCount+leaf.length) : native;
        }
        if (task.kind === 'direct') {
            if (!task.instanceId) throw new Error('SOURCE_UNVERIFIED');
            const items = await this.bss.listDailyBillingItems({ billingDate: day, instanceId: task.instanceId! }, context);
            const native = await this.sync.prepareScopedRows({ billingDate: day, context, items, getArchive: id => this.store.snapshotArchive(id) });
            if (!/^eip-/.test(task.instanceId)) return native;
            const month = new Date(billingDayText(new Date()) + 'T00:00:00Z');
            if (task.billingDate < new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() - 11, 1))) return native;
            // The EIP may be a split item of CDT or shared bandwidth rather than the native bill ID.
            let leaf = await this.bss.listDailySplitBillingItems({ billingDate: day, splitItemId: task.instanceId }, context);
            const ledger = proof.ledgers.find(row => task.targetLedgerIds.includes(row.id) && row.cloudResourceType === 'eip' && row.cloudResourceId === task.instanceId);
            // Historical CDT IDs include region/line/tier. Discover them through this range's tag, never an account-wide bill scan or guessed aliases.
            if (ledger?.rangeInstanceId) {
                const tagged = await this.bss.listDailySplitBillingItems({ billingDate: day, tagFilter: { key: 'RangeInstanceId', value: ledger.rangeInstanceId } }, context);
                leaf = [...leaf, ...tagged.filter(row => {
                    const match = classifyPlatformBillLine({ ...row, __platformBillingSource: 'DescribeSplitItemBill' });
                    return row.SplitItemID === task.instanceId || match.kind === 'direct' && match.cloudResourceType === 'eip' && match.cloudResourceId === task.instanceId;
                })];
            }
            if (!leaf.length) return { ...native, evidence: { ...native.evidence, emptyReason: !items.length ? 'EIP_BILL_NOT_RETURNED' : undefined } };
            return this.combineResults([native, await this.splitGroups(claim, context, leaf)], items.length + leaf.length);
        }
        const product = task.productCode;
        if (product !== 'snapshot' && product !== 'oss')
            throw new Error('Unsupported split product');
        if (!task.splitItemId) throw new Error('SOURCE_UNVERIFIED');
        if (product === 'snapshot') {
            const direct = await this.bss.listDailyBillingItems({ billingDate: day, instanceId: task.splitItemId, productCode: 'snapshot' }, context);
            if (direct.length) return this.sync.prepareScopedRows({ billingDate: day, context, items: direct, getArchive: id => this.store.snapshotArchive(id) });
        }
        let leaf = await this.bss.listDailySplitBillingItems({ billingDate: day, productCode: product, splitItemId: task.splitItemId! }, context);
        if (!leaf.length && task.kind === 'snapshot_source' && task.instanceId && task.instanceId !== task.splitItemId)
            leaf = await this.bss.listDailySplitBillingItems({ billingDate: day, productCode: product, splitItemId: task.instanceId }, context);
        if (!leaf.length)
            return { groups: [], coveredLedgerIds: [], rowCount: 0, evidence: { emptyReason: product === 'snapshot' ? 'SNAPSHOT_BILL_NOT_RETURNED' : 'NO_BILL_RETURNED' } };
        if (task.kind === 'snapshot_source' && leaf.some(row => row.SplitItemID === task.instanceId)) {
            const artifacts = proof.packedImages.filter(row => row.sourceInstanceId === task.instanceId && row.backingSnapshotIds.includes(task.splitItemId!)
                && row.cloudAccountUid === task.cloudAccountUid && row.regionId === task.regionId);
            const code = artifacts.some(row => aliyunPackSnapshotBaselineIssue(row, day) === null) ? null
                : artifacts.length ? aliyunPackSnapshotBaselineIssue(artifacts[0], day) : 'SNAPSHOT_BASELINE_MISSING';
            if (code) return { groups: [], coveredLedgerIds: [], rowCount: leaf.length, issue: { code, message: BILLING_REASONS[code] } };
        }
        return this.splitGroups(claim, context, leaf);
    }
    async processOne() {
        const claim = await this.store.claim();
        if (!claim)
            return false;
        const evidence: BillingQueryEvidence = { requestIds: [], pageCount: 0, rowCount: 0, complete: false };
        let lost = false;
        const check = async () => { if (lost)
            throw new Error('BILLING_CLAIM_LOST'); await this.store.assertClaim(claim.task.id, claim.task.leaseToken!); };
        const timer = setInterval(() => { void check().catch(() => { lost = true; }); }, 30000);
        timer.unref();
        try {
            if (claim.task.kind === 'planner') {
                const plan = claim.task.queryPlan as {
                    input: LifecycleWindow & {
                        entryId?: string;
                    };
                    actorId: string;
                };
                const actor = await this.repository.getPlatformUserById(plan.actorId);
                if (!actor || actor.role !== 'admin' || actor.status !== 'active')
                    throw new Error('SOURCE_UNVERIFIED');
                await this.schedule(plan.input, true, false, claim.task.targetLedgerIds);
                await check();
                await this.store.finishPlanning(claim);
                return true;
            }
            const context = await this.config.getAccountContextById(claim.task.cloudAccountContextId);
            if (context.provider !== claim.task.cloudProvider || context.accountUid !== claim.task.cloudAccountUid || !context.accountUidResolved
                || context.defaultRegion !== claim.task.regionId)
                throw new Error('ACCOUNT_CHANGED');
            const now = new Date(billingDayText(new Date()) + 'T00:00:00Z'), months = ['snapshot', 'oss'].includes(claim.task.productCode ?? '') ? 12 : 18;
            const earliest = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months + 1, 1));
            if (claim.task.billingDate < earliest)
                throw new Error('HISTORY_UNAVAILABLE');
            const current = await this.lifecycle.loadProof();
            const expected = (claim.task.queryPlan as {
                identities?: Record<string, string>;
            }).identities ?? {};
            if (claim.task.targetLedgerIds.some(id => {
                const row = current.ledgers.find(row => row.id === id);
                return !row || !isPlatformCreatedLedger(row, current.proof) || identityDigest(row) !== expected[id];
            }))
                throw new Error('SOURCE_UNVERIFIED');
            const result = await this.bss.captureQuery(evidence, () => this.query(claim, context, current.proof), check);
            await check();
            if (evidence.pageCount !== evidence.requestIds.length)
                throw new Error('Incomplete official query receipts');
            const outcome = result.issue ? 'blocked' : !result.rowCount ? 'empty' : result.coveredLedgerIds.some(id => claim.task.targetLedgerIds.includes(id)) ? 'verified' : 'blocked';
            const issue = result.issue ?? (outcome === 'blocked' ? { code: 'ALLOCATION_PENDING', message: BILLING_REASONS.ALLOCATION_PENDING } : undefined);
            await this.store.finish(claim, result, evidence, outcome, issue);
        }
        catch (error) {
            if (!lost) {
                const permission = (error instanceof BillingRpcError || error instanceof BillingSplitBillUnavailableError) && /forbidden|permission|unauthorized|denied/i.test(error.code);
                const code = permission ? 'QUERY_PERMISSION_DENIED' : error instanceof BillingSplitBillUnavailableError ? 'SPLIT_UNAVAILABLE'
                    : error instanceof Error && error.message === 'BILLING_TAG_FILTER_UNVERIFIED' ? 'QUERY_FILTER_UNVERIFIED'
                    : error instanceof Error && error.message.includes('exceeds ledger precision') ? 'BILLING_AMOUNT_PRECISION'
                    : error instanceof Error && error.message === 'BILLING_PRIOR_MEMBERS_UNVERIFIED' ? 'ALLOCATION_PENDING'
                        : error instanceof Error && ['ACCOUNT_CHANGED', 'SOURCE_UNVERIFIED', 'HISTORY_UNAVAILABLE'].includes(error.message) ? error.message : 'QUERY_FAILED';
                const native = error instanceof BillingRpcError || error instanceof BillingSplitBillUnavailableError
                    ? ' 阿里云错误：' + error.code + (error.requestId ? '；请求 ID ' + error.requestId : '') : '';
                try {
                    await this.store.finish(claim, { groups: [], coveredLedgerIds: [], rowCount: 0 }, evidence, code === 'QUERY_FAILED' ? 'failed' : 'blocked', { code, message: BILLING_REASONS[code] + native });
                }
                catch {
                    this.logger.warn('账单查询执行版本已变化，原金额保持不变，等待后续核对。');
                }
            }
        }
        finally {
            clearInterval(timer);
        }
        return true;
    }
    async tick() {
        const spaces = await runInSystemCloudWorkspaceScope(() => listExecutionCloudWorkspaces(this.config));
        for (const space of spaces ?? []) {
            if (space.provider !== 'alibaba_cloud')
                continue;
            await runInExecutionCloudWorkspace(this.config, space.id, async () => {
                const current=getCurrentCloudWorkspaceScope();
                if(!current||'system'in current)throw new Error('Missing billing execution scope');
                return runInCloudWorkspace({...current,isBillingWorker:true},async()=>{
                const settings = await this.store.settings();
                if (settings.mode === 'legacy')
                    return;
                if (await this.store.hasDueManual()) {
                    await this.processOne();
                    return;
                }
                if (Date.now() - (this.plannedAt.get(space.id) ?? 0) > 3600000) {
                    await recoverBillingInventories(this.repository, { cloudWorkspaceId: space.id, provider: space.provider, accountUid: space.accountUid! });
                    await this.planDaily();
                    this.plannedAt.set(space.id, Date.now());
                }
                if (Date.now() - (this.probedAt.get(space.id) ?? 0) > 7 * 86400000) {
                    const today = billingDayText(new Date()), clock = new Date(today + 'T00:00:00Z');
                    const start = new Date(Date.UTC(clock.getUTCFullYear(), clock.getUTCMonth() - 1, 1)).toISOString().slice(0, 10);
                    await this.schedule({ startAt: start, endAt: today }, false, true);
                    this.probedAt.set(space.id, Date.now());
                }
                await this.processOne();
                });
            }, { provider: space.provider, accountUid: space.accountUid }).catch(() => this.logger.warn('账单核对暂未完成，保留原金额及待核对任务。'));
        }
    }
    async runLoop() {
        while (true) {
            await this.tick();
            await pause(3000);
        }
    }
}
