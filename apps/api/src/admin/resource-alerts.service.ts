import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { ADMIN_REPOSITORY, type AdminRepository, type RangeInstanceRecord } from './admin.repository';
import type { SessionUserProfile } from './admin-user-auth';
import { SystemConfigService, type SystemCloudAccountContext } from './system-config.service';
import { getCurrentCloudWorkspaceScope, requireCurrentCloudWorkspaceId, runInSystemCloudWorkspaceScope } from '../auth/cloud-workspace-scope';
import { ResourcePatrolRepository } from './resource-patrol.repository';
import { CloudPatrolReadError, ResourcePatrolCloudClient, type PatrolCloudResource } from './resource-patrol-cloud-client';
import { readPatrolInventories, patrolResourceIdentities, patrolResourceKey, type ProvenInventory } from './resource-patrol-inventory';
import type { ResourceAlertStatus, ResourceAlertView, ResourceIdentity, ResourceReclaimPreview, StoredResourceAlert } from './resource-alert-types';

const inactive = new Set(['destroyed','create_failed','destroy_failed']);
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sort = (resources: ResourceIdentity[]) => [...resources].sort((a,b) => patrolResourceKey(a).localeCompare(patrolResourceKey(b)));
const safeError = (error: unknown) => error instanceof CloudPatrolReadError
  ? `阿里云 ${error.action} 检查失败（HTTP ${error.status}，${error.code}；${error.requestId ? `请求 ID ${error.requestId}` : '请求 ID 未核验'}），请检查账号权限与网络后重新核验。`
  : '云端检查未完成或来源已变化，请检查账号权限与网络后重新核验。';

@Injectable()
export class ResourceAlertsService {
  constructor(@Inject(ADMIN_REPOSITORY) private readonly repository: AdminRepository,
    private readonly systemConfig: SystemConfigService, private readonly store: ResourcePatrolRepository,
    private readonly cloud: ResourcePatrolCloudClient) {}

  async getPatrol(user: SessionUserProfile) {
    this.assertManager(user);
    const settings = await this.store.settings();
    if (!settings.managerUserId) return { ...settings, managerUsername: null, cloudWorkspaceId: null, provider: null, accountUid: null,
      status: 'not_configured', lastCompleted: null };
    try {
      const target = await this.store.target(settings.managerUserId);
      const sameTarget = settings.lastScanWorkspaceId === target.cloudWorkspaceId;
      return { ...settings, ...target, lastScanAt:sameTarget?settings.lastScanAt:null,
        lastScanError:sameTarget?settings.lastScanError:null,regions:sameTarget?settings.regions:[],
        status: sameTarget ? settings.lastScanError ? 'failed' : 'ready' : 'pending',
        lastCompleted: sameTarget && settings.lastScanAt ? { at: settings.lastScanAt, cloudWorkspaceId: target.cloudWorkspaceId,
          regions: settings.regions, succeeded: !settings.lastScanError } : null };
    } catch {
      return { ...settings, managerUsername: null, cloudWorkspaceId: null, provider: null, accountUid: null,
        status: 'unavailable', lastCompleted: null };
    }
  }

  async setPatrolManager(user: SessionUserProfile, input: { managerUserId?: string }) {
    this.assertManager(user);
    const managerUserId = input.managerUserId ?? user.id;
    if (!managerUserId.trim() || managerUserId.length > 192) throw new BadRequestException('巡检管理员标识无效。');
    await this.store.target(managerUserId);
    await this.store.setManager(managerUserId);
    return this.getPatrol(user);
  }

  async list(user: SessionUserProfile, input: { status?: ResourceAlertStatus } = {}): Promise<ResourceAlertView[]> {
    this.assertManager(user);
    if (input.status && !['pending','unverified','reclaiming','failed','resolved'].includes(input.status)) throw new BadRequestException('告警状态无效。');
    const scope = getCurrentCloudWorkspaceScope();
    if (!scope || 'system' in scope || !scope.accountUid || scope.isReadOnly) return [];
    const rows = await this.store.list(input.status);
    if (!rows.length) return [];
    const { inventories } = await this.inventoryData(scope.accountUid,scope.provider);
    return rows.flatMap(row => {
      const owner = this.ownedAlertInventory(row,inventories);
      return owner ? [this.view({ ...row,rangeName:owner.instance.name,
        remainingResources:row.remainingResources.filter(resource => this.ownedAlertInventory(row,inventories,resource) === owner) })] : [];
    });
  }

