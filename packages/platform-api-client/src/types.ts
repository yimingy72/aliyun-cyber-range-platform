export type RangeTemplateView = 'platform' | 'mine';
export type PlatformImageView = 'platform' | 'mine';
export type InstanceView = 'active' | 'history';
export type InstanceMode = 'single' | 'range';
export type ImageCatalogScope = 'public' | 'custom';

export type OperationRequest = {
  idempotencyKey?: string;
  confirmationId?: string;
};

export type PlatformApiClientOptions = {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
};

export type RangeAccessPayload = {
  ip?: string | null;
  publicIp?: string | null;
  privateIp?: string | null;
  ssh?: string | null;
  accessEntry?: Record<string, unknown> | null;
  runtimeCredentials?: Record<string, unknown> | null;
};

export type RangeTemplate = Record<string, unknown> & { id: string };
export type CreateRangeTemplateInput = {
  name: string;
  description?: string;
  topologySpec: Record<string, unknown>;
  topologyGraph: Record<string, unknown>;
  scenarioTemplateSpec: Record<string, unknown>;
  compiledProvisionSpec: Record<string, unknown>;
  compiledSpec: Record<string, unknown>;
  variableSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  defaultNetworkPolicy?: Record<string, unknown>;
};
export type UpdateRangeTemplateInput = {
  expectedRevision: number;
  name?: string;
  description?: string;
};
export type SaveRangeTemplateTopologyInput = {
  expectedRevision: number;
  topologySpec: Record<string, unknown>;
  topologyGraph: Record<string, unknown>;
  scenarioTemplateSpec: Record<string, unknown>;
  compiledProvisionSpec: Record<string, unknown>;
  compiledSpec: Record<string, unknown>;
};
export type ApplyRangeInstanceDraftInput = {
  expectedDraftRevision: number;
};
export type SyncRangeInstanceTemplateInput = {
  expectedDraftRevision: number;
  expectedTemplateRevision: number;
};
export type PlatformImageAsset = Record<string, unknown> & { id: string };
export type PlatformImageTag = { id: string; name: string };
export type ImageCatalogScopePayload = {
  snapshots: Array<Record<string, unknown> & { id: string }>;
  catalogItems: Array<Record<string, unknown> & { id: string }>;
};
export type ImageImportJob = Record<string, unknown> & {
  id: string;
  status: 'awaiting_upload' | 'importing' | 'available' | 'failed' | 'cancelled';
};
export type ImageImportJobListPayload = {
  items: ImageImportJob[];
};

export type BillingWindowInput = {
  startAt?: string;
  endAt?: string;
  page?: number;
  pageSize?: 20 | 50 | 100;
};

export type BillingGroupInput = BillingWindowInput & {
  userId?: string;
};

export type PaginatedResult<T> = {
  items: T[];
  page: number;
  pageSize: 20 | 50 | 100;
  total: number;
};

export type BillingSummary = Record<string, unknown> & {
  startAt: string;
  endAt: string;
  currency?: string | null;
  currencyTotals?: Array<{ currency: string; totalPretaxAmount: number; platformPretaxAmount: number }>;
  billingStatus?: 'provisional';
  billingScope?: 'platform_resources';
  reconciliationIssues?: Array<{ resourceType: 'snapshot' | 'oss' | 'unknown'; resourceCount: number; reason: string }>;
  unallocatedCurrencyTotals?: Array<{ currency: string; pretaxAmount: number }>;
  resourcesWithoutBillCount?: number;
  totalPretaxAmount: number | null;
  platformPretaxAmount: number | null;
  anomalyCount: number;
};

export type BillingUserSummary = Record<string, unknown> & {
  currency?: string | null;
  amounts?: Array<{ currency: string; pretaxAmount: number }>;
  userId: string;
  username: string;
  pretaxAmount: number | null;
  itemCount: number;
  launchCount: number;
};

