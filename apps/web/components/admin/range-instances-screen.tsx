'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

import {
  AdminApiError,
  deleteRangeInstance,
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
  RangeInstanceDetail,
} from '../../lib/admin-types';
import { useAdminSession } from './use-admin-session';

type RangeInstancesScreenProps = {
  apiBaseUrl?: string;
  pollIntervalMs?: number;
};

type ExtendedRangeInstance = RangeInstance & {
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

type RangeListMode = 'active' | 'history';

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
    return '未知靶场';
  }

  return template.name?.trim() || template.slug;
}

function getInstanceTemplateLabel(
  instance: ExtendedRangeInstance | ExtendedRangeInstanceDetail,
  template: AdminBootstrapData['rangeTemplates'][number] | undefined,
) {
  return template?.name?.trim() || instance.templateNameSnapshot?.trim() || '未知靶场';
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

function formatObjectEntries(record?: Record<string, string> | null) {
  if (!record || Object.keys(record).length === 0) {
    return '暂无';
  }

  return Object.entries(record)
    .map(([key, value]) => `${key}: ${value}`)
    .join(' | ');
}

function getRecentJobLabel(job?: ExtendedProvisionJob | null) {
  if (!job) {
    return '暂无';
  }

  return `${job.jobType === 'destroy' ? '销毁' : '创建'} / ${getStatusLabel(job.status)}`;
}

function getStatusTone(status: string) {
  if (status === 'running' || status === 'succeeded') {
    return 'success';
  }

  if (status === 'create_failed' || status === 'destroy_failed' || status === 'failed') {
    return 'danger';
  }

  if (status === 'pending_create' || status === 'creating' || status === 'pending_destroy' || status === 'destroying' || status === 'pending') {
    return 'warning';
  }

  return 'neutral';
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

function getInstanceDisplayName(instance: ExtendedRangeInstance) {
  return instance.name?.trim() || instance.id;
}

function getInstanceCreatedAt(instance: ExtendedRangeInstance, recentJob?: ExtendedProvisionJob | null) {
  return formatDateTime(instance.createdAt ?? recentJob?.startedAt ?? null);
}

function getInstanceActionLabel(instance: ExtendedRangeInstance) {
  if (instance.status === 'running') {
    return '关闭';
  }

  if (instance.status === 'destroy_failed') {
    return '销毁';
  }

  if (instance.status === 'create_failed') {
    return '删除';
  }

  return null;
}

function getEndedAtLabel(job?: ExtendedProvisionJob | null) {
  return formatDateTime(job?.finishedAt ?? job?.startedAt ?? null);
}

function getDurationLabel(start?: string | null, end?: string | null) {
  if (!start || !end) {
    return '暂无';
  }

  const startedAt = new Date(start);
  const endedAt = new Date(end);

  if (Number.isNaN(startedAt.getTime()) || Number.isNaN(endedAt.getTime())) {
    return '暂无';
  }

  const durationMs = endedAt.getTime() - startedAt.getTime();

  if (durationMs <= 0) {
    return '暂无';
  }

  const totalMinutes = Math.floor(durationMs / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours > 0) {
    return `${hours} 小时 ${minutes} 分钟`;
  }

  return `${minutes} 分钟`;
}

export function RangeInstancesScreen({
  apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3001',
  pollIntervalMs = 2500,
}: RangeInstancesScreenProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const session = useAdminSession();
  const [snapshot, setSnapshot] = useState<AdminBootstrapData | null>(null);
  const [selectedDetail, setSelectedDetail] = useState<ExtendedRangeInstanceDetail | null>(null);
  const [selectedInstanceId, setSelectedInstanceId] = useState<string | null>(null);
  const [selectedJobState, setSelectedJobState] = useState<SelectedJobState>({ job: null, steps: [] });
  const [listMode, setListMode] = useState<RangeListMode>('active');
  const [searchName, setSearchName] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);
  const [isSubmittingAction, setIsSubmittingAction] = useState<'create' | 'destroy' | null>(null);
  const [removedInstanceIds, setRemovedInstanceIds] = useState<string[]>([]);
  const detailRequestIdRef = useRef(0);
  const autoOpenedInstanceIdRef = useRef<string | null>(null);

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

  const rangeTemplates = snapshot?.rangeTemplates ?? [];

  const templatesById = useMemo(() => {
    return new Map(rangeTemplates.map((item) => [item.id, item]));
  }, [rangeTemplates]);

  const jobsByInstanceId = useMemo(() => {
    const map = new Map<string, ExtendedProvisionJob>();

    for (const job of snapshot?.provisionJobs ?? []) {
      if (!map.has(job.rangeInstanceId)) {
        map.set(job.rangeInstanceId, job as ExtendedProvisionJob);
      }
    }

    return map;
  }, [snapshot]);

  const currentStage = useMemo(() => {
    return getCurrentStage(selectedJobState.steps);
  }, [selectedJobState.steps]);

  const visibleInstances = useMemo(() => {
    return ((snapshot?.rangeInstances ?? []) as ExtendedRangeInstance[]).filter(
      (instance) => !removedInstanceIds.includes(instance.id),
    );
  }, [removedInstanceIds, snapshot]);
  const activeInstances = useMemo(() => {
    return visibleInstances.filter((instance) => instance.status !== 'destroyed');
  }, [visibleInstances]);
  const historyInstances = useMemo(() => {
    return visibleInstances.filter((instance) => instance.status === 'destroyed');
  }, [visibleInstances]);
  const filteredActiveInstances = useMemo(() => {
    const keyword = searchName.trim().toLowerCase();

    if (!keyword) {
      return activeInstances;
    }

    return activeInstances.filter((instance) => getInstanceDisplayName(instance).toLowerCase().includes(keyword));
  }, [activeInstances, searchName]);
  const filteredHistoryInstances = useMemo(() => {
    const keyword = searchName.trim().toLowerCase();

    if (!keyword) {
      return historyInstances;
    }

    return historyInstances.filter((instance) => getInstanceDisplayName(instance).toLowerCase().includes(keyword));
  }, [historyInstances, searchName]);
  const visibleListInstances = listMode === 'history' ? filteredHistoryInstances : filteredActiveInstances;
  const requestedInstanceId = searchParams.get('instanceId')?.trim() || null;

  useEffect(() => {
    if (listMode === 'active' && activeInstances.length === 0 && historyInstances.length > 0) {
      setListMode('history');
      return;
    }

    if (listMode === 'history' && historyInstances.length === 0 && activeInstances.length > 0) {
      setListMode('active');
    }
  }, [activeInstances.length, historyInstances.length, listMode]);

  function closeDetailDialog() {
    setSelectedInstanceId(null);
    setSelectedDetail(null);
    setSelectedJobState({ job: null, steps: [] });
  }

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

  function removeInstanceFromSnapshot(instanceId: string) {
    setSnapshot((current) => {
      if (!current) {
        return current;
      }

      return {
        ...current,
        rangeInstances: current.rangeInstances.filter((item) => item.id !== instanceId),
        provisionJobs: current.provisionJobs.filter((item) => item.rangeInstanceId !== instanceId),
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

  async function handleListDestroyAction(instance: ExtendedRangeInstance) {
    if (!session.token) {
      return;
    }

    setErrorMessage(null);
    setIsSubmittingAction('destroy');

    try {
      const trigger = getActionTrigger(instance, 'destroy');
      const job = (await triggerRangeAction(apiBaseUrl, session.token, instance.id, trigger, 'admin')) as ExtendedProvisionJob;
      const pendingStatus = 'pending_destroy';

      upsertInstanceInSnapshot({
        ...instance,
        status: pendingStatus,
        lastJobId: job.id,
      });

      if (selectedInstanceId === instance.id) {
        setSelectedDetail((current) =>
          current
            ? {
                ...current,
                status: pendingStatus,
                lastJobId: job.id,
              }
            : current,
        );
        setSelectedJobState({ job, steps: [] });
      }

      upsertJobInSnapshot(job);
    } catch (error: unknown) {
      if (isUnauthorizedError(error)) {
        session.logout();
        router.replace('/admin/login');
        return;
      }

      setErrorMessage('实例生命周期操作失败，请稍后重试。');
    } finally {
      setIsSubmittingAction(null);
    }
  }

  async function handleDeleteFailedInstance(instance: ExtendedRangeInstance) {
    if (!session.token) {
      return;
    }

    setErrorMessage(null);
    setIsSubmittingAction('create');

    try {
      await deleteRangeInstance(apiBaseUrl, session.token, instance.id);
      setRemovedInstanceIds((current) => [...current, instance.id]);
      removeInstanceFromSnapshot(instance.id);

      if (selectedInstanceId === instance.id) {
        closeDetailDialog();
      }
    } catch (error: unknown) {
      if (isUnauthorizedError(error)) {
        session.logout();
        router.replace('/admin/login');
        return;
      }

      setErrorMessage('删除失败实例失败，请稍后重试。');
    } finally {
      setIsSubmittingAction(null);
    }
  }

  useEffect(() => {
    if (!requestedInstanceId) {
      autoOpenedInstanceIdRef.current = null;
      return;
    }

    if (autoOpenedInstanceIdRef.current === requestedInstanceId) {
      return;
    }

    const targetInstance = visibleInstances.find((instance) => instance.id === requestedInstanceId);

    if (!targetInstance) {
      return;
    }

    autoOpenedInstanceIdRef.current = requestedInstanceId;
    void handleViewDetail(requestedInstanceId);
  }, [requestedInstanceId, visibleInstances]);

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
    return null;
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

  return (
    <div className="admin-screen admin-workbench-screen">
      {errorMessage ? <p className="admin-error">{errorMessage}</p> : null}

      <section>
        <article className="admin-workbench-panel range-workbench-shell">
          <div className="template-workbench-list-header range-workbench-header">
            <div className="template-workbench-list-header-copy">
              <h2>靶场实例</h2>
            </div>
          </div>

          <div className="template-workbench-controls range-workbench-controls">
            <div className="template-workbench-search-grid">
              <label className="template-workbench-search-field">
                <span className="sr-only">实例名搜索</span>
                <input
                  aria-label="筛选实例名"
                  value={searchName}
                  onChange={(event) => setSearchName(event.target.value)}
                  placeholder="搜索实例名"
                />
              </label>
            </div>

            <div className="template-workbench-segmented range-workbench-segmented" role="tablist" aria-label="靶场实例视图切换">
              <button type="button" aria-pressed={listMode === 'active'} onClick={() => setListMode('active')}>
                实例列表
              </button>
              <button type="button" aria-pressed={listMode === 'history'} onClick={() => setListMode('history')}>
                实例历史
              </button>
            </div>
          </div>

          {listMode === 'history' ? (
            <div className="range-history-column-head">
              <div className="template-workbench-column-cell"><strong>实例名</strong></div>
              <div className="template-workbench-column-cell"><strong>靶场名</strong></div>
              <div className="template-workbench-column-cell"><strong>开启时间</strong></div>
              <div className="template-workbench-column-cell"><strong>回收时间</strong></div>
              <div className="template-workbench-column-cell"><strong>运行时长</strong></div>
            </div>
          ) : (
            <div className="range-workbench-column-head">
              <div className="template-workbench-column-cell"><strong>实例名</strong></div>
              <div className="template-workbench-column-cell"><strong>靶场名</strong></div>
              <div className="template-workbench-column-cell"><strong>状态</strong></div>
              <div className="template-workbench-column-cell"><strong>创建时间</strong></div>
              <div className="template-workbench-column-cell"><strong>操作</strong></div>
            </div>
          )}

          {visibleListInstances.length ? (
            listMode === 'history' ? (
              <div className="range-history-rows">
                {filteredHistoryInstances.map((instance) => {
                  const template = templatesById.get(instance.templateId ?? '');
                  const recentJob = jobsByInstanceId.get(instance.id);
                  const endedAt = recentJob?.finishedAt ?? recentJob?.startedAt ?? null;

                  return (
                    <article key={instance.id} className="range-history-row">
                      <div className="range-workbench-main">
                        <strong>{getInstanceDisplayName(instance)}</strong>
                      </div>

                      <div className="range-workbench-scenario">
                        <strong>{getInstanceTemplateLabel(instance, template)}</strong>
                      </div>

                      <div className="range-history-time">
                        <span>{formatDateTime(instance.createdAt)}</span>
                      </div>

                      <div className="range-history-time">
                        <span>{getEndedAtLabel(recentJob)}</span>
                      </div>

                      <div className="range-history-time">
                        <span>{getDurationLabel(instance.createdAt, endedAt)}</span>
                      </div>
                    </article>
                  );
                })}
              </div>
            ) : (
              <div className="range-workbench-rows">
                {filteredActiveInstances.map((instance) => {
                  const template = templatesById.get(instance.templateId ?? '');
                  const recentJob = jobsByInstanceId.get(instance.id);
                  const actionLabel = getInstanceActionLabel(instance);

                  return (
                    <article key={instance.id} className="range-workbench-row">
                      <div className="range-workbench-main">
                        <strong>{getInstanceDisplayName(instance)}</strong>
                      </div>

                      <div className="range-workbench-scenario">
                        <strong>{getInstanceTemplateLabel(instance, template)}</strong>
                      </div>

                      <div className="range-workbench-status-cell">
                        <span className={`admin-pill admin-pill-${getStatusTone(instance.status)}`}>{getStatusLabel(instance.status)}</span>
                      </div>

                      <div className="range-workbench-created-at">
                        <span>{getInstanceCreatedAt(instance, recentJob)}</span>
                      </div>

                      <div className="range-workbench-actions">
                        <button type="button" onClick={() => void handleViewDetail(instance.id)}>
                          查看详情
                        </button>
                        {actionLabel ? (
                          <button
                            type="button"
                            disabled={isSubmittingAction !== null}
                            onClick={() =>
                              void (instance.status === 'create_failed'
                                ? handleDeleteFailedInstance(instance)
                                : handleListDestroyAction(instance))
                            }
                          >
                            {isSubmittingAction !== null && selectedInstanceId === instance.id ? '处理中...' : actionLabel}
                          </button>
                        ) : null}
                      </div>
                    </article>
                  );
                })}
              </div>
            )
          ) : (
            <div className="admin-workbench-empty">
              <strong>{listMode === 'history' ? '当前还没有已回收实例' : '当前还没有可查看的靶场实例'}</strong>
              <p>{listMode === 'history' ? '实例完成销毁后，会自动沉淀到这里。' : '实例会在靶场编排页生成后进入这里。'}</p>
            </div>
          )}
        </article>
      </section>

      {selectedInstanceId ? (
        <div className="template-workbench-dialog-backdrop range-detail-dialog-backdrop" role="presentation" onClick={closeDetailDialog}>
          <section
            className="template-workbench-dialog range-detail-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="实例详情"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="template-workbench-dialog-header">
              <h2>实例详情</h2>
              <p>{selectedDetail?.name?.trim() || selectedInstanceId}</p>
            </div>

            {isLoadingDetail ? (
              <div className="admin-workbench-empty">
                <p>正在加载实例详情...</p>
              </div>
            ) : selectedDetail ? (
              <div className="range-detail-body">
                <div className="range-detail-section">
                  <strong>实例基础信息</strong>
                  <div className="admin-detail-grid">
                    <span>实例名：{selectedDetail.name?.trim() || selectedDetail.id}</span>
                    <span>实例 ID：{selectedDetail.id}</span>
                    <span>状态：{getStatusLabel(selectedDetail.status)}</span>
                    <span>靶场名：{getInstanceTemplateLabel(selectedDetail, templatesById.get(selectedDetail.templateId ?? ''))}</span>
                    <span>创建时间：{formatDateTime(selectedDetail.createdAt ?? selectedJobState.job?.startedAt ?? null)}</span>
                    <span>过期时间：{formatDateTime(selectedDetail.expiresAt)}</span>
                    <span>错误摘要：{selectedDetail.errorSummary ?? '无'}</span>
                  </div>
                </div>

                <div className="range-detail-section">
                  <strong>公网入口详情</strong>
                  <div className="admin-detail-grid">
                    <span>角色：{selectedDetail.accessEntry?.hostRole ?? '暂无'}</span>
                    <span>公网 IP：{selectedDetail.accessEntry?.publicIp ?? '暂无'}</span>
                    <span>私网 IP：{selectedDetail.accessEntry?.privateIp ?? '暂无'}</span>
                    <span>SSH：{selectedDetail.accessEntry?.ssh ?? '暂无'}</span>
                    <span>URL：{selectedDetail.accessEntry?.url ?? '暂无'}</span>
                  </div>
                </div>

                <div className="range-detail-section">
                  <strong>资源摘要</strong>
                  <div className="admin-detail-grid">
                    <span>模式：{selectedDetail.resourceSummary?.mode ?? '暂无'}</span>
                    <span>VPC：{selectedDetail.resourceSummary?.vpcId ?? '暂无'}</span>
                    <span>网段：{selectedDetail.resourceSummary?.topologySpec?.vpcCidr ?? '暂无'}</span>
                    <span>子网：{formatObjectEntries(selectedDetail.resourceSummary?.subnetIds)}</span>
                    <span>主机：{formatObjectEntries(selectedDetail.resourceSummary?.hostIds)}</span>
                    <span>二级网卡：{formatObjectEntries(selectedDetail.resourceSummary?.secondaryNetworkInterfaceIds)}</span>
                  </div>
                </div>

                <div className="range-detail-section">
                  <strong>最近一次任务</strong>
                  {selectedJobState.job ? (
                    <div className="admin-detail-grid">
                      <span>任务 ID：{selectedJobState.job.id}</span>
                      <span>类型：{selectedJobState.job.jobType}</span>
                      <span>状态：{getStatusLabel(selectedJobState.job.status)}</span>
                      <span>当前阶段：{currentStage}</span>
                      <span>触发人：{selectedJobState.job.triggeredBy}</span>
                      <span>开始时间：{formatDateTime(selectedJobState.job.startedAt)}</span>
                      <span>结束时间：{formatDateTime(selectedJobState.job.finishedAt)}</span>
                    </div>
                  ) : (
                    <span>暂无最近任务。</span>
                  )}
                </div>

                <div className="range-detail-actions">
                  {getActionLabels(selectedDetail).includes('destroy') ? (
                    <button
                      type="button"
                      disabled={isSubmittingAction !== null || selectedDetail.recoverySummary?.canRetry === false}
                      onClick={() => void handleTriggerAction('destroy')}
                    >
                      {isSubmittingAction === 'destroy' ? '销毁中...' : '销毁'}
                    </button>
                  ) : null}
                  <button type="button" onClick={closeDetailDialog}>
                    关闭
                  </button>
                </div>
              </div>
            ) : (
              <div className="admin-workbench-empty">
                <p>实例详情加载失败，请返回列表后重试。</p>
              </div>
            )}
          </section>
        </div>
      ) : null}
    </div>
  );
}
