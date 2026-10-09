import { Inject, Injectable, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ADMIN_REPOSITORY, type AdminRepository, type PackedImageArtifactRecord, type UpdatePackedImageArtifactInput } from './admin.repository';
import { CloudAccountContextsService, type CloudAccountContextCredentials } from './cloud-account-contexts.service';
import { buildAliyunTagParameters, buildBillingTags } from './billing-tagging';
import type { SessionUserProfile } from './admin-user-auth';
import { imageRpc, cloudItems, cloudTags, cloudTotal, cloudPage } from './aliyun-image-rpc';
import { randomUUID } from 'node:crypto';

type Image = { ImageId: string; ImageName?: string; Status: string; Progress?: string; Tags?: unknown; DiskDeviceMappings?: { DiskDeviceMapping?: Array<{ SnapshotId?: string }> } };
type Snapshot = { SnapshotId: string; SourceDiskId?: string; SourceSnapshotId?: string; RegionId?: string; CreationTime?: string; Usage?: string; Tags?: unknown };
const ACTIVE = ['pending', 'creating', 'deleting'];
type LeasedContext = CloudAccountContextCredentials & { artifactLease?: { id: string; token: string } };

@Injectable()
export class PackedImagesService {
  constructor(@Inject(ADMIN_REPOSITORY) private readonly repository: AdminRepository, private readonly contexts: CloudAccountContextsService) {}

  async begin(input: { cloudAccountContextId: string; cloudAccountUid: string; regionId: string; ownerUserId: string; sourceRangeInstanceId: string; sourceHostKey: string; sourceInstanceId: string }, context: CloudAccountContextCredentials) {
    this.assertContext(input, context);
    const body = await imageRpc(context, 'DescribeDisks', { InstanceId: input.sourceInstanceId, PageNumber: '1', PageSize: '100' });
    const disks = cloudItems<{ DiskId?: string }>(body, 'Disks', 'Disk');
    const sourceDiskIds = disks.map(item => item.DiskId ?? '');
    if (!sourceDiskIds.length || sourceDiskIds.some(id => !/^d-/.test(id)) || new Set(sourceDiskIds).size !== sourceDiskIds.length || cloudTotal(body) !== sourceDiskIds.length) {
      throw new ConflictException('无法确认源实例的完整磁盘清单，未提交镜像打包。');
    }
    const artifact = await this.repository.withSingleInstanceControlLock(async () => {
      const existing = (await this.repository.listPackedImageArtifacts()).find(item => ACTIVE.includes(item.status)
        && item.cloudAccountUid === input.cloudAccountUid && item.regionId === input.regionId && item.sourceInstanceId === input.sourceInstanceId);
      if (existing) throw new ConflictException({ message: '该实例已有尚未确认或清理中的打包任务，请先核验原任务，避免重复生成计费快照。', packedImageArtifactId: existing.id });
      return this.repository.createPackedImageArtifact({ ...input, sourceDiskIds });
    });
    const submissionToken = randomUUID();
    if (!await this.repository.claimPackedImageArtifact(artifact.id, submissionToken, new Date(Date.now() + 300_000))) throw new ConflictException('打包来源记录正在恢复，请稍后重试。');
    return { ...artifact, submissionToken };
  }

  endSubmission(id: string, token: string) { return this.repository.releasePackedImageArtifactClaim(id, token); }
  updateClaimed(id: string, token: string, input: UpdatePackedImageArtifactInput) {
    return this.repository.withPackedImageArtifactClaim(id, token, repo => repo.updatePackedImageArtifact(id, input));
  }

