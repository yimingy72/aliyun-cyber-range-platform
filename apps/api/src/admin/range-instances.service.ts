import { randomUUID } from 'node:crypto';

import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  compileTopologyGraph,
  type CompiledTopologySpec,
  type ScenarioGraphDraft,
  type TemplateAuthoringMetadata,
  type TemplateNode,
} from '@aliyun-cyber-range/scenario-runtime/compiled';

import {
  ADMIN_REPOSITORY,
  AdminRepository,
  ProvisionJobTopologySnapshot,
  RangeInstanceRecord,
  RangeInstanceDraftRevisionConflictError,
  CreateRangeInstanceInput,
  RangeTemplateCompiledSpec,
  RangeTemplateTopologySpec,
  RangeRuntimeCredentials,
} from './admin.repository';
import type { SessionUserProfile } from './admin-user-auth';
import { attachCreatedByUsernames } from './creator-display';
import { SaveRangeInstanceDraftDto } from './dto/range-instance-draft.dto';
import { ApplyRangeInstanceDraftDto, LaunchRangeInstanceDto } from './dto/range-instance.dto';
import { generateAliyunEcsPassword } from './ecs-password-generator';
import { signAliyunRpcQuery } from './image-catalog-rpc-signer';
import { RangeTemplatesService } from './range-templates.service';
import { validateRangeInstanceDraftPayload } from './range-instance-draft.validation';
import { buildRangeRecoverySummary } from './range-instance-recovery';
import { SystemConfigService } from './system-config.service';
import { CidrPoolService } from '../provisioning/cidr-pool.service';
import { ProvisioningWorkerService } from '../provisioning/provisioning-worker.service';

const ALICLOUD_ECS_API_VERSION = '2014-05-26';
const ALICLOUD_SIGNATURE_METHOD = 'HMAC-SHA1';
const ALICLOUD_SIGNATURE_VERSION = '1.0';
type AuthenticatedUser = Pick<SessionUserProfile, 'id' | 'role'>;

@Injectable()
export class RangeInstancesService {
  constructor(
    @Inject(ADMIN_REPOSITORY) private readonly adminRepository: AdminRepository,
    private readonly rangeTemplatesService: RangeTemplatesService,
    private readonly systemConfigService: SystemConfigService,
    private readonly cidrPoolService: CidrPoolService,
    private readonly provisioningWorkerService: ProvisioningWorkerService,
  ) {}

  async list(currentUser?: AuthenticatedUser, view: 'active' | 'history' = 'active') {
    const instances = await this.adminRepository.listRangeInstances();
    const scopedInstances =
      currentUser && currentUser.role !== 'admin'
        ? instances.filter((instance) => instance.ownerUserId === currentUser.id)
        : instances;
    const templates = await this.adminRepository.listRangeTemplates();
    const templateNameById = new Map(
      templates.map((template) => [template.id, template.name?.trim() || template.slug]),
    );

    const hydratedInstances = await Promise.all(
      scopedInstances
        .filter((instance) => instance.instanceMode === 'range')
        .map((instance) => this.attachRecoverySummary(instance)),
    );

    const listItems = hydratedInstances
      .filter((instance): instance is NonNullable<typeof instance> => Boolean(instance))
      .map((instance) => toRangeInstanceListItem(instance, templateNameById))
      .filter((instance) =>
        view === 'history' ? isRangeInstanceHistoryStatus(instance.status) : !isRangeInstanceHistoryStatus(instance.status),
      );

    return attachCreatedByUsernames(
      this.adminRepository,
      listItems,
    );
  }

  async getById(id: string, currentUser?: AuthenticatedUser) {
    const instance = await this.adminRepository.getRangeInstanceById(id);

    if (!instance) {
      throw new NotFoundException('Range instance not found');
    }

    if (currentUser) {
      this.assertInstanceOwnerOrAdmin(instance, currentUser);
    }

    const hydrated = await this.attachRecoverySummary(instance);

    if (!hydrated) {
      throw new NotFoundException('Range instance not found');
    }

    const nodeStatuses = await this.resolveNodeStatuses(hydrated);

    return {
      ...hydrated,
      nodeStatuses,
    };
  }

  async getAccessById(id: string, currentUser?: AuthenticatedUser) {
    const instance = await this.adminRepository.getRangeInstanceById(id);

    if (!instance) {
      throw new NotFoundException('Range instance not found');
    }

    if (currentUser) {
      this.assertInstanceOwnerOrAdmin(instance, currentUser);
    }

    return {
      id: instance.id,
      runtimeCredentials: instance.runtimeCredentials ?? null,
      accessEntry: instance.accessEntry ?? null,
    };
  }

  async prepareLaunchConfirmation(input: LaunchRangeInstanceDto, currentUser?: AuthenticatedUser) {
    const template = await this.adminRepository.getRangeTemplateById(input.templateId);

    if (!template) {
      throw new NotFoundException('Range template not found');
    }

    const sourceTemplateVersion = await this.rangeTemplatesService.resolveTemplateConsumptionVersion(template, currentUser);

    if (!sourceTemplateVersion) {
      throw new ConflictException('Range template does not have an active template version');
    }

    const templateName = template.name?.trim() || template.slug;
    return {
      targetId: template.id,
      targetSnapshot: { templateId: template.id, templateName, rangeName: input.name, expiresAt: input.expiresAt },
      summary: { targetName: input.name, templateName, destructive: false },
    };
  }

