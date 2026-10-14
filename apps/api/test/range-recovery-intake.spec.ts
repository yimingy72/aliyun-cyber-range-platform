import { BadRequestException, ConflictException } from '@nestjs/common';
import { OperationControlService } from '../src/operations/operation-control.service';
import { runInCloudWorkspace } from '../src/auth/cloud-workspace-scope';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';
import type { CreateIdempotentOperationInput } from '../src/admin/admin.repository';
import { ProvisioningWorkerService } from '../src/provisioning/provisioning-worker.service';
import { RangesController } from '../src/admin/ranges.controller';

const scope = { cloudWorkspaceId: 'recovery-intake-a', provider: 'alibaba_cloud' as const, accountUid: '100001' };
const context = { user: { id: 'owner-a', username: 'owner-a', role: 'user' as const }, source: 'web' as const, oauthClientId: 'platform-web' };
const metadata = { requestId: 'request', idempotencyKey: 'original-recovery-key', confirmationId: null };

async function fixture() {
  const repository = createMemoryAdminRepository();
  const instance = await repository.createRangeInstance({ name: 'failed range', instanceMode: 'range', status: 'create_failed', ownerUserId: context.user.id });
  const service = new OperationControlService(repository);
  const operation = service.prepareRangeRecoveryIntake(context, metadata, instance.id, 'retry');
  const queue = async (intakeOperation: CreateIdempotentOperationInput) => {
    const job = await repository.queueRangeInstanceJob({ rangeInstanceId: instance.id, jobType: 'retry', triggeredBy: context.user.id,
      expectedStatus: 'create_failed', expectedOwnerUserId: context.user.id, nextStatus: 'pending_create', intakeOperation });
    if (!job) throw new ConflictException('Range state changed');
    return job;
  };
  const intake = (execute = queue) => service.executeRangeRecoveryIntake({ context, metadata, rangeInstanceId: instance.id, trigger: 'retry', execute });
  return { repository, instance, service, operation, queue, intake };
}

describe('durable range recovery intake', () => {
  it('keeps an unconfirmed lookup empty while validation is running and later associates its original job', async () => runInCloudWorkspace(scope, async () => {
    const f = await fixture();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const original = f.intake(async operation => { await gate; return f.queue(operation); });
    expect(await f.service.readRangeRecoveryIntake(f.operation)).toBeNull();
    release();
    const id = await original;
    expect(await f.service.readRangeRecoveryIntake(f.operation)).toMatchObject({ status: 'succeeded', result: { id } });
  }));

  it('never creates a second job for the same key even when the first job has already failed', async () => runInCloudWorkspace(scope, async () => {
    const f = await fixture();
    const id = await f.intake();
    await f.repository.updateProvisionJob(id, { status: 'failed' });
    await f.repository.updateRangeInstance(f.instance.id, { status: 'create_failed' });
    const validation = jest.fn().mockRejectedValue(new BadRequestException('expired since the first request'));
    await expect(f.intake(validation)).resolves.toBe(id);
    expect(validation).not.toHaveBeenCalled();
    expect(await f.repository.listProvisionJobs()).toHaveLength(1);
  }));

  it('keeps the receipt accepted after the actual worker failure finalizer and returns it from recovery GET', async () => runInCloudWorkspace(scope, async () => {
    const f = await fixture();
    const id = await f.intake();
    const claim = await f.repository.claimRangeProvisionJob(id, new Date());
    const instance = (await f.repository.getRangeInstanceById(f.instance.id))!;
    const worker = new ProvisioningWorkerService(f.repository, {} as never, {} as never) as unknown as {
      failJob: (job: NonNullable<typeof claim>, range: typeof instance, message: string) => Promise<void> };
    await worker.failJob(claim!, instance, 'fixture capacity failure');
    expect((await f.repository.getProvisionJobById(id))!.status).toBe('failed');
    expect(await f.service.readRangeRecoveryIntake(f.operation)).toMatchObject({ status: 'succeeded', result: { id } });
    await expect(f.intake()).resolves.toBe(id);
    const controller = new RangesController({
      getById: async () => f.repository.getRangeInstanceById(f.instance.id),
      getRecordedRecoveryJob: async () => f.repository.getProvisionJobById(id),
    } as never, {} as never, f.service);
    await expect(controller.recoveryStatus({ adminUser: context.user, authContext: context,
      headers: { 'x-idempotency-key': metadata.idempotencyKey } } as never, f.instance.id, 'retry'))
      .resolves.toEqual({ state: 'accepted', jobId: id });
    expect(await f.repository.listProvisionJobs()).toHaveLength(1);
  }));

  it('fences a delayed original handler after a same-key validation rejection', async () => runInCloudWorkspace(scope, async () => {
    const f = await fixture();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const original = f.intake(async operation => { await gate; return f.queue(operation); }).catch(error => error);
    await expect(f.intake(async () => { throw new BadRequestException('image became unavailable'); })).rejects.toThrow('image became unavailable');
    expect(await f.service.readRangeRecoveryIntake(f.operation)).toMatchObject({ status: 'failed', errorCode: 'HTTP_400' });
    release();
    expect(await original).toBeInstanceOf(ConflictException);
    expect(await f.repository.listProvisionJobs()).toHaveLength(0);
  }));

  it('keeps the accepted receipt after a response is lost and safely replays it', async () => runInCloudWorkspace(scope, async () => {
    const f = await fixture();
    jest.spyOn(f.service, 'audit').mockResolvedValueOnce({} as never).mockRejectedValueOnce(new Error('response lost')).mockResolvedValue({} as never);
    await expect(f.intake()).rejects.toThrow('response lost');
    const recorded = await f.service.readRangeRecoveryIntake(f.operation);
    expect(recorded).toMatchObject({ status: 'succeeded' });
    expect(await f.intake()).toBe(recorded!.result!.id);
    expect(await f.repository.listProvisionJobs()).toHaveLength(1);
  }));

  it('does not expose another actor or workspace receipt or bind the key to another range', async () => runInCloudWorkspace(scope, async () => {
    const f = await fixture();
    await f.intake();
    const otherActor = f.service.prepareRangeRecoveryIntake({ ...context, user: { ...context.user, id: 'owner-b' } }, metadata, f.instance.id, 'retry');
    expect(await f.service.readRangeRecoveryIntake(otherActor)).toBeNull();
    await expect(f.service.readRangeRecoveryIntake(f.service.prepareRangeRecoveryIntake(context, metadata, 'another-range', 'retry'))).rejects.toBeInstanceOf(ConflictException);
    await runInCloudWorkspace({ ...scope, cloudWorkspaceId: 'recovery-intake-b' }, async () => {
      expect(await f.service.readRangeRecoveryIntake(f.service.prepareRangeRecoveryIntake(context, metadata, f.instance.id, 'retry'))).toBeNull();
    });
  }));
});
