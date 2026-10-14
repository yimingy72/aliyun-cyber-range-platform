import type {
  AdminUser,
  AdminBootstrapData,
  BillingAnomaly,
  BillingLaunchGroup,
  BillingLineItem,
  BillingSummary,
  BillingUserSummary,
  PaginatedResult,
  CollectImageCatalogItemInput,
  CloudConfigSnapshot,
  CreateAdminUserInput,
  ImageCatalogItem,
  ImageCatalogScopePayload,
  InstanceTypeAvailabilitySnapshot,
  PlatformImageAsset,
  PlatformImageAssetListPayload,
  PlatformImageTag,
  PlatformImageTagListPayload,
  CloudAccountContext,
  CreateImageImportInput,
  ImageImportJob,
  ImageImportUploadSession,
  RangeInstanceNodeActionResult,
  ProvisionJob,
  ProvisionJobStep,
  RangeInstanceCreateInput,
  RangeInstanceLaunchInput,
  RangeTemplateView,
  RangeInstance,
  RangeInstanceDetail,
  ResetAdminUserPasswordInput,
  Scenario,
  ScenarioCreateInput,
  ScenarioUpdateInput,
  SingleInstanceAction,
  SingleInstanceListPayload,
  SingleInstanceLaunchInput,
  SingleInstanceLaunchResult,
  PlatformImageView,
  UpdateAdminUserRoleInput,
  UpdateAdminUserStatusInput,
} from './admin-types';
import type { SaveTencentCloudAccountInput, TencentCloudImagesInput, TencentCloudImagesPayload, TencentCloudRegionsInput, TencentCloudRegionsPayload } from './admin-types';
import type { CloudWorkspaceView, DeleteCloudAccountResult, RangeInstanceChangePreview, RangeInstanceTemplateCopy, SaveCloudAccountInput } from './admin-types';
import { readCloudWorkspaceSelection } from './cloud-workspace-selection';
import type { ResourceAlert, ResourceAlertStatus, ResourcePatrol, ResourceReclaimPreview, ResourceReclaimResult } from '@aliyun-cyber-range/platform-api-client';

export async function fetchResourcePatrol(apiBaseUrl: string, token: string) {
  return readJson<ResourcePatrol>(await fetch(`${apiBaseUrl}/admin/resource-alerts/patrol`, { headers: createAdminHeaders(token) }));
}
export async function setResourcePatrolManager(apiBaseUrl: string, token: string, managerUserId: string) {
  return readJson<ResourcePatrol>(await fetch(`${apiBaseUrl}/admin/resource-alerts/patrol`,
    { method: 'POST', headers: createAdminHeaders(token), body: JSON.stringify({ managerUserId }) }));
}
export async function fetchResourceAlerts(apiBaseUrl: string, token: string, status?: ResourceAlertStatus) {
  return readJson<ResourceAlert[]>(await fetch(`${apiBaseUrl}/admin/resource-alerts${status ? `?status=${encodeURIComponent(status)}` : ''}`, { headers: createAdminHeaders(token) }));
}
export async function previewResourceReclaim(apiBaseUrl: string, token: string, id: string) {
  return readJson<ResourceReclaimPreview>(await fetch(`${apiBaseUrl}/admin/resource-alerts/${encodeURIComponent(id)}/preview`, { headers: createAdminHeaders(token) }));
}
export async function reclaimResourceAlert(apiBaseUrl: string, token: string, preview: ResourceReclaimPreview,
  workspaceId: string, operation: { idempotencyKey: string; confirmationId?: string }) {
  const response = await readJson<ResourceReclaimResult | { result: ResourceReclaimResult }>(await fetch(`${apiBaseUrl}/admin/resource-alerts/${encodeURIComponent(preview.alertId)}/reclaim`, {
    method: 'POST', headers: { ...createAdminHeaders(token, workspaceId), 'x-idempotency-key': operation.idempotencyKey,
      ...(operation.confirmationId ? { 'x-confirmation-id': operation.confirmationId } : {}) },
    body: JSON.stringify({ planDigest: preview.planDigest }),
  }));
  return 'result' in response ? response.result : response;
}

export type { AdminProfile, AdminSessionPayload } from './admin-types';
export async function fetchAuthenticatedAdminProfile(apiBaseUrl: string, token: string) {
  return readJson<import('./admin-types').AdminProfile>(await fetch(`${apiBaseUrl}/admin/session`, { headers: createAdminHeaders(token, null) }));
}

export class AdminApiError extends Error {
  constructor(
    readonly status: number,
    message = `Admin API request failed with status ${status}`,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AdminApiError';
  }
}

function createAdminHeaders(token: string, workspaceId: string | null = readCloudWorkspaceSelection()) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    ...(workspaceId ? { 'x-cloud-workspace-id': workspaceId } : {}),
  };
}

export async function fetchCloudWorkspaces(apiBaseUrl: string, token: string) {
  return readJson<CloudWorkspaceView[]>(await fetch(`${apiBaseUrl}/admin/cloud-workspaces`, { headers: createAdminHeaders(token, null) }));
}

