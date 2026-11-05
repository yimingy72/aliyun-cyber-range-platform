import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ADMIN_REPOSITORY, type AdminRepository, type HostCloudReleaseDeadline, type ProvisionJobRecord, type RangeInstanceRecord } from './admin.repository';
import type { SessionUserProfile } from './admin-user-auth';
import { SystemConfigService } from './system-config.service';
import { InstancePowerService } from './instance-power.service';
import { InstancePowerCloudClient } from './instance-power-cloud';
import { powerHash, powerSourceDigest, type PowerTarget } from './instance-power-types';
import { AliyunImageRpcError } from './aliyun-image-rpc';
import { NodeResetCloudError } from './range-node-reset-cloud.client';
import { EXPIRY_WARNINGS, type ExpiryPlan } from './instance-expiry-types';
import { assertPlatformExpirationSupportsCloudDeadline } from '../provisioning/cloud-release-deadlines';

type Actor = Pick<SessionUserProfile, 'id' | 'role'>;
const active = (job: ProvisionJobRecord) => ['pending', 'running'].includes(job.status);
const snapshot = (expiryPlan: ExpiryPlan) => ({ draftRevision: 0, topologyGraph: {}, topologySpec: {}, scenarioTemplateSpec: {},
  compiledProvisionSpec: {}, compiledSpec: {}, templateModulePath: '', expiryPlan });

@Injectable()
export class InstanceExpiryService {
  constructor(@Inject(ADMIN_REPOSITORY) private readonly repository: AdminRepository,
    private readonly power: InstancePowerService, private readonly config: SystemConfigService,
    private readonly cloud: InstancePowerCloudClient) {}