  async restoreAsset(id: string, snapshotId: string, displayName: string) {
    return this.withClaim(id, true, token => this.repository.withPackedImageArtifactClaim(id, token, async repo => {
      const artifact = (await repo.getPackedImageArtifact(id))!;
      const source = await repo.getImageSnapshotById(snapshotId);
      if (artifact.status !== 'available' || !source?.isAvailable || source.imageId !== artifact.imageId) throw new ConflictException('打包镜像尚不可用或已进入清理，不能重新收录。');
      const asset = await repo.collectPlatformImageAsset({ preserveExisting: true, snapshotId, displayName, ownerUserId: artifact.ownerUserId, visibility: 'private' });
      await repo.updatePackedImageArtifact(id, { platformImageAssetId: asset.id });
      // Recollecting a catalog asset does not restart billing or change the resource's creator.
      for (const ledger of await repo.listBillingLedgerResources()) {
        if (ledger.cloudAccountUid === artifact.cloudAccountUid && ledger.regionId === artifact.regionId
          && ledger.ownerUserId === artifact.ownerUserId && ledger.tagsSnapshot.PlatformPackedImageArtifactId === artifact.id
          && (ledger.cloudResourceType === 'image' && ledger.cloudResourceId === artifact.imageId
            || ledger.cloudResourceType === 'snapshot' && artifact.backingSnapshotIds.includes(ledger.cloudResourceId))) {
          await repo.updateBillingLedgerResource(ledger.id, { platformImageAssetId: asset.id });
        }
      }
      return asset;
    }));
  }

  async hasPending(input: { imageId?: string | null; sourceSnapshotId?: string | null; platformImageAssetId?: string | null }) {
    const all = await this.repository.listPackedImageArtifacts();
    return all.some(item => ACTIVE.includes(item.status) && ((input.imageId && item.imageId === input.imageId) || (input.sourceSnapshotId && item.sourceSnapshotId === input.sourceSnapshotId) || (input.platformImageAssetId && item.platformImageAssetId === input.platformImageAssetId)));
  }

  async refreshPending() {
    const rows = (await this.repository.listPackedImageArtifacts()).filter(item => ACTIVE.includes(item.status)).sort((a, b) => (a.lastPolledAt?.getTime() ?? 0) - (b.lastPolledAt?.getTime() ?? 0)).slice(0, 20);
    for (const row of rows) await this.refresh(row.id);
  }

  async refresh(id: string) {
    return this.withClaim(id, false, (token) => this.refreshClaimed(id, token));
  }

  private async refreshClaimed(id: string, token: string) {
    let artifact = await this.require(id);
    try {
      const context = await this.boundContext(artifact, token);
      artifact = await this.updateClaimed(id, token, { lastPolledAt: new Date() });
      if (artifact.status === 'deleting') return await this.processCleanup(artifact, context);
      if (!ACTIVE.includes(artifact.status)) return artifact;
      let images: Image[];
      if (artifact.imageId) {
        images = await this.describeImages(context, { ImageId: artifact.imageId });
      } else {
        images = await this.describeImages(context, { 'Tag.1.Key': 'PlatformPackedImageArtifactId', 'Tag.1.Value': artifact.id, ImageOwnerAlias: 'self' });
      }
      if (!images.length) return artifact;
      if (images.length !== 1) throw new ConflictException('打包来源标记匹配多个镜像，拒绝自动关联。');
      const image = images[0];
      this.assertImage(artifact, image);
      if (!artifact.imageId) artifact = await this.updateClaimed(id, token, { imageId: image.ImageId, status: 'creating' });
      const snapshotIds = this.snapshotIds(image);
      if (image.Status === 'Available' && !snapshotIds.length) throw new ConflictException('打包镜像已可用，但快照绑定信息尚未完整，等待恢复。');
      if (snapshotIds.length) {
        await this.captureSnapshots(artifact, context, snapshotIds);
        artifact = await this.require(id);
      }
      await this.upsertLedger(artifact, image.ImageId, 'image', token);
      const status = image.Status === 'Available' ? 'available' : /Failed|UnAvailable/i.test(image.Status) ? 'failed' : 'creating';
      return this.repository.withPackedImageArtifactClaim(id, token, async repo => {
        await repo.upsertImageSnapshots({ provider: 'alibaba_cloud', accountUid: artifact.cloudAccountUid, regionId: artifact.regionId, scope: 'custom', snapshots: [{ imageId: image.ImageId, sourceImageName: image.ImageName || image.ImageId, status: image.Progress && image.Status !== 'Available' ? `${image.Status} ${image.Progress}` : image.Status, isAvailable: image.Status === 'Available', lastSyncedAt: new Date() }] });
        const [source] = await repo.listImageSnapshots({ provider: 'alibaba_cloud', accountUid: artifact.cloudAccountUid, regionId: artifact.regionId, scope: 'custom', imageId: image.ImageId });
        if (artifact.platformImageAssetId && await repo.getPlatformImageAssetById(artifact.platformImageAssetId)) await repo.setPlatformImageAssetEnabled(artifact.platformImageAssetId, image.Status === 'Available');
        return repo.updatePackedImageArtifact(id, { sourceSnapshotId: source.id, status, errorMessage: status === 'failed' ? `阿里云打包失败：${image.Status}` : null });
      });
    } catch {
      return this.updateClaimed(id, token, { errorMessage: '打包或清理状态验证失败，清理材料已保留，可修复后重试。' });
    }
  }

