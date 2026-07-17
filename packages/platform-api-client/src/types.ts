export type RangeTemplateView = 'platform' | 'mine';
export type PlatformImageView = 'platform' | 'mine';
export type InstanceView = 'active' | 'history';
export type InstanceMode = 'single' | 'range';

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
  defaultInstancePassword?: string | null;
  accessEntry?: Record<string, unknown> | null;
  runtimeCredentials?: Record<string, unknown> | null;
};

export type RangeTemplate = Record<string, unknown> & { id: string };
export type PlatformImageAsset = Record<string, unknown> & { id: string };
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

export type LaunchRangeInput = {
  templateId: string;
  name: string;
  expiresAt: string;
};

export type LaunchSingleInstancesInput = {
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
  listPlatformImages(view?: PlatformImageView): Promise<PlatformImageAsset[]>;
  collectPlatformImage(payload: CollectPlatformImageInput, operation?: OperationRequest): Promise<PlatformImageAsset>;
  renamePlatformImage(id: string, displayName: string, operation?: OperationRequest): Promise<PlatformImageAsset>;
  publishPlatformImage(id: string, operation?: OperationRequest): Promise<PlatformImageAsset>;
  unpublishPlatformImage(id: string, operation?: OperationRequest): Promise<PlatformImageAsset>;
  enablePlatformImage(id: string, operation?: OperationRequest): Promise<PlatformImageAsset>;
  disablePlatformImage(id: string, operation?: OperationRequest): Promise<PlatformImageAsset>;
  removePlatformImage(id: string, operation?: OperationRequest): Promise<void>;
  listRangeInstances(view?: InstanceView): Promise<RangeInstance[]>;
  getRangeInstance(id: string): Promise<RangeInstance>;
  getRangeInstanceAccess(id: string): Promise<RangeAccessPayload>;
  listSingleInstances(view?: InstanceView): Promise<SingleInstanceListPayload>;
  getSingleInstance(id: string): Promise<RangeInstance | null>;
  getSingleInstanceAccess(id: string): Promise<RangeAccessPayload>;
  listProvisionJobs(instanceMode?: InstanceMode): Promise<ProvisionJob[]>;
  getProvisionJob(id: string): Promise<ProvisionJob>;
  fetchCloudConfig(): Promise<CloudConfigSnapshot>;
  saveCloudConfig(payload: CloudConfigSnapshot, operation?: OperationRequest): Promise<CloudConfigSnapshot>;
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
