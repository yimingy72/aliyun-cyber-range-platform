import {
  AdminRepository,
  CompetitionRecord,
  CreateCompetitionInput,
  CreateProvisionJobInput,
  CreateProvisionJobStepLogInput,
  CreateRangeInstanceInput,
  CreateRangeTemplateInput,
  CreateTeamInput,
  ProvisionJobRecord,
  ProvisionJobStepLogRecord,
  RangeInstanceRecord,
  RangeTemplateRecord,
  RangeTemplateVersionRecord,
  TeamRecord,
  UpdateProvisionJobInput,
  UpdateProvisionJobStepLogInput,
  UpdateRangeInstanceInput,
  UpdateCompetitionInput,
  UpdateRangeTemplateInput,
  UpdateTeamInput,
} from '../../src/admin/admin.repository';

export function createMemoryAdminRepository(): AdminRepository {
  const competitions: CompetitionRecord[] = [];
  const teams: TeamRecord[] = [];
  const rangeTemplates: RangeTemplateRecord[] = [];
  const rangeTemplateVersions: RangeTemplateVersionRecord[] = [];
  const rangeInstances: RangeInstanceRecord[] = [];
  const provisionJobs: ProvisionJobRecord[] = [];
  const provisionJobStepLogs: ProvisionJobStepLogRecord[] = [];

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

  return {
    async listCompetitions() {
      return cloneList(competitions);
    },
    async createCompetition(input: CreateCompetitionInput) {
      const record: CompetitionRecord = {
        id: nextId(),
        name: input.name,
        description: input.description ?? null,
        status: input.status ?? 'draft',
        startAt: input.startAt ? new Date(input.startAt) : null,
        endAt: input.endAt ? new Date(input.endAt) : null,
        defaultTemplateId: input.defaultTemplateId ?? null,
        createdAt: now(),
        updatedAt: now(),
      };

      competitions.unshift(record);

      return clone(record);
    },
    async getCompetitionById(id: string) {
      const record = competitions.find((competition) => competition.id === id);

      return record ? clone(record) : null;
    },
    async updateCompetition(id: string, input: UpdateCompetitionInput) {
      const record = competitions.find((competition) => competition.id === id)!;

      Object.assign(record, {
        name: input.name ?? record.name,
        description: input.description ?? record.description,
        status: input.status ?? record.status,
        startAt: input.startAt ? new Date(input.startAt) : record.startAt,
        endAt: input.endAt ? new Date(input.endAt) : record.endAt,
        defaultTemplateId: input.defaultTemplateId ?? record.defaultTemplateId,
        updatedAt: now(),
      });

      return clone(record);
    },
    async deleteCompetition(id: string) {
      const index = competitions.findIndex((competition) => competition.id === id);

      if (index >= 0) {
        competitions.splice(index, 1);
      }
    },
    async listTeams(filter) {
      if (!filter?.competitionId) {
        return cloneList(teams);
      }

      return cloneList(teams.filter((team) => team.competitionId === filter.competitionId));
    },
    async createTeam(input: CreateTeamInput) {
      const record: TeamRecord = {
        id: nextId(),
        competitionId: input.competitionId,
        name: input.name,
        contactName: input.contactName ?? null,
        contactEmailOrPhone: input.contactEmailOrPhone ?? null,
        notes: input.notes ?? null,
        createdAt: now(),
        updatedAt: now(),
      };

      teams.unshift(record);

      return clone(record);
    },
    async getTeamById(id: string) {
      const record = teams.find((team) => team.id === id);

      return record ? clone(record) : null;
    },
    async updateTeam(id: string, input: UpdateTeamInput) {
      const record = teams.find((team) => team.id === id)!;

      Object.assign(record, {
        competitionId: input.competitionId ?? record.competitionId,
        name: input.name ?? record.name,
        contactName: input.contactName ?? record.contactName,
        contactEmailOrPhone: input.contactEmailOrPhone ?? record.contactEmailOrPhone,
        notes: input.notes ?? record.notes,
        updatedAt: now(),
      });

      return clone(record);
    },
    async deleteTeam(id: string) {
      const index = teams.findIndex((team) => team.id === id);

      if (index >= 0) {
        teams.splice(index, 1);
      }
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
        topologySpec: input.topologySpec,
        topologyGraph: input.topologyGraph,
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
        slug: input.slug,
        version: input.version,
        cloudProvider: input.cloudProvider ?? 'alibaba_cloud',
        iacType: input.iacType ?? 'opentofu',
        modulePathOrRef: input.modulePathOrRef,
        topologySpec: input.topologySpec,
        topologyGraph: input.topologyGraph,
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
    async updateRangeTemplate(id: string, input: UpdateRangeTemplateInput) {
      const record = rangeTemplates.find((template) => template.id === id)!;
      const draftVersion = rangeTemplateVersions.find((item) => item.id === record.currentDraftVersionId)!;

      assignIfDefined(record, 'name', input.name);
      assignIfDefined(record, 'slug', input.slug);
      assignIfDefined(record, 'version', input.version);
      assignIfDefined(record, 'cloudProvider', input.cloudProvider);
      assignIfDefined(record, 'iacType', input.iacType);
      assignIfDefined(record, 'modulePathOrRef', input.modulePathOrRef);
      assignIfDefined(record, 'topologySpec', input.topologySpec);
      assignIfDefined(record, 'topologyGraph', input.topologyGraph);
      assignIfDefined(record, 'compiledSpec', input.compiledSpec);
      assignIfDefined(record, 'variableSchema', input.variableSchema);
      assignIfDefined(record, 'outputSchema', input.outputSchema);
      assignIfDefined(record, 'defaultNetworkPolicy', input.defaultNetworkPolicy);
      record.updatedAt = now();

      assignIfDefined(draftVersion, 'version', input.version);
      assignIfDefined(draftVersion, 'modulePathOrRef', input.modulePathOrRef);
      assignIfDefined(draftVersion, 'topologySpec', input.topologySpec);
      assignIfDefined(draftVersion, 'topologyGraph', input.topologyGraph);
      assignIfDefined(draftVersion, 'compiledSpec', input.compiledSpec);
      assignIfDefined(draftVersion, 'variableSchema', input.variableSchema);
      assignIfDefined(draftVersion, 'outputSchema', input.outputSchema);
      assignIfDefined(draftVersion, 'defaultNetworkPolicy', input.defaultNetworkPolicy);
      draftVersion.updatedAt = now();

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
    async createRangeInstance(input: CreateRangeInstanceInput) {
      const record: RangeInstanceRecord = {
        id: nextId(),
        competitionId: input.competitionId,
        teamId: input.teamId,
        templateId: input.templateId,
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
  };
}