  async cleanup(snapshotId: string, currentUser: SessionUserProfile) {
    const [artifact] = await this.repository.listPackedImageArtifacts({ sourceSnapshotId: snapshotId });
    if (!artifact) throw new ConflictException('仅支持有完整来源记录的新平台打包镜像；旧镜像或外部快照不能自动回收。');
    if (currentUser.role !== 'admin' && artifact.ownerUserId !== currentUser.id) throw new ForbiddenException('镜像不属于当前用户。');
    if (artifact.status === 'deleted') return this.cleanupView(artifact);
    return this.withClaim(artifact.id, true, (token) => this.cleanupClaimed(artifact, token));
  }

  private async cleanupClaimed(artifact: PackedImageArtifactRecord, token: string) {
    artifact = await this.require(artifact.id);
    if (artifact.status === 'deleted') return this.cleanupView(artifact);
    if (!artifact.imageId) throw new ConflictException('云镜像身份尚未确认，等待打包状态恢复。');
    const context = await this.boundContext(artifact, token);
    if (artifact.status !== 'deleting') {
      const [image] = await this.describeImages(context, { ImageId: artifact.imageId! });
      if (image) {
        this.assertImage(artifact, image);
        if (image.Status !== 'Available' && !/Failed|UnAvailable/i.test(image.Status)) throw new ConflictException('镜像仍在创建，完成前不能回收。');
      }
      const ids = image ? this.snapshotIds(image) : artifact.backingSnapshotIds;
      if (!ids.length) throw new ConflictException('云镜像未返回确切 backing snapshot，拒绝清理。');
      if (image) await this.captureSnapshots(artifact, context, ids);
      artifact.backingSnapshotIds = ids;
      for (const sid of ids) await this.assertExclusiveSnapshot(artifact, context, sid);
      await this.repository.withPackedImageArtifactClaim(artifact.id, token, async repo => {
        await repo.updatePackedImageArtifact(artifact.id, { status: 'deleting', errorMessage: null });
        if (artifact.platformImageAssetId && await repo.getPlatformImageAssetById(artifact.platformImageAssetId)) await repo.setPlatformImageAssetEnabled(artifact.platformImageAssetId, false);
        await repo.upsertImageSnapshots({ provider: 'alibaba_cloud', accountUid: artifact.cloudAccountUid, regionId: artifact.regionId, scope: 'custom', snapshots: [{ imageId: artifact.imageId!, sourceImageName: artifact.imageId!, status: 'Deleting', isAvailable: false, lastSyncedAt: new Date() }] });
      });
    }
    try { return this.cleanupView(await this.processCleanup(await this.require(artifact.id), context)); }
    catch {
      await this.updateClaimed(artifact.id, token, { errorMessage: '云资源清理未确认，确切快照清单和已删除进度已保留，请重试。' });
      throw new ConflictException({ message: '云资源清理未确认，材料已保留，可用相同 snapshotId 重试。', packedImageArtifactId: artifact.id });
    }
  }

