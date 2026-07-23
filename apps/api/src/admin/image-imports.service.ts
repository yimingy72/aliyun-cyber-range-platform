import { createHmac, randomUUID } from 'node:crypto';

import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';

import { ADMIN_REPOSITORY, type AdminRepository, type CloudImageSnapshotRecord } from './admin.repository';
import type { SessionUserProfile } from './admin-user-auth';
import { CloudAccountContextsService, type CloudAccountContextCredentials } from './cloud-account-contexts.service';
import { CreateImageImportDto } from './dto/image-import.dto';
import { signAliyunRpcQuery } from './image-catalog-rpc-signer';
import { encryptPlatformImageDefaultPassword } from './platform-image-password';
import { PrismaService } from '../database/prisma.service';

const ALICLOUD_ECS_API_VERSION = '2014-05-26';
const ALICLOUD_SIGNATURE_METHOD = 'HMAC-SHA1';
const ALICLOUD_SIGNATURE_VERSION = '1.0';
const IMAGE_IMPORT_UPLOAD_TTL_MS = 30 * 60 * 1000;
const DEFAULT_IMAGE_IMPORT_MAX_BYTES = 4 * 1024 * 1024 * 1024;
const DEFAULT_IMAGE_IMPORT_MAX_DURATION_MS = 24 * 60 * 60 * 1000;

