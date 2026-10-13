import { ProvisioningWorkerService } from '../src/provisioning/provisioning-worker.service';
import type { SingleInstanceExecutionItem } from '../src/admin/single-instance-batch-execution.service';
import type { SingleInstanceOpenTofuBatchLease } from '../src/admin/single-instance-opentofu-execution.service';
import { SingleInstanceBatchExecutionService } from '../src/admin/single-instance-batch-execution.service';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';

const snapshot = { provider: 'alibaba_cloud', defaultRegion: 'cn-hangzhou', defaultZoneId: 'cn-hangzhou-h', accessKeyId: 'fixture', accessKeySecret: 'fixture' };
const config = { getSnapshot: async () => snapshot };
const scheduler = (worker: ProvisioningWorkerService) => worker as any;
const gate = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };

async function fixture(quantity = 2) {
  const repository = createMemoryAdminRepository();
  const batch = await repository.createSingleInstanceBatch({ name: 'queued-tofu', platformImageAssetId: 'asset', imageId: 'image', imageDisplayName: 'fixture', cpu: 2, memory: 4, systemDiskSize: 40, quantity, ownerUserId: 'owner-a' });
  const items = [];
  for (let index = 0; index < quantity; index++) {
    const instance = await repository.createRangeInstance({ name: `single-${index}`, instanceMode: 'single', status: 'pending_create', ownerUserId: 'owner-a', singleInstanceBatchId: batch.id,
      singleInstanceConfig: { executionBackend: 'opentofu', cloudAccountContextId: 'context-a', cloudAccountUid: 'uid-a', regionId: 'cn-hangzhou', zoneId: 'cn-hangzhou-h', networkProfileId: 'profile-a',
        baseName: 'single', hostName: null, quantityIndex: index + 1, hostKey: `host-${index}`, platformImageAssetId: 'asset', imageId: 'image', imageDisplayName: 'fixture', cpu: 2, memory: 4, systemDiskSize: 40 } });
    const job = await repository.createProvisionJob({ rangeInstanceId: instance.id, jobType: 'create', triggeredBy: 'owner-a' });
    items.push({ instance: await repository.updateRangeInstance(instance.id, { lastJobId: job.id }), job });
  }
  const native = { executeCreateBatch: jest.fn(), executeDestroyBatch: jest.fn(), refreshSingleInstanceAccessEntry: jest.fn() };
  const tofu = { executeCreateBatch: jest.fn(async (claimed: SingleInstanceExecutionItem[], lease: SingleInstanceOpenTofuBatchLease) => {
    await lease.assertCurrent();
    for (const item of claimed) await repository.commitSingleInstanceClaim(item.job, { status: 'running', resourceSummary: { mode: 'opentofu', hostIds: { [item.instance.singleInstanceConfig!.hostKey]: `i-${item.instance.id}` } }, accessEntry: { hostRole: 'host', publicIp: '192.0.2.1', privateIp: null, ssh: null } }, { status: 'succeeded', finishedAt: new Date() });
  }), executeDestroyBatch: jest.fn(async (claimed: SingleInstanceExecutionItem[], lease: SingleInstanceOpenTofuBatchLease) => {
    await lease.assertCurrent();
    for (const item of claimed) await repository.commitSingleInstanceClaim(item.job, { status: 'destroyed', resourceSummary: null, accessEntry: null }, { status: 'succeeded', finishedAt: new Date() });
  }) };
  const worker = new ProvisioningWorkerService(repository, {} as any, config as any, native as any, {} as any, tofu as any);
  return { repository, batch, items, native, tofu, worker };
}

