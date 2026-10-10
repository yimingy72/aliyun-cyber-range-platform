import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';

import type { SessionUserProfile } from './admin-user-auth';
import { attachCreatedByUsernames } from './creator-display';
import { generateAliyunEcsPassword } from './ecs-password-generator';
import {
  ADMIN_REPOSITORY,
  type AdminRepository,
  type RangeInstanceRecord,
  type PlatformImageAssetRecord,
} from './admin.repository';
import { RangeInstanceNodeActionsService } from './range-instance-node-actions.service';
import { SingleInstanceBatchExecutionService } from './single-instance-batch-execution.service';
import { SingleInstanceNetworkService } from './single-instance-network.service';
import { assertTencentImagesAvailable } from '../provisioning/tencent-cloud-zone-instance-scheduler';
import { SystemConfigService, type InstanceTypeAvailabilitySnapshot, type SystemCloudAccountContext } from './system-config.service';
import type { LaunchSingleInstanceDto } from './dto/single-instance.dto';
import { ProvisioningWorkerService } from '../provisioning/provisioning-worker.service';
import { buildSingleInstanceBlueprint } from './single-instance-blueprint';
import { readTencentSingleRecordedResourceStatus } from './single-instance-recorded-resource-status';
import { packedImageArtifactSummaries } from './packed-image-diagnostic';
import { readPackedImageSourceSnapshots } from './packed-image-source-observation';

const SINGLE_INSTANCE_ACTION_ALLOWLIST = new Set(['reboot', 'open-vnc', 'pack-image']);

@Injectable()
export class SingleInstancesService {
  constructor(
    @Inject(ADMIN_REPOSITORY) private readonly adminRepository: AdminRepository,
    private readonly systemConfigService: SystemConfigService,
    private readonly singleInstanceNetworkService: SingleInstanceNetworkService,
    private readonly singleInstanceBatchExecutionService: SingleInstanceBatchExecutionService,
    private readonly provisioningWorkerService: ProvisioningWorkerService,
    private readonly rangeInstanceNodeActionsService: RangeInstanceNodeActionsService,
  ) {}

  async list(currentUser: SessionUserProfile, view: 'active' | 'history' = 'active') {
    const instances = await this.adminRepository.listRangeInstances();
    const visibleInstances =
      currentUser.role === 'admin'
        ? instances
        : instances.filter((instance) => this.isOwnedBy(instance.ownerUserId, instance.createdBy, currentUser.id));
    const batches = await this.adminRepository.listSingleInstanceBatchesWithInstances();
    const batchIds = new Set(batches.map((entry) => entry.batch.id));
    const standaloneInstances = visibleInstances.filter(
      (instance) =>
        instance.instanceMode === 'single' &&
        (!instance.singleInstanceBatchId || !batchIds.has(instance.singleInstanceBatchId)),
    );
    const visibleBatches =
      currentUser.role === 'admin'
        ? batches
        : batches
            .filter((entry) => this.isOwnedBy(entry.batch.ownerUserId, entry.batch.createdBy, currentUser.id))
            .map((entry) => ({
              ...entry,
              instances: entry.instances.filter((instance) =>
                this.isOwnedBy(instance.ownerUserId, instance.createdBy, currentUser.id),
              ),
            }));

    const isHistoryView = view === 'history';
    const normalizedBatches = await Promise.all(
      visibleBatches
        .map((entry) => ({
          ...entry,
          instances: entry.instances.filter(
            (instance) => isSingleInstanceHistoryStatus(instance.status) === isHistoryView,
          ),
        }))
        .filter((entry) => entry.instances.length > 0)
        .map(async (entry) => {
          const [batch] = await attachCreatedByUsernames(this.adminRepository, [entry.batch]);
          const instances = await attachCreatedByUsernames(
            this.adminRepository,
            entry.instances.map((instance) => toSingleInstanceListItem(instance)),
          );

          return {
            ...entry,
            batch,
            instances,
          };
        }),
    );

    const standaloneItems = await attachCreatedByUsernames(
      this.adminRepository,
      standaloneInstances.map((instance) => toSingleInstanceListItem(instance)),
    );
    const standaloneForView = standaloneItems.filter((instance) =>
      isSingleInstanceHistoryStatus(instance.status) === isHistoryView,
    );

    return {
      batches: normalizedBatches,
      standaloneInstances: standaloneForView,
    };
  }