  private async processCleanup(artifact: PackedImageArtifactRecord, context: LeasedContext) {
    const token = context.artifactLease!.token;
    if (!artifact.imageId || !artifact.backingSnapshotIds.length) throw new ConflictException('清理证明不完整。');
    if (!artifact.cloudImageDeletedAt) {
      const [image] = await this.describeImages(context, { ImageId: artifact.imageId });
      if (image) {
        this.assertImage(artifact, image);
        if (this.snapshotIds(image).sort().join(',') !== [...artifact.backingSnapshotIds].sort().join(',')) throw new ConflictException('镜像快照绑定发生变化，拒绝清理。');
        for (const sid of artifact.backingSnapshotIds) await this.assertExclusiveSnapshot(artifact, context, sid);
        await this.rpc(context, 'DeleteImage', { ImageId: artifact.imageId, Force: 'false' });
        if ((await this.describeImages(context, { ImageId: artifact.imageId })).length) throw new ConflictException('云镜像删除尚未确认。');
      }
      artifact = await this.updateClaimed(artifact.id, token, { cloudImageDeletedAt: new Date(), errorMessage: null });
    }
    await this.releaseLedger(artifact, artifact.imageId!, 'image', token);
    for (const sid of artifact.backingSnapshotIds) {
      if (artifact.deletedSnapshotIds.includes(sid)) { await this.releaseLedger(artifact, sid, 'snapshot', token); continue; }
      const snapshot = await this.describeSnapshot(context, sid);
      if (snapshot) {
        await this.assertSnapshotProof(artifact, snapshot);
        if ((await this.describeImages(context, { SnapshotId: sid })).length) throw new ConflictException('快照仍被其它镜像引用，拒绝回收。');
        if (snapshot.Usage === 'disk' || snapshot.Usage === 'image_disk') throw new ConflictException('快照仍被磁盘使用，拒绝回收。');
        await this.rpc(context, 'DeleteSnapshot', { SnapshotId: sid, Force: 'false' });
        if (await this.describeSnapshot(context, sid)) throw new ConflictException('云快照删除尚未确认。');
      }
      artifact = await this.updateClaimed(artifact.id, token, { deletedSnapshotIds: [...artifact.deletedSnapshotIds, sid] });
      await this.releaseLedger(artifact, sid, 'snapshot', token);
    }
    return this.repository.withPackedImageArtifactClaim(artifact.id, token, async repo => {
      if (artifact.sourceSnapshotId) {
        await repo.deletePlatformImageAssetsBySnapshotId(artifact.sourceSnapshotId);
        await repo.upsertImageSnapshots({ provider: 'alibaba_cloud', accountUid: artifact.cloudAccountUid, regionId: artifact.regionId, scope: 'custom', snapshots: [{ imageId: artifact.imageId!, sourceImageName: artifact.imageId!, status: 'Deleted', isAvailable: false, lastSyncedAt: new Date() }] });
      }
      return repo.updatePackedImageArtifact(artifact.id, { status: 'deleted', completedAt: new Date(), errorMessage: null });
    });
  }

  private async captureSnapshots(artifact: PackedImageArtifactRecord, context: LeasedContext, ids: string[]) {
    if (ids.length !== artifact.sourceDiskIds.length) throw new ConflictException('打包镜像快照清单未覆盖全部源磁盘，等待完整结果。');
    if (artifact.backingSnapshotIds.length && artifact.backingSnapshotIds.sort().join(',') !== [...ids].sort().join(',')) throw new ConflictException('已记录的打包快照绑定发生变化。');
    // Save the binding before cloud tagging; a denied tag request must not lose billable identities.
    await this.updateClaimed(artifact.id, context.artifactLease!.token, { backingSnapshotIds: ids });
    const capturedDisks = new Set<string>();
    for (const sid of ids) {
      const snapshot = await this.describeSnapshot(context, sid);
      if (!snapshot || !this.isFreshSourceSnapshot(artifact, snapshot)) throw new ConflictException('快照来源、地域或创建时间不匹配，拒绝标记外部快照。');
      if (capturedDisks.has(snapshot.SourceDiskId!)) throw new ConflictException('打包快照重复引用同一源磁盘，拒绝不完整清单。');
      capturedDisks.add(snapshot.SourceDiskId!);
      const existingTags = cloudTags(snapshot.Tags);
      if ((existingTags.PlatformPackedImageArtifactId && existingTags.PlatformPackedImageArtifactId !== artifact.id)
        || (existingTags.PlatformUserId && existingTags.PlatformUserId !== artifact.ownerUserId)
        || (existingTags.CreatedBy && existingTags.CreatedBy !== 'cyber-range-platform')) throw new ConflictException('快照已有其它来源或 owner 标记，拒绝覆盖。');
    }
    for (const sid of ids) {
      await this.upsertLedger(artifact, sid, 'snapshot', context.artifactLease!.token);
    }
    for (const sid of ids) {
      await this.rpc(context, 'TagResources', { ResourceType: 'snapshot', 'ResourceId.1': sid, ...buildAliyunTagParameters({ ...this.tags(artifact), PlatformResourceType: 'snapshot' }) });
    }
    await this.updateClaimed(artifact.id, context.artifactLease!.token, { backingSnapshotIds: ids });
  }

