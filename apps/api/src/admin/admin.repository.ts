import type { RangeDnsVerification } from './range-dns-types';
import type { HostDnsConfig } from '@aliyun-cyber-range/scenario-runtime/compiled';

export const ADMIN_REPOSITORY = Symbol('ADMIN_REPOSITORY');

export type CloudProvider = 'alibaba_cloud' | 'tencent_cloud';
export type IacType = 'opentofu' | 'terraform';
export type UserRole = 'admin' | 'user';
export type UserStatus = 'active' | 'disabled';
export type OperationSource = 'web' | 'mcp' | 'system';
export type OperationAuditPhase = 'requested' | 'confirmation_required' | 'confirmed' | 'dispatched' | 'succeeded' | 'failed';
export type IdempotentOperationStatus = 'accepted' | 'succeeded' | 'failed';
export type ResourceVisibility = 'private' | 'platform';
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
export type BillingScope = 'user' | 'platform';
export type BillingLedgerResourceType =
  | 'ecs'
  | 'disk'
  | 'eip'
  | 'nat_gateway'
  | 'snat_entry'
  | 'dnat_entry'
  | 'image'
  | 'snapshot'
  | 'snapshot_region'
  | 'oss_bucket'
  | 'unknown';
export type CloudResourceDriftSeverity = 'warning' | 'critical';

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
  hostName?: string | null;
  zoneKey: string;
  role: string;
  privateIp: string;
  exposePublic?: boolean;
  dns?: HostDnsConfig;
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
  cloudWorkspaceId?: string;
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
  retiredResources?: RangeResourceSummary | null;
  creationAttempted?: boolean;
  executionContext?: { provider?: CloudProvider; cloudAccountContextId: string; cloudAccountUid: string; regionId: string; zoneId: string };
  mode: 'dry-run' | 'opentofu' | 'ecs-native';
  modulePath?: string;
  workspaceDir?: string;
  outputFilePath?: string;
  vpcId?: string | null;
  routeTableIds?: Record<string, string> | null;
  subnetIds?: Record<string, string> | null;
  networkAclIds?: Record<string, string> | null;
  securityGroupIds?: Record<string, string> | null;
  hostIds?: Record<string, string> | null;
  systemDiskIds?: Record<string, string> | null;
  dataDiskIds?: Record<string, string> | null;
  unverifiedDiskIds?: Record<string, string> | null;
  diskInventoryHostIds?: Record<string, string> | null;
  diskOwnershipProofs?: Record<string, { instanceId: string | null; method: 'persisted' | 'tags' }> | null;
  secondaryNetworkInterfaceIds?: Record<string, string> | null;
  natGatewayIds?: Record<string, string> | null;
  snatEntryIds?: Record<string, string> | null;
  dnatEntryIds?: Record<string, string> | null;
  eipAllocationId?: string | null;
  eipAllocationIds?: Record<string, string> | null;
  bootstrapHostKeys?: string[] | null;
  dnsVerification?: Record<string, RangeDnsVerification>;
  runtimeSelections?: Record<string, unknown> | null;
  resolvedInstanceType?: string | null;
  resolvedImageId?: string | null;
  resolvedImageIds?: Record<string, string> | null;
  topologySpec?: RangeResourceTopologySummary;
};

export type RangeRuntimeCredential = {
  username: string;
  password: string;
};

export type RangeRuntimeCredentials = Record<string, RangeRuntimeCredential>;