  async getById(id: string, currentUser: SessionUserProfile) {
    const instance = await this.requireSingleInstance(id, currentUser);
    const [detail] = await attachCreatedByUsernames(this.adminRepository, [toSingleInstanceListItem(instance)]);
    const packedImageArtifacts = packedImageArtifactSummaries(instance, await this.adminRepository.listPackedImageArtifacts({ cloudAccountUid: instance.singleInstanceConfig?.cloudAccountUid ?? undefined,
      regionId: instance.singleInstanceConfig?.regionId }));
    const packSourceSnapshots = await readPackedImageSourceSnapshots(packedImageArtifacts, this.systemConfigService);
    return { ...detail, packedImageArtifacts, packSourceSnapshots };
  }

  async getCloudResourceStatus(id: string, currentUser: SessionUserProfile) {
    const instance = await this.requireSingleInstance(id, currentUser);
    const recordedResourceStatus = instance.cloudProvider === 'tencent_cloud'
      ? await readTencentSingleRecordedResourceStatus(instance, await this.singleInstanceBatchExecutionService.resolveInstanceAccount(instance), this.adminRepository)
      : undefined;
    const result = await this.singleInstanceBatchExecutionService.findCloudInstanceIdsByRangeInstanceId(instance.id, instance);

    return {
      singleInstanceId: instance.id,
      regionId: result.regionId,
      exists: result.instanceIds.length > 0,
      instanceIds: result.instanceIds,
      matchedInstances:result.matchedInstances,
      checkedAt: new Date().toISOString(),
      ...(recordedResourceStatus ? { recordedResourceStatus } : {}),
    };
  }

  async getAccessById(id: string, currentUser: SessionUserProfile) {
    const instance = await this.requireSingleInstance(id, currentUser);
    return {
      id: instance.id,
      runtimeCredentials: instance.runtimeCredentials,
      accessEntry: instance.accessEntry
        ? {
            hostRole: instance.accessEntry.hostRole,
            publicIp: instance.accessEntry.publicIp,
            privateIp: instance.accessEntry.privateIp,
            ssh: instance.accessEntry.ssh,
          }
        : null,
    };
  }

  async prepareLaunchConfirmation(input: LaunchSingleInstanceDto & { expiresAt: string }, currentUserId: string) {
    const image = await this.requireEnabledPlatformImage(input.platformImageAssetId, currentUserId);
    const systemDiskSize = input.systemDiskSize ?? (image.provider === 'tencent_cloud' ? 50 : 40);
    const ingress = 'TCP 1-65535 from 0.0.0.0/0';
    return {
      targetId: image.id,
      targetSnapshot: {
        imageId: image.imageId,
        imageName: image.displayName,
        instanceName: input.name,
        cpu: input.cpu,
        memory: input.memory,
        systemDiskSize,
        quantity: input.quantity,
        expiresAt: input.expiresAt,
        ingress,
      },
      summary: {
        targetName: input.name,
        imageName: image.displayName,
        cpu: input.cpu,
        memory: input.memory,
        systemDiskSize,
        quantity: input.quantity,
        expiresAt: input.expiresAt,
        ingress,
        destructive: false,
      },
    };
  }

  async prepareDestroyConfirmation(id: string, currentUser: SessionUserProfile) {
    const instance = await this.requireSingleInstance(id, currentUser);
    return {
      targetId: instance.id,
      targetSnapshot: { status: instance.status, name: instance.name },
      summary: { targetName: instance.name || instance.id, destructive: true },
    };
  }

  async prepareDestroyBatchConfirmation(batchId: string, currentUser: SessionUserProfile) {
    const groups = await this.adminRepository.listSingleInstanceBatchesWithInstances();
    const group = groups.find((entry) => entry.batch.id === batchId);
    if (!group) {
      throw new NotFoundException('Single instance batch not found');
    }
    this.assertBatchAccess(group.batch.ownerUserId, group.batch.createdBy, currentUser);
    return {
      targetId: group.batch.id,
      targetSnapshot: {
        batchName: group.batch.name,
        instanceCount: group.instances.filter((instance) => !isSingleInstanceHistoryStatus(instance.status)).length,
      },
      summary: { targetName: group.batch.name, destructive: true },
    };
  }

