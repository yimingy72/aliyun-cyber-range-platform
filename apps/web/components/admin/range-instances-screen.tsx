'use client';

import React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';

import {
  deleteRangeInstance,
  fetchAdminBootstrap,
  triggerRangeAction,
} from '../../lib/admin-api';
import { formatAdminDateTime, isUnauthorizedAdminError } from '../../lib/admin-screen';
import type {
  AdminBootstrapData,
  ProvisionJob,
  RangeInstance,
} from '../../lib/admin-types';
import { useAdminSession } from './use-admin-session';

type RangeInstancesScreenProps = {
  apiBaseUrl?: string;
};

type ExtendedRangeInstance = RangeInstance & {
  templateId?: string | null;
};

type ExtendedProvisionJob = ProvisionJob & {
  startedAt?: string | null;
  finishedAt?: string | null;
};

type RangeListMode = 'active' | 'history';

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

function getInstanceTemplateLabel(
  instance: ExtendedRangeInstance,
  template: AdminBootstrapData['rangeTemplates'][number] | undefined,
) {
  return template?.name?.trim() || instance.templateNameSnapshot?.trim() || '未知靶场';
}

function getStatusTone(status: string) {
  if (status === 'running' || status === 'succeeded') {
    return 'success';
  }

  if (status === 'create_failed' || status === 'destroy_failed' || status === 'failed') {
    return 'danger';
  }

  if (
    status === 'pending_create' ||
    status === 'creating' ||
    status === 'pending_destroy' ||
    status === 'destroying' ||
    status === 'pending'
  ) {
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
  return formatAdminDateTime(instance.createdAt ?? recentJob?.startedAt ?? null);
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
  return formatAdminDateTime(job?.finishedAt ?? job?.startedAt ?? null);
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
}: RangeInstancesScreenProps) {
  const router = useRouter();
  const session = useAdminSession();
  const [snapshot, setSnapshot] = useState<AdminBootstrapData | null>(null);
  const [listMode, setListMode] = useState<RangeListMode>('active');
  const [searchName, setSearchName] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmittingAction, setIsSubmittingAction] = useState<'create' | 'destroy' | null>(null);
  const [removedInstanceIds, setRemovedInstanceIds] = useState<string[]>([]);

  useEffect(() => {
    if (!session.isReady) {
      return;
    }

    if (!session.token) {
      setSnapshot(null);
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

        if (isUnauthorizedAdminError(error)) {
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

  function upsertInstanceInSnapshot(instance: ExtendedRangeInstance) {
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

  function handleViewDetail(instanceId: string) {
    router.push(`/admin/ranges/${instanceId}`);
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

      upsertInstanceInSnapshot({
        ...instance,
        status: 'pending_destroy',
        lastJobId: job.id,
      });
      upsertJobInSnapshot(job);
    } catch (error: unknown) {
      if (isUnauthorizedAdminError(error)) {
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
    } catch (error: unknown) {
      if (isUnauthorizedAdminError(error)) {
        session.logout();
        router.replace('/admin/login');
        return;
      }

      setErrorMessage('删除失败实例失败，请稍后重试。');
    } finally {
      setIsSubmittingAction(null);
    }
  }

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

  const isBootstrapLoading = isLoading && !snapshot;

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
              <div className="template-workbench-column-cell workbench-action-cell"><strong>操作</strong></div>
            </div>
          ) : (
            <div className="range-workbench-column-head">
              <div className="template-workbench-column-cell"><strong>实例名</strong></div>
              <div className="template-workbench-column-cell"><strong>靶场名</strong></div>
              <div className="template-workbench-column-cell"><strong>状态</strong></div>
              <div className="template-workbench-column-cell"><strong>创建时间</strong></div>
              <div className="template-workbench-column-cell workbench-action-cell"><strong>操作</strong></div>
            </div>
          )}

          {isBootstrapLoading ? (
            <div className="admin-workbench-empty" aria-hidden="true" />
          ) : visibleListInstances.length ? (
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
                        <span>{formatAdminDateTime(instance.createdAt)}</span>
                      </div>

                      <div className="range-history-time">
                        <span>{getEndedAtLabel(recentJob)}</span>
                      </div>

                      <div className="range-history-time">
                        <span>{getDurationLabel(instance.createdAt, endedAt)}</span>
                      </div>

                      <div className="range-workbench-actions workbench-action-cell">
                        <button type="button" onClick={() => void handleViewDetail(instance.id)}>
                          查看详情
                        </button>
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

                      <div className="range-workbench-actions workbench-action-cell">
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
                            {isSubmittingAction !== null ? '处理中...' : actionLabel}
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
    </div>
  );
}
