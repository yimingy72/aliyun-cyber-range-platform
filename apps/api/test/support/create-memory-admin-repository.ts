import {
  AdminRepository,
  CloudImageSnapshotRecord,
  CollectImageCatalogItemInput,
  CollectPlatformImageAssetInput,
  CreateProvisionJobInput,
  CreateProvisionJobStepLogInput,
  CreateRangeInstanceInput,
  CreateRangeTemplateInput,
  ImageCatalogItemRecord,
  ListImageCatalogItemsFilter,
  ListImageSnapshotsFilter,
  ListPlatformImageAssetsFilter,
  PlatformImageAssetRecord,
  ProvisionJobRecord,
  ProvisionJobStepLogRecord,
  ReconcileImageSnapshotsInput,
  RangeInstanceRecord,
  RangeTemplateRecord,
  RangeTemplateVersionRecord,
  UpsertImageSnapshotsInput,
  UpdateProvisionJobInput,
  UpdateProvisionJobStepLogInput,
  UpdateRangeInstanceInput,
  UpdateRangeTemplateInput,
} from '../../src/admin/admin.repository';
import { toAccountScopeKey } from '../../src/admin/image-account-scope';

function shouldAutoUnpublishTemplate(input: UpdateRangeTemplateInput) {
  return (
    input.topologySpec !== undefined ||
    input.topologyGraph !== undefined ||
    input.scenarioTemplateSpec !== undefined ||
    input.compiledProvisionSpec !== undefined ||
    input.compiledSpec !== undefined
  );
}

