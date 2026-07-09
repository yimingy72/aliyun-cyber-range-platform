import { randomUUID } from 'node:crypto';

import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';

import {
  ADMIN_REPOSITORY,
  type AdminRepository,
  type CloudImageScope,
  type CloudImageSnapshotRecord,
  type ImageCatalogItemRecord,
  type PlatformImageAssetRecord,
  type UpsertImageSnapshotInput,
} from './admin.repository';
import { signAliyunRpcQuery } from './image-catalog-rpc-signer';
import { SystemConfigService } from './system-config.service';

type ImageCatalogScopePayload = {
  snapshots: CloudImageSnapshotRecord[];
  catalogItems: ImageCatalogItemRecord[];
};

type PlatformImageAssetsPayload = {
  items: PlatformImageAssetRecord[];
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

  async listPlatformAssets(): Promise<PlatformImageAssetsPayload> {
    const accountContext = await this.systemConfigService.getAccountContext();

    const items = await this.adminRepository.listPlatformImageAssets({
      provider: accountContext.provider,
      accountUid: accountContext.accountUid,
      regionId: accountContext.defaultRegion,
      onlyAvailableSourceSnapshots: true,
    });

    return { items };
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

    return this.adminRepository.collectPlatformImageAsset({
      snapshotId,
      displayName,
    });
  }

  async renamePlatformAsset(id: string, displayName: string) {
    await this.getScopedPlatformAssetOrThrow(id);

    return this.adminRepository.updatePlatformImageAsset(id, { displayName });
  }

  async setPlatformAssetEnabled(id: string, enabled: boolean) {
    await this.getScopedPlatformAssetOrThrow(id);

    return this.adminRepository.setPlatformImageAssetEnabled(id, enabled);
  }

  async removePlatformAsset(id: string): Promise<void> {
    await this.getScopedPlatformAssetOrThrow(id);

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

    return { snapshots, catalogItems };
  }

  private async getScopedPlatformAssetOrThrow(id: string): Promise<PlatformImageAssetRecord> {
    const { items } = await this.listPlatformAssets();
    const asset = items.find((item) => item.id === id);

    if (!asset) {
      throw new NotFoundException('Platform image asset not found');
    }

    return asset;
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
          status: image.Status ?? null,
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
