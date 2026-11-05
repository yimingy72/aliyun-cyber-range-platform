import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ADMIN_REPOSITORY, type AdminRepository, type BillingLedgerResourceRecord, type BillingLineItemRecord, type BillingSourceInstance, type BillingSourceJob } from './admin.repository';
import { BillingReconciliationRepository, type BillingCoverageView } from './billing-reconciliation.repository';
import { BILLING_REASONS, billingKey, billingDates, billingDateText, independentBillResource } from './billing-reconciliation-types';
import { loadPlatformBillingProof, isPlatformCreatedLedger, type PlatformBillingProof } from './billing-platform-scope';
import { currentBillingRows, currentPlatformBillingProof, readPlatformBillingStartedAt } from './billing-current-scope';
import { billingDayText, resolveBillingWindow } from './billing-window';
import { getCurrentCloudWorkspaceScope, requireCurrentCloudWorkspaceId } from '../auth/cloud-workspace-scope';
import { platformBillingItems } from './billing.service';
import { BillingDecimal } from './billing-amount';
import { rangeLaunchBatches } from './range-launch-batches';
import { readAliyunOssDedicatedBilling, aliyunOssBindingCoversBillingDay } from './billing-oss-binding-proof';
import { readAliyunSnapshotEcsScope } from './aliyun-snapshot-ecs-evidence';
import { billingExpenseScope } from './billing-expense-scope';
import { billingChargeItems, billingDocumentStatus, billingEcsSpecs, type BillingDocumentStatus } from './billing-read-model';
import { buildProvisionJobEvidence } from './provision-job-evidence';
import { patrolResourceIdentities } from './resource-patrol-inventory';
export type LifecycleWindow = {
    startAt?: string;
    endAt?: string;
    view?: string;
    userId?: string;
    page?: number;
    pageSize?: number;
    groupBy?: 'batch';
    billStatus?: BillingDocumentStatus;
};
export function billingAmounts(rows: Array<{
    currency: string;
    pretaxAmount: number;
    pretaxAmountExact?: string;
}>) {
    const totals = new Map<string, InstanceType<typeof BillingDecimal>>();
    for (const row of rows)
        totals.set(row.currency, (totals.get(row.currency) ?? new BillingDecimal(0)).plus(row.pretaxAmountExact ?? row.pretaxAmount));
    return [...totals].sort(([a], [b]) => a.localeCompare(b)).map(([currency, value]) => ({ currency, pretaxAmount: value.toNumber(),
        ...(!new BillingDecimal(value.toNumber()).equals(value) ? { pretaxAmountExact: value.toFixed() } : {}) }));
}
export function contiguousCoveredThrough(start: string, end: string, units: Array<{
    billingDate: Date;
    state: string;
    category: string;
}>, categories: string[]) {
    let through: string | null = null;
    const coverage = new Map<string, Set<string>>();
    for (const unit of units) {
        if (!['issued', 'covered_by_parent', 'probe_empty'].includes(unit.state)) continue;
        const day = billingDateText(unit.billingDate), covered = coverage.get(day) ?? new Set<string>();
        covered.add(unit.category);
        coverage.set(day, covered);
    }
    for (const day of billingDates(start, end)) {
        if (!categories.every(category => coverage.get(day)?.has(category)))
            break;
        through = day;
    }
    return through;
}
export const expectedBillingCategories = (ledger: BillingLedgerResourceRecord) => ledger.cloudResourceType === 'eip' ? ['eip_configuration', 'network_usage'] : [ledger.cloudResourceType];

function coverageWindow(ledger: BillingLedgerResourceRecord, window: ReturnType<typeof resolveBillingWindow>, lastComplete: string) {
    const from = [window.startAtText, billingDayText(ledger.billingStartAt)].sort().at(-1)!;
    const allocationEndedAt = readAliyunOssDedicatedBilling(ledger)?.effectiveEndAt ?? null;
    const endAt = allocationEndedAt ? billingDayText(new Date(allocationEndedAt)) : ledger.releasedAt ? billingDayText(ledger.releasedAt) : window.endAtText;
    const lastDay = [window.endAtText, lastComplete].sort()[0];
    return { from, to: [lastDay, endAt].sort()[0], lastDay, probe: from > endAt, allocationEndedAt };
}

