export const ADMIN_REPOSITORY = Symbol('ADMIN_REPOSITORY');

export type CompetitionStatus = 'draft' | 'scheduled' | 'active' | 'completed';
export type CloudProvider = 'alibaba_cloud';
export type IacType = 'opentofu' | 'terraform';
export type RangeTemplateVersionStatus = 'draft' | 'published' | 'archived';
export type RangeInstanceStatus =
  | 'draft'
  | 'pending_create'
  | 'creating'
  | 'running'
  | 'create_failed'
  | 'pending_destroy'
  | 'destroying'
  | 'destroy_failed'
  | 'destroyed';
export type ProvisionJobType = 'create' | 'destroy' | 'retry' | 'refresh_status';
export type ProvisionJobStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type ProvisionJobStepStatus = 'pending' | 'running' | 'succeeded' | 'failed';

export type RangeTemplateNetworkZone = {
  key: string;
  name: string;
  purpose: string;
  cidr: string;
  isPublicEntry?: boolean;
};

export type RangeTemplateHost = {
  key: string;
  name: string;
  zoneKey: string;
  role: string;
  privateIp: string;
  exposePublic?: boolean;
};

export type RangeTemplateEntryProtocol = {
  protocol: string;
  port: number;
};

export type RangeTemplatePublicEntry = {
  hostKey: string;
  protocols: RangeTemplateEntryProtocol[];
};

export type RangeTemplateTopologySpec = {
  vpcCidr: string;
  networkZones: RangeTemplateNetworkZone[];
  hosts: RangeTemplateHost[];
  publicEntry: RangeTemplatePublicEntry;
  executionPolicies?: Record<string, unknown>;
};

export type TopologyGraphNode = {
  id: string;
  kind: string;
  position?: { x: number; y: number };
  data: Record<string, unknown>;
};

export type TopologyGraphEdge = {
  id: string;
  source: string;
  target: string;
  kind?: string;
  data?: Record<string, unknown>;
};

export type RangeTemplateTopologyGraph = {
  schemaVersion: string;
  nodes: TopologyGraphNode[];
  edges: TopologyGraphEdge[];
  viewport?: Record<string, unknown>;
  templateMeta?: Record<string, unknown>;
  publishConfig?: Record<string, unknown>;
};

export type RangeTemplateCompiledSpec = {
  schemaVersion: string;
  resources: Array<{
    id: string;
    type: string;
    provider?: string;
    config: Record<string, unknown>;
  }>;
  topology?: {
    vpcCidr: string;
    publicEntryHostKey: string;
    networkZoneKeys: string[];
    hostKeys: string[];
  };
  topologySpec?: RangeTemplateTopologySpec | null;
  variables?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
};

export type RangeTemplateVersionRecord = {
  id: string;
  templateId: string;
  version: string;
  status: RangeTemplateVersionStatus;
  modulePathOrRef: string;
  topologySpec: RangeTemplateTopologySpec | null;
  topologyGraph?: Record<string, unknown> | null;
  compiledSpec?: Record<string, unknown> | null;
  variableSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  defaultNetworkPolicy: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
};

export type RangeAccessEntry = {
  hostRole: string;
  publicIp: string | null;
  privateIp: string | null;
  ssh: string | null;
  url?: string | null;
};

export type RangeResourceTopologySummary = {
  vpcCidr: string;
  publicEntryHostKey: string;
  networkZoneKeys: string[];
  hostKeys: string[];
};

export type RangeResourceSummary = {
  mode: 'dry-run' | 'opentofu';
  modulePath?: string;
  workspaceDir?: string;
  outputFilePath?: string;
  vpcId?: string | null;
  subnetIds?: Record<string, string> | null;
  hostIds?: Record<string, string> | null;
  natGatewayIds?: Record<string, string> | null;
  eipAllocationId?: string | null;
  eipAllocationIds?: Record<string, string> | null;
  topologySpec?: RangeResourceTopologySummary;
};

