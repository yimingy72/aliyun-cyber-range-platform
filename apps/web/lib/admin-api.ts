import type {
  AdminBootstrapData,
  CloudConfigSnapshot,
  Competition,
  CompetitionInput,
  ProvisionJob,
  ProvisionJobStep,
  RangeInstanceCreateInput,
  RangeInstance,
  RangeInstanceDetail,
  RangeTemplate,
  RangeTemplateCreateInput,
  RangeTemplateUpdateInput,
  Team,
  TeamInput,
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

export async function createRangeInstance(
  apiBaseUrl: string,
  token: string,
  payload: RangeInstanceCreateInput,
) {
  const response = await fetch(`${apiBaseUrl}/admin/range-instances`, {
    method: 'POST',
    headers: createAdminHeaders(token),
    body: JSON.stringify(payload),
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

export async function createCompetition(apiBaseUrl: string, token: string, payload: CompetitionInput) {
  const response = await fetch(`${apiBaseUrl}/admin/competitions`, {
    method: 'POST',
    headers: createAdminHeaders(token),
    body: JSON.stringify(payload),
  });

  return readJson<Competition>(response);
}

export async function updateCompetition(apiBaseUrl: string, token: string, id: string, payload: CompetitionInput) {
  const response = await fetch(`${apiBaseUrl}/admin/competitions/${id}`, {
    method: 'PATCH',
    headers: createAdminHeaders(token),
    body: JSON.stringify(payload),
  });

  return readJson<Competition>(response);
}

export async function deleteCompetition(apiBaseUrl: string, token: string, id: string) {
  const response = await fetch(`${apiBaseUrl}/admin/competitions/${id}`, {
    method: 'DELETE',
    headers: createAdminHeaders(token),
  });

  if (!response.ok) {
    throw new AdminApiError(response.status);
  }
}

export async function createTeam(apiBaseUrl: string, token: string, payload: TeamInput) {
  const response = await fetch(`${apiBaseUrl}/admin/teams`, {
    method: 'POST',
    headers: createAdminHeaders(token),
    body: JSON.stringify(payload),
  });

  return readJson<Team>(response);
}

export async function updateTeam(apiBaseUrl: string, token: string, id: string, payload: TeamInput) {
  const response = await fetch(`${apiBaseUrl}/admin/teams/${id}`, {
    method: 'PATCH',
    headers: createAdminHeaders(token),
    body: JSON.stringify(payload),
  });

  return readJson<Team>(response);
}

export async function deleteTeam(apiBaseUrl: string, token: string, id: string) {
  const response = await fetch(`${apiBaseUrl}/admin/teams/${id}`, {
    method: 'DELETE',
    headers: createAdminHeaders(token),
  });

  if (!response.ok) {
    throw new AdminApiError(response.status);
  }
}

export async function createRangeTemplate(
  apiBaseUrl: string,
  token: string,
  payload: RangeTemplateCreateInput,
) {
  const response = await fetch(`${apiBaseUrl}/admin/range-templates`, {
    method: 'POST',
    headers: createAdminHeaders(token),
    body: JSON.stringify(payload),
  });

  return readJson<RangeTemplate>(response);
}

export async function updateRangeTemplate(
  apiBaseUrl: string,
  token: string,
  id: string,
  payload: RangeTemplateUpdateInput,
) {
  const response = await fetch(`${apiBaseUrl}/admin/range-templates/${id}`, {
    method: 'PATCH',
    headers: createAdminHeaders(token),
    body: JSON.stringify(payload),
  });

  return readJson<RangeTemplate>(response);
}

export async function deleteRangeTemplate(apiBaseUrl: string, token: string, id: string) {
  const response = await fetch(`${apiBaseUrl}/admin/range-templates/${id}`, {
    method: 'DELETE',
    headers: createAdminHeaders(token),
  });

  if (!response.ok) {
    throw new AdminApiError(response.status);
  }
}