export async function fetchCurrentCloudWorkspace(apiBaseUrl: string, token: string, cloudWorkspaceId: string | null = null) {
  return readJson<CloudWorkspaceView | null>(await fetch(`${apiBaseUrl}/admin/cloud-workspaces/current`, { headers: createAdminHeaders(token, cloudWorkspaceId) }));
}

export async function switchCloudWorkspace(apiBaseUrl: string, token: string, workspaceId: string) {
  return readJson<CloudWorkspaceView>(await fetch(`${apiBaseUrl}/admin/cloud-workspaces/${encodeURIComponent(workspaceId)}/switch`, { method: 'POST', headers: createAdminHeaders(token), body: '{}' }));
}

export async function saveCloudAccount(apiBaseUrl: string, token: string, input: SaveCloudAccountInput) {
  return readJson<CloudAccountContext>(await fetch(`${apiBaseUrl}/admin/cloud-contexts`, { method: 'POST', headers: createAdminHeaders(token), body: JSON.stringify(input) }));
}

export async function deleteCloudAccount(apiBaseUrl: string, token: string, workspaceId: string) {
  return readJson<DeleteCloudAccountResult>(await fetch(`${apiBaseUrl}/admin/cloud-workspaces/${encodeURIComponent(workspaceId)}`, {
    method: 'DELETE', headers: createAdminHeaders(token),
  }));
}

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let details: unknown;

    try {
      details = await response.json();
    } catch {
      details = null;
    }

    const message =
      details &&
      typeof details === 'object' &&
      'message' in details &&
      typeof (details as { message?: unknown }).message === 'string'
        ? (details as { message: string }).message
        : `Admin API request failed with status ${response.status}`;

    throw new AdminApiError(response.status, message, details);
  }

  return (await response.json()) as T;
}

async function readText(response: Response): Promise<string> {
  if (!response.ok) {
    let details: unknown;

    try {
      details = await response.json();
    } catch {
      details = null;
    }

    const message =
      details &&
      typeof details === 'object' &&
      'message' in details &&
      typeof (details as { message?: unknown }).message === 'string'
        ? (details as { message: string }).message
        : `Admin API request failed with status ${response.status}`;

    throw new AdminApiError(response.status, message, details);
  }

  return response.text();
}

export async function fetchAdminBootstrap(
  apiBaseUrl: string,
  token: string,
  options?: { templateView?: RangeTemplateView },
): Promise<AdminBootstrapData> {
  const headers = createAdminHeaders(token);
  const scenarioUrl = new URL(`${apiBaseUrl}/admin/scenarios`);

  if (options?.templateView) {
    scenarioUrl.searchParams.set('view', options.templateView);
  }

  const [templatesResponse, instancesResponse, jobsResponse] = await Promise.all([
    fetch(scenarioUrl, { headers }),
    fetch(`${apiBaseUrl}/admin/ranges`, { headers }),
    fetch(`${apiBaseUrl}/admin/provision-jobs`, { headers }),
  ]);

  const scenarios = await readJson<Scenario[]>(templatesResponse);

  return {
    scenarios,
    rangeTemplates: scenarios,
    rangeInstances: await readJson<RangeInstance[]>(instancesResponse),
    provisionJobs: await readJson<ProvisionJob[]>(jobsResponse),
  };
}

export async function fetchRangeTemplates(
  apiBaseUrl: string,
  token: string,
  view: RangeTemplateView,
) {
  const url = new URL(`${apiBaseUrl}/admin/scenarios`);
  url.searchParams.set('view', view);

  const response = await fetch(url, {
    headers: createAdminHeaders(token),
  });

  return readJson<Scenario[]>(response);
}

export async function fetchRangeTemplateById(apiBaseUrl: string, token: string, id: string) {
  const response = await fetch(`${apiBaseUrl}/admin/scenarios/${id}`, {
    headers: createAdminHeaders(token),
  });

  return readJson<Scenario>(response);
}

export async function fetchRangeInstances(
  apiBaseUrl: string,
  token: string,
  options?: { view?: 'active' | 'history' },
) {
  const url = new URL(`${apiBaseUrl}/admin/ranges`);

  if (options?.view) {
    url.searchParams.set('view', options.view);
  }

  const response = await fetch(url, {
    headers: createAdminHeaders(token),
  });

  return readJson<RangeInstance[]>(response);
}

export async function fetchRangeInstanceDetail(apiBaseUrl: string, token: string, id: string) {
  const response = await fetch(`${apiBaseUrl}/admin/ranges/${id}`, {
    headers: createAdminHeaders(token),
  });

  return readJson<RangeInstanceDetail>(response);
}

export async function fetchSingleInstances(
  apiBaseUrl: string,
  token: string,
  options?: { view?: 'active' | 'history' },
) {
  const url = new URL(`${apiBaseUrl}/admin/instances`);

  if (options?.view) {
    url.searchParams.set('view', options.view);
  }

  const response = await fetch(url, {
    headers: createAdminHeaders(token),
  });

  return readJson<RangeInstance[] | SingleInstanceListPayload>(response);
}

export async function fetchProvisionJobs(
  apiBaseUrl: string,
  token: string,
  options?: { instanceMode?: 'single' | 'range' },
) {
  const url = new URL(`${apiBaseUrl}/admin/provision-jobs`);

  if (options?.instanceMode) {
    url.searchParams.set('instanceMode', options.instanceMode);
  }

  const response = await fetch(url, {
    headers: createAdminHeaders(token),
  });

  return readJson<ProvisionJob[]>(response);
}

