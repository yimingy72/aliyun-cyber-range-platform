export const ADMIN_REPOSITORY = Symbol('ADMIN_REPOSITORY');

export type CloudProvider = 'alibaba_cloud';
export type IacType = 'opentofu' | 'terraform';
export type RangeTemplateVersionStatus = 'draft' | 'published' | 'archived';
export type RangeInstanceMode = 'range' | 'single';
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
export type ProvisionJobType = 'create' | 'update' | 'destroy' | 'retry' | 'refresh_status';
export type ProvisionJobStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type ProvisionJobStepStatus = 'pending' | 'running' | 'succeeded' | 'failed';
export type CloudImageScope = 'public' | 'custom';

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
  scenarioTemplateSpec?: Record<string, unknown> | null;
  compiledProvisionSpec?: Record<string, unknown> | null;
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
  secondaryNetworkInterfaceIds?: Record<string, string> | null;
  natGatewayIds?: Record<string, string> | null;
  snatEntryIds?: Record<string, string> | null;
  dnatEntryIds?: Record<string, string> | null;
  eipAllocationId?: string | null;
  eipAllocationIds?: Record<string, string> | null;
  bootstrapHostKeys?: string[] | null;
  runtimeSelections?: Record<string, unknown> | null;
  resolvedInstanceType?: string | null;
  resolvedImageId?: string | null;
  topologySpec?: RangeResourceTopologySummary;
};

export type RangeRuntimeCredential = {
  username: string;
  password: string;
};

export type RangeRuntimeCredentials = Record<string, RangeRuntimeCredential>;

export type SingleInstanceConfig = {
  baseName: string;
  quantityIndex: number;
  hostKey: string;
  hostName: string;
  platformImageAssetId: string;
  imageId: string;
  imageDisplayName: string;
  cpu: number;
  memory: number;
  systemDiskSize: number;
  remark?: string | null;
  assignedVswitchId?: string | null;
};

