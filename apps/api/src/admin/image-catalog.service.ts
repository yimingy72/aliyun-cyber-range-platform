import { randomUUID } from 'node:crypto';

import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';

import {
  ADMIN_REPOSITORY,
  type AdminRepository,
  type CloudImageScope,
  type CloudImageSnapshotRecord,
  type ImageCatalogItemRecord,
  type PlatformImageAssetRecord,
  type ResourceVisibility,
  type UpsertImageSnapshotInput,
} from './admin.repository';
import type { SessionUserProfile } from './admin-user-auth';
import { attachOwnerUsernamesAsCreatedBy } from './creator-display';
import type { PlatformImageView, UpdatePlatformImageDto } from './dto/platform-image.dto';
import { signAliyunRpcQuery } from './image-catalog-rpc-signer';
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

type PlatformImageAssetsPayload = {
  items: Array<
    PlatformImageAssetRecord & {
      createdBy: string;
      sourceSnapshotStatus: string | null;
      sourceSnapshotAvailable: boolean | null;
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
};

const ALICLOUD_ECS_API_VERSION = '2014-05-26';
const ALICLOUD_SIGNATURE_METHOD = 'HMAC-SHA1';
const ALICLOUD_SIGNATURE_VERSION = '1.0';
const ALICLOUD_PAGE_SIZE = 100;

@Injectable()
export class ImageCatalogService {
  constructor(
    @Inject(ADMIN_REPOSITORY) private readonly adminRepository: AdminRepository,
    private readonly systemConfigService: SystemConfigService,
  ) {}

  listPublic() {
    return this.syncScope('public', 'system');
  }

  listCustom() {
    return this.syncScope('custom', 'self');
  }

  syncPublicImages() {
    return this.syncScope('public', 'system');
  }

  syncCustomImages() {
    return this.syncScope('custom', 'self');
  }

  async listPlatformAssets(
    currentUserId: string,
    view: PlatformImageView = 'platform',
  ): Promise<PlatformImageAssetsPayload> {
    const accountContext = await this.systemConfigService.getAccountContext();
    const baseFilter = {
      provider: accountContext.provider,
      accountUid: accountContext.accountUid,
      regionId: accountContext.defaultRegion,
      ...(view === 'platform' ? { visibility: 'platform' as const } : { ownerUserId: currentUserId }),
    };

    const items = await this.adminRepository.listPlatformImageAssets({
      ...baseFilter,
      ...(view === 'platform' ? { onlyAvailableSourceSnapshots: true } : {}),
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

        return {
          ...item,
          sourceSnapshotStatus: snapshot?.status ?? null,
          sourceSnapshotAvailable: snapshot?.isAvailable ?? null,
        };
      }),
    };
  }

  async collectPlatformAsset(snapshotId: string, displayName: string) {
    const snapshot = await this.adminRepository.getImageSnapshotById(snapshotId);

    if (!snapshot) {
      throw new NotFoundException('Image snapshot not found');
    }

    const accountContext = await this.systemConfigService.getAccountContext();

    if (!this.isSnapshotInScope(snapshot, accountContext)) {
      throw new NotFoundException('Image snapshot not found');
    }

    const asset = await this.adminRepository.collectPlatformImageAsset({
      snapshotId,
      displayName,
      ownerUserId: null,
      visibility: 'platform',
    });

    return this.withCreatorUsername(asset);
  }

  async updatePlatformAsset(id: string, input: UpdatePlatformImageDto, currentUser: SessionUserProfile) {
    const asset = await this.getScopedPlatformAssetOrThrow(id, currentUser);
    const nextDisplayName = input.displayName ?? asset.displayName;
    const nextVisibility = input.visibility;

    if (input.displayName === undefined && nextVisibility === undefined) {
      throw new BadRequestException('At least one platform image update field is required');
    }

    if (nextVisibility === undefined) {
      const updatedAsset = await this.adminRepository.updatePlatformImageAsset(id, { displayName: nextDisplayName });
      return this.withCreatorUsername(updatedAsset);
    }

    if (nextVisibility === asset.visibility && nextDisplayName === asset.displayName) {
      return asset;
    }

    if (!asset.ownerUserId) {
      throw new BadRequestException('Only owner-backed image assets can change visibility');
    }

    const updatedAsset = await this.recollectPlatformAssetWithVisibility(asset, nextDisplayName, nextVisibility);
    return this.withCreatorUsername(updatedAsset);
  }

  async setPlatformAssetEnabled(id: string, enabled: boolean, currentUser: SessionUserProfile) {
    await this.getScopedPlatformAssetOrThrow(id, currentUser);

    const updatedAsset = await this.adminRepository.setPlatformImageAssetEnabled(id, enabled);
    return this.withCreatorUsername(updatedAsset);
  }

  async removePlatformAsset(id: string, currentUser: SessionUserProfile): Promise<void> {
    const asset = await this.getScopedPlatformAssetOrThrow(id, currentUser);

    if (asset.ownerUserId && asset.sourceScope === 'custom') {
      const snapshot = await this.resolvePlatformAssetSnapshot(asset);

      if (snapshot) {
        await this.deleteCustomSnapshot(snapshot.id);
        return;
      }
    }

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

  async deleteCustomSnapshot(snapshotId: string): Promise<void> {
    const snapshot = await this.adminRepository.getImageSnapshotById(snapshotId);

    if (!snapshot) {
      throw new NotFoundException('Image snapshot not found');
    }

    if (snapshot.scope !== 'custom') {
      throw new BadRequestException('Only custom image snapshots can be deleted');
    }

    const accountContext = await this.systemConfigService.getAccountContext();

    if (
      snapshot.provider !== accountContext.provider ||
      snapshot.regionId !== accountContext.defaultRegion ||
      snapshot.accountUid !== accountContext.accountUid
    ) {
      throw new NotFoundException('Image snapshot not found');
    }

    await this.performAliyunRpcRequest({
      accessKeyId: accountContext.accessKeyId,
      accessKeySecret: accountContext.accessKeySecret,
      regionId: accountContext.defaultRegion,
      action: 'DeleteImage',
      parameters: {
        ImageId: snapshot.imageId,
      },
    });

    // ponytail: O(n) ledger scan is fine for now; add a dedicated repository query once image billing volume grows.
    const ledgerResources = await this.adminRepository.listBillingLedgerResources();
    await Promise.all(
      ledgerResources
        .filter(
          (item) =>
            item.cloudResourceId === snapshot.imageId &&
            (item.cloudResourceType === 'image' || item.cloudResourceType === 'snapshot') &&
            item.releasedAt === null,
        )
        .map((item) =>
          this.adminRepository.updateBillingLedgerResource(item.id, {
            releasedAt: new Date(),
          }),
        ),
    );

    await this.adminRepository.deletePlatformImageAssetsBySnapshotId(snapshot.id);

    const remainingSnapshots = await this.adminRepository.listImageSnapshots({
      provider: snapshot.provider,
      accountUid: snapshot.accountUid,
      regionId: snapshot.regionId,
      scope: 'custom',
    });

    await this.adminRepository.reconcileImageSnapshots({
      provider: snapshot.provider,
      accountUid: snapshot.accountUid,
      regionId: snapshot.regionId,
      scope: 'custom',
      snapshots: remainingSnapshots
        .filter((item) => item.id !== snapshot.id)
        .map((item) => this.toUpsertSnapshotInput(item)),
    });
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
      snapshots: snapshots.map((snapshot) => ({
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

  private async withCreatorUsername<T extends PlatformImageAssetRecord>(asset: T) {
    const [normalizedAsset] = await attachOwnerUsernamesAsCreatedBy(this.adminRepository, [asset]);
    return normalizedAsset;
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

      totalCount = this.toNumber(response.TotalCount);
      pageNumber += 1;
    } while ((pageNumber - 1) * ALICLOUD_PAGE_SIZE < totalCount);

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
      },
    });
  }

  private async performAliyunRpcRequest<ResponsePayload>(input: {
    accessKeyId: string;
    accessKeySecret: string;
    regionId: string;
    action: string;
    parameters?: Record<string, string>;
  }): Promise<ResponsePayload> {
    const endpoint = `https://ecs.${input.regionId}.aliyuncs.com/`;
    const query = signAliyunRpcQuery(
      {
        Action: input.action,
        AccessKeyId: input.accessKeyId,
        Format: 'JSON',
        RegionId: input.regionId,
        SignatureMethod: ALICLOUD_SIGNATURE_METHOD,
        SignatureNonce: randomUUID(),
        SignatureVersion: ALICLOUD_SIGNATURE_VERSION,
        Timestamp: this.formatTimestamp(new Date()),
        Version: ALICLOUD_ECS_API_VERSION,
        ...(input.parameters ?? {}),
      },
      input.accessKeySecret,
    );
    const response = await fetch(`${endpoint}?${query}`, {
      method: 'GET',
    });

    if (!response.ok) {
      throw new Error(`Aliyun ${input.action} request failed with status ${response.status}`);
    }

    return (await response.json()) as ResponsePayload;
  }

  private toUpsertSnapshotInput(snapshot: CloudImageSnapshotRecord): UpsertImageSnapshotInput {
    return {
      imageId: snapshot.imageId,
      sourceImageName: snapshot.sourceImageName,
      osType: snapshot.osType,
      platform: snapshot.platform,
      architecture: snapshot.architecture,
      status: snapshot.status,
      isAvailable: snapshot.isAvailable,
      lastSyncedAt: snapshot.lastSyncedAt,
    };
  }

  private formatTimestamp(value: Date) {
    return value.toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  private normalizeImages(response: AliyunDescribeImagesResponse) {
    const images = response.Images?.Image;

    if (!images) {
      return [];
    }

    return Array.isArray(images) ? images : [images];
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

  private toNumber(value: number | string | undefined) {
    if (typeof value === 'number') {
      return value;
    }

    if (typeof value === 'string') {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : 0;
    }

    return 0;
  }
}