export async function launchSingleInstances(
  apiBaseUrl: string,
  token: string,
  payload: SingleInstanceLaunchInput,
  idempotencyKey: string,
) {
  const response = await fetch(`${apiBaseUrl}/admin/instances/launch`, {
    method: 'POST',
    headers: { ...createAdminHeaders(token), 'x-idempotency-key': idempotencyKey },
    body: JSON.stringify(payload),
  });

  return readJson<SingleInstanceLaunchResult>(response);
}

export async function triggerSingleInstanceAction(
  apiBaseUrl: string,
  token: string,
  id: string,
  action: SingleInstanceAction,
  payload: Record<string, unknown>,
) {
  const endpoint =
    action === 'destroy' || action === 'retry'
      ? `${apiBaseUrl}/admin/instances/${id}/${action}`
      : `${apiBaseUrl}/admin/instances/${id}/actions/${action}`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: createAdminHeaders(token),
    body: JSON.stringify(payload),
  });

  return readJson<Record<string, unknown>>(response);
}

export async function destroySingleInstanceBatch(
  apiBaseUrl: string,
  token: string,
  id: string,
) {
  const response = await fetch(`${apiBaseUrl}/admin/instances/batches/${id}/destroy-all`, {
    method: 'POST',
    headers: createAdminHeaders(token),
  });

  return readJson<{ batchId: string; jobCount: number }>(response);
}

export async function saveRangeInstanceDraft(
  apiBaseUrl: string,
  token: string,
  id: string,
  payload: {
    draftTopologyGraph: Record<string, unknown>;
    draftTopologySpec: Record<string, unknown>;
    draftScenarioTemplateSpec: Record<string, unknown>;
    draftCompiledProvisionSpec: Record<string, unknown>;
    expectedDraftRevision: number;
  },
) {
  const response = await fetch(`${apiBaseUrl}/admin/ranges/${id}/draft`, {
    method: 'PATCH',
    headers: createAdminHeaders(token),
    body: JSON.stringify(payload),
  });

  return readJson<RangeInstanceDetail>(response);
}

export async function discardRangeInstanceDraft(apiBaseUrl: string, token: string, id: string) {
  const response = await fetch(`${apiBaseUrl}/admin/ranges/${id}/draft`, {
    method: 'DELETE',
    headers: createAdminHeaders(token),
  });

  return readJson<RangeInstanceDetail>(response);
}

export async function applyRangeInstanceDraft(
  apiBaseUrl: string,
  token: string,
  id: string,
  expectedDraftRevision: number,
  previewToken: string,
) {
  const response = await fetch(`${apiBaseUrl}/admin/ranges/${encodeURIComponent(id)}/apply`, {
    method: 'POST',
    headers: createAdminHeaders(token),
    body: JSON.stringify({ expectedDraftRevision, previewToken }),
  });

  return readJson<ProvisionJob>(response);
}

export async function previewRangeInstanceDraft(apiBaseUrl: string, token: string, id: string, expectedDraftRevision: number) {
  return readJson<RangeInstanceChangePreview>(await fetch(`${apiBaseUrl}/admin/ranges/${encodeURIComponent(id)}/preview`, {
    method: 'POST', headers: createAdminHeaders(token), body: JSON.stringify({ expectedDraftRevision }),
  }));
}

export async function saveRangeInstanceAsTemplate(apiBaseUrl: string, token: string, id: string,
  input: { name: string; description?: string; expectedDraftRevision: number }, idempotencyKey: string) {
  return readJson<RangeInstanceTemplateCopy>(await fetch(`${apiBaseUrl}/admin/ranges/${encodeURIComponent(id)}/templates`, {
    method: 'POST', headers: { ...createAdminHeaders(token), 'x-idempotency-key': idempotencyKey }, body: JSON.stringify(input),
  }));
}

export async function syncRangeInstanceTemplate(
  apiBaseUrl: string,
  token: string,
  id: string,
  expectedDraftRevision: number,
  expectedTemplateRevision: number,
) {
  const response = await fetch(`${apiBaseUrl}/admin/ranges/${id}/sync-template`, {
    method: 'POST',
    headers: createAdminHeaders(token),
    body: JSON.stringify({ expectedDraftRevision, expectedTemplateRevision }),
  });

  return readJson<Scenario>(response);
}

export async function runRangeInstanceNodeAction(
  apiBaseUrl: string,
  token: string,
  rangeInstanceId: string,
  nodeId: string,
  action: 'start' | 'stop' | 'reboot' | 'open-vnc' | 'pack-image' | 'verify-dns',
  payload: Record<string, string>,
) {
  const response = await fetch(`${apiBaseUrl}/admin/ranges/${encodeURIComponent(rangeInstanceId)}/nodes/${encodeURIComponent(nodeId)}/actions/${action}`, {
    method: 'POST',
    headers: createAdminHeaders(token),
    body: JSON.stringify(payload),
    ...(action === 'verify-dns' ? { signal: AbortSignal.timeout(180_000) } : {}),
  });

  return readJson<RangeInstanceNodeActionResult>(response);
}

