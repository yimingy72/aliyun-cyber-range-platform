import { ConflictException } from '@nestjs/common';
import { InstanceExpiryService } from '../src/admin/instance-expiry.service';
import { InstanceExpiryController } from '../src/admin/instance-expiry.controller';
import { InstancePowerCloudClient } from '../src/admin/instance-power-cloud';
import { OperationControlService } from '../src/operations/operation-control.service';
import { AliyunImageRpcError } from '../src/admin/aliyun-image-rpc';
import { assertDelegatedApiScopes } from '../src/auth/delegated-api-scopes';
import { runInCloudWorkspace } from '../src/auth/cloud-workspace-scope';
import { ProvisioningWorkerService } from '../src/provisioning/provisioning-worker.service';
import { verifiedExpiryEdit } from '../src/admin/instance-expiry-types';
import type { PowerTarget } from '../src/admin/instance-power-types';
import { fixture, actor, scope, inSpace, account } from './support/instance-control-fixture';

const later = (minutes = 120) => new Date(Math.ceil((Date.now() + minutes * 60_000) / 60_000) * 60_000).toISOString();
async function setup(mode: 'single' | 'range' = 'single', quantity = 1) {
  const f = await fixture(mode, quantity);
  const cloud = { ...f.cloud, modifyReleaseTime: jest.fn(async (_account: unknown, id: string, at: string) => {
    f.hosts[id].AutoReleaseTime = at; return { requestId: 'expiry-receipt' };
  }) };
  const service = new InstanceExpiryService(f.repository, f.service, f.config as any, cloud as any);
  const submit = async (at = later(), target = f.target) => {
    const preview = await service.preview(target, actor, at);
    return service.submit(target, actor, at, preview.planDigest);
  };
  return { ...f, cloud, expiry: service, submit };
}

