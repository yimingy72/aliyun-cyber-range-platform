import {
  AdminRepository,
  BillingAnomalyRecord,
  BillingLedgerResourceRecord,
  BillingLineItemRecord,
  CloudResourceDriftRecord,
  CloudImageSnapshotRecord,
  CollectImageCatalogItemInput,
  CollectPlatformImageAssetInput,
  CreatePlatformImageTagInput,
  CreateBillingAnomalyInput,
  CreateBillingLedgerResourceInput,
  CreateBillingLineItemInput,
  CreateIdempotentOperationInput,
  CreateOperationConfirmationInput,
  CreatePlatformUserInput,
  CreateSingleInstanceBatchInput,
  ApplyRangeInstanceDraftInput,
  CompleteRangeInstanceDraftApplyInput,
  CreateProvisionJobInput,
  QueueRangeInstanceJobInput,
  ProvisionJobTopologySnapshot,
  RangeInstanceDraftRevisionConflictError,
  CreateProvisionJobStepLogInput,
  CreateRangeInstanceInput,
  CreateRangeTemplateInput,
  ImageCatalogItemRecord,
  IdempotentOperationRecord,
  ListImageCatalogItemsFilter,
  ListImageSnapshotsFilter,
  ListPlatformImageAssetsFilter,
  OperationAuditEventInput,
  OperationAuditEventRecord,
  OperationConfirmationRecord,
  PlatformUserRecord,
  PackedImageArtifactRecord,
  PlatformImageAssetRecord,
  PlatformImageTagRecord,
  ProvisionJobRecord,
  ListPendingProvisionJobsInput,
  ProvisionJobStepLogRecord,
  ReconcileImageSnapshotsInput,
  RangeInstanceRecord,
  RangeTemplateRecord,
  RangeTemplateVersionRecord,
  SaveRangeInstanceDraftInput,
  FindBillingLedgerResourceInput,
  ListBillingAnomaliesFilter,
  ListBillingLineItemsFilter,
  SingleInstanceNetworkProfileRecord,
  SingleInstanceBatchRecord,
  TemplateRevisionConflictError,
  UpsertImageSnapshotsInput,
  UpsertCloudResourceDriftInput,
  UpsertSingleInstanceNetworkProfileInput,
  UpdateBillingLedgerResourceInput,
  UpdateIdempotentOperationInput,
  UpdatePlatformUserInput,
  UpdateProvisionJobInput,
  UpdateProvisionJobStepLogInput,
  UpdateRangeInstanceInput,
} from '../../src/admin/admin.repository';
import { toAccountScopeKey } from '../../src/admin/image-account-scope';
import { getCurrentCloudWorkspaceId, getCurrentCloudWorkspaceScope, runInSystemCloudWorkspaceScope } from '../../src/auth/cloud-workspace-scope';

function workspaceProvider(): 'alibaba_cloud' | 'tencent_cloud' {
  const scope = getCurrentCloudWorkspaceScope();
  return scope && !('system' in scope) ? scope.provider : 'alibaba_cloud';
}

function visibleInWorkspace(record: { cloudWorkspaceId?: string | null; isPlatformManager?: boolean }) {
  const id = getCurrentCloudWorkspaceId();
  return !id || record.cloudWorkspaceId === id || record.isPlatformManager === true;
}