export type CompetitionRecord = {
  id: string;
  name: string;
  description: string | null;
  status: CompetitionStatus;
  startAt: Date | null;
  endAt: Date | null;
  defaultTemplateId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type TeamRecord = {
  id: string;
  competitionId: string;
  name: string;
  contactName: string | null;
  contactEmailOrPhone: string | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type RangeTemplateRecord = {
  id: string;
  name: string;
  slug: string;
  version: string;
  cloudProvider: CloudProvider;
  iacType: IacType;
  modulePathOrRef: string;
  topologySpec: RangeTemplateTopologySpec | null;
  topologyGraph?: Record<string, unknown> | null;
  compiledSpec?: Record<string, unknown> | null;
  variableSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  defaultNetworkPolicy: Record<string, unknown> | null;
  currentDraftVersionId: string | null;
  currentPublishedVersionId: string | null;
  currentDraftVersion?: RangeTemplateVersionRecord | null;
  currentPublishedVersion?: RangeTemplateVersionRecord | null;
  versions?: RangeTemplateVersionRecord[];
  createdAt: Date;
  updatedAt: Date;
};

export type RangeInstanceRecord = {
  id: string;
  competitionId: string;
  teamId: string;
  templateId: string;
  status: RangeInstanceStatus;
  allocatedCidr: string | null;
  cloudProvider: CloudProvider;
  accessEntry: RangeAccessEntry | null;
  resourceSummary: RangeResourceSummary | null;
  errorSummary: string | null;
  expiresAt: Date | null;
  lastJobId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type ProvisionJobRecord = {
  id: string;
  rangeInstanceId: string;
  jobType: ProvisionJobType;
  status: ProvisionJobStatus;
  triggeredBy: string;
  startedAt: Date | null;
  finishedAt: Date | null;
  retryCount: number;
  errorSummary: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type ProvisionJobStepLogRecord = {
  id: string;
  jobId: string;
  stepName: string;
  status: ProvisionJobStepStatus;
  message: string | null;
  stdoutExcerpt: string | null;
  stderrExcerpt: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type CreateCompetitionInput = {
  name: string;
  description?: string;
  status?: CompetitionStatus;
  startAt?: string;
  endAt?: string;
  defaultTemplateId?: string;
};

export type UpdateCompetitionInput = Partial<CreateCompetitionInput>;

export type CreateTeamInput = {
  competitionId: string;
  name: string;
  contactName?: string;
  contactEmailOrPhone?: string;
  notes?: string;
};

export type UpdateTeamInput = Partial<Omit<CreateTeamInput, 'competitionId'>> & {
  competitionId?: string;
};

export type CreateRangeTemplateInput = {
  name: string;
  slug: string;
  version: string;
  cloudProvider?: CloudProvider;
  iacType?: IacType;
  modulePathOrRef: string;
  topologySpec: RangeTemplateTopologySpec;
  topologyGraph?: Record<string, unknown>;
  compiledSpec?: Record<string, unknown>;
  variableSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  defaultNetworkPolicy?: Record<string, unknown>;
};

export type UpdateRangeTemplateInput = Partial<CreateRangeTemplateInput>;

export type CreateRangeInstanceInput = {
  competitionId: string;
  teamId: string;
  templateId: string;
  status?: RangeInstanceStatus;
  allocatedCidr?: string;
  accessEntry?: RangeAccessEntry | null;
  resourceSummary?: RangeResourceSummary | null;
  errorSummary?: string | null;
  expiresAt?: string;
  lastJobId?: string | null;
};

export type UpdateRangeInstanceInput = Partial<{
  status: RangeInstanceStatus;
  allocatedCidr: string | null;
  accessEntry: RangeAccessEntry | null;
  resourceSummary: RangeResourceSummary | null;
  errorSummary: string | null;
  expiresAt: Date | null;
  lastJobId: string | null;
}>;

export type CreateProvisionJobInput = {
  rangeInstanceId: string;
  jobType: ProvisionJobType;
  triggeredBy: string;
  status?: ProvisionJobStatus;
  retryCount?: number;
};

export type UpdateProvisionJobInput = Partial<{
  status: ProvisionJobStatus;
  startedAt: Date | null;
  finishedAt: Date | null;
  retryCount: number;
  errorSummary: string | null;
}>;

export type CreateProvisionJobStepLogInput = {
  jobId: string;
  stepName: string;
  status?: ProvisionJobStepStatus;
  message?: string | null;
  stdoutExcerpt?: string | null;
  stderrExcerpt?: string | null;
  startedAt?: Date | null;
  finishedAt?: Date | null;
};

export type UpdateProvisionJobStepLogInput = Partial<{
  status: ProvisionJobStepStatus;
  message: string | null;
  stdoutExcerpt: string | null;
  stderrExcerpt: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
}>;

export interface AdminRepository {
  listCompetitions(): Promise<CompetitionRecord[]>;
  createCompetition(input: CreateCompetitionInput): Promise<CompetitionRecord>;
  getCompetitionById(id: string): Promise<CompetitionRecord | null>;
  updateCompetition(id: string, input: UpdateCompetitionInput): Promise<CompetitionRecord>;
  deleteCompetition(id: string): Promise<void>;
  listTeams(filter?: { competitionId?: string }): Promise<TeamRecord[]>;
  createTeam(input: CreateTeamInput): Promise<TeamRecord>;
  getTeamById(id: string): Promise<TeamRecord | null>;
  updateTeam(id: string, input: UpdateTeamInput): Promise<TeamRecord>;
  deleteTeam(id: string): Promise<void>;
  listRangeTemplates(): Promise<RangeTemplateRecord[]>;
  createRangeTemplate(input: CreateRangeTemplateInput): Promise<RangeTemplateRecord>;
  getRangeTemplateById(id: string): Promise<RangeTemplateRecord | null>;
  updateRangeTemplate(id: string, input: UpdateRangeTemplateInput): Promise<RangeTemplateRecord>;
  publishRangeTemplate(id: string): Promise<RangeTemplateRecord>;
  deleteRangeTemplate(id: string): Promise<void>;
  listRangeInstances(): Promise<RangeInstanceRecord[]>;
  createRangeInstance(input: CreateRangeInstanceInput): Promise<RangeInstanceRecord>;
  getRangeInstanceById(id: string): Promise<RangeInstanceRecord | null>;
  updateRangeInstance(id: string, input: UpdateRangeInstanceInput): Promise<RangeInstanceRecord>;
  listProvisionJobs(): Promise<ProvisionJobRecord[]>;
  createProvisionJob(input: CreateProvisionJobInput): Promise<ProvisionJobRecord>;
  getProvisionJobById(id: string): Promise<ProvisionJobRecord | null>;
  claimProvisionJob(id: string, startedAt: Date): Promise<ProvisionJobRecord | null>;
  updateProvisionJob(id: string, input: UpdateProvisionJobInput): Promise<ProvisionJobRecord>;
  listProvisionJobStepLogs(jobId: string): Promise<ProvisionJobStepLogRecord[]>;
  createProvisionJobStepLog(input: CreateProvisionJobStepLogInput): Promise<ProvisionJobStepLogRecord>;
  updateProvisionJobStepLog(id: string, input: UpdateProvisionJobStepLogInput): Promise<ProvisionJobStepLogRecord>;
}
