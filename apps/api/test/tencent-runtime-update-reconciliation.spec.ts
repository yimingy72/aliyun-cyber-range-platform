import { createHash } from 'node:crypto';
import { PlatformResourceReconciliationService } from '../src/provisioning/platform-resource-reconciliation.service';
import * as resources from '../src/admin/tencent-cloud-resources';
import type { TencentResource } from '../src/admin/tencent-cloud-resources';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';
import { runInCloudWorkspace } from '../src/auth/cloud-workspace-scope';

const context = { provider: 'tencent_cloud' as const, cloudAccountContextId: 'context', cloudAccountUid: '100001', regionId: 'ap-nanjing', zoneId: 'ap-nanjing-1' };
const scope = { cloudWorkspaceId: 'runtime-reconcile-fixture', provider: context.provider, accountUid: context.cloudAccountUid };
const run = <T>(work: () => T) => runInCloudWorkspace(scope, work);
afterEach(() => jest.restoreAllMocks());

async function fixture(mode: 'range' | 'single' = 'range', jobType: 'update' | 'create' = 'update') {
 const repository = createMemoryAdminRepository();
 const summary = { mode: 'opentofu' as const, executionContext: context, hostIds: { old: 'ins-old', added: 'ins-added' } };
 const instance = await repository.createRangeInstance({ name: 'runtime range', cloudProvider: 'tencent_cloud', instanceMode: mode, ownerUserId: 'owner', status: 'running', resourceSummary: summary,
  ...(mode === 'single' ? { singleInstanceBatchId: 'batch', singleInstanceConfig: { cloudAccountContextId: context.cloudAccountContextId, cloudAccountUid: context.cloudAccountUid, regionId: context.regionId, zoneId: context.zoneId } as any } : {}) });
 const source = await repository.createProvisionJob({ rangeInstanceId: instance.id, jobType, triggeredBy: 'owner', topologySnapshot: {
  operation: jobType, draftRevision: 1, topologyGraph: {}, topologySpec: {}, scenarioTemplateSpec: {}, compiledProvisionSpec: {}, compiledSpec: {}, templateModulePath: 'fixture' } });
 await repository.updateProvisionJob(source.id, { status: 'succeeded', startedAt: new Date(Date.now() - 60_000) });
 await repository.updateRangeInstance(instance.id, { lastJobId: source.id, ...(mode === 'single' ? { singleInstanceConfig: { ...instance.singleInstanceConfig!, opentofuCreateJobId: source.id } } : {}) });
 const tags = { CreatedBy: 'cyber-range-platform', PlatformManaged: 'true', ExecutionBackend: 'opentofu', RangeInstanceId: instance.id,
  CloudAccountUid: context.cloudAccountUid, CloudAccountContextId: context.cloudAccountContextId, PlatformScope: 'user', PlatformUserId: 'owner', PlatformCreateJobId: source.id,
  ...(mode === 'single' ? { SingleInstanceBatchId: 'batch', CreationIntentId: createHash('sha256').update(JSON.stringify(['tencent_cloud', context.cloudAccountContextId, context.cloudAccountUid, context.regionId, context.zoneId, 'batch', instance.id, source.id])).digest('hex').slice(0,32) } : {}) };
 const original = await repository.createProvisionJob({ rangeInstanceId: instance.id, jobType: 'create', triggeredBy: 'owner' });
 await repository.updateProvisionJob(original.id, { status: 'succeeded', startedAt: new Date(Date.now() - 120_000) });
 for (const id of Object.values(summary.hostIds)) await repository.createBillingLedgerResource({ cloudProvider: 'tencent_cloud', regionId: context.regionId, cloudAccountUid: context.cloudAccountUid,
  cloudResourceId: id, cloudResourceType: 'ecs', billingScope: 'user', ownerUserId: 'owner', rangeInstanceId: instance.id, sourceProvisionJobId: id === 'ins-old' ? original.id : source.id, billingStartAt: new Date() });
 const native = Object.values(summary.hostIds).map(id => ({ id, kind: 'ecs', tags, instanceId: id, vpcId: 'vpc-owned', diskUsage: null, deleteWithInstance: null, shared: false, chargeType: 'POSTPAID_BY_HOUR',
  evidence: { provider: 'tencent_cloud', accountUid: context.cloudAccountUid, cloudAccountContextId: context.cloudAccountContextId, regionId: context.regionId, action: 'DescribeInstances', requestIds: ['fixture-receipt'], observedAt: new Date().toISOString() } } as TencentResource));
 const inventory = jest.spyOn(resources, 'describeTencentResourceInventory').mockImplementation(async (_account, kind, query) => kind === 'ecs' ? native.filter(resource => !query.ids || query.ids.includes(resource.id)) : []);
 const resolve = jest.spyOn(repository, 'resolveCloudResourceDrift');
 const service = new PlatformResourceReconciliationService(repository, { getDefaultCredentials: async () => ({ provider: context.provider, accountUid: context.cloudAccountUid, cloudAccountContextId: context.cloudAccountContextId,
  accountUidResolved: true, regionId: context.regionId, accessKeyId: 'fixture', accessKeySecret: 'fixture' }) } as any);
 return { repository, instance, source, service, native, inventory, resolve };
}

it('accepts owned old and update-created Tencent resources without altering history, billing or lifecycle', () => run(async () => {
 const f = await fixture(); const before = await f.repository.listBillingLedgerResources(); const record = await f.repository.getRangeInstanceById(f.instance.id);
 const update = jest.spyOn(f.repository, 'updateRangeInstance'); const bills = jest.spyOn(f.repository, 'createBillingLedgerResource');
 expect(await f.service.reconcile()).toEqual({ recovered: 0, drifts: 0, skipped: false });
 expect(await f.repository.listBillingLedgerResources()).toEqual(before); expect(await f.repository.getRangeInstanceById(f.instance.id)).toEqual(record);
 expect(update).not.toHaveBeenCalled(); expect(bills).not.toHaveBeenCalled(); expect(f.resolve).toHaveBeenCalledTimes(2);
}));

it.each(['workspace', 'instance', 'inventory', 'unstarted-update', 'single-update'] as const)('rejects forged or missing %s proof without adopting resources or assigning bills', cause => run(async () => {
 const f = await fixture(cause === 'single-update' ? 'single' : 'range');
 if (cause === 'inventory') await f.repository.updateRangeInstance(f.instance.id, { resourceSummary: { mode: 'opentofu', executionContext: context, hostIds: {} } });
 const lookup = f.repository.getProvisionJobById.bind(f.repository);
 if (['workspace', 'instance', 'unstarted-update'].includes(cause)) jest.spyOn(f.repository, 'getProvisionJobById').mockImplementation(async id => { const job = await lookup(id); return job ? { ...job,
  ...(cause === 'workspace' ? { cloudWorkspaceId: 'foreign' } : cause === 'instance' ? { rangeInstanceId: 'foreign' } : { startedAt: null }) } : null; });
 const before = await f.repository.listBillingLedgerResources();
 expect(await f.service.reconcile()).toEqual({ recovered: 0, drifts: 2, skipped: false });
 expect(await f.repository.listBillingLedgerResources()).toEqual(before); expect(f.resolve).not.toHaveBeenCalled();
}));

it('retains strict single-member creation intent validation for original creation jobs', () => run(async () => {
 const f = await fixture('single', 'create');
 expect((await f.service.reconcile()).drifts).toBe(0);
 f.native.forEach(resource => { resource.tags = { ...resource.tags, CreationIntentId: 'forged' }; });
 expect((await f.service.reconcile()).drifts).toBe(2);
}));
