'use client';

import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

import {
  AdminApiError,
  createRangeInstance,
  fetchAdminBootstrap,
  fetchProvisionJobDetail,
  fetchRangeInstanceDetail,
  triggerRangeAction,
} from '../../lib/admin-api';
import type {
  AdminBootstrapData,
  ProvisionJob,
  ProvisionJobStep,
  RangeInstance,
  RangeInstanceCreateInput,
  RangeInstanceDetail,
} from '../../lib/admin-types';
import { useAdminSession } from './use-admin-session';

type RangeInstancesScreenProps = {
  apiBaseUrl?: string;
  pollIntervalMs?: number;
};

type ExtendedRangeInstance = RangeInstance & {
  competitionId?: string | null;
  templateId?: string | null;
};

type ExtendedRangeInstanceDetail = RangeInstanceDetail & {
  allocatedCidr?: string | null;
};

type SelectedJobState = {
  job: ExtendedProvisionJob | null;
  steps: ExtendedProvisionJobStep[];
};

type ExtendedProvisionJob = ProvisionJob & {
  startedAt?: string | null;
  finishedAt?: string | null;
};

type ExtendedProvisionJobStep = ProvisionJobStep & {
  startedAt?: string | null;
  finishedAt?: string | null;
};

type FilterState = {
  competitionId: string;
  teamId: string;
  templateId: string;
  status: string;
  recoveryCategory: string;
};

type CreateInstanceFormState = {
  competitionId: string;
  teamId: string;
  templateId: string;
  expiresAt: string;
};

const TWO_COLUMN_LAYOUT = {
  display: 'grid',
  gap: '1.5rem',
  gridTemplateColumns: 'minmax(0, 1.35fr) minmax(22rem, 1fr)',
  alignItems: 'start',
} as const;

const FILTER_GRID = {
  display: 'grid',
  gap: '0.75rem',
  gridTemplateColumns: 'repeat(auto-fit, minmax(12rem, 1fr))',
} as const;

const EMPTY_CREATE_FORM: CreateInstanceFormState = {
  competitionId: '',
  teamId: '',
  templateId: '',
  expiresAt: '',
};

const ACTIVE_INSTANCE_STATUSES = new Set(['pending_create', 'creating', 'pending_destroy', 'destroying']);

function isUnauthorizedError(error: unknown) {
  return error instanceof AdminApiError && error.status === 401;
}

function getStatusLabel(status: string) {
  if (status === 'draft') {
    return '草稿';
  }

  if (status === 'pending_create') {
    return '待创建';
  }

  if (status === 'creating') {
    return '创建中';
  }

  if (status === 'running') {
    return '运行中';
  }

  if (status === 'create_failed') {
    return '创建失败';
  }

  if (status === 'pending_destroy') {
    return '待销毁';
  }

  if (status === 'destroying') {
    return '销毁中';
  }

  if (status === 'destroy_failed') {
    return '销毁失败';
  }

  if (status === 'destroyed') {
    return '已销毁';
  }

  if (status === 'pending') {
    return '处理中';
  }

  if (status === 'failed') {
    return '失败';
  }

  if (status === 'succeeded') {
    return '成功';
  }

  return status;
}