export type BillingLaunchGroup = Record<string, unknown> & { id: string };
export type BillingLineItem = Record<string, unknown> & { id: string };
export type BillingAnomaly = Record<string, unknown> & { id: string };
export type BillingSyncResult = {
  syncInProgress?: boolean;
  deferredDates?: string[];
  syncedDays: number;
  importedLineItems: number;
  anomalyCount: number;
  deferredCount: number;
};
export type GetRangeInstanceOptions = {
  /** Read only network facts for this instance's bound cloud context; no caller supplied cloud IDs. */
  includeNetworkDiagnostics?: boolean;
};
type NetworkDiagnosticRows = ReadonlyArray<Readonly<Record<string, unknown>>>;
/** Server allowlisted facts for this instance only; excludes credentials and raw provider responses. */
export type RangeInstanceNetworkDiagnostics = Readonly<{
  status: 'succeeded';
  checkedAt: string;
  regionId: string;
  cloudAccountUid: string;
  vpcId: string;
  instances: NetworkDiagnosticRows;
  networkInterfaces: NetworkDiagnosticRows;
  natGateways: NetworkDiagnosticRows;
  forwardEntries: NetworkDiagnosticRows;
  snatEntries: NetworkDiagnosticRows;
  routeTables: NetworkDiagnosticRows;
  networkAcls: NetworkDiagnosticRows;
  securityGroups: NetworkDiagnosticRows;
}>;
export type RangeInstance = Record<string, unknown> & {
  id: string;
  instanceMode?: 'range' | 'single';
  networkDiagnostics?: RangeInstanceNetworkDiagnostics;
};
export type ProvisionJob = Record<string, unknown> & { id: string };
export type CloudConfigSnapshot = Record<string, unknown>;
export type CloudAccountContext = {
  id: string;
  provider: 'alibaba_cloud' | 'tencent_cloud';
  displayName: string;
  accountUid: string;
  regionId: string;
  zoneId: string;
  isActive: boolean;
  status: 'provisioning' | 'ready' | 'degraded' | 'disabled';
  imageImportBucket: string;
  bucketStatus: string;
  lastVerifiedAt?: string | null;
};
export type SaveTencentCloudAccountInput = {
  provider: 'tencent_cloud';
  regionId: string;
  zoneId: string;
  accessKeyId: string;
  accessKeySecret: string;
};
export type TencentCloudRegionsInput = {
  regionIds: string[];
  accessKeyId: string;
  accessKeySecret: string;
};
export type TencentCloudRegionsPayload = {
  provider: 'tencent_cloud';
  regions: Array<{ regionId: string; displayName: string; zones: Array<{ zoneId: string; displayName: string }> }>;
};
export type TencentCloudImagesInput = {
  cloudAccountContextId: string;
  scope: 'public' | 'custom';
  offset?: number;
  limit?: number;
};
export type TencentCloudImagesPayload = {
  provider: 'tencent_cloud';
  cloudAccountContextId: string;
  accountUid: string;
  regionId: string;
  zoneId: string;
  scope: 'public' | 'custom';
  offset: number;
  limit: number;
  totalCount: number;
  items: Array<{ imageId: string; displayName: string; status: string; platform: string | null; architecture: string | null; isAvailable: boolean }>;
};
export type AdminUser = Record<string, unknown> & { id: string; username: string };
export type SingleInstanceListPayload = {
  batches: Array<{
    batch: Record<string, unknown> & { id: string };
    instances: RangeInstance[];
  }>;
  standaloneInstances: RangeInstance[];
};
export type SingleInstanceCloudResourceStatus = {
  matchedInstances?:Array<{instanceId:string;ownerUserId:string|null;tags:Record<string,string>}>;
  singleInstanceId: string;
  regionId: string;
  exists: boolean;
  instanceIds: string[];
  checkedAt: string;
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

export type LaunchRangeInput = {
  templateId: string;
  name: string;
  expiresAt: string;
};

export type SaveRangeInstanceDraftInput = {
  draftTopologyGraph: Record<string, unknown>;
  draftTopologySpec: Record<string, unknown>;
  draftScenarioTemplateSpec: Record<string, unknown>;
  draftCompiledProvisionSpec: Record<string, unknown>;
  expectedDraftRevision: number;
};

export type RangeInstanceNodeActionPayload = {
  displayName?: string;
  defaultHostName?: string;
  defaultPassword?: string;
  description?: string;
};

export type LaunchSingleInstancesInput = {
  name: string;
  hostName?: string;
  platformImageAssetId: string;
  cpu: number;
  memory: number;
  systemDiskSize?: number;
  expiresAt?: string;
  password?: string;
  quantity: number;
  remark?: string;
};

export type SingleInstanceActionPayload = {
  displayName?: string;
  defaultHostName?: string;
  defaultPassword?: string;
  description?: string;
};

export type CollectPlatformImageInput = {
  snapshotId: string;
  displayName: string;
};

export type CreateAdminUserInput = {
  username: string;
  password: string;
  role: 'admin' | 'user';
};

export type UpdateAdminUserRoleInput = {
  role: 'admin' | 'user';
};

export type UpdateAdminUserStatusInput = {
  status: 'active' | 'disabled';
};

export type ResetAdminUserPasswordInput = {
  password: string;
};

export type PlatformApiClientLike = {
  listRangeTemplates(view?: RangeTemplateView): Promise<RangeTemplate[]>;
  getRangeTemplate(id: string): Promise<RangeTemplate | null>;
  createRangeTemplate(payload: CreateRangeTemplateInput, operation?: OperationRequest): Promise<RangeTemplate>;
  updateRangeTemplate(id: string, payload: UpdateRangeTemplateInput, operation?: OperationRequest): Promise<RangeTemplate>;
  cloneRangeTemplate(id: string, operation?: OperationRequest): Promise<RangeTemplate>;
  saveRangeTemplateTopology(id: string, payload: SaveRangeTemplateTopologyInput, operation?: OperationRequest): Promise<RangeTemplate>;
  publishRangeTemplate(id: string, expectedRevision: number, operation?: OperationRequest): Promise<RangeTemplate>;
  returnRangeTemplateToPrivate(id: string, expectedRevision: number, operation?: OperationRequest): Promise<RangeTemplate>;
  removeRangeTemplate(id: string, operation?: OperationRequest): Promise<void>;
  listPlatformImages(view?: PlatformImageView): Promise<PlatformImageAsset[]>;
  listPlatformImageTags(): Promise<PlatformImageTag[]>;
  createPlatformImageTag(name: string, operation?: OperationRequest): Promise<PlatformImageTag>;
  setPlatformImageTags(id: string, tagIds: string[], operation?: OperationRequest): Promise<PlatformImageAsset>;
  collectPlatformImage(payload: CollectPlatformImageInput, operation?: OperationRequest): Promise<PlatformImageAsset>;
  renamePlatformImage(id: string, displayName: string, operation?: OperationRequest): Promise<PlatformImageAsset>;
  publishPlatformImage(id: string, operation?: OperationRequest): Promise<PlatformImageAsset>;
  unpublishPlatformImage(id: string, operation?: OperationRequest): Promise<PlatformImageAsset>;
  enablePlatformImage(id: string, operation?: OperationRequest): Promise<PlatformImageAsset>;
  disablePlatformImage(id: string, operation?: OperationRequest): Promise<PlatformImageAsset>;
  removePlatformImage(id: string, operation?: OperationRequest): Promise<void>;
  listImageCatalog(scope: ImageCatalogScope): Promise<ImageCatalogScopePayload>;
  syncImageCatalog(scope: ImageCatalogScope): Promise<ImageCatalogScopePayload>;
  removeCustomImageSnapshot(snapshotId: string, options?: { deleteOwnedSnapshots?: boolean }, operation?: OperationRequest): Promise<Record<string, unknown> | void>;
  listImageImportJobs(): Promise<ImageImportJobListPayload>;
  retryImageImport(id: string): Promise<ImageImportJob>;
  listRangeInstances(view?: InstanceView): Promise<RangeInstance[]>;
  getRangeInstance(id: string, options?: GetRangeInstanceOptions): Promise<RangeInstance>;
  getRangeInstanceAccess(id: string): Promise<RangeAccessPayload>;
  saveRangeInstanceDraft(id: string, payload: SaveRangeInstanceDraftInput, operation?: OperationRequest): Promise<RangeInstance>;
  applyRangeInstanceDraft(
    id: string,
    expectedDraftRevision: number,
    operation?: OperationRequest,
  ): Promise<Record<string, unknown>>;
  syncRangeInstanceTemplate(
    id: string,
    expectedDraftRevision: number,
    expectedTemplateRevision: number,
    operation?: OperationRequest,
  ): Promise<RangeTemplate>;
  retryRangeInstance(id: string, operation?: OperationRequest): Promise<Record<string, unknown>>;
  runRangeInstanceNodeAction(
    rangeInstanceId: string,
    nodeId: string,
    action: 'start' | 'stop' | 'reboot' | 'open-vnc' | 'pack-image',
    payload?: RangeInstanceNodeActionPayload,
    operation?: OperationRequest,
  ): Promise<Record<string, unknown>>;
  listSingleInstanceNetworks?():Promise<Record<string,unknown>[]>;
  registerSingleInstanceNetworkCleanup?(id:string,payload:{runId:string;createdAfter:string;ownerUserIds:string[]}):Promise<Record<string,unknown>>;
  destroySingleInstanceNetwork?(id:string,cleanupRunId:string,operation?:OperationRequest):Promise<Record<string,unknown>>;
  listSingleInstances(view?: InstanceView): Promise<SingleInstanceListPayload>;
  getSingleInstance(id: string): Promise<RangeInstance | null>;
  getSingleInstanceCloudResourceStatus(id: string): Promise<SingleInstanceCloudResourceStatus>;
  getSingleInstanceAccess(id: string): Promise<RangeAccessPayload>;
  getInstanceTypeAvailability(cpu: number, memory: number): Promise<InstanceTypeAvailabilitySnapshot>;
  listProvisionJobs(instanceMode?: InstanceMode): Promise<ProvisionJob[]>;
  getProvisionJob(id: string): Promise<ProvisionJob>;
  fetchCloudConfig(): Promise<CloudConfigSnapshot>;
  saveCloudConfig(payload: CloudConfigSnapshot, operation?: OperationRequest): Promise<CloudConfigSnapshot>;
  listCloudAccountContexts(includeInactive?: boolean): Promise<CloudAccountContext[]>;
  saveTencentCloudAccount(payload: SaveTencentCloudAccountInput, operation?: OperationRequest): Promise<CloudAccountContext>;
  discoverTencentCloudRegions(payload: TencentCloudRegionsInput): Promise<TencentCloudRegionsPayload>;
  listTencentCloudImages(input: TencentCloudImagesInput): Promise<TencentCloudImagesPayload>;
  getCloudAccountInstanceTypeAvailability(id: string, cpu: number, memory: number): Promise<InstanceTypeAvailabilitySnapshot>;
  getBillingSummary(input?: BillingWindowInput): Promise<BillingSummary>;
  listBillingUsers(input?: BillingWindowInput): Promise<PaginatedResult<BillingUserSummary>>;
  getBillingUserSummary(userId: string, input?: BillingWindowInput): Promise<BillingUserSummary>;
  listBillingUserGroups(input?: BillingGroupInput): Promise<PaginatedResult<BillingLaunchGroup>>;
  listBillingPlatformGroups(input?: BillingWindowInput): Promise<PaginatedResult<BillingLaunchGroup>>;
  listBillingUserItems(userId: string, input?: BillingWindowInput): Promise<BillingLineItem[]>;
  listBillingPlatformItems(input?: BillingWindowInput): Promise<BillingLineItem[]>;
  listBillingAnomalies(input?: BillingWindowInput): Promise<BillingAnomaly[]>;
  syncBilling(input?: Pick<BillingWindowInput, 'startAt' | 'endAt'>): Promise<BillingSyncResult>;
  exportPlatformBillingCsv(input?: Pick<BillingWindowInput, 'startAt' | 'endAt'>): Promise<string>;
  exportBillingUsersCsv(input?: Pick<BillingWindowInput, 'startAt' | 'endAt'>): Promise<string>;
  exportBillingUserItemsCsv(userId: string, input?: Pick<BillingWindowInput, 'startAt' | 'endAt'>): Promise<string>;
  listAdminUsers(): Promise<AdminUser[]>;
  createAdminUser(payload: CreateAdminUserInput, operation?: OperationRequest): Promise<AdminUser>;
  updateAdminUserRole(id: string, payload: UpdateAdminUserRoleInput, operation?: OperationRequest): Promise<AdminUser>;
  updateAdminUserStatus(id: string, payload: UpdateAdminUserStatusInput, operation?: OperationRequest): Promise<AdminUser>;
  resetAdminUserPassword(id: string, payload: ResetAdminUserPasswordInput, operation?: OperationRequest): Promise<AdminUser>;
  launchRange(payload: LaunchRangeInput, operation?: OperationRequest): Promise<RangeInstance>;
  destroyRange(rangeInstanceId: string, operation?: OperationRequest): Promise<Record<string, unknown>>;
  launchSingleInstances(payload: LaunchSingleInstancesInput, operation?: OperationRequest): Promise<Record<string, unknown>>;
  destroySingleInstance(id: string, operation?: OperationRequest): Promise<Record<string, unknown>>;
  destroySingleInstanceBatch(id: string, operation?: OperationRequest): Promise<Record<string, unknown>>;
  retrySingleInstance(id: string, operation?: OperationRequest): Promise<Record<string, unknown>>;
  rebootSingleInstance(id: string, payload?: SingleInstanceActionPayload, operation?: OperationRequest): Promise<Record<string, unknown>>;
  openSingleInstanceVnc(id: string, payload?: SingleInstanceActionPayload): Promise<Record<string, unknown>>;
  packSingleInstanceImage(id: string, payload?: SingleInstanceActionPayload, operation?: OperationRequest): Promise<Record<string, unknown>>;
};
