import { BadGatewayException, BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { getCurrentCloudWorkspaceScope } from '../auth/cloud-workspace-scope';

import {
  ADMIN_REPOSITORY,
  type AdminRepository,
  type CloudImageScope,
  type CloudImageSnapshotRecord,
  type ImageCatalogItemRecord,
  type PlatformImageAssetRecord,
  type PlatformImageTagRecord,
  type UpsertImageSnapshotInput,
} from './admin.repository';
import type { SessionUserProfile } from './admin-user-auth';
import { attachOwnerUsernamesAsCreatedBy } from './creator-display';
import type { PlatformImageView, UpdatePlatformImageDto } from './dto/platform-image.dto';
import type { DeleteCustomImageDto } from './dto/image-catalog.dto';
import type { CreatePlatformImageTagDto, SetPlatformImageTagsDto } from './dto/platform-image-tag.dto';
import { imageRpc, cloudItems, cloudPage } from './aliyun-image-rpc';
import { aliyunImageMinimumSystemDiskSize, readAliyunImageSystemDisk } from './aliyun-image-capacity';
import { PackedImagesService } from './packed-images.service';
import { SystemConfigService } from './system-config.service';
import { deleteTencentImage, describeTencentImages } from './tencent-image-rpc';

type ImageCatalogScopePayload = {
  snapshots: Array<
    Pick<
      CloudImageSnapshotRecord,
      'id' | 'provider' | 'scope' | 'imageId' | 'sourceImageName' | 'platform' | 'architecture' | 'minimumSystemDiskSize' | 'status' | 'isAvailable'
    > & { ownedSnapshotCleanup?: { snapshotCount: number; status: 'ready' | 'deleting' } }
  >;
  catalogItems: Array<
    Pick<ImageCatalogItemRecord, 'id' | 'displayName' | 'imageId' | 'scope' | 'enabled' | 'sourceSnapshotId'>
  >;
};

type PlatformImageTagView = Pick<PlatformImageTagRecord, 'id' | 'name'>;
type PlatformImageAssetView = Omit<PlatformImageAssetRecord, 'defaultPassword' | 'tags'> & {
  tags: PlatformImageTagView[];
  createdBy?: string;
  canManage?: boolean;
  canChangeVisibility?: boolean;
};
type PlatformImageAssetsPayload = {
  items: Array<
    PlatformImageAssetView & {
      createdBy: string;
      osType?: string | null;
      platform?: string | null;
      sourceSnapshotStatus: string | null;
      sourceSnapshotAvailable: boolean | null;
      minimumSystemDiskSize: number | null;
      canManage: boolean;
      canChangeVisibility: boolean;
    }
  >;
};

type AliyunDescribeImagesResponse = {
  Images?: {
    Image?: AliyunImage[] | AliyunImage;
  };
  TotalCount?: number | string;
  PageNumber?: number | string;
  PageSize?: number | string;
};

type AliyunImage = {
  ImageId?: string;
  ImageName?: string;
  OSType?: string;
  Platform?: string;
  Architecture?: string;
  Status?: string;
  Progress?: string;
  Size?: number;
  DiskDeviceMappings?: {
    DiskDeviceMapping?: Array<{ SnapshotId?: string; Type?: string; Size?: string }> | { SnapshotId?: string; Type?: string; Size?: string };
  };
};

const ALICLOUD_PAGE_SIZE = 100;

function containsImageReference(
  value: unknown,
  platformImageAssetIds: ReadonlySet<string>,
  imageIds: ReadonlySet<string>,
) {
  const seen = new WeakSet<object>();

  const visit = (current: unknown): boolean => {
    if (typeof current === 'string') {
      return platformImageAssetIds.has(current) || imageIds.has(current);
    }

    if (!current || typeof current !== 'object') {
      return false;
    }

    if (seen.has(current)) {
      return false;
    }
    seen.add(current);

    if (Array.isArray(current)) {
      return current.some((item) => visit(item));
    }

    return Object.values(current).some((item) => visit(item));
  };

  return visit(value);
}

@Injectable()
export class ImageCatalogService {
  constructor(
    @Inject(ADMIN_REPOSITORY) private readonly adminRepository: AdminRepository,
    private readonly systemConfigService: SystemConfigService,
    @Optional() private readonly packedImages?: PackedImagesService,
  ) {}

  listPublic() {
    return this.listScope('public');
  }

  listCustom() {
    return this.listScope('custom');
  }

  syncPublicImages() {
    return this.syncScope('public', 'system');
  }

  syncCustomImages() {
    return this.syncScope('custom', 'self');
  }

  private selectedContext() {
    return typeof this.systemConfigService.getSelectedAccountContext === 'function'
      ? this.systemConfigService.getSelectedAccountContext() : this.systemConfigService.getAccountContext();
  }

  async listPlatformAssets(
    currentUser: SessionUserProfile,
    view: PlatformImageView = 'platform',
  ): Promise<PlatformImageAssetsPayload> {
    const accountContext = await this.selectedContext();
    const workspace = getCurrentCloudWorkspaceScope();
    const historical = workspace && !('system' in workspace) && workspace.isReadOnly;
    const baseFilter = {
      ...(historical ? {} : { provider: accountContext.provider,
        ...(workspace && !('system' in workspace) ? {} : { accountUid: accountContext.accountUid }), regionId: accountContext.defaultRegion }),
      ...(view === 'platform' ? { visibility: 'platform' as const } : { ownerUserId: currentUser.id }),
    };

    const items = await this.adminRepository.listPlatformImageAssets({
      ...baseFilter,
      ...(view === 'platform' && currentUser.role !== 'admin' ? { onlyAvailableSourceSnapshots: true } : {}),
    });

    const itemsWithCreatedBy = await attachOwnerUsernamesAsCreatedBy(this.adminRepository, items);
    const sourceSnapshots = await Promise.all(
      [...new Set(items.map((item) => item.sourceSnapshotId).filter((value): value is string => Boolean(value)))].map(
        async (snapshotId) => [snapshotId, await this.adminRepository.getImageSnapshotById(snapshotId)] as const,
      ),
    );
    const sourceSnapshotsById = new Map(sourceSnapshots);
    const liveCapacities = new Map<string, number>();
    if (!historical && accountContext.provider === 'alibaba_cloud' && accountContext.accountUidResolved) {
      for (const item of items) {
        const snapshot = item.sourceSnapshotId ? sourceSnapshotsById.get(item.sourceSnapshotId) : null;
        if (!item.enabled || !snapshot?.isAvailable || snapshot.minimumSystemDiskSize != null
          || item.accountUid !== accountContext.accountUid || item.regionId !== accountContext.defaultRegion) continue;
        try { liveCapacities.set(item.imageId, (await readAliyunImageSystemDisk(accountContext, item.imageId)).minimumSystemDiskSize); }
        catch { /* Keep the catalog readable; launch still requires fresh capacity verification. */ }
      }
    }

    return {
      items: itemsWithCreatedBy.map((item) => {
        const snapshot = item.sourceSnapshotId ? sourceSnapshotsById.get(item.sourceSnapshotId) ?? null : null;
        const assetView = this.toPlatformImageAssetView(item, currentUser, view);

        return {
          ...assetView,
          createdBy: assetView.createdBy ?? 'admin',
          canManage: assetView.canManage ?? false,
          canChangeVisibility: assetView.canChangeVisibility ?? false,
          osType: snapshot?.osType ?? null,
          platform: snapshot?.platform ?? null,
          sourceSnapshotStatus: snapshot?.status ?? null,
          sourceSnapshotAvailable: snapshot?.isAvailable ?? null,
          architecture: snapshot?.architecture ?? null,
          minimumSystemDiskSize: liveCapacities.get(item.imageId) ?? snapshot?.minimumSystemDiskSize ?? null,
        };
      }),
    };
  }

  async listPlatformImageTags() {
    const tags = await this.adminRepository.listPlatformImageTags();

    return {
      items: tags.map((tag) => this.toPlatformImageTagView(tag)),
    };
  }

  async preparePlatformImageTagCreation(input: CreatePlatformImageTagDto, currentUser: SessionUserProfile) {
    if (currentUser.role !== 'admin') {
      throw new ForbiddenException('Admin access required to create platform image tags');
    }

    const name = input.name.trim();
    const normalizedName = this.normalizePlatformImageTagName(name);
    const existingTags = await this.adminRepository.listPlatformImageTags();

    if (existingTags.some((tag) => tag.normalizedName === normalizedName)) {
      throw new ConflictException('镜像标签已存在');
    }
    return { name, normalizedName };
  }

  async createPlatformImageTag(input: CreatePlatformImageTagDto, currentUser: SessionUserProfile) {
    const { name, normalizedName } = await this.preparePlatformImageTagCreation(input, currentUser);

    try {
      const tag = await this.adminRepository.createPlatformImageTag({
        name,
        normalizedName,
        createdByUserId: currentUser.id,
      });
      return this.toPlatformImageTagView(tag);
    } catch (error) {
      if (this.isPlatformImageTagUniqueViolation(error)) {
        throw new ConflictException('镜像标签已存在');
      }

      throw error;
    }
  }

  async preparePlatformImageTagDeletion(id: string, currentUser: SessionUserProfile) {
    if (currentUser.role !== 'admin') throw new ForbiddenException('Admin access required to delete platform image tags');
    const [tag] = await this.adminRepository.listPlatformImageTagsByIds([id]);
    if (!tag) throw new NotFoundException('镜像标签不存在');
    return this.toPlatformImageTagView(tag);
  }

  async deletePlatformImageTag(id: string, currentUser: SessionUserProfile) {
    await this.preparePlatformImageTagDeletion(id, currentUser);
    if (!await this.adminRepository.deletePlatformImageTag(id)) throw new NotFoundException('镜像标签不存在');
    return { removed: true, platformImageTagId: id };
  }

  private async prepareTagAssociation(id: string, input: SetPlatformImageTagsDto, currentUser: SessionUserProfile) {
    const asset = await this.getScopedPlatformAssetOrThrow(id, currentUser);
    const tagIds = [...new Set(input.tagIds)];
    const tags = await this.adminRepository.listPlatformImageTagsByIds(tagIds);

    if (tags.length !== tagIds.length) {
      throw new BadRequestException('镜像标签不存在');
    }
    return { asset, tagIds };
  }

  async preparePlatformAssetTags(id: string, input: SetPlatformImageTagsDto, currentUser: SessionUserProfile) {
    const { asset, tagIds } = await this.prepareTagAssociation(id, input, currentUser);
    return { platformImageAssetId: asset.id, displayName: asset.displayName, ownerUserId: asset.ownerUserId, accountUid: asset.accountUid, regionId: asset.regionId, tagIds };
  }

  async setPlatformAssetTags(id: string, input: SetPlatformImageTagsDto, currentUser: SessionUserProfile) {
    const { tagIds } = await this.prepareTagAssociation(id, input, currentUser);

    try {
      const updatedAsset = await this.adminRepository.replacePlatformImageAssetTags(id, tagIds);
      return this.withCreatorUsername(updatedAsset, currentUser);
    } catch (error) {
      // Deletion may win after validation; the nested write rolls back instead of leaving partial tags.
      if (error && typeof error === 'object' && 'code' in error && ['P2003', 'P2025'].includes(String(error.code))) {
        throw new ConflictException('镜像或标签已被删除，请刷新后重新设置标签');
      }
      throw error;
    }
  }

  async collectPlatformAsset(snapshotId: string, displayName: string, currentUser: SessionUserProfile, visibility: 'private' | 'platform' = 'platform') {
    if (currentUser.role !== 'admin') throw new ForbiddenException('Admin access required');
    return this.collectAvailableAsset(snapshotId, displayName, currentUser, visibility);
  }

  collectMogongAsset(snapshotId: string, displayName: string, currentUser: SessionUserProfile) {
    return this.collectAvailableAsset(snapshotId, displayName, currentUser, 'platform');
  }

  private async collectAvailableAsset(snapshotId: string, displayName: string, currentUser: SessionUserProfile, visibility: 'private' | 'platform') {
    const snapshot = await this.adminRepository.getImageSnapshotById(snapshotId);

    if (!snapshot) {
      throw new NotFoundException('Image snapshot not found');
    }

    const accountContext = await this.selectedContext();

    if (!this.isSnapshotInScope(snapshot, accountContext)) {
      throw new NotFoundException('Image snapshot not found');
    }

    if (!snapshot.isAvailable || snapshot.status === 'Missing' || await this.adminRepository.hasActiveImageImportForArtifact({ sourceSnapshotId: snapshot.id, imageId: snapshot.imageId }) || await this.packedImages?.hasPending({ imageId: snapshot.imageId, sourceSnapshotId: snapshot.id })) throw new ConflictException('来源镜像尚不可用或正在处理，不能收录。');
    const [existing] = await this.adminRepository.listPlatformImageAssets({ provider: snapshot.provider, accountUid: snapshot.accountUid, regionId: snapshot.regionId, imageId: snapshot.imageId });
    if (existing) {
      if (existing.visibility === 'private' && existing.ownerUserId !== currentUser.id) throw new NotFoundException('Image snapshot not found');
      return this.withCreatorUsername(existing, currentUser);
    }
    const [packed] = await this.adminRepository.listPackedImageArtifacts({ imageId: snapshot.imageId, cloudAccountUid: snapshot.accountUid ?? undefined, regionId: snapshot.regionId });
    if (packed && packed.status !== 'deleted') {
      if (packed.ownerUserId !== currentUser.id) throw new NotFoundException('Image snapshot not found');
      if (visibility === 'private') throw new ConflictException('请先按原打包来源恢复镜像资产。');
      if (!this.packedImages) throw new ConflictException('打包来源恢复服务不可用，请稍后重试。');
      const asset = await this.packedImages.restoreAsset(packed.id, snapshotId, displayName);
      return this.withCreatorUsername(asset, currentUser);
    }
    const asset = await this.adminRepository.collectPlatformImageAsset({
      preserveExisting: true,
      snapshotId,
      displayName,
      ownerUserId: visibility === 'private' ? currentUser.id : null,
      visibility,
    });
    // Catalog inclusion is not resource creation and must not claim external image or snapshot costs.
    return this.withCreatorUsername(asset, currentUser);
  }

  async updatePlatformAsset(id: string, input: UpdatePlatformImageDto, currentUser: SessionUserProfile) {
    const asset = await this.getScopedPlatformAssetOrThrow(id, currentUser);
    const visibility = input.visibility;
    if (input.displayName === undefined && visibility === undefined) {
      throw new BadRequestException('At least one platform image update field is required');
    }

    if (visibility !== undefined) {
      if (!asset.ownerUserId) throw new BadRequestException('没有个人归属的目录镜像不能发布或回退。');
      if (visibility === 'platform') {
        if (asset.ownerUserId !== currentUser.id) throw new ForbiddenException('仅镜像所有者可以发布。');
        await this.assertPlatformAssetNotImporting(asset);
        const source = await this.resolvePlatformAssetSnapshot(asset);
        if (!asset.enabled || !source?.isAvailable) throw new ConflictException('来源镜像不可用，不能发布。');
      } else if (asset.visibility === 'platform') {
        await this.assertPlatformAssetNotReferencedByPublishedTemplates(asset);
      }
    }

    try {
      const updated = await this.adminRepository.updatePlatformImageAsset(id, {
        displayName: input.displayName ?? asset.displayName,
        ...(visibility !== undefined ? { visibility } : {}),
      }, { ownerUserId: asset.ownerUserId, visibility: asset.visibility });
      return this.withCreatorUsername(updated, currentUser);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'P2025') {
        throw new ConflictException('镜像的归属或发布状态已变化，请刷新后重试。');
      }
      throw error;
    }
  }

  // Legacy catalog removal never deletes a cloud resource.
  async removePlatformAsset(id: string, currentUser: SessionUserProfile): Promise<void> {
    const asset = await this.getScopedPlatformAssetOrThrow(id, currentUser);
    if (asset.ownerUserId && (asset.ownerUserId !== currentUser.id || asset.sourceScope !== 'public')) {
      throw new ForbiddenException('用户镜像请在“我的镜像”删除，或从平台回退为私有。');
    }
    await this.assertPlatformAssetNotImporting(asset);
    await this.assertPlatformAssetNotReferencedByPublishedTemplates(asset);
    await this.adminRepository.deletePlatformImageAsset(id);
  }

  async prepareOwnedImageDeletion(id: string, currentUser: SessionUserProfile) {
    const asset = await this.getScopedPlatformAssetOrThrow(id, currentUser);
    if (asset.ownerUserId !== currentUser.id) throw new ForbiddenException('只能删除自己创建的云镜像。');
    const snapshot = asset.sourceSnapshotId && await this.adminRepository.getImageSnapshotById(asset.sourceSnapshotId);
    const account = await this.selectedContext();
    if (!snapshot || snapshot.scope !== 'custom' || snapshot.imageId !== asset.imageId ||
      !account.accountUidResolved || !account.accountUid || !this.isSnapshotInScope(snapshot, account)) {
      throw new ConflictException('无法核对该镜像的云账号或来源，未执行云端删除。');
    }
    await this.assertPlatformAssetNotImporting(asset);
    const packedOwner = await this.readPackedImageOwner(snapshot, asset.id);
    const importOwner = await this.adminRepository.findImageImportOwner(snapshot, asset.id);
    if ([packedOwner, importOwner].some(owner => owner && owner !== currentUser.id) ||
      (packedOwner !== currentUser.id && importOwner !== currentUser.id)) {
      throw new ForbiddenException('仅支持删除来源可核验的本人导入或打包镜像。');
    }
    await this.assertCustomSnapshotNotInUse(snapshot, currentUser);
    return { asset, snapshot, account };
  }

  async deleteOwnedImage(id: string, currentUser: SessionUserProfile) {
    const { snapshot, account } = await this.prepareOwnedImageDeletion(id, currentUser);
    return this.deleteCloudImage(snapshot, account);
  }

  private async readPackedImageOwner(snapshot: CloudImageSnapshotRecord, assetId?: string) {
    const artifacts = await this.adminRepository.listPackedImageArtifacts({ sourceSnapshotId: snapshot.id });
    return artifacts.find(artifact => artifact.imageId === snapshot.imageId && artifact.cloudAccountUid === snapshot.accountUid &&
      artifact.regionId === snapshot.regionId && (artifact.cloudProvider ?? 'alibaba_cloud') === snapshot.provider &&
      (!assetId || artifact.platformImageAssetId === assetId))?.ownerUserId ?? null;
  }

  async collectFromSnapshot(snapshotId: string, displayName: string) {
    const snapshot = await this.adminRepository.getImageSnapshotById(snapshotId);

    if (!snapshot) {
      throw new NotFoundException('Image snapshot not found');
    }

    return this.adminRepository.collectImageCatalogItem({
      displayName,
      imageId: snapshot.imageId,
      provider: snapshot.provider,
      scope: snapshot.scope,
      accountUid: snapshot.accountUid,
      regionId: snapshot.regionId,
      sourceSnapshotId: snapshot.id,
      enabled: true,
    });
  }

  async prepareCustomDelete(snapshotId: string, currentUser: SessionUserProfile, deleteOwnedSnapshots: boolean) {
    const snapshot = await this.adminRepository.getImageSnapshotById(snapshotId);
    if (!snapshot || snapshot.scope !== 'custom') throw new NotFoundException('Image snapshot not found');
    if (deleteOwnedSnapshots) {
      const [artifact] = await this.adminRepository.listPackedImageArtifacts({ sourceSnapshotId: snapshotId });
      if (!artifact || artifact.cloudAccountUid !== snapshot.accountUid || artifact.regionId !== snapshot.regionId || artifact.imageId !== snapshot.imageId
        || (currentUser.role !== 'admin' && artifact.ownerUserId !== currentUser.id)) throw new ForbiddenException('仅 owner 或管理员可完整回收已验证的平台打包镜像。');
    } else {
      if (currentUser.role !== 'admin') throw new ForbiddenException('仅管理员可删除云镜像；owner 请显式选择完整打包回收。');
      const account = await this.selectedContext();
      if (!this.isSnapshotInScope(snapshot, account)) throw new NotFoundException('Image snapshot not found');
    }
    await this.assertCustomSnapshotNotInUse(snapshot, currentUser);
    return { imageId: snapshot.imageId, snapshotId, cloudAccountUid: snapshot.accountUid, regionId: snapshot.regionId };
  }

  async deleteCustomSnapshot(snapshotId: string, options: DeleteCustomImageDto = {}, currentUser?: SessionUserProfile) {
    const snapshot = await this.adminRepository.getImageSnapshotById(snapshotId);

    if (!snapshot) {
      throw new NotFoundException('Image snapshot not found');
    }

    if (snapshot.scope !== 'custom') {
      throw new BadRequestException('Only custom image snapshots can be deleted');
    }

    if (options.deleteOwnedSnapshots) {
      if (!currentUser || !this.packedImages) throw new ForbiddenException('完整回收需要已认证 owner 和打包来源记录。');
      await this.prepareCustomDelete(snapshotId, currentUser, true);
      await this.assertCustomSnapshotNotInUse(snapshot, currentUser);
      return this.packedImages.cleanup(snapshotId, currentUser);
    }
    if (currentUser && currentUser.role !== 'admin') throw new ForbiddenException('仅管理员可删除云镜像；owner 请显式选择完整打包回收。');

    const accountContext = await this.selectedContext();

    if (
      snapshot.provider !== accountContext.provider ||
      snapshot.regionId !== accountContext.defaultRegion ||
      snapshot.accountUid !== accountContext.accountUid
    ) {
      throw new NotFoundException('Image snapshot not found');
    }

    await this.assertCustomSnapshotNotInUse(snapshot, currentUser);
    await this.assertImageSnapshotNotImporting(snapshot);
    return this.deleteCloudImage(snapshot, accountContext);
  }

  private async deleteCloudImage(snapshot: CloudImageSnapshotRecord, accountContext: Awaited<ReturnType<ImageCatalogService['selectedContext']>>) {
    if (await this.describeImageById(snapshot.imageId, accountContext)) {
      if (accountContext.provider === 'tencent_cloud') {
        await deleteTencentImage(this.tencentCredentials(accountContext), snapshot.imageId);
      } else {
      await this.performAliyunRpcRequest({
        accessKeyId: accountContext.accessKeyId,
        accessKeySecret: accountContext.accessKeySecret,
        regionId: accountContext.defaultRegion,
        action: 'DeleteImage',
        parameters: {
          ImageId: snapshot.imageId,
          Force: 'false',
        },
      });
      }
      await this.adminRepository.upsertImageSnapshots({
        provider: snapshot.provider, accountUid: snapshot.accountUid, regionId: snapshot.regionId, scope: 'custom',
        snapshots: [{ imageId: snapshot.imageId, sourceImageName: snapshot.sourceImageName,
          osType: snapshot.osType, platform: snapshot.platform, architecture: snapshot.architecture,
          status: 'Deleting', isAvailable: false, lastSyncedAt: new Date() }],
      });
      const assets = await this.adminRepository.listPlatformImageAssets({
        provider: snapshot.provider, accountUid: snapshot.accountUid, regionId: snapshot.regionId, imageId: snapshot.imageId,
      });
      await Promise.all(assets.map(asset => this.adminRepository.setPlatformImageAssetEnabled(asset.id, false)));
    }
    if (await this.describeImageById(snapshot.imageId, accountContext)) throw new ConflictException('云镜像删除尚未确认，请用相同目标重试。');

    // ponytail: O(n) ledger scan is fine for now; add a dedicated repository query once image billing volume grows.
    const ledgerResources = await this.adminRepository.listBillingLedgerResources();
    await Promise.all(
      ledgerResources
        .filter(
          (item) =>
            item.cloudResourceId === snapshot.imageId &&
            item.cloudAccountUid === snapshot.accountUid && item.regionId === snapshot.regionId &&
            item.cloudResourceType === 'image' &&
            item.releasedAt === null,
        )
        .map((item) =>
          this.adminRepository.updateBillingLedgerResource(item.id, {
            releasedAt: new Date(),
          }),
        ),
    );

    await this.adminRepository.deletePlatformImageAssetsBySnapshotId(snapshot.id);

    await this.adminRepository.upsertImageSnapshots({
      provider: snapshot.provider,
      accountUid: snapshot.accountUid,
      regionId: snapshot.regionId,
      scope: 'custom',
      snapshots: [{ imageId: snapshot.imageId, sourceImageName: snapshot.sourceImageName, status: 'Deleted', isAvailable: false, lastSyncedAt: new Date() }],
    });
    return { removed: true, snapshotId: snapshot.id };
  }

  private async listScope(scope: CloudImageScope): Promise<ImageCatalogScopePayload> {
    const accountContext = await this.selectedContext();
    const workspace = getCurrentCloudWorkspaceScope();
    const placement = workspace && !('system' in workspace) && workspace.isReadOnly ? {}
      : { provider: accountContext.provider, ...(workspace && !('system' in workspace) ? {} : { accountUid: accountContext.accountUid }), regionId: accountContext.defaultRegion };

    const [snapshots, catalogItems, packedArtifacts] = await Promise.all([
      this.adminRepository.listImageSnapshots({
        ...placement,
        scope,
      }),
      this.adminRepository.listImageCatalogItems({
        ...placement,
        scope,
      }),
      scope === 'custom' ? this.adminRepository.listPackedImageArtifacts() : Promise.resolve([]),
    ]);
    const cleanupBySnapshot = new Map(packedArtifacts.filter(artifact =>
      artifact.cloudAccountUid === accountContext.accountUid && artifact.regionId === accountContext.defaultRegion
      && artifact.sourceSnapshotId && ['available', 'failed', 'deleting'].includes(artifact.status)
      && artifact.backingSnapshotIds.length > 0 && artifact.backingSnapshotIds.length === artifact.sourceDiskIds.length,
    ).map(artifact => [artifact.sourceSnapshotId, artifact]));

    return {
      snapshots: snapshots.filter(snapshot => snapshot.status !== 'Deleted' || cleanupBySnapshot.get(snapshot.id)?.imageId === snapshot.imageId).map((snapshot) => ({
        id: snapshot.id,
        provider: snapshot.provider,
        scope: snapshot.scope,
        imageId: snapshot.imageId,
        sourceImageName: snapshot.sourceImageName,
        platform: snapshot.platform,
        architecture: snapshot.architecture,
        minimumSystemDiskSize: snapshot.minimumSystemDiskSize,
        status: snapshot.status,
        isAvailable: snapshot.isAvailable,
        ...(cleanupBySnapshot.get(snapshot.id)?.imageId === snapshot.imageId ? {
          ownedSnapshotCleanup: {
            snapshotCount: cleanupBySnapshot.get(snapshot.id)!.backingSnapshotIds.length - cleanupBySnapshot.get(snapshot.id)!.deletedSnapshotIds.length,
            status: cleanupBySnapshot.get(snapshot.id)!.status === 'deleting' ? 'deleting' as const : 'ready' as const,
          },
        } : {}),
      })),
      catalogItems: catalogItems.map((item) => ({
        id: item.id,
        displayName: item.displayName,
        imageId: item.imageId,
        scope: item.scope,
        enabled: item.enabled,
        sourceSnapshotId: item.sourceSnapshotId,
      })),
    };
  }

  private async getScopedPlatformAssetOrThrow(
    id: string,
    currentUser: SessionUserProfile,
  ): Promise<PlatformImageAssetRecord> {
    const asset = await this.adminRepository.getPlatformImageAssetById(id);
    const accountContext = await this.selectedContext();

    if (
      !asset ||
      !this.isPlatformAssetInScope(asset, accountContext) ||
      (asset.ownerUserId !== currentUser.id && (currentUser.role !== 'admin' || asset.visibility !== 'platform'))
    ) {
      throw new NotFoundException('Platform image asset not found');
    }

    return asset;
  }

  private async assertPlatformAssetNotImporting(asset: PlatformImageAssetRecord) {
    const importing = await this.adminRepository.hasActiveImageImportForArtifact({
      platformImageAssetId: asset.id,
      sourceSnapshotId: asset.sourceSnapshotId,
      imageId: asset.imageId,
    });

    if (importing || await this.packedImages?.hasPending({ platformImageAssetId: asset.id, sourceSnapshotId: asset.sourceSnapshotId, imageId: asset.imageId })) {
      throw new ConflictException('镜像正在导入、打包或清理，完成前不能修改启用状态或删除。');
    }
  }

  private async assertImageSnapshotNotImporting(snapshot: CloudImageSnapshotRecord) {
    const importing = await this.adminRepository.hasActiveImageImportForArtifact({
      sourceSnapshotId: snapshot.id,
      imageId: snapshot.imageId,
    });

    if (importing || await this.packedImages?.hasPending({ sourceSnapshotId: snapshot.id, imageId: snapshot.imageId })) {
      throw new ConflictException('镜像正在导入、打包或清理，完成前不能删除。');
    }
  }

  private async assertPlatformAssetNotReferencedByPublishedTemplates(asset: PlatformImageAssetRecord) {
    const templates = await this.adminRepository.listRangeTemplates();
    const publishedTemplates = templates.filter(
      (template) => template.visibility === 'platform' && Boolean(template.currentPublishedVersionId),
    );
    const publishedSnapshots = await Promise.all(
      publishedTemplates.map(async (template) => ({
        template,
        snapshot:
          template.currentPublishedVersion ??
          (template.currentPublishedVersionId
            ? await this.adminRepository.getRangeTemplateVersionById(template.currentPublishedVersionId)
            : null),
      })),
    );
    const assetIds = new Set([asset.id]);
    const imageIds = new Set([asset.imageId]);
    const referencingTemplates = publishedSnapshots
      .filter(({ snapshot }) => containsImageReference(snapshot, assetIds, imageIds))
      .map(({ template }) => template);

    if (referencingTemplates.length === 0) {
      return;
    }

    const names = referencingTemplates
      .slice(0, 3)
      .map((template) => `“${template.name?.trim() || template.slug}”`)
      .join('、');
    const omitted = referencingTemplates.length - 3;
    const suffix = omitted > 0 ? `等 ${referencingTemplates.length} 个拓扑` : '';

    throw new ConflictException(
      `镜像仍被已发布拓扑${names}${suffix}引用，请先将相关拓扑回退为私有并替换镜像。`,
    );
  }

  private async withCreatorUsername(asset: PlatformImageAssetRecord, currentUser?: SessionUserProfile) {
    const [normalizedAsset] = await attachOwnerUsernamesAsCreatedBy(this.adminRepository, [asset]);
    return this.toPlatformImageAssetView(normalizedAsset, currentUser);
  }

  private toPlatformImageAssetView(
    asset: PlatformImageAssetRecord & { createdBy?: string },
    currentUser?: SessionUserProfile,
    listView?: PlatformImageView,
  ): PlatformImageAssetView {
    const { defaultPassword: _defaultPassword, tags, ...view } = asset;
    const tagViews = tags.map((tag) => this.toPlatformImageTagView(tag));

    if (!currentUser) {
      return {
        ...view,
        tags: tagViews,
      };
    }

    const owned = asset.ownerUserId === currentUser.id;
    const moderator = currentUser.role === 'admin' && asset.visibility === 'platform';
    const canManage = listView === 'platform' ? moderator : owned || moderator;

    return {
      ...view,
      tags: tagViews,
      canManage,
      canChangeVisibility: canManage && Boolean(asset.ownerUserId),
    };
  }

  private toPlatformImageTagView(tag: PlatformImageTagRecord): PlatformImageTagView {
    return {
      id: tag.id,
      name: tag.name,
    };
  }

  private normalizePlatformImageTagName(name: string) {
    return name.normalize('NFKC').toLocaleLowerCase();
  }

  private isPlatformImageTagUniqueViolation(error: unknown) {
    return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'P2002';
  }

  private async resolvePlatformAssetSnapshot(asset: PlatformImageAssetRecord): Promise<CloudImageSnapshotRecord | null> {
    if (asset.sourceSnapshotId) {
      const sourceSnapshot = await this.adminRepository.getImageSnapshotById(asset.sourceSnapshotId);

      if (sourceSnapshot) {
        return sourceSnapshot;
      }
    }

    const [matchingSnapshot] = await this.adminRepository.listImageSnapshots({
      provider: asset.provider,
      accountUid: asset.accountUid,
      regionId: asset.regionId,
      scope: asset.sourceScope,
      imageId: asset.imageId,
    });

    return matchingSnapshot ?? null;
  }

  private async assertCustomSnapshotNotInUse(snapshot: CloudImageSnapshotRecord, currentUser?: SessionUserProfile) {
    const assets = await this.adminRepository.listPlatformImageAssets({
      provider: snapshot.provider,
      accountUid: snapshot.accountUid,
      regionId: snapshot.regionId,
      sourceSnapshotId: snapshot.id,
    });
    const assetIds = new Set(assets.map((asset) => asset.id));
    const imageIds = new Set([snapshot.imageId]);

    const instances = await this.adminRepository.listRangeInstances();
    const sourceVersions = await Promise.all(instances.map((instance) =>
      instance.status !== 'destroyed' && !instance.singleInstanceConfig &&
      !instance.runtimeScenarioTemplateSpec && !instance.runtimeCompiledProvisionSpec && instance.sourceTemplateVersionId
        ? this.adminRepository.getRangeTemplateVersionById(instance.sourceTemplateVersionId) : null,
    ));
    const instanceBasis = new Map<string, string[]>();
    const referencingInstances = instances.filter((instance, index) => {
      if (instance.status === 'destroyed') {
        return false;
      }

      const singleInstanceConfig = instance.singleInstanceConfig;
      const basis = [
        ...((singleInstanceConfig?.platformImageAssetId && assetIds.has(singleInstanceConfig.platformImageAssetId)) ||
          (singleInstanceConfig?.imageId && imageIds.has(singleInstanceConfig.imageId)) ? ['single-instance'] : []),
        ...(containsImageReference(instance.runtimeScenarioTemplateSpec, assetIds, imageIds) ||
          containsImageReference(instance.runtimeCompiledProvisionSpec, assetIds, imageIds) ? ['runtime'] : []),
        ...(containsImageReference(instance.draftScenarioTemplateSpec, assetIds, imageIds) ||
          containsImageReference(instance.draftCompiledProvisionSpec, assetIds, imageIds) ? ['draft'] : []),
        ...(containsImageReference(instance.resourceSummary, assetIds, imageIds) ? ['resource-summary'] : []),
        ...(containsImageReference(sourceVersions[index], assetIds, imageIds) ? ['unfrozen-source-version'] : []),
      ];
      if (basis.length > 0) instanceBasis.set(instance.id, basis);
      return basis.length > 0;
    });

    const templates = await this.adminRepository.listRangeTemplates();
    const referencingTemplates: typeof templates = [];
    const templateBasis = new Map<string, string[]>();
    for (const template of templates) {
      const draft = template.currentDraftVersion ?? (template.currentDraftVersionId
        ? await this.adminRepository.getRangeTemplateVersionById(template.currentDraftVersionId) : null);
      const published = template.currentPublishedVersion ?? (template.currentPublishedVersionId
        ? await this.adminRepository.getRangeTemplateVersionById(template.currentPublishedVersionId) : null);
      // Owners consume the current draft; other users consume the current public version, never historical versions.
      const consumedVersions = [{ version: draft ?? published,
        basis: draft ? 'current-draft' : published
          ? template.visibility === 'platform' ? 'current-publication' : 'published-fallback' : 'legacy-current' }];
      if (template.visibility === 'platform' && published && draft) consumedVersions.push({ version: published, basis: 'current-publication' });
      const basis = consumedVersions.filter(({ version }) => [
        version?.topologySpec ?? template.topologySpec,
        version?.topologyGraph ?? template.topologyGraph,
        version?.scenarioTemplateSpec ?? template.scenarioTemplateSpec,
        version?.compiledProvisionSpec ?? template.compiledProvisionSpec,
        version?.compiledSpec ?? template.compiledSpec,
      ].some((value) => containsImageReference(value, assetIds, imageIds))).map(({ basis }) => basis);
      if (basis.length > 0) {
        referencingTemplates.push(template);
        templateBasis.set(template.id, basis);
      }
    }

    if (referencingInstances.length === 0 && referencingTemplates.length === 0) {
      return;
    }

    const references = [
      ...referencingInstances.slice(0, 3).map((instance) => `实例“${instance.name}”`),
      ...referencingTemplates.slice(0, 3).map((template) => `模板“${template.name}”`),
    ];
    const omitted = referencingInstances.length + referencingTemplates.length - references.length;
    const suffix = omitted > 0 ? ` 等 ${omitted + references.length} 个引用` : '';
    const remedies = [
      ...(referencingTemplates.length > 0
        ? ['请在相关模板中替换镜像并检测保存；若已发布版本仍引用，还需重新发布或回退为私有。'] : []),
      ...(referencingInstances.length > 0
        ? ['请替换相关实例运行或草稿中的镜像并应用变更，或销毁相关实例。'] : []),
    ];

    throw new BadRequestException({
      statusCode: 400,
      error: 'Bad Request',
      message: `镜像仍被${references.join('、')}${suffix}引用。${remedies.join('')}完成后再删除云端自定义镜像。`,
      ...(currentUser?.role === 'admin' ? { references: [
        ...referencingInstances.map((instance) => ({ kind: 'instance', id: instance.id, name: instance.name,
          ownerId: instance.ownerUserId, basis: instanceBasis.get(instance.id) })),
        ...referencingTemplates.map((template) => ({ kind: 'template', id: template.id, name: template.name,
          ownerId: template.ownerUserId, basis: templateBasis.get(template.id) })),
      ] } : {}),
    });
  }

  private isSnapshotInScope(
    snapshot: CloudImageSnapshotRecord,
    accountContext: {
      provider: string;
      accountUid: string | null;
      defaultRegion: string;
    },
  ) {
    return (
      snapshot.provider === accountContext.provider &&
      snapshot.accountUid === accountContext.accountUid &&
      snapshot.regionId === accountContext.defaultRegion
    );
  }

  private isPlatformAssetInScope(
    asset: PlatformImageAssetRecord,
    accountContext: {
      provider: string;
      accountUid: string | null;
      defaultRegion: string;
    },
  ) {
    return (
      asset.provider === accountContext.provider &&
      asset.accountUid === accountContext.accountUid &&
      asset.regionId === accountContext.defaultRegion
    );
  }

  private async syncScope(
    scope: CloudImageScope,
    imageOwnerAlias: 'system' | 'self',
  ): Promise<ImageCatalogScopePayload> {
    const accountContext = await this.selectedContext();
    if (accountContext.provider === 'tencent_cloud') {
      const images = await describeTencentImages(this.tencentCredentials(accountContext), { scope });
      await this.adminRepository.reconcileImageSnapshots({ provider: accountContext.provider, accountUid: accountContext.accountUid,
        regionId: accountContext.defaultRegion, scope, snapshots: images.map(image => ({ imageId: image.ImageId,
          sourceImageName: image.ImageName, osType: image.OSType, platform: image.Platform, architecture: image.Architecture,
          minimumSystemDiskSize: image.ImageSize, status: image.Status, isAvailable: image.Status === 'Available', lastSyncedAt: new Date() })) });
      return this.listScope(scope);
    }
    const lastSyncedAt = new Date();
    const snapshots: UpsertImageSnapshotInput[] = [];

    let pageNumber = 1;
    let totalCount = 0;
    let expectedTotal: number | undefined;

    do {
      const response = await this.describeImagesPage({
        accessKeyId: accountContext.accessKeyId,
        accessKeySecret: accountContext.accessKeySecret,
        regionId: accountContext.defaultRegion,
        imageOwnerAlias,
        pageNumber,
      });

      snapshots.push(
        ...this.normalizeImages(response).map((image) => ({
          imageId: image.ImageId ?? '',
          sourceImageName: image.ImageName ?? image.ImageId ?? '',
          osType: image.OSType ?? null,
          platform: image.Platform ?? null,
          architecture: image.Architecture ?? null,
          minimumSystemDiskSize: aliyunImageMinimumSystemDiskSize({ ...image, DiskDeviceMappings: {
            DiskDeviceMapping: Array.isArray(image.DiskDeviceMappings?.DiskDeviceMapping) ? image.DiskDeviceMappings.DiskDeviceMapping : image.DiskDeviceMappings?.DiskDeviceMapping ? [image.DiskDeviceMappings.DiskDeviceMapping] : [],
          } }),
          status: this.buildSnapshotStatus(image),
          isAvailable: image.Status === 'Available',
          lastSyncedAt,
        })),
      );

      totalCount = cloudPage(response, pageNumber, ALICLOUD_PAGE_SIZE, this.normalizeImages(response).length);
      if (expectedTotal !== undefined && expectedTotal !== totalCount) throw new Error('Cloud image list changed during pagination; cached sources were retained');
      expectedTotal = totalCount;
      if (!Number.isSafeInteger(totalCount) || totalCount < 0 || (!this.normalizeImages(response).length && snapshots.length < totalCount)) throw new Error('Invalid image catalog pagination; cached sources were retained');
      pageNumber += 1;
    } while ((pageNumber - 1) * ALICLOUD_PAGE_SIZE < totalCount);

    if (snapshots.length !== totalCount || new Set(snapshots.map(item => item.imageId)).size !== snapshots.length || snapshots.some(item => !item.imageId || !item.status)) throw new Error('Incomplete image catalog result; cached sources were retained');
    await this.adminRepository.reconcileImageSnapshots({
      provider: accountContext.provider,
      accountUid: accountContext.accountUid,
      regionId: accountContext.defaultRegion,
      scope,
      snapshots: snapshots.filter((snapshot) => snapshot.imageId),
    });

    return this.listScope(scope);
  }

  private async describeImagesPage(input: {
    accessKeyId: string;
    accessKeySecret: string;
    regionId: string;
    imageOwnerAlias: 'system' | 'self';
    pageNumber: number;
  }): Promise<AliyunDescribeImagesResponse> {
    return this.performAliyunRpcRequest<AliyunDescribeImagesResponse>({
      accessKeyId: input.accessKeyId,
      accessKeySecret: input.accessKeySecret,
      regionId: input.regionId,
      action: 'DescribeImages',
      parameters: {
        ImageOwnerAlias: input.imageOwnerAlias,
        PageNumber: String(input.pageNumber),
        PageSize: String(ALICLOUD_PAGE_SIZE),
        Status: 'ALL',
      },
    });
  }

  private async describeImageById(
    imageId: string,
    accountContext: Awaited<ReturnType<SystemConfigService['getSelectedAccountContext']>>,
  ) {
    if (accountContext.provider === 'tencent_cloud') {
      return (await describeTencentImages(this.tencentCredentials(accountContext), { ImageId: imageId }))[0] ?? null;
    }
    const response = await this.performAliyunRpcRequest<AliyunDescribeImagesResponse>({
      accessKeyId: accountContext.accessKeyId,
      accessKeySecret: accountContext.accessKeySecret,
      regionId: accountContext.defaultRegion,
      action: 'DescribeImages',
      parameters: {
        ImageId: imageId,
        Status: 'ALL',
        PageNumber: '1',
        PageSize: '100',
      },
    });

    const items = this.normalizeImages(response);
    if (cloudPage(response, 1, 100, items.length) !== items.length || items.length > 1 || items.some(item => item.ImageId !== imageId || !item.Status)) throw new Error('Invalid exact image query');
    return items[0] ?? null;
  }

  private tencentCredentials(account: Awaited<ReturnType<SystemConfigService['getSelectedAccountContext']>>) {
    if (account.provider !== 'tencent_cloud' || !account.accountUidResolved || !account.accountUid || !account.cloudAccountContextId) {
      throw new BadRequestException('腾讯云镜像操作缺少已验证账号配置。');
    }
    return { provider: account.provider, id: account.cloudAccountContextId, accountUid: account.accountUid,
      regionId: account.defaultRegion, accessKeyId: account.accessKeyId, accessKeySecret: account.accessKeySecret };
  }

  private async performAliyunRpcRequest<ResponsePayload>(input: {
    accessKeyId: string;
    accessKeySecret: string;
    regionId: string;
    action: string;
    parameters?: Record<string, string>;
  }): Promise<ResponsePayload> {
    return imageRpc<ResponsePayload>({ accessKeyId: input.accessKeyId, accessKeySecret: input.accessKeySecret, regionId: input.regionId }, input.action, input.parameters);
  }

  private normalizeImages(response: AliyunDescribeImagesResponse) {
    const items = cloudItems<AliyunImage>(response, 'Images', 'Image');
    if (items.some(item => typeof item.ImageId !== 'string' || !item.ImageId.trim() || typeof item.Status !== 'string' || !item.Status.trim())) throw new BadGatewayException('Invalid cloud image identity/status');
    return items;
  }

  private buildSnapshotStatus(image: AliyunImage) {
    const status = image.Status?.trim();
    const progress = image.Progress?.trim();

    if (!status) {
      return null;
    }

    if (progress && progress !== '100%' && status !== 'Available') {
      return `${status} ${progress}`;
    }

    return status;
  }

}