  async prepareRetryConfirmation(id: string, currentUser: SessionUserProfile) {
    const instance = await this.requireSingleInstance(id, currentUser);
    return {
      targetId: instance.id,
      targetSnapshot: { status: instance.status, name: instance.name },
      summary: { targetName: instance.name || instance.id, destructive: false },
    };
  }

  async prepareActionConfirmation(id: string, action: 'reboot' | 'pack-image', currentUser: SessionUserProfile) {
    const instance = await this.requireSingleInstance(id, currentUser);
    return {
      targetId: instance.id,
      targetSnapshot: { status: instance.status, name: instance.name, action },
      summary: { targetName: instance.name || instance.id, action, destructive: action === 'reboot' },
    };
  }

  async launch(input: LaunchSingleInstanceDto & { expiresAt: string }, currentUserId: string) {
    this.assertFutureInstanceExpiration(input.expiresAt);
    const accountContext = { ...await this.systemConfigService.getExecutionAccountContext() };
    if (!accountContext.accountUid || !accountContext.cloudAccountContextId) throw new ConflictException('创建实例前必须配置并验证云账号。');
    if (accountContext.provider === 'tencent_cloud' && new Date(input.expiresAt).getTime() - Date.now() <= 10 * 60_000) throw new ConflictException('腾讯云定时销毁需至少预留十分钟，请延长实例到期时间。');
    await this.requireEnabledPlatformImage(input.platformImageAssetId, currentUserId, accountContext);
    const offered = await this.systemConfigService.getInstanceTypeAvailabilityInContext({ cpu: input.cpu, memory: input.memory }, accountContext);
    const matches = accountContext.provider === 'tencent_cloud' ? offered.matches.filter(match => match.architecture === 'X86_64') : offered.matches;
    const availability = { ...offered, matches, exactAvailable: offered.exactAvailable && matches.length > 0 };
    if (!availability.exactAvailable || !availability.matches.length) throw new ConflictException(availability.warning ?? '规格不可售');
    return this.adminRepository.withSingleInstanceControlLock(() => this.launchLocked(input, currentUserId, accountContext, availability));
  }