describe('OpenTofu single-instance worker integration', () => {
  it('does not absorb a confirmed native recovery into another member normal destroy batch', async () => {
    const f = await fixture(2); await f.worker.process(f.items[0].job.id);
    const normal = await f.repository.createProvisionJob({ rangeInstanceId: f.items[0].instance.id, jobType: 'destroy', triggeredBy: 'owner-a' });
    const recovery = await f.repository.createProvisionJob({ rangeInstanceId: f.items[1].instance.id, jobType: 'destroy', triggeredBy: 'resource-alert:admin',
      topologySnapshot: { resourceAlertPlan: { mode: 'confirmed_inventory' } } as any });
    for (const [item, job] of [[f.items[0], normal], [f.items[1], recovery]] as const)
      await f.repository.updateRangeInstance(item.instance.id, { status: 'pending_destroy', lastJobId: job.id });
    await f.worker.process(normal.id);
    expect(f.tofu.executeDestroyBatch.mock.calls[0][0].map(item => item.job.id)).toEqual([normal.id]);
    expect((await f.repository.getProvisionJobById(recovery.id))?.status).toBe('pending');
  });
  it('recovers all 50 members including early-running members without claiming other operations', async () => {
    const f = await fixture(50);
    for (const item of f.items.slice(0, 20)) await f.repository.updateRangeInstance(item.instance.id, { status: 'running' });
    const finished = f.items[48], refresh = f.items[49];
    await f.repository.updateProvisionJob(finished.job.id, { status: 'succeeded' });
    await f.repository.updateRangeInstance(finished.instance.id, { status: 'running' });
    await f.repository.updateProvisionJob(refresh.job.id, { status: 'succeeded' });
    const refreshJob = await f.repository.createProvisionJob({ rangeInstanceId: refresh.instance.id, jobType: 'refresh_status', triggeredBy: 'owner-a' });
    await f.repository.updateRangeInstance(refresh.instance.id, { status: 'running', lastJobId: refreshJob.id });
    await f.worker.process(f.items[20].job.id);
    expect(f.tofu.executeCreateBatch).toHaveBeenCalledTimes(1);
    expect(f.tofu.executeCreateBatch.mock.calls[0][0]).toHaveLength(48);
    expect(f.tofu.executeCreateBatch.mock.calls[0][0].map(item => item.instance.id).sort())
      .toEqual(f.items.slice(0, 48).map(item => item.instance.id).sort());
    expect((await f.repository.getProvisionJobById(refreshJob.id))?.status).toBe('pending');
    expect(f.native.executeCreateBatch).not.toHaveBeenCalled();
  });

  it('claims the complete batch behind its database lease and calls OpenTofu once without native create', async () => {
    const f = await fixture(3);
    await f.worker.process(f.items[0].job.id);
    expect(f.tofu.executeCreateBatch).toHaveBeenCalledTimes(1);
    expect(f.tofu.executeCreateBatch.mock.calls[0][0].map(item => item.instance.id).sort()).toEqual(f.items.map(item => item.instance.id).sort());
    expect(f.native.executeCreateBatch).not.toHaveBeenCalled();
    expect((await f.repository.listProvisionJobs()).every(job => job.status === 'succeeded')).toBe(true);
  });

  it('does not split a shared workspace when two worker instances race different members', async () => {
    const f = await fixture(3), paused = gate(), started = gate();
    const original = f.tofu.executeCreateBatch.getMockImplementation()!;
    f.tofu.executeCreateBatch.mockImplementation(async (items, lease) => { started.release(); await paused.promise; await original(items, lease); });
    const second = new ProvisioningWorkerService(f.repository, {} as any, config as any, f.native as any, {} as any, f.tofu as any);
    const firstRun = f.worker.process(f.items[0].job.id);
    await started.promise;
    await second.process(f.items[1].job.id);
    expect(f.tofu.executeCreateBatch).toHaveBeenCalledTimes(1);
    expect(scheduler(second).failedTaskRetryAfter.has(`single-batch:${f.batch.id}`)).toBe(true);
    paused.release(); await firstRun;
    expect((await f.repository.listProvisionJobs()).every(job => job.status === 'succeeded')).toBe(true);
  });

  it('routes a single-member delete through its batch lease without calling legacy deletion', async () => {
    const f = await fixture(2); await f.worker.process(f.items[0].job.id);
    const target = f.items[1].instance;
    const job = await f.repository.createProvisionJob({ rangeInstanceId: target.id, jobType: 'destroy', triggeredBy: 'owner-a' });
    await f.repository.updateRangeInstance(target.id, { status: 'pending_destroy', lastJobId: job.id });
    await f.worker.process(job.id);
    expect(f.tofu.executeDestroyBatch.mock.calls[0][0]).toHaveLength(1);
    expect(f.native.executeDestroyBatch).not.toHaveBeenCalled();
    expect((await f.repository.getRangeInstanceById(f.items[0].instance.id))?.status).toBe('running');
    expect((await f.repository.getRangeInstanceById(target.id))?.status).toBe('destroyed');
  });

  it('keeps existing API-managed resources on legacy delete instead of adopting their state', async () => {
    const f = await fixture(1), item = f.items[0];
    await f.repository.updateProvisionJob(item.job.id, { status: 'succeeded' });
    const job = await f.repository.createProvisionJob({ rangeInstanceId: item.instance.id, jobType: 'destroy', triggeredBy: 'owner-a' });
    await f.repository.updateRangeInstance(item.instance.id, { status: 'pending_destroy', lastJobId: job.id, singleInstanceConfig: { ...item.instance.singleInstanceConfig!, executionBackend: 'ecs-native' } });
    await f.worker.process(job.id);
    expect(f.native.executeDestroyBatch).toHaveBeenCalledTimes(1);
    expect(f.tofu.executeDestroyBatch).not.toHaveBeenCalled();
  });

  it('pages past 100 members of an already active batch to find another user workload', async () => {
    const f = await fixture(101), paused = gate();
    const other = await f.repository.createRangeInstance({ name: 'other-user', instanceMode: 'single', status: 'pending_create', ownerUserId: 'owner-b', singleInstanceBatchId: 'other-batch' });
    await f.repository.createProvisionJob({ rangeInstanceId: other.id, jobType: 'create', triggeredBy: 'owner-b' });
    const calls = jest.spyOn(f.worker, 'process').mockImplementation(() => paused.promise);
    expect(await scheduler(f.worker).startEligiblePendingJobs()).toBe(2);
    expect(calls).toHaveBeenCalledTimes(2);
    paused.release(); await Promise.all([...scheduler(f.worker).activeTasks]);
  });

  it('releases a readiness-poll slot after one incomplete read and schedules a future job', async () => {
    const f = await fixture(1), item = f.items[0];
    await f.repository.updateProvisionJob(item.job.id, { status: 'succeeded' });
    const refresh = await f.repository.createProvisionJob({ rangeInstanceId: item.instance.id, jobType: 'refresh_status', triggeredBy: 'owner-a' });
    await f.repository.updateRangeInstance(item.instance.id, { status: 'creating', lastJobId: refresh.id, resourceSummary: { mode: 'opentofu', hostIds: { [item.instance.singleInstanceConfig!.hostKey]: 'i-pending' } } });
    const readonly = new SingleInstanceBatchExecutionService(f.repository, { ...config, getAccountContextById: async () => ({ ...snapshot, cloudAccountContextId: 'context-a', accountUid: 'uid-a', accountUidResolved: true }) } as any);
    const read = jest.spyOn(readonly as any, 'describeInstances').mockResolvedValue([{ instanceId: 'i-pending', status: 'Starting', instanceName: 'fixture', hostName: '', privateIp: null, publicIp: null, tags: {} }]);
    const worker = new ProvisioningWorkerService(f.repository, {} as any, config as any, readonly, {} as any, f.tofu as any);
    const before = new Date(); await worker.process(refresh.id);
    expect(read).toHaveBeenCalledTimes(1);
    expect((await f.repository.getProvisionJobById(refresh.id))?.status).toBe('succeeded');
    const queued = (await f.repository.listProvisionJobs()).find(job => job.status === 'pending')!;
    expect(queued.jobType).toBe('refresh_status');
    expect(queued.availableAt!.getTime()).toBeGreaterThanOrEqual(before.getTime() + 2000);
    expect(await f.repository.listPendingProvisionJobs({ now: before })).toEqual([]);
    expect((await f.repository.listPendingProvisionJobs({ now: queued.availableAt })).map(job => job.id)).toEqual([queued.id]);
    expect((readonly as any).inFlight).toBe(0);
  });
});
