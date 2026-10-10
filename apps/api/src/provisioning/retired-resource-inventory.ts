import type { RangeResourceSummary } from '../admin/admin.repository';

const maps = ['hostIds', 'systemDiskIds', 'dataDiskIds', 'routeTableIds', 'subnetIds', 'networkAclIds', 'securityGroupIds',
  'secondaryNetworkInterfaceIds', 'natGatewayIds', 'snatEntryIds', 'dnatEntryIds', 'eipAllocationIds'] as const;

// Keep replaced IDs apart from the current host map used by the detail page and node actions.
export function retiredResourceInventory(before: RangeResourceSummary | null | undefined, current: RangeResourceSummary): RangeResourceSummary | null {
  if (!before) return null;
  const retired: RangeResourceSummary = { mode: 'opentofu', ...(before.executionContext ? { executionContext: before.executionContext } : {}) };
  let found = false;
  for (const field of maps) {
    const active = new Set(Object.values(current[field] ?? {}));
    if (field === 'dataDiskIds' || field === 'systemDiskIds') {
      for (const id of [...Object.values(current.systemDiskIds ?? {}), ...Object.values(current.dataDiskIds ?? {})]) active.add(id);
    }
    const ids = [...Object.values(before.retiredResources?.[field] ?? {}), ...Object.values(before[field] ?? {})].filter(id => id && !active.has(id));
    if (ids.length) { retired[field] = Object.fromEntries([...new Set(ids)].map(id => [id,id])); found = true; }
  }
  const oldVpc = before.retiredResources?.vpcId ?? (before.vpcId !== current.vpcId ? before.vpcId : null);
  if (oldVpc && oldVpc !== current.vpcId) { retired.vpcId = oldVpc; found = true; }
  const eips = [before.retiredResources?.eipAllocationId, before.eipAllocationId].filter((id): id is string => Boolean(id));
  for (const id of eips) if (id !== current.eipAllocationId && !Object.values(current.eipAllocationIds ?? {}).includes(id)) {
    retired.eipAllocationIds = { ...retired.eipAllocationIds, [id]: id }; found = true;
  }
  return found ? retired : null;
}

export function retiredBillableIds(summary: RangeResourceSummary) {
  return new Set([...Object.values(summary.hostIds ?? {}), ...Object.values(summary.systemDiskIds ?? {}), ...Object.values(summary.dataDiskIds ?? {}),
    ...Object.values(summary.natGatewayIds ?? {}), ...Object.values(summary.eipAllocationIds ?? {}), ...Object.values(summary.snatEntryIds ?? {}),
    ...Object.values(summary.dnatEntryIds ?? {}), ...(summary.eipAllocationId ? [summary.eipAllocationId] : [])]);
}