  private isFreshSourceSnapshot(artifact: PackedImageArtifactRecord, snapshot: Snapshot) {
    return snapshot.SnapshotId.startsWith('s-') && snapshot.RegionId === artifact.regionId && !snapshot.SourceSnapshotId
      && !!snapshot.SourceDiskId && artifact.sourceDiskIds.includes(snapshot.SourceDiskId)
      && !!snapshot.CreationTime && Number.isFinite(Date.parse(snapshot.CreationTime)) && Date.parse(snapshot.CreationTime) >= artifact.createdAt.getTime() - 30_000;
  }

  private async assertSnapshotProof(artifact: PackedImageArtifactRecord, snapshot: Snapshot) {
    const tags = cloudTags(snapshot.Tags);
    if (!this.isFreshSourceSnapshot(artifact, snapshot) || tags.PlatformPackedImageArtifactId !== artifact.id || tags.PlatformUserId !== artifact.ownerUserId || tags.CreatedBy !== 'cyber-range-platform') throw new ConflictException('快照来源或 owner 证明不匹配。');
    const ledger = (await this.repository.listBillingLedgerResources()).find(item => item.cloudAccountUid === artifact.cloudAccountUid && item.regionId === artifact.regionId && item.cloudResourceType === 'snapshot' && item.cloudResourceId === snapshot.SnapshotId && item.ownerUserId === artifact.ownerUserId && item.tagsSnapshot.PlatformPackedImageArtifactId === artifact.id);
    if (!ledger) throw new ConflictException('快照缺少匹配的打包台账证明。');
  }

  private async assertExclusiveSnapshot(artifact: PackedImageArtifactRecord, context: CloudAccountContextCredentials, sid: string) {
    const snapshot = await this.describeSnapshot(context, sid);
    if (!snapshot) throw new ConflictException('快照在建立清理证明前已消失。');
    await this.assertSnapshotProof(artifact, snapshot);
    if ((await this.describeImages(context, { SnapshotId: sid })).some(image => image.ImageId !== artifact.imageId)) throw new ConflictException('快照被其它镜像共享，拒绝回收。');
    if (snapshot.Usage === 'disk' || snapshot.Usage === 'image_disk') throw new ConflictException('快照被磁盘使用，拒绝回收。');
  }

