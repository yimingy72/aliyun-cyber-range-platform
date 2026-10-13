import { readPatrolInventories } from '../src/admin/resource-patrol-inventory';
import { ResourceAlertsService } from '../src/admin/resource-alerts.service';
import { runInCloudWorkspace } from '../src/auth/cloud-workspace-scope';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';
import { createMemoryResourcePatrolRepository } from './support/create-memory-resource-patrol-repository';

async function fixture(provider: 'alibaba_cloud' | 'tencent_cloud' = 'alibaba_cloud', single = false) {
  const scope = { cloudWorkspaceId: 'origin-space', provider, accountUid: 'owned-uid' };
  const context = { provider, cloudAccountUid: scope.accountUid, cloudAccountContextId: 'original-context',
    regionId: provider === 'alibaba_cloud' ? 'cn-hangzhou' : 'ap-nanjing', zoneId: provider === 'alibaba_cloud' ? 'cn-hangzhou-j' : 'ap-nanjing-1' };
  const repository = createMemoryAdminRepository();
  return runInCloudWorkspace(scope, async () => {
    const instance = await repository.createRangeInstance({ name: 'origin fixture', status: 'destroyed', cloudProvider: provider,
      ownerUserId: 'owner', instanceMode: single ? 'single' : 'range', singleInstanceBatchId: single ? 'batch-a' : undefined,
      singleInstanceConfig: single ? { hostKey: 'new' } as any : undefined });
    const base = (jobId: string, resources: any) => ({ version: 1, cloudProvider: provider, cloudWorkspaceId: scope.cloudWorkspaceId,
      rangeInstanceId: instance.id, sourceJobId: jobId, ownerUserId: 'owner', executionContext: context, resources });
    const job = async (jobType: any, operation?: 'create' | 'update' | 'destroy') => {
      const created = await repository.createProvisionJob({ rangeInstanceId: instance.id, jobType, triggeredBy: 'owner',
        topologySnapshot: operation ? { operation } as any : undefined });
      return repository.updateProvisionJob(created.id, { status: 'failed', startedAt: new Date() });
    };
    const log = (jobId: string, stepName: string, resources: any, override: any = {}) => repository.createProvisionJobStepLog({ jobId, stepName, status: 'succeeded',
      message: JSON.stringify({ ...base(jobId, resources), ...override }) });
    const read = () => runInCloudWorkspace(scope, async () => readPatrolInventories(repository, await repository.listRangeInstances(), await repository.listProvisionJobs(), scope));
    const ids = provider === 'alibaba_cloud' ? { old: 'i-old', new: 'i-new', oldDisk: 'd-old', newDisk: 'd-new' }
      : { old: 'ins-old', new: 'ins-new', oldDisk: 'disk-old', newDisk: 'disk-new' };
    const observation = { hostIds: { old: ids.old, new: ids.new }, systemDiskIds: { old: ids.oldDisk, new: ids.newDisk },
      diskInventoryHostIds: { old: ids.old, new: ids.new }, diskOwnershipProofs: {
        [ids.oldDisk]: { instanceId: ids.old, method: 'persisted', deleteWithInstance: true },
        [ids.newDisk]: { instanceId: ids.new, method: 'persisted', deleteWithInstance: true } } };
    const receipt = { type: 'ecs', id: ids.new, logicalKey: 'new', address: `module.range.${provider === 'alibaba_cloud' ? 'alicloud' : 'tencentcloud'}_instance.hosts["new"]`,
      providerResourceType: provider === 'alibaba_cloud' ? 'alicloud_instance' : 'tencentcloud_instance' };
    return { scope, context, repository, instance, job, log, read, ids, observation, receipt };
  });
}

