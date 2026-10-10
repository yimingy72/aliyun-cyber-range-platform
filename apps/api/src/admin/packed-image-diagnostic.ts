import type { PackedImageArtifactRecord, RangeInstanceRecord } from './admin.repository';
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
export function packedImageArtifactSummaries(instance: RangeInstanceRecord, rows: PackedImageArtifactRecord[]) {
  const config = instance.singleInstanceConfig, owner = instance.ownerUserId ?? instance.createdBy;
  if (!owner || !config?.cloudAccountContextId || !config.cloudAccountUid || !config.regionId) return [];
  return rows.filter(row => row.sourceRangeInstanceId === instance.id && row.ownerUserId === owner
    && (row.cloudProvider ?? 'alibaba_cloud') === instance.cloudProvider && (row.cloudWorkspaceId ?? 'legacy-unbound') === (instance.cloudWorkspaceId ?? 'legacy-unbound')
    && row.cloudAccountContextId === config.cloudAccountContextId && row.cloudAccountUid === config.cloudAccountUid && row.regionId === config.regionId
    && row.sourceHostKey === config.hostKey).map(row => ({ id: row.id, status: ['pending','creating','available','failed','deleting','deleted'].includes(row.status) ? row.status : 'unknown',
      cloudProvider: row.cloudProvider ?? 'alibaba_cloud', cloudAccountContextId: row.cloudAccountContextId, cloudAccountUid: row.cloudAccountUid, regionId: row.regionId,
      ownerUserId: row.ownerUserId, sourceRangeInstanceId: row.sourceRangeInstanceId, sourceInstanceId: row.sourceInstanceId, sourceDiskIds: row.sourceDiskIds,
      imageId: row.imageId, backingSnapshotIds: row.backingSnapshotIds, createdAt: row.createdAt, lastPolledAt: row.lastPolledAt, ...readPackedImageDiagnostic(row.errorMessage) }));
}
