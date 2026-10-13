import type { CompiledProvisionSpec } from './compiled-provision-spec';
import type { ScenarioTemplateSpec } from './scenario-template-spec';
import type { HostDnsConfig } from '@aliyun-cyber-range/scenario-runtime';
import type { RangeNodeDnsVerification } from '../components/admin/range-instance-node-directory';

export type AdminProfile = {
  id: string;
  username: string;
  role: 'admin' | 'user';
  isPlatformManager?: boolean;
  cloudWorkspaceId?: string | null;
};

export type AdminSessionPayload = {
  token: string;
  idToken?: string | null;
  refreshToken?: string | null;
  sessionGeneration?: number;
  profile: AdminProfile;
};

export type AdminUserRole = AdminProfile['role'];
export type ResourceVisibility = 'private' | 'platform';
export type RangeTemplateView = 'platform' | 'mine' | 'all';
export type PlatformImageView = 'platform' | 'mine';

export type AdminUserStatus = 'active' | 'disabled';

export type AdminUser = {
  id: string;
  username: string;
  loginUsername?: string;
  role: AdminUserRole;
  status: AdminUserStatus;
  isCurrentUser?: boolean;
  createdAt: string;
  updatedAt: string;
};

export type CreateAdminUserInput = {
  username: string;
  password: string;
  role: AdminUserRole;
};

export type UpdateAdminUserRoleInput = {
  role: AdminUserRole;
};

export type UpdateAdminUserStatusInput = {
  status: AdminUserStatus;
};

export type ResetAdminUserPasswordInput = {
  password: string;
};

export type RangeTemplate = {
  id: string;
  name?: string | null;
  createdBy?: string | null;
  ownerUserId?: string | null;
  canManage?: boolean;
  visibility?: ResourceVisibility;
  status: 'private' | 'published';
  revision: number;
  description?: string | null;
  slug: string;
  cloudProvider?: 'alibaba_cloud' | 'tencent_cloud';
  iacType?: 'opentofu' | 'terraform';
  topologySpec?: RangeTemplateTopologySpec | null;
  topologyGraph?: Record<string, unknown> | null;
  scenarioTemplateSpec?: ScenarioTemplateSpec | null;
  compiledProvisionSpec?: CompiledProvisionSpec | null;
  compiledSpec?: RangeTemplateCompiledSpec | null;
  variableSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  defaultNetworkPolicy?: Record<string, unknown> | null;
  nodeCount?: number;
  zoneCount?: number;
  hostCount?: number;
};

