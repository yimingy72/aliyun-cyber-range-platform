import { createMemoryAdminRepository } from './support/create-memory-admin-repository';

describe('Admin image catalog platform asset persistence baseline', () => {
  it('collects a platform image asset once per provider account scope region and image', async () => {
    const repository = createMemoryAdminRepository();

    await repository.reconcileImageSnapshots({
      provider: 'alibaba_cloud',
      accountUid: '1234567890',
      regionId: 'cn-hangzhou',
      scope: 'public',
      snapshots: [
        {
          imageId: 'ubuntu_24_04_x64_20G_alibase_20250618.vhd',
          sourceImageName: 'Ubuntu 24.04',
          status: 'Available',
          isAvailable: true,
          lastSyncedAt: new Date('2026-07-06T00:00:00.000Z'),
        },
      ],
    });

    const [publicSnapshot] = await repository.listImageSnapshots({
      provider: 'alibaba_cloud',
      accountUid: '1234567890',
      regionId: 'cn-hangzhou',
      scope: 'public',
    });

    const platformAssetRepository = repository as typeof repository & {
      collectPlatformImageAsset: (input: {
        snapshotId: string;
        displayName: string;
      }) => Promise<{ id: string }>;
      listPlatformImageAssets: (filter: {
        accountScopeKey: string;
        regionId: string;
      }) => Promise<
        Array<{
          imageId: string;
          displayName: string;
          enabled: boolean;
          sourceScope: string;
        }>
      >;
    };

    const firstAsset = await platformAssetRepository.collectPlatformImageAsset({
      snapshotId: publicSnapshot.id,
      displayName: 'Ubuntu 24.04',
    });

    const secondAsset = await platformAssetRepository.collectPlatformImageAsset({
      snapshotId: publicSnapshot.id,
      displayName: 'Ubuntu 24.04',
    });

    expect(secondAsset.id).toBe(firstAsset.id);

    const assets = await platformAssetRepository.listPlatformImageAssets({
      accountScopeKey: 'aliyun::1234567890',
      regionId: 'cn-hangzhou',
    });

    expect(assets).toHaveLength(1);
    expect(assets[0]).toEqual(
      expect.objectContaining({
        imageId: publicSnapshot.imageId,
        displayName: 'Ubuntu 24.04',
        enabled: true,
        sourceScope: 'public',
      }),
    );
  });
});
