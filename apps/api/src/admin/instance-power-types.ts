import { createHash } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import type { RangeInstanceRecord, ProvisionJobRecord } from './admin.repository';

export type PowerAction = 'economical_stop' | 'resume';
export type PowerTarget = { kind: 'single' | 'single_batch' | 'range' | 'range_batch'; id: string };
export type PowerHost = {
  nodeId: string; name: string; instanceId: string; sourceJobId: string; tagJobId: string;
  networkDigest: string; diskIds: string[]; originalStatus: string; originalStoppedMode: string | null;
  autoReleaseTime?: string | null;
};
export type PowerPlan = {
  version: 1; target: PowerTarget; instanceId: string; instanceName: string; instanceMode: 'single' | 'range';
  cloudWorkspaceId: string; ownerUserId: string; cloudAccountContextId: string; accountUid: string; regionId: string;
  sourceDigest: string; expiresAt: string | null; hosts: PowerHost[]; previousJobId: string | null;
};
export type PowerHostFact = { instanceId: string; status: string; stoppedMode: string | null; publicIp: string | null; checkedAt: string };
export type PowerSchedule = {
  id: string; revision: number; at: string; triggeredBy: string; createdAt: string; updatedAt: string;
  status: 'scheduled' | 'queued' | 'succeeded' | 'failed' | 'cancelled'; plan: PowerPlan;
  jobId?: string; message?: string;
};
export type InstancePowerControl = {
  version: 1; state: 'running' | 'economical_stopped' | 'stopped_standard' | 'partial' | 'unknown';
  phase?: 'stopping' | 'starting'; jobId?: string; checkedAt?: string; error?: string | null;
  hosts?: Record<string, PowerHostFact>; schedule?: PowerSchedule | null;
};
export function publicPowerControl(control?: InstancePowerControl | null): (Omit<InstancePowerControl, 'schedule'> & { schedule?: Omit<PowerSchedule, 'plan'> | null }) | null {
  if (!control) return null;
  const { schedule, ...facts } = control;
  if (!schedule) return facts;
  const { plan, ...publicSchedule } = schedule;
  return { ...facts, schedule: publicSchedule };
}
export const POWER_WARNINGS = [
  '此操作正常关机并释放计算资源，不销毁 ECS 或磁盘；未持久化的内存数据及当前连接会丢失。',
  '云盘、快照、EIP、NAT 等保留资源仍可能计费；节省停机不等于整套靶场零费用。',
  '系统分配的公网 IP 可能被回收，恢复开机后会更新平台入口；私网 IP 与磁盘应保留。',
  '再次开机可能因库存不足而失败，平台不会换规格、重建或创建替代实例。',
  '原平台到期销毁时间不变；预约为一次性任务，执行前仍会核对原账号、来源和权限。',
];
export const powerHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const isPowerJob = (job: Pick<ProvisionJobRecord, 'jobType'> | null | undefined) => job?.jobType === 'economical_stop' || job?.jobType === 'resume';
export function powerSourceDigest(instance: RangeInstanceRecord) {
  const summary = instance.resourceSummary;
  return powerHash({ id: instance.id, workspace: instance.cloudWorkspaceId, owner: instance.ownerUserId, provider: instance.cloudProvider,
    mode: instance.instanceMode, expiresAt: instance.expiresAt?.toISOString(), config: instance.singleInstanceConfig,
    hostIds: summary?.hostIds, systemDiskIds: summary?.systemDiskIds, dataDiskIds: summary?.dataDiskIds,
    secondaryNetworkInterfaceIds: summary?.secondaryNetworkInterfaceIds, context: summary?.executionContext });
}
export function assertPowerAllowsMutation(instance: RangeInstanceRecord) {
  if (instance.powerControl?.phase || instance.powerControl && instance.powerControl.state !== 'running')
    throw new ConflictException('实例正在节省停机、恢复或待核验；请先通过电源任务核验或恢复原实例。');
}
