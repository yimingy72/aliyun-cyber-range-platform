export type Competition = {
  id: string;
  name: string;
  description?: string | null;
  status?: string;
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
  lastJobId?: string | null;
  errorSummary?: string | null;
  expiresAt?: string | null;
  accessEntry?: RangeAccessEntry | null;
  resourceSummary?: RangeResourceSummary | null;
};

export type RangeInstanceDetail = RangeInstance & {
  competitionId: string;
  templateId: string;
};

export type ProvisionJob = {
  id: string;
  rangeInstanceId: string;
  jobType: string;
  status: string;
  triggeredBy: string;
  errorSummary?: string | null;
};

export type ProvisionJobStep = {
  id: string;
  jobId: string;
  stepName: string;
  status: string;
  message?: string | null;
  stdoutExcerpt?: string | null;
  stderrExcerpt?: string | null;
};

export type CloudConfigSnapshot = {
  region: string;
  zoneId: string;
  provisionerMode: string;
  instanceTypeStrategy: string;
  instanceTypePreferences: string[];
};

export type AdminBootstrapData = {
  competitions: Competition[];
  teams: Team[];
  rangeTemplates: RangeTemplate[];
  rangeInstances: RangeInstance[];
  provisionJobs: ProvisionJob[];
};