  private async launchLocked(input: LaunchSingleInstanceDto & { expiresAt: string }, currentUserId: string,
    accountContext: SystemCloudAccountContext, availability: InstanceTypeAvailabilitySnapshot) {
    this.assertFutureInstanceExpiration(input.expiresAt);
    const systemDiskSize = input.systemDiskSize ?? (accountContext.provider === 'tencent_cloud' ? 50 : 40);
    if (accountContext.provider === 'tencent_cloud' && availability.matches[0]?.architecture !== 'X86_64') throw new ConflictException('腾讯云实例需要已核验的 x86_64 可售机型。');

    if (accountContextFingerprint(accountContext) !== accountContextFingerprint(await this.systemConfigService.getExecutionAccountContext()))
      throw new ConflictException('云账号配置在规格检查期间发生变化，请重新提交。');
    await this.requireEnabledPlatformImage(input.platformImageAssetId, currentUserId, accountContext);
    if (accountContext.provider === 'tencent_cloud') {
      const selectedImage = await this.requireEnabledPlatformImage(input.platformImageAssetId,currentUserId,accountContext);
      const metadata = await assertTencentImagesAvailable(accountContext,[selectedImage.imageId]);
      if (systemDiskSize < metadata[selectedImage.imageId].minimumSystemDiskSize) throw new ConflictException(`腾讯云镜像至少需要 ${metadata[selectedImage.imageId].minimumSystemDiskSize} GiB 系统盘。`);
    }
    const profile = await this.singleInstanceNetworkService.ensureDefaultProfile(accountContext,currentUserId);
    this.assertFutureInstanceExpiration(input.expiresAt);
    const image = await this.requireEnabledPlatformImage(input.platformImageAssetId, currentUserId, accountContext);
    if (accountContext.provider === 'tencent_cloud') {
      const metadata = await assertTencentImagesAvailable(accountContext,[image.imageId]);
      if (systemDiskSize < metadata[image.imageId].minimumSystemDiskSize) throw new ConflictException('腾讯云镜像系统盘要求已变化，请重新提交。');
    }
    const sourceSnapshot = image.sourceSnapshotId ? await this.adminRepository.getImageSnapshotById(image.sourceSnapshotId) : null;
    const runtimeUsername = `${sourceSnapshot?.osType ?? ''} ${sourceSnapshot?.platform ?? image.displayName}`.toLowerCase().includes('windows') ? 'Administrator' : 'root';
    const sharedPassword = input.password?.trim() || null;
    const quantity = input.quantity;
    const activeCount = (await this.adminRepository.listRangeInstances()).filter(
      (instance) => instance.instanceMode === 'single' && !isSingleInstanceHistoryStatus(instance.status),
    ).length;
    const created = [];
    const jobIds: string[] = [];
    const batch = await this.adminRepository.createSingleInstanceBatch({
      name: input.name,
      platformImageAssetId: image.id,
      imageId: image.imageId,
      imageDisplayName: image.displayName,
      cpu: input.cpu,
      memory: input.memory,
      systemDiskSize,
      quantity,
      remark: input.remark?.trim() || null,
      createdBy: currentUserId,
      ownerUserId: currentUserId,
      expiresAt: new Date(input.expiresAt),
    });

    try {
      for (let index = 0; index < quantity; index += 1) {
        const quantityIndex = index + 1;
        const password = sharedPassword ?? generateAliyunEcsPassword();
        const network = this.singleInstanceNetworkService.allocateVswitch(profile, activeCount + index);
        const name = this.resolveIndexedValue(input.name, quantityIndex, quantity);
        const requestedHostBaseName =
          normalizeOptionalValue(input.hostName) ?? normalizeOptionalValue(image.defaultHostName) ?? null;
        const hostName = requestedHostBaseName
          ? this.resolveIndexedValue(requestedHostBaseName, quantityIndex, quantity)
          : null;
        const hostKey = `single-ecs-${quantityIndex}`;
        const blueprint = buildSingleInstanceBlueprint({
          resolvedInstanceType: availability.matches[0].instanceTypeId,
          name,
          hostKey,
          hostName: hostName ?? name,
          privateIp: network.privateIp,
          password,
          cpu: input.cpu,
          memory: input.memory,
          image,
          regionId: profile.regionId,
          zoneId: profile.zoneId,
          vpcCidr: profile.vpcCidr,
          zoneKey: network.zoneKey,
          zoneCidr: network.vswitchCidr,
        });

        const instance = await this.adminRepository.createRangeInstance({
          name,
          createdBy: currentUserId,
          ownerUserId: currentUserId,
          cloudProvider: accountContext.provider,
          instanceMode: 'single',
          singleInstanceBatchId: batch.id,
          status: 'pending_create',
          expiresAt: input.expiresAt,
          runtimeTopologyGraph: blueprint.runtimeTopologyGraph,
          runtimeScenarioTemplateSpec: blueprint.runtimeScenarioTemplateSpec as Record<string, unknown>,
          runtimeCompiledProvisionSpec: blueprint.runtimeCompiledProvisionSpec as Record<string, unknown>,
          runtimeCredentials: {
            [hostKey]: {
              username: runtimeUsername,
              password,
            },
          },
          singleInstanceConfig: {
            executionBackend: 'opentofu',
            cloudAccountContextId: accountContext.cloudAccountContextId,
            cloudAccountUid: accountContext.accountUid, regionId: profile.regionId, zoneId: profile.zoneId,
            networkProfileId: profile.id, resolvedInstanceType: availability.matches[0].instanceTypeId,
            autoReleaseTime: accountContext.provider === 'tencent_cloud' ? new Date(input.expiresAt).toISOString().replace(/\.\d{3}Z$/, 'Z') : new Date(input.expiresAt).getTime()-Date.now()>=30*60_000 ? new Date(input.expiresAt).toISOString().replace(/\.\d{3}Z$/, 'Z') : null,
            baseName: input.name,
            quantityIndex,
            hostKey,
            hostName,
            platformImageAssetId: image.id,
            imageId: image.imageId,
            imageDisplayName: image.displayName,
            cpu: input.cpu,
            memory: input.memory,
            systemDiskSize,
            remark: input.remark?.trim() || null,
            assignedVswitchId: network.vswitchId,
          },
        });
        const job = await this.adminRepository.createProvisionJob({
          rangeInstanceId: instance.id,
          jobType: 'create',
          triggeredBy: currentUserId,
        });
        jobIds.push(job.id);
        const updated = await this.adminRepository.updateRangeInstance(instance.id, {
          lastJobId: job.id,
        });

        created.push(updated);
      }
    } catch(error) {
      // Intake holds the native control lock: workers cannot enter cloud execution until it commits.
      const members=(await this.adminRepository.listRangeInstances()).filter(instance=>instance.singleInstanceBatchId===batch.id);
      const jobs=(await this.adminRepository.listProvisionJobs()).filter(job=>jobIds.includes(job.id));
      for(const member of members) {
        const job=jobs.find(value=>value.rangeInstanceId===member.id);
        if(job) await this.adminRepository.updateProvisionJob(job.id,{status:'failed',finishedAt:new Date(),errorSummary:'Batch intake aborted before cloud execution'});
        await this.adminRepository.updateRangeInstance(member.id,{status:'create_failed',lastJobId:job?.id??null,errorSummary:'Batch intake aborted before cloud execution'});
      }
      throw error;
    }

    const [normalizedBatch] = await attachCreatedByUsernames(this.adminRepository, [batch]);

    return {
      batch: normalizedBatch,
      instances: await attachCreatedByUsernames(this.adminRepository, created),
    };
  }

