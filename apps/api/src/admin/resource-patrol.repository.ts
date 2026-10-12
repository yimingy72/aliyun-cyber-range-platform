import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '@aliyun-cyber-range/database/generated/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../database/prisma.service';
import { requireCurrentCloudWorkspaceId, runInSystemCloudWorkspaceScope } from '../auth/cloud-workspace-scope';
import type { RangeInstanceRecord, RangeResourceSummary } from './admin.repository';
import type { PatrolSettings, ResourceAlertStatus, ResourceIdentity, StoredResourceAlert } from './resource-alert-types';

export function storedResourceAlert(row: any): StoredResourceAlert {
  const evidence = row.sourceEvidence && typeof row.sourceEvidence === 'object' ? row.sourceEvidence : {};
  return { id: row.id, cloudWorkspaceId: row.cloudWorkspaceId, provider: row.cloudProvider, accountUid: row.accountUid ?? '',
    regionId: row.regionId, type: row.cloudResourceType, resourceId: row.cloudResourceId, rangeInstanceId: row.rangeInstanceId,
    rangeName: typeof evidence.rangeName === 'string' ? evidence.rangeName : null, reason: row.reason,
    status: row.resolvedAt ? 'resolved' : row.patrolStatus, firstSeenAt: row.firstSeenAt, lastSeenAt: row.lastSeenAt,
    evidenceSummary: { recordedInventory: evidence.recordedInventory === true,
      sourceJobIds: Array.isArray(evidence.sourceJobIds) ? evidence.sourceJobIds.filter((id: unknown) => typeof id === 'string') : [],
      accountVerified: evidence.accountVerified === true },
    remainingResources: Array.isArray(row.remainingResources) ? row.remainingResources : [], errorSummary: row.errorSummary ?? null,
    jobId: row.reclaimJobId ?? null, evidence, updatedAt: row.updatedAt };
}

@Injectable()
export class ResourcePatrolRepository {
  constructor(private readonly prisma: PrismaService) {}

  async target(managerUserId: string) {
    return runInSystemCloudWorkspaceScope(async () => {
      const manager = await this.prisma.platformUser.findUnique({ where: { id: managerUserId } });
      if (!manager || !manager.isPlatformManager || manager.status !== 'active') throw new ConflictException('指定巡检管理员不可用。');
      const space = manager.selectedCloudWorkspaceId ? await this.prisma.cloudWorkspace.findUnique({ where: { id: manager.selectedCloudWorkspaceId } }) : null;
      if (!space || space.archivedAt || space.isReadOnly || !space.accountUid || !space.activeCloudAccountContextId) throw new ConflictException('指定管理员尚未选择可执行的默认云账号。');
      return { managerUserId: manager.id, managerUsername: manager.username, cloudWorkspaceId: space.id,
        provider: space.provider, accountUid: space.accountUid, cloudAccountContextId: space.activeCloudAccountContextId };
    });
  }

  async settings(): Promise<PatrolSettings> {
    return runInSystemCloudWorkspaceScope(async () => {
      const row = await this.prisma.resourcePatrolSettings.findUnique({ where: { id: 'default' } });
      return { managerUserId: row?.managerUserId ?? null, lastScanAt: row?.lastScanAt ?? null,
        lastScanWorkspaceId: row?.lastScanWorkspaceId ?? null,
        lastScanError: row?.lastScanError ?? null, regions: Array.isArray(row?.regions) ? row.regions.filter((r): r is string => typeof r === 'string') : [] };
    });
  }

  async setManager(managerUserId: string) {
    await runInSystemCloudWorkspaceScope(() => this.prisma.resourcePatrolSettings.upsert({ where: { id: 'default' },
      create: { id: 'default', managerUserId }, update: { managerUserId, lastScanAt: null, lastScanWorkspaceId: null, lastScanError: null, regions: [] } }));
  }