function workspaceRecords<T extends { cloudWorkspaceId?: string | null }>() {
  const records: T[] = [];
  const visible = () => records.filter(visibleInWorkspace);
  const stamp = (record: T) => {
    const id = getCurrentCloudWorkspaceId();
    if (id && record.cloudWorkspaceId !== undefined && record.cloudWorkspaceId !== null && record.cloudWorkspaceId !== id) {
      throw new Error('Resources cannot move between cloud workspaces');
    }
    if (record.cloudWorkspaceId === undefined) record.cloudWorkspaceId = id ?? 'legacy-unbound';
    return record;
  };
  return new Proxy(records, {
    get(target, property) {
      if (property === 'push' || property === 'unshift') return (...items: T[]) => target[property](...items.map(stamp));
      if (property === 'find' || property === 'filter' || property === 'some' || property === 'every' || property === 'findIndex') {
        return (predicate: (record: T, index: number) => boolean) => {
          if (property === 'every') return target.every((record, index) => !visibleInWorkspace(record) || predicate(record, index));
          return target[property]((record, index) => visibleInWorkspace(record) && predicate(record, index));
        };
      }
      if (['map', 'slice', 'sort', 'reduce', 'forEach', 'values', 'entries', 'keys'].includes(String(property))) {
        return (...args: any[]) => (visible() as any)[property](...args);
      }
      if (property === Symbol.iterator) return () => visible()[Symbol.iterator]();
      if (property === 'splice') return (start: number, count: number, ...items: T[]) => {
        if (getCurrentCloudWorkspaceId() && target.slice(start, start + count).some(record => !visibleInWorkspace(record))) {
          throw new Error('Cannot remove data from another cloud workspace');
        }
        return target.splice(start, count, ...items.map(stamp));
      };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function schedulingInstance({ cloudWorkspaceId, id, instanceMode, singleInstanceBatchId, status, lastJobId, ownerUserId, expiresAt }: RangeInstanceRecord) {
  return { cloudWorkspaceId, id, instanceMode, singleInstanceBatchId, status, lastJobId, ownerUserId, expiresAt };
}

export function createMemoryAdminRepository(): AdminRepository {
  const packedImageArtifacts = workspaceRecords<PackedImageArtifactRecord>();
  const packedImageClaims = new Map<string, { token: string; expiresAt: Date }>();
  const platformUsers = workspaceRecords<PlatformUserRecord>();
  const rangeTemplates = workspaceRecords<RangeTemplateRecord>();
  const rangeTemplateVersions = workspaceRecords<RangeTemplateVersionRecord>();
  const singleInstanceBatches = workspaceRecords<SingleInstanceBatchRecord>();
  const rangeInstances = workspaceRecords<RangeInstanceRecord>();
  const provisionJobs = workspaceRecords<ProvisionJobRecord>();
  const provisionJobStepLogs = workspaceRecords<ProvisionJobStepLogRecord>();
  const imageSnapshots = workspaceRecords<CloudImageSnapshotRecord>();
  const imageCatalogItems = workspaceRecords<ImageCatalogItemRecord>();
  const platformImageAssets = workspaceRecords<PlatformImageAssetRecord>();
  const platformImageTags = workspaceRecords<PlatformImageTagRecord>();
  const singleInstanceNetworkProfiles = workspaceRecords<SingleInstanceNetworkProfileRecord>();
  const billingLedgerResources = workspaceRecords<BillingLedgerResourceRecord>();
  const billingLineItems = workspaceRecords<BillingLineItemRecord>();
  const billingAnomalies = workspaceRecords<BillingAnomalyRecord>();
  const cloudResourceDrifts = workspaceRecords<CloudResourceDriftRecord>();
  const operationConfirmations = workspaceRecords<OperationConfirmationRecord>();
  const idempotentOperations = workspaceRecords<IdempotentOperationRecord>();
  const operationAuditEvents = workspaceRecords<OperationAuditEventRecord>();

  let idCounter = 1;
  let singleControlQueue: Promise<unknown> = Promise.resolve();
  const singleBatchProvisionLocks = new Set<string>();

  const nextId = () => `memory-${idCounter++}`;
  const now = () => new Date();
  const clone = <T>(record: T): T => structuredClone(record);
  const cloneIfDefined = <T>(value: T): T => (value == null ? value : structuredClone(value));
  const cloneList = <T extends Record<string, unknown>>(records: T[]): T[] => records.map((record) => clone(record));
  const createJobRecord = (input: CreateProvisionJobInput): ProvisionJobRecord => {
    const record: ProvisionJobRecord = {
      id: nextId(), rangeInstanceId: input.rangeInstanceId, jobType: input.jobType,
      topologySnapshot: cloneIfDefined(input.topologySnapshot ?? null), status: input.status ?? 'pending',
      triggeredBy: input.triggeredBy, startedAt: null, finishedAt: null, retryCount: input.retryCount ?? 0,
      errorSummary: null, createdAt: now(), updatedAt: now(),
      availableAt: clone(input.availableAt ?? now()),
    };
    provisionJobs.unshift(record);
    return record;
  };
  const ownsRangeClaim = (id: string, startedAt: Date) => {
    const job = provisionJobs.find(record => record.id === id && record.status === 'running' && record.startedAt?.getTime() === startedAt.getTime());
    const instance = job && rangeInstances.find(record => record.id === job.rangeInstanceId && record.instanceMode === 'range' && record.lastJobId === id);
    return instance ? { job: job!, instance } : null;
  };

  const assignIfDefined = <T extends Record<string, unknown>, K extends keyof T>(
    target: T,
    key: K,
    value: T[K] | undefined,
  ) => {
    if (value !== undefined) {
      target[key] = value;
    }
  };
  const assignClonedIfDefined = <T extends Record<string, unknown>, K extends keyof T>(
    target: T,
    key: K,
    value: T[K] | undefined,
  ) => {
    if (value !== undefined) {
      target[key] = cloneIfDefined(value);
    }
  };
  const parseDateValue = (value: string | Date) => (value instanceof Date ? new Date(value) : new Date(value));
  const inDateRange = (value: Date, startAt?: string | Date, endAt?: string | Date) => {
    const start = startAt ? parseDateValue(startAt) : null;
    const end = endAt ? parseDateValue(endAt) : null;

    if (start && value < start) {
      return false;
    }

    if (end) {
      const exclusiveEnd = new Date(end);
      exclusiveEnd.setUTCDate(exclusiveEnd.getUTCDate() + 1);

      if (value >= exclusiveEnd) {
        return false;
      }
    }

    return true;
  };

  const matchesImageSnapshotFilter = (
    record: CloudImageSnapshotRecord,
    filter: ListImageSnapshotsFilter,
  ) =>
    (filter.provider === undefined || record.provider === filter.provider) &&
    (filter.accountUid === undefined || record.accountUid === filter.accountUid) &&
    (filter.regionId === undefined || record.regionId === filter.regionId) &&
    (filter.scope === undefined || record.scope === filter.scope) &&
    (filter.imageId === undefined || record.imageId === filter.imageId);

  const matchesImageCatalogItemFilter = (
    record: ImageCatalogItemRecord,
    filter: ListImageCatalogItemsFilter,
  ) =>
    (filter.provider === undefined || record.provider === filter.provider) &&
    (filter.scope === undefined || record.scope === filter.scope) &&
    (filter.accountUid === undefined || record.accountUid === filter.accountUid) &&
    (filter.regionId === undefined || record.regionId === filter.regionId) &&
    (filter.enabled === undefined || record.enabled === filter.enabled);

  const matchesPlatformImageAssetFilter = (
    record: PlatformImageAssetRecord,
    filter: ListPlatformImageAssetsFilter,
  ) =>
    (filter.provider === undefined || record.provider === filter.provider) &&
    (filter.accountUid === undefined || record.accountUid === filter.accountUid) &&
    (filter.accountScopeKey === undefined || record.accountScopeKey === filter.accountScopeKey) &&
    (filter.regionId === undefined || record.regionId === filter.regionId) &&
    (filter.enabled === undefined || record.enabled === filter.enabled) &&
    (filter.imageId === undefined || record.imageId === filter.imageId) &&
    (filter.sourceSnapshotId === undefined || record.sourceSnapshotId === filter.sourceSnapshotId) &&
    (filter.ownerUserId === undefined || record.ownerUserId === filter.ownerUserId) &&
    (filter.visibility === undefined || record.visibility === filter.visibility) &&
    (!filter.onlyAvailableSourceSnapshots ||
      imageSnapshots.some((snapshot) => snapshot.id === record.sourceSnapshotId && snapshot.isAvailable));

  const findPlatformUserOrThrow = (id: string) => {
    const record = platformUsers.find((user) => user.id === id);

    if (!record) {
      throw new Error(`Platform user not found: ${id}`);
    }

    return record;
  };

  const assertPlatformUserUnique = (
    input: { id?: string; username?: string; loginUsername?: string; cloudWorkspaceId?: string | null; isPlatformManager?: boolean; oidcIssuer?: string | null; oidcSubject?: string | null },
    ignoreId?: string,
  ) => {
    const cloudWorkspaceId = input.isPlatformManager ? null : input.cloudWorkspaceId ?? getCurrentCloudWorkspaceId() ?? 'legacy-unbound';
    if (input.loginUsername && runInSystemCloudWorkspaceScope(() => platformUsers.some(user => user.loginUsername === input.loginUsername && user.id !== ignoreId))) throw new Error('Platform user unique constraint failed: loginUsername');
    if (
      input.id !== undefined &&
      runInSystemCloudWorkspaceScope(() => platformUsers.some((user) => user.id === input.id && user.id !== ignoreId))
    ) {
      throw new Error(`Platform user unique constraint failed: id (${input.id})`);
    }

    if (
      input.username !== undefined &&
      runInSystemCloudWorkspaceScope(() => platformUsers.some((user) => user.username === input.username && user.cloudWorkspaceId === cloudWorkspaceId && user.id !== ignoreId))
    ) {
      throw new Error(`Platform user unique constraint failed: username (${input.username})`);
    }

    if (
      input.oidcIssuer != null &&
      input.oidcSubject != null &&
      runInSystemCloudWorkspaceScope(() => platformUsers.some(
        (user) =>
          user.oidcIssuer === input.oidcIssuer &&
          user.oidcSubject === input.oidcSubject &&
          user.id !== ignoreId,
      ))
    ) {
      throw new Error(`Platform user unique constraint failed: oidc identity (${input.oidcIssuer}, ${input.oidcSubject})`);
    }
  };

  const findPlatformImageAssetOrThrow = (id: string) => {
    const record = platformImageAssets.find((asset) => asset.id === id);

    if (!record) {
      throw new Error(`Platform image asset not found: ${id}`);
    }

    return record;
  };

  const repository: AdminRepository = {
    async createPlatformUser(input: CreatePlatformUserInput) {
      assertPlatformUserUnique({
        id: input.id,
        username: input.username,
        loginUsername: input.loginUsername ?? input.username,
        cloudWorkspaceId: input.cloudWorkspaceId,
        isPlatformManager: input.isPlatformManager,
      });

      const record: PlatformUserRecord = {
        id: input.id,
        username: input.username,
        loginUsername: input.loginUsername ?? input.username,
        cloudWorkspaceId: input.isPlatformManager ? null : input.cloudWorkspaceId ?? getCurrentCloudWorkspaceId() ?? 'legacy-unbound',
        isPlatformManager: input.isPlatformManager ?? false,
        selectedCloudWorkspaceId: input.selectedCloudWorkspaceId ?? null,
        passwordHash: input.passwordHash,
        oidcIssuer: input.oidcIssuer ?? null,
        oidcSubject: input.oidcSubject ?? null,
        role: input.role,
        status: input.status ?? 'active',
        createdAt: now(),
        updatedAt: now(),
      };

      platformUsers.unshift(record);

      return clone(record);
    },
    async listPlatformUsers() {
      return cloneList(platformUsers.filter(user => !user.isPlatformManager));
    },
    async getPlatformUserById(id: string) {
      const record = platformUsers.find((user) => user.id === id);

      return record ? clone(record) : null;
    },
    async getPlatformUserByUsername(username: string) {
      const record = platformUsers.find((user) => user.username === username && (!getCurrentCloudWorkspaceId() || !user.isPlatformManager));

      return record ? clone(record) : null;
    },
    async getPlatformUserByOidcIdentity(issuer: string, subject: string) {
      const record = platformUsers.find((user) => user.oidcIssuer === issuer && user.oidcSubject === subject);

      return record ? clone(record) : null;
    },
    async updatePlatformUser(id: string, input: UpdatePlatformUserInput) {
      const record = findPlatformUserOrThrow(id);

      const oidcIssuer = input.oidcIssuer !== undefined ? input.oidcIssuer : record.oidcIssuer;
      const oidcSubject = input.oidcSubject !== undefined ? input.oidcSubject : record.oidcSubject;

      assertPlatformUserUnique(
        {
          username: input.username,
          loginUsername: input.loginUsername,
          cloudWorkspaceId: record.cloudWorkspaceId,
          isPlatformManager: record.isPlatformManager,
          oidcIssuer,
          oidcSubject,
        },
        id,
      );

      Object.assign(record, {
        username: input.username ?? record.username,
        loginUsername: input.loginUsername ?? record.loginUsername,
        selectedCloudWorkspaceId: input.selectedCloudWorkspaceId !== undefined ? input.selectedCloudWorkspaceId : record.selectedCloudWorkspaceId,
        passwordHash: input.passwordHash ?? record.passwordHash,
        oidcIssuer,
        oidcSubject,
        role: input.role ?? record.role,
        status: input.status ?? record.status,
        updatedAt: now(),
      });

      return clone(record);
    },
    async countActiveAdmins() {
      return platformUsers.filter((user) => !user.isPlatformManager && user.role === 'admin' && user.status === 'active').length;
    },
    async createOperationConfirmation(input: CreateOperationConfirmationInput) {
      const record: OperationConfirmationRecord = {
        id: nextId(),
        ...clone(input),
        consumedAt: null,
        createdAt: now(),
      };
      operationConfirmations.unshift(record);
      return clone(record);
    },
    async getOperationConfirmationById(id: string) {
      const record = operationConfirmations.find((item) => item.id === id);
      return record ? clone(record) : null;
    },
    async consumeOperationConfirmation(id: string, consumedAt: Date) {
      const record = operationConfirmations.find((item) => item.id === id);
      if (!record || record.consumedAt || record.expiresAt <= consumedAt) {
        return null;
      }
      record.consumedAt = new Date(consumedAt);
      return clone(record);
    },
    async createIdempotentOperation(input: CreateIdempotentOperationInput) {
      if (idempotentOperations.some((item) => item.actorUserId === input.actorUserId && item.toolName === input.toolName && item.idempotencyKey === input.idempotencyKey)) {
        throw new Error('Idempotent operation unique constraint failed');
      }
      const record: IdempotentOperationRecord = {
        id: nextId(),
        ...clone(input),
        status: 'accepted',
        result: null,
        errorCode: null,
        createdAt: now(),
        updatedAt: now(),
      };
      idempotentOperations.unshift(record);
      return clone(record);
    },
    async getIdempotentOperation(actorUserId: string, toolName: string, idempotencyKey: string) {
      const record = idempotentOperations.find((item) => item.actorUserId === actorUserId && item.toolName === toolName && item.idempotencyKey === idempotencyKey);
      return record ? clone(record) : null;
    },
    async getIdempotentOperationByOperationId(operationId: string) {
      const record = idempotentOperations.find((item) => item.operationId === operationId);
      return record ? clone(record) : null;
    },
    async updateIdempotentOperation(id: string, input: UpdateIdempotentOperationInput) {
      const record = idempotentOperations.find((item) => item.id === id);
      if (!record) {
        throw new Error(`Idempotent operation not found: ${id}`);
      }
      Object.assign(record, clone(input), { updatedAt: now() });
      return clone(record);
    },
    async appendOperationAuditEvent(input: OperationAuditEventInput) {
      const record: OperationAuditEventRecord = {
        id: nextId(),
        operationId: input.operationId,
        requestId: input.requestId,
        actorUserId: input.actorUserId,
        source: input.source,
        oauthClientId: input.oauthClientId ?? null,
        toolName: input.toolName,
        phase: input.phase,
        targetType: input.targetType ?? null,
        targetId: input.targetId ?? null,
        sanitizedInput: cloneIfDefined(input.sanitizedInput ?? null),
        jobId: input.jobId ?? null,
        errorCode: input.errorCode ?? null,
        durationMs: input.durationMs ?? null,
        createdAt: now(),
      };
      operationAuditEvents.unshift(record);
      return clone(record);
    },
    async getDispatchedOperationByJobId(jobId: string) {
      const record = operationAuditEvents.find((item) => item.jobId === jobId && item.phase === 'dispatched');
      return record ? clone(record) : null;
    },
    async listRangeTemplates() {
      return cloneList(rangeTemplates);
    },
    async createRangeTemplate(input: CreateRangeTemplateInput) {
      const draftVersion: RangeTemplateVersionRecord = {
        id: nextId(),
        templateId: '',
        version: input.version,
        status: 'draft',
        modulePathOrRef: input.modulePathOrRef,
        topologySpec: clone(input.topologySpec),
        topologyGraph: cloneIfDefined(input.topologyGraph),
        scenarioTemplateSpec: cloneIfDefined(input.scenarioTemplateSpec),
        compiledProvisionSpec: cloneIfDefined(input.compiledProvisionSpec),
        compiledSpec: cloneIfDefined(input.compiledSpec),
        variableSchema: clone(input.variableSchema ?? {}),
        outputSchema: clone(input.outputSchema ?? {}),
        defaultNetworkPolicy: cloneIfDefined(input.defaultNetworkPolicy ?? null),
        createdAt: now(),
        updatedAt: now(),
      };

      const record: RangeTemplateRecord = {
        id: nextId(),
        name: input.name,
        createdBy: input.createdBy ?? 'admin',
        ownerUserId: input.ownerUserId ?? null,
        description: input.description ?? null,
        slug: input.slug,
        version: input.version,
        cloudProvider: input.cloudProvider ?? workspaceProvider(),
        iacType: input.iacType ?? 'opentofu',
        modulePathOrRef: input.modulePathOrRef,
        topologySpec: clone(input.topologySpec),
        topologyGraph: cloneIfDefined(input.topologyGraph),
        scenarioTemplateSpec: cloneIfDefined(input.scenarioTemplateSpec),
        compiledProvisionSpec: cloneIfDefined(input.compiledProvisionSpec),
        compiledSpec: cloneIfDefined(input.compiledSpec),
        variableSchema: clone(input.variableSchema ?? {}),
        outputSchema: clone(input.outputSchema ?? {}),
        defaultNetworkPolicy: cloneIfDefined(input.defaultNetworkPolicy ?? null),
        visibility: input.visibility ?? 'private',
        revision: 1,
        currentDraftVersionId: draftVersion.id,
        currentPublishedVersionId: null,
        currentDraftVersion: null,
        currentPublishedVersion: null,
        versions: [],
        createdAt: now(),
        updatedAt: now(),
      };

      draftVersion.templateId = record.id;
      record.currentDraftVersion = clone(draftVersion);
      record.versions = [clone(draftVersion)];

      rangeTemplateVersions.unshift(draftVersion);
      rangeTemplates.unshift(record);

      return clone(record);
    },
    async getRangeTemplateById(id: string) {
      const record = rangeTemplates.find((template) => template.id === id);

      return record ? clone(record) : null;
    },
    async getRangeTemplateVersionById(id: string) {
      const record = rangeTemplateVersions.find((version) => version.id === id);

      return record ? clone(record) : null;
    },
    async updateRangeTemplateMetadata(id, input) {
      const record = rangeTemplates.find((template) => template.id === id)!;

      if (record.revision !== input.expectedRevision) {
        throw new TemplateRevisionConflictError();
      }

      const changed =
        (input.name !== undefined && input.name !== record.name) ||
        (input.description !== undefined && input.description !== record.description);

      if (changed) {
        assignIfDefined(record, 'name', input.name);
        assignIfDefined(record, 'description', input.description);
        record.revision += 1;
        record.updatedAt = now();
      }

      return clone(record);
    },
    async saveRangeTemplateTopology(id, input) {
      const record = rangeTemplates.find((template) => template.id === id)!;

      if (record.revision !== input.expectedRevision) {
        throw new TemplateRevisionConflictError();
      }

      const draftVersion = rangeTemplateVersions.find((item) => item.id === record.currentDraftVersionId)!;
      const topologyChanged =
        JSON.stringify(draftVersion.topologySpec) !== JSON.stringify(input.topologySpec) ||
        JSON.stringify(draftVersion.topologyGraph) !== JSON.stringify(input.topologyGraph) ||
        JSON.stringify(draftVersion.scenarioTemplateSpec) !== JSON.stringify(input.scenarioTemplateSpec) ||
        JSON.stringify(draftVersion.compiledProvisionSpec) !== JSON.stringify(input.compiledProvisionSpec) ||
        JSON.stringify(draftVersion.compiledSpec) !== JSON.stringify(input.compiledSpec);

      if (topologyChanged) {
        Object.assign(draftVersion, {
          topologySpec: clone(input.topologySpec),
          topologyGraph: clone(input.topologyGraph),
          scenarioTemplateSpec: clone(input.scenarioTemplateSpec),
          compiledProvisionSpec: clone(input.compiledProvisionSpec),
          compiledSpec: clone(input.compiledSpec),
          updatedAt: now(),
        });

        const publishedVersion = record.currentPublishedVersionId
          ? rangeTemplateVersions.find((item) => item.id === record.currentPublishedVersionId) ?? null
          : null;
        if (publishedVersion) {
          publishedVersion.status = 'archived';
          publishedVersion.updatedAt = now();
        }

        Object.assign(record, {
          topologySpec: clone(input.topologySpec),
          topologyGraph: clone(input.topologyGraph),
          scenarioTemplateSpec: clone(input.scenarioTemplateSpec),
          compiledProvisionSpec: clone(input.compiledProvisionSpec),
          compiledSpec: clone(input.compiledSpec),
          visibility: 'private',
          currentPublishedVersionId: null,
          currentPublishedVersion: null,
          currentDraftVersion: clone(draftVersion),
          revision: record.revision + 1,
          updatedAt: now(),
        });
        record.versions = cloneList(rangeTemplateVersions.filter((item) => item.templateId === record.id));
      }

      return clone(record);
    },
    async syncRangeInstanceDraftToTemplate(input) {
      const instance = rangeInstances.find((record) => record.id === input.rangeInstanceId);

      if (
        !instance ||
        instance.status !== 'running' ||
        !instance.templateId ||
        instance.draftRevision !== input.expectedDraftRevision ||
        !instance.draftTopologyGraph ||
        !instance.draftTopologySpec ||
        !instance.draftScenarioTemplateSpec ||
        !instance.draftCompiledProvisionSpec
      ) {
        return null;
      }

      const template = rangeTemplates.find((record) => record.id === instance.templateId);

      if (
        !template ||
        template.revision !== input.expectedTemplateRevision ||
        !template.currentDraftVersionId
      ) {
        return null;
      }

      const draftVersion = rangeTemplateVersions.find((item) => item.id === template.currentDraftVersionId);

      if (!draftVersion) {
        return null;
      }

      const topologyChanged =
        JSON.stringify(draftVersion.topologySpec) !== JSON.stringify(input.topology.topologySpec) ||
        JSON.stringify(draftVersion.topologyGraph) !== JSON.stringify(input.topology.topologyGraph) ||
        JSON.stringify(draftVersion.scenarioTemplateSpec) !== JSON.stringify(input.topology.scenarioTemplateSpec) ||
        JSON.stringify(draftVersion.compiledProvisionSpec) !== JSON.stringify(input.topology.compiledProvisionSpec) ||
        JSON.stringify(draftVersion.compiledSpec) !== JSON.stringify(input.topology.compiledSpec);

      if (topologyChanged) {
        Object.assign(draftVersion, {
          topologySpec: clone(input.topology.topologySpec),
          topologyGraph: clone(input.topology.topologyGraph),
          scenarioTemplateSpec: clone(input.topology.scenarioTemplateSpec),
          compiledProvisionSpec: clone(input.topology.compiledProvisionSpec),
          compiledSpec: clone(input.topology.compiledSpec),
          updatedAt: now(),
        });

        Object.assign(template, {
          topologySpec: clone(input.topology.topologySpec),
          topologyGraph: clone(input.topology.topologyGraph),
          scenarioTemplateSpec: clone(input.topology.scenarioTemplateSpec),
          compiledProvisionSpec: clone(input.topology.compiledProvisionSpec),
          compiledSpec: clone(input.topology.compiledSpec),
          currentDraftVersion: clone(draftVersion),
          revision: template.revision + 1,
          updatedAt: now(),
        });
        template.versions = cloneList(rangeTemplateVersions.filter((item) => item.templateId === template.id));
      }

      return clone(template);
    },
    async publishRangeTemplateToPlatform(id, expectedRevision) {
      const record = rangeTemplates.find((template) => template.id === id)!;

      if (record.revision !== expectedRevision) {
        throw new TemplateRevisionConflictError();
      }

      if (record.currentPublishedVersionId && record.visibility === 'platform') {
        return clone(record);
      }

      if (!record.currentPublishedVersionId) {
        const currentDraft = rangeTemplateVersions.find((item) => item.id === record.currentDraftVersionId)!;
        rangeTemplateVersions
          .filter((item) => item.templateId === id && item.status === 'published')
          .forEach((item) => {
            item.status = 'archived';
            item.updatedAt = now();
          });
        currentDraft.status = 'published';
        currentDraft.updatedAt = now();

        const nextDraft: RangeTemplateVersionRecord = {
          ...clone(currentDraft),
          id: nextId(),
          status: 'draft',
          createdAt: now(),
          updatedAt: now(),
        };
        rangeTemplateVersions.unshift(nextDraft);
        Object.assign(record, {
          currentPublishedVersionId: currentDraft.id,
          currentDraftVersionId: nextDraft.id,
          currentPublishedVersion: clone(currentDraft),
          currentDraftVersion: clone(nextDraft),
        });
      }

      record.visibility = 'platform';
      record.revision += 1;
      record.updatedAt = now();
      record.versions = cloneList(rangeTemplateVersions.filter((item) => item.templateId === record.id));
      return clone(record);
    },
    async unshareRangeTemplate(id, expectedRevision) {
      const record = rangeTemplates.find((template) => template.id === id)!;

      if (record.revision !== expectedRevision) {
        throw new TemplateRevisionConflictError();
      }

      if (record.visibility === 'private') {
        return clone(record);
      }

      record.visibility = 'private';
      record.revision += 1;
      record.updatedAt = now();
      return clone(record);
    },
    async deleteRangeTemplate(id: string) {
      const index = rangeTemplates.findIndex((template) => template.id === id);

      if (index >= 0) {
        rangeTemplates.splice(index, 1);
      }

      for (let i = rangeTemplateVersions.length - 1; i >= 0; i -= 1) {
        if (visibleInWorkspace(rangeTemplateVersions[i]) && rangeTemplateVersions[i].templateId === id) {
          rangeTemplateVersions.splice(i, 1);
        }
      }
    },
    async createSingleInstanceBatch(input: CreateSingleInstanceBatchInput) {
      const timestamp = now();
      const record: SingleInstanceBatchRecord = {
        id: nextId(),
        name: input.name,
        platformImageAssetId: input.platformImageAssetId,
        imageId: input.imageId,
        imageDisplayName: input.imageDisplayName,
        cpu: input.cpu,
        memory: input.memory,
        systemDiskSize: input.systemDiskSize,
        quantity: input.quantity,
        remark: input.remark ?? null,
        createdBy: input.createdBy ?? null,
        ownerUserId: input.ownerUserId ?? null,
        expiresAt: input.expiresAt ?? null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      singleInstanceBatches.unshift(record);

      return clone(record);
    },
    async getSingleInstanceBatchById(id: string) {
      const record = singleInstanceBatches.find((batch) => batch.id === id);

      return record ? clone(record) : null;
    },
    async listSingleInstanceBatchesWithInstances() {
      return cloneList(
        singleInstanceBatches.map((batch) => ({
          batch,
          instances: rangeInstances.filter((instance) => instance.singleInstanceBatchId === batch.id),
        })),
      );
    },
    async getSingleInstanceBatchWithInstancesById(id: string) {
      const batch = singleInstanceBatches.find(value => value.id === id);
      return batch ? clone({ batch, instances: rangeInstances.filter(value => value.singleInstanceBatchId === id)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id)) }) : null;
    },
    async listRangeInstances() {
      return cloneList(rangeInstances);
    },
    async listProvisioningInstancesByIds(ids: string[]) {
      const selected = new Set(ids);
      return cloneList(rangeInstances.filter(value => selected.has(value.id)).map(schedulingInstance));
    },
    async listExpiredRangeInstances(timestamp: Date) {
      return cloneList(rangeInstances.filter(value => value.expiresAt && value.expiresAt <= timestamp
        && (value.instanceMode === 'single' && ['running', 'creating'].includes(value.status)
          || value.instanceMode === 'range' && value.status === 'running'))
        .sort((a, b) => a.expiresAt!.getTime() - b.expiresAt!.getTime() || a.id.localeCompare(b.id)).map(schedulingInstance));
    },
    async archiveDestroyedRangeInstancesForDeletedTemplate(template) {
      for (const instance of rangeInstances) {
        if (instance.templateId !== template.id || instance.status !== 'destroyed') {
          continue;
        }

        instance.templateId = null;
        instance.sourceTemplateVersionId = null;
        instance.templateNameSnapshot = template.name;
        instance.templateSlugSnapshot = template.slug;
        instance.templateVersionSnapshot = template.version;
        instance.templateModulePathSnapshot = template.modulePathOrRef;
        instance.updatedAt = now();
      }
    },
    async createRangeInstance(input: CreateRangeInstanceInput, initialJob?: { triggeredBy: string; topologySnapshot: ProvisionJobTopologySnapshot; expectedTemplateRevision?: number }) {
      if (initialJob?.expectedTemplateRevision !== undefined && input.templateId
        && rangeTemplates.find(template => template.id === input.templateId)?.revision !== initialJob.expectedTemplateRevision) {
        throw new TemplateRevisionConflictError();
      }
      const record: RangeInstanceRecord = {
        id: nextId(),
        name: input.name,
        createdBy: input.createdBy ?? 'admin',
        ownerUserId: input.ownerUserId ?? null,
        instanceMode: input.instanceMode ?? 'range',
        singleInstanceBatchId: input.singleInstanceBatchId ?? null,
        singleInstanceConfig: cloneIfDefined(input.singleInstanceConfig ?? null),
        templateId: input.templateId ?? null,
        sourceTemplateVersionId: input.sourceTemplateVersionId ?? null,
        templateNameSnapshot: input.templateNameSnapshot ?? null,
        templateSlugSnapshot: input.templateSlugSnapshot ?? null,
        templateVersionSnapshot: input.templateVersionSnapshot ?? null,
        templateModulePathSnapshot: input.templateModulePathSnapshot ?? null,
        runtimeTopologyGraph: cloneIfDefined(input.runtimeTopologyGraph ?? null),
        runtimeScenarioTemplateSpec: cloneIfDefined(input.runtimeScenarioTemplateSpec ?? null),
        runtimeCompiledProvisionSpec: cloneIfDefined(input.runtimeCompiledProvisionSpec ?? null),
        runtimeCredentials: cloneIfDefined(input.runtimeCredentials ?? null),
        draftTopologyGraph: cloneIfDefined(input.draftTopologyGraph ?? null),
        draftTopologySpec: cloneIfDefined(input.draftTopologySpec ?? null),
        draftScenarioTemplateSpec: cloneIfDefined(input.draftScenarioTemplateSpec ?? null),
        draftCompiledProvisionSpec: cloneIfDefined(input.draftCompiledProvisionSpec ?? null),
        draftRevision: input.draftRevision ?? 0,
        draftUpdatedBy: input.draftUpdatedBy ?? null,
        draftUpdatedAt: input.draftUpdatedAt ?? null,
        status: input.status ?? 'draft',
        allocatedCidr: input.allocatedCidr ?? null,
        cloudProvider: input.cloudProvider ?? workspaceProvider(),
        accessEntry: cloneIfDefined(input.accessEntry ?? null),
        resourceSummary: cloneIfDefined(input.resourceSummary ?? null),
        errorSummary: input.errorSummary ?? null,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        lastJobId: input.lastJobId ?? null,
        createdAt: now(),
        updatedAt: now(),
      };

      rangeInstances.unshift(record);
      if (initialJob) {
        const job = createJobRecord({ rangeInstanceId: record.id, jobType: 'create', ...initialJob });
        record.lastJobId = job.id;
      }

      return clone(record);
    },
    async getRangeInstanceById(id: string) {
      const record = rangeInstances.find((instance) => instance.id === id);

      return record ? clone(record) : null;
    },
    async updateRangeInstance(id: string, input: UpdateRangeInstanceInput) {
      const record = rangeInstances.find((instance) => instance.id === id)!;

      Object.assign(record, {
        name: input.name ?? record.name,
        createdBy: input.createdBy !== undefined ? input.createdBy : record.createdBy,
        ownerUserId: input.ownerUserId !== undefined ? input.ownerUserId : record.ownerUserId,
        instanceMode: input.instanceMode ?? record.instanceMode,
        singleInstanceBatchId:
          input.singleInstanceBatchId !== undefined ? input.singleInstanceBatchId : record.singleInstanceBatchId,
        singleInstanceConfig:
          input.singleInstanceConfig !== undefined
            ? cloneIfDefined(input.singleInstanceConfig)
            : record.singleInstanceConfig,
        sourceTemplateVersionId:
          input.sourceTemplateVersionId !== undefined ? input.sourceTemplateVersionId : record.sourceTemplateVersionId,
        runtimeTopologyGraph:
          input.runtimeTopologyGraph !== undefined ? cloneIfDefined(input.runtimeTopologyGraph) : record.runtimeTopologyGraph,
        runtimeScenarioTemplateSpec:
          input.runtimeScenarioTemplateSpec !== undefined
            ? cloneIfDefined(input.runtimeScenarioTemplateSpec)
            : record.runtimeScenarioTemplateSpec,
        runtimeCompiledProvisionSpec:
          input.runtimeCompiledProvisionSpec !== undefined
            ? cloneIfDefined(input.runtimeCompiledProvisionSpec)
            : record.runtimeCompiledProvisionSpec,
        runtimeCredentials:
          input.runtimeCredentials !== undefined ? cloneIfDefined(input.runtimeCredentials) : record.runtimeCredentials,
        draftTopologyGraph:
          input.draftTopologyGraph !== undefined ? cloneIfDefined(input.draftTopologyGraph) : record.draftTopologyGraph,
        draftTopologySpec:
          input.draftTopologySpec !== undefined ? cloneIfDefined(input.draftTopologySpec) : record.draftTopologySpec,
        draftScenarioTemplateSpec:
          input.draftScenarioTemplateSpec !== undefined
            ? cloneIfDefined(input.draftScenarioTemplateSpec)
            : record.draftScenarioTemplateSpec,
        draftCompiledProvisionSpec:
          input.draftCompiledProvisionSpec !== undefined
            ? cloneIfDefined(input.draftCompiledProvisionSpec)
            : record.draftCompiledProvisionSpec,
        draftRevision: input.draftRevision !== undefined ? input.draftRevision : record.draftRevision,
        draftUpdatedBy: input.draftUpdatedBy !== undefined ? input.draftUpdatedBy : record.draftUpdatedBy,
        draftUpdatedAt: input.draftUpdatedAt !== undefined ? input.draftUpdatedAt : record.draftUpdatedAt,
        status: input.status ?? record.status,
        allocatedCidr: input.allocatedCidr !== undefined ? input.allocatedCidr : record.allocatedCidr,
        accessEntry: input.accessEntry !== undefined ? cloneIfDefined(input.accessEntry) : record.accessEntry,
        resourceSummary: input.resourceSummary !== undefined ? cloneIfDefined(input.resourceSummary) : record.resourceSummary,
        errorSummary: input.errorSummary !== undefined ? input.errorSummary : record.errorSummary,
        expiresAt: input.expiresAt !== undefined ? input.expiresAt : record.expiresAt,
        lastJobId: input.lastJobId !== undefined ? input.lastJobId : record.lastJobId,
        updatedAt: now(),
      });

      return clone(record);
    },
    async saveRangeInstanceDraft(id: string, expectedDraftRevision: number, input: SaveRangeInstanceDraftInput) {
      const record = rangeInstances.find((instance) => instance.id === id);

      if (
        !record ||
        record.status !== 'running' ||
        (record.draftRevision ?? 0) !== expectedDraftRevision
      ) {
        return null;
      }

      Object.assign(record, {
        draftTopologyGraph: cloneIfDefined(input.draftTopologyGraph),
        draftTopologySpec: cloneIfDefined(input.draftTopologySpec),
        draftScenarioTemplateSpec: cloneIfDefined(input.draftScenarioTemplateSpec),
        draftCompiledProvisionSpec: cloneIfDefined(input.draftCompiledProvisionSpec),
        draftUpdatedBy: input.draftUpdatedBy,
        draftUpdatedAt: input.draftUpdatedAt,
        draftRevision: (record.draftRevision ?? 0) + 1,
        updatedAt: now(),
      });

      return clone(record);
    },
    async discardRangeInstanceDraft(id: string, expectedDraftRevision: number) {
      const record = rangeInstances.find((instance) => instance.id === id);

      if (
        !record ||
        record.status !== 'running' ||
        (record.draftRevision ?? 0) !== expectedDraftRevision
      ) {
        return null;
      }

      Object.assign(record, {
        draftTopologyGraph: null,
        draftTopologySpec: null,
        draftScenarioTemplateSpec: null,
        draftCompiledProvisionSpec: null,
        draftUpdatedBy: null,
        draftUpdatedAt: null,
        draftRevision: (record.draftRevision ?? 0) + 1,
        updatedAt: now(),
      });

      return clone(record);
    },
    async applyRangeInstanceDraft(input: ApplyRangeInstanceDraftInput) {
      const instance = rangeInstances.find((record) => record.id === input.rangeInstanceId);

      if (
        !instance ||
        instance.status !== 'running' ||
        instance.draftRevision !== input.expectedDraftRevision ||
        !instance.draftTopologyGraph ||
        !instance.draftTopologySpec ||
        !instance.draftScenarioTemplateSpec ||
        !instance.draftCompiledProvisionSpec
      ) {
        return null;
      }

      if (
        provisionJobs.some(
          (job) =>
            job.rangeInstanceId === input.rangeInstanceId &&
            (job.status === 'pending' || job.status === 'running'),
        )
      ) {
        return null;
      }

      const job: ProvisionJobRecord = {
        id: nextId(),
        rangeInstanceId: input.rangeInstanceId,
        jobType: 'update',
        topologySnapshot: clone(input.topologySnapshot),
        status: 'pending',
        triggeredBy: input.triggeredBy,
        startedAt: null,
        finishedAt: null,
        retryCount: 0,
        errorSummary: null,
        createdAt: now(),
        updatedAt: now(),
      };

      provisionJobs.unshift(job);
      instance.lastJobId = job.id;
      instance.errorSummary = null;
      instance.updatedAt = now();

      return clone(job);
    },
    async completeRangeInstanceDraftApply(id: string, input: CompleteRangeInstanceDraftApplyInput) {
      if (input.provisionJobId && input.claimStartedAt && !ownsRangeClaim(input.provisionJobId, input.claimStartedAt)) {
        throw new RangeInstanceDraftRevisionConflictError();
      }
      const instance = rangeInstances.find((record) => record.id === id)!;
      const shouldClearDraft = instance.draftRevision === input.expectedDraftRevision;

      Object.assign(instance, {
        runtimeTopologyGraph: clone(input.runtimeTopologyGraph),
        runtimeScenarioTemplateSpec: clone(input.runtimeScenarioTemplateSpec),
        runtimeCompiledProvisionSpec: clone(input.runtimeCompiledProvisionSpec),
        ...(input.runtimeCredentials !== undefined ? { runtimeCredentials: clone(input.runtimeCredentials) } : {}),
        accessEntry: cloneIfDefined(input.accessEntry ?? null),
        resourceSummary: cloneIfDefined(input.resourceSummary ?? null),
        errorSummary: input.errorSummary ?? null,
        ...(shouldClearDraft
          ? {
              draftTopologyGraph: null,
              draftTopologySpec: null,
              draftScenarioTemplateSpec: null,
              draftCompiledProvisionSpec: null,
              draftUpdatedBy: null,
              draftUpdatedAt: null,
              draftRevision: (instance.draftRevision ?? 0) + 1,
            }
          : {}),
        updatedAt: now(),
      });

      return clone(instance);
    },
    async listProvisionJobs() {
      return cloneList(provisionJobs);
    },
    async listPendingProvisionJobs(input: ListPendingProvisionJobsInput = {}) {
      const limit = input.limit ?? 100;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new RangeError('Pending job page size must be between 1 and 1000');
      const timestamp = input.now ?? now();
      return cloneList(provisionJobs.filter(value => value.status === 'pending' && (value.availableAt ?? value.createdAt) <= timestamp && (!input.after
        || value.createdAt > input.after.createdAt || value.createdAt.getTime() === input.after.createdAt.getTime() && value.id > input.after.id))
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id)).slice(0, limit)
        .map(({ cloudWorkspaceId, id, rangeInstanceId, jobType, status, createdAt }) => ({ cloudWorkspaceId, id, rangeInstanceId, jobType, status, createdAt })));
    },
    async createProvisionJob(input: CreateProvisionJobInput) {
      return clone(createJobRecord(input));
    },
    async queueRangeInstanceJob(input: QueueRangeInstanceJobInput) {
      const instance = rangeInstances.find(record => record.id === input.rangeInstanceId && record.instanceMode === 'range'
        && record.status === input.expectedStatus && record.ownerUserId === input.expectedOwnerUserId);
      if (!instance || provisionJobs.some(job => job.rangeInstanceId === input.rangeInstanceId && ['pending', 'running'].includes(job.status))) return null;
      const job = createJobRecord(input);
      Object.assign(instance, { status: input.nextStatus, lastJobId: job.id, errorSummary: null, updatedAt: now(),
        ...(input.allocatedCidr !== undefined ? { allocatedCidr: input.allocatedCidr } : {}),
      });
      return clone(job);
    },
    async claimRangeProvisionJob(id: string, startedAt: Date) {
      const job = provisionJobs.find(record => record.id === id && record.status === 'pending');
      const instance = job && rangeInstances.find(record => record.id === job.rangeInstanceId && record.instanceMode === 'range');
      if (!job || !instance) return null;
      if (instance.lastJobId && instance.lastJobId !== id) {
        Object.assign(job, { status: 'cancelled', finishedAt: startedAt, errorSummary: 'Superseded by the current range operation' });
        return null;
      }
      if (job.jobType === 'update' && instance.status !== 'running'
        || (job.jobType === 'create' || job.topologySnapshot?.operation === 'create')
          && ['pending_destroy', 'destroying', 'destroy_failed', 'destroyed'].includes(instance.status)) {
        Object.assign(job, { status: 'cancelled', finishedAt: startedAt, errorSummary: 'Range operation is incompatible with the current instance state' });
        return null;
      }
      if (instance.lastJobId === id) {
        provisionJobs.filter(other => other.rangeInstanceId === instance.id && other.id !== id && other.status === 'pending')
          .forEach(other => Object.assign(other, { status: 'cancelled', finishedAt: startedAt, errorSummary: 'Superseded by the current range operation' }));
      }
      if (provisionJobs.some(other => other.rangeInstanceId === instance.id && other.id !== id && ['pending', 'running'].includes(other.status))) return null;
      Object.assign(job, { status: 'running', startedAt, finishedAt: null, errorSummary: null, updatedAt: now() });
      instance.lastJobId = id;
      return clone(job);
    },
    async heartbeatRangeProvisionJob(id: string, startedAt: Date, heartbeatAt: Date) {
      const owned = ownsRangeClaim(id, startedAt);
      if (!owned) return false;
      owned.job.updatedAt = heartbeatAt;
      return true;
    },
    async updateRangeInstanceForProvisionJob(id: string, startedAt: Date, input: UpdateRangeInstanceInput) {
      const owned = ownsRangeClaim(id, startedAt);
      if (!owned) return null;
      return this.updateRangeInstance(owned.instance.id, input);
    },
    async updateRangeProvisionJob(id: string, startedAt: Date, input: UpdateProvisionJobInput) {
      const owned = ownsRangeClaim(id, startedAt);
      if (!owned) return false;
      Object.assign(owned.job, input, { updatedAt: now() });
      return true;
    },
    async getProvisionJobById(id: string) {
      const record = provisionJobs.find((job) => job.id === id);

      return record ? clone(record) : null;
    },
    async claimProvisionJob(id: string, startedAt: Date) {
      const record = provisionJobs.find((job) => job.id === id && job.status === 'pending');

      if (!record) {
        return null;
      }

      Object.assign(record, {
        status: 'running',
        startedAt,
        finishedAt: null,
        errorSummary: null,
        updatedAt: now(),
      });

      return clone(record);
    },
    async heartbeatProvisionJob(id: string, startedAt: Date, heartbeatAt: Date) {
      const record = provisionJobs.find((job) =>
        job.id === id && job.status === 'running' && job.startedAt?.getTime() === startedAt.getTime(),
      );

      if (!record) {
        return false;
      }

      record.updatedAt = heartbeatAt;
      return true;
    },
    async requeueInterruptedProvisionJobs(staleBefore: Date) {
      const interruptedJobs = provisionJobs.filter(
        (job) => job.status === 'running' && job.updatedAt <= staleBefore,
      );

      for (const job of interruptedJobs) {
        Object.assign(job, {
          status: 'pending',
          startedAt: null,
          finishedAt: null,
          errorSummary: null,
          retryCount: job.retryCount + 1,
          updatedAt: now(),
        });
      }

      return interruptedJobs.length;
    },
    async updateProvisionJob(id: string, input: UpdateProvisionJobInput) {
      const record = provisionJobs.find((job) => job.id === id)!;

      Object.assign(record, {
        status: input.status ?? record.status,
        startedAt: input.startedAt !== undefined ? input.startedAt : record.startedAt,
        finishedAt: input.finishedAt !== undefined ? input.finishedAt : record.finishedAt,
        retryCount: input.retryCount ?? record.retryCount,
        errorSummary: input.errorSummary !== undefined ? input.errorSummary : record.errorSummary,
        updatedAt: now(),
      });

      return clone(record);
    },
    async listProvisionJobStepLogs(jobId: string) {
      return cloneList(provisionJobStepLogs.filter((stepLog) => stepLog.jobId === jobId));
    },
    async createProvisionJobStepLog(input: CreateProvisionJobStepLogInput) {
      const record: ProvisionJobStepLogRecord = {
        id: nextId(),
        jobId: input.jobId,
        stepName: input.stepName,
        status: input.status ?? 'pending',
        message: input.message ?? null,
        stdoutExcerpt: input.stdoutExcerpt ?? null,
        stderrExcerpt: input.stderrExcerpt ?? null,
        startedAt: input.startedAt ?? null,
        finishedAt: input.finishedAt ?? null,
        createdAt: now(),
        updatedAt: now(),
      };

      provisionJobStepLogs.push(record);

      return clone(record);
    },
    async updateProvisionJobStepLog(id: string, input: UpdateProvisionJobStepLogInput) {
      const record = provisionJobStepLogs.find((stepLog) => stepLog.id === id)!;

      Object.assign(record, {
        status: input.status ?? record.status,
        message: input.message !== undefined ? input.message : record.message,
        stdoutExcerpt: input.stdoutExcerpt !== undefined ? input.stdoutExcerpt : record.stdoutExcerpt,
        stderrExcerpt: input.stderrExcerpt !== undefined ? input.stderrExcerpt : record.stderrExcerpt,
        startedAt: input.startedAt !== undefined ? input.startedAt : record.startedAt,
        finishedAt: input.finishedAt !== undefined ? input.finishedAt : record.finishedAt,
        updatedAt: now(),
      });

      return clone(record);
    },
    async upsertCloudResourceDrift(input: UpsertCloudResourceDriftInput) {
      const cloudProvider = input.cloudProvider ?? workspaceProvider();
      const existing = cloudResourceDrifts.find(
        (record) =>
          record.cloudProvider === cloudProvider &&
          record.regionId === input.regionId &&
          record.cloudResourceType === input.cloudResourceType &&
          record.cloudResourceId === input.cloudResourceId,
      );

      if (existing) {
        Object.assign(existing, {
          rangeInstanceId: input.rangeInstanceId ?? null,
          severity: input.severity,
          reason: input.reason,
          tagsSnapshot: clone(input.tagsSnapshot ?? {}),
          lastSeenAt: new Date(input.observedAt),
          resolvedAt: null,
          updatedAt: now(),
        });
        return clone(existing);
      }

      const record: CloudResourceDriftRecord = {
        id: nextId(),
        cloudProvider,
        regionId: input.regionId,
        cloudResourceType: input.cloudResourceType,
        cloudResourceId: input.cloudResourceId,
        rangeInstanceId: input.rangeInstanceId ?? null,
        severity: input.severity,
        reason: input.reason,
        tagsSnapshot: clone(input.tagsSnapshot ?? {}),
        firstSeenAt: new Date(input.observedAt),
        lastSeenAt: new Date(input.observedAt),
        resolvedAt: null,
        createdAt: now(),
        updatedAt: now(),
      };
      cloudResourceDrifts.unshift(record);
      return clone(record);
    },
    async resolveCloudResourceDrift(input) {
      const cloudProvider = input.cloudProvider ?? workspaceProvider();
      const record = cloudResourceDrifts.find(
        (item) =>
          item.cloudProvider === cloudProvider &&
          item.regionId === input.regionId &&
          item.cloudResourceType === input.cloudResourceType &&
          item.cloudResourceId === input.cloudResourceId &&
          item.resolvedAt === null,
      );

      if (record) {
        record.resolvedAt = new Date(input.resolvedAt);
        record.updatedAt = now();
      }
    },
    async listImageSnapshots(filter: ListImageSnapshotsFilter) {
      return cloneList(
        imageSnapshots
          .filter((record) => matchesImageSnapshotFilter(record, filter))
          .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime()),
      );
    },
    async getImageSnapshotById(id: string) {
      const record = imageSnapshots.find((snapshot) => snapshot.id === id);

      return record ? clone(record) : null;
    },
    async upsertImageSnapshots(input: UpsertImageSnapshotsInput) {
      for (const snapshot of input.snapshots) {
        const existing = imageSnapshots.find(
          (record) =>
            record.provider === input.provider &&
            toAccountScopeKey(record.accountUid) === toAccountScopeKey(input.accountUid) &&
            record.regionId === input.regionId &&
            record.scope === input.scope &&
            record.imageId === snapshot.imageId,
        );

        if (existing) {
          if (['Deleting', 'Deleted'].includes(existing.status ?? '') && !['Deleting', 'Deleted'].includes(snapshot.status ?? '')) continue;
          Object.assign(existing, {
            sourceImageName: snapshot.sourceImageName,
            osType: snapshot.osType ?? null,
            platform: snapshot.platform ?? null,
            architecture: snapshot.architecture ?? null,
            status: snapshot.status ?? null,
            isAvailable: snapshot.isAvailable ?? true,
            lastSyncedAt: snapshot.lastSyncedAt,
            updatedAt: now(),
          });
          continue;
        }

        imageSnapshots.unshift({
          id: nextId(),
          provider: input.provider,
          accountUid: input.accountUid,
          regionId: input.regionId,
          scope: input.scope,
          imageId: snapshot.imageId,
          sourceImageName: snapshot.sourceImageName,
          osType: snapshot.osType ?? null,
          platform: snapshot.platform ?? null,
          architecture: snapshot.architecture ?? null,
          status: snapshot.status ?? null,
          isAvailable: snapshot.isAvailable ?? true,
          lastSyncedAt: snapshot.lastSyncedAt,
          createdAt: now(),
          updatedAt: now(),
        });
      }
      for (const asset of platformImageAssets.filter(item => !item.sourceSnapshotId && item.provider === input.provider && item.accountUid === input.accountUid && item.regionId === input.regionId)) {
        const source = imageSnapshots.find(item => item.provider === input.provider && item.accountUid === input.accountUid && item.regionId === input.regionId && item.scope === input.scope && item.imageId === asset.imageId);
        if (source) { asset.sourceSnapshotId = source.id; asset.sourceScope = source.scope; }
      }
    },
    async reconcileImageSnapshots(input: ReconcileImageSnapshotsInput) {
      await this.upsertImageSnapshots(input);

      const imageIds = new Set(input.snapshots.map((snapshot) => snapshot.imageId));

      for (let index = imageSnapshots.length - 1; index >= 0; index -= 1) {
        const record = imageSnapshots[index];
        if (!visibleInWorkspace(record)) continue;

        if (
          record.provider === input.provider &&
          toAccountScopeKey(record.accountUid) === toAccountScopeKey(input.accountUid) &&
          record.regionId === input.regionId &&
          record.scope === input.scope &&
          !imageIds.has(record.imageId)
        ) {
          if (!['Deleting', 'Deleted'].includes(record.status ?? '')) record.status = 'Missing';
          record.isAvailable = false;
          record.updatedAt = now();
          for (const asset of platformImageAssets) {
            if (asset.sourceSnapshotId === record.id) { asset.enabled = false; asset.updatedAt = now(); }
          }
        }
      }
    },
    async listImageCatalogItems(filter: ListImageCatalogItemsFilter = {}) {
      return cloneList(
        imageCatalogItems
          .filter((record) => matchesImageCatalogItemFilter(record, filter))
          .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime()),
      );
    },
    async collectImageCatalogItem(input: CollectImageCatalogItemInput) {
      const existing = imageCatalogItems.find(
        (record) =>
          record.provider === input.provider &&
          toAccountScopeKey(record.accountUid) === toAccountScopeKey(input.accountUid) &&
          record.regionId === input.regionId &&
          record.scope === input.scope &&
          record.imageId === input.imageId,
      );

      if (existing) {
        Object.assign(existing, {
          displayName: input.displayName,
          accountUid: input.accountUid,
          enabled: input.enabled ?? true,
          sourceSnapshotId: input.sourceSnapshotId ?? null,
          updatedAt: now(),
        });

        return clone(existing);
      }

      const record: ImageCatalogItemRecord = {
        id: nextId(),
        displayName: input.displayName,
        imageId: input.imageId,
        provider: input.provider,
        scope: input.scope,
        accountUid: input.accountUid,
        regionId: input.regionId,
        enabled: input.enabled ?? true,
        sourceSnapshotId: input.sourceSnapshotId ?? null,
        createdAt: now(),
        updatedAt: now(),
      };

      imageCatalogItems.unshift(record);

      return clone(record);
    },
    async listPlatformImageTags() {
      return cloneList(platformImageTags.slice().sort((left, right) => left.name.localeCompare(right.name)));
    },
    async listPlatformImageTagsByIds(ids: string[]) {
      const requestedIds = new Set(ids);
      return cloneList(platformImageTags.filter((tag) => requestedIds.has(tag.id)));
    },
    async createPlatformImageTag(input: CreatePlatformImageTagInput) {
      if (platformImageTags.some((tag) => tag.normalizedName === input.normalizedName)) {
        throw new Error(`Platform image tag unique constraint failed: normalizedName (${input.normalizedName})`);
      }

      const record: PlatformImageTagRecord = {
        id: nextId(),
        name: input.name,
        normalizedName: input.normalizedName,
        createdByUserId: input.createdByUserId,
        createdAt: now(),
        updatedAt: now(),
      };
      platformImageTags.push(record);

      return clone(record);
    },
    async listPlatformImageAssets(filter: ListPlatformImageAssetsFilter = {}) {
      return cloneList(
        platformImageAssets
          .filter((record) => matchesPlatformImageAssetFilter(record, filter))
          .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime()),
      );
    },
    async getPlatformImageAssetById(id: string) {
      const record = platformImageAssets.find((asset) => asset.id === id);

      return record ? clone(record) : null;
    },
    async collectPlatformImageAsset(input: CollectPlatformImageAssetInput) {
      const snapshot = imageSnapshots.find((record) => record.id === input.snapshotId);

      if (!snapshot) {
        throw new Error(`Platform image asset source snapshot not found: ${input.snapshotId}`);
      }

      const accountScopeKey = toAccountScopeKey(snapshot.accountUid);
      const existing = platformImageAssets.find(
        (record) =>
          record.provider === snapshot.provider &&
          record.accountScopeKey === accountScopeKey &&
          record.regionId === snapshot.regionId &&
          record.imageId === snapshot.imageId,
      );

      if (existing) {
        if (input.preserveExisting) return clone(existing);
        Object.assign(existing, {
          displayName: input.displayName,
          defaultHostName: input.defaultHostName ?? null,
          defaultPassword: input.defaultPassword ?? null,
          description: input.description ?? null,
          enabled: true,
          sourceScope: snapshot.scope,
          sourceSnapshotId: snapshot.id,
          accountUid: snapshot.accountUid,
          accountScopeKey,
          ownerUserId: input.ownerUserId !== undefined ? input.ownerUserId : existing.ownerUserId,
          visibility: input.visibility ?? existing.visibility,
          updatedAt: now(),
        });

        return clone(existing);
      }

      const record: PlatformImageAssetRecord = {
        id: nextId(),
        provider: snapshot.provider,
        accountUid: snapshot.accountUid,
        accountScopeKey,
        regionId: snapshot.regionId,
        sourceScope: snapshot.scope,
        sourceSnapshotId: snapshot.id,
        imageId: snapshot.imageId,
        displayName: input.displayName,
        defaultHostName: input.defaultHostName ?? null,
        defaultPassword: input.defaultPassword ?? null,
        description: input.description ?? null,
        ownerUserId: input.ownerUserId ?? null,
        visibility: input.visibility ?? 'private',
        enabled: true,
        tags: [],
        createdAt: now(),
        updatedAt: now(),
      };

      platformImageAssets.unshift(record);

      return clone(record);
    },
    async updatePlatformImageAsset(id: string, input: { displayName: string }) {
      const record = findPlatformImageAssetOrThrow(id);

      Object.assign(record, {
        displayName: input.displayName,
        updatedAt: now(),
      });

      return clone(record);
    },
    async setPlatformImageAssetEnabled(id: string, enabled: boolean) {
      const record = findPlatformImageAssetOrThrow(id);

      Object.assign(record, {
        enabled,
        updatedAt: now(),
      });

      return clone(record);
    },
    async replacePlatformImageAssetTags(id: string, tagIds: string[]) {
      const record = findPlatformImageAssetOrThrow(id);
      const tagIdsSet = new Set(tagIds);

      record.tags = platformImageTags
        .filter((tag) => tagIdsSet.has(tag.id))
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((tag) => clone(tag));
      record.updatedAt = now();

      return clone(record);
    },
    async hasActiveImageImportForArtifact() {
      return false;
    },
    async deletePlatformImageAsset(id: string) {
      findPlatformImageAssetOrThrow(id);

      const index = platformImageAssets.findIndex((asset) => asset.id === id);
      platformImageAssets.splice(index, 1);
    },
    async deletePlatformImageAssetsBySnapshotId(snapshotId: string) {
      for (let index = platformImageAssets.length - 1; index >= 0; index -= 1) {
        if (visibleInWorkspace(platformImageAssets[index]) && platformImageAssets[index].sourceSnapshotId === snapshotId) {
          platformImageAssets.splice(index, 1);
        }
      }
    },
    async withSingleInstanceControlLock(work) {
      const run = singleControlQueue.then(work, work);
      singleControlQueue = run.then(() => undefined, () => undefined);
      return run;
    },
    async tryWithSingleInstanceBatchProvisionLock(batchId, work) {
      if (singleBatchProvisionLocks.has(batchId)) return { acquired: false };
      singleBatchProvisionLocks.add(batchId);
      const controller = new AbortController();
      const deadline = setTimeout(() => controller.abort(new Error('Single-instance batch provision lease reached its execution deadline')), 14 * 60_000);
      deadline.unref();
      const assertHeld = async () => { if (controller.signal.aborted) throw controller.signal.reason; };
      try {
        const result = await work({ signal: controller.signal, assertHeld });
        await assertHeld();
        return { acquired: true, result };
      }
      finally { clearTimeout(deadline); controller.abort(new Error('Single-instance batch provision lease has ended')); singleBatchProvisionLocks.delete(batchId); }
    },
    async commitSingleInstanceClaim(job, instancePatch, jobPatch) {
      const current = provisionJobs.find((value) => value.id === job.id);
      const instance = rangeInstances.find((value) => value.id === job.rangeInstanceId);
      if (!job.startedAt || current?.status !== 'running' || current.startedAt?.getTime() !== job.startedAt.getTime() || instance?.lastJobId !== job.id || instance.instanceMode !== 'single' || ['destroyed','create_failed'].includes(instance.status)) return false;
      Object.assign(instance, clone(instancePatch), {updatedAt: now()});
      if (jobPatch) Object.assign(current, clone(jobPatch), {updatedAt: now()});
      return true;
    },
    async listSingleInstanceNetworkProfiles() { return clone(singleInstanceNetworkProfiles); },
    async getSingleInstanceNetworkProfileById(id) { return clone(singleInstanceNetworkProfiles.find((value) => value.id === id) ?? null); },
    async registerSingleInstanceNetworkCleanup(id,runId,adminId,ownerIds) {const profile=singleInstanceNetworkProfiles.find(value=>value.id===id);if(profile)Object.assign(profile,{cleanupRunId:runId,cleanupRegisteredByUserId:adminId,cleanupOwnerUserIds:ownerIds});},
    async markSingleInstanceNetworkDestroying(id) {const profile=singleInstanceNetworkProfiles.find(value=>value.id===id);if(profile)profile.status='destroying';},
    async deleteSingleInstanceNetworkProfile(id) { const index = singleInstanceNetworkProfiles.findIndex((value) => value.id === id); if (index >= 0) singleInstanceNetworkProfiles.splice(index, 1); },
    async createPackedImageArtifact(input) {
      const record: PackedImageArtifactRecord = { ...input, id: nextId(), imageId: null, sourceSnapshotId: null, platformImageAssetId: null, status: 'pending', backingSnapshotIds: [], deletedSnapshotIds: [], cloudImageDeletedAt: null, completedAt: null, lastPolledAt: null, errorMessage: null, createdAt: now(), updatedAt: now() };
      packedImageArtifacts.push(record); return clone(record);
    },
    async getPackedImageArtifact(id) { return cloneIfDefined(packedImageArtifacts.find(item => item.id === id) ?? null); },
    async claimPackedImageArtifact(id, token, expiresAt) {
      const claim = packedImageClaims.get(id);
      if (claim && claim.expiresAt > new Date()) return false;
      packedImageClaims.set(id, { token, expiresAt }); return true;
    },
    async renewPackedImageArtifactClaim(id, token, expiresAt) {
      if (packedImageClaims.get(id)?.token !== token) return false;
      packedImageClaims.set(id, { token, expiresAt }); return true;
    },
    async releasePackedImageArtifactClaim(id, token) { if (packedImageClaims.get(id)?.token === token) packedImageClaims.delete(id); },
    async withPackedImageArtifactClaim(id, token, work) {
      const claim = packedImageClaims.get(id);
      if (claim?.token !== token || claim.expiresAt <= new Date()) throw new Error('Packed image lease expired');
      return work(this);
    },
    async listPackedImageArtifacts(filter = {}) { return cloneList(packedImageArtifacts.filter(item => Object.entries(filter).every(([key, value]) => item[key as keyof PackedImageArtifactRecord] === value))); },
    async updatePackedImageArtifact(id, input) {
      const record = packedImageArtifacts.find(item => item.id === id);
      if (!record) throw new Error('Packed image artifact not found');
      Object.assign(record, clone(input), { updatedAt: now() }); return clone(record);
    },
    async getSingleInstanceNetworkProfile(input) {
      const record = singleInstanceNetworkProfiles.find(
        (profile) =>
          profile.provider === input.provider &&
          (profile.cloudAccountUid ?? 'legacy-unbound') === (input.cloudAccountUid ?? 'legacy-unbound') &&
          profile.regionId === input.regionId &&
          profile.zoneId === input.zoneId,
      );

      return record ? clone(record) : null;
    },
    async upsertSingleInstanceNetworkProfile(input: UpsertSingleInstanceNetworkProfileInput) {
      const existing = singleInstanceNetworkProfiles.find(
        (profile) =>
          profile.provider === input.provider &&
          (profile.cloudAccountUid ?? 'legacy-unbound') === (input.cloudAccountUid ?? 'legacy-unbound') &&
          profile.regionId === input.regionId &&
          profile.zoneId === input.zoneId,
      );

      if (existing) {
        Object.assign(existing, {
          status:input.status??existing.status,
          cloudAccountContextId: input.cloudAccountContextId ?? existing.cloudAccountContextId,
          workspaceKey: input.workspaceKey ?? existing.workspaceKey,
          managedByPlatform: input.managedByPlatform ?? existing.managedByPlatform,
          vpcId: input.vpcId,
          vpcCidr: input.vpcCidr,
          vswitchIds: clone(input.vswitchIds),
          vswitchCidrs: clone(input.vswitchCidrs),
          securityGroupId: input.securityGroupId,
          securityGroupName: input.securityGroupName,
          updatedAt: now(),
        });

        return clone(existing);
      }

      const record: SingleInstanceNetworkProfileRecord = {
        createdByUserId:input.createdByUserId??null,
        status:input.status??'ready',
        cloudAccountUid: input.cloudAccountUid ?? 'legacy-unbound',
        cloudAccountContextId: input.cloudAccountContextId ?? null,
        workspaceKey: input.workspaceKey ?? null,
        managedByPlatform: input.managedByPlatform ?? false,
        id: nextId(),
        provider: input.provider,
        regionId: input.regionId,
        zoneId: input.zoneId,
        vpcId: input.vpcId,
        vpcCidr: input.vpcCidr,
        vswitchIds: clone(input.vswitchIds),
        vswitchCidrs: clone(input.vswitchCidrs),
        securityGroupId: input.securityGroupId,
        securityGroupName: input.securityGroupName,
        createdAt: now(),
        updatedAt: now(),
      };

      singleInstanceNetworkProfiles.unshift(record);

      return clone(record);
    },
    async listBillingImageImportResources() { return []; },
    async createBillingLedgerResource(input: CreateBillingLedgerResourceInput) {
      const timestamp = now();
      const record: BillingLedgerResourceRecord = {
        id: nextId(),
        cloudProvider: input.cloudProvider ?? workspaceProvider(),
        cloudAccountUid: input.cloudAccountUid ?? null,
        regionId: input.regionId,
        cloudResourceId: input.cloudResourceId,
        cloudResourceType: input.cloudResourceType,
        billingScope: input.billingScope,
        ownerUserId: input.ownerUserId ?? null,
        rangeInstanceId: input.rangeInstanceId ?? null,
        singleInstanceBatchId: input.singleInstanceBatchId ?? null,
        platformImageAssetId: input.platformImageAssetId ?? null,
        sourceProvisionJobId: input.sourceProvisionJobId ?? null,
        billingStartAt: clone(input.billingStartAt),
        releasedAt: input.releasedAt ?? null,
        tagsSnapshot: clone(input.tagsSnapshot ?? {}),
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      billingLedgerResources.unshift(record);

      return clone(record);
    },
    async findBillingLedgerResource(input: FindBillingLedgerResourceInput) {
      const record = billingLedgerResources.find(
        (item) =>
          item.cloudProvider === (input.cloudProvider ?? workspaceProvider()) &&
          item.regionId === input.regionId &&
          item.cloudResourceId === input.cloudResourceId &&
          item.cloudResourceType === input.cloudResourceType,
      );

      return record ? clone(record) : null;
    },
    async updateBillingLedgerResource(id: string, input: UpdateBillingLedgerResourceInput) {
      const record = billingLedgerResources.find((item) => item.id === id);

      if (!record) {
        throw new Error(`Billing ledger resource not found: ${id}`);
      }

      assignIfDefined(record, 'cloudAccountUid', input.cloudAccountUid);
      assignIfDefined(record, 'billingScope', input.billingScope);
      assignIfDefined(record, 'ownerUserId', input.ownerUserId);
      assignIfDefined(record, 'rangeInstanceId', input.rangeInstanceId);
      assignIfDefined(record, 'singleInstanceBatchId', input.singleInstanceBatchId);
      assignIfDefined(record, 'platformImageAssetId', input.platformImageAssetId);
      assignIfDefined(record, 'sourceProvisionJobId', input.sourceProvisionJobId);
      assignClonedIfDefined(record, 'billingStartAt', input.billingStartAt);
      assignClonedIfDefined(record, 'releasedAt', input.releasedAt);
      assignClonedIfDefined(record, 'tagsSnapshot', input.tagsSnapshot);
      record.updatedAt = now();

      return clone(record);
    },
    async listBillingLedgerResources(filter = {}) {
      return cloneList(billingLedgerResources.filter(item => filter.rangeInstanceId === undefined || item.rangeInstanceId === filter.rangeInstanceId));
    },
    async getLatestBillingLineItemDate(cloudAccountUid?: string) {
      const latest = billingLineItems.filter(item => cloudAccountUid === undefined || item.cloudAccountUid === cloudAccountUid).reduce<Date | null>(
        (current, item) => (!current || item.billingDate > current ? item.billingDate : current),
        null,
      );

      return latest ? new Date(latest) : null;
    },
    async replaceBillingDay(input) {
      const date = new Date(input.billingDate).getTime();
      if ([...input.lineItems, ...input.anomalies].some(item => item.cloudAccountUid !== input.cloudAccountUid || new Date(item.billingDate).getTime() !== date)) throw new Error('Billing replacement account or date mismatch');
      const oldLines = cloneList(billingLineItems);
      const oldAnomalies = cloneList(billingAnomalies);
      try {
        for (const item of billingLineItems) if (item.cloudAccountUid == null && item.billingDate.getTime() === date && billingLedgerResources.some(ledger => ledger.id === item.matchedLedgerId && ledger.cloudAccountUid === input.cloudAccountUid)) item.cloudAccountUid = input.cloudAccountUid;
        for (let i = billingLineItems.length - 1; i >= 0; i--) if (visibleInWorkspace(billingLineItems[i]) && billingLineItems[i].cloudAccountUid === input.cloudAccountUid && billingLineItems[i].billingDate.getTime() === date) billingLineItems.splice(i, 1);
        for (let i = billingAnomalies.length - 1; i >= 0; i--) if (visibleInWorkspace(billingAnomalies[i]) && billingAnomalies[i].cloudAccountUid === input.cloudAccountUid && billingAnomalies[i].billingDate.getTime() === date) billingAnomalies.splice(i, 1);
        await this.upsertBillingLineItems(input.lineItems);
        for (const item of input.anomalies) await this.createBillingAnomaly(item);
      } catch (error) {
        for (let index = billingLineItems.length - 1; index >= 0; index--) if (visibleInWorkspace(billingLineItems[index])) billingLineItems.splice(index, 1);
        for (let index = billingAnomalies.length - 1; index >= 0; index--) if (visibleInWorkspace(billingAnomalies[index])) billingAnomalies.splice(index, 1);
        billingLineItems.push(...oldLines);
        billingAnomalies.push(...oldAnomalies);
        throw error;
      }
    },
    async deleteBillingLineItemsBySyncBatchId(syncBatchId: string) {
      for (let index = billingLineItems.length - 1; index >= 0; index -= 1) {
        if (visibleInWorkspace(billingLineItems[index]) && billingLineItems[index]?.syncBatchId === syncBatchId) {
          billingLineItems.splice(index, 1);
        }
      }
    },
    async upsertBillingLineItems(input: CreateBillingLineItemInput[]) {
      const timestamp = now();

      return input.map((item) => {
        const existing = billingLineItems.find((entry) => entry.sourceFingerprint === item.sourceFingerprint);

        if (existing) {
          existing.cloudAccountUid = item.cloudAccountUid ?? null;
          existing.syncBatchId = item.syncBatchId;
          existing.billCycle = item.billCycle;
          existing.billingDate = parseDateValue(item.billingDate);
          existing.productCode = item.productCode;
          existing.productDetail = item.productDetail ?? null;
          existing.billItem = item.billItem;
          existing.cloudResourceId = item.cloudResourceId;
          existing.cloudResourceType = item.cloudResourceType;
          existing.pretaxAmount = item.pretaxAmount;
          existing.currency = item.currency;
          existing.billingScope = item.billingScope;
          existing.ownerUserId = item.ownerUserId ?? null;
          existing.matchedLedgerId = item.matchedLedgerId ?? null;
          existing.rawPayload = clone(item.rawPayload ?? {});
          existing.updatedAt = timestamp;

          return clone(existing);
        }

        const created: BillingLineItemRecord = {
          id: nextId(),
          cloudAccountUid: item.cloudAccountUid ?? null,
          syncBatchId: item.syncBatchId,
          sourceFingerprint: item.sourceFingerprint,
          billCycle: item.billCycle,
          billingDate: parseDateValue(item.billingDate),
          productCode: item.productCode,
          productDetail: item.productDetail ?? null,
          billItem: item.billItem,
          cloudResourceId: item.cloudResourceId,
          cloudResourceType: item.cloudResourceType,
          pretaxAmount: item.pretaxAmount,
          currency: item.currency,
          billingScope: item.billingScope,
          ownerUserId: item.ownerUserId ?? null,
          matchedLedgerId: item.matchedLedgerId ?? null,
          rawPayload: clone(item.rawPayload ?? {}),
          createdAt: timestamp,
          updatedAt: timestamp,
        };

        billingLineItems.unshift(created);
        return clone(created);
      });
    },
    async listBillingLineItems(filter: ListBillingLineItemsFilter = {}) {
      return cloneList(
        billingLineItems.filter(
          (item) =>
            inDateRange(item.billingDate, filter.startAt, filter.endAt) &&
            (filter.cloudAccountUid === undefined || item.cloudAccountUid === filter.cloudAccountUid) &&
            (filter.ownerUserId === undefined || item.ownerUserId === filter.ownerUserId) &&
            (filter.billingScope === undefined || item.billingScope === filter.billingScope) &&
            (filter.matchedLedgerId === undefined || item.matchedLedgerId === filter.matchedLedgerId),
        ),
      );
    },
    async createBillingAnomaly(input: CreateBillingAnomalyInput) {
      const existing = billingAnomalies.find((item) => item.sourceFingerprint === input.sourceFingerprint);

      if (existing) {
        existing.cloudAccountUid = input.cloudAccountUid ?? null;
        existing.syncBatchId = input.syncBatchId;
        existing.billCycle = input.billCycle;
        existing.billingDate = parseDateValue(input.billingDate);
        existing.cloudResourceId = input.cloudResourceId;
        existing.cloudResourceType = input.cloudResourceType;
        existing.pretaxAmount = input.pretaxAmount;
        existing.currency = input.currency;
        existing.reason = input.reason;
        existing.rawPayload = clone(input.rawPayload ?? {});
        existing.updatedAt = now();

        return clone(existing);
      }

      const timestamp = now();
      const record: BillingAnomalyRecord = {
        id: nextId(),
        cloudAccountUid: input.cloudAccountUid ?? null,
        syncBatchId: input.syncBatchId,
        sourceFingerprint: input.sourceFingerprint,
        billCycle: input.billCycle,
        billingDate: parseDateValue(input.billingDate),
        cloudResourceId: input.cloudResourceId,
        cloudResourceType: input.cloudResourceType,
        pretaxAmount: input.pretaxAmount,
        currency: input.currency,
        reason: input.reason,
        rawPayload: clone(input.rawPayload ?? {}),
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      billingAnomalies.unshift(record);

      return clone(record);
    },
    async deleteBillingAnomaliesBySyncBatchId(syncBatchId: string) {
      for (let index = billingAnomalies.length - 1; index >= 0; index -= 1) {
        if (visibleInWorkspace(billingAnomalies[index]) && billingAnomalies[index]?.syncBatchId === syncBatchId) {
          billingAnomalies.splice(index, 1);
        }
      }
    },
    async listBillingAnomalies(filter: ListBillingAnomaliesFilter = {}) {
      return cloneList(billingAnomalies.filter((item) => inDateRange(item.billingDate, filter.startAt, filter.endAt) && (filter.cloudAccountUid === undefined || item.cloudAccountUid === filter.cloudAccountUid)));
    },
  };
  return new Proxy(repository, {
    get(target, property) {
      const value = Reflect.get(target, property);
      if (typeof value !== 'function' || value._isMockFunction) return value;
      return (...args: unknown[]) => {
        const scope = getCurrentCloudWorkspaceScope();
        const operation = String(property);
        if (scope && !('system' in scope) && scope.isReadOnly
          && /^(create|update|delete|set|collect|replace|reconcile|upsert|queue|claim|consume|apply|complete|save|sync|release|mark|register|renew)/.test(operation)
          && !/(Operation|Confirmation|Audit)/.test(operation)) return Promise.reject(new Error('Historical cloud workspace is read-only'));
        return value.apply(target, args);
      };
    },
  });
}