  async destroyBatch(batchId: string, currentUser: SessionUserProfile) {
    return this.adminRepository.withSingleInstanceControlLock(() => this.destroyBatchLocked(batchId, currentUser));
  }

  private async destroyBatchLocked(batchId: string, currentUser: SessionUserProfile) {
    const groups = await this.adminRepository.listSingleInstanceBatchesWithInstances();
    const group = groups.find((entry) => entry.batch.id === batchId);

    if (!group) {
      throw new NotFoundException('Single instance batch not found');
    }

    this.assertBatchAccess(group.batch.ownerUserId, group.batch.createdBy, currentUser);

    if(currentUser.role !== 'admin' && group.instances.some(instance=>!this.isOwnedBy(instance.ownerUserId,instance.createdBy,currentUser.id))) throw new ForbiddenException('Single instance batch member access denied');
    if (group.instances.some(instance => ['pending_create','creating'].includes(instance.status))) throw new ConflictException('批次仍在创建，请等待创建完成后销毁。');
    await this.assertOpenTofuBatchCreationFinished(group.instances);
    const targetInstances = group.instances.filter((instance) => ['running','destroy_failed'].includes(instance.status));

    for (const instance of targetInstances) {
      const job = await this.adminRepository.createProvisionJob({
        rangeInstanceId: instance.id,
        jobType: 'destroy',
        triggeredBy: currentUser.id,
      });

      await this.adminRepository.updateRangeInstance(instance.id, {
        status: 'pending_destroy',
        lastJobId: job.id,
      });
    }

    return {
      batchId,
      jobCount: targetInstances.length,
    };
  }

  async destroy(id: string, currentUser: SessionUserProfile) {
    return this.adminRepository.withSingleInstanceControlLock(() => this.destroyLocked(id, currentUser));
  }

  private async destroyLocked(id: string, currentUser: SessionUserProfile) {
    const instance = await this.requireSingleInstance(id, currentUser);
    if (instance.singleInstanceConfig?.executionBackend === 'opentofu' && instance.singleInstanceBatchId) {
      const group = await this.adminRepository.getSingleInstanceBatchWithInstancesById(instance.singleInstanceBatchId);
      if (!group) throw new ConflictException('OpenTofu 批次记录缺失，暂不能销毁。');
      await this.assertOpenTofuBatchCreationFinished(group.instances);
    }

    if (!['running', 'destroy_failed'].includes(instance.status)) {
      throw new ConflictException('Single instance cannot start a destroy job from the current status');
    }

    const job = await this.adminRepository.createProvisionJob({
      rangeInstanceId: id,
      jobType: 'destroy',
      triggeredBy: currentUser.id,
    });

    await this.adminRepository.updateRangeInstance(id, {
      status: 'pending_destroy',
      lastJobId: job.id,
    });

    return job;
  }

  async retry(id: string, currentUser: SessionUserProfile) {
    return this.adminRepository.withSingleInstanceControlLock(() => this.retryLocked(id, currentUser));
  }

