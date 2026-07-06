import { Inject, Injectable } from '@nestjs/common';

import {
  ADMIN_REPOSITORY,
  AdminRepository,
  ProvisionJobRecord,
  RangeInstanceRecord,
  RangeTemplateCompiledSpec,
  RangeTemplateTopologySpec,
} from '../admin/admin.repository';
import { SystemConfigService } from '../admin/system-config.service';
import {
  RANGE_PROVISIONER,
  type RangeProvisionStepEvent,
  type RangeProvisionStepReporter,
  RangeProvisioner,
} from './provisioning.types';

const DEFAULT_WORKER_POLL_INTERVAL_MS = 1_000;

@Injectable()
export class ProvisioningWorkerService {
  constructor(
    @Inject(ADMIN_REPOSITORY) private readonly adminRepository: AdminRepository,
    @Inject(RANGE_PROVISIONER) private readonly rangeProvisioner: RangeProvisioner,
    private readonly systemConfigService: SystemConfigService,
  ) {}

  dispatch(_jobId: string) {
    // ponytail: API role only enqueues in DB; the dedicated worker loop claims jobs later.
  }

  async runLoop(): Promise<void> {
    while (true) {
      const pendingJob = (await this.adminRepository.listProvisionJobs()).find((job) => job.status === 'pending');

      if (pendingJob) {
        await this.process(pendingJob.id);
        continue;
      }

      await sleep(readWorkerPollIntervalMs());
    }
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

    if (!instance.templateId) {
      await this.failJob(job, instance, 'Template not found');
      return;
    }

    const template = await this.adminRepository.getRangeTemplateById(instance.templateId);

    if (!template) {
      await this.failJob(job, instance, 'Template not found');
      return;
    }

    const sourceVersion = instance.sourceTemplateVersionId
      ? await this.adminRepository.getRangeTemplateVersionById(instance.sourceTemplateVersionId)
      : template.currentDraftVersion ?? template.currentPublishedVersion;

    if (instance.sourceTemplateVersionId && !sourceVersion) {
      await this.failJob(job, instance, 'Template source version not found');
      return;
    }

    const templateModulePath = sourceVersion?.modulePathOrRef ?? template.modulePathOrRef;
    const baseCompiledProvisionSpec =
      this.getCompiledProvisionSpec(sourceVersion?.compiledProvisionSpec) ??
      this.getCompiledProvisionSpec(template.compiledProvisionSpec);
    const baseCompiledSpec = this.getCompiledSpec(sourceVersion?.compiledSpec) ?? this.getCompiledSpec(template.compiledSpec);
    const baseTopologySpec =
      this.getTopologySpecFromCompiledProvisionSpec(baseCompiledProvisionSpec) ??
      this.getCompiledTopologySpec(baseCompiledSpec) ??
      sourceVersion?.topologySpec ??
      template.topologySpec;

    if (!baseTopologySpec && !baseCompiledSpec && !baseCompiledProvisionSpec) {
      await this.failJob(job, instance, 'Template provisioning blueprint not found');
      return;
    }

    await this.adminRepository.updateRangeInstance(instance.id, {
      errorSummary: null,
    });
    const reportStep = this.createStepReporter(job.id);

    try {
      const effectiveJobType = this.resolveEffectiveJobType(job, instance);
      const runtimeConfig = await this.systemConfigService.getSnapshot();
      const compiledProvisionSpec =
        effectiveJobType === 'update'
          ? this.getCompiledProvisionSpec(instance.draftCompiledProvisionSpec) ?? baseCompiledProvisionSpec
          : baseCompiledProvisionSpec;
      const compiledSpec = effectiveJobType === 'update' ? baseCompiledSpec : baseCompiledSpec;
      const topologySpec =
        effectiveJobType === 'update'
          ? this.getTopologySpecFromCompiledProvisionSpec(instance.draftCompiledProvisionSpec) ??
            baseTopologySpec
          : baseTopologySpec;

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
          runtimeConfig,
          topologySpec,
          compiledProvisionSpec,
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
      } else if (effectiveJobType === 'update') {
        await this.runWorkerStep(reportStep, 'prepare', async () => {
          await this.adminRepository.updateRangeInstance(instance.id, {
            errorSummary: null,
          });
        });

        const result = await this.rangeProvisioner.create({
          rangeInstanceId: instance.id,
          templateModulePath,
          allocatedCidr: instance.allocatedCidr,
          runtimeConfig,
          topologySpec,
          compiledProvisionSpec,
          compiledSpec,
          reportStep,
        });

        await this.runWorkerStep(reportStep, 'persist_update_result', async () => {
          await this.adminRepository.updateRangeInstance(instance.id, {
            runtimeTopologyGraph: instance.draftTopologyGraph,
            runtimeScenarioTemplateSpec: instance.draftScenarioTemplateSpec,
            runtimeCompiledProvisionSpec: instance.draftCompiledProvisionSpec,
            draftTopologyGraph: null,
            draftScenarioTemplateSpec: null,
            draftCompiledProvisionSpec: null,
            draftUpdatedBy: null,
            draftUpdatedAt: null,
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
          runtimeConfig,
          topologySpec,
          compiledProvisionSpec,
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

  private getCompiledProvisionSpec(
    compiledProvisionSpec: Record<string, unknown> | null | undefined,
  ): Record<string, unknown> | null {
    if (!compiledProvisionSpec) {
      return null;
    }

    return compiledProvisionSpec;
  }

  private getTopologySpecFromCompiledProvisionSpec(
    compiledProvisionSpec: Record<string, unknown> | null | undefined,
  ): RangeTemplateTopologySpec | null {
    if (!compiledProvisionSpec) {
      return null;
    }

    const topology = this.readJsonObject(compiledProvisionSpec.topology);
    const networkZones = this.readJsonArray(compiledProvisionSpec.networkZones);
    const hosts = this.readJsonArray(compiledProvisionSpec.hosts);
    const entryHostKey = typeof topology?.entryHostKey === 'string' ? topology.entryHostKey : null;
    const vpcCidr = typeof topology?.vpcCidr === 'string' ? topology.vpcCidr : null;

    if (!entryHostKey || !vpcCidr || networkZones.length === 0 || hosts.length === 0) {
      return null;
    }

    return {
      vpcCidr,
      networkZones: networkZones.flatMap((zoneValue) => {
        const zone = this.readJsonObject(zoneValue);
        if (!zone || typeof zone.key !== 'string' || typeof zone.name !== 'string' || typeof zone.cidr !== 'string') {
          return [];
        }

        return [{
          key: zone.key,
          name: zone.name,
          purpose: typeof zone.purpose === 'string' ? zone.purpose : zone.key,
          cidr: zone.cidr,
          ...(zone.isPublicEntry === true ? { isPublicEntry: true } : {}),
        }];
      }),
      hosts: hosts.flatMap((hostValue) => {
        const host = this.readJsonObject(hostValue);
        if (
          !host ||
          typeof host.key !== 'string' ||
          typeof host.name !== 'string' ||
          typeof host.zoneKey !== 'string' ||
          typeof host.role !== 'string' ||
          typeof host.primaryPrivateIp !== 'string'
        ) {
          return [];
        }

        return [{
          key: host.key,
          name: host.name,
          zoneKey: host.zoneKey,
          role: host.role,
          privateIp: host.primaryPrivateIp,
          ...(host.exposePublic === true ? { exposePublic: true } : {}),
        }];
      }),
      publicEntry: {
        hostKey: entryHostKey,
        protocols: [{ protocol: 'ssh', port: 22 }],
      },
    };
  }

  private readJsonObject(value: unknown): Record<string, unknown> | null {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return null;
    }

    return value as Record<string, unknown>;
  }

  private readJsonArray(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
  }

  private async failJob(job: ProvisionJobRecord, instance: RangeInstanceRecord, message: string) {
    await this.adminRepository.updateProvisionJob(job.id, {
      status: 'failed',
      finishedAt: new Date(),
      errorSummary: message,
    });

    await this.adminRepository.updateRangeInstance(instance.id, {
      status:
        job.jobType === 'destroy'
          ? 'destroy_failed'
          : job.jobType === 'update'
            ? instance.status
            : 'create_failed',
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

function readWorkerPollIntervalMs() {
  const configuredValue = Number(process.env.PROVISIONING_WORKER_POLL_INTERVAL_MS ?? DEFAULT_WORKER_POLL_INTERVAL_MS);

  return Number.isFinite(configuredValue) && configuredValue > 0
    ? configuredValue
    : DEFAULT_WORKER_POLL_INTERVAL_MS;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
