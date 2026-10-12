import { Inject, Injectable, ConflictException, ForbiddenException, NotFoundException, Optional } from '@nestjs/common';
import { runInSystemCloudWorkspaceScope } from '../auth/cloud-workspace-scope';
import { listExecutionCloudWorkspaces, runInExecutionCloudWorkspace } from '../auth/background-cloud-workspace';
import { SystemConfigService } from './system-config.service';
import { ADMIN_REPOSITORY, type AdminRepository, type PackedImageArtifactRecord, type UpdatePackedImageArtifactInput } from './admin.repository';
import { CloudAccountContextsService, type CloudAccountContextCredentials } from './cloud-account-contexts.service';
import { buildAliyunTagParameters, buildBillingTags } from './billing-tagging';
import type { SessionUserProfile } from './admin-user-auth';
import { imageRpc, cloudItems, cloudTags, cloudTotal, cloudPage } from './aliyun-image-rpc';
import { describeTencentImages, describeTencentSnapshot, tagTencentImageResources, deleteTencentImage, deleteTencentSnapshot, tencentImageRequest, type TencentSnapshot } from './tencent-image-rpc';
import { describeTencentResourceInventory, describeTencentInstances, assertTencentOwnedInstance, type TencentResourceEvidence } from './tencent-cloud-resources';
import { randomUUID } from 'node:crypto';
import { TencentCloudRequestError } from './tencent-cloud-client';
import { PackedImageCloudError, PackedImageVerificationError, safePackedCloudCode, packedImageDiagnostic, readPackedImageDiagnostic, encodePackedImageDiagnostic, type PackedImagePhase } from './packed-image-diagnostic';
import { TENCENT_PACK_BASELINE_KIND, readTencentPackBaseline, validTencentPackBaseline } from './tencent-pack-snapshot-baseline';
import { collectAliyunPackSnapshotBaseline } from './aliyun-snapshot-ecs-evidence';

type Image = { ImageType?: string; ImageSize?: number | null; ImageId: string; ImageName?: string; Status: string; Progress?: string; Tags?: unknown; DiskDeviceMappings?: { DiskDeviceMapping?: Array<{ SnapshotId?: string }> } };
type Snapshot = { SnapshotId: string; SourceDiskId?: string; SourceSnapshotId?: string; RegionId?: string; CreationTime?: string; Usage?: string; Tags?: unknown };
const ACTIVE = ['pending', 'creating', 'deleting'];
type LeasedContext = CloudAccountContextCredentials & { artifactLease?: { id: string; token: string } };
type TencentPackSource = { cloudAccountContextId: string; cloudAccountUid: string; regionId: string; ownerUserId: string; sourceRangeInstanceId: string; sourceHostKey: string; sourceInstanceId: string };
type TencentPackRequestSource = TencentPackSource & { id: string; createdAt: Date; platformImageAssetId: string | null };

@Injectable()
export class PackedImagesService {
  constructor(@Inject(ADMIN_REPOSITORY) private readonly repository: AdminRepository, private readonly contexts: CloudAccountContextsService,
    @Optional() private readonly systemConfigService?: SystemConfigService) {}

