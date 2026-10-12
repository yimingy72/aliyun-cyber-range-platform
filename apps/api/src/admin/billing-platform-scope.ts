import type { AdminRepository, BillingImageImportResourceRecord, BillingManagedCosBucketRecord, BillingLedgerResourceRecord, PackedImageArtifactRecord, RangeResourceSummary, RangeInstanceRecord, ProvisionJobRecord, ProvisionJobStepLogRecord } from './admin.repository';
import { classifyBillLine } from './billing-classifier';
import { ownedCosBucketProof } from './tencent-cos-proof';
import { billingDayText } from './billing-window';
import { readTencentPackBaseline } from './tencent-pack-snapshot-baseline';
import { readAliyunOssDedicatedBilling, aliyunOssBindingCoversBillingDay, aliyunOssBindingOverlapsBillingDay } from './billing-oss-binding-proof';

const REGION_ID = /^(cn|ap|eu|us|na|me|af|sa)-[a-z0-9-]+$/;
const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';

export type PlatformBillingProof = {
  ledgers: BillingLedgerResourceRecord[];
  imageImports: BillingImageImportResourceRecord[];
  packedImages: PackedImageArtifactRecord[];
  cosBuckets: BillingManagedCosBucketRecord[];
  createdLedgerIds: Set<string>;
  unverifiedSourceLedgerIds: Set<string>;
  creationJobs?: Map<string, ProvisionJobRecord>;
  snapshotParentProof?: PlatformBillingProof;
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

function tencentContextMatches(value: unknown, ledger: BillingLedgerResourceRecord, instance: RangeInstanceRecord, contextId?: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const context = value as Record<string, unknown>, config = instance.singleInstanceConfig;
  return context.provider === 'tencent_cloud' && typeof context.cloudAccountContextId === 'string' && Boolean(context.cloudAccountContextId)
    && (!contextId || context.cloudAccountContextId === contextId)
    && context.cloudAccountUid === ledger.cloudAccountUid && context.regionId === ledger.regionId && typeof context.zoneId === 'string' && Boolean(context.zoneId)
    && (!config || config.cloudAccountContextId === context.cloudAccountContextId && config.cloudAccountUid === context.cloudAccountUid
      && config.regionId === context.regionId && config.zoneId === context.zoneId);
}

export function tencentInventoryMatches(ledger: BillingLedgerResourceRecord, instance: RangeInstanceRecord, logs: ProvisionJobStepLogRecord[], contextId?: string) {
  if (tencentContextMatches(instance.resourceSummary?.executionContext, ledger, instance, contextId) && inventoryIncludes(instance.resourceSummary, ledger)) return true;
  return logs.some(log => {
    if (log.jobId !== ledger.sourceProvisionJobId || log.status !== 'succeeded' || log.stepName !== 'platform_billing_creation_inventory' || !log.message
      || (log.cloudWorkspaceId ?? 'legacy-unbound') !== (ledger.cloudWorkspaceId ?? 'legacy-unbound')) return false;
    let value: unknown; try { value = JSON.parse(log.message); } catch { return false; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const inventory = value as Record<string, unknown>;
    return inventory.version === 1 && inventory.cloudProvider === 'tencent_cloud' && inventory.cloudWorkspaceId === (ledger.cloudWorkspaceId ?? 'legacy-unbound')
      && inventory.rangeInstanceId === instance.id && inventory.sourceJobId === ledger.sourceProvisionJobId && inventory.ownerUserId === (instance.ownerUserId ?? null)
      && tencentContextMatches(inventory.executionContext, ledger, instance, contextId) && Array.isArray(inventory.resources)
      && inventory.resources.some(resource => resource && typeof resource === 'object' && !Array.isArray(resource)
        && resource.cloudResourceId === ledger.cloudResourceId && resource.cloudResourceType === ledger.cloudResourceType);
  });
}

function originalTencentCreationSource(ledger: BillingLedgerResourceRecord, instance: RangeInstanceRecord,
  jobs: ProvisionJobRecord[], logs: Map<string, ProvisionJobStepLogRecord[]>) {
  const namespace = ledger.cloudWorkspaceId ?? 'legacy-unbound';
  if (instance.cloudProvider !== 'tencent_cloud' || namespace !== (instance.cloudWorkspaceId ?? 'legacy-unbound')
    || ledger.ownerUserId !== (instance.ownerUserId ?? null) || ledger.billingScope !== (instance.ownerUserId ? 'user' : 'platform')
    || (ledger.singleInstanceBatchId ?? null) !== (instance.singleInstanceBatchId ?? null)) return null;
  const original = { ...instance, resourceSummary: null };
  const frozen = instance.singleInstanceConfig ?? instance.resourceSummary?.executionContext;
  const eligible = jobs.filter(job => job.rangeInstanceId === instance.id && (job.cloudWorkspaceId ?? 'legacy-unbound') === namespace
    && ['create', 'retry', 'update'].includes(job.jobType));
  const matches = (job: ProvisionJobRecord, log: ProvisionJobStepLogRecord) => {
      // Both timestamps come from the database. Later inventories cannot establish this resource's original creator.
      if (Object.prototype.toString.call(ledger.createdAt) !== '[object Date]' || Object.prototype.toString.call(log.createdAt) !== '[object Date]'
        || !Number.isFinite(ledger.createdAt.getTime()) || !Number.isFinite(log.createdAt.getTime()) || log.createdAt > ledger.createdAt) return false;
      const proposed = { ...ledger, sourceProvisionJobId: job.id };
      if (!tencentInventoryMatches(proposed, original, [log], frozen?.cloudAccountContextId ?? undefined)) return false;
      if (frozen) {
        let inventory: { executionContext?: { zoneId?: unknown } }; try { inventory = JSON.parse(log.message!); } catch { return false; }
        if (inventory.executionContext?.zoneId !== frozen.zoneId) return false;
      }
      return true;
  };
  const current = eligible.find(job => job.id === ledger.sourceProvisionJobId);
  if (current && (logs.get(current.id) ?? []).some(log => matches(current, log))) return current;
  const candidates = eligible.filter(job => (logs.get(job.id) ?? []).some(log => matches(job, log)));
  return candidates.length === 1 ? candidates[0] : null;
}

export async function loadPlatformBillingProof(repository: AdminRepository, options: { ledgers?: BillingLedgerResourceRecord[] } = {}): Promise<PlatformBillingProof> {
  const [ledgers, imageImports, packedImages, instances, sourceJobs, cosBuckets] = await Promise.all([
    options.ledgers ?? repository.listBillingLedgerResources(), repository.listBillingImageImportResources(),
    repository.listPackedImageArtifacts(), repository.listRangeInstances(), repository.listProvisionJobs(),
    typeof repository.listBillingManagedCosBuckets === 'function' ? repository.listBillingManagedCosBuckets() : [],
  ]);
  const jobs = new Map(sourceJobs.map(job => [job.id, job]));
  const instancesById = new Map(instances.map(instance => [instance.id, instance]));
  const tencentRangeIds = new Set(ledgers.filter(ledger => ledger.cloudProvider === 'tencent_cloud').map(ledger => ledger.rangeInstanceId));
  const inventoryLogs = new Map(await Promise.all([...new Set([...ledgers.filter(ledger => ledger.cloudProvider === 'tencent_cloud' && ledger.sourceProvisionJobId)
    .map(ledger => ledger.sourceProvisionJobId!), ...sourceJobs.filter(job => tencentRangeIds.has(job.rangeInstanceId) && ['create','retry','update'].includes(job.jobType)).map(job => job.id)])]
    .map(async id => [id, await repository.listProvisionJobStepLogs(id)] as const)));
  const launchInstanceIds = new Set(sourceJobs.filter(job => ['create', 'retry', 'update'].includes(job.jobType)).map(job => job.rangeInstanceId));
  const createdLedgerIds = new Set<string>();
  const creationJobs = new Map<string, ProvisionJobRecord>();
  const unverifiedSourceLedgerIds = new Set<string>();
  for (const ledger of ledgers) {
    const sourceJob = ledger.sourceProvisionJobId ? jobs.get(ledger.sourceProvisionJobId) : null;
    const sourceInstance = instancesById.get(ledger.rangeInstanceId ?? '');
    const hasBucketSource = cosBuckets.some(bucket => bucket.cloudProvider === ledger.cloudProvider && bucket.cloudWorkspaceId === (ledger.cloudWorkspaceId ?? 'legacy-unbound') && bucket.bucketName === ledger.cloudResourceId && bucket.cloudAccountUid === ledger.cloudAccountUid);
    const hasSource = hasBucketSource || Boolean(sourceInstance && (sourceJob?.rangeInstanceId === sourceInstance.id || launchInstanceIds.has(sourceInstance.id)))
      || packedImages.some(artifact => ledger.cloudResourceType === 'image' ? artifact.imageId === ledger.cloudResourceId : ledger.cloudResourceType === 'snapshot' && artifact.backingSnapshotIds.includes(ledger.cloudResourceId))
      || imageImports.some(job => ledger.cloudResourceType === 'image' ? job.imageId === ledger.cloudResourceId : ledger.cloudResourceType === 'snapshot' && job.backingSnapshotIds.includes(ledger.cloudResourceId));
    if (hasSource) unverifiedSourceLedgerIds.add(ledger.id);
    if (!['alibaba_cloud', 'tencent_cloud'].includes(ledger.cloudProvider)
      || !ledger.cloudAccountUid || !REGION_ID.test(ledger.regionId) || !ledger.cloudResourceId.trim()
      || ['snapshot_region', 'unknown'].includes(ledger.cloudResourceType)) continue;
    if (ledger.cloudResourceType === 'oss_bucket') {
      if (ledger.cloudProvider === 'alibaba_cloud' && readAliyunOssDedicatedBilling(ledger)) {
        createdLedgerIds.add(ledger.id);
        continue;
      }
      const bucket = cosBuckets.find(bucket => bucket.id === ledger.tagsSnapshot.PlatformManagedImportBucketId && bucket.cloudProvider === 'tencent_cloud'
        && ledger.cloudProvider === 'tencent_cloud' && bucket.cloudWorkspaceId === (ledger.cloudWorkspaceId ?? 'legacy-unbound') && bucket.cloudAccountUid === ledger.cloudAccountUid
        && bucket.regionId === ledger.regionId && bucket.bucketName === ledger.cloudResourceId && ownedCosBucketProof(bucket));
      if (bucket && ledger.billingScope === 'platform' && ledger.ownerUserId === null && billingDayText(ledger.billingStartAt) === billingDayText(new Date(String(ownedCosBucketProof(bucket)!.cloudCreationAt)))) createdLedgerIds.add(ledger.id);
      continue;
    }
    if (ledger.cloudResourceType === 'image' || ledger.cloudResourceType === 'snapshot') {
      if (ledger.cloudProvider === 'tencent_cloud') {
        const packed = packedImages.some(artifact => {
          const source = instancesById.get(artifact.sourceRangeInstanceId);
          const sourceLedger = ledgers.find(parent => parent.cloudProvider === 'tencent_cloud' && parent.cloudWorkspaceId === artifact.cloudWorkspaceId
            && parent.cloudAccountUid === artifact.cloudAccountUid && parent.regionId === artifact.regionId && parent.rangeInstanceId === artifact.sourceRangeInstanceId
            && parent.cloudResourceType === 'ecs' && parent.cloudResourceId === artifact.sourceInstanceId && parent.ownerUserId === artifact.ownerUserId);
          const sourceJob = sourceLedger?.sourceProvisionJobId ? jobs.get(sourceLedger.sourceProvisionJobId) : null;
          const hasResource = (id: string, type: BillingLedgerResourceRecord['cloudResourceType']) => Boolean(source && sourceLedger
            && tencentInventoryMatches({ ...sourceLedger, cloudResourceId: id, cloudResourceType: type }, source,
              inventoryLogs.get(sourceLedger.sourceProvisionJobId ?? '') ?? [], artifact.cloudAccountContextId));
          return artifact.cloudProvider === 'tencent_cloud' && readTencentPackBaseline(artifact) && artifact.cloudWorkspaceId === (ledger.cloudWorkspaceId ?? 'legacy-unbound')
            && artifact.cloudAccountUid === ledger.cloudAccountUid && artifact.regionId === ledger.regionId && ledger.billingScope === 'user'
            && artifact.ownerUserId === ledger.ownerUserId && artifact.sourceRangeInstanceId === ledger.rangeInstanceId
            && ledger.tagsSnapshot.PlatformPackedImageArtifactId === artifact.id && source?.cloudProvider === 'tencent_cloud'
            && source.ownerUserId === artifact.ownerUserId && source.cloudWorkspaceId === artifact.cloudWorkspaceId
            && hasResource(artifact.sourceInstanceId, 'ecs') && artifact.sourceDiskIds.length > 0 && artifact.sourceDiskIds.every(id => hasResource(id, 'disk'))
            && sourceJob?.rangeInstanceId === source.id && sourceJob.cloudWorkspaceId === artifact.cloudWorkspaceId && ['create', 'retry', 'update'].includes(sourceJob.jobType)
            && (ledger.cloudResourceType === 'image' ? artifact.imageId === ledger.cloudResourceId : artifact.backingSnapshotIds.includes(ledger.cloudResourceId));
        });
        const imported = imageImports.some(job => {
          const bucket = cosBuckets.find(bucket => bucket.id === job.managedBucketId && ownedCosBucketProof(bucket));
          const object = job.sourceObjectProof && typeof job.sourceObjectProof === 'object' && !Array.isArray(job.sourceObjectProof) ? job.sourceObjectProof as Record<string,unknown> : null;
          return job.cloudProvider === 'tencent_cloud' && job.cloudWorkspaceId === (ledger.cloudWorkspaceId ?? 'legacy-unbound') && job.cloudAccountUid === ledger.cloudAccountUid
            && job.regionId === ledger.regionId && ledger.billingScope === 'platform' && ledger.ownerUserId === null && job.taskId && job.uploadCompletedAt
            && ledger.tagsSnapshot.PlatformImageImportJobId === job.id && bucket?.cloudWorkspaceId === job.cloudWorkspaceId && bucket.cloudAccountContextId === job.cloudAccountContextId
            && bucket.cloudAccountUid === job.cloudAccountUid && bucket.regionId === job.regionId && bucket.bucketName === job.imageImportBucket
            && object?.provider === 'tencent_cloud' && object.bucketId === bucket.id && object.bucketName === bucket.bucketName && object.objectKey === job.objectKey
            && object.jobId === job.id && object.ownerUserId === job.ownerUserId && object.cloudAccountContextId === job.cloudAccountContextId
            && object.cloudAccountUid === job.cloudAccountUid && object.regionId === job.regionId && object.contentLength === Number(job.sourceSizeBytes)
            && typeof object.etag === 'string' && object.etag && typeof object.verifiedAt === 'string' && Number.isFinite(Date.parse(object.verifiedAt))
            && (ledger.cloudResourceType === 'image' ? job.imageId === ledger.cloudResourceId : job.backingSnapshotIds.includes(ledger.cloudResourceId));
        });
        if (packed || imported) createdLedgerIds.add(ledger.id);
        continue;
      }
      const packed = packedImages.some(artifact => (artifact.cloudProvider ?? 'alibaba_cloud') === 'alibaba_cloud' && artifact.cloudAccountUid === ledger.cloudAccountUid && artifact.regionId === ledger.regionId
        && ledger.billingScope === 'user' && artifact.ownerUserId === ledger.ownerUserId && artifact.sourceRangeInstanceId === ledger.rangeInstanceId
        && (ledger.cloudResourceType === 'image' ? artifact.imageId === ledger.cloudResourceId : artifact.backingSnapshotIds.includes(ledger.cloudResourceId)));
      const imported = imageImports.some(job => (job.cloudProvider ?? 'alibaba_cloud') === 'alibaba_cloud' && job.cloudAccountUid === ledger.cloudAccountUid && job.regionId === ledger.regionId
        && ledger.billingScope === 'platform' && ledger.ownerUserId === null
        && (ledger.cloudResourceType === 'image' ? job.imageId === ledger.cloudResourceId : job.backingSnapshotIds.includes(ledger.cloudResourceId)));
      if (packed || imported) createdLedgerIds.add(ledger.id);
      continue;
    }
    const instance = instancesById.get(ledger.rangeInstanceId ?? '');
    const job = ledger.cloudProvider === 'tencent_cloud' && instance ? originalTencentCreationSource(ledger, instance, sourceJobs, inventoryLogs)
      : ledger.sourceProvisionJobId ? jobs.get(ledger.sourceProvisionJobId) : null;
    const context = ledger.cloudProvider === 'tencent_cloud' ? instance?.resourceSummary?.executionContext : instance?.singleInstanceConfig ?? instance?.resourceSummary?.executionContext;
    // Tencent evidence has no legacy fallback: the frozen account and exact creation inventory are required.
    if (ledger.cloudProvider === 'tencent_cloud' && (!instance
      || (ledger.cloudWorkspaceId ?? 'legacy-unbound') !== (instance?.cloudWorkspaceId ?? 'legacy-unbound')
      || (ledger.cloudWorkspaceId ?? 'legacy-unbound') !== (job?.cloudWorkspaceId ?? 'legacy-unbound')
      || !job)) continue;
    if (instance && job?.rangeInstanceId === instance.id && (['create', 'retry', 'update'].includes(job.jobType) || job.jobType === 'destroy' && inventoryIncludes(instance.resourceSummary, ledger))
      && instance.cloudProvider === ledger.cloudProvider
      && (!context || !('provider' in context) || context.provider === ledger.cloudProvider)
      && (!context?.cloudAccountUid || context.cloudAccountUid === ledger.cloudAccountUid)
      && (!context?.regionId || context.regionId === ledger.regionId)
      && ledger.billingScope === (instance.ownerUserId ? 'user' : 'platform')
      && (instance.ownerUserId ?? null) === ledger.ownerUserId
      && (instance.singleInstanceBatchId ?? null) === ledger.singleInstanceBatchId) {
      createdLedgerIds.add(ledger.id);
      creationJobs.set(ledger.id, job);
    }
  }
  for (const id of createdLedgerIds) unverifiedSourceLedgerIds.delete(id);
  return { ledgers, imageImports, packedImages, cosBuckets, createdLedgerIds, unverifiedSourceLedgerIds, creationJobs };
}

// Collection and tags are not creation proof; this set was checked against persisted job/artifact identities.
export function isPlatformCreatedLedger(ledger: BillingLedgerResourceRecord, proof: PlatformBillingProof) {
  return proof.createdLedgerIds.has(ledger.id);
}

export function isAlibabaBillingPayload(line: Record<string, unknown>) {
  // Unmarked rows predate multi-cloud support; they can only match Aliyun ledgers.
  return (!('__platformCloudProvider' in line) || line.__platformCloudProvider === 'alibaba_cloud')
    && (!('__platformBillingSource' in line) || ['DescribeInstanceBill', 'DescribeSplitItemBill'].includes(String(line.__platformBillingSource)));
}

export function classifyPlatformBillLine(line: Record<string, unknown>) {
  if (!isAlibabaBillingPayload(line)) return classifyBillLine({});
  if (line.__platformBillingSource === 'DescribeSplitItemBill' && line.ProductCode === 'oss'
    && /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(text(line.SplitItemID))) {
    return { kind: 'direct' as const, cloudResourceType: 'oss_bucket' as const, cloudResourceId: text(line.SplitItemID) };
  }
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
  if (!isAlibabaBillingPayload(input.line)) return null;
  const classification = classifyPlatformBillLine(input.line);
  const regionId = billRegionId(input.line);
  const accountConflict = ['OwnerID', 'SplitAccountID'].some(key => input.line[key] != null
    && String(input.line[key]) !== input.cloudAccountUid);
  const correction = ['Refund', 'Adjustment'].includes(text(input.line.Item));
  const owned = input.proof.ledgers.filter(ledger => isPlatformCreatedLedger(ledger, input.proof)
    && ledger.cloudProvider === 'alibaba_cloud'
    && ledger.cloudAccountUid === input.cloudAccountUid && input.billingDate >= billingDayText(ledger.billingStartAt));
  if (classification.kind !== 'aggregated') {
    // A late charge for a known released resource still needs investigation; do not silently drop it.
    const exact = owned.filter(ledger => ledger.cloudResourceId === classification.cloudResourceId);
    if (!exact.length) {
      const imports = classification.cloudResourceType === 'oss_bucket' ? input.proof.imageImports.filter(job => job.cloudAccountUid === input.cloudAccountUid
        && job.regionId === regionId && job.imageImportBucket === classification.cloudResourceId && job.objectKey
        && billingDayText(job.createdAt) <= input.billingDate && (!job.temporaryObjectDeletedAt || correction || input.billingDate <= billingDayText(job.temporaryObjectDeletedAt))) : [];
      return imports.length ? { kind: 'aggregate_pending', ledgerIds: [], imageImportJobIds: imports.map(job => job.id) } : null;
    }
    if (classification.cloudResourceType === 'oss_bucket') {
      const binding = readAliyunOssDedicatedBilling(exact[0]);
      if (binding && correction) return { kind: 'aggregate_pending', ledgerIds: exact.map(ledger => ledger.id), imageImportJobIds: [] };
      if (binding && !aliyunOssBindingCoversBillingDay(binding, input.billingDate)) {
        return aliyunOssBindingOverlapsBillingDay(binding, input.billingDate)
          ? { kind: 'aggregate_pending', ledgerIds: exact.map(ledger => ledger.id), imageImportJobIds: [] } : null;
      }
    }
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
  const buckets = candidates.filter(ledger => {
    const binding = readAliyunOssDedicatedBilling(ledger);
    return binding && aliyunOssBindingOverlapsBillingDay(binding, input.billingDate)
      && identifiers.some(value => value === ledger.regionId || value.startsWith(`${ledger.regionId};`) || value === ledger.cloudResourceId);
  });
  const imports = input.proof.imageImports.filter(job => job.cloudAccountUid === input.cloudAccountUid
    && job.regionId === regionId && job.imageImportBucket && job.objectKey
    && billingDayText(job.createdAt) <= input.billingDate
    && (!job.temporaryObjectDeletedAt || correction || input.billingDate <= billingDayText(job.temporaryObjectDeletedAt))
    && identifiers.some(value => value === regionId || value.startsWith(`${regionId};`)
      || value === job.imageImportBucket || value.startsWith(`${job.imageImportBucket};`)
      || value === `${job.imageImportBucket}/${job.objectKey}`));
  return imports.length || buckets.length ? { kind: 'aggregate_pending', ledgerIds: buckets.map(ledger => ledger.id), imageImportJobIds: imports.map(job => job.id) } : null;
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

// Numeric billing region IDs are documented in Tencent's TopicIdAndRegion schema; unknown IDs remain unverified.
// https://cloud.tencent.com/document/api/614/56471
const TENCENT_BILLING_REGIONS: Record<string, string> = {
  '1': 'ap-guangzhou', '4': 'ap-shanghai', '5': 'ap-hongkong', '7': 'ap-shanghai-fsi',
  '8': 'ap-beijing', '9': 'ap-singapore', '11': 'ap-shenzhen-fsi', '15': 'na-siliconvalley',
  '16': 'ap-chengdu', '17': 'eu-frankfurt', '18': 'ap-seoul', '19': 'ap-chongqing',
  '22': 'na-ashburn', '23': 'ap-bangkok', '25': 'ap-tokyo', '33': 'ap-nanjing',
  '46': 'ap-beijing-fsi', '72': 'ap-jakarta', '74': 'sa-saopaulo',
};

export function isTencentBillingPayload(line: Record<string, unknown>) {
  return line.__platformCloudProvider === 'tencent_cloud' && line.__platformBillingSource === 'DescribeBillDetail';
}

export function tencentBillRegionId(line: Record<string, unknown>) {
  return TENCENT_BILLING_REGIONS[text(line.RegionId)] ?? null;
}

export function classifyTencentBillLine(line: Record<string, unknown>): ReturnType<typeof classifyBillLine> {
  const id = text(line.ResourceId);
  const business = text(line.BusinessCode);
  // https://cloud.tencent.com/document/product/555/93162 documents p_cvm/p_cbs/p_eip/p_nat.
  // Product codes and resource shape must both agree; a matching ID or tag alone cannot establish a bill's source.
  const type = business === 'p_cos' && /^[a-z0-9][a-z0-9-]+-[1-9]\d+$/.test(id) ? 'oss_bucket'
    : business === 'p_cvm' && /^img-[a-z0-9-]+$/i.test(id) ? 'image'
    : business === 'p_cvm' && /^ins-[a-z0-9-]+$/i.test(id) ? 'ecs'
    : business === 'p_cbs' && /^disk-[a-z0-9-]+$/i.test(id) ? 'disk'
    : business === 'p_eip' && /^eip-[a-z0-9-]+$/i.test(id) ? 'eip'
    : business === 'p_nat' && /^nat-[a-z0-9-]+$/i.test(id) ? 'nat_gateway'
    : business === 'p_cbs' && /^snap-[a-z0-9-]+$/i.test(id) ? 'snapshot' : null;
  return type && isTencentBillingPayload(line) ? { kind: 'direct', cloudResourceId: id, cloudResourceType: type }
    : { kind: 'unknown', cloudResourceId: id, cloudResourceType: 'unknown', reason: '腾讯云账单资源类型尚未核实。' };
}

export function tencentCosBillLifetimeMatches(ledger: BillingLedgerResourceRecord, line: Record<string, unknown>, billingDate: string) {
  if (ledger.cloudResourceType !== 'oss_bucket' || !ledger.releasedAt) return true;
  if (billingDate <= billingDayText(ledger.releasedAt)) return true;
  // Bucket names are reusable. A later billing day needs an explicit official usage interval from before deletion.
  const end = typeof line.FeeEndTime === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(line.FeeEndTime)
    ? Date.parse(`${line.FeeEndTime.replace(' ', 'T')}+08:00`) : NaN;
  const begin = typeof line.FeeBeginTime === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(line.FeeBeginTime)
    ? Date.parse(`${line.FeeBeginTime.replace(' ', 'T')}+08:00`) : NaN;
  return Number.isFinite(begin) && Number.isFinite(end) && begin >= ledger.billingStartAt.getTime() && end >= begin && end <= ledger.releasedAt.getTime();
}

export function pendingTencentBillingEvidence(input: {
  line: Record<string, unknown>; cloudAccountUid: string; billingDate: string; proof: PlatformBillingProof;
}): PlatformBillingEvidence | null {
  if (!isTencentBillingPayload(input.line) || input.line.OwnerUin !== input.cloudAccountUid || input.line.PayerUin !== input.cloudAccountUid) return null;
  const id = text(input.line.ResourceId);
  const owned = input.proof.ledgers.filter(ledger => ledger.cloudProvider === 'tencent_cloud'
    && ledger.cloudAccountUid === input.cloudAccountUid && ledger.cloudResourceId === id
    && isPlatformCreatedLedger(ledger, input.proof) && input.billingDate >= billingDayText(ledger.billingStartAt));
  if (!owned.length) return null;
  const region = tencentBillRegionId(input.line);
  const classification = classifyTencentBillLine(input.line);
  const exact = owned.filter(ledger => ledger.regionId === region && ledger.cloudResourceType === classification.cloudResourceType && tencentCosBillLifetimeMatches(ledger, input.line, input.billingDate));
  return { kind: classification.kind === 'direct' && exact.length === 1 ? 'resource_pending' : 'source_pending',
    ledgerIds: owned.map(ledger => ledger.id), imageImportJobIds: [] };
}
