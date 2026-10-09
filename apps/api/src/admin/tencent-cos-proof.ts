export type CosBucketIdentity = { id: string; cloudWorkspaceId: string; cloudProvider: string; cloudAccountContextId: string; cloudAccountUid: string;
  appId: string; regionId: string; bucketName: string; creationNonce: string; creatorUserId: string; ownershipMarkerKey: string;
  status: string; preflightAbsentAt: Date | null; creationStartedAt: Date | null; ownershipProof: unknown; deletedAt?: Date | null };
export const COS_BUCKET_PROOF_KIND = 'platform_private_cos_import_bucket_v1';
export const COS_BUCKET_MARKER = 'PlatformCreationNonce';
export function expectedCosBucketTags(bucket: CosBucketIdentity) {
  return { CreatedBy: 'cyber-range-platform', PlatformPurpose: 'private-image-import', PlatformCloudWorkspaceId: bucket.cloudWorkspaceId,
    PlatformCloudProvider: 'tencent_cloud', PlatformCloudAccountUid: bucket.cloudAccountUid, PlatformCloudContextId: bucket.cloudAccountContextId,
    PlatformCreatorUserId: bucket.creatorUserId, [COS_BUCKET_MARKER]: bucket.creationNonce };
}
export function ownedCosBucketProof(bucket: CosBucketIdentity): Record<string, unknown> | null {
  const value = bucket.ownershipProof;
  if (!value || typeof value !== 'object' || Array.isArray(value) || bucket.cloudProvider !== 'tencent_cloud'
    || !bucket.cloudWorkspaceId || !bucket.cloudAccountContextId || !/^\d+$/.test(bucket.cloudAccountUid)
    || !/^[1-9]\d*$/.test(bucket.appId) || !bucket.bucketName.endsWith(`-${bucket.appId}`)
    || !bucket.creationNonce || !bucket.creatorUserId || bucket.ownershipMarkerKey !== COS_BUCKET_MARKER
    || !bucket.preflightAbsentAt || !bucket.creationStartedAt) return null;
  const proof = value as Record<string, unknown>;
  const identity = ['cloudWorkspaceId', 'cloudProvider', 'cloudAccountContextId', 'cloudAccountUid', 'appId', 'regionId', 'bucketName', 'creationNonce', 'creatorUserId', 'ownershipMarkerKey'] as const;
  if (proof.kind !== COS_BUCKET_PROOF_KIND || proof.bucketId !== bucket.id || !['available', 'deleting', 'deleted'].includes(bucket.status) || identity.some(key => proof[key] !== bucket[key]) || proof.aclPrivate !== true
    || proof.policyAbsent !== true || proof.exclusiveUsage !== true || proof.preflightAbsentAt !== bucket.preflightAbsentAt.toISOString()
    || proof.creationStartedAt !== bucket.creationStartedAt.toISOString() || proof.ownerId !== `qcs::cam::uin/${bucket.cloudAccountUid}:uin/${bucket.cloudAccountUid}`) return null;
  const tags = proof.atomicTags;
  if (!tags || typeof tags !== 'object' || Array.isArray(tags) || Object.entries(expectedCosBucketTags(bucket)).some(([key, value]) => (tags as Record<string,unknown>)[key] !== value)) return null;
  const created = typeof proof.cloudCreationAt === 'string' ? Date.parse(proof.cloudCreationAt) : NaN;
  const verified = typeof proof.verifiedAt === 'string' ? Date.parse(proof.verifiedAt) : NaN;
  if (!Number.isFinite(created) || !Number.isFinite(verified) || created < bucket.preflightAbsentAt.getTime() - 120_000 || created > verified + 120_000 || created > bucket.creationStartedAt.getTime() + 420_000
    || bucket.creationStartedAt < bucket.preflightAbsentAt || bucket.creationStartedAt.getTime() > verified
    || ['preflightRequestId', 'iamRequestId', 'headRequestId', 'aclRequestId', 'tagRequestId', 'serviceRequestId'].some(key => typeof proof[key] !== 'string' || !proof[key])) return null;
  return proof;
}
