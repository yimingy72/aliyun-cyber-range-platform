import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';

import {
  ADMIN_REPOSITORY,
  AdminRepository,
  ProvisionJobRecord,
  ProvisionJobTopologySnapshot,
  RangeInstanceRecord,
  RangeResourceSummary,
  RangeTemplateCompiledSpec,
  RangeTemplateTopologySpec,
} from '../admin/admin.repository';
import { buildBillingTags } from '../admin/billing-tagging';
import { RangeTemplatesService } from '../admin/range-templates.service';
import { releaseRangeInstanceBillingLedger, syncRangeInstanceBillingLedger } from '../admin/billing-ledger-sync';
import { signAliyunRpcQuery } from '../admin/image-catalog-rpc-signer';
import { SingleInstanceBatchExecutionService } from '../admin/single-instance-batch-execution.service';
import { SystemConfigService } from '../admin/system-config.service';
import { FAILED_CREATE_CLEANUP_PROOF_STEP, type FailedCreateCleanupProof } from '../admin/failed-create-cleanup-evidence';
import {
  AliyunEcsResourceClient,
  PlatformResourceReconciliationService,
} from './platform-resource-reconciliation.service';
import {
  RANGE_PROVISIONER,
  type RangeProvisionDestroyInput,
  type RangeProvisionStepEvent,
  type RangeProvisionStepReporter,
  RangeProvisioner,
} from './provisioning.types';

const DEFAULT_WORKER_POLL_INTERVAL_MS = 1_000;
const DEFAULT_INTERRUPTED_JOB_STALE_AFTER_MS = 5 * 60 * 1_000;
const DEFAULT_PLATFORM_RESOURCE_RECONCILIATION_INTERVAL_MS = 5 * 60 * 1_000;
const ALICLOUD_ECS_API_VERSION = '2014-05-26';
const ALICLOUD_VPC_API_VERSION = '2016-04-28';
const ALICLOUD_SIGNATURE_METHOD = 'HMAC-SHA1';
const ALICLOUD_SIGNATURE_VERSION = '1.0';
const DESTROY_VERIFICATION_ATTEMPTS = 12;
const DESTROY_VERIFICATION_INTERVAL_MS = 5_000;
const SINGLE_INSTANCE_TEMPLATE_MODULE_PATH = 'infra/opentofu/modules/alicloud-vpc-single-ecs';

type SingleInstanceJobInput = {
  job: ProvisionJobRecord;
  instance: RangeInstanceRecord;
  effectiveJobType: 'create' | 'update' | 'destroy' | 'refresh_status';
  runtimeConfig: Awaited<ReturnType<SystemConfigService['getSnapshot']>>;
  reportStep: RangeProvisionStepReporter;
};
type SingleInstanceExecutionItem = { instance: RangeInstanceRecord; job: ProvisionJobRecord };

@Injectable()
export class ProvisioningWorkerService {
  private readonly logger = new Logger(ProvisioningWorkerService.name);
  private readonly activeSingleBatchIds = new Set<string>();
  private readonly activeTasks = new Set<Promise<void>>();
  private rangeTaskActive = false;
  private readonly singleInstanceBatchExecutionService: SingleInstanceBatchExecutionService;
  private readonly platformResourceReconciliationService: PlatformResourceReconciliationService;
  private nextResourceReconciliationAt = 0;

  constructor(
    @Inject(ADMIN_REPOSITORY) private readonly adminRepository: AdminRepository,
    @Inject(RANGE_PROVISIONER) private readonly rangeProvisioner: RangeProvisioner,
    private readonly systemConfigService: SystemConfigService,
    singleInstanceBatchExecutionService?: SingleInstanceBatchExecutionService,
    platformResourceReconciliationService?: PlatformResourceReconciliationService,
  ) {
    this.singleInstanceBatchExecutionService =
      singleInstanceBatchExecutionService ??
      new SingleInstanceBatchExecutionService(this.adminRepository, this.systemConfigService);
    this.platformResourceReconciliationService =
      platformResourceReconciliationService ??
      new PlatformResourceReconciliationService(
        this.adminRepository,
        new AliyunEcsResourceClient(this.systemConfigService),
      );
  }

  dispatch(jobId: string) {
    void this.dispatchSingleInstanceJob(jobId);
  }

  async runLoop(): Promise<void> {
    await this.recoverInterruptedJobs(new Date());
    await this.reconcilePlatformResourcesSafely(new Date());

    while (true) {
      const now = new Date();
      await this.recoverInterruptedJobs(now);
      await this.processExpiredInstances(now);
      await this.reconcilePlatformResourcesIfDue(now);
      const started = await this.startEligiblePendingJobs();

      if (started > 0) {
        continue;
      }

      if (this.activeTasks.size > 0) {
        await Promise.race([...this.activeTasks, sleep(readWorkerPollIntervalMs())]);
        continue;
      }

      await sleep(readWorkerPollIntervalMs());
    }
  }

  async recoverInterruptedJobs(now: Date): Promise<number> {
    return this.adminRepository.requeueInterruptedProvisionJobs(
      new Date(now.getTime() - readInterruptedJobStaleAfterMs()),
    );
  }

  async reconcilePlatformResources(now: Date) {
    return this.platformResourceReconciliationService.reconcile(now);
  }