  async preview(user: SessionUserProfile, id: string): Promise<ResourceReclaimPreview> {
    this.assertManager(user);
    return (await this.prepare(id)).preview;
  }

  async reclaim(user: SessionUserProfile, id: string, input: { planDigest: string; idempotencyKey: string }) {
    this.assertManager(user);
    if (!/^[a-f0-9]{64}$/.test(input.planDigest) || !input.idempotencyKey || input.idempotencyKey.length > 128) throw new BadRequestException('请先预览准确回收清单并提供稳定幂等键。');
    const existing = await this.requireAlert(id);
    if (existing.status === 'reclaiming' && existing.jobId) return { alertId: id, status: 'reclaiming' as const, jobId: existing.jobId };
    // Read cloud identity, exact IDs and all occupation relationships again after confirmation.
    const prepared = await this.prepare(id);
    if (!prepared.preview.reclaimable || !prepared.inventory) throw new ConflictException(prepared.preview.reason ?? '来源证据不足，不能回收。');
    if (prepared.preview.planDigest !== input.planDigest) throw new ConflictException('资源状态或回收清单已变化，请重新预览确认。');
    const queued = await this.store.queueReclaim({ alert: prepared.alert, instance: prepared.inventory.instance,
      summary: prepared.inventory.summary, resources: prepared.preview.resources, planDigest: input.planDigest,
      creationProofs:Object.fromEntries(prepared.preview.resources.map(resource=>[patrolResourceKey(resource),prepared.inventory!.birthSources.get(patrolResourceKey(resource))!])),
      idempotencyKey: input.idempotencyKey, actorUserId: user.id });
    return { alertId: id, status: 'reclaiming' as const, jobId: queued.jobId };
  }

  async scanCurrent(now = new Date()) {
    const token = await this.store.tryLease(now);
    if (!token) return { recovered: 0, drifts: 0, skipped: true };
    let regions: string[] = [], drifts = 0, error: string | null = null, scanWorkspaceId: string | null = null;
    let leaseError: unknown = null;
    const heartbeat = setInterval(() => { void this.store.heartbeat(token).catch(value => { leaseError = value; }); }, 30_000);
    heartbeat.unref();
    try {
      const settings = await this.store.settings();
      if (!settings.managerUserId) return { recovered: 0, drifts: 0, skipped: true };
      const target = await this.store.target(settings.managerUserId);
      scanWorkspaceId = target.cloudWorkspaceId;
      const assertCurrent = async () => {
        if (leaseError) throw leaseError;
        await this.store.heartbeat(token);
        const currentSettings = await this.store.settings();
        if (currentSettings.managerUserId !== settings.managerUserId) throw new Error('PATROL_TARGET_CHANGED');
        const current = await this.store.target(settings.managerUserId!);
        if (current.cloudWorkspaceId !== target.cloudWorkspaceId || current.accountUid !== target.accountUid
          || current.provider !== target.provider || current.cloudAccountContextId !== target.cloudAccountContextId) throw new Error('PATROL_TARGET_CHANGED');
      };
      await this.systemConfig.runInWorkspace(target.cloudWorkspaceId, async () => {
        const account = await this.systemConfig.getExecutionAccountContext();
        await this.cloud.verifyAccount(account);
        const data = await this.inventoryData(target.accountUid, target.provider);
        regions = [...new Set([...data.inventories.map(row => row.context.regionId),
          ...data.instances.flatMap(instance => {
            const source = instance.instanceMode === 'single' ? instance.singleInstanceConfig : instance.resourceSummary?.executionContext;
            return source?.cloudAccountUid === target.accountUid && source.regionId ? [source.regionId] : [];
          }), ...data.ledgers.filter(row => row.cloudAccountUid === target.accountUid).map(row => row.regionId),
          ...data.profiles.filter(row => row.cloudAccountUid === target.accountUid).map(row => row.regionId)])].sort();
        for (const region of regions) {
          try {
            await assertCurrent();
            const known = data.inventories.filter(row => row.context.regionId === region).flatMap(row => row.resources);
            const observations = await this.cloud.inspect({ ...account, defaultRegion: region }, known);
            await assertCurrent();
            // A completed bounded read is required before any absence may close an alert.
            drifts += await this.observeRegion({ ...account, defaultRegion: region }, data, observations, new Date(), assertCurrent, token);
          } catch (cause) { error = safeError(cause); }
        }
      });
    } catch (cause) { error = safeError(cause); }
    finally {
      clearInterval(heartbeat);
      await this.store.finish(token, new Date(), regions, error, scanWorkspaceId);
    }
    return { recovered: 0, drifts, skipped: false, ...(error ? { error } : {}) };
  }

