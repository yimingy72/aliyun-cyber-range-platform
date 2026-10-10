import { readTencentPackBaseline, validTencentPackBaseline } from '../src/admin/tencent-pack-snapshot-baseline';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';
import { tencentPackBaselineFixture } from './support/tencent-pack-baseline-fixture';

const source = { id: 'baseline-artifact', cloudProvider: 'tencent_cloud' as const, cloudWorkspaceId: 'legacy-unbound', cloudAccountContextId: 'original-context', cloudAccountUid: '123456', regionId: 'ap-shanghai', ownerUserId: 'owner',
  sourceRangeInstanceId: 'range-source', sourceHostKey: 'host', sourceInstanceId: 'ins-source', sourceDiskIds: ['disk-source'] };
describe('immutable Tencent pack snapshot pre-create baseline', () => {
  it('retains complete empty baseline receipts in a new artifact but never permits legacy or post-insert replacement', async () => {
    const repository = createMemoryAdminRepository();
    const baseline = tencentPackBaselineFixture(source);
    const artifact = await repository.createPackedImageArtifact({ ...source, sourceSnapshotBaseline: baseline });
    expect(readTencentPackBaseline(artifact)).toEqual(baseline);
    await expect(repository.updatePackedImageArtifact(artifact.id, { sourceSnapshotBaseline: { ...baseline, preCreateSnapshotIds: ['snap-old'] } } as never)).rejects.toThrow('immutable');
    const legacy = await repository.createPackedImageArtifact({ ...source, id: 'legacy' });
    expect(readTencentPackBaseline(legacy)).toBeNull();
    await expect(repository.updatePackedImageArtifact(legacy.id, { sourceSnapshotBaseline: baseline } as never)).rejects.toThrow('immutable');
  });
  it.each(['id','cloudProvider','cloudWorkspaceId','cloudAccountContextId','cloudAccountUid','regionId','ownerUserId','sourceRangeInstanceId','sourceHostKey','sourceInstanceId'])('rejects conflicting immutable source field %s', field => {
    expect(validTencentPackBaseline(source, { ...tencentPackBaselineFixture(source), [field]: 'foreign' })).toBe(false);
  });
  it('rejects incomplete disk coverage, missing receipts and mismatched global prior IDs', () => {
    const baseline = tencentPackBaselineFixture(source);
    expect(validTencentPackBaseline(source, { ...baseline, sourceDisks: [] })).toBe(false);
    expect(validTencentPackBaseline(source, { ...baseline, sourceDisks: [{ ...baseline.sourceDisks[0], evidence: [] }] })).toBe(false);
    expect(validTencentPackBaseline(source, { ...baseline, preCreateSnapshotIds: ['snap-unread'] })).toBe(false);
    expect(validTencentPackBaseline(source, { ...baseline, observedAt: '2026-10-10 09:00:00' })).toBe(false);
  });
});