export type SingleInstanceConfig = {
  executionBackend?: 'opentofu' | 'ecs-native';
  cloudAccountContextId?: string | null;
  cloudAccountUid?: string | null;
  regionId?: string;
  zoneId?: string;
  networkProfileId?: string;
  resolvedInstanceType?: string;
  nativeCreateJobId?: string;
  opentofuCreateJobId?: string | null;
  autoReleaseTime?: string | null;
  baseName: string;
  quantityIndex: number;
  hostKey: string;
  hostName: string | null;
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
  cloudWorkspaceId?: string;
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
  ownerUserId: string | null;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type SingleInstanceBatchWithInstancesRecord = {
  cloudWorkspaceId?: string;
  batch: SingleInstanceBatchRecord;
  instances: RangeInstanceRecord[];
};

export type RangeTemplateRecord = {
  cloudWorkspaceId?: string;
  id: string;
  name: string;
  createdBy: string;
  ownerUserId: string | null;
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
  visibility: ResourceVisibility;
  revision: number;
  currentDraftVersionId: string | null;
  currentPublishedVersionId: string | null;
  currentDraftVersion?: RangeTemplateVersionRecord | null;
  currentPublishedVersion?: RangeTemplateVersionRecord | null;
  versions?: RangeTemplateVersionRecord[];
  createdAt: Date;
  updatedAt: Date;
};

export type RangeInstanceRecord = {
  cloudWorkspaceId?: string;
  id: string;
  name: string;
  createdBy: string | null;
  ownerUserId: string | null;
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
  draftTopologySpec?: Record<string, unknown> | null;
  draftScenarioTemplateSpec: Record<string, unknown> | null;
  draftCompiledProvisionSpec: Record<string, unknown> | null;
  draftRevision?: number;
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

export type ProvisionJobTopologySnapshot = {
  draftRevision: number;
  topologyGraph: Record<string, unknown>;
  topologySpec: Record<string, unknown>;
  scenarioTemplateSpec: Record<string, unknown>;
  compiledProvisionSpec: Record<string, unknown>;
  compiledSpec: Record<string, unknown>;
  templateModulePath: string;
  runtimeCredentials?: RangeRuntimeCredentials | null;
  operation?: 'create' | 'update' | 'destroy';
  changeApproval?: import('./range-draft-change-policy').RangeChangeApproval;
};

export type ProvisionJobRecord = {
  cloudWorkspaceId?: string;
  id: string;
  rangeInstanceId: string;
  jobType: ProvisionJobType;
  topologySnapshot: ProvisionJobTopologySnapshot | null;
  status: ProvisionJobStatus;
  triggeredBy: string;
  startedAt: Date | null;
  finishedAt: Date | null;
  retryCount: number;
  errorSummary: string | null;
  createdAt: Date;
  availableAt?: Date;
  updatedAt: Date;
};

export type ProvisionJobStepLogRecord = {
  cloudWorkspaceId?: string;
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

export type PlatformUserRecord = {
  cloudWorkspaceId?: string | null;
  loginUsername?: string;
  isPlatformManager?: boolean;
  selectedCloudWorkspaceId?: string | null;
  id: string;
  username: string;
  passwordHash: string;
  oidcIssuer: string | null;
  oidcSubject: string | null;
  role: UserRole;
  status: UserStatus;
  createdAt: Date;
  updatedAt: Date;
};

export type OperationConfirmationRecord = {
  cloudWorkspaceId?: string;
  id: string;
  actorUserId: string;
  oauthClientId: string;
  toolName: string;
  argumentsHash: string;
  targetSnapshot: Record<string, unknown> | null;
  idempotencyKey: string;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
};

export type IdempotentOperationRecord = {
  cloudWorkspaceId?: string;
  id: string;
  actorUserId: string;
  toolName: string;
  idempotencyKey: string;
  argumentsHash: string;
  operationId: string;
  status: IdempotentOperationStatus;
  result: Record<string, unknown> | null;
  errorCode: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type OperationAuditEventInput = {
  cloudWorkspaceId?: string;
  operationId: string;
  requestId: string;
  actorUserId: string;
  source: OperationSource;
  oauthClientId?: string | null;
  toolName: string;
  phase: OperationAuditPhase;
  targetType?: string | null;
  targetId?: string | null;
  sanitizedInput?: Record<string, unknown> | null;
  jobId?: string | null;
  errorCode?: string | null;
  durationMs?: number | null;
};

export type OperationAuditEventRecord = Required<Pick<OperationAuditEventInput, 'operationId' | 'requestId' | 'actorUserId' | 'source' | 'toolName' | 'phase'>> & {
  cloudWorkspaceId?: string;
  id: string;
  oauthClientId: string | null;
  targetType: string | null;
  targetId: string | null;
  sanitizedInput: Record<string, unknown> | null;
  jobId: string | null;
  errorCode: string | null;
  durationMs: number | null;
  createdAt: Date;
};

export type CloudImageSnapshotRecord = {
  minimumSystemDiskSize?: number | null;
  cloudWorkspaceId?: string;
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

export type PackedImageArtifactRecord = {
  cloudProvider?: CloudProvider;
  cloudWorkspaceId?: string;
  id: string;
  cloudAccountContextId: string;
  cloudAccountUid: string;
  regionId: string;
  ownerUserId: string;
  sourceRangeInstanceId: string;
  sourceHostKey: string;
  sourceInstanceId: string;
  sourceDiskIds: string[];
  sourceSnapshotBaseline: Record<string, unknown> | null;
  imageId: string | null;
  sourceSnapshotId: string | null;
  platformImageAssetId: string | null;
  status: string;
  backingSnapshotIds: string[];
  deletedSnapshotIds: string[];
  cloudImageDeletedAt: Date | null;
  completedAt: Date | null;
  lastPolledAt: Date | null;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
};
export type CreatePackedImageArtifactInput = Pick<PackedImageArtifactRecord,
  'cloudAccountContextId' | 'cloudAccountUid' | 'regionId' | 'ownerUserId' | 'sourceRangeInstanceId' | 'sourceHostKey' | 'sourceInstanceId' | 'sourceDiskIds'> & { cloudProvider?: CloudProvider; id?: string; sourceSnapshotBaseline?: Record<string, unknown> };
export type UpdatePackedImageArtifactInput = Partial<Pick<PackedImageArtifactRecord,
  'imageId' | 'sourceSnapshotId' | 'platformImageAssetId' | 'status' | 'backingSnapshotIds' | 'deletedSnapshotIds' | 'cloudImageDeletedAt' | 'completedAt' | 'lastPolledAt' | 'errorMessage'>>;

export type ImageCatalogItemRecord = {
  cloudWorkspaceId?: string;
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
  cloudWorkspaceId?: string;
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
  ownerUserId: string | null;
  visibility: ResourceVisibility;
  enabled: boolean;
  tags: PlatformImageTagRecord[];
  createdAt: Date;
  updatedAt: Date;
};

export type PlatformImageTagRecord = {
  cloudWorkspaceId?: string;
  id: string;
  name: string;
  normalizedName: string;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type SingleInstanceNetworkProfileRecord = {
  cloudWorkspaceId?: string;
  createdByUserId?:string|null;
  cleanupRunId?:string|null;
  cleanupRegisteredByUserId?:string|null;
  cleanupOwnerUserIds?:string[]|null;
  status?: string;
  cloudAccountUid?: string;
  cloudAccountContextId?: string | null;
  workspaceKey?: string | null;
  managedByPlatform?: boolean;
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

// Only identifiers and lifecycle evidence needed for billing; no upload credentials or image password.
export type BillingImageImportResourceRecord = {
  cloudProvider?: CloudProvider;
  cloudAccountContextId?: string;
  managedBucketId?: string | null;
  ownerUserId?: string;
  taskId?: string | null;
  sourceSizeBytes?: string;
  sourceObjectProof?: unknown;
  cloudWorkspaceId?: string;
  id: string;
  cloudAccountUid: string | null;
  regionId: string | null;
  imageImportBucket: string | null;
  objectKey: string;
  imageId: string | null;
  backingSnapshotIds: string[];
  cloudImageDeletedAt: Date | null;
  snapshotCleanupCompletedAt: Date | null;
  createdAt: Date;
  uploadCompletedAt: Date | null;
  temporaryObjectDeletedAt: Date | null;
};

export type BillingManagedCosBucketRecord = import('./tencent-cos-proof').CosBucketIdentity;

export type BillingLedgerResourceRecord = {
  cloudWorkspaceId?: string;
  id: string;
  cloudProvider: CloudProvider;
  cloudAccountUid: string | null;
  regionId: string;
  cloudResourceId: string;
  cloudResourceType: BillingLedgerResourceType;
  billingScope: BillingScope;
  ownerUserId: string | null;
  rangeInstanceId: string | null;
  singleInstanceBatchId: string | null;
  platformImageAssetId: string | null;
  sourceProvisionJobId: string | null;
  billingStartAt: Date;
  releasedAt: Date | null;
  tagsSnapshot: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
};

export type BillingLineItemRecord = {
  cloudProvider?: CloudProvider;
  cloudWorkspaceId?: string;
  id: string;
  cloudAccountUid?: string | null;
  syncBatchId: string;
  sourceFingerprint: string;
  billCycle: string;
  billingDate: Date;
  productCode: string;
  productDetail: string | null;
  billItem: string;
  cloudResourceId: string;
  cloudResourceType: BillingLedgerResourceType;
  pretaxAmount: number;
  currency: string;
  billingScope: BillingScope;
  ownerUserId: string | null;
  matchedLedgerId: string | null;
  rawPayload: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
};

export type BillingAnomalyRecord = {
  cloudProvider?: CloudProvider;
  cloudWorkspaceId?: string;
  id: string;
  cloudAccountUid?: string | null;
  syncBatchId: string;
  sourceFingerprint: string;
  billCycle: string;
  billingDate: Date;
  cloudResourceId: string;
  cloudResourceType: BillingLedgerResourceType;
  pretaxAmount: number;
  currency: string;
  reason: string;
  rawPayload: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
};

export type CloudResourceDriftRecord = {
  cloudWorkspaceId?: string;
  id: string;
  cloudProvider: CloudProvider;
  regionId: string;
  cloudResourceType: string;
  cloudResourceId: string;
  rangeInstanceId: string | null;
  severity: CloudResourceDriftSeverity;
  reason: string;
  tagsSnapshot: Record<string, unknown>;
  firstSeenAt: Date;
  lastSeenAt: Date;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type UpsertCloudResourceDriftInput = {
  cloudWorkspaceId?: string;
  cloudProvider?: CloudProvider;
  regionId: string;
  cloudResourceType: string;
  cloudResourceId: string;
  rangeInstanceId?: string | null;
  severity: CloudResourceDriftSeverity;
  reason: string;
  tagsSnapshot?: Record<string, unknown>;
  observedAt: Date;
};

export type UpsertSingleInstanceNetworkProfileInput = {
  cloudWorkspaceId?: string;
  createdByUserId?:string|null;
  status?: string;
  cloudAccountUid?: string;
  cloudAccountContextId?: string | null;
  workspaceKey?: string | null;
  managedByPlatform?: boolean;
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

export type CreateBillingLedgerResourceInput = {
  cloudWorkspaceId?: string;
  cloudProvider?: CloudProvider;
  cloudAccountUid?: string | null;
  regionId: string;
  cloudResourceId: string;
  cloudResourceType: BillingLedgerResourceType;
  billingScope: BillingScope;
  ownerUserId?: string | null;
  rangeInstanceId?: string | null;
  singleInstanceBatchId?: string | null;
  platformImageAssetId?: string | null;
  sourceProvisionJobId?: string | null;
  billingStartAt: Date;
  releasedAt?: Date | null;
  tagsSnapshot?: Record<string, unknown>;
};

export type FindBillingLedgerResourceInput = {
  cloudWorkspaceId?: string;
  cloudProvider?: CloudProvider;
  regionId: string;
  cloudResourceId: string;
  cloudResourceType: BillingLedgerResourceType;
};

export type UpdateBillingLedgerResourceInput = Partial<{
  cloudAccountUid: string | null;
  billingScope: BillingScope;
  ownerUserId: string | null;
  rangeInstanceId: string | null;
  singleInstanceBatchId: string | null;
  platformImageAssetId: string | null;
  sourceProvisionJobId: string | null;
  billingStartAt: Date;
  releasedAt: Date | null;
  tagsSnapshot: Record<string, unknown>;
}>;

export type CreateBillingLineItemInput = {
  cloudProvider?: CloudProvider;
  cloudWorkspaceId?: string;
  cloudAccountUid?: string | null;
  syncBatchId: string;
  sourceFingerprint: string;
  billCycle: string;
  billingDate: string | Date;
  productCode: string;
  productDetail?: string | null;
  billItem: string;
  cloudResourceId: string;
  cloudResourceType: BillingLedgerResourceType;
  pretaxAmount: number;
  currency: string;
  billingScope: BillingScope;
  ownerUserId?: string | null;
  matchedLedgerId?: string | null;
  rawPayload?: Record<string, unknown>;
};

export type ListBillingLineItemsFilter = Partial<{
  cloudProvider: CloudProvider;
  cloudAccountUid: string | null;
  startAt: string | Date;
  endAt: string | Date;
  ownerUserId: string | null;
  billingScope: BillingScope;
  matchedLedgerId: string | null;
}>;

export type CreateBillingAnomalyInput = {
  cloudProvider?: CloudProvider;
  cloudWorkspaceId?: string;
  cloudAccountUid?: string | null;
  syncBatchId: string;
  sourceFingerprint: string;
  billCycle: string;
  billingDate: string | Date;
  cloudResourceId: string;
  cloudResourceType: BillingLedgerResourceType;
  pretaxAmount: number;
  currency: string;
  reason: string;
  rawPayload?: Record<string, unknown>;
};

export type ListBillingAnomaliesFilter = Partial<{
  cloudProvider: CloudProvider;
  cloudAccountUid: string | null;
  startAt: string | Date;
  endAt: string | Date;
}>;

export type ListImageSnapshotsFilter = Partial<{
  provider: CloudProvider;
  accountUid: string | null;
  regionId: string;
  scope: CloudImageScope;
  imageId: string;
}>;

export type UpsertImageSnapshotInput = {
  minimumSystemDiskSize?: number | null;
  cloudWorkspaceId?: string;
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
  cloudWorkspaceId?: string;
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
  cloudWorkspaceId?: string;
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
  ownerUserId: string | null;
  visibility: ResourceVisibility;
}>;

export type CollectPlatformImageAssetInput = {
  cloudWorkspaceId?: string;
  preserveExisting?: boolean;
  snapshotId: string;
  displayName: string;
  defaultHostName?: string | null;
  defaultPassword?: string | null;
  description?: string | null;
  ownerUserId?: string | null;
  visibility?: ResourceVisibility;
};

export type CreatePlatformImageTagInput = {
  cloudWorkspaceId?: string;
  name: string;
  normalizedName: string;
  createdByUserId: string;
};

export type CreatePlatformUserInput = {
  cloudWorkspaceId?: string | null;
  loginUsername?: string;
  isPlatformManager?: boolean;
  selectedCloudWorkspaceId?: string | null;
  id: string;
  username: string;
  passwordHash: string;
  oidcIssuer?: string | null;
  oidcSubject?: string | null;
  role: UserRole;
  status?: UserStatus;
};

export type UpdatePlatformUserInput = Partial<{
  cloudWorkspaceId: string | null;
  loginUsername: string;
  isPlatformManager: boolean;
  selectedCloudWorkspaceId: string | null;
  username: string;
  passwordHash: string;
  oidcIssuer: string | null;
  oidcSubject: string | null;
  role: UserRole;
  status: UserStatus;
}>;

export type CreateOperationConfirmationInput = Omit<OperationConfirmationRecord, 'id' | 'consumedAt' | 'createdAt'>;
export type CreateIdempotentOperationInput = Omit<IdempotentOperationRecord, 'id' | 'status' | 'result' | 'errorCode' | 'createdAt' | 'updatedAt'>;
export type UpdateIdempotentOperationInput = Partial<Pick<IdempotentOperationRecord, 'status' | 'result' | 'errorCode'>>;

export type CreateRangeTemplateInput = {
  cloudWorkspaceId?: string;
  name: string;
  createdBy?: string;
  ownerUserId?: string | null;
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
  visibility?: ResourceVisibility;
};

export type SaveRangeTemplateTopologyInput = {
  cloudWorkspaceId?: string;
  expectedRevision: number;
  topologySpec: RangeTemplateTopologySpec;
  topologyGraph: Record<string, unknown>;
  scenarioTemplateSpec: Record<string, unknown>;
  compiledProvisionSpec: Record<string, unknown>;
  compiledSpec: Record<string, unknown>;
};

export type UpdateRangeTemplateMetadataInput = {
  cloudWorkspaceId?: string;
  expectedRevision: number;
  name?: string;
  description?: string | null;
};

export class TemplateRevisionConflictError extends Error {
  constructor() {
    super('TEMPLATE_REVISION_CONFLICT');
    this.name = 'TemplateRevisionConflictError';
  }
}

export type CreateSingleInstanceBatchInput = {
  cloudWorkspaceId?: string;
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
  ownerUserId?: string | null;
  expiresAt?: Date | null;
};

export type CreateRangeInstanceInput = {
  cloudWorkspaceId?: string;
  cloudProvider?: CloudProvider;
  name: string;
  createdBy?: string;
  ownerUserId?: string | null;
  templateId?: string | null;
  sourceTemplateVersionId?: string | null;
  templateNameSnapshot?: string | null;
  templateSlugSnapshot?: string | null;
  templateVersionSnapshot?: string | null;
  templateModulePathSnapshot?: string | null;
  runtimeTopologyGraph?: Record<string, unknown> | null;
  runtimeScenarioTemplateSpec?: Record<string, unknown> | null;
  runtimeCompiledProvisionSpec?: Record<string, unknown> | null;
  runtimeCredentials?: RangeRuntimeCredentials | null;
  draftTopologyGraph?: Record<string, unknown> | null;
  draftTopologySpec?: Record<string, unknown> | null;
  draftScenarioTemplateSpec?: Record<string, unknown> | null;
  draftCompiledProvisionSpec?: Record<string, unknown> | null;
  draftRevision?: number;
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
  ownerUserId: string | null;
  instanceMode: RangeInstanceMode;
  singleInstanceBatchId: string | null;
  singleInstanceConfig: SingleInstanceConfig | null;
  sourceTemplateVersionId: string | null;
  runtimeTopologyGraph: Record<string, unknown> | null;
  runtimeScenarioTemplateSpec: Record<string, unknown> | null;
  runtimeCompiledProvisionSpec: Record<string, unknown> | null;
  runtimeCredentials: RangeRuntimeCredentials | null;
  draftTopologyGraph: Record<string, unknown> | null;
  draftTopologySpec: Record<string, unknown> | null;
  draftScenarioTemplateSpec: Record<string, unknown> | null;
  draftCompiledProvisionSpec: Record<string, unknown> | null;
  draftRevision: number;
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

export type SaveRangeInstanceDraftInput = Pick<
  UpdateRangeInstanceInput,
  | 'draftTopologyGraph'
  | 'draftTopologySpec'
  | 'draftScenarioTemplateSpec'
  | 'draftCompiledProvisionSpec'
  | 'draftUpdatedBy'
  | 'draftUpdatedAt'
> & {
  draftTopologyGraph: Record<string, unknown>;
  draftTopologySpec: Record<string, unknown>;
  draftScenarioTemplateSpec: Record<string, unknown>;
  draftCompiledProvisionSpec: Record<string, unknown>;
};

export type CreateProvisionJobInput = {
  cloudWorkspaceId?: string;
  rangeInstanceId: string;
  jobType: ProvisionJobType;
  triggeredBy: string;
  topologySnapshot?: ProvisionJobTopologySnapshot | null;
  status?: ProvisionJobStatus;
  retryCount?: number;
  availableAt?: Date;
};

export type ApplyRangeInstanceDraftInput = {
  cloudWorkspaceId?: string;
  rangeInstanceId: string;
  expectedDraftRevision: number;
  triggeredBy: string;
  previewToken: string;
  expectedSourceDigest: string;
  topologySnapshot: ProvisionJobTopologySnapshot;
};

export type QueueRangeInstanceJobInput = CreateProvisionJobInput & {
  expectedStatus: RangeInstanceStatus;
  expectedOwnerUserId: string | null;
  nextStatus: 'pending_create' | 'pending_destroy';
  allocatedCidr?: string | null;
};

export type SyncRangeInstanceDraftToTemplateInput = {
  cloudWorkspaceId?: string;
  rangeInstanceId: string;
  expectedDraftRevision: number;
  expectedTemplateRevision: number;
  topology: SaveRangeTemplateTopologyInput;
};

export type CompleteRangeInstanceDraftApplyInput = Pick<
  UpdateRangeInstanceInput,
  | 'runtimeTopologyGraph'
  | 'runtimeScenarioTemplateSpec'
  | 'runtimeCompiledProvisionSpec'
  | 'accessEntry'
  | 'resourceSummary'
  | 'errorSummary'
  | 'runtimeCredentials'
> & {
  runtimeTopologyGraph: Record<string, unknown>;
  runtimeScenarioTemplateSpec: Record<string, unknown>;
  runtimeCompiledProvisionSpec: Record<string, unknown>;
  expectedDraftRevision: number;
  provisionJobId?: string;
  claimStartedAt?: Date;
};

export type CreateRangeTemplateFromInstanceInput = {
  rangeInstanceId: string;
  expectedDraftRevision: number;
  actorUserId: string;
  isAdmin: boolean;
  idempotencyKey: string;
  argumentsHash: string;
  operationId: string;
  template: CreateRangeTemplateInput;
};

export type SaveRangeInstanceAsTemplateResult = {
  id: string;
  templateId: string;
  name: string;
  visibility: 'private';
  rangeInstanceId: string;
  sourceDraftRevision: number;
};

export class RangeInstanceDraftRevisionConflictError extends Error {
  constructor() {
    super('RANGE_INSTANCE_DRAFT_REVISION_CONFLICT');
    this.name = 'RangeInstanceDraftRevisionConflictError';
  }
}

export type UpdateProvisionJobInput = Partial<{
  status: ProvisionJobStatus;
  startedAt: Date | null;
  finishedAt: Date | null;
  retryCount: number;
  errorSummary: string | null;
}>;

export type CreateProvisionJobStepLogInput = {
  cloudWorkspaceId?: string;
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

export type ProvisionJobSchedulingRecord = Pick<ProvisionJobRecord, 'cloudWorkspaceId' | 'id' | 'rangeInstanceId' | 'jobType' | 'status' | 'createdAt'>;
export type RangeInstanceSchedulingRecord = Pick<RangeInstanceRecord, 'cloudWorkspaceId' | 'id' | 'instanceMode' | 'singleInstanceBatchId' | 'status' | 'lastJobId' | 'ownerUserId' | 'expiresAt'>;
export type ListPendingProvisionJobsInput = {
  cloudWorkspaceId?: string;
  limit?: number;
  now?: Date;
  after?: { createdAt: Date; id: string };
};
export type SingleInstanceBatchProvisionLease = {
  signal: AbortSignal;
  assertHeld(): Promise<void>;
};

export interface AdminRepository {
  createPlatformUser(input: CreatePlatformUserInput): Promise<PlatformUserRecord>;
  listPlatformUsers(): Promise<PlatformUserRecord[]>;
  getPlatformUserById(id: string): Promise<PlatformUserRecord | null>;
  getPlatformUserByUsername(username: string): Promise<PlatformUserRecord | null>;
  getPlatformUserByOidcIdentity(issuer: string, subject: string): Promise<PlatformUserRecord | null>;
  updatePlatformUser(id: string, input: UpdatePlatformUserInput): Promise<PlatformUserRecord>;
  countActiveAdmins(): Promise<number>;
  createOperationConfirmation(input: CreateOperationConfirmationInput): Promise<OperationConfirmationRecord>;
  getOperationConfirmationById(id: string): Promise<OperationConfirmationRecord | null>;
  consumeOperationConfirmation(id: string, consumedAt: Date): Promise<OperationConfirmationRecord | null>;
  createIdempotentOperation(input: CreateIdempotentOperationInput): Promise<IdempotentOperationRecord>;
  getIdempotentOperation(actorUserId: string, toolName: string, idempotencyKey: string): Promise<IdempotentOperationRecord | null>;
  getIdempotentOperationByOperationId(operationId: string): Promise<IdempotentOperationRecord | null>;
  updateIdempotentOperation(id: string, input: UpdateIdempotentOperationInput): Promise<IdempotentOperationRecord>;
  appendOperationAuditEvent(input: OperationAuditEventInput): Promise<OperationAuditEventRecord>;
  getDispatchedOperationByJobId(jobId: string): Promise<OperationAuditEventRecord | null>;
  listRangeTemplates(): Promise<RangeTemplateRecord[]>;
  createRangeTemplate(input: CreateRangeTemplateInput): Promise<RangeTemplateRecord>;
  createRangeTemplateFromInstance(input: CreateRangeTemplateFromInstanceInput): Promise<SaveRangeInstanceAsTemplateResult | null>;
  getRangeTemplateById(id: string): Promise<RangeTemplateRecord | null>;
  getRangeTemplateVersionById(id: string): Promise<RangeTemplateVersionRecord | null>;
  updateRangeTemplateMetadata(id: string, input: UpdateRangeTemplateMetadataInput): Promise<RangeTemplateRecord>;
  saveRangeTemplateTopology(id: string, input: SaveRangeTemplateTopologyInput): Promise<RangeTemplateRecord>;
  publishRangeTemplateToPlatform(id: string, expectedRevision: number): Promise<RangeTemplateRecord>;
  unshareRangeTemplate(id: string, expectedRevision: number): Promise<RangeTemplateRecord>;
  deleteRangeTemplate(id: string): Promise<void>;
  createSingleInstanceBatch(input: CreateSingleInstanceBatchInput): Promise<SingleInstanceBatchRecord>;
  getSingleInstanceBatchById(id: string): Promise<SingleInstanceBatchRecord | null>;
  getSingleInstanceBatchWithInstancesById(id: string): Promise<SingleInstanceBatchWithInstancesRecord | null>;
  listSingleInstanceBatchesWithInstances(): Promise<SingleInstanceBatchWithInstancesRecord[]>;
  listRangeInstances(): Promise<RangeInstanceRecord[]>;
  listProvisioningInstancesByIds(ids: string[]): Promise<RangeInstanceSchedulingRecord[]>;
  listExpiredRangeInstances(now: Date): Promise<RangeInstanceSchedulingRecord[]>;
  archiveDestroyedRangeInstancesForDeletedTemplate(template: RangeTemplateRecord): Promise<void>;
  createRangeInstance(input: CreateRangeInstanceInput, initialJob?: {
    triggeredBy: string; topologySnapshot: ProvisionJobTopologySnapshot; expectedTemplateRevision?: number;
  }): Promise<RangeInstanceRecord>;
  getRangeInstanceById(id: string): Promise<RangeInstanceRecord | null>;
  updateRangeInstance(id: string, input: UpdateRangeInstanceInput): Promise<RangeInstanceRecord>;
  updateRangeInstanceDnsState(id: string, hostKey: string, nativeId: string, expectedClaim: string | null, entry: RangeDnsVerification): Promise<boolean>;
  saveRangeInstanceDraft(
    id: string,
    expectedDraftRevision: number,
    input: SaveRangeInstanceDraftInput,
  ): Promise<RangeInstanceRecord | null>;
  discardRangeInstanceDraft(id: string, expectedDraftRevision: number): Promise<RangeInstanceRecord | null>;
  applyRangeInstanceDraft(input: ApplyRangeInstanceDraftInput): Promise<ProvisionJobRecord | null>;
  syncRangeInstanceDraftToTemplate(input: SyncRangeInstanceDraftToTemplateInput): Promise<RangeTemplateRecord | null>;
  completeRangeInstanceDraftApply(
    id: string,
    input: CompleteRangeInstanceDraftApplyInput,
  ): Promise<RangeInstanceRecord>;
  listProvisionJobs(): Promise<ProvisionJobRecord[]>;
  listPendingProvisionJobs(input?: ListPendingProvisionJobsInput): Promise<ProvisionJobSchedulingRecord[]>;
  createProvisionJob(input: CreateProvisionJobInput): Promise<ProvisionJobRecord>;
  queueRangeInstanceJob(input: QueueRangeInstanceJobInput): Promise<ProvisionJobRecord | null>;
  queueExpiredSingleInstanceDestroy(input: { rangeInstanceId: string; now: Date }): Promise<ProvisionJobRecord | null>;
  claimRangeProvisionJob(id: string, startedAt: Date): Promise<ProvisionJobRecord | null>;
  heartbeatRangeProvisionJob(id: string, startedAt: Date, heartbeatAt: Date): Promise<boolean>;
  updateRangeInstanceForProvisionJob(id: string, startedAt: Date, input: UpdateRangeInstanceInput): Promise<RangeInstanceRecord | null>;
  updateRangeProvisionJob(id: string, startedAt: Date, input: UpdateProvisionJobInput): Promise<boolean>;
  getProvisionJobById(id: string): Promise<ProvisionJobRecord | null>;
  claimProvisionJob(id: string, startedAt: Date): Promise<ProvisionJobRecord | null>;
  heartbeatProvisionJob(id: string, startedAt: Date, heartbeatAt: Date): Promise<boolean>;
  requeueInterruptedProvisionJobs(staleBefore: Date): Promise<number>;
  updateProvisionJob(id: string, input: UpdateProvisionJobInput): Promise<ProvisionJobRecord>;
  listProvisionJobStepLogs(jobId: string): Promise<ProvisionJobStepLogRecord[]>;
  createProvisionJobStepLog(input: CreateProvisionJobStepLogInput): Promise<ProvisionJobStepLogRecord>;
  updateProvisionJobStepLog(id: string, input: UpdateProvisionJobStepLogInput): Promise<ProvisionJobStepLogRecord>;
  upsertCloudResourceDrift(input: UpsertCloudResourceDriftInput): Promise<CloudResourceDriftRecord>;
  resolveCloudResourceDrift(input: {
    cloudProvider?: CloudProvider;
    regionId: string;
    cloudResourceType: string;
    cloudResourceId: string;
    resolvedAt: Date;
  }): Promise<void>;
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
  listPlatformImageTags(): Promise<PlatformImageTagRecord[]>;
  listPlatformImageTagsByIds(ids: string[]): Promise<PlatformImageTagRecord[]>;
  createPlatformImageTag(input: CreatePlatformImageTagInput): Promise<PlatformImageTagRecord>;
  deletePlatformImageTag(id: string): Promise<boolean>;
  replacePlatformImageAssetTags(id: string, tagIds: string[]): Promise<PlatformImageAssetRecord>;
  hasActiveImageImportForArtifact(input: {
    platformImageAssetId?: string | null;
    sourceSnapshotId?: string | null;
    imageId?: string | null;
  }): Promise<boolean>;
  deletePlatformImageAsset(id: string): Promise<void>;
  deletePlatformImageAssetsBySnapshotId(snapshotId: string): Promise<void>;
  withSingleInstanceControlLock<T>(work: () => Promise<T>): Promise<T>;
  tryWithSingleInstanceBatchProvisionLock<T>(batchId: string, work: (lease: SingleInstanceBatchProvisionLease) => Promise<T>): Promise<{ acquired: boolean; result?: T }>;
  commitSingleInstanceClaim(job: ProvisionJobRecord, instancePatch: UpdateRangeInstanceInput, jobPatch?: UpdateProvisionJobInput): Promise<boolean>;
  listSingleInstanceNetworkProfiles(): Promise<SingleInstanceNetworkProfileRecord[]>;
  getSingleInstanceNetworkProfileById(id: string): Promise<SingleInstanceNetworkProfileRecord | null>;
  deleteSingleInstanceNetworkProfile(id: string): Promise<void>;
  markSingleInstanceNetworkDestroying(id: string): Promise<void>;
  registerSingleInstanceNetworkCleanup(id:string,runId:string,adminId:string,ownerIds:string[]):Promise<void>;
  createPackedImageArtifact(input: CreatePackedImageArtifactInput): Promise<PackedImageArtifactRecord>;
  getPackedImageArtifact(id: string): Promise<PackedImageArtifactRecord | null>;
  listPackedImageArtifacts(filter?: Partial<Pick<PackedImageArtifactRecord, 'imageId' | 'sourceSnapshotId' | 'platformImageAssetId' | 'cloudAccountUid' | 'regionId'>>): Promise<PackedImageArtifactRecord[]>;
  updatePackedImageArtifact(id: string, input: UpdatePackedImageArtifactInput): Promise<PackedImageArtifactRecord>;
  claimPackedImageArtifact(id: string, token: string, expiresAt: Date): Promise<boolean>;
  renewPackedImageArtifactClaim(id: string, token: string, expiresAt: Date): Promise<boolean>;
  releasePackedImageArtifactClaim(id: string, token: string): Promise<void>;
  withPackedImageArtifactClaim<T>(id: string, token: string, work: (repository: AdminRepository) => Promise<T>): Promise<T>;
  getSingleInstanceNetworkProfile(input: {
    cloudAccountUid?: string;
    provider: CloudProvider;
    regionId: string;
    zoneId: string;
  }): Promise<SingleInstanceNetworkProfileRecord | null>;
  upsertSingleInstanceNetworkProfile(
    input: UpsertSingleInstanceNetworkProfileInput,
  ): Promise<SingleInstanceNetworkProfileRecord>;
  listBillingImageImportResources(): Promise<BillingImageImportResourceRecord[]>;
  listBillingManagedCosBuckets(): Promise<BillingManagedCosBucketRecord[]>;
  createBillingLedgerResource(input: CreateBillingLedgerResourceInput): Promise<BillingLedgerResourceRecord>;
  findBillingLedgerResource(input: FindBillingLedgerResourceInput): Promise<BillingLedgerResourceRecord | null>;
  updateBillingLedgerResource(id: string, input: UpdateBillingLedgerResourceInput): Promise<BillingLedgerResourceRecord>;
  listBillingLedgerResources(filter?: { rangeInstanceId?: string }): Promise<BillingLedgerResourceRecord[]>;
  getLatestBillingLineItemDate(cloudAccountUid?: string): Promise<Date | null>;
  replaceBillingDay(input: {
    cloudProvider?: CloudProvider;
    cloudAccountUid: string;
    billingDate: string;
    lineItems: CreateBillingLineItemInput[];
    anomalies: CreateBillingAnomalyInput[];
  }): Promise<void>;
  deleteBillingLineItemsBySyncBatchId(syncBatchId: string): Promise<void>;
  upsertBillingLineItems(input: CreateBillingLineItemInput[]): Promise<BillingLineItemRecord[]>;
  listBillingLineItems(filter?: ListBillingLineItemsFilter): Promise<BillingLineItemRecord[]>;
  deleteBillingAnomaliesBySyncBatchId(syncBatchId: string): Promise<void>;
  createBillingAnomaly(input: CreateBillingAnomalyInput): Promise<BillingAnomalyRecord>;
  listBillingAnomalies(filter?: ListBillingAnomaliesFilter): Promise<BillingAnomalyRecord[]>;
}