function formatDateTime(value?: string | null) {
  if (!value) {
    return '暂无';
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
    .format(date)
    .replace(/\//g, '-');
}

function getTemplateLabel(template: AdminBootstrapData['rangeTemplates'][number] | undefined) {
  if (!template) {
    return '未知模板';
  }

  return template.name?.trim() || template.slug;
}

function getActionLabels(instance: RangeInstance) {
  if (instance.status === 'draft' || instance.status === 'create_failed' || instance.status === 'destroyed') {
    return ['create'] as Array<'create' | 'destroy'>;
  }

  if (instance.status === 'running' || instance.status === 'destroy_failed') {
    return ['destroy'] as Array<'create' | 'destroy'>;
  }

  return [] as Array<'create' | 'destroy'>;
}

function getResolvedStepSummary(step: ExtendedProvisionJobStep) {
  return step.message ?? step.stderrExcerpt ?? step.stdoutExcerpt ?? step.status;
}

function getCurrentStage(steps: ExtendedProvisionJobStep[]) {
  const runningStep = steps.find((step) => step.status === 'running' || step.status === 'pending');

  if (runningStep) {
    return `${runningStep.stepName} / ${getStatusLabel(runningStep.status)}`;
  }

  const latestFinishedStep = [...steps]
    .reverse()
    .find((step) => step.status === 'succeeded' || step.status === 'failed');

  if (latestFinishedStep) {
    return `${latestFinishedStep.stepName} / ${getStatusLabel(latestFinishedStep.status)}`;
  }

  return '暂无';
}

function getLatestFailedStep(steps: ExtendedProvisionJobStep[]) {
  return [...steps].reverse().find((step) => step.status === 'failed') ?? null;
}

function getJobInsights(
  job: ExtendedProvisionJob | null,
  steps: ExtendedProvisionJobStep[],
  accessEntry: RangeInstance['accessEntry'] | null | undefined,
) {
  const insights = new Set<string>();

  if (job?.errorSummary) {
    insights.add(`失败原因：${job.errorSummary}`);
  }

  if (accessEntry?.publicIp) {
    insights.add(`公网入口：${accessEntry.publicIp}`);
  }

  for (const step of steps) {
    if (step.message) {
      insights.add(`步骤消息：${step.message}`);
    }

    const ipMatch = (step.stdoutExcerpt ?? step.stderrExcerpt ?? '').match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/);

    if (ipMatch) {
      insights.add(`日志 IP：${ipMatch[0]}`);
    }
  }

  return Array.from(insights).slice(0, 4);
}

function getRecoverySuggestions(job: ExtendedProvisionJob | null, steps: ExtendedProvisionJobStep[]) {
  const suggestions = new Set<string>();
  const combined = [job?.errorSummary, ...steps.flatMap((step) => [step.message, step.stderrExcerpt, step.stdoutExcerpt])]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  if (!combined) {
    return [] as string[];
  }

  if (
    combined.includes('no saleable ecs instance type') ||
    combined.includes('规格不可售') ||
    combined.includes('instance type')
  ) {
    suggestions.add('建议动作：切换可用区或调整实例规格偏好后重试。');
  }

  if (combined.includes('quota') || combined.includes('配额')) {
    suggestions.add('建议动作：检查 EIP、ECS 或 VPC 配额是否足够。');
  }

  if (combined.includes('missing required opentofu setting') || combined.includes('access key')) {
    suggestions.add('建议动作：检查阿里云凭证、区域和 Runner 环境变量配置。');
  }

  if (combined.includes('provider zip') || combined.includes('provider zip does not exist')) {
    suggestions.add('建议动作：检查阿里云 Provider 包路径与 Runner 挂载。');
  }

  if (combined.includes('topology') || combined.includes('blueprint')) {
    suggestions.add('建议动作：回到模板中心重新发布模板，确认蓝图编译产物完整。');
  }

  return Array.from(suggestions).slice(0, 3);
}

function getRecoveryCategoryLabel(category?: string | null) {
  if (category === 'capacity') {
    return '规格容量';
  }

  if (category === 'quota') {
    return '资源配额';
  }

  if (category === 'credentials') {
    return '云凭证配置';
  }

  if (category === 'provider_setup') {
    return 'Provider / Runner 配置';
  }

  if (category === 'template_blueprint') {
    return '模板蓝图';
  }

  return '未知';
}

function getActionButtonLabel(instance: RangeInstance, action: 'create' | 'destroy') {
  if (action === 'create') {
    return instance.status === 'create_failed' ? '重试创建' : '发起创建';
  }

  return instance.status === 'destroy_failed' ? '重试销毁' : '发起销毁';
}

function getActionTrigger(instance: RangeInstance, action: 'create' | 'destroy') {
  if (action === 'create' && instance.status === 'create_failed') {
    return 'retry' as const;
  }

  if (action === 'destroy' && instance.status === 'destroy_failed') {
    return 'retry' as const;
  }

  return action;
}

function normalizeExpiresAtInput(value: string) {
  if (!value) {
    return undefined;
  }

  const normalized = new Date(value);

  if (Number.isNaN(normalized.getTime())) {
    return undefined;
  }

  return normalized.toISOString();
}

export function RangeInstancesScreen({
  apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3001',
  pollIntervalMs = 2500,
}: RangeInstancesScreenProps) {
  const router = useRouter();
  const session = useAdminSession();
  const [snapshot, setSnapshot] = useState<AdminBootstrapData | null>(null);
  const [selectedDetail, setSelectedDetail] = useState<ExtendedRangeInstanceDetail | null>(null);
  const [selectedInstanceId, setSelectedInstanceId] = useState<string | null>(null);
  const [selectedJobState, setSelectedJobState] = useState<SelectedJobState>({ job: null, steps: [] });
  const [filters, setFilters] = useState<FilterState>({
    competitionId: 'all',
    teamId: 'all',
    templateId: 'all',
    status: 'all',
    recoveryCategory: 'all',
  });
  const [createForm, setCreateForm] = useState<CreateInstanceFormState>(EMPTY_CREATE_FORM);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);
  const [isCreatingInstance, setIsCreatingInstance] = useState(false);
  const [isSubmittingAction, setIsSubmittingAction] = useState<'create' | 'destroy' | null>(null);
  const detailRequestIdRef = useRef(0);

  useEffect(() => {
    if (!session.isReady) {
      return;
    }

    if (!session.token) {
      setSnapshot(null);
      setSelectedDetail(null);
      setSelectedInstanceId(null);
      setSelectedJobState({ job: null, steps: [] });
      setErrorMessage(null);
      setIsLoading(false);
      return;
    }

    const token = session.token;
    let isActive = true;

    setErrorMessage(null);
    setIsLoading(true);

    void (async () => {
      try {
        const payload = await fetchAdminBootstrap(apiBaseUrl, token);

        if (!isActive) {
          return;
        }

        setSnapshot(payload);
      } catch (error: unknown) {
        if (!isActive) {
          return;
        }

        if (isUnauthorizedError(error)) {
          session.logout();
          router.replace('/admin/login');
          return;
        }

        setErrorMessage('靶场实例加载失败，请刷新页面后重试。');
      } finally {
        if (!isActive) {
          return;
        }

        setIsLoading(false);
      }
    })();

    return () => {
      isActive = false;
    };
  }, [apiBaseUrl, router, session.isReady, session.token]);

  const competitionsById = useMemo(() => {
    return new Map((snapshot?.competitions ?? []).map((item) => [item.id, item]));
  }, [snapshot]);

  const competitions = snapshot?.competitions ?? [];
  const teams = snapshot?.teams ?? [];
  const rangeTemplates = snapshot?.rangeTemplates ?? [];

  const teamsById = useMemo(() => {
    return new Map(teams.map((item) => [item.id, item]));
  }, [teams]);

  const templatesById = useMemo(() => {
    return new Map(rangeTemplates.map((item) => [item.id, item]));
  }, [rangeTemplates]);

  const resolvedCreateCompetitionId = useMemo(() => {
    if (competitions.some((competition) => competition.id === createForm.competitionId)) {
      return createForm.competitionId;
    }

    return competitions[0]?.id ?? '';
  }, [competitions, createForm.competitionId]);

  const createTeams = useMemo(() => {
    if (!resolvedCreateCompetitionId) {
      return teams;
    }

    return teams.filter((team) => team.competitionId === resolvedCreateCompetitionId);
  }, [resolvedCreateCompetitionId, teams]);

  const publishedTemplates = useMemo(() => {
    return rangeTemplates.filter((template) => Boolean(template.currentPublishedVersionId));
  }, [rangeTemplates]);

  const resolvedCreateTeamId = useMemo(() => {
    if (createTeams.some((team) => team.id === createForm.teamId)) {
      return createForm.teamId;
    }

    return createTeams[0]?.id ?? '';
  }, [createForm.teamId, createTeams]);

  const resolvedCreateTemplateId = useMemo(() => {
    if (publishedTemplates.some((template) => template.id === createForm.templateId)) {
      return createForm.templateId;
    }

    return publishedTemplates[0]?.id ?? '';
  }, [createForm.templateId, publishedTemplates]);

  const jobsByInstanceId = useMemo(() => {
    const map = new Map<string, ExtendedProvisionJob>();

    for (const job of snapshot?.provisionJobs ?? []) {
      if (!map.has(job.rangeInstanceId)) {
        map.set(job.rangeInstanceId, job as ExtendedProvisionJob);
      }
    }

    return map;
  }, [snapshot]);

  const latestFailedStep = useMemo(() => {
    return getLatestFailedStep(selectedJobState.steps);
  }, [selectedJobState.steps]);

  const currentStage = useMemo(() => {
    return getCurrentStage(selectedJobState.steps);
  }, [selectedJobState.steps]);

  const selectedJobInsights = useMemo(() => {
    return getJobInsights(selectedJobState.job, selectedJobState.steps, selectedDetail?.accessEntry);
  }, [selectedDetail?.accessEntry, selectedJobState.job, selectedJobState.steps]);

  const recoverySuggestions = useMemo(() => {
    return getRecoverySuggestions(selectedJobState.job, selectedJobState.steps);
  }, [selectedJobState.job, selectedJobState.steps]);

  const visibleInstances = useMemo(() => {
    return ((snapshot?.rangeInstances ?? []) as ExtendedRangeInstance[]).filter((instance) => {
      if (filters.competitionId !== 'all' && (instance.competitionId ?? '') !== filters.competitionId) {
        return false;
      }

      if (filters.teamId !== 'all' && instance.teamId !== filters.teamId) {
        return false;
      }

      if (filters.templateId !== 'all' && (instance.templateId ?? '') !== filters.templateId) {
        return false;
      }

      if (filters.status !== 'all' && instance.status !== filters.status) {
        return false;
      }

      if (
        filters.recoveryCategory !== 'all' &&
        (instance.recoverySummary?.category ?? 'none') !== filters.recoveryCategory
      ) {
        return false;
      }

      return true;
    });
  }, [filters, snapshot]);

  const recoveryCategories = useMemo(() => {
    return Array.from(
      new Set(
        ((snapshot?.rangeInstances ?? []) as ExtendedRangeInstance[])
          .map((instance) => instance.recoverySummary?.category)
          .filter((value): value is string => Boolean(value)),
      ),
    );
  }, [snapshot]);

  function upsertInstanceInSnapshot(instance: ExtendedRangeInstanceDetail | ExtendedRangeInstance) {
    setSnapshot((current) => {
      if (!current) {
        return current;
      }

      const hasExisting = current.rangeInstances.some((item) => item.id === instance.id);

      return {
        ...current,
        rangeInstances: hasExisting
          ? current.rangeInstances.map((item) => (item.id === instance.id ? { ...item, ...instance } : item))
          : [instance, ...current.rangeInstances],
      };
    });
  }

  function upsertJobInSnapshot(job: ExtendedProvisionJob) {
    setSnapshot((current) => {
      if (!current) {
        return current;
      }

      return {
        ...current,
        provisionJobs: [job, ...current.provisionJobs.filter((item) => item.id !== job.id)],
      };
    });
  }

  async function refreshSelectedInstance(
    instanceId: string,
    options: {
      background?: boolean;
      requestId?: number;
      showLoading?: boolean;
    } = {},
  ) {
    if (!session.token) {
      return;
    }

    const requestId = options.requestId ?? detailRequestIdRef.current + 1;

    detailRequestIdRef.current = requestId;

    if (options.showLoading) {
      setIsLoadingDetail(true);
    }

    try {
      const detail = (await fetchRangeInstanceDetail(
        apiBaseUrl,
        session.token,
        instanceId,
      )) as ExtendedRangeInstanceDetail;

      if (detailRequestIdRef.current !== requestId) {
        return;
      }

      setSelectedDetail(detail);
      upsertInstanceInSnapshot(detail);

      if (!detail.lastJobId) {
        setSelectedJobState({ job: null, steps: [] });
        return;
      }

      const jobDetail = await fetchProvisionJobDetail(apiBaseUrl, session.token, detail.lastJobId);

      if (detailRequestIdRef.current !== requestId) {
        return;
      }

      const nextJob = jobDetail.job as ExtendedProvisionJob;
      const nextSteps = jobDetail.steps as ExtendedProvisionJobStep[];

      setSelectedJobState({
        job: nextJob,
        steps: nextSteps,
      });
      upsertJobInSnapshot(nextJob);
    } catch (error: unknown) {
      if (detailRequestIdRef.current !== requestId) {
        return;
      }

      if (isUnauthorizedError(error)) {
        session.logout();
        router.replace('/admin/login');
        return;
      }

      if (!options.background) {
        setErrorMessage('实例详情加载失败，请稍后重试。');
      }
    } finally {
      if (detailRequestIdRef.current === requestId && options.showLoading) {
        setIsLoadingDetail(false);
      }
    }
  }

  async function handleViewDetail(instanceId: string) {
    setSelectedInstanceId(instanceId);
    setSelectedDetail(null);
    setSelectedJobState({ job: null, steps: [] });
    setErrorMessage(null);
    await refreshSelectedInstance(instanceId, { showLoading: true });
  }

  async function handleCreateInstance(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!session.token) {
      return;
    }

    const payload: RangeInstanceCreateInput = {
      competitionId: resolvedCreateCompetitionId,
      teamId: resolvedCreateTeamId,
      templateId: resolvedCreateTemplateId,
      expiresAt: normalizeExpiresAtInput(createForm.expiresAt),
    };

    if (!payload.competitionId || !payload.teamId || !payload.templateId) {
      setErrorMessage('请先选择比赛、队伍和靶场模板。');
      return;
    }

    setErrorMessage(null);
    setIsCreatingInstance(true);

    try {
      const created = (await createRangeInstance(
        apiBaseUrl,
        session.token,
        payload,
      )) as ExtendedRangeInstanceDetail;
      const job = (await triggerRangeAction(
        apiBaseUrl,
        session.token,
        created.id,
        'create',
        'admin',
      )) as ExtendedProvisionJob;
      const pendingDetail: ExtendedRangeInstanceDetail = {
        ...created,
        status: 'pending_create',
        lastJobId: job.id,
      };

      upsertInstanceInSnapshot(pendingDetail);
      setSelectedInstanceId(created.id);
      setSelectedDetail(pendingDetail);
      setSelectedJobState({ job, steps: [] });
      setFilters((current) => ({
        ...current,
        competitionId: current.competitionId === 'all' ? current.competitionId : created.competitionId,
        teamId: current.teamId === 'all' ? current.teamId : created.teamId,
        templateId: current.templateId === 'all' ? current.templateId : created.templateId,
      }));
      setCreateForm((current) => ({
        ...current,
        expiresAt: '',
      }));

      void refreshSelectedInstance(created.id, { background: true });
    } catch (error: unknown) {
      if (isUnauthorizedError(error)) {
        session.logout();
        router.replace('/admin/login');
        return;
      }

      setErrorMessage('实例创建或启动失败，请检查比赛、队伍与模板发布状态后重试。');
    } finally {
      setIsCreatingInstance(false);
    }
  }

  async function handleTriggerAction(action: 'create' | 'destroy') {
    if (!session.token || !selectedDetail) {
      return;
    }

    setErrorMessage(null);
    setIsSubmittingAction(action);

    try {
      const trigger = getActionTrigger(selectedDetail, action);
      const job = (await triggerRangeAction(apiBaseUrl, session.token, selectedDetail.id, trigger, 'admin')) as ExtendedProvisionJob;
      const pendingStatus =
        action === 'destroy' || (trigger === 'retry' && selectedDetail.status === 'destroy_failed')
          ? 'pending_destroy'
          : 'pending_create';

      upsertInstanceInSnapshot({
        ...selectedDetail,
        status: pendingStatus,
        lastJobId: job.id,
      });
      setSelectedDetail((current) =>
        current
          ? {
              ...current,
              status: pendingStatus,
              lastJobId: job.id,
            }
          : current,
      );
      upsertJobInSnapshot(job);
      setSelectedJobState({
        job,
        steps: [],
      });
    } catch (error: unknown) {
      if (isUnauthorizedError(error)) {
        session.logout();
        router.replace('/admin/login');
        return;
      }

      setErrorMessage(
        action === 'create'
          ? '创建或恢复任务发起失败，请稍后重试。'
          : '销毁或恢复任务发起失败，请稍后重试。',
      );
    } finally {
      setIsSubmittingAction(null);
    }
  }

  useEffect(() => {
    if (!selectedDetail?.id || !selectedDetail.lastJobId || !ACTIVE_INSTANCE_STATUSES.has(selectedDetail.status)) {
      return;
    }

    const timer = window.setTimeout(() => {
      void refreshSelectedInstance(selectedDetail.id, { background: true });
    }, pollIntervalMs);

    return () => window.clearTimeout(timer);
  }, [apiBaseUrl, pollIntervalMs, refreshSelectedInstance, selectedDetail?.id, selectedDetail?.lastJobId, selectedDetail?.status]);

  if (!session.isReady) {
    return (
      <main className="admin-shell">
        <section className="admin-panel admin-login-panel">
          <h2>正在恢复管理员会话...</h2>
          <p className="admin-empty">请稍候，正在同步后台登录状态。</p>
        </section>
      </main>
    );
  }

  if (!session.token) {
    return (
      <main className="admin-shell">
        <section className="admin-panel admin-login-panel">
          <h2>正在跳转到管理员登录页...</h2>
          <p className="admin-empty">检测到当前没有有效的管理员会话。</p>
        </section>
      </main>
    );
  }

  if (isLoading && !snapshot) {
    return (
      <main className="admin-shell">
        <section className="admin-panel admin-login-panel">
          <h2>正在加载靶场实例...</h2>
          <p className="admin-empty">请稍候，正在拉取实例列表与最近任务摘要。</p>
        </section>
      </main>
    );
  }

  return (
    <div className="admin-screen">
      <section className="admin-hero">
        <p className="auth-eyebrow">后台二级页</p>
        <h1>靶场实例</h1>
        <p className="admin-description">在双栏工作页中联动查看实例列表、入口信息、资源摘要和最近任务步骤。</p>
      </section>

      {errorMessage ? <p className="admin-error">{errorMessage}</p> : null}

      <section className="admin-panel">
        <div className="admin-section-header">
          <h2>创建实例</h2>
          <span>按队伍分配独立靶场</span>
        </div>

        <form className="admin-form" onSubmit={(event) => void handleCreateInstance(event)}>
          <label>
            <span>所属比赛</span>
            <select
              aria-label="所属比赛"
              value={resolvedCreateCompetitionId}
              onChange={(event) =>
                setCreateForm((current) => ({
                  ...current,
                  competitionId: event.target.value,
                  teamId: '',
                }))
              }
              disabled={isCreatingInstance || !competitions.length}
            >
              {competitions.length ? (
                competitions.map((competition) => (
                  <option key={competition.id} value={competition.id}>
                    {competition.name}
                  </option>
                ))
              ) : (
                <option value="">暂无可选比赛</option>
              )}
            </select>
          </label>

          <label>
            <span>所属队伍</span>
            <select
              aria-label="所属队伍"
              value={resolvedCreateTeamId}
              onChange={(event) => setCreateForm((current) => ({ ...current, teamId: event.target.value }))}
              disabled={isCreatingInstance || !createTeams.length}
            >
              {createTeams.length ? (
                createTeams.map((team) => (
                  <option key={team.id} value={team.id}>
                    {team.name}
                  </option>
                ))
              ) : (
                <option value="">当前比赛下暂无队伍</option>
              )}
            </select>
          </label>

          <label>
            <span>靶场模板</span>
            <select
              aria-label="靶场模板"
              value={resolvedCreateTemplateId}
              onChange={(event) => setCreateForm((current) => ({ ...current, templateId: event.target.value }))}
              disabled={isCreatingInstance || !publishedTemplates.length}
            >
              {publishedTemplates.length ? (
                publishedTemplates.map((template) => (
                  <option key={template.id} value={template.id}>
                    {getTemplateLabel(template)}
                  </option>
                ))
              ) : (
                <option value="">暂无已发布模板</option>
              )}
            </select>
          </label>

          <label>
            <span>过期时间</span>
            <input
              aria-label="过期时间"
              type="datetime-local"
              value={createForm.expiresAt}
              onChange={(event) => setCreateForm((current) => ({ ...current, expiresAt: event.target.value }))}
              disabled={isCreatingInstance}
            />
          </label>

          <div className="admin-inline-actions">
            <button
              type="submit"
              disabled={
                  isCreatingInstance ||
                  !resolvedCreateCompetitionId ||
                  !resolvedCreateTeamId ||
                  !resolvedCreateTemplateId
                }
            >
              {isCreatingInstance ? '创建并启动中...' : '创建并启动'}
            </button>
          </div>
        </form>
      </section>

      <section className="admin-panel">
        <div className="admin-section-header">
          <h2>筛选条件</h2>
          <span>{visibleInstances.length} / {snapshot?.rangeInstances.length ?? 0}</span>
        </div>

        <div style={FILTER_GRID}>
          <label>
            <span>比赛筛选</span>
            <select
              aria-label="比赛筛选"
              value={filters.competitionId}
              onChange={(event) => setFilters((current) => ({ ...current, competitionId: event.target.value }))}
            >
              <option value="all">全部比赛</option>
              {(snapshot?.competitions ?? []).map((competition) => (
                <option key={competition.id} value={competition.id}>
                  {competition.name}
                </option>
              ))}
            </select>
          </label>

          <label>
            <span>队伍筛选</span>
            <select
              aria-label="队伍筛选"
              value={filters.teamId}
              onChange={(event) => setFilters((current) => ({ ...current, teamId: event.target.value }))}
            >
              <option value="all">全部队伍</option>
              {(snapshot?.teams ?? []).map((team) => (
                <option key={team.id} value={team.id}>
                  {team.name}
                </option>
              ))}
            </select>
          </label>

          <label>
            <span>模板筛选</span>
            <select
              aria-label="模板筛选"
              value={filters.templateId}
              onChange={(event) => setFilters((current) => ({ ...current, templateId: event.target.value }))}
            >
              <option value="all">全部模板</option>
              {(snapshot?.rangeTemplates ?? []).map((template) => (
                <option key={template.id} value={template.id}>
                  {getTemplateLabel(template)}
                </option>
              ))}
            </select>
          </label>

          <label>
            <span>实例状态筛选</span>
            <select
              aria-label="实例状态筛选"
              value={filters.status}
              onChange={(event) => setFilters((current) => ({ ...current, status: event.target.value }))}
            >
              <option value="all">全部状态</option>
              {Array.from(new Set((snapshot?.rangeInstances ?? []).map((instance) => instance.status))).map((status) => (
                <option key={status} value={status}>
                  {getStatusLabel(status)}
                </option>
              ))}
            </select>
          </label>

          <label>
            <span>恢复分类筛选</span>
            <select
              aria-label="恢复分类筛选"
              value={filters.recoveryCategory}
              onChange={(event) => setFilters((current) => ({ ...current, recoveryCategory: event.target.value }))}
            >
              <option value="all">全部分类</option>
              {recoveryCategories.map((category) => (
                <option key={category} value={category}>
                  {getRecoveryCategoryLabel(category)}
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>

      <section style={TWO_COLUMN_LAYOUT}>
        <article className="admin-panel">
          <div className="admin-section-header">
            <h2>实例列表</h2>
            <span>列表 + 摘要</span>
          </div>

          {visibleInstances.length ? (
            <ul className="admin-list">
              {visibleInstances.map((instance) => {
                const team = teamsById.get(instance.teamId);
                const competitionId = instance.competitionId ?? team?.competitionId ?? '';
                const competition = competitionsById.get(competitionId);
                const template = templatesById.get(instance.templateId ?? '');
                const recentJob = jobsByInstanceId.get(instance.id);

                return (
                  <li key={instance.id}>
                    <div className="admin-list-copy">
                      <strong>{instance.id}</strong>
                      <span>队伍：{team?.name ?? instance.teamId}</span>
                      <span>比赛：{competition?.name ?? competitionId ?? '暂无'}</span>
                      <span>模板：{getTemplateLabel(template)}</span>
                      <span>状态：{getStatusLabel(instance.status)}</span>
                      <span>恢复分类：{getRecoveryCategoryLabel(instance.recoverySummary?.category)}</span>
                      <span>
                        公网入口：{instance.accessEntry?.publicIp ?? instance.accessEntry?.url ?? '暂无'}
                      </span>
                      <span>最近任务：{recentJob ? getStatusLabel(recentJob.status) : '暂无'}</span>
                      <span>过期时间：{formatDateTime(instance.expiresAt)}</span>
                      <span>错误摘要：{instance.errorSummary ?? '无'}</span>
                    </div>
                    <div className="admin-list-actions">
                      <button type="button" onClick={() => void handleViewDetail(instance.id)}>
                        查看实例 {instance.id}
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="admin-empty">当前筛选条件下没有匹配的靶场实例。</p>
          )}
        </article>

        <article className="admin-panel">
          <div className="admin-section-header">
            <h2>实例详情</h2>
            <span>{selectedInstanceId ?? '未选择'}</span>
          </div>

          {isLoadingDetail ? (
            <p className="admin-empty">正在加载实例详情...</p>
          ) : selectedDetail ? (
            <>
              <div className="admin-list-copy">
                <strong>实例基础信息</strong>
                <span>实例 ID：{selectedDetail.id}</span>
                <span>状态：{getStatusLabel(selectedDetail.status)}</span>
                <span>比赛：{competitionsById.get(selectedDetail.competitionId)?.name ?? selectedDetail.competitionId}</span>
                <span>队伍：{teamsById.get(selectedDetail.teamId)?.name ?? selectedDetail.teamId}</span>
                <span>模板：{getTemplateLabel(templatesById.get(selectedDetail.templateId))}</span>
                <span>过期时间：{formatDateTime(selectedDetail.expiresAt)}</span>
                <span>分配网段：{selectedDetail.allocatedCidr ?? '暂无'}</span>
                <span>错误摘要：{selectedDetail.errorSummary ?? '无'}</span>
              </div>

              <div className="admin-list-copy" style={{ marginTop: '1rem' }}>
                <strong>公网入口详情</strong>
                <span>角色：{selectedDetail.accessEntry?.hostRole ?? '暂无'}</span>
                <span>公网 IP：{selectedDetail.accessEntry?.publicIp ?? '暂无'}</span>
                <span>私网 IP：{selectedDetail.accessEntry?.privateIp ?? '暂无'}</span>
                <span>SSH：{selectedDetail.accessEntry?.ssh ?? '暂无'}</span>
                <span>URL：{selectedDetail.accessEntry?.url ?? '暂无'}</span>
              </div>

              <div className="admin-list-copy" style={{ marginTop: '1rem' }}>
                <strong>资源摘要</strong>
                <span>模式：{selectedDetail.resourceSummary?.mode ?? '暂无'}</span>
                <span>VPC：{selectedDetail.resourceSummary?.vpcId ?? '暂无'}</span>
                <span>网段：{selectedDetail.resourceSummary?.topologySpec?.vpcCidr ?? '暂无'}</span>
              </div>

              <div className="admin-list-copy" style={{ marginTop: '1rem' }}>
                <strong>最近一次任务</strong>
                {selectedJobState.job ? (
                  <>
                    <span>任务 ID：{selectedJobState.job.id}</span>
                    <span>类型：{selectedJobState.job.jobType}</span>
                    <span>状态：{getStatusLabel(selectedJobState.job.status)}</span>
                    <span>当前阶段：{currentStage}</span>
                    <span>触发人：{selectedJobState.job.triggeredBy}</span>
                    <span>开始时间：{formatDateTime(selectedJobState.job.startedAt)}</span>
                    <span>结束时间：{formatDateTime(selectedJobState.job.finishedAt)}</span>
                    <span>失败摘要：{selectedJobState.job.errorSummary ?? '无'}</span>
                  </>
                ) : (
                  <span>暂无最近任务。</span>
                )}
              </div>

              <div className="admin-list-copy" style={{ marginTop: '1rem' }}>
                <strong>运行洞察</strong>
                {selectedJobInsights.length ? (
                  selectedJobInsights.map((insight) => <span key={insight}>{insight}</span>)
                ) : (
                  <span>暂无可解析洞察。</span>
                )}
              </div>

              <div className="admin-list-copy" style={{ marginTop: '1rem' }}>
                <strong>最近失败步骤</strong>
                {latestFailedStep ? (
                  <>
                    <span>步骤：{latestFailedStep.stepName}</span>
                    <span>状态：{getStatusLabel(latestFailedStep.status)}</span>
                    <span>摘要：{getResolvedStepSummary(latestFailedStep)}</span>
                    <span>错误输出：{latestFailedStep.stderrExcerpt ?? '暂无'}</span>
                  </>
                ) : (
                  <span>暂无失败步骤。</span>
                )}
              </div>

              <div className="admin-list-copy" style={{ marginTop: '1rem' }}>
                <strong>恢复建议</strong>
                {selectedDetail.recoverySummary ? (
                  <>
                    <span>分类：{getRecoveryCategoryLabel(selectedDetail.recoverySummary.category)}</span>
                    <span>级别：{selectedDetail.recoverySummary.severity === 'critical' ? '关键' : '提示'}</span>
                    <span>摘要：{selectedDetail.recoverySummary.summary}</span>
                    <span>可重试：{selectedDetail.recoverySummary.canRetry ? '是' : '否'}</span>
                    {selectedDetail.recoverySummary.suggestions.map((suggestion) => <span key={suggestion}>{suggestion}</span>)}
                  </>
                ) : recoverySuggestions.length ? (
                  recoverySuggestions.map((suggestion) => <span key={suggestion}>{suggestion}</span>)
                ) : (
                  <span>暂无恢复建议，建议进入任务详情查看完整时间线。</span>
                )}
              </div>

              <div className="admin-list-copy" style={{ marginTop: '1rem' }}>
                <strong>最近步骤日志</strong>
                {selectedJobState.steps.length ? (
                  selectedJobState.steps.slice(0, 5).map((step) => (
                    <span key={step.id}>
                      {step.stepName} / {getStatusLabel(step.status)} / {getResolvedStepSummary(step)}
                    </span>
                  ))
                ) : (
                  <span>暂无步骤日志。</span>
                )}
              </div>

              <div className="admin-list-actions" style={{ marginTop: '1rem' }}>
                {selectedJobState.job ? (
                  <button
                    type="button"
                    disabled={isSubmittingAction !== null}
                    onClick={() => router.push(`/admin/provision-jobs?jobId=${selectedJobState.job!.id}`)}
                  >
                    查看任务详情
                  </button>
                ) : null}
                {getActionLabels(selectedDetail).includes('create') ? (
                  <button
                    type="button"
                    disabled={isSubmittingAction !== null || selectedDetail.recoverySummary?.canRetry === false}
                    onClick={() => void handleTriggerAction('create')}
                  >
                    {isSubmittingAction === 'create' ? '创建中...' : getActionButtonLabel(selectedDetail, 'create')}
                  </button>
                ) : null}
                {getActionLabels(selectedDetail).includes('destroy') ? (
                  <button
                    type="button"
                    disabled={isSubmittingAction !== null || selectedDetail.recoverySummary?.canRetry === false}
                    onClick={() => void handleTriggerAction('destroy')}
                  >
                    {isSubmittingAction === 'destroy' ? '销毁中...' : getActionButtonLabel(selectedDetail, 'destroy')}
                  </button>
                ) : null}
              </div>
            </>
          ) : (
            <p className="admin-empty">请选择一个实例查看基础信息、入口详情和最近任务。</p>
          )}
        </article>
      </section>
    </div>
  );
}
