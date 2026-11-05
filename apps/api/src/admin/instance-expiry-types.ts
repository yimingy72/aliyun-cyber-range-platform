import type { PowerPlan } from './instance-power-types';
import type { AdminRepository, RangeInstanceRecord } from './admin.repository';

export type ExpiryPlan = PowerPlan & {
  requestedExpiresAt: string;
  effectiveExpiresAt: string;
  cloudReleaseAt: string;
};

export const EXPIRY_WARNINGS = [
  '仅修改回收时间，不重启实例，不更改网络、磁盘或登录信息。',
  '延期须等全部云端定时释放核验成功才生效；提前回收在任务受理后按新时间执行。',
  '同步失败或结果待核验时，平台保留较早的回收时间；请查看原任务，不要重复提交。',
];

/** A recorded edit authorizes only the deadline fields, never adoption of another resource. */
export async function verifiedExpiryEdit(repository: AdminRepository, instance: RangeInstanceRecord) {
  const id = instance.resourceSummary?.expiryChangeJobId;
  if (!id) return null;
  const job = await repository.getProvisionJobById(id), plan = job?.topologySnapshot?.expiryPlan;
  const source = instance.instanceMode === 'single' ? instance.singleInstanceConfig : instance.resourceSummary?.executionContext;
  if (!job || job.jobType !== 'change_expiry' || !plan || plan.version !== 1 || job.rangeInstanceId !== instance.id
    || plan.instanceId !== instance.id || job.cloudWorkspaceId !== instance.cloudWorkspaceId || plan.cloudWorkspaceId !== instance.cloudWorkspaceId
    || plan.ownerUserId !== instance.ownerUserId || plan.cloudAccountContextId !== source?.cloudAccountContextId
    || plan.accountUid !== source.cloudAccountUid || plan.regionId !== source.regionId
    || Date.parse(job.status === 'succeeded' ? plan.requestedExpiresAt : plan.effectiveExpiresAt) !== instance.expiresAt?.getTime()
    || plan.hosts.some(host => instance.resourceSummary?.hostIds?.[host.nodeId] !== host.instanceId))
    throw new Error('Recorded expiry change does not match its original instance, account or approved time');
  return { job, plan };
}
