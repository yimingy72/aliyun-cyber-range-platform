import { Injectable, ConflictException } from '@nestjs/common';
import { Prisma, type BillingCoverageUnit } from '@aliyun-cyber-range/database/generated/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../database/prisma.service';
import { getCurrentCloudWorkspaceScope, requireCurrentCloudWorkspaceId } from '../auth/cloud-workspace-scope';
import { BILLING_REASONS, billingDateText, billingKey, financialGroupKey, type BillingMode, type BillingTaskPlan, type BillingQueryEvidence, type ScopedBillingResult } from './billing-reconciliation-types';
import { readPlatformBillingStartedAt } from './billing-current-scope';
import { BillingDecimal } from './billing-amount';
import { isDeepStrictEqual } from 'node:util';

export type BillingCoverageView = Pick<BillingCoverageUnit, 'ledgerId' | 'billingDate' | 'category' | 'state' | 'reasonCode' | 'reasonMessage'
    | 'queryTaskId' | 'parentBillingResourceId' | 'lastQueriedAt' | 'lastVerifiedAt' | 'lastAttemptId' | 'adoptedAttemptId'>;
type DisplayCoverageSpan = { ledgerId: string; from: string; to: string; probe: boolean };

function displayTaskFilter(ledgerIds: string[]) {
    const workspace = requireCurrentCloudWorkspaceId(), scope = getCurrentCloudWorkspaceScope();
    const manager = scope && !('system' in scope) && (scope.isPlatformManager || scope.isBillingWorker);
    return Prisma.sql`task."cloudWorkspaceId" = ${workspace} AND task.status <> 'coordinator'
        ${manager ? Prisma.empty : Prisma.sql`AND cardinality(task."targetLedgerIds") > 0
            AND task."targetLedgerIds" <@ ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(ledgerIds)}::jsonb))`}`;
}

