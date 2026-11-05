import { recoverBillingInventories } from '../src/admin/billing-inventory-recovery';
import { loadPlatformBillingProof } from '../src/admin/billing-platform-scope';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';
import { runInCloudWorkspace } from '../src/auth/cloud-workspace-scope';

const scope = { cloudWorkspaceId: 'billing-failure-recovery', provider: 'alibaba_cloud' as const, accountUid: 'owned-account', actorUserId: 'alice', isPlatformManager: true };
const inScope = <T>(work: () => Promise<T>) => runInCloudWorkspace(scope, work);
const context = { provider: scope.provider, cloudAccountUid: scope.accountUid, cloudAccountContextId: 'original-context', regionId: 'cn-beijing', zoneId: 'cn-beijing-h' };
async function fixture() {
  const repository = createMemoryAdminRepository();
  const instance = await repository.createRangeInstance({ name: 'partial failed creation', cloudProvider: scope.provider, ownerUserId: 'alice', instanceMode: 'range', status: 'create_failed' });
  const source = await repository.createProvisionJob({ rangeInstanceId: instance.id, jobType: 'create', triggeredBy: 'alice' });
  const job = (await repository.updateProvisionJob(source.id, { status: 'failed', startedAt: new Date('2026-10-14T01:00:00Z'), finishedAt: new Date('2026-10-14T01:05:00Z') }))!;
  const payload = { version: 1, cloudProvider: scope.provider, cloudWorkspaceId: scope.cloudWorkspaceId, rangeInstanceId: instance.id, sourceJobId: job.id,
    ownerUserId: 'alice', executionContext: context,
    resources: [{ type: 'ecs', id: 'i-partial', address: 'module.range.alicloud_instance.hosts["dc"]', providerResourceType: 'alicloud_instance', logicalKey: 'dc' }] };
  const receipt = (override: Record<string, unknown> = {}) => repository.createProvisionJobStepLog({ jobId: job.id, stepName: 'range_resource_creation_receipt', status: 'succeeded',
    startedAt: new Date('2026-10-14T01:01:00Z'), finishedAt: new Date('2026-10-14T01:01:00Z'), message: JSON.stringify({ ...payload, ...override }) });
  return { repository, instance, job, payload, receipt };
}
describe('failed creation billing inventory recovery', () => {
  it.each([null, 'original'] as const)('repairs verified missing account metadata with source %s without changing release history', async origin => inScope(async () => {
    const f = await fixture(); await f.receipt();
    const releasedAt = new Date('2026-10-14T02:00:00Z');
    const row = await f.repository.createBillingLedgerResource({ cloudProvider: 'alibaba_cloud', cloudAccountUid: null, regionId: 'cn-beijing', cloudResourceId: 'i-partial', cloudResourceType: 'ecs',
      billingScope: 'user', ownerUserId: 'alice', rangeInstanceId: f.instance.id, sourceProvisionJobId: origin ? f.job.id : null, billingStartAt: f.job.startedAt!, releasedAt, tagsSnapshot: { preserve: true } });
    expect(await recoverBillingInventories(f.repository, scope)).toBe(1);
    const repaired = (await f.repository.listBillingLedgerResources())[0];
    expect(repaired).toMatchObject({ id: row.id, cloudAccountUid: scope.accountUid, sourceProvisionJobId: f.job.id, releasedAt,
      tagsSnapshot: { preserve: true, CloudAccountContextId: context.cloudAccountContextId } });
    expect((await loadPlatformBillingProof(f.repository)).createdLedgerIds.has(row.id)).toBe(true);
    expect(await recoverBillingInventories(f.repository, scope)).toBe(0);
    expect((await f.repository.listProvisionJobStepLogs(f.job.id)).filter(step => step.stepName === 'platform_billing_origin_repair')).toHaveLength(1);
  }));
  it('does not move a conflicting existing account or owner into the current bill', async () => inScope(async () => {
    const f = await fixture(); await f.receipt();
    await f.repository.createBillingLedgerResource({ cloudAccountUid: 'foreign', regionId: 'cn-beijing', cloudResourceId: 'i-partial', cloudResourceType: 'ecs',
      billingScope: 'user', ownerUserId: 'other-owner', rangeInstanceId: f.instance.id, billingStartAt: f.job.startedAt! });
    expect(await recoverBillingInventories(f.repository, scope)).toBe(0);
    expect((await f.repository.listBillingLedgerResources())[0]).toMatchObject({ cloudAccountUid: 'foreign', ownerUserId: 'other-owner', sourceProvisionJobId: null });
  }));
  it('recovers an exact surviving resource from its creation receipt even after the active summary is missing', async () => inScope(async () => {
    const f = await fixture(); await f.receipt();
    expect(await recoverBillingInventories(f.repository, scope)).toBe(1);
    const rows = await f.repository.listBillingLedgerResources();
    expect(rows).toMatchObject([{ cloudResourceId: 'i-partial', ownerUserId: 'alice', sourceProvisionJobId: f.job.id, releasedAt: null }]);
    expect((await loadPlatformBillingProof(f.repository)).createdLedgerIds.has(rows[0].id)).toBe(true);
    expect(await recoverBillingInventories(f.repository, scope)).toBe(0);
  }));
  it('uses a proven failed-create rollback time and never reopens an existing released ledger', async () => inScope(async () => {
    const f = await fixture(); await f.receipt();
    const releasedAt = new Date('2026-10-14T01:06:00Z');
    await f.repository.createProvisionJobStepLog({ jobId: f.job.id, stepName: 'confirm_failed_create_cleanup', status: 'succeeded', finishedAt: releasedAt,
      message: JSON.stringify({ version: 1, rangeInstanceId: f.instance.id, provisionJobId: f.job.id, claimStartedAt: f.job.startedAt!.toISOString(),
        cloudAccountContextId: context.cloudAccountContextId, cloudAccountUid: scope.accountUid, regionId: context.regionId }) });
    await recoverBillingInventories(f.repository, scope);
    expect((await f.repository.listBillingLedgerResources())[0].releasedAt).toEqual(releasedAt);
    await f.repository.updateRangeInstance(f.instance.id, { status: 'destroy_failed' });
    await recoverBillingInventories(f.repository, scope);
    expect((await f.repository.listBillingLedgerResources())[0].releasedAt).toEqual(releasedAt);
  }));
  it('does not turn a destroyed display status into a release proof', async () => inScope(async () => {
    const f = await fixture(); await f.receipt();
    await f.repository.updateRangeInstance(f.instance.id, { status: 'destroyed' });
    await recoverBillingInventories(f.repository, scope);
    expect((await f.repository.listBillingLedgerResources())[0].releasedAt).toBeNull();
  }));
  it('retains the resource as unverified when a later claim overwrote the original creation clock', async () => inScope(async () => {
    const f = await fixture(); await f.receipt();
    await f.repository.updateProvisionJob(f.job.id, { startedAt: new Date(Date.now() + 60000) });
    expect(await recoverBillingInventories(f.repository, scope)).toBe(1);
    const row = (await f.repository.listBillingLedgerResources())[0];
    expect(row.sourceProvisionJobId).toBeNull();
    expect(row.tagsSnapshot.OriginalCreationJobId).toBe(f.job.id);
    expect((await loadPlatformBillingProof(f.repository)).createdLedgerIds.has(row.id)).toBe(false);
  }));
  it.each(['succeeded','failed'] as const)('keeps exact cleanup evidence separate from a %s destroy task', async status => inScope(async () => {
    const f = await fixture(); await f.receipt();
    const at = new Date('2026-10-14T02:00:00Z');
    const destroy = await f.repository.createProvisionJob({ rangeInstanceId: f.instance.id, jobType: 'destroy', triggeredBy: 'alice' });
    await f.repository.updateProvisionJob(destroy.id, { status, startedAt: at, finishedAt: at });
    await f.repository.createProvisionJobStepLog({ jobId: destroy.id, stepName: 'range_resource_inventory', status: 'succeeded', startedAt: at, finishedAt: at,
      message: JSON.stringify({ ...f.payload, sourceJobId: destroy.id, resources: { hostIds: { dc: 'i-partial' } } }) });
    await f.repository.createProvisionJobStepLog({ jobId: destroy.id, stepName: 'verify_destroy', status: 'succeeded', startedAt: at, finishedAt: at });
    await recoverBillingInventories(f.repository, scope);
    expect((await f.repository.listBillingLedgerResources())[0].releasedAt).toEqual(status === 'succeeded' ? at : null);
  }));
  it('continues when the provisioner concurrently records the same owned physical resource', async () => inScope(async () => {
    const f = await fixture(); await f.receipt();
    const create = f.repository.createBillingLedgerResource.bind(f.repository);
    jest.spyOn(f.repository, 'createBillingLedgerResource').mockImplementationOnce(async input => {
      await create(input); throw Object.assign(new Error('concurrent insert'), { code: 'P2002' });
    });
    expect(await recoverBillingInventories(f.repository, scope)).toBe(0);
    expect(await f.repository.listBillingLedgerResources()).toHaveLength(1);
  }));
  it.each(['workspace','account','owner'])('rejects a receipt whose %s differs from the frozen source', async mismatch => inScope(async () => {
    const f = await fixture();
    await f.receipt(mismatch === 'workspace' ? { cloudWorkspaceId: 'foreign' } : mismatch === 'account' ? { executionContext: { ...context, cloudAccountUid: 'foreign' } } : { ownerUserId: 'foreign' });
    expect(await recoverBillingInventories(f.repository, scope)).toBe(0);
    expect(await f.repository.listBillingLedgerResources()).toHaveLength(0);
  }));
  it('does not convert an observed update inventory into creation proof or money', async () => inScope(async () => {
    const f = await fixture();
    const update = await f.repository.createProvisionJob({ rangeInstanceId: f.instance.id, jobType: 'update', triggeredBy: 'alice', topologySnapshot: { operation: 'update' } as any });
    await f.repository.updateProvisionJob(update.id, { startedAt: new Date(), status: 'failed' });
    await f.repository.createProvisionJobStepLog({ jobId: update.id, stepName: 'range_resource_inventory', status: 'succeeded',
      message: JSON.stringify({ ...f.payload, sourceJobId: update.id, resources: { hostIds: { dc: 'i-observed' } } }) });
    expect(await recoverBillingInventories(f.repository, scope)).toBe(0);
  }));
});
