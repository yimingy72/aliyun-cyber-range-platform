import { SingleInstancesService } from '../src/admin/single-instances.service';
import { SingleInstanceBatchExecutionService } from '../src/admin/single-instance-batch-execution.service';
import { ProvisioningWorkerService } from '../src/provisioning/provisioning-worker.service';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';
import { useFastSingleInstanceVerification } from './support/fast-single-instance-verification';

const owner = { id: 'alice', username: 'Alice', role: 'user' as const };
const account = { provider: 'alibaba_cloud' as const, cloudAccountContextId: 'source-context', accountUid: 'source-account',
  accountUidResolved: true, defaultRegion: 'cn-hangzhou', defaultZoneId: 'cn-hangzhou-h', accessKeyId: 'fixture', accessKeySecret: 'fixture' };

async function fixture() {
  const repo = createMemoryAdminRepository();
  const profile = await repo.upsertSingleInstanceNetworkProfile({ provider: 'alibaba_cloud', cloudAccountUid: account.accountUid,
    cloudAccountContextId: account.cloudAccountContextId, regionId: account.defaultRegion, zoneId: account.defaultZoneId,
    vpcId: 'vpc-recovery', vpcCidr: '10.99.0.0/16', vswitchIds: ['vsw-recovery'], vswitchCidrs: ['10.99.1.0/24'],
    securityGroupId: 'sg-recovery', securityGroupName: 'recovery' });
  const instance = await repo.createRangeInstance({ name: 'native-recovery', ownerUserId: owner.id, createdBy: owner.id,
    instanceMode: 'single', status: 'pending_create', expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    runtimeCredentials: { entry: { username: 'root', password: 'Synthetic123!' } }, singleInstanceConfig: {
      executionBackend: 'ecs-native', baseName: 'native-recovery', quantityIndex: 1, hostKey: 'entry', hostName: 'recovery',
      platformImageAssetId: 'fixture-image', imageId: 'm-fixture', imageDisplayName: 'Fixture', cpu: 2, memory: 4, systemDiskSize: 40,
      cloudAccountUid: account.accountUid, cloudAccountContextId: account.cloudAccountContextId,
      regionId: account.defaultRegion, zoneId: account.defaultZoneId, networkProfileId: profile.id,
      assignedVswitchId: profile.vswitchIds[0], resolvedInstanceType: 'ecs.fixture',
    } });
  const job = await repo.createProvisionJob({ rangeInstanceId: instance.id, jobType: 'create', triggeredBy: owner.id });
  await repo.updateRangeInstance(instance.id, { lastJobId: job.id, singleInstanceConfig: { ...instance.singleInstanceConfig!, nativeCreateJobId: job.id } });
  const config: any = { getSnapshot: jest.fn(async () => account), getAccountContext: jest.fn(async () => account),
    getAccountContextById: jest.fn(async () => account),
    getInstanceTypeAvailabilityInContext: jest.fn(async () => ({ exactAvailable: true, matches: [{ instanceTypeId: 'ecs.fixture' }], warning: null })) };
  const native = new SingleInstanceBatchExecutionService(repo, config);
  const tags = { CreatedBy: 'cyber-range-platform', PlatformScope: 'user', PlatformUserId: owner.id, RangeInstanceId: instance.id };
  const cloud = new Set(['i-original-accepted']);
  const rpc = jest.spyOn(native as any, 'performAliyunRpcRequest').mockImplementation(async (input: any) => {
    const p = input.parameters;
    const metadata = { RequestId: 'fixture-request', PageNumber: Number(p.PageNumber ?? 1), PageSize: Number(p.PageSize ?? 100) };
    if (input.action === 'RunInstances') { cloud.add('i-retry-created'); return { InstanceIdSets: { InstanceIdSet: ['i-retry-created'] } }; }
    if (input.action === 'DescribeInstances') {
      const ids = p.InstanceIds ? JSON.parse(p.InstanceIds) : [...cloud];
      const rows = [...cloud].filter(id => ids.includes(id)).map(InstanceId => ({ InstanceId, Status: 'Running',
        Tags: { Tag: Object.entries(tags).map(([TagKey, TagValue]) => ({ TagKey, TagValue })) },
        PublicIpAddress: { IpAddress: ['192.0.2.10'] }, VpcAttributes: { PrivateIpAddress: { IpAddress: ['10.99.1.10'] } } }));
      return { ...metadata, TotalCount: rows.length, Instances: { Instance: rows } };
    }
    if (input.action === 'DescribeDisks') {
      const ids = p.DiskIds ? JSON.parse(p.DiskIds) : null;
      const rows = [...cloud].filter(id => p.InstanceId ? id === p.InstanceId : ids?.includes(`d-${id}`)).map(InstanceId => ({
        DiskId: `d-${InstanceId}`, InstanceId, Type: 'system', DeleteWithInstance: true,
        Tags: { Tag: Object.entries(tags).map(([TagKey, TagValue]) => ({ TagKey, TagValue })) },
      }));
      return { ...metadata, TotalCount: rows.length, Disks: { Disk: rows } };
    }
    if (input.action === 'DeleteInstances') {
      for (const [key, id] of Object.entries(p)) if (key.startsWith('InstanceId.')) cloud.delete(id as string);
      return { RequestId: 'deleted' };
    }
    if (input.action === 'TagResources') return { RequestId: 'tagged' };
    throw new Error(`Unexpected fixture RPC: ${input.action}`);
  });
  const worker = new ProvisioningWorkerService(repo, {} as any, config, native);
  const service = new SingleInstancesService(repo, config, {} as any, native, worker, {} as any);
  return { repo, instance, job, config, native, cloud, rpc, worker, service };
}

