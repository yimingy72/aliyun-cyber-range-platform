import type {
  AdminBootstrapData,
  CloudConfigSnapshot,
  Competition,
  ProvisionJob,
  ProvisionJobStep,
  RangeInstance,
  RangeInstanceDetail,
  RangeTemplate,
  Team,
} from './admin-types';

export class AdminApiError extends Error {
  constructor(
    readonly status: number,
    message = `Admin API request failed with status ${status}`,
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
    throw new AdminApiError(response.status);
  }

  return (await response.json()) as T;
}

export async function fetchAdminBootstrap(apiBaseUrl: string, token: string): Promise<AdminBootstrapData> {
  const headers = createAdminHeaders(token);
  const [competitionsResponse, teamsResponse, templatesResponse, instancesResponse, jobsResponse] = await Promise.all([
    fetch(`${apiBaseUrl}/admin/competitions`, { headers }),
    fetch(`${apiBaseUrl}/admin/teams`, { headers }),
    fetch(`${apiBaseUrl}/admin/range-templates`, { headers }),
    fetch(`${apiBaseUrl}/admin/range-instances`, { headers }),
    fetch(`${apiBaseUrl}/admin/provision-jobs`, { headers }),
  ]);

  return {
    competitions: await readJson<Competition[]>(competitionsResponse),
    teams: await readJson<Team[]>(teamsResponse),
    rangeTemplates: await readJson<RangeTemplate[]>(templatesResponse),
    rangeInstances: await readJson<RangeInstance[]>(instancesResponse),
    provisionJobs: await readJson<ProvisionJob[]>(jobsResponse),
  };
}

export async function fetchRangeInstanceDetail(apiBaseUrl: string, token: string, id: string) {
  const response = await fetch(`${apiBaseUrl}/admin/range-instances/${id}`, {
    headers: createAdminHeaders(token),
  });

  return readJson<RangeInstanceDetail>(response);
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
  action: 'create' | 'destroy',
  triggeredBy: string,
) {
  const response = await fetch(`${apiBaseUrl}/admin/range-instances/${id}/${action}`, {
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