  async begin(input: { cloudAccountContextId: string; cloudAccountUid: string; regionId: string; ownerUserId: string; sourceRangeInstanceId: string; sourceHostKey: string; sourceInstanceId: string }, context: CloudAccountContextCredentials) {
    this.assertContext(input, context);
    const body = context.provider === 'tencent_cloud' ? await this.tencentSourceDisks(input, context) : await imageRpc(context, 'DescribeDisks', { InstanceId: input.sourceInstanceId, PageNumber: '1', PageSize: '100' });
    const disks = cloudItems<{ DiskId?: string }>(body, 'Disks', 'Disk');
    const sourceDiskIds = disks.map(item => item.DiskId ?? '');
    if (!sourceDiskIds.length || sourceDiskIds.some(id => !(context.provider === 'tencent_cloud' ? /^disk-[A-Za-z0-9]+$/ : /^d-/).test(id)) || new Set(sourceDiskIds).size !== sourceDiskIds.length || cloudTotal(body) !== sourceDiskIds.length) {
      throw new ConflictException('无法确认源实例的完整磁盘清单，未提交镜像打包。');
    }
    const artifact = await this.repository.withSingleInstanceControlLock(async () => {
      const existing = (await this.repository.listPackedImageArtifacts()).find(item => (item.cloudProvider ?? 'alibaba_cloud') === context.provider && ACTIVE.includes(item.status)
        && item.cloudAccountUid === input.cloudAccountUid && item.regionId === input.regionId && item.sourceInstanceId === input.sourceInstanceId);
      if (existing) throw new ConflictException({ message: '该实例已有尚未确认或清理中的打包任务，请先核验原任务，避免重复生成计费快照。', packedImageArtifactId: existing.id });
      const source = await this.repository.getRangeInstanceById(input.sourceRangeInstanceId);
      if (context.provider !== 'tencent_cloud') {
        const identity = { ...input, id: randomUUID(), cloudProvider: 'alibaba_cloud' as const, cloudWorkspaceId: source?.cloudWorkspaceId ?? 'legacy-unbound', sourceDiskIds };
        const sourceSnapshotBaseline = await collectAliyunPackSnapshotBaseline({ ...context, cloudAccountContextId: context.id }, identity);
        // Missing audit permissions or inventory cannot block a pack or trigger another create.
        // Keep the artifact; source-ECS billing remains pending without this historical baseline.
        return this.repository.createPackedImageArtifact({ ...input, id: identity.id, cloudProvider: context.provider, sourceDiskIds, ...(sourceSnapshotBaseline ? { sourceSnapshotBaseline } : {}) });
      }
      const identity = { ...input, id: randomUUID(), cloudProvider: 'tencent_cloud' as const, cloudWorkspaceId: source?.cloudWorkspaceId ?? 'legacy-unbound', sourceDiskIds };
      const account = { ...context, accountUidResolved: true, cloudAccountContextId: context.id, defaultRegion: context.regionId, defaultZoneId: context.zoneId };
      const sourceDisks = [];
      for (const sourceDiskId of sourceDiskIds) {
        const evidence: TencentResourceEvidence[] = [];
        const snapshots = await describeTencentResourceInventory(account, 'snapshot', { diskIds: [sourceDiskId], onEvidence: value => evidence.push(value) });
        sourceDisks.push({ sourceDiskId, snapshotIds: snapshots.map(snapshot => snapshot.id), evidence });
      }
      const sourceSnapshotBaseline = { ...identity, kind: TENCENT_PACK_BASELINE_KIND, sourceDisks,
        preCreateSnapshotIds: [...new Set(sourceDisks.flatMap(disk => disk.snapshotIds))], observedAt: new Date().toISOString() };
      if (!validTencentPackBaseline(identity, sourceSnapshotBaseline)) throw new ConflictException('腾讯云提交前快照清单或官方回执不完整，未创建打包任务或镜像。');
      return this.repository.createPackedImageArtifact({ ...input, id: identity.id, cloudProvider: 'tencent_cloud', sourceDiskIds, sourceSnapshotBaseline });
    });
    const submissionToken = randomUUID();
    if (!await this.repository.claimPackedImageArtifact(artifact.id, submissionToken, new Date(Date.now() + 300_000))) throw new ConflictException('打包来源记录正在恢复，请稍后重试。');
    return { ...artifact, submissionToken };
  }

