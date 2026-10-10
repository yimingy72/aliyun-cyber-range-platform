import { ProvisioningWorkerService } from '../src/provisioning/provisioning-worker.service';
import { OperationControlService } from '../src/operations/operation-control.service';
import { runInCloudWorkspace } from '../src/auth/cloud-workspace-scope';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';

const scope = { cloudWorkspaceId: 'workspace-a', provider: 'alibaba_cloud' as const, accountUid: '123456' };
const binding = { cloudAccountContextId: 'context-a', cloudAccountUid: scope.accountUid, regionId: 'cn-hangzhou', zoneId: 'cn-hangzhou-h' };

async function expiredFixture(mode: 'range' | 'single', error = 'Cloud request timed out', retries = 0) {
  const repository = createMemoryAdminRepository();
  const instance = await repository.createRangeInstance({ name: 'expired-owned', instanceMode: mode,
    status: 'destroy_failed', expiresAt: '2026-10-01T00:00:00Z',
    resourceSummary: { mode: 'opentofu', executionContext: binding, creationAttempted: true },
    ...(mode === 'single' ? { singleInstanceConfig: { ...binding, hostKey: 'entry' } as never } : {}) });
  const job = await repository.createProvisionJob({ rangeInstanceId: instance.id, jobType: 'destroy',
    triggeredBy: 'system:auto-expire', retryCount: retries });
  await repository.updateProvisionJob(job.id, { status: 'failed', errorSummary: error, finishedAt: new Date('2026-10-01T00:01:00Z') });
  await repository.updateRangeInstance(instance.id, { lastJobId: job.id });
  const worker = new ProvisioningWorkerService(repository, {} as never, {} as never);
  return { repository, instance, job, worker };
}