export async function createRangeInstance(
  apiBaseUrl: string,
  token: string,
  payload: RangeInstanceCreateInput,
) {
  const response = await fetch(`${apiBaseUrl}/admin/ranges`, {
    method: 'POST',
    headers: createAdminHeaders(token),
    body: JSON.stringify(payload),
  });

  return readJson<RangeInstance>(response);
}

export async function launchRangeInstance(
  apiBaseUrl: string,
  token: string,
  payload: RangeInstanceLaunchInput,
  idempotencyKey: string,
) {
  const response = await fetch(`${apiBaseUrl}/admin/ranges/launch`, {
    method: 'POST',
    headers: { ...createAdminHeaders(token), 'x-idempotency-key': idempotencyKey },
    body: JSON.stringify(payload),
  });

  return readJson<RangeInstance>(response);
}

export async function fetchProvisionJobDetail(apiBaseUrl: string, token: string, id: string) {
  const headers = createAdminHeaders(token);
  const [jobResponse, stepsResponse] = await Promise.all([
    fetch(`${apiBaseUrl}/admin/provision-jobs/${id}`, { headers }),
    fetch(`${apiBaseUrl}/admin/provision-jobs/${id}/steps`, { headers }),
  ]);

  return {
    job: await readJson<ProvisionJob>(jobResponse),
    steps: await readJson<ProvisionJobStep[]>(stepsResponse),
  };
}

export async function triggerRangeAction(
  apiBaseUrl: string,
  token: string,
  id: string,
  action: 'create' | 'destroy' | 'retry',
  idempotencyKey?: string,
) {
  const response = await fetch(`${apiBaseUrl}/admin/ranges/${id}/${action}`, {
    method: 'POST',
    headers: { ...createAdminHeaders(token), ...(idempotencyKey ? { 'x-idempotency-key': idempotencyKey } : {}) },
  });

  return readJson<ProvisionJob>(response);
}

export type RangeRecoveryStatus = { state: 'unconfirmed' } | { state: 'accepted'; jobId: string } | { state: 'rejected'; errorCode: string | null };

export async function fetchRangeRecoveryStatus(apiBaseUrl: string, token: string, id: string, trigger: 'retry' | 'destroy', key: string) {
  return readJson<RangeRecoveryStatus>(await fetch(`${apiBaseUrl}/admin/ranges/${encodeURIComponent(id)}/recovery/${trigger}`, {
    headers: { ...createAdminHeaders(token), 'x-idempotency-key': key },
  }));
}

export async function fetchCloudConfig(
  apiBaseUrl: string,
  token: string,
): Promise<CloudConfigSnapshot> {
  const response = await fetch(`${apiBaseUrl}/admin/system-config`, {
    headers: createAdminHeaders(token),
  });

  return readJson<CloudConfigSnapshot>(response);
}

export async function fetchBillingSummary(
  apiBaseUrl: string,
  token: string,
  options?: { startAt?: string; endAt?: string },
): Promise<BillingSummary> {
  const url = new URL(`${apiBaseUrl}/admin/billing/summary`);

  if (options?.startAt) {
    url.searchParams.set('startAt', options.startAt);
  }

  if (options?.endAt) {
    url.searchParams.set('endAt', options.endAt);
  }

  const response = await fetch(url, {
    headers: createAdminHeaders(token),
  });

  return readJson<BillingSummary>(response);
}

export async function fetchBillingUsers(
  apiBaseUrl: string,
  token: string,
  options?: { startAt?: string; endAt?: string; page?: number; pageSize?: 20 | 50 | 100 },
): Promise<PaginatedResult<BillingUserSummary>> {
  const url = new URL(`${apiBaseUrl}/admin/billing/users`);

  if (options?.startAt) {
    url.searchParams.set('startAt', options.startAt);
  }

  if (options?.endAt) {
    url.searchParams.set('endAt', options.endAt);
  }

  if (options?.page) {
    url.searchParams.set('page', String(options.page));
  }

  if (options?.pageSize) {
    url.searchParams.set('pageSize', String(options.pageSize));
  }

  const response = await fetch(url, {
    headers: createAdminHeaders(token),
  });

  return readJson<PaginatedResult<BillingUserSummary>>(response);
}

export async function fetchBillingUserGroups(
  apiBaseUrl: string,
  token: string,
  options?: { userId?: string; startAt?: string; endAt?: string; page?: number; pageSize?: 20 | 50 | 100 },
): Promise<PaginatedResult<BillingLaunchGroup>> {
  const url = new URL(`${apiBaseUrl}/admin/billing/user-groups`);

  if (options?.userId) {
    url.searchParams.set('userId', options.userId);
  }

  if (options?.startAt) {
    url.searchParams.set('startAt', options.startAt);
  }

  if (options?.endAt) {
    url.searchParams.set('endAt', options.endAt);
  }

  if (options?.page) {
    url.searchParams.set('page', String(options.page));
  }

  if (options?.pageSize) {
    url.searchParams.set('pageSize', String(options.pageSize));
  }

  const response = await fetch(url, {
    headers: createAdminHeaders(token),
  });

  return readJson<PaginatedResult<BillingLaunchGroup>>(response);
}

