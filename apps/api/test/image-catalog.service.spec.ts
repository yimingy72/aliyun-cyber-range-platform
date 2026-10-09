import type { AdminRepository, PlatformImageAssetRecord } from '../src/admin/admin.repository';
import { ImageCatalogService } from '../src/admin/image-catalog.service';
import type { PackedImagesService } from '../src/admin/packed-images.service';
import { SystemConfigService } from '../src/admin/system-config.service';

const OWNER = { id: 'owner-1', username: 'owner', role: 'user' as const };
const ADMIN = { id: 'admin-1', username: 'admin', role: 'admin' as const };
const originalFetch = global.fetch;

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
    tags: [],
    createdAt: now,
    updatedAt: now,
  };
}

describe('ImageCatalogService import operation guard', () => {
  function createService(packedImages?: PackedImagesService) {
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
      listPackedImageArtifacts: jest.fn().mockResolvedValue([]),
      listRangeInstances: jest.fn().mockResolvedValue([]),
      listRangeTemplates: jest.fn().mockResolvedValue([]),
      getRangeTemplateVersionById: jest.fn().mockResolvedValue(null),
      listBillingLedgerResources: jest.fn().mockResolvedValue([]),
      findBillingLedgerResource: jest.fn().mockResolvedValue(null),
      createBillingLedgerResource: jest.fn().mockImplementation(async (input) => ({ id: `ledger-${input.cloudResourceType}`, ...input })),
      updateBillingLedgerResource: jest.fn(),
      deletePlatformImageAssetsBySnapshotId: jest.fn(),
      listImageSnapshots: jest.fn().mockResolvedValue([snapshot]),
      reconcileImageSnapshots: jest.fn(),
      upsertImageSnapshots: jest.fn(),
    };
    const systemConfigServiceMock = {
      getAccountContext: jest.fn().mockResolvedValue({
        provider: 'alibaba_cloud',
        accountUid: '1234567890',
        defaultRegion: 'cn-hangzhou',
        accessKeyId: 'test-access-key',
        accessKeySecret: 'test-access-secret',
      }),
    };
    const service = new ImageCatalogService(
      adminRepositoryMock as unknown as AdminRepository,
      systemConfigServiceMock as unknown as SystemConfigService,
      packedImages,
    );

    return { service, adminRepositoryMock, asset, snapshot };
  }

  afterEach(() => {
    global.fetch = originalFetch;
  });

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

  it('collects an external cloud image without claiming its resources or fees', async () => {
    const { service, adminRepositoryMock, snapshot } = createService();
    snapshot.status = 'Available'; snapshot.isAvailable = true;
    adminRepositoryMock.hasActiveImageImportForArtifact.mockResolvedValue(false);
    global.fetch = jest.fn();

    await service.collectPlatformAsset('snapshot-1', 'Platform Ubuntu', ADMIN);

    expect(adminRepositoryMock.collectPlatformImageAsset).toHaveBeenCalledWith({
      preserveExisting: true, snapshotId: 'snapshot-1', displayName: 'Platform Ubuntu', ownerUserId: null, visibility: 'platform',
    });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(adminRepositoryMock.createBillingLedgerResource).not.toHaveBeenCalled();
    expect(adminRepositoryMock.updateBillingLedgerResource).not.toHaveBeenCalled();
  });

  it('keeps existing import billing ownership and release evidence when recollecting', async () => {
    const { service, adminRepositoryMock, snapshot } = createService();
    snapshot.status = 'Available'; snapshot.isAvailable = true;
    adminRepositoryMock.hasActiveImageImportForArtifact.mockResolvedValue(false);
    adminRepositoryMock.findBillingLedgerResource.mockResolvedValue({
      id: 'ledger-import', cloudAccountUid: snapshot.accountUid, ownerUserId: OWNER.id,
      releasedAt: new Date('2026-09-01'), tagsSnapshot: { PlatformImageImportJobId: 'original-import' },
    });
    global.fetch = jest.fn();

    await service.collectPlatformAsset('snapshot-1', 'Recollected Ubuntu', ADMIN);

    expect(global.fetch).not.toHaveBeenCalled();
    expect(adminRepositoryMock.createBillingLedgerResource).not.toHaveBeenCalled();
    expect(adminRepositoryMock.updateBillingLedgerResource).not.toHaveBeenCalled();
  });

  it('returns server-side image capabilities for an ordinary owner', async () => {
    const { service, adminRepositoryMock, asset } = createService();
    adminRepositoryMock.listPlatformImageAssets.mockResolvedValue([asset]);

    const result = await (
      service as unknown as {
        listPlatformAssets(currentUser: typeof OWNER, view: 'mine'): Promise<{ items: Record<string, unknown>[] }>;
      }
    ).listPlatformAssets(OWNER, 'mine');

    expect(adminRepositoryMock.listPlatformImageAssets).toHaveBeenCalledWith(
      expect.objectContaining({ ownerUserId: OWNER.id }),
    );
    expect(result.items).toEqual([
      expect.objectContaining({
        id: asset.id,
        canManage: true,
        canChangeVisibility: false,
      }),
    ]);
  });

  it('rejects an ordinary owner changing image visibility through the generic update route', async () => {
    const { service, adminRepositoryMock } = createService();
    adminRepositoryMock.hasActiveImageImportForArtifact.mockResolvedValue(false);

    await expect(
      service.updatePlatformAsset('asset-1', { visibility: 'platform' }, OWNER),
    ).rejects.toThrow('Admin access required');

    expect(adminRepositoryMock.collectPlatformImageAsset).not.toHaveBeenCalled();
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

  it('removes only the platform directory entry while preserving its cloud image and snapshots', async () => {
    const { service, adminRepositoryMock } = createService();
    adminRepositoryMock.hasActiveImageImportForArtifact.mockResolvedValue(false);
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });

    await service.removePlatformAsset('asset-1', OWNER);

    expect(global.fetch).not.toHaveBeenCalled();
    expect(adminRepositoryMock.deletePlatformImageAsset).toHaveBeenCalledWith('asset-1');
    expect(adminRepositoryMock.deletePlatformImageAssetsBySnapshotId).not.toHaveBeenCalled();
  });

  it('removes a custom asset whose re-synced snapshot is not linked back to that asset', async () => {
    const { service, adminRepositoryMock, asset } = createService();
    asset.sourceSnapshotId = null;
    adminRepositoryMock.hasActiveImageImportForArtifact.mockResolvedValue(false);
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });

    await service.removePlatformAsset('asset-1', OWNER);

    expect(adminRepositoryMock.deletePlatformImageAssetsBySnapshotId).not.toHaveBeenCalled();
    expect(adminRepositoryMock.deletePlatformImageAsset).toHaveBeenCalledWith('asset-1');
  });

  it('removes an unreferenced custom asset when its cloud snapshot is already unavailable', async () => {
    const { service, adminRepositoryMock } = createService();
    adminRepositoryMock.hasActiveImageImportForArtifact.mockResolvedValue(false);
    adminRepositoryMock.getImageSnapshotById.mockResolvedValue(null);
    adminRepositoryMock.listImageSnapshots.mockResolvedValue([]);
    global.fetch = jest.fn();

    await expect(service.removePlatformAsset('asset-1', OWNER)).resolves.toBeUndefined();

    expect(adminRepositoryMock.deletePlatformImageAsset).toHaveBeenCalledWith('asset-1');
    expect(global.fetch).not.toHaveBeenCalled();
    expect(adminRepositoryMock.deletePlatformImageAssetsBySnapshotId).not.toHaveBeenCalled();
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
      service.updatePlatformAsset('asset-1', { visibility: 'private' }, ADMIN),
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

  function version(id: string, imageId: string) {
    return {
      id,
      topologySpec: {},
      topologyGraph: { nodes: [{ id: 'ecs-1', imageId }] },
      scenarioTemplateSpec: { hosts: [{ key: 'ecs-1', imageId }] },
      compiledProvisionSpec: { hosts: [{ key: 'ecs-1', imageId }] },
      compiledSpec: { resources: [{ id: 'ecs-1', config: { imageId } }] },
    };
  }

  function replacementTemplate(imageId: string) {
    const old = version('version-old', imageId);
    const current = version('version-current', 'm-replacement');
    return {
      ...old,
      id: 'template-1', name: 'test1-test1', ownerUserId: OWNER.id, visibility: 'private',
      currentDraftVersionId: current.id, currentDraftVersion: current,
      currentPublishedVersionId: old.id, currentPublishedVersion: old,
      versions: [old, current],
    };
  }

  function cloudDeleteMock() {
    let exists = true;
    global.fetch = jest.fn().mockImplementation(async (input) => {
      const action = new URL(String(input)).searchParams.get('Action');
      if (action === 'DeleteImage') {
        exists = false;
        return new Response('{}', { status: 200 });
      }
      return new Response(JSON.stringify({ TotalCount: exists ? 1 : 0, Images: {
        Image: exists ? [{ ImageId: 'm-importing-image', Status: 'Available' }] : [],
      } }), { status: 200 });
    });
  }

  it('allows cloud deletion after replacement when only old versions and stale top-level copies reference the image', async () => {
    const { service, adminRepositoryMock, snapshot } = createService();
    adminRepositoryMock.hasActiveImageImportForArtifact.mockResolvedValue(false);
    adminRepositoryMock.listRangeTemplates.mockResolvedValue([replacementTemplate(snapshot.imageId)]);
    adminRepositoryMock.listRangeInstances.mockResolvedValue([{ status: 'destroyed', runtimeScenarioTemplateSpec: version('runtime-old', snapshot.imageId) }]);
    cloudDeleteMock();

    await expect(service.prepareCustomDelete(snapshot.id, ADMIN, false)).resolves.toMatchObject({ imageId: snapshot.imageId });
    expect(global.fetch).not.toHaveBeenCalled();
    await expect(service.deleteCustomSnapshot(snapshot.id, {}, ADMIN)).resolves.toMatchObject({ removed: true });

    expect((global.fetch as jest.Mock).mock.calls.map(([input]) => new URL(String(input)).searchParams.get('Action')))
      .toEqual(['DescribeImages', 'DeleteImage', 'DescribeImages']);
    expect(adminRepositoryMock.deletePlatformImageAssetsBySnapshotId).toHaveBeenCalledWith(snapshot.id);
  });

  it('still protects the old public version while a new owner draft uses a replacement', async () => {
    const { service, adminRepositoryMock, snapshot } = createService();
    adminRepositoryMock.listRangeTemplates.mockResolvedValue([{ ...replacementTemplate(snapshot.imageId), visibility: 'platform' }]);
    cloudDeleteMock();

    await expect(service.deleteCustomSnapshot(snapshot.id, {}, ADMIN)).rejects.toThrow('重新发布或回退为私有');
    expect(global.fetch).not.toHaveBeenCalled();
    expect(adminRepositoryMock.deletePlatformImageAssetsBySnapshotId).not.toHaveBeenCalled();
  });

  it('protects a current private draft without telling users to destroy unrelated instances', async () => {
    const { service, adminRepositoryMock, snapshot } = createService();
    const template = replacementTemplate(snapshot.imageId);
    template.currentDraftVersion = version(template.currentDraftVersionId, snapshot.imageId);
    adminRepositoryMock.listRangeTemplates.mockResolvedValue([template]);
    cloudDeleteMock();

    const message = await service.deleteCustomSnapshot(snapshot.id, {}, ADMIN).then(() => '', (error: Error) => error.message);
    expect(message).toContain('模板“test1-test1”');
    expect(message).toContain('替换镜像并检测保存');
    expect(message).not.toContain('销毁相关实例');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('resolves the current version by ID when its relation is not included', async () => {
    const { service, adminRepositoryMock, snapshot } = createService();
    const template = replacementTemplate(snapshot.imageId);
    adminRepositoryMock.listRangeTemplates.mockResolvedValue([{ ...template, currentDraftVersion: null }]);
    adminRepositoryMock.getRangeTemplateVersionById.mockResolvedValue(version(template.currentDraftVersionId, snapshot.imageId));
    cloudDeleteMock();

    await expect(service.deleteCustomSnapshot(snapshot.id, {}, ADMIN)).rejects.toThrow('模板“test1-test1”');
    expect(adminRepositoryMock.getRangeTemplateVersionById).toHaveBeenCalledWith(template.currentDraftVersionId);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it.each(['scenarioTemplateSpec', 'compiledProvisionSpec', 'topologyGraph'])('protects the legacy %s fallback used by an incomplete current version', async (field) => {
    const { service, adminRepositoryMock, snapshot } = createService();
    const template = replacementTemplate(snapshot.imageId);
    adminRepositoryMock.listRangeTemplates.mockResolvedValue([{ ...template,
      currentDraftVersion: { ...template.currentDraftVersion, [field]: null },
    }]);
    cloudDeleteMock();

    await expect(service.deleteCustomSnapshot(snapshot.id, {}, ADMIN)).rejects.toThrow('模板“test1-test1”');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('protects a legacy template without current version pointers', async () => {
    const { service, adminRepositoryMock, snapshot } = createService();
    adminRepositoryMock.listRangeTemplates.mockResolvedValue([{ name: 'legacy', scenarioTemplateSpec: version('legacy', snapshot.imageId) }]);
    cloudDeleteMock();

    await expect(service.deleteCustomSnapshot(snapshot.id, {}, ADMIN)).rejects.toThrow('模板“legacy”');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('protects the private published fallback when there is no current owner draft', async () => {
    const { service, adminRepositoryMock, snapshot } = createService();
    adminRepositoryMock.listRangeTemplates.mockResolvedValue([{ ...replacementTemplate(snapshot.imageId), currentDraftVersion: null, currentDraftVersionId: null }]);
    cloudDeleteMock();

    await expect(service.deleteCustomSnapshot(snapshot.id, {}, ADMIN)).rejects.toThrow('模板“test1-test1”');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('still protects a live instance and gives an instance-specific remedy', async () => {
    const { service, adminRepositoryMock, snapshot } = createService();
    adminRepositoryMock.listRangeInstances.mockResolvedValue([{ name: 'running-test', status: 'running', runtimeScenarioTemplateSpec: version('runtime', snapshot.imageId) }]);
    cloudDeleteMock();

    const message = await service.deleteCustomSnapshot(snapshot.id, {}, ADMIN).then(() => '', (error: Error) => error.message);
    expect(message).toContain('实例“running-test”');
    expect(message).toContain('销毁相关实例');
    expect(message).not.toContain('检测保存');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('uses the same current-version guard for owned image and snapshot cleanup', async () => {
    const cleanup = jest.fn().mockResolvedValue({ removed: true, status: 'deleted' });
    const { service, adminRepositoryMock, snapshot } = createService({ cleanup } as unknown as PackedImagesService);
    adminRepositoryMock.listPackedImageArtifacts.mockResolvedValue([{
      cloudAccountUid: snapshot.accountUid, regionId: snapshot.regionId, imageId: snapshot.imageId, ownerUserId: OWNER.id,
    }]);
    const template = replacementTemplate(snapshot.imageId);
    adminRepositoryMock.listRangeTemplates.mockResolvedValue([template]);
    cloudDeleteMock();

    await expect(service.deleteCustomSnapshot(snapshot.id, { deleteOwnedSnapshots: true }, OWNER))
      .resolves.toMatchObject({ removed: true, status: 'deleted' });
    expect(cleanup).toHaveBeenCalledWith(snapshot.id, OWNER);

    template.currentDraftVersion = version(template.currentDraftVersionId, snapshot.imageId);
    await expect(service.deleteCustomSnapshot(snapshot.id, { deleteOwnedSnapshots: true }, OWNER)).rejects.toThrow('模板“test1-test1”');
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('protects an unfrozen legacy create/retry source version while allowing unrelated old sources after runtime replacement', async () => {
    const { service, adminRepositoryMock, snapshot } = createService();
    adminRepositoryMock.hasActiveImageImportForArtifact.mockResolvedValue(false);
    const legacy = { name: 'legacy-retry', status: 'create_failed', sourceTemplateVersionId: 'version-old' };
    adminRepositoryMock.listRangeInstances.mockResolvedValue([legacy]);
    adminRepositoryMock.getRangeTemplateVersionById.mockResolvedValue(version('version-old', snapshot.imageId));
    cloudDeleteMock();

    await expect(service.deleteCustomSnapshot(snapshot.id, {}, ADMIN)).rejects.toThrow('实例“legacy-retry”');
    expect(adminRepositoryMock.getRangeTemplateVersionById).toHaveBeenCalledWith('version-old');
    expect(global.fetch).not.toHaveBeenCalled();

    adminRepositoryMock.listRangeInstances.mockResolvedValue([{ ...legacy, status: 'running', runtimeScenarioTemplateSpec: version('current-runtime', 'm-replacement') }]);
    adminRepositoryMock.getRangeTemplateVersionById.mockClear();
    await expect(service.deleteCustomSnapshot(snapshot.id, {}, ADMIN)).resolves.toMatchObject({ removed: true });
    expect(adminRepositoryMock.getRangeTemplateVersionById).not.toHaveBeenCalled();
  });

  it('returns exact administrator reference details during preflight without invoking cloud or deletion', async () => {
    const { service, adminRepositoryMock, snapshot } = createService();
    const template = replacementTemplate(snapshot.imageId);
    template.currentDraftVersion = version(template.currentDraftVersionId, snapshot.imageId);
    adminRepositoryMock.listRangeTemplates.mockResolvedValue([template]);
    cloudDeleteMock();

    const response = await service.prepareCustomDelete(snapshot.id, ADMIN, false)
      .then(() => null, (error: { getResponse(): unknown }) => error.getResponse());
    expect(response).toMatchObject({ references: [{ kind: 'template', id: 'template-1', name: 'test1-test1', ownerId: OWNER.id, basis: ['current-draft'] }] });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(adminRepositoryMock.deletePlatformImageAssetsBySnapshotId).not.toHaveBeenCalled();
    expect(adminRepositoryMock.upsertImageSnapshots).not.toHaveBeenCalled();
  });

  it('keeps other private reference IDs and owner IDs out of an ordinary image owner preflight', async () => {
    const cleanup = jest.fn();
    const { service, adminRepositoryMock, snapshot } = createService({ cleanup } as unknown as PackedImagesService);
    adminRepositoryMock.listPackedImageArtifacts.mockResolvedValue([{
      cloudAccountUid: snapshot.accountUid, regionId: snapshot.regionId, imageId: snapshot.imageId, ownerUserId: OWNER.id,
    }]);
    const template = replacementTemplate(snapshot.imageId);
    template.currentDraftVersion = version(template.currentDraftVersionId, snapshot.imageId);
    adminRepositoryMock.listRangeTemplates.mockResolvedValue([template]);
    cloudDeleteMock();

    const response = await service.prepareCustomDelete(snapshot.id, OWNER, true)
      .then(() => null, (error: { getResponse(): unknown }) => error.getResponse());
    expect(response).toMatchObject({ message: expect.stringContaining('替换镜像并检测保存') });
    expect(response).not.toHaveProperty('references');
    expect(cleanup).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