export type SingleInstanceBatchRecord = {
  id: string;
  name: string;
  platformImageAssetId: string;
  imageId: string;
  imageDisplayName: string;
  cpu: number;
  memory: number;
  systemDiskSize: number;
  quantity: number;
  remark: string | null;
  createdBy: string | null;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type SingleInstanceBatchWithInstancesRecord = {
  batch: SingleInstanceBatchRecord;
  instances: RangeInstanceRecord[];
};

export type RangeTemplateRecord = {
  id: string;
  name: string;
  createdBy: string;
  description: string | null;
  slug: string;
  version: string;
  cloudProvider: CloudProvider;
  iacType: IacType;
  modulePathOrRef: string;
  topologySpec: RangeTemplateTopologySpec | null;
  topologyGraph?: Record<string, unknown> | null;
  scenarioTemplateSpec?: Record<string, unknown> | null;
  compiledProvisionSpec?: Record<string, unknown> | null;
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
  name: string;
  createdBy: string | null;
  instanceMode: RangeInstanceMode;
  singleInstanceBatchId?: string | null;
  singleInstanceConfig: SingleInstanceConfig | null;
  templateId: string | null;
  sourceTemplateVersionId: string | null;
  templateNameSnapshot: string | null;
  templateSlugSnapshot: string | null;
  templateVersionSnapshot: string | null;
  templateModulePathSnapshot: string | null;
  runtimeTopologyGraph: Record<string, unknown> | null;
  runtimeScenarioTemplateSpec: Record<string, unknown> | null;
  runtimeCompiledProvisionSpec: Record<string, unknown> | null;
  runtimeCredentials: RangeRuntimeCredentials | null;
  draftTopologyGraph: Record<string, unknown> | null;
  draftScenarioTemplateSpec: Record<string, unknown> | null;
  draftCompiledProvisionSpec: Record<string, unknown> | null;
  draftUpdatedBy: string | null;
  draftUpdatedAt: Date | null;
  status: RangeInstanceStatus;
  allocatedCidr: string | null;
  cloudProvider: CloudProvider;
  accessEntry: RangeAccessEntry | null;
  resourceSummary: RangeResourceSummary | null;
  errorSummary: string | null;
  expiresAt: Date | null;
  lastJobId: string | null;
  nodeStatuses?: Record<string, string> | null;
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

export type CloudImageSnapshotRecord = {
  id: string;
  provider: CloudProvider;
  accountUid: string | null;
  regionId: string;
  scope: CloudImageScope;
  imageId: string;
  sourceImageName: string;
  osType: string | null;
  platform: string | null;
  architecture: string | null;
  status: string | null;
  isAvailable: boolean;
  lastSyncedAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

export type ImageCatalogItemRecord = {
  id: string;
  displayName: string;
  imageId: string;
  provider: CloudProvider;
  scope: CloudImageScope;
  accountUid: string | null;
  regionId: string;
  enabled: boolean;
  sourceSnapshotId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type PlatformImageAssetRecord = {
  id: string;
  provider: CloudProvider;
  accountUid: string | null;
  accountScopeKey: string;
  regionId: string;
  sourceScope: CloudImageScope;
  sourceSnapshotId: string | null;
  imageId: string;
  displayName: string;
  defaultHostName: string | null;
  defaultPassword: string | null;
  description: string | null;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type SingleInstanceNetworkProfileRecord = {
  id: string;
  provider: CloudProvider;
  regionId: string;
  zoneId: string;
  vpcId: string;
  vpcCidr: string;
  vswitchIds: string[];
  vswitchCidrs: string[];
  securityGroupId: string;
  securityGroupName: string;
  createdAt: Date;
  updatedAt: Date;
};

export type UpsertSingleInstanceNetworkProfileInput = {
  provider: CloudProvider;
  regionId: string;
  zoneId: string;
  vpcId: string;
  vpcCidr: string;
  vswitchIds: string[];
  vswitchCidrs: string[];
  securityGroupId: string;
  securityGroupName: string;
};

export type ListImageSnapshotsFilter = Partial<{
  provider: CloudProvider;
  accountUid: string | null;
  regionId: string;
  scope: CloudImageScope;
  imageId: string;
}>;

export type UpsertImageSnapshotInput = {
  imageId: string;
  sourceImageName: string;
  osType?: string | null;
  platform?: string | null;
  architecture?: string | null;
  status?: string | null;
  isAvailable?: boolean;
  lastSyncedAt: Date;
};

export type UpsertImageSnapshotsInput = {
  provider: CloudProvider;
  accountUid: string | null;
  regionId: string;
  scope: CloudImageScope;
  snapshots: UpsertImageSnapshotInput[];
};

export type ReconcileImageSnapshotsInput = UpsertImageSnapshotsInput;

export type ListImageCatalogItemsFilter = Partial<{
  provider: CloudProvider;
  scope: CloudImageScope;
  accountUid: string | null;
  regionId: string;
  enabled: boolean;
}>;

export type CollectImageCatalogItemInput = {
  displayName: string;
  imageId: string;
  provider: CloudProvider;
  scope: CloudImageScope;
  accountUid: string | null;
  regionId: string;
  sourceSnapshotId?: string | null;
  enabled?: boolean;
};

export type ListPlatformImageAssetsFilter = Partial<{
  provider: CloudProvider;
  accountUid: string | null;
  accountScopeKey: string;
  regionId: string;
  enabled: boolean;
  imageId: string;
  sourceSnapshotId: string | null;
  onlyAvailableSourceSnapshots: boolean;
}>;

export type CollectPlatformImageAssetInput = {
  snapshotId: string;
  displayName: string;
  defaultHostName?: string | null;
  defaultPassword?: string | null;
  description?: string | null;
};

export type CreateRangeTemplateInput = {
  name: string;
  createdBy?: string;
  description?: string;
  slug: string;
  version: string;
  cloudProvider?: CloudProvider;
  iacType?: IacType;
  modulePathOrRef: string;
  topologySpec: RangeTemplateTopologySpec;
  topologyGraph?: Record<string, unknown>;
  scenarioTemplateSpec?: Record<string, unknown>;
  compiledProvisionSpec?: Record<string, unknown>;
  compiledSpec?: Record<string, unknown>;
  variableSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  defaultNetworkPolicy?: Record<string, unknown>;
};

export type UpdateRangeTemplateInput = Partial<Omit<CreateRangeTemplateInput, 'createdBy'>>;

export type CreateSingleInstanceBatchInput = {
  name: string;
  platformImageAssetId: string;
  imageId: string;
  imageDisplayName: string;
  cpu: number;
  memory: number;
  systemDiskSize: number;
  quantity: number;
  remark?: string | null;
  createdBy?: string | null;
  expiresAt?: Date | null;
};

export type CreateRangeInstanceInput = {
  name: string;
  createdBy?: string;
  templateId?: string | null;
  sourceTemplateVersionId?: string | null;
  runtimeTopologyGraph?: Record<string, unknown> | null;
  runtimeScenarioTemplateSpec?: Record<string, unknown> | null;
  runtimeCompiledProvisionSpec?: Record<string, unknown> | null;
  runtimeCredentials?: RangeRuntimeCredentials | null;
  draftTopologyGraph?: Record<string, unknown> | null;
  draftScenarioTemplateSpec?: Record<string, unknown> | null;
  draftCompiledProvisionSpec?: Record<string, unknown> | null;
  draftUpdatedBy?: string | null;
  draftUpdatedAt?: Date | null;
  status?: RangeInstanceStatus;
  instanceMode?: RangeInstanceMode;
  singleInstanceBatchId?: string | null;
  singleInstanceConfig?: SingleInstanceConfig | null;
  allocatedCidr?: string;
  accessEntry?: RangeAccessEntry | null;
  resourceSummary?: RangeResourceSummary | null;
  errorSummary?: string | null;
  expiresAt?: string;
  lastJobId?: string | null;
};

export type UpdateRangeInstanceInput = Partial<{
  name: string;
  createdBy: string | null;
  instanceMode: RangeInstanceMode;
  singleInstanceBatchId: string | null;
  singleInstanceConfig: SingleInstanceConfig | null;
  sourceTemplateVersionId: string | null;
  runtimeTopologyGraph: Record<string, unknown> | null;
  runtimeScenarioTemplateSpec: Record<string, unknown> | null;
  runtimeCompiledProvisionSpec: Record<string, unknown> | null;
  runtimeCredentials: RangeRuntimeCredentials | null;
  draftTopologyGraph: Record<string, unknown> | null;
  draftScenarioTemplateSpec: Record<string, unknown> | null;
  draftCompiledProvisionSpec: Record<string, unknown> | null;
  draftUpdatedBy: string | null;
  draftUpdatedAt: Date | null;
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
  listRangeTemplates(): Promise<RangeTemplateRecord[]>;
  createRangeTemplate(input: CreateRangeTemplateInput): Promise<RangeTemplateRecord>;
  getRangeTemplateById(id: string): Promise<RangeTemplateRecord | null>;
  getRangeTemplateVersionById(id: string): Promise<RangeTemplateVersionRecord | null>;
  updateRangeTemplate(id: string, input: UpdateRangeTemplateInput): Promise<RangeTemplateRecord>;
  publishRangeTemplate(id: string): Promise<RangeTemplateRecord>;
  unpublishRangeTemplate(id: string): Promise<RangeTemplateRecord>;
  deleteRangeTemplate(id: string): Promise<void>;
  createSingleInstanceBatch(input: CreateSingleInstanceBatchInput): Promise<SingleInstanceBatchRecord>;
  getSingleInstanceBatchById(id: string): Promise<SingleInstanceBatchRecord | null>;
  listSingleInstanceBatchesWithInstances(): Promise<SingleInstanceBatchWithInstancesRecord[]>;
  listRangeInstances(): Promise<RangeInstanceRecord[]>;
  archiveDestroyedRangeInstancesForDeletedTemplate(template: RangeTemplateRecord): Promise<void>;
  deleteRangeInstance(id: string): Promise<void>;
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
  listImageSnapshots(filter: ListImageSnapshotsFilter): Promise<CloudImageSnapshotRecord[]>;
  getImageSnapshotById(id: string): Promise<CloudImageSnapshotRecord | null>;
  upsertImageSnapshots(input: UpsertImageSnapshotsInput): Promise<void>;
  reconcileImageSnapshots(input: ReconcileImageSnapshotsInput): Promise<void>;
  listImageCatalogItems(filter?: ListImageCatalogItemsFilter): Promise<ImageCatalogItemRecord[]>;
  collectImageCatalogItem(input: CollectImageCatalogItemInput): Promise<ImageCatalogItemRecord>;
  getPlatformImageAssetById(id: string): Promise<PlatformImageAssetRecord | null>;
  listPlatformImageAssets(filter?: ListPlatformImageAssetsFilter): Promise<PlatformImageAssetRecord[]>;
  collectPlatformImageAsset(input: CollectPlatformImageAssetInput): Promise<PlatformImageAssetRecord>;
  updatePlatformImageAsset(id: string, input: { displayName: string }): Promise<PlatformImageAssetRecord>;
  setPlatformImageAssetEnabled(id: string, enabled: boolean): Promise<PlatformImageAssetRecord>;
  deletePlatformImageAsset(id: string): Promise<void>;
  deletePlatformImageAssetsBySnapshotId(snapshotId: string): Promise<void>;
  getSingleInstanceNetworkProfile(input: {
    provider: CloudProvider;
    regionId: string;
    zoneId: string;
  }): Promise<SingleInstanceNetworkProfileRecord | null>;
  upsertSingleInstanceNetworkProfile(
    input: UpsertSingleInstanceNetworkProfileInput,
  ): Promise<SingleInstanceNetworkProfileRecord>;
}
