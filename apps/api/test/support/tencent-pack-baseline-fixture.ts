import type { PackedImageArtifactRecord } from '../../src/admin/admin.repository';
import { TENCENT_PACK_BASELINE_KIND } from '../../src/admin/tencent-pack-snapshot-baseline';
export function tencentPackBaselineFixture(source: Pick<PackedImageArtifactRecord, 'id' | 'cloudProvider' | 'cloudWorkspaceId' | 'cloudAccountContextId' | 'cloudAccountUid' | 'regionId' | 'ownerUserId' | 'sourceRangeInstanceId' | 'sourceHostKey' | 'sourceInstanceId' | 'sourceDiskIds'>, prior: string[] = []) {
  const observedAt = '2026-10-10T00:00:00.000Z';
  return { ...source, cloudWorkspaceId: source.cloudWorkspaceId ?? 'legacy-unbound', kind: TENCENT_PACK_BASELINE_KIND, observedAt, preCreateSnapshotIds: prior,
    sourceDisks: source.sourceDiskIds.map((sourceDiskId, index) => ({ sourceDiskId, snapshotIds: index ? [] : prior,
      evidence: [{ provider: 'tencent_cloud', accountUid: source.cloudAccountUid, cloudAccountContextId: source.cloudAccountContextId, regionId: source.regionId,
        action: 'DescribeSnapshots', requestIds: [`fixture-preread-${index}`], observedAt }] })) };
}
