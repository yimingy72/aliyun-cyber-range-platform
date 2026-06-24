import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';

import {
  ADMIN_REPOSITORY,
  AdminRepository,
  CreateRangeInstanceInput,
} from './admin.repository';
import { CidrPoolService } from '../provisioning/cidr-pool.service';
import { ProvisioningWorkerService } from '../provisioning/provisioning-worker.service';

@Injectable()
export class RangeInstancesService {
  constructor(
    @Inject(ADMIN_REPOSITORY) private readonly adminRepository: AdminRepository,
    private readonly cidrPoolService: CidrPoolService,
    private readonly provisioningWorkerService: ProvisioningWorkerService,
  ) {}

  list() {
    return this.adminRepository.listRangeInstances();
  }

  async getById(id: string) {
    const instance = await this.adminRepository.getRangeInstanceById(id);

    if (!instance) {
      throw new NotFoundException('Range instance not found');
    }

    return instance;
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

      if (!['draft', 'create_failed', 'destroyed'].includes(instance.status)) {
        throw new ConflictException('Range instance cannot start a create job from the current status');
      }

      const occupiedCidrs = (await this.adminRepository.listRangeInstances())
        .filter((item) => item.id !== instance.id)
        .filter((item) => item.status !== 'destroyed')
        .map((item) => item.allocatedCidr)
        .filter((value): value is string => Boolean(value));

      const cidrPool = this.cidrPoolService.getPool();
      const fixedVpcCidr = template.topologySpec?.vpcCidr ?? null;

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
}