  validateTime(value: unknown, checkFuture = true): string {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
      || !Number.isFinite(Date.parse(value))) throw new BadRequestException('回收时间必须是带时区的有效日期。');
    const date = new Date(value);
    const calendar = value.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::(\d{2}))?/)!;
    const local = calendar[1] + ':' + (calendar[2] ?? '00');
    if (new Date(local + 'Z').toISOString().slice(0, 19) !== local) throw new BadRequestException('回收时间包含无效日期。');
    if (!checkFuture) return date.toISOString();
    if (date.getTime() < Date.now() + 30 * 60_000) throw new BadRequestException('新回收时间需至少在 30 分钟后，为云端同步预留时间。');
    try { assertPlatformExpirationSupportsCloudDeadline('alibaba_cloud', value); }
    catch { throw new BadRequestException('回收时间过远，需为云端自动释放预留余量，不能超过 1095 天。'); }
    return date.toISOString();
  }

  async list(target: PowerTarget, actor: Actor) {
    const rows = await this.power.targets(target, actor), ids = new Set(rows.map(row => row.id));
    const jobs = (await this.repository.listProvisionJobs()).filter(job => ids.has(job.rangeInstanceId) && job.jobType === 'change_expiry');
    return { instances: rows.map(row => ({ id: row.id, name: row.name, status: row.status, expiresAt: row.expiresAt })),
      jobs: jobs.slice(0, 100).map(job => ({ id: job.id, instanceId: job.rangeInstanceId, status: job.status,
        previousExpiresAt: job.topologySnapshot?.expiryPlan?.expiresAt, requestedExpiresAt: job.topologySnapshot?.expiryPlan?.requestedExpiresAt,
        createdAt: job.createdAt, error: job.errorSummary })), warnings: EXPIRY_WARNINGS };
  }

  async preview(target: PowerTarget, actor: Actor, expiresAt: string) {
    const at = this.validateTime(expiresAt), rows = await this.power.targets(target, actor);
    const jobs = await this.repository.listProvisionJobs();
    for (const row of rows.filter(row => !['destroyed', 'create_failed'].includes(row.status))) {
      if (!row.expiresAt || row.expiresAt.getTime() <= Date.now() + 5 * 60_000) throw new ConflictException('实例已到期或距原回收时间不足 5 分钟，不能再改期。');
      if (row.powerControl?.schedule?.status === 'scheduled') throw new ConflictException('已有节省停机预约，请先取消预约，修改回收时间后重新预约。');
      for (const job of jobs.filter(job => job.rangeInstanceId === row.id && job.jobType === 'change_expiry' && job.status === 'failed')) {
        const steps = await this.repository.listProvisionJobStepLogs(job.id);
        if (steps.some(step => step.stepName.startsWith('expiry_intent:') && !steps.some(other =>
          ['expiry_verified:', 'expiry_rejected:'].some(prefix => other.stepName === prefix + step.stepName.slice('expiry_intent:'.length)))))
          throw new ConflictException('上次回收时间修改结果待核验，请先核验原任务，不能重复提交。');
      }
    }
    // Reuse the same read-only ownership, account, host and active-operation checks as power control.
    const source = await this.power.preview(target, 'resume', actor);
    const cloudReleaseAt = new Date(Math.ceil((Date.parse(at) + 5 * 60_000) / 60_000) * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const plans: ExpiryPlan[] = source.plans.filter(plan => plan.expiresAt !== at).map(plan => ({ ...plan, requestedExpiresAt: at,
      effectiveExpiresAt: new Date(Math.min(Date.parse(plan.expiresAt!), Date.parse(at))).toISOString(), cloudReleaseAt }));
    if (!plans.length) throw new ConflictException('所选实例已是该回收时间，无需重复修改。');
    const skipped = [...source.skipped, ...source.plans.filter(plan => plan.expiresAt === at).map(plan => ({ id: plan.instanceId, name: plan.instanceName, reason: '回收时间未变化' }))];
    const planDigest = powerHash({ target, at, plans, sourceVersions: source.sourceVersions });
    return { target, expiresAt: at, planDigest, plans, sourceVersions: source.sourceVersions, skipped, warnings: EXPIRY_WARNINGS };
  }

  async submit(target: PowerTarget, actor: Actor, expiresAt: string, digest: string) {
    const preview = await this.preview(target, actor, expiresAt);
    if (preview.planDigest !== digest) throw new ConflictException('实例或时间已变化，请重新预览并确认。');
    return this.repository.withSingleInstanceControlLock(() => this.repository.withSingleInstanceTransaction(async tx => {
      const items = [];
      for (const plan of preview.plans) {
        const row = await tx.getRangeInstanceById(plan.instanceId);
        if (!row || row.updatedAt.toISOString() !== preview.sourceVersions.find(item => item.id === row.id)?.updatedAt
          || powerSourceDigest(row) !== plan.sourceDigest) throw new ConflictException('实例已变化，本批次未提交。');
        const acceptedPlan = { ...plan, sourceDigest: powerSourceDigest({ ...row, expiresAt: new Date(plan.effectiveExpiresAt) }) };
        const job = await tx.queueInstanceExpiryJob(row.id, row.updatedAt, { rangeInstanceId: row.id, jobType: 'change_expiry',
          triggeredBy: actor.id, topologySnapshot: snapshot(acceptedPlan) }, new Date(plan.effectiveExpiresAt));
        if (!job) throw new ConflictException('实例已有其他操作，本批次未提交。');
        items.push({ instanceId: row.id, jobId: job.id });
      }
      return { status: 'accepted', items };
    }));
  }

  async verify(target: PowerTarget, actor: Actor, jobId: string) {
    return this.repository.withSingleInstanceControlLock(async () => {
      const rows = await this.power.targets(target, actor), job = await this.repository.getProvisionJobById(jobId);
      const row = rows.find(row => row.id === job?.rangeInstanceId);
      if (!row || !job || job.jobType !== 'change_expiry' || !job.topologySnapshot?.expiryPlan) throw new NotFoundException('原回收时间任务不存在。');
      if (active(job) || job.status === 'succeeded') return { status: job.status, jobId };
      if (row.lastJobId !== job.id || row.status !== 'running' || powerSourceDigest(row) !== job.topologySnapshot.expiryPlan.sourceDigest)
        throw new ConflictException('实例已进入其他操作，不能核验旧任务。');
      if (!await this.repository.requeueInstanceExpiryJob(job.id, row.updatedAt, job.updatedAt)) throw new ConflictException('原任务或实例已变化，请刷新。');
      return { status: 'accepted', jobId, observeOnly: true };
    });
  }

  async execute(job: ProvisionJobRecord, assertClaim: () => Promise<void>) {
    const plan = job.topologySnapshot?.expiryPlan;
    if (!plan || job.jobType !== 'change_expiry') throw new Error('EXPIRY_PLAN_MISSING');
    const row = await this.source(job, plan), account = await this.config.getAccountContextById(plan.cloudAccountContextId);
    if (account.provider !== 'alibaba_cloud' || !account.accountUidResolved || account.cloudAccountContextId !== plan.cloudAccountContextId
      || account.accountUid !== plan.accountUid || account.defaultRegion !== plan.regionId) throw new ConflictException('原云账号或地域已变化，未继续修改回收时间。');
    await this.cloud.verifyAccount(account);
    let waiting = false;
    for (const target of plan.hosts) {
      await assertClaim();
      await this.source(job, plan);
      let host = await this.cloud.host(account, target.instanceId);
      const assertHost = () => {
        const tags = this.cloud.tags(host);
        if (host.InstanceId !== target.instanceId || tags.CreatedBy !== 'cyber-range-platform' || tags.RangeInstanceId !== row.id
          || tags.PlatformUserId !== plan.ownerUserId || tags.PlatformCreateJobId !== target.tagJobId
          || this.cloud.networkDigest({ ...host, AutoReleaseTime: target.autoReleaseTime }) !== target.networkDigest)
          throw new ConflictException('主机来源或网络身份已变化，未继续修改回收时间。');
      };
      assertHost();
      const steps = await this.repository.listProvisionJobStepLogs(job.id);
      const intent = steps.some(step => step.stepName === 'expiry_intent:' + target.nodeId);
      if (Date.parse(host.AutoReleaseTime ?? '') !== Date.parse(plan.cloudReleaseAt) && !intent && !job.topologySnapshot?.expiryObserveOnly) {
        if (Date.parse(host.AutoReleaseTime ?? '') !== Date.parse(target.autoReleaseTime ?? '')
          && (host.AutoReleaseTime || target.autoReleaseTime)) throw new ConflictException('云端回收时间已被其他操作修改，请重新核对。');
        if (Date.parse(plan.cloudReleaseAt) < Date.now() + 31 * 60_000) throw new ConflictException('任务等待过久，已不足云端修改时间窗口；请刷新后重新设置。');
        await this.step(job, 'expiry_intent:' + target.nodeId, 'succeeded', '已记录本主机的改期请求；结果未知时仅核验，不重复发送。');
        await assertClaim();
        await this.source(job, plan);
        try {
          const receipt = await this.cloud.modifyReleaseTime(account, target.instanceId, plan.cloudReleaseAt);
          await this.step(job, 'expiry_receipt:' + target.nodeId, 'succeeded', JSON.stringify(receipt));
        } catch (error) {
          const rejected = error instanceof AliyunImageRpcError && error.cloudStatus >= 400 && error.cloudStatus < 500 && Boolean(error.requestId);
          await this.step(job, (rejected ? 'expiry_rejected:' : 'expiry_unconfirmed:') + target.nodeId, 'failed', this.failure(error));
          if (rejected) throw new ConflictException(this.failure(error));
        }
        host = await this.cloud.host(account, target.instanceId);
        assertHost();
      }
      if (Date.parse(host.AutoReleaseTime ?? '') === Date.parse(plan.cloudReleaseAt)) {
        await this.step(job, 'expiry_verified:' + target.nodeId, 'succeeded', '已核验原 ECS 的云端释放时间：' + plan.cloudReleaseAt);
      } else waiting = true;
    }
    await assertClaim();
    const current = await this.source(job, plan);
    if (waiting) {
      if (job.topologySnapshot?.expiryObserveOnly || Date.now() - job.createdAt.getTime() > 5 * 60_000)
        throw new ConflictException('云端回收时间未全部确认；保留较早的平台回收时间，请核验原任务。');
      await this.repository.updateInstancePowerForClaim(job.id, job.startedAt!, {}, { status: 'pending', startedAt: null, availableAt: new Date(Date.now() + 5000) });
      return;
    }
    const deadlines = { ...current.resourceSummary?.cloudReleaseDeadlines };
    for (const host of plan.hosts) {
      const prior = deadlines[host.nodeId] ?? current.singleInstanceConfig?.cloudReleaseDeadline;
      deadlines[host.nodeId] = { provider: 'alibaba_cloud', platformExpiresAt: plan.requestedExpiresAt,
        creationPhaseStartedAt: prior?.creationPhaseStartedAt ?? current.createdAt.toISOString(), sourceProvisionJobId: host.sourceJobId,
        cloudReleaseAt: plan.cloudReleaseAt, instanceId: host.instanceId, status: 'verified',
        verifiedAt: new Date().toISOString(), lastCheckedAt: new Date().toISOString() } satisfies HostCloudReleaseDeadline;
    }
    const changed = await this.repository.updateInstancePowerForClaim(job.id, job.startedAt!, {
      expiresAt: new Date(plan.requestedExpiresAt), resourceSummary: { ...current.resourceSummary!, cloudReleaseDeadlines: deadlines },
      ...(current.singleInstanceConfig ? { singleInstanceConfig: { ...current.singleInstanceConfig, autoReleaseTime: plan.cloudReleaseAt,
        cloudReleaseDeadline: deadlines[current.singleInstanceConfig.hostKey] } } : {}),
    }, { status: 'succeeded', finishedAt: new Date(), errorSummary: null });
    if (!changed) throw new Error('EXPIRY_CLAIM_LOST');
  }

  private async source(job: ProvisionJobRecord, plan: ExpiryPlan): Promise<RangeInstanceRecord> {
    const row = await this.repository.getRangeInstanceById(job.rangeInstanceId);
    if (!row || row.status !== 'running' || row.lastJobId !== job.id || row.cloudWorkspaceId !== plan.cloudWorkspaceId || row.ownerUserId !== plan.ownerUserId
      || powerSourceDigest(row) !== plan.sourceDigest || !row.expiresAt || row.expiresAt.getTime() <= Date.now() + 60_000)
      throw new ConflictException('实例来源或回收状态已变化，未继续改期；不会撤销已开始的回收。');
    const actor = await this.repository.getPlatformUserById(job.triggeredBy);
    if (!actor || actor.status !== 'active' || actor.role !== 'admin' && actor.id !== row.ownerUserId) throw new ConflictException('操作人的当前权限或状态已失效。');
    return row;
  }

  async fail(job: ProvisionJobRecord, error: unknown) {
    await this.repository.updateInstancePowerForClaim(job.id, job.startedAt!, {}, {
      status: 'failed', finishedAt: new Date(), errorSummary: this.failure(error),
    });
  }
  private failure(error: unknown) {
    if (error instanceof ConflictException) return error.message;
    if (error instanceof AliyunImageRpcError) return '阿里云 ' + error.action + '：' + (error.cloudCode ?? 'UNKNOWN') + (error.requestId ? '；请求 ID ' + error.requestId : '');
    if (error instanceof NodeResetCloudError) return this.power.failure(error);
    return '回收时间修改未完成或结果待核验，平台保留较早的回收时间；请查看原任务。';
  }
  private async step(job: ProvisionJobRecord, stepName: string, status: 'succeeded' | 'failed', message: string) {
    await this.repository.createProvisionJobStepLog({ jobId: job.id, stepName, status, message });
  }
}
