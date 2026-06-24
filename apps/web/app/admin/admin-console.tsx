'use client';

import { FormEvent, useEffect, useState } from 'react';

type Competition = {
  id: string;
  name: string;
  description?: string | null;
  status?: string;
};

type Team = {
  id: string;
  competitionId: string;
  name: string;
  contactName?: string | null;
  contactEmailOrPhone?: string | null;
};

type RangeTemplate = {
  id: string;
  name?: string;
  slug: string;
  version: string;
  modulePathOrRef?: string;
};

type RangeAccessEntry = {
  hostRole?: string | null;
  publicIp?: string | null;
  privateIp?: string | null;
  ssh?: string | null;
  url?: string | null;
};

type RangeResourceSummary = {
  mode?: string;
  vpcId?: string | null;
  topologySpec?: {
    vpcCidr?: string | null;
  } | null;
};

type RangeInstance = {
  id: string;
  status: string;
  teamId: string;
  allocatedCidr?: string | null;
  lastJobId?: string | null;
  errorSummary?: string | null;
};

type RangeInstanceDetail = RangeInstance & {
  competitionId: string;
  templateId: string;
  cloudProvider?: string;
  accessEntry?: RangeAccessEntry | null;
  resourceSummary?: RangeResourceSummary | null;
};

type ProvisionJob = {
  id: string;
  rangeInstanceId: string;
  jobType: string;
  status: string;
  triggeredBy: string;
  errorSummary?: string | null;
};

type ProvisionJobStep = {
  id: string;
  jobId: string;
  stepName: string;
  status: string;
  message?: string | null;
  stdoutExcerpt?: string | null;
  stderrExcerpt?: string | null;
};

type AdminConsoleProps = {
  apiBaseUrl?: string;
};

const ADMIN_TOKEN_STORAGE_KEY = 'aliyun-cyber-range-admin-token';
const DEFAULT_TEMPLATE_MODULE_PATH = 'infra/opentofu/modules/alicloud-enterprise-range';
const CREATEABLE_RANGE_STATUSES = ['draft', 'create_failed', 'destroyed'] as const;
const DESTROYABLE_RANGE_STATUSES = ['running', 'destroy_failed'] as const;

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