export async function fetchPlatformBillingGroups(
  apiBaseUrl: string,
  token: string,
  options?: { startAt?: string; endAt?: string; page?: number; pageSize?: 20 | 50 | 100 },
): Promise<PaginatedResult<BillingLaunchGroup>> {
  const url = new URL(`${apiBaseUrl}/admin/billing/platform/groups`);

  if (options?.startAt) {
    url.searchParams.set('startAt', options.startAt);
  }

  if (options?.endAt) {
    url.searchParams.set('endAt', options.endAt);
  }

  if (options?.page) {
    url.searchParams.set('page', String(options.page));
  }

  if (options?.pageSize) {
    url.searchParams.set('pageSize', String(options.pageSize));
  }

  const response = await fetch(url, {
    headers: createAdminHeaders(token),
  });

  return readJson<PaginatedResult<BillingLaunchGroup>>(response);
}

export async function fetchBillingUserItems(
  apiBaseUrl: string,
  token: string,
  userId: string,
  options?: { startAt?: string; endAt?: string },
): Promise<BillingLineItem[]> {
  const url = new URL(`${apiBaseUrl}/admin/billing/users/${userId}/items`);

  if (options?.startAt) {
    url.searchParams.set('startAt', options.startAt);
  }

  if (options?.endAt) {
    url.searchParams.set('endAt', options.endAt);
  }

  const response = await fetch(url, {
    headers: createAdminHeaders(token),
  });

  return readJson<BillingLineItem[]>(response);
}

export async function fetchPlatformBillingItems(
  apiBaseUrl: string,
  token: string,
  options?: { startAt?: string; endAt?: string },
): Promise<BillingLineItem[]> {
  const url = new URL(`${apiBaseUrl}/admin/billing/platform/items`);

  if (options?.startAt) {
    url.searchParams.set('startAt', options.startAt);
  }

  if (options?.endAt) {
    url.searchParams.set('endAt', options.endAt);
  }

  const response = await fetch(url, {
    headers: createAdminHeaders(token),
  });

  return readJson<BillingLineItem[]>(response);
}

export async function fetchBillingAnomalies(
  apiBaseUrl: string,
  token: string,
  options?: { startAt?: string; endAt?: string },
): Promise<BillingAnomaly[]> {
  const url = new URL(`${apiBaseUrl}/admin/billing/anomalies`);

  if (options?.startAt) {
    url.searchParams.set('startAt', options.startAt);
  }

  if (options?.endAt) {
    url.searchParams.set('endAt', options.endAt);
  }

  const response = await fetch(url, {
    headers: createAdminHeaders(token),
  });

  return readJson<BillingAnomaly[]>(response);
}

export async function triggerBillingSync(
  apiBaseUrl: string,
  token: string,
  options?: { startAt?: string; endAt?: string },
) {
  const response = await fetch(`${apiBaseUrl}/admin/billing/sync`, {
    method: 'POST',
    headers: createAdminHeaders(token),
    body: JSON.stringify(options ?? {}),
  });

  return readJson<{
    syncInProgress?: boolean;
    deferredDates?: string[];
    syncedDays: number;
    importedLineItems: number;
    anomalyCount: number;
    deferredCount: number;
  }>(response);
}

export async function exportPlatformBillingCsv(
  apiBaseUrl: string,
  token: string,
  options?: { startAt?: string; endAt?: string },
) {
  const url = new URL(`${apiBaseUrl}/admin/billing/export/platform.csv`);

  if (options?.startAt) {
    url.searchParams.set('startAt', options.startAt);
  }

  if (options?.endAt) {
    url.searchParams.set('endAt', options.endAt);
  }

  const response = await fetch(url, {
    headers: createAdminHeaders(token),
  });

  return readText(response);
}

export async function exportBillingUsersCsv(
  apiBaseUrl: string,
  token: string,
  options?: { startAt?: string; endAt?: string },
) {
  const url = new URL(`${apiBaseUrl}/admin/billing/export/users.csv`);

  if (options?.startAt) {
    url.searchParams.set('startAt', options.startAt);
  }

  if (options?.endAt) {
    url.searchParams.set('endAt', options.endAt);
  }

  const response = await fetch(url, {
    headers: createAdminHeaders(token),
  });

  return readText(response);
}

export async function exportBillingUserItemsCsv(
  apiBaseUrl: string,
  token: string,
  userId: string,
  options?: { startAt?: string; endAt?: string },
) {
  const url = new URL(`${apiBaseUrl}/admin/billing/export/users/${userId}.csv`);

  if (options?.startAt) {
    url.searchParams.set('startAt', options.startAt);
  }

  if (options?.endAt) {
    url.searchParams.set('endAt', options.endAt);
  }

  const response = await fetch(url, {
    headers: createAdminHeaders(token),
  });

  return readText(response);
}

export async function saveCloudConfig(
  apiBaseUrl: string,
  token: string,
  payload: CloudConfigSnapshot,
): Promise<CloudConfigSnapshot> {
  const response = await fetch(`${apiBaseUrl}/admin/system-config`, {
    method: 'PATCH',
    headers: createAdminHeaders(token),
    body: JSON.stringify(payload),
  });

  return readJson<CloudConfigSnapshot>(response);
}

