import { toAccountScopeKey } from '../src/admin/image-account-scope';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';

describe('Admin image catalog platform asset persistence baseline', () => {
  it('collects a platform image asset once per provider account scope region and image', async () => {
    const repository = createMemoryAdminRepository();
    const accountUid = '1234567890';

    await repository.reconcileImageSnapshots({
      provider: 'alibaba_cloud',
      accountUid,
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
      accountUid,
      regionId: 'cn-hangzhou',
      scope: 'public',
    });

    const firstAsset = await repository.collectPlatformImageAsset({
      snapshotId: publicSnapshot.id,
      displayName: 'Ubuntu 24.04',
    });

    const secondAsset = await repository.collectPlatformImageAsset({
      snapshotId: publicSnapshot.id,
      displayName: 'Ubuntu 24.04',
    });

    expect(secondAsset.id).toBe(firstAsset.id);

    const assets = await repository.listPlatformImageAssets({
      accountScopeKey: toAccountScopeKey(accountUid),
      regionId: 'cn-hangzhou',
    });

    expect(assets).toHaveLength(1);
    expect(assets[0]).toEqual(
      expect.objectContaining({
        id: firstAsset.id,
        imageId: publicSnapshot.imageId,
        displayName: 'Ubuntu 24.04',
        enabled: true,
        sourceScope: 'public',
      }),
    );

    await repository.updatePlatformImageAsset(firstAsset.id, {
      displayName: 'Ubuntu 24.04 LTS',
    });

    await repository.setPlatformImageAssetEnabled(firstAsset.id, false);

    const updatedAssets = await repository.listPlatformImageAssets({
      accountScopeKey: toAccountScopeKey(accountUid),
      regionId: 'cn-hangzhou',
    });

    expect(updatedAssets).toHaveLength(1);
    expect(updatedAssets[0]).toEqual(
      expect.objectContaining({
        id: firstAsset.id,
        displayName: 'Ubuntu 24.04 LTS',
        enabled: false,
      }),
    );

    await repository.deletePlatformImageAsset(firstAsset.id);

    const assetsAfterDeletion = await repository.listPlatformImageAssets({
      accountScopeKey: toAccountScopeKey(accountUid),
      regionId: 'cn-hangzhou',
    });

    expect(assetsAfterDeletion).toHaveLength(0);
  });

  it('nulls sourceSnapshotId when the source snapshot is reconciled away', async () => {
    const repository = createMemoryAdminRepository();
    const accountUid = '1234567890';

    await repository.reconcileImageSnapshots({
      provider: 'alibaba_cloud',
      accountUid,
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

    const [snapshot] = await repository.listImageSnapshots({
      provider: 'alibaba_cloud',
      accountUid,
      regionId: 'cn-hangzhou',
      scope: 'public',
    });

    const asset = await repository.collectPlatformImageAsset({
      snapshotId: snapshot.id,
      displayName: 'Ubuntu 24.04',
    });

    await repository.reconcileImageSnapshots({
      provider: 'alibaba_cloud',
      accountUid,
      regionId: 'cn-hangzhou',
      scope: 'public',
      snapshots: [],
    });

    const [remainingAsset] = await repository.listPlatformImageAssets({
      accountScopeKey: toAccountScopeKey(accountUid),
      regionId: 'cn-hangzhou',
    });

    expect(remainingAsset).toEqual(
      expect.objectContaining({
        id: asset.id,
        sourceSnapshotId: null,
      }),
    );
  });

  it('throws not-found errors for missing platform image asset ids', async () => {
    const repository = createMemoryAdminRepository();

    await expect(
      repository.updatePlatformImageAsset('missing-asset-id', {
        displayName: 'Ubuntu 24.04 LTS',
      }),
    ).rejects.toThrow(/not found/i);

    await expect(repository.setPlatformImageAssetEnabled('missing-asset-id', false)).rejects.toThrow(/not found/i);

    await expect(repository.deletePlatformImageAsset('missing-asset-id')).rejects.toThrow(/not found/i);
  });
});