  private async tencentSourceDisks(input: { sourceRangeInstanceId: string; sourceHostKey: string; sourceInstanceId: string; ownerUserId: string }, context: CloudAccountContextCredentials) {
    const instance = await this.repository.getRangeInstanceById(input.sourceRangeInstanceId);
    const source = instance?.instanceMode === 'single' ? instance.singleInstanceConfig : instance?.resourceSummary?.executionContext;
    if (!instance || instance.cloudProvider !== 'tencent_cloud' || (instance.ownerUserId ?? instance.createdBy) !== input.ownerUserId
      || instance.resourceSummary?.hostIds?.[input.sourceHostKey] !== input.sourceInstanceId || source?.cloudAccountContextId !== context.id
      || source.cloudAccountUid !== context.accountUid || source.regionId !== context.regionId) throw new ConflictException('腾讯云源实例缺少冻结账号、owner 或持久物理 ID 证明。');
    const account = { ...context, accountUidResolved: true, cloudAccountContextId: context.id, defaultRegion: context.regionId, defaultZoneId: context.zoneId };
    const [cloudInstance] = await describeTencentInstances(account, { instanceIds: [input.sourceInstanceId] });
    if (!cloudInstance) throw new ConflictException('腾讯云源实例暂不可见，未提交打包。');
    assertTencentOwnedInstance(instance, account, cloudInstance, input.sourceHostKey);
    const resources = await describeTencentResourceInventory(account, 'disk', { instanceId: input.sourceInstanceId });
    const known = new Set([...Object.values(instance.resourceSummary.systemDiskIds ?? {}), ...Object.values(instance.resourceSummary.dataDiskIds ?? {})]);
    if (!resources.length || resources.some(disk => !known.has(disk.id) || disk.shared || !['SYSTEM_DISK', 'DATA_DISK'].includes(disk.diskUsage ?? ''))
      || !resources.some(disk => disk.diskUsage === 'SYSTEM_DISK')) throw new ConflictException('腾讯云源磁盘清单有未证明或共享磁盘，拒绝打包。');
    return { TotalCount: resources.length, Disks: { Disk: resources.map(disk => ({ DiskId: disk.id, DiskUsage: disk.diskUsage })) } };
  }
  async dryRunTencentImage(source: TencentPackSource, context: CloudAccountContextCredentials, input: { name: string; description?: string | null }) {
    this.assertContext(source, context);
    if (context.provider !== 'tencent_cloud') throw new ConflictException('此参数核验仅支持腾讯云官方 CreateImage DryRun。');
    this.assertTencentPackMetadata(input);
    if ((await this.repository.listPackedImageArtifacts()).some(row => row.cloudProvider === 'tencent_cloud' && ACTIVE.includes(row.status)
      && row.cloudAccountUid === source.cloudAccountUid && row.regionId === source.regionId && row.sourceInstanceId === source.sourceInstanceId))
      throw new ConflictException('原源实例已有未知或进行中的打包，不能借参数核验重提该来源。');
    const body = await this.tencentSourceDisks(source, context);
    const disks = cloudItems<{ DiskId: string; DiskUsage: string }>(body, 'Disks', 'Disk');
    const parameters = this.tencentCreateImageParameters({ ...source, id: randomUUID(), createdAt: new Date(), platformImageAssetId: null }, input,
      disks.map(disk => ({ id: disk.DiskId, diskUsage: disk.DiskUsage })));
    try {
      const result = await tencentImageRequest<{ ImageId?: string | null; RequestId: string }>(context, 'cvm', 'CreateImage', { ...parameters, DryRun: true });
      if (result.ImageId || typeof result.RequestId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(result.RequestId)
        || [context.accessKeyId, context.accessKeySecret].some(secret => result.RequestId.includes(secret)))
        return { status: 'unverified', dryRun: true, phase: 'create_image', cloudErrorCode: 'UNEXPECTED_DRY_RUN_RESPONSE' };
      return { status: 'validated', dryRun: true, phase: 'create_image', cloudRequestId: result.RequestId };
    } catch (error) {
      const diagnostic = packedImageDiagnostic(error, 'create_image', [context.accessKeyId, context.accessKeySecret]);
      if (error instanceof TencentCloudRequestError && error.code === 'DryRunOperation' && diagnostic.cloudRequestId)
        return { status: 'validated', dryRun: true, ...diagnostic };
      return { status: diagnostic.cloudRequestId ? 'rejected' : 'unverified', dryRun: true, ...diagnostic };
    }
  }
  private assertTencentPackMetadata(input: { name: string; description?: string | null }) {
    if (!input.name || [...input.name].length > 60 || input.description && [...input.description].length > 256)
      throw new ConflictException('腾讯云镜像名称须为 1–60 字符，描述最多 256 字符；未提交创建。');
  }
  private tencentCreateImageParameters(artifact: TencentPackRequestSource, input: { name: string; description?: string | null }, disks: Array<{ id: string; diskUsage?: string | null }>) {
    return { InstanceId: artifact.sourceInstanceId, ImageName: input.name, ...(input.description ? { ImageDescription: input.description } : {}),
      // Optional data disks are omitted for a system-only source, matching the official CreateImage example.
      // https://cloud.tencent.com/document/api/213/16726
      ForcePoweroff: 'false', ...(disks.some(disk => disk.diskUsage === 'DATA_DISK') ? { DataDiskIds: disks.filter(disk => disk.diskUsage === 'DATA_DISK').map(disk => disk.id) } : {}),
      TagSpecification: [{ ResourceType: 'image', Tags: Object.entries({ ...this.tags(artifact), CloudProvider: 'tencent_cloud',
        CloudAccountUid: artifact.cloudAccountUid, CloudAccountContextId: artifact.cloudAccountContextId }).map(([Key, Value]) => ({ Key, Value })) }] };
  }
  async submitTencentImage(artifact: PackedImageArtifactRecord & { submissionToken: string }, context: CloudAccountContextCredentials, input: { name: string; description?: string | null }) {
    this.assertContext(artifact, context);
    if (context.provider !== 'tencent_cloud') throw new ConflictException('腾讯云镜像提交需要已绑定腾讯云账号。');
    this.assertTencentPackMetadata(input);
    if (!await this.repository.renewPackedImageArtifactClaim(artifact.id, artifact.submissionToken, new Date(Date.now() + 300_000))) throw new ConflictException('打包提交租约失效。');
    const fresh = await this.repository.getPackedImageArtifact(artifact.id);
    if (!fresh || fresh.status !== 'pending' || fresh.imageId) throw new ConflictException('原打包已提交或结果未知，禁止再次创建。');
    if (!readTencentPackBaseline(fresh)) throw new ConflictException('腾讯云打包缺少完整提交前快照基线；旧或未知记录不可补基线或恢复创建。');
    let phase: 'source_disk_inventory' | 'create_image' = 'source_disk_inventory';
    try {
      const disks = await describeTencentResourceInventory({ ...context, accountUidResolved: true, cloudAccountContextId: context.id,
        defaultRegion: context.regionId, defaultZoneId: context.zoneId }, 'disk', { instanceId: artifact.sourceInstanceId });
      if (disks.length !== artifact.sourceDiskIds.length || disks.some(disk => !artifact.sourceDiskIds.includes(disk.id) || disk.shared)) throw new ConflictException('打包提交前源盘发生变化。');
      await this.updateClaimed(artifact.id, artifact.submissionToken, { status: 'creating' });
      phase = 'create_image';
      return await tencentImageRequest<{ ImageId?: string }>(context, 'cvm', 'CreateImage', this.tencentCreateImageParameters(artifact, input, disks));
    } catch (error) {
      if (error instanceof TencentCloudRequestError) throw new PackedImageCloudError(phase, safePackedCloudCode(error, [context.accessKeyId, context.accessKeySecret]), packedImageDiagnostic(error, phase, [context.accessKeyId, context.accessKeySecret]));
      throw error;
    }
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
    const spaces = await runInSystemCloudWorkspaceScope(() => listExecutionCloudWorkspaces(this.systemConfigService));
    const allowed = spaces ? new Set(spaces.map(space => space.id)) : null;
    const rows = (await runInSystemCloudWorkspaceScope(() => this.repository.listPackedImageArtifacts()))
      .filter(item => ACTIVE.includes(item.status) && (!allowed || item.cloudWorkspaceId && allowed.has(item.cloudWorkspaceId)))
      .sort((a, b) => (a.lastPolledAt?.getTime() ?? 0) - (b.lastPolledAt?.getTime() ?? 0)).slice(0, 20);
    let failed = false;
    for (const row of rows) {
      try {
        await runInExecutionCloudWorkspace(this.systemConfigService, row.cloudWorkspaceId,
          () => this.refresh(row.id), { provider: row.cloudProvider ?? 'alibaba_cloud', accountUid: row.cloudAccountUid });
      } catch { failed = true; }
    }
    if (failed) throw new Error('Packed image polling failed for a source workspace; other pending artifacts were still processed');
  }