describe('instance expiry edits', () => {
  it.each(['single', 'range'] as const)('extends %s only after native verification without recreating or releasing anything', async mode => inSpace(async () => {
    const f = await setup(mode), at = later(), before = await f.repository.listBillingLedgerResources();
    const result = await f.submit(at), job = await f.claim(result.items[0].jobId);
    expect((await f.repository.getRangeInstanceById(f.target.id))?.expiresAt).toEqual(f.instances[0].expiresAt);
    await f.expiry.execute(job, async () => undefined);
    const updated = await f.repository.getRangeInstanceById(f.target.id);
    expect(updated?.expiresAt?.toISOString()).toBe(at);
    expect(updated?.status).toBe('running');
    expect(updated?.resourceSummary?.hostIds).toEqual(f.instances[0].resourceSummary?.hostIds);
    expect(updated?.resourceSummary?.cloudReleaseDeadlines?.host).toMatchObject({ platformExpiresAt: at, status: 'verified', instanceId: 'i-original-0' });
    expect((await f.repository.getProvisionJobById(job.id))?.status).toBe('succeeded');
    expect(await verifiedExpiryEdit(f.repository, updated!)).toBeTruthy();
    expect(await f.repository.listBillingLedgerResources()).toEqual(before);
    expect(f.cloud.start).not.toHaveBeenCalled(); expect(f.cloud.stopEconomical).not.toHaveBeenCalled();
    expect(f.cloud.modifyReleaseTime).toHaveBeenCalledTimes(1);
  }));
  it('shortens the platform deadline at acceptance so partial cloud sync cannot retain resources beyond the requested time', async () => inSpace(async () => {
    const f = await setup(), at = later(40), result = await f.submit(at);
    expect((await f.repository.getRangeInstanceById(f.target.id))?.expiresAt?.toISOString()).toBe(at);
    f.cloud.modifyReleaseTime.mockRejectedValueOnce(new AliyunImageRpcError('ModifyInstanceAutoReleaseTime', 'Forbidden.RAM', 403, 'req-denied'));
    const job = await f.claim(result.items[0].jobId);
    try { await f.expiry.execute(job, async () => undefined); } catch (error) { await f.expiry.fail(job, error); }
    expect((await f.repository.getRangeInstanceById(f.target.id))?.expiresAt?.toISOString()).toBe(at);
    expect(await f.repository.getProvisionJobById(job.id)).toMatchObject({ status: 'failed', errorSummary: expect.stringContaining('Forbidden.RAM') });
    expect(await verifiedExpiryEdit(f.repository, (await f.repository.getRangeInstanceById(f.target.id))!)).toBeTruthy();
  }));
  it('allows stopped instances without starting them', async () => inSpace(async () => {
    const f = await setup();
    f.hosts['i-original-0'].Status = 'Stopped'; f.hosts['i-original-0'].StoppedMode = 'StopCharging';
    await f.repository.updateRangeInstance(f.target.id, { powerControl: { version: 1, state: 'economical_stopped' } });
    const result = await f.submit(); await f.expiry.execute(await f.claim(result.items[0].jobId), async () => undefined);
    expect(f.cloud.start).not.toHaveBeenCalled();
    expect((await f.repository.getRangeInstanceById(f.target.id))?.powerControl?.state).toBe('economical_stopped');
  }));
  it.each(['single_batch', 'range_batch'] as const)('queues every actual member of %s, with independent completion', async kind => inSpace(async () => {
    const f = await setup(kind === 'single_batch' ? 'single' : 'range', 2);
    let target: PowerTarget = { kind, id: f.batch.id };
    if (kind === 'range_batch') {
      const uuid = '43d86dc7-187a-4e83-9830-a5387c79ffb9';
      target = { kind, id: JSON.stringify([scope.cloudWorkspaceId, actor.id, uuid]) };
      for (let index = 0; index < 2; index++) {
        await f.repository.updateRangeInstance(f.instances[index].id, { name: 'Range-' + (index + 1) });
        const receipt = await f.repository.createIdempotentOperation({ actorUserId: actor.id, toolName: 'web_range_instance_launch',
          idempotencyKey: uuid + '-' + (index + 1), operationId: 'expiry-launch-' + index, argumentsHash: 'fixture' });
        await f.repository.updateIdempotentOperation(receipt.id, { status: 'succeeded', result: { id: f.instances[index].id } });
      }
    }
    const result = await f.submit(later(), target); expect(result.items).toHaveLength(2);
    for (const item of result.items) await f.expiry.execute(await f.claim(item.jobId), async () => undefined);
    expect(f.cloud.modifyReleaseTime).toHaveBeenCalledTimes(2);
  }));
  it('does not resubmit unknown native writes, and can verify their original job', async () => inSpace(async () => {
    const f = await setup(), at = later();
    f.cloud.modifyReleaseTime.mockRejectedValueOnce(new Error('lost response'));
    const accepted = await f.submit(at), job = await f.claim(accepted.items[0].jobId);
    await f.expiry.execute(job, async () => undefined);
    const again = await f.claim(job.id);
    await f.expiry.execute({ ...again, createdAt: new Date(Date.now() - 6 * 60_000) }, async () => undefined).catch(error => f.expiry.fail(again, error));
    expect(f.cloud.modifyReleaseTime).toHaveBeenCalledTimes(1);
    expect((await f.repository.getRangeInstanceById(f.target.id))?.expiresAt).toEqual(f.instances[0].expiresAt);
    await expect(f.expiry.preview(f.target, actor, later(180))).rejects.toThrow('核验原任务');
    f.hosts['i-original-0'].AutoReleaseTime = job.topologySnapshot!.expiryPlan!.cloudReleaseAt;
    await f.expiry.verify(f.target, actor, job.id);
    await f.expiry.execute(await f.claim(job.id), async () => undefined);
    expect((await f.repository.getRangeInstanceById(f.target.id))?.expiresAt?.toISOString()).toBe(at);
    expect(f.cloud.modifyReleaseTime).toHaveBeenCalledTimes(1);
  }));
  it('keeps an extension unchanged when native verification or ownership fails', async () => inSpace(async () => {
    const f = await setup(), accepted = await f.submit(), job = await f.claim(accepted.items[0].jobId);
    f.hosts['i-original-0'].Tags.Tag.find((row: any) => row.TagKey === 'PlatformUserId').TagValue = 'someone-else';
    await expect(f.expiry.execute(job, async () => undefined)).rejects.toThrow('来源');
    expect(f.cloud.modifyReleaseTime).not.toHaveBeenCalled();
    expect((await f.repository.getRangeInstanceById(f.target.id))?.expiresAt).toEqual(f.instances[0].expiresAt);
  }));
  it.each(['pending_destroy', 'destroying', 'destroy_failed', 'destroyed', 'creating'] as const)('rejects %s instead of reviving the instance', async status => inSpace(async () => {
    const f = await setup(); await f.repository.updateRangeInstance(f.target.id, { status });
    await expect(f.submit()).rejects.toThrow();
    expect(f.cloud.modifyReleaseTime).not.toHaveBeenCalled();
  }));
  it('requires cancelling an existing economical stop appointment explicitly', async () => inSpace(async () => {
    const f = await setup(); await f.service.submit(f.target, 'economical_stop', actor,
      (await f.service.preview(f.target, 'economical_stop', actor, later(10))).planDigest, later(10));
    await expect(f.submit()).rejects.toThrow('先取消预约');
    expect((await f.repository.getRangeInstanceById(f.target.id))?.powerControl?.schedule?.status).toBe('scheduled');
  }));
  it.each(['2020-01-01T00:00:00Z', '2099-01-01T00:00:00Z', '2027-01-01T08:00', '2027-02-30T08:00:00Z', 'bad'])('rejects unsafe or timezone-less time %s', async at => inSpace(async () => {
    const f = await setup(); await expect(f.submit(at)).rejects.toThrow();
  }));
  it('rejects a near-expiry instance even when requesting a far-future time', async () => inSpace(async () => {
    const f = await setup(); await f.repository.updateRangeInstance(f.target.id, { expiresAt: new Date(Date.now() + 2 * 60_000) });
    await expect(f.submit()).rejects.toThrow('不足 5 分钟');
  }));
  it('blocks cross-owner, cross-space and historical read-only writes', async () => inSpace(async () => {
    const f = await setup();
    await expect(f.expiry.preview(f.target, { ...actor, id: 'foreign' }, later())).rejects.toThrow();
    await expect(runInCloudWorkspace({ ...scope, cloudWorkspaceId: 'foreign' }, () => f.expiry.preview(f.target, actor, later()))).rejects.toThrow();
    await expect(runInCloudWorkspace({ ...scope, isReadOnly: true }, () => f.submit())).rejects.toThrow();
  }));
  it('rejects stale previews without changing any expiry', async () => inSpace(async () => {
    const f = await setup(), at = later(), preview = await f.expiry.preview(f.target, actor, at);
    await f.repository.updateRangeInstance(f.target.id, { name: 'changed' });
    await expect(f.expiry.submit(f.target, actor, at, preview.planDigest)).rejects.toThrow('变化');
    expect((await f.repository.listProvisionJobs()).filter(job => job.jobType === 'change_expiry')).toHaveLength(0);
  }));
  it('requires confirmation and replays the same operation without another task', async () => inSpace(async () => {
    const f = await setup(), controller = new InstanceExpiryController(f.expiry, f.service, new OperationControlService(f.repository));
    const at = later(), preview = await f.expiry.preview(f.target, actor, at), body = { expiresAt: at, planDigest: preview.planDigest };
    const request: any = { adminUser: actor, authContext: { user: actor, source: 'web', oauthClientId: 'platform-web' }, headers: { 'x-idempotency-key': 'expiry-once' } };
    let challenge: any;
    try { await controller.submit(request, 'single', f.target.id, body); } catch (error) { challenge = (error as ConflictException).getResponse(); }
    expect(challenge).toMatchObject({ code: 'CONFIRMATION_REQUIRED', summary: { expiresAt: at, planDigest: preview.planDigest } });
    request.headers['x-confirmation-id'] = challenge.confirmationId;
    await controller.submit(request, 'single', f.target.id, body); await controller.submit(request, 'single', f.target.id, body);
    expect((await f.repository.listProvisionJobs()).filter(job => job.jobType === 'change_expiry')).toHaveLength(1);
  }));
  it('uses control scopes for previews/submissions and read scopes for task history', () => {
    for (const [kind, prefix] of [['single', 'instances'], ['single_batch', 'instances'], ['range', 'ranges'], ['range_batch', 'ranges']]) {
      expect(() => assertDelegatedApiScopes('GET', '/admin/instance-expiry/' + kind + '/id', new Set([prefix + ':read']))).not.toThrow();
      expect(() => assertDelegatedApiScopes('POST', '/admin/instance-expiry/' + kind + '/id', new Set([prefix + ':read']))).toThrow();
      expect(() => assertDelegatedApiScopes('GET', '/admin/instance-expiry/' + kind + '/id/preview', new Set([prefix + ':control']))).not.toThrow();
    }
  });
  it('routes failure through expiry handling, never creation cleanup', async () => inSpace(async () => {
    const f = await setup(), accepted = await f.submit(), job = await f.claim(accepted.items[0].jobId);
    jest.spyOn(f.expiry, 'execute').mockRejectedValueOnce(new Error('expiry test'));
    const provisioner = { create: jest.fn(), update: jest.fn(), destroy: jest.fn() };
    const worker = new ProvisioningWorkerService(f.repository, provisioner as any, f.config as any,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, f.service, f.expiry);
    await (worker as any).processClaimedJob(job);
    expect((await f.repository.getProvisionJobById(job.id))?.status).toBe('failed');
    expect((await f.repository.getRangeInstanceById(f.target.id))?.status).toBe('running');
    expect(provisioner.destroy).not.toHaveBeenCalled();
  }));
  it('cannot overwrite a superseding destroy or a lost worker claim', async () => inSpace(async () => {
    const f = await setup(), accepted = await f.submit(), job = await f.claim(accepted.items[0].jobId);
    await expect(f.expiry.execute(job, async () => { throw new Error('claim lost'); })).rejects.toThrow('claim lost');
    const destroy = await f.repository.createProvisionJob({ rangeInstanceId: f.target.id, jobType: 'destroy', triggeredBy: 'fixture' });
    await f.repository.updateRangeInstance(f.target.id, { status: 'pending_destroy', lastJobId: destroy.id });
    await f.expiry.fail(job, new Error('failed'));
    expect((await f.repository.getRangeInstanceById(f.target.id))?.lastJobId).toBe(destroy.id);
    expect(f.cloud.modifyReleaseTime).not.toHaveBeenCalled();
  }));
});

describe('native deadline RPC', () => {
  afterEach(() => jest.restoreAllMocks());
  it('sends only the exact existing ECS and nonempty UTC deadline', async () => {
    const fetcher = jest.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({ RequestId: 'expiry-request' }), { status: 200 }));
    const at = later().replace('.000Z', 'Z');
    await new InstancePowerCloudClient().modifyReleaseTime(account as any, 'i-original', at);
    const query = new URL(String(fetcher.mock.calls[0][0])).searchParams;
    expect(query.get('Action')).toBe('ModifyInstanceAutoReleaseTime'); expect(query.get('InstanceId')).toBe('i-original');
    expect(query.get('AutoReleaseTime')).toBe(at);
    await expect(new InstancePowerCloudClient().modifyReleaseTime(account as any, 'i-original', '')).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