  private async reconcilePlatformResourcesIfDue(now: Date) {
    if (now.getTime() < this.nextResourceReconciliationAt) {
      return;
    }

    await this.reconcilePlatformResourcesSafely(now);
  }

  private async reconcilePlatformResourcesSafely(now: Date) {
    this.nextResourceReconciliationAt = now.getTime() + readPlatformResourceReconciliationIntervalMs();

    try {
      await this.reconcilePlatformResources(now);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Platform cloud resource reconciliation failed: ${message}`);
    }
  }

  async processExpiredInstances(now: Date) {
    const instances = await this.adminRepository.listRangeInstances();

    for (const instance of instances) {
      if (instance.instanceMode === 'single' && instance.expiresAt && instance.expiresAt <= now && ['running','creating'].includes(instance.status)) {
        await this.adminRepository.withSingleInstanceControlLock(async () => {
          const current=await this.adminRepository.getRangeInstanceById(instance.id);
          if(!current || !['running','creating'].includes(current.status)) return;
          const last=current.lastJobId?await this.adminRepository.getProvisionJobById(current.lastJobId):null;
          if(last?.status === 'running' && last.jobType !== 'refresh_status') return;
          if(last && ['pending','running'].includes(last.status)) await this.adminRepository.updateProvisionJob(last.id,{status:'failed',finishedAt:new Date(),errorSummary:'Expired before access refresh completed'});
          const job=await this.adminRepository.createProvisionJob({rangeInstanceId:current.id,jobType:'destroy',triggeredBy:'system:auto-expire'});
          await this.adminRepository.updateRangeInstance(current.id,{status:'pending_destroy',lastJobId:job.id});
        });
        continue;
      }
      if (instance.status !== 'running' || !instance.expiresAt || instance.expiresAt > now) {
        continue;
      }

      if (instance.instanceMode === 'range') {
        await this.adminRepository.queueRangeInstanceJob({
          rangeInstanceId: instance.id, jobType: 'destroy', triggeredBy: 'system:auto-expire',
          expectedStatus: instance.status, expectedOwnerUserId: instance.ownerUserId, nextStatus: 'pending_destroy',
        });
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
    const claimedAt = new Date();
    const pendingJob = await this.adminRepository.getProvisionJobById(jobId);
    const pendingInstance = pendingJob ? await this.adminRepository.getRangeInstanceById(pendingJob.rangeInstanceId) : null;
    const job = pendingInstance?.instanceMode === 'range'
      ? await this.adminRepository.claimRangeProvisionJob(jobId, claimedAt)
      : await this.adminRepository.claimProvisionJob(jobId, claimedAt);

    if (!job) {
      return;
    }

    const heartbeat = this.startProvisionJobHeartbeat([job]);

    try {
      await this.processClaimedJob(job);
    } finally {
      clearInterval(heartbeat);
    }
  }

  private startProvisionJobHeartbeat(jobs: ProvisionJobRecord[]) {
    const heartbeat = setInterval(() => {
      for (const job of jobs) {
        void this.ownsProvisionJobClaim(job);
      }
    }, Math.max(1, Math.min(30_000, readInterruptedJobStaleAfterMs() / 3)));
    heartbeat.unref();
    return heartbeat;
  }

  private async ownsProvisionJobClaim(job: ProvisionJobRecord) {
    if (!job.startedAt) {
      return false;
    }

    try {
      const instance = await this.adminRepository.getRangeInstanceById(job.rangeInstanceId);
      return instance?.instanceMode === 'range'
        ? await this.adminRepository.heartbeatRangeProvisionJob(job.id, job.startedAt, new Date())
        : await this.adminRepository.heartbeatProvisionJob(job.id, job.startedAt, new Date());
    } catch (error) {
      this.logger.error(`Provision job heartbeat failed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  private async processClaimedJob(job: ProvisionJobRecord) {
    const instance = await this.adminRepository.getRangeInstanceById(job.rangeInstanceId);

    if (!instance) {
      await this.adminRepository.updateProvisionJob(job.id, {
        status: 'failed',
        finishedAt: new Date(),
        errorSummary: 'Range instance not found',
      });
      return;
    }

    if (instance.instanceMode === 'range') {
      if (!(await this.ownsProvisionJobClaim(job))) return;
      await this.updateRangeForClaim(job, { errorSummary: null });
    }
    const reportStep = this.createStepReporter(job.id);
    let failedCreateCleanupInput: RangeProvisionDestroyInput | null = null;
    let failedCreateCleanupContext: { id: string; accountUid: string; regionId: string } | null = null;

    try {
      const effectiveJobType = this.resolveEffectiveJobType(job, instance);
      const runtimeConfig = await this.systemConfigService.getSnapshot();

      if (instance.instanceMode === 'single') {
        const current = await this.adminRepository.withSingleInstanceControlLock(async () => {
          let latest = await this.adminRepository.getRangeInstanceById(instance.id);
          if (latest && !latest.lastJobId) {
            const active = (await this.adminRepository.listProvisionJobs()).filter(value => value.rangeInstanceId === instance.id && ['pending','running'].includes(value.status));
            if (active.length === 1 && active[0].id === job.id) latest = await this.adminRepository.updateRangeInstance(instance.id,{lastJobId:job.id});
          }
          return latest;
        });
        if (!current || current.lastJobId !== job.id || !(await this.ownsProvisionJobClaim(job))
          || ['destroyed','create_failed'].includes(current.status) && job.jobType !== 'retry') {
          if (await this.ownsProvisionJobClaim(job)) await this.adminRepository.updateProvisionJob(job.id,{status:'failed',finishedAt:new Date(),errorSummary:'Superseded single-instance job'});
          return;
        }
        await this.processSingleInstanceJob({
          job,
          instance: current,
          effectiveJobType,
          runtimeConfig,
          reportStep,
        });
        this.nextResourceReconciliationAt = 0;
        return;
      }

      if (effectiveJobType === 'update') {
        await this.processRangeInstanceUpdateJob({
          job,
          instance,
          runtimeConfig,
          reportStep,
        });
        if (!(await this.ownsProvisionJobClaim(job))) {
          return;
        }
        if (!(await this.adminRepository.updateRangeProvisionJob(job.id, job.startedAt!, {
          status: 'succeeded', finishedAt: new Date(), errorSummary: null,
        }))) return;
        await this.finalizeDispatchedOperation(job, 'succeeded');
        this.nextResourceReconciliationAt = 0;
        return;
      }

      if (effectiveJobType === 'destroy') {
        await this.processRangeDestroyJob(job, instance, runtimeConfig, reportStep);
        return;
      }

      const frozen = job.topologySnapshot?.operation === 'create' ? job.topologySnapshot : null;
      if (!frozen && !instance.templateId) {
        await this.failJob(job, instance, 'Template not found');
        return;
      }

      const template = !frozen && instance.templateId ? await this.adminRepository.getRangeTemplateById(instance.templateId) : null;

      if (!frozen && !template) {
        await this.failJob(job, instance, 'Template not found');
        return;
      }

      const sourceVersion = frozen ? null : instance.sourceTemplateVersionId
        ? await this.adminRepository.getRangeTemplateVersionById(instance.sourceTemplateVersionId)
        : template?.currentDraftVersion ?? template?.currentPublishedVersion;

      if (!frozen && instance.sourceTemplateVersionId && !sourceVersion) {
        await this.failJob(job, instance, 'Template source version not found');
        return;
      }

      const allowTemplateFallback = Boolean(!frozen && !instance.sourceTemplateVersionId && template
        && await this.shouldAllowTemplateFallback(instance, template, job.triggeredBy));
      const templateModulePath =
        frozen?.templateModulePath ?? sourceVersion?.modulePathOrRef ??
        (allowTemplateFallback ? template?.modulePathOrRef : null);
      const baseCompiledProvisionSpec =
        this.getCompiledProvisionSpec(frozen?.compiledProvisionSpec ?? sourceVersion?.compiledProvisionSpec) ??
        (allowTemplateFallback ? this.getCompiledProvisionSpec(template?.compiledProvisionSpec) : null) ??
        this.getCompiledProvisionSpec(instance.runtimeCompiledProvisionSpec);
      const baseCompiledSpec =
        this.getCompiledSpec(frozen?.compiledSpec ?? sourceVersion?.compiledSpec) ??
        (allowTemplateFallback ? this.getCompiledSpec(template?.compiledSpec) : null);
      const baseTopologyGraph =
        frozen?.topologyGraph ?? sourceVersion?.topologyGraph ??
        (allowTemplateFallback ? template?.topologyGraph : null) ??
        instance.runtimeTopologyGraph ??
        null;
      const baseTopologySpec =
        (frozen ? frozen.topologySpec as RangeTemplateTopologySpec : null) ??
        this.getTopologySpecFromCompiledProvisionSpec(baseCompiledProvisionSpec) ??
        this.getCompiledTopologySpec(baseCompiledSpec) ??
        sourceVersion?.topologySpec ??
        (allowTemplateFallback ? template?.topologySpec : null);

      if (!templateModulePath) {
        await this.failJob(job, instance, 'Template module path not found');
        return;
      }

      if (!baseTopologySpec && !baseCompiledSpec && !baseCompiledProvisionSpec) {
        await this.failJob(job, instance, 'Template provisioning blueprint not found');
        return;
      }

      const compiledProvisionSpec = baseCompiledProvisionSpec;
      const compiledSpec = baseCompiledSpec;
      const topologySpec = baseTopologySpec;
      const topologyGraph = baseTopologyGraph;
      const accountContext = await this.resolveAccountContext();

      if (effectiveJobType === 'create') {
        await this.runWorkerStep(reportStep, 'prepare', async () => {
          await this.updateRangeForClaim(job, { status: 'creating' });
        });

        const billingTags = buildBillingTags({
          billingScope: instance.ownerUserId ? 'user' : 'platform',
          ownerUserId: instance.ownerUserId,
          rangeInstanceId: instance.id,
          singleInstanceBatchId: instance.singleInstanceBatchId ?? null,
          platformResourceType: 'range',
          billingStartAt: new Date(),
        });
        if (accountContext.cloudAccountContextId && accountContext.accountUid) {
          failedCreateCleanupContext = { id: accountContext.cloudAccountContextId, accountUid: accountContext.accountUid, regionId: accountContext.defaultRegion };
        }
        failedCreateCleanupInput = {
          rangeInstanceId: instance.id,
          templateModulePath,
          allocatedCidr: instance.allocatedCidr,
          runtimeConfig,
          runtimeCredentials: frozen?.runtimeCredentials ?? instance.runtimeCredentials ?? undefined,
          topologyGraph,
          topologySpec,
          compiledProvisionSpec,
          compiledSpec,
          billingTags,
        };
        if (!(await this.ownsProvisionJobClaim(job))) {
          return;
        }
        if (frozen) await this.assertRangeSnapshotImages(instance, frozen);
        const result = await this.rangeProvisioner.create({
          ...failedCreateCleanupInput,
          preserveWorkspaceState: job.jobType === 'retry' || job.retryCount > 0,
          reportStep,
        });

        if (!(await this.ownsProvisionJobClaim(job))) {
          return;
        }

        await this.runWorkerStep(reportStep, 'persist_access_entry', async () => {
          await this.updateRangeForClaim(job, {
            status: 'running',
            runtimeTopologyGraph:
              frozen?.topologyGraph ?? sourceVersion?.topologyGraph ??
              (allowTemplateFallback ? template?.topologyGraph : null) ??
              instance.runtimeTopologyGraph ??
              null,
            runtimeScenarioTemplateSpec:
              frozen?.scenarioTemplateSpec ?? sourceVersion?.scenarioTemplateSpec ??
              (allowTemplateFallback ? template?.scenarioTemplateSpec : null) ??
              instance.runtimeScenarioTemplateSpec ??
              null,
            runtimeCompiledProvisionSpec:
              baseCompiledProvisionSpec ??
              instance.runtimeCompiledProvisionSpec ??
              null,
            runtimeCredentials: frozen?.runtimeCredentials ?? instance.runtimeCredentials ?? null,
            accessEntry: result.accessEntry,
            resourceSummary: result.resourceSummary,
            errorSummary: null,
          });
          await syncRangeInstanceBillingLedger({
            repository: this.adminRepository,
            instance,
            regionId: accountContext.defaultRegion,
            cloudAccountUid: accountContext.accountUid,
            resourceSummary: result.resourceSummary,
            sourceProvisionJobId: job.id,
            billingStartAt: new Date(),
          });
        });
      }

      if (!(await this.ownsProvisionJobClaim(job))) {
        return;
      }
      if (!(await this.adminRepository.updateRangeProvisionJob(job.id, job.startedAt!, {
        status: 'succeeded', finishedAt: new Date(), errorSummary: null,
      }))) return;
      await this.finalizeDispatchedOperation(job, 'succeeded');
      this.nextResourceReconciliationAt = 0;
    } catch (error) {
      if (!(await this.ownsProvisionJobClaim(job))) {
        return;
      }
      const createFailureMessage = error instanceof Error ? error.message : 'Unknown provisioning error';
      const cleanupFailureMessage = failedCreateCleanupInput
        ? await this.cleanupFailedRangeCreate({
            instance,
            job,
            cloudContext: failedCreateCleanupContext,
            cleanupInput: failedCreateCleanupInput,
            reportStep,
          })
        : null;
      const message = appendCleanupFailureMessage(createFailureMessage, cleanupFailureMessage);

      await this.failJob(job, instance, message, cleanupFailureMessage ? 'destroy_failed' : undefined);
    }
  }

  private async updateRangeForClaim(job: ProvisionJobRecord, input: Parameters<AdminRepository['updateRangeInstance']>[1]) {
    const updated = job.startedAt && await this.adminRepository.updateRangeInstanceForProvisionJob(job.id, job.startedAt, input);
    if (!updated) throw new Error('Range operation claim is no longer active');
    return updated;
  }

  private async assertRangeSnapshotImages(instance: RangeInstanceRecord, snapshot: ProvisionJobTopologySnapshot) {
    const owner = instance.ownerUserId ? await this.adminRepository.getPlatformUserById(instance.ownerUserId) : undefined;
    await new RangeTemplatesService(this.adminRepository, this.systemConfigService).assertTemplateEcsImageSelections({
      ...snapshot, topologySpec: snapshot.topologySpec as RangeTemplateTopologySpec,
    }, owner ?? undefined);
  }

  private async processRangeDestroyJob(job: ProvisionJobRecord, instance: RangeInstanceRecord,
    runtimeConfig: Awaited<ReturnType<SystemConfigService['getSnapshot']>>, reportStep: RangeProvisionStepReporter) {
    if (!(await this.ownsProvisionJobClaim(job))) return;
    await this.runWorkerStep(reportStep, 'prepare', async () => { await this.updateRangeForClaim(job, { status: 'destroying' }); });
    await this.rangeProvisioner.destroy({
      rangeInstanceId: instance.id, templateModulePath: instance.templateModulePathSnapshot ?? '',
      allocatedCidr: instance.allocatedCidr, runtimeConfig, reportStep,
    });
    await this.runWorkerStep(reportStep, 'verify_destroy', async () => { await this.verifyDestroyCompletion(instance, runtimeConfig); });
    await this.updateRangeForClaim(job, { status: 'destroyed', accessEntry: null, resourceSummary: null, errorSummary: null });
    await releaseRangeInstanceBillingLedger(this.adminRepository, instance.id, new Date());
    if (!(await this.adminRepository.updateRangeProvisionJob(job.id, job.startedAt!, {
      status: 'succeeded', finishedAt: new Date(), errorSummary: null,
    }))) return;
    await this.finalizeDispatchedOperation(job, 'succeeded');
    this.nextResourceReconciliationAt = 0;
  }

  private async processRangeInstanceUpdateJob(input: {
    job: ProvisionJobRecord;
    instance: RangeInstanceRecord;
    runtimeConfig: Awaited<ReturnType<SystemConfigService['getSnapshot']>>;
    reportStep: RangeProvisionStepReporter;
  }) {
    const topologySnapshot = this.readUpdateTopologySnapshot(input.job.topologySnapshot);

    if (!topologySnapshot) {
      throw new Error('Update job topology snapshot is missing or invalid');
    }

    await this.runWorkerStep(input.reportStep, 'prepare', async () => {
      await this.updateRangeForClaim(input.job, { errorSummary: null });
    });

    if (!(await this.ownsProvisionJobClaim(input.job))) {
      return;
    }
    if (topologySnapshot.operation) await this.assertRangeSnapshotImages(input.instance, topologySnapshot);
    const result = await this.rangeProvisioner.create({
      rangeInstanceId: input.instance.id,
      templateModulePath: topologySnapshot.templateModulePath,
      allocatedCidr: input.instance.allocatedCidr,
      preserveWorkspaceState: true,
      runtimeConfig: input.runtimeConfig,
      runtimeCredentials: topologySnapshot.runtimeCredentials ?? input.instance.runtimeCredentials ?? undefined,
      topologyGraph: topologySnapshot.topologyGraph,
      topologySpec: topologySnapshot.topologySpec as RangeTemplateTopologySpec,
      compiledProvisionSpec: topologySnapshot.compiledProvisionSpec,
      compiledSpec: topologySnapshot.compiledSpec as RangeTemplateCompiledSpec,
      billingTags: buildBillingTags({
        billingScope: input.instance.ownerUserId ? 'user' : 'platform',
        ownerUserId: input.instance.ownerUserId,
        rangeInstanceId: input.instance.id,
        singleInstanceBatchId: input.instance.singleInstanceBatchId ?? null,
        platformResourceType: 'range',
        billingStartAt: new Date(),
      }),
      reportStep: input.reportStep,
    });

    if (!(await this.ownsProvisionJobClaim(input.job))) {
      return;
    }
    await this.runWorkerStep(input.reportStep, 'persist_update_result', async () => {
      await this.adminRepository.completeRangeInstanceDraftApply(input.instance.id, {
        runtimeTopologyGraph: topologySnapshot.topologyGraph,
        runtimeScenarioTemplateSpec: topologySnapshot.scenarioTemplateSpec,
        runtimeCompiledProvisionSpec: topologySnapshot.compiledProvisionSpec,
        expectedDraftRevision: topologySnapshot.draftRevision,
        provisionJobId: input.job.id, claimStartedAt: input.job.startedAt!,
        runtimeCredentials: topologySnapshot.runtimeCredentials ?? input.instance.runtimeCredentials ?? null,
        accessEntry: result.accessEntry,
        resourceSummary: result.resourceSummary,
        errorSummary: null,
      });
      const accountContext = await this.resolveAccountContext();
      await syncRangeInstanceBillingLedger({
        repository: this.adminRepository,
        instance: input.instance,
        regionId: accountContext.defaultRegion,
        cloudAccountUid: accountContext.accountUid,
        resourceSummary: result.resourceSummary,
        sourceProvisionJobId: input.job.id,
        billingStartAt: new Date(),
      });
    });
  }

  private readUpdateTopologySnapshot(value: unknown): ProvisionJobTopologySnapshot | null {
    const snapshot = this.readJsonObject(value);

    if (!snapshot) {
      return null;
    }

    const draftRevision = snapshot.draftRevision;
    const topologyGraph = this.readJsonObject(snapshot.topologyGraph);
    const topologySpec = this.readJsonObject(snapshot.topologySpec);
    const scenarioTemplateSpec = this.readJsonObject(snapshot.scenarioTemplateSpec);
    const compiledProvisionSpec = this.readJsonObject(snapshot.compiledProvisionSpec);
    const compiledSpec = this.readJsonObject(snapshot.compiledSpec);
    const templateModulePath = typeof snapshot.templateModulePath === 'string'
      ? snapshot.templateModulePath.trim()
      : '';

    if (
      typeof draftRevision !== 'number' ||
      !Number.isInteger(draftRevision) ||
      draftRevision < 1 ||
      !topologyGraph ||
      !topologySpec ||
      !scenarioTemplateSpec ||
      !compiledProvisionSpec ||
      !compiledSpec ||
      !templateModulePath ||
      !Array.isArray(topologyGraph.nodes) ||
      !Array.isArray(topologyGraph.edges) ||
      typeof topologySpec.vpcCidr !== 'string' ||
      !Array.isArray(topologySpec.networkZones) ||
      !Array.isArray(topologySpec.hosts) ||
      !this.readJsonObject(topologySpec.publicEntry) ||
      !this.readJsonObject(scenarioTemplateSpec.metadata) ||
      !this.readJsonObject(scenarioTemplateSpec.topology) ||
      !Array.isArray(scenarioTemplateSpec.networkZones) ||
      !Array.isArray(scenarioTemplateSpec.hosts) ||
      !this.readJsonObject(compiledProvisionSpec.topology) ||
      !Array.isArray(compiledProvisionSpec.networkZones) ||
      !Array.isArray(compiledProvisionSpec.hosts) ||
      !Array.isArray(compiledSpec.resources) ||
      !this.readJsonObject(compiledSpec.topology)
    ) {
      return null;
    }

    return {
      draftRevision,
      topologyGraph,
      topologySpec,
      scenarioTemplateSpec,
      compiledProvisionSpec,
      compiledSpec,
      templateModulePath,
      ...(snapshot.runtimeCredentials ? { runtimeCredentials: snapshot.runtimeCredentials as ProvisionJobTopologySnapshot['runtimeCredentials'] } : {}),
      ...(snapshot.operation === 'update' ? { operation: 'update' as const } : {}),
    };
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

  private async resolveAccountContext() {
    const service = this.systemConfigService as SystemConfigService & {
      getAccountContext?: () => Promise<{
        provider: 'alibaba_cloud';
        defaultRegion: string;
        defaultZoneId: string;
        accessKeyId: string;
        accessKeySecret: string;
        accountUid: string | null;
        accountUidResolved: boolean;
      }>;
    };

    if (typeof service.getAccountContext === 'function') {
      return service.getAccountContext();
    }

    const snapshot = await this.systemConfigService.getSnapshot();

    return {
      ...snapshot,
      cloudAccountContextId: null,
      accountUid: null,
      accountUidResolved: false,
    };
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

    const batchLockId =
      job.jobType === 'refresh_status'
        ? `${instance.id}:refresh_status`
        : instance.singleInstanceBatchId ?? instance.id;

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

  private async processSingleInstanceJob(input: SingleInstanceJobInput) {
    if (!input.instance.singleInstanceConfig) {
      throw new Error('Single instance config missing');
    }

    if (input.effectiveJobType === 'update') {
      throw new Error('Single instance update jobs are not supported');
    }

    const items = await this.collectSingleInstanceExecutionItems(input);
    const heartbeat = this.startProvisionJobHeartbeat(items.filter((item) => item.job.id !== input.job.id).map((item) => item.job));

    try {
      await this.executeClaimedSingleInstanceJob(input, items);
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async executeClaimedSingleInstanceJob(input: SingleInstanceJobInput, items: SingleInstanceExecutionItem[]) {
    if (input.effectiveJobType === 'refresh_status') {
      const item = items[0];

      if (!item) {
        throw new Error('Single instance refresh job is missing its target item');
      }

      await this.singleInstanceBatchExecutionService.refreshSingleInstanceAccessEntry(item);

      const refreshedInstance = await this.adminRepository.getRangeInstanceById(item.instance.id);

      if (needsSingleInstancePublicIpRefresh(refreshedInstance)) await this.queueSingleInstanceRefresh(item);

      return;
    }

    if (input.effectiveJobType === 'create') {
      await this.runWorkerStep(input.reportStep, 'prepare', async () => {
        for (const item of items) {
          await this.adminRepository.commitSingleInstanceClaim(item.job, {status:'creating',errorSummary:null});
        }
      });

      await this.singleInstanceBatchExecutionService.executeCreateBatch(items);

      for (const item of items) {
        const refreshedInstance = await this.adminRepository.getRangeInstanceById(item.instance.id);

        if (!needsSingleInstancePublicIpRefresh(refreshedInstance)) {
          continue;
        }

        await this.queueSingleInstanceRefresh(item);
      }

      return;
    }

    await this.runWorkerStep(input.reportStep, 'prepare', async () => {
      for (const item of items) {
        await this.adminRepository.commitSingleInstanceClaim(item.job, {status:'destroying',errorSummary:null});
      }
    });

    await this.singleInstanceBatchExecutionService.executeDestroyBatch(items);
  }

  private async queueSingleInstanceRefresh(item: SingleInstanceExecutionItem) {
    await this.adminRepository.withSingleInstanceControlLock(async () => {
      const current = await this.adminRepository.getRangeInstanceById(item.instance.id);
      if (!needsSingleInstancePublicIpRefresh(current) || current?.lastJobId !== item.job.id) return;
      const previous = await this.adminRepository.getProvisionJobById(item.job.id);
      if (!previous || !['succeeded','failed'].includes(previous.status)) return;
      const job=await this.adminRepository.createProvisionJob({rangeInstanceId:item.instance.id,jobType:'refresh_status',triggeredBy:item.job.triggeredBy});
      await this.adminRepository.updateRangeInstance(item.instance.id,{lastJobId:job.id});
      this.dispatch(job.id);
    });
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
    const candidateInstances = group.instances.filter((instance) => instance.status === targetStatus
      && instance.ownerUserId === input.instance.ownerUserId
      && JSON.stringify([instance.singleInstanceConfig?.cloudAccountUid,instance.singleInstanceConfig?.cloudAccountContextId,instance.singleInstanceConfig?.regionId,instance.singleInstanceConfig?.networkProfileId])
        === JSON.stringify([input.instance.singleInstanceConfig?.cloudAccountUid,input.instance.singleInstanceConfig?.cloudAccountContextId,input.instance.singleInstanceConfig?.regionId,input.instance.singleInstanceConfig?.networkProfileId]));
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
      if (item.instance.id === input.instance.id || item.job.id === input.job.id) {
        continue;
      }

      const claimedJob = await this.adminRepository.claimProvisionJob(item.job.id, new Date());
      if (claimedJob) {
        itemsByInstanceId.set(item.instance.id, { ...item, job: claimedJob });
      }
    }

    return Array.from(itemsByInstanceId.values());
  }

  private resolveEffectiveJobType(job: ProvisionJobRecord, instance: RangeInstanceRecord) {
    if (job.jobType === 'retry') {
      if (job.topologySnapshot?.operation === 'create') return 'create' as const;
      if (instance.status === 'pending_create' || instance.status === 'create_failed' || instance.status === 'creating') {
        return 'create' as const;
      }

      if (instance.status === 'pending_destroy' || instance.status === 'destroy_failed' || instance.status === 'destroying' || instance.status === 'destroyed') {
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

    if (compiledSpec.topologySpec) {
      return compiledSpec.topologySpec;
    }

    const switchResources = compiledSpec.resources.filter((resource) => resource.type === 'switch');
    const hostResources = compiledSpec.resources.filter((resource) => resource.type === 'host');
    const vpcCidr = compiledSpec.topology?.vpcCidr;

    if (!vpcCidr || switchResources.length === 0 || hostResources.length === 0) {
      return null;
    }

    const publicEntryHostKey =
      compiledSpec.topology?.publicEntryHostKey ??
      hostResources.find((resource) => resource.config.exposePublic === true)?.id ??
      hostResources.find((resource) => resource.config.role === 'entry')?.id;

    if (!publicEntryHostKey) {
      return null;
    }

    const publicEntryHost = hostResources.find((resource) => resource.id === publicEntryHostKey);

    if (!publicEntryHost?.config.zoneKey) {
      return null;
    }

    return {
      vpcCidr,
      networkZones: switchResources.flatMap((resource) => {
        const zoneKey = typeof resource.config.zoneKey === 'string' ? resource.config.zoneKey : null;
        const name = typeof resource.config.label === 'string' ? resource.config.label : null;
        const cidr = typeof resource.config.cidr === 'string' ? resource.config.cidr : null;

        if (!zoneKey || !name || !cidr) {
          return [];
        }

        return [{
          key: zoneKey,
          name,
          purpose: typeof resource.config.purpose === 'string' ? resource.config.purpose : zoneKey,
          cidr,
          ...(zoneKey === publicEntryHost.config.zoneKey ? { isPublicEntry: true } : {}),
        }];
      }),
      hosts: hostResources.flatMap((resource) => {
        const zoneKey = typeof resource.config.zoneKey === 'string' ? resource.config.zoneKey : null;
        const role = typeof resource.config.role === 'string' ? resource.config.role : null;
        const privateIp = typeof resource.config.privateIp === 'string' ? resource.config.privateIp : null;

        if (!zoneKey || !role || !privateIp) {
          return [];
        }

        return [{
          key: resource.id,
          name: typeof resource.config.label === 'string' ? resource.config.label : resource.id,
          zoneKey,
          role,
          privateIp,
          ...(typeof resource.config.exposePublic === 'boolean'
            ? { exposePublic: resource.config.exposePublic }
            : {}),
        }];
      }),
      publicEntry: {
        hostKey: publicEntryHostKey,
        protocols: [{ protocol: 'ssh', port: 22 }],
      },
    };
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
          typeof host.role !== 'string'
        ) {
          return [];
        }

        const privateIp = this.readCompiledProvisionHostPrivateIp(host);

        if (!privateIp) {
          return [];
        }

        return [{
          key: host.key,
          name: host.name,
          zoneKey: host.zoneKey,
          role: host.role,
          privateIp,
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

  private readCompiledProvisionHostPrivateIp(host: Record<string, unknown>) {
    if (typeof host.primaryPrivateIp === 'string') {
      return host.primaryPrivateIp;
    }

    const primaryInterface = this.readJsonObject(this.readJsonArray(host.networkInterfaces)[0]);

    if (typeof primaryInterface?.privateIp === 'string') {
      return primaryInterface.privateIp;
    }

    return null;
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

  private async failJob(
    job: ProvisionJobRecord,
    instance: RangeInstanceRecord,
    message: string,
    failedInstanceStatus?: 'create_failed' | 'destroy_failed',
  ) {
    if (instance.instanceMode === 'range') {
      const current = await this.adminRepository.getRangeInstanceById(instance.id);
      const status = current?.status === 'destroy_failed' ? 'destroy_failed'
        : failedInstanceStatus ?? this.resolveFailedInstanceStatus(job, instance);
      if (!(await this.adminRepository.updateRangeInstanceForProvisionJob(job.id, job.startedAt!, { status, errorSummary: message }))) return;
      if (!(await this.adminRepository.updateRangeProvisionJob(job.id, job.startedAt!, {
        status: 'failed', finishedAt: new Date(), errorSummary: message,
      }))) return;
      await this.finalizeDispatchedOperation(job, 'failed', 'PROVISIONING_FAILED');
      return;
    }
    await this.adminRepository.updateProvisionJob(job.id, {
      status: 'failed',
      finishedAt: new Date(),
      errorSummary: message,
    });

    const currentInstance = await this.adminRepository.getRangeInstanceById(instance.id);
    const resolvedFailedInstanceStatus = currentInstance?.status === 'destroy_failed'
      ? 'destroy_failed'
      : failedInstanceStatus ?? this.resolveFailedInstanceStatus(job, instance);

    await this.adminRepository.updateRangeInstance(instance.id, {
      status: resolvedFailedInstanceStatus,
      errorSummary: message,
    });
    await this.finalizeDispatchedOperation(job, 'failed', 'PROVISIONING_FAILED');
  }

  private async cleanupFailedRangeCreate(input: {
    instance: RangeInstanceRecord;
    job: ProvisionJobRecord;
    cloudContext: { id: string; accountUid: string; regionId: string } | null;
    cleanupInput: RangeProvisionDestroyInput;
    reportStep: RangeProvisionStepReporter;
  }) {
    try {
      await this.runWorkerStep(input.reportStep, 'cleanup_failed_create_resources', async () => {
        if (!(await this.ownsProvisionJobClaim(input.job))) throw new Error('Range operation claim is no longer active');
        await this.rangeProvisioner.destroy({
          ...input.cleanupInput,
          reportStep: undefined,
        });
      });
      await this.updateRangeForClaim(input.job, {
        accessEntry: null,
        resourceSummary: null,
      });
      await releaseRangeInstanceBillingLedger(this.adminRepository, input.instance.id, new Date());
      if (input.cloudContext && input.job.startedAt) {
        const verifiedAt = new Date();
        const proof: FailedCreateCleanupProof = {
          version: 1, rangeInstanceId: input.instance.id, provisionJobId: input.job.id,
          claimStartedAt: input.job.startedAt.toISOString(), cloudAccountContextId: input.cloudContext.id,
          cloudAccountUid: input.cloudContext.accountUid, regionId: input.cloudContext.regionId,
        };
        await this.adminRepository.createProvisionJobStepLog({
          jobId: input.job.id, stepName: FAILED_CREATE_CLEANUP_PROOF_STEP, status: 'succeeded',
          message: JSON.stringify(proof), startedAt: verifiedAt, finishedAt: verifiedAt,
          stdoutExcerpt: null, stderrExcerpt: null,
        });
      }
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : 'Unknown automatic cleanup failure';
    }
  }

  private async finalizeDispatchedOperation(
    job: ProvisionJobRecord,
    status: 'succeeded' | 'failed',
    errorCode: string | null = null,
  ) {
    const event = await this.adminRepository.getDispatchedOperationByJobId(job.id);
    if (!event) {
      return;
    }

    const operation = await this.adminRepository.getIdempotentOperationByOperationId(event.operationId);
    if (operation) {
      await this.adminRepository.updateIdempotentOperation(operation.id, {
        status,
        errorCode,
        ...(status === 'succeeded' ? { result: { jobId: job.id, rangeInstanceId: job.rangeInstanceId } } : {}),
      });
    }

    await this.adminRepository.appendOperationAuditEvent({
      operationId: event.operationId,
      requestId: event.requestId,
      actorUserId: event.actorUserId,
      source: event.source,
      oauthClientId: event.oauthClientId,
      toolName: event.toolName,
      phase: status,
      targetType: event.targetType,
      targetId: event.targetId,
      jobId: job.id,
      errorCode,
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

function readInterruptedJobStaleAfterMs() {
  const configuredValue = Number(
    process.env.PROVISIONING_WORKER_INTERRUPTED_JOB_STALE_AFTER_MS ?? DEFAULT_INTERRUPTED_JOB_STALE_AFTER_MS,
  );

  return Number.isFinite(configuredValue) && configuredValue > 0
    ? configuredValue
    : DEFAULT_INTERRUPTED_JOB_STALE_AFTER_MS;
}

function readPlatformResourceReconciliationIntervalMs() {
  const configuredValue = Number(
    process.env.PLATFORM_RESOURCE_RECONCILIATION_INTERVAL_MS ?? DEFAULT_PLATFORM_RESOURCE_RECONCILIATION_INTERVAL_MS,
  );

  return Number.isFinite(configuredValue) && configuredValue > 0
    ? configuredValue
    : DEFAULT_PLATFORM_RESOURCE_RECONCILIATION_INTERVAL_MS;
}

function needsSingleInstancePublicIpRefresh(instance: RangeInstanceRecord | null) {
  return Boolean(
    instance &&
      instance.instanceMode === 'single' &&
      (instance.status === 'creating' || instance.status === 'running') &&
      instance.resourceSummary?.mode === 'ecs-native' &&
      instance.resourceSummary?.hostIds &&
      (instance.status === 'creating' || !instance.accessEntry?.publicIp),
  );
}

function appendCleanupFailureMessage(createFailureMessage: string, cleanupFailureMessage: string | null) {
  return cleanupFailureMessage
    ? `${createFailureMessage}\nAutomatic cleanup failed: ${cleanupFailureMessage}`
    : createFailureMessage;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
