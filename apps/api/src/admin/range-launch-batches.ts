import type { RangeInstanceRecord, RangeLaunchReceipt } from './admin.repository';

export type RangeLaunchBatch = { id: string; name: string; index: number; quantity: number };

// The web launch helper already persists UUID-member keys. Names alone never prove membership.
export function rangeLaunchBatches(instances: Pick<RangeInstanceRecord, 'id' | 'name' | 'instanceMode' | 'ownerUserId' | 'cloudWorkspaceId' | 'templateId'>[], receipts: RangeLaunchReceipt[]) {
  const byId = new Map(instances.filter(instance => instance.instanceMode === 'range').map(instance => [instance.id, instance]));
  const groups = new Map<string, { name: string; templateId: string | null; valid: boolean; members: Map<number, string> }>();
  const seen = new Map<string, string>();
  for (const receipt of receipts) {
    const instance = byId.get(receipt.rangeInstanceId);
    const match = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-([1-9]\d?)$/i.exec(receipt.idempotencyKey);
    if (!instance || !match || !instance.ownerUserId || receipt.actorUserId !== instance.ownerUserId
      || receipt.cloudWorkspaceId !== (instance.cloudWorkspaceId ?? 'legacy-unbound')) continue;
    const index = Number(match[2]), suffix = `-${index}`;
    if (!instance.name.endsWith(suffix) || instance.name.length === suffix.length) continue;
    const name = instance.name.slice(0, -suffix.length);
    const id = JSON.stringify([receipt.cloudWorkspaceId, receipt.actorUserId, match[1].toLowerCase()]);
    const group = groups.get(id) ?? { name, templateId: instance.templateId, valid: true, members: new Map<number, string>() };
    if (group.name !== name || group.templateId !== instance.templateId || group.members.has(index) || seen.has(instance.id)) group.valid = false;
    const previous = seen.get(instance.id);
    if (previous) groups.get(previous)!.valid = false;
    group.members.set(index, instance.id);
    seen.set(instance.id, id);
    groups.set(id, group);
  }
  const result = new Map<string, RangeLaunchBatch>();
  for (const [id, group] of groups) {
    if (!group.valid) continue;
    for (const [index, instanceId] of group.members) result.set(instanceId, { id, name: group.name, index, quantity: group.members.size });
  }
  return result;
}
