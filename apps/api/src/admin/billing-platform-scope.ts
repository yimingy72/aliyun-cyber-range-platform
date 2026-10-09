import type { AdminRepository, BillingImageImportResourceRecord, BillingLedgerResourceRecord, PackedImageArtifactRecord, RangeResourceSummary } from './admin.repository';
import { classifyBillLine } from './billing-classifier';
import { billingDayText } from './billing-window';

const REGION_ID = /^(cn|ap|eu|us|me|af|sa)-[a-z0-9-]+$/;
const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';

export type PlatformBillingProof = {
  ledgers: BillingLedgerResourceRecord[];
  imageImports: BillingImageImportResourceRecord[];
  packedImages: PackedImageArtifactRecord[];
  createdLedgerIds: Set<string>;
  unverifiedSourceLedgerIds: Set<string>;
};

function inventoryIncludes(summary: RangeResourceSummary | null | undefined, ledger: BillingLedgerResourceRecord): boolean {
  if (!summary) return false;
  const ids = ledger.cloudResourceType === 'ecs' ? Object.values(summary.hostIds ?? {})
    : ledger.cloudResourceType === 'disk' ? [...Object.values(summary.systemDiskIds ?? {}), ...Object.values(summary.dataDiskIds ?? {})]
    : ledger.cloudResourceType === 'eip' ? [...Object.values(summary.eipAllocationIds ?? {}), summary.eipAllocationId]
    : ledger.cloudResourceType === 'nat_gateway' ? Object.values(summary.natGatewayIds ?? {})
    : ledger.cloudResourceType === 'snat_entry' ? Object.values(summary.snatEntryIds ?? {})
    : ledger.cloudResourceType === 'dnat_entry' ? Object.values(summary.dnatEntryIds ?? {}) : [];
  return ids.includes(ledger.cloudResourceId) || inventoryIncludes(summary.retiredResources, ledger);
}

export async function loadPlatformBillingProof(repository: AdminRepository, options: { ledgers?: BillingLedgerResourceRecord[] } = {}): Promise<PlatformBillingProof> {
  const [ledgers, imageImports, packedImages, instances, sourceJobs] = await Promise.all([
    options.ledgers ?? repository.listBillingLedgerResources(), repository.listBillingImageImportResources(),
    repository.listPackedImageArtifacts(), repository.listRangeInstances(), repository.listProvisionJobs(),
  ]);
  const jobs = new Map(sourceJobs.map(job => [job.id, job]));
  const instancesById = new Map(instances.map(instance => [instance.id, instance]));
  const launchInstanceIds = new Set(sourceJobs.filter(job => ['create', 'retry', 'update'].includes(job.jobType)).map(job => job.rangeInstanceId));
  const createdLedgerIds = new Set<string>();
  const unverifiedSourceLedgerIds = new Set<string>();
  for (const ledger of ledgers) {
    const sourceJob = ledger.sourceProvisionJobId ? jobs.get(ledger.sourceProvisionJobId) : null;
    const sourceInstance = instancesById.get(ledger.rangeInstanceId ?? '');
    const hasSource = Boolean(sourceInstance && (sourceJob?.rangeInstanceId === sourceInstance.id || launchInstanceIds.has(sourceInstance.id)))
      || packedImages.some(artifact => ledger.cloudResourceType === 'image' ? artifact.imageId === ledger.cloudResourceId : ledger.cloudResourceType === 'snapshot' && artifact.backingSnapshotIds.includes(ledger.cloudResourceId))
      || imageImports.some(job => ledger.cloudResourceType === 'image' ? job.imageId === ledger.cloudResourceId : ledger.cloudResourceType === 'snapshot' && job.backingSnapshotIds.includes(ledger.cloudResourceId));
    if (hasSource) unverifiedSourceLedgerIds.add(ledger.id);
    if (!ledger.cloudAccountUid || !REGION_ID.test(ledger.regionId) || !ledger.cloudResourceId.trim()
      || ['oss_bucket', 'snapshot_region', 'unknown'].includes(ledger.cloudResourceType)) continue;
    if (ledger.cloudResourceType === 'image' || ledger.cloudResourceType === 'snapshot') {
      const packed = packedImages.some(artifact => artifact.cloudAccountUid === ledger.cloudAccountUid && artifact.regionId === ledger.regionId
        && ledger.billingScope === 'user' && artifact.ownerUserId === ledger.ownerUserId && artifact.sourceRangeInstanceId === ledger.rangeInstanceId
        && (ledger.cloudResourceType === 'image' ? artifact.imageId === ledger.cloudResourceId : artifact.backingSnapshotIds.includes(ledger.cloudResourceId)));
      const imported = imageImports.some(job => job.cloudAccountUid === ledger.cloudAccountUid && job.regionId === ledger.regionId
        && ledger.billingScope === 'platform' && ledger.ownerUserId === null
        && (ledger.cloudResourceType === 'image' ? job.imageId === ledger.cloudResourceId : job.backingSnapshotIds.includes(ledger.cloudResourceId)));
      if (packed || imported) createdLedgerIds.add(ledger.id);
      continue;
    }
    const instance = instancesById.get(ledger.rangeInstanceId ?? '');
    const job = ledger.sourceProvisionJobId ? jobs.get(ledger.sourceProvisionJobId) : null;
    const context = instance?.singleInstanceConfig ?? instance?.resourceSummary?.executionContext;
    if (instance && job?.rangeInstanceId === instance.id && (['create', 'retry', 'update'].includes(job.jobType) || job.jobType === 'destroy' && inventoryIncludes(instance.resourceSummary, ledger))
      && (!context?.cloudAccountUid || context.cloudAccountUid === ledger.cloudAccountUid)
      && (!context?.regionId || context.regionId === ledger.regionId)
      && ledger.billingScope === (instance.ownerUserId ? 'user' : 'platform')
      && (instance.ownerUserId ?? null) === ledger.ownerUserId
      && (instance.singleInstanceBatchId ?? null) === ledger.singleInstanceBatchId) createdLedgerIds.add(ledger.id);
  }
  for (const id of createdLedgerIds) unverifiedSourceLedgerIds.delete(id);
  return { ledgers, imageImports, packedImages, createdLedgerIds, unverifiedSourceLedgerIds };
}

