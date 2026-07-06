import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';

import {
  ADMIN_REPOSITORY,
  AdminRepository,
  CreateRangeInstanceInput,
} from './admin.repository';
import { SaveRangeInstanceDraftDto } from './dto/range-instance-draft.dto';
import { LaunchRangeInstanceDto } from './dto/range-instance.dto';
import { validateRangeInstanceDraftPayload } from './range-instance-draft.validation';
import { buildRangeRecoverySummary } from './range-instance-recovery';
import { CidrPoolService } from '../provisioning/cidr-pool.service';
import { ProvisioningWorkerService } from '../provisioning/provisioning-worker.service';

@Injectable()
export class RangeInstancesService {
  constructor(
    @Inject(ADMIN_REPOSITORY) private readonly adminRepository: AdminRepository,
    private readonly cidrPoolService: CidrPoolService,
    private readonly provisioningWorkerService: ProvisioningWorkerService,
  ) {}

  async list() {
    const instances = await this.adminRepository.listRangeInstances();

    return Promise.all(instances.map((instance) => this.attachRecoverySummary(instance)));
  }

  async getById(id: string) {
    const instance = await this.adminRepository.getRangeInstanceById(id);

    if (!instance) {
      throw new NotFoundException('Range instance not found');
    }

    return this.attachRecoverySummary(instance);
  }

  async create(input: CreateRangeInstanceInput) {
    const template = await this.adminRepository.getRangeTemplateById(input.templateId);

    if (!template) {
      throw new NotFoundException('Range template not found');
    }

    const sourceTemplateVersionId = template.currentDraftVersionId ?? template.currentPublishedVersionId;

    if (!sourceTemplateVersionId) {
      throw new ConflictException('Range template does not have an active template version');
    }

    return this.adminRepository.createRangeInstance({
      ...input,
      sourceTemplateVersionId,
    });
  }

