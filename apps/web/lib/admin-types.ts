import type { CompiledProvisionSpec } from './compiled-provision-spec';
import type { ScenarioTemplateSpec } from './scenario-template-spec';

export type RangeTemplate = {
  id: string;
  name?: string | null;
  description?: string | null;
  slug: string;
  version: string;
  cloudProvider?: 'alibaba_cloud';
  iacType?: 'opentofu' | 'terraform';
  modulePathOrRef?: string | null;
  variableSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  defaultNetworkPolicy?: Record<string, unknown> | null;
  currentDraftVersionId?: string | null;
  currentPublishedVersionId?: string | null;
  currentDraftVersion?: {
    id: string;
    status: 'draft' | 'published' | 'archived' | string;
    version: string;
    topologySpec?: RangeTemplateTopologySpec | null;
    topologyGraph?: Record<string, unknown> | null;
    scenarioTemplateSpec?: ScenarioTemplateSpec | null;
    compiledProvisionSpec?: CompiledProvisionSpec | null;
    compiledSpec?: RangeTemplateCompiledSpec | null;
  } | null;
  currentPublishedVersion?: {
    id: string;
    status: 'draft' | 'published' | 'archived' | string;
    version: string;
    topologySpec?: RangeTemplateTopologySpec | null;
    topologyGraph?: Record<string, unknown> | null;
    scenarioTemplateSpec?: ScenarioTemplateSpec | null;
    compiledProvisionSpec?: CompiledProvisionSpec | null;
    compiledSpec?: RangeTemplateCompiledSpec | null;
  } | null;
};

export type RangeTemplateCompiledResource = {
  id: string;
  type: string;
  provider: 'alibaba_cloud';
  config: Record<string, unknown>;
};

export type RangeTemplateCompiledTopology = {
  vpcCidr: string;
  publicEntryHostKey: string;
  networkZoneKeys: string[];
  hostKeys: string[];
};

export type RangeTemplateCompiledSpec = {
  schemaVersion: string;
  resources: RangeTemplateCompiledResource[];
  topology?: RangeTemplateCompiledTopology;
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
  description?: string;
  slug: string;
  version: string;
  modulePathOrRef: string;
  cloudProvider: 'alibaba_cloud';
  iacType: 'opentofu' | 'terraform';
  topologySpec: RangeTemplateTopologySpec;
  topologyGraph?: Record<string, unknown>;
  scenarioTemplateSpec?: ScenarioTemplateSpec;
  compiledProvisionSpec?: CompiledProvisionSpec;
  compiledSpec?: RangeTemplateCompiledSpec;
  variableSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  defaultNetworkPolicy?: Record<string, unknown>;
};

export type RangeTemplateUpdateInput = Partial<RangeTemplateCreateInput> & {
  topologySpec?: RangeTemplateTopologySpec | null;
  topologyGraph?: Record<string, unknown> | null;
  scenarioTemplateSpec?: ScenarioTemplateSpec | null;
  compiledProvisionSpec?: CompiledProvisionSpec | null;
  compiledSpec?: RangeTemplateCompiledSpec | null;
};

export type Scenario = RangeTemplate;
export type ScenarioCreateInput = RangeTemplateCreateInput;
export type ScenarioUpdateInput = RangeTemplateUpdateInput;

export type RangeAccessEntry = {
  hostRole?: string | null;
  publicIp?: string | null;
  privateIp?: string | null;
  ssh?: string | null;
  url?: string | null;
};

export type RangeRuntimeSelectionPolicy = {
  mode?: string | null;
  imageId?: string | null;
  preferredInstanceTypes?: string[] | null;
  fallbackInstanceTypes?: string[] | null;
  zoneId?: string | null;
};

export type RangeRuntimeSelections = {
  image_policies?: Record<string, RangeRuntimeSelectionPolicy> | null;
  imagePolicies?: Record<string, RangeRuntimeSelectionPolicy> | null;
  instance_type_policies?: Record<string, RangeRuntimeSelectionPolicy> | null;
  instanceTypePolicies?: Record<string, RangeRuntimeSelectionPolicy> | null;
};

export type RangeRuntimeCredential = {
  username: string;
  password: string;
};

export type RangeRuntimeCredentials = Record<string, RangeRuntimeCredential>;

