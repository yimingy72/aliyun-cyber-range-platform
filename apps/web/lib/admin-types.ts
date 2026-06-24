export type CompetitionStatus = 'draft' | 'scheduled' | 'active' | 'completed';

export type Competition = {
  id: string;
  name: string;
  description?: string | null;
  status?: CompetitionStatus | string;
};

export type Team = {
  id: string;
  competitionId: string;
  name: string;
  contactName?: string | null;
  contactEmailOrPhone?: string | null;
};

export type RangeTemplate = {
  id: string;
  name?: string | null;
  slug: string;
  version: string;
  modulePathOrRef?: string | null;
};

export type CompetitionInput = {
  name: string;
  description?: string;
  status?: CompetitionStatus;
};

export type TeamInput = {
  competitionId: string;
  name: string;
  contactName?: string;
  contactEmailOrPhone?: string;
};

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

export type RangeTemplateCreateInput = {
  name: string;
  slug: string;
  version: string;
  modulePathOrRef: string;
  cloudProvider: 'alibaba_cloud';
  iacType: 'opentofu' | 'terraform';
  topologySpec: RangeTemplateTopologySpec;
  variableSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  defaultNetworkPolicy?: Record<string, unknown>;
};

export type RangeTemplateUpdateInput = Partial<RangeTemplateCreateInput>;

export type RangeAccessEntry = {
  hostRole?: string | null;
  publicIp?: string | null;
  privateIp?: string | null;
  ssh?: string | null;
  url?: string | null;
};

export type RangeResourceSummary = {
  mode?: string | null;
  vpcId?: string | null;
  topologySpec?: {
    vpcCidr?: string | null;
  } | null;
};

export type RangeInstance = {
  id: string;
  status: string;
  teamId: string;
  competitionId?: string | null;
  templateId?: string | null;
  lastJobId?: string | null;
  errorSummary?: string | null;
  expiresAt?: string | null;
  accessEntry?: RangeAccessEntry | null;
  resourceSummary?: RangeResourceSummary | null;
  allocatedCidr?: string | null;
};

export type RangeInstanceDetail = RangeInstance & {
  competitionId: string;
  templateId: string;
};

export type RangeInstanceCreateInput = {
  competitionId: string;
  teamId: string;
  templateId: string;
  expiresAt?: string;
};

export type ProvisionJob = {
  id: string;
  rangeInstanceId: string;
  jobType: string;
  status: string;
  triggeredBy: string;
  errorSummary?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
};

export type ProvisionJobStep = {
  id: string;
  jobId: string;
  stepName: string;
  status: string;
  message?: string | null;
  stdoutExcerpt?: string | null;
  stderrExcerpt?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
};

export type CloudConfigSnapshot = {
  region: string;
  zoneId: string;
  provisionerMode: string;
  instanceTypeStrategy: string;
  instanceTypePreferences: string[];
  imageId: string;
  instancePasswordConfigured: boolean;
  providerZipPathConfigured: boolean;
  readyForPlan: boolean;
  checks: Array<{
    key: string;
    label: string;
    configured: boolean;
    required: boolean;
  }>;
};

export type AdminBootstrapData = {
  competitions: Competition[];
  teams: Team[];
  rangeTemplates: RangeTemplate[];
  rangeInstances: RangeInstance[];
  provisionJobs: ProvisionJob[];
};
