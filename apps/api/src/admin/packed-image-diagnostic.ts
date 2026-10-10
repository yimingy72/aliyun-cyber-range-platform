import type { AdminRepository, PackedImageArtifactRecord, RangeInstanceRecord } from './admin.repository';
import { tencentInventoryMatches } from './billing-platform-scope';
import { readTencentPackBaseline } from './tencent-pack-snapshot-baseline';
import { CREATE_IMAGE_PARAMETERS, CREATE_IMAGE_HINTS, TencentCloudRequestError, type TencentCreateImageParameter, type TencentCreateImageHint } from './tencent-cloud-client';

const PHASES = ['unknown', 'source_disk_inventory', 'create_image', 'create_response', 'persist_image', 'persist_asset', 'account_context', 'describe_image', 'verify_image', 'snapshot_verify', 'snapshot_ledger', 'snapshot_tagging', 'persist_catalog', 'cleanup'] as const;
export type PackedImagePhase = typeof PHASES[number];
const CHECKS = ['snapshot_response_shape', 'snapshot_source', 'snapshot_coverage', 'snapshot_image_binding', 'snapshot_namespace_tags', 'snapshot_owner_tags', 'snapshot_tag_response'] as const;
type PackedImageCheck = typeof CHECKS[number];
const SHAPE_FIELDS = ['Images', 'ShareReference', 'CopyFromRemote', 'SnapshotType', 'SnapshotState', 'CreateTime', 'DiskId'] as const;
const SHAPES = ['missing', 'null', 'array', 'object', 'string', 'number', 'boolean', 'other'] as const;
const PROOF_CHECKS = ['validBaseline', 'newSnapshot', 'regionMatches', 'sourceDiskMatches', 'privateSnapshot', 'notCopied', 'notShared'] as const;
const PREFIX = 'packed-image-diagnostic:';
export class PackedImageVerificationError extends Error {
  constructor(readonly verificationCheck: PackedImageCheck, readonly details?: { snapshotFieldShapes?: Record<string, string>; snapshotChecks?: Record<string, boolean>; failedResourceCodes?: string[]; cloudRequestId?: string }, readonly phase?: PackedImagePhase) {
    super(`镜像验证不完整或标签失败（check=${verificationCheck}）。`);
  }
}
export function packedSnapshotFieldShapes(row: Record<string, unknown>) {
  return Object.fromEntries(SHAPE_FIELDS.map(key => [key, row[key] === undefined ? 'missing' : row[key] === null ? 'null' : Array.isArray(row[key]) ? 'array'
    : ['object', 'string', 'number', 'boolean'].includes(typeof row[key]) ? typeof row[key] : 'other']));
}
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
  return { phase: error instanceof PackedImageCloudError ? error.phase : error instanceof PackedImageVerificationError && error.phase ? error.phase : phase,
    cloudErrorCode: error instanceof PackedImageCloudError ? safeCode(error.cloudErrorCode, secrets) : safePackedCloudCode(error, secrets), ...safeEvidence(evidence, secrets),
    ...safeVerification(error instanceof PackedImageVerificationError ? { verificationCheck: error.verificationCheck, ...error.details } : undefined, secrets) };
}
function safeVerification(value: unknown, secrets: string[] = []) {
  if (!value || typeof value !== 'object') return {};
  const v = value as Record<string, unknown>;
  const shapes = v.snapshotFieldShapes && typeof v.snapshotFieldShapes === 'object' ? v.snapshotFieldShapes as Record<string, unknown> : {};
  const checks = v.snapshotChecks && typeof v.snapshotChecks === 'object' ? v.snapshotChecks as Record<string, unknown> : {};
  const snapshotFieldShapes = Object.fromEntries(SHAPE_FIELDS.filter(key => SHAPES.includes(shapes[key] as typeof SHAPES[number])).map(key => [key, shapes[key]]));
  const snapshotChecks = Object.fromEntries(PROOF_CHECKS.filter(key => typeof checks[key] === 'boolean').map(key => [key, checks[key]]));
  const failedResourceCodes = Array.isArray(v.failedResourceCodes) ? [...new Set(v.failedResourceCodes.slice(0, 10).map(code => safeCode(code, secrets)))] : [];
  return { ...(CHECKS.includes(v.verificationCheck as PackedImageCheck) ? { verificationCheck: v.verificationCheck as PackedImageCheck } : {}),
    ...(Object.keys(snapshotFieldShapes).length ? { snapshotFieldShapes } : {}), ...(Object.keys(snapshotChecks).length ? { snapshotChecks } : {}),
    ...(failedResourceCodes.length ? { failedResourceCodes } : {}), ...safeEvidence({ cloudRequestId: v.cloudRequestId }, secrets) };
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
        return { phase: value.phase as PackedImagePhase, cloudErrorCode: value.cloudErrorCode, ...safeEvidence(value), ...safeVerification(value) };
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
      && ledger.rangeInstanceId === instance.id && ledger.ownerUserId === row.ownerUserId && ledger.billingScope === 'user');
    if (!parent?.sourceProvisionJobId) continue;
    const job = await repository.getProvisionJobById(parent.sourceProvisionJobId);
    if (!job || job.rangeInstanceId !== instance.id || job.cloudWorkspaceId !== row.cloudWorkspaceId || !['create','retry','update'].includes(job.jobType)) continue;
    const logs = await repository.listProvisionJobStepLogs(job.id);
    // The immutable pre-create baseline binds the logical host to its CVM and disk set; creation ledgers do not carry cloud tags.
    // Require one original job receipt to prove both that CVM and every disk attachment, without borrowing the active summary.
    const originalSource = { ...instance, resourceSummary: null };
    if (logs.some(log => {
      if (!tencentInventoryMatches(parent, originalSource, [log], row.cloudAccountContextId)) return false;
      let inventory: unknown; try { inventory = JSON.parse(log.message!); } catch { return false; }
      const attachments = (inventory as { diskAttachments?: unknown }).diskAttachments;
      if (!attachments || typeof attachments !== 'object' || Array.isArray(attachments)) return false;
      return row.sourceDiskIds.every(id => {
        const proof = (attachments as Record<string, unknown>)[id];
        return proof && typeof proof === 'object' && !Array.isArray(proof) && (proof as { instanceId?: unknown }).instanceId === row.sourceInstanceId
          && (proof as { method?: unknown }).method === 'persisted'
          && tencentInventoryMatches({ ...parent, cloudResourceType: 'disk', cloudResourceId: id }, originalSource, [log], row.cloudAccountContextId);
      });
    })) proofs.add(row.id);
  }
  return packedImageArtifactSummaries(instance, rows, proofs);
}