  async tryLease(now: Date): Promise<string | null> {
    return runInSystemCloudWorkspaceScope(async () => {
      const token = randomUUID();
      const result = await this.prisma.resourcePatrolSettings.updateMany({ where: { id: 'default', managerUserId: { not: null },
        OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }] }, data: { leaseToken: token, leaseUntil: new Date(now.getTime() + 120_000) } });
      return result.count === 1 ? token : null;
    });
  }

  async heartbeat(token: string) {
    const result = await runInSystemCloudWorkspaceScope(() => this.prisma.resourcePatrolSettings.updateMany({
      where: { id: 'default', leaseToken: token, leaseUntil: { gt: new Date() } }, data: { leaseUntil: new Date(Date.now() + 120_000) } }));
    if (result.count !== 1) throw new ConflictException('巡检租约已失效，停止写入巡检结果。');
  }

  async finish(token: string, now: Date, regions: string[], error: string | null, cloudWorkspaceId?: string | null) {
    await runInSystemCloudWorkspaceScope(() => this.prisma.resourcePatrolSettings.updateMany({ where: { id: 'default', leaseToken: token },
      data: { leaseToken: null, leaseUntil: null, lastScanAt: now, lastScanWorkspaceId: cloudWorkspaceId ?? null, lastScanError: error, regions } }));
  }

  async list(status?: ResourceAlertStatus) {
    return (await this.prisma.cloudResourceDrift.findMany({ where: { ...(status ? { patrolStatus: status } : {}) },
      orderBy: [{ lastSeenAt: 'desc' }, { id: 'asc' }] })).map(storedResourceAlert);
  }

  async get(id: string) {
    const row = await this.prisma.cloudResourceDrift.findUnique({ where: { id } });
    return row ? storedResourceAlert(row) : null;
  }

  async observe(input: { provider: 'alibaba_cloud' | 'tencent_cloud'; accountUid: string; regionId: string; resource: ResourceIdentity;
    rangeInstanceId: string | null; status: 'pending' | 'unverified'; reason: string; evidence: Record<string, unknown>; now: Date; leaseToken?: string }) {
    return this.withScanLease(input.leaseToken,async db => {
    const cloudWorkspaceId = requireCurrentCloudWorkspaceId();
    const identity = { cloudWorkspaceId, cloudProvider: input.provider, regionId: input.regionId,
      cloudResourceType: input.resource.type, cloudResourceId: input.resource.id };
    const existing = await db.cloudResourceDrift.findUnique({
      where: { cloudWorkspaceId_cloudProvider_regionId_cloudResourceType_cloudResourceId: identity } });
    const previous = existing?.sourceEvidence && typeof existing.sourceEvidence === 'object' && !Array.isArray(existing.sourceEvidence)
      ? existing.sourceEvidence as Record<string,unknown> : {};
    const { history: oldHistory, ...priorEvidence } = previous;
    const history = Array.isArray(oldHistory) ? [...oldHistory] : [];
    if (existing && JSON.stringify(priorEvidence) !== JSON.stringify(input.evidence)) history.push({
      observedAt: existing.lastSeenAt.toISOString(), status: existing.patrolStatus, evidence: priorEvidence,
    });
    const data = { accountUid: input.accountUid, rangeInstanceId: input.rangeInstanceId, severity: 'critical' as const,
      reason: input.reason, sourceEvidence: { ...input.evidence,history } as Prisma.InputJsonValue, lastSeenAt: input.now };
    if (existing) {
      // A background observation cannot undo a confirmed cleanup or discard its failure evidence.
      const preserve = ['reclaiming', 'failed'].includes(existing.patrolStatus);
      await db.cloudResourceDrift.update({ where: { id: existing.id }, data: { ...data,
        ...(preserve ? {} : { patrolStatus: input.status, resolvedAt: null }) } });
    } else {
      await db.cloudResourceDrift.create({ data: { ...identity, ...data, firstSeenAt: input.now,
        patrolStatus: input.status, tagsSnapshot: {}, remainingResources: [input.resource] } });
    }
    });
  }

  async resolve(id: string, now: Date, leaseToken?: string) {
    await this.withScanLease(leaseToken,db => db.cloudResourceDrift.updateMany({ where: { id, resolvedAt: null },
      data: { patrolStatus: 'resolved', resolvedAt: now, remainingResources: [], errorSummary: null } }));
  }

  async failed(id: string, remainingResources: ResourceIdentity[], message: string, leaseToken?: string) {
    await this.withScanLease(leaseToken,db => db.cloudResourceDrift.updateMany({ where: { id, resolvedAt: null },
      data: { patrolStatus: 'failed', remainingResources: remainingResources as Prisma.InputJsonValue, errorSummary: message } }));
  }

  private async withScanLease<T>(token: string | undefined, work: (db: Prisma.TransactionClient | PrismaService) => Promise<T>): Promise<T> {
    if (!token) return work(this.prisma);
    const workspace = requireCurrentCloudWorkspaceId();
    return this.prisma.$transaction(async tx => {
      const held = await tx.$queryRaw<Array<{id:string}>>`SELECT s.id FROM "ResourcePatrolSettings" s
        JOIN "PlatformUser" u ON u.id=s."managerUserId"
        WHERE s.id='default' AND s."leaseToken"=${token} AND s."leaseUntil">CURRENT_TIMESTAMP
          AND u."selectedCloudWorkspaceId"=${workspace} AND u."isPlatformManager"=TRUE AND u.status='active'
        FOR UPDATE OF s`;
      if (held.length !== 1) throw new ConflictException('巡检目标或租约已变化，保留旧告警。');
      return work(tx);
    }, {timeout:10_000,maxWait:5_000});
  }

  async queueReclaim(input: { alert: StoredResourceAlert; instance: RangeInstanceRecord; summary: RangeResourceSummary;
    resources: ResourceIdentity[]; planDigest: string; idempotencyKey: string; actorUserId: string }) {
    const cloudWorkspaceId = requireCurrentCloudWorkspaceId();
    return this.prisma.$transaction(async tx => {
      const [lock] = await tx.$queryRaw<Array<{ acquired: boolean }>>`SELECT pg_try_advisory_xact_lock(hashtextextended(${`resource-reclaim:${cloudWorkspaceId}:${input.instance.id}`}, 0)) AS acquired`;
      if (!lock?.acquired) throw new ConflictException('同一实例的资源回收正在受理。');
      const existing = await tx.cloudResourceDrift.findUnique({ where: { id: input.alert.id } });
      if (!existing || existing.accountUid !== input.alert.accountUid || existing.regionId !== input.alert.regionId) throw new ConflictException('资源告警来源已变化。');
      if (existing.patrolStatus === 'reclaiming' && existing.reclaimJobId) return { jobId: existing.reclaimJobId };
      if (existing.updatedAt.getTime() !== input.alert.updatedAt.getTime()) throw new ConflictException('资源告警已变化，请重新预览。');
      // Preserve the established job -> instance row lock order.
      if (input.instance.lastJobId) await tx.$queryRaw`SELECT id FROM "ProvisionJob" WHERE id = ${input.instance.lastJobId}
        AND "cloudWorkspaceId" = ${cloudWorkspaceId} FOR UPDATE`;
      const locked = await tx.rangeInstance.updateMany({ where: { id: input.instance.id, updatedAt: input.instance.updatedAt,
        status: { in: ['destroyed', 'create_failed', 'destroy_failed'] }, cloudProvider: input.alert.provider },
        data: { draftRevision: { increment: 0 } } });
      if (locked.count !== 1 || await tx.provisionJob.count({ where: { rangeInstanceId: input.instance.id,
        status: { in: ['pending', 'running'] } } })) throw new ConflictException('实例状态或作业已变化，请重新预览。');
      const job = await tx.provisionJob.create({ data: { rangeInstanceId: input.instance.id, jobType: 'destroy',
        triggeredBy: `resource-alert:${input.actorUserId}`, topologySnapshot: { resourceAlertPlan: {
          alertId: input.alert.id, accountUid: input.alert.accountUid, regionId: input.alert.regionId,
          planDigest: input.planDigest, resources: input.resources } } as Prisma.InputJsonValue } });
      await tx.rangeInstance.update({ where: { id: input.instance.id }, data: { status: 'pending_destroy', lastJobId: job.id,
        resourceSummary: input.summary as unknown as Prisma.InputJsonValue, errorSummary: null } });
      await tx.cloudResourceDrift.updateMany({ where: { rangeInstanceId: input.instance.id, resolvedAt: null,
        accountUid: input.alert.accountUid, regionId: input.alert.regionId }, data: { patrolStatus: 'reclaiming', reclaimJobId: job.id,
        reclaimKey: input.idempotencyKey, remainingResources: input.resources as Prisma.InputJsonValue, errorSummary: null } });
      return { jobId: job.id };
    }, { timeout: 10_000, maxWait: 5_000 });
  }
}