type ImageImportJobRow = {
  id: string;
  cloudAccountContextId: string;
  ownerUserId: string;
  displayName: string;
  defaultHostName: string | null;
  defaultPassword: string | null;
  description: string | null;
  osType: string;
  platform: string | null;
  architecture: string;
  bootMode: string;
  imageFormat: string;
  systemDiskSize: number;
  sourceFileName: string;
  sourceContentType: string;
  sourceSizeBytes: string;
  objectKey: string;
  uploadExpiresAt: Date;
  uploadCompletedAt: Date | null;
  lastPolledAt: Date | null;
  status: 'awaiting_upload' | 'importing' | 'available' | 'failed' | 'cancelled';
  imageId: string | null;
  taskId: string | null;
  sourceSnapshotId: string | null;
  platformImageAssetId: string | null;
  cloudImageDeletedAt: Date | null;
  temporaryObjectDeletedAt: Date | null;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type ImageImportJobView = Omit<ImageImportJobRow, 'defaultPassword' | 'objectKey' | 'sourceSizeBytes'> & {
  sourceSizeBytes: number;
};

@Injectable()
export class ImageImportsService {
  constructor(
    @Inject(ADMIN_REPOSITORY) private readonly adminRepository: AdminRepository,
    private readonly prisma: PrismaService,
    private readonly cloudAccountContextsService: CloudAccountContextsService,
  ) {}

  async createUpload(input: CreateImageImportDto, currentUser: SessionUserProfile) {
    const sourceSizeBytes = Math.trunc(input.sourceSizeBytes);

    if (!Number.isSafeInteger(sourceSizeBytes) || sourceSizeBytes > this.readMaxUploadBytes()) {
      throw new BadRequestException(`镜像文件超出单次上传上限（${this.readMaxUploadBytes()} 字节）。`);
    }

    const cloudContext = await this.cloudAccountContextsService.getCredentials(input.cloudContextId, {
      requireReady: true,
      requireActive: true,
      requireImageImportBucket: true,
    });
    const now = new Date();
    const uploadExpiresAt = new Date(now.getTime() + IMAGE_IMPORT_UPLOAD_TTL_MS);
    const sourceFileName = this.normalizeSourceFileName(input.sourceFileName);
    this.assertSourceFileMatchesFormat(sourceFileName, input.imageFormat);
    const objectKey = `image-imports/${currentUser.id}/${randomUUID()}/${sourceFileName}`;
    const contentType = input.sourceContentType?.trim() || 'application/octet-stream';
    const job = await this.prisma.imageImportJob.create({
      data: {
        cloudAccountContextId: cloudContext.id,
        ownerUserId: currentUser.id,
        displayName: input.displayName.trim(),
        defaultHostName: input.defaultHostName?.trim() || null,
        defaultPassword: encryptPlatformImageDefaultPassword(input.defaultPassword),
        description: input.description?.trim() || null,
        osType: input.osType,
        platform: input.platform?.trim() || null,
        architecture: input.architecture,
        bootMode: input.bootMode,
        imageFormat: input.imageFormat,
        systemDiskSize: input.systemDiskSize,
        sourceFileName,
        sourceContentType: contentType,
        sourceSizeBytes: String(sourceSizeBytes),
        objectKey,
        uploadExpiresAt,
      },
    });

    return {
      job: this.toView(job),
      upload: {
        method: 'PUT' as const,
        url: this.createPresignedPutUrl({
          bucket: cloudContext.imageImportBucket,
          regionId: cloudContext.regionId,
          objectKey,
          contentType,
          accessKeyId: cloudContext.accessKeyId,
          accessKeySecret: cloudContext.accessKeySecret,
          expiresAt: uploadExpiresAt,
        }),
        headers: { 'Content-Type': contentType },
        expiresAt: uploadExpiresAt,
      },
    };
  }

  async completeUpload(id: string, currentUser: SessionUserProfile) {
    const job = await this.getAccessibleJob(id, currentUser);

    if (job.status !== 'awaiting_upload') {
      return this.toView(job);
    }

    if (job.uploadExpiresAt <= new Date()) {
      throw new BadRequestException('上传地址已过期，请重新发起镜像上传。');
    }

    const context = await this.cloudAccountContextsService.getCredentials(job.cloudAccountContextId, { requireReady: true });
    const uploadedObject = await this.headOssObject(context, job.objectKey);

    if (!uploadedObject) {
      throw new BadRequestException('OSS 中未找到已上传的镜像文件，请完成上传后再导入。');
    }

    const expectedSizeBytes = Number(job.sourceSizeBytes);

    if (uploadedObject.contentLength !== expectedSizeBytes) {
      await this.deleteOssObject(context, job.objectKey).catch(() => false);
      throw new BadRequestException('上传文件大小与提交信息不一致，请重新上传镜像文件。');
    }

    let imageId: string;
    let taskId: string | null;

    try {
      const response = await this.importImage(context, job);
      imageId = response.ImageId?.trim() ?? '';

      if (!imageId) {
        throw new Error('阿里云 ImportImage 未返回 ImageId。');
      }
      taskId = response.TaskId?.trim() || null;
    } catch (error) {
      const message = error instanceof Error ? error.message : '镜像导入请求失败。';
      const retryable = await this.prisma.imageImportJob.update({
        where: { id: job.id },
        data: { status: 'failed', errorMessage: message },
      });
      return this.toView(retryable);
    }

    const importing = await this.prisma.imageImportJob.update({
      where: { id: job.id },
      data: {
        status: 'importing',
        uploadCompletedAt: new Date(),
        imageId,
        taskId,
        errorMessage: null,
      },
    });

    try {
      return this.toView(await this.ensureImportArtifacts(context, importing));
    } catch (error) {
      const message = error instanceof Error ? error.message : '镜像导入元数据同步失败。';
      const pending = await this.prisma.imageImportJob.update({
        where: { id: importing.id },
        data: { errorMessage: message },
      });
      return this.toView(pending);
    }
  }

  async get(id: string, currentUser: SessionUserProfile) {
    return this.toView(await this.getAccessibleJob(id, currentUser));
  }

  async retry(id: string, currentUser: SessionUserProfile) {
    const job = await this.getAccessibleJob(id, currentUser);

    if (job.status === 'awaiting_upload') {
      return this.completeUpload(id, currentUser);
    }

    if (job.status !== 'failed' || job.imageId) {
      throw new BadRequestException('仅可重试尚未获得阿里云 ImageId 的失败导入任务。');
    }

    if (job.uploadExpiresAt <= new Date()) {
      throw new BadRequestException('上传地址已过期，请重新上传镜像文件。');
    }

    await this.prisma.imageImportJob.update({
      where: { id: job.id },
      data: { status: 'awaiting_upload', errorMessage: null },
    });
    return this.completeUpload(id, currentUser);
  }

  async list(currentUser: SessionUserProfile) {
    const jobs = await this.prisma.imageImportJob.findMany({
      where: { ownerUserId: currentUser.id },
      orderBy: { createdAt: 'desc' },
    });
    return { items: jobs.map((job) => this.toView(job)) };
  }

  async refreshImport(id: string) {
    const existingJob = await this.prisma.imageImportJob.findUnique({ where: { id } });

    if (!existingJob || existingJob.status !== 'importing' || !existingJob.imageId) {
      return existingJob ? this.toView(existingJob) : null;
    }

    const job = await this.prisma.imageImportJob.update({
      where: { id: existingJob.id },
      data: { lastPolledAt: new Date() },
    });

    if (this.hasExceededImportDuration(job)) {
      return this.toView(await this.failTimedOutImport(job));
    }

    try {
      const context = await this.cloudAccountContextsService.getCredentials(job.cloudAccountContextId, { requireReady: true });
      const importJob = await this.ensureImportArtifacts(context, job);
      const image = await this.describeImage(context, importJob.imageId!);

      if (!image) {
        return this.toView(importJob);
      }

      const rawStatus = image.Status?.trim() || 'Creating';
      const status = this.buildSnapshotStatus(image) ?? rawStatus;
      const isAvailable = rawStatus === 'Available';
      const failed = /Failed|Error|Unavailable/i.test(rawStatus);
      const syncedAt = new Date();
      await this.adminRepository.upsertImageSnapshots({
        provider: 'alibaba_cloud',
        accountUid: context.accountUid,
        regionId: context.regionId,
        scope: 'custom',
        snapshots: [
          {
            imageId: importJob.imageId!,
            sourceImageName: image.ImageName?.trim() || importJob.displayName,
            osType: image.OSType?.trim() || importJob.osType,
            platform: image.Platform?.trim() || importJob.platform,
            architecture: image.Architecture?.trim() || importJob.architecture,
            status,
            isAvailable,
            lastSyncedAt: syncedAt,
          },
        ],
      });

      if (!isAvailable && !failed) {
        return this.toView(importJob);
      }

      if (isAvailable) {
        if (!importJob.platformImageAssetId) {
          throw new Error('镜像导入完成，但平台镜像资产尚未创建。');
        }

        await this.adminRepository.setPlatformImageAssetEnabled(importJob.platformImageAssetId, true);
      }

      return this.toView(
        await this.finalizeImport(
          context,
          importJob,
          isAvailable ? 'available' : 'failed',
          failed ? `阿里云镜像导入失败：${status}` : null,
        ),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : '镜像导入状态同步失败。';
      const pending = await this.prisma.imageImportJob.update({
        where: { id: job.id },
        data: { errorMessage: message },
      });
      return this.toView(pending);
    }
  }

  async refreshPendingImports() {
    const [jobs, expiredUploads, terminalJobs] = await Promise.all([
      this.prisma.imageImportJob.findMany({
        where: { status: 'importing' },
        select: { id: true },
        take: 20,
        orderBy: [
          { lastPolledAt: { sort: 'asc', nulls: 'first' } },
          { createdAt: 'asc' },
        ],
      }),
      this.prisma.imageImportJob.findMany({
        where: {
          status: { in: ['awaiting_upload', 'failed'] },
          imageId: null,
          uploadExpiresAt: { lt: new Date() },
        },
        take: 20,
        orderBy: { uploadExpiresAt: 'asc' },
      }),
      this.prisma.imageImportJob.findMany({
        where: {
          OR: [
            {
              temporaryObjectDeletedAt: null,
              OR: [
                { status: { in: ['available', 'cancelled'] } },
                { status: 'failed', imageId: { not: null } },
              ],
            },
            {
              cloudImageDeletedAt: null,
              status: 'failed',
              imageId: { not: null },
            },
          ],
        },
        take: 20,
        orderBy: { updatedAt: 'asc' },
      }),
    ]);
    await Promise.all(jobs.map((job) => this.refreshImport(job.id)));
    await Promise.all(expiredUploads.map((job) => this.cancelExpiredUpload(job)));
    await Promise.all(terminalJobs.map((job) => this.cleanupTerminalArtifacts(job)));
    return jobs.length + expiredUploads.length + terminalJobs.length;
  }

  private async getAccessibleJob(id: string, currentUser: SessionUserProfile): Promise<ImageImportJobRow> {
    const job = await this.prisma.imageImportJob.findUnique({ where: { id } });

    if (!job) {
      throw new NotFoundException('Image import job not found');
    }

    if (currentUser.role !== 'admin' && job.ownerUserId !== currentUser.id) {
      throw new ForbiddenException('Image import job access denied');
    }

    return job;
  }

  private async ensureImportArtifacts(context: CloudAccountContextCredentials, job: ImageImportJobRow) {
    if (!job.imageId) {
      throw new Error('镜像导入任务缺少阿里云 ImageId。');
    }

    const [sourceSnapshot, linkedPlatformImageAsset] = await Promise.all([
      job.sourceSnapshotId ? this.adminRepository.getImageSnapshotById(job.sourceSnapshotId) : null,
      job.platformImageAssetId ? this.adminRepository.getPlatformImageAssetById(job.platformImageAssetId) : null,
    ]);

    if (
      sourceSnapshot &&
      sourceSnapshot.imageId === job.imageId &&
      linkedPlatformImageAsset &&
      linkedPlatformImageAsset.imageId === job.imageId &&
      linkedPlatformImageAsset.sourceSnapshotId === sourceSnapshot.id
    ) {
      await this.syncImportedImageBillingLedger({
        imageId: job.imageId,
        platformImageAssetId: linkedPlatformImageAsset.id,
        regionId: context.regionId,
        accountUid: context.accountUid,
        billingStartAt: job.uploadCompletedAt ?? job.createdAt,
      });
      return job;
    }

    const syncedAt = new Date();
    await this.adminRepository.upsertImageSnapshots({
      provider: 'alibaba_cloud',
      accountUid: context.accountUid,
      regionId: context.regionId,
      scope: 'custom',
      snapshots: [
        {
          imageId: job.imageId,
          sourceImageName: job.displayName,
          osType: job.osType,
          platform: job.platform,
          architecture: job.architecture,
          status: 'Creating',
          isAvailable: false,
          lastSyncedAt: syncedAt,
        },
      ],
    });
    const snapshot = await this.resolveSnapshot(context, job.imageId);
    const platformImageAsset = await this.adminRepository.collectPlatformImageAsset({
      snapshotId: snapshot.id,
      displayName: job.displayName,
      defaultHostName: job.defaultHostName,
      defaultPassword: job.defaultPassword,
      description: job.description,
      ownerUserId: job.ownerUserId,
      visibility: 'private',
    });
    await this.adminRepository.setPlatformImageAssetEnabled(platformImageAsset.id, false);
    await this.syncImportedImageBillingLedger({
      imageId: job.imageId,
      platformImageAssetId: platformImageAsset.id,
      regionId: context.regionId,
      accountUid: context.accountUid,
      billingStartAt: syncedAt,
    });

    return this.prisma.imageImportJob.update({
      where: { id: job.id },
      data: {
        sourceSnapshotId: snapshot.id,
        platformImageAssetId: platformImageAsset.id,
        errorMessage: null,
      },
    });
  }

  private async syncImportedImageBillingLedger(input: {
    imageId: string;
    platformImageAssetId: string;
    regionId: string;
    accountUid: string;
    billingStartAt: Date;
  }) {
    for (const cloudResourceType of ['image', 'snapshot'] as const) {
      const existing = await this.adminRepository.findBillingLedgerResource({
        cloudProvider: 'alibaba_cloud',
        regionId: input.regionId,
        cloudResourceId: input.imageId,
        cloudResourceType,
      });

      if (existing) {
        await this.adminRepository.updateBillingLedgerResource(existing.id, {
          billingScope: 'platform',
          ownerUserId: null,
          platformImageAssetId: input.platformImageAssetId,
          releasedAt: null,
        });
        continue;
      }

      await this.adminRepository.createBillingLedgerResource({
        cloudProvider: 'alibaba_cloud',
        cloudAccountUid: input.accountUid,
        regionId: input.regionId,
        cloudResourceId: input.imageId,
        cloudResourceType,
        billingScope: 'platform',
        ownerUserId: null,
        platformImageAssetId: input.platformImageAssetId,
        billingStartAt: input.billingStartAt,
        tagsSnapshot: {},
      });
    }
  }

  private async resolveSnapshot(context: CloudAccountContextCredentials, imageId: string): Promise<CloudImageSnapshotRecord> {
    const [snapshot] = await this.adminRepository.listImageSnapshots({
      provider: 'alibaba_cloud',
      accountUid: context.accountUid,
      regionId: context.regionId,
      scope: 'custom',
      imageId,
    });

    if (!snapshot) {
      throw new Error('镜像快照记录创建失败。');
    }

    return snapshot;
  }

  private async importImage(context: CloudAccountContextCredentials, job: ImageImportJobRow) {
    const parameters: Record<string, string> = {
      ImageName: job.displayName,
      Architecture: job.architecture,
      OSType: job.osType,
      BootMode: job.bootMode,
      RoleName: 'AliyunECSImageImportDefaultRole',
      'DiskDeviceMapping.1.OSSBucket': context.imageImportBucket,
      'DiskDeviceMapping.1.OSSObject': job.objectKey,
      'DiskDeviceMapping.1.Format': job.imageFormat.toUpperCase(),
      'DiskDeviceMapping.1.DiskImageSize': String(job.systemDiskSize),
      DetectionStrategy: 'Standard',
      ClientToken: job.id,
      'Tag.1.Key': 'CyberRangeOwnerUserId',
      'Tag.1.Value': job.ownerUserId,
      'Tag.2.Key': 'CyberRangeCloudContextId',
      'Tag.2.Value': job.cloudAccountContextId,
      'Tag.3.Key': 'CyberRangeImageImportJobId',
      'Tag.3.Value': job.id,
    };

    if (job.description) {
      parameters.Description = job.description;
    }
    if (job.platform) {
      parameters.Platform = job.platform;
    }

    return this.performAliyunEcsRequest<{ ImageId?: string; TaskId?: string }>({
      ...context,
      action: 'ImportImage',
      parameters,
    });
  }

  private async describeImage(context: CloudAccountContextCredentials, imageId: string) {
    const response = await this.performAliyunEcsRequest<{
      Images?: { Image?: AliyunImage | AliyunImage[] };
    }>({
      ...context,
      action: 'DescribeImages',
      parameters: { ImageId: imageId },
    });
    const images = response.Images?.Image;

    if (!images) {
      return null;
    }

    return Array.isArray(images) ? images[0] ?? null : images;
  }

  private async performAliyunEcsRequest<ResponsePayload>(input: CloudAccountContextCredentials & {
    action: string;
    parameters: Record<string, string>;
  }): Promise<ResponsePayload> {
    const query = signAliyunRpcQuery(
      {
        Action: input.action,
        AccessKeyId: input.accessKeyId,
        Format: 'JSON',
        RegionId: input.regionId,
        SignatureMethod: ALICLOUD_SIGNATURE_METHOD,
        SignatureNonce: randomUUID(),
        SignatureVersion: ALICLOUD_SIGNATURE_VERSION,
        Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
        Version: ALICLOUD_ECS_API_VERSION,
        ...input.parameters,
      },
      input.accessKeySecret,
    );
    const response = await fetch(`https://ecs.${input.regionId}.aliyuncs.com/?${query}`);

    if (!response.ok) {
      throw new Error(`阿里云 ${input.action} 请求失败（HTTP ${response.status}）：${await response.text()}`);
    }

    return (await response.json()) as ResponsePayload;
  }

  private async headOssObject(context: CloudAccountContextCredentials, objectKey: string) {
    const response = await this.ossRequest({ context, objectKey, method: 'HEAD' });

    if (!response.ok) {
      return null;
    }

    const contentLength = Number(response.headers.get('content-length'));
    return {
      contentLength: Number.isSafeInteger(contentLength) && contentLength >= 0 ? contentLength : null,
    };
  }

  private async deleteOssObject(context: CloudAccountContextCredentials, objectKey: string) {
    const response = await this.ossRequest({ context, objectKey, method: 'DELETE' });
    return response.ok || response.status === 404;
  }

  private async ossRequest(input: {
    context: CloudAccountContextCredentials;
    objectKey: string;
    method: 'HEAD' | 'DELETE';
  }) {
    const date = new Date().toUTCString();
    const canonicalResource = `/${input.context.imageImportBucket}/${input.objectKey}`;
    const stringToSign = `${input.method}\n\n\n${date}\n${canonicalResource}`;
    const signature = createHmac('sha1', input.context.accessKeySecret).update(stringToSign).digest('base64');
    return fetch(`${this.getOssEndpoint(input.context)}/${this.encodeObjectKey(input.objectKey)}`, {
      method: input.method,
      headers: {
        Date: date,
        Authorization: `OSS ${input.context.accessKeyId}:${signature}`,
      },
    });
  }

  private createPresignedPutUrl(input: {
    bucket: string;
    regionId: string;
    objectKey: string;
    contentType: string;
    accessKeyId: string;
    accessKeySecret: string;
    expiresAt: Date;
  }) {
    const expires = Math.floor(input.expiresAt.getTime() / 1000);
    const canonicalResource = `/${input.bucket}/${input.objectKey}`;
    const stringToSign = `PUT\n\n${input.contentType}\n${expires}\n${canonicalResource}`;
    const signature = createHmac('sha1', input.accessKeySecret).update(stringToSign).digest('base64');
    const query = new URLSearchParams({
      OSSAccessKeyId: input.accessKeyId,
      Expires: String(expires),
      Signature: signature,
    });
    return `https://${input.bucket}.oss-${input.regionId}.aliyuncs.com/${this.encodeObjectKey(input.objectKey)}?${query.toString()}`;
  }

  private encodeObjectKey(value: string) {
    return value.split('/').map((item) => encodeURIComponent(item)).join('/');
  }

  private getOssEndpoint(context: CloudAccountContextCredentials) {
    return `https://${context.imageImportBucket}.oss-${context.regionId}.aliyuncs.com`;
  }

  private normalizeSourceFileName(value: string) {
    const normalized = value.trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');

    if (!normalized) {
      throw new BadRequestException('镜像文件名无效。');
    }

    return normalized.slice(0, 180);
  }

  private assertSourceFileMatchesFormat(sourceFileName: string, imageFormat: ImageImportJobRow['imageFormat']) {
    const extension = sourceFileName.split('.').pop()?.toLowerCase();

    if (!extension || extension !== imageFormat) {
      throw new BadRequestException(`镜像文件扩展名必须为 .${imageFormat}。`);
    }
  }

  private async cancelExpiredUpload(job: ImageImportJobRow) {
    const cancelled = await this.prisma.imageImportJob.update({
      where: { id: job.id },
      data: {
        status: 'cancelled',
        errorMessage: '上传地址已过期，临时镜像文件已进入清理流程。',
      },
    });
    await this.cleanupTerminalObject(cancelled);
  }

  private async cleanupTerminalObject(job: ImageImportJobRow) {
    if (job.temporaryObjectDeletedAt) {
      return job;
    }

    try {
      const context = await this.cloudAccountContextsService.getCredentials(job.cloudAccountContextId, { requireReady: true });
      return this.cleanupTemporaryObject(context, job);
    } catch (error) {
      const message = error instanceof Error ? error.message : '临时 OSS 文件清理失败。';
      return this.prisma.imageImportJob.update({
        where: { id: job.id },
        data: { errorMessage: this.withCleanupError(job.errorMessage, message) },
      });
    }
  }

  private async cleanupTerminalArtifacts(job: ImageImportJobRow) {
    try {
      const context = await this.cloudAccountContextsService.getCredentials(job.cloudAccountContextId, { requireReady: true });
      const imageCleaned =
        job.status === 'failed' && job.imageId && !job.cloudImageDeletedAt
          ? await this.cleanupFailedCloudImage(context, job)
          : job;

      return this.cleanupTemporaryObject(context, imageCleaned);
    } catch (error) {
      const message = error instanceof Error ? error.message : '镜像导入终态资源清理失败。';
      return this.prisma.imageImportJob.update({
        where: { id: job.id },
        data: { errorMessage: this.withTerminalCleanupError(job.errorMessage, message) },
      });
    }
  }

  private async cleanupFailedCloudImage(context: CloudAccountContextCredentials, job: ImageImportJobRow) {
    if (job.status !== 'failed' || !job.imageId || job.cloudImageDeletedAt) {
      return job;
    }

    try {
      await this.performAliyunEcsRequest({
        ...context,
        action: 'DeleteImage',
        parameters: {
          ImageId: job.imageId,
          Force: 'true',
        },
      });
    } catch (error) {
      if (!this.isAliyunImageAlreadyDeleted(error)) {
        throw error;
      }
    }

    const releasedAt = new Date();
    const ledgerResources = await this.adminRepository.listBillingLedgerResources();
    await Promise.all(
      ledgerResources
        .filter(
          (item) =>
            item.cloudResourceId === job.imageId &&
            (item.cloudResourceType === 'image' || item.cloudResourceType === 'snapshot') &&
            item.releasedAt === null,
        )
        .map((item) => this.adminRepository.updateBillingLedgerResource(item.id, { releasedAt })),
    );

    if (job.sourceSnapshotId) {
      await this.adminRepository.deletePlatformImageAssetsBySnapshotId(job.sourceSnapshotId);
    } else if (job.platformImageAssetId) {
      await this.adminRepository.deletePlatformImageAsset(job.platformImageAssetId);
    }

    return this.prisma.imageImportJob.update({
      where: { id: job.id },
      data: {
        cloudImageDeletedAt: releasedAt,
        errorMessage: this.withoutTerminalCleanupErrors(job.errorMessage),
      },
    });
  }

  private async cleanupTemporaryObject(context: CloudAccountContextCredentials, job: ImageImportJobRow) {
    if (job.temporaryObjectDeletedAt) {
      return job;
    }

    const deleted = await this.deleteOssObject(context, job.objectKey);

    if (!deleted) {
      throw new Error('删除 OSS 临时镜像文件失败。');
    }

    return this.prisma.imageImportJob.update({
      where: { id: job.id },
      data: {
        temporaryObjectDeletedAt: new Date(),
        ...(job.status === 'available' ? { errorMessage: null } : {}),
        ...(job.status === 'failed' ? { errorMessage: this.withoutCleanupError(job.errorMessage) } : {}),
      },
    });
  }

  private readMaxUploadBytes() {
    const parsed = Number(process.env.IMAGE_IMPORT_MAX_BYTES);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_IMAGE_IMPORT_MAX_BYTES;
  }

  private readMaxImportDurationMs() {
    const parsed = Number(process.env.IMAGE_IMPORT_MAX_DURATION_MS);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_IMAGE_IMPORT_MAX_DURATION_MS;
  }

  private hasExceededImportDuration(job: ImageImportJobRow) {
    return (
      job.uploadCompletedAt !== null &&
      Date.now() - job.uploadCompletedAt.getTime() > this.readMaxImportDurationMs()
    );
  }

  private async finalizeImport(
    context: CloudAccountContextCredentials,
    job: ImageImportJobRow,
    status: 'available' | 'failed',
    errorMessage: string | null,
  ) {
    const terminal = await this.prisma.imageImportJob.update({
      where: { id: job.id },
      data: { status, errorMessage },
    });

    return this.cleanupTerminalArtifacts(terminal);
  }

  private async failTimedOutImport(job: ImageImportJobRow) {
    const terminal = await this.prisma.imageImportJob.update({
      where: { id: job.id },
      data: {
        status: 'failed',
        errorMessage: `镜像导入超过最大等待时长（${this.readMaxImportDurationMs()} 毫秒）。`,
      },
    });
    return this.cleanupTerminalArtifacts(terminal);
  }

  private withCleanupError(existingMessage: string | null, cleanupMessage: string) {
    return [this.withoutCleanupError(existingMessage), `临时 OSS 文件清理失败：${cleanupMessage}`].filter(Boolean).join('\n');
  }

  private withoutCleanupError(message: string | null) {
    return (
      message
        ?.split('\n')
        .filter((line) => !line.startsWith('临时 OSS 文件清理失败：'))
        .join('\n')
        .trim() || null
    );
  }

  private withTerminalCleanupError(existingMessage: string | null, cleanupMessage: string) {
    return [this.withoutTerminalCleanupErrors(existingMessage), `镜像导入终态资源清理失败：${cleanupMessage}`]
      .filter(Boolean)
      .join('\n');
  }

  private withoutTerminalCleanupErrors(message: string | null) {
    return (
      message
        ?.split('\n')
        .filter(
          (line) =>
            !line.startsWith('临时 OSS 文件清理失败：') &&
            !line.startsWith('镜像导入终态资源清理失败：'),
        )
        .join('\n')
        .trim() || null
    );
  }

  private isAliyunImageAlreadyDeleted(error: unknown) {
    return error instanceof Error && /InvalidImageId\.NotFound|InvalidImageId\.NotFound/i.test(error.message);
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

  private toView(job: ImageImportJobRow): ImageImportJobView {
    const { defaultPassword: _defaultPassword, objectKey: _objectKey, sourceSizeBytes, ...rest } = job;
    return {
      ...rest,
      sourceSizeBytes: Number(sourceSizeBytes),
    };
  }
}

type AliyunImage = {
  ImageId?: string;
  ImageName?: string;
  OSType?: string;
  Platform?: string;
  Architecture?: string;
  Status?: string;
  Progress?: string;
};
