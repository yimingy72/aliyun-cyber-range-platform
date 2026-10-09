import { performance } from 'node:perf_hooks';
import { ProvisioningWorkerService } from '../src/provisioning/provisioning-worker.service';
import type { RangeProvisioner } from '../src/provisioning/provisioning.types';
import type { SingleInstanceBatchExecutionService } from '../src/admin/single-instance-batch-execution.service';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';

const config = {
  getSnapshot: async () => ({ provider: 'alibaba_cloud', defaultRegion: 'cn-hangzhou', defaultZoneId: 'cn-hangzhou-h', accessKeyId: 'fixture', accessKeySecret: 'fixture' }),
};
const result = { accessEntry: { hostRole: 'entry', publicIp: null, privateIp: null, ssh: null }, resourceSummary: { mode: 'dry-run' as const } };
const scheduler = (worker: ProvisioningWorkerService) => worker as unknown as {
  startEligiblePendingJobs(): Promise<number>;
  dispatchSingleInstanceJob(id: string): Promise<void>;
  activeTasks: Set<Promise<void>>;
};
const gate = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
const envKeys = ['PROVISIONING_WORKER_RANGE_CONCURRENCY', 'PROVISIONING_WORKER_SINGLE_BATCH_CONCURRENCY'] as const;
let savedEnv: Array<string | undefined>;

beforeEach(() => { savedEnv = envKeys.map(key => process.env[key]); envKeys.forEach(key => delete process.env[key]); });
afterEach(() => envKeys.forEach((key, index) => { if (savedEnv[index] === undefined) delete process.env[key]; else process.env[key] = savedEnv[index]; }));

async function ranges(count: number) {
  const repository = createMemoryAdminRepository();
  const template = await repository.createRangeTemplate({
    name: 'Scheduling fixture', slug: 'scheduling-fixture', version: 'v1', modulePathOrRef: 'fixture/range',
    topologySpec: { vpcCidr: '10.0.0.0/16', networkZones: [{ key: 'dmz', name: 'DMZ', purpose: 'entry', cidr: '10.0.10.0/24' }], hosts: [{ key: 'entry', name: 'entry', zoneKey: 'dmz', role: 'entry', privateIp: '10.0.10.10' }], publicEntry: { hostKey: 'entry', protocols: [{ protocol: 'ssh', port: 22 }] } },
  });
  const published = await repository.publishRangeTemplateToPlatform(template.id, template.revision);
  const jobs = [];
  for (let index = 0; index < count; index += 1) {
    const owner = await repository.createPlatformUser({ id: `scheduler-owner-${index}`, username: `scheduler-owner-${index}`, role: 'user', passwordHash: 'fixture' });
    const instance = await repository.createRangeInstance({ name: `range-${index}`, ownerUserId: owner.id, createdBy: owner.id, templateId: template.id, sourceTemplateVersionId: published.currentPublishedVersionId, status: 'pending_create' });
    const job = await repository.createProvisionJob({ rangeInstanceId: instance.id, jobType: 'create', triggeredBy: owner.id });
    await repository.updateRangeInstance(instance.id, { lastJobId: job.id });
    jobs.push(job);
  }
  return { repository, jobs };
}

async function singles(repository: ReturnType<typeof createMemoryAdminRepository>, count: number) {
  const jobs = [];
  for (let index = 0; index < count; index += 1) {
    const instance = await repository.createRangeInstance({ name: `single-${index}`, instanceMode: 'single', singleInstanceBatchId: `batch-${index}`, status: 'pending_create' });
    const job = await repository.createProvisionJob({ rangeInstanceId: instance.id, jobType: 'create', triggeredBy: 'fixture-owner' });
    await repository.updateRangeInstance(instance.id, { lastJobId: job.id }); jobs.push(job);
  }
  return jobs;
}

