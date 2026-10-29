import { createHmac, randomUUID } from 'node:crypto';

import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { runInSystemCloudWorkspaceScope } from '../auth/cloud-workspace-scope';
import { listExecutionCloudWorkspaces, runInExecutionCloudWorkspace } from '../auth/background-cloud-workspace';
import { SystemConfigService } from './system-config.service';

import { ADMIN_REPOSITORY, type AdminRepository, type CloudImageSnapshotRecord } from './admin.repository';
import type { SessionUserProfile } from './admin-user-auth';
import { CloudAccountContextsService, type CloudAccountContextCredentials } from './cloud-account-contexts.service';
import { CreateImageImportDto } from './dto/image-import.dto';
import { buildAliyunTagParameters, buildBillingTags } from './billing-tagging';
import { encryptPlatformImageDefaultPassword } from './platform-image-password';
import { imageRpc, cloudItems, cloudPage, cloudTags, AliyunImageRpcError } from './aliyun-image-rpc';
import { PrismaService } from '../database/prisma.service';
import { requestTencentCloud, TencentCloudRequestError } from './tencent-cloud-client';
import { COS_MAX_SIGNATURE_TTL_SECONDS, COS_SINGLE_PUT_MAX_BYTES } from './tencent-cos-client';
import { describeTencentImages, describeTencentSnapshot, tagTencentImageResources, deleteTencentImage, deleteTencentSnapshot, tencentImageRequest, type TencentSnapshot } from './tencent-image-rpc';
type ManagedCosBucket = { id: string; bucketName: string; cloudWorkspaceId: string; cloudAccountContextId: string; cloudAccountUid: string; appId: string; regionId: string; cloudProvider: 'tencent_cloud' };
type CosObjectInput = { contextCredentials: CloudAccountContextCredentials; bucketName: string; objectKey: string; method: 'PUT' | 'GET' | 'HEAD' | 'DELETE'; headers?: Record<string,string>; expiresAt?: Date };
type ManagedCosBuckets = { withImportBucket<T>(input: { cloudAccountContextId: string; creatorUserId: string }, work: (bucket: ManagedCosBucket) => Promise<T>): Promise<T>;
  getOwnedBucket(input: { bucketId: string; cloudAccountContextId: string; cloudAccountUid: string; regionId: string }): Promise<ManagedCosBucket>;
  cleanupIfIdle(input: { bucketId: string; cloudAccountContextId: string; cloudAccountUid: string; regionId: string }): Promise<unknown>;
  presignObject(input: CosObjectInput): Promise<{ url: string; headers: Record<string,string> }>;
  requestObject(input: CosObjectInput): Promise<Response>;
  refreshPendingBuckets?(): Promise<unknown> };


const IMAGE_IMPORT_UPLOAD_TTL_MS = 30 * 60 * 1000;
const IMAGE_IMPORT_UPLOAD_DRAIN_MS = 5 * 60 * 1000;
const DEFAULT_IMAGE_IMPORT_MAX_BYTES = 4 * 1024 * 1024 * 1024;
const DEFAULT_IMAGE_IMPORT_MAX_DURATION_MS = 24 * 60 * 60 * 1000;

