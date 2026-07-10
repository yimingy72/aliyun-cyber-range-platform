import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import {
  ADMIN_REPOSITORY,
  AdminRepository,
  ProvisionJobRecord,
  RangeInstanceRecord,
  RangeResourceSummary,
  RangeTemplateCompiledSpec,
  RangeTemplateTopologySpec,
} from '../admin/admin.repository';
import { signAliyunRpcQuery } from '../admin/image-catalog-rpc-signer';
import { SingleInstanceBatchExecutionService } from '../admin/single-instance-batch-execution.service';
import { SystemConfigService } from '../admin/system-config.service';
import {
  RANGE_PROVISIONER,
  type RangeProvisionStepEvent,
  type RangeProvisionStepReporter,
  RangeProvisioner,
} from './provisioning.types';

const DEFAULT_WORKER_POLL_INTERVAL_MS = 1_000;
const ALICLOUD_ECS_API_VERSION = '2014-05-26';
const ALICLOUD_VPC_API_VERSION = '2016-04-28';
const ALICLOUD_SIGNATURE_METHOD = 'HMAC-SHA1';
const ALICLOUD_SIGNATURE_VERSION = '1.0';
const DESTROY_VERIFICATION_ATTEMPTS = 12;
const DESTROY_VERIFICATION_INTERVAL_MS = 5_000;
const SINGLE_INSTANCE_TEMPLATE_MODULE_PATH = 'infra/opentofu/modules/alicloud-vpc-single-ecs';

@Injectable()
export class ProvisioningWorkerService {
  private readonly activeSingleBatchIds = new Set<string>();
  private readonly activeTasks = new Set<Promise<void>>();
  private rangeTaskActive = false;
  private readonly singleInstanceBatchExecutionService: SingleInstanceBatchExecutionService;

  constructor(
    @Inject(ADMIN_REPOSITORY) private readonly adminRepository: AdminRepository,
    @Inject(RANGE_PROVISIONER) private readonly rangeProvisioner: RangeProvisioner,
    private readonly systemConfigService: SystemConfigService,
    singleInstanceBatchExecutionService?: SingleInstanceBatchExecutionService,
  ) {
    this.singleInstanceBatchExecutionService =
      singleInstanceBatchExecutionService ??
      new SingleInstanceBatchExecutionService(this.adminRepository, this.systemConfigService);
  }

  dispatch(jobId: string) {
    void this.dispatchSingleInstanceJob(jobId);
  }

  async runLoop(): Promise<void> {
    while (true) {
      await this.processExpiredInstances(new Date());
      const started = await this.startEligiblePendingJobs();

      if (started > 0) {
        continue;
      }

      if (this.activeTasks.size > 0) {
        await Promise.race(this.activeTasks);
        continue;
      }

      await sleep(readWorkerPollIntervalMs());
    }
  }

