import { PrismaService } from '../src/database/prisma.service';
import { PrismaAdminRepository } from '../src/database/prisma-admin.repository';
import { tencentPackBaselineFixture } from './support/tencent-pack-baseline-fixture';
import { ImageImportsService } from '../src/admin/image-imports.service';
import { CloudAccountContextsService } from '../src/admin/cloud-account-contexts.service';
const url = process.env.PACKED_IMAGE_TEST_DATABASE_URL;
if (url && (new URL(url).hostname !== 'packed-image-test-postgres' || new URL(url).pathname !== '/packed_image_test')) throw new Error('Packed-image DB tests require isolated packed_image_test');
const describeDb = url ? describe : describe.skip;

describeDb('Packed-image repository in isolated PostgreSQL', () => {
  let prisma: PrismaService;
  let repository: PrismaAdminRepository;
  beforeAll(async () => {
    prisma = new PrismaService({ datasources: { db: { url } } });
    repository = new PrismaAdminRepository(prisma);
    await prisma.$connect();
  });
  afterAll(async () => { await prisma?.$disconnect(); });
  beforeEach(async () => {
    await prisma.imageImportJob.deleteMany(); await prisma.cloudAccountContext.deleteMany();
    await prisma.platformImageAsset.deleteMany(); await prisma.cloudImageSnapshot.deleteMany(); await prisma.packedImageArtifact.deleteMany(); await prisma.platformUser.deleteMany();
  });
  const newArtifact = () => repository.createPackedImageArtifact({ cloudAccountContextId: 'ctx', cloudAccountUid: '100001', regionId: 'cn-hangzhou', ownerUserId: 'owner', sourceRangeInstanceId: 'range', sourceHostKey: 'ecs', sourceInstanceId: 'i-owned', sourceDiskIds: ['d-owned'] });
  it('keeps new baseline JSON and source identity immutable while leaving old NULL artifacts unupgraded', async () => {
    const source = { id: 'baseline-pg', cloudProvider: 'tencent_cloud' as const, cloudWorkspaceId: 'legacy-unbound', cloudAccountContextId: 'ctx', cloudAccountUid: '100001', regionId: 'ap-shanghai',
      ownerUserId: 'owner', sourceRangeInstanceId: 'range', sourceHostKey: 'host', sourceInstanceId: 'ins-source', sourceDiskIds: ['disk-source'] };
    const baseline = tencentPackBaselineFixture(source);
    const created = await repository.createPackedImageArtifact({ ...source, sourceSnapshotBaseline: baseline });
    expect(created.sourceSnapshotBaseline).toEqual(baseline);
    await repository.updatePackedImageArtifact(created.id, { status: 'creating', imageId: 'img-owned' });
    await expect(prisma.packedImageArtifact.update({ where: { id: created.id }, data: { sourceSnapshotBaseline: { ...baseline, preCreateSnapshotIds: ['snap-replaced'] } } })).rejects.toThrow();
    await expect(prisma.packedImageArtifact.update({ where: { id: created.id }, data: { ownerUserId: 'foreign' } })).rejects.toThrow();
    expect((await repository.getPackedImageArtifact(created.id))?.sourceSnapshotBaseline).toEqual(baseline);
    const legacy = await newArtifact(); expect(legacy.sourceSnapshotBaseline).toBeNull();
    await expect(prisma.packedImageArtifact.update({ where: { id: legacy.id }, data: { sourceSnapshotBaseline: baseline } })).rejects.toThrow();
    expect((await repository.getPackedImageArtifact(legacy.id))?.sourceSnapshotBaseline).toBeNull();
  });
  it('serializes claim acquisition, fences stale writers, and preserves progress across a new holder', async () => {
    const artifact = await newArtifact();
    const results = await Promise.all(['A', 'B'].map(token => repository.claimPackedImageArtifact(artifact.id, token, new Date(Date.now() + 60_000))));
    expect(results.filter(Boolean)).toHaveLength(1);
    const held = results[0] ? 'A' : 'B';
    await repository.withPackedImageArtifactClaim(artifact.id, held, repo => repo.updatePackedImageArtifact(artifact.id, { status: 'deleting', imageId: 'm-owned', backingSnapshotIds: ['s-owned'] }));
    await prisma.packedImageArtifact.update({ where: { id: artifact.id }, data: { leaseExpiresAt: new Date(Date.now() - 1000) } });
    expect(await repository.claimPackedImageArtifact(artifact.id, 'recovery', new Date(Date.now() + 60_000))).toBe(true);
    await expect(repository.withPackedImageArtifactClaim(artifact.id, held, repo => repo.updatePackedImageArtifact(artifact.id, { status: 'available' }))).rejects.toThrow();
    await repository.releasePackedImageArtifactClaim(artifact.id, held);
    expect(await repository.renewPackedImageArtifactClaim(artifact.id, 'recovery', new Date(Date.now() + 60_000))).toBe(true);
    expect(await repository.getPackedImageArtifact(artifact.id)).toMatchObject({ status: 'deleting', backingSnapshotIds: ['s-owned'] });
  });
  it('retains missing sources, excludes unverified sources and restores only the exact source link without clearing defaults', async () => {
    await repository.createPlatformUser({ id: 'owner', username: 'owner', passwordHash: 'mock', role: 'user' });
    const input = { provider: 'alibaba_cloud' as const, accountUid: '100001', regionId: 'cn-hangzhou', scope: 'custom' as const, snapshots: [{ imageId: 'm-owned', sourceImageName: 'original', status: 'Available', isAvailable: true, lastSyncedAt: new Date() }] };
    await repository.upsertImageSnapshots(input);
    const source = (await repository.listImageSnapshots({ imageId: 'm-owned' }))[0];
    const asset = await repository.collectPlatformImageAsset({ snapshotId: source.id, displayName: 'private', ownerUserId: 'owner', visibility: 'private', defaultHostName: 'retained-host', defaultPassword: 'encrypted', description: 'retained' });
    await repository.setPlatformImageAssetEnabled(asset.id, false);
    await repository.collectPlatformImageAsset({ snapshotId: source.id, displayName: 'replace', ownerUserId: null, visibility: 'platform', preserveExisting: true });
    expect(await repository.getPlatformImageAssetById(asset.id)).toMatchObject({ ownerUserId: 'owner', defaultHostName: 'retained-host', defaultPassword: 'encrypted', enabled: false, visibility: 'private', displayName: 'private' });
    await prisma.platformImageAsset.update({ where: { id: asset.id }, data: { sourceSnapshotId: null } });
    expect(await repository.listPlatformImageAssets({ onlyAvailableSourceSnapshots: true })).toEqual([]);
    await repository.upsertImageSnapshots(input);
    expect(await repository.getPlatformImageAssetById(asset.id)).toMatchObject({ sourceSnapshotId: source.id, ownerUserId: 'owner', defaultHostName: 'retained-host', enabled: false });
    await repository.reconcileImageSnapshots({ ...input, snapshots: [] });
    expect(await repository.getImageSnapshotById(source.id)).toMatchObject({ status: 'Missing', isAvailable: false });
    expect(await repository.getPlatformImageAssetById(asset.id)).toMatchObject({ sourceSnapshotId: source.id, enabled: false });
    expect(await repository.listPlatformImageAssets({ onlyAvailableSourceSnapshots: true })).toEqual([]);
    await repository.upsertImageSnapshots({ ...input, snapshots: [{ ...input.snapshots[0], status: 'Deleted', isAvailable: false }] });
    await repository.upsertImageSnapshots(input);
    expect(await repository.getImageSnapshotById(source.id)).toMatchObject({ status: 'Deleted', isAvailable: false });
  });
  it('fences concurrent import workers and stale cleanup writers while retaining exact snapshot progress', async () => {
    await repository.createPlatformUser({ id: 'owner', username: 'owner', passwordHash: 'mock', role: 'user' });
    await prisma.cloudAccountContext.create({ data: { id: 'ctx', displayName: 'fixture', accountUid: '100001', regionId: 'cn-hangzhou', zoneId: 'cn-hangzhou-h', accessKeyId: 'mock', accessKeySecret: 'mock', imageImportBucket: 'fixture-bucket' } });
    const job = await prisma.imageImportJob.create({ data: { cloudAccountContextId: 'ctx', cloudAccountUid: '100001', regionId: 'cn-hangzhou', imageImportBucket: 'fixture-bucket', ownerUserId: 'owner', displayName: 'fixture', osType: 'linux', architecture: 'x86_64', bootMode: 'BIOS', imageFormat: 'qcow2', systemDiskSize: 40, sourceFileName: 'fixture.qcow2', sourceContentType: 'application/octet-stream', sourceSizeBytes: '1024', objectKey: 'fixture/object', uploadExpiresAt: new Date(Date.now() + 60000) } });
    const a = new ImageImportsService(repository, prisma, {} as CloudAccountContextsService) as any;
    const b = new ImageImportsService(repository, prisma, {} as CloudAccountContextsService) as any;
    let release!: () => void, entered!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const acquired = new Promise<void>(resolve => { entered = resolve; });
    let stale: any;
    const first = a.withClaim(job.id, async (held: any) => { stale = held; await a.updateJob(held, { status: 'failed', imageId: 'm-fixture', backingSnapshotIds: ['s-first', 's-second'], deletedSnapshotIds: ['s-first'] }); entered(); await blocked; });
    await acquired;
    let overlapped = false;
    await b.withClaim(job.id, async () => { overlapped = true; });
    expect(overlapped).toBe(false);
    await prisma.imageImportJob.update({ where: { id: job.id }, data: { leaseExpiresAt: new Date(0) } });
    await b.withClaim(job.id, async (held: any) => {
      await expect(a.updateJob(stale, { snapshotCleanupCompletedAt: new Date() })).rejects.toThrow();
      await b.updateJob(held, { deletedSnapshotIds: ['s-first', 's-second'] });
    });
    release(); await first;
    expect(await prisma.imageImportJob.findUnique({ where: { id: job.id } })).toMatchObject({ backingSnapshotIds: ['s-first', 's-second'], deletedSnapshotIds: ['s-first', 's-second'], snapshotCleanupCompletedAt: null, leaseToken: null });
  });
});