useFastSingleInstanceVerification();

describe('native create intent recovery', () => {
  it('retains unknown acceptance through cleanup retries without adopting tags or creating another ECS', async () => {
    const f = await fixture();
    jest.spyOn(f.repo, 'getSingleInstanceNetworkProfileById').mockRejectedValueOnce(new Error('Temporary profile lookup outage'));
    await f.worker.process(f.job.id);
    const failed = (await f.repo.getRangeInstanceById(f.instance.id))!;
    expect(failed.status).toBe('destroy_failed');
    expect(failed.singleInstanceConfig?.nativeCreateJobId).toBe(f.job.id);
    const retry = await f.service.retry(f.instance.id, owner);
    expect(retry.topologySnapshot?.operation).toBe('destroy');
    await f.worker.process(retry.id);
    expect((await f.repo.getRangeInstanceById(f.instance.id))?.status).toBe('destroy_failed');
    expect(f.cloud.size).toBe(1);
    expect(f.rpc.mock.calls.some(([input]: any[]) => input.action === 'DeleteInstances')).toBe(false);
    expect(f.rpc.mock.calls.some(([input]: any[]) => input.action === 'RunInstances')).toBe(false);
  });

  it('recovers a legacy create retry using the original request identity instead of a new job token or new specification lookup', async () => {
    const f = await fixture();
    await f.repo.updateProvisionJob(f.job.id, { status: 'failed', startedAt: new Date(), finishedAt: new Date() });
    await f.repo.updateRangeInstance(f.instance.id, { status: 'create_failed', resourceSummary: { mode: 'ecs-native', hostIds: { entry: 'i-original-accepted' } } });
    f.config.getInstanceTypeAvailabilityInContext.mockRejectedValue(new Error('Specification service unavailable'));
    const retry = await f.service.retry(f.instance.id, owner);
    await f.worker.process(retry.id);
    expect(f.config.getInstanceTypeAvailabilityInContext).not.toHaveBeenCalled();
    expect(f.rpc.mock.calls.some(([input]: any[]) => input.action === 'RunInstances')).toBe(false);
    expect(f.cloud).toEqual(new Set(['i-original-accepted']));
    const recovered = (await f.repo.getRangeInstanceById(f.instance.id))!;
    expect(recovered.singleInstanceConfig?.nativeCreateJobId).toBe(f.job.id);
    expect(recovered.resourceSummary?.hostIds).toEqual({ entry: 'i-original-accepted' });
    expect((await f.repo.getProvisionJobById(retry.id))?.status).toBe('succeeded');
  });

  it('allows a new creation only after the previous attempt has a verified complete cleanup', async () => {
    const f = await fixture();
    await f.repo.updateRangeInstance(f.instance.id, { resourceSummary: { mode: 'ecs-native', hostIds: { entry: 'i-original-accepted' } } });
    jest.spyOn(f.native as any, 'waitForSystemDisks').mockRejectedValueOnce(new Error('Temporary disk lookup failure'));
    await f.worker.process(f.job.id);
    const failed = (await f.repo.getRangeInstanceById(f.instance.id))!;
    expect(failed.status).toBe('create_failed');
    expect(failed.singleInstanceConfig?.nativeCreateJobId).toBeUndefined();
    expect(f.cloud.size).toBe(0);
    const retry = await f.service.retry(f.instance.id, owner);
    await f.worker.process(retry.id);
    expect(f.rpc.mock.calls.filter(([input]: any[]) => input.action === 'RunInstances')).toHaveLength(1);
    expect(f.cloud).toEqual(new Set(['i-retry-created']));
  });
  it('never deletes an additional native ECS carrying copied tags during confirmed cleanup', async () => {
    const f = await fixture();
    await f.repo.updateProvisionJob(f.job.id, { status: 'failed', startedAt: new Date(), finishedAt: new Date() });
    await f.repo.updateRangeInstance(f.instance.id, { status: 'destroy_failed', resourceSummary: { mode: 'ecs-native', hostIds: { entry: 'i-original-accepted' } } });
    f.cloud.add('i-copied-tags');
    const retry = await f.service.retry(f.instance.id, owner); await f.worker.process(retry.id);
    expect((await f.repo.getRangeInstanceById(f.instance.id))?.status).toBe('destroy_failed');
    expect(f.rpc.mock.calls.some(([input]: any[]) => input.action === 'DeleteInstances')).toBe(false);
    expect(f.cloud).toEqual(new Set(['i-original-accepted', 'i-copied-tags']));
    expect((await f.repo.listBillingLedgerResources()).some(row => row.cloudResourceId === 'i-copied-tags')).toBe(false);
  });
});