  async launch(input: LaunchRangeInstanceDto) {
    const template = await this.adminRepository.getRangeTemplateById(input.templateId);

    if (!template) {
      throw new NotFoundException('Range template not found');
    }

    const sourceTemplateVersion = template.currentDraftVersion ?? template.currentPublishedVersion;

    if (!sourceTemplateVersion) {
      throw new ConflictException('Range template does not have an active template version');
    }

    const instance = await this.adminRepository.createRangeInstance({
      name: input.name,
      createdBy: input.triggeredBy,
      templateId: template.id,
      sourceTemplateVersionId: sourceTemplateVersion.id,
      runtimeTopologyGraph: sourceTemplateVersion.topologyGraph ?? template.topologyGraph ?? null,
      runtimeScenarioTemplateSpec: sourceTemplateVersion.scenarioTemplateSpec ?? template.scenarioTemplateSpec ?? null,
      runtimeCompiledProvisionSpec:
        sourceTemplateVersion.compiledProvisionSpec ?? template.compiledProvisionSpec ?? null,
      status: 'pending_create',
      expiresAt: input.expiresAt,
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

    return this.attachRecoverySummary(updated);
  }

  async saveDraft(id: string, input: SaveRangeInstanceDraftDto) {
    const instance = await this.adminRepository.getRangeInstanceById(id);

    if (!instance) {
      throw new NotFoundException('Range instance not found');
    }

    if (instance.status !== 'running') {
      throw new ConflictException('Only running instances can save draft changes');
    }

    validateRangeInstanceDraftPayload(input);

    const updated = await this.adminRepository.updateRangeInstance(id, {
      draftTopologyGraph: input.draftTopologyGraph,
      draftScenarioTemplateSpec: input.draftScenarioTemplateSpec,
      draftCompiledProvisionSpec: input.draftCompiledProvisionSpec,
      draftUpdatedBy: input.draftUpdatedBy,
      draftUpdatedAt: new Date(),
    });

    return this.attachRecoverySummary(updated);
  }

  async discardDraft(id: string) {
    const instance = await this.adminRepository.getRangeInstanceById(id);

    if (!instance) {
      throw new NotFoundException('Range instance not found');
    }

    const updated = await this.adminRepository.updateRangeInstance(id, {
      draftTopologyGraph: null,
      draftScenarioTemplateSpec: null,
      draftCompiledProvisionSpec: null,
      draftUpdatedBy: null,
      draftUpdatedAt: null,
    });

    return this.attachRecoverySummary(updated);
  }

  async applyDraft(id: string, triggeredBy: string) {
    const instance = await this.adminRepository.getRangeInstanceById(id);

    if (!instance) {
      throw new NotFoundException('Range instance not found');
    }

    if (instance.status !== 'running') {
      throw new ConflictException('Only running instances can apply draft changes');
    }

    if (!instance.draftTopologyGraph || !instance.draftScenarioTemplateSpec || !instance.draftCompiledProvisionSpec) {
      throw new ConflictException('Range instance does not have a pending draft');
    }

    const job = await this.adminRepository.createProvisionJob({
      rangeInstanceId: id,
      jobType: 'update',
      triggeredBy,
    });

    await this.adminRepository.updateRangeInstance(id, {
      lastJobId: job.id,
      errorSummary: null,
    });

    this.provisioningWorkerService.dispatch(job.id);

    return job;
  }

  async triggerCreate(id: string, triggeredBy: string) {
    const job = await this.cidrPoolService.serialize(async () => {
      const instance = await this.adminRepository.getRangeInstanceById(id);

      if (!instance) {
        throw new NotFoundException('Range instance not found');
      }

       if (!instance.templateId) {
        throw new ConflictException('Range instance no longer references an active template');
      }

      const template = await this.adminRepository.getRangeTemplateById(instance.templateId);

      if (!template) {
        throw new NotFoundException('Range template not found');
      }

      const sourceTemplateVersion = instance.sourceTemplateVersionId
        ? await this.adminRepository.getRangeTemplateVersionById(instance.sourceTemplateVersionId)
        : template.currentDraftVersion ?? template.currentPublishedVersion;

      if (instance.sourceTemplateVersionId && !sourceTemplateVersion) {
        throw new ConflictException('Range instance source template version not found');
      }

      if (!['draft', 'create_failed', 'destroyed'].includes(instance.status)) {
        throw new ConflictException('Range instance cannot start a create job from the current status');
      }

      const occupiedCidrs = (await this.adminRepository.listRangeInstances())
        .filter((item) => item.id !== instance.id)
        .filter((item) => item.status !== 'destroyed')
        .map((item) => item.allocatedCidr)
        .filter((value): value is string => Boolean(value));

      const cidrPool = this.cidrPoolService.getPool();
      const effectiveTopologySpec =
        sourceTemplateVersion?.topologySpec ??
        template.currentDraftVersion?.topologySpec ??
        template.currentPublishedVersion?.topologySpec ??
        template.topologySpec;
      const fixedVpcCidr = effectiveTopologySpec?.vpcCidr ?? null;

      const allocatedCidr =
        instance.allocatedCidr ??
        fixedVpcCidr ??
        (cidrPool.length > 0 ? this.cidrPoolService.allocate(cidrPool, occupiedCidrs) : null);

      const nextJob = await this.adminRepository.createProvisionJob({
        rangeInstanceId: instance.id,
        jobType: 'create',
        triggeredBy,
      });

      await this.adminRepository.updateRangeInstance(instance.id, {
        allocatedCidr,
        status: 'pending_create',
        lastJobId: nextJob.id,
      });

      return nextJob;
    });

    this.provisioningWorkerService.dispatch(job.id);

    return job;
  }

  async triggerDestroy(id: string, triggeredBy: string) {
    const instance = await this.adminRepository.getRangeInstanceById(id);

    if (!instance) {
      throw new NotFoundException('Range instance not found');
    }

    if (!instance.templateId) {
      throw new ConflictException('Range instance no longer references an active template');
    }

    if (!['running', 'destroy_failed'].includes(instance.status)) {
      throw new ConflictException('Range instance cannot start a destroy job from the current status');
    }

    const job = await this.adminRepository.createProvisionJob({
      rangeInstanceId: instance.id,
      jobType: 'destroy',
      triggeredBy,
    });

    await this.adminRepository.updateRangeInstance(instance.id, {
      status: 'pending_destroy',
      lastJobId: job.id,
    });

    this.provisioningWorkerService.dispatch(job.id);

    return job;
  }

  async triggerRetry(id: string, triggeredBy: string) {
    const instance = await this.adminRepository.getRangeInstanceById(id);

    if (!instance) {
      throw new NotFoundException('Range instance not found');
    }

    if (!instance.templateId) {
      throw new ConflictException('Range instance no longer references an active template');
    }

    if (!['create_failed', 'destroy_failed'].includes(instance.status)) {
      throw new ConflictException('Range instance cannot start a retry job from the current status');
    }

    const previousJob = instance.lastJobId
      ? await this.adminRepository.getProvisionJobById(instance.lastJobId)
      : null;

    const retryCount = (previousJob?.retryCount ?? 0) + 1;
    const pendingStatus = instance.status === 'create_failed' ? 'pending_create' : 'pending_destroy';

    const job = await this.adminRepository.createProvisionJob({
      rangeInstanceId: instance.id,
      jobType: 'retry',
      triggeredBy,
      retryCount,
    });

    await this.adminRepository.updateRangeInstance(instance.id, {
      status: pendingStatus,
      errorSummary: null,
      lastJobId: job.id,
    });

    this.provisioningWorkerService.dispatch(job.id);

    return job;
  }

  async delete(id: string) {
    const instance = await this.adminRepository.getRangeInstanceById(id);

    if (!instance) {
      throw new NotFoundException('Range instance not found');
    }

    if (instance.status !== 'create_failed') {
      throw new ConflictException('Only create_failed instances can be deleted');
    }

    await this.adminRepository.deleteRangeInstance(id);
  }

  private async attachRecoverySummary(instance: Awaited<ReturnType<AdminRepository['getRangeInstanceById']>>) {
    if (!instance) {
      return instance;
    }

    const lastJob = instance.lastJobId
      ? await this.adminRepository.getProvisionJobById(instance.lastJobId)
      : null;
    const steps = instance.lastJobId
      ? await this.adminRepository.listProvisionJobStepLogs(instance.lastJobId)
      : [];

    return {
      ...instance,
      recoverySummary: buildRangeRecoverySummary({
        instance,
        job: lastJob,
        steps,
      }),
    };
  }
}
