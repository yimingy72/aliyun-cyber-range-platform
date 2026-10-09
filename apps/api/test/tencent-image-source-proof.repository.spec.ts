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
  afterAll(async () => { await prisma.imageImportJob.deleteMany({ where: { cloudWorkspaceId: { in: [scope.cloudWorkspaceId, 'foreign-fixture'] } } }); await prisma.platformUser.deleteMany({ where: { cloudWorkspaceId: { in: [scope.cloudWorkspaceId, 'foreign-fixture'] } } }); await prisma.cloudAccountContext.deleteMany({ where: { cloudWorkspaceId: { in: [scope.cloudWorkspaceId, 'foreign-fixture'] } } }); await prisma.cloudImageImportBucket.deleteMany({ where: { cloudWorkspaceId: { in: [scope.cloudWorkspaceId, 'foreign-fixture'] } } }); await prisma.cloudImageSnapshot.deleteMany({ where: { cloudWorkspaceId: { in: [scope.cloudWorkspaceId, 'foreign-fixture'] } } }); await prisma.cloudWorkspace.deleteMany({ where: { id: { in: [scope.cloudWorkspaceId, 'foreign-fixture'] } } }); await prisma.$disconnect(); });
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
  it('rejects foreign updates/upserts and scalar or nested import attachments at the database boundary', async () => runInCloudWorkspace(scope, async () => {
    const row = await prisma.cloudImageImportBucket.findUnique({ where: { activeSlot: 'image-proof-slot' } });
    await expect(prisma.cloudImageImportBucket.update({ where: { id: row!.id }, data: { cloudAccountContextId: 'other-context' } })).rejects.toThrow('immutable');
    const foreign = { ...scope, cloudWorkspaceId: 'foreign-fixture', accountUid: '654321' };
    await prisma.cloudWorkspace.upsert({ where: { id: foreign.cloudWorkspaceId }, create: { id: foreign.cloudWorkspaceId, provider: 'tencent_cloud', accountUid: foreign.accountUid, displayName: 'synthetic foreign workspace' }, update: {} });
    await expect(runInCloudWorkspace(foreign, () => prisma.cloudImageImportBucket.update({ where: { id: row!.id }, data: { status: 'ready' } }))).rejects.toThrow();
    await expect(runInCloudWorkspace(foreign, () => prisma.cloudImageImportBucket.upsert({ where: { id: row!.id }, update: { status: 'ready' }, create: { id: row!.id, cloudAccountContextId: 'context', cloudAccountUid: foreign.accountUid, appId: '1250000000', regionId: 'ap-guangzhou', bucketName: 'foreign-fixture-1250000000', creationNonce: 'foreign-fixture', creatorUserId: 'owner', ownershipMarkerKey: 'foreign-marker' } as never }))).rejects.toThrow();
    const foreignActor = await runInCloudWorkspace(foreign, () => prisma.platformUser.create({ data: { id: 'foreign-image-source-actor', username: 'foreign-image-source-actor', loginUsername: 'foreign-image-source-actor', passwordHash: 'synthetic', role: 'user' } as never }));
    const actor = await prisma.platformUser.create({ data: { id: 'image-source-actor', username: 'image-source-actor', loginUsername: 'image-source-actor', passwordHash: 'synthetic', role: 'user' } as never });
    const context = await prisma.cloudAccountContext.create({ data: { cloudWorkspaceId: scope.cloudWorkspaceId, displayName: 'fixture', provider: 'tencent_cloud', accountUid: scope.accountUid, regionId: 'ap-guangzhou', zoneId: 'ap-guangzhou-3', accessKeyId: 'synthetic', accessKeySecret: 'synthetic', imageImportBucket: '', status: 'ready' } });
    const data = { cloudAccountContextId: context.id, ownerUserId: actor.id, cloudProvider: 'tencent_cloud' as const, displayName: 'fixture', osType: 'linux', architecture: 'x86_64', bootMode: 'BIOS', imageFormat: 'qcow2', systemDiskSize: 40, sourceFileName: 'fixture.qcow2', sourceContentType: 'application/octet-stream', sourceSizeBytes: '1', objectKey: 'fixture-key', uploadExpiresAt: new Date(Date.now()+60000) };
    await expect(runInCloudWorkspace(foreign, () => prisma.imageImportJob.create({ data: { ...data, managedBucketId: row!.id } }))).rejects.toThrow();
    await expect(runInCloudWorkspace(foreign, () => prisma.imageImportJob.create({ data: { ...data, ownerUserId: undefined, ownerUser: { connect: { id: foreignActor.id } }, cloudAccountContextId: undefined, cloudAccountContext: { connect: { id: context.id } }, managedBucket: { connect: { id: row!.id } } } as never }))).rejects.toThrow();
    expect(await prisma.imageImportJob.count()).toBe(0);
  }));

});
