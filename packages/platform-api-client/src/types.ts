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
export type PlatformImageAsset = Record<string, unknown> & { id: string };
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
  limit?: number;
};

export type BillingGroupInput = BillingWindowInput & {
  userId?: string;
};

export type BillingSummary = Record<string, unknown> & {
  startAt: string;
  endAt: string;
  totalPretaxAmount: number;
  platformPretaxAmount: number;
  anomalyCount: number;
};

export type BillingUserSummary = Record<string, unknown> & {
  userId: string;
  username: string;
  pretaxAmount: number;
  itemCount: number;
  launchCount: number;
};

export type BillingLaunchGroup = Record<string, unknown> & { id: string };
export type BillingLineItem = Record<string, unknown> & { id: string };
export type BillingAnomaly = Record<string, unknown> & { id: string };
export type BillingSyncResult = {
  syncedDays: number;
  importedLineItems: number;
  anomalyCount: number;
  deferredCount: number;
};
export type RangeInstance = Record<string, unknown> & { id: string; instanceMode?: 'range' | 'single' };
export type ProvisionJob = Record<string, unknown> & { id: string };
export type CloudConfigSnapshot = Record<string, unknown>;
export type AdminUser = Record<string, unknown> & { id: string; username: string };
export type SingleInstanceListPayload = {
  batches: Array<{
    batch: Record<string, unknown> & { id: string };
    instances: RangeInstance[];
  }>;
  standaloneInstances: RangeInstance[];
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
  draftScenarioTemplateSpec: Record<string, unknown>;
  draftCompiledProvisionSpec: Record<string, unknown>;
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
  collectPlatformImage(payload: CollectPlatformImageInput, operation?: OperationRequest): Promise<PlatformImageAsset>;
  renamePlatformImage(id: string, displayName: string, operation?: OperationRequest): Promise<PlatformImageAsset>;
  publishPlatformImage(id: string, operation?: OperationRequest): Promise<PlatformImageAsset>;
  unpublishPlatformImage(id: string, operation?: OperationRequest): Promise<PlatformImageAsset>;
  enablePlatformImage(id: string, operation?: OperationRequest): Promise<PlatformImageAsset>;
  disablePlatformImage(id: string, operation?: OperationRequest): Promise<PlatformImageAsset>;
  removePlatformImage(id: string, operation?: OperationRequest): Promise<void>;
  listImageCatalog(scope: ImageCatalogScope): Promise<ImageCatalogScopePayload>;
  syncImageCatalog(scope: ImageCatalogScope): Promise<ImageCatalogScopePayload>;
  removeCustomImageSnapshot(snapshotId: string): Promise<void>;
  listImageImportJobs(): Promise<ImageImportJobListPayload>;
  retryImageImport(id: string): Promise<ImageImportJob>;
  listRangeInstances(view?: InstanceView): Promise<RangeInstance[]>;
  getRangeInstance(id: string): Promise<RangeInstance>;
  getRangeInstanceAccess(id: string): Promise<RangeAccessPayload>;
  saveRangeInstanceDraft(id: string, payload: SaveRangeInstanceDraftInput, operation?: OperationRequest): Promise<RangeInstance>;
  applyRangeInstanceDraft(id: string, operation?: OperationRequest): Promise<Record<string, unknown>>;
  syncRangeInstanceTemplate(id: string, operation?: OperationRequest): Promise<RangeTemplate>;
  retryRangeInstance(id: string, operation?: OperationRequest): Promise<Record<string, unknown>>;
  removeFailedRangeInstance(id: string, operation?: OperationRequest): Promise<void>;
  runRangeInstanceNodeAction(
    rangeInstanceId: string,
    nodeId: string,
    action: 'start' | 'stop' | 'reboot' | 'open-vnc' | 'pack-image',
    payload?: RangeInstanceNodeActionPayload,
    operation?: OperationRequest,
  ): Promise<Record<string, unknown>>;
  listSingleInstances(view?: InstanceView): Promise<SingleInstanceListPayload>;
  getSingleInstance(id: string): Promise<RangeInstance | null>;
  getSingleInstanceAccess(id: string): Promise<RangeAccessPayload>;
  getInstanceTypeAvailability(cpu: number, memory: number): Promise<InstanceTypeAvailabilitySnapshot>;
  listProvisionJobs(instanceMode?: InstanceMode): Promise<ProvisionJob[]>;
  getProvisionJob(id: string): Promise<ProvisionJob>;
  fetchCloudConfig(): Promise<CloudConfigSnapshot>;
  saveCloudConfig(payload: CloudConfigSnapshot, operation?: OperationRequest): Promise<CloudConfigSnapshot>;
  getBillingSummary(input?: BillingWindowInput): Promise<BillingSummary>;
  listBillingUsers(input?: BillingWindowInput): Promise<BillingUserSummary[]>;
  getBillingUserSummary(userId: string, input?: BillingWindowInput): Promise<BillingUserSummary>;
  listBillingUserGroups(input?: BillingGroupInput): Promise<BillingLaunchGroup[]>;
  listBillingPlatformGroups(input?: BillingWindowInput): Promise<BillingLaunchGroup[]>;
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