  private async inventoryData(accountUid: string, provider: string) {
    const cloudWorkspaceId = requireCurrentCloudWorkspaceId();
    const [instances,jobs,ledgers,profiles] = await Promise.all([this.repository.listRangeInstances(), this.repository.listProvisionJobs(),
      this.repository.listBillingLedgerResources(), this.repository.listSingleInstanceNetworkProfiles()]);
    const inventories = await readPatrolInventories(this.repository,instances,jobs,{ accountUid,provider,cloudWorkspaceId });
    return { instances,jobs,ledgers,profiles,inventories };
  }

  private async observeRegion(account: SystemCloudAccountContext, data: Awaited<ReturnType<ResourceAlertsService['inventoryData']>>,
    observations: PatrolCloudResource[], now: Date, assertCurrent: () => Promise<void>, leaseToken: string) {
    const region = account.defaultRegion;
    const existing = (await this.store.list()).filter(alert => alert.regionId === region && alert.accountUid === account.accountUid);
    const inventory = data.inventories.filter(row => row.context.regionId === region);
    const observed = new Set(observations.map(patrolResourceKey));
    const busyInstances = new Set(data.jobs.filter(job => ['pending','running'].includes(job.status)).map(job => job.rangeInstanceId));
    const sharedIds = new Set(data.profiles.filter(profile => profile.status !== 'deleted' && profile.cloudAccountUid === account.accountUid && profile.regionId === region)
      .flatMap(profile => [profile.vpcId,profile.securityGroupId,...profile.vswitchIds]));
    let drifts = 0;
    for (const resource of observations) {
      await assertCurrent();
      if (sharedIds.has(resource.id) || resource.parentId && sharedIds.has(resource.parentId)) continue;
      const owners = inventory.filter(row => row.proven.has(patrolResourceKey(resource)));
      const source = owners.length === 1 ? owners[0] : null;
      if (resource.type==='eni'&&resource.isPrimary&&resource.attachedInstanceId
        && inventory.some(row=>row.proven.has(`ecs:${resource.attachedInstanceId}`))) continue;
      if (!source || source.context.cloudAccountUid !== account.accountUid
        || !source.birthSources.has(patrolResourceKey(resource))) continue;
      if (busyInstances.has(source.instance.id) || !inactive.has(source.instance.status)) continue;
      if (!(await this.unchangedInactive(source.instance))) continue;
      await this.store.observe({ provider: account.provider, accountUid: account.accountUid!, regionId: region,
        resource, rangeInstanceId: source.instance.id, status: 'pending', now, leaseToken,
        reason: '平台记录已回收或创建失败，但准确库存中的云资源仍存在。',
        evidence: { recordedInventory: true, sourceJobIds: source.sourceJobIds, accountVerified: true,
          rangeName: source.instance.name, cloudAccountContextId: source.context.cloudAccountContextId,
          parentId: resource.parentId, identity: { type: resource.type, id: resource.id } } });
      await this.reconcileResourceBilling(source,resource,account,now,leaseToken,true);
      drifts++;
    }
    for (const alert of existing.filter(row => row.status !== 'resolved')) {
      await assertCurrent();
      const owner = this.ownedAlertInventory(alert,inventory);
      if (!owner || busyInstances.has(owner.instance.id)) continue;
      if (!(await this.unchangedInactive(owner.instance))) continue;
      if (!observed.has(`${alert.type}:${alert.resourceId}`)) {
        await this.reconcileResourceBilling(owner,{type:alert.type,id:alert.resourceId},account,now,leaseToken,false);
        await this.store.resolve(alert.id, now, leaseToken);
      }
      else if (alert.status === 'reclaiming' && alert.jobId) {
        const job = data.jobs.find(job => job.id === alert.jobId);
        if (job?.status === 'failed') await this.store.failed(alert.id,
          alert.remainingResources.filter(resource => observed.has(patrolResourceKey(resource))), '回收作业失败；保留剩余清单及历史来源。',leaseToken);
      }
    }
    return drifts;
  }

