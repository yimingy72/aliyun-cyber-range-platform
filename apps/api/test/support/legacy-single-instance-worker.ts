import type { AdminRepository } from '../../src/admin/admin.repository';
import type { ProvisioningWorkerService } from '../../src/provisioning/provisioning-worker.service';

export async function markQueuedInstancesAsLegacyNative(repository: AdminRepository, ids: string[]) {
  for (const id of ids) {
    const instance = await repository.getRangeInstanceById(id);
    if (instance?.instanceMode !== 'single' || instance.status !== 'pending_create' || !instance.singleInstanceConfig)
      throw new Error('Legacy fixture requires an explicitly selected queued single instance');
    await repository.updateRangeInstance(id, { singleInstanceConfig: { ...instance.singleInstanceConfig, executionBackend: 'ecs-native' } });
  }
}

export async function pumpLegacySingleInstanceWorker(worker: ProvisioningWorkerService, repository: AdminRepository) {
  const scheduling = worker as unknown as { startEligiblePendingJobs(): Promise<number>; activeTasks: Set<Promise<void>> };
  for (let round = 0; round < 10; round++) {
    const pending = (await repository.listProvisionJobs()).filter(job => job.status === 'pending');
    if (!pending.length && !scheduling.activeTasks.size) return;
    for (const job of pending) {
      const instance = await repository.getRangeInstanceById(job.rangeInstanceId);
      if (instance?.instanceMode !== 'single' || instance.singleInstanceConfig?.executionBackend !== 'ecs-native')
        throw new Error('Native compatibility tests must explicitly label every queued fixture ecs-native');
    }
    const started = await scheduling.startEligiblePendingJobs();
    while (scheduling.activeTasks.size) await Promise.all([...scheduling.activeTasks]);
    if (!started && pending.length) {
      const latest = (await repository.listProvisionJobs()).filter(job => job.status === 'pending');
      if (!latest.length) continue;
      const delay = Math.min(...latest.map(job => (job.availableAt ?? job.createdAt).getTime())) - Date.now();
      // Eligibility can cross its deadline after the scheduler captured this round's clock.
      await new Promise(resolve => setTimeout(resolve, Math.max(1, delay)));
    }
  }
  throw new Error('Legacy fixture exceeded bounded worker scheduling rounds');
}

/** Legacy fixtures must carry the same durable creation origin as production
 *  rows: destroy and cleanup only proceed with the original started creation job. */
export async function seedLegacyNativeCreateJob(repository: AdminRepository, instanceId: string) {
  const instance = await repository.getRangeInstanceById(instanceId);
  if (!instance || instance.instanceMode !== 'single' || !instance.singleInstanceConfig)
    throw new Error('Legacy fixture requires a single instance before seeding its creation origin');
  if (instance.singleInstanceConfig.nativeCreateJobId) return instance.singleInstanceConfig.nativeCreateJobId;
  const startedAt = new Date(Date.now() - 60_000);
  const job = await repository.createProvisionJob({ rangeInstanceId: instanceId, jobType: 'create', triggeredBy: 'legacy-fixture' });
  await repository.updateProvisionJob(job.id, { status: 'succeeded', startedAt, finishedAt: new Date() });
  await repository.updateRangeInstance(instanceId, { singleInstanceConfig: { ...instance.singleInstanceConfig, nativeCreateJobId: job.id } });
  return job.id;
}