export function createMemoryAdminRepository(): AdminRepository {
  const rangeTemplates: RangeTemplateRecord[] = [];
  const rangeTemplateVersions: RangeTemplateVersionRecord[] = [];
  const rangeInstances: RangeInstanceRecord[] = [];
  const provisionJobs: ProvisionJobRecord[] = [];
  const provisionJobStepLogs: ProvisionJobStepLogRecord[] = [];
  const imageSnapshots: CloudImageSnapshotRecord[] = [];
  const imageCatalogItems: ImageCatalogItemRecord[] = [];
  const platformImageAssets: PlatformImageAssetRecord[] = [];

  let idCounter = 1;

  const nextId = () => `memory-${idCounter++}`;
  const now = () => new Date();
  const clone = <T extends Record<string, unknown>>(record: T): T => ({ ...record });
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
    (filter.sourceSnapshotId === undefined || record.sourceSnapshotId === filter.sourceSnapshotId);

  const findPlatformImageAssetOrThrow = (id: string) => {
    const record = platformImageAssets.find((asset) => asset.id === id);

    if (!record) {
      throw new Error(`Platform image asset not found: ${id}`);
    }

    return record;
  };

  return {
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
        topologySpec: input.topologySpec,
        topologyGraph: input.topologyGraph,
        scenarioTemplateSpec: input.scenarioTemplateSpec,
        compiledProvisionSpec: input.compiledProvisionSpec,
        compiledSpec: input.compiledSpec,
        variableSchema: input.variableSchema ?? {},
        outputSchema: input.outputSchema ?? {},
        defaultNetworkPolicy: input.defaultNetworkPolicy ?? null,
        createdAt: now(),
        updatedAt: now(),
      };

      const record: RangeTemplateRecord = {
        id: nextId(),
        name: input.name,
        description: input.description ?? null,
        slug: input.slug,
        version: input.version,
        cloudProvider: input.cloudProvider ?? 'alibaba_cloud',
        iacType: input.iacType ?? 'opentofu',
        modulePathOrRef: input.modulePathOrRef,
        topologySpec: input.topologySpec,
        topologyGraph: input.topologyGraph,
        scenarioTemplateSpec: input.scenarioTemplateSpec,
        compiledProvisionSpec: input.compiledProvisionSpec,
        compiledSpec: input.compiledSpec,
        variableSchema: input.variableSchema ?? {},
        outputSchema: input.outputSchema ?? {},
        defaultNetworkPolicy: input.defaultNetworkPolicy ?? null,
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
    async updateRangeTemplate(id: string, input: UpdateRangeTemplateInput) {
      const record = rangeTemplates.find((template) => template.id === id)!;
      const draftVersion = rangeTemplateVersions.find((item) => item.id === record.currentDraftVersionId)!;
      const autoUnpublish = Boolean(record.currentPublishedVersionId) && shouldAutoUnpublishTemplate(input);

      assignIfDefined(record, 'name', input.name);
      assignIfDefined(record, 'description', input.description);
      assignIfDefined(record, 'slug', input.slug);
      assignIfDefined(record, 'version', input.version);
      assignIfDefined(record, 'cloudProvider', input.cloudProvider);
      assignIfDefined(record, 'iacType', input.iacType);
      assignIfDefined(record, 'modulePathOrRef', input.modulePathOrRef);
      assignIfDefined(record, 'topologySpec', input.topologySpec);
      assignIfDefined(record, 'topologyGraph', input.topologyGraph);
      assignIfDefined(record, 'scenarioTemplateSpec', input.scenarioTemplateSpec);
      assignIfDefined(record, 'compiledProvisionSpec', input.compiledProvisionSpec);
      assignIfDefined(record, 'compiledSpec', input.compiledSpec);
      assignIfDefined(record, 'variableSchema', input.variableSchema);
      assignIfDefined(record, 'outputSchema', input.outputSchema);
      assignIfDefined(record, 'defaultNetworkPolicy', input.defaultNetworkPolicy);
      record.updatedAt = now();

      assignIfDefined(draftVersion, 'version', input.version);
      assignIfDefined(draftVersion, 'modulePathOrRef', input.modulePathOrRef);
      assignIfDefined(draftVersion, 'topologySpec', input.topologySpec);
      assignIfDefined(draftVersion, 'topologyGraph', input.topologyGraph);
      assignIfDefined(draftVersion, 'scenarioTemplateSpec', input.scenarioTemplateSpec);
      assignIfDefined(draftVersion, 'compiledProvisionSpec', input.compiledProvisionSpec);
      assignIfDefined(draftVersion, 'compiledSpec', input.compiledSpec);
      assignIfDefined(draftVersion, 'variableSchema', input.variableSchema);
      assignIfDefined(draftVersion, 'outputSchema', input.outputSchema);
      assignIfDefined(draftVersion, 'defaultNetworkPolicy', input.defaultNetworkPolicy);
      draftVersion.updatedAt = now();

      if (autoUnpublish && record.currentPublishedVersionId) {
        const currentPublished = rangeTemplateVersions.find((item) => item.id === record.currentPublishedVersionId) ?? null;

        if (currentPublished) {
          currentPublished.status = 'archived';
          currentPublished.updatedAt = now();
        }

        record.currentPublishedVersionId = null;
        record.currentPublishedVersion = null;
      }

      record.currentDraftVersion = clone(draftVersion);
      record.versions = cloneList(rangeTemplateVersions.filter((item) => item.templateId === record.id));

      return clone(record);
    },
    async publishRangeTemplate(id: string) {
      const record = rangeTemplates.find((template) => template.id === id)!;
      const currentDraft = rangeTemplateVersions.find((item) => item.id === record.currentDraftVersionId)!;

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
        version: currentDraft.version,
        modulePathOrRef: currentDraft.modulePathOrRef,
        topologySpec: currentDraft.topologySpec,
        topologyGraph: currentDraft.topologyGraph,
        scenarioTemplateSpec: currentDraft.scenarioTemplateSpec,
        compiledProvisionSpec: currentDraft.compiledProvisionSpec,
        compiledSpec: currentDraft.compiledSpec,
        variableSchema: currentDraft.variableSchema,
        outputSchema: currentDraft.outputSchema,
        defaultNetworkPolicy: currentDraft.defaultNetworkPolicy,
        currentPublishedVersionId: currentDraft.id,
        currentDraftVersionId: nextDraft.id,
        currentPublishedVersion: clone(currentDraft),
        currentDraftVersion: clone(nextDraft),
        versions: cloneList(rangeTemplateVersions.filter((item) => item.templateId === record.id)),
        updatedAt: now(),
      });

      return clone(record);
    },
    async unpublishRangeTemplate(id: string) {
      const record = rangeTemplates.find((template) => template.id === id)!;
      const currentPublished = record.currentPublishedVersionId
        ? rangeTemplateVersions.find((item) => item.id === record.currentPublishedVersionId) ?? null
        : null;

      if (currentPublished) {
        currentPublished.status = 'archived';
        currentPublished.updatedAt = now();
      }

      Object.assign(record, {
        currentPublishedVersionId: null,
        currentPublishedVersion: null,
        versions: cloneList(rangeTemplateVersions.filter((item) => item.templateId === record.id)),
        updatedAt: now(),
      });

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
        createdBy: input.createdBy ?? null,
        templateId: input.templateId,
        sourceTemplateVersionId: input.sourceTemplateVersionId ?? null,
        templateNameSnapshot: null,
        templateSlugSnapshot: null,
        templateVersionSnapshot: null,
        templateModulePathSnapshot: null,
        runtimeTopologyGraph: input.runtimeTopologyGraph ?? null,
        runtimeScenarioTemplateSpec: input.runtimeScenarioTemplateSpec ?? null,
        runtimeCompiledProvisionSpec: input.runtimeCompiledProvisionSpec ?? null,
        draftTopologyGraph: input.draftTopologyGraph ?? null,
        draftScenarioTemplateSpec: input.draftScenarioTemplateSpec ?? null,
        draftCompiledProvisionSpec: input.draftCompiledProvisionSpec ?? null,
        draftUpdatedBy: input.draftUpdatedBy ?? null,
        draftUpdatedAt: input.draftUpdatedAt ?? null,
        status: input.status ?? 'draft',
        allocatedCidr: input.allocatedCidr ?? null,
        cloudProvider: 'alibaba_cloud',
        accessEntry: input.accessEntry ?? null,
        resourceSummary: input.resourceSummary ?? null,
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
        sourceTemplateVersionId:
          input.sourceTemplateVersionId !== undefined ? input.sourceTemplateVersionId : record.sourceTemplateVersionId,
        runtimeTopologyGraph:
          input.runtimeTopologyGraph !== undefined ? input.runtimeTopologyGraph : record.runtimeTopologyGraph,
        runtimeScenarioTemplateSpec:
          input.runtimeScenarioTemplateSpec !== undefined
            ? input.runtimeScenarioTemplateSpec
            : record.runtimeScenarioTemplateSpec,
        runtimeCompiledProvisionSpec:
          input.runtimeCompiledProvisionSpec !== undefined
            ? input.runtimeCompiledProvisionSpec
            : record.runtimeCompiledProvisionSpec,
        draftTopologyGraph:
          input.draftTopologyGraph !== undefined ? input.draftTopologyGraph : record.draftTopologyGraph,
        draftScenarioTemplateSpec:
          input.draftScenarioTemplateSpec !== undefined
            ? input.draftScenarioTemplateSpec
            : record.draftScenarioTemplateSpec,
        draftCompiledProvisionSpec:
          input.draftCompiledProvisionSpec !== undefined
            ? input.draftCompiledProvisionSpec
            : record.draftCompiledProvisionSpec,
        draftUpdatedBy: input.draftUpdatedBy !== undefined ? input.draftUpdatedBy : record.draftUpdatedBy,
        draftUpdatedAt: input.draftUpdatedAt !== undefined ? input.draftUpdatedAt : record.draftUpdatedAt,
        status: input.status ?? record.status,
        allocatedCidr: input.allocatedCidr !== undefined ? input.allocatedCidr : record.allocatedCidr,
        accessEntry: input.accessEntry !== undefined ? input.accessEntry : record.accessEntry,
        resourceSummary: input.resourceSummary !== undefined ? input.resourceSummary : record.resourceSummary,
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
    async listPlatformImageAssets(filter: ListPlatformImageAssetsFilter = {}) {
      return cloneList(
        platformImageAssets
          .filter((record) => matchesPlatformImageAssetFilter(record, filter))
          .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime()),
      );
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
          enabled: true,
          sourceScope: snapshot.scope,
          sourceSnapshotId: snapshot.id,
          accountUid: snapshot.accountUid,
          accountScopeKey,
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
        enabled: true,
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
  };
}
