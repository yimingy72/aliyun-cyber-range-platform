import { ForbiddenException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';

import { ADMIN_REPOSITORY, AdminRepository, type ProvisionJobRecord, type ProvisionJobStepLogRecord } from './admin.repository';
import type { SessionUserProfile } from './admin-user-auth';
import { buildProvisionJobEvidence } from './provision-job-evidence';
import { SystemConfigService } from './system-config.service';
import { sanitizeAliyunErrorCode } from './aliyun-error-code';
import { readAliyunResourceCloudEvents } from './aliyun-resource-cloud-events';
import { isPlatformCreatedLedger, loadPlatformBillingProof } from './billing-platform-scope';

@Injectable()
export class ProvisionJobsService {
  constructor(@Inject(ADMIN_REPOSITORY) private readonly adminRepository: AdminRepository,
    @Optional() private readonly systemConfigService?: SystemConfigService) {}

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

  async getById(id: string, currentUser: SessionUserProfile, includeEvidence = false, includeCloudEvents = false, cloudResourceIds?: string[]) {
    const job = await this.adminRepository.getProvisionJobById(id);

    if (!job) {
      throw new NotFoundException('Provision job not found');
    }

    await this.assertJobAccess(job.rangeInstanceId, currentUser);

    includeEvidence ||= includeCloudEvents;
    if (!includeEvidence && (job.status !== 'failed' || !this.systemConfigService)) return redactJobSecrets(job);
    const steps = await this.adminRepository.listProvisionJobStepLogs(id);
    const cloudErrorSummary = job.status === 'failed' ? await this.readCloudErrorSummary(job, steps) : null;
    if (!includeEvidence) return { ...redactJobSecrets(job), ...(cloudErrorSummary ? { errorSummary: `${job.errorSummary ?? ''}\n${cloudErrorSummary}` } : {}) };
    const [jobs, ledgers, instance] = await Promise.all([
      this.adminRepository.listProvisionJobs(), this.adminRepository.listBillingLedgerResources({ rangeInstanceId: job.rangeInstanceId }),
      this.adminRepository.getRangeInstanceById(job.rangeInstanceId),
    ]);
    const cloudEvents = includeCloudEvents ? await this.readCloudEvents(job, ledgers, cloudResourceIds) : undefined;
    return { id: job.id, rangeInstanceId: job.rangeInstanceId, jobType: job.jobType, status: job.status,
      createdAt: job.createdAt, startedAt: job.startedAt, finishedAt: job.finishedAt, retryCount: job.retryCount,
      ...(cloudErrorSummary ? { errorSummary: cloudErrorSummary } : {}),
      evidence: { ...buildProvisionJobEvidence(job, steps, jobs, ledgers, instance), ...(cloudEvents ? { cloudEvents } : {}) } };
  }

  private async readCloudEvents(job: ProvisionJobRecord, ledgers: Awaited<ReturnType<AdminRepository['listBillingLedgerResources']>>, ids?: string[]) {
    if (!this.systemConfigService) throw new ForbiddenException('Cloud event evidence is unavailable');
    const proof = await loadPlatformBillingProof(this.adminRepository);
    const candidates = ledgers.filter(row => row.cloudWorkspaceId === job.cloudWorkspaceId && row.rangeInstanceId === job.rangeInstanceId
      && ['ecs', 'disk', 'eip', 'nat_gateway'].includes(row.cloudResourceType) && isPlatformCreatedLedger(row, proof));
    if (ids && (ids.some(id => !candidates.some(row => row.cloudResourceId === id)) || new Set(ids).size !== ids.length))
      throw new ForbiddenException('Cloud resource is outside the recorded creation inventory');
    const selected = ids ? candidates.filter(row => ids.includes(row.cloudResourceId)) : candidates;
    if (!selected.length || selected.length > 20) throw new ForbiddenException('Select between 1 and 20 recorded cloud resources');
    const contexts = new Map<string, Awaited<ReturnType<SystemConfigService['getAccountContextById']>>>();
    const result = [];
    for (const row of selected) {
      const id = String(row.tagsSnapshot.CloudAccountContextId ?? '');
      if (!id) throw new ForbiddenException('Original cloud account context is unverified');
      if (!contexts.has(id)) contexts.set(id, await this.systemConfigService.getAccountContextById(id));
      result.push(await readAliyunResourceCloudEvents(contexts.get(id)!, row));
    }
    return result;
  }

  private async readCloudErrorSummary(job: ProvisionJobRecord, steps: ProvisionJobStepLogRecord[]) {
    if (!this.systemConfigService) return null;
    const range = await this.adminRepository.getRangeInstanceById(job.rangeInstanceId);
    const source = range?.resourceSummary?.executionContext;
    if (!source?.cloudAccountContextId || source.provider !== 'alibaba_cloud' || range?.cloudWorkspaceId !== job.cloudWorkspaceId) return null;
    let account;
    try { account = await this.systemConfigService.getAccountContextById(source.cloudAccountContextId); }
    catch { return null; }
    if (account.provider !== source.provider || account.accountUid !== source.cloudAccountUid || account.defaultRegion !== source.regionId) return null;
    const secrets = [account.accessKeyId, account.accessKeySecret, ...Object.values(range?.runtimeCredentials ?? {}).map(value => value.password)].filter(Boolean);
    const codes = new Set<string>();
    for (const step of steps.filter(step => step.jobId === job.id && step.cloudWorkspaceId === job.cloudWorkspaceId && step.status === 'failed')) {
      for (const match of `${step.stdoutExcerpt ?? ''}\n${step.stderrExcerpt ?? ''}`.matchAll(/\bCode:\s*([A-Za-z][A-Za-z0-9._-]{0,127})/g)) {
        const code = sanitizeAliyunErrorCode(match[1], secrets);
        if (code) codes.add(code);
      }
    }
    return codes.size ? `Alibaba cloud error codes: ${[...codes].join(', ')}` : null;
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
