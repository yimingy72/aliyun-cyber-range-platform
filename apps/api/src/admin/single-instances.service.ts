import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { generateAliyunEcsPassword } from './ecs-password-generator';
import {
  ADMIN_REPOSITORY,
  type AdminRepository,
  type PlatformImageAssetRecord,
} from './admin.repository';
import { RangeInstanceNodeActionsService } from './range-instance-node-actions.service';
import { SingleInstanceNetworkService } from './single-instance-network.service';
import type { LaunchSingleInstanceDto } from './dto/single-instance.dto';
import { ProvisioningWorkerService } from '../provisioning/provisioning-worker.service';
import { buildSingleInstanceBlueprint } from './single-instance-blueprint';

const SINGLE_INSTANCE_ACTION_ALLOWLIST = new Set(['reboot', 'open-vnc', 'pack-image']);

@Injectable()
export class SingleInstancesService {
  constructor(
    @Inject(ADMIN_REPOSITORY) private readonly adminRepository: AdminRepository,
    private readonly singleInstanceNetworkService: SingleInstanceNetworkService,
    private readonly provisioningWorkerService: ProvisioningWorkerService,
    private readonly rangeInstanceNodeActionsService: RangeInstanceNodeActionsService,
  ) {}

  async list() {
    const instances = await this.adminRepository.listRangeInstances();
    const batches = await this.adminRepository.listSingleInstanceBatchesWithInstances();
    const batchIds = new Set(batches.map((entry) => entry.batch.id));
    const standaloneInstances = instances.filter(
      (instance) =>
        instance.instanceMode === 'single' &&
        (!instance.singleInstanceBatchId || !batchIds.has(instance.singleInstanceBatchId)),
    );

    return {
      batches,
      standaloneInstances,
    };
  }

  async launch(input: LaunchSingleInstanceDto) {
    const profile = await this.singleInstanceNetworkService.ensureDefaultProfile();
    const image = await this.requireEnabledPlatformImage(input.platformImageAssetId);
    const password = input.password?.trim() || generateAliyunEcsPassword();
    const quantity = input.quantity;
    const activeCount = (await this.adminRepository.listRangeInstances()).filter(
      (instance) => instance.instanceMode === 'single' && instance.status !== 'destroyed',
    ).length;
    const created = [];

    for (let index = 0; index < quantity; index += 1) {
      const quantityIndex = index + 1;
      const network = this.singleInstanceNetworkService.allocateVswitch(profile, activeCount + index);
      const name = this.resolveIndexedValue(input.name, quantityIndex, quantity);
      const hostName = this.resolveIndexedValue(input.hostName?.trim() || input.name, quantityIndex, quantity);
      const hostKey = `single-ecs-${quantityIndex}`;
      const blueprint = buildSingleInstanceBlueprint({
        name,
        hostKey,
        hostName,
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
        createdBy: input.triggeredBy,
        instanceMode: 'single',
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
        triggeredBy: input.triggeredBy,
      });
      const updated = await this.adminRepository.updateRangeInstance(instance.id, {
        lastJobId: job.id,
      });

      this.provisioningWorkerService.dispatch(job.id);
      created.push(updated);
    }

    return { instances: created };
  }

  async destroy(id: string, triggeredBy: string) {
    const instance = await this.requireSingleInstance(id);

    if (!['running', 'destroy_failed'].includes(instance.status)) {
      throw new ConflictException('Single instance cannot start a destroy job from the current status');
    }

    const job = await this.adminRepository.createProvisionJob({
      rangeInstanceId: id,
      jobType: 'destroy',
      triggeredBy,
    });

    await this.adminRepository.updateRangeInstance(id, {
      status: 'pending_destroy',
      lastJobId: job.id,
    });
    this.provisioningWorkerService.dispatch(job.id);

    return job;
  }

  async retry(id: string, triggeredBy: string) {
    const instance = await this.requireSingleInstance(id);

    if (!['create_failed', 'destroy_failed'].includes(instance.status)) {
      throw new ConflictException('Single instance cannot start a retry job from the current status');
    }

    const previousJob = instance.lastJobId
      ? await this.adminRepository.getProvisionJobById(instance.lastJobId)
      : null;
    const job = await this.adminRepository.createProvisionJob({
      rangeInstanceId: id,
      jobType: 'retry',
      triggeredBy,
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

  runAction(id: string, action: 'reboot' | 'open-vnc' | 'pack-image', payload: Record<string, string>) {
    if (!SINGLE_INSTANCE_ACTION_ALLOWLIST.has(action)) {
      throw new NotFoundException('Unsupported single instance action');
    }

    return this.rangeInstanceNodeActionsService.runSingleInstanceAction(id, action, payload);
  }

  private async requireSingleInstance(id: string) {
    const instance = await this.adminRepository.getRangeInstanceById(id);

    if (!instance) {
      throw new NotFoundException('Single instance not found');
    }

    if (instance.instanceMode !== 'single') {
      throw new ConflictException('Range instance is not a single instance');
    }

    return instance;
  }

  private async requireEnabledPlatformImage(id: string): Promise<PlatformImageAssetRecord> {
    const image = await this.adminRepository.getPlatformImageAssetById(id);

    if (!image || !image.enabled) {
      throw new NotFoundException('Platform image asset not found');
    }

    return image;
  }

  private resolveIndexedValue(value: string, quantityIndex: number, quantity: number) {
    if (quantity <= 1) {
      return value;
    }

    return `${value}-${String(quantityIndex).padStart(2, '0')}`;
  }
}
