import type { AdminRepository, BillingLedgerResourceRecord, BillingLineItemRecord, RangeInstanceRecord } from './admin.repository';
import { ledgerBillingDateMatches } from './billing-platform-scope';

const namespace = (value: { cloudWorkspaceId?: string }) => value.cloudWorkspaceId ?? 'legacy-unbound';
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function systemDiskComponent(item: BillingLineItemRecord) {
  if (item.cloudResourceType !== 'ecs') return false;
  if ((item.cloudProvider ?? 'alibaba_cloud') === 'alibaba_cloud') return item.rawPayload.ProductCode === 'ecs'
    && (item.rawPayload.BillingItemCode === 'SystemDiskSize' || item.rawPayload.BillingItem === '系统盘');
  const index = item.rawPayload.__platformBillingComponentIndex;
  const component = Array.isArray(item.rawPayload.ComponentSet) && Number.isSafeInteger(index)
    ? item.rawPayload.ComponentSet[index as number] as Record<string, unknown> | undefined : null;
  return component?.ComponentCode === 'v_cvm_rootdisk';
}

function sameCreation(disk: BillingLedgerResourceRecord, host: BillingLedgerResourceRecord) {
  return namespace(disk) === namespace(host) && disk.cloudProvider === host.cloudProvider && disk.cloudAccountUid === host.cloudAccountUid
    && disk.regionId === host.regionId && disk.ownerUserId === host.ownerUserId && disk.billingScope === host.billingScope
    && disk.rangeInstanceId === host.rangeInstanceId && disk.singleInstanceBatchId === host.singleInstanceBatchId
    && Boolean(disk.sourceProvisionJobId) && disk.sourceProvisionJobId === host.sourceProvisionJobId;
}

function frozenContextMatches(context: unknown, disk: BillingLedgerResourceRecord, instance: RangeInstanceRecord, requireProvider = false) {
  if (!object(context) || context.cloudAccountUid !== disk.cloudAccountUid || context.regionId !== disk.regionId) return false;
  return (requireProvider ? context.provider : context.provider ?? instance.cloudProvider) === disk.cloudProvider
    && typeof context.cloudAccountContextId === 'string' && Boolean(context.cloudAccountContextId);
}

function diskRelation(summary: unknown, diskId: string, depth = 0): { systemHosts: Set<string>; isDataDisk: boolean } {
  const systemHosts = new Set<string>();
  if (!object(summary) || depth > 1) return { systemHosts, isDataDisk: false };
  const system = object(summary.systemDiskIds) ? summary.systemDiskIds : {};
  const hosts = object(summary.hostIds) ? summary.hostIds : {};
  const data = object(summary.dataDiskIds) ? summary.dataDiskIds : {};
  for (const [key, id] of Object.entries(system)) {
    if (id !== diskId) continue;
    const attached = object(summary.diskOwnershipProofs) && object(summary.diskOwnershipProofs[diskId])
      ? summary.diskOwnershipProofs[diskId].instanceId : null;
    const keyedHost = hosts[key];
    if (typeof attached === 'string' && Object.values(hosts).includes(attached) && (keyedHost == null || keyedHost === attached)) systemHosts.add(attached);
    else if (attached == null && typeof keyedHost === 'string') systemHosts.add(keyedHost);
  }
  const retired = diskRelation(summary.retiredResources, diskId, depth + 1);
  for (const host of retired.systemHosts) systemHosts.add(host);
  return { systemHosts, isDataDisk: Object.values(data).includes(diskId) || retired.isDataDisk };
}

