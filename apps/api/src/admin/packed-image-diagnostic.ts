import type { AdminRepository, PackedImageArtifactRecord, RangeInstanceRecord } from './admin.repository';
import { tencentInventoryMatches } from './billing-platform-scope';
import { readTencentPackBaseline } from './tencent-pack-snapshot-baseline';
import { CREATE_IMAGE_PARAMETERS, CREATE_IMAGE_HINTS, TencentCloudRequestError, type TencentCreateImageParameter, type TencentCreateImageHint } from './tencent-cloud-client';

const PHASES = ['unknown', 'source_disk_inventory', 'create_image', 'create_response', 'persist_image', 'persist_asset'] as const;
export type PackedImagePhase = typeof PHASES[number];
const PREFIX = 'packed-image-diagnostic:';
export class PackedImageCloudError extends Error {
  constructor(readonly phase: PackedImagePhase, readonly cloudErrorCode: string,
    readonly evidence?: { cloudParameterName?: TencentCreateImageParameter; cloudErrorHint?: TencentCreateImageHint; cloudRequestId?: string }) { super(`镜像云操作未完成（phase=${phase}; code=${cloudErrorCode}）。`); }
}
function safeCode(value: unknown, secrets: string[]) {
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.]{0,100}$/.test(value) && !secrets.filter(Boolean).some(secret => value.includes(secret)) ? value : 'UNKNOWN';
}
export function safePackedCloudCode(error: unknown, secrets: string[] = []) {
  return safeCode(error instanceof TencentCloudRequestError ? error.code : null, secrets);
}
export function packedImageDiagnostic(error: unknown, phase: PackedImagePhase, secrets: string[] = []) {
  const evidence = error instanceof PackedImageCloudError ? error.evidence : error instanceof TencentCloudRequestError
    ? { cloudParameterName: error.parameterName, cloudErrorHint: error.hint, cloudRequestId: error.requestId } : undefined;
  return { phase: error instanceof PackedImageCloudError ? error.phase : phase,
    cloudErrorCode: error instanceof PackedImageCloudError ? safeCode(error.cloudErrorCode, secrets) : safePackedCloudCode(error, secrets), ...safeEvidence(evidence, secrets) };
}
function safeEvidence(value: unknown, secrets: string[] = []) {
  if (!value || typeof value !== 'object') return {};
  const evidence = value as Record<string, unknown>;
  const excludesSecrets = (item: string) => !secrets.filter(Boolean).some(secret => item.includes(secret));
  return { ...(CREATE_IMAGE_PARAMETERS.includes(evidence.cloudParameterName as TencentCreateImageParameter) && excludesSecrets(String(evidence.cloudParameterName)) ? { cloudParameterName: evidence.cloudParameterName as TencentCreateImageParameter } : {}),
    ...(CREATE_IMAGE_HINTS.includes(evidence.cloudErrorHint as TencentCreateImageHint) && excludesSecrets(String(evidence.cloudErrorHint)) ? { cloudErrorHint: evidence.cloudErrorHint as TencentCreateImageHint } : {}),
    ...(typeof evidence.cloudRequestId === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(evidence.cloudRequestId) && excludesSecrets(evidence.cloudRequestId) ? { cloudRequestId: evidence.cloudRequestId } : {}) };
}
export function encodePackedImageDiagnostic(diagnostic: ReturnType<typeof packedImageDiagnostic>) { return `${PREFIX}${JSON.stringify(diagnostic)}`; }
export function readPackedImageDiagnostic(message: string | null) {
  if (message?.startsWith(PREFIX)) {
    try {
      const value = JSON.parse(message.slice(PREFIX.length));
      if (value && typeof value === 'object' && PHASES.includes(value.phase) && typeof value.cloudErrorCode === 'string' && /^[A-Za-z][A-Za-z0-9_.]{0,100}$/.test(value.cloudErrorCode))
        return { phase: value.phase as PackedImagePhase, cloudErrorCode: value.cloudErrorCode, ...safeEvidence(value) };
    } catch { /* Legacy or malformed messages never enter the read-only summary. */ }
  }
  return { phase: 'unknown' as const, cloudErrorCode: 'UNKNOWN' };
}
export function packedImageArtifactSummaries(instance: RangeInstanceRecord, rows: PackedImageArtifactRecord[], rangeProofIds = new Set<string>()) {
  const config = instance.singleInstanceConfig, owner = instance.ownerUserId ?? instance.createdBy;
  if (!owner || instance.instanceMode !== 'range' && (!config?.cloudAccountContextId || !config.cloudAccountUid || !config.regionId)) return [];
  return rows.filter(row => row.sourceRangeInstanceId === instance.id && row.ownerUserId === owner
    && (row.cloudProvider ?? 'alibaba_cloud') === instance.cloudProvider && (row.cloudWorkspaceId ?? 'legacy-unbound') === (instance.cloudWorkspaceId ?? 'legacy-unbound')
    && (instance.instanceMode === 'range' ? rangeProofIds.has(row.id) : row.cloudAccountContextId === config!.cloudAccountContextId && row.cloudAccountUid === config!.cloudAccountUid && row.regionId === config!.regionId
      && row.sourceHostKey === config!.hostKey)).map(row => ({ id: row.id, status: ['pending','creating','available','failed','deleting','deleted'].includes(row.status) ? row.status : 'unknown',
      cloudProvider: row.cloudProvider ?? 'alibaba_cloud', cloudAccountContextId: row.cloudAccountContextId, cloudAccountUid: row.cloudAccountUid, regionId: row.regionId,
      ownerUserId: row.ownerUserId, sourceRangeInstanceId: row.sourceRangeInstanceId, sourceInstanceId: row.sourceInstanceId, sourceDiskIds: row.sourceDiskIds,
      imageId: row.imageId, backingSnapshotIds: row.backingSnapshotIds, createdAt: row.createdAt, lastPolledAt: row.lastPolledAt, ...readPackedImageDiagnostic(row.errorMessage) }));
}