// Collection and tags are not creation proof; this set was checked against persisted job/artifact identities.
export function isPlatformCreatedLedger(ledger: BillingLedgerResourceRecord, proof: PlatformBillingProof) {
  return proof.createdLedgerIds.has(ledger.id);
}

export function classifyPlatformBillLine(line: Record<string, unknown>) {
  return classifyBillLine(line.__platformBillingSource === 'DescribeSplitItemBill' && line.ProductCode === 'snapshot' && /^s-[a-z0-9-]+$/i.test(text(line.SplitItemID))
    ? { ...line, InstanceID: text(line.SplitItemID) } : line);
}

export function billRegionConflict(line: Record<string, unknown>) {
  const explicit = [line.RegionId, line.Region].map(text).filter(value => REGION_ID.test(value));
  return new Set(explicit).size > 1 || Boolean(text(line.RegionId) && !REGION_ID.test(text(line.RegionId)));
}

export function billRegionId(line: Record<string, unknown>) {
  const explicit = [line.RegionId, line.Region].map(text).filter(value => REGION_ID.test(value));
  if (new Set(explicit).size > 1) return null;
  if (explicit.length) return explicit[0];
  const instanceRegion = text(line.InstanceID).split(';')[0];
  return REGION_ID.test(instanceRegion) ? instanceRegion : null;
}

export function ledgerBillingDateMatches(ledger: BillingLedgerResourceRecord, billingDate: string, correction = false) {
  if (billingDate < billingDayText(ledger.billingStartAt)) return false;
  if (!ledger.releasedAt || correction) return true;
  const graceEnd = new Date(`${billingDayText(ledger.releasedAt)}T00:00:00.000Z`);
  graceEnd.setUTCDate(graceEnd.getUTCDate() + 1);
  return billingDate <= graceEnd.toISOString().slice(0, 10);
}

export type PlatformBillingEvidence = {
  kind: 'resource_pending' | 'aggregate_pending' | 'source_pending';
  ledgerIds: string[];
  imageImportJobIds: string[];
};

