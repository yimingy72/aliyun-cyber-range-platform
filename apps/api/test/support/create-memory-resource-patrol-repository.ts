import { ConflictException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AdminRepository } from '../../src/admin/admin.repository';
import { requireCurrentCloudWorkspaceId } from '../../src/auth/cloud-workspace-scope';
import type { ResourcePatrolRepository } from '../../src/admin/resource-patrol.repository';
import type { PatrolSettings, StoredResourceAlert } from '../../src/admin/resource-alert-types';

export function createMemoryResourcePatrolRepository(repository: AdminRepository, target: Record<string,any>) {
  const alerts: StoredResourceAlert[] = [];
  const settings: PatrolSettings = { managerUserId: 'admin', lastScanAt: null, lastScanError: null, regions: [] };
  let lease: string | null = null;
  return {
    alerts, settingsValue: settings, targetValue: target,
    settings: async () => ({ ...settings }), target: async () => ({ ...target }),
    setManager: async (id: string) => { settings.managerUserId = id; },
    tryLease: async () => { if (lease || !settings.managerUserId) return null; lease = randomUUID(); return lease; },
    heartbeat: async (token: string) => { if (token !== lease) throw new Error('lease lost'); },
    finish: async (token: string, now: Date, regions: string[], error: string | null) => { if (lease === token) {
      lease = null; settings.lastScanAt = now; settings.lastScanError = error; settings.regions = regions;
    } },
    list: async (status?: string) => alerts.filter(row => row.cloudWorkspaceId === requireCurrentCloudWorkspaceId() && (!status || row.status === status)),
    get: async (id: string) => alerts.find(row => row.id === id && row.cloudWorkspaceId === requireCurrentCloudWorkspaceId()) ?? null,
    observe: async (input: any) => {
      const workspace = requireCurrentCloudWorkspaceId();
      const existing = alerts.find(row => row.cloudWorkspaceId === workspace && row.provider === input.provider && row.regionId === input.regionId
        && row.type === input.resource.type && row.resourceId === input.resource.id);
      if (existing) Object.assign(existing,{ lastSeenAt: input.now, evidence: input.evidence,
        ...(['reclaiming','failed'].includes(existing.status) ? {} : {status: input.status}) });
      else alerts.push({ id: randomUUID(), cloudWorkspaceId: workspace, provider: input.provider, accountUid: input.accountUid,
        regionId: input.regionId, type: input.resource.type, resourceId: input.resource.id, rangeInstanceId: input.rangeInstanceId,
        rangeName: input.evidence.rangeName ?? null, reason: input.reason, status: input.status, firstSeenAt: input.now, lastSeenAt: input.now,
        evidenceSummary: { recordedInventory: input.evidence.recordedInventory, sourceJobIds: input.evidence.sourceJobIds, accountVerified: true },
        evidence: input.evidence, remainingResources: [input.resource], errorSummary: null, jobId: null, updatedAt: input.now });
    },
    resolve: async (id: string) => { const row = alerts.find(row => row.id === id)!; row.status = 'resolved'; row.remainingResources = []; },
    failed: async (id: string, remainingResources: any[], error: string) => { Object.assign(alerts.find(row => row.id === id)!,{ status: 'failed',remainingResources,errorSummary:error }); },
    queueReclaim: async (input: any) => repository.withSingleInstanceControlLock(async () => {
      const existing = alerts.find(row => row.id === input.alert.id)!;
      if (existing.status === 'reclaiming' && existing.jobId) return { jobId: existing.jobId };
      const instance = await repository.getRangeInstanceById(input.instance.id);
      if (!instance || instance.updatedAt.getTime() !== input.instance.updatedAt.getTime()
        || (await repository.listProvisionJobs()).some(job => job.rangeInstanceId === instance.id && ['pending','running'].includes(job.status))) throw new ConflictException();
      const job = await repository.createProvisionJob({ rangeInstanceId: instance.id, jobType:'destroy', triggeredBy:`resource-alert:${input.actorUserId}` });
      await repository.updateRangeInstance(instance.id,{ status:'pending_destroy',lastJobId:job.id,resourceSummary:input.summary });
      alerts.filter(row => row.rangeInstanceId === instance.id && row.status !== 'resolved').forEach(row => Object.assign(row,{status:'reclaiming',jobId:job.id,remainingResources:input.resources}));
      return {jobId:job.id};
    }),
  } as unknown as ResourcePatrolRepository & { alerts: StoredResourceAlert[]; settingsValue: PatrolSettings; targetValue: Record<string,any> };
}
