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
  const rangeInstances: RangeInstanceRecord[] = [];
  const provisionJobs: ProvisionJobRecord[] = [];
  const provisionJobStepLogs: ProvisionJobStepLogRecord[] = [];

  let idCounter = 1;

  const nextId = () => `memory-${idCounter++}`;
  const now = () => new Date();
  const clone = <T extends Record<string, unknown>>(record: T): T => ({ ...record });
  const cloneList = <T extends Record<string, unknown>>(records: T[]): T[] => records.map((record) => clone(record));

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
      const record: RangeTemplateRecord = {
        id: nextId(),
        name: input.name,
        slug: input.slug,
        version: input.version,
        cloudProvider: input.cloudProvider ?? 'alibaba_cloud',
        iacType: input.iacType ?? 'opentofu',
        modulePathOrRef: input.modulePathOrRef,
        topologySpec: input.topologySpec,
        variableSchema: input.variableSchema ?? {},
        outputSchema: input.outputSchema ?? {},
        defaultNetworkPolicy: input.defaultNetworkPolicy ?? null,
        createdAt: now(),
        updatedAt: now(),
      };

      rangeTemplates.unshift(record);

      return clone(record);
    },
    async getRangeTemplateById(id: string) {
      const record = rangeTemplates.find((template) => template.id === id);

      return record ? clone(record) : null;
    },
    async updateRangeTemplate(id: string, input: UpdateRangeTemplateInput) {
      const record = rangeTemplates.find((template) => template.id === id)!;

      Object.assign(record, {
        name: input.name ?? record.name,
        slug: input.slug ?? record.slug,
        version: input.version ?? record.version,
        cloudProvider: input.cloudProvider ?? record.cloudProvider,
        iacType: input.iacType ?? record.iacType,
        modulePathOrRef: input.modulePathOrRef ?? record.modulePathOrRef,
        topologySpec: input.topologySpec ?? record.topologySpec,
        variableSchema: input.variableSchema ?? record.variableSchema,
        outputSchema: input.outputSchema ?? record.outputSchema,
        defaultNetworkPolicy: input.defaultNetworkPolicy ?? record.defaultNetworkPolicy,
        updatedAt: now(),
      });

      return clone(record);
    },
    async deleteRangeTemplate(id: string) {
      const index = rangeTemplates.findIndex((template) => template.id === id);

      if (index >= 0) {
        rangeTemplates.splice(index, 1);
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
        retryCount: 0,
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
