import type { PackedImageArtifactRecord, PlatformImageAssetRecord, RangeInstanceRecord, CloudImageSnapshotRecord } from './admin.repository';
import { readPackedImageAssetConfig } from './packed-image-asset-config';
import { readPackedImageDiagnostic } from './packed-image-diagnostic';
import { isAliyunImageSubmissionRejection } from './aliyun-image-rpc';

export function packedImageTaskView(row: PackedImageArtifactRecord, asset: PlatformImageAssetRecord | null, source: RangeInstanceRecord | null, snapshot: CloudImageSnapshotRecord | null) {
  const diagnostic = readPackedImageDiagnostic(row.errorMessage);
  let displayName = asset?.displayName || snapshot?.sourceImageName || '未命名打包镜像';
  try { displayName = readPackedImageAssetConfig(row, row.assetConfigCiphertext)?.displayName || displayName; } catch { /* The diagnostic remains visible even if the original key is unavailable. */ }
  const rejected = row.status === 'failed' && !row.imageId && diagnostic.phase === 'create_image'
    && Boolean(diagnostic.cloudRequestId) && isAliyunImageSubmissionRejection(diagnostic.cloudErrorCode);
  const state = row.status === 'deleted' || row.status === 'deleting' ? row.status
    : rejected ? 'rejected' : row.status === 'failed' ? 'failed'
    : row.status === 'available' ? asset?.enabled && snapshot?.isAvailable ? 'available' : 'needs_review'
    : !row.imageId && row.errorMessage ? 'unconfirmed' : row.errorMessage ? 'blocked' : row.status === 'pending' ? 'pending' : 'creating';
  const explanations: Record<string, [string, string]> = {
    pending: ['打包请求已登记，正在等待云端回执。', '请等待后台核验；不要重复提交。'],
    creating: ['云端正在生成镜像或平台正在核验依赖快照。', '可核验原任务；镜像和全部来源快照确认后才可用于创建。'],
    unconfirmed: ['原请求结果尚未确认，不能据此认定云端未创建镜像。', '核验原任务会按原账号、地域和唯一标记查找镜像及官方拒绝回执，不会重新打包。'],
    blocked: ['原任务核验或平台收录尚未完成，恢复材料已保留。', '按下方失败阶段和错误码修正权限或配置，再核验原任务。不要重新提交打包。'],
    rejected: ['云端明确拒绝原打包请求，未创建新镜像。', '修正错误原因后，可返回源实例重新发起打包。'],
    failed: ['云端镜像创建失败；已生成的镜像或快照仍可能计费。', '可核验原任务。需要回收产物时，请在镜像中心核对原镜像及所属快照，不要直接删除任务记录。'],
    available: ['镜像和依赖快照已核验，已收录到我的镜像。', '可在我的镜像中使用。保留镜像时，依赖快照也会保留并可能计费。'],
    needs_review: ['镜像已生成，但平台资产未启用或原始默认配置需核对。', '请在我的镜像中核对默认配置与启用状态；不需要重新打包。'],
    deleting: ['产物回收已开始。', '后台按原清单继续回收；本入口不会发起或扩大删除。'],
    deleted: ['本次打包产物已确认回收。', '任务历史与计费来源记录保留。'],
  };
  const [message, nextStep] = explanations[state];
  return {
    id: row.id, status: row.status, state, displayName,
    sourceRangeInstanceId: row.sourceRangeInstanceId, sourceHostKey: row.sourceHostKey, sourceInstanceId: row.sourceInstanceId,
    sourceName: source?.name || row.sourceRangeInstanceId, instanceMode: source?.instanceMode ?? null,
    cloudProvider: row.cloudProvider ?? 'alibaba_cloud', regionId: row.regionId,
    imageId: row.imageId, sourceSnapshotId: row.sourceSnapshotId, platformImageAssetId: row.platformImageAssetId,
    cloudImageStatus: snapshot?.status ?? null, backingSnapshotIds: row.backingSnapshotIds, deletedSnapshotIds: row.deletedSnapshotIds,
    createdAt: row.createdAt, updatedAt: row.updatedAt, lastPolledAt: row.lastPolledAt, completedAt: row.completedAt,
    diagnostic: row.errorMessage ? diagnostic : null, message, nextStep,
    canVerify: ['pending', 'creating'].includes(row.status) || row.status === 'failed' && Boolean(row.imageId),
  };
}