  private async retryLocked(id: string, currentUser: SessionUserProfile) {
    const instance = await this.requireSingleInstance(id, currentUser);

    if (instance.status === 'create_failed') this.assertFutureInstanceExpiration(instance.expiresAt?.toISOString() ?? '');
    if (!['create_failed', 'destroy_failed'].includes(instance.status)) {
      throw new ConflictException('Single instance cannot start a retry job from the current status');
    }

    if (instance.singleInstanceConfig?.networkProfileId && !(await this.adminRepository.getSingleInstanceNetworkProfileById(instance.singleInstanceConfig.networkProfileId))) throw new ConflictException('实例来源网络已回收，请创建新的实例。');
    await this.singleInstanceBatchExecutionService.resolveInstanceAccount(instance);
    const previousJob = instance.lastJobId
      ? await this.adminRepository.getProvisionJobById(instance.lastJobId)
      : null;
    const job = await this.adminRepository.createProvisionJob({
      rangeInstanceId: id,
      jobType: 'retry',
      triggeredBy: currentUser.id,
      retryCount: (previousJob?.retryCount ?? 0) + 1,
      topologySnapshot: {
        operation: instance.status === 'create_failed' ? 'create' : 'destroy', draftRevision: 0,
        // Single-instance definitions stay on the instance; only retry intent belongs in this snapshot.
        topologyGraph: {}, topologySpec: {}, scenarioTemplateSpec: {}, compiledProvisionSpec: {}, compiledSpec: {},
        templateModulePath: instance.templateModulePathSnapshot ?? instance.resourceSummary?.modulePath
          ?? (instance.singleInstanceConfig?.executionBackend === 'opentofu' ? 'infra/opentofu/modules/alicloud-single-instance-batch' : ''),
      },
    });

    await this.adminRepository.updateRangeInstance(id, {
      status: instance.status === 'create_failed' ? 'pending_create' : 'pending_destroy',
      errorSummary: null,
      lastJobId: job.id,
    });

    return job;
  }

  runAction(
    id: string,
    action: 'reboot' | 'open-vnc' | 'pack-image',
    currentUser: SessionUserProfile,
    payload: Record<string, string>,
  ) {
    if (!SINGLE_INSTANCE_ACTION_ALLOWLIST.has(action)) {
      throw new NotFoundException('Unsupported single instance action');
    }

    return this.rangeInstanceNodeActionsService.runSingleInstanceAction(id, action, payload, currentUser);
  }

  private async assertOpenTofuBatchCreationFinished(instances: RangeInstanceRecord[]) {
    const members = instances.filter(instance => instance.singleInstanceConfig?.executionBackend === 'opentofu');
    if (members.some(instance => ['pending_create', 'creating'].includes(instance.status))) throw new ConflictException('批次仍在创建，请等待创建完成后销毁。');
    const jobs = await Promise.all(members.map(instance => instance.lastJobId
      ? this.adminRepository.getProvisionJobById(instance.lastJobId) : Promise.resolve(null)));
    if (jobs.some(job => job && ['create', 'retry'].includes(job.jobType) && ['pending', 'running'].includes(job.status))) {
      throw new ConflictException('批次仍在创建，请等待创建完成后销毁。');
    }
  }

  private assertFutureInstanceExpiration(expiresAt: string) {
    const expiration = new Date(expiresAt);

    if (!Number.isFinite(expiration.getTime()) || expiration <= new Date()) {
      throw new ConflictException('创建独立实例前必须设置未来的到期时间。');
    }
  }

  private async requireSingleInstance(id: string, currentUser?: SessionUserProfile) {
    const instance = await this.adminRepository.getRangeInstanceById(id);

    if (!instance) {
      throw new NotFoundException('Single instance not found');
    }

    if (instance.instanceMode !== 'single') {
      throw new ConflictException('Range instance is not a single instance');
    }

    if (currentUser && currentUser.role !== 'admin' && !this.isOwnedBy(instance.ownerUserId, instance.createdBy, currentUser.id)) {
      throw new ForbiddenException('Single instance access denied');
    }

    return instance;
  }

  private async requireEnabledPlatformImage(id: string, currentUserId: string, preparedContext?: SystemCloudAccountContext): Promise<PlatformImageAssetRecord> {
    const image = await this.adminRepository.getPlatformImageAssetById(id);
    const accountContext = preparedContext ?? await this.systemConfigService.getExecutionAccountContext();

    if (
      !image ||
      !image.enabled ||
      !this.isPlatformImageInScope(image, accountContext) ||
      (image.visibility !== 'platform' && image.ownerUserId !== currentUserId)
    ) {
      throw new NotFoundException('Platform image asset not found');
    }

    if (!image.sourceSnapshotId) throw new ConflictException('Platform image source is unavailable; sync the catalog before launching.');
    if (image.sourceSnapshotId) {
      const sourceSnapshot = await this.adminRepository.getImageSnapshotById(image.sourceSnapshotId);

      if (!sourceSnapshot || !sourceSnapshot.isAvailable) {
        throw new ConflictException('Platform image asset source snapshot is still exporting');
      }
    }

    return image;
  }