export async function rangePackedImageArtifactSummaries(instance: RangeInstanceRecord, repository: AdminRepository) {
  if (instance.instanceMode !== 'range' || instance.cloudProvider !== 'tencent_cloud') return [];
  const rows = (await repository.listPackedImageArtifacts()).filter(row => row.sourceRangeInstanceId === instance.id && row.cloudProvider === 'tencent_cloud'
    && row.cloudWorkspaceId === (instance.cloudWorkspaceId ?? 'legacy-unbound') && row.ownerUserId === (instance.ownerUserId ?? instance.createdBy));
  if (!rows.length) return [];
  const ledgers = await repository.listBillingLedgerResources();
  const proofs = new Set<string>();
  for (const row of rows) {
    if (!readTencentPackBaseline(row)) continue;
    const parent = ledgers.find(ledger => ledger.cloudResourceType === 'ecs' && ledger.cloudResourceId === row.sourceInstanceId && ledger.cloudProvider === 'tencent_cloud'
      && ledger.cloudWorkspaceId === row.cloudWorkspaceId && ledger.cloudAccountUid === row.cloudAccountUid && ledger.regionId === row.regionId
      && ledger.rangeInstanceId === instance.id && ledger.ownerUserId === row.ownerUserId && ledger.billingScope === 'user' && ledger.tagsSnapshot.PlatformHostKey === row.sourceHostKey);
    if (!parent?.sourceProvisionJobId) continue;
    const job = await repository.getProvisionJobById(parent.sourceProvisionJobId);
    if (!job || job.rangeInstanceId !== instance.id || job.cloudWorkspaceId !== row.cloudWorkspaceId || !['create','retry','update'].includes(job.jobType)) continue;
    const logs = await repository.listProvisionJobStepLogs(job.id);
    if (tencentInventoryMatches(parent, instance, logs, row.cloudAccountContextId)
      && row.sourceDiskIds.every(id => tencentInventoryMatches({ ...parent, cloudResourceType: 'disk', cloudResourceId: id }, instance, logs, row.cloudAccountContextId))) proofs.add(row.id);
  }
  return packedImageArtifactSummaries(instance, rows, proofs);
}
