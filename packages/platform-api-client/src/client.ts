import type {
  AdminUser,
  BillingAnomaly,
  BillingGroupInput,
  BillingLaunchGroup,
  BillingLineItem,
  BillingSummary,
  BillingSyncResult,
  BillingUserSummary,
  BillingWindowInput,
  CloudConfigSnapshot,
  CloudAccountContext,
  SaveTencentCloudAccountInput,
  SaveCloudAccountInput,
  CloudWorkspaceView,
  CloudAccountRemovalResult,
  TencentCloudRegionsInput,
  TencentCloudRegionsPayload,
  TencentCloudImagesInput,
  TencentCloudImagesPayload,
  CollectPlatformImageInput,
  CreateRangeTemplateInput,
  SaveRangeInstanceAsTemplateInput,
  SaveRangeInstanceAsTemplateResult,
  CreateAdminUserInput,
  GetRangeInstanceOptions,
  InstanceMode,
  InstanceTypeAvailabilitySnapshot,
  InstanceView,
  ImageCatalogScope,
  ImageCatalogScopePayload,
  ImageImportJob,
  ImageImportJobListPayload,
  LaunchRangeInput,
  LaunchSingleInstancesInput,
  OperationRequest,
  PaginatedResult,
  PlatformApiClientLike,
  PlatformApiClientOptions,
  PlatformImageAsset,
  PlatformImageTag,
  PlatformImageView,
  ProvisionJob,
  RangeAccessPayload,
  RangeInstance,
  RangeInstanceNodeActionPayload,
  RangeTemplate,
  RangeTemplateView,
  ResetAdminUserPasswordInput,
  SingleInstanceActionPayload,
  SingleInstanceListPayload,
  SaveRangeInstanceDraftInput,
  SaveRangeTemplateTopologyInput,
  SingleInstanceCloudResourceStatus,
  UpdateAdminUserRoleInput,
  UpdateAdminUserStatusInput,
  UpdateRangeTemplateInput,
} from './types';

export class PlatformApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'PlatformApiError';
  }
}

export class PlatformApiClient implements PlatformApiClientLike {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly cloudWorkspaceId: string | undefined;

  constructor(options: PlatformApiClientOptions) {
    if (options.cloudWorkspaceId !== undefined && (!options.cloudWorkspaceId.trim() || options.cloudWorkspaceId.length > 192)) {
      throw new Error('Invalid cloud workspace selection');
    }
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.token = options.token;
    this.fetchImpl = options.fetch ?? fetch;
    this.cloudWorkspaceId = options.cloudWorkspaceId?.trim();
  }

  listRangeTemplates(view: RangeTemplateView = 'platform') {
    return this.request<RangeTemplate[]>(`/admin/scenarios?view=${encodeURIComponent(view)}`);
  }

  async getRangeTemplate(id: string) {
    try {
      return await this.request<RangeTemplate>(`/admin/scenarios/${encodeURIComponent(id)}`);
    } catch (error) {
      if (error instanceof PlatformApiError && error.status === 404) {
        return null;
      }

      throw error;
    }
  }

  createRangeTemplate(payload: CreateRangeTemplateInput, operation?: OperationRequest) {
    return this.request<RangeTemplate>('/admin/scenarios', {
      method: 'POST',
      body: JSON.stringify(payload),
      operation,
    });
  }