export type RangeTemplateCompiledResource = {
  id: string;
  type: string;
  provider: 'alibaba_cloud' | 'tencent_cloud';
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

export type RangeTemplateCreateInput = {
  name: string;
  description?: string;
  topologySpec: RangeTemplateTopologySpec;
  topologyGraph: Record<string, unknown>;
  scenarioTemplateSpec: ScenarioTemplateSpec;
  compiledProvisionSpec: CompiledProvisionSpec;
  compiledSpec: RangeTemplateCompiledSpec;
  variableSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  defaultNetworkPolicy?: Record<string, unknown>;
};

export type RangeTemplateUpdateInput = {
  expectedRevision: number;
  name?: string;
  description?: string;
};

export type RangeTemplateTopologySaveInput = {
  expectedRevision: number;
  topologySpec: RangeTemplateTopologySpec;
  topologyGraph: Record<string, unknown>;
  scenarioTemplateSpec: ScenarioTemplateSpec;
  compiledProvisionSpec: CompiledProvisionSpec;
  compiledSpec: RangeTemplateCompiledSpec;
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

export type SingleInstanceConfig = {
  cloudReleaseDeadline?: import('@aliyun-cyber-range/platform-api-client').HostCloudReleaseDeadline | null;
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

export type RangeResourceSummary = {
  cloudReleaseDeadlines?: Record<string, import('@aliyun-cyber-range/platform-api-client').HostCloudReleaseDeadline>;
  mode?: 'dry-run' | 'opentofu' | 'ecs-native' | null;
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
  cloudProvider?: 'alibaba_cloud' | 'tencent_cloud';
  id: string;
  name?: string | null;
  createdBy?: string | null;
  instanceMode?: 'range' | 'single';
  singleInstanceBatchId?: string | null;
  singleInstanceConfig?: SingleInstanceConfig | null;
  nodeStatuses?: Record<string, string> | null;
  status: string;
  templateId?: string | null;
  templateNameSnapshot?: string | null;
  templateSlugSnapshot?: string | null;
  templateVersionSnapshot?: string | null;
  templateModulePathSnapshot?: string | null;
  sourceTemplateVersionId?: string | null;
  sourceTemplateRevision?: number | null;
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
};

export type SingleInstanceLaunchInput = {
  name: string;
  hostName?: string;
  platformImageAssetId: string;
  cpu: number;
  memory: number;
  systemDiskSize?: number;
  expiresAt: string;
  password?: string;
  quantity: number;
  remark?: string;
};

export type SingleInstanceLaunchResult = {
  batch?: SingleInstanceBatch | null;
  instances: RangeInstance[];
};

export type SingleInstanceBatchSummary = {
  running: number;
  creating: number;
  createFailed: number;
  destroying: number;
  destroyFailed: number;
  destroyed: number;
};

export type SingleInstanceBatch = {
  id: string;
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
  expiresAt?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  summary?: SingleInstanceBatchSummary;
};

export type SingleInstanceBatchGroup = {
  batch: SingleInstanceBatch;
  instances: RangeInstance[];
};

export type SingleInstanceListPayload = {
  batches: SingleInstanceBatchGroup[];
  standaloneInstances: RangeInstance[];
};

export type SingleInstanceAction =
  | 'destroy'
  | 'retry'
  | 'reboot'
  | 'open-vnc'
  | 'pack-image';

export type RangeInstanceDetail = RangeInstance & {
  templateId: string;
  recoverySummary?: RangeRecoverySummary | null;
  runtimeTopologySpec?: Record<string, unknown> | null;
  dnsVerification?: Record<string, RangeNodeDnsVerification>;
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
  imageImportBucket: string;
};

export type BillingResourceTypeTotal = {
  currency?: string;
  resourceType: string;
  pretaxAmount: number;
};

export type BillingDailyTotal = {
  currency?: string;
  billingDate: string;
  pretaxAmount: number;
};

export type BillingSummary = {
  startAt: string;
  endAt: string;
  currency?: string | null;
  currencyTotals?: Array<{ currency: string; totalPretaxAmount: number; platformPretaxAmount: number }>;
  billingStatus?: 'provisional';
  billingScope?: 'platform_resources';
  platformBillingStartedAt?: string;
  reconciliationIssues?: Array<{ resourceType: 'snapshot' | 'oss' | 'unknown' | 'disk'; resourceCount: number; reason: string;
    resources?: import('../../../packages/platform-api-client/src/types').BillingReconciliationResource[] }>;
  unallocatedCurrencyTotals?: Array<{ currency: string; pretaxAmount: number }>;
  resourcesWithoutBillCount?: number;
  totalPretaxAmount: number | null;
  platformPretaxAmount: number | null;
  anomalyCount: number;
  resourceTypeTotals: BillingResourceTypeTotal[];
  dailyTotals: BillingDailyTotal[];
};

export type BillingUserSummary = {
  currency?: string | null;
  amounts?: Array<{ currency: string; pretaxAmount: number }>;
  userId: string;
  username: string;
  pretaxAmount: number | null;
  itemCount: number;
  launchCount: number;
};

export type PaginatedResult<T> = {
  items: T[];
  page: number;
  pageSize: 20 | 50 | 100;
  total: number;
};

export type BillingLineItem = {
  id: string;
  syncBatchId: string;
  sourceFingerprint: string;
  billCycle: string;
  billingDate: string;
  productCode: string;
  productDetail?: string | null;
  billItem: string;
  cloudResourceId: string;
  cloudResourceType: string;
  pretaxAmount: number;
  currency: string;
  billingScope: 'user' | 'platform';
  ownerUserId?: string | null;
  matchedLedgerId?: string | null;
};

export type BillingLaunchGroup = {
  id: string;
  kind: 'range_launch' | 'single_launch' | 'unmatched';
  title: '开启靶场实例' | '开启单实例' | '开启编排实例' | '未关联平台启动的费用';
  provisionJobStatus: 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled' | null;
  completedAt: string | null;
  billingPeriodStart: string;
  billingPeriodEnd: string;
  ownerUserId: string | null;
  ownerUsername: string | null;
  instance: { id: string; name: string; batchId: string | null } | null;
  resourceCount: number;
  pretaxAmount: number;
  currency: string;
  items: BillingLineItem[];
};

export type BillingAnomaly = {
  id: string;
  syncBatchId: string;
  sourceFingerprint: string;
  billCycle: string;
  billingDate: string;
  cloudResourceId: string;
  cloudResourceType: string;
  pretaxAmount: number;
  currency: string;
  reason: string;
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
  provider: 'alibaba_cloud' | 'tencent_cloud';
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
  ownedSnapshotCleanup?: { snapshotCount: number; status: 'ready' | 'deleting' };
  lastSyncedAt?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  minimumSystemDiskSize?: number | null;
};

export type ImageCatalogItem = {
  id: string;
  displayName: string;
  imageId: string;
  provider: 'alibaba_cloud' | 'tencent_cloud';
  scope: 'public' | 'custom' | string;
  accountUid?: string | null;
  regionId: string;
  enabled: boolean;
  sourceSnapshotId?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
};

export type PlatformImageTag = {
  id: string;
  name: string;
};

export type PlatformImageAsset = {
  id: string;
  provider: 'alibaba_cloud' | 'tencent_cloud';
  accountUid?: string | null;
  ownerUserId?: string | null;
  createdBy?: string | null;
  canManage?: boolean;
  canChangeVisibility?: boolean;
  visibility?: ResourceVisibility;
  accountScopeKey: string;
  regionId: string;
  sourceScope: 'public' | 'custom' | string;
  sourceSnapshotId?: string | null;
  imageId: string;
  displayName: string;
  sourceSnapshotStatus?: string | null;
  sourceSnapshotAvailable?: boolean | null;
  defaultHostName?: string | null;
  description?: string | null;
  enabled: boolean;
  tags: PlatformImageTag[];
  createdAt?: string | null;
  updatedAt?: string | null;
  minimumSystemDiskSize?: number | null;
  architecture?: string | null;
  osType?: string | null;
  platform?: string | null;
};

export type ImageCatalogScopePayload = {
  snapshots: ImageSnapshot[];
  catalogItems: ImageCatalogItem[];
};

export type PlatformImageAssetListPayload = {
  items: PlatformImageAsset[];
};

export type PlatformImageTagListPayload = {
  items: PlatformImageTag[];
};

export type CloudAccountContext = {
  id: string;
  cloudWorkspaceId?: string;
  displayName: string;
  provider: 'alibaba_cloud' | 'tencent_cloud';
  accountUid: string;
  regionId: string;
  zoneId: string;
  imageImportBucket: string;
  isActive: boolean;
  status: 'provisioning' | 'ready' | 'degraded' | 'disabled';
  bucketStatus: string;
  lastError?: string | null;
  lastVerifiedAt?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
};

export type CloudWorkspaceView = {
  id: string;
  provider: 'alibaba_cloud' | 'tencent_cloud';
  accountUid: string | null;
  displayName: string;
  isReadOnly: boolean;
  activeCloudAccountContextId: string | null;
  contexts: CloudAccountContext[];
  capabilities: { provisioning: boolean; rangeProvisioning?: boolean; imageImport: boolean; billingSync: boolean };
};

export type SaveCloudAccountInput = {
  cloudWorkspaceId?: string;
  provider: CloudWorkspaceView['provider'];
  regionId: string;
  zoneId: string;
  accessKeyId: string;
  accessKeySecret: string;
  imageImportBucket?: string;
  displayName?: string;
};

export type DeleteCloudAccountResult = {
  id: string;
  provider: CloudWorkspaceView['provider'];
  accountUid: string;
  displayName: string;
  deletedAt: string;
  retainedData: true;
};

export type RangeInstanceChangePreview = {
  id: string;
  rangeInstanceId: string;
  kind: 'expected-topology-diff';
  expectedDraftRevision: number;
  previewToken: string;
  expiresAt: string;
  sourceDigest: string;
  addedNetworks?: Array<{ nodeId: string; name: string; zoneKey: string; cidr: string }>;
  addedHosts: Array<{ id: string; nodeId: string; name: string; expiresAt: string | null }>;
  deletedHosts: Array<{ id: string; nodeId: string; name: string; instanceId: string | null; systemDiskId: string | null; dataDiskIds: string[]; networkInterfaceIds: string[]; diskIds: string[] }>;
  ruleChanges: Array<{ nodeId: string; name: string; nodeKind: string }>;
  resourceChanges: Array<{ resourceType: string; key: string; action: 'create' | 'delete'; resourceId?: string }>;
  allowDnatRemoval: boolean;
  allowSnatRemoval: boolean;
};

export type RangeInstanceTemplateCopy = {
  id: string; templateId: string; name: string; visibility: 'private'; rangeInstanceId: string; sourceDraftRevision: number;
};

export type ImageImportJob = {
  id: string;
  cloudAccountContextId: string;
  ownerUserId: string;
  displayName: string;
  defaultHostName?: string | null;
  description?: string | null;
  osType: 'linux' | 'windows' | string;
  platform?: string | null;
  osVersion?: string | null;
  architecture: 'x86_64' | 'arm64' | string;
  bootMode: 'BIOS' | 'UEFI' | string;
  imageFormat: 'qcow2' | 'raw' | 'vhd' | string;
  systemDiskSize: number;
  sourceFileName: string;
  sourceContentType: string;
  sourceSizeBytes: number;
  uploadExpiresAt: string;
  uploadCompletedAt?: string | null;
  status: 'awaiting_upload' | 'importing' | 'available' | 'failed' | 'cancelled';
  imageId?: string | null;
  taskId?: string | null;
  sourceSnapshotId?: string | null;
  platformImageAssetId?: string | null;
  temporaryObjectDeletedAt?: string | null;
  errorMessage?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
};

export type CreateImageImportInput = {
  cloudContextId: string;
  displayName: string;
  defaultHostName?: string;
  defaultPassword?: string;
  description?: string;
  osType: 'linux' | 'windows';
  platform?: string;
  osVersion?: string;
  architecture: 'x86_64' | 'arm64';
  bootMode: 'BIOS' | 'UEFI';
  imageFormat: 'qcow2' | 'raw' | 'vhd';
  systemDiskSize: number;
  sourceFileName: string;
  sourceContentType?: string;
  sourceSizeBytes: number;
};

export type ImageImportUploadSession = {
  job: ImageImportJob;
  upload: {
    method: 'PUT';
    url: string;
    headers: Record<string, string>;
    expiresAt: string;
  };
};

export type RangeInstanceNodeActionResult = {
  status: string;
  action: 'start' | 'stop' | 'reboot' | 'open-vnc' | 'pack-image' | 'verify-dns';
  dnsVerification?: RangeNodeDnsVerification;
  vncUrl?: string | null;
  webTerminalUrl?: string | null;
  imageId?: string | null;
  imageReady?: boolean;
  defaultHostName?: string | null;
  defaultPassword?: string | null;
  description?: string | null;
  platformImageAsset?: PlatformImageAsset | null;
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
export type { SaveTencentCloudAccountInput, TencentCloudImagesInput, TencentCloudImagesPayload, TencentCloudRegionsInput, TencentCloudRegionsPayload } from '../../../packages/platform-api-client/src/types';
