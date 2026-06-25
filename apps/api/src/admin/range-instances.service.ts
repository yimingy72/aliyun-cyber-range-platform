import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';

import {
  ADMIN_REPOSITORY,
  AdminRepository,
  CreateRangeInstanceInput,
} from './admin.repository';
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
    const [competition, team, template] = await Promise.all([
      this.adminRepository.getCompetitionById(input.competitionId),
      this.adminRepository.getTeamById(input.teamId),
      this.adminRepository.getRangeTemplateById(input.templateId),
    ]);

    if (!competition) {
      throw new NotFoundException('Competition not found');
    }

    if (!team) {
      throw new NotFoundException('Team not found');
    }

    if (!template) {
      throw new NotFoundException('Range template not found');
    }

    if (!template.currentPublishedVersionId) {
      throw new ConflictException('Range template must be published before creating range instances');
    }

    if (team.competitionId !== competition.id) {
      throw new ConflictException('Team does not belong to the selected competition');
    }

    return this.adminRepository.createRangeInstance(input);
  }

  async triggerCreate(id: string, triggeredBy: string) {
    const job = await this.cidrPoolService.serialize(async () => {
      const instance = await this.adminRepository.getRangeInstanceById(id);

      if (!instance) {
        throw new NotFoundException('Range instance not found');
      }

      const template = await this.adminRepository.getRangeTemplateById(instance.templateId);

      if (!template) {
        throw new NotFoundException('Range template not found');
      }

      if (!template.currentPublishedVersionId) {
        throw new ConflictException('Range template must be published before creating range instances');
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
      const publishedTopologySpec = template.currentPublishedVersion?.topologySpec ?? template.topologySpec;
      const fixedVpcCidr = publishedTopologySpec?.vpcCidr ?? null;

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