  private isPlatformImageInScope(
    image: PlatformImageAssetRecord,
    accountContext: {
      provider: string;
      accountUid: string | null;
      defaultRegion: string;
    },
  ) {
    return (
      image.provider === accountContext.provider &&
      image.accountUid === accountContext.accountUid &&
      image.regionId === accountContext.defaultRegion
    );
  }

  private resolveIndexedValue(value: string, quantityIndex: number, quantity: number) {
    if (quantity <= 1) {
      return value;
    }

    return `${value}-${String(quantityIndex).padStart(2, '0')}`;
  }

  private assertBatchAccess(ownerUserId: string | null, createdBy: string | null, currentUser: SessionUserProfile) {
    if (currentUser.role === 'admin') {
      return;
    }

    if (!this.isOwnedBy(ownerUserId, createdBy, currentUser.id)) {
      throw new ForbiddenException('Single instance batch access denied');
    }
  }

  private isOwnedBy(ownerUserId: string | null, createdBy: string | null, currentUserId: string) {
    return ownerUserId === currentUserId || createdBy === currentUserId;
  }
}

function normalizeOptionalValue(value: string | null | undefined) {
  const normalized = value?.trim() ?? '';
  return normalized || null;
}

function accountContextFingerprint(context: SystemCloudAccountContext) {
  return createHash('sha256').update(JSON.stringify([
    context.provider, context.cloudAccountContextId, context.accountUid, context.accountUidResolved,
    context.defaultRegion, context.defaultZoneId, context.accessKeyId, context.accessKeySecret, context.imageImportBucket,
  ])).digest('hex');
}

function isSingleInstanceHistoryStatus(status: string) {
  return status === 'destroyed' || status === 'create_failed';
}

function toSingleInstanceListItem(instance: RangeInstanceRecord) {
  return {
    id: instance.id,
    name: instance.name,
    createdBy: instance.createdBy,
    ownerUserId: instance.ownerUserId,
    instanceMode: instance.instanceMode,
    singleInstanceBatchId: instance.singleInstanceBatchId ?? null,
    singleInstanceConfig: instance.singleInstanceConfig
      ? {
          networkProfileId: instance.singleInstanceConfig.networkProfileId,
          cloudAccountUid: instance.singleInstanceConfig.cloudAccountUid,
          regionId: instance.singleInstanceConfig.regionId,
          hostKey: instance.singleInstanceConfig.hostKey,
          hostName: instance.singleInstanceConfig.hostName ?? null,
          imageDisplayName: instance.singleInstanceConfig.imageDisplayName,
          platformImageAssetId: instance.singleInstanceConfig.platformImageAssetId,
          imageId: instance.singleInstanceConfig.imageId,
          cpu: instance.singleInstanceConfig.cpu,
          memory: instance.singleInstanceConfig.memory,
          systemDiskSize: instance.singleInstanceConfig.systemDiskSize,
          quantityIndex: instance.singleInstanceConfig.quantityIndex,
          baseName: instance.singleInstanceConfig.baseName,
        }
      : null,
    runtimeCredentials: instance.runtimeCredentials,
    status: instance.status,
    createdAt: instance.createdAt,
    expiresAt: instance.expiresAt,
    accessEntry: instance.accessEntry
      ? {
          hostRole: instance.accessEntry.hostRole,
          publicIp: instance.accessEntry.publicIp,
          privateIp: instance.accessEntry.privateIp,
          ssh: instance.accessEntry.ssh,
        }
      : null,
    resourceSummary: instance.resourceSummary
      ? {
          mode: instance.resourceSummary.mode,
          vpcId: instance.resourceSummary.vpcId ?? null,
          subnetIds: instance.resourceSummary.subnetIds ?? null,
          hostIds: instance.resourceSummary.hostIds ?? null,
          resolvedImageId: instance.resourceSummary.resolvedImageId ?? null,
          resolvedInstanceType: instance.resourceSummary.resolvedInstanceType ?? null,
        }
      : null,
    lastJobId: instance.lastJobId ?? null,
    errorSummary: instance.errorSummary ?? null,
  };
}