// Keep account-wide source amounts for investigation, but never present them as platform payable amounts.
export function pendingPlatformBillingEvidence(input: {
  line: Record<string, unknown>;
  cloudAccountUid: string;
  billingDate: string;
  proof: PlatformBillingProof;
}): PlatformBillingEvidence | null {
  const classification = classifyPlatformBillLine(input.line);
  const regionId = billRegionId(input.line);
  const accountConflict = ['OwnerID', 'SplitAccountID'].some(key => input.line[key] != null
    && String(input.line[key]) !== input.cloudAccountUid);
  const correction = ['Refund', 'Adjustment'].includes(text(input.line.Item));
  const owned = input.proof.ledgers.filter(ledger => isPlatformCreatedLedger(ledger, input.proof)
    && ledger.cloudAccountUid === input.cloudAccountUid && input.billingDate >= billingDayText(ledger.billingStartAt));
  if (classification.kind !== 'aggregated') {
    // A late charge for a known released resource still needs investigation; do not silently drop it.
    const exact = owned.filter(ledger => ledger.cloudResourceId === classification.cloudResourceId);
    if (!exact.length) return null;
    const scoped = exact.filter(ledger => !regionId || ledger.regionId === regionId);
    return { kind: accountConflict || billRegionConflict(input.line) || scoped.length !== 1 ? 'source_pending' : 'resource_pending',
      ledgerIds: (scoped.length ? scoped : exact).map(ledger => ledger.id), imageImportJobIds: [] };
  }
  const candidates = owned.filter(ledger => ledger.regionId === regionId && ledgerBillingDateMatches(ledger, input.billingDate, correction));
  // An unknown aggregation region is not evidence that any platform resource participated.
  if (accountConflict || !regionId || billRegionConflict(input.line)) return null;
  if (classification.cloudResourceType === 'snapshot_region') {
    const splitId = text(input.line.SplitItemID);
    const snapshotIds = /^i-/.test(splitId) ? new Set(input.proof.packedImages.filter(artifact => artifact.cloudAccountUid === input.cloudAccountUid && artifact.regionId === regionId && artifact.sourceInstanceId === splitId).flatMap(artifact => artifact.backingSnapshotIds)) : null;
    const snapshots = candidates.filter(ledger => ledger.cloudResourceType === 'snapshot' && (!snapshotIds || snapshotIds.has(ledger.cloudResourceId)));
    return snapshots.length ? { kind: 'aggregate_pending', ledgerIds: snapshots.map(ledger => ledger.id), imageImportJobIds: [] } : null;
  }
  const identifiers = (text(input.line.SplitItemID) ? ['SplitItemID'] : ['InstanceID', 'InstanceName', 'NickName', 'ResourceId', 'ResourceName']).map(key => text(input.line[key])).filter(Boolean);
  const imports = input.proof.imageImports.filter(job => job.cloudAccountUid === input.cloudAccountUid
    && job.regionId === regionId && job.imageImportBucket && job.objectKey
    && billingDayText(job.createdAt) <= input.billingDate
    && (!job.temporaryObjectDeletedAt || correction || input.billingDate <= billingDayText(job.temporaryObjectDeletedAt))
    && identifiers.some(value => value === regionId || value.startsWith(`${regionId};`)
      || value === job.imageImportBucket || value.startsWith(`${job.imageImportBucket};`)
      || value === `${job.imageImportBucket}/${job.objectKey}`));
  return imports.length ? { kind: 'aggregate_pending', ledgerIds: [], imageImportJobIds: imports.map(job => job.id) } : null;
}

export function readPlatformBillingEvidence(rawPayload: Record<string, unknown>): PlatformBillingEvidence | null {
  const evidence = rawPayload.__platformBillingScope;
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return null;
  const value = evidence as Partial<PlatformBillingEvidence>;
  if (!['resource_pending', 'aggregate_pending', 'source_pending'].includes(value.kind ?? '')
    || !Array.isArray(value.ledgerIds) || !value.ledgerIds.every(id => typeof id === 'string')
    || !Array.isArray(value.imageImportJobIds) || !value.imageImportJobIds.every(id => typeof id === 'string')) return null;
  return value as PlatformBillingEvidence;
}
