import { PrismaService } from '../src/database/prisma.service';
import { PrismaAdminRepository } from '../src/database/prisma-admin.repository';
import { ImageCatalogService } from '../src/admin/image-catalog.service';
import { SystemConfigService } from '../src/admin/system-config.service';
const url = process.env.IMAGE_TAG_TEST_DATABASE_URL;
if (url && (new URL(url).hostname !== 'image-tags-test-postgres' || new URL(url).pathname !== '/image_tags_test')) throw new Error('Tag DB tests require isolated image_tags_test');
const describeDb = url ? describe : describe.skip;
const admin = { id: 'admin', username: 'admin', role: 'admin' as const }, owner = { id: 'owner', username: 'owner', role: 'user' as const };

describeDb('Image tag existing capabilities in isolated PostgreSQL', () => {
  let prisma: PrismaService, repository: PrismaAdminRepository, service: ImageCatalogService;
  beforeAll(async () => {
    prisma = new PrismaService({ datasources: { db: { url } } }); await prisma.$connect(); repository = new PrismaAdminRepository(prisma);
    service = new ImageCatalogService(repository, { getAccountContext: async () => ({ provider: 'alibaba_cloud', accountUid: '100001', defaultRegion: 'cn-hangzhou' }) } as unknown as SystemConfigService);
  });
  afterAll(async () => { await prisma?.$disconnect(); });
  beforeEach(async () => {
    await prisma.platformImageAsset.deleteMany(); await prisma.cloudImageSnapshot.deleteMany(); await prisma.platformImageTag.deleteMany(); await prisma.platformUser.deleteMany();
    for (const user of [admin, owner]) await repository.createPlatformUser({ ...user, passwordHash: 'mock' });
  });
  it('creates dictionary definitions, normalizes duplicates, and rejects simultaneous duplicate inserts', async () => {
    const tag = await service.createPlatformImageTag({ name: '  Ｗｅｂ  ' }, admin);
    expect(tag.name).toBe('Ｗｅｂ');
    await expect(service.createPlatformImageTag({ name: 'WEB' }, admin)).rejects.toThrow('已存在');
    await expect(service.createPlatformImageTag({ name: 'User tag' }, owner)).rejects.toThrow('Admin');
    const results = await Promise.allSettled(['Service', 'SERVICE'].map(name => service.createPlatformImageTag({ name }, admin)));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect((await repository.listPlatformImageTags()).map(t => t.normalizedName).sort()).toEqual(['service', 'web']);
  });
  it('allows only owner/admin association replacement and clears associations while keeping definitions', async () => {
    const tag = await service.createPlatformImageTag({ name: 'Web' }, admin);
    await repository.upsertImageSnapshots({ provider: 'alibaba_cloud', accountUid: '100001', regionId: 'cn-hangzhou', scope: 'custom', snapshots: [{ imageId: 'm-tagged', sourceImageName: 'tagged', status: 'Available', isAvailable: true, lastSyncedAt: new Date() }] });
    const source = (await repository.listImageSnapshots({ imageId: 'm-tagged' }))[0];
    const asset = await repository.collectPlatformImageAsset({ snapshotId: source.id, displayName: 'private', ownerUserId: owner.id, visibility: 'private' });
    await service.setPlatformAssetTags(asset.id, { tagIds: [tag.id] }, owner);
    await expect(service.setPlatformAssetTags(asset.id, { tagIds: [] }, { ...owner, id: 'other-user' })).rejects.toThrow('not found');
    await expect(service.setPlatformAssetTags(asset.id, { tagIds: ['missing'] }, owner)).rejects.toThrow('不存在');
    expect((await repository.getPlatformImageAssetById(asset.id))!.tags.map(t => t.id)).toEqual([tag.id]);
    await service.setPlatformAssetTags(asset.id, { tagIds: [] }, admin);
    expect((await repository.getPlatformImageAssetById(asset.id))!.tags).toEqual([]);
    expect(await repository.listPlatformImageTags()).toHaveLength(1);
  });
});