export async function fetchAdminUsers(apiBaseUrl: string, token: string): Promise<AdminUser[]> {
  const response = await fetch(`${apiBaseUrl}/admin/users`, {
    headers: createAdminHeaders(token),
  });

  return readJson<AdminUser[]>(response);
}

export async function createAdminUser(apiBaseUrl: string, token: string, payload: CreateAdminUserInput): Promise<AdminUser> {
  const response = await fetch(`${apiBaseUrl}/admin/users`, {
    method: 'POST',
    headers: createAdminHeaders(token),
    body: JSON.stringify(payload),
  });

  return readJson<AdminUser>(response);
}

export async function updateAdminUserRole(
  apiBaseUrl: string,
  token: string,
  id: string,
  payload: UpdateAdminUserRoleInput,
): Promise<AdminUser> {
  const response = await fetch(`${apiBaseUrl}/admin/users/${id}/role`, {
    method: 'PATCH',
    headers: createAdminHeaders(token),
    body: JSON.stringify(payload),
  });

  return readJson<AdminUser>(response);
}

export async function updateAdminUserStatus(
  apiBaseUrl: string,
  token: string,
  id: string,
  payload: UpdateAdminUserStatusInput,
): Promise<AdminUser> {
  const response = await fetch(`${apiBaseUrl}/admin/users/${id}/status`, {
    method: 'PATCH',
    headers: createAdminHeaders(token),
    body: JSON.stringify(payload),
  });

  return readJson<AdminUser>(response);
}

export async function resetAdminUserPassword(
  apiBaseUrl: string,
  token: string,
  id: string,
  payload: ResetAdminUserPasswordInput,
): Promise<AdminUser> {
  const response = await fetch(`${apiBaseUrl}/admin/users/${id}/reset-password`, {
    method: 'POST',
    headers: createAdminHeaders(token),
    body: JSON.stringify(payload),
  });

  return readJson<AdminUser>(response);
}

export async function fetchInstanceTypeAvailability(
  apiBaseUrl: string,
  token: string,
  cpu: number,
  memory: number,
): Promise<InstanceTypeAvailabilitySnapshot> {
  const searchParams = new URLSearchParams({
    cpu: String(cpu),
    memory: String(memory),
  });
  const response = await fetch(`${apiBaseUrl}/admin/system-config/instance-type-availability?${searchParams}`, {
    headers: createAdminHeaders(token),
  });

  return readJson<InstanceTypeAvailabilitySnapshot>(response);
}

export async function createRangeTemplate(
  apiBaseUrl: string,
  token: string,
  payload: ScenarioCreateInput,
) {
  const response = await fetch(`${apiBaseUrl}/admin/scenarios`, {
    method: 'POST',
    headers: createAdminHeaders(token),
    body: JSON.stringify(payload),
  });

  return readJson<Scenario>(response);
}

export async function cloneRangeTemplate(apiBaseUrl: string, token: string, id: string) {
  const response = await fetch(`${apiBaseUrl}/admin/scenarios/${id}/clone`, {
    method: 'POST',
    headers: createAdminHeaders(token),
  });

  return readJson<Scenario>(response);
}

export async function updateRangeTemplate(
  apiBaseUrl: string,
  token: string,
  id: string,
  payload: ScenarioUpdateInput,
) {
  const response = await fetch(`${apiBaseUrl}/admin/scenarios/${id}`, {
    method: 'PATCH',
    headers: createAdminHeaders(token),
    body: JSON.stringify(payload),
  });

  return readJson<Scenario>(response);
}

export async function shareRangeTemplate(
  apiBaseUrl: string,
  token: string,
  id: string,
  payload: { expectedRevision: number },
) {
  const response = await fetch(`${apiBaseUrl}/admin/scenarios/${id}/share`, {
    method: 'POST',
    headers: createAdminHeaders(token),
    body: JSON.stringify(payload),
  });

  return readJson<Scenario>(response);
}

export async function validateAndSaveRangeTemplate(
  apiBaseUrl: string,
  token: string,
  id: string,
  payload: import('./admin-types').RangeTemplateTopologySaveInput,
) {
  const response = await fetch(`${apiBaseUrl}/admin/scenarios/${id}/validate-and-save`, {
    method: 'POST',
    headers: createAdminHeaders(token),
    body: JSON.stringify(payload),
  });

  return readJson<Scenario>(response);
}

export async function unshareRangeTemplate(
  apiBaseUrl: string,
  token: string,
  id: string,
  payload: { expectedRevision: number },
) {
  const response = await fetch(`${apiBaseUrl}/admin/scenarios/${id}/unshare`, {
    method: 'POST',
    headers: createAdminHeaders(token),
    body: JSON.stringify(payload),
  });

  return readJson<Scenario>(response);
}

export async function deleteRangeTemplate(apiBaseUrl: string, token: string, id: string) {
  const response = await fetch(`${apiBaseUrl}/admin/scenarios/${id}`, {
    method: 'DELETE',
    headers: createAdminHeaders(token),
  });

  if (!response.ok) {
    let details: unknown;

    try {
      details = await response.json();
    } catch {
      details = null;
    }

    const message =
      details &&
      typeof details === 'object' &&
      'message' in details &&
      typeof (details as { message?: unknown }).message === 'string'
        ? (details as { message: string }).message
        : `Admin API request failed with status ${response.status}`;

      throw new AdminApiError(response.status, message, details);
  }
}

