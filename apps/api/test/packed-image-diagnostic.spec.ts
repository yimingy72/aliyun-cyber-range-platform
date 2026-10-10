import type { PackedImageArtifactRecord, RangeInstanceRecord } from '../src/admin/admin.repository';
import { encodePackedImageDiagnostic, packedImageArtifactSummaries, packedImageDiagnostic, PackedImageCloudError, PackedImageVerificationError } from '../src/admin/packed-image-diagnostic';
import { TencentCloudRequestError } from '../src/admin/tencent-cloud-client';

const instance = { id: 'source', ownerUserId: 'owner', createdBy: 'owner', cloudProvider: 'tencent_cloud', cloudWorkspaceId: 'space',
  singleInstanceConfig: { cloudAccountContextId: 'context', cloudAccountUid: '123456', regionId: 'ap-shanghai', hostKey: 'host' } } as RangeInstanceRecord;
const artifact = { id: 'artifact', cloudProvider: 'tencent_cloud', cloudWorkspaceId: 'space', ownerUserId: 'owner', cloudAccountContextId: 'context', cloudAccountUid: '123456', regionId: 'ap-shanghai',
  sourceRangeInstanceId: 'source', sourceInstanceId: 'ins-source', sourceHostKey: 'host', sourceDiskIds: ['disk-source'], imageId: null, status: 'creating', backingSnapshotIds: [],
  sourceSnapshotBaseline: null, sourceSnapshotId: null, platformImageAssetId: null, deletedSnapshotIds: [], cloudImageDeletedAt: null, completedAt: null,
  errorMessage: 'legacy raw private message synthetic-secret', createdAt: new Date(), updatedAt: new Date(), lastPolledAt: null } as PackedImageArtifactRecord;

describe('safe packed image diagnostics', () => {
  it('keeps original swallowed errors unknown and exposes only the targeted frozen artifact summary', () => {
    const summary = packedImageArtifactSummaries(instance, [artifact]);
    expect(summary).toEqual([expect.objectContaining({ id: 'artifact', status: 'creating', phase: 'unknown', cloudErrorCode: 'UNKNOWN' })]);
    expect(JSON.stringify(summary)).not.toContain('synthetic-secret');
    expect(summary[0]).not.toHaveProperty('errorMessage');
  });
  it.each(['cloudProvider','cloudWorkspaceId','ownerUserId','cloudAccountContextId','cloudAccountUid','regionId','sourceRangeInstanceId','sourceHostKey'])('excludes a conflicting artifact %s without cloud calls', field => {
    expect(packedImageArtifactSummaries(instance, [{ ...artifact, [field]: 'foreign' }])).toEqual([]);
  });
  it('preserves a known safe cloud stage/code while redacting raw errors and credential-bearing code strings', () => {
    const diagnostic = packedImageDiagnostic(new PackedImageCloudError('create_image', 'InvalidParameterValue'), 'persist_asset');
    const summary = packedImageArtifactSummaries(instance, [{ ...artifact, errorMessage: encodePackedImageDiagnostic(diagnostic) }]);
    expect(summary[0]).toMatchObject({ phase: 'create_image', cloudErrorCode: 'InvalidParameterValue' });
    expect(packedImageDiagnostic(new Error('synthetic-secret raw transport error'), 'create_image')).toEqual({ phase: 'create_image', cloudErrorCode: 'UNKNOWN' });
    expect(packedImageDiagnostic(new TencentCloudRequestError('synthetic_secret'), 'create_image', ['synthetic_secret']).cloudErrorCode).toBe('UNKNOWN');
    expect(packedImageDiagnostic(new PackedImageCloudError('create_image', 'synthetic_secret'), 'create_image', ['synthetic_secret']).cloudErrorCode).toBe('UNKNOWN');
  });
  it('persists safe parameter categories and a request receipt while dropping arbitrary fields', () => {
    const diagnostic = packedImageDiagnostic(new TencentCloudRequestError('InvalidParameterValue', 'create-request', { parameterName: 'TagSpecification', hint: 'invalid_type' }), 'create_image');
    expect(packedImageArtifactSummaries(instance, [{ ...artifact, errorMessage: encodePackedImageDiagnostic(diagnostic) }])[0])
      .toMatchObject({ cloudParameterName: 'TagSpecification', cloudErrorHint: 'invalid_type', cloudRequestId: 'create-request' });
    const malformed = 'packed-image-diagnostic:' + JSON.stringify({ phase: 'create_image', cloudErrorCode: 'InvalidParameterValue', cloudParameterName: 'private-value', cloudErrorHint: 'private-value', vendorMessage: 'private-value' });
    expect(JSON.stringify(packedImageArtifactSummaries(instance, [{ ...artifact, errorMessage: malformed }]))).not.toContain('private-value');
  });
  it('exposes only allowlisted capture checks and field shapes through the existing artifact summary',()=>{
    const diagnostic=packedImageDiagnostic(new PackedImageVerificationError('snapshot_response_shape',{snapshotFieldShapes:{CopyFromRemote:'null',ShareReference:'string',privateKey:'synthetic-secret'},
      snapshotChecks:{privateSnapshot:false,privateKey:true}},'snapshot_verify'),'describe_image');
    const summary=packedImageArtifactSummaries(instance,[{...artifact,errorMessage:encodePackedImageDiagnostic(diagnostic)}]);
    expect(summary[0]).toMatchObject({phase:'snapshot_verify',verificationCheck:'snapshot_response_shape',snapshotFieldShapes:{CopyFromRemote:'null',ShareReference:'string'},snapshotChecks:{privateSnapshot:false}});
    expect(JSON.stringify(summary)).not.toContain('privateKey');expect(JSON.stringify(summary)).not.toContain('synthetic-secret');
  });
});