describe('reviewed lifecycle regressions', () => {
  it.each(['range', 'single'] as const)('retries expired transient %s destruction once after backoff without duplicating jobs', async mode => {
    const f = await expiredFixture(mode);
    await f.worker.processExpiredInstances(new Date('2026-10-01T00:01:30Z'));
    expect(await f.repository.listProvisionJobs()).toHaveLength(1);
    await f.worker.processExpiredInstances(new Date('2026-10-01T00:03:00Z'));
    await f.worker.processExpiredInstances(new Date('2026-10-01T00:04:00Z'));
    const jobs = await f.repository.listProvisionJobs();
    expect(jobs).toHaveLength(2);
    expect(jobs.find(job => job.id !== f.job.id)).toMatchObject({ jobType: 'destroy', triggeredBy: 'system:auto-expire', retryCount: 1 });
    expect(await f.repository.getRangeInstanceById(f.instance.id)).toMatchObject({ status: 'pending_destroy' });
  });

  it.each(['source identity unknown after timeout', 'unverified disk requires recovery', 'Forbidden credentials'])('keeps unsafe expiry cleanup visible without retrying: %s', async error => {
    const f = await expiredFixture('range', error);
    const log = jest.spyOn((f.worker as any).logger, 'error').mockImplementation(() => {});
    await f.worker.processExpiredInstances(new Date('2026-10-01T01:00:00Z'));
    expect(await f.repository.listProvisionJobs()).toHaveLength(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining(f.instance.id));
  });

  it('bounds automatic cleanup retries', async () => {
    const f = await expiredFixture('range', 'Cloud request timed out', 3);
    jest.spyOn((f.worker as any).logger, 'error').mockImplementation(() => {});
    await f.worker.processExpiredInstances(new Date('2026-10-01T01:00:00Z'));
    expect(await f.repository.listProvisionJobs()).toHaveLength(1);
  });

  it('only treats a successful cloud-verified destroy as the boundary of old apply evidence', async () => {
    const repository = createMemoryAdminRepository();
    const instance = await repository.createRangeInstance({ name: 'recreated', instanceMode: 'range', status: 'pending_create',
      resourceSummary: { mode: 'opentofu', creationAttempted: false, executionContext: binding } });
    const create = await repository.createProvisionJob({ rangeInstanceId: instance.id, jobType: 'create', triggeredBy: 'owner' });
    await repository.updateProvisionJob(create.id, { status: 'succeeded', finishedAt: new Date('2026-10-01T00:01:00Z') });
    await repository.createProvisionJobStepLog({ jobId: create.id, stepName: 'tofu_apply', status: 'succeeded' });
    const destroy = await repository.createProvisionJob({ rangeInstanceId: instance.id, jobType: 'destroy', triggeredBy: 'owner' });
    await repository.updateProvisionJob(destroy.id, { status: 'succeeded', finishedAt: new Date('2026-10-01T00:02:00Z') });
    const next = await repository.createProvisionJob({ rangeInstanceId: instance.id, jobType: 'create', triggeredBy: 'owner', retryCount: 1 });
    const worker = new ProvisioningWorkerService(repository, {} as never, {} as never);
    await expect((worker as any).rangeHasApplyEvidence(instance, next)).resolves.toBe(true);
    await repository.createProvisionJobStepLog({ jobId: destroy.id, stepName: 'verify_destroy', status: 'succeeded' });
    await expect((worker as any).rangeHasApplyEvidence(instance, next)).resolves.toBe(false);
    await repository.updateProvisionJob(destroy.id, { status: 'failed' });
    await expect((worker as any).rangeHasApplyEvidence(instance, next)).resolves.toBe(true);
  });

  it.each([false, true])('finalizes a single-instance operation including interrupted execution (%s)', async interrupted => runInCloudWorkspace(scope, async () => {
    const repository = createMemoryAdminRepository();
    const instance = await repository.createRangeInstance({ name: 'single', instanceMode: 'single', status: 'pending_destroy',
      singleInstanceConfig: { hostKey: 'entry', nativeCreateJobId: 'original-create' } as never });
    const pending = await repository.createProvisionJob({ rangeInstanceId: instance.id, jobType: 'destroy', triggeredBy: 'owner' });
    await repository.updateRangeInstance(instance.id, { lastJobId: pending.id });
    const job = (await repository.claimProvisionJob(pending.id, new Date()))!;
    const operation = await repository.createIdempotentOperation({ cloudWorkspaceId: scope.cloudWorkspaceId,
      actorUserId: 'owner', toolName: 'single_instance_destroy', idempotencyKey: 'one', argumentsHash: 'hash', operationId: 'operation-a' });
    await repository.updateIdempotentOperation(operation.id, { result: { jobId: job.id, singleInstanceId: instance.id } });
    await repository.appendOperationAuditEvent({ cloudWorkspaceId: scope.cloudWorkspaceId, operationId: operation.operationId,
      requestId: 'request-a', actorUserId: 'owner', source: 'mcp', oauthClientId: 'mcp-gateway', toolName: 'single_instance_destroy',
      phase: 'dispatched', targetType: 'single_instance', targetId: instance.id, jobId: job.id });
    const executor = { executeDestroyBatch: jest.fn(async () => {
      if (interrupted) throw new Error('execution interrupted');
      await repository.commitSingleInstanceClaim(job, { status: 'destroyed' }, { status: 'succeeded', finishedAt: new Date() });
    }) };
    const worker = new ProvisioningWorkerService(repository, {} as never, {} as never, executor as never);
    await (worker as any).processClaimedJob(job);
    expect(await repository.getIdempotentOperationByOperationId(operation.operationId)).toMatchObject({ status: interrupted ? 'failed' : 'succeeded',
      result: { jobId: job.id, singleInstanceId: instance.id } });
  }));

  it.each(['pending', 'succeeded', 'failed'] as const)('persists async job identity and reconciles a %s job at dispatch', async status => runInCloudWorkspace(scope, async () => {
    const repository = createMemoryAdminRepository();
    const instance = await repository.createRangeInstance({ name: 'single', instanceMode: 'single' });
    const job = await repository.createProvisionJob({ rangeInstanceId: instance.id, jobType: 'destroy', triggeredBy: 'owner', status });
    const service = new OperationControlService(repository);
    const input = { context: { user: { id: 'owner', username: 'owner', role: 'user' as const }, source: 'mcp' as const, oauthClientId: 'mcp-gateway' },
      metadata: { requestId: 'request', idempotencyKey: 'stable', confirmationId: null as string | null },
      toolName: 'single_instance_destroy', arguments: { singleInstanceId: instance.id }, targetType: 'single_instance', targetId: instance.id,
      resolveConfirmation: async () => ({ targetId: instance.id, targetSnapshot: null, summary: {} }),
      execute: jest.fn(async () => ({ jobId: job.id, singleInstanceId: instance.id })) };
    try { await service.executeConfirmed(input); throw new Error('expected confirmation'); }
    catch (error) { input.metadata.confirmationId = (error as any).getResponse().confirmationId; }
    await service.executeConfirmed(input);
    const replay = await service.executeConfirmed(input);
    expect(replay).toMatchObject({ status: status === 'pending' ? 'accepted' : status, result: { jobId: job.id, singleInstanceId: instance.id } });
    expect(input.execute).toHaveBeenCalledTimes(1);
  }));
});
