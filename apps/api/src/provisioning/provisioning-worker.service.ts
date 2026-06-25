import { Inject, Injectable } from '@nestjs/common';

import {
  ADMIN_REPOSITORY,
  AdminRepository,
  ProvisionJobRecord,
  RangeInstanceRecord,
  RangeTemplateCompiledSpec,
  RangeTemplateTopologySpec,
} from '../admin/admin.repository';
import {
  RANGE_PROVISIONER,
  type RangeProvisionStepEvent,
  type RangeProvisionStepReporter,
  RangeProvisioner,
} from './provisioning.types';

@Injectable()
export class ProvisioningWorkerService {
  constructor(
    @Inject(ADMIN_REPOSITORY) private readonly adminRepository: AdminRepository,
    @Inject(RANGE_PROVISIONER) private readonly rangeProvisioner: RangeProvisioner,
  ) {}

  dispatch(jobId: string) {
    queueMicrotask(() => {
      void this.process(jobId);
    });
  }

  async process(jobId: string) {
    const job = await this.adminRepository.claimProvisionJob(jobId, new Date());

    if (!job) {
      return;
    }

    const instance = await this.adminRepository.getRangeInstanceById(job.rangeInstanceId);

    if (!instance) {
      await this.adminRepository.updateProvisionJob(job.id, {
        status: 'failed',
        finishedAt: new Date(),
        errorSummary: 'Range instance not found',
      });
      return;
    }

    const template = await this.adminRepository.getRangeTemplateById(instance.templateId);

    if (!template) {
      await this.failJob(job, instance, 'Template not found');
      return;
    }

    const publishedVersion = template.currentPublishedVersion;
    const templateModulePath = publishedVersion?.modulePathOrRef ?? template.modulePathOrRef;
    const compiledSpec = this.getCompiledSpec(publishedVersion?.compiledSpec) ?? this.getCompiledSpec(template.compiledSpec);
    const topologySpec =
      this.getCompiledTopologySpec(compiledSpec) ??
      publishedVersion?.topologySpec ??
      template.topologySpec;

    if (!topologySpec && !compiledSpec) {
      await this.failJob(job, instance, 'Template provisioning blueprint not found');
      return;
    }

    await this.adminRepository.updateRangeInstance(instance.id, {
      errorSummary: null,
    });
    const reportStep = this.createStepReporter(job.id);

    try {
      const effectiveJobType = this.resolveEffectiveJobType(job, instance);

      if (effectiveJobType === 'create') {
        await this.runWorkerStep(reportStep, 'prepare', async () => {
          await this.adminRepository.updateRangeInstance(instance.id, {
            status: 'creating',
          });
        });

        const result = await this.rangeProvisioner.create({
          rangeInstanceId: instance.id,
          templateModulePath,
          allocatedCidr: instance.allocatedCidr,
          topologySpec,
          compiledSpec,
          reportStep,
        });

        await this.runWorkerStep(reportStep, 'persist_access_entry', async () => {
          await this.adminRepository.updateRangeInstance(instance.id, {
            status: 'running',
            accessEntry: result.accessEntry,
            resourceSummary: result.resourceSummary,
            errorSummary: null,
          });
        });
      } else if (effectiveJobType === 'destroy') {
        await this.runWorkerStep(reportStep, 'prepare', async () => {
          await this.adminRepository.updateRangeInstance(instance.id, {
            status: 'destroying',
          });
        });

        await this.rangeProvisioner.destroy({
          rangeInstanceId: instance.id,
          templateModulePath,
          allocatedCidr: instance.allocatedCidr,
          topologySpec,
          compiledSpec,
          reportStep,
        });

        await this.adminRepository.updateRangeInstance(instance.id, {
          status: 'destroyed',
          accessEntry: null,
          resourceSummary: null,
          errorSummary: null,
        });
      }

      await this.adminRepository.updateProvisionJob(job.id, {
        status: 'succeeded',
        finishedAt: new Date(),
        errorSummary: null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown provisioning error';

      await this.failJob(job, instance, message);
    }
  }

  private resolveEffectiveJobType(job: ProvisionJobRecord, instance: RangeInstanceRecord) {
    if (job.jobType === 'retry') {
      if (instance.status === 'pending_create' || instance.status === 'create_failed') {
        return 'create' as const;
      }

      if (instance.status === 'pending_destroy' || instance.status === 'destroy_failed') {
        return 'destroy' as const;
      }

      throw new Error(`Retry job cannot resolve action from instance status: ${instance.status}`);
    }

    return job.jobType;
  }

  private getCompiledTopologySpec(
    compiledSpec: RangeTemplateCompiledSpec | null | undefined,
  ): RangeTemplateTopologySpec | null {
    if (!compiledSpec) {
      return null;
    }

    const candidate = compiledSpec.topologySpec;

    return candidate ?? null;
  }

  private getCompiledSpec(
    compiledSpec: Record<string, unknown> | null | undefined,
  ): RangeTemplateCompiledSpec | null {
    if (!compiledSpec) {
      return null;
    }

    return compiledSpec as RangeTemplateCompiledSpec;
  }

  private async failJob(job: ProvisionJobRecord, instance: RangeInstanceRecord, message: string) {
    await this.adminRepository.updateProvisionJob(job.id, {
      status: 'failed',
      finishedAt: new Date(),
      errorSummary: message,
    });

    await this.adminRepository.updateRangeInstance(instance.id, {
      status: job.jobType === 'destroy' ? 'destroy_failed' : 'create_failed',
      errorSummary: message,
    });
  }

  private createStepReporter(jobId: string): RangeProvisionStepReporter {
    const stepLogIds = new Map<string, string>();

    return async (event: RangeProvisionStepEvent) => {
      const payload = {
        message: event.message ?? null,
        stdoutExcerpt: event.stdoutExcerpt ?? null,
        stderrExcerpt: event.stderrExcerpt ?? null,
      };

      if (event.status === 'running') {
        const created = await this.adminRepository.createProvisionJobStepLog({
          jobId,
          stepName: event.stepName,
          status: 'running',
          startedAt: new Date(),
          finishedAt: null,
          ...payload,
        });

        stepLogIds.set(event.stepName, created.id);
        return;
      }

      const existingId = stepLogIds.get(event.stepName);

      if (existingId) {
        await this.adminRepository.updateProvisionJobStepLog(existingId, {
          status: event.status,
          finishedAt: new Date(),
          ...payload,
        });
        stepLogIds.delete(event.stepName);
        return;
      }

      await this.adminRepository.createProvisionJobStepLog({
        jobId,
        stepName: event.stepName,
        status: event.status,
        startedAt: new Date(),
        finishedAt: new Date(),
        ...payload,
      });
    };
  }

  private async runWorkerStep(
    reportStep: RangeProvisionStepReporter,
    stepName: string,
    action: () => Promise<void>,
  ) {
    await reportStep({
      stepName,
      status: 'running',
    });

    try {
      await action();
      await reportStep({
        stepName,
        status: 'succeeded',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown worker step failure';

      await reportStep({
        stepName,
        status: 'failed',
        message,
      });
      throw error;
    }
  }
}
