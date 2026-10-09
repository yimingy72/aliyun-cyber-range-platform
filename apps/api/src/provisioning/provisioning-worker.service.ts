import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

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
import { SingleInstanceOpenTofuExecutionService, type SingleInstanceOpenTofuBatchLease } from '../admin/single-instance-opentofu-execution.service';
import { FAILED_CREATE_CLEANUP_PROOF_STEP, readFailedCreateCleanupProof, type FailedCreateCleanupProof } from '../admin/failed-create-cleanup-evidence';
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
const SINGLE_INSTANCE_REFRESH_DELAY_MS = 2_000;
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
  batchLease?: SingleInstanceOpenTofuBatchLease;
};
type SingleInstanceExecutionItem = { instance: RangeInstanceRecord; job: ProvisionJobRecord };

@Injectable()
export class ProvisioningWorkerService {
  private readonly logger = new Logger(ProvisioningWorkerService.name);
  private readonly activeSingleBatchIds = new Set<string>();
  private readonly activeRangeInstanceIds = new Set<string>();
  private readonly activeTasks = new Set<Promise<void>>();
  private readonly failedTaskRetryAfter = new Map<string, number>();
  private readonly rangeConcurrency = readWorkerConcurrency('PROVISIONING_WORKER_RANGE_CONCURRENCY', 2);
  private readonly singleBatchConcurrency = readWorkerConcurrency('PROVISIONING_WORKER_SINGLE_BATCH_CONCURRENCY', 3);
  private readonly singleInstanceBatchExecutionService: SingleInstanceBatchExecutionService;
  private readonly singleInstanceOpenTofuExecutionService: SingleInstanceOpenTofuExecutionService;
  private readonly platformResourceReconciliationService: PlatformResourceReconciliationService;
  private nextResourceReconciliationAt = 0;

  constructor(
    @Inject(ADMIN_REPOSITORY) private readonly adminRepository: AdminRepository,
    @Inject(RANGE_PROVISIONER) private readonly rangeProvisioner: RangeProvisioner,
    private readonly systemConfigService: SystemConfigService,
    singleInstanceBatchExecutionService?: SingleInstanceBatchExecutionService,
    platformResourceReconciliationService?: PlatformResourceReconciliationService,
    @Optional() singleInstanceOpenTofuExecutionService?: SingleInstanceOpenTofuExecutionService,
  ) {
    this.singleInstanceBatchExecutionService =
      singleInstanceBatchExecutionService ??
      new SingleInstanceBatchExecutionService(this.adminRepository, this.systemConfigService);
    this.singleInstanceOpenTofuExecutionService = singleInstanceOpenTofuExecutionService
      ?? new SingleInstanceOpenTofuExecutionService(this.adminRepository, this.systemConfigService, this.singleInstanceBatchExecutionService);
    this.platformResourceReconciliationService =
      platformResourceReconciliationService ??
      new PlatformResourceReconciliationService(
        this.adminRepository,
        new AliyunEcsResourceClient(this.systemConfigService),
      );
  }

  dispatch(jobId: string) {
    void this.dispatchSingleInstanceJob(jobId).catch(() => {
      this.logger.error('Provision job dispatch failed; pending jobs remain available to the worker.');
    });
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
    const instances = await this.adminRepository.listExpiredRangeInstances(now);

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
    const pendingJob = await this.adminRepository.getProvisionJobById(jobId);
    const instance = pendingJob ? await this.adminRepository.getRangeInstanceById(pendingJob.rangeInstanceId) : null;
    if (instance?.instanceMode === 'single' && instance.singleInstanceConfig?.executionBackend === 'opentofu'
      && pendingJob?.jobType !== 'refresh_status') {
      const batchId = instance.singleInstanceBatchId;
      if (!batchId) throw new Error('OpenTofu single-instance job has no batch identity');
      const result = await this.adminRepository.tryWithSingleInstanceBatchProvisionLock(batchId, async lease => {
        await this.processPendingJob(jobId, instance, { batchId, assertCurrent: () => lease.assertHeld(), signal: lease.signal });
      });
      if (!result.acquired) this.failedTaskRetryAfter.set(`single-batch:${batchId}`, Date.now() + readWorkerPollIntervalMs());
      return;
    }
    await this.processPendingJob(jobId, instance);
  }

