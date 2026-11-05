import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ADMIN_REPOSITORY, type AdminRepository, type ProvisionJobRecord, type RangeInstanceRecord, type UpdateRangeInstanceInput } from './admin.repository';
import type { SessionUserProfile } from './admin-user-auth';
import { getCurrentCloudWorkspaceId, requireCurrentCloudWorkspaceId, runInSystemCloudWorkspaceScope } from '../auth/cloud-workspace-scope';
import { runInExecutionCloudWorkspace } from '../auth/background-cloud-workspace';
import { SystemConfigService, type SystemCloudAccountContext } from './system-config.service';
import { InstancePowerCloudClient } from './instance-power-cloud';
import { rangeLaunchBatches } from './range-launch-batches';
import { readProvenSingleInstanceIds } from './single-instance-resource-origin';
import { readPatrolInventories } from './resource-patrol-inventory';
import { AliyunImageRpcError } from './aliyun-image-rpc';
import { NodeResetCloudError } from './range-node-reset-cloud.client';
import { isPowerJob, POWER_WARNINGS, powerHash, powerSourceDigest, publicPowerControl, type InstancePowerControl, type PowerAction, type PowerHost, type PowerHostFact, type PowerPlan, type PowerTarget } from './instance-power-types';

type Actor = Pick<SessionUserProfile, 'id' | 'role'>;
const active = (job: ProvisionJobRecord) => ['pending', 'running'].includes(job.status);
const emptyControl = (): InstancePowerControl => ({ version: 1, state: 'running' });
const sorted = (values: string[]) => [...values].sort();
const snapshot = (plan: PowerPlan) => ({ draftRevision: 0, topologyGraph: {}, topologySpec: {}, scenarioTemplateSpec: {}, compiledProvisionSpec: {}, compiledSpec: {}, templateModulePath: '', powerPlan: plan });

@Injectable()
export class InstancePowerService {
  constructor(@Inject(ADMIN_REPOSITORY) private readonly repository: AdminRepository,
    private readonly config: SystemConfigService, private readonly cloud: InstancePowerCloudClient) {}

  validateTarget(kind: string, id: string): PowerTarget {
    if (!['single', 'single_batch', 'range', 'range_batch'].includes(kind) || !id || id.length > 1024 || /[\x00-\x1f\x7f]/.test(id))
      throw new BadRequestException('电源目标必须是准确的实例或批次。');
    return { kind: kind as PowerTarget['kind'], id };
  }

  validateAction(action: unknown): asserts action is PowerAction {
    if (action !== 'economical_stop' && action !== 'resume') throw new BadRequestException('只支持节省停机或恢复原实例。');
  }

