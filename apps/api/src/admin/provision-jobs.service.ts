import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';

import { ADMIN_REPOSITORY, AdminRepository } from './admin.repository';
import type { SessionUserProfile } from './admin-user-auth';
import { buildProvisionJobEvidence } from './provision-job-evidence';

@Injectable()
export class ProvisionJobsService {
  constructor(@Inject(ADMIN_REPOSITORY) private readonly adminRepository: AdminRepository) {}

  async list(currentUser: SessionUserProfile, instanceMode?: 'single' | 'range') {
    const jobs = await this.adminRepository.listProvisionJobs();
    const instanceIdsByMode = instanceMode ? await this.listInstanceIdsByMode(instanceMode) : null;

    if (currentUser.role === 'admin') {
      return (instanceIdsByMode ? jobs.filter((job) => instanceIdsByMode.has(job.rangeInstanceId)) : jobs).map(redactJobSecrets);
    }

    const ownedInstanceIds = await this.listOwnedInstanceIds(currentUser.id);

    return jobs.filter(
      (job) =>
        ownedInstanceIds.has(job.rangeInstanceId) &&
        (!instanceIdsByMode || instanceIdsByMode.has(job.rangeInstanceId)),
    ).map(redactJobSecrets);
  }

  async getById(id: string, currentUser: SessionUserProfile, includeEvidence = false) {
    const job = await this.adminRepository.getProvisionJobById(id);

    if (!job) {
      throw new NotFoundException('Provision job not found');
    }

    await this.assertJobAccess(job.rangeInstanceId, currentUser);

    if (!includeEvidence) return redactJobSecrets(job);
    const [steps, jobs, ledgers] = await Promise.all([
      this.adminRepository.listProvisionJobStepLogs(id), this.adminRepository.listProvisionJobs(),
      this.adminRepository.listBillingLedgerResources({ rangeInstanceId: job.rangeInstanceId }),
    ]);
    return { id: job.id, rangeInstanceId: job.rangeInstanceId, jobType: job.jobType, status: job.status,
      createdAt: job.createdAt, startedAt: job.startedAt, finishedAt: job.finishedAt, retryCount: job.retryCount,
      evidence: buildProvisionJobEvidence(job, steps, jobs, ledgers) };
  }

  async listSteps(id: string, currentUser: SessionUserProfile) {
    const job = await this.adminRepository.getProvisionJobById(id);

    if (!job) {
      throw new NotFoundException('Provision job not found');
    }

    await this.assertJobAccess(job.rangeInstanceId, currentUser);

    return this.adminRepository.listProvisionJobStepLogs(id);
  }

  private async assertJobAccess(rangeInstanceId: string, currentUser: SessionUserProfile) {
    if (currentUser.role === 'admin') {
      return;
    }

    const instance = await this.adminRepository.getRangeInstanceById(rangeInstanceId);

    if (!instance || !this.isOwnedBy(instance.ownerUserId, instance.createdBy, currentUser.id)) {
      throw new ForbiddenException('Provision job access denied');
    }
  }

  private async listOwnedInstanceIds(currentUserId: string) {
    const instances = await this.adminRepository.listRangeInstances();

    return new Set(
      instances
        .filter((instance) => this.isOwnedBy(instance.ownerUserId, instance.createdBy, currentUserId))
        .map((instance) => instance.id),
    );
  }

  private async listInstanceIdsByMode(instanceMode: 'single' | 'range') {
    const instances = await this.adminRepository.listRangeInstances();

    return new Set(
      instances
        .filter((instance) => instance.instanceMode === instanceMode)
        .map((instance) => instance.id),
    );
  }

  private isOwnedBy(ownerUserId: string | null, createdBy: string | null, currentUserId: string) {
    return ownerUserId === currentUserId || createdBy === currentUserId;
  }
}

function redactJobSecrets<T>(value: T): T {
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map(redactJobSecrets) as T;
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !['runtimecredentials', 'password', 'custompassword', 'defaultpassword'].includes(key.toLowerCase()))
    .map(([key, child]) => [key, redactJobSecrets(child)])) as T;
}