export type RangeResourceSummary = {
  mode?: string | null;
  modulePath?: string | null;
  workspaceDir?: string | null;
  outputFilePath?: string | null;
  vpcId?: string | null;
  subnetIds?: Record<string, string> | null;
  hostIds?: Record<string, string> | null;
  secondaryNetworkInterfaceIds?: Record<string, string> | null;
  natGatewayIds?: Record<string, string> | null;
  snatEntryIds?: Record<string, string> | null;
  dnatEntryIds?: Record<string, string> | null;
  eipAllocationId?: string | null;
  eipAllocationIds?: Record<string, string> | null;
  bootstrapHostKeys?: string[] | null;
  runtimeSelections?: RangeRuntimeSelections | Record<string, unknown> | null;
  resolvedInstanceType?: string | null;
  resolvedImageId?: string | null;
  topologySpec?: {
    vpcCidr?: string | null;
    publicEntryHostKey?: string | null;
    networkZoneKeys?: string[] | null;
    hostKeys?: string[] | null;
  } | null;
};

export type RangeRecoverySummary = {
  category: 'capacity' | 'quota' | 'credentials' | 'provider_setup' | 'template_blueprint' | 'unknown';
  severity: 'warning' | 'critical';
  canRetry: boolean;
  summary: string;
  suggestions: string[];
};

export type RangeInstance = {
  id: string;
  name?: string | null;
  createdBy?: string | null;
  defaultInstancePassword?: string | null;
  status: string;
  templateId?: string | null;
  templateNameSnapshot?: string | null;
  templateSlugSnapshot?: string | null;
  templateVersionSnapshot?: string | null;
  templateModulePathSnapshot?: string | null;
  sourceTemplateVersionId?: string | null;
  runtimeTopologyGraph?: Record<string, unknown> | null;
  runtimeScenarioTemplateSpec?: Record<string, unknown> | null;
  runtimeCompiledProvisionSpec?: Record<string, unknown> | null;
  runtimeCredentials?: RangeRuntimeCredentials | null;
  draftTopologyGraph?: Record<string, unknown> | null;
  draftScenarioTemplateSpec?: Record<string, unknown> | null;
  draftCompiledProvisionSpec?: Record<string, unknown> | null;
  draftUpdatedBy?: string | null;
  draftUpdatedAt?: string | null;
  lastJobId?: string | null;
  createdAt?: string | null;
  errorSummary?: string | null;
  expiresAt?: string | null;
  accessEntry?: RangeAccessEntry | null;
  resourceSummary?: RangeResourceSummary | null;
  allocatedCidr?: string | null;
  recoverySummary?: RangeRecoverySummary | null;
};

export type RangeInstanceCreateInput = {
  name: string;
  templateId: string;
  expiresAt?: string;
};

export type RangeInstanceLaunchInput = {
  templateId: string;
  name: string;
  expiresAt: string;
  triggeredBy: string;
};

export type RangeInstanceDetail = RangeInstance & {
  templateId: string;
  recoverySummary?: RangeRecoverySummary | null;
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
  provider: 'alibaba_cloud';
  defaultRegion: string;
  defaultZoneId: string;
  accessKeyId: string;
  accessKeySecret: string;
};

export type InstanceTypeAvailabilityMatch = {
  instanceTypeId: string;
  cpu: number;
  memoryGiB: number;
  family: string;
  generation: string;
  architecture: string;
};

export type InstanceTypeAvailabilitySnapshot = {
  cpu: number;
  memory: number;
  regionId: string;
  zoneId: string;
  exactAvailable: boolean;
  matches: InstanceTypeAvailabilityMatch[];
  warning: string | null;
};

export type ImageSnapshot = {
  id: string;
  provider: 'alibaba_cloud';
  accountUid?: string | null;
  regionId: string;
  scope: 'public' | 'custom' | string;
  imageId: string;
  sourceImageName: string;
  osType?: string | null;
  platform?: string | null;
  architecture?: string | null;
  status?: string | null;
  isAvailable: boolean;
  lastSyncedAt?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
};

export type ImageCatalogItem = {
  id: string;
  displayName: string;
  imageId: string;
  provider: 'alibaba_cloud';
  scope: 'public' | 'custom' | string;
  accountUid?: string | null;
  regionId: string;
  enabled: boolean;
  sourceSnapshotId?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
};

export type PlatformImageAsset = {
  id: string;
  provider: 'alibaba_cloud';
  accountUid?: string | null;
  accountScopeKey: string;
  regionId: string;
  sourceScope: 'public' | 'custom' | string;
  sourceSnapshotId?: string | null;
  imageId: string;
  displayName: string;
  enabled: boolean;
  createdAt?: string | null;
  updatedAt?: string | null;
};

export type ImageCatalogScopePayload = {
  snapshots: ImageSnapshot[];
  catalogItems: ImageCatalogItem[];
};

export type PlatformImageAssetListPayload = {
  items: PlatformImageAsset[];
};

export type CollectImageCatalogItemInput = {
  snapshotId: string;
  displayName: string;
};

export type AdminBootstrapData = {
  scenarios: Scenario[];
  rangeTemplates: RangeTemplate[];
  rangeInstances: RangeInstance[];
  provisionJobs: ProvisionJob[];
};