  private async prepare(id: string) {
    const alert = await this.requireAlert(id);
    const scope = getCurrentCloudWorkspaceScope();
    if (!scope || 'system' in scope || scope.isReadOnly || scope.accountUid !== alert.accountUid || scope.provider !== alert.provider) throw new ConflictException('告警与当前云账号空间不一致。');
    const data = await this.inventoryData(alert.accountUid,alert.provider);
    const inventory = this.ownedAlertInventory(alert,data.inventories);
    let reason: string | null = null;
    if (!inventory || !alert.evidenceSummary.recordedInventory) reason = '缺少完整创建来源和准确库存证明，不能删除。';
    else if (!inactive.has(inventory.instance.status) || data.jobs.some(job => job.rangeInstanceId === inventory.instance.id && ['pending','running'].includes(job.status))) reason = '原实例仍在使用或有活动作业，不能按残留回收。';
    else if (data.inventories.some(row => row.instance.id !== inventory.instance.id && !inactive.has(row.instance.status)
      && row.resources.some(resource => inventory.proven.has(patrolResourceKey(resource))))) reason = '存在活动实例共享的资源，不能回收。';
    else if (data.instances.some(instance => instance.id !== inventory.instance.id && !inactive.has(instance.status)
      && (patrolResourceIdentities(instance.resourceSummary).some(resource => inventory.proven.has(patrolResourceKey(resource)))
        || instance.singleInstanceConfig?.assignedVswitchId && inventory.resources.some(resource => resource.type === 'vswitch'
          && resource.id === instance.singleInstanceConfig?.assignedVswitchId)))) reason = '当前运行记录仍引用这套资源，不能回收。';
    else if (data.profiles.some(profile => profile.cloudAccountUid === alert.accountUid && profile.regionId === alert.regionId
      && inventory.resources.some(resource => [profile.vpcId,profile.securityGroupId,...profile.vswitchIds].includes(resource.id)))) reason = '该资源属于共享网络池，不能作为实例孤儿回收。';
    let resources: ResourceIdentity[] = [];
    if (inventory && !reason) {
      const account = await this.systemConfig.getExecutionAccountContext({ cloudAccountContextId: inventory.context.cloudAccountContextId });
      if (account.provider !== alert.provider || account.accountUid !== alert.accountUid || account.defaultRegion !== alert.regionId) throw new ConflictException('冻结云账号配置与资源来源不一致。');
      await this.cloud.verifyAccount(account);
      const observations = await this.cloud.inspect(account,inventory.resources);
      const ownedVpc = new Set(inventory.resources.filter(resource => ['vpc','nat_gateway'].includes(resource.type)).map(resource => resource.id));
      const foreign = observations.some(row => row.parentId && ownedVpc.has(row.parentId) && !inventory.proven.has(patrolResourceKey(row))
        && !(row.type==='eni'&&row.isPrimary&&row.attachedInstanceId&&inventory.proven.has(`ecs:${row.attachedInstanceId}`)));
      if (foreign) reason = '云端网络包含没有创建库存证明的关联资源，不能回收整套网络。';
      const hostIds = new Set(inventory.resources.filter(resource => ['ecs','nat_gateway'].includes(resource.type)).map(resource => resource.id));
      if (observations.some(row => inventory.proven.has(patrolResourceKey(row))
        && (row.attachedInstanceId && !hostIds.has(row.attachedInstanceId) || row.raw.shared === true || row.raw.IsShared === true))) reason = '准确库存资源已被其他云主机使用或共享，不能回收。';
      if (observations.some(row => inventory.proven.has(patrolResourceKey(row)) && row.type==='disk' && !row.systemDisk)) reason = '原系统盘的云端类型已变化，本轮不能作为系统盘回收。';
      resources = sort(observations.filter(row => inventory.proven.has(patrolResourceKey(row))).map(({type,id}) => ({type,id})));
      const currentIds = patrolResourceIdentities(inventory.summary);
      if (currentIds.some(resource => !inventory.proven.has(patrolResourceKey(resource)))) reason = '运行状态包含未证明来源的物理资源，需要先核验。';
      if (!resources.length) reason = '准确库存中的资源已不存在，请等待巡检核验解决。';
    }
    const planDigest = digest({ cloudWorkspaceId: alert.cloudWorkspaceId, provider: alert.provider, accountUid: alert.accountUid,
      regionId: alert.regionId, rangeInstanceId: alert.rangeInstanceId, resources, sourceJobIds: inventory?.sourceJobIds.slice().sort() ?? [],
      instanceUpdatedAt: inventory?.instance.updatedAt.toISOString(), lastJobId: inventory?.instance.lastJobId });
    const preview: ResourceReclaimPreview = { alertId: id, cloudWorkspaceId: alert.cloudWorkspaceId, provider: alert.provider,
      accountUid: alert.accountUid, regionId: alert.regionId, rangeInstanceId: alert.rangeInstanceId, resources,
      planDigest, reclaimable: !reason, reason };
    return { alert,inventory,preview };
  }

