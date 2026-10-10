import { COS_BUCKET_MARKER, COS_BUCKET_PROOF_KIND, expectedCosBucketTags, type CosBucketIdentity } from '../../src/admin/tencent-cos-proof';
export function ownedCosFixture(workspaceId = 'legacy-unbound'): CosBucketIdentity {
  const bucket: CosBucketIdentity = { id: 'owned-cos-bucket', cloudWorkspaceId: workspaceId, cloudProvider: 'tencent_cloud', cloudAccountContextId: 'fixture-context', cloudAccountUid: '100001',
    appId: '1250000000', regionId: 'ap-shanghai', bucketName: 'platform-import-fixture-1250000000', creationNonce: 'fixture-nonce', creatorUserId: 'fixture-creator',
    ownershipMarkerKey: COS_BUCKET_MARKER, status: 'available', preflightAbsentAt: new Date('2026-09-01T00:00:00Z'), creationStartedAt: new Date('2026-09-01T00:00:01Z'), ownershipProof: null };
  bucket.ownershipProof = { ...bucket, bucketId: bucket.id, ownershipProof: undefined, kind: COS_BUCKET_PROOF_KIND, atomicTags: expectedCosBucketTags(bucket),
    preflightAbsentAt: bucket.preflightAbsentAt!.toISOString(), creationStartedAt: bucket.creationStartedAt!.toISOString(), cloudCreationAt: '2026-09-01T00:00:02.000Z', verifiedAt: '2026-09-01T00:00:03.000Z',
    ownerId: 'qcs::cam::uin/100001:uin/100001', aclPrivate: true, policyAbsent: true, exclusiveUsage: true,
    preflightRequestId: 'preflight', iamRequestId: 'iam', headRequestId: 'head', aclRequestId: 'acl', tagRequestId: 'tags', serviceRequestId: 'service' };
  return bucket;
}