  async prepareDestroyConfirmation(id: string, currentUser?: AuthenticatedUser) {
    return this.prepareActionConfirmation(id, 'destroy', currentUser, true);
  }

  async prepareActionConfirmation(
    id: string,
    action: string,
    currentUser?: AuthenticatedUser,
    destructive = false,
    details: Record<string, unknown> = {},
  ) {
    const instance = await this.adminRepository.getRangeInstanceById(id);

    if (!instance) {
      throw new NotFoundException('Range instance not found');
    }

    if (currentUser) {
      this.assertInstanceOwnerOrAdmin(instance, currentUser);
    }

    return {
      targetId: instance.id,
      targetSnapshot: { status: instance.status, name: instance.name, action, ...details },
      summary: { targetName: instance.name || instance.id, action, destructive },
    };
  }

  async create(input: CreateRangeInstanceInput, currentUser?: AuthenticatedUser) {
    if (!input.templateId) {
      throw new ConflictException('Range instance requires a template id');
    }

    const template = await this.adminRepository.getRangeTemplateById(input.templateId);

    if (!template) {
      throw new NotFoundException('Range template not found');
    }

    const sourceTemplateVersion = await this.rangeTemplatesService.resolveTemplateConsumptionVersion(template, currentUser);

    if (!sourceTemplateVersion) {
      throw new ConflictException('Range template does not have an active template version');
    }

    const instance = await this.adminRepository.createRangeInstance({
      ...input,
      createdBy: currentUser?.id ?? input.createdBy,
      ownerUserId: currentUser?.id ?? input.ownerUserId,
      sourceTemplateVersionId: sourceTemplateVersion.id,
      templateNameSnapshot: template.name,
      templateSlugSnapshot: template.slug,
      templateVersionSnapshot: sourceTemplateVersion.version,
      templateModulePathSnapshot: sourceTemplateVersion.modulePathOrRef,
    });

    return this.withCreatorUsername(instance);
  }

  async launch(input: LaunchRangeInstanceDto, currentUser?: AuthenticatedUser) {
    this.assertFutureInstanceExpiration(input.expiresAt);

    const template = await this.adminRepository.getRangeTemplateById(input.templateId);

    if (!template) {
      throw new NotFoundException('Range template not found');
    }

    const sourceTemplateVersion = await this.rangeTemplatesService.resolveTemplateConsumptionVersion(template, currentUser);
    const allowTemplateFallback = !this.isPlatformTemplateConsumer(template, currentUser);

    if (!sourceTemplateVersion) {
      throw new ConflictException('Range template does not have an active template version');
    }

    const sourceTopologyGraph =
      sourceTemplateVersion.topologyGraph ??
      (allowTemplateFallback ? template.topologyGraph : null) ??
      undefined;
    const sourceTopologySpec =
      sourceTemplateVersion.topologySpec ??
      (allowTemplateFallback ? template.topologySpec : null) ??
      null;
    const runtimeScenarioTemplateSpec =
      sourceTemplateVersion.scenarioTemplateSpec ??
      (allowTemplateFallback ? template.scenarioTemplateSpec : null) ??
      null;
    const runtimeCompiledProvisionSpec =
      sourceTemplateVersion.compiledProvisionSpec ??
      (allowTemplateFallback ? template.compiledProvisionSpec : null) ??
      null;
    const sourceCompiledSpec =
      sourceTemplateVersion.compiledSpec ?? (allowTemplateFallback ? template.compiledSpec : null) ?? null;
    await this.rangeTemplatesService.assertTemplateEcsImageSelections(
      {
        topologyGraph: sourceTopologyGraph,
        topologySpec: sourceTopologySpec,
        scenarioTemplateSpec: runtimeScenarioTemplateSpec,
        compiledProvisionSpec: runtimeCompiledProvisionSpec,
        compiledSpec: sourceCompiledSpec,
      },
      currentUser,
    );
    const runtimeCredentials = this.resolveRuntimeCredentials(runtimeScenarioTemplateSpec);
    const actorId = currentUser?.id ?? 'admin';

    const instance = await this.adminRepository.createRangeInstance({
      name: input.name,
      createdBy: actorId,
      ownerUserId: currentUser?.id ?? null,
      instanceMode: 'range',
      templateId: template.id,
      sourceTemplateVersionId: sourceTemplateVersion.id,
      templateNameSnapshot: template.name,
      templateSlugSnapshot: template.slug,
      templateVersionSnapshot: sourceTemplateVersion.version,
      templateModulePathSnapshot: sourceTemplateVersion.modulePathOrRef,
      runtimeTopologyGraph: sourceTopologyGraph ?? null,
      runtimeScenarioTemplateSpec,
      runtimeCompiledProvisionSpec,
      runtimeCredentials,
      status: 'pending_create',
      expiresAt: input.expiresAt,
    });

    const job = await this.adminRepository.createProvisionJob({
      rangeInstanceId: instance.id,
      jobType: 'create',
      triggeredBy: actorId,
    });

    const updated = await this.adminRepository.updateRangeInstance(instance.id, {
      lastJobId: job.id,
    });

    this.provisioningWorkerService.dispatch(job.id);

    const hydrated = await this.attachRecoverySummary(updated);

    if (!hydrated) {
      throw new NotFoundException('Range instance not found');
    }

    return this.withCreatorUsername(hydrated);
  }

