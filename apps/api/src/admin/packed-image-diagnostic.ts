import type { PackedImageArtifactRecord, RangeInstanceRecord } from './admin.repository';
import { TencentCloudRequestError } from './tencent-cloud-client';

const PHASES = ['unknown', 'source_disk_inventory', 'create_image', 'create_response', 'persist_image', 'persist_asset'] as const;
export type PackedImagePhase = typeof PHASES[number];
const PREFIX = 'packed-image-diagnostic:';
export class PackedImageCloudError extends Error {
  constructor(readonly phase: PackedImagePhase, readonly cloudErrorCode: string) { super(`镜像云操作未完成（phase=${phase}; code=${cloudErrorCode}）。`); }
}
function safeCode(value: unknown, secrets: string[]) {
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.]{0,100}$/.test(value) && !secrets.filter(Boolean).some(secret => value.includes(secret)) ? value : 'UNKNOWN';
}
export function safePackedCloudCode(error: unknown, secrets: string[] = []) {
  return safeCode(error instanceof TencentCloudRequestError ? error.code : null, secrets);
}
export function packedImageDiagnostic(error: unknown, phase: PackedImagePhase, secrets: string[] = []) {
  return { phase: error instanceof PackedImageCloudError ? error.phase : phase,
    cloudErrorCode: error instanceof PackedImageCloudError ? safeCode(error.cloudErrorCode, secrets) : safePackedCloudCode(error, secrets) };
}
export function encodePackedImageDiagnostic(diagnostic: ReturnType<typeof packedImageDiagnostic>) { return `${PREFIX}${JSON.stringify(diagnostic)}`; }
function readDiagnostic(message: string | null) {
  if (message?.startsWith(PREFIX)) {
    try {
      const value = JSON.parse(message.slice(PREFIX.length));
      if (value && typeof value === 'object' && PHASES.includes(value.phase) && typeof value.cloudErrorCode === 'string' && /^[A-Za-z][A-Za-z0-9_.]{0,100}$/.test(value.cloudErrorCode))
        return { phase: value.phase as PackedImagePhase, cloudErrorCode: value.cloudErrorCode };
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
      imageId: row.imageId, backingSnapshotIds: row.backingSnapshotIds, createdAt: row.createdAt, lastPolledAt: row.lastPolledAt, ...readDiagnostic(row.errorMessage) }));
}
