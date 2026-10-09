import { ImageCatalogService } from '../src/admin/image-catalog.service';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';
import { runInCloudWorkspace } from '../src/auth/cloud-workspace-scope';

const space = { cloudWorkspaceId: 'tencent-space', provider: 'tencent_cloud' as const, accountUid: '123', isReadOnly: false };
const context = { provider: 'tencent_cloud' as const, cloudAccountContextId: 'tencent-context', accountUid: '123', accountUidResolved: true,
  defaultRegion: 'ap-nanjing', defaultZoneId: 'ap-nanjing-1', accessKeyId: 'fixture-id', accessKeySecret: 'fixture-secret', imageImportBucket: '' };
const cloudImage = { ImageId: 'img-fixture', ImageName: 'Tencent Ubuntu', ImageType: 'PUBLIC_IMAGE', ImageState: 'NORMAL',
  Platform: 'Ubuntu', Architecture: 'x86_64', ImageSize: 50, SnapshotSet: [], Tags: [] };
const response = (images: unknown[]) => ({ ok: true, status: 200, json: async () => ({ Response: { RequestId: 'fixture-request', TotalCount: images.length, ImageSet: images } }) }) as Response;

describe('Tencent catalog within a cloud workspace', () => {
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; });
  const fixture = () => {
    const repository = createMemoryAdminRepository();
    const service = new ImageCatalogService(repository, { getSelectedAccountContext: async () => context } as never);
    return { repository, service };
  };
  it('syncs and collects source architecture and minimum disk without taking over external costs', async () => {
    const { repository, service } = fixture();
    global.fetch = jest.fn().mockResolvedValue(response([cloudImage]));
    await runInCloudWorkspace(space, async () => {
      const catalog = await service.syncPublicImages();
      expect(catalog.snapshots[0]).toMatchObject({ provider: 'tencent_cloud', minimumSystemDiskSize: 50, architecture: 'x86_64' });
      await service.collectPlatformAsset(catalog.snapshots[0].id, 'Tencent Ubuntu', { id: 'manager', username: 'manager', role: 'admin' });
      const assets = await service.listPlatformAssets({ id: 'manager', username: 'manager', role: 'admin' });
      expect(assets.items[0]).toMatchObject({ imageId: 'img-fixture', minimumSystemDiskSize: 50, architecture: 'x86_64' });
      expect(await repository.listBillingLedgerResources()).toHaveLength(0);
    });
  });
  it('retains the old source on malformed cloud inventory instead of pretending it disappeared', async () => {
    const { repository, service } = fixture();
    global.fetch = jest.fn().mockResolvedValueOnce(response([cloudImage])).mockResolvedValueOnce(response([cloudImage, cloudImage]));
    await runInCloudWorkspace(space, async () => {
      await service.syncPublicImages();
      await expect(service.syncPublicImages()).rejects.toThrow('重复');
      expect((await repository.listImageSnapshots({ scope: 'public' }))[0].isAvailable).toBe(true);
    });
  });
  it('keeps data in a different account isolated even if it uses the same cloud image ID', async () => {
    const { repository, service } = fixture();
    global.fetch = jest.fn().mockResolvedValue(response([cloudImage]));
    await runInCloudWorkspace(space, () => service.syncPublicImages());
    await runInCloudWorkspace({ ...space, cloudWorkspaceId: 'other-tencent', accountUid: '456' }, async () => {
      expect(await repository.listImageSnapshots({})).toHaveLength(0);
      expect(await repository.listPlatformImageAssets()).toHaveLength(0);
    });
  });
});