  async refresh(id: string) {
    return this.withClaim(id, false, (token) => this.refreshClaimed(id, token));
  }

  private async refreshClaimed(id: string, token: string) {
    let artifact = await this.require(id);
    let phase: PackedImagePhase = 'account_context';
    let diagnosticContext: LeasedContext | undefined;
    try {
      const context = await this.boundContext(artifact, token);
      diagnosticContext = context;
      artifact = await this.updateClaimed(id, token, { lastPolledAt: new Date() });
      if (artifact.status === 'deleting') { phase = 'cleanup'; return await this.processCleanup(artifact, context); }
      if (!ACTIVE.includes(artifact.status)) return artifact;
      let images: Image[];
      phase = 'describe_image';
      if (artifact.imageId) {
        images = await this.describeImages(context, { ImageId: artifact.imageId });
      } else {
        images = await this.describeImages(context, { 'Tag.1.Key': 'PlatformPackedImageArtifactId', 'Tag.1.Value': artifact.id, ImageOwnerAlias: 'self' });
      }
      if (!images.length) return artifact;
      if (images.length !== 1) throw new ConflictException('打包来源标记匹配多个镜像，拒绝自动关联。');
      const image = images[0];
      phase = 'verify_image';
      this.assertImage(artifact, image);
      if (!artifact.imageId) artifact = await this.updateClaimed(id, token, { imageId: image.ImageId, status: 'creating' });
      await this.upsertLedger(artifact, image.ImageId, 'image', token);
      const snapshotIds = this.snapshotIds(image);
      if (image.Status === 'Available' && !snapshotIds.length) throw new ConflictException('打包镜像已可用，但快照绑定信息尚未完整，等待恢复。');
      if (snapshotIds.length) {
        phase = 'snapshot_verify';
        await this.captureSnapshots(artifact, context, snapshotIds);
        artifact = await this.require(id);
      }
      const status = image.Status === 'Available' ? 'available' : /Failed|UnAvailable/i.test(image.Status) ? 'failed' : 'creating';
      phase = 'persist_catalog';
      return this.repository.withPackedImageArtifactClaim(id, token, async repo => {
        await repo.upsertImageSnapshots({ provider: context.provider, accountUid: artifact.cloudAccountUid, regionId: artifact.regionId, scope: 'custom', snapshots: [{ imageId: image.ImageId, sourceImageName: image.ImageName || image.ImageId, minimumSystemDiskSize: image.ImageSize, status: image.Progress && image.Status !== 'Available' ? `${image.Status} ${image.Progress}` : image.Status, isAvailable: image.Status === 'Available', lastSyncedAt: new Date() }] });
        const [source] = await repo.listImageSnapshots({ provider: context.provider, accountUid: artifact.cloudAccountUid, regionId: artifact.regionId, scope: 'custom', imageId: image.ImageId });
        if (artifact.platformImageAssetId && await repo.getPlatformImageAssetById(artifact.platformImageAssetId)) await repo.setPlatformImageAssetEnabled(artifact.platformImageAssetId, image.Status === 'Available');
        return repo.updatePackedImageArtifact(id, { sourceSnapshotId: source.id, status, errorMessage: status === 'failed' ? `云镜像打包失败：${image.Status}` : null });
      });
    } catch (error) {
      // A later failed observation must not erase the original bounded submission rejection receipt.
      if (artifact.cloudProvider === 'tencent_cloud' && !artifact.imageId && readPackedImageDiagnostic(artifact.errorMessage).phase === 'create_image') return artifact;
      if (artifact.cloudProvider === 'tencent_cloud') return this.updateClaimed(id, token, { errorMessage: encodePackedImageDiagnostic(packedImageDiagnostic(error, phase, diagnosticContext ? [diagnosticContext.accessKeyId, diagnosticContext.accessKeySecret] : [])) });
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
        await repo.upsertImageSnapshots({ provider: context.provider, accountUid: artifact.cloudAccountUid, regionId: artifact.regionId, scope: 'custom', snapshots: [{ imageId: artifact.imageId!, sourceImageName: artifact.imageId!, status: 'Deleting', isAvailable: false, lastSyncedAt: new Date() }] });
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
        if (context.provider === 'tencent_cloud' && image.Status !== 'Available' && !/Failed|UnAvailable/i.test(image.Status)) throw new ConflictException('腾讯云镜像操作仍在进行，请查询终态后再清理。');
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
        await repo.upsertImageSnapshots({ provider: context.provider, accountUid: artifact.cloudAccountUid, regionId: artifact.regionId, scope: 'custom', snapshots: [{ imageId: artifact.imageId!, sourceImageName: artifact.imageId!, status: 'Deleted', isAvailable: false, lastSyncedAt: new Date() }] });
      }
      return repo.updatePackedImageArtifact(artifact.id, { status: 'deleted', completedAt: new Date(), errorMessage: null });
    });
  }

  private async captureSnapshots(artifact: PackedImageArtifactRecord, context: LeasedContext, ids: string[]) {
    if (ids.length !== artifact.sourceDiskIds.length) {
      if (context.provider === 'tencent_cloud') throw new PackedImageVerificationError('snapshot_coverage', undefined, 'snapshot_verify');
      throw new ConflictException('打包镜像快照清单未覆盖全部源磁盘，等待完整结果。');
    }
    if (artifact.backingSnapshotIds.length && artifact.backingSnapshotIds.sort().join(',') !== [...ids].sort().join(',')) throw new ConflictException('已记录的打包快照绑定发生变化。');
    // Save the binding before cloud tagging; a denied tag request must not lose billable identities.
    await this.updateClaimed(artifact.id, context.artifactLease!.token, { backingSnapshotIds: ids });
    const capturedDisks = new Set<string>();
    for (const sid of ids) {
      const snapshot = await this.describeSnapshot(context, sid);
      if (!snapshot || !this.isFreshSourceSnapshot(artifact, snapshot)) {
        if (artifact.cloudProvider === 'tencent_cloud') {
          const baseline = readTencentPackBaseline(artifact), tc = snapshot as TencentSnapshot | null;
          throw new PackedImageVerificationError('snapshot_source', { snapshotChecks: { validBaseline: Boolean(baseline), newSnapshot: Boolean(snapshot && baseline && !baseline.preCreateSnapshotIds.includes(snapshot.SnapshotId)),
            regionMatches: snapshot?.RegionId === artifact.regionId, sourceDiskMatches: Boolean(snapshot?.SourceDiskId && baseline?.sourceDiskIds.includes(snapshot.SourceDiskId)),
            privateSnapshot: tc?.SnapshotType === 'PRIVATE_SNAPSHOT', notCopied: tc?.CopyFromRemote === false && !tc?.SourceSnapshotId, notShared: tc?.ShareReference === 0 } }, 'snapshot_verify');
        }
        throw new ConflictException('快照来源、地域或创建时间不匹配，拒绝标记外部快照。');
      }
      if (capturedDisks.has(snapshot.SourceDiskId!)) throw new ConflictException('打包快照重复引用同一源磁盘，拒绝不完整清单。');
      capturedDisks.add(snapshot.SourceDiskId!);
      if (context.provider === 'tencent_cloud' && ((snapshot as TencentSnapshot).ImageIds.length !== 1 || (snapshot as TencentSnapshot).ImageIds[0] !== artifact.imageId)) throw new PackedImageVerificationError('snapshot_image_binding', undefined, 'snapshot_verify');
      const existingTags = cloudTags(snapshot.Tags);
      if (context.provider === 'tencent_cloud' && Object.entries({ CloudProvider: 'tencent_cloud', CloudAccountUid: artifact.cloudAccountUid, CloudAccountContextId: artifact.cloudAccountContextId }).some(([key,value]) => existingTags[key] !== undefined && existingTags[key] !== value)) throw new PackedImageVerificationError('snapshot_namespace_tags', undefined, 'snapshot_verify');
      if ((existingTags.PlatformPackedImageArtifactId && existingTags.PlatformPackedImageArtifactId !== artifact.id)
        || (existingTags.PlatformUserId && existingTags.PlatformUserId !== artifact.ownerUserId)
        || (existingTags.CreatedBy && existingTags.CreatedBy !== 'cyber-range-platform')) {
        if (context.provider === 'tencent_cloud') throw new PackedImageVerificationError('snapshot_owner_tags', undefined, 'snapshot_verify');
        throw new ConflictException('快照已有其它来源或 owner 标记，拒绝覆盖。');
      }
    }
    for (const sid of ids) {
      try { await this.upsertLedger(artifact, sid, 'snapshot', context.artifactLease!.token); }
      catch (error) { if (context.provider === 'tencent_cloud') throw new PackedImageCloudError('snapshot_ledger', 'UNKNOWN'); throw error; }
    }
    for (const sid of ids) {
      if (context.provider === 'tencent_cloud') {
        await this.repository.withPackedImageArtifactClaim(artifact.id, context.artifactLease!.token, repo => repo.renewPackedImageArtifactClaim(artifact.id, context.artifactLease!.token, new Date(Date.now() + 300_000)));
        try { await tagTencentImageResources(context, 'snapshot', [sid], { ...this.tags(artifact), PlatformResourceType: 'snapshot', CloudAccountUid: artifact.cloudAccountUid, CloudAccountContextId: artifact.cloudAccountContextId, CloudProvider: 'tencent_cloud' }); }
        catch (error) { if (error instanceof TencentCloudRequestError) throw new PackedImageCloudError('snapshot_tagging', safePackedCloudCode(error, [context.accessKeyId, context.accessKeySecret]), packedImageDiagnostic(error, 'snapshot_tagging', [context.accessKeyId, context.accessKeySecret])); throw error; }
      } else await this.rpc(context, 'TagResources', { ResourceType: 'snapshot', 'ResourceId.1': sid, ...buildAliyunTagParameters({ ...this.tags(artifact), PlatformResourceType: 'snapshot' }) });
    }
    await this.updateClaimed(artifact.id, context.artifactLease!.token, { backingSnapshotIds: ids });
  }

  private isFreshSourceSnapshot(artifact: PackedImageArtifactRecord, snapshot: Snapshot) {
    const tencent = snapshot as Snapshot & Partial<TencentSnapshot>;
    if ((artifact.cloudProvider ?? 'alibaba_cloud') === 'tencent_cloud') {
      const baseline = readTencentPackBaseline(artifact);
      return Boolean(baseline && /^snap-[A-Za-z0-9]+$/.test(snapshot.SnapshotId) && !baseline.preCreateSnapshotIds.includes(snapshot.SnapshotId)
        && snapshot.RegionId === artifact.regionId && !!snapshot.SourceDiskId && baseline.sourceDiskIds.includes(snapshot.SourceDiskId)
        && !snapshot.SourceSnapshotId && tencent.SnapshotType === 'PRIVATE_SNAPSHOT' && tencent.CopyFromRemote === false && tencent.ShareReference === 0);
    }
    const privateOrigin = !snapshot.SnapshotId.startsWith('snap-') || tencent.SnapshotType === 'PRIVATE_SNAPSHOT' && tencent.CopyFromRemote === false && tencent.ShareReference === 0;
    return privateOrigin && (snapshot.SnapshotId.startsWith('s-') || snapshot.SnapshotId.startsWith('snap-')) && snapshot.RegionId === artifact.regionId && !snapshot.SourceSnapshotId
      && !!snapshot.SourceDiskId && artifact.sourceDiskIds.includes(snapshot.SourceDiskId)
      && !!snapshot.CreationTime && Number.isFinite(Date.parse(snapshot.CreationTime)) && Date.parse(snapshot.CreationTime) >= artifact.createdAt.getTime() - 30_000
      && Date.parse(snapshot.CreationTime) <= Date.now() + 30_000;
  }

  private async assertSnapshotProof(artifact: PackedImageArtifactRecord, snapshot: Snapshot) {
    const tags = cloudTags(snapshot.Tags);
    if (artifact.cloudProvider === 'tencent_cloud' && (tags.CloudProvider !== 'tencent_cloud' || tags.CloudAccountUid !== artifact.cloudAccountUid || tags.CloudAccountContextId !== artifact.cloudAccountContextId)) throw new ConflictException('腾讯云快照账号与打包来源证明不一致。');
    if (!this.isFreshSourceSnapshot(artifact, snapshot) || tags.PlatformPackedImageArtifactId !== artifact.id || tags.PlatformUserId !== artifact.ownerUserId || tags.CreatedBy !== 'cyber-range-platform') throw new ConflictException('快照来源或 owner 证明不匹配。');
    const ledger = (await this.repository.listBillingLedgerResources()).find(item => item.cloudProvider === (artifact.cloudProvider ?? 'alibaba_cloud') && item.cloudAccountUid === artifact.cloudAccountUid && item.regionId === artifact.regionId && item.cloudResourceType === 'snapshot' && item.cloudResourceId === snapshot.SnapshotId && item.ownerUserId === artifact.ownerUserId && item.tagsSnapshot.PlatformPackedImageArtifactId === artifact.id);
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
    const provider = artifact.cloudProvider ?? 'alibaba_cloud';
    const existing = await repo.findBillingLedgerResource({ cloudProvider: provider, regionId: artifact.regionId, cloudResourceId, cloudResourceType });
    if (existing && (existing.cloudAccountUid !== artifact.cloudAccountUid || existing.ownerUserId !== artifact.ownerUserId || (existing.tagsSnapshot.PlatformPackedImageArtifactId && existing.tagsSnapshot.PlatformPackedImageArtifactId !== artifact.id))) throw new ConflictException('资源台账 owner、来源或云账号不匹配。');
    const sourceInstance = await repo.getRangeInstanceById(artifact.sourceRangeInstanceId);
    const sourceEcs = await repo.findBillingLedgerResource({ cloudProvider: provider, regionId: artifact.regionId, cloudResourceId: artifact.sourceInstanceId, cloudResourceType: 'ecs' });
    const provenSourceEcs = sourceEcs?.cloudAccountUid === artifact.cloudAccountUid && sourceEcs.ownerUserId === artifact.ownerUserId && sourceEcs.rangeInstanceId === artifact.sourceRangeInstanceId ? sourceEcs : null;
    const sourceJob = (await repo.listProvisionJobs()).filter(job => job.rangeInstanceId === artifact.sourceRangeInstanceId && job.jobType === 'create' && job.status === 'succeeded').sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];
    const tagsSnapshot: Record<string, string> = { ...this.tags(artifact), CloudProvider: provider, CloudAccountUid: artifact.cloudAccountUid, CloudAccountContextId: artifact.cloudAccountContextId };
    const singleInstanceBatchId = provenSourceEcs?.singleInstanceBatchId ?? sourceInstance?.singleInstanceBatchId ?? existing?.singleInstanceBatchId ?? null;
    if (singleInstanceBatchId) tagsSnapshot.SingleInstanceBatchId = singleInstanceBatchId;
    const data = { billingScope: 'user' as const, ownerUserId: artifact.ownerUserId, rangeInstanceId: artifact.sourceRangeInstanceId, singleInstanceBatchId, sourceProvisionJobId: provenSourceEcs?.sourceProvisionJobId ?? existing?.sourceProvisionJobId ?? sourceJob?.id ?? null, platformImageAssetId: artifact.platformImageAssetId, releasedAt: null, tagsSnapshot };
    if (existing) await repo.updateBillingLedgerResource(existing.id, data);
    else await repo.createBillingLedgerResource({ ...data, cloudProvider: provider, cloudAccountUid: artifact.cloudAccountUid, regionId: artifact.regionId, cloudResourceId, cloudResourceType, billingStartAt: artifact.createdAt });
  }

  private async releaseLedger(artifact: PackedImageArtifactRecord, id: string, type: 'image' | 'snapshot', token: string) {
    return this.repository.withPackedImageArtifactClaim(artifact.id, token, async repo => {
      const rows = await repo.listBillingLedgerResources();
      for (const item of rows.filter(item => item.cloudProvider === (artifact.cloudProvider ?? 'alibaba_cloud') && item.cloudAccountUid === artifact.cloudAccountUid && item.regionId === artifact.regionId && item.cloudResourceId === id && item.cloudResourceType === type && item.tagsSnapshot.PlatformPackedImageArtifactId === artifact.id && !item.releasedAt)) {
        await repo.updateBillingLedgerResource(item.id, { releasedAt: new Date() });
      }
    });
  }

  private tags(artifact: Pick<PackedImageArtifactRecord, 'id' | 'ownerUserId' | 'sourceRangeInstanceId' | 'sourceHostKey' | 'platformImageAssetId' | 'createdAt'>) {
    return buildBillingTags({ billingScope: 'user', ownerUserId: artifact.ownerUserId, rangeInstanceId: artifact.sourceRangeInstanceId, platformImageAssetId: artifact.platformImageAssetId, platformHostKey: artifact.sourceHostKey, platformPackedImageArtifactId: artifact.id, billingStartAt: artifact.createdAt });
  }

  private assertImage(artifact: PackedImageArtifactRecord, image: Image) {
    const tags = cloudTags(image.Tags);
    if (artifact.cloudProvider === 'tencent_cloud' && (!readTencentPackBaseline(artifact) || image.ImageType !== 'PRIVATE_IMAGE' || tags.CloudAccountUid !== artifact.cloudAccountUid
      || tags.CloudAccountContextId !== artifact.cloudAccountContextId || tags.CloudProvider !== 'tencent_cloud')) throw new ConflictException('腾讯云镜像缺少冻结厂商与账号来源证明。');
    if ((artifact.imageId && artifact.imageId !== image.ImageId) || tags.PlatformPackedImageArtifactId !== artifact.id || tags.PlatformImageOrigin !== 'instance_pack' || tags.CreatedBy !== 'cyber-range-platform' || tags.PlatformUserId !== artifact.ownerUserId || !image.Status) throw new ConflictException('云镜像来源或 owner 证明不匹配。');
  }

  private snapshotIds(image: Image) {
    const entries = image.DiskDeviceMappings?.DiskDeviceMapping;
    if (!Array.isArray(entries)) return [];
    const ids = entries.map(item => item.SnapshotId ?? '');
    if (ids.some(id => !(id.startsWith('snap-') ? /^snap-[A-Za-z0-9]+$/ : /^s-/).test(id)) || new Set(ids).size !== ids.length) throw new ConflictException('云镜像 backing snapshot 清单格式不完整。');
    return ids;
  }

  async describeImages(context: CloudAccountContextCredentials, parameters: Record<string, string>) {
    if (context.provider === 'tencent_cloud') return describeTencentImages(context, parameters.ImageId ? { ImageId: parameters.ImageId } : {
      ...(parameters.SnapshotId ? { SnapshotId: parameters.SnapshotId } : {}),
      ...(parameters['Tag.1.Key'] ? { tags: { [parameters['Tag.1.Key']]: parameters['Tag.1.Value'] } } : {}) });
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
    if (context.provider === 'tencent_cloud') return describeTencentSnapshot(context, sid);
    const body = await this.rpc(context, 'DescribeSnapshots', { SnapshotIds: JSON.stringify([sid]), Status: 'all', PageNumber: '1', PageSize: '100' });
    const rows = cloudItems<Snapshot>(body, 'Snapshots', 'Snapshot');
    if (rows.some(item => item.SnapshotId !== sid) || rows.length > 1 || (body as { NextToken?: string }).NextToken || cloudPage(body, 1, 100, rows.length) !== rows.length) throw new Error('Invalid snapshot query identity/pagination');
    return rows[0] ?? null;
  }

  private assertContext(artifact: { cloudAccountUid: string; regionId: string; cloudAccountContextId?: string }, context: CloudAccountContextCredentials) {
    if (!['alibaba_cloud', 'tencent_cloud'].includes(context.provider)) throw new ConflictException('该云厂商的镜像打包与快照回收尚未开放。');
    if (artifact.cloudAccountContextId && artifact.cloudAccountContextId !== context.id || (artifact as PackedImageArtifactRecord).cloudProvider && (artifact as PackedImageArtifactRecord).cloudProvider !== context.provider || !artifact.cloudAccountUid || artifact.cloudAccountUid !== context.accountUid || artifact.regionId !== context.regionId) throw new ConflictException('打包云账号或地域上下文不匹配。');
  }
  private async boundContext(artifact: PackedImageArtifactRecord, token: string): Promise<LeasedContext> {
    const context = await this.contexts.getCredentials(artifact.cloudAccountContextId, { requireReady: true });
    this.assertContext(artifact, context); return { ...context, artifactLease: { id: artifact.id, token } };
  }
  private async rpc<T = unknown>(context: LeasedContext, action: string, parameters: Record<string, string>) {
    if (context.artifactLease && !await this.repository.renewPackedImageArtifactClaim(context.artifactLease.id, context.artifactLease.token, new Date(Date.now() + 300_000))) throw new ConflictException('打包资源操作租约已失效，请重试。');
    if (context.provider === 'tencent_cloud') {
      if (action === 'DeleteImage') return deleteTencentImage(context, parameters.ImageId) as Promise<T>;
      if (action === 'DeleteSnapshot') return deleteTencentSnapshot(context, parameters.SnapshotId) as Promise<T>;
      throw new ConflictException('腾讯云打包 RPC 操作不在已核验接口范围内。');
    }
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
