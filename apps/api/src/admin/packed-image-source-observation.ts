import { type SystemCloudAccountContext, SystemConfigService } from './system-config.service';
import { describeTencentResourceInventory, type TencentResourceEvidence } from './tencent-cloud-resources';
import { packedImageArtifactSummaries, safePackedCloudCode } from './packed-image-diagnostic';

export async function readPackedImageSourceSnapshots(packedImageArtifacts: ReturnType<typeof packedImageArtifactSummaries>, systemConfigService: SystemConfigService) {
    const packSourceSnapshots = [];
    for (const artifact of packedImageArtifacts.filter(item => item.cloudProvider === 'tencent_cloud' && ['pending','creating','deleting'].includes(item.status))) {
      let account: SystemCloudAccountContext | undefined;
      const sourceDisks: Array<{ sourceDiskId: string; status: string; candidateSnapshots: Array<{ snapshotId: string; createdAt: string | null }>;
        evidence: TencentResourceEvidence[]; cloudErrorCode?: string }> = [];
      try {
        account = await systemConfigService.getAccountContextById(artifact.cloudAccountContextId);
        if (account.provider !== 'tencent_cloud' || !account.accountUidResolved || account.cloudAccountContextId !== artifact.cloudAccountContextId
          || account.accountUid !== artifact.cloudAccountUid || account.defaultRegion !== artifact.regionId || !artifact.sourceDiskIds.length)
          throw new Error('Packed source snapshot inventory is not bound to its original account and disks');
        for (const sourceDiskId of artifact.sourceDiskIds) {
          const evidence: TencentResourceEvidence[] = [];
          try {
            const snapshots = await describeTencentResourceInventory(account, 'snapshot', { diskIds: [sourceDiskId], onEvidence: value => evidence.push(value) });
            if (!evidence.length || evidence.some(value => value.provider !== 'tencent_cloud' || value.accountUid !== artifact.cloudAccountUid
              || value.cloudAccountContextId !== artifact.cloudAccountContextId || value.regionId !== artifact.regionId || value.action !== 'DescribeSnapshots' || !value.requestIds.length))
              throw new Error('Original disk snapshot read lacks its completed official request evidence');
            sourceDisks.push({ sourceDiskId, status: snapshots.length ? 'observed' : 'absent', candidateSnapshots: snapshots.map(snapshot => ({ snapshotId: snapshot.id, createdAt: snapshot.createdAt ?? null })), evidence });
          } catch (error) {
            sourceDisks.push({ sourceDiskId, status: 'unverified', candidateSnapshots: [], evidence,
              cloudErrorCode: safePackedCloudCode(error, [account.accessKeyId, account.accessKeySecret]) });
          }
        }
        const snapshotIds = [...new Set(sourceDisks.flatMap(disk => disk.candidateSnapshots.map(snapshot => snapshot.snapshotId)))];
        const status = sourceDisks.some(disk => disk.status === 'unverified') ? 'unverified' : snapshotIds.length ? 'observed' : 'absent';
        packSourceSnapshots.push({ artifactId: artifact.id, status, snapshotIds, sourceDisks,
          ...(status === 'unverified' ? { cloudErrorCode: sourceDisks.find(disk => disk.status === 'unverified')?.cloudErrorCode ?? 'UNKNOWN' } : {}),
          scope: 'original_source_disks', ownership: 'unconfirmed', checkedAt: new Date().toISOString() });
      } catch (error) {
        packSourceSnapshots.push({ artifactId: artifact.id, status: 'unverified', snapshotIds: [], sourceDisks, scope: 'original_source_disks', ownership: 'unconfirmed',
          cloudErrorCode: safePackedCloudCode(error, account ? [account.accessKeyId, account.accessKeySecret] : []), checkedAt: new Date().toISOString() });
      }
    }
    return packSourceSnapshots;
}
