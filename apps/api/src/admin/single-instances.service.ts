import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

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
import { SingleInstanceNetworkService } from './single-instance-network.service';
import { SystemConfigService } from './system-config.service';
import type { LaunchSingleInstanceDto } from './dto/single-instance.dto';
import { ProvisioningWorkerService } from '../provisioning/provisioning-worker.service';
import { buildSingleInstanceBlueprint } from './single-instance-blueprint';

const SINGLE_INSTANCE_ACTION_ALLOWLIST = new Set(['reboot', 'open-vnc', 'pack-image']);

@Injectable()
export class SingleInstancesService {
  constructor(
    @Inject(ADMIN_REPOSITORY) private readonly adminRepository: AdminRepository,
    private readonly systemConfigService: SystemConfigService,
    private readonly singleInstanceNetworkService: SingleInstanceNetworkService,
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

    const normalizedBatches = await Promise.all(
      visibleBatches.map(async (entry) => {
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
    const batchesForView = normalizedBatches.filter((entry) =>
      view === 'history' ? isHistoryOnlyBatch(entry.instances) : !isHistoryOnlyBatch(entry.instances),
    );
    const standaloneForView = standaloneItems.filter((instance) =>
      view === 'history' ? instance.status === 'destroyed' : instance.status !== 'destroyed',
    );

    return {
      batches: batchesForView,
      standaloneInstances: standaloneForView,
    };
  }

  async launch(input: LaunchSingleInstanceDto, currentUserId: string) {
    const profile = await this.singleInstanceNetworkService.ensureDefaultProfile();
    const image = await this.requireEnabledPlatformImage(input.platformImageAssetId, currentUserId);
    const password = input.password?.trim() || generateAliyunEcsPassword();
    const quantity = input.quantity;
    const activeCount = (await this.adminRepository.listRangeInstances()).filter(
      (instance) => instance.instanceMode === 'single' && instance.status !== 'destroyed',
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
      systemDiskSize: input.systemDiskSize ?? 40,
      quantity,
      remark: input.remark?.trim() || null,
      createdBy: currentUserId,
      ownerUserId: currentUserId,
      expiresAt: new Date(input.expiresAt),
    });

    try {
      for (let index = 0; index < quantity; index += 1) {
        const quantityIndex = index + 1;
        const network = this.singleInstanceNetworkService.allocateVswitch(profile, activeCount + index);
        const name = this.resolveIndexedValue(input.name, quantityIndex, quantity);
        const requestedHostBaseName =
          normalizeOptionalValue(input.hostName) ?? normalizeOptionalValue(image.defaultHostName) ?? null;
        const hostName = requestedHostBaseName
          ? this.resolveIndexedValue(requestedHostBaseName, quantityIndex, quantity)
          : null;
        const hostKey = `single-ecs-${quantityIndex}`;
        const blueprint = buildSingleInstanceBlueprint({
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
          instanceMode: 'single',
          singleInstanceBatchId: batch.id,
          status: 'pending_create',
          expiresAt: input.expiresAt,
          runtimeTopologyGraph: blueprint.runtimeTopologyGraph,
          runtimeScenarioTemplateSpec: blueprint.runtimeScenarioTemplateSpec as Record<string, unknown>,
          runtimeCompiledProvisionSpec: blueprint.runtimeCompiledProvisionSpec as Record<string, unknown>,
          runtimeCredentials: {
            [hostKey]: {
              username: 'root',
              password,
            },
          },
          singleInstanceConfig: {
            baseName: input.name,
            quantityIndex,
            hostKey,
            hostName,
            platformImageAssetId: image.id,
            imageId: image.imageId,
            imageDisplayName: image.displayName,
            cpu: input.cpu,
            memory: input.memory,
            systemDiskSize: input.systemDiskSize ?? 40,
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
    } finally {
      for (const jobId of jobIds) {
        this.provisioningWorkerService.dispatch(jobId);
      }
    }

    const [normalizedBatch] = await attachCreatedByUsernames(this.adminRepository, [batch]);

    return {
      batch: normalizedBatch,
      instances: await attachCreatedByUsernames(this.adminRepository, created),
    };
  }

  async destroyBatch(batchId: string, currentUser: SessionUserProfile) {
    const groups = await this.adminRepository.listSingleInstanceBatchesWithInstances();
    const group = groups.find((entry) => entry.batch.id === batchId);

    if (!group) {
      throw new NotFoundException('Single instance batch not found');
    }

    this.assertBatchAccess(group.batch.ownerUserId, group.batch.createdBy, currentUser);

    const targetInstances = group.instances.filter((instance) => instance.status !== 'destroyed');
    const jobIds: string[] = [];

    try {
      for (const instance of targetInstances) {
        const job = await this.adminRepository.createProvisionJob({
          rangeInstanceId: instance.id,
          jobType: 'destroy',
          triggeredBy: currentUser.id,
        });
        jobIds.push(job.id);

        await this.adminRepository.updateRangeInstance(instance.id, {
          status: 'pending_destroy',
          lastJobId: job.id,
        });
      }
    } finally {
      for (const jobId of jobIds) {
        this.provisioningWorkerService.dispatch(jobId);
      }
    }

    return {
      batchId,
      jobCount: targetInstances.length,
    };
  }

  async destroy(id: string, currentUser: SessionUserProfile) {
    const instance = await this.requireSingleInstance(id, currentUser);

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
    this.provisioningWorkerService.dispatch(job.id);

    return job;
  }

  async retry(id: string, currentUser: SessionUserProfile) {
    const instance = await this.requireSingleInstance(id, currentUser);

    if (!['create_failed', 'destroy_failed'].includes(instance.status)) {
      throw new ConflictException('Single instance cannot start a retry job from the current status');
    }

    const previousJob = instance.lastJobId
      ? await this.adminRepository.getProvisionJobById(instance.lastJobId)
      : null;
    const job = await this.adminRepository.createProvisionJob({
      rangeInstanceId: id,
      jobType: 'retry',
      triggeredBy: currentUser.id,
      retryCount: (previousJob?.retryCount ?? 0) + 1,
    });

    await this.adminRepository.updateRangeInstance(id, {
      status: instance.status === 'create_failed' ? 'pending_create' : 'pending_destroy',
      errorSummary: null,
      lastJobId: job.id,
    });
    this.provisioningWorkerService.dispatch(job.id);

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

  private async requireEnabledPlatformImage(id: string, currentUserId: string): Promise<PlatformImageAssetRecord> {
    const image = await this.adminRepository.getPlatformImageAssetById(id);
    const accountContext = await this.systemConfigService.getAccountContext();

    if (
      !image ||
      !image.enabled ||
      !this.isPlatformImageInScope(image, accountContext) ||
      (image.visibility !== 'platform' && image.ownerUserId !== currentUserId)
    ) {
      throw new NotFoundException('Platform image asset not found');
    }

    if (image.sourceSnapshotId) {
      const sourceSnapshot = await this.adminRepository.getImageSnapshotById(image.sourceSnapshotId);

      if (sourceSnapshot && !sourceSnapshot.isAvailable) {
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

function isHistoryOnlyBatch(
  instances: Array<{
    status: string;
  }>,
) {
  return instances.length > 0 && instances.every((instance) => instance.status === 'destroyed');
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
