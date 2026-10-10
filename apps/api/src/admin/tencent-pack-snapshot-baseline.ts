import type { PackedImageArtifactRecord } from './admin.repository';
import type { TencentResourceEvidence } from './tencent-cloud-resources';

export const TENCENT_PACK_BASELINE_KIND = 'native_tencent_pack_snapshot_baseline_v1';
type BaselineSource = Pick<PackedImageArtifactRecord, 'id' | 'cloudProvider' | 'cloudWorkspaceId' | 'cloudAccountContextId' | 'cloudAccountUid' | 'regionId' | 'ownerUserId' | 'sourceRangeInstanceId' | 'sourceHostKey' | 'sourceInstanceId' | 'sourceDiskIds'>;
export type TencentPackSnapshotBaseline = Record<string, unknown> & { kind: typeof TENCENT_PACK_BASELINE_KIND; sourceDiskIds: string[]; preCreateSnapshotIds: string[];
  sourceDisks: Array<{ sourceDiskId: string; snapshotIds: string[]; evidence: TencentResourceEvidence[] }>; observedAt: string };
const identities = ['id','cloudProvider','cloudAccountContextId','cloudAccountUid','regionId','ownerUserId','sourceRangeInstanceId','sourceHostKey','sourceInstanceId'] as const;
const ids = (value: unknown, prefix: string): value is string[] => Array.isArray(value) && value.every(id => typeof id === 'string' && new RegExp(`^${prefix}-[A-Za-z0-9]+$`).test(id)) && new Set(value).size === value.length;
const instant = (value: unknown) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) && Number.isFinite(Date.parse(value));

export function validTencentPackBaseline(source: BaselineSource, input: unknown): input is TencentPackSnapshotBaseline {
  if (!input || typeof input !== 'object' || Array.isArray(input) || source.cloudProvider !== 'tencent_cloud') return false;
  const value = input as TencentPackSnapshotBaseline;
  if (value.kind !== TENCENT_PACK_BASELINE_KIND || identities.some(key => value[key] !== source[key])
    || value.cloudWorkspaceId !== (source.cloudWorkspaceId ?? 'legacy-unbound') || !instant(value.observedAt)
    || !ids(value.sourceDiskIds, 'disk') || !value.sourceDiskIds.length || [...value.sourceDiskIds].sort().join(',') !== [...source.sourceDiskIds].sort().join(',')
    || !ids(value.preCreateSnapshotIds, 'snap') || !Array.isArray(value.sourceDisks) || value.sourceDisks.length !== value.sourceDiskIds.length) return false;
  const seen = new Set<string>(), prior = new Set<string>();
  for (const disk of value.sourceDisks) {
    if (!disk || !value.sourceDiskIds.includes(disk.sourceDiskId) || seen.has(disk.sourceDiskId) || !ids(disk.snapshotIds, 'snap') || !Array.isArray(disk.evidence) || !disk.evidence.length) return false;
    seen.add(disk.sourceDiskId); disk.snapshotIds.forEach(id => prior.add(id));
    if (disk.evidence.some(e => !e || e.provider !== 'tencent_cloud' || e.accountUid !== source.cloudAccountUid || e.cloudAccountContextId !== source.cloudAccountContextId
      || e.regionId !== source.regionId || e.action !== 'DescribeSnapshots' || !instant(e.observedAt) || !Array.isArray(e.requestIds) || !e.requestIds.length
      || e.requestIds.some(id => typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(id)))) return false;
  }
  return [...prior].sort().join(',') === [...value.preCreateSnapshotIds].sort().join(',');
}
export function readTencentPackBaseline(artifact: PackedImageArtifactRecord) {
  return validTencentPackBaseline(artifact, artifact.sourceSnapshotBaseline) ? artifact.sourceSnapshotBaseline : null;
}
