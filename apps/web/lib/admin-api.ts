import type {
  AdminUser,
  AdminBootstrapData,
  CollectImageCatalogItemInput,
  CloudConfigSnapshot,
  CreateAdminUserInput,
  ImageCatalogItem,
  ImageCatalogScopePayload,
  InstanceTypeAvailabilitySnapshot,
  PlatformImageAsset,
  PlatformImageAssetListPayload,
  RangeInstanceNodeActionResult,
  ProvisionJob,
  ProvisionJobStep,
  RangeInstanceCreateInput,
  RangeInstanceLaunchInput,
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
  UpdateAdminUserRoleInput,
  UpdateAdminUserStatusInput,
} from './admin-types';

export type { AdminProfile, AdminSessionPayload } from './admin-types';

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

function createAdminHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
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

export async function fetchAdminBootstrap(apiBaseUrl: string, token: string): Promise<AdminBootstrapData> {
  const headers = createAdminHeaders(token);
  const [templatesResponse, instancesResponse, jobsResponse] = await Promise.all([
    fetch(`${apiBaseUrl}/admin/scenarios`, { headers }),
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

export async function fetchRangeInstanceDetail(apiBaseUrl: string, token: string, id: string) {
  const response = await fetch(`${apiBaseUrl}/admin/ranges/${id}`, {
    headers: createAdminHeaders(token),
  });

  return readJson<RangeInstanceDetail>(response);
}

export async function fetchSingleInstances(apiBaseUrl: string, token: string) {
  const response = await fetch(`${apiBaseUrl}/admin/instances`, {
    headers: createAdminHeaders(token),
  });

  return readJson<RangeInstance[] | SingleInstanceListPayload>(response);
}

export async function fetchProvisionJobs(apiBaseUrl: string, token: string) {
  const response = await fetch(`${apiBaseUrl}/admin/provision-jobs`, {
    headers: createAdminHeaders(token),
  });

  return readJson<ProvisionJob[]>(response);
}

export async function launchSingleInstances(
  apiBaseUrl: string,
  token: string,
  payload: SingleInstanceLaunchInput,
) {
  const response = await fetch(`${apiBaseUrl}/admin/instances/launch`, {
    method: 'POST',
    headers: createAdminHeaders(token),
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
  triggeredBy: string,
) {
  const response = await fetch(`${apiBaseUrl}/admin/instances/batches/${id}/destroy-all`, {
    method: 'POST',
    headers: createAdminHeaders(token),
    body: JSON.stringify({ triggeredBy }),
  });

  return readJson<{ batchId: string; jobCount: number }>(response);
}

export async function saveRangeInstanceDraft(
  apiBaseUrl: string,
  token: string,
  id: string,
  payload: {
    draftTopologyGraph: Record<string, unknown>;
    draftScenarioTemplateSpec: Record<string, unknown>;
    draftCompiledProvisionSpec: Record<string, unknown>;
    draftUpdatedBy: string;
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

export async function applyRangeInstanceDraft(apiBaseUrl: string, token: string, id: string, triggeredBy: string) {
  const response = await fetch(`${apiBaseUrl}/admin/ranges/${id}/apply`, {
    method: 'POST',
    headers: createAdminHeaders(token),
    body: JSON.stringify({ triggeredBy }),
  });

  return readJson<ProvisionJob>(response);
}

export async function syncRangeInstanceTemplate(apiBaseUrl: string, token: string, id: string, triggeredBy: string) {
  const response = await fetch(`${apiBaseUrl}/admin/ranges/${id}/sync-template`, {
    method: 'POST',
    headers: createAdminHeaders(token),
    body: JSON.stringify({ triggeredBy }),
  });

  return readJson<Scenario>(response);
}

export async function runRangeInstanceNodeAction(
  apiBaseUrl: string,
  token: string,
  rangeInstanceId: string,
  nodeId: string,
  action: 'start' | 'stop' | 'reboot' | 'open-vnc' | 'pack-image',
  payload: Record<string, string>,
) {
  const response = await fetch(`${apiBaseUrl}/admin/ranges/${rangeInstanceId}/nodes/${nodeId}/actions/${action}`, {
    method: 'POST',
    headers: createAdminHeaders(token),
    body: JSON.stringify(payload),
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
) {
  const response = await fetch(`${apiBaseUrl}/admin/ranges/launch`, {
    method: 'POST',
    headers: createAdminHeaders(token),
    body: JSON.stringify(payload),
  });

  return readJson<RangeInstance>(response);
}

export async function deleteRangeInstance(apiBaseUrl: string, token: string, id: string) {
  const response = await fetch(`${apiBaseUrl}/admin/ranges/${id}`, {
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
  triggeredBy: string,
) {
  const response = await fetch(`${apiBaseUrl}/admin/ranges/${id}/${action}`, {
    method: 'POST',
    headers: createAdminHeaders(token),
    body: JSON.stringify({ triggeredBy }),
  });

  return readJson<ProvisionJob>(response);
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

export async function publishRangeTemplate(apiBaseUrl: string, token: string, id: string) {
  const response = await fetch(`${apiBaseUrl}/admin/scenarios/${id}/publish`, {
    method: 'POST',
    headers: createAdminHeaders(token),
  });

  return readJson<Scenario>(response);
}

export async function validateRangeTemplate(apiBaseUrl: string, token: string, id: string) {
  const response = await fetch(`${apiBaseUrl}/admin/scenarios/${id}/validate`, {
    method: 'POST',
    headers: createAdminHeaders(token),
  });

  return readJson<{ valid: true }>(response);
}

export async function unpublishRangeTemplate(apiBaseUrl: string, token: string, id: string) {
  const response = await fetch(`${apiBaseUrl}/admin/scenarios/${id}/unpublish`, {
    method: 'POST',
    headers: createAdminHeaders(token),
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

export async function fetchPlatformImages(apiBaseUrl: string, token: string) {
  const response = await fetch(`${apiBaseUrl}/admin/platform-images`, {
    headers: createAdminHeaders(token),
  });

  return readJson<PlatformImageAssetListPayload>(response);
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

export async function renamePlatformImage(apiBaseUrl: string, token: string, id: string, displayName: string) {
  const response = await fetch(`${apiBaseUrl}/admin/platform-images/${id}`, {
    method: 'PATCH',
    headers: createAdminHeaders(token),
    body: JSON.stringify({ displayName }),
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

export async function deleteCustomImageSnapshot(apiBaseUrl: string, token: string, snapshotId: string) {
  const response = await fetch(`${apiBaseUrl}/admin/image-catalog/custom/${snapshotId}`, {
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
