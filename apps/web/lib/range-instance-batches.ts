import type { RangeInstance } from './admin-types';
import { instancePowerStatus, POWER_STATUS_LABELS } from './instance-power-state';

export type RangeInstanceGroup = { id: string; name: string; isBatch: boolean; quantity: number; instances: RangeInstance[] };

export function groupRangeInstances(instances: RangeInstance[], search = '') {
  const groups = new Map<string, RangeInstanceGroup>();
  for (const instance of instances) {
    const batch = instance.launchBatch;
    const id = batch ? `batch:${batch.id}` : `instance:${instance.id}`;
    const group = groups.get(id) ?? { id, name: batch?.name ?? (instance.name?.trim() || instance.id),
      isBatch: Boolean(batch), quantity: batch?.quantity ?? 1, instances: [] };
    group.instances.push(instance);
    groups.set(id, group);
  }
  const keyword = search.trim().toLowerCase();
  return [...groups.values()].filter(group => !keyword || group.name.toLowerCase().includes(keyword)
    || group.instances.some(instance => instance.name?.toLowerCase().includes(keyword))).map(group => ({ ...group,
    instances: group.isBatch ? [...group.instances].sort((a, b) => (a.launchBatch?.index ?? 0) - (b.launchBatch?.index ?? 0)) : group.instances,
  }));
}

export function rangeBatchStatus(instances: RangeInstance[]) {
  const labels: Record<string, string> = { running: '运行中', pending_create: '等待创建', creating: '创建中', create_failed: '创建失败',
    pending_destroy: '等待销毁', destroying: '销毁中', destroy_failed: '销毁失败', destroyed: '已销毁', pending_update: '等待更新', updating: '更新中' };
  const counts = new Map<string, number>();
  for (const instance of instances) { const status = instancePowerStatus(instance); counts.set(status, (counts.get(status) ?? 0) + 1); }
  return [...counts].map(([status, count]) => `${count} ${POWER_STATUS_LABELS[status] ?? labels[status] ?? '状态未知'}`).join(' / ');
}

export function rangeBatchBusy(instances: RangeInstance[]) {
  return instances.some(instance => Boolean(instance.powerControl?.phase) || ['pending_create', 'creating', 'pending_update', 'updating'].includes(instance.status));
}