  private runAt(value?: string) {
    if (value === undefined) return null;
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
      || !Number.isFinite(Date.parse(value)) || Date.parse(value) <= Date.now()) throw new BadRequestException('预约必须是带时区的有效未来时间。');
    return new Date(value).toISOString();
  }

  async targets(target: PowerTarget, actor: Actor) {
    let rows: RangeInstanceRecord[];
    if (target.kind === 'single_batch') {
      const batch = await this.repository.getSingleInstanceBatchWithInstancesById(target.id);
      if (!batch) throw new NotFoundException('实例批次不存在。');
      rows = batch.instances;
    } else if (target.kind === 'range_batch') {
      const all = (await this.repository.listRangeInstances()).filter(row => row.instanceMode === 'range');
      const batches = rangeLaunchBatches(all, await this.repository.listRangeLaunchReceipts(all.map(row => row.id)));
      rows = all.filter(row => batches.get(row.id)?.id === target.id);
    } else {
      const row = await this.repository.getRangeInstanceById(target.id);
      rows = row && row.instanceMode === target.kind ? [row] : [];
    }
    if (!rows.length) throw new NotFoundException('实例或已核验的批次不存在。');
    if (rows.some(row => (row.cloudWorkspaceId ?? 'legacy-unbound') !== (getCurrentCloudWorkspaceId() ?? 'legacy-unbound')
      || actor.role !== 'admin' && row.ownerUserId !== actor.id)) throw new ForbiddenException('无权操作该账号空间或批次。');
    return rows;
  }

  async list(target: PowerTarget, actor: Actor) {
    const rows = await this.targets(target, actor), ids = new Set(rows.map(row => row.id));
    const jobs = (await this.repository.listProvisionJobs()).filter(job => ids.has(job.rangeInstanceId) && isPowerJob(job));
    return { instances: rows.map(row => ({ id: row.id, name: row.name, status: row.status, powerControl: publicPowerControl(row.powerControl) })),
      jobs: await Promise.all(jobs.slice(0, 100).map(async job => ({ id: job.id, rangeInstanceId: job.rangeInstanceId, action: job.jobType,
        status: job.status, error: job.errorSummary, createdAt: job.createdAt, startedAt: job.startedAt, finishedAt: job.finishedAt,
        steps: (await this.repository.listProvisionJobStepLogs(job.id)).filter(step => step.stepName.startsWith('power_')).map(step => ({ name: step.stepName, status: step.status, message: step.message, createdAt: step.createdAt })) }))),
      warnings: POWER_WARNINGS };
  }

  async preview(target: PowerTarget, action: PowerAction, actor: Actor, scheduledAt?: string) {
    this.validateAction(action);
    if (action === 'resume' && scheduledAt !== undefined) throw new BadRequestException('恢复开机暂不支持预约，不会隐式添加自动开机。');
    const at = this.runAt(scheduledAt), all = await this.targets(target, actor);
    const skipped = all.filter(row => ['destroyed', 'create_failed'].includes(row.status)).map(row => ({ id: row.id, name: row.name, reason: '已回收或创建失败，不属于本次停机目标' }));
    const rows = all.filter(row => !skipped.some(skip => skip.id === row.id));
    if (!rows.length) throw new ConflictException('本次没有可操作的存量实例。');
    const plans: PowerPlan[] = [];
    for (const row of rows) {
      try { plans.push(await this.prepare(row, target, action, at)); }
      catch (error) { if (error instanceof ConflictException) throw error; throw new ConflictException(this.failure(error)); }
    }
    const version = rows.map(row => ({ id: row.id, updatedAt: row.updatedAt.toISOString(), schedule: row.powerControl?.schedule ? { id: row.powerControl.schedule.id, revision: row.powerControl.schedule.revision } : null }));
    const planDigest = powerHash({ target, action, at, plans, version });
    return { target, action, scheduledAt: at, planDigest, plans, skipped, sourceVersions: version, warnings: POWER_WARNINGS,
      replacingSchedule: rows.some(row => row.powerControl?.schedule?.status === 'scheduled') };
  }

  async submit(target: PowerTarget, action: PowerAction, actor: Actor, planDigest: string, scheduledAt?: string) {
    const preview = await this.preview(target, action, actor, scheduledAt);
    if (preview.planDigest !== planDigest) throw new ConflictException('实例、来源或预约已变化，请重新预览并确认。');
    return this.repository.withSingleInstanceControlLock(async () => {
      const refreshed = await this.targets(target, actor), byId = new Map(refreshed.map(row => [row.id, row]));
      const changed: Array<{ instanceId: string; jobId: string | null; scheduledAt: string | null }> = [];
      // Commit all selected members or none; cloud execution remains per-instance and reports partial failures.
      return this.repository.withSingleInstanceTransaction(async tx => {
        for (const plan of preview.plans) {
          const row = byId.get(plan.instanceId);
          if (!row || row.status !== 'running' || powerSourceDigest(row) !== plan.sourceDigest
            || row.updatedAt.toISOString() !== preview.sourceVersions.find(version => version.id === row.id)?.updatedAt) throw new ConflictException('实例来源发生变化。');
          const control = { ...(row.powerControl ?? emptyControl()) };
          let result;
          if (preview.scheduledAt) {
            const old = control.schedule;
            control.schedule = { id: old?.status === 'scheduled' ? old.id : randomUUID(), revision: old?.status === 'scheduled' ? old.revision + 1 : 1,
              at: preview.scheduledAt, triggeredBy: actor.id, createdAt: old?.status === 'scheduled' ? old.createdAt : new Date().toISOString(),
              updatedAt: new Date().toISOString(), status: 'scheduled', plan };
            result = await tx.saveInstancePowerControl(row.id, row.updatedAt, control);
          } else {
            if (control.schedule?.status === 'scheduled') throw new ConflictException('已有未来预约，请先明确修改或取消该预约。');
            control.phase = action === 'economical_stop' ? 'stopping' : 'starting'; control.error = null;
            result = await tx.saveInstancePowerControl(row.id, row.updatedAt, control, { rangeInstanceId: row.id, jobType: action, triggeredBy: actor.id, topologySnapshot: snapshot(plan) });
          }
          if (!result) throw new ConflictException('实例已被其他操作更新，未提交本次任务。');
          changed.push({ instanceId: row.id, jobId: result.job?.id ?? null, scheduledAt: preview.scheduledAt });
        }
        return { status: preview.scheduledAt ? 'scheduled' : 'accepted', items: changed };
      });
    });
  }

  async cancel(target: PowerTarget, actor: Actor, expected: Array<{ instanceId: string; scheduleId: string; revision: number }>) {
    if (!Array.isArray(expected) || !expected.length || expected.length > 99 || new Set(expected.map(row => row.instanceId)).size !== expected.length) throw new BadRequestException('取消预约必须包含准确实例、预约 ID 及版本。');
    return this.repository.withSingleInstanceControlLock(async () => {
      const rows = await this.targets(target, actor), byId = new Map(rows.map(row => [row.id, row]));
      return this.repository.withSingleInstanceTransaction(async tx => {
        for (const item of expected) {
          const row = byId.get(item.instanceId), schedule = row?.powerControl?.schedule;
          if (!row || schedule?.status !== 'scheduled' || schedule.id !== item.scheduleId || schedule.revision !== item.revision) throw new ConflictException('预约已变化或开始执行，不能报告已取消。');
          const control = { ...row.powerControl!, schedule: { ...schedule, status: 'cancelled' as const, revision: schedule.revision + 1, updatedAt: new Date().toISOString(), message: '用户已取消预约' } };
          if (!await tx.saveInstancePowerControl(row.id, row.updatedAt, control)) throw new ConflictException('取消预约发生并发冲突，请刷新。');
        }
        return { status: 'cancelled', instanceIds: expected.map(row => row.instanceId) };
      });
    });
  }

  async reconcile(target: PowerTarget, actor: Actor, jobId: string) {
    return this.repository.withSingleInstanceControlLock(async () => {
      const rows = await this.targets(target, actor), job = await this.repository.getProvisionJobById(jobId);
      const row = job && rows.find(source => source.id === job.rangeInstanceId);
      if (!row || !job || !isPowerJob(job) || !job.topologySnapshot?.powerPlan) throw new NotFoundException('原电源任务不存在或不属于此目标。');
      if (active(job)) return { status: 'processing', jobId: job.id };
      if (job.status !== 'failed') return { status: job.status, jobId: job.id };
      if (row.status !== 'running' || row.lastJobId !== job.id || row.powerControl?.jobId !== job.id) throw new ConflictException('实例已进入其他操作，不能恢复旧任务。');
      return this.repository.withSingleInstanceTransaction(async tx => {
        const current = await tx.getProvisionJobById(job.id);
        if (current?.status !== 'failed' || current.updatedAt.getTime() !== job.updatedAt.getTime()) throw new ConflictException('原任务已变化，请刷新。');
        await tx.updateProvisionJob(job.id, { status: 'pending', startedAt: null, finishedAt: null, availableAt: new Date(),
          topologySnapshot: { ...job.topologySnapshot!, powerObserveOnly: true } });
        const control: InstancePowerControl = { ...row.powerControl!, phase: job.jobType === 'economical_stop' ? 'stopping' : 'starting', error: null };
        if (!await tx.saveInstancePowerControl(row.id, row.updatedAt, control)) throw new ConflictException('原任务核验发生并发冲突。');
        return { status: 'accepted', jobId: job.id, observeOnly: true };
      });
    });
  }

  private async prepare(row: RangeInstanceRecord, target: PowerTarget, action: PowerAction, at: string | null): Promise<PowerPlan> {
    if (row.status !== 'running' || row.cloudProvider !== 'alibaba_cloud' || !row.ownerUserId || !['opentofu', 'ecs-native'].includes(row.resourceSummary?.mode ?? ''))
      throw new ConflictException('节省停机只支持已创建的阿里云存量实例；不支持 dry-run、腾讯云或正在销毁的实例。');
    if (row.expiresAt && row.expiresAt.getTime() <= (at ? Date.parse(at) : Date.now()) + 60_000) throw new ConflictException('操作或预约必须在原到期销毁时间至少一分钟前。');
    const jobs = await this.repository.listProvisionJobs();
    if (jobs.some(job => job.rangeInstanceId === row.id && active(job))) throw new ConflictException('实例有活动任务，请等待完成后操作。');
    if (row.powerControl?.phase || row.powerControl?.state === 'unknown') throw new ConflictException('上次电源操作尚未确认，请先核验原任务。');
    if ((await this.repository.listPackedImageArtifacts()).some(pack => pack.sourceRangeInstanceId === row.id && ['pending', 'creating', 'deleting'].includes(pack.status))) throw new ConflictException('实例存在未结束的镜像任务，不能同时停机或开机。');
    const source = row.instanceMode === 'single' ? row.singleInstanceConfig : row.resourceSummary!.executionContext;
    if (!source?.cloudAccountContextId || !source.cloudAccountUid || !source.regionId) throw new ConflictException('缺少原冻结云账号和地域，不能猜用当前账号。');
    const plan: PowerPlan = { version: 1, target, instanceId: row.id, instanceName: row.name, instanceMode: row.instanceMode,
      cloudWorkspaceId: requireCurrentCloudWorkspaceId(), ownerUserId: row.ownerUserId, cloudAccountContextId: source.cloudAccountContextId,
      accountUid: source.cloudAccountUid, regionId: source.regionId, sourceDigest: powerSourceDigest(row), expiresAt: row.expiresAt?.toISOString() ?? null,
      hosts: [], previousJobId: row.lastJobId };
    const account = await this.account(row, plan); await this.cloud.verifyAccount(account);
    const ids = row.resourceSummary!.hostIds ?? {};
    if (!Object.keys(ids).length || row.instanceMode === 'single' && Object.keys(ids).length !== 1) throw new ConflictException('缺少准确的已部署主机清单。');
    const proven = row.instanceMode === 'single' ? await readProvenSingleInstanceIds(this.repository, row) : null;
    const inventories = row.instanceMode === 'range' ? await readPatrolInventories(this.repository, [row], jobs,
      { provider: 'alibaba_cloud', accountUid: source.cloudAccountUid, cloudWorkspaceId: plan.cloudWorkspaceId }) : [];
    for (const [nodeId, instanceId] of Object.entries(ids)) {
      const inventory = inventories.find(item => item.context.cloudAccountContextId === source.cloudAccountContextId && item.context.regionId === source.regionId && item.proven.has('ecs:' + instanceId));
      const sourceJobId = row.instanceMode === 'single' ? row.singleInstanceConfig?.opentofuCreateJobId ?? row.singleInstanceConfig?.nativeCreateJobId : inventory?.birthSources.get('ecs:' + instanceId);
      if (!sourceJobId || proven && !proven.has(instanceId) || row.instanceMode === 'range' && !inventory) throw new ConflictException('主机缺少同来源创建证明，不能仅凭标签执行电源操作。');
      const host = await this.cloud.host(account, instanceId), tags = this.cloud.tags(host);
      const tagJobId = tags.PlatformCreateJobId;
      if (!jobs.some(job => job.id === tagJobId && job.rangeInstanceId === row.id && job.cloudWorkspaceId === row.cloudWorkspaceId && ['create', 'retry', 'update'].includes(job.jobType))) throw new Error('POWER_TAG_JOB_UNVERIFIED');
      this.assertTags(row, instanceId, host, plan);
      if (!['Running', 'Stopped'].includes(host.Status)) throw new ConflictException('主机电源正在变化，请稍后重新核验。');
      if (action === 'economical_stop') {
        if (host.Status === 'Stopped' && host.StoppedMode !== 'StopCharging') throw new ConflictException('存在普通停机的主机，请先恢复开机，再明确执行节省停机。');
        await this.cloud.assertEconomicalSupported(account, host);
      }
      if (host.AutoReleaseTime && Date.parse(host.AutoReleaseTime) <= (at ? Date.parse(at) : Date.now()) + 60_000) throw new ConflictException('操作或预约晚于原云端自动释放期限。');
      const disks = await this.cloud.disks(account, instanceId);
      if (!disks.length || disks.some(disk => disk.InstanceId !== instanceId || !['system', 'data'].includes(disk.Type))) throw new Error('POWER_DISK_BINDINGS_UNVERIFIED');
      const nodes = (row.runtimeTopologyGraph as { nodes?: Array<{ id: string; label?: string }> } | null)?.nodes;
      plan.hosts.push({ nodeId, name: nodes?.find(node => node.id === nodeId)?.label ?? row.name, instanceId, sourceJobId, tagJobId,
        autoReleaseTime: host.AutoReleaseTime ?? null,
        networkDigest: this.cloud.networkDigest(host), diskIds: sorted(disks.map(disk => disk.DiskId)), originalStatus: host.Status, originalStoppedMode: host.StoppedMode ?? null });
    }
    return plan;
  }

  private async account(row: RangeInstanceRecord, plan: PowerPlan) {
    const account = await this.config.getAccountContextById(plan.cloudAccountContextId);
    if (account.provider !== 'alibaba_cloud' || !account.accountUidResolved || account.cloudAccountContextId !== plan.cloudAccountContextId
      || account.accountUid !== plan.accountUid || account.defaultRegion !== plan.regionId || powerSourceDigest(row) !== plan.sourceDigest
      || row.ownerUserId !== plan.ownerUserId || row.cloudWorkspaceId !== plan.cloudWorkspaceId) throw new Error('POWER_SOURCE_ACCOUNT_CHANGED');
    return account;
  }

  private assertTags(row: RangeInstanceRecord, id: string, host: Record<string, any>, plan: PowerPlan, target?: PowerHost) {
    const tags = this.cloud.tags(host);
    if (host.InstanceId !== id || tags.CreatedBy !== 'cyber-range-platform' || tags.RangeInstanceId !== row.id
      || tags.PlatformUserId !== plan.ownerUserId || target && tags.PlatformCreateJobId !== target.tagJobId) throw new Error('POWER_CLOUD_OWNER_CHANGED');
  }

  async processSchedules(now = new Date()) {
    const rows = await runInSystemCloudWorkspaceScope(() => this.repository.listDuePowerSchedules(now));
    for (const row of rows.filter(item => item.powerControl?.schedule?.status === 'scheduled')) {
      const plan = row.powerControl!.schedule!.plan;
      await runInExecutionCloudWorkspace(this.config, row.cloudWorkspaceId, async () => {
        await this.repository.withSingleInstanceControlLock(async () => {
          const current = await this.repository.getRangeInstanceById(row.id), schedule = current?.powerControl?.schedule;
          if (!current || schedule?.id !== row.powerControl!.schedule!.id || schedule.status !== 'scheduled') return;
          let reason: string | null = null;
          if (current.status !== 'running') reason = '实例已进入创建、销毁或归档状态，预约不再执行。';
          else if (current.expiresAt && current.expiresAt <= now) reason = '原到期时间已到，按原销毁流程处理，不再停机。';
          else if (powerSourceDigest(current) !== schedule.plan.sourceDigest) reason = '已部署主机或来源发生变化，预约未执行；请重新设置。';
          const actor = await this.repository.getPlatformUserById(schedule.triggeredBy);
          if (!actor || actor.status !== 'active' || actor.role !== 'admin' && actor.id !== current.ownerUserId) reason = '预约创建人的当前权限或状态已失效。';
          if (!reason && Date.parse(schedule.at) > now.getTime()) return;
          if (!reason && now.getTime() - Date.parse(schedule.at) > 5 * 60_000) reason = '预约错过执行窗口（5 分钟），未补发停机；请重新设置。';
          if (!reason && (await this.repository.listProvisionJobs()).some(job => job.rangeInstanceId === current.id && active(job))) return;
          if (!reason && (await this.repository.listPackedImageArtifacts()).some(pack => pack.sourceRangeInstanceId === current.id && ['pending', 'creating', 'deleting'].includes(pack.status))) return;
          const control = { ...current.powerControl!, schedule: { ...schedule, status: reason ? 'failed' as const : 'queued' as const,
            updatedAt: now.toISOString(), ...(reason ? { message: reason } : {}) } };
          if (reason) { await this.repository.saveInstancePowerControl(current.id, current.updatedAt, control); return; }
          control.phase = 'stopping';
          await this.repository.saveInstancePowerControl(current.id, current.updatedAt, control, { rangeInstanceId: current.id, jobType: 'economical_stop',
            triggeredBy: schedule.triggeredBy, topologySnapshot: snapshot(plan) });
        });
      }, { provider: 'alibaba_cloud', accountUid: plan.accountUid }).catch(async () => {
        await runInSystemCloudWorkspaceScope(async () => {
          const current = await this.repository.getRangeInstanceById(row.id), schedule = current?.powerControl?.schedule;
          if (!current || schedule?.status !== 'scheduled' || schedule.id !== row.powerControl!.schedule!.id || schedule.revision !== row.powerControl!.schedule!.revision) return;
          await this.repository.saveInstancePowerControl(current.id, current.updatedAt, { ...current.powerControl!, schedule: { ...schedule,
            status: 'failed', message: '预约账号或工作空间不可执行，未发起停机；请核对权限和原账号。', updatedAt: new Date().toISOString() } });
        }).catch(() => undefined);
      });
    }
  }

  async execute(job: ProvisionJobRecord, assertClaim: () => Promise<void>, observeOnly = false) {
    const plan = job.topologySnapshot?.powerPlan;
    if (!isPowerJob(job) || !plan || plan.version !== 1) throw new Error('POWER_PLAN_MISSING');
    const row = await this.repository.getRangeInstanceById(job.rangeInstanceId);
    if (!row || row.status !== 'running' || row.lastJobId !== job.id || row.powerControl?.jobId !== job.id
      || plan.expiresAt && Date.parse(plan.expiresAt) <= Date.now()) throw new Error('POWER_SOURCE_CHANGED_OR_EXPIRED');
    const account = await this.account(row, plan); await this.cloud.verifyAccount(account);
    const actor = await this.repository.getPlatformUserById(job.triggeredBy);
    if (!observeOnly && (!actor || actor.status !== 'active' || actor.role !== 'admin' && actor.id !== row.ownerUserId)) throw new Error('POWER_ACTOR_NO_LONGER_AUTHORIZED');
    const facts: Record<string, PowerHostFact> = {}, failures: string[] = [];
    let waiting = false;
    for (const target of plan.hosts) {
      await assertClaim();
      let host = await this.cloud.host(account, target.instanceId);
      this.assertTags(row, target.instanceId, host, plan, target);
      if (this.cloud.networkDigest(host) !== target.networkDigest) throw new Error('POWER_NETWORK_OR_DEADLINE_CHANGED');
      const disks = await this.cloud.disks(account, target.instanceId);
      if (JSON.stringify(sorted(disks.map(disk => disk.DiskId))) !== JSON.stringify(target.diskIds) || disks.some(disk => disk.InstanceId !== target.instanceId)) throw new Error('POWER_DISK_BINDINGS_CHANGED');
      const desired = job.jobType === 'economical_stop' ? host.Status === 'Stopped' && host.StoppedMode === 'StopCharging' : this.cloud.runningReady(host);
      const steps = await this.repository.listProvisionJobStepLogs(job.id);
      const intent = steps.find(step => step.stepName === 'power_intent:' + target.nodeId);
      const rejected = steps.find(step => step.stepName === 'power_rejected:' + target.nodeId);
      if (!desired && !intent && !observeOnly && !(job.jobType === 'resume' && host.Status === 'Running')) {
        if (row.powerControl?.schedule?.jobId === job.id && Date.now() - Date.parse(row.powerControl.schedule.at) > 5 * 60_000) throw new Error('POWER_SCHEDULE_WINDOW_MISSED');
        if (job.jobType === 'economical_stop') await this.cloud.assertEconomicalSupported(account, host);
        if (host.Status !== (job.jobType === 'economical_stop' ? 'Running' : 'Stopped')) throw new Error('POWER_HOST_TRANSITION_UNVERIFIED');
        await this.assertNativeAllowed(job, plan, host);
        await this.step(job, 'power_intent:' + target.nodeId, 'succeeded', '已持久记录本主机唯一电源请求意图；未知结果只观察原实例，不自动重发。');
        await assertClaim();
        await this.assertNativeAllowed(job, plan, host);
        try {
          const receipt = job.jobType === 'economical_stop' ? await this.cloud.stopEconomical(account, target.instanceId) : await this.cloud.start(account, target.instanceId);
          await this.step(job, 'power_receipt:' + target.nodeId, 'succeeded', JSON.stringify(receipt));
        } catch (error) {
          const known = error instanceof AliyunImageRpcError && error.cloudStatus >= 400 && error.cloudStatus < 500 && Boolean(error.requestId)
            || error instanceof NodeResetCloudError && error.rejected;
          await this.step(job, (known ? 'power_rejected:' : 'power_unconfirmed:') + target.nodeId, 'failed', this.failure(error));
        }
        host = await this.cloud.host(account, target.instanceId);
      }
      facts[target.nodeId] = this.cloud.fact(host);
      const complete = job.jobType === 'economical_stop' ? host.Status === 'Stopped' && host.StoppedMode === 'StopCharging' : this.cloud.runningReady(host);
      if (complete) {
        if (this.cloud.networkDigest(host) !== target.networkDigest) throw new Error('POWER_NETWORK_OR_DEADLINE_CHANGED');
        const retained = await this.cloud.disks(account, target.instanceId);
        if (JSON.stringify(sorted(retained.map(disk => disk.DiskId))) !== JSON.stringify(target.diskIds) || retained.some(disk => disk.InstanceId !== target.instanceId)) throw new Error('POWER_DISK_BINDINGS_CHANGED');
      }
      if (complete) await this.step(job, 'power_verified:' + target.nodeId, 'succeeded', job.jobType === 'economical_stop' ? '已核验 Stopped + StopCharging；实例、磁盘和私网身份保留。' : '已核验原 ECS 恢复 Running。');
      else if (job.jobType === 'economical_stop' && host.Status === 'Stopped') failures.push(target.name + '：已停止但未返回 StopCharging，不能确认节省停机。');
      else if (rejected) failures.push(target.name + '：' + rejected.message);
      else waiting = true;
    }
    const firstIntent = (await this.repository.listProvisionJobStepLogs(job.id)).find(step => step.stepName.startsWith('power_intent:'));
    const timedOut = Date.now() - (firstIntent?.createdAt ?? job.createdAt).getTime() > 10 * 60_000;
    const control: InstancePowerControl = { ...(row.powerControl ?? emptyControl()), jobId: job.id, checkedAt: new Date().toISOString(), hosts: facts,
      state: Object.values(facts).every(fact => fact.status === 'Running') ? 'running'
        : Object.values(facts).every(fact => fact.status === 'Stopped' && fact.stoppedMode === 'StopCharging') ? 'economical_stopped'
        : Object.values(facts).every(fact => fact.status === 'Stopped') ? 'stopped_standard' : 'partial',
      ...(waiting && !timedOut ? { phase: job.jobType === 'economical_stop' ? 'stopping' as const : 'starting' as const } : { phase: undefined }),
      error: failures.length ? failures.join('\n') : timedOut ? '电源请求结果尚未确认，不能自动重发；请核验原任务。' : null };
    if (waiting && timedOut) control.state = 'unknown';
    const pending = !observeOnly && waiting && !timedOut && !failures.length;
    const failed = failures.length > 0 || Boolean(timedOut && waiting) || observeOnly && waiting;
    if (observeOnly && waiting) {
      control.error = '原任务目标状态仍未完整确认；本次仅核验，未补发任何停机或开机请求。';
      if (firstIntent) control.state = 'unknown';
    }
    if (!pending) delete control.phase;
    if (control.schedule?.jobId === job.id) control.schedule = { ...control.schedule, status: pending ? 'queued' : failed ? 'failed' : 'succeeded', ...(control.error ? { message: control.error } : {}) };
    await assertClaim();
    const updated = await this.repository.updateInstancePowerForClaim(job.id, job.startedAt!, this.sourceUpdate(row, control),
      pending ? { status: 'pending', availableAt: new Date(Date.now() + 5000), startedAt: null, errorSummary: null }
        : { status: failed ? 'failed' : 'succeeded', finishedAt: new Date(), errorSummary: control.error });
    if (!updated) throw new Error('POWER_CLAIM_LOST');
    return { pending, failed };
  }

  private async assertNativeAllowed(job: ProvisionJobRecord, plan: PowerPlan, host: Record<string, any>) {
    const current = await this.repository.getRangeInstanceById(job.rangeInstanceId);
    if (!current || current.status !== 'running' || current.lastJobId !== job.id || current.powerControl?.jobId !== job.id
      || powerSourceDigest(current) !== plan.sourceDigest || current.expiresAt && current.expiresAt.getTime() <= Date.now()
      || host.AutoReleaseTime && Date.parse(host.AutoReleaseTime) <= Date.now()) throw new Error('POWER_SOURCE_CHANGED_OR_EXPIRED');
    const actor = await this.repository.getPlatformUserById(job.triggeredBy);
    if (!actor || actor.status !== 'active' || actor.role !== 'admin' && actor.id !== current.ownerUserId) throw new Error('POWER_ACTOR_NO_LONGER_AUTHORIZED');
  }

  private sourceUpdate(row: RangeInstanceRecord, control: InstancePowerControl): UpdateRangeInstanceInput {
    const input: UpdateRangeInstanceInput = { powerControl: control };
    if (row.instanceMode === 'single' && row.accessEntry) {
      const fact = control.hosts?.[row.singleInstanceConfig?.hostKey ?? ''];
      if (fact) {
        const username = row.runtimeCredentials?.[row.singleInstanceConfig!.hostKey]?.username;
        input.accessEntry = { ...row.accessEntry, publicIp: fact.publicIp, ssh: fact.publicIp && username && username !== 'Administrator' && /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(username) ? 'ssh ' + username + '@' + fact.publicIp : null };
      }
    }
    return input;
  }

  async fail(job: ProvisionJobRecord, error: unknown, assertClaim: () => Promise<void>) {
    await assertClaim();
    const row = await this.repository.getRangeInstanceById(job.rangeInstanceId);
    if (!row) return;
    const message = this.failure(error), hasIntent = (await this.repository.listProvisionJobStepLogs(job.id)).some(step => step.stepName.startsWith('power_intent:'));
    const control: InstancePowerControl = { ...(row.powerControl ?? emptyControl()), phase: undefined, state: hasIntent ? 'unknown' : row.powerControl?.state ?? 'running', error: message };
    delete control.phase;
    if (control.schedule?.jobId === job.id) control.schedule = { ...control.schedule, status: 'failed', message };
    await this.repository.updateInstancePowerForClaim(job.id, job.startedAt!, { powerControl: control }, { status: 'failed', finishedAt: new Date(), errorSummary: message });
  }

  failure(error: unknown) {
    if (error instanceof AliyunImageRpcError) return '阿里云 ' + error.action + '：' + (error.cloudCode ?? 'UNKNOWN') + (error.requestId ? '；请求 ID ' + error.requestId : '；未取得官方回执');
    if (error instanceof NodeResetCloudError) return '阿里云 ' + error.action + '：' + error.code + (error.requestId ? '；请求 ID ' + error.requestId : '；结果未确认');
    const reasons: Record<string, string> = {
      POWER_REQUIRES_POSTPAID_VPC: '节省停机仅适用于按量付费 VPC 实例。', POWER_INSTANCE_TYPE_UNVERIFIED: '规格元数据不完整，无法确认节省停机条件。',
      POWER_LOCAL_OR_PERSISTENT_MEMORY_UNSUPPORTED: '本地盘或持久内存规格不支持节省停机。', POWER_TAG_JOB_UNVERIFIED: '缺少原创建作业的云标签来源证明。',
      POWER_SOURCE_ACCOUNT_CHANGED: '原冻结账号、地域、owner 或已部署资源身份发生变化。', POWER_ACTOR_NO_LONGER_AUTHORIZED: '任务创建人的当前权限或状态失效。',
      POWER_DISK_BINDINGS_CHANGED: '原磁盘挂载关系发生变化，未继续操作。', POWER_NETWORK_OR_DEADLINE_CHANGED: '私网、网卡或云端自动释放时间发生变化。',
      POWER_CLOUD_OWNER_CHANGED: '云端主机归属或创建来源不匹配。', POWER_SCHEDULE_WINDOW_MISSED: '预约错过 5 分钟执行窗口，未补发停机。',
      POWER_SOURCE_CHANGED_OR_EXPIRED: '实例已进入其他操作或已到期，不再执行电源动作。', POWER_RECEIPT_UNVERIFIED: '未取得可验证的官方回执，请核验原任务。',
    };
    if (error instanceof Error && /^POWER_[A-Z_]+$/.test(error.message)) return error.message + (reasons[error.message] ? '：' + reasons[error.message] : '：来源或请求未完整核验，未继续操作。');
    return '电源操作核验未完成；原实例、来源和请求材料保留，不自动重发或重建。';
  }

  private async step(job: ProvisionJobRecord, name: string, status: 'succeeded' | 'failed', message: string) {
    if ((await this.repository.listProvisionJobStepLogs(job.id)).some(step => step.stepName === name && step.status === status)) return;
    await this.repository.createProvisionJobStepLog({ jobId: job.id, stepName: name, status, message, startedAt: new Date(), finishedAt: new Date() });
  }
}
