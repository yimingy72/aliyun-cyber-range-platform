import type { RangeResourceSummary } from './admin.repository';

export type DiskRpc = (action: string, parameters: Record<string, string>) => Promise<unknown>;
type Disk = { DiskId: string; InstanceId?: string; Type: 'system' | 'data'; DeleteWithInstance?: boolean;
  Tags?: { Tag?: Array<{ TagKey: string; TagValue: string }> };
};
export type AttachedDiskInventory = { systemDiskIds: string[]; dataDiskIds: string[]; unverifiedDisks: Array<{ id: string; deleteWithInstance: boolean | null }>; proofs: NonNullable<RangeResourceSummary['diskOwnershipProofs']> };

let activeQueries = 0;
const waitingQueries: Array<() => void> = [];
async function query(rpc: DiskRpc, action: string, parameters: Record<string, string>) {
  if (activeQueries >= 4) await new Promise<void>(resolve => waitingQueries.push(resolve));
  else activeQueries++;
  try { return await rpc(action, parameters); } finally {
    const next = waitingQueries.shift();
    if (next) next(); else activeQueries--;
  }
}

async function readDiskPages(rpc: DiskRpc, parameters: Record<string, string>) {
  const disks: Disk[] = [];
  let expectedTotal: number | undefined;
  for (let page = 1; page <= 100; page++) {
    const body = await query(rpc, 'DescribeDisks', { ...parameters, PageNumber: String(page), PageSize: '100' }) as any;
    const rows = body?.Disks?.Disk;
    if (typeof body?.RequestId !== 'string' || !body.RequestId || !Array.isArray(rows) || !Number.isSafeInteger(body.TotalCount) || body.TotalCount < 0
      || Number(body.PageNumber) !== page || Number(body.PageSize) < 1 || Number(body.PageSize) > 100
      || body.NextToken || expectedTotal !== undefined && expectedTotal !== body.TotalCount
      || rows.some(row => !row || typeof row.DiskId !== 'string' || !/^d-[A-Za-z0-9-]+$/.test(row.DiskId))
      || rows.length > Number(body.PageSize)) throw new Error('Disk inventory response is incomplete or malformed');
    expectedTotal = body.TotalCount;
    disks.push(...rows);
    if (new Set(disks.map(disk => disk.DiskId)).size !== disks.length || disks.length > body.TotalCount)
      throw new Error('Disk inventory contains duplicate or unexpected identities');
    if (disks.length === expectedTotal) return disks;
    if (!rows.length) throw new Error('Disk inventory pagination ended before all disks were returned');
  }
  throw new Error('Disk inventory exceeded its bounded pagination limit');
}

export async function readAttachedDiskInventory(input: { rpc: DiskRpc; instanceId: string;
  knownSystemDiskIds?: string[]; knownDataDiskIds?: string[]; expectedTags: Record<string, string> }): Promise<AttachedDiskInventory> {
  if (input.expectedTags.CreatedBy !== 'cyber-range-platform' || !input.expectedTags.RangeInstanceId
    || !['user', 'platform'].includes(input.expectedTags.PlatformScope)) throw new Error('Disk inventory requires proven platform ownership');
  const disks = await readDiskPages(input.rpc, { InstanceId: input.instanceId });
  const result: AttachedDiskInventory = { systemDiskIds: [], dataDiskIds: [], unverifiedDisks: [], proofs: {} };
  for (const disk of disks) {
    if (disk.InstanceId !== input.instanceId || !['system', 'data'].includes(disk.Type)
      || disk.DeleteWithInstance !== undefined && typeof disk.DeleteWithInstance !== 'boolean')
      throw new Error('Disk inventory contains an unexpected attachment or disk type');
    const tagRows = disk.Tags?.Tag ?? [];
    if (!Array.isArray(tagRows) || tagRows.some(tag => !tag || typeof tag.TagKey !== 'string' || typeof tag.TagValue !== 'string')
      || new Set(tagRows.map(tag => tag.TagKey)).size !== tagRows.length) throw new Error('Disk ownership tags are malformed');
    const tags = Object.fromEntries(tagRows.map(tag => [tag.TagKey, tag.TagValue]));
    const conflict = Object.entries(input.expectedTags).some(([key, value]) => tags[key] !== undefined && tags[key] !== value);
    const tagged = Object.entries(input.expectedTags).every(([key, value]) => tags[key] === value);
    const known = (disk.Type === 'system' ? input.knownSystemDiskIds : input.knownDataDiskIds)?.includes(disk.DiskId);
    if (!conflict && (tagged || known)) {
      (disk.Type === 'system' ? result.systemDiskIds : result.dataDiskIds).push(disk.DiskId);
      result.proofs[disk.DiskId] = { instanceId: input.instanceId, method: known ? 'persisted' : 'tags' };
    } else result.unverifiedDisks.push({ id: disk.DiskId, deleteWithInstance: disk.DeleteWithInstance ?? null });
  }
  return result;
}

export async function findExistingInventoryDiskIds(rpc: DiskRpc, ids: string[]) {
  const unique = [...new Set(ids)], existing: string[] = [];
  for (let offset = 0; offset < unique.length; offset += 100) {
    const requested = unique.slice(offset, offset + 100);
    const disks = await readDiskPages(rpc, { DiskIds: JSON.stringify(requested) });
    if (disks.some(disk => !requested.includes(disk.DiskId))) throw new Error('Disk verification returned an unrequested identity');
    existing.push(...disks.map(disk => disk.DiskId));
  }
  return existing;
}

export function inventoryDiskIds(summary: RangeResourceSummary | null | undefined) {
  return [...new Set([...Object.values(summary?.systemDiskIds ?? {}), ...Object.values(summary?.dataDiskIds ?? {})])];
}
export function mergeDiskInventory(summary: RangeResourceSummary, hostKey: string, disks: AttachedDiskInventory): RangeResourceSummary {
  return { ...summary, diskOwnershipProofs: { ...summary.diskOwnershipProofs, ...disks.proofs },
    systemDiskIds: { ...summary.systemDiskIds, ...Object.fromEntries(disks.systemDiskIds.map((id, index) => [index ? `${hostKey}:${id}` : hostKey, id])) },
    dataDiskIds: { ...summary.dataDiskIds, ...Object.fromEntries(disks.dataDiskIds.map(id => [`${hostKey}:${id}`, id])) },
    unverifiedDiskIds: { ...summary.unverifiedDiskIds, ...Object.fromEntries(disks.unverifiedDisks.map(disk => [`${hostKey}:${disk.id}`, disk.id])) } };
}
export function assertDiskInventorySafe(inventory: AttachedDiskInventory, destroying: boolean) {
  if (inventory.unverifiedDisks.some(disk => !destroying || disk.deleteWithInstance !== false))
    throw new Error('Attached disk ownership is unverified; preserve resource inventory before billing or deleting the ECS');
}