async function drain(workers: ProvisioningWorkerService[], repository: ReturnType<typeof createMemoryAdminRepository>) {
  while ((await repository.listProvisionJobs()).some(job => ['pending', 'running'].includes(job.status))) {
    await Promise.all(workers.map(worker => scheduler(worker).startEligiblePendingJobs()));
    const active = workers.flatMap(worker => [...scheduler(worker).activeTasks]);
    if (!active.length) throw new Error('Pending workload made no progress');
    await Promise.race(active);
  }
  await Promise.all(workers.flatMap(worker => [...scheduler(worker).activeTasks]));
}

describe('Provisioning worker bounded scheduling', () => {
  it('runs different owners and instances in parallel within the range budget, leaving excess jobs pending', async () => {
    const fixture = await ranges(5), release = gate(), started = gate();
    let active = 0, peak = 0;
    const create = jest.fn(async () => { active += 1; peak = Math.max(peak, active); if (active === 2) started.release(); await release.promise; active -= 1; return result; });
    const worker = new ProvisioningWorkerService(fixture.repository, { create, destroy: jest.fn() }, config as any);
    expect(await scheduler(worker).startEligiblePendingJobs()).toBe(2);
    await started.promise;
    expect(await scheduler(worker).startEligiblePendingJobs()).toBe(0);
    expect((await fixture.repository.listProvisionJobs()).filter(job => job.status === 'pending')).toHaveLength(3);
    release.release();
    await drain([worker], fixture.repository);
    expect(peak).toBe(2); expect(create).toHaveBeenCalledTimes(5);
    for (const job of fixture.jobs) {
      expect(await fixture.repository.getProvisionJobById(job.id)).toMatchObject({ status: 'succeeded' });
      expect(await fixture.repository.getRangeInstanceById(job.rangeInstanceId)).toMatchObject({ status: 'running', ownerUserId: job.triggeredBy });
    }
  });

  it('keeps a second operation on the same range out of a reserved instance slot', async () => {
    const fixture = await ranges(1), release = gate();
    await fixture.repository.createProvisionJob({ rangeInstanceId: fixture.jobs[0].rangeInstanceId, jobType: 'destroy', triggeredBy: fixture.jobs[0].triggeredBy });
    const worker = new ProvisioningWorkerService(fixture.repository, {} as RangeProvisioner, config as any);
    const processSpy = jest.spyOn(worker, 'process').mockImplementation(() => release.promise);
    expect(await scheduler(worker).startEligiblePendingJobs()).toBe(1);
    expect(await scheduler(worker).startEligiblePendingJobs()).toBe(0);
    expect(processSpy).toHaveBeenCalledTimes(1);
    release.release(); await Promise.all([...scheduler(worker).activeTasks]);
  });

  it.each(['0', '-2', '1.5', 'Infinity', 'invalid'])('uses the safe default range budget for invalid configuration %s', async value => {
    process.env.PROVISIONING_WORKER_RANGE_CONCURRENCY = value;
    const fixture = await ranges(3), release = gate();
    const worker = new ProvisioningWorkerService(fixture.repository, {} as RangeProvisioner, config as any);
    jest.spyOn(worker, 'process').mockImplementation(() => release.promise);
    expect(await scheduler(worker).startEligiblePendingJobs()).toBe(2);
    release.release(); await Promise.all([...scheduler(worker).activeTasks]);
  });

  it('shares the native batch budget between immediate dispatch and polling, retaining overflow for the next poll', async () => {
    process.env.PROVISIONING_WORKER_SINGLE_BATCH_CONCURRENCY = '2';
    const repository = createMemoryAdminRepository(), jobs = await singles(repository, 5), release = gate();
    const worker = new ProvisioningWorkerService(repository, {} as RangeProvisioner, config as any);
    const processSpy = jest.spyOn(worker, 'process').mockImplementation(async id => {
      await repository.claimProvisionJob(id, new Date());
      await release.promise;
      await repository.updateProvisionJob(id, { status: 'succeeded', finishedAt: new Date() });
    });
    await Promise.all(jobs.map(job => scheduler(worker).dispatchSingleInstanceJob(job.id)));
    expect(processSpy).toHaveBeenCalledTimes(2);
    expect(await scheduler(worker).startEligiblePendingJobs()).toBe(0);
    expect((await repository.listProvisionJobs()).filter(job => job.status === 'pending')).toHaveLength(3);
    release.release(); await Promise.all([...scheduler(worker).activeTasks]);
    expect(await scheduler(worker).startEligiblePendingJobs()).toBe(2);
    await drain([worker], repository);
    expect(processSpy).toHaveBeenCalledTimes(5);
  });

  it('keeps the default native budget at three even when its configuration is invalid', async () => {
    process.env.PROVISIONING_WORKER_SINGLE_BATCH_CONCURRENCY = '0';
    const repository = createMemoryAdminRepository(), jobs = await singles(repository, 6), release = gate();
    const worker = new ProvisioningWorkerService(repository, {} as RangeProvisioner, config as any);
    const processSpy = jest.spyOn(worker, 'process').mockImplementation(() => release.promise);
    await Promise.all(jobs.map(job => scheduler(worker).dispatchSingleInstanceJob(job.id)));
    expect(processSpy).toHaveBeenCalledTimes(3); expect(scheduler(worker).activeTasks.size).toBe(3);
    release.release(); await Promise.all([...scheduler(worker).activeTasks]);
  });

  it('does not execute a stale refresh alongside the current destroy on the same single instance', async () => {
    const repository = createMemoryAdminRepository(), release = gate(), started = gate();
    const instance = await repository.createRangeInstance({ name: 'single-fenced', instanceMode: 'single', status: 'pending_destroy', singleInstanceConfig: { baseName: 'fenced', quantityIndex: 1, hostKey: 'single', hostName: 'single', platformImageAssetId: 'fixture-asset', imageId: 'fixture-image', imageDisplayName: 'fixture', cpu: 2, memory: 4, systemDiskSize: 40 } });
    const refresh = await repository.createProvisionJob({ rangeInstanceId: instance.id, jobType: 'refresh_status', triggeredBy: 'fixture-owner' });
    const destroy = await repository.createProvisionJob({ rangeInstanceId: instance.id, jobType: 'destroy', triggeredBy: 'fixture-owner' });
    await repository.updateRangeInstance(instance.id, { lastJobId: destroy.id });
    const executor = { executeDestroyBatch: jest.fn(async () => { started.release(); await release.promise; }), refreshSingleInstanceAccessEntry: jest.fn() };
    const worker = new ProvisioningWorkerService(repository, {} as RangeProvisioner, config as any, executor as unknown as SingleInstanceBatchExecutionService);
    await scheduler(worker).dispatchSingleInstanceJob(destroy.id); await started.promise;
    await scheduler(worker).dispatchSingleInstanceJob(refresh.id);
    await new Promise(resolve => setImmediate(resolve));
    expect(executor.refreshSingleInstanceAccessEntry).not.toHaveBeenCalled();
    expect(executor.executeDestroyBatch).toHaveBeenCalledTimes(1);
    release.release(); await Promise.all([...scheduler(worker).activeTasks]);
  });

  it('keeps atomic claims across two worker instances and never runs a job twice', async () => {
    const fixture = await ranges(6); const seen: string[] = [];
    const create = jest.fn(async (input: { rangeInstanceId: string }) => { seen.push(input.rangeInstanceId); await new Promise(resolve => setTimeout(resolve, 15)); return result; });
    const workers = [0, 1].map(() => new ProvisioningWorkerService(fixture.repository, { create, destroy: jest.fn() }, config as any));
    await drain(workers, fixture.repository);
    expect(seen).toHaveLength(6); expect(new Set(seen).size).toBe(6);
    expect((await fixture.repository.listProvisionJobs()).every(job => job.status === 'succeeded')).toBe(true);
  });

  it.each(['read', 'claim', 'persist'] as const)('releases a failed %s slot without rejecting the loop or interrupting another owner', async stage => {
    const fixture = await ranges(3), release = gate(), started = gate();
    const failedId = fixture.jobs[2].id;
    const fail = () => Promise.reject(new Error('fixture secret must not be logged'));
    if (stage === 'claim') {
      const original = fixture.repository.claimRangeProvisionJob.bind(fixture.repository);
      jest.spyOn(fixture.repository, 'claimRangeProvisionJob').mockImplementation((id, when) => id === failedId ? fail() : original(id, when));
    } else if (stage === 'read') {
      const original = fixture.repository.getProvisionJobById.bind(fixture.repository);
      jest.spyOn(fixture.repository, 'getProvisionJobById').mockImplementation(id => id === failedId ? fail() : original(id));
    } else {
      const original = fixture.repository.updateRangeInstanceForProvisionJob.bind(fixture.repository);
      jest.spyOn(fixture.repository, 'updateRangeInstanceForProvisionJob').mockImplementation((id, when, input) => id === failedId ? fail() : original(id, when, input));
    }
    const create = jest.fn(async () => { if (create.mock.calls.length === 1) started.release(); await release.promise; return result; });
    const worker = new ProvisioningWorkerService(fixture.repository, { create, destroy: jest.fn() }, config as any);
    const errors = jest.spyOn((worker as any).logger, 'error').mockImplementation(() => {});
    expect(await scheduler(worker).startEligiblePendingJobs()).toBe(2);
    const firstTasks = [...scheduler(worker).activeTasks];
    await Promise.race(firstTasks); await started.promise;
    const failedJob = (await fixture.repository.listProvisionJobs()).find(job => job.id === failedId)!;
    expect(failedJob.status).toBe(stage === 'persist' ? 'running' : 'pending');
    expect(failedJob.startedAt === null).toBe(stage !== 'persist');
    expect(await scheduler(worker).startEligiblePendingJobs()).toBe(1);
    release.release(); await Promise.all([...scheduler(worker).activeTasks]);
    expect(create).toHaveBeenCalledTimes(2);
    expect((await fixture.repository.listProvisionJobs()).filter(job => job.status === 'succeeded')).toHaveLength(2);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(errors.mock.calls)).not.toContain('fixture secret');
    if (stage === 'persist') {
      await expect(worker.recoverInterruptedJobs(new Date(Date.now() + 10 * 60_000))).resolves.toBe(1);
      expect((await fixture.repository.listProvisionJobs()).find(job => job.id === failedId)).toMatchObject({ status: 'pending', retryCount: 1 });
    }
  });

  it('reserves one native slot when polling and immediate dispatch race for the same job', async () => {
    const repository = createMemoryAdminRepository(), [job] = await singles(repository, 1), release = gate();
    const worker = new ProvisioningWorkerService(repository, {} as RangeProvisioner, config as any);
    const processSpy = jest.spyOn(worker, 'process').mockImplementation(async id => {
      await repository.claimProvisionJob(id, new Date()); await release.promise;
    });
    await Promise.all([scheduler(worker).startEligiblePendingJobs(), scheduler(worker).dispatchSingleInstanceJob(job.id)]);
    expect(processSpy).toHaveBeenCalledTimes(1); expect(scheduler(worker).activeTasks.size).toBe(1);
    release.release(); await Promise.all([...scheduler(worker).activeTasks]);
  });

  it('benchmarks six slow multi-user range creates at concurrency one and two', async () => {
    const measurements = [];
    for (const concurrency of [1, 2]) {
      process.env.PROVISIONING_WORKER_RANGE_CONCURRENCY = String(concurrency);
      const fixture = await ranges(6); let active = 0, peak = 0;
      const create = jest.fn(async () => { active += 1; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 100)); active -= 1; return result; });
      const worker = new ProvisioningWorkerService(fixture.repository, { create, destroy: jest.fn() }, config as any);
      const began = performance.now(); await drain([worker], fixture.repository);
      measurements.push({ concurrency, jobs: 6, owners: 6, simulatedProvisionerDelayMs: 100, elapsedMs: Math.round(performance.now() - began), peak });
      expect(peak).toBe(concurrency); expect(create).toHaveBeenCalledTimes(6);
      expect((await fixture.repository.listProvisionJobs()).every(job => job.status === 'succeeded')).toBe(true);
    }
    console.log(`WORKER_SIMULATION_BENCHMARK ${JSON.stringify(measurements)}`);
  });
});
