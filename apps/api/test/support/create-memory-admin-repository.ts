import {
  AdminRepository,
  BillingAnomalyRecord,
  BillingLedgerResourceRecord,
  BillingLineItemRecord,
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
  CreateProvisionJobInput,
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
  PlatformImageAssetRecord,
  PlatformImageTagRecord,
  ProvisionJobRecord,
  ProvisionJobStepLogRecord,
  ReconcileImageSnapshotsInput,
  RangeInstanceRecord,
  RangeTemplateRecord,
  RangeTemplateVersionRecord,
  FindBillingLedgerResourceInput,
  ListBillingAnomaliesFilter,
  ListBillingLineItemsFilter,
  SingleInstanceNetworkProfileRecord,
  SingleInstanceBatchRecord,
  TemplateRevisionConflictError,
  UpsertImageSnapshotsInput,
  UpsertSingleInstanceNetworkProfileInput,
  UpdateBillingLedgerResourceInput,
  UpdateIdempotentOperationInput,
  UpdatePlatformUserInput,
  UpdateProvisionJobInput,
  UpdateProvisionJobStepLogInput,
  UpdateRangeInstanceInput,
} from '../../src/admin/admin.repository';
import { toAccountScopeKey } from '../../src/admin/image-account-scope';

export function createMemoryAdminRepository(): AdminRepository {
  const platformUsers: PlatformUserRecord[] = [];
  const rangeTemplates: RangeTemplateRecord[] = [];
  const rangeTemplateVersions: RangeTemplateVersionRecord[] = [];
  const singleInstanceBatches: SingleInstanceBatchRecord[] = [];
  const rangeInstances: RangeInstanceRecord[] = [];
  const provisionJobs: ProvisionJobRecord[] = [];
  const provisionJobStepLogs: ProvisionJobStepLogRecord[] = [];
  const imageSnapshots: CloudImageSnapshotRecord[] = [];
  const imageCatalogItems: ImageCatalogItemRecord[] = [];
  const platformImageAssets: PlatformImageAssetRecord[] = [];
  const platformImageTags: PlatformImageTagRecord[] = [];
  const singleInstanceNetworkProfiles: SingleInstanceNetworkProfileRecord[] = [];
  const billingLedgerResources: BillingLedgerResourceRecord[] = [];
  const billingLineItems: BillingLineItemRecord[] = [];
  const billingAnomalies: BillingAnomalyRecord[] = [];
  const operationConfirmations: OperationConfirmationRecord[] = [];
  const idempotentOperations: IdempotentOperationRecord[] = [];
  const operationAuditEvents: OperationAuditEventRecord[] = [];

  let idCounter = 1;

  const nextId = () => `memory-${idCounter++}`;
  const now = () => new Date();
  const clone = <T>(record: T): T => structuredClone(record);
  const cloneIfDefined = <T>(value: T): T => (value == null ? value : structuredClone(value));
  const cloneList = <T extends Record<string, unknown>>(records: T[]): T[] => records.map((record) => clone(record));
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
      exclusiveEnd.setDate(exclusiveEnd.getDate() + 1);

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
      record.sourceSnapshotId === null ||
      imageSnapshots.some((snapshot) => snapshot.id === record.sourceSnapshotId && snapshot.isAvailable));

  const findPlatformUserOrThrow = (id: string) => {
    const record = platformUsers.find((user) => user.id === id);

    if (!record) {
      throw new Error(`Platform user not found: ${id}`);
    }

    return record;
  };

  const assertPlatformUserUnique = (
    input: { id?: string; username?: string; oidcIssuer?: string | null; oidcSubject?: string | null },
    ignoreId?: string,
  ) => {
    if (
      input.id !== undefined &&
      platformUsers.some((user) => user.id === input.id && user.id !== ignoreId)
    ) {
      throw new Error(`Platform user unique constraint failed: id (${input.id})`);
    }

    if (
      input.username !== undefined &&
      platformUsers.some((user) => user.username === input.username && user.id !== ignoreId)
    ) {
      throw new Error(`Platform user unique constraint failed: username (${input.username})`);
    }

    if (
      input.oidcIssuer != null &&
      input.oidcSubject != null &&
      platformUsers.some(
        (user) =>
          user.oidcIssuer === input.oidcIssuer &&
          user.oidcSubject === input.oidcSubject &&
          user.id !== ignoreId,
      )
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

  return {
    async createPlatformUser(input: CreatePlatformUserInput) {
      assertPlatformUserUnique({
        id: input.id,
        username: input.username,
      });

      const record: PlatformUserRecord = {
        id: input.id,
        username: input.username,
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
      return cloneList(platformUsers);
    },
    async getPlatformUserById(id: string) {
      const record = platformUsers.find((user) => user.id === id);

      return record ? clone(record) : null;
    },
    async getPlatformUserByUsername(username: string) {
      const record = platformUsers.find((user) => user.username === username);

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
          oidcIssuer,
          oidcSubject,
        },
        id,
      );

      Object.assign(record, {
        username: input.username ?? record.username,
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
      return platformUsers.filter((user) => user.role === 'admin' && user.status === 'active').length;
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
        cloudProvider: input.cloudProvider ?? 'alibaba_cloud',
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
        if (rangeTemplateVersions[i].templateId === id) {
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
    async listRangeInstances() {
      return cloneList(rangeInstances);
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
    async deleteRangeInstance(id: string) {
      const deletedJobIds = new Set(
        provisionJobs.filter((job) => job.rangeInstanceId === id).map((job) => job.id),
      );

      for (let i = rangeInstances.length - 1; i >= 0; i -= 1) {
        if (rangeInstances[i].id === id) {
          rangeInstances.splice(i, 1);
        }
      }

      for (let i = provisionJobs.length - 1; i >= 0; i -= 1) {
        if (provisionJobs[i].rangeInstanceId === id) {
          provisionJobs.splice(i, 1);
        }
      }

      for (let i = provisionJobStepLogs.length - 1; i >= 0; i -= 1) {
        if (deletedJobIds.has(provisionJobStepLogs[i].jobId)) {
          provisionJobStepLogs.splice(i, 1);
        }
      }
    },
    async createRangeInstance(input: CreateRangeInstanceInput) {
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
        templateNameSnapshot: null,
        templateSlugSnapshot: null,
        templateVersionSnapshot: null,
        templateModulePathSnapshot: null,
        runtimeTopologyGraph: cloneIfDefined(input.runtimeTopologyGraph ?? null),
        runtimeScenarioTemplateSpec: cloneIfDefined(input.runtimeScenarioTemplateSpec ?? null),
        runtimeCompiledProvisionSpec: cloneIfDefined(input.runtimeCompiledProvisionSpec ?? null),
        runtimeCredentials: cloneIfDefined(input.runtimeCredentials ?? null),
        draftTopologyGraph: cloneIfDefined(input.draftTopologyGraph ?? null),
        draftScenarioTemplateSpec: cloneIfDefined(input.draftScenarioTemplateSpec ?? null),
        draftCompiledProvisionSpec: cloneIfDefined(input.draftCompiledProvisionSpec ?? null),
        draftUpdatedBy: input.draftUpdatedBy ?? null,
        draftUpdatedAt: input.draftUpdatedAt ?? null,
        status: input.status ?? 'draft',
        allocatedCidr: input.allocatedCidr ?? null,
        cloudProvider: 'alibaba_cloud',
        accessEntry: cloneIfDefined(input.accessEntry ?? null),
        resourceSummary: cloneIfDefined(input.resourceSummary ?? null),
        errorSummary: input.errorSummary ?? null,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        lastJobId: input.lastJobId ?? null,
        createdAt: now(),
        updatedAt: now(),
      };

      rangeInstances.unshift(record);

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
        draftScenarioTemplateSpec:
          input.draftScenarioTemplateSpec !== undefined
            ? cloneIfDefined(input.draftScenarioTemplateSpec)
            : record.draftScenarioTemplateSpec,
        draftCompiledProvisionSpec:
          input.draftCompiledProvisionSpec !== undefined
            ? cloneIfDefined(input.draftCompiledProvisionSpec)
            : record.draftCompiledProvisionSpec,
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
    async listProvisionJobs() {
      return cloneList(provisionJobs);
    },
    async createProvisionJob(input: CreateProvisionJobInput) {
      const record: ProvisionJobRecord = {
        id: nextId(),
        rangeInstanceId: input.rangeInstanceId,
        jobType: input.jobType,
        status: input.status ?? 'pending',
        triggeredBy: input.triggeredBy,
        startedAt: null,
        finishedAt: null,
        retryCount: input.retryCount ?? 0,
        errorSummary: null,
        createdAt: now(),
        updatedAt: now(),
      };

      provisionJobs.unshift(record);

      return clone(record);
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
    },
    async reconcileImageSnapshots(input: ReconcileImageSnapshotsInput) {
      await this.upsertImageSnapshots(input);

      const imageIds = new Set(input.snapshots.map((snapshot) => snapshot.imageId));

      for (let index = imageSnapshots.length - 1; index >= 0; index -= 1) {
        const record = imageSnapshots[index];

        if (
          record.provider === input.provider &&
          toAccountScopeKey(record.accountUid) === toAccountScopeKey(input.accountUid) &&
          record.regionId === input.regionId &&
          record.scope === input.scope &&
          !imageIds.has(record.imageId)
        ) {
          for (const asset of platformImageAssets) {
            if (asset.sourceSnapshotId === record.id) {
              asset.sourceSnapshotId = null;
              asset.updatedAt = now();
            }
          }

          imageSnapshots.splice(index, 1);
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
        if (platformImageAssets[index].sourceSnapshotId === snapshotId) {
          platformImageAssets.splice(index, 1);
        }
      }
    },
    async getSingleInstanceNetworkProfile(input) {
      const record = singleInstanceNetworkProfiles.find(
        (profile) =>
          profile.provider === input.provider &&
          profile.regionId === input.regionId &&
          profile.zoneId === input.zoneId,
      );

      return record ? clone(record) : null;
    },
    async upsertSingleInstanceNetworkProfile(input: UpsertSingleInstanceNetworkProfileInput) {
      const existing = singleInstanceNetworkProfiles.find(
        (profile) =>
          profile.provider === input.provider &&
          profile.regionId === input.regionId &&
          profile.zoneId === input.zoneId,
      );

      if (existing) {
        Object.assign(existing, {
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
    async createBillingLedgerResource(input: CreateBillingLedgerResourceInput) {
      const timestamp = now();
      const record: BillingLedgerResourceRecord = {
        id: nextId(),
        cloudProvider: input.cloudProvider ?? 'alibaba_cloud',
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
          item.cloudProvider === (input.cloudProvider ?? 'alibaba_cloud') &&
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
    async listBillingLedgerResources() {
      return cloneList(billingLedgerResources);
    },
    async deleteBillingLineItemsBySyncBatchId(syncBatchId: string) {
      for (let index = billingLineItems.length - 1; index >= 0; index -= 1) {
        if (billingLineItems[index]?.syncBatchId === syncBatchId) {
          billingLineItems.splice(index, 1);
        }
      }
    },
    async upsertBillingLineItems(input: CreateBillingLineItemInput[]) {
      const timestamp = now();

      return input.map((item) => {
        const existing = billingLineItems.find((entry) => entry.sourceFingerprint === item.sourceFingerprint);

        if (existing) {
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
            (filter.ownerUserId === undefined || item.ownerUserId === filter.ownerUserId) &&
            (filter.billingScope === undefined || item.billingScope === filter.billingScope) &&
            (filter.matchedLedgerId === undefined || item.matchedLedgerId === filter.matchedLedgerId),
        ),
      );
    },
    async createBillingAnomaly(input: CreateBillingAnomalyInput) {
      const existing = billingAnomalies.find((item) => item.sourceFingerprint === input.sourceFingerprint);

      if (existing) {
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
        if (billingAnomalies[index]?.syncBatchId === syncBatchId) {
          billingAnomalies.splice(index, 1);
        }
      }
    },
    async listBillingAnomalies(filter: ListBillingAnomaliesFilter = {}) {
      return cloneList(billingAnomalies.filter((item) => inDateRange(item.billingDate, filter.startAt, filter.endAt)));
    },
  };
}