describe('patrol creation authority is independent of observation', () => {
  it.each([['destroy', undefined], ['retry', 'destroy'], ['update', 'update'], ['retry', undefined]] as const)
    ('does not grant deletion or billing from %s/%s inventory', async (type, operation) => {
      const f = await fixture();
      await runInCloudWorkspace(f.scope, async () => { const job = await f.job(type, operation); await f.log(job.id, 'range_resource_inventory', f.observation); });
      const [inventory] = await f.read();
      expect(inventory.resources).toEqual(expect.arrayContaining([{ type: 'ecs', id: f.ids.new }, { type: 'disk', id: f.ids.newDisk }]));
      expect(inventory.proven.size).toBe(0); expect(inventory.birthSources.size).toBe(0);
    });
  it.each([['create', undefined], ['retry', 'create']] as const)('retains accurate failed %s/%s creation inventory', async (type, operation) => {
    const f = await fixture(); let source: any;
    await runInCloudWorkspace(f.scope, async () => { source = await f.job(type, operation); await f.log(source.id, 'range_resource_inventory', f.observation); });
    expect((await f.read())[0].birthSources.get(`ecs:${f.ids.new}`)).toBe(source.id);
  });
  it('queries current tagless physical IDs without granting them any birth proof', async () => {
    const f = await fixture();
    await runInCloudWorkspace(f.scope, () => f.repository.updateRangeInstance(f.instance.id, { resourceSummary: { mode: 'opentofu', executionContext: f.context, hostIds: { new: f.ids.new } } }));
    const [inventory] = await f.read(); expect(inventory.resources).toContainEqual({ type: 'ecs', id: f.ids.new });
    expect(inventory.proven.size).toBe(0);
  });
  it.each(['alibaba_cloud', 'tencent_cloud'] as const)('proves actual %s update host and only its exact implicit system disk', async provider => {
    const f = await fixture(provider); let update: any;
    await runInCloudWorkspace(f.scope, async () => {
      update = await f.job('update', 'update');
      await f.log(update.id, 'range_resource_inventory', f.observation);
      await f.log(update.id, 'range_resource_creation_receipt', [f.receipt]);
    });
    const [inventory] = await f.read(); expect(inventory.proven).toEqual(new Set([`ecs:${f.ids.new}`, `disk:${f.ids.newDisk}`]));
    expect(inventory.birthSources.get(`disk:${f.ids.newDisk}`)).toBe(update.id);
    expect(inventory.birthSources.has(`ecs:${f.ids.old}`)).toBe(false); expect(inventory.birthSources.has(`disk:${f.ids.oldDisk}`)).toBe(false);
  });
  it.each(['alibaba_cloud', 'tencent_cloud'] as const)('accepts exact %s network creation identities including native rule IDs', async provider => {
    const f = await fixture(provider);
    const entities = provider === 'alibaba_cloud'
      ? [['vpc','vpc-new','alicloud_vpc'], ['vswitch','vsw-new','alicloud_vswitch'], ['security_group','sg-new','alicloud_security_group'],
        ['network_acl','nacl-new','alicloud_network_acl'], ['eni','eni-new','alicloud_network_interface'], ['nat_gateway','ngw-new','alicloud_nat_gateway'],
        ['eip','eip-new','alicloud_eip_address'], ['route_table','vtb-new','alicloud_route_table'],
        ['snat_entry','stb-new:snat-new','alicloud_snat_entry'], ['dnat_entry','ftb-new:fwd-new','alicloud_forward_entry']]
      : [['vpc','vpc-new','tencentcloud_vpc'], ['vswitch','subnet-new','tencentcloud_subnet'], ['security_group','sg-new','tencentcloud_security_group'],
        ['network_acl','acl-new','tencentcloud_vpc_acl'], ['eni','eni-new','tencentcloud_eni'], ['nat_gateway','nat-new','tencentcloud_nat_gateway'],
        ['eip','eip-new','tencentcloud_eip'], ['route_table','rtb-new','tencentcloud_route_table'],
        ['snat_entry','nat-new#subnet-new','tencentcloud_nat_gateway_snat'], ['dnat_entry','TCP://vpc-new:nat-new@203.0.113.1:3389','tencentcloud_dnat']];
    let source: any;
    await runInCloudWorkspace(f.scope, async () => {
      source = await f.job('update', 'update');
      await f.log(source.id, 'range_resource_creation_receipt', entities.map(([type,id,providerResourceType]) => ({ type,id,providerResourceType,
        logicalKey: type, address: `module.range.${providerResourceType}.nodes["${type}"]` })));
    });
    const [inventory] = await f.read();
    expect(inventory.proven).toEqual(new Set(entities.map(([type,id]) => `${type}:${id}`)));
    expect([...inventory.birthSources.values()].every(id => id === source.id)).toBe(true);
  });
  it('does not authorize a destroy retry even when it carries a creation-shaped receipt', async () => {
    const f = await fixture();
    await runInCloudWorkspace(f.scope, async () => {
      const retry = await f.job('retry', 'destroy'); await f.log(retry.id, 'range_resource_creation_receipt', [f.receipt]);
      await f.log(retry.id, 'range_resource_inventory', f.observation);
    });
    expect((await f.read())[0].proven.size).toBe(0);
  });
  it('does not adopt a disk from a later observing job through an earlier host creation receipt', async () => {
    const f = await fixture();
    await runInCloudWorkspace(f.scope, async () => {
      const creating = await f.job('update', 'update'); await f.log(creating.id, 'range_resource_creation_receipt', [f.receipt]);
      const observing = await f.job('update', 'update'); await f.log(observing.id, 'range_resource_inventory', f.observation);
    });
    expect((await f.read())[0].proven).toEqual(new Set([`ecs:${f.ids.new}`]));
  });
  it.each(['account', 'workspace', 'job', 'owner', 'type', 'address', 'update_action', 'association'])('rejects %s receipt and cannot derive a disk through it', async mismatch => {
    const f = await fixture();
    await runInCloudWorkspace(f.scope, async () => {
      const update = await f.job('update', 'update'); await f.log(update.id, 'range_resource_inventory', f.observation);
      const resource: any = { ...f.receipt }, override: any = {};
      if (mismatch === 'account') override.executionContext = { ...f.context, cloudAccountUid: 'foreign' };
      if (mismatch === 'workspace') override.cloudWorkspaceId = 'foreign';
      if (mismatch === 'job') override.sourceJobId = 'foreign';
      if (mismatch === 'owner') override.ownerUserId = 'foreign';
      if (mismatch === 'type') resource.type = 'security_group';
      if (mismatch === 'address') resource.address = 'module.foreign.alicloud_instance.hosts["new"]';
      if (mismatch === 'update_action') resource.action = 'update';
      if (mismatch === 'association') Object.assign(resource, { type: 'security_group', id: 'sg-old', providerResourceType: 'alicloud_security_group_rule', address: 'module.range.alicloud_security_group_rule.rules["new"]' });
      await f.log(update.id, 'range_resource_creation_receipt', [resource], override);
    });
    expect((await f.read())[0].proven.size).toBe(0);
  });
  it.each(['tag_proof', 'wrong_host', 'wrong_key', 'incomplete'])('does not adopt an observed system disk with %s', async mismatch => {
    const f = await fixture();
    await runInCloudWorkspace(f.scope, async () => {
      const update = await f.job('update', 'update'), stock: any = structuredClone(f.observation);
      if (mismatch === 'tag_proof') stock.diskOwnershipProofs[f.ids.newDisk].method = 'tags';
      if (mismatch === 'wrong_host') stock.diskOwnershipProofs[f.ids.newDisk].instanceId = f.ids.old;
      if (mismatch === 'wrong_key') stock.systemDiskIds = { wrong: f.ids.newDisk };
      if (mismatch === 'incomplete') stock.diskInventoryHostIds = {};
      await f.log(update.id, 'range_resource_creation_receipt', [f.receipt]); await f.log(update.id, 'range_resource_inventory', stock);
    });
    expect((await f.read())[0].proven).toEqual(new Set([`ecs:${f.ids.new}`]));
  });
  it('requires an actual single receipt for an unspecified single retry and never grants observed network IDs', async () => {
    const f = await fixture('alibaba_cloud', true);
    await runInCloudWorkspace(f.scope, async () => {
      const retry = await f.job('retry'); await f.log(retry.id, 'range_resource_inventory', { ...f.observation, vpcId: 'vpc-shared' });
      expect((await f.read())[0].proven.size).toBe(0);
      await f.log(retry.id, 'single_instance_creation_receipt', { hostIds: { new: f.ids.new }, vpcId: 'vpc-shared' });
    });
    expect((await f.read())[0].proven).toEqual(new Set([`ecs:${f.ids.new}`, `disk:${f.ids.newDisk}`]));
  });
  it('does not bill or confirm deletion from a destroy retry while still inspecting its known IDs', async () => {
    const f = await fixture();
    await runInCloudWorkspace(f.scope, async () => { const retry = await f.job('retry', 'destroy'); await f.log(retry.id, 'range_resource_inventory', f.observation); });
    const store = createMemoryResourcePatrolRepository(f.repository, { managerUserId: 'manager', managerUsername: 'manager', ...f.scope, cloudAccountContextId: f.context.cloudAccountContextId });
    const account = { provider: f.scope.provider, accountUid: f.scope.accountUid, accountUidResolved: true, cloudAccountContextId: f.context.cloudAccountContextId,
      defaultRegion: f.context.regionId, defaultZoneId: f.context.zoneId, accessKeyId: 'fixture', accessKeySecret: 'fixture' };
    const config = { runInWorkspace: (_id: string, fn: () => Promise<any>) => runInCloudWorkspace(f.scope, fn), getExecutionAccountContext: async () => account };
    const cloud = { verifyAccount: jest.fn(), inspect: jest.fn(async (_account: unknown, _known: unknown) => [{ type: 'ecs', id: f.ids.new, parentId: null, attachedInstanceId: null, systemDisk: false, tags: {}, raw: {} }]) };
    const service = new ResourceAlertsService(f.repository, config as any, store, cloud as any);
    await service.scanCurrent();
    expect(cloud.inspect.mock.calls[0][1]).toEqual(expect.arrayContaining([{ type: 'ecs', id: f.ids.new }]));
    expect(store.alerts[0].status).toBe('unverified');
    await runInCloudWorkspace(f.scope, async () => {
      expect((await service.preview({ id: 'manager', isPlatformManager: true } as any, store.alerts[0].id)).reclaimable).toBe(false);
      expect(await f.repository.listBillingLedgerResources()).toEqual([]);
    });
  });
});