  updateRangeTemplate(id: string, payload: UpdateRangeTemplateInput, operation?: OperationRequest) {
    return this.request<RangeTemplate>(`/admin/scenarios/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
      operation,
    });
  }

  cloneRangeTemplate(id: string, operation?: OperationRequest) {
    return this.templateAction<RangeTemplate>(id, 'clone', operation);
  }

  saveRangeTemplateTopology(id: string, payload: SaveRangeTemplateTopologyInput, operation?: OperationRequest) {
    return this.request<RangeTemplate>(`/admin/scenarios/${encodeURIComponent(id)}/validate-and-save`, {
      method: 'POST',
      body: JSON.stringify(payload),
      operation,
    });
  }

  publishRangeTemplate(id: string, expectedRevision: number, operation?: OperationRequest) {
    return this.templateRevisionAction(id, 'share', expectedRevision, operation);
  }

  returnRangeTemplateToPrivate(id: string, expectedRevision: number, operation?: OperationRequest) {
    return this.templateRevisionAction(id, 'unshare', expectedRevision, operation);
  }

  async removeRangeTemplate(id: string, operation?: OperationRequest) {
    await this.request<void>(`/admin/scenarios/${encodeURIComponent(id)}`, { method: 'DELETE', operation });
  }

  async listPlatformImages(view: PlatformImageView = 'platform') {
    const result = await this.request<{ items: PlatformImageAsset[] }>(`/admin/platform-images?view=${encodeURIComponent(view)}`);
    return result.items;
  }

  async listPlatformImageTags() {
    const result = await this.request<{ items: PlatformImageTag[] }>('/admin/platform-image-tags');
    return result.items;
  }

  createPlatformImageTag(name: string, operation?: OperationRequest) {
    return this.request<PlatformImageTag>('/admin/platform-image-tags', { method: 'POST', body: JSON.stringify({ name }), operation });
  }

  setPlatformImageTags(id: string, tagIds: string[], operation?: OperationRequest) {
    return this.request<PlatformImageAsset>(`/admin/platform-images/${encodeURIComponent(id)}/tags`, { method: 'PUT', body: JSON.stringify({ tagIds }), operation });
  }

  collectPlatformImage(payload: CollectPlatformImageInput, operation?: OperationRequest) {
    return this.request<PlatformImageAsset>('/admin/platform-images', {
      method: 'POST',
      body: JSON.stringify(payload),
      operation,
    });
  }

  renamePlatformImage(id: string, displayName: string, operation?: OperationRequest) {
    return this.request<PlatformImageAsset>(`/admin/platform-images/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ displayName }),
      operation,
    });
  }

  publishPlatformImage(id: string, operation?: OperationRequest) {
    return this.request<PlatformImageAsset>(`/admin/platform-images/${encodeURIComponent(id)}/publish`, {
      method: 'POST',
      body: '{}',
      operation,
    });
  }

  unpublishPlatformImage(id: string, operation?: OperationRequest) {
    return this.request<PlatformImageAsset>(`/admin/platform-images/${encodeURIComponent(id)}/unpublish`, {
      method: 'POST',
      body: '{}',
      operation,
    });
  }

  enablePlatformImage(id: string, operation?: OperationRequest) {
    return this.request<PlatformImageAsset>(`/admin/platform-images/${encodeURIComponent(id)}/enable`, {
      method: 'POST',
      body: '{}',
      operation,
    });
  }

  disablePlatformImage(id: string, operation?: OperationRequest) {
    return this.request<PlatformImageAsset>(`/admin/platform-images/${encodeURIComponent(id)}/disable`, {
      method: 'POST',
      body: '{}',
      operation,
    });
  }

  async removePlatformImage(id: string, operation?: OperationRequest) {
    await this.request<void>(`/admin/platform-images/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      operation,
    });
  }

  listImageCatalog(scope: ImageCatalogScope) {
    return this.request<ImageCatalogScopePayload>(`/admin/image-catalog/${scope}`);
  }

  syncImageCatalog(scope: ImageCatalogScope) {
    return this.request<ImageCatalogScopePayload>(`/admin/image-catalog/${scope}/sync`, {
      method: 'POST',
      body: '{}',
    });
  }

  async removeCustomImageSnapshot(snapshotId: string, options?: { deleteOwnedSnapshots?: boolean }, operation?: OperationRequest) {
    return this.request<Record<string, unknown>>(`/admin/image-catalog/custom/${encodeURIComponent(snapshotId)}${options?.deleteOwnedSnapshots ? '?deleteOwnedSnapshots=true' : ''}`, {
      method: 'DELETE',
      operation,
    });
  }

  listImageImportJobs() {
    return this.request<ImageImportJobListPayload>('/admin/image-imports');
  }

  retryImageImport(id: string) {
    return this.request<ImageImportJob>(`/admin/image-imports/${encodeURIComponent(id)}/retry`, {
      method: 'POST',
      body: '{}',
    });
  }

  listRangeInstances(view: InstanceView = 'active') {
    return this.request<RangeInstance[]>(`/admin/ranges?view=${encodeURIComponent(view)}`);
  }

  getRangeInstance(id: string, options?: GetRangeInstanceOptions) {
    const query = options?.includeNetworkDiagnostics === true ? '?includeNetworkDiagnostics=true' : '';
    return this.request<RangeInstance>(`/admin/ranges/${encodeURIComponent(id)}${query}`);
  }

  validateRangeInstanceNodePackImage(rangeInstanceId: string, nodeId: string, payload: Pick<RangeInstanceNodeActionPayload, 'displayName' | 'description'>) {
    return this.request<Record<string, unknown>>(`/admin/ranges/${encodeURIComponent(rangeInstanceId)}/nodes/${encodeURIComponent(nodeId)}/pack-image-validation`, {
      method: 'POST', body: JSON.stringify(payload),
    });
  }

  async getRangeInstanceAccess(id: string): Promise<RangeAccessPayload> {
    return this.request<RangeAccessPayload>(`/admin/ranges/${encodeURIComponent(id)}/access`);
  }

  saveRangeInstanceAsTemplate(id: string, payload: SaveRangeInstanceAsTemplateInput, operation: OperationRequest & { idempotencyKey: string }) {
    return this.request<SaveRangeInstanceAsTemplateResult>(`/admin/ranges/${encodeURIComponent(id)}/templates`, {
      method: 'POST', body: JSON.stringify(payload), operation,
    });
  }

  saveRangeInstanceDraft(id: string, payload: SaveRangeInstanceDraftInput, operation?: OperationRequest) {
    return this.request<RangeInstance>(`/admin/ranges/${encodeURIComponent(id)}/draft`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
      operation,
    });
  }

  applyRangeInstanceDraft(id: string, expectedDraftRevision: number, operation?: OperationRequest) {
    return this.request<Record<string, unknown>>(`/admin/ranges/${encodeURIComponent(id)}/apply`, {
      method: 'POST',
      body: JSON.stringify({ expectedDraftRevision }),
      operation,
    });
  }

  syncRangeInstanceTemplate(
    id: string,
    expectedDraftRevision: number,
    expectedTemplateRevision: number,
    operation?: OperationRequest,
  ) {
    return this.request<RangeTemplate>(`/admin/ranges/${encodeURIComponent(id)}/sync-template`, {
      method: 'POST',
      body: JSON.stringify({ expectedDraftRevision, expectedTemplateRevision }),
      operation,
    });
  }

  retryRangeInstance(id: string, operation?: OperationRequest) {
    return this.request<Record<string, unknown>>(`/admin/ranges/${encodeURIComponent(id)}/retry`, {
      method: 'POST',
      body: '{}',
      operation,
    });
  }

  runRangeInstanceNodeAction(
    rangeInstanceId: string,
    nodeId: string,
    action: 'start' | 'stop' | 'reboot' | 'open-vnc' | 'pack-image' | 'verify-dns' | 'apply-dns',
    payload: RangeInstanceNodeActionPayload = {},
    operation?: OperationRequest,
  ) {
    return this.request<Record<string, unknown>>(
      `/admin/ranges/${encodeURIComponent(rangeInstanceId)}/nodes/${encodeURIComponent(nodeId)}/actions/${action}`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
        operation,
        ...(action === 'verify-dns' ? { signal: AbortSignal.timeout(180_000) } : {}),
        ...(action === 'apply-dns' ? { signal: AbortSignal.timeout(240_000) } : {}),
      },
    );
  }

  listSingleInstanceNetworks() {return this.request<Record<string,unknown>[]>('/admin/instances/networks');}
  registerSingleInstanceNetworkCleanup(id:string,payload:{runId:string;createdAfter:string;ownerUserIds:string[]}) {return this.request<Record<string,unknown>>(`/admin/instances/networks/${encodeURIComponent(id)}/register-cleanup`,{method:'POST',body:JSON.stringify(payload)});}
  destroySingleInstanceNetwork(id:string,cleanupRunId:string,operation?:OperationRequest) {
    return this.request<Record<string,unknown>>(`/admin/instances/networks/${encodeURIComponent(id)}/destroy`,{method:'POST',body:JSON.stringify({cleanupRunId}),operation});
  }

  listSingleInstances(view: InstanceView = 'active') {
    return this.request<SingleInstanceListPayload>(`/admin/instances?view=${encodeURIComponent(view)}`);
  }

  async getSingleInstance(id: string) {
    try { return await this.request<RangeInstance>(`/admin/instances/${encodeURIComponent(id)}`); }
    catch (error) { if (error instanceof PlatformApiError && error.status === 404) return null; throw error; }
  }

  getSingleInstanceCloudResourceStatus(id: string): Promise<SingleInstanceCloudResourceStatus> {
    return this.request<SingleInstanceCloudResourceStatus>(
      `/admin/instances/${encodeURIComponent(id)}/cloud-resource-status`,
    );
  }

  async getSingleInstanceAccess(id: string): Promise<RangeAccessPayload> {
    return this.request<RangeAccessPayload>(`/admin/instances/${encodeURIComponent(id)}/access`);
  }

  getInstanceTypeAvailability(cpu: number, memory: number) {
    return this.request<InstanceTypeAvailabilitySnapshot>(
      `/admin/system-config/instance-type-availability?cpu=${encodeURIComponent(cpu)}&memory=${encodeURIComponent(memory)}`,
    );
  }

  listProvisionJobs(instanceMode?: InstanceMode) {
    const query = instanceMode ? `?instanceMode=${encodeURIComponent(instanceMode)}` : '';
    return this.request<ProvisionJob[]>(`/admin/provision-jobs${query}`);
  }

  getProvisionJob(id: string, options?: { includeEvidence?: boolean }) {
    const query = options?.includeEvidence === undefined ? '' : `?includeEvidence=${options.includeEvidence}`;
    return this.request<ProvisionJob>(`/admin/provision-jobs/${encodeURIComponent(id)}${query}`);
  }

  fetchCloudConfig() {
    return this.request<CloudConfigSnapshot>('/admin/system-config');
  }

  listCloudAccountContexts(includeInactive = false) {
    return this.request<CloudAccountContext[]>(`/admin/cloud-contexts${includeInactive ? '?includeInactive=true' : ''}`);
  }

  saveTencentCloudAccount(payload: SaveTencentCloudAccountInput, operation?: OperationRequest) {
    return this.request<CloudAccountContext>('/admin/cloud-contexts', { method: 'POST', body: JSON.stringify(payload), operation });
  }

  saveCloudAccountBinding(payload: SaveCloudAccountInput, operation?: OperationRequest) {
    return this.request<CloudAccountContext>('/admin/cloud-contexts', { method: 'POST', body: JSON.stringify(payload), operation });
  }

  listCloudWorkspaces() { return this.request<CloudWorkspaceView[]>('/admin/cloud-workspaces'); }
  getCurrentCloudWorkspace() { return this.request<CloudWorkspaceView | null>('/admin/cloud-workspaces/current'); }
  switchCloudWorkspace(id: string) {
    return this.request<CloudWorkspaceView>(`/admin/cloud-workspaces/${encodeURIComponent(id)}/switch`, { method: 'POST', body: '{}' });
  }
  deleteCloudWorkspace(id: string, operation?: OperationRequest) {
    return this.request<CloudAccountRemovalResult>(`/admin/cloud-workspaces/${encodeURIComponent(id)}`, { method: 'DELETE', operation });
  }

  discoverTencentCloudRegions(payload: TencentCloudRegionsInput) {
    return this.request<TencentCloudRegionsPayload>('/admin/tencent-cloud/regions/query', { method: 'POST', body: JSON.stringify(payload) });
  }

  listTencentCloudImages(input: TencentCloudImagesInput) {
    const params = new URLSearchParams({ scope: input.scope });
    if (input.offset !== undefined) params.set('offset', String(input.offset));
    if (input.limit !== undefined) params.set('limit', String(input.limit));
    return this.request<TencentCloudImagesPayload>(`/admin/tencent-cloud/contexts/${encodeURIComponent(input.cloudAccountContextId)}/images?${params}`);
  }

  getCloudAccountInstanceTypeAvailability(id: string, cpu: number, memory: number) {
    return this.request<InstanceTypeAvailabilitySnapshot>(`/admin/cloud-contexts/${encodeURIComponent(id)}/instance-type-availability?${new URLSearchParams({ cpu: String(cpu), memory: String(memory) })}`);
  }

  saveCloudConfig(payload: CloudConfigSnapshot, operation?: OperationRequest) {
    return this.request<CloudConfigSnapshot>('/admin/system-config', {
      method: 'PATCH',
      body: JSON.stringify(payload),
      operation,
    });
  }

  getBillingSummary(input: BillingWindowInput = {}) {
    return this.request<BillingSummary>(this.billingPath('summary', input));
  }

  listBillingUsers(input: BillingWindowInput = {}) {
    return this.request<PaginatedResult<BillingUserSummary>>(this.billingPath('users', input));
  }

  getBillingUserSummary(userId: string, input: BillingWindowInput = {}) {
    return this.request<BillingUserSummary>(this.billingPath(`users/${encodeURIComponent(userId)}`, input));
  }

  listBillingUserGroups(input: BillingGroupInput = {}) {
    return this.request<PaginatedResult<BillingLaunchGroup>>(this.billingPath('user-groups', input));
  }

  listBillingPlatformGroups(input: BillingWindowInput = {}) {
    return this.request<PaginatedResult<BillingLaunchGroup>>(this.billingPath('platform/groups', input));
  }

  listBillingUserItems(userId: string, input: BillingWindowInput = {}) {
    return this.request<BillingLineItem[]>(this.billingPath(`users/${encodeURIComponent(userId)}/items`, input));
  }

  listBillingPlatformItems(input: BillingWindowInput = {}) {
    return this.request<BillingLineItem[]>(this.billingPath('platform/items', input));
  }

  listBillingAnomalies(input: BillingWindowInput = {}) {
    return this.request<BillingAnomaly[]>(this.billingPath('anomalies', input));
  }

  syncBilling(input: Pick<BillingWindowInput, 'startAt' | 'endAt'> = {}) {
    return this.request<BillingSyncResult>('/admin/billing/sync', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  exportPlatformBillingCsv(input: Pick<BillingWindowInput, 'startAt' | 'endAt'> = {}) {
    return this.requestText(this.billingPath('export/platform.csv', input));
  }

  exportBillingUsersCsv(input: Pick<BillingWindowInput, 'startAt' | 'endAt'> = {}) {
    return this.requestText(this.billingPath('export/users.csv', input));
  }

  exportBillingUserItemsCsv(userId: string, input: Pick<BillingWindowInput, 'startAt' | 'endAt'> = {}) {
    return this.requestText(this.billingPath(`export/users/${encodeURIComponent(userId)}.csv`, input));
  }

  listAdminUsers() {
    return this.request<AdminUser[]>('/admin/users');
  }

  createAdminUser(payload: CreateAdminUserInput, operation?: OperationRequest) {
    return this.request<AdminUser>('/admin/users', {
      method: 'POST',
      body: JSON.stringify(payload),
      operation,
    });
  }

  updateAdminUserRole(id: string, payload: UpdateAdminUserRoleInput, operation?: OperationRequest) {
    return this.request<AdminUser>(`/admin/users/${encodeURIComponent(id)}/role`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
      operation,
    });
  }

  updateAdminUserStatus(id: string, payload: UpdateAdminUserStatusInput, operation?: OperationRequest) {
    return this.request<AdminUser>(`/admin/users/${encodeURIComponent(id)}/status`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
      operation,
    });
  }

  resetAdminUserPassword(id: string, payload: ResetAdminUserPasswordInput, operation?: OperationRequest) {
    return this.request<AdminUser>(`/admin/users/${encodeURIComponent(id)}/reset-password`, {
      method: 'POST',
      body: JSON.stringify(payload),
      operation,
    });
  }

  launchRange(payload: LaunchRangeInput, operation?: OperationRequest) {
    return this.request<RangeInstance>('/admin/ranges/launch', {
      method: 'POST',
      body: JSON.stringify(payload),
      operation,
    });
  }

  destroyRange(rangeInstanceId: string, operation?: OperationRequest) {
    return this.request<Record<string, unknown>>(`/admin/ranges/${encodeURIComponent(rangeInstanceId)}/destroy`, {
      method: 'POST',
      body: '{}',
      operation,
    });
  }

  launchSingleInstances(payload: LaunchSingleInstancesInput, operation?: OperationRequest) {
    return this.request<Record<string, unknown>>('/admin/instances/launch', {
      method: 'POST',
      body: JSON.stringify(payload),
      operation,
    });
  }

  destroySingleInstance(id: string, operation?: OperationRequest) {
    return this.request<Record<string, unknown>>(`/admin/instances/${encodeURIComponent(id)}/destroy`, {
      method: 'POST',
      body: '{}',
      operation,
    });
  }

  destroySingleInstanceBatch(id: string, operation?: OperationRequest) {
    return this.request<Record<string, unknown>>(`/admin/instances/batches/${encodeURIComponent(id)}/destroy-all`, {
      method: 'POST',
      body: '{}',
      operation,
    });
  }

  retrySingleInstance(id: string, operation?: OperationRequest) {
    return this.request<Record<string, unknown>>(`/admin/instances/${encodeURIComponent(id)}/retry`, {
      method: 'POST',
      body: '{}',
      operation,
    });
  }

  rebootSingleInstance(id: string, payload: SingleInstanceActionPayload = {}, operation?: OperationRequest) {
    return this.action(id, 'reboot', payload, operation);
  }

  openSingleInstanceVnc(id: string, payload: SingleInstanceActionPayload = {}) {
    return this.action(id, 'open-vnc', payload);
  }

  packSingleInstanceImage(id: string, payload: SingleInstanceActionPayload = {}, operation?: OperationRequest) {
    return this.action(id, 'pack-image', payload, operation);
  }

  private action(id: string, action: 'reboot' | 'open-vnc' | 'pack-image', payload: SingleInstanceActionPayload, operation?: OperationRequest) {
    return this.request<Record<string, unknown>>(`/admin/instances/${encodeURIComponent(id)}/actions/${action}`, {
      method: 'POST',
      body: JSON.stringify(payload),
      operation,
    });
  }

  private templateAction<T>(id: string, action: 'clone', operation?: OperationRequest) {
    return this.request<T>(`/admin/scenarios/${encodeURIComponent(id)}/${action}`, {
      method: 'POST',
      body: '{}',
      operation,
    });
  }

  private templateRevisionAction(id: string, action: 'share' | 'unshare', expectedRevision: number, operation?: OperationRequest) {
    return this.request<RangeTemplate>(`/admin/scenarios/${encodeURIComponent(id)}/${action}`, {
      method: 'POST',
      body: JSON.stringify({ expectedRevision }),
      operation,
    });
  }

  private billingPath(path: string, input: BillingWindowInput | BillingGroupInput) {
    const query = new URLSearchParams();

    if (input.startAt) {
      query.set('startAt', input.startAt);
    }

    if (input.endAt) {
      query.set('endAt', input.endAt);
    }

    if (input.page !== undefined) {
      query.set('page', String(input.page));
    }

    if (input.pageSize !== undefined) {
      query.set('pageSize', String(input.pageSize));
    }

    if ('userId' in input && input.userId) {
      query.set('userId', input.userId);
    }

    const search = query.toString();
    return `/admin/billing/${path}${search ? `?${search}` : ''}`;
  }

  private async request<T>(path: string, init?: { method?: string; body?: string; operation?: OperationRequest; signal?: AbortSignal }) {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: init?.method ?? 'GET',
      headers: this.buildHeaders(init?.operation),
      body: init?.body,
      ...(init?.signal ? { signal: init.signal } : {}),
    });

    if (!response.ok) {
      let details: unknown = null;

      try {
        details = await response.json();
      } catch {
        details = await response.text().catch(() => null);
      }

      const message =
        details && typeof details === 'object' && 'message' in details && typeof (details as { message?: unknown }).message === 'string'
          ? (details as { message: string }).message
          : `Platform API request failed with status ${response.status}`;

      throw new PlatformApiError(response.status, message, details);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    const text = await response.text();

    if (!text.trim()) {
      return undefined as T;
    }

    return unwrapConfirmedOperationResult(JSON.parse(text)) as T;
  }

  private async requestText(path: string) {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: 'GET',
      headers: this.buildHeaders(),
    });

    if (!response.ok) {
      let details: unknown = null;

      try {
        details = await response.json();
      } catch {
        details = await response.text().catch(() => null);
      }

      const message =
        details && typeof details === 'object' && 'message' in details && typeof (details as { message?: unknown }).message === 'string'
          ? (details as { message: string }).message
          : `Platform API request failed with status ${response.status}`;

      throw new PlatformApiError(response.status, message, details);
    }

    return response.text();
  }

  private buildHeaders(operation?: OperationRequest) {
    return {
      Authorization: `Bearer ${this.token}`,
      ...(this.cloudWorkspaceId ? { 'x-cloud-workspace-id': this.cloudWorkspaceId } : {}),
      'Content-Type': 'application/json',
      ...(operation?.idempotencyKey ? { 'x-idempotency-key': operation.idempotencyKey } : {}),
      ...(operation?.confirmationId ? { 'x-confirmation-id': operation.confirmationId } : {}),
    };
  }
}

function unwrapConfirmedOperationResult(value: unknown): unknown {
  let current = value;
  let unwrappedOperation = false;

  // Confirmed MCP writes include operation metadata around the business response.
  while (
    current &&
    typeof current === 'object' &&
    !Array.isArray(current) &&
    typeof (current as { operationId?: unknown }).operationId === 'string' &&
    'result' in current &&
    (current as { result?: unknown }).result !== null
  ) {
    current = (current as { result: unknown }).result;
    unwrappedOperation = true;
  }

  while (
    unwrappedOperation &&
    current &&
    typeof current === 'object' &&
    !Array.isArray(current) &&
    Object.keys(current).length === 1 &&
    'result' in current &&
    (current as { result?: unknown }).result !== null
  ) {
    current = (current as { result: unknown }).result;
  }

  return current;
}