  private async processPendingJob(jobId: string, instance: RangeInstanceRecord | null, batchLease?: SingleInstanceOpenTofuBatchLease) {
    await batchLease?.assertCurrent();
    const claimedAt = new Date();
    const job = instance?.instanceMode === 'range'
      ? await this.adminRepository.claimRangeProvisionJob(jobId, claimedAt)
      : await this.adminRepository.claimProvisionJob(jobId, claimedAt);
    if (!job) return;
    const controller = new AbortController();
    const heartbeat = this.startProvisionJobHeartbeat([job], controller);
    try {
      await this.processClaimedJob(job, batchLease, controller.signal);
    } finally {
      clearInterval(heartbeat);
    }
  }

  private startProvisionJobHeartbeat(jobs: ProvisionJobRecord[], controller?: AbortController) {
    const heartbeat = setInterval(() => {
      for (const job of jobs) {
        void this.ownsProvisionJobClaim(job).then(owned => { if (!owned) controller?.abort(new Error('Provision job claim was lost')); });
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

  private async processClaimedJob(job: ProvisionJobRecord, batchLease?: SingleInstanceOpenTofuBatchLease, signal?: AbortSignal) {
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
    let rangeApplyStarted = false;
    let failedCreateCleanupInput: RangeProvisionDestroyInput | null = null;
    let failedCreateCleanupContext: { id: string; accountUid: string; regionId: string } | null = null;

    try {
      const effectiveJobType = this.resolveEffectiveJobType(job, instance);
      const rangeContext = instance.instanceMode === 'range' ? await this.resolveRangeAccountContext(instance, job) : null;
      const runtimeConfig = rangeContext ?? await this.systemConfigService.getSnapshot();

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
          batchLease,
        });
        this.nextResourceReconciliationAt = 0;
        return;
      }

      if (effectiveJobType === 'update') {
        await this.processRangeInstanceUpdateJob({
          job,
          instance,
          runtimeConfig,
          accountContext: rangeContext!,
          onApplyStart: () => { rangeApplyStarted = true; },
          signal,
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
        await this.processRangeDestroyJob(job, instance, rangeContext!, reportStep, signal);
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
      const accountContext = rangeContext!;

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
          billingTags: { ...billingTags, ...(accountContext.cloudAccountContextId ? { CloudAccountContextId: accountContext.cloudAccountContextId, CloudAccountUid: accountContext.accountUid!, ExecutionBackend: 'opentofu' } : {}) },
          requirePersistedState: await this.rangeHasApplyEvidence(instance, job),
          signal,
        };
        if (!(await this.ownsProvisionJobClaim(job))) {
          return;
        }
        if (frozen) await this.assertRangeSnapshotImages(instance, frozen);
        const result = await this.rangeProvisioner.create({
          ...failedCreateCleanupInput,
          preserveWorkspaceState: job.jobType === 'retry' || job.retryCount > 0,
          onApplyStart: async () => {
            await this.recordRangeApplyStart(instance, job, accountContext, signal);
            failedCreateCleanupInput!.requirePersistedState = true;
          },
          reportStep,
        });

        if (!(await this.ownsProvisionJobClaim(job))) {
          return;
        }

        await this.runWorkerStep(reportStep, 'persist_access_entry', async () => {
          const current = await this.adminRepository.getRangeInstanceById(instance.id);
          const resourceSummary = { ...result.resourceSummary, creationAttempted: current?.resourceSummary?.creationAttempted, executionContext: current?.resourceSummary?.executionContext };
          await this.updateRangeForClaim(job, {
            status: 'creating',
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
            resourceSummary,
            errorSummary: null,
          });
          await this.recordRangeResourceInventory(job, resourceSummary);
          await syncRangeInstanceBillingLedger({
            repository: this.adminRepository,
            instance,
            regionId: accountContext.defaultRegion,
            cloudAccountUid: accountContext.accountUid,
            resourceSummary,
            sourceProvisionJobId: job.id,
            billingStartAt: instance.createdAt,
          });
          await this.updateRangeForClaim(job, { status: 'running' });
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
      const current = await this.adminRepository.getRangeInstanceById(instance.id);
      if (instance.instanceMode === 'single' && (instance.singleInstanceConfig?.executionBackend === 'opentofu'
        || current?.singleInstanceConfig?.nativeCreateJobId || current?.singleInstanceConfig?.opentofuCreateJobId)) {
        await this.adminRepository.commitSingleInstanceClaim(job, {
          status: 'destroy_failed', errorSummary: 'Instance execution was interrupted after cloud creation may have started; recovery is required before retry',
        }, { status: 'failed', finishedAt: new Date(), errorSummary: 'Instance execution requires state recovery' });
        return;
      }
      if (instance.instanceMode === 'range' && job.jobType === 'update' && rangeApplyStarted && current?.resourceSummary?.executionContext) {
        try {
          const context = await this.resolveRangeAccountContext(current, job);
          await this.captureRangeResources(job, current, { rangeInstanceId: current.id,
            templateModulePath: current.templateModulePathSnapshot ?? '', allocatedCidr: current.allocatedCidr,
            runtimeConfig: context, requirePersistedState: true, signal }, context);
        } catch (captureError) {
          this.logger.error(`Range update inventory needs recovery: ${captureError instanceof Error ? captureError.message : 'unknown error'}`);
        }
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

      const needsRecovery = cleanupFailureMessage || (job.jobType === 'update' ? rangeApplyStarted
        : !failedCreateCleanupInput && (current?.resourceSummary?.creationAttempted || current?.resourceSummary?.mode === 'opentofu'));
      await this.failJob(job, instance, message, needsRecovery ? 'destroy_failed' : undefined);
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
    accountContext: Awaited<ReturnType<ProvisioningWorkerService['resolveAccountContext']>>, reportStep: RangeProvisionStepReporter, signal?: AbortSignal) {
    if (!(await this.ownsProvisionJobClaim(job))) return;
    await this.runWorkerStep(reportStep, 'prepare', async () => { await this.updateRangeForClaim(job, { status: 'destroying' }); });
    const cleanupInput: RangeProvisionDestroyInput = {
      rangeInstanceId: instance.id, templateModulePath: instance.templateModulePathSnapshot ?? '',
      allocatedCidr: instance.allocatedCidr, runtimeConfig: accountContext, reportStep, signal,
      requirePersistedState: await this.rangeHasApplyEvidence(instance, job),
      billingTags: accountContext.cloudAccountContextId ? { CloudAccountContextId: accountContext.cloudAccountContextId, CloudAccountUid: accountContext.accountUid! } : undefined,
    };
    const evidence = await this.captureRangeResources(job, instance, cleanupInput, accountContext);
    await this.rangeProvisioner.destroy(cleanupInput);
    await this.runWorkerStep(reportStep, 'verify_destroy', async () => { await this.verifyDestroyCompletion(evidence, accountContext); });
    if (!(await this.ownsProvisionJobClaim(job))) return;
    await releaseRangeInstanceBillingLedger(this.adminRepository, instance.id, new Date());
    await this.updateRangeForClaim(job, { status: 'destroyed', accessEntry: null, resourceSummary: null, errorSummary: null });
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
    accountContext: Awaited<ReturnType<ProvisioningWorkerService['resolveAccountContext']>>;
    onApplyStart: () => void;
    signal?: AbortSignal;
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
      requirePersistedState: true,
      signal: input.signal,
      onApplyStart: async () => { await this.recordRangeApplyStart(input.instance, input.job, input.accountContext, input.signal); input.onApplyStart(); },
      runtimeConfig: input.runtimeConfig,
      runtimeCredentials: topologySnapshot.runtimeCredentials ?? input.instance.runtimeCredentials ?? undefined,
      topologyGraph: topologySnapshot.topologyGraph,
      topologySpec: topologySnapshot.topologySpec as RangeTemplateTopologySpec,
      compiledProvisionSpec: topologySnapshot.compiledProvisionSpec,
      compiledSpec: topologySnapshot.compiledSpec as RangeTemplateCompiledSpec,
      billingTags: { CloudAccountContextId: input.accountContext.cloudAccountContextId!, CloudAccountUid: input.accountContext.accountUid!, ExecutionBackend: 'opentofu', ...buildBillingTags({
        billingScope: input.instance.ownerUserId ? 'user' : 'platform',
        ownerUserId: input.instance.ownerUserId,
        rangeInstanceId: input.instance.id,
        singleInstanceBatchId: input.instance.singleInstanceBatchId ?? null,
        platformResourceType: 'range',
        billingStartAt: new Date(),
      }) },
      reportStep: input.reportStep,
    });

    if (!(await this.ownsProvisionJobClaim(input.job))) {
      return;
    }
    await this.runWorkerStep(input.reportStep, 'persist_update_result', async () => {
      const current = await this.adminRepository.getRangeInstanceById(input.instance.id);
      const resourceSummary = { ...result.resourceSummary, creationAttempted: current?.resourceSummary?.creationAttempted, executionContext: current?.resourceSummary?.executionContext };
      await this.updateRangeForClaim(input.job, { resourceSummary });
      await this.recordRangeResourceInventory(input.job, resourceSummary);
      await syncRangeInstanceBillingLedger({ repository: this.adminRepository, instance: input.instance, regionId: input.accountContext.defaultRegion, cloudAccountUid: input.accountContext.accountUid, resourceSummary, sourceProvisionJobId: input.job.id, billingStartAt: input.instance.createdAt });
      await this.adminRepository.completeRangeInstanceDraftApply(input.instance.id, {
        runtimeTopologyGraph: topologySnapshot.topologyGraph,
        runtimeScenarioTemplateSpec: topologySnapshot.scenarioTemplateSpec,
        runtimeCompiledProvisionSpec: topologySnapshot.compiledProvisionSpec,
        expectedDraftRevision: topologySnapshot.draftRevision,
        provisionJobId: input.job.id, claimStartedAt: input.job.startedAt!,
        runtimeCredentials: topologySnapshot.runtimeCredentials ?? input.instance.runtimeCredentials ?? null,
        accessEntry: result.accessEntry,
        resourceSummary,
        errorSummary: null,
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
    this.clearExpiredTaskFailures();
    let started = 0;
    let after: { createdAt: Date; id: string } | undefined;
    const now = new Date();
    while (this.activeRangeInstanceIds.size < this.rangeConcurrency || this.activeSingleBatchIds.size < this.singleBatchConcurrency) {
      const pendingJobs = await this.adminRepository.listPendingProvisionJobs({ limit: 100, now, after });
      if (!pendingJobs.length) break;
      const instances = await this.adminRepository.listProvisioningInstancesByIds([...new Set(pendingJobs.map(job => job.rangeInstanceId))]);
      const instancesById = new Map(instances.map(instance => [instance.id, instance]));
      for (const job of pendingJobs) {
        if (this.failedTaskRetryAfter.has(job.id)) continue;
        const instance = instancesById.get(job.rangeInstanceId);
        if (!instance) continue;
        if (instance.instanceMode === 'single') {
          if (this.startSingleInstanceJob(job, instance.singleInstanceBatchId ?? instance.id)) started += 1;
          continue;
        }
        if (this.activeRangeInstanceIds.size >= this.rangeConcurrency || this.activeRangeInstanceIds.has(instance.id)) continue;
        this.activeRangeInstanceIds.add(instance.id);
        started += 1;
        this.trackTask(this.process(job.id).finally(() => this.activeRangeInstanceIds.delete(instance.id)), job.id);
      }
      const last = pendingJobs[pendingJobs.length - 1];
      after = { createdAt: last.createdAt, id: last.id };
      if (pendingJobs.length < 100) break;
    }
    return started;
  }

  private async rangeHasApplyEvidence(instance: RangeInstanceRecord, job: ProvisionJobRecord) {
    if (instance.resourceSummary?.mode === 'dry-run') return false;
    if (instance.resourceSummary?.creationAttempted || this.rangeSummaryHasIds(instance.resourceSummary)) return true;
    const jobs = (await this.adminRepository.listProvisionJobs()).filter(value => value.rangeInstanceId === instance.id);
    for (const previous of jobs) {
      const logs = await this.adminRepository.listProvisionJobStepLogs(previous.id);
      const cleanup = logs.find(log => { const proof = readFailedCreateCleanupProof(log.message);
        return log.stepName === FAILED_CREATE_CLEANUP_PROOF_STEP && log.status === 'succeeded'
          && proof?.rangeInstanceId === instance.id && proof.provisionJobId === previous.id
          && proof.claimStartedAt === previous.startedAt?.toISOString(); });
      if (!cleanup && logs.some(log => log.stepName === 'tofu_apply' && !log.message?.startsWith('Dry-run'))) return true;
    }
    return false;
  }

  private rangeSummaryHasIds(summary: RangeResourceSummary | null) {
    return Boolean(summary && (summary.vpcId || summary.eipAllocationId
      || ['hostIds','systemDiskIds','subnetIds','networkAclIds','securityGroupIds','secondaryNetworkInterfaceIds','natGatewayIds','snatEntryIds','dnatEntryIds','eipAllocationIds']
        .some(field => Object.values((summary as any)[field] ?? {}).some(Boolean))));
  }

  private async resolveRangeAccountContext(instance: RangeInstanceRecord, job: ProvisionJobRecord) {
    const bound = instance.resourceSummary?.executionContext;
    if (this.rangeProvisioner.mode === 'dry-run') {
      if (instance.resourceSummary?.creationAttempted || bound || (instance.resourceSummary?.mode !== 'dry-run' && this.rangeSummaryHasIds(instance.resourceSummary)))
        throw new Error('Dry-run cannot operate on a range with real cloud creation evidence');
      return this.resolveAccountContext();
    }
    if (bound) {
      const service = this.systemConfigService;
      const context = typeof service.getAccountContextById === 'function'
        ? await service.getAccountContextById(bound.cloudAccountContextId) : await this.resolveAccountContext();
      if (!context.accountUidResolved || context.accountUid !== bound.cloudAccountUid || context.cloudAccountContextId !== bound.cloudAccountContextId
        || context.defaultRegion !== bound.regionId || context.defaultZoneId !== bound.zoneId)
        throw new Error('Range execution account no longer matches its frozen cloud identity');
      return context;
    }
    if (await this.rangeHasApplyEvidence(instance, job) || ['destroy','update'].includes(this.resolveEffectiveJobType(job, instance)))
      throw new Error('Range has no verified source account binding; manual resource recovery is required');
    const context = await this.resolveAccountContext();
    if (!context.accountUidResolved || !context.accountUid || !context.cloudAccountContextId
      || !context.accessKeyId || !context.accessKeySecret || !context.defaultRegion || !context.defaultZoneId)
      throw new Error('A verified cloud account context is required before range provisioning');
    await this.updateRangeForClaim(job, { resourceSummary: { mode: 'opentofu', creationAttempted: false,
      executionContext: { cloudAccountContextId: context.cloudAccountContextId, cloudAccountUid: context.accountUid,
        regionId: context.defaultRegion, zoneId: context.defaultZoneId } } });
    return context;
  }

  private async recordRangeApplyStart(instance: RangeInstanceRecord, job: ProvisionJobRecord,
    context: Awaited<ReturnType<ProvisioningWorkerService['resolveAccountContext']>>, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (!(await this.ownsProvisionJobClaim(job))) throw new Error('Range operation claim is no longer active');
    const current = await this.adminRepository.getRangeInstanceById(instance.id);
    if (!current || current.expiresAt && current.expiresAt <= new Date()) throw new Error('Range expired before cloud creation started');
    if (!context.cloudAccountContextId || !context.accountUid) throw new Error('Range execution account is not verified');
    await this.updateRangeForClaim(job, { resourceSummary: { ...current.resourceSummary, mode: 'opentofu', creationAttempted: true,
      executionContext: { cloudAccountContextId: context.cloudAccountContextId, cloudAccountUid: context.accountUid,
        regionId: context.defaultRegion, zoneId: context.defaultZoneId } } });
    signal?.throwIfAborted();
  }

  private async recordRangeResourceInventory(job: ProvisionJobRecord, summary: RangeResourceSummary) {
    const inventory = Object.fromEntries(['vpcId','subnetIds','networkAclIds','securityGroupIds','hostIds','systemDiskIds',
      'secondaryNetworkInterfaceIds','natGatewayIds','snatEntryIds','dnatEntryIds','eipAllocationId','eipAllocationIds']
      .filter(key => (summary as any)[key] != null).map(key => [key, (summary as any)[key]]));
    const now = new Date();
    await this.adminRepository.createProvisionJobStepLog({ jobId: job.id, stepName: 'range_resource_inventory', status: 'succeeded',
      message: JSON.stringify({ version: 1, rangeInstanceId: job.rangeInstanceId, executionContext: summary.executionContext, resources: inventory }),
      startedAt: now, finishedAt: now, stdoutExcerpt: null, stderrExcerpt: null });
  }

  private async captureRangeResources(job: ProvisionJobRecord, instance: RangeInstanceRecord,
    input: RangeProvisionDestroyInput, context: { defaultRegion: string; accountUid: string | null }) {
    input.signal?.throwIfAborted();
    if (!(await this.ownsProvisionJobClaim(job))) throw new Error('Range operation claim is no longer active');
    const current = await this.adminRepository.getRangeInstanceById(instance.id) ?? instance;
    if (this.rangeProvisioner.mode === 'dry-run') return current;
    if (!this.rangeProvisioner.inspectResources) throw new Error('Range provider cannot inspect persisted resource identities before cleanup');
    const bound = current.resourceSummary?.executionContext;
    const inspectedInput = { ...input, billingTags: { ...input.billingTags, ...(bound ? { CloudAccountContextId: bound.cloudAccountContextId, CloudAccountUid: bound.cloudAccountUid } : {}) } };
    const observed = await this.rangeProvisioner.inspectResources(inspectedInput);
    if (!observed && input.requirePersistedState) throw new Error('Range persisted state is missing; cleanup cannot be proven');
    const summary: RangeResourceSummary = { ...current.resourceSummary, mode: 'opentofu' };
    if (observed) for (const [field, value] of Object.entries(observed)) {
      if (field.endsWith('Ids') && value && typeof value === 'object') {
        const merged = { ...((summary as any)[field] ?? {}) };
        for (const [key,id] of Object.entries(value)) merged[merged[key] && merged[key] !== id ? `observed:${key}` : key] = id;
        (summary as any)[field] = merged;
      } else if (field === 'vpcId' || field === 'eipAllocationId') {
        if ((summary as any)[field] && (summary as any)[field] !== value) throw new Error('Range state resource identity conflicts with persisted inventory');
        (summary as any)[field] = value;
      }
    }
    const persisted = await this.updateRangeForClaim(job, { resourceSummary: summary });
    await this.recordRangeResourceInventory(job, summary);
    await syncRangeInstanceBillingLedger({ repository: this.adminRepository, instance: persisted,
      resourceSummary: summary, regionId: context.defaultRegion, cloudAccountUid: context.accountUid,
      sourceProvisionJobId: job.id, billingStartAt: instance.createdAt });
    return persisted;
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

  private trackTask(task: Promise<void>, jobId: string) {
    const tracked = task.catch(() => {
      this.failedTaskRetryAfter.set(jobId, Date.now() + readWorkerPollIntervalMs());
      this.logger.error(`Provisioning task ${jobId} failed; its job state remains available for recovery.`);
    });
    this.activeTasks.add(tracked);
    void tracked.then(() => {
      this.activeTasks.delete(tracked);
    });
  }

  private clearExpiredTaskFailures() {
    const now = Date.now();
    for (const [id, retryAfter] of this.failedTaskRetryAfter) {
      if (retryAfter <= now) this.failedTaskRetryAfter.delete(id);
    }
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

    this.startSingleInstanceJob(job, batchLockId);
  }

  private startSingleInstanceJob(job: Pick<ProvisionJobRecord, 'id'>, batchLockId: string) {
    this.clearExpiredTaskFailures();
    if ((this.failedTaskRetryAfter.get(job.id) ?? 0) > Date.now()
      || (this.failedTaskRetryAfter.get(`single-batch:${batchLockId}`) ?? 0) > Date.now()) return false;
    if (this.activeSingleBatchIds.size >= this.singleBatchConcurrency || this.activeSingleBatchIds.has(batchLockId)) {
      return false;
    }

    this.activeSingleBatchIds.add(batchLockId);
    this.trackTask(
      this.process(job.id).finally(() => {
        this.activeSingleBatchIds.delete(batchLockId);
      }), job.id,
    );
    return true;
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

      if (input.instance.singleInstanceConfig?.executionBackend === 'opentofu') {
        if (!input.batchLease) throw new Error('OpenTofu single-instance execution requires its batch lease');
        await this.singleInstanceOpenTofuExecutionService.executeCreateBatch(items, input.batchLease);
      } else {
        await this.singleInstanceBatchExecutionService.executeCreateBatch(items);
      }

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

    if (input.instance.singleInstanceConfig?.executionBackend === 'opentofu') {
      if (!input.batchLease) throw new Error('OpenTofu single-instance execution requires its batch lease');
      await this.singleInstanceOpenTofuExecutionService.executeDestroyBatch(items, input.batchLease);
    } else {
      await this.singleInstanceBatchExecutionService.executeDestroyBatch(items);
    }
  }

  private async queueSingleInstanceRefresh(item: SingleInstanceExecutionItem) {
    await this.adminRepository.withSingleInstanceControlLock(async () => {
      const current = await this.adminRepository.getRangeInstanceById(item.instance.id);
      if (!needsSingleInstancePublicIpRefresh(current) || current?.lastJobId !== item.job.id
        || current.expiresAt && current.expiresAt <= new Date()) return;
      const previous = await this.adminRepository.getProvisionJobById(item.job.id);
      if (!previous || !['succeeded','failed'].includes(previous.status)) return;
      const job=await this.adminRepository.createProvisionJob({rangeInstanceId:item.instance.id,jobType:'refresh_status',triggeredBy:item.job.triggeredBy,availableAt:new Date(Date.now()+SINGLE_INSTANCE_REFRESH_DELAY_MS)});
      await this.adminRepository.updateRangeInstance(item.instance.id,{lastJobId:job.id});
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

    const group = await this.adminRepository.getSingleInstanceBatchWithInstancesById(batchId);

    if (!group) {
      return [currentItem];
    }

    const targetStatus = input.effectiveJobType === 'create' ? 'pending_create' : 'pending_destroy';
    const candidateInstances = group.instances.filter((instance) => (instance.status === targetStatus
      || input.instance.singleInstanceConfig?.executionBackend === 'opentofu' && input.effectiveJobType === 'create' && ['creating', 'running'].includes(instance.status))
      && instance.ownerUserId === input.instance.ownerUserId
      && JSON.stringify([instance.singleInstanceConfig?.cloudAccountUid,instance.singleInstanceConfig?.cloudAccountContextId,instance.singleInstanceConfig?.regionId,instance.singleInstanceConfig?.networkProfileId,instance.singleInstanceConfig?.executionBackend])
        === JSON.stringify([input.instance.singleInstanceConfig?.cloudAccountUid,input.instance.singleInstanceConfig?.cloudAccountContextId,input.instance.singleInstanceConfig?.regionId,input.instance.singleInstanceConfig?.networkProfileId,input.instance.singleInstanceConfig?.executionBackend]));
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

      if (!job || job.rangeInstanceId !== instance.id || job.status !== 'pending'
        || this.resolveEffectiveJobType(job, instance) !== input.effectiveJobType) {
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
      if (job.topologySnapshot?.operation === 'destroy') return 'destroy' as const;
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
    if (!resourceSummary || resourceSummary.mode === 'dry-run') {
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

    const checks: Array<() => Promise<string[]>> = [];
    {
      for (const subnetId of new Set(Object.values(resourceSummary.subnetIds ?? {}).filter(Boolean))) {
        checks.push(async () => await this.checkVSwitchExists(subnetId, runtimeConfig, regionId, vpcId ?? undefined) ? [`vswitch:${subnetId}`] : []);
      }
    }
    checks.push(async () => (await this.findExistingInstanceIds(Object.values(resourceSummary.hostIds ?? {}).filter(Boolean), runtimeConfig, regionId))
      .map(id => `instance:${id}`));
    checks.push(async () => (await this.findExistingDiskIds(Object.values(resourceSummary.systemDiskIds ?? {}).filter(Boolean), runtimeConfig, regionId)).map(id => `disk:${id}`));
    for (const id of new Set(Object.values(resourceSummary.secondaryNetworkInterfaceIds ?? {}).filter(Boolean))) {
      checks.push(async () => await this.checkNetworkInterfaceExists(id, runtimeConfig, regionId) ? [`eni:${id}`] : []);
    }
    for (const id of new Set(Object.values(resourceSummary.natGatewayIds ?? {}).filter(Boolean))) {
      checks.push(async () => await this.checkNatGatewayExists(id, runtimeConfig, regionId) ? [`nat:${id}`] : []);
    }
    const eipIds = new Set([resourceSummary.eipAllocationId, ...Object.values(resourceSummary.eipAllocationIds ?? {})].filter((id): id is string => Boolean(id)));
    for (const id of eipIds) {
      checks.push(async () => await this.checkEipExists(id, runtimeConfig, regionId) ? [`eip:${id}`] : []);
    }
    const results: string[][] = new Array(checks.length);
    let index = 0;
    const outcomes = await Promise.allSettled(Array.from({ length: Math.min(4, checks.length) }, async () => {
      while (index < checks.length) {
        const current = index++;
        results[current] = await checks[current]();
      }
    }));
    const failed = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
    if (failed) throw failed.reason;
    residualResources.push(...results.flat());

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

    const ids = [...new Set(instanceIds)];
    const existing: string[] = [];
    for (let offset = 0; offset < ids.length; offset += 100) {
      const requested = ids.slice(offset, offset + 100);
      const payload = await this.performAliyunRpcRequest<{
        TotalCount?: number;
        Instances?: { Instance?: Array<{ InstanceId?: string }> | { InstanceId?: string } };
      }>({
        endpoint: `ecs.${regionId}.aliyuncs.com`, version: ALICLOUD_ECS_API_VERSION, action: 'DescribeInstances',
        accessKeyId: runtimeConfig.accessKeyId, accessKeySecret: runtimeConfig.accessKeySecret,
        parameters: { RegionId: regionId, InstanceIds: JSON.stringify(requested), PageSize: '100', PageNumber: '1' },
      });
      const rows = this.readVerificationPage(payload, payload.Instances?.Instance, 'InstanceId', requested);
      existing.push(...rows.map(row => row.InstanceId!));
    }
    return existing;
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
        VpcId: vpcId, PageSize: '100', PageNumber: '1',
      },
    });

    return this.readVerificationPage(payload, payload.Vpcs?.Vpc, 'VpcId', [vpcId]).length > 0;
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
        VSwitchId: vSwitchId, PageSize: '100', PageNumber: '1',
      },
    });

    return this.readVerificationPage(payload, payload.VSwitches?.VSwitch, 'VSwitchId', [vSwitchId]).length > 0;
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
        'NetworkInterfaceId.1': networkInterfaceId, PageSize: '100', PageNumber: '1',
      },
    });

    return this.readVerificationPage(payload, payload.NetworkInterfaceSets?.NetworkInterfaceSet, 'NetworkInterfaceId', [networkInterfaceId]).length > 0;
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
        NatGatewayId: natGatewayId, PageSize: '100', PageNumber: '1',
      },
    });

    return this.readVerificationPage(payload, payload.NatGateways?.NatGateway, 'NatGatewayId', [natGatewayId]).length > 0;
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
        AllocationId: allocationId, PageSize: '100', PageNumber: '1',
      },
    });