@Injectable()
export class BillingLifecycleService {
    private readonly readCache = new Map<string, { loadedAt: number; value?: Awaited<ReturnType<BillingLifecycleService['load']>>; pending?: Promise<Awaited<ReturnType<BillingLifecycleService['load']>>> }>();
    constructor(
    @Inject(ADMIN_REPOSITORY)
    private readonly repository: AdminRepository, private readonly reconciliation: BillingReconciliationRepository) { }
    private async failedBeforeResourceCreation(instance: BillingSourceInstance, jobs: BillingSourceJob[], accountUid?: string | null) {
        if (!['create_failed','destroyed'].includes(instance.status) || !accountUid) return false;
        try { if (patrolResourceIdentities(instance.resourceSummary).length) return false; } catch { return false; }
        const ownJobs = jobs.filter(job => job.rangeInstanceId === instance.id && job.cloudWorkspaceId === instance.cloudWorkspaceId);
        if (!ownJobs.some(job => job.id === instance.lastJobId) || ownJobs.some(job => job.jobType === 'update'
            || job.jobType === 'retry' && !['create','destroy'].includes(job.topologySnapshot?.operation ?? ''))) return false;
        const attempts = ownJobs.filter(job => job.jobType === 'create' || job.jobType === 'retry' && job.topologySnapshot?.operation === 'create');
        if (!attempts.length || attempts.some(job => job.status !== 'failed' || !job.startedAt || !job.finishedAt)) return false;
        if (instance.instanceMode === 'single') {
            const evidence = await Promise.all(ownJobs.map(async job => ({ job, steps: (await this.repository.listProvisionJobStepLogs(job.id))
                .filter(step => step.jobId === job.id && step.cloudWorkspaceId === job.cloudWorkspaceId) })));
            const projections = evidence.map(({job,steps}) => buildProvisionJobEvidence(job,steps,ownJobs,[],instance));
            if (projections.some(row => row.invalidInventoryCount || row.inventories.some(item => Object.keys(item.resources).length))
                || evidence.some(row => row.steps.some(step => ['range_resource_creation_receipt','single_instance_creation_receipt','platform_billing_creation_inventory'].includes(step.stepName)))) return false;
            const rejections = projections.flatMap(row => row.creationRejections).filter(row => row.cloudAccountUid === accountUid);
            return attempts.every(job => rejections.some(row => row.sourceProvisionJobId === job.id));
        }
        const proofs = await Promise.all(attempts.map(async job => {
            const steps = (await this.repository.listProvisionJobStepLogs(job.id)).filter(step => step.jobId === job.id && step.cloudWorkspaceId === job.cloudWorkspaceId);
            // A failed render is before cloud creation. Empty ledgers or successful cleanup alone cannot establish this.
            if (!steps.some(step => step.stepName === 'render_template' && step.status === 'failed' && step.startedAt && step.finishedAt
                && step.startedAt >= job.startedAt! && step.finishedAt <= job.finishedAt!)
                || steps.some(step => ['tofu_apply','range_resource_creation_receipt','single_instance_creation_receipt','platform_billing_creation_inventory'].includes(step.stepName))) return false;
            const evidence = buildProvisionJobEvidence(job, steps, [], []);
            return evidence.invalidInventoryCount === 0 && evidence.inventories.length > 0 && evidence.inventories.every(row =>
                row.executionContext.provider === instance.cloudProvider && row.executionContext.cloudAccountUid === accountUid
                && Object.keys(row.resources).length === 0);
        }));
        return proofs.every(Boolean);
    }
    window(input: LifecycleWindow) {
        const window = resolveBillingWindow(input);
        if ((window.endAt.getTime() - window.startAt.getTime()) / 86400000 > 366)
            throw new BadRequestException('请按不超过一年的区间查看或分段核对账单。');
        return window;
    }
    async loadProof(display = false) {
        const scope = getCurrentCloudWorkspaceScope(), workspace = requireCurrentCloudWorkspaceId();
        if (!scope || 'system' in scope)
            throw new BadRequestException('请选择已核验的云账号空间。');
        const all = currentPlatformBillingProof(await loadPlatformBillingProof(this.repository, {display}), readPlatformBillingStartedAt());
        const manager = scope.isPlatformManager === true || scope.isBillingWorker === true;
        const visible = (row: {
            cloudWorkspaceId?: string;
            ownerUserId?: string | null;
        }) => row.cloudWorkspaceId === workspace && (manager || row.ownerUserId === scope.actorUserId);
        const ledgers = all.ledgers.filter(row => visible(row) && (manager || billingExpenseScope(row).billingScope === 'user'));
        const proof = { ...all, ledgers, createdLedgerIds: new Set(ledgers.filter(row => all.createdLedgerIds.has(row.id)
            && row.cloudProvider === scope.provider && (!scope.accountUid || row.cloudAccountUid === scope.accountUid)).map(row => row.id)) };
        return { all, scope, workspace, manager, ledgers, proof, visible };
    }
    private async read(input: LifecycleWindow, refresh = false) {
        const scope = getCurrentCloudWorkspaceScope(), window = this.window(input);
        if (!scope || 'system' in scope) throw new BadRequestException('请选择已核验的云账号空间。');
        const key = JSON.stringify([scope.cloudWorkspaceId, scope.provider, scope.accountUid, scope.actorUserId, scope.isPlatformManager === true,
            scope.isBillingWorker === true, scope.isReadOnly === true, readPlatformBillingStartedAt()?.toISOString(), window.startAtText, window.endAtText]);
        const cached = this.readCache.get(key);
        if (cached?.pending) return cached.pending;
        if (!refresh && cached?.value && Date.now() - cached.loadedAt < 30_000) return cached.value;
        if (!cached && this.readCache.size >= 8) this.readCache.delete(this.readCache.keys().next().value!);
        const cell: { loadedAt: number; value?: Awaited<ReturnType<BillingLifecycleService['load']>>; pending?: Promise<Awaited<ReturnType<BillingLifecycleService['load']>>> } = { loadedAt: 0 };
        this.readCache.set(key, cell);
        const pending = this.load(input, true).then(value => { cell.value = value; cell.loadedAt = Date.now(); cell.pending = undefined; return value; }, error => { if (this.readCache.get(key) === cell) this.readCache.delete(key); throw error; });
        cell.pending = pending;
        return pending;
    }
    async load(input: LifecycleWindow, display = false) {
        const window = this.window(input);
        const compact = display && typeof this.reconciliation.displayQueryStatus === 'function';
        const billWindow = {startAt: window.startAt, endAt: window.endAt};
        const [{ all, scope, workspace, manager, ledgers, proof, visible }, users, allTasks, settings, prefetchedItems] = await Promise.all([
            this.loadProof(compact), this.repository.listPlatformUsers(),
            compact ? [] : typeof this.reconciliation.taskSummaries === 'function' ? this.reconciliation.taskSummaries() : this.reconciliation.tasks(), this.reconciliation.settings(),
            // The scoped billing rows can arrive alongside provenance; they are still verified against it below.
            compact ? this.repository.listBillingLineItems(billWindow) : null,
        ]);
        const instances = all.sourceInstances ?? await this.repository.listRangeInstances();
        const list = instances.filter(visible);
        const lastComplete = new Date(Date.parse(billingDayText(new Date()) + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10);
        const bounds = new Map(ledgers.map(ledger => [ledger.id, coverageWindow(ledger, window, lastComplete)]));
        const ledgerIds = ledgers.map(row => row.id);
        const [batches, rawItems, jobs, units, receipts, queryStatus] = await Promise.all([
            this.repository.listSingleInstanceBatchNames([...new Set(list.flatMap(row => row.singleInstanceBatchId ? [row.singleInstanceBatchId] : []))]),
            prefetchedItems ?? this.repository.listBillingLineItems({ ...billWindow,
                // A new snapshot can still be billed through an older ECS source.
                matchedLedgerIds: [...new Set([...ledgers.map(row => row.id),
                    ...(proof.snapshotParentProof?.ledgers.filter(row => row.cloudResourceType === 'ecs').map(row => row.id) ?? [])])] }),
            all.sourceJobs ?? this.repository.listProvisionJobs(),
            compact ? this.reconciliation.displayUnits([...bounds].flatMap(([ledgerId, range]) => {
                const to = range.probe ? range.lastDay : range.to;
                return range.from <= to ? [{ledgerId, from:range.from, to, probe:range.probe}] : [];
            }), ledgerIds) : this.reconciliation.units(ledgerIds, window.startAtText, window.endAtText),
            this.repository.listRangeLaunchReceipts(list.filter(row => row.instanceMode === 'range').map(row => row.id)),
            compact ? this.reconciliation.displayQueryStatus(ledgerIds) : null,
        ]);
        const visibleIds=new Set(ledgers.map(row=>row.id));
        const tasks=allTasks.filter(task=>manager||task.targetLedgerIds.length>0&&task.targetLedgerIds.every(id=>visibleIds.has(id)));
        const items = platformBillingItems(currentBillingRows(rawItems, readPlatformBillingStartedAt()), proof);
        const links = new Map(items.map(item => {
            const parent = item.productCode === 'snapshot' && item.cloudResourceType === 'ecs' && item.cloudAccountUid
                ? readAliyunSnapshotEcsScope(item.rawPayload, proof, billingDateText(item.billingDate), item.cloudAccountUid) : null;
            return [item.sourceFingerprint, { ids: parent?.snapshotLedgerIds ?? (item.matchedLedgerId ? [item.matchedLedgerId] : []), scope: parent }] as const;
        }));
        const billedLedgerIds = new Set([...links.values()].flatMap(row => row.ids));
        const billable = (row: BillingLedgerResourceRecord) => independentBillResource(row) || billedLedgerIds.has(row.id);
        const names = new Map(users.map(row => [row.id, row.username]));
        const batchesById = new Map(batches.map(row => [row.id, row]));
        const rangeBatches = rangeLaunchBatches(list, receipts);
        const overlaps = (ledger: BillingLedgerResourceRecord) => billingDayText(ledger.billingStartAt) <= window.endAtText
            && (!ledger.releasedAt || billingDayText(ledger.releasedAt) >= window.startAtText);
        const entryResources = new Map<string, BillingLedgerResourceRecord[]>();
        const roots: Array<{
            id: string;
            kind: 'single' | 'range' | 'platform_image' | 'platform_bucket' | 'resource' | 'platform_import';
            name: string;
            ownerUserId: string | null;
            batch: {
                id: string;
                name: string;
            } | null;
            createdAt: Date;
            instanceStatus: string | null;
            plannedExpiresAt: Date | null;
            instanceId: string | null;
            sourceImportJobIds?: string[];
            sourcePackedImageArtifactIds?: string[];
            sourceInstanceId?: string | null;
            sourceInstanceName?: string | null;
        }> = [];
        for (const instance of list) {
            const resources = ledgers.filter(row => billingExpenseScope(row).billingScope === 'user' && row.rangeInstanceId === instance.id && billable(row)
                && (overlaps(row) || billedLedgerIds.has(row.id)));
            if (!resources.length && (billingDayText(instance.createdAt) < window.startAtText || billingDayText(instance.createdAt) > window.endAtText))
                continue;
            const launchBatch = rangeBatches.get(instance.id);
            const singleBatch = instance.singleInstanceBatchId ? batchesById.get(instance.singleInstanceBatchId) : null;
            const id = 'instance:' + instance.id;
            roots.push({ id, kind: instance.instanceMode, name: instance.name, ownerUserId: resources[0]?.ownerUserId ?? instance.ownerUserId,
                batch: launchBatch ? { id: launchBatch.id, name: launchBatch.name } : singleBatch ? { id: singleBatch.id, name: singleBatch.name } : null,
                createdAt: instance.createdAt, instanceStatus: instance.status, plannedExpiresAt: instance.expiresAt, instanceId: instance.id });
            entryResources.set(id, resources);
        }
        for (const ledger of ledgers.filter(row => billingExpenseScope(row).billingScope === 'platform' && billable(row) && (overlaps(row) || billedLedgerIds.has(row.id)))) {
            const origins = all.packedImages.filter(row => row.cloudAccountUid === ledger.cloudAccountUid && row.regionId === ledger.regionId
                && (row.cloudProvider ?? 'alibaba_cloud') === ledger.cloudProvider && (row.cloudWorkspaceId ?? 'legacy-unbound') === workspace
                && (row.imageId === ledger.cloudResourceId || row.backingSnapshotIds.includes(ledger.cloudResourceId)));
            const origin = origins.length === 1 ? origins[0] : null;
            const asset = ledger.platformImageAssetId ?? origin?.platformImageAssetId;
            const importId = ledger.tagsSnapshot.PlatformImageImportJobId;
            const key = ledger.cloudResourceType === 'oss_bucket' ? 'bucket:' + ledger.id : origin ? 'image-export:' + origin.id : importId ? 'image-import:' + importId : asset ? 'image:' + asset : 'resource:' + ledger.id;
            if (!entryResources.has(key)) {
                const image = asset ? await this.repository.getPlatformImageAssetById(asset) : null;
                const sourceName = instances.find(row => row.id === (origin?.sourceRangeInstanceId ?? ledger.rangeInstanceId))?.name;
                roots.push({ id: key, kind: ledger.cloudResourceType === 'oss_bucket' ? 'platform_bucket' : ['snapshot','image'].includes(ledger.cloudResourceType) ? 'platform_image' : 'resource', name: image?.displayName ?? (sourceName && ['snapshot','image'].includes(ledger.cloudResourceType) ? sourceName + ' · 镜像 / 快照' : ledger.cloudResourceId),
                    ownerUserId: null, batch: null, createdAt: ledger.billingStartAt, instanceStatus: origin?.status ?? null, plannedExpiresAt: null, instanceId: null,
                    sourceInstanceId: origin?.sourceRangeInstanceId ?? ledger.rangeInstanceId,
                    sourceInstanceName: instances.find(row => row.id === (origin?.sourceRangeInstanceId ?? ledger.rangeInstanceId))?.name ?? null,
                    sourcePackedImageArtifactIds: origin ? [origin.id] : [] });
                entryResources.set(key, []);
            }
            entryResources.get(key)!.push(ledger);
        }
        if (manager) for (const artifact of all.packedImages) {
            if ((artifact.cloudWorkspaceId ?? 'legacy-unbound') !== workspace || (artifact.cloudProvider ?? 'alibaba_cloud') !== scope.provider || artifact.cloudAccountUid !== scope.accountUid) continue;
            const id = 'image-export:' + artifact.id;
            if (entryResources.has(id) || billingDayText(artifact.createdAt) < window.startAtText || billingDayText(artifact.createdAt) > window.endAtText) continue;
            const source = instances.find(row => row.id === artifact.sourceRangeInstanceId);
            const asset = artifact.platformImageAssetId ? await this.repository.getPlatformImageAssetById(artifact.platformImageAssetId) : null;
            roots.push({ id, kind: 'platform_image', name: asset?.displayName ?? (source?.name ? source.name + ' · 镜像导出' : '镜像导出'), ownerUserId: null,
                batch: null, createdAt: artifact.createdAt, instanceStatus: artifact.status, plannedExpiresAt: null, instanceId: null,
                sourceInstanceId: artifact.sourceRangeInstanceId, sourceInstanceName: source?.name ?? null, sourcePackedImageArtifactIds: [artifact.id] });
            entryResources.set(id, []);
        }
        const pendingImportRoots = new Set<string>();
        if (manager) for (const job of all.imageImports) {
            if (job.cloudWorkspaceId !== workspace || (job.cloudProvider ?? 'alibaba_cloud') !== 'alibaba_cloud' || scope.provider !== 'alibaba_cloud'
                || job.cloudAccountUid && scope.accountUid && job.cloudAccountUid !== scope.accountUid || !job.imageImportBucket || !job.objectKey) continue;
            const begin = job.uploadCompletedAt ?? job.createdAt;
            const from = [billingDayText(begin), window.startAtText].sort().at(-1)!;
            const to = [job.temporaryObjectDeletedAt && job.temporaryObjectDeletedAt >= begin ? billingDayText(job.temporaryObjectDeletedAt) : window.endAtText, window.endAtText].sort()[0];
            if (from > to) continue;
            const candidates = ledgers.filter(row => row.cloudResourceType === 'oss_bucket' && row.cloudResourceId === job.imageImportBucket
                && row.regionId === job.regionId && row.cloudAccountUid === job.cloudAccountUid);
            const covered = billingDates(from, to).every(day => candidates.some(row => {
                const binding = readAliyunOssDedicatedBilling(row);
                return binding && binding.cloudAccountContextId === job.cloudAccountContextId && Date.parse(binding.bucketCreatedAt) <= begin.getTime()
                    && aliyunOssBindingCoversBillingDay(binding, day);
            }));
            const existing = candidates.map(row => roots.find(root => root.id === 'bucket:' + row.id)).find(Boolean);
            if (covered) continue;
            const id = existing?.id ?? 'upload-source:' + billingKey([job.cloudAccountContextId, job.cloudAccountUid, job.regionId, job.imageImportBucket]);
            let root = roots.find(row => row.id === id);
            if (!root) {
                root = { id, kind: 'platform_import', name: job.imageImportBucket, ownerUserId: null, batch: null, createdAt: begin,
                    instanceStatus: null, plannedExpiresAt: null, instanceId: null, sourceImportJobIds: [] };
                roots.push(root); entryResources.set(id, []);
            }
            (root.sourceImportJobIds ??= []).push(job.id);
            if (root.kind === 'platform_import' && begin < root.createdAt) root.createdAt = begin;
            pendingImportRoots.add(id);
        }
        const attached = new Set([...entryResources.values()].flatMap(rows => rows.map(row => row.id)));
        for (const ledger of ledgers.filter(row => billable(row) && !attached.has(row.id) && (overlaps(row) || billedLedgerIds.has(row.id)))) {
            const id = 'resource:' + ledger.id;
            roots.push({ id, kind: 'resource', name: ledger.cloudResourceId, ownerUserId: ledger.ownerUserId, batch: null,
                createdAt: ledger.billingStartAt, instanceStatus: null, plannedExpiresAt: null, instanceId: null });
            entryResources.set(id, [ledger]);
        }
        const feeOwners = new Map<string, string>(), sharedRoots = new Map<string, string>();
        const originalRoots = [...roots];
        for (const item of items) {
            const link = links.get(item.sourceFingerprint)!;
            if (!link.scope)
                continue;
            const owners = originalRoots.filter(root => entryResources.get(root.id)!.some(ledger => link.ids.includes(ledger.id)));
            if (owners.length < 2)
                continue;
            const key = 'snapshot-group:' + billingKey([item.cloudAccountUid, link.scope.regionId, link.scope.sourceInstanceId]);
            if (!entryResources.has(key)) {
                const members = ledgers.filter(ledger => link.ids.includes(ledger.id));
                roots.push({ id: key, kind: 'platform_image', name: '快照合并计费组 ' + link.scope.sourceInstanceId, ownerUserId: item.ownerUserId ?? null,
                    batch: null, createdAt: members.map(row => row.billingStartAt).sort((a, b) => a.getTime() - b.getTime())[0] ?? new Date(item.billingDate), instanceStatus: null, plannedExpiresAt: null, instanceId: null });
                entryResources.set(key, []);
            }
            const target = entryResources.get(key)!;
            for (const ledger of ledgers.filter(row => link.ids.includes(row.id)))
                if (!target.some(row => row.id === ledger.id))
                    target.push(ledger);
            feeOwners.set(item.sourceFingerprint, key);
            for (const owner of owners)
                sharedRoots.set(owner.id, key);
        }
        const firstRootByLedger = new Map<string, number>(), feeRowsByRoot = new Map<string, BillingLineItemRecord[]>();
        roots.forEach((root, index) => {
            for (const ledger of entryResources.get(root.id)!) if (!firstRootByLedger.has(ledger.id)) firstRootByLedger.set(ledger.id, index);
        });
        for (const item of items) {
            let root = feeOwners.get(item.sourceFingerprint);
            if (!root) {
                let first = Infinity;
                for (const ledgerId of links.get(item.sourceFingerprint)!.ids) first = Math.min(first, firstRootByLedger.get(ledgerId) ?? Infinity);
                root = roots[first]?.id;
            }
            if (!root) continue;
            const rows = feeRowsByRoot.get(root) ?? [];
            rows.push(item);
            feeRowsByRoot.set(root, rows);
        }
        const seenFees = new Set<string>(), entryItems = new Map<string, BillingLineItemRecord[]>();
        const unitsByLedger = new Map<string, BillingCoverageView[]>(), itemsByLedger = new Map<string, typeof items>();
        const tasksById = new Map<string, {id:string;availableAt:Date}>(tasks.map(row => [row.id, row]));
        for (const row of units) {
            const list = unitsByLedger.get(row.ledgerId) ?? []; list.push(row); unitsByLedger.set(row.ledgerId, list);
            if ('visibleTaskId' in row && row.visibleTaskId && row.taskAvailableAt)
                tasksById.set(row.visibleTaskId, {id:row.visibleTaskId, availableAt:row.taskAvailableAt});
        }
        for (const row of items) if (row.matchedLedgerId) { const list = itemsByLedger.get(row.matchedLedgerId) ?? []; list.push(row); itemsByLedger.set(row.matchedLedgerId, list); }
        const entryInstanceIds = new Set(roots.flatMap(root => root.instanceId ? [root.instanceId] : []));
        const withoutResourceCreation = new Set((await Promise.all(list.filter(instance => entryInstanceIds.has(instance.id)
            && !all.ledgers.some(row => row.rangeInstanceId === instance.id))
            .map(async instance => await this.failedBeforeResourceCreation(instance, jobs, scope.accountUid) ? instance.id : null))).filter((id): id is string => id !== null));
        const entries = roots.map(root => {
            const resources = entryResources.get(root.id)!;
            const feeRows = feeRowsByRoot.get(root.id) ?? [];
            const uniqueFees = feeRows.filter(row => { if (seenFees.has(row.sourceFingerprint))
                return false; seenFees.add(row.sourceFingerprint); return true; });
            entryItems.set(root.id, uniqueFees);
            const resourceViews = resources.map(ledger => this.resourceView(ledger, itemsByLedger.get(ledger.id) ?? [], unitsByLedger.get(ledger.id) ?? [], tasksById, bounds.get(ledger.id)!, proof));
            const pending = resourceViews.filter(row => !['issued', 'covered_by_parent'].includes(row.state));
            const failed = resourceViews.some(row => row.state === 'query_error'), unverified = resourceViews.some(row => row.state === 'source_pending');
            const dates = resourceViews.map(row => row.coveredThrough).filter((value): value is string => Boolean(value)).sort();
            const last = (field: 'lastQueriedAt' | 'lastVerifiedAt') => resourceViews.map(row => row[field]).filter((value): value is string => Boolean(value)).sort().at(-1) ?? null;
            const released = resources.filter(row => row.releasedAt);
            const allocationEnded = root.kind === 'platform_bucket' && resources.length > 0 && resources.every(row => readAliyunOssDedicatedBilling(row)?.effectiveEndAt);
            const billingNotRequired = uniqueFees.length === 0 && resources.length === 0 && withoutResourceCreation.has(root.instanceId ?? '');
            const missingInventory = !billingNotRequired && resources.length === 0 && (Boolean(root.instanceStatus?.includes('failed')) || root.instanceStatus === 'destroyed'
                || jobs.some(job => job.rangeInstanceId === root.instanceId && ['create','retry','update'].includes(job.jobType) && job.status === 'failed'));
            const lifecycleStatus = resources.length && released.length === resources.length || !resources.length && (root.instanceStatus === 'destroyed' || root.kind === 'platform_image' && root.instanceStatus === 'deleted') ? 'released' : allocationEnded ? 'allocation_ended' : released.length || root.instanceStatus === 'destroyed' && resources.length ? 'partially_released'
                : root.instanceStatus && /failed/.test(root.instanceStatus) ? 'failed' : root.instanceStatus && /creat|pending/.test(root.instanceStatus) ? 'creating' : 'active';
            return { ...root, ownerUsername: root.ownerUserId ? names.get(root.ownerUserId) ?? root.ownerUserId : null,
                createdAt: root.createdAt.toISOString(), plannedExpiresAt: root.plannedExpiresAt?.toISOString() ?? null,
                releaseConfirmedAt: released.length === resources.length && resources.length ? released.map(row => row.releasedAt!.toISOString()).sort().at(-1)! : null,
                lifecycleStatus, billingNotRequired, reconciliationStatus: unverified || missingInventory || pendingImportRoots.has(root.id) ? 'source_pending' : failed ? 'query_error' : billingNotRequired ? 'current' : !resources.length ? 'waiting' : !pending.length ? 'current' : uniqueFees.length ? 'partial'
                    : resourceViews.some(row => row.state === 'no_bill') ? 'no_bill' : 'waiting', amounts: billingAmounts(uniqueFees), resourceCount: resources.length, pendingResourceCount: pending.length,
                lastQueriedAt: last('lastQueriedAt'), lastVerifiedAt: last('lastVerifiedAt'), coveredThrough: dates.length === resources.length ? dates[0] : null,
                resources: resourceViews, coveredByEntryId: sharedRoots.get(root.id) ?? null,
                issueMessage: billingNotRequired ? '创建请求未产生计费资源，无需等待出账。' : pendingImportRoots.has(root.id) ? '上传桶费用归属待核验' : missingInventory ? '计费资源记录待核验' : null };
        }).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
        return { window, entries: entries.map(entry => ({ ...entry, billingStatus: billingDocumentStatus(entry) })), items, ledgers, proof, jobs, units, tasks, settings, scope, entryItems, queryStatus,
            integrity: { bookedRows: items.length, representedRows: seenFees.size, unrepresentedRows: items.filter(row => !seenFees.has(row.sourceFingerprint)).length } };
    }
    private resourceView(ledger: BillingLedgerResourceRecord, items: BillingLineItemRecord[], units: BillingCoverageView[], tasks: Map<string, { id: string; availableAt: Date }>, bounds: ReturnType<typeof coverageWindow>, proof: PlatformBillingProof) {
        const {from, allocationEndedAt} = bounds;
        const transactions = bounds.probe && items.some(row => row.matchedLedgerId === ledger.id);
        const to = transactions ? bounds.lastDay : bounds.to;
        const own = units.filter(row => row.ledgerId === ledger.id && (transactions ? row.category.startsWith('probe:') : !row.category.startsWith('probe:')) && billingDateText(row.billingDate) >= from && billingDateText(row.billingDate) <= to);
        const categories = transactions ? ['probe:transactions'] : expectedBillingCategories(ledger);
        const through = from <= to ? contiguousCoveredThrough(from, to, own, categories) : null;
        const complete = Boolean(through && through === to), pending = own.filter(row => !['issued', 'covered_by_parent'].includes(row.state));
        const last = own.filter(row => row.lastQueriedAt).sort((a, b) => b.lastQueriedAt!.getTime() - a.lastQueriedAt!.getTime())[0];
        const bad = pending.find(row => row.state === 'query_error') ?? pending.find(row => row.state === 'source_pending') ?? pending.find(row => row.state === 'partial') ?? pending.find(row => row.state === 'no_bill') ?? pending[0];
        const proven = isPlatformCreatedLedger(ledger, proof);
        const state = !proven ? 'source_pending' : complete ? (own.every(row => row.state === 'covered_by_parent') ? 'covered_by_parent' : 'issued') : bad?.state ?? 'awaiting_query';
        const code = !proven ? 'SOURCE_UNVERIFIED' : bad?.reasonCode ?? (from > to ? 'NOT_YET_DUE' : null);
        const task = tasks.get(bad?.queryTaskId ?? last?.queryTaskId ?? '');
        return { ledgerId: ledger.id, cloudResourceId: ledger.cloudResourceId, cloudResourceType: ledger.cloudResourceType, cloudProvider: ledger.cloudProvider, regionId: ledger.regionId,
            billingStartAt: ledger.billingStartAt.toISOString(), releasedAt: ledger.releasedAt?.toISOString() ?? null, allocationEndedAt, state, amounts: billingAmounts(items.filter(row => row.matchedLedgerId === ledger.id)),
            coveredThrough: through, lastQueriedAt: last?.lastQueriedAt?.toISOString() ?? null, lastVerifiedAt: own.map(row => row.lastVerifiedAt?.toISOString()).filter(Boolean).sort().at(-1) ?? null,
            reasonCode: code, reasonMessage: bad?.reasonMessage ?? (code ? BILLING_REASONS[code] ?? '明细仍待核对。' : null), nextQueryAt: task?.availableAt.toISOString() ?? null,
            queryTaskId: task?.id ?? null, lastQueryAttemptId: last?.lastAttemptId ?? null,
            parentBillingResourceId: own.find(row => row.parentBillingResourceId)?.parentBillingResourceId ?? null };
    }
    async list(input: LifecycleWindow, refresh = false) {
        const data = await this.read(input, refresh), all = data.entries;
        const selected = all.filter(row => (input.view === 'platform' ? row.ownerUserId === null : row.ownerUserId !== null) && (!input.userId || row.ownerUserId === input.userId));
        const size = [20, 50, 100].includes(input.pageSize ?? 20) ? input.pageSize ?? 20 : 20;
        const leafRows = selected.map(({ resources, instanceId, ...entry }) => ({ ...entry, rowType: 'entry' as 'entry' | 'batch', members: [] as Array<Omit<typeof entry,'members'>> }));
        let rows = leafRows;
        if (input.groupBy === 'batch') {
            const groups = new Map<string, typeof leafRows>();
            for (const row of leafRows) if (row.batch) { const key = JSON.stringify([row.batch.id,row.ownerUserId,row.kind]); const members = groups.get(key) ?? []; members.push(row); groups.set(key,members); }
            const emitted = new Set<string>();
            rows = leafRows.flatMap(row => {
                if (!row.batch) return [row];
                const key = JSON.stringify([row.batch.id,row.ownerUserId,row.kind]), members = groups.get(key)!;
                if (members.length < 2) return [row];
                if (emitted.has(key)) return []; emitted.add(key);
                const billableMembers = members.filter(member => member.billingStatus !== 'not_applicable');
                const billingStatus: BillingDocumentStatus = !billableMembers.length ? 'not_applicable'
                    : billableMembers.every(member => member.billingStatus === 'issued') ? 'issued'
                    : members.some(member => member.amounts.length || member.coveredByEntryId) ? 'partial'
                    : billableMembers.some(member => member.billingStatus === 'pending') ? 'pending' : 'unissued';
                return [{ ...row, id: 'batch:' + billingKey(key), name: row.batch.name, rowType: 'batch' as const, members,
                    amounts: billingAmounts(members.flatMap(member => member.amounts)), billingStatus, billingNotRequired: !billableMembers.length,
                    resourceCount: members.reduce((sum,member)=>sum+member.resourceCount,0), pendingResourceCount: members.reduce((sum,member)=>sum+member.pendingResourceCount,0),
                    createdAt: members.map(member=>member.createdAt).sort()[0], instanceStatus: null, issueMessage: null,
                    lastQueriedAt: members.map(member=>member.lastQueriedAt).filter((date): date is string=>Boolean(date)).sort().at(-1) ?? null,
                    lastVerifiedAt: members.map(member=>member.lastVerifiedAt).filter((date): date is string=>Boolean(date)).sort().at(-1) ?? null }];
            });
        }
        const billingStatusCounts = Object.fromEntries((['issued','partial','unissued','not_applicable','pending'] as const).map(status => [status,rows.filter(row=>row.billingStatus===status).length])) as Record<BillingDocumentStatus,number>;
        if (input.billStatus) rows = rows.filter(row=>row.billingStatus===input.billStatus);
        const page = Math.min(Math.max(1, input.page ?? 1), Math.max(1, Math.ceil(rows.length / size)));
        const totals = billingAmounts(data.items);
        const batches = [...new Map(selected.filter(row => row.batch).map(row => [row.batch!.id, row.batch!])).values()];
        const batchSummaries = batches.map(batch => {
            const members = selected.filter(row => row.batch?.id === batch.id);
            return { ...batch, memberCount: members.length, pendingResourceCount: members.reduce((sum, row) => sum + row.pendingResourceCount, 0),
                pendingEntryCount: members.filter(row => row.reconciliationStatus !== 'current').length,
                amounts: billingAmounts(members.flatMap(row => row.amounts)) };
        });
        return { version: 2, startAt: data.window.startAtText, endAt: data.window.endAtText, mode: data.settings.mode,
            items: rows.slice((page - 1) * size, page * size), page, pageSize: size, total: rows.length, entryTotal: selected.length,
            billingStatusCounts, rowTotal: Object.values(billingStatusCounts).reduce((sum,count)=>sum+count,0),
            currencyTotals: totals.map(amount => ({ ...amount, userPretaxAmount: billingAmounts(data.items.filter(row => row.currency === amount.currency && row.billingScope === 'user'))[0]?.pretaxAmount ?? 0,
                platformPretaxAmount: billingAmounts(data.items.filter(row => row.currency === amount.currency && row.billingScope === 'platform'))[0]?.pretaxAmount ?? 0,
                userPretaxAmountExact: billingAmounts(data.items.filter(row => row.currency === amount.currency && row.billingScope === 'user'))[0]?.pretaxAmountExact,
                platformPretaxAmountExact: billingAmounts(data.items.filter(row => row.currency === amount.currency && row.billingScope === 'platform'))[0]?.pretaxAmountExact })),
            batchSummaries,
            filteredAmounts: billingAmounts(rows.flatMap(row => row.amounts)), pendingEntryCount: all.filter(row => row.reconciliationStatus !== 'current').length,
            integrity: data.integrity,
            pendingResourceCount: new Set(all.flatMap(row => row.resources.filter(resource => !['issued', 'covered_by_parent'].includes(resource.state)).map(resource => resource.ledgerId))).size,
            queryStatus: data.queryStatus ?? { lastRunAt: data.tasks.map(row => row.lastQueriedAt?.toISOString()).filter(Boolean).sort().at(-1) ?? null, nextRunAt: data.tasks.filter(row => row.status !== 'planned').map(row => row.availableAt.toISOString()).sort()[0] ?? null,
                queuedCount: data.tasks.filter(row => ['pending', 'backoff'].includes(row.status)).length, runningCount: data.tasks.filter(row => row.status === 'running').length,
                errorCount: data.tasks.filter(row => row.lastErrorCode).length,
                errorResourceCount: new Set(data.tasks.filter(row => row.lastErrorCode).flatMap(row => row.targetLedgerIds)).size } };
    }
    async detail(id: string, input: LifecycleWindow, refresh = false) {
        const data = await this.read(input, refresh), found = data.entries.find(row => row.id === id);
        if (!found)
            throw new NotFoundException('该账目不存在或不在当前账号与账期范围。');
        const { resources, instanceId, ...entry } = found;
        const titles: Record<string, string> = { create: '创建实例', retry: '重试原任务', destroy: '回收实例', update: '修改拓扑', change_expiry: '修改回收时间', economical_stop: '节省停机', resume: '恢复开机', reset: '重置主机', refresh_status: '核验运行状态' };
        const events = data.jobs.filter(job => job.rangeInstanceId === instanceId).map(job => ({ id: job.id, type: job.jobType as string, title: titles[job.jobType] ?? '实例操作', status: job.status as string,
            at: (job.finishedAt ?? job.startedAt ?? job.createdAt).toISOString(), ...(job.topologySnapshot?.expiryPlan ? {
                previousExpiresAt: job.topologySnapshot.expiryPlan.expiresAt, requestedExpiresAt: job.topologySnapshot.expiryPlan.requestedExpiresAt,
                effectiveExpiresAt: job.status === 'succeeded' ? job.topologySnapshot.expiryPlan.requestedExpiresAt : job.topologySnapshot.expiryPlan.effectiveExpiresAt
            } : {}) }));
        for (const source of data.proof.imageImports.filter(job => entry.sourceImportJobIds?.includes(job.id))) {
            events.push({ id: source.id + ':submitted', type: 'image_upload', title: '提交镜像上传', status: 'succeeded', at: source.createdAt.toISOString() });
            if (source.uploadCompletedAt) events.push({ id: source.id + ':uploaded', type: 'image_upload', title: '上传完成', status: 'succeeded', at: source.uploadCompletedAt.toISOString() });
            if (source.temporaryObjectDeletedAt) events.push({ id: source.id + ':cleaned', type: 'image_upload', title: '上传对象清理', status: 'succeeded', at: source.temporaryObjectDeletedAt.toISOString() });
        }
        for (const source of data.proof.packedImages.filter(job => entry.sourcePackedImageArtifactIds?.includes(job.id)))
            events.push({ id: source.id + ':export', type: 'image_export', title: '镜像导出', status: source.status, at: source.createdAt.toISOString() });
        const items = data.entryItems.get(id) ?? [], charges = billingChargeItems(items, resources, entry.kind === 'single');
        const specs = billingEcsSpecs(items), grouped = new Map<string, typeof charges>();
        for (const charge of charges) {
            const key = JSON.stringify([charge.resourceType, charge.resourceId]), group = grouped.get(key) ?? [];
            group.push(charge); grouped.set(key, group);
        }
        const resourceFees = [...grouped.values()].map(group => {
            const {resourceType, resourceId} = group[0], specification = resourceType === 'ecs' ? specs.get(resourceId) : undefined;
            return {resourceType, resourceId, amounts:billingAmounts(group.flatMap(charge=>charge.amounts)),
                ...(specification ? {specification} : {}), ...(specification === null ? {configurationChanged:true} : {})};
        });
        return { entry, resources, events, charges, resourceFees };
    }
}
