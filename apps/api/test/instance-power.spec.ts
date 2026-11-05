import { ConflictException, ForbiddenException } from '@nestjs/common';
import { InstancePowerService } from '../src/admin/instance-power.service';
import { InstancePowerCloudClient } from '../src/admin/instance-power-cloud';
import { InstancePowerController } from '../src/admin/instance-power.controller';
import { NodeResetCloudError } from '../src/admin/range-node-reset-cloud.client';
import { OperationControlService } from '../src/operations/operation-control.service';
import { assertDelegatedApiScopes } from '../src/auth/delegated-api-scopes';
import { runInCloudWorkspace } from '../src/auth/cloud-workspace-scope';
import { assertPowerAllowsMutation, type PowerTarget } from '../src/admin/instance-power-types';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';
import { ProvisioningWorkerService } from '../src/provisioning/provisioning-worker.service';

import { scope, actor, context, account, inSpace, fixture } from './support/instance-control-fixture';

describe('economical power control', () => {
  it.each(['single', 'range'] as const)('stops and resumes original %s IDs while retaining disks/private network, expiry and billing', async mode => inSpace(async () => {
    const f = await fixture(mode), before = await f.repository.listBillingLedgerResources();
    const accepted = await f.submit(), job = await f.claim(accepted.items[0].jobId!);
    expect(await f.service.execute(job, async () => undefined)).toEqual({ pending: false, failed: false });
    const stopped = await f.repository.getRangeInstanceById(f.target.id);
    expect(stopped).toMatchObject({ status: 'running', powerControl: { state: 'economical_stopped' }, resourceSummary: f.instances[0].resourceSummary });
    if (mode === 'single') expect(stopped?.accessEntry).toMatchObject({ publicIp: null, ssh: null });
    const resume = await f.submit('resume'); await f.service.execute(await f.claim(resume.items[0].jobId!), async () => undefined);
    const running = await f.repository.getRangeInstanceById(f.target.id);
    expect(running?.powerControl?.state).toBe('running'); expect(running?.expiresAt).toEqual(f.instances[0].expiresAt);
    if (mode === 'single') expect(running?.accessEntry).toMatchObject({ publicIp: '192.0.2.2', ssh: 'ssh root@192.0.2.2' });
    expect(await f.repository.listBillingLedgerResources()).toEqual(before);
    expect(f.cloud.stopEconomical).toHaveBeenCalledTimes(1); expect(f.cloud.start).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(await f.service.list(f.target, actor))).not.toContain('NeverPrintThis');
  }));
  it('persists a future appointment without locking the instance; modifies and cancels exact revisions', async () => inSpace(async () => {
    const f = await fixture(), originalId = f.instances[0].lastJobId, at = new Date(Date.now() + 180_000).toISOString();
    expect((await f.submit('economical_stop', at)).items[0].scheduledAt).toBe(at);
    expect((await f.repository.listProvisionJobs()).filter(job => job.jobType === 'economical_stop')).toHaveLength(0);
    expect(await f.repository.getRangeInstanceById(f.target.id)).toMatchObject({ lastJobId: originalId, powerControl: { schedule: { status: 'scheduled', revision: 1 } } });
    await f.service.processSchedules(new Date()); expect(f.cloud.stopEconomical).not.toHaveBeenCalled();
    const first = (await f.repository.getRangeInstanceById(f.target.id))!.powerControl!.schedule!;
    await f.submit('economical_stop', new Date(Date.now() + 240_000).toISOString());
    await expect(f.service.cancel(f.target, actor, [{ instanceId: f.target.id, scheduleId: first.id, revision: 1 }])).rejects.toThrow(ConflictException);
    await f.service.cancel(f.target, actor, [{ instanceId: f.target.id, scheduleId: first.id, revision: 2 }]);
    await f.service.processSchedules(new Date(Date.now() + 240_000));
    expect((await f.repository.listProvisionJobs()).filter(job => job.jobType === 'economical_stop')).toHaveLength(0);
    expect((await f.service.list(f.target, actor)).instances[0].powerControl?.schedule).not.toHaveProperty('plan');
  }));
  it('refreshes the Windows public IP without advertising a Linux SSH command', async () => inSpace(async () => {
    const f = await fixture();
    await f.repository.updateRangeInstance(f.target.id, { runtimeCredentials: { host: { username: 'Administrator', password: 'NeverPrintThis9!' } },
      accessEntry: { ...f.instances[0].accessEntry!, ssh: null } });
    const stop = await f.submit(); await f.service.execute(await f.claim(stop.items[0].jobId!), async () => undefined);
    const resume = await f.submit('resume'); await f.service.execute(await f.claim(resume.items[0].jobId!), async () => undefined);
    expect((await f.repository.getRangeInstanceById(f.target.id))?.accessEntry).toMatchObject({ publicIp: '192.0.2.2', ssh: null });
  }));
  it('executes a persisted batch schedule after service restart and cannot cancel a queued schedule', async () => inSpace(async () => {
    const f = await fixture('single', 2), target: PowerTarget = { kind: 'single_batch', id: f.batch.id }, at = new Date(Date.now() + 60_000).toISOString();
    await f.submit('economical_stop', at, target);
    const restarted = new InstancePowerService(f.repository, f.config as any, f.cloud as any);
    await restarted.processSchedules(new Date(Date.parse(at) + 1000));
    const jobs = (await f.repository.listProvisionJobs()).filter(job => job.jobType === 'economical_stop'); expect(jobs).toHaveLength(2);
    const row = (await f.repository.getRangeInstanceById(f.target.id))!, schedule = row.powerControl!.schedule!;
    await expect(restarted.cancel(target, actor, [{ instanceId: row.id, scheduleId: schedule.id, revision: schedule.revision }])).rejects.toThrow();
    for (const job of jobs) await restarted.execute(await f.claim(job.id), async () => undefined);
    expect(f.cloud.stopEconomical).toHaveBeenCalledTimes(2);
    await restarted.processSchedules(new Date(Date.parse(at) + 2000)); expect((await f.repository.listProvisionJobs()).filter(job => job.jobType === 'economical_stop')).toHaveLength(2);
  }));
  it.each(['missed', 'source', 'disabled', 'destroyed'] as const)('does not execute an unsafe %s appointment', async change => inSpace(async () => {
    const f = await fixture(), at = new Date(Date.now() + 60_000).toISOString(); await f.submit('economical_stop', at);
    if (change === 'source') await f.repository.updateRangeInstance(f.target.id, { resourceSummary: { ...f.instances[0].resourceSummary!, hostIds: { host: 'i-other' } } });
    if (change === 'disabled') await f.repository.updatePlatformUser(actor.id, { status: 'disabled' });
    if (change === 'destroyed') await f.repository.updateRangeInstance(f.target.id, { status: 'destroyed' });
    await f.service.processSchedules(new Date(Date.parse(at) + (change === 'missed' ? 301_000 : 1000)));
    expect((await f.repository.getRangeInstanceById(f.target.id))?.powerControl?.schedule?.status).toBe('failed');
    expect((await f.repository.listProvisionJobs()).filter(job => job.jobType === 'economical_stop')).toHaveLength(0);
  }));
  it('waits for conflicting work only within the due window', async () => inSpace(async () => {
    const f = await fixture(), at = new Date(Date.now() + 60_000).toISOString(); await f.submit('economical_stop', at);
    await f.repository.createProvisionJob({ rangeInstanceId: f.target.id, jobType: 'refresh_status', triggeredBy: actor.id });
    await f.service.processSchedules(new Date(Date.parse(at) + 1000));
    expect((await f.repository.getRangeInstanceById(f.target.id))?.powerControl?.schedule?.status).toBe('scheduled');
    await f.service.processSchedules(new Date(Date.parse(at) + 301_000));
    expect((await f.repository.getRangeInstanceById(f.target.id))?.powerControl?.schedule?.status).toBe('failed');
  }));
  it('does not confuse ordinary stopping with StopCharging', async () => inSpace(async () => {
    const f = await fixture(); f.cloud.stopEconomical.mockImplementation(async (_: any, id: string) => { f.hosts[id].Status = 'Stopped'; return { requestId: 'fallback' }; });
    const accepted = await f.submit(), job = await f.claim(accepted.items[0].jobId!);
    expect(await f.service.execute(job, async () => undefined)).toMatchObject({ failed: true });
    expect((await f.repository.getRangeInstanceById(f.target.id))?.powerControl).toMatchObject({ state: 'stopped_standard' });
    expect((await f.repository.getProvisionJobById(job.id))?.status).toBe('failed');
    await expect(f.submit()).rejects.toThrow('普通停机');
  }));
  it('never sends a second command after an unknown receipt or worker restart; recovery is observe-only', async () => inSpace(async () => {
    const f = await fixture(); f.cloud.stopEconomical.mockRejectedValue(new Error('network fixture-secret NeverPrintThis'));
    const accepted = await f.submit(), id = accepted.items[0].jobId!, job = await f.claim(id);
    expect(await f.service.execute(job, async () => undefined)).toMatchObject({ pending: true });
    const next = await f.claim(id); await f.service.execute(next, async () => undefined);
    expect(f.cloud.stopEconomical).toHaveBeenCalledTimes(1);
    await f.repository.updateProvisionJob(id, { status: 'failed' });
    const current = (await f.repository.getRangeInstanceById(f.target.id))!;
    await f.repository.updateRangeInstance(current.id, { powerControl: { ...current.powerControl!, phase: undefined, state: 'unknown' } });
    await f.service.reconcile(f.target, actor, id); const verify = await f.claim(id);
    expect(await f.service.execute(verify, async () => undefined, true)).toMatchObject({ failed: true });
    expect(f.cloud.stopEconomical).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(await f.service.list(f.target, actor))).not.toContain('fixture-secret');
    f.hosts['i-original-0'].Status = 'Stopped'; f.hosts['i-original-0'].StoppedMode = 'StopCharging';
    await f.service.reconcile(f.target, actor, id); await f.service.execute(await f.claim(id), async () => undefined, true);
    expect((await f.repository.getProvisionJobById(id))?.status).toBe('succeeded');
  }));
  it('reports native stock rejection without automatically creating a replacement', async () => inSpace(async () => {
    const f = await fixture(); const stop = await f.submit(); await f.service.execute(await f.claim(stop.items[0].jobId!), async () => undefined);
    f.cloud.start.mockRejectedValue(new NodeResetCloudError('StartInstance', 'OperationDenied.NoStock', 'safe-request', true));
    const resume = await f.submit('resume'), id = resume.items[0].jobId!;
    await f.service.execute(await f.claim(id), async () => undefined); await f.service.execute(await f.claim(id), async () => undefined);
    expect((await f.repository.getProvisionJobById(id))?.errorSummary).toContain('NoStock');
    expect(f.cloud.start).toHaveBeenCalledTimes(1);
    expect((await f.repository.getRangeInstanceById(f.target.id))?.resourceSummary?.hostIds).toEqual({ host: 'i-original-0' });
  }));
  it('returns no appointment for an immediate resume while retaining completed schedule history', async () => inSpace(async () => {
    const f = await fixture(), at = new Date(Date.now() + 60_000).toISOString();
    await f.submit('economical_stop', at); await f.service.processSchedules(new Date(Date.parse(at) + 1000));
    const stop = (await f.repository.listProvisionJobs()).find(job => job.jobType === 'economical_stop')!;
    await f.service.execute(await f.claim(stop.id), async () => undefined);
    const resume = await f.submit('resume');
    expect(resume).toMatchObject({ status: 'accepted', items: [{ instanceId: f.target.id, scheduledAt: null }] });
    expect(resume.items[0].jobId).toBeTruthy();
    expect((await f.repository.getRangeInstanceById(f.target.id))?.powerControl?.schedule).toMatchObject({ status: 'succeeded', at });
  }));
  it.each(['owner', 'context', 'tags', 'proof', 'expiry', 'active'] as const)('rejects %s before dispatch', async change => inSpace(async () => {
    const f = await fixture();
    if (change === 'owner') await expect(f.service.preview(f.target, 'economical_stop', { id: 'other', role: 'user' })).rejects.toThrow(ForbiddenException);
    else {
      if (change === 'context') f.config.getAccountContextById.mockResolvedValue({ ...account, accountUid: 'different' });
      if (change === 'tags') f.hosts['i-original-0'].Tags.Tag = [];
      if (change === 'proof') await f.repository.updateRangeInstance(f.target.id, { singleInstanceConfig: { ...f.instances[0].singleInstanceConfig!, nativeCreateJobId: 'unknown' } });
      if (change === 'expiry') await f.repository.updateRangeInstance(f.target.id, { expiresAt: new Date(Date.now() + 30_000) });
      if (change === 'active') await f.repository.createProvisionJob({ rangeInstanceId: f.target.id, jobType: 'refresh_status', triggeredBy: actor.id });
      await expect(f.submit()).rejects.toThrow();
    }
    expect(f.cloud.stopEconomical).not.toHaveBeenCalled();
  }));
  it('rejects changed previews and prevents cross-workspace lookup', async () => inSpace(async () => {
    const f = await fixture(), preview = await f.service.preview(f.target, 'economical_stop', actor);
    f.hosts['i-original-0'].VpcAttributes.PrivateIpAddress.IpAddress = ['10.0.10.99'];
    await expect(f.service.submit(f.target, 'economical_stop', actor, preview.planDigest)).rejects.toThrow();
    await runInCloudWorkspace({ ...scope, cloudWorkspaceId: 'foreign' }, async () => expect(f.service.list(f.target, actor)).rejects.toThrow());
  }));
  it('requires the server confirmation challenge and idempotently dispatches one task', async () => inSpace(async () => {
    const f = await fixture(), controller = new InstancePowerController(f.service, new OperationControlService(f.repository));
    const preview = await f.service.preview(f.target, 'economical_stop', actor), body = { action: 'economical_stop', planDigest: preview.planDigest };
    const request: any = { adminUser: actor, authContext: { user: actor, source: 'web', oauthClientId: 'platform-web' }, headers: { 'x-idempotency-key': 'power-once' } };
    let challenge: any; try { await controller.submit(request, 'single', f.target.id, body); } catch (error) { challenge = (error as ConflictException).getResponse(); }
    expect(challenge).toMatchObject({ code: 'CONFIRMATION_REQUIRED', summary: { action: 'economical_stop', instances: [{ id: f.target.id, hostCount: 1 }] } });
    request.headers['x-confirmation-id'] = challenge.confirmationId;
    const result = await controller.submit(request, 'single', f.target.id, body);
    const replay: any = await controller.submit(request, 'single', f.target.id, body);
    expect(replay.result?.items ?? replay.items).toEqual((result as any).items);
    expect((await f.repository.listProvisionJobs()).filter(job => job.jobType === 'economical_stop')).toHaveLength(1);
  }));
  it('keeps read-only scopes out of power previews and mutations', () => {
    expect(() => assertDelegatedApiScopes('GET', '/admin/instance-power/range/r', new Set(['ranges:read']))).not.toThrow();
    expect(() => assertDelegatedApiScopes('GET', '/admin/instance-power/range/r/preview', new Set(['ranges:read']))).toThrow();
    expect(() => assertDelegatedApiScopes('POST', '/admin/instance-power/single/s', new Set(['instances:read']))).toThrow();
  });
  it('resolves range batches from independent launch receipts, not similar names', async () => inSpace(async () => {
    const f = await fixture('range', 2), uuid = '43d86dc7-187a-4e83-9830-a5387c79ffb9';
    const target: PowerTarget = { kind: 'range_batch', id: JSON.stringify([scope.cloudWorkspaceId, actor.id, uuid]) };
    await expect(f.service.list(target, actor)).rejects.toThrow();
    for (let index = 0; index < 2; index++) {
      await f.repository.updateRangeInstance(f.instances[index].id, { name: 'Range-' + (index + 1) });
      const receipt = await f.repository.createIdempotentOperation({ actorUserId: actor.id, toolName: 'web_range_instance_launch', idempotencyKey: uuid + '-' + (index + 1),
        operationId: 'range-launch-' + index, argumentsHash: 'fixture' });
      await f.repository.updateIdempotentOperation(receipt.id, { status: 'succeeded', result: { id: f.instances[index].id } });
    }
    const accepted = await f.submit('economical_stop', undefined, target); expect(accepted.items).toHaveLength(2);
    for (const item of accepted.items) await f.service.execute(await f.claim(item.jobId!), async () => undefined);
    expect(f.cloud.stopEconomical).toHaveBeenCalledTimes(2);
  }));
  it('isolates power failure from creation cleanup, resource release and generic provisioner actions', async () => inSpace(async () => {
    const f = await fixture(), accepted = await f.submit(), job = await f.claim(accepted.items[0].jobId!);
    const before = await f.repository.listBillingLedgerResources(), provisioner = { create: jest.fn(), update: jest.fn(), destroy: jest.fn() };
    jest.spyOn(f.service, 'execute').mockRejectedValue(new Error('POWER_SOURCE_ACCOUNT_CHANGED'));
    const worker = new ProvisioningWorkerService(f.repository, provisioner as any, f.config as any, undefined, undefined, undefined, undefined, undefined, undefined, undefined, f.service);
    await (worker as any).processClaimedJob(job);
    expect((await f.repository.getProvisionJobById(job.id))?.status).toBe('failed');
    expect((await f.repository.getRangeInstanceById(f.target.id))?.status).toBe('running');
    expect(await f.repository.listBillingLedgerResources()).toEqual(before);
    expect(provisioner.create).not.toHaveBeenCalled(); expect(provisioner.destroy).not.toHaveBeenCalled();
  }));
  it('blocks guest changes but never overwrites a superseding destroy', async () => inSpace(async () => {
    const f = await fixture(), accepted = await f.submit(), job = await f.claim(accepted.items[0].jobId!);
    expect(() => assertPowerAllowsMutation(f.instances[0])).not.toThrow();
    expect(() => assertPowerAllowsMutation({ ...f.instances[0], powerControl: { version: 1, state: 'economical_stopped' } })).toThrow();
    const destroy = await f.repository.createProvisionJob({ rangeInstanceId: f.target.id, jobType: 'destroy', triggeredBy: 'system:auto-expire' });
    await f.repository.updateRangeInstance(f.target.id, { status: 'pending_destroy', lastJobId: destroy.id });
    await expect(f.service.execute(job, async () => undefined)).rejects.toThrow();
    await f.service.fail(job, new Error('POWER_SOURCE_CHANGED_OR_EXPIRED'), async () => undefined);
    expect(await f.repository.getRangeInstanceById(f.target.id)).toMatchObject({ status: 'pending_destroy', lastJobId: destroy.id });
    expect((await f.repository.getProvisionJobById(job.id))?.status).toBe('cancelled'); expect(f.cloud.stopEconomical).not.toHaveBeenCalled();
  }));
});