    return this.readVerificationPage(payload, payload.EipAddresses?.EipAddress, 'AllocationId', [allocationId]).length > 0;
  }

  private readVerificationPage(payload: unknown, items: unknown, field: string, ids: string[]): Record<string, string>[] {
    const page = this.readJsonObject(payload);
    const rows = Array.isArray(items) ? items : items && typeof items === 'object' ? [items] : null;
    if (!page || typeof page.RequestId !== 'string' || !page.RequestId.trim() || page.Code || !rows
      || !Number.isInteger(page.TotalCount) || page.TotalCount !== rows.length || Number(page.PageNumber) !== 1
      || !Number.isInteger(Number(page.PageSize)) || Number(page.PageSize) < rows.length || Number(page.PageSize) < 1
      || (page.NextToken !== undefined && page.NextToken !== '')
      || rows.some(row => !row || typeof row[field] !== 'string' || !ids.includes(row[field]))
      || new Set(rows.map(row => row[field])).size !== rows.length) {
      throw new Error('Cloud destroy verification response is incomplete or contains unexpected resource identities');
    }
    return rows;
  }

  private async findExistingDiskIds(ids: string[], runtimeConfig: { accessKeyId: string; accessKeySecret: string }, regionId: string) {
    const unique = [...new Set(ids)], existing: string[] = [];
    for (let offset = 0; offset < unique.length; offset += 100) {
      const requested = unique.slice(offset, offset + 100);
      const payload = await this.performAliyunRpcRequest<{ Disks?: { Disk?: unknown } }>({
        endpoint: `ecs.${regionId}.aliyuncs.com`, version: ALICLOUD_ECS_API_VERSION, action: 'DescribeDisks',
        ...runtimeConfig, parameters: { RegionId: regionId, DiskIds: JSON.stringify(requested), PageSize: '100', PageNumber: '1' },
      });
      existing.push(...this.readVerificationPage(payload, payload.Disks?.Disk, 'DiskId', requested).map(row => row.DiskId));
    }
    return existing;
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
      signal: AbortSignal.timeout(15_000),
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
      const current = await this.adminRepository.getRangeInstanceById(input.instance.id) ?? input.instance;
      const evidence = await this.captureRangeResources(input.job, current, input.cleanupInput, {
        ...input.cleanupInput.runtimeConfig!, accountUid: input.cloudContext?.accountUid ?? null,
      });
      await this.runWorkerStep(input.reportStep, 'cleanup_failed_create_resources', async () => {
        if (!(await this.ownsProvisionJobClaim(input.job))) throw new Error('Range operation claim is no longer active');
        await this.rangeProvisioner.destroy({ ...input.cleanupInput, reportStep: undefined });
        await this.verifyDestroyCompletion(evidence, input.cleanupInput.runtimeConfig!);
      });
      if (!(await this.ownsProvisionJobClaim(input.job))) throw new Error('Range operation claim is no longer active');
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
      await this.updateRangeForClaim(input.job, { accessEntry: null, resourceSummary: null });
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

function readWorkerConcurrency(name: string, fallback: number) {
  const value = Number(process.env[name] ?? fallback);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
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
      ['ecs-native', 'opentofu'].includes(instance.resourceSummary?.mode ?? '') &&
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
