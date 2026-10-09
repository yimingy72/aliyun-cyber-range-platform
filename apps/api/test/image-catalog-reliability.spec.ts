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

  describe('default cloud image deletion', () => {
    async function ledgers() {
      const common = { cloudAccountUid: account.accountUid, regionId: account.defaultRegion, billingScope: 'user' as const, ownerUserId: owner.id, platformImageAssetId: assetId, billingStartAt: new Date(), tagsSnapshot: {} };
      const image = await repository.createBillingLedgerResource({ ...common, cloudResourceId: 'm-existing', cloudResourceType: 'image' });
      const snapshot = await repository.createBillingLedgerResource({ ...common, cloudResourceId: 's-retained', cloudResourceType: 'snapshot' });
      return { image, snapshot };
    }
    function cloudImages(status: string | null) {
      return new Response(JSON.stringify({ RequestId: 'mock-request', TotalCount: status ? 1 : 0, PageNumber: 1, PageSize: 100,
        Images: { Image: status ? [{ ImageId: 'm-existing', ImageName: 'existing', Status: status }] : [] } }), { status: 200 });
    }

    it.each(['Available', 'Deleting'])('disables only the scoped assets before checking an accepted deletion still reported as %s', async status => {
      await repository.setPlatformImageAssetEnabled(assetId, true);
      const retained = await ledgers();
      await repository.upsertImageSnapshots({ provider: account.provider, accountUid: 'foreign-account', regionId: account.defaultRegion, scope: 'custom', snapshots: [{ imageId: 'm-existing', sourceImageName: 'foreign', status: 'Available', isAvailable: true, lastSyncedAt: new Date() }] });
      const foreignSource = (await repository.listImageSnapshots({ accountUid: 'foreign-account', imageId: 'm-existing' }))[0];
      const foreignAsset = await repository.collectPlatformImageAsset({ snapshotId: foreignSource.id, displayName: 'foreign image' });
      let accepted = false;
      fetchMock.mockImplementation(async input => {
        const params = new URL(String(input)).searchParams;
        if (params.get('Action') === 'DeleteImage') {
          accepted = true;
          return new Response(JSON.stringify({ RequestId: 'delete-accepted' }), { status: 200 });
        }
        if (accepted && params.has('ImageId')) {
          expect(await repository.getImageSnapshotById(sourceId)).toMatchObject({ status: 'Deleting', isAvailable: false });
          expect(await repository.getPlatformImageAssetById(assetId)).toMatchObject({ enabled: false });
        }
        return cloudImages(accepted && params.has('ImageId') ? status : 'Available');
      });
      await expect(service.deleteCustomSnapshot(sourceId, {}, admin)).rejects.toThrow('删除尚未确认');
      expect(await repository.getPlatformImageAssetById(assetId)).toMatchObject({ sourceSnapshotId: sourceId, enabled: false, ownerUserId: owner.id, defaultHostName: 'private-host' });
      expect(await repository.getPlatformImageAssetById(foreignAsset.id)).toMatchObject({ enabled: true });
      expect(await repository.listBillingLedgerResources()).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: retained.image.id, releasedAt: null }),
        expect.objectContaining({ id: retained.snapshot.id, releasedAt: null }),
      ]));
      await expect(service.setPlatformAssetEnabled(assetId, true, owner)).rejects.toThrow('来源镜像不可用');
      await expect(service.collectPlatformAsset(sourceId, 'retry', admin)).rejects.toThrow('不可用');
      await service.syncCustomImages();
      expect(await repository.getImageSnapshotById(sourceId)).toMatchObject({ status: 'Deleting', isAvailable: false });
      expect(await repository.getPlatformImageAssetById(assetId)).toMatchObject({ enabled: false });
    });

    it.each([503, 200])('keeps the available source, enabled asset and ledgers if DeleteImage fails at status %s', async status => {
      await repository.setPlatformImageAssetEnabled(assetId, true);
      const retained = await ledgers();
      fetchMock.mockImplementation(async input => new URL(String(input)).searchParams.get('Action') === 'DeleteImage'
        ? new Response(JSON.stringify({ Code: 'OperationDenied', Message: 'fixture denial' }), { status })
        : cloudImages('Available'));
      await expect(service.deleteCustomSnapshot(sourceId, {}, admin)).rejects.toThrow();
      expect(await repository.getImageSnapshotById(sourceId)).toMatchObject({ status: 'Available', isAvailable: true });
      expect(await repository.getPlatformImageAssetById(assetId)).toMatchObject({ enabled: true });
      expect(await repository.listBillingLedgerResources()).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: retained.image.id, releasedAt: null }),
        expect.objectContaining({ id: retained.snapshot.id, releasedAt: null }),
      ]));
    });

    it('keeps an accepted deletion unavailable if its confirmation read fails', async () => {
      await repository.setPlatformImageAssetEnabled(assetId, true);
      const retained = await ledgers();
      let accepted = false;
      fetchMock.mockImplementation(async input => {
        if (new URL(String(input)).searchParams.get('Action') === 'DeleteImage') {
          accepted = true;
          return new Response(JSON.stringify({ RequestId: 'accepted' }), { status: 200 });
        }
        if (accepted) throw new Error('confirmation unavailable');
        return cloudImages('Available');
      });
      await expect(service.deleteCustomSnapshot(sourceId, {}, admin)).rejects.toThrow();
      expect(await repository.getImageSnapshotById(sourceId)).toMatchObject({ status: 'Deleting', isAvailable: false });
      expect(await repository.getPlatformImageAssetById(assetId)).toMatchObject({ enabled: false });
      expect((await repository.listBillingLedgerResources()).find(item => item.id === retained.image.id)!.releasedAt).toBeNull();
    });

    it.each([true, false])('releases only the matching image ledger after absence is confirmed (initially present=%s)', async initiallyPresent => {
      const retained = await ledgers();
      const foreign = await repository.createBillingLedgerResource({ cloudAccountUid: 'foreign-account', regionId: account.defaultRegion, cloudResourceId: 'm-existing', cloudResourceType: 'image', billingScope: 'platform', billingStartAt: new Date(), tagsSnapshot: {} });
      let exists = initiallyPresent;
      fetchMock.mockImplementation(async input => {
        if (new URL(String(input)).searchParams.get('Action') === 'DeleteImage') {
          exists = false;
          return new Response(JSON.stringify({ RequestId: 'accepted' }), { status: 200 });
        }
        return cloudImages(exists ? 'Available' : null);
      });
      await expect(service.deleteCustomSnapshot(sourceId, {}, admin)).resolves.toEqual({ removed: true, snapshotId: sourceId });
      expect(await repository.getImageSnapshotById(sourceId)).toMatchObject({ status: 'Deleted', isAvailable: false });
      expect(await repository.getPlatformImageAssetById(assetId)).toBeNull();
      const rows = await repository.listBillingLedgerResources();
      expect(rows.find(item => item.id === retained.image.id)!.releasedAt?.getTime()).toBeGreaterThan(0);
      expect(rows.find(item => item.id === retained.snapshot.id)!.releasedAt).toBeNull();
      expect(rows.find(item => item.id === foreign.id)!.releasedAt).toBeNull();
      expect(fetchMock.mock.calls.filter(([url]) => new URL(String(url)).searchParams.get('Action') === 'DeleteImage')).toHaveLength(initiallyPresent ? 1 : 0);
    });
  });
});