describe('native economical RPC', () => {
  const original = global.fetch; afterEach(() => { global.fetch = original; });
  const response = (body: any) => ({ ok: true, status: 200, json: async () => body }) as Response;
  it('uses graceful StopCharging only and validates the original request receipt', async () => {
    global.fetch = jest.fn(async (url: any) => { const query = new URL(String(url)).searchParams;
      expect(query.get('Action')).toBe('StopInstance'); expect(query.get('StoppedMode')).toBe('StopCharging'); expect(query.get('ForceStop')).toBe('false');
      expect(query.get('InstanceId')).toBe('i-original'); return response({ RequestId: 'safe-request' }); });
    expect(await new InstancePowerCloudClient().stopEconomical(account, 'i-original')).toEqual({ requestId: 'safe-request' });
    global.fetch = jest.fn(async () => response({})); await expect(new InstancePowerCloudClient().stopEconomical(account, 'i-original')).rejects.toThrow('POWER_RECEIPT_UNVERIFIED');
    global.fetch = jest.fn(async () => response({ RequestId: account.accessKeySecret }));
    await expect(new InstancePowerCloudClient().stopEconomical(account, 'i-original')).rejects.toThrow('POWER_RECEIPT_UNVERIFIED');
  });
  it.each(['PrePaid', 'classic', 'local', 'persistent', 'missing', 'malformed', 'supported'])('validates live support: %s', async variant => {
    const details: any = { InstanceTypeId: 'ecs.e-c1m1.large', InstanceTypeFamily: 'ecs.e-c1m1', LocalStorageAmount: 0 };
    if (variant === 'local') details.LocalStorageAmount = 1;
    if (variant === 'persistent') details.InstanceTypeFamily = 'ecs.re6p';
    if (variant === 'missing') delete details.LocalStorageAmount;
    if (variant === 'malformed') details.LocalStorageAmount = 'unknown';
    global.fetch = jest.fn(async () => response({ InstanceTypes: { InstanceType: [details] } }));
    const result = new InstancePowerCloudClient().assertEconomicalSupported(account, { InstanceChargeType: variant === 'PrePaid' ? 'PrePaid' : 'PostPaid',
      InstanceNetworkType: variant === 'classic' ? 'classic' : 'vpc', InstanceType: 'ecs.e-c1m1.large' });
    if (['supported', 'missing'].includes(variant)) await expect(result).resolves.toBeUndefined(); else await expect(result).rejects.toThrow('POWER_');
  });
  it('exhausts type token pages instead of treating a token as an unsupported type', async () => {
    const fetcher = jest.fn(async (url: any) => {
      const token = new URL(String(url)).searchParams.get('NextToken');
      return response({ InstanceTypes: { InstanceType: token ? [] : [{ InstanceTypeId: 'ecs.e-c1m1.large', InstanceTypeFamily: 'ecs.e' }] }, NextToken: token ? '' : 'page-two' });
    }); global.fetch = fetcher;
    await new InstancePowerCloudClient().assertEconomicalSupported(account, { InstanceChargeType: 'PostPaid', InstanceNetworkType: 'vpc', InstanceType: 'ecs.e-c1m1.large' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
