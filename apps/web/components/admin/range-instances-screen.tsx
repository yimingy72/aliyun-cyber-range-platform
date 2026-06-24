'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

import {
  AdminApiError,
  fetchAdminBootstrap,
  fetchProvisionJobDetail,
  fetchRangeInstanceDetail,
  triggerRangeAction,
} from '../../lib/admin-api';
import type { AdminBootstrapData, ProvisionJob, ProvisionJobStep, RangeInstance, RangeInstanceDetail } from '../../lib/admin-types';
import { useAdminSession } from './use-admin-session';

type RangeInstancesScreenProps = {
  apiBaseUrl?: string;
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

function isUnauthorizedError(error: unknown) {
  return error instanceof AdminApiError && error.status === 401;
}

function getStatusLabel(status: string) {
  if (status === 'running') {
    return '运行中';
  }

  if (status === 'create_failed') {
    return '创建失败';
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

export function RangeInstancesScreen({
  apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3001',
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
  });
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);
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

  const teamsById = useMemo(() => {
    return new Map((snapshot?.teams ?? []).map((item) => [item.id, item]));
  }, [snapshot]);

  const templatesById = useMemo(() => {
    return new Map((snapshot?.rangeTemplates ?? []).map((item) => [item.id, item]));
  }, [snapshot]);

  const jobsByInstanceId = useMemo(() => {
    const map = new Map<string, ExtendedProvisionJob>();

    for (const job of snapshot?.provisionJobs ?? []) {
      const nextJob = job as ExtendedProvisionJob;
      const currentJob = map.get(job.rangeInstanceId);

      if (!currentJob) {
        map.set(job.rangeInstanceId, nextJob);
        continue;
      }

      const currentStartedAt = currentJob.startedAt ?? '';
      const nextStartedAt = nextJob.startedAt ?? '';

      if (nextStartedAt > currentStartedAt) {
        map.set(job.rangeInstanceId, nextJob);
      }
    }

    return map;
  }, [snapshot]);

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

      return true;
    });
  }, [filters, snapshot]);

  async function handleViewDetail(instanceId: string) {
    if (!session.token) {
      return;
    }

    const requestId = detailRequestIdRef.current + 1;
    detailRequestIdRef.current = requestId;
    setSelectedInstanceId(instanceId);
    setSelectedDetail(null);
    setSelectedJobState({ job: null, steps: [] });
    setErrorMessage(null);
    setIsLoadingDetail(true);

    try {
      const detail = (await fetchRangeInstanceDetail(apiBaseUrl, session.token, instanceId)) as ExtendedRangeInstanceDetail;

      if (detailRequestIdRef.current !== requestId) {
        return;
      }

      setSelectedDetail(detail);

      if (!detail.lastJobId) {
        setSelectedJobState({ job: null, steps: [] });
        return;
      }

      const jobDetail = await fetchProvisionJobDetail(apiBaseUrl, session.token, detail.lastJobId);

      if (detailRequestIdRef.current !== requestId) {
        return;
      }

      setSelectedJobState({
        job: jobDetail.job as ExtendedProvisionJob,
        steps: jobDetail.steps as ExtendedProvisionJobStep[],
      });
    } catch (error: unknown) {
      if (detailRequestIdRef.current !== requestId) {
        return;
      }

      if (isUnauthorizedError(error)) {
        session.logout();
        router.replace('/admin/login');
        return;
      }

      setErrorMessage('实例详情加载失败，请稍后重试。');
    } finally {
      if (detailRequestIdRef.current === requestId) {
        setIsLoadingDetail(false);
      }
    }
  }

  async function handleTriggerAction(action: 'create' | 'destroy') {
    if (!session.token || !selectedDetail) {
      return;
    }

    setErrorMessage(null);
    setIsSubmittingAction(action);

    try {
      const job = (await triggerRangeAction(apiBaseUrl, session.token, selectedDetail.id, action, 'admin')) as ExtendedProvisionJob;

      setSnapshot((current) => {
        if (!current) {
          return current;
        }

        return {
          ...current,
          rangeInstances: current.rangeInstances.map((instance) =>
            instance.id === selectedDetail.id ? { ...instance, lastJobId: job.id } : instance,
          ),
          provisionJobs: [job, ...current.provisionJobs.filter((existingJob) => existingJob.id !== job.id)],
        };
      });

      setSelectedJobState((current) => ({
        ...current,
        job,
      }));
    } catch (error: unknown) {
      if (isUnauthorizedError(error)) {
        session.logout();
        router.replace('/admin/login');
        return;
      }

      setErrorMessage(action === 'create' ? '创建任务发起失败，请稍后重试。' : '销毁任务发起失败，请稍后重试。');
    } finally {
      setIsSubmittingAction(null);
    }
  }

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
                    <span>触发人：{selectedJobState.job.triggeredBy}</span>
                    <span>开始时间：{formatDateTime(selectedJobState.job.startedAt)}</span>
                    <span>失败摘要：{selectedJobState.job.errorSummary ?? '无'}</span>
                  </>
                ) : (
                  <span>暂无最近任务。</span>
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
                {getActionLabels(selectedDetail).includes('create') ? (
                  <button
                    type="button"
                    disabled={isSubmittingAction !== null}
                    onClick={() => void handleTriggerAction('create')}
                  >
                    {isSubmittingAction === 'create' ? '创建中...' : '发起创建'}
                  </button>
                ) : null}
                {getActionLabels(selectedDetail).includes('destroy') ? (
                  <button
                    type="button"
                    disabled={isSubmittingAction !== null}
                    onClick={() => void handleTriggerAction('destroy')}
                  >
                    {isSubmittingAction === 'destroy' ? '销毁中...' : '发起销毁'}
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