export async function fetchPublicImageCatalogScope(apiBaseUrl: string, token: string) {
  const response = await fetch(`${apiBaseUrl}/admin/image-catalog/public`, {
    headers: createAdminHeaders(token),
  });

  return readJson<ImageCatalogScopePayload>(response);
}

export async function fetchCustomImageCatalogScope(apiBaseUrl: string, token: string) {
  const response = await fetch(`${apiBaseUrl}/admin/image-catalog/custom`, {
    headers: createAdminHeaders(token),
  });

  return readJson<ImageCatalogScopePayload>(response);
}

export async function syncPublicImages(apiBaseUrl: string, token: string) {
  const response = await fetch(`${apiBaseUrl}/admin/image-catalog/public/sync`, {
    method: 'POST',
    headers: createAdminHeaders(token),
  });

  return readJson<ImageCatalogScopePayload>(response);
}

export async function syncCustomImages(apiBaseUrl: string, token: string) {
  const response = await fetch(`${apiBaseUrl}/admin/image-catalog/custom/sync`, {
    method: 'POST',
    headers: createAdminHeaders(token),
  });

  return readJson<ImageCatalogScopePayload>(response);
}

export async function collectImageCatalogItem(
  apiBaseUrl: string,
  token: string,
  payload: CollectImageCatalogItemInput,
) {
  const response = await fetch(`${apiBaseUrl}/admin/image-catalog/collect`, {
    method: 'POST',
    headers: createAdminHeaders(token),
    body: JSON.stringify(payload),
  });

  return readJson<ImageCatalogItem>(response);
}

export async function fetchPlatformImages(apiBaseUrl: string, token: string, view: PlatformImageView = 'platform') {
  const url = new URL(`${apiBaseUrl}/admin/platform-images`);
  url.searchParams.set('view', view);

  const response = await fetch(url, {
    headers: createAdminHeaders(token),
  });

  return readJson<PlatformImageAssetListPayload>(response);
}

export async function fetchPlatformImageTags(apiBaseUrl: string, token: string) {
  const response = await fetch(`${apiBaseUrl}/admin/platform-image-tags`, {
    headers: createAdminHeaders(token),
  });

  return readJson<PlatformImageTagListPayload>(response);
}

export async function createPlatformImageTag(apiBaseUrl: string, token: string, name: string) {
  const response = await fetch(`${apiBaseUrl}/admin/platform-image-tags`, {
    method: 'POST',
    headers: createAdminHeaders(token),
    body: JSON.stringify({ name }),
  });

  return readJson<PlatformImageTag>(response);
}

export async function deletePlatformImageTag(apiBaseUrl: string, token: string, id: string) {
  const response = await fetch(`${apiBaseUrl}/admin/platform-image-tags/${encodeURIComponent(id)}`, {
    method: 'DELETE', headers: createAdminHeaders(token),
  });
  return readJson<{ removed: boolean; platformImageTagId: string }>(response);
}

export async function setPlatformImageTags(apiBaseUrl: string, token: string, id: string, tagIds: string[]) {
  const response = await fetch(`${apiBaseUrl}/admin/platform-images/${encodeURIComponent(id)}/tags`, {
    method: 'PUT',
    headers: createAdminHeaders(token),
    body: JSON.stringify({ tagIds }),
  });

  return readJson<PlatformImageAsset>(response);
}

export async function fetchCloudAccountContexts(apiBaseUrl: string, token: string, includeInactive = false) {
  const response = await fetch(`${apiBaseUrl}/admin/cloud-contexts${includeInactive ? '?includeInactive=true' : ''}`, {
    headers: createAdminHeaders(token),
  });

  return readJson<CloudAccountContext[]>(response);
}

export async function saveTencentCloudAccount(apiBaseUrl: string, token: string, input: SaveTencentCloudAccountInput) {
  return readJson<CloudAccountContext>(await fetch(`${apiBaseUrl}/admin/cloud-contexts`, {
    method: 'POST', headers: createAdminHeaders(token), body: JSON.stringify(input),
  }));
}

export async function discoverTencentCloudRegions(apiBaseUrl: string, token: string, input: TencentCloudRegionsInput) {
  return readJson<TencentCloudRegionsPayload>(await fetch(`${apiBaseUrl}/admin/tencent-cloud/regions/query`, {
    method: 'POST', headers: createAdminHeaders(token), body: JSON.stringify(input),
  }));
}

export async function fetchTencentCloudImages(apiBaseUrl: string, token: string, input: TencentCloudImagesInput) {
  const params = new URLSearchParams({ scope: input.scope });
  if (input.offset !== undefined) params.set('offset', String(input.offset));
  if (input.limit !== undefined) params.set('limit', String(input.limit));
  return readJson<TencentCloudImagesPayload>(await fetch(`${apiBaseUrl}/admin/tencent-cloud/contexts/${encodeURIComponent(input.cloudAccountContextId)}/images?${params}`, { headers: createAdminHeaders(token) }));
}

export async function fetchImageImportJobs(apiBaseUrl: string, token: string) {
  const response = await fetch(`${apiBaseUrl}/admin/image-imports`, {
    headers: createAdminHeaders(token),
  });

  return readJson<{ items: ImageImportJob[] }>(response);
}