  async saveDraft(id: string, input: SaveRangeInstanceDraftDto, currentUser?: AuthenticatedUser) {
    const instance = await this.adminRepository.getRangeInstanceById(id);

    if (!instance) {
      throw new NotFoundException('Range instance not found');
    }

    if (currentUser) {
      this.assertInstanceOwnerOrAdmin(instance, currentUser);
    }

    if (instance.status !== 'running') {
      throw new ConflictException('Only running instances can save draft changes');
    }

    const metadata = await this.resolveDraftCompilationMetadata(instance);
    const compiled = validateRangeInstanceDraftPayload(input, metadata);
    const viewport = this.readDraftViewport(input.draftTopologyGraph);
    const updated = await this.adminRepository.saveRangeInstanceDraft(id, input.expectedDraftRevision, {
      draftTopologyGraph: this.normalizeJsonRecord({
        ...compiled.topologyGraph,
        ...(viewport ? { viewport } : {}),
      }),
      draftTopologySpec: this.normalizeJsonRecord(compiled.topologySpec),
      draftScenarioTemplateSpec: this.normalizeJsonRecord(compiled.scenarioTemplateSpec),
      draftCompiledProvisionSpec: this.normalizeJsonRecord(compiled.compiledProvisionSpec),
      draftUpdatedBy: currentUser?.id ?? null,
      draftUpdatedAt: new Date(),
    });

    if (!updated) {
      throw new ConflictException('Range instance draft has changed; refresh before saving again');
    }

    const hydrated = await this.attachRecoverySummary(updated);

    if (!hydrated) {
      throw new NotFoundException('Range instance not found');
    }

    return this.withCreatorUsername(hydrated);
  }

  async discardDraft(id: string, currentUser?: AuthenticatedUser) {
    const instance = await this.adminRepository.getRangeInstanceById(id);

    if (!instance) {
      throw new NotFoundException('Range instance not found');
    }

    if (currentUser) {
      this.assertInstanceOwnerOrAdmin(instance, currentUser);
    }

    const updated = await this.adminRepository.discardRangeInstanceDraft(id, instance.draftRevision ?? 0);

    if (!updated) {
      throw new ConflictException('Range instance draft has changed; refresh before discarding it');
    }

    const hydrated = await this.attachRecoverySummary(updated);

    if (!hydrated) {
      throw new NotFoundException('Range instance not found');
    }

    return this.withCreatorUsername(hydrated);
  }

  async applyDraft(
    id: string,
    input: ApplyRangeInstanceDraftDto,
    currentUserOrTriggeredBy?: AuthenticatedUser | string,
  ) {
    const instance = await this.adminRepository.getRangeInstanceById(id);

    if (!instance) {
      throw new NotFoundException('Range instance not found');
    }

    const actorId =
      typeof currentUserOrTriggeredBy === 'string'
        ? currentUserOrTriggeredBy
        : currentUserOrTriggeredBy?.id ?? 'admin';

    if (typeof currentUserOrTriggeredBy === 'object' && currentUserOrTriggeredBy) {
      this.assertInstanceOwnerOrAdmin(instance, currentUserOrTriggeredBy);
    }

    if (instance.status !== 'running') {
      throw new ConflictException('Only running instances can apply draft changes');
    }

    if (
      !instance.draftTopologyGraph ||
      !instance.draftTopologySpec ||
      !instance.draftScenarioTemplateSpec ||
      !instance.draftCompiledProvisionSpec
    ) {
      throw new ConflictException('Range instance does not have a pending draft');
    }

    if (instance.draftRevision !== input.expectedDraftRevision) {
      throw new ConflictException('Range instance draft has changed; refresh before applying it');
    }

    const draftTopologyGraph = this.normalizeJsonRecord(instance.draftTopologyGraph);
    const draftTopologySpec = this.normalizeJsonRecord(instance.draftTopologySpec);
    const draftScenarioTemplateSpec = this.normalizeJsonRecord(instance.draftScenarioTemplateSpec);
    const draftCompiledProvisionSpec = this.normalizeJsonRecord(instance.draftCompiledProvisionSpec);
    const metadata = await this.resolveDraftCompilationMetadata(instance);
    const compiled = validateRangeInstanceDraftPayload(
      {
        draftTopologyGraph,
        draftTopologySpec,
        draftScenarioTemplateSpec,
        draftCompiledProvisionSpec,
      },
      metadata,
    );
    const viewport = this.readDraftViewport(draftTopologyGraph);
    const templateModulePath = await this.resolveApplyTemplateModulePath(instance);
    const topologySnapshot: ProvisionJobTopologySnapshot = {
      draftRevision: input.expectedDraftRevision,
      topologyGraph: {
        ...compiled.topologyGraph,
        ...(viewport ? { viewport } : {}),
      },
      topologySpec: compiled.topologySpec,
      scenarioTemplateSpec: compiled.scenarioTemplateSpec,
      compiledProvisionSpec: compiled.compiledProvisionSpec,
      compiledSpec: compiled.compiledSpec,
      templateModulePath,
    };
    let job;

    try {
      job = await this.adminRepository.applyRangeInstanceDraft({
        rangeInstanceId: id,
        expectedDraftRevision: input.expectedDraftRevision,
        triggeredBy: actorId,
        topologySnapshot,
      });
    } catch (error) {
      if (error instanceof RangeInstanceDraftRevisionConflictError) {
        throw new ConflictException('Range instance draft has changed; refresh before applying it');
      }

      throw error;
    }

    if (!job) {
      throw new ConflictException('Range instance draft has changed; refresh before applying it');
    }

    this.provisioningWorkerService.dispatch(job.id);

    return job;
  }