export function AdminConsole({ apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3001' }: AdminConsoleProps) {
  const [token, setToken] = useState<string | null>(null);
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [competitions, setCompetitions] = useState<Competition[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [rangeTemplates, setRangeTemplates] = useState<RangeTemplate[]>([]);
  const [rangeInstances, setRangeInstances] = useState<RangeInstance[]>([]);
  const [provisionJobs, setProvisionJobs] = useState<ProvisionJob[]>([]);
  const [selectedRangeInstanceId, setSelectedRangeInstanceId] = useState<string | null>(null);
  const [selectedRangeInstanceDetail, setSelectedRangeInstanceDetail] = useState<RangeInstanceDetail | null>(null);
  const [selectedRangeInstanceJob, setSelectedRangeInstanceJob] = useState<ProvisionJob | null>(null);
  const [selectedRangeInstanceSteps, setSelectedRangeInstanceSteps] = useState<ProvisionJobStep[]>([]);
  const [selectedProvisionJobId, setSelectedProvisionJobId] = useState<string | null>(null);
  const [selectedProvisionJob, setSelectedProvisionJob] = useState<ProvisionJob | null>(null);
  const [selectedProvisionJobSteps, setSelectedProvisionJobSteps] = useState<ProvisionJobStep[]>([]);
  const [isLoadingRangeInstanceDetail, setIsLoadingRangeInstanceDetail] = useState(false);
  const [isLoadingProvisionJobDetail, setIsLoadingProvisionJobDetail] = useState(false);
  const [pendingRangeActionInstanceId, setPendingRangeActionInstanceId] = useState<string | null>(null);
  const [editingCompetitionId, setEditingCompetitionId] = useState<string | null>(null);
  const [editingTeamId, setEditingTeamId] = useState<string | null>(null);
  const [editingTemplateId, setEditingTemplateId] = useState<string | null>(null);

  const [competitionForm, setCompetitionForm] = useState({
    name: '',
    description: '',
    status: 'scheduled',
  });
  const [teamForm, setTeamForm] = useState({
    competitionId: '',
    name: '',
    contactName: '',
    contactEmailOrPhone: '',
  });
  const [templateForm, setTemplateForm] = useState({
    name: '',
    slug: '',
    version: 'v1',
    modulePathOrRef: DEFAULT_TEMPLATE_MODULE_PATH,
  });

  async function loadResources(activeToken: string) {
    const headers = {
      Authorization: `Bearer ${activeToken}`,
    };

    const [competitionsResponse, teamsResponse, templatesResponse, instancesResponse, jobsResponse] = await Promise.all([
      fetch(`${apiBaseUrl}/admin/competitions`, { headers }),
      fetch(`${apiBaseUrl}/admin/teams`, { headers }),
      fetch(`${apiBaseUrl}/admin/range-templates`, { headers }),
      fetch(`${apiBaseUrl}/admin/range-instances`, { headers }),
      fetch(`${apiBaseUrl}/admin/provision-jobs`, { headers }),
    ]);

    setCompetitions(await readJson<Competition[]>(competitionsResponse));
    setTeams(await readJson<Team[]>(teamsResponse));
    setRangeTemplates(await readJson<RangeTemplate[]>(templatesResponse));
    const nextRangeInstances = await readJson<RangeInstance[]>(instancesResponse);
    const nextProvisionJobs = await readJson<ProvisionJob[]>(jobsResponse);

    setRangeInstances(nextRangeInstances);
    setProvisionJobs(nextProvisionJobs);
    if (
      selectedRangeInstanceId &&
      !nextRangeInstances.some((instance) => instance.id === selectedRangeInstanceId)
    ) {
      setSelectedRangeInstanceId(null);
      setSelectedRangeInstanceDetail(null);
      setSelectedRangeInstanceJob(null);
      setSelectedRangeInstanceSteps([]);
    }
    if (
      selectedProvisionJobId &&
      !nextProvisionJobs.some((job) => job.id === selectedProvisionJobId)
    ) {
      setSelectedProvisionJobId(null);
      setSelectedProvisionJob(null);
      setSelectedProvisionJobSteps([]);
    }
  }

  async function loadProvisionJobDetail(jobId: string) {
    if (!token) {
      return null;
    }

    setIsLoadingProvisionJobDetail(true);
    setErrorMessage(null);
    setSelectedProvisionJobId(jobId);

    try {
      const headers = {
        Authorization: `Bearer ${token}`,
      };
      const [jobResponse, stepResponse] = await Promise.all([
        fetch(`${apiBaseUrl}/admin/provision-jobs/${jobId}`, {
          headers,
        }),
        fetch(`${apiBaseUrl}/admin/provision-jobs/${jobId}/steps`, {
          headers,
        }),
      ]);

      if (!jobResponse.ok || !stepResponse.ok) {
        setErrorMessage('Failed to load provision job detail.');
        setSelectedProvisionJob(null);
        setSelectedProvisionJobSteps([]);
        return null;
      }

      const job = await readJson<ProvisionJob>(jobResponse);
      const steps = await readJson<ProvisionJobStep[]>(stepResponse);

      setSelectedProvisionJob(job);
      setSelectedProvisionJobSteps(steps);

      return {
        job,
        steps,
      };
    } catch {
      setErrorMessage('Failed to load provision job detail.');
      setSelectedProvisionJob(null);
      setSelectedProvisionJobSteps([]);
      return null;
    } finally {
      setIsLoadingProvisionJobDetail(false);
    }
  }

  function getRangeAction(instance: RangeInstance) {
    if (CREATEABLE_RANGE_STATUSES.includes(instance.status as (typeof CREATEABLE_RANGE_STATUSES)[number])) {
      return {
        action: 'create' as const,
        label: 'Create Range',
      };
    }

    if (DESTROYABLE_RANGE_STATUSES.includes(instance.status as (typeof DESTROYABLE_RANGE_STATUSES)[number])) {
      return {
        action: 'destroy' as const,
        label: 'Destroy Range',
      };
    }

    return null;
  }

  async function triggerRangeAction(instance: RangeInstance, action: 'create' | 'destroy') {
    if (!token) {
      return;
    }

    setPendingRangeActionInstanceId(instance.id);
    setErrorMessage(null);

    try {
      const response = await fetch(`${apiBaseUrl}/admin/range-instances/${instance.id}/${action}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          triggeredBy: username || 'admin',
        }),
      });

      if (!response.ok) {
        setErrorMessage(`Failed to trigger range ${action} job.`);
        return;
      }

      const nextJob = await readJson<ProvisionJob>(response);

      setSelectedProvisionJobId(nextJob.id);
      setSelectedProvisionJob(nextJob);
      setSelectedProvisionJobSteps([]);

      await loadResources(token);

      if (selectedRangeInstanceId === instance.id) {
        await loadRangeInstanceDetail(instance.id);
      }
    } catch {
      setErrorMessage(`Failed to trigger range ${action} job.`);
    } finally {
      setPendingRangeActionInstanceId(null);
    }
  }

  useEffect(() => {
    const storedToken = window.localStorage.getItem(ADMIN_TOKEN_STORAGE_KEY);

    if (!storedToken) {
      return;
    }

    setToken(storedToken);
    void loadResources(storedToken).catch(() => {
      setErrorMessage('Failed to load admin resources.');
    });
  }, []);

  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSubmitting(true);
    setErrorMessage(null);

    try {
      const response = await fetch(`${apiBaseUrl}/admin/session`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          username,
          password,
        }),
      });

      if (!response.ok) {
        setErrorMessage('Invalid admin credentials.');
        return;
      }

      const session = await readJson<{ token: string }>(response);

      window.localStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, session.token);
      setToken(session.token);
      await loadResources(session.token);
      setPassword('');
    } catch {
      setErrorMessage('Failed to connect to the admin API.');
    } finally {
      setIsSubmitting(false);
    }
  }

  async function createCompetition(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!token) {
      return;
    }

    const response = await fetch(
      editingCompetitionId ? `${apiBaseUrl}/admin/competitions/${editingCompetitionId}` : `${apiBaseUrl}/admin/competitions`,
      {
        method: editingCompetitionId ? 'PATCH' : 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(competitionForm),
      },
    );

    if (!response.ok) {
      setErrorMessage('Failed to save competition.');
      return;
    }

    const savedCompetition = await readJson<Competition>(response);

    setCompetitions((previous) =>
      editingCompetitionId
        ? previous.map((competition) => (competition.id === editingCompetitionId ? savedCompetition : competition))
        : [savedCompetition, ...previous],
    );
    setEditingCompetitionId(null);
    setCompetitionForm({
      name: '',
      description: '',
      status: 'scheduled',
    });
  }

  async function createTeam(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!token) {
      return;
    }

    const response = await fetch(editingTeamId ? `${apiBaseUrl}/admin/teams/${editingTeamId}` : `${apiBaseUrl}/admin/teams`, {
      method: editingTeamId ? 'PATCH' : 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(teamForm),
    });

    if (!response.ok) {
      setErrorMessage('Failed to save team.');
      return;
    }

    const savedTeam = await readJson<Team>(response);

    setTeams((previous) =>
      editingTeamId ? previous.map((team) => (team.id === editingTeamId ? savedTeam : team)) : [savedTeam, ...previous],
    );
    setEditingTeamId(null);
    setTeamForm({
      competitionId: '',
      name: '',
      contactName: '',
      contactEmailOrPhone: '',
    });
  }

  async function createTemplate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!token) {
      return;
    }

    const response = await fetch(
      editingTemplateId ? `${apiBaseUrl}/admin/range-templates/${editingTemplateId}` : `${apiBaseUrl}/admin/range-templates`,
      {
        method: editingTemplateId ? 'PATCH' : 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
      body: JSON.stringify({
          ...templateForm,
          cloudProvider: 'alibaba_cloud',
          iacType: 'opentofu',
          variableSchema: {},
          outputSchema: {},
        }),
      },
    );

    if (!response.ok) {
      setErrorMessage('Failed to save template.');
      return;
    }

    const savedTemplate = await readJson<RangeTemplate>(response);

    setRangeTemplates((previous) =>
      editingTemplateId
        ? previous.map((template) => (template.id === editingTemplateId ? savedTemplate : template))
        : [savedTemplate, ...previous],
    );
    setEditingTemplateId(null);
    setTemplateForm({
      name: '',
      slug: '',
      version: 'v1',
      modulePathOrRef: DEFAULT_TEMPLATE_MODULE_PATH,
    });
  }

  function beginCompetitionEdit(competition: Competition) {
    setEditingCompetitionId(competition.id);
    setCompetitionForm({
      name: competition.name,
      description: competition.description ?? '',
      status: competition.status ?? 'scheduled',
    });
  }

  function beginTeamEdit(team: Team) {
    setEditingTeamId(team.id);
    setTeamForm({
      competitionId: team.competitionId,
      name: team.name,
      contactName: team.contactName ?? '',
      contactEmailOrPhone: team.contactEmailOrPhone ?? '',
    });
  }

  function beginTemplateEdit(template: RangeTemplate) {
    setEditingTemplateId(template.id);
    setTemplateForm({
      name: template.name ?? '',
      slug: template.slug,
      version: template.version,
      modulePathOrRef: template.modulePathOrRef ?? DEFAULT_TEMPLATE_MODULE_PATH,
    });
  }

  async function loadRangeInstanceDetail(instanceId: string) {
    if (!token) {
      return;
    }

    setIsLoadingRangeInstanceDetail(true);
    setErrorMessage(null);

    try {
      const headers = {
        Authorization: `Bearer ${token}`,
      };
      const detailResponse = await fetch(`${apiBaseUrl}/admin/range-instances/${instanceId}`, {
        headers,
      });

      if (!detailResponse.ok) {
        setErrorMessage('Failed to load range instance detail.');
        return;
      }

      const detail = await readJson<RangeInstanceDetail>(detailResponse);
      setSelectedRangeInstanceId(instanceId);
      setSelectedRangeInstanceDetail(detail);

      if (!detail.lastJobId) {
        setSelectedRangeInstanceJob(null);
        setSelectedRangeInstanceSteps([]);
        return;
      }

      const jobDetail = await loadProvisionJobDetail(detail.lastJobId);

      if (!jobDetail) {
        setSelectedRangeInstanceJob(null);
        setSelectedRangeInstanceSteps([]);
        return;
      }

      setSelectedRangeInstanceJob(jobDetail.job);
      setSelectedRangeInstanceSteps(jobDetail.steps);
    } catch {
      setErrorMessage('Failed to load range instance detail.');
    } finally {
      setIsLoadingRangeInstanceDetail(false);
    }
  }

  async function deleteCompetition(id: string) {
    if (!token) {
      return;
    }

    const response = await fetch(`${apiBaseUrl}/admin/competitions/${id}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      setErrorMessage('Failed to delete competition.');
      return;
    }

    setCompetitions((previous) => previous.filter((competition) => competition.id !== id));
  }

  async function deleteTeam(id: string) {
    if (!token) {
      return;
    }

    const response = await fetch(`${apiBaseUrl}/admin/teams/${id}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      setErrorMessage('Failed to delete team.');
      return;
    }

    setTeams((previous) => previous.filter((team) => team.id !== id));
  }

  async function deleteTemplate(id: string) {
    if (!token) {
      return;
    }

    const response = await fetch(`${apiBaseUrl}/admin/range-templates/${id}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      setErrorMessage('Failed to delete template.');
      return;
    }

    setRangeTemplates((previous) => previous.filter((template) => template.id !== id));
  }

  return (
    <main className="admin-shell">
      <section className="admin-hero">
        <p className="eyebrow">Alibaba Cloud Cyber Range</p>
        <h1>Admin Control Center</h1>
        <p className="admin-description">
          Manage competitions, teams, templates, and environment visibility from one operator-focused control surface.
        </p>
      </section>

      {errorMessage ? <p className="admin-error">{errorMessage}</p> : null}

      {!token ? (
        <section className="admin-panel admin-login-panel">
          <h2>Administrator Sign In</h2>
          <form className="admin-form" onSubmit={handleLogin}>
            <label>
              <span>Username</span>
              <input value={username} onChange={(event) => setUsername(event.target.value)} />
            </label>
            <label>
              <span>Password</span>
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
            <button disabled={isSubmitting} type="submit">
              {isSubmitting ? 'Signing in...' : 'Sign In'}
            </button>
          </form>
        </section>
      ) : (
        <div className="admin-grid">
          <section className="admin-panel">
            <div className="admin-section-header">
              <h2>Competitions</h2>
              <span>{competitions.length} items</span>
            </div>
            <form className="admin-form" onSubmit={createCompetition}>
              <label>
                <span>Competition Name</span>
                <input
                  value={competitionForm.name}
                  onChange={(event) => setCompetitionForm((previous) => ({ ...previous, name: event.target.value }))}
                />
              </label>
              <label>
                <span>Description</span>
                <textarea
                  value={competitionForm.description}
                  onChange={(event) =>
                    setCompetitionForm((previous) => ({ ...previous, description: event.target.value }))
                  }
                />
              </label>
              <button type="submit">{editingCompetitionId ? 'Save Competition' : 'Create Competition'}</button>
            </form>
            <ul className="admin-list">
              {competitions.map((competition) => (
                <li key={competition.id}>
                  <div className="admin-list-copy">
                    <strong>{competition.name}</strong>
                    <span>{competition.status ?? 'draft'}</span>
                  </div>
                  <div className="admin-list-actions">
                    <button
                      aria-label={`Edit competition ${competition.name}`}
                      type="button"
                      onClick={() => beginCompetitionEdit(competition)}
                    >
                      Edit
                    </button>
                    <button
                      aria-label={`Delete competition ${competition.name}`}
                      type="button"
                      onClick={() => void deleteCompetition(competition.id)}
                    >
                      Delete
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </section>

          <section className="admin-panel">
            <div className="admin-section-header">
              <h2>Teams</h2>
              <span>{teams.length} items</span>
            </div>
            <form className="admin-form" onSubmit={createTeam}>
              <label>
                <span>Competition ID</span>
                <input
                  value={teamForm.competitionId}
                  onChange={(event) => setTeamForm((previous) => ({ ...previous, competitionId: event.target.value }))}
                />
              </label>
              <label>
                <span>Team Name</span>
                <input value={teamForm.name} onChange={(event) => setTeamForm((previous) => ({ ...previous, name: event.target.value }))} />
              </label>
              <label>
                <span>Contact Name</span>
                <input
                  value={teamForm.contactName}
                  onChange={(event) => setTeamForm((previous) => ({ ...previous, contactName: event.target.value }))}
                />
              </label>
              <label>
                <span>Contact</span>
                <input
                  value={teamForm.contactEmailOrPhone}
                  onChange={(event) =>
                    setTeamForm((previous) => ({ ...previous, contactEmailOrPhone: event.target.value }))
                  }
                />
              </label>
              <button type="submit">{editingTeamId ? 'Save Team' : 'Create Team'}</button>
            </form>
            <ul className="admin-list">
              {teams.map((team) => (
                <li key={team.id}>
                  <div className="admin-list-copy">
                    <strong>{team.name}</strong>
                    <span>{team.competitionId}</span>
                  </div>
                  <div className="admin-list-actions">
                    <button
                      aria-label={`Edit team ${team.name}`}
                      type="button"
                      onClick={() => beginTeamEdit(team)}
                    >
                      Edit
                    </button>
                    <button aria-label={`Delete team ${team.name}`} type="button" onClick={() => void deleteTeam(team.id)}>
                      Delete
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </section>

          <section className="admin-panel">
            <div className="admin-section-header">
              <h2>Range Templates</h2>
              <span>{rangeTemplates.length} items</span>
            </div>
            <form className="admin-form" onSubmit={createTemplate}>
              <label>
                <span>Template Name</span>
                <input
                  value={templateForm.name}
                  onChange={(event) => setTemplateForm((previous) => ({ ...previous, name: event.target.value }))}
                />
              </label>
              <label>
                <span>Slug</span>
                <input
                  value={templateForm.slug}
                  onChange={(event) => setTemplateForm((previous) => ({ ...previous, slug: event.target.value }))}
                />
              </label>
              <label>
                <span>Template Version</span>
                <input
                  value={templateForm.version}
                  onChange={(event) => setTemplateForm((previous) => ({ ...previous, version: event.target.value }))}
                />
              </label>
              <label>
                <span>Module Path</span>
                <input
                  value={templateForm.modulePathOrRef}
                  onChange={(event) =>
                    setTemplateForm((previous) => ({ ...previous, modulePathOrRef: event.target.value }))
                  }
                />
              </label>
              <button type="submit">{editingTemplateId ? 'Save Template' : 'Create Template'}</button>
            </form>
            <ul className="admin-list">
              {rangeTemplates.map((template) => (
                <li key={template.id}>
                  <div className="admin-list-copy">
                    <strong>{template.slug}</strong>
                    <span>{template.version}</span>
                  </div>
                  <div className="admin-list-actions">
                    <button
                      aria-label={`Edit template ${template.slug}`}
                      type="button"
                      onClick={() => beginTemplateEdit(template)}
                    >
                      Edit
                    </button>
                    <button
                      aria-label={`Delete template ${template.slug}`}
                      type="button"
                      onClick={() => void deleteTemplate(template.id)}
                    >
                      Delete
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </section>

          <section className="admin-panel">
            <div className="admin-section-header">
              <h2>Range Instances</h2>
              <span>{rangeInstances.length} items</span>
            </div>
            {rangeInstances.length === 0 ? (
              <p className="admin-empty">No range instances yet.</p>
            ) : (
              <ul className="admin-list">
                {rangeInstances.map((instance) => (
                  <li key={instance.id}>
                    <div className="admin-list-copy">
                      <strong>{instance.id}</strong>
                      <span>{instance.teamId}</span>
                      <span>{instance.status}</span>
                      {instance.errorSummary ? <span>{instance.errorSummary}</span> : null}
                    </div>
                    <div className="admin-list-actions">
                      {getRangeAction(instance) ? (
                        <button
                          aria-label={`${getRangeAction(instance)?.label} ${instance.id}`}
                          disabled={pendingRangeActionInstanceId === instance.id}
                          type="button"
                          onClick={() => {
                            const rangeAction = getRangeAction(instance);

                            if (!rangeAction) {
                              return;
                            }

                            void triggerRangeAction(instance, rangeAction.action);
                          }}
                        >
                          {pendingRangeActionInstanceId === instance.id
                            ? `${getRangeAction(instance)?.label.split(' ')[0]}ing...`
                            : getRangeAction(instance)?.label}
                        </button>
                      ) : null}
                      <button
                        aria-label={`View details for range instance ${instance.id}`}
                        type="button"
                        onClick={() => void loadRangeInstanceDetail(instance.id)}
                      >
                        {selectedRangeInstanceId === instance.id ? 'Refresh Details' : 'View Details'}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="admin-panel">
            <div className="admin-section-header">
              <h2>Provision Jobs</h2>
              <span>{provisionJobs.length} items</span>
            </div>
            {provisionJobs.length === 0 ? (
              <p className="admin-empty">No provision jobs yet.</p>
            ) : (
              <ul className="admin-list">
                {provisionJobs.map((job) => (
                  <li key={job.id}>
                    <div className="admin-list-copy">
                      <strong>{job.id}</strong>
                      <span>{job.rangeInstanceId}</span>
                      <span>{job.jobType}</span>
                      <span>{job.status}</span>
                      {job.errorSummary ? <span>{job.errorSummary}</span> : null}
                    </div>
                    <div className="admin-list-actions">
                      <button
                        aria-label={`View provision job ${job.id}`}
                        type="button"
                        onClick={() => void loadProvisionJobDetail(job.id)}
                      >
                        {selectedProvisionJobId === job.id ? 'Refresh Job' : 'View Job'}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {selectedRangeInstanceDetail ? (
            <section className="admin-panel admin-panel-wide">
              <div className="admin-section-header">
                <h2>Range Instance Detail</h2>
                <span>{selectedRangeInstanceDetail.id}</span>
              </div>
              {getRangeAction(selectedRangeInstanceDetail) ? (
                <div className="admin-inline-actions">
                  <button
                    aria-label={`${getRangeAction(selectedRangeInstanceDetail)?.label} ${selectedRangeInstanceDetail.id}`}
                    disabled={pendingRangeActionInstanceId === selectedRangeInstanceDetail.id}
                    type="button"
                    onClick={() => {
                      const rangeAction = getRangeAction(selectedRangeInstanceDetail);

                      if (!rangeAction) {
                        return;
                      }

                      void triggerRangeAction(selectedRangeInstanceDetail, rangeAction.action);
                    }}
                  >
                    {pendingRangeActionInstanceId === selectedRangeInstanceDetail.id
                      ? `${getRangeAction(selectedRangeInstanceDetail)?.label.split(' ')[0]}ing...`
                      : getRangeAction(selectedRangeInstanceDetail)?.label}
                  </button>
                </div>
              ) : null}
              {isLoadingRangeInstanceDetail ? (
                <p className="admin-empty">Loading range instance detail...</p>
              ) : (
                <div className="admin-detail-grid">
                  <div className="admin-detail-stack">
                    <div className="admin-metadata">
                      <h3>Instance Summary</h3>
                      <dl className="admin-key-value">
                        <div>
                          <dt>Status</dt>
                          <dd>{selectedRangeInstanceDetail.status}</dd>
                        </div>
                        <div>
                          <dt>Competition</dt>
                          <dd>{selectedRangeInstanceDetail.competitionId}</dd>
                        </div>
                        <div>
                          <dt>Team</dt>
                          <dd>{selectedRangeInstanceDetail.teamId}</dd>
                        </div>
                        <div>
                          <dt>Template</dt>
                          <dd>{selectedRangeInstanceDetail.templateId}</dd>
                        </div>
                        <div>
                          <dt>Allocated CIDR</dt>
                          <dd>{selectedRangeInstanceDetail.allocatedCidr ?? 'Not assigned'}</dd>
                        </div>
                        <div>
                          <dt>Error Summary</dt>
                          <dd>{selectedRangeInstanceDetail.errorSummary ?? 'No failure recorded'}</dd>
                        </div>
                      </dl>
                    </div>

                    <div className="admin-metadata">
                      <h3>Access Entry</h3>
                      <dl className="admin-key-value">
                        <div>
                          <dt>Host Role</dt>
                          <dd>{selectedRangeInstanceDetail.accessEntry?.hostRole ?? 'N/A'}</dd>
                        </div>
                        <div>
                          <dt>Public IP</dt>
                          <dd>{selectedRangeInstanceDetail.accessEntry?.publicIp ?? 'N/A'}</dd>
                        </div>
                        <div>
                          <dt>Private IP</dt>
                          <dd>{selectedRangeInstanceDetail.accessEntry?.privateIp ?? 'N/A'}</dd>
                        </div>
                        <div>
                          <dt>SSH</dt>
                          <dd>{selectedRangeInstanceDetail.accessEntry?.ssh ?? 'N/A'}</dd>
                        </div>
                        <div>
                          <dt>URL</dt>
                          <dd>{selectedRangeInstanceDetail.accessEntry?.url ?? 'N/A'}</dd>
                        </div>
                      </dl>
                    </div>
                  </div>

                  <div className="admin-detail-stack">
                    <div className="admin-metadata">
                      <h3>Resource Summary</h3>
                      <dl className="admin-key-value">
                        <div>
                          <dt>Provisioner Mode</dt>
                          <dd>{selectedRangeInstanceDetail.resourceSummary?.mode ?? 'N/A'}</dd>
                        </div>
                        <div>
                          <dt>VPC ID</dt>
                          <dd>{selectedRangeInstanceDetail.resourceSummary?.vpcId ?? 'N/A'}</dd>
                        </div>
                        <div>
                          <dt>VPC CIDR</dt>
                          <dd>{selectedRangeInstanceDetail.resourceSummary?.topologySpec?.vpcCidr ?? 'N/A'}</dd>
                        </div>
                      </dl>
                    </div>

                    <div className="admin-metadata">
                      <h3>Last Provision Job</h3>
                      {selectedRangeInstanceJob ? (
                        <dl className="admin-key-value">
                          <div>
                            <dt>Job Type</dt>
                            <dd>{selectedRangeInstanceJob.jobType}</dd>
                          </div>
                          <div>
                            <dt>Status</dt>
                            <dd>{selectedRangeInstanceJob.status}</dd>
                          </div>
                          <div>
                            <dt>Triggered By</dt>
                            <dd>{selectedRangeInstanceJob.triggeredBy}</dd>
                          </div>
                          <div>
                            <dt>Error Summary</dt>
                            <dd>{selectedRangeInstanceJob.errorSummary ?? 'No failure recorded'}</dd>
                          </div>
                        </dl>
                      ) : (
                        <p className="admin-empty">No provision job detail available.</p>
                      )}
                    </div>

                    <div className="admin-metadata">
                      <h3>Step Logs</h3>
                      {selectedRangeInstanceSteps.length === 0 ? (
                        <p className="admin-empty">No step logs recorded yet.</p>
                      ) : (
                        <ul className="admin-step-list">
                          {selectedRangeInstanceSteps.map((step) => (
                            <li key={step.id}>
                              <div className="admin-section-header">
                                <strong>{step.stepName}</strong>
                                <span>{step.status}</span>
                              </div>
                              {step.message ? <p>{step.message}</p> : null}
                              {step.stdoutExcerpt ? <code>{step.stdoutExcerpt}</code> : null}
                              {step.stderrExcerpt ? <code>{step.stderrExcerpt}</code> : null}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </section>
          ) : null}

          {selectedProvisionJobId ? (
            <section className="admin-panel admin-panel-wide">
              <div className="admin-section-header">
                <h2>Provision Job Detail</h2>
                <span>{selectedProvisionJobId}</span>
              </div>
              {isLoadingProvisionJobDetail ? (
                <p className="admin-empty">Loading provision job detail...</p>
              ) : selectedProvisionJob ? (
                <div className="admin-detail-grid">
                  <div className="admin-metadata">
                    <h3>Job Summary</h3>
                    <dl className="admin-key-value">
                      <div>
                        <dt>Range Instance</dt>
                        <dd>{selectedProvisionJob.rangeInstanceId}</dd>
                      </div>
                      <div>
                        <dt>Job Type</dt>
                        <dd>{selectedProvisionJob.jobType}</dd>
                      </div>
                      <div>
                        <dt>Status</dt>
                        <dd>{selectedProvisionJob.status}</dd>
                      </div>
                      <div>
                        <dt>Triggered By</dt>
                        <dd>{selectedProvisionJob.triggeredBy}</dd>
                      </div>
                      <div>
                        <dt>Error Summary</dt>
                        <dd>{selectedProvisionJob.errorSummary ?? 'No failure recorded'}</dd>
                      </div>
                    </dl>
                  </div>

                  <div className="admin-metadata">
                    <h3>Step Logs</h3>
                    {selectedProvisionJobSteps.length === 0 ? (
                      <p className="admin-empty">No step logs recorded yet.</p>
                    ) : (
                      <ul className="admin-step-list">
                        {selectedProvisionJobSteps.map((step) => (
                          <li key={step.id}>
                            <div className="admin-section-header">
                              <strong>{step.stepName}</strong>
                              <span>{step.status}</span>
                            </div>
                            {step.message ? <p>{step.message}</p> : null}
                            {step.stdoutExcerpt ? <code>{step.stdoutExcerpt}</code> : null}
                            {step.stderrExcerpt ? <code>{step.stderrExcerpt}</code> : null}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              ) : (
                <p className="admin-empty">No provision job detail available.</p>
              )}
            </section>
          ) : null}
        </div>
      )}
    </main>
  );
}
