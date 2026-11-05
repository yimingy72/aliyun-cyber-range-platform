import { PrismaService } from '../src/database/prisma.service';
import { PrismaAdminRepository } from '../src/database/prisma-admin.repository';
import { BillingReconciliationRepository } from '../src/admin/billing-reconciliation.repository';
import { BillingLifecycleService } from '../src/admin/billing-lifecycle.service';
import { createProvenBillingLedger } from './support/create-billing-fixture';
import { runInCloudWorkspace, runInSystemCloudWorkspaceScope } from '../src/auth/cloud-workspace-scope';
import { financialGroupKey, type ScopedBillingResult } from '../src/admin/billing-reconciliation-types';
import { randomUUID } from 'node:crypto';
const url = process.env.BILLING_V2_TEST_DATABASE_URL;
if (url && (new URL(url).hostname !== 'billing-v2-postgres' || new URL(url).pathname !== '/billing_v2_test'))
    throw new Error('Only the isolated Docker billing fixture is allowed');
(url ? describe : describe.skip)('resource billing atomic persistence', () => {
    const db = new PrismaService({ datasourceUrl: url }), repo = new PrismaAdminRepository(db), store = new BillingReconciliationRepository(db);
    let uid = 'bill-v2-account';
    const provider = 'alibaba_cloud' as const, day = '2026-10-14';
    let workspace: string;
    const inScope = <T>(run: () => Promise<T>) => runInCloudWorkspace({ cloudWorkspaceId: workspace, provider, accountUid: uid, actorUserId: 'fixture', isPlatformManager: true }, run);
    beforeEach(async () => runInSystemCloudWorkspaceScope(async () => {
        workspace = 'billing-v2-' + randomUUID();
        uid = 'account-' + randomUUID();
        await db.cloudWorkspace.create({ data: { id: workspace, provider, accountUid: uid, displayName: 'Isolated billing test', billingReconciliationMode: 'resource' } });
    }));
    afterAll(async () => { await db.$disconnect(); });
    async function ledger(id: string) {
        return repo.createBillingLedgerResource({ cloudProvider: provider, cloudAccountUid: uid, regionId: 'cn-beijing', cloudResourceId: id,
            cloudResourceType: 'ecs', billingScope: 'platform', billingStartAt: new Date(day) });
    }
    async function enqueue(id: string = 'i-a') {
        const resource = await ledger(id);
        const task = await store.enqueue({ cloudProvider: provider, cloudAccountUid: uid, cloudAccountContextId: 'fixture-context', regionId: 'cn-beijing',
            billingDate: day, groupKey: 'query-' + resource.id, kind: 'direct', instanceId: id, targetLedgerIds: [resource.id] }, [{ ledgerId: resource.id, category: 'ecs' }]);
        return { resource, task };
    }
    function result(resource: Awaited<ReturnType<typeof ledger>>, amount = 3): ScopedBillingResult {
        const key = financialGroupKey(provider, uid, day, 'ecs', resource.cloudResourceId);
        return { coveredLedgerIds: [resource.id], rowCount: 1, groups: [{ groupKey: key, productCode: 'ecs', instanceId: resource.cloudResourceId, anomalies: [], items: [{
                            cloudProvider: provider, cloudAccountUid: uid, syncBatchId: 'resource-' + key, sourceFingerprint: key + '-' + amount, billCycle: '2026-10', billingDate: day,
                            productCode: 'ecs', billItem: '实例', cloudResourceId: resource.cloudResourceId, cloudResourceType: 'ecs', pretaxAmount: amount, currency: 'CNY',
                            billingScope: 'platform', matchedLedgerId: resource.id, rawPayload: { InstanceID: resource.cloudResourceId, ProductCode: 'ecs', OwnerID: uid, Region: 'cn-beijing' },
                        }] }] };
    }
    const evidence = { requestIds: ['official-receipt'], pageCount: 1, rowCount: 1, complete: true };
    it('summarizes the workspace queue and reads only coverage within a visible ledger span', async () => inScope(async () => {
        const a = await enqueue('i-display-a'), b = await enqueue('i-display-b');
        const first = new Date('2026-10-14T03:00:00Z'), second = new Date('2026-10-14T04:00:00Z');
        await db.billingReconcileTask.update({ where: { id: a.task.id }, data: { status: 'backoff', availableAt: first, lastQueriedAt: first, lastErrorCode: 'QUERY_FAILED' } });
        // An otherwise visible ledger can reference a task that also contains a hidden resource.
        await db.billingReconcileTask.update({ where: { id: b.task.id }, data: { targetLedgerIds: [a.resource.id, b.resource.id], status: 'running',
            availableAt: second, lastQueriedAt: second, lastErrorCode: 'QUERY_FAILED' } });
        const span = { ledgerId: a.resource.id, from: day, to: day, probe: false };
        await store.ensureUnits(a.resource.id, day, ['probe:network']);
        await store.ensureUnits(a.resource.id, '2026-10-15', ['ecs']);
        expect(await store.displayQueryStatus([a.resource.id])).toEqual({lastRunAt:second.toISOString(),nextRunAt:first.toISOString(),queuedCount:1,runningCount:1,errorCount:2,errorResourceCount:2});
        const projected = await store.displayUnits([span], [a.resource.id]);
        expect(projected).toHaveLength(1);
        expect(projected[0]).toMatchObject({category:'ecs',billingDate:new Date(day),visibleTaskId:a.task.id,taskAvailableAt:first});
        expect((await store.displayUnits([{...span,probe:true}], [a.resource.id])).map(unit=>unit.category)).toEqual(['probe:network']);
        await db.billingCoverageUnit.updateMany({where:{ledgerId:a.resource.id,category:'ecs',billingDate:new Date(day)},data:{queryTaskId:b.task.id}});
        await runInCloudWorkspace({cloudWorkspaceId:workspace,provider,accountUid:uid,actorUserId:'limited'},async()=>{
            expect(await store.displayQueryStatus([a.resource.id])).toEqual({lastRunAt:first.toISOString(),nextRunAt:first.toISOString(),queuedCount:1,runningCount:0,errorCount:1,errorResourceCount:1});
            expect(await store.displayUnits([span],[a.resource.id])).toMatchObject([{visibleTaskId:null,taskAvailableAt:null}]);
        });
        await runInCloudWorkspace({cloudWorkspaceId:'foreign-'+randomUUID(),provider,accountUid:uid,isPlatformManager:true},async()=>{
            expect(await store.displayUnits([span],[a.resource.id])).toEqual([]);
            expect(await store.displayQueryStatus([a.resource.id])).toEqual({lastRunAt:null,nextRunAt:null,queuedCount:0,runningCount:0,errorCount:0,errorResourceCount:0});
        });
    }));
    it('keeps a post-release refund and its transaction coverage in the compact display', async () => inScope(async () => {
        const source = await createProvenBillingLedger(repo, { cloudAccountUid:uid, cloudResourceId:'i-display-refund', cloudResourceType:'ecs',
            regionId:'cn-beijing', billingScope:'platform', billingStartAt:new Date(day), releasedAt:new Date(day+'T08:00:00Z') });
        const later = '2026-10-16', row = result(source.ledger,-1.25).groups[0].items[0];
        await repo.upsertBillingLineItems([{...row,billingDate:later,rawPayload:{...row.rawPayload,Item:'Refund'}}]);
        const task = await store.enqueue({ cloudProvider:provider,cloudAccountUid:uid,cloudAccountContextId:'fixture-context',regionId:'cn-beijing',
            billingDate:later,groupKey:'refund-'+source.ledger.id,kind:'direct',targetLedgerIds:[source.ledger.id] },
            [{ledgerId:source.ledger.id,category:'probe:transactions'}]);
        await db.billingCoverageUnit.updateMany({where:{ledgerId:source.ledger.id,billingDate:new Date(later),category:'probe:transactions'},
            data:{state:'issued',lastQueriedAt:new Date(later+'T08:00:00Z')}});
        const lifecycle = new BillingLifecycleService(repo,store), window={startAt:later,endAt:later};
        const full=await lifecycle.load(window),compact=await lifecycle.load(window,true);
        expect(compact.entries).toEqual(full.entries);
        expect(compact.entries[0]).toMatchObject({amounts:[{currency:'CNY',pretaxAmount:-1.25}],resources:[{coveredThrough:later,queryTaskId:task.id}]});
    }));
    it('loads billing provenance without historical credentials and preserves null values in expiry events',async()=>inScope(async()=>{
        const source=await createProvenBillingLedger(repo,{cloudAccountUid:uid,cloudResourceId:'i-display-source',cloudResourceType:'ecs',
            regionId:'cn-beijing',billingScope:'platform',billingStartAt:new Date(day)});
        const expiryPlan={expiresAt:'2026-10-14T15:00:00Z',requestedExpiresAt:null,effectiveExpiresAt:null};
        await db.provisionJob.update({where:{id:source.job.id},data:{topologySnapshot:{operation:'create',expiryPlan,runtimeCredentials:{example:'fixture-only'}}}});
        const [instance]=await repo.listBillingSourceInstances(),[job]=await repo.listBillingSourceJobs();
        expect(instance.id).toBe(source.instance.id);expect(instance).not.toHaveProperty('runtimeCredentials');
        expect(job.topologySnapshot).toEqual({operation:'create',expiryPlan});
        expect(job.startedAt).toEqual(source.job.startedAt);expect(job.createdAt).toEqual(source.job.createdAt);
        expect(await runInCloudWorkspace({cloudWorkspaceId:'foreign-'+randomUUID(),provider,accountUid:uid},()=>repo.listBillingSourceJobs())).toEqual([]);
    }));
    it('refreshes repaired source bindings between leases while preserving explicit queue priority', async () => inScope(async () => {
        const a = await enqueue();
        const plan = { cloudProvider: provider, cloudAccountUid: uid, cloudAccountContextId: 'new-verified-context', regionId: 'cn-beijing', billingDate: day,
            groupKey: a.task.groupKey, kind: 'direct' as const, instanceId: a.resource.cloudResourceId, targetLedgerIds: [a.resource.id], queryPlan: { identities: { [a.resource.id]: 'repaired-origin' } } };
        await store.enqueue(plan, [{ ledgerId: a.resource.id, category: 'ecs' }], true);
        await store.enqueue(plan, [{ ledgerId: a.resource.id, category: 'ecs' }], false);
        const claim = (await store.claim())!;
        expect(claim.task.cloudAccountContextId).toBe('new-verified-context');
        expect(claim.task.queryPlan).toMatchObject({ manual: true, identities: { [a.resource.id]: 'repaired-origin' } });
        await store.enqueue({ ...plan, cloudAccountContextId: 'next-context' }, [{ ledgerId: a.resource.id, category: 'ecs' }]);
        expect((await store.task(a.task.id))!.cloudAccountContextId).toBe('new-verified-context');
        await store.finish(claim, result(a.resource), evidence, 'verified');
        await store.enqueue({ ...plan, cloudAccountContextId: 'next-context' }, [{ ledgerId: a.resource.id, category: 'ecs' }]);
        expect((await store.claim())!.task.cloudAccountContextId).toBe('next-context');
        expect((await repo.listBillingLineItems())[0].pretaxAmount).toBe(3);
    }));
    it('archives blocked official rows without changing the last adopted amount', async () => inScope(async () => {
        const a = await enqueue();
        await repo.upsertBillingLineItems([result(a.resource, 5).groups[0].items[0]]);
        const receipt = { ...evidence, datasets: [{ action: 'DescribeInstanceBill', accountUid: uid, billingDate: day, instanceId: a.resource.cloudResourceId, complete: true,
            rows: [{ InstanceID: a.resource.cloudResourceId, ProductCode: 'new_product', Currency: 'CNY', PretaxAmount: '0.123456789012345678' }] }] };
        const claim = (await store.claim())!;
        await store.finish(claim, { groups: [], coveredLedgerIds: [], rowCount: 1 }, receipt, 'blocked', { code: 'ALLOCATION_PENDING', message: 'pending classification' });
        expect((await repo.listBillingLineItems())[0].pretaxAmount).toBe(5);
        const saved = await db.billingQueryAttempt.findUniqueOrThrow({ where: { id: claim.attempt.id } });
        expect(saved.evidence).toMatchObject({ applied: false, officialDatasets: [{ rows: [{ PretaxAmount: '0.123456789012345678' }] }] });
        await db.billingReconcileTask.update({ where: { id: a.task.id }, data: { availableAt: new Date(0) } });
        const next = (await store.claim())!;
        const changed = { ...receipt, datasets: [{ ...receipt.datasets[0], rows: [{ ...receipt.datasets[0].rows[0], PretaxAmount: '0.223456789012345678' }] }] };
        await store.finish(next, { groups: [], coveredLedgerIds: [], rowCount: 1 }, changed, 'blocked', { code: 'ALLOCATION_PENDING', message: 'pending classification' });
        expect((await db.billingQueryAttempt.findUniqueOrThrow({ where: { id: next.attempt.id } })).datasetDigest).not.toBe(saved.datasetDigest);
        expect((await repo.listBillingLineItems())[0].pretaxAmount).toBe(5);
    }));
    it('repairs an account and origin atomically but rejects a stale competing repair', async () => inScope(async () => {
        const instance = await repo.createRangeInstance({ name: 'legacy identity' });
        const source = await repo.createProvisionJob({ rangeInstanceId: instance.id, jobType: 'create', triggeredBy: 'fixture' });
        const old = await repo.createBillingLedgerResource({ cloudAccountUid: null, regionId: 'cn-beijing', cloudResourceId: 'i-legacy', cloudResourceType: 'ecs',
            billingScope: 'platform', rangeInstanceId: instance.id, billingStartAt: new Date(day), releasedAt: new Date(day + 'T01:00:00Z') });
        expect(await repo.repairBillingLedgerOrigin({ expected: old, sourceProvisionJobId: source.id, cloudAccountUid: uid, cloudAccountContextId: 'fixture-context', auditMessage: 'verified original receipt' })).toBe(true);
        expect((await repo.listBillingLedgerResources())[0]).toMatchObject({ cloudAccountUid: uid, sourceProvisionJobId: source.id, releasedAt: old.releasedAt });
        expect(await repo.repairBillingLedgerOrigin({ expected: old, sourceProvisionJobId: source.id, cloudAccountUid: uid, auditMessage: 'stale repair' })).toBe(false);
        expect((await repo.listProvisionJobStepLogs(source.id)).filter(step => step.stepName === 'platform_billing_origin_repair')).toHaveLength(1);
    }));
    it('prioritizes an explicit resource query over the historical queue without keeping permanent priority', async () => inScope(async () => {
        const automatic = await enqueue('i-auto'), manual = await enqueue('i-manual');
        await store.enqueue({ cloudProvider: provider, cloudAccountUid: uid, cloudAccountContextId: 'fixture-context', regionId: 'cn-beijing', billingDate: day,
            groupKey: manual.task.groupKey, kind: 'direct', instanceId: manual.resource.cloudResourceId, targetLedgerIds: [manual.resource.id] }, [{ ledgerId: manual.resource.id, category: 'ecs' }], true);
        expect(await store.hasDueManual()).toBe(true);
        const claim = (await store.claim())!;
        expect(claim.task.id).toBe(manual.task.id);
        await store.finish(claim, result(manual.resource), evidence, 'verified');
        expect(await store.hasDueManual()).toBe(false);
        expect((await store.claim())!.task.id).toBe(automatic.task.id);
    }));
    it('runs recent daily billing before an older native backlog and weekly transaction probes', async () => inScope(async () => {
        const probe = await enqueue('i-probe'), old = await enqueue('i-old'), recent = await enqueue('i-recent');
        await db.billingReconcileTask.update({ where: { id: probe.task.id }, data: { availableAt: new Date(0), queryPlan: { transactionProbe: true } } });
        await db.billingReconcileTask.update({ where: { id: old.task.id }, data: { availableAt: new Date(0), queryPlan: { transactionProbe: false } } });
        await db.billingReconcileTask.update({ where: { id: recent.task.id }, data: { billingDate: new Date('2026-10-15'), queryPlan: { transactionProbe: false } } });
        expect((await store.claim())!.task.id).toBe(recent.task.id);
        expect((await store.claim())!.task.id).toBe(old.task.id);
    }));
    it('updates A without deleting B and keeps one financial revision across repeated queries', async () => inScope(async () => {
        const a = await enqueue(), b = await ledger('i-b');
        await repo.upsertBillingLineItems([result(b, 7).groups[0].items[0]]);
        const first = (await store.claim())!;
        expect(first.task.id).toBe(a.task.id);
        await store.finish(first, result(a.resource), evidence, 'verified');
        expect((await repo.listBillingLineItems()).map(row => row.pretaxAmount).sort()).toEqual([3, 7]);
        await db.billingReconcileTask.update({ where: { id: a.task.id }, data: { availableAt: new Date(0) } });
        await store.finish((await store.claim())!, result(a.resource, 4), evidence, 'verified');
        expect((await repo.listBillingLineItems()).map(row => row.pretaxAmount).sort()).toEqual([4, 7]);
        expect((await store.units([a.resource.id]))[0]).toMatchObject({ state: 'issued', adoptedAttemptId: expect.any(String) });
    }));
    it('preserves the prior amount on complete empty responses, then accepts an explicit official zero', async () => inScope(async () => {
        const a = await enqueue();
        await repo.upsertBillingLineItems([result(a.resource, 5).groups[0].items[0]]);
        await store.finish((await store.claim())!, { groups: [], coveredLedgerIds: [], rowCount: 0 }, { ...evidence, rowCount: 0 }, 'empty');
        expect((await repo.listBillingLineItems())[0].pretaxAmount).toBe(5);
        expect((await store.units([a.resource.id]))[0].state).toBe('no_bill');
        await db.billingReconcileTask.update({ where: { id: a.task.id }, data: { availableAt: new Date(0) } });
        await store.finish((await store.claim())!, result(a.resource, 0), evidence, 'verified');
        expect((await repo.listBillingLineItems())[0].pretaxAmount).toBe(0);
    }));
    it('records shadow evidence without changing money or claiming financial adoption', async () => inScope(async () => {
        await store.setMode('shadow', 0);
        const a = await enqueue();
        await repo.upsertBillingLineItems([result(a.resource, 5).groups[0].items[0]]);
        const accepted = await store.finish((await store.claim())!, result(a.resource, 6), evidence, 'verified');
        expect(accepted.applied).toBe(false);
        expect((await repo.listBillingLineItems())[0].pretaxAmount).toBe(5);
        expect((await store.units([a.resource.id]))[0].adoptedAttemptId).toBeNull();
        await store.setMode('resource', 1);
        const next = await store.claim();
        expect(next).not.toBeNull();
        await store.finish(next!, result(a.resource, 6), evidence, 'verified');
        expect((await repo.listBillingLineItems())[0].pretaxAmount).toBe(6);
    }));
    it('rejects stale workers and legacy whole-day writes after the workspace cutover', async () => inScope(async () => {
        const a = await enqueue(), claim = (await store.claim())!;
        await store.setMode('shadow', 0);
        await expect(store.finish(claim, result(a.resource), evidence, 'verified')).rejects.toThrow();
        await store.setMode('resource', 1);
        await expect(repo.replaceBillingDay({ cloudProvider: provider, cloudAccountUid: uid, billingDate: day, lineItems: [], anomalies: [] })).rejects.toThrow('FENCED');
    }));
    it('allows one claimant and rejects an expired lease', async () => inScope(async () => {
        const a = await enqueue();
        const claims = await Promise.all([store.claim(), store.claim()]);
        expect(claims.filter(Boolean)).toHaveLength(1);
        const claim = claims.find(Boolean)!;
        await db.billingReconcileTask.update({ where: { id: a.task.id }, data: { leaseExpiresAt: new Date(0) } });
        await expect(store.finish(claim, result(a.resource), evidence, 'verified')).rejects.toThrow('CLAIM_LOST');
    }));
    it('rejects a foreign ledger or financial group before changing existing money', async () => inScope(async () => {
        const a = await enqueue(), claim = (await store.claim())!;
        const wrong = result(a.resource);
        wrong.groups[0].items[0].cloudAccountUid = 'foreign';
        await expect(store.finish(claim, wrong, evidence, 'verified')).rejects.toThrow('MISMATCH');
        expect(await repo.listBillingLineItems()).toHaveLength(0);
    }));
    it('retains independent expected units even when no query task was generated', async () => inScope(async () => {
        const a = await ledger('i-no-route');
        await store.ensureUnits(a.id, day, ['ecs'], 'SOURCE_UNVERIFIED');
        expect(await store.tasks()).toHaveLength(0);
        expect(await store.units([a.id])).toMatchObject([{ state: 'source_pending', queryTaskId: null }]);
        const task = await store.enqueue({ cloudProvider: provider, cloudAccountUid: uid, cloudAccountContextId: 'fixture-context', regionId: 'cn-beijing',
            billingDate: day, groupKey: 'query-' + a.id, kind: 'direct', instanceId: a.cloudResourceId, targetLedgerIds: [a.id] }, [{ ledgerId: a.id, category: 'ecs' }]);
        expect(await store.units([a.id])).toMatchObject([{ queryTaskId: task.id }]);
    }));
    function shared(resource: Awaited<ReturnType<typeof ledger>>, amount: number): ScopedBillingResult {
        const value = result(resource, amount), group = value.groups[0];
        group.productCode = 'snapshot';
        group.instanceId = 'parent-shared';
        group.groupKey = financialGroupKey(provider, uid, day, 'snapshot', 'parent-shared');
        group.items[0].productCode = 'snapshot';
        group.items[0].rawPayload = { InstanceID: 'parent-shared', ProductCode: 'snapshot', OwnerID: uid };
        group.items[0].sourceFingerprint = group.groupKey + '-' + resource.id + '-' + amount;
        return value;
    }
    it('rejects a prior query when another task already adopted a newer shared-group revision', async () => inScope(async () => {
        const a = await enqueue('i-a'), b = await enqueue('i-b');
        const first = (await store.claim())!, second = (await store.claim())!;
        const newest = second.task.id === b.task.id ? b : a, oldest = first.task.id === a.task.id ? a : b;
        await store.finish(second, shared(newest.resource, 7), evidence, 'verified');
        const stale = shared(oldest.resource, 3);
        stale.verifiedLedgerIds = [a.resource.id, b.resource.id];
        await expect(store.finish(first, stale, evidence, 'verified')).rejects.toThrow('GROUP_VERSION_CHANGED');
        expect((await repo.listBillingLineItems()).map(row => row.pretaxAmount)).toEqual([7]);
    }));
    it('does not erase old parent-group members whose attribution was not re-proven', async () => inScope(async () => {
        const a = await enqueue('i-a'), b = await ledger('i-b');
        await repo.upsertBillingLineItems([...shared(a.resource, 3).groups[0].items, ...shared(b, 7).groups[0].items]);
        await expect(store.finish((await store.claim())!, shared(a.resource, 4), evidence, 'verified')).rejects.toThrow('PRIOR_MEMBERS_UNVERIFIED');
        expect((await repo.listBillingLineItems()).map(row => row.pretaxAmount).sort()).toEqual([3, 7]);
    }));
    it('preserves another product anomaly under the same source ID', async () => inScope(async () => {
        const a = await enqueue();
        for (const product of ['ecs', 'cdt'])
            await repo.createBillingAnomaly({ cloudProvider: provider, cloudAccountUid: uid, syncBatchId: 'fixture',
                sourceFingerprint: 'anomaly-' + product, billCycle: '2026-10', billingDate: day, cloudResourceId: a.resource.cloudResourceId, cloudResourceType: 'unknown',
                pretaxAmount: 1, currency: 'CNY', reason: 'fixture', rawPayload: { InstanceID: a.resource.cloudResourceId, ProductCode: product } });
        await store.finish((await store.claim())!, result(a.resource), evidence, 'verified');
        expect((await repo.listBillingAnomalies()).map(row => row.rawPayload.ProductCode)).toEqual(['cdt']);
    }));
    it('rolls back to a legacy current partition without retaining duplicate resource batches', async () => inScope(async () => {
        const saved = process.env.PLATFORM_BILLING_STARTED_AT;
        process.env.PLATFORM_BILLING_STARTED_AT = '2026-10-10T00:00:00.000Z';
        try {
            const a = await enqueue(), value = result(a.resource), prefix = 'billing-current:2026-10-10T00:00:00.000Z:';
            value.groups[0].items[0].syncBatchId = prefix + 'billing-resource:fixture';
            await store.finish((await store.claim())!, value, evidence, 'verified');
            await store.setMode('shadow', 0);
            const old = result(a.resource, 4).groups[0].items[0];
            old.syncBatchId = prefix + 'billing-sync:alibaba_cloud:' + uid + ':' + day;
            old.sourceFingerprint = 'legacy-revision';
            await repo.replaceBillingDay({ cloudProvider: provider, cloudAccountUid: uid, billingDate: day, replacementSyncBatchId: old.syncBatchId, lineItems: [old], anomalies: [] });
            expect((await repo.listBillingLineItems()).map(row => row.pretaxAmount)).toEqual([4]);
            expect((await store.units([a.resource.id]))[0].state).toBe('awaiting_query');
        }
        finally {
            if (saved === undefined)
                delete process.env.PLATFORM_BILLING_STARTED_AT;
            else
                process.env.PLATFORM_BILLING_STARTED_AT = saved;
        }
    }));
    it('refreshes an expired query plan while fencing the interrupted owner', async () => inScope(async () => {
        const a = await enqueue(), oldClaim = (await store.claim())!;
        await db.billingReconcileTask.update({ where: { id: a.task.id }, data: { leaseExpiresAt: new Date(0) } });
        const refreshed = await store.enqueue({ cloudProvider: provider, cloudAccountUid: uid, cloudAccountContextId: 'fixture-context', regionId: 'cn-beijing',
            billingDate: day, groupKey: 'query-' + a.resource.id, kind: 'direct', instanceId: a.resource.cloudResourceId, targetLedgerIds: [a.resource.id], queryPlan: { resourceQueryVersion: 2 } }, [{ ledgerId: a.resource.id, category: 'ecs' }], true);
        expect(refreshed).toMatchObject({ status: 'pending', leaseToken: null, queryPlan: { resourceQueryVersion: 2, manual: true } });
        await expect(store.finish(oldClaim, result(a.resource), evidence, 'verified')).rejects.toThrow();
        const claimed = (await store.claim())!;
        expect(claimed.task.queryPlan).toMatchObject({ resourceQueryVersion: 2 });
        expect((await store.attempts(a.task.id)).some(row => row.outcome === 'interrupted')).toBe(true);
    }));
    it('adopts one balanced EIP share, retains it on empty requery, and distinguishes a missing configuration component', async () => inScope(async () => {
        const resource = await repo.createBillingLedgerResource({ cloudProvider: provider, cloudAccountUid: uid, regionId: 'cn-beijing', cloudResourceId: 'eip-owned',
            cloudResourceType: 'eip', billingScope: 'platform', billingStartAt: new Date(day) });
        const plan = { cloudProvider: provider, cloudAccountUid: uid, cloudAccountContextId: 'fixture-context', regionId: resource.regionId,
            billingDate: day, groupKey: 'query-' + resource.id, kind: 'direct' as const, instanceId: resource.cloudResourceId, targetLedgerIds: [resource.id] };
        const categories = ['eip_configuration', 'network_usage'].map(category => ({ ledgerId: resource.id, category }));
        await store.enqueue(plan, categories);
        const value = result(resource, 0.75), key = financialGroupKey(provider, uid, day, 'cbwp', 'cbwp-parent');
        value.coveredCategories = { [resource.id]: ['network_usage'] };
        value.groups[0] = { ...value.groups[0], groupKey: key, productCode: 'cbwp', instanceId: 'cbwp-parent', items: [{ ...value.groups[0].items[0],
            productCode: 'cbwp', cloudResourceType: 'eip', sourceFingerprint: 'verified-network-share', rawPayload: { ProductCode: 'cbwp', InstanceID: 'cbwp-parent', SplitItemID: 'eip-owned' } }] };
        await store.finish((await store.claim())!, value, evidence, 'verified');
        expect((await store.units([resource.id])).find(unit => unit.category === 'eip_configuration')).toMatchObject({ state: 'partial', reasonCode: 'EIP_CONFIGURATION_BILL_NOT_RETURNED' });
        expect((await store.units([resource.id])).find(unit => unit.category === 'network_usage')?.state).toBe('issued');
        await store.enqueue(plan, categories, true);
        await store.finish((await store.claim())!, value, evidence, 'verified');
        expect((await repo.listBillingLineItems()).map(row => row.pretaxAmount)).toEqual([0.75]);
        await store.enqueue(plan, categories, true);
        await store.finish((await store.claim())!, { groups: [], coveredLedgerIds: [], rowCount: 0, evidence: { emptyReason: 'EIP_BILL_NOT_RETURNED' } }, { ...evidence, rowCount: 0 }, 'empty');
        expect((await store.units([resource.id])).every(unit => unit.reasonCode === 'EIP_BILL_NOT_RETURNED')).toBe(true);
        expect((await repo.listBillingLineItems()).map(row => row.pretaxAmount)).toEqual([0.75]);
    }));
    it('keeps VM configuration coverage and fees intact when the separate network probe is empty',async()=>inScope(async()=>{
        const a=await enqueue();await store.finish((await store.claim())!,result(a.resource,3),evidence,'verified');
        const configUnit=(await store.units([a.resource.id])).find(unit=>unit.category==='ecs')!;
        await store.enqueue({cloudProvider:provider,cloudAccountUid:uid,cloudAccountContextId:'fixture-context',regionId:'cn-beijing',billingDate:day,
            groupKey:'network-'+a.resource.id,kind:'discovery',productCode:'cdt',instanceId:a.resource.cloudResourceId,targetLedgerIds:[a.resource.id]},[{ledgerId:a.resource.id,category:'probe:network'}]);
        await store.finish((await store.claim())!,{groups:[],coveredLedgerIds:[],rowCount:0},{...evidence,rowCount:0},'empty');
        const units=await store.units([a.resource.id]);
        expect(units.find(unit=>unit.category==='ecs')).toMatchObject({state:'issued',adoptedAttemptId:configUnit.adoptedAttemptId});
        expect(units.find(unit=>unit.category==='probe:network')?.state).toBe('probe_empty');
        expect((await repo.listBillingLineItems()).map(row=>row.pretaxAmount)).toEqual([3]);
    }));
    it('never reads another workspace and forbids historical read-only mutation', async () => inScope(async () => {
        const a = await enqueue();
        const other = 'foreign-' + randomUUID();
        expect(await runInCloudWorkspace({ cloudWorkspaceId: other, provider, accountUid: uid }, () => store.units([a.resource.id]))).toEqual([]);
        await expect(runInCloudWorkspace({ cloudWorkspaceId: workspace, provider, accountUid: uid, isReadOnly: true }, () => store.ensureUnits(a.resource.id, day, ['disk']))).rejects.toThrow();
    }));
});