  async upsertLedger(artifact: PackedImageArtifactRecord, cloudResourceId: string, cloudResourceType: 'image' | 'snapshot', token?: string, repo = this.repository): Promise<void> {
    if (token) return this.repository.withPackedImageArtifactClaim(artifact.id, token, claimed => this.upsertLedger(artifact, cloudResourceId, cloudResourceType, undefined, claimed));
    const existing = await repo.findBillingLedgerResource({ regionId: artifact.regionId, cloudResourceId, cloudResourceType });
    if (existing && (existing.cloudAccountUid !== artifact.cloudAccountUid || existing.ownerUserId !== artifact.ownerUserId || (existing.tagsSnapshot.PlatformPackedImageArtifactId && existing.tagsSnapshot.PlatformPackedImageArtifactId !== artifact.id))) throw new ConflictException('资源台账 owner、来源或云账号不匹配。');
    const sourceInstance = await repo.getRangeInstanceById(artifact.sourceRangeInstanceId);
    const sourceEcs = await repo.findBillingLedgerResource({ regionId: artifact.regionId, cloudResourceId: artifact.sourceInstanceId, cloudResourceType: 'ecs' });
    const provenSourceEcs = sourceEcs?.cloudAccountUid === artifact.cloudAccountUid && sourceEcs.ownerUserId === artifact.ownerUserId && sourceEcs.rangeInstanceId === artifact.sourceRangeInstanceId ? sourceEcs : null;
    const sourceJob = (await repo.listProvisionJobs()).filter(job => job.rangeInstanceId === artifact.sourceRangeInstanceId && job.jobType === 'create' && job.status === 'succeeded').sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];
    const tagsSnapshot = this.tags(artifact);
    const singleInstanceBatchId = provenSourceEcs?.singleInstanceBatchId ?? sourceInstance?.singleInstanceBatchId ?? existing?.singleInstanceBatchId ?? null;
    if (singleInstanceBatchId) tagsSnapshot.SingleInstanceBatchId = singleInstanceBatchId;
    const data = { billingScope: 'user' as const, ownerUserId: artifact.ownerUserId, rangeInstanceId: artifact.sourceRangeInstanceId, singleInstanceBatchId, sourceProvisionJobId: provenSourceEcs?.sourceProvisionJobId ?? existing?.sourceProvisionJobId ?? sourceJob?.id ?? null, platformImageAssetId: artifact.platformImageAssetId, releasedAt: null, tagsSnapshot };
    if (existing) await repo.updateBillingLedgerResource(existing.id, data);
    else await repo.createBillingLedgerResource({ ...data, cloudAccountUid: artifact.cloudAccountUid, regionId: artifact.regionId, cloudResourceId, cloudResourceType, billingStartAt: artifact.createdAt });
  }

  private async releaseLedger(artifact: PackedImageArtifactRecord, id: string, type: 'image' | 'snapshot', token: string) {
    return this.repository.withPackedImageArtifactClaim(artifact.id, token, async repo => {
      const rows = await repo.listBillingLedgerResources();
      for (const item of rows.filter(item => item.cloudAccountUid === artifact.cloudAccountUid && item.regionId === artifact.regionId && item.cloudResourceId === id && item.cloudResourceType === type && item.tagsSnapshot.PlatformPackedImageArtifactId === artifact.id && !item.releasedAt)) {
        await repo.updateBillingLedgerResource(item.id, { releasedAt: new Date() });
      }
    });
  }

  private tags(artifact: PackedImageArtifactRecord) {
    return buildBillingTags({ billingScope: 'user', ownerUserId: artifact.ownerUserId, rangeInstanceId: artifact.sourceRangeInstanceId, platformImageAssetId: artifact.platformImageAssetId, platformHostKey: artifact.sourceHostKey, platformPackedImageArtifactId: artifact.id, billingStartAt: artifact.createdAt });
  }

  private assertImage(artifact: PackedImageArtifactRecord, image: Image) {
    const tags = cloudTags(image.Tags);
    if ((artifact.imageId && artifact.imageId !== image.ImageId) || tags.PlatformPackedImageArtifactId !== artifact.id || tags.PlatformImageOrigin !== 'instance_pack' || tags.CreatedBy !== 'cyber-range-platform' || tags.PlatformUserId !== artifact.ownerUserId || !image.Status) throw new ConflictException('云镜像来源或 owner 证明不匹配。');
  }

  private snapshotIds(image: Image) {
    const entries = image.DiskDeviceMappings?.DiskDeviceMapping;
    if (!Array.isArray(entries)) return [];
    const ids = entries.map(item => item.SnapshotId ?? '');
    if (ids.some(id => !/^s-/.test(id)) || new Set(ids).size !== ids.length) throw new ConflictException('云镜像 backing snapshot 清单格式不完整。');
    return ids;
  }

  async describeImages(context: CloudAccountContextCredentials, parameters: Record<string, string>) {
    const result: Image[] = [];
    let total = 0, page = 1;
    let expectedTotal: number | undefined;
    do {
      const body = await this.rpc(context, 'DescribeImages', { Status: 'ALL', PageSize: '100', PageNumber: String(page), ...parameters });
      const items = cloudItems<Image>(body, 'Images', 'Image');
      if (items.some(item => typeof item.ImageId !== 'string' || !item.ImageId.trim() || typeof item.Status !== 'string' || !item.Status.trim())) throw new Error('Invalid image identity/status');
      total = cloudPage(body, page, 100, items.length);
      if (expectedTotal !== undefined && expectedTotal !== total) throw new Error('Cloud image list changed during pagination');
      expectedTotal = total;
      if (!Number.isSafeInteger(total) || total < 0 || (!items.length && result.length < total)) throw new Error('Invalid image pagination');
      result.push(...items); page++;
    } while (result.length < total);
    if (result.length !== total || new Set(result.map(item => item.ImageId)).size !== result.length) throw new Error('Incomplete image pagination');
    return result;
  }

  private async describeSnapshot(context: CloudAccountContextCredentials, sid: string) {
    const body = await this.rpc(context, 'DescribeSnapshots', { SnapshotIds: JSON.stringify([sid]), Status: 'all', PageNumber: '1', PageSize: '100' });
    const rows = cloudItems<Snapshot>(body, 'Snapshots', 'Snapshot');
    if (rows.some(item => item.SnapshotId !== sid) || rows.length > 1 || (body as { NextToken?: string }).NextToken || cloudPage(body, 1, 100, rows.length) !== rows.length) throw new Error('Invalid snapshot query identity/pagination');
    return rows[0] ?? null;
  }

  private assertContext(artifact: { cloudAccountUid: string; regionId: string }, context: CloudAccountContextCredentials) {
    if (context.provider !== 'alibaba_cloud') throw new ConflictException('该云厂商的镜像打包与快照回收尚未开放。');
    if (!artifact.cloudAccountUid || artifact.cloudAccountUid !== context.accountUid || artifact.regionId !== context.regionId) throw new ConflictException('打包云账号或地域上下文不匹配。');
  }
  private async boundContext(artifact: PackedImageArtifactRecord, token: string): Promise<LeasedContext> {
    const context = await this.contexts.getCredentials(artifact.cloudAccountContextId, { requireReady: true });
    this.assertContext(artifact, context); return { ...context, artifactLease: { id: artifact.id, token } };
  }
  private async rpc<T = unknown>(context: LeasedContext, action: string, parameters: Record<string, string>) {
    if (context.artifactLease && !await this.repository.renewPackedImageArtifactClaim(context.artifactLease.id, context.artifactLease.token, new Date(Date.now() + 300_000))) throw new ConflictException('打包资源操作租约已失效，请重试。');
    return imageRpc<T>(context, action, parameters);
  }
  private async withClaim<T>(id: string, required: true, run: (token: string) => Promise<T>): Promise<T>;
  private async withClaim<T>(id: string, required: false, run: (token: string) => Promise<T>): Promise<T | PackedImageArtifactRecord>;
  private async withClaim<T>(id: string, required: boolean, run: (token: string) => Promise<T>): Promise<T | PackedImageArtifactRecord> {
    const token = randomUUID();
    if (!await this.repository.claimPackedImageArtifact(id, token, new Date(Date.now() + 300_000))) {
      if (required) throw new ConflictException('打包镜像正在验证或清理，请稍后使用同一目标重试。');
      return this.require(id);
    }
    try { return await run(token); } finally { await this.repository.releasePackedImageArtifactClaim(id, token); }
  }
  private async require(id: string) { const row = await this.repository.getPackedImageArtifact(id); if (!row) throw new NotFoundException('Packed image artifact not found'); return row; }
  private cleanupView(artifact: PackedImageArtifactRecord) {
    return { removed: artifact.status === 'deleted', status: artifact.status, packedImageArtifactId: artifact.id, snapshotId: artifact.sourceSnapshotId, imageId: artifact.imageId, cloudAccountUid: artifact.cloudAccountUid, regionId: artifact.regionId, snapshotIds: artifact.backingSnapshotIds, deletedSnapshotIds: artifact.deletedSnapshotIds };
  }
}
