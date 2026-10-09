import { PrismaService } from '../src/database/prisma.service';
import { PrismaAdminRepository } from '../src/database/prisma-admin.repository';
import { runInCloudWorkspace } from '../src/auth/cloud-workspace-scope';
const url = process.env.PACKED_IMAGE_TEST_DATABASE_URL;
if (url && (new URL(url).hostname !== 'packed-image-test-postgres' || new URL(url).pathname !== '/packed_image_test')) throw new Error('Image source proof tests require the isolated fixture database');
(url ? describe : describe.skip)('Tencent image source proof in isolated PostgreSQL', () => {
  let prisma: PrismaService; let repo: PrismaAdminRepository;
  const scope = { cloudWorkspaceId: 'image-proof-fixture', provider: 'tencent_cloud' as const, accountUid: '123456', isReadOnly: false };
  beforeAll(async () => {
    prisma = new PrismaService({ datasources: { db: { url } } }); await prisma.$connect(); repo = new PrismaAdminRepository(prisma);
    await prisma.cloudWorkspace.upsert({ where: { id: scope.cloudWorkspaceId }, create: { id: scope.cloudWorkspaceId, provider: 'tencent_cloud', accountUid: '123456', displayName: 'synthetic image workspace' }, update: {} });
  });
  afterAll(async () => { await prisma.cloudImageImportBucket.deleteMany({ where: { cloudWorkspaceId: scope.cloudWorkspaceId } }); await prisma.cloudImageSnapshot.deleteMany({ where: { cloudWorkspaceId: scope.cloudWorkspaceId } }); await prisma.cloudWorkspace.delete({ where: { id: scope.cloudWorkspaceId } }); await prisma.$disconnect(); });
  it('preserves the cloud minimum through lifecycle-only updates without inventing a default', async () => runInCloudWorkspace(scope, async () => {
    await repo.upsertImageSnapshots({ provider: 'tencent_cloud', accountUid: scope.accountUid, regionId: 'ap-guangzhou', scope: 'custom', snapshots: [{ imageId: 'img-owned', sourceImageName: 'fixture', minimumSystemDiskSize: 80, lastSyncedAt: new Date() }] });
    await repo.upsertImageSnapshots({ provider: 'tencent_cloud', accountUid: scope.accountUid, regionId: 'ap-guangzhou', scope: 'custom', snapshots: [{ imageId: 'img-owned', sourceImageName: 'fixture', status: 'Deleting', lastSyncedAt: new Date() }] });
    expect((await repo.listImageSnapshots({ imageId: 'img-owned' }))[0].minimumSystemDiskSize).toBe(80);
  }));
  it('serializes the same active bucket slot, retains full creation proof and hides it in another workspace', async () => runInCloudWorkspace(scope, async () => {
    const input = (nonce: string) => ({ cloudAccountContextId: 'context-frozen', cloudProvider: 'tencent_cloud' as const, cloudAccountUid: scope.accountUid, appId: '1250000000', regionId: 'ap-guangzhou', bucketName: `fixture-${nonce}-1250000000`, creationNonce: nonce, creatorUserId: 'owner', ownershipMarkerKey: `proof/${nonce}.json`, activeSlot: 'image-proof-slot' });
    const attempts = await Promise.allSettled(['one', 'two'].map(nonce => prisma.cloudImageImportBucket.create({ data: input(nonce) as never })));
    expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const row = await prisma.cloudImageImportBucket.findUnique({ where: { activeSlot: 'image-proof-slot' } });
    expect(row).toMatchObject({ cloudWorkspaceId: scope.cloudWorkspaceId, cloudAccountUid: scope.accountUid, cloudProvider: 'tencent_cloud', cloudAccountContextId: 'context-frozen' });
    await expect(runInCloudWorkspace({ ...scope, cloudWorkspaceId: 'other-workspace' }, () => prisma.cloudImageImportBucket.findUnique({ where: { id: row!.id } }))).resolves.toBeNull();
    await prisma.cloudImageImportBucket.update({ where: { id: row!.id }, data: { status: 'deleted', activeSlot: null, ownershipProof: { requestId: 'synthetic-request', source: 'platform-created' } } });
    await prisma.cloudImageImportBucket.create({ data: input('three') as never });
    expect(await prisma.cloudImageImportBucket.count()).toBe(2);
  }));
});
