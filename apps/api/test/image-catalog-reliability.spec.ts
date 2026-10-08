import { ImageCatalogService } from '../src/admin/image-catalog.service';
import { SystemConfigService } from '../src/admin/system-config.service';
import { PackedImagesService } from '../src/admin/packed-images.service';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';

const admin = { id: 'admin', username: 'admin', role: 'admin' as const };
const owner = { id: 'owner', username: 'owner', role: 'user' as const };
const account = { provider: 'alibaba_cloud' as const, accountUid: '123456', defaultRegion: 'cn-hangzhou', accessKeyId: 'mock-ak', accessKeySecret: 'mock-sk' };

describe('Image catalog preservation and collection', () => {
  let repository: ReturnType<typeof createMemoryAdminRepository>;
  let service: ImageCatalogService;
  let sourceId: string;
  let assetId: string;
  let fetchMock: jest.SpiedFunction<typeof fetch>;
  beforeEach(async () => {
    repository = createMemoryAdminRepository();
    service = new ImageCatalogService(repository, { getAccountContext: jest.fn().mockResolvedValue(account) } as unknown as SystemConfigService, { hasPending: jest.fn().mockResolvedValue(false) } as unknown as PackedImagesService);
    await repository.createPlatformUser({ id: owner.id, username: owner.username, passwordHash: 'mock', role: 'user' });
    await repository.upsertImageSnapshots({ provider: account.provider, accountUid: account.accountUid, regionId: account.defaultRegion, scope: 'custom', snapshots: [{ imageId: 'm-existing', sourceImageName: 'existing', status: 'Available', isAvailable: true, lastSyncedAt: new Date() }] });
    sourceId = (await repository.listImageSnapshots({ imageId: 'm-existing' }))[0].id;
    assetId = (await repository.collectPlatformImageAsset({ snapshotId: sourceId, displayName: 'owner image', ownerUserId: owner.id, visibility: 'private', defaultHostName: 'private-host', defaultPassword: 'retained-encrypted-password', description: 'retained description' })).id;
    await repository.setPlatformImageAssetEnabled(assetId, false);
    fetchMock = jest.spyOn(globalThis, 'fetch');
  });
  afterEach(() => jest.restoreAllMocks());
  it.each([
    { Code: 'InvalidAccessKeyId.NotFound' },
    { Success: false, TotalCount: 0 },
    { Success: 'false', TotalCount: 0 },
    { TotalCount: 0, Images: 'malformed' },
    { TotalCount: 1, PageNumber: 2, PageSize: 100, Images: { Image: [{ ImageId: 'm-other', Status: 'Available' }] } },
    { TotalCount: null, Images: { Image: [] } },
    { TotalCount: 0 },
    { TotalCount: 2, Images: { Image: [] } },
    { TotalCount: 1, Images: { Image: [{ ImageId: 'm-other' }] } },
    { TotalCount: 2, Images: { Image: [{ ImageId: 'm-other', Status: 'Available' }, { ImageId: 'm-other', Status: 'Creating' }] } },
  ])('retains cached source and asset on a malformed or business-failed cloud response: %j', async body => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
    await expect(service.syncCustomImages()).rejects.toThrow();
    expect(await repository.getImageSnapshotById(sourceId)).toMatchObject({ status: 'Available', isAvailable: true });
    expect(await repository.getPlatformImageAssetById(assetId)).toMatchObject({ ownerUserId: owner.id, sourceSnapshotId: sourceId, enabled: false });
  });
  it('retains cached records on invalid JSON and queries Status=ALL', async () => {
    fetchMock.mockResolvedValue(new Response('not-json', { status: 200 }));
    await expect(service.syncCustomImages()).rejects.toThrow('invalid JSON');
    expect(new URL(String(fetchMock.mock.calls[0][0])).searchParams.get('Status')).toBe('ALL');
    expect((await repository.getImageSnapshotById(sourceId))!.isAvailable).toBe(true);
  });
  it('tombstones vanished cloud images and disables assets without losing the source link or owner defaults', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ TotalCount: 0, Images: { Image: [] } }), { status: 200 }));
    await service.syncCustomImages();
    expect(await repository.getImageSnapshotById(sourceId)).toMatchObject({ status: 'Missing', isAvailable: false });
    expect(await repository.getPlatformImageAssetById(assetId)).toMatchObject({ sourceSnapshotId: sourceId, ownerUserId: owner.id, defaultHostName: 'private-host', enabled: false });
    await expect(service.setPlatformAssetEnabled(assetId, true, owner)).rejects.toThrow('来源镜像不可用');
    await expect(service.collectPlatformAsset(sourceId, 'retry', admin)).rejects.toThrow('不可用');
  });
  it('prepares owned cleanup against its captured account even after the active account changes', async () => {
    const artifact = await repository.createPackedImageArtifact({ cloudAccountContextId: 'context-captured', cloudAccountUid: account.accountUid, regionId: account.defaultRegion, ownerUserId: owner.id, sourceRangeInstanceId: 'range', sourceHostKey: 'ecs', sourceInstanceId: 'i-owned', sourceDiskIds: ['d-owned'] });
    await repository.updatePackedImageArtifact(artifact.id, { imageId: 'm-existing', sourceSnapshotId: sourceId, platformImageAssetId: assetId, status: 'available' });
    const oldAccountService = new ImageCatalogService(repository, { getAccountContext: jest.fn().mockResolvedValue({ ...account, accountUid: 'another-account', defaultRegion: 'cn-beijing' }) } as unknown as SystemConfigService);
    await expect(oldAccountService.prepareCustomDelete(sourceId, owner, true)).resolves.toMatchObject({ cloudAccountUid: account.accountUid, regionId: account.defaultRegion, imageId: 'm-existing' });
    await expect(oldAccountService.prepareCustomDelete(sourceId, { ...owner, id: 'another-owner' }, true)).rejects.toThrow('owner');
    await expect(oldAccountService.prepareCustomDelete(sourceId, admin, false)).rejects.toThrow('not found');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps vanished platform assets manageable for admins while excluding them from ordinary user choices', async () => {
    await service.updatePlatformAsset(assetId, { visibility: 'platform' }, admin);
    await repository.reconcileImageSnapshots({ provider: account.provider, accountUid: account.accountUid, regionId: account.defaultRegion, scope: 'custom', snapshots: [] });
    await expect(service.listPlatformAssets(admin, 'platform')).resolves.toMatchObject({ items: [expect.objectContaining({ id: assetId, enabled: false, sourceSnapshotAvailable: false, canManage: true })] });
    await expect(service.listPlatformAssets(owner, 'platform')).resolves.toEqual({ items: [] });
  });

  it('does not clear owner, private visibility, defaults or disabled state on repeated collection', async () => {
    const before = await repository.getPlatformImageAssetById(assetId);
    await service.collectPlatformAsset(sourceId, 'admin replacement name', admin);
    expect(await repository.getPlatformImageAssetById(assetId)).toEqual(before);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('removes only the directory record, keeping the source and charged snapshot ledger', async () => {
    const ledger = await repository.createBillingLedgerResource({ cloudAccountUid: account.accountUid, regionId: account.defaultRegion, cloudResourceId: 's-kept', cloudResourceType: 'snapshot', billingScope: 'user', ownerUserId: owner.id, platformImageAssetId: assetId, billingStartAt: new Date(), tagsSnapshot: {} });
    await service.removePlatformAsset(assetId, owner);
    expect(await repository.getPlatformImageAssetById(assetId)).toBeNull();
    expect((await repository.getImageSnapshotById(sourceId))!.isAvailable).toBe(true);
    expect((await repository.listBillingLedgerResources()).find(row => row.id === ledger.id)!.releasedAt).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
