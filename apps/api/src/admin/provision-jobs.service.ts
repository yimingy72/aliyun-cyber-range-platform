import { Inject, Injectable, NotFoundException } from '@nestjs/common';

import { ADMIN_REPOSITORY, AdminRepository } from './admin.repository';

@Injectable()
export class ProvisionJobsService {
  constructor(@Inject(ADMIN_REPOSITORY) private readonly adminRepository: AdminRepository) {}

  list() {
    return this.adminRepository.listProvisionJobs();
  }

  async getById(id: string) {
    const job = await this.adminRepository.getProvisionJobById(id);

    if (!job) {
      throw new NotFoundException('Provision job not found');
    }

    return job;
  }

  async listSteps(id: string) {
    const job = await this.adminRepository.getProvisionJobById(id);

    if (!job) {
      throw new NotFoundException('Provision job not found');
    }

    return this.adminRepository.listProvisionJobStepLogs(id);
  }
}