export async function createImageImport(apiBaseUrl: string, token: string, payload: CreateImageImportInput) {
  const response = await fetch(`${apiBaseUrl}/admin/image-imports`, {
    method: 'POST',
    headers: createAdminHeaders(token),
    body: JSON.stringify(payload),
  });

  return readJson<ImageImportUploadSession>(response);
}

export async function completeImageImport(apiBaseUrl: string, token: string, id: string, workspaceId?: string) {
  const response = await fetch(`${apiBaseUrl}/admin/image-imports/${encodeURIComponent(id)}/complete`, {
    method: 'POST',
    headers: createAdminHeaders(token, workspaceId ?? readCloudWorkspaceSelection()),
  });

  return readJson<ImageImportJob>(response);
}

export async function retryImageImport(apiBaseUrl: string, token: string, id: string) {
  const response = await fetch(`${apiBaseUrl}/admin/image-imports/${encodeURIComponent(id)}/retry`, {
    method: 'POST',
    headers: createAdminHeaders(token),
  });

  return readJson<ImageImportJob>(response);
}

export async function collectPlatformImage(
  apiBaseUrl: string,
  token: string,
  payload: CollectImageCatalogItemInput,
) {
  const response = await fetch(`${apiBaseUrl}/admin/platform-images`, {
    method: 'POST',
    headers: createAdminHeaders(token),
    body: JSON.stringify(payload),
  });

  return readJson<PlatformImageAsset>(response);
}

async function updatePlatformImage(
  apiBaseUrl: string,
  token: string,
  id: string,
  payload: { displayName?: string },
) {
  const response = await fetch(`${apiBaseUrl}/admin/platform-images/${id}`, {
    method: 'PATCH',
    headers: createAdminHeaders(token),
    body: JSON.stringify(payload),
  });

  return readJson<PlatformImageAsset>(response);
}

export async function renamePlatformImage(apiBaseUrl: string, token: string, id: string, displayName: string) {
  return updatePlatformImage(apiBaseUrl, token, id, { displayName });
}

export async function publishPlatformImage(apiBaseUrl: string, token: string, id: string) {
  const response = await fetch(`${apiBaseUrl}/admin/platform-images/${id}/publish`, {
    method: 'POST',
    headers: createAdminHeaders(token),
  });

  return readJson<PlatformImageAsset>(response);
}

export async function unpublishPlatformImage(apiBaseUrl: string, token: string, id: string) {
  const response = await fetch(`${apiBaseUrl}/admin/platform-images/${id}/unpublish`, {
    method: 'POST',
    headers: createAdminHeaders(token),
  });

  return readJson<PlatformImageAsset>(response);
}

export async function enablePlatformImage(apiBaseUrl: string, token: string, id: string) {
  const response = await fetch(`${apiBaseUrl}/admin/platform-images/${id}/enable`, {
    method: 'POST',
    headers: createAdminHeaders(token),
  });

  return readJson<PlatformImageAsset>(response);
}

export async function disablePlatformImage(apiBaseUrl: string, token: string, id: string) {
  const response = await fetch(`${apiBaseUrl}/admin/platform-images/${id}/disable`, {
    method: 'POST',
    headers: createAdminHeaders(token),
  });

  return readJson<PlatformImageAsset>(response);
}

export async function removePlatformImage(apiBaseUrl: string, token: string, id: string) {
  const response = await fetch(`${apiBaseUrl}/admin/platform-images/${id}`, {
    method: 'DELETE',
    headers: createAdminHeaders(token),
  });

  if (!response.ok) {
    let details: unknown;

    try {
      details = await response.json();
    } catch {
      details = null;
    }

    const message =
      details &&
      typeof details === 'object' &&
      'message' in details &&
      typeof (details as { message?: unknown }).message === 'string'
        ? (details as { message: string }).message
        : `Admin API request failed with status ${response.status}`;

    throw new AdminApiError(response.status, message, details);
  }
}

export async function deleteCustomImageSnapshot(apiBaseUrl: string, token: string, snapshotId: string, options: { deleteOwnedSnapshots: boolean } = { deleteOwnedSnapshots: false }) {
  const query = options.deleteOwnedSnapshots ? '?deleteOwnedSnapshots=true' : '';
  const response = await fetch(`${apiBaseUrl}/admin/image-catalog/custom/${snapshotId}${query}`, {
    method: 'DELETE',
    headers: createAdminHeaders(token),
  });

  if (!response.ok) {
    let details: unknown;

    try {
      details = await response.json();
    } catch {
      details = null;
    }

    const message =
      details &&
      typeof details === 'object' &&
      'message' in details &&
      typeof (details as { message?: unknown }).message === 'string'
        ? (details as { message: string }).message
        : `Admin API request failed with status ${response.status}`;

    throw new AdminApiError(response.status, message, details);
  }
  if (options.deleteOwnedSnapshots) {
    const result = await response.json() as { removed?: boolean; status?: string };
    if (result.removed !== true || result.status !== 'deleted') throw new AdminApiError(409, '镜像及快照回收尚未全部确认，请稍后继续回收。', result);
  }
}