@Injectable()
export class BillingReconciliationRepository {
    constructor(private readonly prisma: PrismaService) { }
    async settings() {
        const id = requireCurrentCloudWorkspaceId();
        const row = await this.prisma.cloudWorkspace.findUniqueOrThrow({ where: { id } });
        if (!['legacy', 'shadow', 'resource'].includes(row.billingReconciliationMode))
            throw new Error('Unknown billing writer mode');
        return { mode: row.billingReconciliationMode as BillingMode, generation: row.billingWriterGeneration, workspace: row };
    }
    async setMode(mode: BillingMode, expectedGeneration: number) {
        const id = requireCurrentCloudWorkspaceId();
        return this.prisma.$transaction(async (tx) => {
            await tx.$executeRaw `SELECT id FROM "CloudWorkspace" WHERE id = ${id} FOR NO KEY UPDATE`;
            const row = await tx.cloudWorkspace.findUniqueOrThrow({ where: { id } });
            if (row.isReadOnly || row.archivedAt)
                throw new ConflictException('历史空间为只读，不能切换账单写入方式。');
            if (row.billingWriterGeneration !== expectedGeneration)
                throw new ConflictException('账单执行版本已变化，请刷新。');
            if (mode === 'resource' && row.provider !== 'alibaba_cloud')
                throw new ConflictException('此版本仅为阿里云启用资源定向对账，腾讯云保留既有同步。');
            const next = await tx.cloudWorkspace.update({ where: { id }, data: { billingReconciliationMode: mode, billingWriterGeneration: { increment: 1 } } });
            if (row.billingReconciliationMode !== mode)
                await tx.billingCoverageUnit.updateMany({ where: { cloudWorkspaceId: id, supersededAt: null },
                    data: { state: 'awaiting_query', adoptedAttemptId: null, reasonCode: 'MODE_CHANGED', reasonMessage: '对账方式已切换，等待新执行版本重新核对。' } });
            await tx.billingReconcileTask.updateMany({ where: { cloudWorkspaceId: id, kind: { not: 'coordinator' } },
                data: { status: 'pending', leaseToken: null, leaseExpiresAt: null, writerGeneration: next.billingWriterGeneration, availableAt: new Date() } });
            return { mode: next.billingReconciliationMode, generation: next.billingWriterGeneration };
        });
    }
    async enqueue(plan: BillingTaskPlan, categories: Array<{
        ledgerId: string;
        category: string;
    }>, force = false) {
        const space = requireCurrentCloudWorkspaceId(), day = new Date(plan.billingDate + 'T00:00:00Z');
        const scope = getCurrentCloudWorkspaceScope();
        if (!scope || 'system' in scope || scope.provider !== plan.cloudProvider || scope.accountUid !== plan.cloudAccountUid)
            throw new Error('BILLING_PLAN_SCOPE_CHANGED');
        return this.prisma.$transaction(async (tx) => {
            await tx.$executeRaw`SELECT id FROM "CloudWorkspace" WHERE id = ${space} FOR NO KEY UPDATE`;
            const current = await tx.cloudWorkspace.findUniqueOrThrow({ where: { id: space } });
            if (current.isReadOnly || current.archivedAt || !['shadow','resource'].includes(current.billingReconciliationMode)
                || current.provider !== plan.cloudProvider || current.accountUid !== plan.cloudAccountUid) throw new Error('BILLING_WRITER_FENCED');
            const generation = current.billingWriterGeneration;
            const found = await tx.billingReconcileTask.findFirst({ where: { cloudWorkspaceId: space, groupKey: plan.groupKey } });
            const data = { ...plan, billingDate: day, cloudWorkspaceId: space, writerGeneration: generation,
                queryPlan: JSON.parse(JSON.stringify({ ...plan.queryPlan, manual: force })) as Prisma.InputJsonValue };
            const previousPlan = { ...(found?.queryPlan as Prisma.JsonObject ?? {}) }, requestedPlan = { ...(data.queryPlan as Prisma.JsonObject) };
            delete previousPlan.manual; delete requestedPlan.manual;
            const changed = found && (!isDeepStrictEqual(previousPlan, requestedPlan)
                || found.cloudAccountContextId !== plan.cloudAccountContextId || found.regionId !== plan.regionId
                || found.instanceId !== (plan.instanceId ?? null) || found.splitItemId !== (plan.splitItemId ?? null) || found.productCode !== (plan.productCode ?? null));
            const inFlight = found?.status === 'running' && found.leaseExpiresAt !== null && found.leaseExpiresAt > new Date();
            const task = found ? await tx.billingReconcileTask.update({ where: { id: found.id }, data: {
                    targetLedgerIds: [...new Set([...found.targetLedgerIds, ...plan.targetLedgerIds])],
                    ...(!inFlight && (force || changed || found.writerGeneration !== generation) ? { status: 'pending', availableAt: new Date(), writerGeneration: generation,
                        leaseToken: null, leaseExpiresAt: null,
                        cloudAccountContextId: plan.cloudAccountContextId, regionId: plan.regionId, instanceId: plan.instanceId ?? null, splitItemId: plan.splitItemId ?? null, productCode: plan.productCode ?? null,
                        queryPlan: { ...requestedPlan, manual: force || (found.queryPlan as Prisma.JsonObject).manual === true } as Prisma.InputJsonValue } : {}),
                } }) : await tx.billingReconcileTask.create({ data });
            await tx.billingCoverageUnit.createMany({ data: categories.map(unit => ({ ...unit, cloudWorkspaceId: space, billingDate: day, ruleVersion: 1, queryTaskId: task.id })), skipDuplicates: true });
            for (const ledgerId of [...new Set(categories.map(unit => unit.ledgerId))])
                await tx.billingCoverageUnit.updateMany({ where: { cloudWorkspaceId: space, ledgerId, billingDate: day, ruleVersion: 1, supersededAt: null,
                        category: { in: categories.filter(unit => unit.ledgerId === ledgerId).map(unit => unit.category) } }, data: { queryTaskId: task.id } });
            return task;
        });
    }
    async units(ledgerIds?: string[], startAt?: string, endAt?: string) {
        return this.prisma.billingCoverageUnit.findMany({ where: { supersededAt: null, ...(ledgerIds ? { ledgerId: { in: ledgerIds } } : {}),
                ...(startAt && endAt ? { billingDate: { gte: new Date(startAt + 'T00:00:00Z'), lte: new Date(endAt + 'T00:00:00Z') } } : {}) }, orderBy: { billingDate: 'asc' } });
    }
    async ensureUnits(ledgerId: string, date: string, categories: string[], code?: string) {
        const cloudWorkspaceId = requireCurrentCloudWorkspaceId();
        return this.prisma.billingCoverageUnit.createMany({ data: categories.map(category => ({ cloudWorkspaceId, ledgerId, billingDate: new Date(date + 'T00:00:00Z'), category,
                ...(code ? { state: 'source_pending', reasonCode: code, reasonMessage: BILLING_REASONS[code] ?? '资源来源或原执行账号尚未核实。' } : {}) })), skipDuplicates: true });
    }
    async tasks(ledgerIds?: string[], startAt?: string, endAt?: string) { return this.prisma.billingReconcileTask.findMany({ where: { status: { not: 'coordinator' },
        ...(ledgerIds ? { targetLedgerIds: { hasSome: ledgerIds } } : {}), ...(startAt && endAt ? { billingDate: { gte: new Date(startAt+'T00:00:00Z'), lte: new Date(endAt+'T00:00:00Z') } } : {}) }, orderBy: { createdAt: 'desc' } }); }
    async taskSummaries() { return this.prisma.billingReconcileTask.findMany({ where: { status: { not: 'coordinator' } }, select: {
        id: true, kind: true, status: true, targetLedgerIds: true, availableAt: true, lastQueriedAt: true, lastErrorCode: true,
        billingDate: true,
    } }); }
    async displayQueryStatus(ledgerIds: string[]) {
        const [row] = await this.prisma.$queryRaw<Array<{ lastRunAt: Date | null; nextRunAt: Date | null; queuedCount: number;
            runningCount: number; errorCount: number; errorResourceCount: number }>>`
            WITH visible AS (
                SELECT task.status, task."availableAt", task."lastQueriedAt", task."lastErrorCode", task."targetLedgerIds"
                FROM "BillingReconcileTask" task WHERE ${displayTaskFilter(ledgerIds)}
            )
            SELECT MAX("lastQueriedAt") AS "lastRunAt",
                   MIN("availableAt") FILTER (WHERE status <> 'planned') AS "nextRunAt",
                   COUNT(*) FILTER (WHERE status IN ('pending', 'backoff'))::int AS "queuedCount",
                   COUNT(*) FILTER (WHERE status = 'running')::int AS "runningCount",
                   COUNT(*) FILTER (WHERE NULLIF("lastErrorCode", '') IS NOT NULL)::int AS "errorCount",
                   (SELECT COUNT(DISTINCT ledger_id)::int FROM visible,
                       LATERAL unnest("targetLedgerIds") AS target(ledger_id)
                       WHERE NULLIF("lastErrorCode", '') IS NOT NULL) AS "errorResourceCount"
            FROM visible`;
        return { ...row, lastRunAt: row.lastRunAt?.toISOString() ?? null, nextRunAt: row.nextRunAt?.toISOString() ?? null };
    }
    async displayUnits(spans: DisplayCoverageSpan[], ledgerIds: string[]) {
        const workspace = requireCurrentCloudWorkspaceId();
        if (!spans.length) return [];
        return this.prisma.$queryRaw<Array<BillingCoverageView & { visibleTaskId: string | null; taskAvailableAt: Date | null }>>`
            SELECT unit."ledgerId", unit."billingDate", unit.category, unit.state, unit."reasonCode", unit."reasonMessage",
                   unit."queryTaskId", unit."parentBillingResourceId", unit."lastQueriedAt", unit."lastVerifiedAt",
                   unit."lastAttemptId", unit."adoptedAttemptId", task.id AS "visibleTaskId", task."availableAt" AS "taskAvailableAt"
            FROM jsonb_to_recordset(${JSON.stringify(spans)}::jsonb) AS span("ledgerId" text, "from" date, "to" date, probe boolean)
            JOIN "BillingCoverageUnit" unit ON unit."cloudWorkspaceId" = ${workspace} AND unit."ledgerId" = span."ledgerId"
                AND unit."billingDate" BETWEEN span."from" AND span."to"
                AND (LEFT(unit.category, 6) = 'probe:') = span.probe
            LEFT JOIN "BillingReconcileTask" task ON task.id = unit."queryTaskId" AND ${displayTaskFilter(ledgerIds)}
            WHERE unit."supersededAt" IS NULL
            ORDER BY unit."billingDate" ASC`;
    }
    async hasDueManual() {
        const now = new Date();
        return Boolean(await this.prisma.billingReconcileTask.findFirst({ where: { availableAt: { lte: now }, queryPlan: { path: ['manual'], equals: true },
            OR: [{ status: { in: ['pending', 'backoff', 'succeeded', 'empty', 'blocked'] } }, { status: 'running', leaseExpiresAt: { lte: now } }] }, select: { id: true } }));
    }
    async task(id: string) { return this.prisma.billingReconcileTask.findUnique({ where: { id } }); }
    async attempts(taskId: string) { return this.prisma.billingQueryAttempt.findMany({ where: { taskId }, orderBy: { startedAt: 'desc' }, take: 20 }); }
    async snapshotArchive(sourceId: string) {
        const row = await this.prisma.billingQueryAttempt.findFirst({ where: { outcome: 'verified',
                evidence: { path: ['snapshotHistories', sourceId, 'version'], equals: 1 } }, orderBy: { finishedAt: 'desc' } });
        return row ? ((row.evidence as any).snapshotHistories?.[sourceId] ?? null) : null;
    }
    async markCoverage(ledgerId: string, day: string, state: string, code: string, message: string, parentId?: string,
        receipt?:{queryTaskId:string|null;adoptedAttemptId:string|null;lastAttemptId:string|null;lastQueriedAt:Date|null;lastVerifiedAt:Date|null}) {
        return this.prisma.billingCoverageUnit.updateMany({ where: { ledgerId, billingDate: new Date(day + 'T00:00:00Z'), supersededAt: null },
            data: { state, reasonCode: code, reasonMessage: message, parentBillingResourceId: parentId ?? null,
                ...(state === 'covered_by_parent' ? receipt??{ lastVerifiedAt: new Date() } : {}) } });
    }
    async claim() {
        const { mode, generation } = await this.settings();
        if (mode === 'legacy')
            return null;
        return this.prisma.$transaction(async (tx) => {
            const now = new Date();
            const space = requireCurrentCloudWorkspaceId();
            await tx.$executeRaw `SELECT id FROM "CloudWorkspace" WHERE id = ${space} FOR NO KEY UPDATE`;
            const settings = await tx.cloudWorkspace.findUniqueOrThrow({ where: { id: space } });
            if (settings.isReadOnly || settings.archivedAt || settings.billingWriterGeneration !== generation || settings.billingReconciliationMode === 'legacy')
                return null;
            if (await tx.billingReconcileTask.count({ where: { status: 'running', leaseExpiresAt: { gt: now } } }) >= 2)
                return null;
            const eligible = { availableAt: { lte: now }, kind: { not: 'coordinator' },
                OR: [{ status: { in: ['pending', 'backoff', 'succeeded', 'empty', 'blocked'] } }, { status: 'running', leaseExpiresAt: { lte: now } }] };
            const orderBy = [{ availableAt: 'asc' as const }, { createdAt: 'asc' as const }];
            const task = await tx.billingReconcileTask.findFirst({ where: { ...eligible, queryPlan: { path: ['manual'], equals: true } }, orderBy })
                ?? await tx.billingReconcileTask.findFirst({ where: { ...eligible, queryPlan: { path: ['transactionProbe'], equals: false } }, orderBy: [{ billingDate: 'desc' }, ...orderBy] })
                ?? await tx.billingReconcileTask.findFirst({ where: eligible, orderBy });
            if (!task)
                return null;
            const token = randomUUID();
            const changed = await tx.billingReconcileTask.updateMany({ where: { id: task.id, updatedAt: task.updatedAt, status: task.status },
                data: { status: 'running', leaseToken: token, leaseExpiresAt: new Date(Date.now() + 240000), writerGeneration: generation, attemptCount: { increment: 1 } } });
            if (changed.count !== 1)
                return null;
            await tx.billingQueryAttempt.updateMany({ where: { taskId: task.id, outcome: 'running' }, data: { outcome: 'interrupted', finishedAt: now, errorCode: 'WORKER_INTERRUPTED', errorMessage: '上次查询中断，将重新完整查询。' } });
            const versions = await tx.billingReconcileTask.findMany({ where: { kind: 'coordinator', billingDate: task.billingDate }, select: { groupKey: true, currentRevisionId: true } });
            const attempt = await tx.billingQueryAttempt.create({ data: { cloudWorkspaceId: task.cloudWorkspaceId, taskId: task.id, querySnapshot: {
                        provider: task.cloudProvider, accountUid: task.cloudAccountUid, contextId: task.cloudAccountContextId, regionId: task.regionId,
                        billingDate: billingDateText(task.billingDate), instanceId: task.instanceId, splitItemId: task.splitItemId, productCode: task.productCode, kind: task.kind,
                        groupVersions: Object.fromEntries(versions.map(row => [row.groupKey, row.currentRevisionId])),
                    } } });
            return { task: { ...task, leaseToken: token, writerGeneration: generation, attemptCount: task.attemptCount + 1 }, attempt };
        });
    }
    async assertClaim(id: string, token: string) {
        const row = await this.prisma.billingReconcileTask.updateMany({ where: { id, status: 'running', leaseToken: token, leaseExpiresAt: { gt: new Date() } },
            data: { leaseExpiresAt: new Date(Date.now() + 240000) } });
        if (row.count !== 1)
            throw new Error('BILLING_CLAIM_LOST');
    }
    async finishPlanning(claim: NonNullable<Awaited<ReturnType<BillingReconciliationRepository['claim']>>>) {
        const space = requireCurrentCloudWorkspaceId();
        return this.prisma.$transaction(async (tx) => {
            await tx.$executeRaw `SELECT id FROM "CloudWorkspace" WHERE id = ${space} FOR NO KEY UPDATE`;
            const settings = await tx.cloudWorkspace.findUniqueOrThrow({ where: { id: space } });
            if (settings.billingWriterGeneration !== claim.task.writerGeneration || settings.billingReconciliationMode === 'legacy')
                throw new Error('BILLING_WRITER_FENCED');
            const result = await tx.billingReconcileTask.updateMany({ where: { id: claim.task.id, status: 'running', leaseToken: claim.task.leaseToken },
                data: { status: 'planned', leaseToken: null, leaseExpiresAt: null, lastErrorCode: null, lastErrorMessage: null } });
            if (result.count !== 1)
                throw new Error('BILLING_CLAIM_LOST');
            await tx.billingQueryAttempt.update({ where: { id: claim.attempt.id }, data: { outcome: 'planned', finishedAt: new Date(), complete: true } });
        });
    }
    async finish(claim: NonNullable<Awaited<ReturnType<BillingReconciliationRepository['claim']>>>, result: ScopedBillingResult, evidence: BillingQueryEvidence, outcome: 'verified' | 'empty' | 'blocked' | 'failed', issue?: {
        code: string;
        message: string;
    }) {
        const { task, attempt } = claim, space = requireCurrentCloudWorkspaceId(), scope = getCurrentCloudWorkspaceScope(), now = new Date();
        if (!scope || 'system' in scope || space !== task.cloudWorkspaceId || scope.accountUid !== task.cloudAccountUid || scope.provider !== task.cloudProvider)
            throw new Error('BILLING_SCOPE_CHANGED');
        return this.prisma.$transaction(async (tx) => {
            await tx.$executeRaw `SELECT id FROM "CloudWorkspace" WHERE id = ${space} FOR NO KEY UPDATE`;
            const settings = await tx.cloudWorkspace.findUniqueOrThrow({ where: { id: space } });
            const current = await tx.billingReconcileTask.findUnique({ where: { id: task.id } });
            if (!current || current.leaseToken !== task.leaseToken || current.status !== 'running' || !current.leaseExpiresAt || current.leaseExpiresAt <= now)
                throw new Error('BILLING_CLAIM_LOST');
            if (settings.isReadOnly || settings.archivedAt || settings.billingWriterGeneration !== task.writerGeneration || settings.billingReconciliationMode === 'legacy')
                throw new Error('BILLING_WRITER_FENCED');
            if (evidence.datasets?.some(dataset => dataset.accountUid !== task.cloudAccountUid || dataset.billingDate !== billingDateText(task.billingDate)))
                throw new Error('BILLING_EVIDENCE_SCOPE_CHANGED');
            const apply = settings.billingReconciliationMode === 'resource' && outcome === 'verified' && evidence.complete && result.coveredLedgerIds.length > 0;
            const referenced = [...new Set([...task.targetLedgerIds, ...result.coveredLedgerIds, ...result.groups.flatMap(group => group.items.flatMap(item => item.matchedLedgerId ? [item.matchedLedgerId] : []))])];
            if (await tx.billingLedgerResource.count({ where: { id: { in: referenced }, cloudAccountUid: task.cloudAccountUid, cloudProvider: task.cloudProvider } }) !== referenced.length)
                throw new Error('BILLING_LEDGER_SCOPE_CHANGED');
            for (const group of result.groups)
                if (group.groupKey !== financialGroupKey(task.cloudProvider, task.cloudAccountUid, billingDateText(task.billingDate), group.productCode, group.instanceId)
                    || group.items.some(item => item.cloudAccountUid !== task.cloudAccountUid || item.productCode !== group.productCode
                        || new Date(item.billingDate).getTime() !== task.billingDate.getTime() || item.rawPayload?.InstanceID !== group.instanceId))
                    throw new Error('BILLING_FINANCIAL_GROUP_MISMATCH');
            const replaced: Array<Record<string, unknown>> = [];
            const comparisons: Array<Record<string, unknown>> = [];
            for (const group of result.groups) {
                const start = readPlatformBillingStartedAt();
                const old = await tx.billingLineItem.findMany({ where: { cloudWorkspaceId: space, cloudProvider: task.cloudProvider, cloudAccountUid: task.cloudAccountUid, billingDate: task.billingDate,
                        productCode: group.productCode, ...(start ? { syncBatchId: { startsWith: 'billing-current:' + start.toISOString() + ':' } } : {}),
                        OR: [{ financialGroupKey: group.groupKey }, { financialGroupKey: null, rawPayload: { path: ['InstanceID'], equals: group.instanceId } }] } });
                const verified = new Set(result.verifiedLedgerIds ?? [...result.coveredLedgerIds, ...group.items.flatMap(item => item.matchedLedgerId ? [item.matchedLedgerId] : [])]);
                if (old.some(row => row.matchedLedgerId && !verified.has(row.matchedLedgerId)))
                    throw new Error('BILLING_PRIOR_MEMBERS_UNVERIFIED');
                const currencies = [...new Set([...old.map(row => row.currency), ...group.items.map(row => row.currency)])];
                comparisons.push({ groupKey: group.groupKey, amounts: currencies.map(currency => {
                        const before = old.filter(row => row.currency === currency).reduce((sum, row) => sum.plus(row.pretaxAmount), new BillingDecimal(0));
                        const after = group.items.filter(row => row.currency === currency).reduce((sum, row) => sum.plus(row.pretaxAmount), new BillingDecimal(0));
                        return { currency, before: before.toString(), after: after.toString(), equal: before.equals(after) };
                    }) });
            }
            if (apply)
                for (const group of [...result.groups].sort((a, b) => a.groupKey.localeCompare(b.groupKey))) {
                    const owner = await tx.billingReconcileTask.findFirst({ where: { groupKey: group.groupKey } });
                    const expected = (attempt.querySnapshot as any).groupVersions?.[group.groupKey] ?? null;
                    if ((owner?.currentRevisionId ?? null) !== expected)
                        throw new Error('BILLING_GROUP_VERSION_CHANGED');
                    const start = readPlatformBillingStartedAt();
                    const where = { cloudWorkspaceId: space, cloudProvider: task.cloudProvider, cloudAccountUid: task.cloudAccountUid, billingDate: task.billingDate,
                        ...(start ? { syncBatchId: { startsWith: 'billing-current:' + start.toISOString() + ':' } } : {}),
                        productCode: group.productCode, OR: [{ financialGroupKey: group.groupKey }, { financialGroupKey: null, rawPayload: { path: ['InstanceID'], equals: group.instanceId } }] };
                    const old = await tx.billingLineItem.findMany({ where });
                    const verified = new Set(result.verifiedLedgerIds ?? [...result.coveredLedgerIds, ...group.items.flatMap(item => item.matchedLedgerId ? [item.matchedLedgerId] : [])]);
                    if (old.some(row => row.matchedLedgerId && !verified.has(row.matchedLedgerId)))
                        throw new Error('BILLING_PRIOR_MEMBERS_UNVERIFIED');
                for (const row of old)
                    replaced.push(JSON.parse(JSON.stringify(row)));
                    await tx.billingLineItem.deleteMany({ where });
                    const anomalyScope = { cloudWorkspaceId: space, cloudProvider: task.cloudProvider, cloudAccountUid: task.cloudAccountUid, billingDate: task.billingDate,
                        ...(start ? { syncBatchId: { startsWith: 'billing-current:' + start.toISOString() + ':' } } : {}) };
                    await tx.billingAnomaly.deleteMany({ where: { ...anomalyScope, OR: [{ financialGroupKey: group.groupKey },
                                { financialGroupKey: null, AND: [{ rawPayload: { path: ['InstanceID'], equals: group.instanceId } }, { rawPayload: { path: ['ProductCode'], equals: group.productCode } }] }] } });
                    if (group.items.length)
                        await tx.billingLineItem.createMany({ data: group.items.map(item => ({ ...item, cloudWorkspaceId: space, cloudProvider: task.cloudProvider,
                                billingDate: task.billingDate, financialGroupKey: group.groupKey, revisionId: attempt.id, pretaxAmount: new Prisma.Decimal(item.pretaxAmount),
                                rawPayload: item.rawPayload as Prisma.InputJsonValue })) });
                    if (owner)
                        await tx.billingReconcileTask.update({ where: { id: owner.id }, data: { currentRevisionId: attempt.id, lastVerifiedAt: now } });
                    else
                        await tx.billingReconcileTask.create({ data: { cloudWorkspaceId: space, cloudProvider: task.cloudProvider, cloudAccountUid: task.cloudAccountUid,
                                cloudAccountContextId: task.cloudAccountContextId, regionId: task.regionId, billingDate: task.billingDate, groupKey: group.groupKey, kind: 'coordinator', status: 'coordinator',
                                instanceId: group.instanceId, productCode: group.productCode, targetLedgerIds: result.coveredLedgerIds, writerGeneration: task.writerGeneration, currentRevisionId: attempt.id, lastVerifiedAt: now } });
                }
            const ids = [...new Set([...task.targetLedgerIds, ...result.coveredLedgerIds])];
            const ledgers = await tx.billingLedgerResource.findMany({ where: { id: { in: ids }, cloudAccountUid: task.cloudAccountUid, cloudProvider: task.cloudProvider } });
            if (ledgers.length !== ids.length)
                throw new Error('BILLING_LEDGER_SCOPE_CHANGED');
            const units = await tx.billingCoverageUnit.findMany({ where: { ledgerId: { in: ids }, billingDate: task.billingDate, supersededAt: null } });
            for (const unit of units) {
                const ledger = ledgers.find(row => row.id === unit.ledgerId)!;
                const networkProbe = unit.category.startsWith('probe:network');
                const networkTask = task.kind === 'discovery' && task.productCode === 'cdt';
                if (networkTask !== networkProbe) continue;
                const matched = result.coveredLedgerIds.includes(unit.ledgerId);
                const probe = unit.category.startsWith('probe:');
                const covered = matched && (probe || ledger.cloudResourceType !== 'eip' || (result.coveredCategories?.[ledger.id] ?? []).includes(unit.category));
                const parent = covered && !result.groups.some(group => group.items.some(item => item.matchedLedgerId === unit.ledgerId));
                const state = apply && covered ? (parent ? 'covered_by_parent' : 'issued') : outcome === 'verified' ? (settings.billingReconciliationMode === 'shadow' ? 'awaiting_query' : 'partial')
                    : outcome === 'empty' ? (probe ? 'probe_empty' : 'no_bill') : outcome === 'blocked' ? 'source_pending' : 'query_error';
                const emptyReason = outcome === 'empty' && ['EIP_BILL_NOT_RETURNED','SNAPSHOT_BILL_NOT_RETURNED'].includes(String(result.evidence?.emptyReason)) ? String(result.evidence?.emptyReason) : 'NO_BILL_RETURNED';
                const missingCategory = apply && matched && !covered && ledger.cloudResourceType === 'eip'
                    ? unit.category === 'eip_configuration' ? 'EIP_CONFIGURATION_BILL_NOT_RETURNED' : 'EIP_NETWORK_BILL_NOT_RETURNED' : null;
                const code = apply && covered ? (parent ? 'PARENT_COVERAGE' : null) : issue?.code ?? missingCategory ?? (settings.billingReconciliationMode === 'shadow' && outcome === 'verified' ? 'SHADOW_VERIFIED' : outcome === 'empty' ? emptyReason : 'ALLOCATION_PENDING');
                await tx.billingCoverageUnit.update({ where: { id: unit.id }, data: { state, reasonCode: code, reasonMessage: issue?.message ?? (code ? BILLING_REASONS[code] ?? null : null), lastAttemptId: attempt.id, lastQueriedAt: now,
                        ...(apply && covered ? { adoptedAttemptId: attempt.id, lastVerifiedAt: now } : {}) } });
            }
            const probe = (task.queryPlan as any).transactionProbe === true;
            const retryMs = issue?.code === 'HISTORY_UNAVAILABLE' ? 30 * 86400000 : outcome === 'failed' ? Math.min(3600000, 60000 * 2 ** Math.min(task.attemptCount, 6))
                : probe ? 7 * 86400000 : 86400000;
            await tx.billingReconcileTask.update({ where: { id: task.id }, data: { status: outcome === 'failed' ? 'backoff' : outcome === 'verified' ? 'succeeded' : outcome === 'empty' ? 'empty' : 'blocked',
                    leaseToken: null, leaseExpiresAt: null, availableAt: new Date(Date.now() + retryMs), lastQueriedAt: now, lastErrorCode: issue?.code ?? null, lastErrorMessage: issue?.message ?? null,
                    queryPlan: { ...(task.queryPlan as Prisma.JsonObject), manual: false } as Prisma.InputJsonValue,
                    ...(apply ? { currentRevisionId: attempt.id, lastVerifiedAt: now } : {}) } });
            await tx.billingQueryAttempt.update({ where: { id: attempt.id }, data: { finishedAt: now, outcome, requestIds: evidence.requestIds, pageCount: evidence.pageCount,
                    rowCount: evidence.rowCount, complete: evidence.complete, errorCode: issue?.code ?? null, errorMessage: issue?.message ?? null,
                    datasetDigest: billingKey({ fingerprints: result.groups.flatMap(group => group.items.map(row => row.sourceFingerprint)).sort(), officialDatasets: evidence.datasets ?? [] }), evidence: JSON.parse(JSON.stringify({
                        ...result.evidence, officialDatasets: evidence.datasets ?? [], applied: apply, coveredLedgerIds: result.coveredLedgerIds, financialGroups: result.groups.map(group => group.groupKey), replacedRows: replaced,
                        comparisons,
                        amounts: result.groups.flatMap(group => group.items.map(item => ({ ledgerId: item.matchedLedgerId, currency: item.currency, amount: item.pretaxAmount }))),
                    })) as Prisma.InputJsonValue } });
            return { applied: apply, outcome };
        }, { timeout: 30000 });
    }
}