  private async unchangedInactive(observed: RangeInstanceRecord) {
    const current = await this.repository.getRangeInstanceById(observed.id);
    if (!current || !inactive.has(current.status) || current.updatedAt.getTime() !== observed.updatedAt.getTime()) return false;
    const job = current.lastJobId ? await this.repository.getProvisionJobById(current.lastJobId) : null;
    return !job || !['pending','running'].includes(job.status);
  }

  private ownedAlertInventory(alert: StoredResourceAlert, inventories: ProvenInventory[],
    resource: ResourceIdentity = {type:alert.type,id:alert.resourceId}) {
    const owners = inventories.filter(row => row.instance.cloudWorkspaceId === alert.cloudWorkspaceId
      && row.instance.cloudProvider === alert.provider && row.context.provider === alert.provider
      && row.context.cloudAccountUid === alert.accountUid && row.context.regionId === alert.regionId
      && row.proven.has(patrolResourceKey(resource)) && row.birthSources.has(patrolResourceKey(resource)));
    return owners.length === 1 && owners[0].instance.id === alert.rangeInstanceId ? owners[0] : null;
  }

  private async reconcileResourceBilling(source: ProvenInventory, resource: ResourceIdentity, account: SystemCloudAccountContext,
    now: Date,leaseToken: string,present: boolean) {
    if (!['ecs','disk','eip','nat_gateway','snat_entry','dnat_entry'].includes(resource.type)) return;
    const sourceJobId = source.birthSources.get(patrolResourceKey(resource));
    if (!sourceJobId || !account.accountUid) throw new Error('BILLING_SOURCE_UNVERIFIED');
    await this.store.reconcileBillingObservation({leaseToken,instance:source.instance,resource,sourceJobId,
      provider:account.provider,accountUid:account.accountUid,regionId:account.defaultRegion,observedAt:now,present});
  }

  private async requireAlert(id: string): Promise<StoredResourceAlert> {
    if (!id?.trim() || id.length > 192) throw new BadRequestException('告警标识无效。');
    const row = await this.store.get(id);
    if (!row || row.cloudWorkspaceId !== requireCurrentCloudWorkspaceId()) throw new NotFoundException('资源告警不存在。');
    const scope = getCurrentCloudWorkspaceScope();
    if (!scope || 'system' in scope || scope.provider !== row.provider || scope.accountUid !== row.accountUid) throw new ConflictException('资源告警与当前账号身份不一致。');
    return row;
  }
  private assertManager(user: SessionUserProfile) {
    if (user.isPlatformManager !== true) throw new ForbiddenException('仅平台超管可查看巡检配置和回收资源告警。');
  }
  private view(row: StoredResourceAlert): ResourceAlertView {
    const { evidence: _evidence, updatedAt: _updatedAt, ...view } = row;
    return view;
  }
}
