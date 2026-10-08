import { BadGatewayException, BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';

import {
  ADMIN_REPOSITORY,
  type AdminRepository,
  type CloudImageScope,
  type CloudImageSnapshotRecord,
  type ImageCatalogItemRecord,
  type PlatformImageAssetRecord,
  type PlatformImageTagRecord,
  type ResourceVisibility,
  type UpsertImageSnapshotInput,
} from './admin.repository';
import type { SessionUserProfile } from './admin-user-auth';
import { attachOwnerUsernamesAsCreatedBy } from './creator-display';
import type { PlatformImageView, UpdatePlatformImageDto } from './dto/platform-image.dto';
import type { DeleteCustomImageDto } from './dto/image-catalog.dto';
import type { CreatePlatformImageTagDto, SetPlatformImageTagsDto } from './dto/platform-image-tag.dto';
import { buildAliyunTagParameters, buildBillingTags } from './billing-tagging';
import { imageRpc, cloudItems, cloudPage } from './aliyun-image-rpc';
import { PackedImagesService } from './packed-images.service';
import { SystemConfigService } from './system-config.service';

type ImageCatalogScopePayload = {
  snapshots: Array<
    Pick<
      CloudImageSnapshotRecord,
      'id' | 'provider' | 'scope' | 'imageId' | 'sourceImageName' | 'platform' | 'status' | 'isAvailable'
    >
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
      sourceSnapshotStatus: string | null;
      sourceSnapshotAvailable: boolean | null;
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
  DiskDeviceMappings?: {
    DiskDeviceMapping?: Array<{ SnapshotId?: string }> | { SnapshotId?: string };
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

function extractImageSnapshotIds(image: AliyunImage | null) {
  const mappings = image?.DiskDeviceMappings?.DiskDeviceMapping;
  const entries = Array.isArray(mappings) ? mappings : mappings ? [mappings] : [];
  return [...new Set(entries.map((entry) => entry.SnapshotId?.trim() ?? '').filter(Boolean))];
}

function buildAliyunArrayParameters(prefix: string, values: string[]) {
  return Object.fromEntries(values.map((value, index) => [`${prefix}.${index + 1}`, value]));
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

  async listPlatformAssets(
    currentUser: SessionUserProfile,
    view: PlatformImageView = 'platform',
  ): Promise<PlatformImageAssetsPayload> {
    const accountContext = await this.systemConfigService.getAccountContext();
    const baseFilter = {
      provider: accountContext.provider,
      accountUid: accountContext.accountUid,
      regionId: accountContext.defaultRegion,
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

    return {
      items: itemsWithCreatedBy.map((item) => {
        const snapshot = item.sourceSnapshotId ? sourceSnapshotsById.get(item.sourceSnapshotId) ?? null : null;
        const assetView = this.toPlatformImageAssetView(item, currentUser);

        return {
          ...assetView,
          createdBy: assetView.createdBy ?? 'admin',
          canManage: assetView.canManage ?? false,
          canChangeVisibility: assetView.canChangeVisibility ?? false,
          sourceSnapshotStatus: snapshot?.status ?? null,
          sourceSnapshotAvailable: snapshot?.isAvailable ?? null,
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

  async createPlatformImageTag(input: CreatePlatformImageTagDto, currentUser: SessionUserProfile) {
    if (currentUser.role !== 'admin') {
      throw new ForbiddenException('Admin access required to create platform image tags');
    }

    const name = input.name.trim();
    const normalizedName = this.normalizePlatformImageTagName(name);
    const existingTags = await this.adminRepository.listPlatformImageTags();

    if (existingTags.some((tag) => tag.normalizedName === normalizedName)) {
      throw new ConflictException('镜像标签已存在');
    }

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

  async setPlatformAssetTags(id: string, input: SetPlatformImageTagsDto, currentUser: SessionUserProfile) {
    await this.getScopedPlatformAssetOrThrow(id, currentUser);
    const tagIds = [...new Set(input.tagIds)];
    const tags = await this.adminRepository.listPlatformImageTagsByIds(tagIds);

    if (tags.length !== tagIds.length) {
      throw new BadRequestException('镜像标签不存在');
    }

    const updatedAsset = await this.adminRepository.replacePlatformImageAssetTags(id, tagIds);
    return this.withCreatorUsername(updatedAsset, currentUser);
  }

  async collectPlatformAsset(snapshotId: string, displayName: string, currentUser: SessionUserProfile) {
    const snapshot = await this.adminRepository.getImageSnapshotById(snapshotId);

    if (!snapshot) {
      throw new NotFoundException('Image snapshot not found');
    }

    const accountContext = await this.systemConfigService.getAccountContext();

    if (!this.isSnapshotInScope(snapshot, accountContext)) {
      throw new NotFoundException('Image snapshot not found');
    }

    if (!snapshot.isAvailable || snapshot.status === 'Missing' || await this.adminRepository.hasActiveImageImportForArtifact({ sourceSnapshotId: snapshot.id, imageId: snapshot.imageId }) || await this.packedImages?.hasPending({ imageId: snapshot.imageId, sourceSnapshotId: snapshot.id })) throw new ConflictException('来源镜像尚不可用或正在处理，不能收录。');
    const [existing] = await this.adminRepository.listPlatformImageAssets({ provider: snapshot.provider, accountUid: snapshot.accountUid, regionId: snapshot.regionId, imageId: snapshot.imageId });
    if (existing) return this.withCreatorUsername(existing, currentUser);
    const [packed] = await this.adminRepository.listPackedImageArtifacts({ imageId: snapshot.imageId, cloudAccountUid: snapshot.accountUid ?? undefined, regionId: snapshot.regionId });
    if (packed && packed.status !== 'deleted') {
      if (!this.packedImages) throw new ConflictException('打包来源恢复服务不可用，请稍后重试。');
      const asset = await this.packedImages.restoreAsset(packed.id, snapshotId, displayName);
      return this.withCreatorUsername(asset, currentUser);
    }
    const billingStartAt = new Date();
    const asset = await this.adminRepository.collectPlatformImageAsset({
      preserveExisting: true,
      snapshotId,
      displayName,
      ownerUserId: null,
      visibility: 'platform',
    });
    const tagsSnapshot = buildBillingTags({
      billingScope: 'platform',
      platformImageAssetId: asset.id,
      platformResourceType: 'image',
      billingStartAt,
    });

    const snapshotIds = await this.tagPlatformImageAndSnapshots(snapshot.imageId, accountContext, tagsSnapshot);
    await this.syncPlatformImageBillingLedger({
      imageId: snapshot.imageId,
      snapshotIds,
      platformImageAssetId: asset.id,
      regionId: accountContext.defaultRegion,
      accountUid: accountContext.accountUid,
      billingStartAt,
      tagsSnapshot,
    });

    return this.withCreatorUsername(asset, currentUser);
  }

  async updatePlatformAsset(id: string, input: UpdatePlatformImageDto, currentUser: SessionUserProfile) {
    const asset = await this.getScopedPlatformAssetOrThrow(id, currentUser);
    const nextDisplayName = input.displayName ?? asset.displayName;
    const nextVisibility = input.visibility;

    if (input.displayName === undefined && nextVisibility === undefined) {
      throw new BadRequestException('At least one platform image update field is required');
    }

    if (nextVisibility !== undefined && currentUser.role !== 'admin') {
      throw new ForbiddenException('Admin access required to change platform image visibility');
    }

    if (nextVisibility === undefined) {
      const updatedAsset = await this.adminRepository.updatePlatformImageAsset(id, { displayName: nextDisplayName });
      return this.withCreatorUsername(updatedAsset, currentUser);
    }

    if (nextVisibility === asset.visibility && nextDisplayName === asset.displayName) {
      return this.withCreatorUsername(asset, currentUser);
    }

    if (!asset.ownerUserId) {
      throw new BadRequestException('Only owner-backed image assets can change visibility');
    }

    if (asset.visibility === 'platform' && nextVisibility === 'private') {
      await this.assertPlatformAssetNotReferencedByPublishedTemplates(asset);
    }

    const updatedAsset = await this.recollectPlatformAssetWithVisibility(asset, nextDisplayName, nextVisibility);
    return this.withCreatorUsername(updatedAsset, currentUser);
  }

  async setPlatformAssetEnabled(id: string, enabled: boolean, currentUser: SessionUserProfile) {
    const asset = await this.getScopedPlatformAssetOrThrow(id, currentUser);
    await this.assertPlatformAssetNotImporting(asset);

    if (!enabled) {
      await this.assertPlatformAssetNotReferencedByPublishedTemplates(asset);
    } else {
      const source = asset.sourceSnapshotId && await this.adminRepository.getImageSnapshotById(asset.sourceSnapshotId);
      if (!source || !source.isAvailable) throw new ConflictException('来源镜像不可用，不能启用。');
    }

    const updatedAsset = await this.adminRepository.setPlatformImageAssetEnabled(id, enabled);
    return this.withCreatorUsername(updatedAsset, currentUser);
  }

  async removePlatformAsset(id: string, currentUser: SessionUserProfile): Promise<void> {
    const asset = await this.getScopedPlatformAssetOrThrow(id, currentUser);
    await this.assertPlatformAssetNotImporting(asset);
    await this.assertPlatformAssetNotReferencedByPublishedTemplates(asset);

    await this.adminRepository.deletePlatformImageAsset(id);
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
    if (!snapshot || snapshot.scope !== 'custom' || snapshot.provider !== 'alibaba_cloud') throw new NotFoundException('Image snapshot not found');
    if (deleteOwnedSnapshots) {
      const [artifact] = await this.adminRepository.listPackedImageArtifacts({ sourceSnapshotId: snapshotId });
      if (!artifact || artifact.cloudAccountUid !== snapshot.accountUid || artifact.regionId !== snapshot.regionId || artifact.imageId !== snapshot.imageId
        || (currentUser.role !== 'admin' && artifact.ownerUserId !== currentUser.id)) throw new ForbiddenException('仅 owner 或管理员可完整回收已验证的平台打包镜像。');
    } else {
      if (currentUser.role !== 'admin') throw new ForbiddenException('仅管理员可删除云镜像；owner 请显式选择完整打包回收。');
      const account = await this.systemConfigService.getAccountContext();
      if (!this.isSnapshotInScope(snapshot, account)) throw new NotFoundException('Image snapshot not found');
    }
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
      await this.assertCustomSnapshotNotInUse(snapshot);
      return this.packedImages.cleanup(snapshotId, currentUser);
    }
    if (currentUser && currentUser.role !== 'admin') throw new ForbiddenException('仅管理员可删除云镜像；owner 请显式选择完整打包回收。');

    const accountContext = await this.systemConfigService.getAccountContext();

    if (
      snapshot.provider !== accountContext.provider ||
      snapshot.regionId !== accountContext.defaultRegion ||
      snapshot.accountUid !== accountContext.accountUid
    ) {
      throw new NotFoundException('Image snapshot not found');
    }

    await this.assertCustomSnapshotNotInUse(snapshot);
    await this.assertImageSnapshotNotImporting(snapshot);

    if (await this.describeImageById(snapshot.imageId, accountContext)) await this.performAliyunRpcRequest({
      accessKeyId: accountContext.accessKeyId,
      accessKeySecret: accountContext.accessKeySecret,
      regionId: accountContext.defaultRegion,
      action: 'DeleteImage',
      parameters: {
        ImageId: snapshot.imageId,
        Force: 'false',
      },
    });
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
    return { removed: true, snapshotId };
  }

  private async listScope(scope: CloudImageScope): Promise<ImageCatalogScopePayload> {
    const accountContext = await this.systemConfigService.getAccountContext();

    const [snapshots, catalogItems] = await Promise.all([
      this.adminRepository.listImageSnapshots({
        provider: accountContext.provider,
        accountUid: accountContext.accountUid,
        regionId: accountContext.defaultRegion,
        scope,
      }),
      this.adminRepository.listImageCatalogItems({
        provider: accountContext.provider,
        scope,
        accountUid: accountContext.accountUid,
        regionId: accountContext.defaultRegion,
      }),
    ]);

    return {
      snapshots: snapshots.filter(snapshot => snapshot.status !== 'Deleted').map((snapshot) => ({
        id: snapshot.id,
        provider: snapshot.provider,
        scope: snapshot.scope,
        imageId: snapshot.imageId,
        sourceImageName: snapshot.sourceImageName,
        platform: snapshot.platform,
        status: snapshot.status,
        isAvailable: snapshot.isAvailable,
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
    const accountContext = await this.systemConfigService.getAccountContext();

    if (
      !asset ||
      !this.isPlatformAssetInScope(asset, accountContext) ||
      (currentUser.role !== 'admin' && asset.ownerUserId !== currentUser.id)
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

  private async recollectPlatformAssetWithVisibility(
    asset: PlatformImageAssetRecord,
    displayName: string,
    visibility: ResourceVisibility,
  ) {
    const snapshot = await this.resolvePlatformAssetSnapshot(asset);

    if (!snapshot) {
      throw new BadRequestException('Platform image asset source snapshot is unavailable');
    }

    const updatedAsset = await this.adminRepository.collectPlatformImageAsset({
      snapshotId: snapshot.id,
      displayName,
      defaultHostName: asset.defaultHostName,
      defaultPassword: asset.defaultPassword,
      description: asset.description,
      ownerUserId: asset.ownerUserId,
      visibility,
    });

    if (asset.enabled) {
      return updatedAsset;
    }

    return this.adminRepository.setPlatformImageAssetEnabled(updatedAsset.id, false);
  }

  private async tagPlatformImageAndSnapshots(
    imageId: string,
    accountContext: Awaited<ReturnType<SystemConfigService['getAccountContext']>>,
    tags: Record<string, string>,
  ) {
    await this.performAliyunRpcRequest({
      accessKeyId: accountContext.accessKeyId,
      accessKeySecret: accountContext.accessKeySecret,
      regionId: accountContext.defaultRegion,
      action: 'TagResources',
      parameters: {
        ResourceType: 'image',
        'ResourceId.1': imageId,
        ...buildAliyunTagParameters(tags),
      },
    });

    const image = await this.describeImageById(imageId, accountContext);
    const snapshotIds = extractImageSnapshotIds(image);

    if (snapshotIds.length > 0) {
      await this.performAliyunRpcRequest({
        accessKeyId: accountContext.accessKeyId,
        accessKeySecret: accountContext.accessKeySecret,
        regionId: accountContext.defaultRegion,
        action: 'TagResources',
        parameters: {
          ResourceType: 'snapshot',
          ...buildAliyunArrayParameters('ResourceId', snapshotIds),
          ...buildAliyunTagParameters({
            ...tags,
            PlatformResourceType: 'snapshot',
          }),
        },
      });
    }

    return snapshotIds;
  }

  private async syncPlatformImageBillingLedger(input: {
    imageId: string;
    snapshotIds: string[];
    platformImageAssetId: string;
    regionId: string;
    accountUid: string | null;
    billingStartAt: Date;
    tagsSnapshot: Record<string, string>;
  }) {
    const legacySnapshotLedger = await this.adminRepository.findBillingLedgerResource({
      cloudProvider: 'alibaba_cloud',
      regionId: input.regionId,
      cloudResourceId: input.imageId,
      cloudResourceType: 'snapshot',
    });

    if (legacySnapshotLedger && !input.snapshotIds.includes(input.imageId)) {
      await this.adminRepository.updateBillingLedgerResource(legacySnapshotLedger.id, {
        releasedAt: input.billingStartAt,
      });
    }

    const resources: Array<{ cloudResourceId: string; cloudResourceType: 'image' | 'snapshot' }> = [
      { cloudResourceId: input.imageId, cloudResourceType: 'image' },
      ...input.snapshotIds.map((cloudResourceId) => ({ cloudResourceId, cloudResourceType: 'snapshot' as const })),
    ];

    for (const resource of resources) {
      const existing = await this.adminRepository.findBillingLedgerResource({
        cloudProvider: 'alibaba_cloud',
        regionId: input.regionId,
        cloudResourceId: resource.cloudResourceId,
        cloudResourceType: resource.cloudResourceType,
      });

      if (existing) {
        await this.adminRepository.updateBillingLedgerResource(existing.id, {
          billingScope: 'platform',
          ownerUserId: null,
          rangeInstanceId: null,
          singleInstanceBatchId: null,
          platformImageAssetId: input.platformImageAssetId,
          releasedAt: null,
          tagsSnapshot: input.tagsSnapshot,
        });
        continue;
      }

      await this.adminRepository.createBillingLedgerResource({
        cloudProvider: 'alibaba_cloud',
        cloudAccountUid: input.accountUid,
        regionId: input.regionId,
        cloudResourceId: resource.cloudResourceId,
        cloudResourceType: resource.cloudResourceType,
        billingScope: 'platform',
        ownerUserId: null,
        platformImageAssetId: input.platformImageAssetId,
        billingStartAt: input.billingStartAt,
        tagsSnapshot: input.tagsSnapshot,
      });
    }
  }

  private async withCreatorUsername(asset: PlatformImageAssetRecord, currentUser?: SessionUserProfile) {
    const [normalizedAsset] = await attachOwnerUsernamesAsCreatedBy(this.adminRepository, [asset]);
    return this.toPlatformImageAssetView(normalizedAsset, currentUser);
  }

  private toPlatformImageAssetView(
    asset: PlatformImageAssetRecord & { createdBy?: string },
    currentUser?: SessionUserProfile,
  ): PlatformImageAssetView {
    const { defaultPassword: _defaultPassword, tags, ...view } = asset;
    const tagViews = tags.map((tag) => this.toPlatformImageTagView(tag));

    if (!currentUser) {
      return {
        ...view,
        tags: tagViews,
      };
    }

    const canManage = currentUser.role === 'admin' || asset.ownerUserId === currentUser.id;

    return {
      ...view,
      tags: tagViews,
      canManage,
      canChangeVisibility: currentUser.role === 'admin' && Boolean(asset.ownerUserId),
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

  private async assertCustomSnapshotNotInUse(snapshot: CloudImageSnapshotRecord) {
    const assets = await this.adminRepository.listPlatformImageAssets({
      provider: snapshot.provider,
      accountUid: snapshot.accountUid,
      regionId: snapshot.regionId,
      sourceSnapshotId: snapshot.id,
    });
    const assetIds = new Set(assets.map((asset) => asset.id));
    const imageIds = new Set([snapshot.imageId]);

    const instances = await this.adminRepository.listRangeInstances();
    const referencingInstances = instances.filter((instance) => {
      if (instance.status === 'destroyed') {
        return false;
      }

      const singleInstanceConfig = instance.singleInstanceConfig;
      return (
        (singleInstanceConfig?.platformImageAssetId ? assetIds.has(singleInstanceConfig.platformImageAssetId) : false) ||
        (singleInstanceConfig?.imageId ? imageIds.has(singleInstanceConfig.imageId) : false) ||
        containsImageReference(instance.runtimeScenarioTemplateSpec, assetIds, imageIds) ||
        containsImageReference(instance.runtimeCompiledProvisionSpec, assetIds, imageIds) ||
        containsImageReference(instance.draftScenarioTemplateSpec, assetIds, imageIds) ||
        containsImageReference(instance.draftCompiledProvisionSpec, assetIds, imageIds) ||
        containsImageReference(instance.resourceSummary, assetIds, imageIds)
      );
    });

    const templates = await this.adminRepository.listRangeTemplates();
    const referencingTemplates = templates.filter((template) =>
      [
        template.topologySpec,
        template.topologyGraph,
        template.scenarioTemplateSpec,
        template.compiledProvisionSpec,
        template.compiledSpec,
        template.currentDraftVersion,
        template.currentPublishedVersion,
        ...(template.versions ?? []),
      ].some((value) => containsImageReference(value, assetIds, imageIds)),
    );

    if (referencingInstances.length === 0 && referencingTemplates.length === 0) {
      return;
    }

    const references = [
      ...referencingInstances.slice(0, 3).map((instance) => `实例“${instance.name}”`),
      ...referencingTemplates.slice(0, 3).map((template) => `模板“${template.name}”`),
    ];
    const omitted = referencingInstances.length + referencingTemplates.length - references.length;
    const suffix = omitted > 0 ? ` 等 ${omitted + references.length} 个引用` : '';

    throw new BadRequestException(
      `镜像仍被${references.join('、')}${suffix}引用。请先替换镜像或销毁相关实例，再删除云端自定义镜像。`,
    );
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
    const accountContext = await this.systemConfigService.getAccountContext();
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
    accountContext: Awaited<ReturnType<SystemConfigService['getAccountContext']>>,
  ) {
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