  async syncTemplate(id: string, currentUser?: AuthenticatedUser) {
    const instance = await this.adminRepository.getRangeInstanceById(id);

    if (!instance) {
      throw new NotFoundException('Range instance not found');
    }

    if (currentUser) {
      this.assertInstanceOwnerOrAdmin(instance, currentUser);
    }

    if (!instance.templateId) {
      throw new ConflictException('Range instance does not reference an active template');
    }

    const template = await this.adminRepository.getRangeTemplateById(instance.templateId);

    if (!template) {
      throw new NotFoundException('Range template not found');
    }

    const topologyGraph = instance.draftTopologyGraph ?? instance.runtimeTopologyGraph;
    const scenarioTemplateSpec = instance.draftScenarioTemplateSpec ?? instance.runtimeScenarioTemplateSpec;
    const compiledProvisionSpec =
      instance.draftCompiledProvisionSpec ?? instance.runtimeCompiledProvisionSpec;

    if (!topologyGraph || !scenarioTemplateSpec || !compiledProvisionSpec) {
      throw new ConflictException('Range instance does not have a complete topology snapshot to sync');
    }

    const topologySpec =
      this.readTopologySpecFromScenarioTemplateSpec(scenarioTemplateSpec) ??
      template.currentDraftVersion?.topologySpec ??
      template.topologySpec;

    if (!topologySpec) {
      throw new ConflictException('Unable to derive template topology spec from the instance snapshot');
    }

    const compiledSpec = this.buildCompiledSpecFromTopologyGraph(topologyGraph, topologySpec);

    if (!compiledSpec) {
      throw new ConflictException('Unable to compile the instance topology snapshot');
    }

    return this.rangeTemplatesService.validateAndSave(
      template.id,
      {
        expectedRevision: template.revision,
        topologySpec,
        topologyGraph,
        scenarioTemplateSpec,
        compiledProvisionSpec,
        compiledSpec,
      },
      currentUser,
    );
  }

