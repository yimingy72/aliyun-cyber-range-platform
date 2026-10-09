import { markQueuedInstancesAsLegacyNative, pumpLegacySingleInstanceWorker } from './support/legacy-single-instance-worker';
import { useFastSingleInstanceVerification } from './support/fast-single-instance-verification';
import { SingleInstancesService } from '../src/admin/single-instances.service';
import { SingleInstanceBatchExecutionService } from '../src/admin/single-instance-batch-execution.service';
import { CidrPoolService } from '../src/provisioning/cidr-pool.service';
import { SingleInstanceNetworkService } from '../src/admin/single-instance-network.service';
import { ProvisioningWorkerService } from '../src/provisioning/provisioning-worker.service';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';
const alice = { id: 'alice', username: 'Alice', role: 'user' as const };
const bob = { id: 'bob', username: 'Bob', role: 'user' as const };
const admin = { id: 'admin', username: 'Admin', role: 'admin' as const };
const account = { provider: 'alibaba_cloud' as const, cloudAccountContextId: 'account-context', accountUid: 'account-1', accountUidResolved: true, defaultRegion: 'cn-hangzhou', defaultZoneId: 'cn-hangzhou-h', accessKeyId: 'synthetic-ak', accessKeySecret: 'synthetic-sk', imageImportBucket: '' };
async function fixture(failDiskForOwner?: string) {
  const repo = createMemoryAdminRepository();
  await repo.upsertImageSnapshots({ provider: 'alibaba_cloud', accountUid: account.accountUid, regionId: account.defaultRegion, scope: 'custom', snapshots: [{ imageId: 'm-test', sourceImageName: 'Ubuntu', status: 'Available', isAvailable: true, lastSyncedAt: new Date() }] });
  const [snapshot] = await repo.listImageSnapshots({ provider: 'alibaba_cloud', accountUid: account.accountUid, regionId: account.defaultRegion, scope: 'custom' });
  const asset = await repo.collectPlatformImageAsset({ snapshotId: snapshot.id, displayName: 'Ubuntu', visibility: 'platform' });
  const profile = await repo.upsertSingleInstanceNetworkProfile({ provider: 'alibaba_cloud', cloudAccountUid: account.accountUid, cloudAccountContextId: account.cloudAccountContextId, regionId: account.defaultRegion, zoneId: account.defaultZoneId, workspaceKey: 'single-instance-network-account-1-cn-hangzhou-cn-hangzhou-h', createdByUserId:alice.id,managedByPlatform: true, vpcId: 'vpc-test', vpcCidr: '10.99.0.0/16', vswitchIds: ['vsw-1', 'vsw-2', 'vsw-3'], vswitchCidrs: ['10.99.1.0/24', '10.99.2.0/24', '10.99.3.0/24'], securityGroupId: 'sg-test', securityGroupName: 'test' });
  const config: any = { getSnapshot: jest.fn(async () => account), getAccountContext: jest.fn(async () => account), getAccountContextById: jest.fn(async () => account), getInstanceTypeAvailabilityInContext: jest.fn(async () => ({ exactAvailable: true, matches: [{ instanceTypeId: 'ecs.u1-c1m1.large' }], warning: null })) };
  const native: any = new SingleInstanceBatchExecutionService(repo, config);
  const cloud = new Map<string, any>();
  const calls: any[] = [];
  const tokens = new Map<string, {
    id: string;
    parameters: any;
  }>();
  let count = 0;
  let failed = false;
  native.performAliyunRpcRequest = async (input: any) => {
    calls.push({ action: input.action, regionId: input.regionId, parameters: input.parameters });
    expect(input.regionId).toBe(account.defaultRegion);
    const p = input.parameters ?? {};
    if (input.action === 'RunInstances') {
      expect(p.InstanceType).toBe('ecs.u1-c1m1.large');
      expect(p.PrivateIpAddress).toBeUndefined();
      const previous = tokens.get(p.ClientToken);
      if (previous) {
        expect(p).toEqual(previous.parameters);
        return { InstanceIdSets: { InstanceIdSet: [previous.id] } };
      }
      const tags: Object = Object.fromEntries(Object.keys(p).filter(key => /^Tag\.\d+\.Key$/.test(key)).map(key => [p[key], p[key.replace('.Key', '.Value')]]));
      const id = `i-${++count}`;
      tokens.set(p.ClientToken, { id, parameters: structuredClone(p) });
      cloud.set(id, { id, tags, privateIp: `10.99.1.${count + 10}`, publicIp: `192.0.2.${count}`, diskId: `d-${count}` });
      return { InstanceIdSets: { InstanceIdSet: [id] } };
    }
    if (input.action === 'DescribeInstances') {
      const ids = p.InstanceIds ? JSON.parse(p.InstanceIds) : null;
      const rows = [...cloud.values()].filter(entry => ids ? ids.includes(entry.id) : p['Tag.1.Value'] ? (entry.tags as any).RangeInstanceId === p['Tag.1.Value'] : true);
      return { RequestId: 'test', TotalCount: rows.length, PageNumber:Number(p.PageNumber??1),PageSize:Number(p.PageSize??100), Instances: { Instance: rows.map(entry => ({ InstanceId: entry.id, Tags:{Tag:Object.entries(entry.tags).map(([TagKey,TagValue])=>({TagKey,TagValue}))},Status: 'Running', PublicIpAddress: { IpAddress: [entry.publicIp] }, VpcAttributes: { PrivateIpAddress: { IpAddress: [entry.privateIp] } } })) } };
    }
    if (input.action === 'DescribeDisks') {
      const entry = cloud.get(p.InstanceId);
      if (!failed && entry?.tags.PlatformUserId === failDiskForOwner) {
        failed = true;
        const records = await repo.listRangeInstances();
        expect(records.find(instance => instance.id === entry.tags.RangeInstanceId)?.resourceSummary?.hostIds).toBeTruthy();
        throw new Error('Synthetic disk lookup failure');
      }
      const requested = p.DiskIds ? JSON.parse(p.DiskIds) : null;
      const rows = requested ? [...cloud.values()].filter(value => requested.includes(value.diskId)) : entry ? [entry] : [];
      return { RequestId: 'disks', PageNumber: 1, PageSize: 100, TotalCount: rows.length, Disks: { Disk: rows.map(value => ({
        DiskId: value.diskId, InstanceId: value.id, Type: 'system', DeleteWithInstance: true, Tags: { Tag: Object.entries(value.tags).map(([TagKey,TagValue]) => ({ TagKey,TagValue })) } })) } };
    }
    if (input.action === 'DeleteInstances') {
      for (const [key, value] of Object.entries(p))
        if (key.startsWith('InstanceId.'))
          cloud.delete(value as string);
      return { RequestId: 'deleted' };
    }
    return { RequestId: 'ok' };
  };
  const network = new SingleInstanceNetworkService(repo, config, { destroyDefaultProfile: jest.fn(async () => { }) } as any, new CidrPoolService(), native);
  const launchNetwork: any = { ensureDefaultProfile: async () => profile, allocateVswitch: network.allocateVswitch.bind(network) };
  const worker: any = new ProvisioningWorkerService(repo, { create: async () => { }, destroy: async () => { } } as any, config, native, { reconcile: async () => { } } as any);
  worker.dispatch = jest.fn();
  const service = new SingleInstancesService(repo, config, launchNetwork, native, worker, {} as any);
  await network.registerCleanup(profile.id,'synthetic-run','2020-01-01T00:00:00Z',[alice.id,bob.id],admin);
  const launch = async (actor: typeof alice) => {
    const result = await service.launch({ name: actor.username, platformImageAssetId: asset.id, cpu: 2, memory: 2, quantity: 2, expiresAt: new Date(Date.now() + 60 * 60000).toISOString() }, actor.id);
    await markQueuedInstancesAsLegacyNative(repo, result.instances.map(instance => instance.id));
    return result;
  };
  const drain = () => pumpLegacySingleInstanceWorker(worker, repo);
  return { repo, config, native, cloud, calls, profile, network, service, worker, launch, drain };
}
describe('legacy native batches: real ECS response contract, two platform users and complete cleanup', () => {
  it.each([
    ['create', 'cloudAccountContextId'], ['create', 'cloudAccountUid'],
    ['destroy', 'cloudAccountContextId'], ['destroy', 'cloudAccountUid'],
  ] as const)('blocks unbound legacy %s when %s is missing and preserves cloud and billing evidence', async (operation, missing) => {
    const f = await fixture(); const a = await f.launch(alice); await f.drain();
    const original = (await f.repo.getRangeInstanceById(a.instances[0].id))!;
    const config = { ...original.singleInstanceConfig! }; delete config[missing];
    const job = await f.repo.createProvisionJob({ rangeInstanceId: original.id, jobType: operation === 'create' ? 'retry' : 'destroy', triggeredBy: alice.id });
    await f.repo.updateRangeInstance(original.id, { singleInstanceConfig: config, lastJobId: job.id, status: operation === 'create' ? 'creating' : 'destroying', errorSummary: 'Earlier failure must not hide the missing original account' });
    const instance = (await f.repo.getRangeInstanceById(original.id))!;
    const claimed = await f.repo.claimProvisionJob(job.id, new Date());
    const ledgerBefore = await f.repo.listBillingLedgerResources({ rangeInstanceId: original.id });
    f.calls.length = 0; f.config.getAccountContext.mockClear(); f.config.getSnapshot.mockClear(); f.config.getAccountContextById.mockClear();
    if (operation === 'create') await f.native.executeCreateBatch([{ instance, job: claimed }]);
    else await f.native.executeDestroyBatch([{ instance, job: claimed }]);
    const after = (await f.repo.getRangeInstanceById(original.id))!;
    expect(after.status).toBe('destroy_failed'); expect(after.errorSummary).toContain('缺少原云账号绑定');
    expect(after.resourceSummary).toEqual(original.resourceSummary);
    expect(after.runtimeCredentials).toEqual(original.runtimeCredentials);
    expect(await f.repo.listBillingLedgerResources({ rangeInstanceId: original.id })).toEqual(ledgerBefore);
    expect(f.cloud.size).toBe(2); expect(f.calls).toHaveLength(0);
    expect(f.config.getAccountContext).not.toHaveBeenCalled(); expect(f.config.getSnapshot).not.toHaveBeenCalled();
    expect(f.config.getAccountContextById).not.toHaveBeenCalled();
    await expect(f.service.retry(original.id, alice)).rejects.toThrow('缺少原云账号绑定');
    await expect(f.native.findCloudInstanceIdsByRangeInstanceId(original.id)).rejects.toThrow('缺少原云账号绑定');
  });

  it.each([{ accountUidResolved: false }, { accountUid: 'other-account' }, { cloudAccountContextId: 'other-context' }, null])('refuses unavailable, unverified or mismatched saved account context %j', async invalid => {
    const f = await fixture(); const a = await f.launch(alice); await f.drain();
    const original = (await f.repo.getRangeInstanceById(a.instances[0].id))!;
    const job = await f.repo.createProvisionJob({ rangeInstanceId: original.id, jobType: 'destroy', triggeredBy: alice.id });
    await f.repo.updateRangeInstance(original.id, { lastJobId: job.id, status: 'destroying' });
    const instance = (await f.repo.getRangeInstanceById(original.id))!;
    const claimed = await f.repo.claimProvisionJob(job.id, new Date());
    const ledgerBefore = await f.repo.listBillingLedgerResources({ rangeInstanceId: original.id });
    if (invalid) f.config.getAccountContextById.mockResolvedValue({ ...account, ...invalid });
    else f.config.getAccountContextById.mockRejectedValue(new Error('Saved cloud account context is unavailable'));
    f.calls.length = 0;
    await f.native.executeDestroyBatch([{ instance, job: claimed }]);
    expect((await f.repo.getRangeInstanceById(original.id))?.status).toBe('destroy_failed');
    expect((await f.repo.getRangeInstanceById(original.id))?.errorSummary).toContain('原云账号');
    expect(await f.repo.listBillingLedgerResources({ rangeInstanceId: original.id })).toEqual(ledgerBefore);
    expect(f.cloud.size).toBe(2); expect(f.calls).toHaveLength(0);
  });

  it('runs Alice/Bob simultaneously with distinct IPs, ownership, batch tags and credentials; fixed context survives default changes', async () => {
    const f = await fixture();
    const [a, b] = await Promise.all([f.launch(alice), f.launch(bob)]);
    expect(a.instances.map(instance => instance.runtimeCredentials)).not.toEqual(b.instances.map(instance => instance.runtimeCredentials));
    expect(new Set([...a.instances, ...b.instances].map(instance => (instance.runtimeScenarioTemplateSpec as any).hosts[0].primaryPrivateIp)).size).toBe(4);
    await expect(f.service.destroyBatch(a.batch.id, alice)).rejects.toThrow('仍在创建');
    f.config.getAccountContext.mockResolvedValue({ ...account, defaultRegion: 'cn-shanghai' });
    f.config.getSnapshot.mockResolvedValue({ ...account, defaultRegion: 'cn-shanghai' });
    await f.drain();
    const instances = await f.repo.listRangeInstances();
    expect(instances.every(instance => instance.status === 'running')).toBe(true);
    expect(new Set(instances.map(instance => instance.accessEntry?.privateIp)).size).toBe(4);
    expect(f.cloud.size).toBe(4);
    expect(f.calls.filter(call => call.action === 'RunInstances')).toHaveLength(4);
    expect((await f.service.list(alice)).batches.map(entry => entry.batch.id)).toEqual([a.batch.id]);
    await expect(f.service.destroyBatch(a.batch.id, bob)).rejects.toThrow('access denied');
    await expect(f.network.destroy(f.profile.id, alice,'synthetic-run')).rejects.toThrow('administrators');
    await expect(f.network.destroy(f.profile.id, admin,'synthetic-run')).rejects.toThrow('referenced');
    await Promise.all([f.service.destroyBatch(a.batch.id, alice), f.service.destroyBatch(a.batch.id, alice)]);
    await f.drain();
    expect(f.cloud.size).toBe(2);
    await expect(f.network.destroy(f.profile.id, admin,'synthetic-run')).rejects.toThrow('referenced');
    await f.service.destroyBatch(b.batch.id, bob);
    expect((await f.repo.listProvisionJobs()).filter(job => job.jobType === 'destroy')).toHaveLength(4);
    await f.drain();
    expect(f.cloud.size).toBe(0);
    expect((await f.repo.listRangeInstances()).map(instance => ({ status: instance.status, error: instance.errorSummary }))).toEqual(Array.from({length:4}, () => ({status:'destroyed',error:null})));
    await f.network.destroy(f.profile.id, admin,'synthetic-run');
    expect(await f.repo.getSingleInstanceNetworkProfileById(f.profile.id)).toBeNull();
  });
  it('saves returned ECS IDs before disk failure, cleans only that member, then keeps the other user running', async () => {
    const f = await fixture(alice.id);
    await Promise.all([f.launch(alice), f.launch(bob)]);
    await f.drain();
    const instances = await f.repo.listRangeInstances();
    expect(instances.filter(instance => instance.ownerUserId === bob.id).every(instance => instance.status === 'running')).toBe(true);
    expect(instances.filter(instance => instance.status === 'create_failed')).toHaveLength(1);
    expect(f.cloud.size).toBe(3);
    const failed = instances.find(instance => instance.status === 'create_failed')!;
    expect(failed.resourceSummary).toBeNull();
    expect([...f.cloud.values()].some(value => value.tags.RangeInstanceId === failed.id)).toBe(false);
  });
  it('fences an old refresh claim after destruction and never revives the member', async () => {
    const f = await fixture();
    const a = await f.launch(alice);
    await f.drain();
    const instance = await f.repo.getRangeInstanceById(a.instances[0].id);
    const job = await f.repo.createProvisionJob({ rangeInstanceId: instance!.id, jobType: 'refresh_status', triggeredBy: alice.id });
    await f.repo.updateRangeInstance(instance!.id, { lastJobId: job.id });
    const claimed = await f.repo.claimProvisionJob(job.id, new Date());
    await f.repo.updateRangeInstance(instance!.id, { status: 'destroyed', lastJobId: null });
    await f.native.refreshSingleInstanceAccessEntry({ instance, job: claimed });
    expect((await f.repo.getRangeInstanceById(instance!.id))?.status).toBe('destroyed');
  });
  it('recovers a reclaimed create by its frozen identity without replaying the old cloud request', async () => {
    const f = await fixture();
    const a = await f.launch(alice);
    const instance = a.instances[0];
    const job = await f.repo.getProvisionJobById(instance.lastJobId!);
    const claimed = await f.repo.claimProvisionJob(job!.id, new Date());
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>(resolve => release = resolve);
    const ready = new Promise<void>(resolve => reached = resolve);
    const base = f.native.performAliyunRpcRequest;
    let pause = true;
    f.native.performAliyunRpcRequest = async (input: any) => { const result = await base(input); if (input.action === 'RunInstances' && pause) {
      pause = false;
      reached();
      await gate;
    } return result; };
    const old = f.native.executeCreateBatch([{ instance, job: claimed }]);
    await ready;
    await f.repo.requeueInterruptedProvisionJobs(new Date(Date.now() + 1000));
    const reclaimed = await f.repo.claimProvisionJob(job!.id, new Date(Date.now() + 2000));
    release();
    await old;
    expect(f.cloud.size).toBe(1);
    expect(f.calls.some(call => call.action === 'DeleteInstances')).toBe(false);
    f.config.getInstanceTypeAvailabilityInContext.mockResolvedValue({exactAvailable:true,matches:[{instanceTypeId:'ecs.e-c1m1.large'}],warning:null});
    await f.native.executeCreateBatch([{ instance:await f.repo.getRangeInstanceById(instance.id), job: reclaimed }]);
    expect(f.cloud.size).toBe(1);
    expect(f.calls.filter(call => call.action === 'RunInstances')).toHaveLength(1);
    expect((await f.repo.getProvisionJobById(job!.id))?.status).toBe('succeeded');
  });
  it('recovers a late tagged ECS after an unknown create response instead of treating the first empty query as cleanup proof',async()=>{
    const f=await fixture();const a=await f.launch(alice);const instance=a.instances[0];const job=await f.repo.claimProvisionJob(instance.lastJobId!,new Date());
    const base=f.native.performAliyunRpcRequest;let missing=true;let firstTag=true;
    f.native.performAliyunRpcRequest=async(input:any)=>{
      if(input.action==='RunInstances'&&missing){missing=false;await base(input);throw new Error('Synthetic response lost after cloud creation');}
      if(input.action==='DescribeInstances'&&input.parameters?.['Tag.1.Value']&&firstTag){firstTag=false;return{RequestId:'empty',TotalCount:0,PageNumber:1,PageSize:100,Instances:{Instance:[]}};}
      return base(input);
    };
    await f.native.executeCreateBatch([{instance,job}]);
    expect((await f.repo.getRangeInstanceById(instance.id))?.errorSummary).not.toMatch(/unverified|malformed|incomplete/);
    expect(f.cloud.size).toBe(0);expect(f.calls.some(call=>call.action==='DeleteInstances')).toBe(true);
    expect((await f.repo.getRangeInstanceById(instance.id))?.status).toBe('create_failed');
  });
  it('retains an unknown accepted request when the tagged resource stays invisible throughout cleanup', async () => {
    const f = await fixture(); const a = await f.launch(alice); const instance = a.instances[0];
    const job = await f.repo.claimProvisionJob(instance.lastJobId!, new Date());
    const base = f.native.performAliyunRpcRequest;
    f.native.performAliyunRpcRequest = async (input: any) => {
      if (input.action === 'RunInstances') { await base(input); throw new Error('accepted response lost'); }
      if (input.action === 'DescribeInstances') return { RequestId: 'empty', TotalCount: 0, PageNumber: 1, PageSize: 100, Instances: { Instance: [] } };
      return base(input);
    };
    await f.native.executeCreateBatch([{ instance, job }]);
    expect((await f.repo.getRangeInstanceById(instance.id))?.status).toBe('destroy_failed');
    expect(f.cloud.size).toBe(1);
    expect(f.calls.filter(call => call.action === 'RunInstances')).toHaveLength(1);
    expect(f.calls.some(call => call.action === 'DeleteInstances')).toBe(false);
  });

  it('does not accept NotFound deletion for a returned ID whose creation was never observed', async () => {
    const f = await fixture(); const a = await f.launch(alice); const instance = a.instances[0];
    await f.repo.updateRangeInstance(instance.id, { status: 'destroy_failed',
      singleInstanceConfig: { ...instance.singleInstanceConfig!, executionBackend: 'ecs-native', nativeCreateJobId: instance.lastJobId! },
      resourceSummary: { mode: 'ecs-native', hostIds: { [instance.singleInstanceConfig!.hostKey]: 'i-accepted-not-yet-visible' } } });
    await f.repo.updateProvisionJob(instance.lastJobId!, { status: 'failed', finishedAt: new Date() });
    const base = f.native.performAliyunRpcRequest;
    f.native.performAliyunRpcRequest = async (input: any) => {
      if (input.action === 'DeleteInstances') throw new Error('InvalidInstanceId.NotFound');
      return base(input);
    };
    await f.service.destroy(instance.id, alice); await f.drain();
    expect((await f.repo.getRangeInstanceById(instance.id))?.status).toBe('destroy_failed');
    expect((await f.repo.getRangeInstanceById(instance.id))?.resourceSummary?.hostIds).toEqual({ [instance.singleInstanceConfig!.hostKey]: 'i-accepted-not-yet-visible' });
    expect((await f.repo.listBillingLedgerResources({ rangeInstanceId: instance.id })).every(row => row.releasedAt === null)).toBe(true);
  });

  it('does not replay a stale native request even when its idempotency token would have expired', async () => {
    const f = await fixture(); const a = await f.launch(alice); const instance = a.instances[0];
    await f.repo.updateRangeInstance(instance.id, { singleInstanceConfig: { ...instance.singleInstanceConfig!, executionBackend: 'ecs-native', nativeCreateJobId: instance.lastJobId! } });
    const current = await f.repo.getRangeInstanceById(instance.id);
    const job = await f.repo.claimProvisionJob(instance.lastJobId!, new Date());
    await f.native.executeCreateBatch([{ instance: current, job }]);
    expect(f.calls.some(call => call.action === 'RunInstances')).toBe(false);
    expect((await f.repo.getRangeInstanceById(instance.id))?.status).toBe('destroy_failed');
  });

  it('blocks deletion when tag search returns an ECS owned by another platform user', async () => {
    const f = await fixture(); const a = await f.launch(alice); await f.drain();
    for (const resource of f.cloud.values()) resource.tags.PlatformUserId = 'bob';
    await f.service.destroyBatch(a.batch.id, alice); await f.drain();
    expect((await f.repo.listRangeInstances()).every(instance => instance.status === 'destroy_failed')).toBe(true);
    expect(f.cloud.size).toBe(2); expect(f.calls.some(call => call.action === 'DeleteInstances')).toBe(false);
  });

  it('records failed-created cloud resources before cleanup and closes their billing only after deletion', async () => {
    const f = await fixture(alice.id); await f.launch(alice); await f.drain();
    const failed = (await f.repo.listRangeInstances()).find(instance => instance.status === 'create_failed')!;
    const rows = await f.repo.listBillingLedgerResources({ rangeInstanceId: failed.id });
    expect(rows.some(row => row.cloudResourceType === 'ecs')).toBe(true);
    expect(rows.every(row => row.releasedAt !== null && Number.isFinite(new Date(row.releasedAt).getTime()))).toBe(true);
  });

  it('keeps a native destruction retryable when the billing release write fails', async () => {
    const f = await fixture(); const a = await f.launch(alice); await f.drain();
    const update = f.repo.updateBillingLedgerResource.bind(f.repo);
    let failRelease = true;
    f.repo.updateBillingLedgerResource = async (id, patch) => {
      if (patch.releasedAt && failRelease) { failRelease = false; throw new Error('synthetic billing write failure'); }
      return update(id, patch);
    };
    await f.service.destroy(a.instances[0].id, alice); await f.drain();
    expect((await f.repo.getRangeInstanceById(a.instances[0].id))?.status).toBe('destroy_failed');
    await f.service.destroy(a.instances[0].id, alice); await f.drain();
    expect(await f.repo.getRangeInstanceById(a.instances[0].id)).toMatchObject({status:'destroyed',errorSummary:null});
    const rows = await f.repo.listBillingLedgerResources({ rangeInstanceId: a.instances[0].id });
    expect(rows.every(row => row.releasedAt !== null)).toBe(true);
  });

  it('stops native deletion retries as soon as another job supersedes the claim', async () => {
    const f = await fixture(); const a = await f.launch(alice); await f.drain();
    await f.service.destroy(a.instances[0].id, alice);
    const instance = (await f.repo.getRangeInstanceById(a.instances[0].id))!;
    const job = await f.repo.claimProvisionJob(instance.lastJobId!, new Date());
    const base = f.native.performAliyunRpcRequest; let deletes = 0;
    f.native.performAliyunRpcRequest = async (input: any) => {
      if (input.action === 'DeleteInstances') {
        deletes++;
        await f.repo.updateRangeInstance(instance.id, { lastJobId: 'newer-job' });
        throw new Error('IncorrectInstanceStatus.Initializing');
      }
      return base(input);
    };
    await f.native.executeDestroyBatch([{ instance, job }]);
    expect(deletes).toBe(1); expect(f.cloud.size).toBe(2);
    expect((await f.repo.getRangeInstanceById(instance.id))?.lastJobId).toBe('newer-job');
  });

  it('refuses malformed empty tag responses when a known ID query is also empty', async () => {
    const f = await fixture(); const a = await f.launch(alice); await f.drain();
    const base = f.native.performAliyunRpcRequest;
    f.native.performAliyunRpcRequest = async (input: any) => {
      if (input.action === 'DescribeInstances') return input.parameters?.['Tag.1.Value']
        ? { RequestId: 'incomplete', Instances: { Instance: [] } }
        : { RequestId: 'empty', TotalCount: 0, Instances: { Instance: [] } };
      return base(input);
    };
    await f.service.destroyBatch(a.batch.id, alice); await f.drain();
    expect((await f.repo.listRangeInstances()).every(instance => instance.status === 'destroy_failed')).toBe(true);
    expect(f.cloud.size).toBe(2); expect(f.calls.some(call => call.action === 'DeleteInstances')).toBe(false);
  });
  it('blocks new launches into a profile whose destruction has been reserved',async()=>{
    const f=await fixture();await f.repo.markSingleInstanceNetworkDestroying(f.profile.id);
    await expect(f.network.ensureDefaultProfile(account,alice.id)).rejects.toThrow('cleanup is required');
  });
  it('requires the pre-registered run and declared temporary creator before any network destruction',async()=>{
    const f=await fixture();
    await expect(f.network.destroy(f.profile.id,admin,'different-run')).rejects.toThrow('pre-registered');
    await expect(f.network.registerCleanup(f.profile.id,'another-run','2020-01-01T00:00:00Z',['unrelated-owner'],admin)).rejects.toThrow('this-run');
    await expect(f.network.registerCleanup(f.profile.id,'another-run','2020-01-01T00:00:00Z',[alice.id,bob.id],bob)).rejects.toThrow('administrators');
  });
  it('returns verified real owner/batch tags without credentials and rejects malformed cloud status proofs',async()=>{
    const f=await fixture();const a=await f.launch(alice);await f.drain();
    const result=await f.service.getCloudResourceStatus(a.instances[0].id,alice);
    expect(result.matchedInstances).toEqual([expect.objectContaining({ownerUserId:alice.id,tags:expect.objectContaining({PlatformUserId:alice.id,RangeInstanceId:a.instances[0].id,SingleInstanceBatchId:a.batch.id,CreatedBy:'cyber-range-platform',PlatformScope:'user'})})]);
    expect(JSON.stringify(result)).not.toContain('password');
    f.native.performAliyunRpcRequest=async()=>({Instances:{Instance:[]},TotalCount:0});
    await expect(f.service.getCloudResourceStatus(a.instances[0].id,alice)).rejects.toThrow('incomplete or malformed');
  });
  it('does not falsely clear failed cleanup when a cloud query is malformed', async () => {
    const f = await fixture();
    const a = await f.launch(alice);
    await f.drain();
    f.native.performAliyunRpcRequest = async () => ({ RequestId: 'ambiguous' });
    await f.service.destroyBatch(a.batch.id, alice);
    await f.drain();
    expect((await f.repo.listRangeInstances()).every(instance => instance.status === 'destroy_failed')).toBe(true);
    await expect(f.network.destroy(f.profile.id, admin,'synthetic-run')).rejects.toThrow('referenced');
  });
});

useFastSingleInstanceVerification();