// A host bill proves its system-disk component was billed, not which historical disk it covered.
export async function systemDiskBillingCoverage(repository: AdminRepository, disks: BillingLedgerResourceRecord[],
  ledgers: BillingLedgerResourceRecord[], items: BillingLineItemRecord[]) {
  const components = items.filter(systemDiskComponent);
  const billedHostIds = new Set(components.map(item => item.matchedLedgerId));
  const hosts = ledgers.filter(ledger => ledger.cloudResourceType === 'ecs' && billedHostIds.has(ledger.id));
  const billedParent = (disk: BillingLedgerResourceRecord, host: BillingLedgerResourceRecord) => sameCreation(disk, host)
    && components.some(item => item.matchedLedgerId === host.id && ledgerBillingDateMatches(disk, item.billingDate.toISOString().slice(0, 10)));
  const candidates = disks.filter(disk => hosts.some(host => billedParent(disk, host)));
  const covered = new Set<string>(), mappingPending = new Set<string>();
  if (!candidates.length) return { covered, mappingPending };
  const [instances, jobs] = await Promise.all([repository.listRangeInstances(), repository.listProvisionJobs()]);
  const summaries = new Map<string, Array<{ resources: unknown; executionContext: unknown }>>();
  const scopedInstances = instances.filter(instance => candidates.some(disk => instance.id === disk.rangeInstanceId
    && namespace(instance) === namespace(disk) && instance.cloudProvider === disk.cloudProvider
    && (instance.ownerUserId ?? null) === disk.ownerUserId && (instance.singleInstanceBatchId ?? null) === disk.singleInstanceBatchId));
  for (const instance of scopedInstances) {
    const context = instance.resourceSummary?.executionContext ?? instance.singleInstanceConfig;
    if (instance.resourceSummary) summaries.set(instance.id, [{ resources: instance.resourceSummary, executionContext: context }]);
  }
  await Promise.all(jobs.filter(job => ['create', 'retry', 'update', 'destroy'].includes(job.jobType)
    && scopedInstances.some(instance => instance.id === job.rangeInstanceId && namespace(instance) === namespace(job))).map(async job => {
    const instance = scopedInstances.find(row => row.id === job.rangeInstanceId)!;
    const disk = candidates.find(row => row.rangeInstanceId === instance.id)!;
    for (const log of await repository.listProvisionJobStepLogs(job.id)) {
      if (log.jobId !== job.id || namespace(log) !== namespace(job) || log.stepName !== 'range_resource_inventory'
        || log.status !== 'succeeded' || !log.message || log.message.length > 1024 * 1024) continue;
      let value: unknown; try { value = JSON.parse(log.message); } catch { continue; }
      if (!object(value) || value.version !== 1 || value.rangeInstanceId !== instance.id
        || !frozenContextMatches(value.executionContext, disk, instance, true)
        || value.cloudWorkspaceId != null && value.cloudWorkspaceId !== namespace(disk)
        || value.cloudProvider != null && value.cloudProvider !== disk.cloudProvider
        || value.ownerUserId !== undefined && value.ownerUserId !== disk.ownerUserId
        || value.singleInstanceBatchId !== undefined && value.singleInstanceBatchId !== disk.singleInstanceBatchId
        || value.sourceJobId != null && value.sourceJobId !== job.id) continue;
      const existing = summaries.get(instance.id) ?? [];
      existing.push({ resources: value.resources, executionContext: value.executionContext });
      summaries.set(instance.id, existing);
    }
  }));
  for (const disk of candidates) {
    const systemHosts = new Set<string>();
    let isDataDisk = false;
    const instance = scopedInstances.find(row => row.id === disk.rangeInstanceId);
    if (!instance) continue;
    for (const summary of summaries.get(disk.rangeInstanceId!) ?? []) {
      if (!frozenContextMatches(summary.executionContext, disk, instance)) continue;
      const relation = diskRelation(summary.resources, disk.cloudResourceId);
      for (const id of relation.systemHosts) systemHosts.add(id);
      isDataDisk ||= relation.isDataDisk;
    }
    if (!isDataDisk && systemHosts.size === 1 && hosts.some(host => billedParent(disk, host) && systemHosts.has(host.cloudResourceId))) covered.add(disk.id);
    else if (!isDataDisk || systemHosts.size) mappingPending.add(disk.id);
  }
  return { covered, mappingPending };
}