  async processExpiredInstances(now: Date) {
    const instances = await this.adminRepository.listRangeInstances();

    for (const instance of instances) {
      if (instance.status !== 'running' || !instance.expiresAt || instance.expiresAt > now) {
        continue;
      }

      const job = await this.adminRepository.createProvisionJob({
        rangeInstanceId: instance.id,
        jobType: 'destroy',
        triggeredBy: 'system:auto-expire',
      });

      await this.adminRepository.updateRangeInstance(instance.id, {
        status: 'pending_destroy',
        lastJobId: job.id,
      });
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

    await this.adminRepository.updateRangeInstance(instance.id, {
      errorSummary: null,
    });
    const reportStep = this.createStepReporter(job.id);

    try {
      const effectiveJobType = this.resolveEffectiveJobType(job, instance);
      const runtimeConfig = await this.systemConfigService.getSnapshot();

      if (instance.instanceMode === 'single') {
        await this.processSingleInstanceJob({
          job,
          instance,
          effectiveJobType,
          runtimeConfig,
          reportStep,
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

      const allowTemplateFallback = await this.shouldAllowTemplateFallback(instance, template, job.triggeredBy);
      const templateModulePath =
        sourceVersion?.modulePathOrRef ??
        (allowTemplateFallback ? template.modulePathOrRef : null);
      const baseCompiledProvisionSpec =
        this.getCompiledProvisionSpec(sourceVersion?.compiledProvisionSpec) ??
        (allowTemplateFallback ? this.getCompiledProvisionSpec(template.compiledProvisionSpec) : null) ??
        this.getCompiledProvisionSpec(instance.runtimeCompiledProvisionSpec);
      const baseCompiledSpec =
        this.getCompiledSpec(sourceVersion?.compiledSpec) ??
        (allowTemplateFallback ? this.getCompiledSpec(template.compiledSpec) : null);
      const baseTopologySpec =
        this.getTopologySpecFromCompiledProvisionSpec(baseCompiledProvisionSpec) ??
        this.getCompiledTopologySpec(baseCompiledSpec) ??
        sourceVersion?.topologySpec ??
        (allowTemplateFallback ? template.topologySpec : null);

      if (!templateModulePath) {
        await this.failJob(job, instance, 'Template module path not found');
        return;
      }

      if (!baseTopologySpec && !baseCompiledSpec && !baseCompiledProvisionSpec) {
        await this.failJob(job, instance, 'Template provisioning blueprint not found');
        return;
      }

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
          runtimeCredentials: instance.runtimeCredentials ?? undefined,
          topologySpec,
          compiledProvisionSpec,
          compiledSpec,
          reportStep,
        });

        await this.runWorkerStep(reportStep, 'persist_access_entry', async () => {
          await this.adminRepository.updateRangeInstance(instance.id, {
            status: 'running',
            runtimeTopologyGraph:
              sourceVersion?.topologyGraph ??
              (allowTemplateFallback ? template.topologyGraph : null) ??
              instance.runtimeTopologyGraph ??
              null,
            runtimeScenarioTemplateSpec:
              sourceVersion?.scenarioTemplateSpec ??
              (allowTemplateFallback ? template.scenarioTemplateSpec : null) ??
              instance.runtimeScenarioTemplateSpec ??
              null,
            runtimeCompiledProvisionSpec:
              baseCompiledProvisionSpec ??
              instance.runtimeCompiledProvisionSpec ??
              null,
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
          preserveWorkspaceState: true,
          runtimeConfig,
          runtimeCredentials: instance.runtimeCredentials ?? undefined,
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

        await this.runWorkerStep(reportStep, 'verify_destroy', async () => {
          await this.verifyDestroyCompletion(instance, runtimeConfig);
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

  private async startEligiblePendingJobs() {
    const pendingJobs = (await this.adminRepository.listProvisionJobs()).filter((job) => job.status === 'pending');

    if (!pendingJobs.length) {
      return 0;
    }

    const instances = await this.adminRepository.listRangeInstances();
    const instancesById = new Map(instances.map((instance) => [instance.id, instance]));
    let started = 0;

    for (const job of pendingJobs) {
      const instance = instancesById.get(job.rangeInstanceId);

      if (!instance) {
        continue;
      }

      if (instance.instanceMode === 'single') {
        const batchLockId = instance.singleInstanceBatchId ?? instance.id;

        if (this.activeSingleBatchIds.has(batchLockId)) {
          continue;
        }

        this.activeSingleBatchIds.add(batchLockId);
        started += 1;
        this.trackTask(
          this.process(job.id).finally(() => {
            this.activeSingleBatchIds.delete(batchLockId);
          }),
        );
        continue;
      }

      if (this.rangeTaskActive) {
        continue;
      }

      this.rangeTaskActive = true;
      started += 1;
      this.trackTask(
        this.process(job.id).finally(() => {
          this.rangeTaskActive = false;
        }),
      );
    }

    return started;
  }

  private async shouldAllowTemplateFallback(
    instance: RangeInstanceRecord,
    template: NonNullable<Awaited<ReturnType<AdminRepository['getRangeTemplateById']>>>,
    triggeredBy: string,
  ) {
    const actor = await this.adminRepository.getPlatformUserById(triggeredBy);

    if (!actor) {
      return true;
    }

    if (actor.role === 'admin') {
      return true;
    }

    return template.ownerUserId === actor.id || instance.ownerUserId === template.ownerUserId;
  }

  private trackTask(task: Promise<void>) {
    this.activeTasks.add(task);
    void task.finally(() => {
      this.activeTasks.delete(task);
    });
  }

  private async dispatchSingleInstanceJob(jobId: string) {
    const job = await this.adminRepository.getProvisionJobById(jobId);

    if (!job || job.status !== 'pending') {
      return;
    }

    const instance = await this.adminRepository.getRangeInstanceById(job.rangeInstanceId);

    if (!instance || instance.instanceMode !== 'single') {
      return;
    }

    const batchLockId = instance.singleInstanceBatchId ?? instance.id;

    if (this.activeSingleBatchIds.has(batchLockId)) {
      return;
    }

    this.activeSingleBatchIds.add(batchLockId);
    this.trackTask(
      this.process(jobId).finally(() => {
        this.activeSingleBatchIds.delete(batchLockId);
      }),
    );
  }

  private async processSingleInstanceJob(input: {
    job: ProvisionJobRecord;
    instance: RangeInstanceRecord;
    effectiveJobType: 'create' | 'update' | 'destroy' | 'refresh_status';
    runtimeConfig: {
      accessKeyId: string;
      accessKeySecret: string;
      defaultRegion: string;
      defaultZoneId: string;
    };
    reportStep: RangeProvisionStepReporter;
  }) {
    if (!input.instance.singleInstanceConfig) {
      throw new Error('Single instance config missing');
    }

    if (input.effectiveJobType === 'update') {
      throw new Error('Single instance update jobs are not supported');
    }

    const items = await this.collectSingleInstanceExecutionItems(input);

    if (input.effectiveJobType === 'refresh_status') {
      const item = items[0];

      if (!item) {
        throw new Error('Single instance refresh job is missing its target item');
      }

      await this.runWorkerStep(input.reportStep, 'refresh_access_entry', async () => {
        if (item.job.status === 'pending') {
          await this.adminRepository.updateProvisionJob(item.job.id, {
            status: 'running',
            startedAt: new Date(),
            finishedAt: null,
            errorSummary: null,
          });
        }
      });

      await this.singleInstanceBatchExecutionService.refreshSingleInstanceAccessEntry(item);
      return;
    }

    if (input.effectiveJobType === 'create') {
      await this.runWorkerStep(input.reportStep, 'prepare', async () => {
        for (const item of items) {
          await this.adminRepository.updateRangeInstance(item.instance.id, {
            status: 'creating',
          });
          if (item.job.status === 'pending') {
            await this.adminRepository.updateProvisionJob(item.job.id, {
              status: 'running',
              startedAt: new Date(),
              finishedAt: null,
              errorSummary: null,
            });
          }
        }
      });

      await this.singleInstanceBatchExecutionService.executeCreateBatch(items);

      for (const item of items) {
        const refreshedInstance = await this.adminRepository.getRangeInstanceById(item.instance.id);

        if (!needsSingleInstancePublicIpRefresh(refreshedInstance)) {
          continue;
        }

        const refreshJob = await this.adminRepository.createProvisionJob({
          rangeInstanceId: item.instance.id,
          jobType: 'refresh_status',
          triggeredBy: item.job.triggeredBy,
        });
        this.dispatch(refreshJob.id);
      }

      return;
    }

    await this.runWorkerStep(input.reportStep, 'prepare', async () => {
      for (const item of items) {
        await this.adminRepository.updateRangeInstance(item.instance.id, {
          status: 'destroying',
        });
        if (item.job.status === 'pending') {
          await this.adminRepository.updateProvisionJob(item.job.id, {
            status: 'running',
            startedAt: new Date(),
            finishedAt: null,
            errorSummary: null,
          });
        }
      }
    });

    await this.singleInstanceBatchExecutionService.executeDestroyBatch(items);
  }

  private async collectSingleInstanceExecutionItems(input: {
    job: ProvisionJobRecord;
    instance: RangeInstanceRecord;
    effectiveJobType: 'create' | 'update' | 'destroy' | 'refresh_status';
  }) {
    const batchId = input.instance.singleInstanceBatchId;
    const currentItem = {
      instance: input.instance,
      job: input.job,
    };

    if (
      !batchId ||
      input.job.jobType === 'retry' ||
      input.job.jobType === 'refresh_status' ||
      input.effectiveJobType === 'refresh_status'
    ) {
      return [currentItem];
    }

    const groups = await this.adminRepository.listSingleInstanceBatchesWithInstances();
    const group = groups.find((entry) => entry.batch.id === batchId);

    if (!group) {
      return [currentItem];
    }

    const targetStatus = input.effectiveJobType === 'create' ? 'pending_create' : 'pending_destroy';
    const candidateInstances = group.instances.filter((instance) => instance.status === targetStatus);
    const jobsById = new Map(
      (
        await Promise.all(
          candidateInstances.map((instance) =>
            instance.lastJobId ? this.adminRepository.getProvisionJobById(instance.lastJobId) : Promise.resolve(null),
          ),
        )
      )
        .filter((job): job is ProvisionJobRecord => Boolean(job))
        .map((job) => [job.id, job]),
    );

    const groupedItems = candidateInstances.flatMap((instance) => {
      const job = instance.lastJobId ? jobsById.get(instance.lastJobId) : null;

      if (!job) {
        return [];
      }

      return [
        {
          instance,
          job,
        },
      ];
    });

    const itemsByInstanceId = new Map<string, { instance: RangeInstanceRecord; job: ProvisionJobRecord }>();
    itemsByInstanceId.set(currentItem.instance.id, currentItem);

    for (const item of groupedItems) {
      itemsByInstanceId.set(item.instance.id, item);
    }

    return Array.from(itemsByInstanceId.values());
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

  private resolveSingleInstanceNetworkIdentity(instance: RangeInstanceRecord) {
    const runtimeScenarioTemplateSpec = this.readJsonObject(instance.runtimeScenarioTemplateSpec);
    const topology = this.readJsonObject(runtimeScenarioTemplateSpec?.topology);
    const regionId =
      typeof topology?.defaultRegion === 'string' ? topology.defaultRegion.trim() : '';
    const zoneId =
      typeof topology?.defaultZoneId === 'string' ? topology.defaultZoneId.trim() : '';

    if (!regionId || !zoneId) {
      throw new Error('Single instance launch-time network identity missing');
    }

    return {
      regionId,
      zoneId,
    };
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

  private async verifyDestroyCompletion(
    instance: RangeInstanceRecord,
    runtimeConfig: {
      accessKeyId: string;
      accessKeySecret: string;
      defaultRegion: string;
    },
  ) {
    for (let attempt = 0; attempt < DESTROY_VERIFICATION_ATTEMPTS; attempt += 1) {
      const residualResources = await this.findResidualCloudResources(
        instance.resourceSummary,
        runtimeConfig,
      );

      if (residualResources.length === 0) {
        return;
      }

      if (attempt < DESTROY_VERIFICATION_ATTEMPTS - 1) {
        await sleep(DESTROY_VERIFICATION_INTERVAL_MS);
        continue;
      }

      throw new Error(
        `Residual cloud resources still exist after destroy: ${residualResources.join(', ')}`,
      );
    }
  }

  private async findResidualCloudResources(
    resourceSummary: RangeResourceSummary | null,
    runtimeConfig: {
      accessKeyId: string;
      accessKeySecret: string;
      defaultRegion: string;
    },
  ) {
    if (!resourceSummary) {
      return [];
    }

    const regionId = runtimeConfig.defaultRegion;
    const residualResources: string[] = [];

    const vpcId = resourceSummary.vpcId?.trim();
    const vpcExists = vpcId
      ? await this.checkVpcExists(vpcId, runtimeConfig, regionId)
      : false;

    if (vpcExists && vpcId) {
      residualResources.push(`vpc:${vpcId}`);
    }

    for (const subnetId of Object.values(resourceSummary.subnetIds ?? {})) {
      if (subnetId && vpcExists && (await this.checkVSwitchExists(subnetId, runtimeConfig, regionId, vpcId ?? undefined))) {
        residualResources.push(`vswitch:${subnetId}`);
      }
    }

    const existingInstanceIds = await this.findExistingInstanceIds(
      Object.values(resourceSummary.hostIds ?? {}).filter(Boolean),
      runtimeConfig,
      regionId,
    );
    residualResources.push(
      ...existingInstanceIds.map((instanceId) => `instance:${instanceId}`),
    );

    for (const networkInterfaceId of Object.values(
      resourceSummary.secondaryNetworkInterfaceIds ?? {},
    )) {
      if (
        networkInterfaceId &&
        (await this.checkNetworkInterfaceExists(
          networkInterfaceId,
          runtimeConfig,
          regionId,
        ))
      ) {
        residualResources.push(`eni:${networkInterfaceId}`);
      }
    }

    for (const natGatewayId of Object.values(resourceSummary.natGatewayIds ?? {})) {
      if (natGatewayId && (await this.checkNatGatewayExists(natGatewayId, runtimeConfig, regionId))) {
        residualResources.push(`nat:${natGatewayId}`);
      }
    }

    const eipIds = [
      ...(resourceSummary.eipAllocationId ? [resourceSummary.eipAllocationId] : []),
      ...Object.values(resourceSummary.eipAllocationIds ?? {}).filter(Boolean),
    ];
    for (const allocationId of eipIds) {
      if (await this.checkEipExists(allocationId, runtimeConfig, regionId)) {
        residualResources.push(`eip:${allocationId}`);
      }
    }

    return residualResources;
  }

  private async findExistingInstanceIds(
    instanceIds: string[],
    runtimeConfig: {
      accessKeyId: string;
      accessKeySecret: string;
    },
    regionId: string,
  ) {
    if (instanceIds.length === 0) {
      return [];
    }

    const payload = await this.performAliyunRpcRequest<{
      Instances?: {
        Instance?: Array<{ InstanceId?: string }> | { InstanceId?: string };
      };
    }>({
      endpoint: `ecs.${regionId}.aliyuncs.com`,
      version: ALICLOUD_ECS_API_VERSION,
      action: 'DescribeInstances',
      accessKeyId: runtimeConfig.accessKeyId,
      accessKeySecret: runtimeConfig.accessKeySecret,
      parameters: {
        RegionId: regionId,
        InstanceIds: JSON.stringify(instanceIds),
      },
    });

    const items = payload.Instances?.Instance;
    const normalized = Array.isArray(items) ? items : items ? [items] : [];

    return normalized
      .map((item) => item?.InstanceId)
      .filter((value): value is string => typeof value === 'string' && value.length > 0);
  }

  private async checkVpcExists(
    vpcId: string,
    runtimeConfig: {
      accessKeyId: string;
      accessKeySecret: string;
    },
    regionId: string,
  ) {
    const payload = await this.performAliyunRpcRequest<{
      Vpcs?: {
        Vpc?: Array<{ VpcId?: string }> | { VpcId?: string };
      };
    }>({
      endpoint: `vpc.${regionId}.aliyuncs.com`,
      version: ALICLOUD_VPC_API_VERSION,
      action: 'DescribeVpcs',
      accessKeyId: runtimeConfig.accessKeyId,
      accessKeySecret: runtimeConfig.accessKeySecret,
      parameters: {
        RegionId: regionId,
        VpcId: vpcId,
      },
    });

    const items = payload.Vpcs?.Vpc;
    const normalized = Array.isArray(items) ? items : items ? [items] : [];

    return normalized.some((item) => item?.VpcId === vpcId);
  }

  private async checkVSwitchExists(
    vSwitchId: string,
    runtimeConfig: {
      accessKeyId: string;
      accessKeySecret: string;
    },
    regionId: string,
    vpcId?: string,
  ) {
    const payload = await this.performAliyunRpcRequest<{
      VSwitches?: {
        VSwitch?: Array<{ VSwitchId?: string }> | { VSwitchId?: string };
      };
    }>({
      endpoint: `vpc.${regionId}.aliyuncs.com`,
      version: ALICLOUD_VPC_API_VERSION,
      action: 'DescribeVSwitches',
      accessKeyId: runtimeConfig.accessKeyId,
      accessKeySecret: runtimeConfig.accessKeySecret,
      parameters: {
        RegionId: regionId,
        ...(vpcId ? { VpcId: vpcId } : {}),
      },
    });

    const items = payload.VSwitches?.VSwitch;
    const normalized = Array.isArray(items) ? items : items ? [items] : [];

    return normalized.some((item) => item?.VSwitchId === vSwitchId);
  }

  private async checkNetworkInterfaceExists(
    networkInterfaceId: string,
    runtimeConfig: {
      accessKeyId: string;
      accessKeySecret: string;
    },
    regionId: string,
  ) {
    const payload = await this.performAliyunRpcRequest<{
      NetworkInterfaceSets?: {
        NetworkInterfaceSet?:
          | Array<{ NetworkInterfaceId?: string }>
          | { NetworkInterfaceId?: string };
      };
    }>({
      endpoint: `ecs.${regionId}.aliyuncs.com`,
      version: ALICLOUD_ECS_API_VERSION,
      action: 'DescribeNetworkInterfaces',
      accessKeyId: runtimeConfig.accessKeyId,
      accessKeySecret: runtimeConfig.accessKeySecret,
      parameters: {
        RegionId: regionId,
        NetworkInterfaceId: networkInterfaceId,
      },
    });

    const items = payload.NetworkInterfaceSets?.NetworkInterfaceSet;
    const normalized = Array.isArray(items) ? items : items ? [items] : [];

    return normalized.some(
      (item) => item?.NetworkInterfaceId === networkInterfaceId,
    );
  }

  private async checkNatGatewayExists(
    natGatewayId: string,
    runtimeConfig: {
      accessKeyId: string;
      accessKeySecret: string;
    },
    regionId: string,
  ) {
    const payload = await this.performAliyunRpcRequest<{
      NatGateways?: {
        NatGateway?: Array<{ NatGatewayId?: string }> | { NatGatewayId?: string };
      };
    }>({
      endpoint: `vpc.${regionId}.aliyuncs.com`,
      version: ALICLOUD_VPC_API_VERSION,
      action: 'DescribeNatGateways',
      accessKeyId: runtimeConfig.accessKeyId,
      accessKeySecret: runtimeConfig.accessKeySecret,
      parameters: {
        RegionId: regionId,
        NatGatewayId: natGatewayId,
      },
    });

    const items = payload.NatGateways?.NatGateway;
    const normalized = Array.isArray(items) ? items : items ? [items] : [];

    return normalized.some((item) => item?.NatGatewayId === natGatewayId);
  }

  private async checkEipExists(
    allocationId: string,
    runtimeConfig: {
      accessKeyId: string;
      accessKeySecret: string;
    },
    regionId: string,
  ) {
    const payload = await this.performAliyunRpcRequest<{
      EipAddresses?: {
        EipAddress?: Array<{ AllocationId?: string }> | { AllocationId?: string };
      };
    }>({
      endpoint: `vpc.${regionId}.aliyuncs.com`,
      version: ALICLOUD_VPC_API_VERSION,
      action: 'DescribeEipAddresses',
      accessKeyId: runtimeConfig.accessKeyId,
      accessKeySecret: runtimeConfig.accessKeySecret,
      parameters: {
        RegionId: regionId,
        AllocationId: allocationId,
      },
    });

    const items = payload.EipAddresses?.EipAddress;
    const normalized = Array.isArray(items) ? items : items ? [items] : [];

    return normalized.some((item) => item?.AllocationId === allocationId);
  }

  private async performAliyunRpcRequest<ResponsePayload>(input: {
    endpoint: string;
    version: string;
    action: string;
    accessKeyId: string;
    accessKeySecret: string;
    parameters?: Record<string, string>;
  }): Promise<ResponsePayload> {
    const query = signAliyunRpcQuery(
      {
        Action: input.action,
        AccessKeyId: input.accessKeyId,
        Format: 'JSON',
        SignatureMethod: ALICLOUD_SIGNATURE_METHOD,
        SignatureNonce: randomUUID(),
        SignatureVersion: ALICLOUD_SIGNATURE_VERSION,
        Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
        Version: input.version,
        ...(input.parameters ?? {}),
      },
      input.accessKeySecret,
    );

    const response = await fetch(`https://${input.endpoint}/?${query}`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Aliyun ${input.action} request failed with status ${response.status}`);
    }

    return (await response.json()) as ResponsePayload;
  }

  private async failJob(job: ProvisionJobRecord, instance: RangeInstanceRecord, message: string) {
    await this.adminRepository.updateProvisionJob(job.id, {
      status: 'failed',
      finishedAt: new Date(),
      errorSummary: message,
    });

    const failedInstanceStatus = this.resolveFailedInstanceStatus(job, instance);

    await this.adminRepository.updateRangeInstance(instance.id, {
      status: failedInstanceStatus,
      errorSummary: message,
    });
  }

  private resolveFailedInstanceStatus(job: ProvisionJobRecord, instance: RangeInstanceRecord) {
    const effectiveJobType =
      job.jobType === 'retry'
        ? instance.status === 'pending_destroy' || instance.status === 'destroy_failed'
          ? 'destroy'
          : instance.status === 'pending_create' || instance.status === 'create_failed'
            ? 'create'
            : 'create'
        : job.jobType;

    if (effectiveJobType === 'destroy') {
      return 'destroy_failed' as const;
    }

    if (effectiveJobType === 'update') {
      return instance.status;
    }

    return 'create_failed' as const;
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

function needsSingleInstancePublicIpRefresh(instance: RangeInstanceRecord | null) {
  return Boolean(
    instance &&
      instance.instanceMode === 'single' &&
      instance.status === 'running' &&
      instance.resourceSummary?.mode === 'ecs-native' &&
      instance.resourceSummary?.hostIds &&
      !instance.accessEntry?.publicIp,
  );
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
