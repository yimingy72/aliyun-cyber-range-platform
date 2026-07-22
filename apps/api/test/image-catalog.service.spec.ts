import type { AdminRepository, PlatformImageAssetRecord } from '../src/admin/admin.repository';
import { ImageCatalogService } from '../src/admin/image-catalog.service';
import { SystemConfigService } from '../src/admin/system-config.service';

const OWNER = { id: 'owner-1', username: 'owner', role: 'user' as const };

function createAsset(): PlatformImageAssetRecord {
  const now = new Date('2026-07-20T00:00:00.000Z');

  return {
    id: 'asset-1',
    provider: 'alibaba_cloud',
    accountUid: '1234567890',
    accountScopeKey: '1234567890',
    regionId: 'cn-hangzhou',
    sourceScope: 'custom',
    sourceSnapshotId: 'snapshot-1',
    imageId: 'm-importing-image',
    displayName: 'Importing Ubuntu',
    defaultHostName: null,
    defaultPassword: null,
    description: null,
    ownerUserId: OWNER.id,
    visibility: 'private',
    enabled: false,
    createdAt: now,
    updatedAt: now,
  };
}

describe('ImageCatalogService import operation guard', () => {
  function createService() {
    const asset = createAsset();
    const snapshot = {
      id: 'snapshot-1',
      provider: 'alibaba_cloud' as const,
      accountUid: '1234567890',
      accountScopeKey: '1234567890',
      regionId: 'cn-hangzhou',
      scope: 'custom' as const,
      imageId: 'm-importing-image',
      sourceImageName: 'Importing Ubuntu',
      osType: 'linux',
      platform: 'Ubuntu',
      architecture: 'x86_64',
      status: 'Creating',
      isAvailable: false,
      lastSyncedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const adminRepositoryMock = {
      getPlatformImageAssetById: jest.fn().mockResolvedValue(asset),
      getImageSnapshotById: jest.fn().mockResolvedValue(snapshot),
      hasActiveImageImportForArtifact: jest.fn().mockResolvedValue(true),
      updatePlatformImageAsset: jest.fn().mockResolvedValue(asset),
      collectPlatformImageAsset: jest.fn().mockResolvedValue(asset),
      setPlatformImageAssetEnabled: jest.fn().mockResolvedValue(asset),
      deletePlatformImageAsset: jest.fn(),
      getPlatformUserById: jest.fn().mockResolvedValue({ id: OWNER.id, username: OWNER.username }),
      listPlatformImageAssets: jest.fn().mockResolvedValue([]),
      listRangeInstances: jest.fn().mockResolvedValue([]),
      listRangeTemplates: jest.fn().mockResolvedValue([]),
      listBillingLedgerResources: jest.fn().mockResolvedValue([]),
      deletePlatformImageAssetsBySnapshotId: jest.fn(),
      listImageSnapshots: jest.fn().mockResolvedValue([snapshot]),
      reconcileImageSnapshots: jest.fn(),
    };
    const systemConfigServiceMock = {
      getAccountContext: jest.fn().mockResolvedValue({
        provider: 'alibaba_cloud',
        accountUid: '1234567890',
        defaultRegion: 'cn-hangzhou',
      }),
    };
    const service = new ImageCatalogService(
      adminRepositoryMock as unknown as AdminRepository,
      systemConfigServiceMock as unknown as SystemConfigService,
    );

    return { service, adminRepositoryMock, asset };
  }

  it('rejects enable and disable requests while the asset belongs to an active import', async () => {
    const { service, adminRepositoryMock } = createService();

    await expect(service.setPlatformAssetEnabled('asset-1', true, OWNER)).rejects.toThrow('正在导入');

    expect(adminRepositoryMock.hasActiveImageImportForArtifact).toHaveBeenCalledWith({
      platformImageAssetId: 'asset-1',
      sourceSnapshotId: 'snapshot-1',
      imageId: 'm-importing-image',
    });
    expect(adminRepositoryMock.setPlatformImageAssetEnabled).not.toHaveBeenCalled();
  });

  it('rejects asset operations when an active import has only persisted its Alibaba Cloud ImageId', async () => {
    const { service, adminRepositoryMock } = createService();
    adminRepositoryMock.hasActiveImageImportForArtifact.mockImplementation(async (input) => input.imageId === 'm-importing-image');

    await expect(service.setPlatformAssetEnabled('asset-1', true, OWNER)).rejects.toThrow('正在导入');

    expect(adminRepositoryMock.hasActiveImageImportForArtifact).toHaveBeenCalledWith(
      expect.objectContaining({ imageId: 'm-importing-image' }),
    );
    expect(adminRepositoryMock.setPlatformImageAssetEnabled).not.toHaveBeenCalled();
  });

  it('rejects asset deletion while the asset belongs to an active import', async () => {
    const { service, adminRepositoryMock } = createService();

    await expect(service.removePlatformAsset('asset-1', OWNER)).rejects.toThrow('正在导入');

    expect(adminRepositoryMock.deletePlatformImageAsset).not.toHaveBeenCalled();
  });

  it('rejects custom image deletion while its import is still active', async () => {
    const { service, adminRepositoryMock } = createService();

    await expect(service.deleteCustomSnapshot('snapshot-1')).rejects.toThrow('正在导入');

    expect(adminRepositoryMock.deletePlatformImageAssetsBySnapshotId).not.toHaveBeenCalled();
  });

  it('rejects returning an image to private while a published topology references it', async () => {
    const { service, adminRepositoryMock, asset } = createService();
    asset.visibility = 'platform';
    asset.enabled = true;
    adminRepositoryMock.hasActiveImageImportForArtifact.mockResolvedValue(false);
    adminRepositoryMock.listRangeTemplates.mockResolvedValue([
      {
        id: 'template-1',
        name: '已发布攻防拓扑',
        visibility: 'platform',
        currentPublishedVersionId: 'published-1',
        currentPublishedVersion: {
          scenarioTemplateSpec: {
            hosts: [{ key: 'ecs-1', platformImageAssetId: asset.id, imageId: asset.imageId }],
          },
        },
      },
    ]);

    await expect(
      service.updatePlatformAsset('asset-1', { visibility: 'private' }, OWNER),
    ).rejects.toThrow('已发布');

    expect(adminRepositoryMock.collectPlatformImageAsset).not.toHaveBeenCalled();
  });

  it('rejects disabling an image while a published topology references it', async () => {
    const { service, adminRepositoryMock, asset } = createService();
    asset.visibility = 'platform';
    asset.enabled = true;
    adminRepositoryMock.hasActiveImageImportForArtifact.mockResolvedValue(false);
    adminRepositoryMock.listRangeTemplates.mockResolvedValue([
      {
        id: 'template-1',
        name: '已发布攻防拓扑',
        visibility: 'platform',
        currentPublishedVersionId: 'published-1',
        currentPublishedVersion: {
          compiledProvisionSpec: {
            hosts: [{ key: 'ecs-1', platformImageAssetId: asset.id, imageId: asset.imageId }],
          },
        },
      },
    ]);

    await expect(service.setPlatformAssetEnabled('asset-1', false, OWNER)).rejects.toThrow('已发布');

    expect(adminRepositoryMock.setPlatformImageAssetEnabled).not.toHaveBeenCalled();
  });

  it('rejects deleting an image while a published topology references it', async () => {
    const { service, adminRepositoryMock, asset } = createService();
    asset.visibility = 'platform';
    asset.enabled = true;
    adminRepositoryMock.hasActiveImageImportForArtifact.mockResolvedValue(false);
    adminRepositoryMock.listRangeTemplates.mockResolvedValue([
      {
        id: 'template-1',
        name: '已发布攻防拓扑',
        visibility: 'platform',
        currentPublishedVersionId: 'published-1',
        currentPublishedVersion: {
          compiledSpec: {
            resources: [
              {
                id: 'ecs-1',
                type: 'host',
                config: { platformImageAssetId: asset.id, imageId: asset.imageId },
              },
            ],
          },
        },
      },
    ]);

    await expect(service.removePlatformAsset('asset-1', OWNER)).rejects.toThrow('已发布');

    expect(adminRepositoryMock.deletePlatformImageAsset).not.toHaveBeenCalled();
  });
});