type ImageImportJobRow = {
  cloudProvider?: 'alibaba_cloud' | 'tencent_cloud';
  managedBucketId?: string | null;
  sourceObjectProof?: unknown;
  sourceDiskIds?: unknown;
  osVersion?: string | null;
  cloudWorkspaceId?: string;
  id: string;
  cloudAccountContextId: string;
  cloudAccountUid: string | null;
  regionId: string | null;
  imageImportBucket: string | null;
  backingSnapshotIds: string[];
  deletedSnapshotIds: string[];
  snapshotCleanupCompletedAt: Date | null;
  leaseToken: string | null;
  leaseExpiresAt: Date | null;
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
  submissionRejected: boolean;
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

export type ImageImportJobView = Omit<ImageImportJobRow, 'sourceObjectProof' | 'defaultPassword' | 'objectKey' | 'sourceSizeBytes' | 'leaseToken' | 'leaseExpiresAt'> & {
  sourceSizeBytes: number;
};

@Injectable()
export class ImageImportsService {
  constructor(
    @Inject(ADMIN_REPOSITORY) private readonly adminRepository: AdminRepository,
    private readonly prisma: PrismaService,
    private readonly cloudAccountContextsService: CloudAccountContextsService,
    @Optional() private readonly systemConfigService?: SystemConfigService,
    @Optional() @Inject('TENCENT_COS_BUCKETS') private readonly cosBuckets?: ManagedCosBuckets,
  ) {}

  async createUpload(input: CreateImageImportDto, currentUser: SessionUserProfile) {
    const sourceSizeBytes = Math.trunc(input.sourceSizeBytes);

    if (!Number.isSafeInteger(sourceSizeBytes) || sourceSizeBytes <= 0 || sourceSizeBytes > this.readMaxUploadBytes()) {
      throw new BadRequestException(`镜像文件超出单次上传上限（${this.readMaxUploadBytes()} 字节）。`);
    }

    const initial = await this.cloudAccountContextsService.getCredentials(input.cloudContextId, { requireReady: true, requireActive: true });
    this.assertImportFormat(initial.provider, input.imageFormat);
    if (initial.provider === 'tencent_cloud') this.assertTencentImportLimits(sourceSizeBytes);
    const now = new Date(), uploadExpiresAt = new Date(now.getTime() + IMAGE_IMPORT_UPLOAD_TTL_MS);
    const sourceFileName = this.normalizeSourceFileName(input.sourceFileName);
    this.assertSourceFileMatchesFormat(sourceFileName, input.imageFormat);
    const objectKey = `image-imports/${currentUser.id}/${randomUUID()}/${sourceFileName}`;
    const contentType = input.sourceContentType?.trim() || 'application/octet-stream';
    if (contentType.length > 256 || /[\r\n]/.test(contentType)) throw new BadRequestException('镜像内容类型无效。');
    const password = encryptPlatformImageDefaultPassword(input.defaultPassword);
    const create = async (cloudContext: CloudAccountContextCredentials, bucket?: ManagedCosBucket) => {
      const job = await this.prisma.imageImportJob.create({ data: {
        cloudProvider: cloudContext.provider, managedBucketId: bucket?.id, osVersion: input.osVersion?.trim() || null,
        cloudAccountContextId: cloudContext.id, cloudAccountUid: cloudContext.accountUid, regionId: cloudContext.regionId,
        imageImportBucket: bucket?.bucketName ?? cloudContext.imageImportBucket, ownerUserId: currentUser.id,
        displayName: input.displayName.trim(), defaultHostName: input.defaultHostName?.trim() || null, defaultPassword: password,
        description: input.description?.trim() || null, osType: input.osType, platform: input.platform?.trim() || null,
        architecture: input.architecture, bootMode: input.bootMode, imageFormat: input.imageFormat, systemDiskSize: input.systemDiskSize,
        sourceFileName, sourceContentType: contentType, sourceSizeBytes: String(sourceSizeBytes), objectKey, uploadExpiresAt } });
      const signed = bucket ? await this.requireCos().presignObject({ contextCredentials: cloudContext, bucketName: bucket.bucketName, objectKey, method: 'PUT', expiresAt: uploadExpiresAt,
        headers: { 'content-type': contentType, 'content-length': String(sourceSizeBytes), 'x-cos-forbid-overwrite': 'true',
          'x-cos-meta-platform-image-job': job.id, 'x-cos-meta-platform-image-owner': job.ownerUserId, 'x-cos-meta-platform-cloud-context': job.cloudAccountContextId } })
        : { url: this.createPresignedPutUrl({ bucket: cloudContext.imageImportBucket, regionId: cloudContext.regionId, objectKey, contentType,
            accessKeyId: cloudContext.accessKeyId, accessKeySecret: cloudContext.accessKeySecret, expiresAt: uploadExpiresAt }), headers: { 'Content-Type': contentType } };
      return { job: this.toView(job), upload: { method: 'PUT' as const, url: signed.url, headers: signed.headers, expiresAt: uploadExpiresAt } };
    };
    if (initial.provider === 'tencent_cloud') {
      await this.validateTencentImportOs(initial, input);
      return this.requireCos().withImportBucket({ cloudAccountContextId: initial.id, creatorUserId: currentUser.id }, bucket => create(initial, bucket));
    }
    return create(await this.cloudAccountContextsService.getCredentials(input.cloudContextId, { requireReady: true, requireActive: true, requireImageImportBucket: true }));
  }

  async completeUpload(id: string, currentUser: SessionUserProfile) {
    await this.getAccessibleJob(id, currentUser);
    return this.withClaim(id, job => this.completeUploadClaimed(job));
  }

  private async completeUploadClaimed(job: ImageImportJobRow) {
    if (job.status !== 'awaiting_upload') {
      return this.toView(job);
    }

    if (job.uploadExpiresAt <= new Date()) {
      throw new BadRequestException('上传地址已过期，请重新发起镜像上传。');
    }

    const context = await this.boundContext(job);
    if (context.provider === 'tencent_cloud') this.assertTencentImportLimits(Number(job.sourceSizeBytes));
    const uploadedObject = await this.headOssObject(context, job.objectKey, job);

    if (!uploadedObject) {
      throw new BadRequestException('对象存储中未找到已上传的镜像文件，请完成上传后再导入。');
    }

    const expectedSizeBytes = Number(job.sourceSizeBytes);

    if (uploadedObject.contentLength !== expectedSizeBytes) {
      await this.deleteOssObject(context, job.objectKey).catch(() => false);
      throw new BadRequestException('上传文件大小与提交信息不一致，请重新上传镜像文件。');
    }

    if (context.provider === 'tencent_cloud' && uploadedObject) job = await this.updateJob(job, { sourceObjectProof: uploadedObject });
    // Persist intent before the request: a timeout/crash must never become a fresh import.
    job = await this.updateJob(job, { status: 'importing', submissionRejected: false, uploadCompletedAt: job.uploadCompletedAt ?? new Date(), errorMessage: null });
    let imageId: string;
    let taskId: string | null;

    try {
      const response = await this.importImage(context, job);
      imageId = response.ImageId?.trim() ?? '';

      if (!imageId) {
        throw new Error('云端 ImportImage 未返回 ImageId。');
      }
      taskId = response.TaskId?.trim() || null;
    } catch (error) {
      const message = error instanceof Error ? error.message : '镜像导入请求失败。';
      // Only explicit pre-submission rejections with an official receipt allow a new request.
      // Internal errors, malformed responses and timeouts remain unknown and must be reconciled.
      // https://cloud.tencent.com/document/api/213/15717
      const rejected = error instanceof TencentCloudRequestError ? Boolean(error.requestId) && /^(UnauthorizedOperation|AuthFailure|InvalidParameter|InvalidParameterValue|MissingParameter|UnknownParameter|InvalidImageName|InvalidImageOsType|InvalidImageOsVersion|ImageQuotaLimitExceeded|RequestLimitExceeded|OperationDenied|RegionAbilityLimit\.UnsupportedToImportImage)(?:[.]|$)/.test(error.code) : error instanceof AliyunImageRpcError && /^(Forbidden(?:\.|$)|InvalidParameter(?:\.|$)|MissingParameter(?:\.|$)|InvalidAccessKeyId(?:\.|$)|SignatureDoesNotMatch(?:\.|$)|Throttling(?:\.|$))/.test(error.cloudCode ?? '');
      const retryable = await this.updateJob(job, rejected
        ? { status: 'failed', submissionRejected: true, errorMessage: message }
        : { errorMessage: `导入提交结果未确认，正在按来源标记恢复；禁止重复提交。${message}` });
      return this.toView(retryable);
    }

    const importing = await this.updateJob(job, { imageId, taskId, errorMessage: null });

    try {
      return this.toView(await this.ensureImportArtifacts(context, importing));
    } catch (error) {
      const message = error instanceof Error ? error.message : '镜像导入元数据同步失败。';
      const pending = await this.updateJob(importing, { errorMessage: message });
      return this.toView(pending);
    }
  }

  async get(id: string, currentUser: SessionUserProfile) {
    return this.toView(await this.getAccessibleJob(id, currentUser));
  }

  async retry(id: string, currentUser: SessionUserProfile) {
    await this.getAccessibleJob(id, currentUser);
    return this.withClaim(id, async job => {
      if (job.status === 'awaiting_upload') return this.completeUploadClaimed(job);
      if (job.status !== 'failed' || job.imageId) throw new BadRequestException('仅可核验尚未获得云端 ImageId 的失败导入任务。');
      if (job.submissionRejected) {
        if (job.uploadExpiresAt <= new Date()) throw new BadRequestException('上传地址已过期，请重新上传镜像文件。');
        return this.completeUploadClaimed(await this.updateJob(job, { status: 'awaiting_upload' }));
      }
      // Legacy failed submissions may already have a cloud image. Never issue ImportImage again.
      const pending = await this.updateJob(job, { status: 'importing', errorMessage: '正在核验原导入结果，不会重复创建镜像。' });
      return this.refreshImportClaimed(pending);
    });
  }

  async list(currentUser: SessionUserProfile) {
    const jobs = await this.prisma.imageImportJob.findMany({
      where: { ownerUserId: currentUser.id },
      orderBy: { createdAt: 'desc' },
    });
    return { items: jobs.map((job) => this.toView(job)) };
  }

  async refreshImport(id: string) {
    return this.withClaim(id, job => this.refreshImportClaimed(job));
  }

  private async refreshImportClaimed(existingJob: ImageImportJobRow) {
    if (existingJob.status === 'failed' && !existingJob.imageId && !existingJob.submissionRejected) existingJob = await this.updateJob(existingJob, { status: 'importing' });
    if (existingJob.status !== 'importing') return this.toView(existingJob);
    let job = await this.updateJob(existingJob, { lastPolledAt: new Date() });
    try {
      const context = await this.boundContext(job);
      if (!job.imageId) {
        job = await this.recoverSubmission(context, job);
        if (!job.imageId) return this.toView(job);
      }
      const image = await this.describeImage(context, job.imageId!);

      if (!image) {
        return this.toView(job);
      }

      const rawStatus = image.Status?.trim() || 'Creating';
      const status = this.buildSnapshotStatus(image) ?? rawStatus;
      const isAvailable = rawStatus === 'Available';
      const failed = /Failed|Error|Unavailable/i.test(rawStatus);
      if (!isAvailable && !failed && this.hasExceededImportDuration(job)) return this.toView(await this.failTimedOutImport(job));
      const importJob = await this.ensureImportArtifacts(context, job);
      const syncedAt = new Date();
      await this.adminRepository.upsertImageSnapshots({
        provider: context.provider,
        accountUid: context.accountUid,
        regionId: context.regionId,
        scope: 'custom',
        snapshots: [
          {
            imageId: importJob.imageId!,
            sourceImageName: image.ImageName?.trim() || importJob.displayName,
            minimumSystemDiskSize: image.ImageSize,
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
          failed ? `云镜像导入失败：${status}` : null,
        ),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : '镜像导入状态同步失败。';
      const pending = await this.updateJob(job, { errorMessage: message });
      return this.toView(pending);
    }
  }

  async refreshPendingImports() {
    const spaces = await runInSystemCloudWorkspaceScope(() => listExecutionCloudWorkspaces(this.systemConfigService));
    const workspaceFilter = spaces ? { cloudWorkspaceId: { in: spaces.map(space => space.id) } } : {};
    const [jobs, expiredUploads, terminalJobs] = await runInSystemCloudWorkspaceScope(() => this.listPendingImports(workspaceFilter));
    const polling = await Promise.allSettled(jobs.map(job => runInExecutionCloudWorkspace(this.systemConfigService, job.cloudWorkspaceId,
      () => this.refreshImport(job.id), { provider: job.cloudProvider ?? 'alibaba_cloud', accountUid: job.cloudAccountUid })));
    const expired = await Promise.allSettled(expiredUploads.map(job => runInExecutionCloudWorkspace(this.systemConfigService, job.cloudWorkspaceId,
      () => this.withClaim(job.id, fresh => this.cancelExpiredUpload(fresh)), { provider: job.cloudProvider ?? 'alibaba_cloud', accountUid: job.cloudAccountUid })));
    const terminal = await Promise.allSettled(terminalJobs.map(job => runInExecutionCloudWorkspace(this.systemConfigService, job.cloudWorkspaceId,
      () => this.withClaim(job.id, fresh => this.cleanupTerminalArtifacts(fresh)), { provider: job.cloudProvider ?? 'alibaba_cloud', accountUid: job.cloudAccountUid })));
    if ([...polling, ...expired, ...terminal].some(result => result.status === 'rejected')) {
      throw new Error('Image import polling failed for a source workspace; other pending jobs were still processed');
    }
    return jobs.length + expiredUploads.length + terminalJobs.length;
  }

  async refreshManagedBuckets() {
    return this.cosBuckets?.refreshPendingBuckets?.();
  }

  private async listPendingImports(workspaceFilter: { cloudWorkspaceId?: { in: string[] } }) {
    const [jobs, expiredUploads, terminalJobs] = await Promise.all([
      this.prisma.imageImportJob.findMany({
        where: { ...workspaceFilter, OR: [{ status: 'importing' }, { status: 'failed', imageId: null, submissionRejected: false }] },
        select: { id: true, cloudWorkspaceId: true, cloudAccountUid: true, cloudProvider: true },
        take: 20,
        orderBy: [
          { lastPolledAt: { sort: 'asc', nulls: 'first' } },
          { createdAt: 'asc' },
        ],
      }),
      this.prisma.imageImportJob.findMany({
        where: {
          ...workspaceFilter,
          OR: [
            { status: 'awaiting_upload', OR: [{ uploadCompletedAt: null }, { submissionRejected: true }] },
            { status: 'failed', submissionRejected: true },
          ],
          imageId: null,
          uploadExpiresAt: { lt: new Date() },
        },
        take: 20,
        orderBy: { uploadExpiresAt: 'asc' },
      }),
      this.prisma.imageImportJob.findMany({
        where: {
          ...workspaceFilter,
          OR: [
            {
              temporaryObjectDeletedAt: null,
              uploadExpiresAt: { lt: new Date(Date.now() - IMAGE_IMPORT_UPLOAD_DRAIN_MS) },
              OR: [
                { status: { in: ['available', 'cancelled'] } },
                { status: 'failed', imageId: { not: null } },
              ],
            },
            {
              snapshotCleanupCompletedAt: null,
              status: 'failed',
              imageId: { not: null },
            },
          ],
        },
        take: 20,
        orderBy: { updatedAt: 'asc' },
      }),
    ]);
    return [jobs, expiredUploads, terminalJobs] as const;
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

  private async ensureImportArtifacts(context: ImportContext, job: ImageImportJobRow) {
    if (!job.imageId) {
      throw new Error('镜像导入任务缺少云端 ImageId。');
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
      const snapshotIds = await this.tagImportedImageAndSnapshots(context, job, linkedPlatformImageAsset.id);
      return { ...job, backingSnapshotIds: snapshotIds };
    }

    const syncedAt = new Date();
    await this.adminRepository.upsertImageSnapshots({
      provider: context.provider,
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
    job = await this.updateJob(job, { sourceSnapshotId: snapshot.id, platformImageAssetId: platformImageAsset.id, errorMessage: null });
    const snapshotIds = await this.tagImportedImageAndSnapshots(context, job, platformImageAsset.id);
    return { ...job, backingSnapshotIds: snapshotIds };
  }

  private async syncImportedImageBillingLedger(input: {
    imageId: string;
    snapshotIds: string[];
    platformImageAssetId: string;
    regionId: string;
    accountUid: string;
    billingStartAt: Date;
    imageImportJobId: string;
    cloudProvider: 'alibaba_cloud' | 'tencent_cloud';
  }) {
    const tagsSnapshot = buildBillingTags({
      billingScope: 'platform',
      platformImageAssetId: input.platformImageAssetId || null,
      platformImageImportJobId: input.imageImportJobId,
      billingStartAt: input.billingStartAt,
    });
    const legacySnapshotLedger = await this.adminRepository.findBillingLedgerResource({
      cloudProvider: input.cloudProvider,
      regionId: input.regionId,
      cloudResourceId: input.imageId,
      cloudResourceType: 'snapshot',
    });

    if (legacySnapshotLedger?.cloudAccountUid === input.accountUid && !input.snapshotIds.includes(input.imageId)) {
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
        cloudProvider: input.cloudProvider,
        regionId: input.regionId,
        cloudResourceId: resource.cloudResourceId,
        cloudResourceType: resource.cloudResourceType,
      });

      if (existing && (existing.cloudAccountUid !== input.accountUid || (existing.tagsSnapshot.PlatformImageImportJobId && existing.tagsSnapshot.PlatformImageImportJobId !== input.imageImportJobId))) throw new ConflictException('镜像台账云账号或导入来源不一致，拒绝覆盖。');
      if (existing) {
        await this.adminRepository.updateBillingLedgerResource(existing.id, {
          billingScope: 'platform',
          ownerUserId: null,
          platformImageAssetId: input.platformImageAssetId || null,
          releasedAt: null,
          tagsSnapshot,
        });
        continue;
      }

      await this.adminRepository.createBillingLedgerResource({
        cloudProvider: input.cloudProvider,
        cloudAccountUid: input.accountUid,
        regionId: input.regionId,
        cloudResourceId: resource.cloudResourceId,
        cloudResourceType: resource.cloudResourceType,
        billingScope: 'platform',
        ownerUserId: null,
        platformImageAssetId: input.platformImageAssetId || null,
        billingStartAt: input.billingStartAt,
        tagsSnapshot,
      });
    }
  }

  private async resolveSnapshot(context: ImportContext, imageId: string): Promise<CloudImageSnapshotRecord> {
    const [snapshot] = await this.adminRepository.listImageSnapshots({
      provider: context.provider,
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

  private async importImage(context: ImportContext, job: ImageImportJobRow) {
    this.assertImportFormat(context.provider, job.imageFormat);
    if (context.provider === 'tencent_cloud') {
      this.assertTencentObjectProof(job);
      if (!job.platform || !job.osVersion || !job.sourceObjectProof) throw new ConflictException('腾讯云导入缺少明确 OS 版本或已上传对象来源证明。');
      const signed = await this.requireCos().presignObject({ contextCredentials: context, bucketName: context.imageImportBucket, objectKey: job.objectKey, method: 'GET', expiresAt: new Date(Date.now() + this.readMaxImportDurationMs()) });
      const tags = { ...buildBillingTags({ billingScope: 'platform', platformResourceType: 'image', platformImageImportJobId: job.id, billingStartAt: job.uploadCompletedAt ?? job.createdAt }),
        CloudProvider: 'tencent_cloud', CloudAccountUid: context.accountUid, CloudAccountContextId: context.id,
        CyberRangeOwnerUserId: job.ownerUserId, CyberRangeCloudContextId: job.cloudAccountContextId };
      await this.assertClaim(context);
      return tencentImageRequest<{ ImageId?: string; TaskId?: string }>(context, 'cvm', 'ImportImage', { ImageName: job.displayName,
        ...(job.description ? { ImageDescription: job.description } : {}), Architecture: job.architecture === 'arm64' ? 'arm_64' : job.architecture,
        OsType: job.platform, OsVersion: job.osVersion, ImageUrl: signed.url, BootMode: job.bootMode === 'BIOS' ? 'Legacy BIOS' : 'UEFI', Force: false,
        TagSpecification: [{ ResourceType: 'image', Tags: Object.entries(tags).map(([Key,Value]) => ({Key,Value})) }] });
    }
    const billingTags = buildBillingTags({
      billingScope: 'platform',
      platformResourceType: 'image',
      platformImageImportJobId: job.id,
      billingStartAt: job.uploadCompletedAt ?? job.createdAt,
    });
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
      ...buildAliyunTagParameters({
        ...billingTags,
        CyberRangeOwnerUserId: job.ownerUserId,
        CyberRangeCloudContextId: job.cloudAccountContextId,
      }),
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

  private async describeImages(context: ImportContext, parameters: Record<string, string>) {
    if (context.provider === 'tencent_cloud') { await this.assertClaim(context); return describeTencentImages(context, parameters.ImageId ? { ImageId: parameters.ImageId } : {
      ...(parameters.SnapshotId ? { SnapshotId: parameters.SnapshotId } : {}), ...(parameters['Tag.1.Key'] ? { tags: { [parameters['Tag.1.Key']]: parameters['Tag.1.Value'] } } : {}) }); }
    const images: AliyunImage[] = [];
    let page = 1, expectedTotal: number | undefined;
    do {
      const body = await this.performAliyunEcsRequest<unknown>({ ...context, action: 'DescribeImages', parameters: { Status: 'ALL', ImageOwnerAlias: 'self', PageSize: '100', PageNumber: String(page), ...parameters } });
      const items = cloudItems<AliyunImage>(body, 'Images', 'Image');
      const total = cloudPage(body, page, 100, items.length);
      if ((expectedTotal !== undefined && total !== expectedTotal) || (items.length === 0 && images.length < total)
        || items.some(image => !image.ImageId?.startsWith('m-') || !image.Status || (parameters.ImageId && image.ImageId !== parameters.ImageId))) throw new Error('镜像查询身份或分页不完整。');
      expectedTotal = total;
      images.push(...items);
      page++;
    } while (images.length < expectedTotal!);
    if (images.length !== expectedTotal || new Set(images.map(image => image.ImageId)).size !== images.length) throw new Error('镜像查询返回重复或不完整结果。');
    return images;
  }

  private async describeImage(context: ImportContext, imageId: string) {
    const images = await this.describeImages(context, { ImageId: imageId });
    if (images.length > 1) throw new Error('镜像身份不唯一。');
    return images[0] ?? null;
  }

  private assertImageOwnership(job: ImageImportJobRow, image: AliyunImage) {
    const tags = cloudTags(image.Tags);
    if (job.cloudProvider === 'tencent_cloud' && (tags.CloudProvider !== 'tencent_cloud' || tags.CloudAccountUid !== job.cloudAccountUid || tags.CloudAccountContextId !== job.cloudAccountContextId)) throw new ConflictException('腾讯云导入镜像缺少冻结厂商与账号来源证明。');
    if ((job.imageId && image.ImageId !== job.imageId) || tags.CreatedBy !== 'cyber-range-platform'
      || tags.PlatformImageImportJobId !== job.id || tags.CyberRangeOwnerUserId !== job.ownerUserId
      || tags.CyberRangeCloudContextId !== job.cloudAccountContextId) throw new ConflictException('导入镜像来源或 owner 证明不匹配。');
  }

  private async recoverSubmission(context: ImportContext, job: ImageImportJobRow) {
    const images = await this.describeImages(context, { 'Tag.1.Key': 'PlatformImageImportJobId', 'Tag.1.Value': job.id });
    if (images.length === 0) return this.updateJob(job, { errorMessage: '导入提交结果仍未确认，保留对象存储和恢复记录；不会重复创建。' });
    if (images.length !== 1) throw new ConflictException('原导入来源匹配多个镜像，需核验后处理。');
    this.assertImageOwnership(job, images[0]);
    return this.updateJob(job, { imageId: images[0].ImageId!, errorMessage: null });
  }

  private async tagImportedImageAndSnapshots(
    context: ImportContext,
    job: ImageImportJobRow,
    platformImageAssetId: string,
  ) {
    if (!job.imageId) {
      throw new Error('镜像导入任务缺少云端 ImageId。');
    }

    const imageTags = buildBillingTags({
      billingScope: 'platform',
      platformImageAssetId,
      platformResourceType: 'image',
      platformImageImportJobId: job.id,
      billingStartAt: job.uploadCompletedAt ?? job.createdAt,
    });
    const image = await this.describeImage(context, job.imageId);
    if (!image) throw new Error('云镜像暂不可见，保留导入状态等待核验。');
    this.assertImageOwnership(job, image);
    const snapshotIds = extractImageSnapshotIds(image);
    if (image.Status === 'Available' && snapshotIds.length === 0) throw new Error('可用镜像缺少 backing snapshot，等待完整结果。');
    const known = job.backingSnapshotIds;
    if (known.some(id => !snapshotIds.includes(id))) throw new Error('导入镜像已记录的快照绑定发生变化。');
    // Save identities before tagging or ledger writes, so failures cannot lose billable resources.
    await this.updateJob(job, { backingSnapshotIds: snapshotIds });
    for (const sid of snapshotIds) {
      const snapshot = await this.describeSnapshot(context, sid);
      if (!snapshot) throw new Error('导入快照暂不可见。');
      const tags = cloudTags(snapshot.Tags);
      if (context.provider === 'tencent_cloud') {
        const proof = snapshot as TencentSnapshot;
        if (snapshotIds.length !== 1 || !job.sourceObjectProof || proof.CopyFromRemote || proof.SnapshotType !== 'PRIVATE_SNAPSHOT' || proof.ShareReference !== 0
          || proof.ImageIds.some(id => id !== job.imageId) || !proof.SourceDiskId.startsWith('disk-') || !Number.isFinite(Date.parse(proof.CreationTime))
          || Date.parse(proof.CreationTime) < (job.uploadCompletedAt ?? job.createdAt).getTime() - 30000 || Date.parse(proof.CreationTime) > Date.now() + 30000)
          throw new ConflictException('腾讯云导入快照缺少完整且新生成的私有来源证明。');
        if (Array.isArray(job.sourceDiskIds) && job.sourceDiskIds.length && (job.sourceDiskIds.length !== 1 || job.sourceDiskIds[0] !== proof.SourceDiskId)) throw new ConflictException('腾讯云导入源盘证明已发生变化。');
        job = await this.updateJob(job, { sourceDiskIds: [proof.SourceDiskId] });
      }
      if ((tags.PlatformImageImportJobId && tags.PlatformImageImportJobId !== job.id)
        || (tags.CreatedBy && tags.CreatedBy !== 'cyber-range-platform') || tags.PlatformPackedImageArtifactId
        || (tags.CyberRangeOwnerUserId && tags.CyberRangeOwnerUserId !== job.ownerUserId)) throw new ConflictException('导入快照已有其它来源，拒绝覆盖。');
    }
    await this.syncImportedImageBillingLedger({ imageId: job.imageId!, snapshotIds, platformImageAssetId, regionId: context.regionId, accountUid: context.accountUid, billingStartAt: job.uploadCompletedAt ?? job.createdAt, imageImportJobId: job.id, cloudProvider: context.provider });
    await this.tagEcsResources(context, 'image', [job.imageId!], imageTags);
    for (const sid of snapshotIds) await this.tagEcsResources(context, 'snapshot', [sid], { ...imageTags, PlatformResourceType: 'snapshot', CyberRangeOwnerUserId: job.ownerUserId, CyberRangeCloudContextId: job.cloudAccountContextId });
    return snapshotIds;
  }

  private async tagEcsResources(
    context: ImportContext,
    resourceType: 'image' | 'snapshot',
    resourceIds: string[],
    tags: Record<string, string>,
  ) {
    if (context.provider === 'tencent_cloud') { await this.assertClaim(context); return tagTencentImageResources(context, resourceType, resourceIds, tags); }
    await this.performAliyunEcsRequest({
      ...context,
      action: 'TagResources',
      parameters: {
        ResourceType: resourceType,
        ...buildAliyunArrayParameters('ResourceId', resourceIds),
        ...buildAliyunTagParameters(tags),
      },
    });
  }

  private async performAliyunEcsRequest<ResponsePayload>(input: ImportContext & { action: string; parameters: Record<string, string> }): Promise<ResponsePayload> {
    await this.assertClaim(input);
    if (input.provider === 'tencent_cloud') {
      if (input.action === 'DeleteImage') return deleteTencentImage(input, input.parameters.ImageId) as Promise<ResponsePayload>;
      if (input.action === 'DeleteSnapshot') return deleteTencentSnapshot(input, input.parameters.SnapshotId) as Promise<ResponsePayload>;
      throw new ConflictException('腾讯云导入 RPC 未匹配已核验的接口。');
    }
    return imageRpc<ResponsePayload>(input, input.action, input.parameters);
  }

  private async headOssObject(context: ImportContext, objectKey: string, job?: ImageImportJobRow) {
    const response = await this.ossRequest({ context, objectKey, method: 'HEAD' });

    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`对象存储文件核验失败（HTTP ${response.status}）。`);

    const contentLength = Number(response.headers.get('content-length'));
    if (context.provider === 'tencent_cloud') {
      if (!job || response.headers.get('x-cos-meta-platform-image-job') !== job.id || response.headers.get('x-cos-meta-platform-image-owner') !== job.ownerUserId
        || response.headers.get('x-cos-meta-platform-cloud-context') !== job.cloudAccountContextId || !response.headers.get('etag') || !Number.isSafeInteger(contentLength))
        throw new ConflictException('COS 上传对象的 job、owner、context 或大小证明不匹配。');
      return { provider: 'tencent_cloud', bucketId: job.managedBucketId!, bucketName: job.imageImportBucket!, objectKey, jobId: job.id, ownerUserId: job.ownerUserId,
        cloudAccountContextId: job.cloudAccountContextId, cloudAccountUid: job.cloudAccountUid!, regionId: job.regionId!, contentLength, etag: response.headers.get('etag')!, verifiedAt: new Date().toISOString() };
    }
    return {
      contentLength: Number.isSafeInteger(contentLength) && contentLength >= 0 ? contentLength : null,
    };
  }

  private async deleteOssObject(context: ImportContext, objectKey: string) {
    const response = await this.ossRequest({ context, objectKey, method: 'DELETE' });
    if (context.provider === 'tencent_cloud' && (response.ok || response.status === 404)) return (await this.ossRequest({ context, objectKey, method: 'HEAD' })).status === 404;
    return response.ok || response.status === 404;
  }

  private async ossRequest(input: {
    context: ImportContext;
    objectKey: string;
    method: 'HEAD' | 'DELETE';
  }) {
    await this.assertClaim(input.context);
    if (input.context.provider === 'tencent_cloud') return this.requireCos().requestObject({ contextCredentials: input.context, bucketName: input.context.imageImportBucket, objectKey: input.objectKey, method: input.method });
    const date = new Date().toUTCString();
    const canonicalResource = `/${input.context.imageImportBucket}/${input.objectKey}`;
    const stringToSign = `${input.method}\n\n\n${date}\n${canonicalResource}`;
    const signature = createHmac('sha1', input.context.accessKeySecret).update(stringToSign).digest('base64');
    return fetch(`${this.getOssEndpoint(input.context)}/${this.encodeObjectKey(input.objectKey)}`, {
      method: input.method,
      signal: AbortSignal.timeout(30_000),
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

  private getOssEndpoint(context: ImportContext) {
    return `https://${context.imageImportBucket}.oss-${context.regionId}.aliyuncs.com`;
  }

  private normalizeSourceFileName(value: string) {
    const normalized = value.trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');

    if (!normalized) {
      throw new BadRequestException('镜像文件名无效。');
    }

    return normalized.slice(0, 180);
  }

  private assertTencentImportLimits(sourceSizeBytes: number) {
    if (sourceSizeBytes > COS_SINGLE_PUT_MAX_BYTES) throw new BadRequestException('腾讯云当前上传方式仅支持不超过 5 GiB 的单个镜像文件。');
    if (this.readMaxImportDurationMs() > COS_MAX_SIGNATURE_TTL_SECONDS * 1000)
      throw new ConflictException('腾讯云导入等待时长超过平台 COS 下载授权的 24 小时上限，请调整 IMAGE_IMPORT_MAX_DURATION_MS 后重试。');
  }

  private assertImportFormat(provider: CloudAccountContextCredentials['provider'], imageFormat: string) {
    // Tencent imports VMDK directly; do not send that format through the Alibaba OSS import adapter.
    // https://cloud.tencent.com/document/api/213/15717
    const formats = provider === 'tencent_cloud' ? ['qcow2', 'raw', 'vhd', 'vmdk'] : ['qcow2', 'raw', 'vhd'];
    if (!formats.includes(imageFormat)) throw new BadRequestException(`当前云账号仅支持 ${formats.map(format => `.${format}`).join('、')} 镜像文件。`);
  }

  private assertSourceFileMatchesFormat(sourceFileName: string, imageFormat: ImageImportJobRow['imageFormat']) {
    const extension = sourceFileName.split('.').pop()?.toLowerCase();

    if (!extension || extension !== imageFormat) {
      throw new BadRequestException(`镜像文件扩展名必须为 .${imageFormat}。`);
    }
  }

  private async cancelExpiredUpload(job: ImageImportJobRow) {
    if (!((job.status === 'awaiting_upload' && (!job.uploadCompletedAt || job.submissionRejected)) || (job.status === 'failed' && job.submissionRejected)) || job.imageId || job.uploadExpiresAt > new Date()) return;
    const cancelled = await this.updateJob(job, { status: 'cancelled', errorMessage: '上传地址已过期，临时镜像文件已进入清理流程。' });
    await this.cleanupTerminalObject(cancelled);
  }

  private async cleanupTerminalObject(job: ImageImportJobRow) {
    if (job.temporaryObjectDeletedAt) {
      return job;
    }

    try {
      const context = await this.boundContext(job);
      return this.cleanupTemporaryObject(context, job);
    } catch (error) {
      const message = error instanceof Error ? error.message : '临时对象存储文件清理失败。';
      return this.updateJob(job, { errorMessage: this.withCleanupError(job.errorMessage, message) });
    }
  }

  private async cleanupTerminalArtifacts(job: ImageImportJobRow) {
    if (!['available', 'failed', 'cancelled'].includes(job.status) || (job.status === 'failed' && !job.imageId)) return job;
    try {
      const context = await this.boundContext(job);
      const imageCleaned =
        job.status === 'failed' && job.imageId && !job.snapshotCleanupCompletedAt
          ? await this.cleanupFailedCloudImage(context, job)
          : job;

      return this.cleanupTemporaryObject(context, imageCleaned);
    } catch (error) {
      const message = error instanceof Error ? error.message : '镜像导入终态资源清理失败。';
      return this.updateJob(job, { errorMessage: this.withTerminalCleanupError(job.errorMessage, message) });
    }
  }

  private async cleanupFailedCloudImage(context: ImportContext, job: ImageImportJobRow) {
    if (job.status !== 'failed' || !job.imageId || job.snapshotCleanupCompletedAt) return job;
    if (job.cloudImageDeletedAt && !job.backingSnapshotIds.length) throw new Error('旧清理记录缺少真实快照清单，不能认定所有计费资源已回收。');
    if (!job.cloudImageDeletedAt) {
      const image = await this.describeImage(context, job.imageId);
      if (image) {
        this.assertImageOwnership(job, image);
        if (context.provider === 'tencent_cloud' && image.Status !== 'Available' && !/Failed|UnAvailable/i.test(image.Status ?? '')) throw new ConflictException('腾讯云导入镜像操作尚未进入可清理终态。');
        const ids = extractImageSnapshotIds(image);
        if (!ids.length) throw new Error('导入镜像快照清单尚未完整，保留云镜像等待核验。');
        if (job.backingSnapshotIds.some(id => !ids.includes(id))) throw new Error('导入镜像快照绑定发生变化。');
        job = await this.updateJob(job, { backingSnapshotIds: ids });
        // Recover billing/ownership before deleting the only cloud-side mapping to snapshots.
        await this.tagImportedImageAndSnapshots(context, job, job.platformImageAssetId ?? '');
        await this.performAliyunEcsRequest({ ...context, action: 'DeleteImage', parameters: { ImageId: job.imageId!, Force: 'false' } });
      }
      if (await this.describeImage(context, job.imageId!)) throw new Error('云镜像删除尚未确认。');
      if (!image && job.backingSnapshotIds.length === 0) throw new Error('云镜像不可见且缺少快照清单，保留清理材料等待核验。');
      job = await this.updateJob(job, { cloudImageDeletedAt: new Date() });
    }
    await this.releaseImportLedger(context, job, job.imageId!, 'image');
    await this.adminRepository.upsertImageSnapshots({ provider: context.provider, accountUid: context.accountUid, regionId: context.regionId, scope: 'custom', snapshots: [{ imageId: job.imageId!, sourceImageName: job.displayName, status: 'Deleted', isAvailable: false, lastSyncedAt: new Date() }] });
    for (const sid of job.backingSnapshotIds) {
      if (!job.deletedSnapshotIds.includes(sid)) {
        const snapshot = await this.describeSnapshot(context, sid);
        if (snapshot) {
          if (context.provider === 'tencent_cloud') {
            this.assertTencentObjectProof(job);
            const proof = snapshot as TencentSnapshot;
            if (!Array.isArray(job.sourceDiskIds) || !job.sourceDiskIds.includes(proof.SourceDiskId) || proof.CopyFromRemote || proof.SnapshotType !== 'PRIVATE_SNAPSHOT' || proof.ShareReference !== 0
              || !Number.isFinite(Date.parse(proof.CreationTime)) || Date.parse(proof.CreationTime) < (job.uploadCompletedAt ?? job.createdAt).getTime() - 30000)
              throw new ConflictException('腾讯云导入快照来源不匹配，保留清理与费用材料。');
          }
          const tags = cloudTags(snapshot.Tags);
          if (tags.CreatedBy !== 'cyber-range-platform' || tags.PlatformImageImportJobId !== job.id
            || tags.CyberRangeOwnerUserId !== job.ownerUserId || tags.CyberRangeCloudContextId !== job.cloudAccountContextId) throw new Error('快照缺少匹配的导入来源证明。');
          if (snapshot.Usage === 'disk' || snapshot.Usage === 'image_disk'
            || (await this.describeImages(context, { SnapshotId: sid })).length) throw new Error('快照仍被其它镜像或磁盘引用，保留费用台账。');
          await this.performAliyunEcsRequest({ ...context, action: 'DeleteSnapshot', parameters: { SnapshotId: sid, Force: 'false' } });
        }
        if (await this.describeSnapshot(context, sid)) throw new Error('云快照删除尚未确认。');
        job = await this.updateJob(job, { deletedSnapshotIds: [...job.deletedSnapshotIds, sid] });
      }
      await this.releaseImportLedger(context, job, sid, 'snapshot');
    }
    if (job.sourceSnapshotId) await this.adminRepository.deletePlatformImageAssetsBySnapshotId(job.sourceSnapshotId);
    else if (job.platformImageAssetId) await this.adminRepository.deletePlatformImageAsset(job.platformImageAssetId);
    return this.updateJob(job, { snapshotCleanupCompletedAt: new Date(), errorMessage: this.withoutTerminalCleanupErrors(job.errorMessage) });
  }

  private async describeSnapshot(context: ImportContext, sid: string) {
    if (context.provider === 'tencent_cloud') { await this.assertClaim(context); return describeTencentSnapshot(context, sid); }
    const body = await this.performAliyunEcsRequest<unknown>({ ...context, action: 'DescribeSnapshots', parameters: { SnapshotIds: JSON.stringify([sid]), Status: 'all', PageNumber: '1', PageSize: '100' } });
    const rows = cloudItems<{ SnapshotId: string; Usage?: string; Tags?: unknown }>(body, 'Snapshots', 'Snapshot');
    if (rows.length > 1 || rows.some(row => row.SnapshotId !== sid) || cloudPage(body, 1, 100, rows.length) !== rows.length || (body as { NextToken?: string }).NextToken) throw new Error('快照查询身份或分页不完整。');
    return rows[0] ?? null;
  }

  private async releaseImportLedger(context: ImportContext, job: ImageImportJobRow, id: string, type: 'image' | 'snapshot') {
    await this.assertClaim(context);
    const rows = await this.adminRepository.listBillingLedgerResources();
    for (const item of rows.filter(row => row.cloudProvider === context.provider && row.cloudAccountUid === context.accountUid && row.regionId === context.regionId
      && row.cloudResourceType === type && row.cloudResourceId === id && !row.releasedAt
      && row.tagsSnapshot.PlatformImageImportJobId === job.id)) await this.adminRepository.updateBillingLedgerResource(item.id, { releasedAt: new Date() });
  }

  private async cleanupTemporaryObject(context: ImportContext, job: ImageImportJobRow) {
    if (job.temporaryObjectDeletedAt) {
      return job;
    }

    // PUT grants remain reusable after a DELETE. Keep the job pollable until the
    // grant expires, with a drain window for requests accepted near expiration.
    if (job.uploadExpiresAt.getTime() + IMAGE_IMPORT_UPLOAD_DRAIN_MS >= Date.now()) return job;

    const deleted = await this.deleteOssObject(context, job.objectKey);

    if (!deleted) {
      throw new Error('删除对象存储临时镜像文件失败。');
    }

    const completed = await this.updateJob(job, { temporaryObjectDeletedAt: new Date(), ...(job.status === 'available' ? { errorMessage: null } : {}), ...(job.status === 'failed' ? { errorMessage: this.withoutCleanupError(job.errorMessage) } : {}) });
    if (context.provider === 'tencent_cloud' && job.managedBucketId) await this.requireCos().cleanupIfIdle({ bucketId: job.managedBucketId, cloudAccountContextId: job.cloudAccountContextId, cloudAccountUid: context.accountUid, regionId: context.regionId });
    return completed;
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
    context: ImportContext,
    job: ImageImportJobRow,
    status: 'available' | 'failed',
    errorMessage: string | null,
  ) {
    const terminal = await this.updateJob(job, { status, errorMessage });

    return this.cleanupTerminalArtifacts(terminal);
  }

  private async failTimedOutImport(job: ImageImportJobRow) {
    const terminal = await this.updateJob(job, { status: 'failed', errorMessage: `镜像导入超过最大等待时长（${this.readMaxImportDurationMs()} 毫秒）。` });
    return this.cleanupTerminalArtifacts(terminal);
  }

  private withCleanupError(existingMessage: string | null, cleanupMessage: string) {
    return [this.withoutCleanupError(existingMessage), `临时对象存储文件清理失败：${cleanupMessage}`].filter(Boolean).join('\n');
  }

  private withoutCleanupError(message: string | null) {
    return (
      message
        ?.split('\n')
        .filter((line) => !/^临时(?: OSS |对象存储)文件清理失败：/.test(line))
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
            !/^临时(?: OSS |对象存储)文件清理失败：/.test(line) &&
            !line.startsWith('镜像导入终态资源清理失败：'),
        )
        .join('\n')
        .trim() || null
    );
  }

  private assertTencentObjectProof(job: ImageImportJobRow) {
    const value = job.sourceObjectProof;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ConflictException('腾讯云导入缺少已核验的上传对象证明。');
    const proof = value as Record<string,unknown>;
    if (proof.provider !== 'tencent_cloud' || proof.bucketId !== job.managedBucketId || proof.bucketName !== job.imageImportBucket
      || proof.objectKey !== job.objectKey || proof.jobId !== job.id || proof.ownerUserId !== job.ownerUserId || proof.cloudAccountContextId !== job.cloudAccountContextId
      || proof.cloudAccountUid !== job.cloudAccountUid || proof.regionId !== job.regionId || proof.contentLength !== Number(job.sourceSizeBytes)
      || typeof proof.etag !== 'string' || !proof.etag || typeof proof.verifiedAt !== 'string' || !Number.isFinite(Date.parse(proof.verifiedAt)))
      throw new ConflictException('腾讯云上传对象证明与作业冻结来源不一致。');
  }
  private requireCos() { if (!this.cosBuckets) throw new ConflictException('腾讯云专属 COS 来源服务不可用。'); return this.cosBuckets; }
  private async validateTencentImportOs(context: CloudAccountContextCredentials, input: CreateImageImportDto) {
    if (!input.platform?.trim() || !input.osVersion?.trim() || input.displayName.trim().length > 60 || (input.description?.length ?? 0) > 256)
      throw new BadRequestException('腾讯云导入需要明确发行版和 OS 版本，名称最多60字符、描述最多256字符。');
    const result = await tencentImageRequest<any>(context, 'cvm', 'DescribeImportImageOs');
    const group = result.ImportImageOsListSupported?.[input.osType === 'windows' ? 'Windows' : 'Linux'];
    const rows = result.ImportImageOsVersionSet;
    if (!Array.isArray(group) || group.some(value => typeof value !== 'string') || !Array.isArray(rows)
      || rows.some(row => !row || typeof row.OsName !== 'string' || !Array.isArray(row.OsVersions) || !Array.isArray(row.Architecture)
        || [...row.OsVersions, ...row.Architecture].some(value => typeof value !== 'string'))) throw new ConflictException('腾讯云导入 OS 支持矩阵响应不完整。');
    const architecture = input.architecture === 'arm64' ? 'arm_64' : input.architecture;
    if (!group.includes(input.platform.trim()) || rows.filter(row => row.OsName === input.platform!.trim() && row.OsVersions.includes(input.osVersion!.trim()) && row.Architecture.includes(architecture)).length !== 1)
      throw new BadRequestException('请求的发行版、OS 版本与架构未被腾讯云地域导入支持矩阵确认。');
  }
  private async boundContext(job: ImageImportJobRow): Promise<ImportContext> {
    const context = await this.cloudAccountContextsService.getCredentials(job.cloudAccountContextId, { requireReady: true });
    if ((job.cloudProvider ?? 'alibaba_cloud') !== context.provider || !job.cloudAccountUid || !job.regionId || !job.imageImportBucket || context.accountUid !== job.cloudAccountUid || context.regionId !== job.regionId) throw new ConflictException('导入云账号或地域证明不匹配，停止云操作。');
    if (context.provider === 'tencent_cloud') {
      if (!job.managedBucketId) throw new ConflictException('腾讯云导入缺少专属 COS 来源记录。');
      if (job.sourceObjectProof) this.assertTencentObjectProof(job);
      const bucket = await this.requireCos().getOwnedBucket({ bucketId: job.managedBucketId, cloudAccountContextId: job.cloudAccountContextId, cloudAccountUid: job.cloudAccountUid, regionId: job.regionId });
      if (bucket.bucketName !== job.imageImportBucket) throw new ConflictException('COS 来源 Bucket 身份与导入任务冻结记录不一致。');
    }
    return { ...context, imageImportBucket: job.imageImportBucket, importLease: { id: job.id, token: job.leaseToken! } };
  }

  private async assertClaim(context: ImportContext) {
    if (!context.importLease) throw new ConflictException('导入资源操作缺少租约。');
    const result = await this.prisma.imageImportJob.updateMany({ where: { id: context.importLease.id, leaseToken: context.importLease.token, leaseExpiresAt: { gt: new Date() } }, data: { leaseExpiresAt: new Date(Date.now() + 300_000) } });
    if (result.count !== 1) throw new ConflictException('导入资源操作租约已失效，停止云操作。');
  }

  private async updateJob(job: ImageImportJobRow, data: Parameters<PrismaService['imageImportJob']['update']>[0]['data']) {
    return this.prisma.imageImportJob.update({ where: { id: job.id, leaseToken: job.leaseToken, leaseExpiresAt: { gt: new Date() } }, data });
  }

  private async withClaim<T>(id: string, run: (job: ImageImportJobRow) => Promise<T>) {
    const token = randomUUID();
    const claimed = await this.prisma.imageImportJob.updateMany({ where: { id, OR: [{ leaseToken: null }, { leaseExpiresAt: { lte: new Date() } }] }, data: { leaseToken: token, leaseExpiresAt: new Date(Date.now() + 300_000) } });
    const job = await this.prisma.imageImportJob.findUnique({ where: { id } });
    if (!job) throw new NotFoundException('Image import job not found');
    if (claimed.count !== 1) return this.toView(job);
    if (job.leaseToken !== token || !job.leaseExpiresAt || job.leaseExpiresAt <= new Date()) throw new ConflictException('导入任务租约已变化，停止处理。');
    try { return await run(job); }
    finally { await this.prisma.imageImportJob.updateMany({ where: { id, leaseToken: token }, data: { leaseToken: null, leaseExpiresAt: null } }); }
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
    const { sourceObjectProof: _sourceObjectProof, defaultPassword: _defaultPassword, objectKey: _objectKey, leaseToken: _leaseToken, leaseExpiresAt: _leaseExpiresAt, sourceSizeBytes, ...rest } = job;
    return {
      ...rest,
      sourceSizeBytes: Number(sourceSizeBytes),
    };
  }
}

type AliyunImage = {
  ImageId?: string;
  ImageSize?: number | null;
  ImageName?: string;
  OSType?: string;
  Platform?: string;
  Architecture?: string;
  Status?: string;
  Progress?: string;
  Tags?: unknown;
  DiskDeviceMappings?: {
    DiskDeviceMapping?: Array<{ SnapshotId?: string }> | { SnapshotId?: string };
  };
};

function extractImageSnapshotIds(image: AliyunImage | null) {
  const mappings = image?.DiskDeviceMappings?.DiskDeviceMapping;
  const entries = Array.isArray(mappings) ? mappings : mappings ? [mappings] : [];
  const ids = entries.map(entry => entry.SnapshotId?.trim() ?? '');
  if (ids.some(id => !(id.startsWith('snap-') ? /^snap-[A-Za-z0-9]+$/ : /^s-/).test(id)) || new Set(ids).size !== ids.length) throw new Error('镜像快照绑定清单不完整。');
  return ids;
}

function buildAliyunArrayParameters(prefix: string, values: string[]) {
  return Object.fromEntries(values.map((value, index) => [`${prefix}.${index + 1}`, value]));
}

type ImportContext = CloudAccountContextCredentials & { importLease?: { id: string; token: string } };
