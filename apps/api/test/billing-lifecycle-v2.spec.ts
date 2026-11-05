import { BillingLifecycleService, contiguousCoveredThrough } from '../src/admin/billing-lifecycle.service';
import { BillingBssClient } from '../src/admin/billing-bss-client';
import { collectAliyunSnapshotHistory } from '../src/admin/aliyun-snapshot-ecs-evidence';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';
import { createProvenBillingLedger } from './support/create-billing-fixture';
import { runInCloudWorkspace } from '../src/auth/cloud-workspace-scope';
import { assertDelegatedApiScopes } from '../src/auth/delegated-api-scopes';
import * as provenance from '../src/admin/billing-platform-scope';
import * as snapshotEvidence from '../src/admin/aliyun-snapshot-ecs-evidence';
import * as diskCoverage from '../src/admin/billing-system-disk-coverage';
import { BillingReconciliationService } from '../src/admin/billing-reconciliation.service';
const scope = { cloudWorkspaceId: 'billing-lifecycle-unit', provider: 'alibaba_cloud' as const, accountUid: '1234567890', actorUserId: 'alice', isPlatformManager: true };
const inScope = <T>(run: () => Promise<T>) => runInCloudWorkspace(scope, run);
const window = { startAt: '2026-10-14', endAt: '2026-10-22', view: 'user' };
async function fixture() {
    const repository = createMemoryAdminRepository();
    await repository.createPlatformUser({ id: 'alice', username: 'Alice', role: 'user', passwordHash: 'fixture' });
    const source = await createProvenBillingLedger(repository, { cloudAccountUid: scope.accountUid, regionId: 'cn-beijing', cloudResourceId: 'i-original',
        cloudResourceType: 'ecs', billingScope: 'user', ownerUserId: 'alice', billingStartAt: new Date('2026-10-14T00:00:00Z'), releasedAt: new Date('2026-10-22T01:00:00Z') });
    await repository.updateRangeInstance(source.instance.id, { status: 'destroyed', expiresAt: new Date('2026-10-22T01:00:00Z') });
    const units: any[] = [];
    const store = { units: jest.fn(async () => units), tasks: jest.fn(async () => []), settings: jest.fn(async () => ({ mode: 'shadow', generation: 0 })) };
    return { repository, source, units, store, service: new BillingLifecycleService(repository, store as any) };
}
describe('lifecycle billing projections', () => {
    beforeEach(() => jest.useFakeTimers().setSystemTime(new Date('2026-10-14T00:00:00Z')));
    afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });
    it('shows a recovered instance before any official bill exists without inventing zero money', async () => inScope(async () => {
        const f = await fixture();
        jest.setSystemTime(new Date('2026-10-28T00:00:00Z'));
        const list = await f.service.list(window);
        expect(list.items).toHaveLength(1);
        expect(list.items[0]).toMatchObject({ id: 'instance:' + f.source.instance.id, lifecycleStatus: 'released', amounts: [], reconciliationStatus: 'waiting' });
    }));
    it.each(['create_failed','destroy_failed','destroyed'] as const)('keeps actual charges and scheduled resource queries for %s attempts', async status => inScope(async () => {
        const f = await fixture();
        jest.setSystemTime(new Date('2026-10-28T00:00:00Z'));
        await f.repository.updateRangeInstance(f.source.instance.id, { status });
        await f.repository.updateProvisionJob(f.source.job.id, { status: 'failed', startedAt: new Date('2026-10-14T00:00:00Z') });
        await f.repository.upsertBillingLineItems([{ cloudAccountUid: scope.accountUid, syncBatchId: 'fixture', sourceFingerprint: 'failed-cost', billCycle: '2026-10', billingDate: '2026-10-14',
            productCode: 'ecs', billItem: 'CPU', cloudResourceId: 'i-original', cloudResourceType: 'ecs', pretaxAmount: 1.25, currency: 'CNY', billingScope: 'user', ownerUserId: 'alice',
            matchedLedgerId: f.source.ledger.id, rawPayload: { OwnerID: scope.accountUid, Region: 'cn-beijing', InstanceID: 'i-original' } }]);
        expect((await f.service.list(window)).items[0].amounts).toEqual([{ currency: 'CNY', pretaxAmount: 1.25 }]);
        const store = { ...f.store, ensureUnits: jest.fn(), enqueue: jest.fn() };
        const reconciler = new BillingReconciliationService(store as any, f.service, f.repository, {} as any, {} as any, {} as any);
        await reconciler.schedule({ startAt: '2026-10-14', endAt: '2026-10-14' }, false);
        expect(store.enqueue).toHaveBeenCalledWith(expect.objectContaining({ instanceId: 'i-original', targetLedgerIds: [f.source.ledger.id] }), expect.any(Array), false);
    }));
    it('records a failure without inventing zero money when no cloud identity has been recovered', async () => inScope(async () => {
        const f = await fixture();
        jest.setSystemTime(new Date('2026-10-28T00:00:00Z'));
        const failed = await f.repository.createRangeInstance({ name: 'failed before inventory', ownerUserId: 'alice', status: 'create_failed' });
        const row = (await f.service.list({ startAt: '2026-10-28', endAt: '2026-10-28' })).items.find(row => row.id === 'instance:' + failed.id);
        expect(row).toMatchObject({ amounts: [], reconciliationStatus: 'source_pending', billingStatus: 'pending', issueMessage: '计费资源记录待核验' });
        const job = await f.repository.createProvisionJob({ rangeInstanceId: failed.id, jobType: 'create', triggeredBy: 'alice' });
        await f.repository.updateProvisionJob(job.id, { status: 'failed' });
        await f.repository.updateRangeInstance(failed.id, { status: 'destroyed' });
        expect((await f.service.detail('instance:' + failed.id, { startAt: '2026-10-28', endAt: '2026-10-28' }, true)).entry)
            .toMatchObject({ amounts: [], lifecycleStatus: 'released', billingStatus: 'pending', reconciliationStatus: 'source_pending', issueMessage: '计费资源记录待核验' });
    }));
    it.each([false,true])('does not await a bill for a proven pre-creation render failure, later archived=%s', async archived => inScope(async () => {
        const f = await fixture(), at = new Date('2026-10-14T00:00:00Z');
        const instance = await f.repository.createRangeInstance({ name: 'rejected image', instanceMode: 'range', cloudProvider: 'alibaba_cloud', ownerUserId: 'alice', status: archived ? 'destroyed' : 'create_failed' });
        const job = await f.repository.createProvisionJob({ rangeInstanceId: instance.id, jobType: 'create', triggeredBy: 'alice' });
        await f.repository.updateProvisionJob(job.id, { status: 'failed', startedAt: at, finishedAt: at });
        await f.repository.updateRangeInstance(instance.id, { lastJobId: job.id });
        await f.repository.createProvisionJobStepLog({ jobId: job.id, stepName: 'render_template', status: 'failed', message: 'image preflight rejected', startedAt: at, finishedAt: at, stdoutExcerpt: null, stderrExcerpt: null });
        await f.repository.createProvisionJobStepLog({ jobId: job.id, stepName: 'range_resource_inventory', status: 'succeeded', message: JSON.stringify({ version: 1, rangeInstanceId: instance.id,
            executionContext: { provider: 'alibaba_cloud', cloudAccountContextId: 'context', cloudAccountUid: scope.accountUid, regionId: 'cn-beijing', zoneId: 'cn-beijing-h' }, resources: {} }), startedAt: at, finishedAt: at, stdoutExcerpt: null, stderrExcerpt: null });
        const result = await f.service.list({ ...window, billStatus: 'not_applicable' });
        expect(result.items).toHaveLength(1);
        expect(result.items[0]).toMatchObject({ id: 'instance:' + instance.id, amounts: [], resourceCount: 0, billingNotRequired: true,
            billingStatus: 'not_applicable', reconciliationStatus: 'current', lifecycleStatus: archived ? 'released' : 'failed' });
        expect(result.billingStatusCounts).toMatchObject({ unissued: 1, not_applicable: 1, pending: 0 });
        expect((await f.service.detail(result.items[0].id, window)).events).toHaveLength(1);
        expect((await f.repository.listBillingLineItems({}))).toHaveLength(0);
        // Once an apply was attempted, empty inventory cannot be treated as proof that nothing was created.
        await f.repository.createProvisionJobStepLog({ jobId: job.id, stepName: 'tofu_apply', status: 'failed', message: 'response lost', startedAt: at, finishedAt: at, stdoutExcerpt: null, stderrExcerpt: null });
        const unknown = await f.service.list({ ...window, billStatus: 'pending' }, true);
        expect(unknown.items.find(row => row.id === result.items[0].id)).toMatchObject({ billingNotRequired: false, amounts: [], reconciliationStatus: 'source_pending' });
        expect(unknown.billingStatusCounts.not_applicable).toBe(0);
    }));
    it('does not hide an existing EIP ledger when the instance later fails image preflight', async () => inScope(async () => {
        const f = await fixture();
        await f.repository.updateRangeInstance(f.source.instance.id, { status: 'create_failed', lastJobId: f.source.job.id });
        await f.repository.createBillingLedgerResource({ cloudAccountUid: scope.accountUid, regionId: 'cn-beijing', cloudResourceType: 'eip', cloudResourceId: 'eip-partial',
            rangeInstanceId: f.source.instance.id, sourceProvisionJobId: f.source.job.id, billingScope: 'user', ownerUserId: 'alice', billingStartAt: new Date('2026-10-14') });
        await f.repository.updateProvisionJob(f.source.job.id, { status: 'failed', startedAt: new Date('2026-10-14'), finishedAt: new Date('2026-10-14') });
        const detail = await f.service.detail('instance:' + f.source.instance.id, window);
        expect(detail.entry).toMatchObject({ billingNotRequired: false, billingStatus: 'unissued', resourceCount: 2, amounts: [] });
        expect(detail.resources.some(row => row.cloudResourceId === 'eip-partial')).toBe(true);
    }));
    it('recognizes an archived single instance rejected by its frozen image constraint, but retains contradictory resource evidence', async () => inScope(async () => {
        const f=await fixture(),at=new Date('2026-10-14');
        const context={provider:'alibaba_cloud',cloudAccountContextId:'context',cloudAccountUid:scope.accountUid,regionId:'cn-beijing',zoneId:'cn-beijing-h'};
        const instance=await f.repository.createRangeInstance({name:'rejected single',instanceMode:'single',ownerUserId:'alice',cloudProvider:'alibaba_cloud',status:'destroyed',singleInstanceBatchId:'batch',
            singleInstanceConfig:{executionBackend:'opentofu',cloudAccountContextId:'context',cloudAccountUid:scope.accountUid,regionId:'cn-beijing',zoneId:'cn-beijing-h',imageId:'m-original',systemDiskSize:40} as any});
        const source=await f.repository.createProvisionJob({rangeInstanceId:instance.id,jobType:'create',triggeredBy:'alice'});
        await f.repository.updateProvisionJob(source.id,{status:'failed',startedAt:at,finishedAt:at});
        const recovery=await f.repository.createProvisionJob({rangeInstanceId:instance.id,jobType:'destroy',triggeredBy:'alice'});
        await f.repository.updateProvisionJob(recovery.id,{status:'succeeded',startedAt:at,finishedAt:at});
        await f.repository.updateRangeInstance(instance.id,{lastJobId:recovery.id});
        await f.repository.createProvisionJobStepLog({jobId:recovery.id,stepName:'single_instance_create_rejection',status:'succeeded',startedAt:at,finishedAt:at,
            message:JSON.stringify({version:1,rangeInstanceId:instance.id,sourceProvisionJobId:source.id,executionContext:context,reason:'InvalidSystemDiskSize.LessThanImageSize',
                imageId:'m-original',requestedSystemDiskSize:40,minimumSystemDiskSize:64,requestId:'image-query-request'}),stdoutExcerpt:null,stderrExcerpt:null});
        const detail=await f.service.detail('instance:'+instance.id,window);
        expect(detail.entry).toMatchObject({billingStatus:'not_applicable',billingNotRequired:true,amounts:[],lifecycleStatus:'released'});
        expect(detail.charges).toEqual([]);expect(detail.events).toHaveLength(2);
        await f.repository.createProvisionJobStepLog({jobId:source.id,stepName:'single_instance_creation_receipt',status:'succeeded',startedAt:at,finishedAt:at,
            message:'receipt could not be recovered',stdoutExcerpt:null,stderrExcerpt:null});
        const unknown=await f.service.detail('instance:'+instance.id,window,true);
        expect(unknown.entry).toMatchObject({billingStatus:'pending',billingNotRequired:false,amounts:[]});
    }));
    it('keeps an owned resource visible when its parent instance link is missing', async () => inScope(async () => {
        const f = await fixture();
        jest.setSystemTime(new Date('2026-10-28T00:00:00Z'));
        const orphan = await f.repository.createBillingLedgerResource({ cloudAccountUid: scope.accountUid, regionId: 'cn-beijing', cloudResourceId: 'eip-orphan',
            cloudResourceType: 'eip', billingScope: 'user', ownerUserId: 'alice', billingStartAt: new Date('2026-10-14') });
        const row = (await f.service.list(window)).items.find(row => row.id === 'resource:' + orphan.id);
        expect(row).toMatchObject({ kind: 'resource', ownerUserId: 'alice', resourceCount: 1, reconciliationStatus: 'source_pending', amounts: [] });
    }));
    it('automatically plans original usage days across months with no page or manual request', async () => inScope(async () => {
        jest.setSystemTime(new Date('2026-07-01T00:00:00Z'));
        const f = await fixture();
        await f.repository.updateBillingLedgerResource(f.source.ledger.id, { billingStartAt: new Date('2026-07-01T00:00:00Z') });
        jest.setSystemTime(new Date('2026-10-28T00:00:00Z'));
        const config = { listExecutionCloudWorkspaces: async () => [{ id: scope.cloudWorkspaceId, provider: scope.provider, accountUid: scope.accountUid, isReadOnly: false }],
            runInWorkspace: async (_: string, work: () => Promise<unknown>) => runInCloudWorkspace(scope, work) };
        const reconciler = new BillingReconciliationService({ ...f.store, hasDueManual: async () => false } as any, f.service, f.repository, config as any, {} as any, {} as any);
        const schedule = jest.spyOn(reconciler, 'schedule').mockResolvedValue({ accepted: true, scheduledTasks: 1, mode: 'resource', note: '' });
        jest.spyOn(reconciler, 'processOne').mockResolvedValue(true);
        await reconciler.tick();
        expect(schedule).toHaveBeenCalledWith({ startAt: '2026-07-01', endAt: '2026-10-27' }, false);
    }));
    it('keeps post-release refunds attached to the original instance', async () => inScope(async () => {
        const f = await fixture();
        jest.setSystemTime(new Date('2026-10-28T00:00:00Z'));
        await f.repository.upsertBillingLineItems([{ cloudAccountUid: scope.accountUid, syncBatchId: 'fixture', sourceFingerprint: 'late-refund', billCycle: '2026-10', billingDate: '2026-10-25',
            productCode: 'ecs', billItem: 'refund', cloudResourceId: 'i-original', cloudResourceType: 'ecs', pretaxAmount: -0.25, currency: 'CNY', billingScope: 'user', ownerUserId: 'alice',
            matchedLedgerId: f.source.ledger.id, rawPayload: { OwnerID: scope.accountUid, Region: 'cn-beijing', InstanceID: 'i-original', Item: 'Refund' } }]);
        const rows = (await f.service.list({ startAt: '2026-10-24', endAt: '2026-10-27' })).items;
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ id: 'instance:' + f.source.instance.id, amounts: [{ currency: 'CNY', pretaxAmount: -0.25 }] });
    }));
    it('retains an official zero row and records expiry changes as events in the original entry', async () => inScope(async () => {
        const f = await fixture();
        jest.setSystemTime(new Date('2026-10-28T00:00:00Z'));
        await f.repository.upsertBillingLineItems([{ cloudAccountUid: scope.accountUid, syncBatchId: 'fixture', sourceFingerprint: 'official-zero', billCycle: '2026-10', billingDate: '2026-10-14',
                productCode: 'ecs', billItem: 'CPU', cloudResourceId: 'i-original', cloudResourceType: 'ecs', pretaxAmount: 0, currency: 'CNY', billingScope: 'user', ownerUserId: 'alice',
                matchedLedgerId: f.source.ledger.id, rawPayload: { OwnerID: scope.accountUid, Region: 'cn-beijing', InstanceID: 'i-original' } }]);
        const job = await f.repository.createProvisionJob({ rangeInstanceId: f.source.instance.id, jobType: 'change_expiry', triggeredBy: 'alice', topologySnapshot: {
                draftRevision: 0, topologyGraph: {}, topologySpec: {}, scenarioTemplateSpec: {}, compiledProvisionSpec: {}, compiledSpec: {}, templateModulePath: '',
                expiryPlan: { expiresAt: '2026-10-21T01:00:00Z', requestedExpiresAt: '2026-10-22T01:00:00Z', effectiveExpiresAt: '2026-10-21T01:00:00Z' } as any
            } });
        await f.repository.updateProvisionJob(job.id, { status: 'succeeded', finishedAt: new Date() });
        const list = await f.service.list(window);
        expect(list.items).toHaveLength(1);
        expect(list.items[0].amounts).toEqual([{ currency: 'CNY', pretaxAmount: 0 }]);
        expect((await f.service.detail(list.items[0].id, window)).events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'change_expiry', title: '修改回收时间' })]));
    }));
    it('does not use the latest bill date as continuous coverage', () => {
        const units = [{ billingDate: new Date('2026-10-14'), state: 'issued', category: 'ecs' }, { billingDate: new Date('2026-10-16'), state: 'issued', category: 'ecs' }];
        expect(contiguousCoveredThrough('2026-10-14', '2026-10-16', units, ['ecs'])).toBe('2026-10-14');
        expect(contiguousCoveredThrough('2026-10-14', '2026-10-14', [{ ...units[0], category: 'eip_configuration' }], ['eip_configuration', 'network_usage'])).toBeNull();
    });
    it('plans every disk while reading its daily ownership inventory only once', async () => inScope(async () => {
        const f = await fixture();
        jest.setSystemTime(new Date('2026-10-28T00:00:00Z'));
        const ledgers = ['disk-one', 'disk-two'].map(id => ({ ...f.source.ledger, id, cloudResourceId: 'd-' + id, cloudResourceType: 'disk' as const,
            tagsSnapshot: { CloudAccountContextId: 'fixture-context' } }));
        const plannedWindow = f.service.window({ startAt: '2026-10-14', endAt: '2026-10-14' });
        const data = { scope, settings: { mode: 'resource' }, window: plannedWindow, ledgers, items: [], units: [], tasks: [],
            entries: [{ id: 'fixture-entry', resources: ledgers.map(row => ({ ledgerId: row.id })) }],
            proof: { packedImages: [], imageImports: [], createdLedgerIds: new Set(ledgers.map(row => row.id)) } };
        const ownership = jest.spyOn(diskCoverage, 'systemDiskBillingCoverage').mockResolvedValue({ covered: new Set(), mappingPending: new Set(), parents: new Map() });
        const repository = { listRangeInstances: jest.fn(async () => []) };
        const store = { ensureUnits: jest.fn(), enqueue: jest.fn(), settings: async () => data.settings };
        const reconciler = new BillingReconciliationService(store as any, { load: async () => data } as any, repository as any, {} as any, {} as any, {} as any);
        await reconciler.schedule({ startAt: '2026-10-14', endAt: '2026-10-14' }, false);
        expect(ownership).toHaveBeenCalledTimes(1);
        expect(repository.listRangeInstances).toHaveBeenCalledTimes(1);
        expect(store.ensureUnits).toHaveBeenCalledTimes(2);
        expect(store.enqueue).toHaveBeenCalledTimes(2);
    }));
    it('keeps foreign users and workspaces out of ledger-first entries', async () => inScope(async () => {
        const f = await fixture();
        jest.setSystemTime(new Date('2026-10-28T00:00:00Z'));
        const rows = await runInCloudWorkspace({ ...scope, isPlatformManager: false, actorUserId: 'bob' }, () => f.service.list(window));
        expect(rows.items).toEqual([]);
        expect(rows.currencyTotals).toEqual([]);
    }));
    it('requires billing control scopes for scheduling and settings scope for cutover', () => {
        expect(() => assertDelegatedApiScopes('GET', '/admin/billing/entries', new Set(['billing:read']))).not.toThrow();
        expect(() => assertDelegatedApiScopes('POST', '/admin/billing/reconcile', new Set(['billing:read']))).toThrow();
        expect(() => assertDelegatedApiScopes('POST', '/admin/billing/reconciliation/mode', new Set(['billing:sync']))).toThrow();
    });
    it('attaches source-ECS snapshot fees once even when the original ECS is older than the billing start', async () => inScope(async () => {
        const f = await fixture();
        jest.setSystemTime(new Date('2026-10-28T00:00:00Z'));
        const snapshot = await f.repository.createBillingLedgerResource({ cloudAccountUid: scope.accountUid, regionId: 'cn-beijing', cloudResourceId: 's-new',
            cloudResourceType: 'snapshot', billingScope: 'user', ownerUserId: 'alice', rangeInstanceId: f.source.instance.id, sourceProvisionJobId: f.source.job.id,
            billingStartAt: new Date('2026-10-21T00:00:00Z') });
        jest.spyOn(provenance, 'loadPlatformBillingProof').mockResolvedValue({ ledgers: [f.source.ledger, snapshot], imageImports: [], packedImages: [], cosBuckets: [],
            createdLedgerIds: new Set([f.source.ledger.id, snapshot.id]), unverifiedSourceLedgerIds: new Set() });
        jest.spyOn(snapshotEvidence, 'readAliyunSnapshotEcsScope').mockReturnValue({ sourceLedgerId: f.source.ledger.id, sourceInstanceId: 'i-original',
            snapshotLedgerIds: [snapshot.id], snapshotIds: ['s-new'], artifactIds: ['artifact'], regionId: 'cn-beijing' } as any);
        const saved = process.env.PLATFORM_BILLING_STARTED_AT;
        process.env.PLATFORM_BILLING_STARTED_AT = '2026-10-15T00:00:00.000Z';
        try {
            await f.repository.upsertBillingLineItems([{ cloudAccountUid: scope.accountUid, syncBatchId: 'billing-current:2026-10-15T00:00:00.000Z:fixture',
                    sourceFingerprint: 'parent-snapshot-fee', billCycle: '2026-10', billingDate: '2026-10-22', productCode: 'snapshot', billItem: 'snapshot',
                    cloudResourceId: 'i-original', cloudResourceType: 'ecs', pretaxAmount: 2, currency: 'CNY', billingScope: 'user', ownerUserId: 'alice',
                    matchedLedgerId: f.source.ledger.id, rawPayload: { OwnerID: scope.accountUid, Region: 'cn-beijing', InstanceID: 'i-original' } }]);
            const list = await f.service.list({ ...window, view: 'platform' });
            expect(list.currencyTotals[0].pretaxAmount).toBe(2);
            expect(list.items[0].amounts).toEqual([{ currency: 'CNY', pretaxAmount: 2 }]);
            expect((await f.service.detail(list.items[0].id, window)).resources[0].amounts).toEqual([]);
        }
        finally {
            if (saved === undefined)
                delete process.env.PLATFORM_BILLING_STARTED_AT;
            else
                process.env.PLATFORM_BILLING_STARTED_AT = saved;
        }
    }));
});
describe('targeted official queries', () => {
    afterEach(() => jest.restoreAllMocks());
    const context = { provider: 'alibaba_cloud', accountUid: scope.accountUid, accountUidResolved: true, accessKeyId: 'fixture-key', accessKeySecret: 'fixture-secret' };
    const response = (rows: any[]) => new Response(JSON.stringify({ RequestId: 'official-request', Success: true, Code: 'Success',
        Data: { AccountID: scope.accountUid, BillingCycle: '2026-10', TotalCount: rows.length, Items: rows } }), { status: 200 });
    it('uses the resource ID, includes zero fees and captures complete official receipts', async () => {
        const fetcher = jest.spyOn(global, 'fetch').mockResolvedValue(response([{ ProductCode: 'ecs', InstanceID: 'i-original' }]));
        const client = new BillingBssClient({ getAccountContext: async () => context } as any), evidence = { requestIds: [] as string[], pageCount: 0, rowCount: 0, complete: false };
        await client.captureQuery(evidence, () => client.listDailyBillingItems({ billingDate: '2026-10-14', instanceId: 'i-original' }, context as any));
        const args = new URL(String(fetcher.mock.calls[0][0])).searchParams;
        expect(args.get('InstanceID')).toBe('i-original');
        expect(args.get('IsHideZeroCharge')).toBe('false');
        expect(evidence).toMatchObject({ requestIds: ['official-request'], pageCount: 1, rowCount: 1, complete: true,
            datasets: [{ complete: true, instanceId: 'i-original', rows: [{ ProductCode: 'ecs', InstanceID: 'i-original' }] }] });
    });
    it('rejects a response outside the exact resource filter', async () => {
        jest.spyOn(global, 'fetch').mockResolvedValue(response([{ ProductCode: 'ecs', InstanceID: 'i-foreign' }]));
        const client = new BillingBssClient({ getAccountContext: async () => context } as any);
        await expect(client.listDailyBillingItems({ billingDate: '2026-10-14', instanceId: 'i-original' }, context as any)).rejects.toThrow('different resource');
    });
    it('filters split bills by the exact split ID and validates the returned split date', async () => {
        const fetcher = jest.spyOn(global, 'fetch').mockResolvedValue(response([{ ProductCode: 'snapshot', InstanceID: 'cn-beijing;test', SplitItemID: 's-original', SplitBillingDate: '2026-10-14' }]));
        const client = new BillingBssClient({ getAccountContext: async () => context } as any);
        await client.listDailySplitBillingItems({ billingDate: '2026-10-14', productCode: 'snapshot', splitItemId: 's-original' }, context as any);
        expect(new URL(String(fetcher.mock.calls[0][0])).searchParams.get('SplitItemID')).toBe('s-original');
    });
});
describe('archived snapshot provenance', () => {
    const source = { id: 'ledger-source', cloudProvider: 'alibaba_cloud', cloudWorkspaceId: scope.cloudWorkspaceId, cloudAccountUid: scope.accountUid, cloudResourceId: 'i-original', regionId: 'cn-beijing' } as any;
    const archive = { version: 1 as const, provider: 'alibaba_cloud' as const, cloudWorkspaceId: scope.cloudWorkspaceId, cloudAccountUid: scope.accountUid, regionId: 'cn-beijing', sourceInstanceId: 'i-original',
        startAt: '2026-01-01T00:00:00Z', endAt: '2026-01-02T15:59:59Z', observedAt: '2026-01-03T16:30:00Z', requestIds: ['original-audit-request'],
        events: [{ id: 'event-1', time: '2026-01-01T00:00:00Z', name: 'CreateImage', type: 'ApiCall', failed: false, requestResourceIds: ['i-original'], responseResourceIds: ['m-owned'], resourceIds: ['i-original', 'm-owned'] }] };
    const credentials = { provider: 'alibaba_cloud', accountUid: scope.accountUid, accessKeyId: 'fixture', accessKeySecret: 'fixture' };
    it('replays complete archived safe events beyond the online audit window without reconstructing evidence', async () => {
        const fetcher = jest.fn();
        const history = await collectAliyunSnapshotHistory(credentials, { sourceLedger: source, sourceCreatedAt: new Date(archive.startAt), billingDate: '2026-01-02' }, { archivedHistory: archive, now: () => new Date('2026-10-28'), fetch: fetcher });
        expect(history?.events).toEqual(archive.events);
        expect(fetcher).not.toHaveBeenCalled();
    });
    it('rejects a foreign or incomplete archive instead of guessing missing history', async () => {
        const history = await collectAliyunSnapshotHistory(credentials, { sourceLedger: source, sourceCreatedAt: new Date(archive.startAt), billingDate: '2026-01-02' }, { archivedHistory: { ...archive, cloudAccountUid: 'foreign' }, now: () => new Date('2026-10-28') });
        expect(history).toBeNull();
    });
});