  async triggerCreate(id: string, currentUserOrTriggeredBy?: AuthenticatedUser | string) {
    const actorId =
      typeof currentUserOrTriggeredBy === 'string'
        ? currentUserOrTriggeredBy
        : currentUserOrTriggeredBy?.id ?? 'admin';
    const job = await this.cidrPoolService.serialize(async () => {
      const instance = await this.adminRepository.getRangeInstanceById(id);

      if (!instance) {
        throw new NotFoundException('Range instance not found');
      }

      if (typeof currentUserOrTriggeredBy === 'object' && currentUserOrTriggeredBy) {
        this.assertInstanceOwnerOrAdmin(instance, currentUserOrTriggeredBy);
      }

      this.assertFutureInstanceExpiration(instance.expiresAt);

      if (!instance.templateId) {
        throw new ConflictException('Range instance no longer references an active template');
      }

      const template = await this.adminRepository.getRangeTemplateById(instance.templateId);

      if (!template) {
        throw new NotFoundException('Range template not found');
      }

      const sourceTemplateVersion = instance.sourceTemplateVersionId
        ? await this.adminRepository.getRangeTemplateVersionById(instance.sourceTemplateVersionId)
        : template.currentDraftVersion ?? template.currentPublishedVersion;

      if (instance.sourceTemplateVersionId && !sourceTemplateVersion) {
        throw new ConflictException('Range instance source template version not found');
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
      const effectiveTopologySpec = instance.sourceTemplateVersionId
        ? this.resolveFrozenSourceTopologySpec(sourceTemplateVersion)
        : sourceTemplateVersion?.topologySpec ??
          template.currentDraftVersion?.topologySpec ??
          template.currentPublishedVersion?.topologySpec ??
          template.topologySpec;
      const imageValidationUser =
        typeof currentUserOrTriggeredBy === 'object' && currentUserOrTriggeredBy
          ? currentUserOrTriggeredBy
          : instance.ownerUserId
            ? await this.adminRepository.getPlatformUserById(instance.ownerUserId)
            : undefined;
      await this.rangeTemplatesService.assertTemplateEcsImageSelections(
        {
          topologyGraph: sourceTemplateVersion?.topologyGraph ?? template.topologyGraph ?? undefined,
          topologySpec: effectiveTopologySpec,
          scenarioTemplateSpec: sourceTemplateVersion?.scenarioTemplateSpec ?? template.scenarioTemplateSpec ?? undefined,
          compiledProvisionSpec:
            sourceTemplateVersion?.compiledProvisionSpec ?? template.compiledProvisionSpec ?? undefined,
          compiledSpec: sourceTemplateVersion?.compiledSpec ?? template.compiledSpec ?? undefined,
        },
        imageValidationUser ?? undefined,
      );
      const fixedVpcCidr = effectiveTopologySpec?.vpcCidr ?? null;

      const allocatedCidr =
        instance.allocatedCidr ??
        fixedVpcCidr ??
        (cidrPool.length > 0 ? this.cidrPoolService.allocate(cidrPool, occupiedCidrs) : null);

      const nextJob = await this.adminRepository.createProvisionJob({
        rangeInstanceId: instance.id,
        jobType: 'create',
        triggeredBy: actorId,
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

  async triggerDestroy(id: string, currentUserOrTriggeredBy?: AuthenticatedUser | string) {
    const instance = await this.adminRepository.getRangeInstanceById(id);

    if (!instance) {
      throw new NotFoundException('Range instance not found');
    }

    const actorId =
      typeof currentUserOrTriggeredBy === 'string'
        ? currentUserOrTriggeredBy
        : currentUserOrTriggeredBy?.id ?? 'admin';

    if (typeof currentUserOrTriggeredBy === 'object' && currentUserOrTriggeredBy) {
      this.assertInstanceOwnerOrAdmin(instance, currentUserOrTriggeredBy);
    }

    if (!instance.templateId) {
      throw new ConflictException('Range instance no longer references an active template');
    }

    if (!['running', 'create_failed', 'destroy_failed'].includes(instance.status)) {
      throw new ConflictException('Range instance cannot start a destroy job from the current status');
    }

    const job = await this.adminRepository.createProvisionJob({
      rangeInstanceId: instance.id,
      jobType: 'destroy',
      triggeredBy: actorId,
    });

    await this.adminRepository.updateRangeInstance(instance.id, {
      status: 'pending_destroy',
      lastJobId: job.id,
    });

    this.provisioningWorkerService.dispatch(job.id);

    return job;
  }

  private assertFutureInstanceExpiration(expiresAt: string | Date | null | undefined) {
    const expiration = expiresAt instanceof Date ? expiresAt : expiresAt ? new Date(expiresAt) : null;

    if (!expiration || !Number.isFinite(expiration.getTime()) || expiration <= new Date()) {
      throw new ConflictException('创建靶场实例前必须设置未来的到期时间。');
    }
  }

  async triggerRetry(id: string, currentUserOrTriggeredBy?: AuthenticatedUser | string) {
    const instance = await this.adminRepository.getRangeInstanceById(id);

    if (!instance) {
      throw new NotFoundException('Range instance not found');
    }

    const actorId =
      typeof currentUserOrTriggeredBy === 'string'
        ? currentUserOrTriggeredBy
        : currentUserOrTriggeredBy?.id ?? 'admin';

    if (typeof currentUserOrTriggeredBy === 'object' && currentUserOrTriggeredBy) {
      this.assertInstanceOwnerOrAdmin(instance, currentUserOrTriggeredBy);
    }

    if (!instance.templateId) {
      throw new ConflictException('Range instance no longer references an active template');
    }

    if (!['create_failed', 'destroy_failed'].includes(instance.status)) {
      throw new ConflictException('Range instance cannot start a retry job from the current status');
    }

    if (instance.status === 'create_failed') {
      this.assertFutureInstanceExpiration(instance.expiresAt);

      const template = await this.adminRepository.getRangeTemplateById(instance.templateId);

      if (!template) {
        throw new NotFoundException('Range template not found');
      }

      const sourceTemplateVersion = instance.sourceTemplateVersionId
        ? await this.adminRepository.getRangeTemplateVersionById(instance.sourceTemplateVersionId)
        : template.currentDraftVersion ?? template.currentPublishedVersion;
      const imageValidationUser =
        typeof currentUserOrTriggeredBy === 'object' && currentUserOrTriggeredBy
          ? currentUserOrTriggeredBy
          : instance.ownerUserId
            ? await this.adminRepository.getPlatformUserById(instance.ownerUserId)
            : undefined;
      await this.rangeTemplatesService.assertTemplateEcsImageSelections(
        {
          topologyGraph: sourceTemplateVersion?.topologyGraph ?? template.topologyGraph ?? undefined,
          topologySpec: this.resolveFrozenSourceTopologySpec(sourceTemplateVersion) ?? template.topologySpec,
          scenarioTemplateSpec: sourceTemplateVersion?.scenarioTemplateSpec ?? template.scenarioTemplateSpec ?? undefined,
          compiledProvisionSpec:
            sourceTemplateVersion?.compiledProvisionSpec ?? template.compiledProvisionSpec ?? undefined,
          compiledSpec: sourceTemplateVersion?.compiledSpec ?? template.compiledSpec ?? undefined,
        },
        imageValidationUser ?? undefined,
      );
    }

    const previousJob = instance.lastJobId
      ? await this.adminRepository.getProvisionJobById(instance.lastJobId)
      : null;

    const retryCount = (previousJob?.retryCount ?? 0) + 1;
    const pendingStatus = instance.status === 'create_failed' ? 'pending_create' : 'pending_destroy';

    const job = await this.adminRepository.createProvisionJob({
      rangeInstanceId: instance.id,
      jobType: 'retry',
      triggeredBy: actorId,
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

  private assertInstanceOwnerOrAdmin(
    instance: NonNullable<Awaited<ReturnType<AdminRepository['getRangeInstanceById']>>>,
    currentUser: AuthenticatedUser,
  ) {
    if (currentUser.role === 'admin') {
      return;
    }

    if (instance.ownerUserId === currentUser.id) {
      return;
    }

    throw new ForbiddenException('Range instance access denied');
  }

  private isPlatformTemplateConsumer(
    template: NonNullable<Awaited<ReturnType<AdminRepository['getRangeTemplateById']>>>,
    currentUser?: AuthenticatedUser,
  ) {
    return Boolean(currentUser) && currentUser!.role !== 'admin' && template.ownerUserId !== currentUser!.id;
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

  private async withCreatorUsername<T extends { createdBy: string | null; ownerUserId: string | null }>(instance: T) {
    const [normalizedInstance] = await attachCreatedByUsernames(this.adminRepository, [instance]);
    return normalizedInstance;
  }

  private async resolveNodeStatuses(instance: Awaited<ReturnType<AdminRepository['getRangeInstanceById']>>) {
    const hostIds = instance?.resourceSummary?.hostIds ?? null;

    if (!hostIds || Object.keys(hostIds).length === 0) {
      return null;
    }

    try {
      const accountContext = await this.systemConfigService.getAccountContext();
      const instanceIds = Object.values(hostIds).filter((value): value is string => Boolean(value));

      if (instanceIds.length === 0) {
        return null;
      }

      const payload = await this.performAliyunRpcRequest<{
        Instances?: {
          Instance?:
            | Array<{
                InstanceId?: string;
                Status?: string;
              }>
            | {
                InstanceId?: string;
                Status?: string;
              };
        };
      }>({
        accessKeyId: accountContext.accessKeyId,
        accessKeySecret: accountContext.accessKeySecret,
        regionId: accountContext.defaultRegion,
        action: 'DescribeInstances',
        parameters: {
          InstanceIds: JSON.stringify(instanceIds),
        },
      });

      const items = payload.Instances?.Instance;
      const normalized = Array.isArray(items) ? items : items ? [items] : [];
      const statusByInstanceId = new Map(
        normalized
          .filter((item) => typeof item?.InstanceId === 'string' && typeof item?.Status === 'string')
          .map((item) => [item.InstanceId as string, item.Status as string]),
      );

      return Object.fromEntries(
        Object.entries(hostIds).flatMap(([nodeId, cloudInstanceId]) => {
          const status = statusByInstanceId.get(cloudInstanceId);
          return status ? [[nodeId, status]] : [];
        }),
      );
    } catch {
      return null;
    }
  }

  private async performAliyunRpcRequest<ResponsePayload>(input: {
    accessKeyId: string;
    accessKeySecret: string;
    regionId: string;
    action: string;
    parameters?: Record<string, string>;
  }): Promise<ResponsePayload> {
    const endpoint = `https://ecs.${input.regionId}.aliyuncs.com/`;
    const query = signAliyunRpcQuery(
      {
        Action: input.action,
        AccessKeyId: input.accessKeyId,
        Format: 'JSON',
        RegionId: input.regionId,
        SignatureMethod: ALICLOUD_SIGNATURE_METHOD,
        SignatureNonce: randomUUID(),
        SignatureVersion: ALICLOUD_SIGNATURE_VERSION,
        Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
        Version: ALICLOUD_ECS_API_VERSION,
        ...(input.parameters ?? {}),
      },
      input.accessKeySecret,
    );
    const response = await fetch(`${endpoint}?${query}`, {
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

  private resolveRuntimeCredentials(runtimeScenarioTemplateSpec: Record<string, unknown> | null) {
    const hosts = Array.isArray(runtimeScenarioTemplateSpec?.hosts) ? runtimeScenarioTemplateSpec.hosts : [];

    if (hosts.length === 0) {
      return null;
    }

    const runtimeCredentials: RangeRuntimeCredentials = {};

    for (const host of hosts) {
      if (!this.isRuntimeScenarioHost(host)) {
        continue;
      }

      const password = this.resolveHostPassword(host.accountPreset);
      runtimeCredentials[host.key] = {
        username: 'root',
        password,
      };
    }

    return Object.keys(runtimeCredentials).length > 0 ? runtimeCredentials : null;
  }

  private resolveHostPassword(accountPreset: { password?: unknown } | undefined) {
    if (typeof accountPreset?.password === 'string') {
      const normalizedPassword = accountPreset.password.trim();

      if (normalizedPassword.length > 0) {
        return normalizedPassword;
      }
    }

    return generateAliyunEcsPassword();
  }

  private isRuntimeScenarioHost(
    value: unknown,
  ): value is {
    key: string;
    accountPreset?: {
      password?: unknown;
    };
  } {
    if (!value || typeof value !== 'object') {
      return false;
    }

    if (typeof (value as { key?: unknown }).key !== 'string') {
      return false;
    }

    const accountPreset = (value as { accountPreset?: unknown }).accountPreset;

    return accountPreset === undefined || (accountPreset !== null && typeof accountPreset === 'object');
  }

  private readTopologySpecFromScenarioTemplateSpec(
    value: Record<string, unknown> | null | undefined,
  ): RangeTemplateTopologySpec | null {
    if (!value) {
      return null;
    }

    const topology = this.readRecord(value.topology);
    const networkZones = this.readArray(value.networkZones);
    const hosts = this.readArray(value.hosts);
    const publicEntryHostKey = typeof topology?.entryHostKey === 'string' ? topology.entryHostKey : null;
    const vpcCidr = typeof topology?.vpcCidr === 'string' ? topology.vpcCidr : null;

    if (!publicEntryHostKey || !vpcCidr || networkZones.length === 0 || hosts.length === 0) {
      return null;
    }

    return {
      vpcCidr,
      networkZones: networkZones.flatMap((zoneValue) => {
        const zone = this.readRecord(zoneValue);

        if (!zone || typeof zone.key !== 'string' || typeof zone.name !== 'string' || typeof zone.cidr !== 'string') {
          return [];
        }

        return [
          {
            key: zone.key,
            name: zone.name,
            purpose: typeof zone.purpose === 'string' ? zone.purpose : zone.key,
            cidr: zone.cidr,
            ...(zone.isPublicEntry === true ? { isPublicEntry: true } : {}),
          },
        ];
      }),
      hosts: hosts.flatMap((hostValue) => {
        const host = this.readRecord(hostValue);

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

        return [
          {
            key: host.key,
            name: host.name,
            zoneKey: host.zoneKey,
            role: host.role,
            privateIp: host.primaryPrivateIp,
            ...(host.exposePublic === true ? { exposePublic: true } : {}),
          },
        ];
      }),
      publicEntry: {
        hostKey: publicEntryHostKey,
        protocols: [{ protocol: 'ssh', port: 22 }],
      },
    };
  }

  private buildCompiledSpecFromTopologyGraph(
    topologyGraph: Record<string, unknown>,
    topologySpec: RangeTemplateTopologySpec,
  ) {
    const rawNodes = this.readArray(topologyGraph.nodes).filter((node) => {
      const record = this.readRecord(node);
      return record && typeof record.id === 'string' && typeof record.kind === 'string';
    });

    if (rawNodes.length === 0) {
      return null;
    }

    return compileTopologyGraph(
      rawNodes as TemplateNode[],
      topologySpec as CompiledTopologySpec,
    );
  }

  private async resolveDraftCompilationMetadata(instance: RangeInstanceRecord): Promise<TemplateAuthoringMetadata> {
    const scenarioTemplateSpec = this.readRecord(instance.runtimeScenarioTemplateSpec);
    const metadata = this.readRecord(scenarioTemplateSpec?.metadata);
    const runtimeTopology = this.readRecord(scenarioTemplateSpec?.topology);
    const compiledProvisionTopology = this.readRecord(
      this.readRecord(instance.runtimeCompiledProvisionSpec)?.topology,
    );
    const sourceTemplateVersion = instance.sourceTemplateVersionId
      ? await this.adminRepository.getRangeTemplateVersionById(instance.sourceTemplateVersionId)
      : null;
    const sourceTemplate = instance.templateId
      ? await this.adminRepository.getRangeTemplateById(instance.templateId)
      : null;
    const name = this.readNonEmptyString(metadata?.name) ?? this.readNonEmptyString(instance.name);
    const slug =
      this.readNonEmptyString(metadata?.slug) ??
      this.readNonEmptyString(instance.templateSlugSnapshot) ??
      this.readNonEmptyString(sourceTemplate?.slug);
    const version =
      this.readNonEmptyString(metadata?.version) ??
      this.readNonEmptyString(instance.templateVersionSnapshot) ??
      this.readNonEmptyString(sourceTemplate?.version);
    const modulePathOrRef =
      this.readNonEmptyString(instance.templateModulePathSnapshot) ??
      this.readNonEmptyString(sourceTemplateVersion?.modulePathOrRef) ??
      this.readNonEmptyString(sourceTemplate?.modulePathOrRef);
    const primaryVpcCidr =
      this.readNonEmptyString(runtimeTopology?.vpcCidr) ??
      this.readNonEmptyString(compiledProvisionTopology?.vpcCidr);
    const cloudProvider = metadata?.cloudProvider === 'alibaba_cloud'
      ? 'alibaba_cloud'
      : sourceTemplate?.cloudProvider === 'alibaba_cloud'
        ? 'alibaba_cloud'
        : null;
    const iacType = metadata?.iacType === 'terraform' || metadata?.iacType === 'opentofu'
      ? metadata.iacType
      : sourceTemplate?.iacType === 'terraform' || sourceTemplate?.iacType === 'opentofu'
        ? sourceTemplate.iacType
        : null;
    const description = this.readNonEmptyString(metadata?.description);
    const defaultRegion = this.readNonEmptyString(runtimeTopology?.defaultRegion);
    const defaultZoneId = this.readNonEmptyString(runtimeTopology?.defaultZoneId);

    if (!name || !slug || !version || !modulePathOrRef || !primaryVpcCidr || !cloudProvider || !iacType) {
      throw new ConflictException('Range instance runtime metadata is incomplete; refresh the instance before saving a draft');
    }

    return {
      name,
      slug,
      version,
      cloudProvider,
      iacType,
      modulePathOrRef,
      primaryVpcCidr,
      ...(description ? { description } : {}),
      ...(defaultRegion ? { defaultRegion } : {}),
      ...(defaultZoneId ? { defaultZoneId } : {}),
    };
  }

  private async resolveApplyTemplateModulePath(instance: RangeInstanceRecord) {
    const savedModulePath = this.readNonEmptyString(instance.templateModulePathSnapshot);

    if (savedModulePath) {
      return savedModulePath;
    }

    if (!instance.sourceTemplateVersionId) {
      throw new ConflictException('Range instance source template module path is unavailable');
    }

    const sourceTemplateVersion = await this.adminRepository.getRangeTemplateVersionById(instance.sourceTemplateVersionId);
    const sourceModulePath = this.readNonEmptyString(sourceTemplateVersion?.modulePathOrRef);

    if (!sourceModulePath) {
      throw new ConflictException('Range instance source template module path is unavailable');
    }

    return sourceModulePath;
  }

  private readNonEmptyString(value: unknown) {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }

  private readDraftViewport(value: Record<string, unknown>) {
    const viewport = this.readRecord(value.viewport);
    const x = viewport?.x;
    const y = viewport?.y;
    const zoom = viewport?.zoom;

    if (
      typeof x !== 'number' ||
      typeof y !== 'number' ||
      typeof zoom !== 'number' ||
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      !Number.isFinite(zoom) ||
      zoom <= 0
    ) {
      return null;
    }

    return { x, y, zoom };
  }

  private normalizeJsonRecord(value: Record<string, unknown>) {
    return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  }

  private readRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }

    return value as Record<string, unknown>;
  }

  private readArray(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
  }

  private resolveFrozenSourceTopologySpec(
    sourceTemplateVersion: Awaited<ReturnType<AdminRepository['getRangeTemplateVersionById']>> | undefined,
  ): RangeTemplateTopologySpec | null {
    if (!sourceTemplateVersion) {
      return null;
    }

    return (
      this.readTopologySpecFromCompiledProvisionSpec(sourceTemplateVersion.compiledProvisionSpec) ??
      this.readTopologySpecFromCompiledSpec(sourceTemplateVersion.compiledSpec as RangeTemplateCompiledSpec | null | undefined) ??
      sourceTemplateVersion.topologySpec
    );
  }

  private readTopologySpecFromCompiledProvisionSpec(
    value: Record<string, unknown> | null | undefined,
  ): RangeTemplateTopologySpec | null {
    if (!value) {
      return null;
    }

    const topology = this.readRecord(value.topology);
    const networkZones = this.readArray(value.networkZones);
    const hosts = this.readArray(value.hosts);
    const publicEntryHostKey = typeof topology?.entryHostKey === 'string' ? topology.entryHostKey : null;
    const vpcCidr = typeof topology?.vpcCidr === 'string' ? topology.vpcCidr : null;

    if (!publicEntryHostKey || !vpcCidr || networkZones.length === 0 || hosts.length === 0) {
      return null;
    }

    return {
      vpcCidr,
      networkZones: networkZones.flatMap((zoneValue) => {
        const zone = this.readRecord(zoneValue);

        if (!zone || typeof zone.key !== 'string' || typeof zone.name !== 'string' || typeof zone.cidr !== 'string') {
          return [];
        }

        return [
          {
            key: zone.key,
            name: zone.name,
            purpose: typeof zone.purpose === 'string' ? zone.purpose : zone.key,
            cidr: zone.cidr,
            ...(zone.isPublicEntry === true ? { isPublicEntry: true } : {}),
          },
        ];
      }),
      hosts: hosts.flatMap((hostValue) => {
        const host = this.readRecord(hostValue);

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

        return [
          {
            key: host.key,
            name: host.name,
            zoneKey: host.zoneKey,
            role: host.role,
            privateIp,
            ...(host.exposePublic === true ? { exposePublic: true } : {}),
          },
        ];
      }),
      publicEntry: {
        hostKey: publicEntryHostKey,
        protocols: [{ protocol: 'ssh', port: 22 }],
      },
    };
  }

  private readTopologySpecFromCompiledSpec(
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

        return [
          {
            key: zoneKey,
            name,
            purpose: typeof resource.config.purpose === 'string' ? resource.config.purpose : zoneKey,
            cidr,
            ...(zoneKey === publicEntryHost.config.zoneKey ? { isPublicEntry: true } : {}),
          },
        ];
      }),
      hosts: hostResources.flatMap((resource) => {
        const zoneKey = typeof resource.config.zoneKey === 'string' ? resource.config.zoneKey : null;
        const role = typeof resource.config.role === 'string' ? resource.config.role : null;
        const privateIp = typeof resource.config.privateIp === 'string' ? resource.config.privateIp : null;

        if (!zoneKey || !role || !privateIp) {
          return [];
        }

        return [
          {
            key: resource.id,
            name: typeof resource.config.label === 'string' ? resource.config.label : resource.id,
            zoneKey,
            role,
            privateIp,
            ...(typeof resource.config.exposePublic === 'boolean'
              ? { exposePublic: resource.config.exposePublic }
              : {}),
          },
        ];
      }),
      publicEntry: {
        hostKey: publicEntryHostKey,
        protocols: [{ protocol: 'ssh', port: 22 }],
      },
    };
  }

  private readCompiledProvisionHostPrivateIp(host: Record<string, unknown>) {
    if (typeof host.primaryPrivateIp === 'string') {
      return host.primaryPrivateIp;
    }

    const primaryInterface = this.readRecord(this.readArray(host.networkInterfaces)[0]);

    if (typeof primaryInterface?.privateIp === 'string') {
      return primaryInterface.privateIp;
    }

    return null;
  }
}

function toRangeInstanceListItem(
  instance: {
    id: string;
    name: string;
    createdBy: string | null;
    ownerUserId: string | null;
    status: string;
    templateId: string | null;
    templateNameSnapshot?: string | null;
    createdAt: Date;
    lastJobId: string | null;
    errorSummary?: string | null;
  },
  templateNameById: Map<string, string>,
) {
  return {
    id: instance.id,
    name: instance.name,
    createdBy: instance.createdBy,
    ownerUserId: instance.ownerUserId,
    status: instance.status,
    templateId: instance.templateId,
    templateNameSnapshot:
      instance.templateNameSnapshot?.trim() ||
      (instance.templateId ? templateNameById.get(instance.templateId) ?? null : null),
    createdAt: instance.createdAt,
    lastJobId: instance.lastJobId,
    errorSummary: instance.errorSummary ?? null,
  };
}

function isRangeInstanceHistoryStatus(status: string) {
  return status === 'destroyed' || status === 'create_failed';
}
