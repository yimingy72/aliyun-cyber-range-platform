'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';

import { AdminApiError, fetchAdminBootstrap, fetchRangeInstanceDetail, triggerRangeAction } from '../../lib/admin-api';
import type { AdminBootstrapData, RangeInstance, RangeInstanceDetail } from '../../lib/admin-types';
import { useAdminSession } from './use-admin-session';

type RangeInstancesScreenProps = {
  apiBaseUrl?: string;
};

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

  return status;
}

function getActionLabels(instance: RangeInstance) {
  if (instance.status === 'running') {
    return ['create', 'destroy'] as Array<'create' | 'destroy'>;
  }

  if (instance.status === 'destroyed') {
    return ['create'] as Array<'create' | 'destroy'>;
  }

  return ['create', 'destroy'] as Array<'create' | 'destroy'>;
}

export function RangeInstancesScreen({
  apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3001',
}: RangeInstancesScreenProps) {
  const router = useRouter();
  const session = useAdminSession();
  const [snapshot, setSnapshot] = useState<AdminBootstrapData | null>(null);
  const [selectedDetail, setSelectedDetail] = useState<RangeInstanceDetail | null>(null);
  const [selectedInstanceId, setSelectedInstanceId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);
  const [isSubmittingAction, setIsSubmittingAction] = useState<'create' | 'destroy' | null>(null);

  useEffect(() => {
    if (!session.isReady) {
      return;
    }

    if (!session.token) {
      setSnapshot(null);
      setSelectedDetail(null);
      setSelectedInstanceId(null);
      setErrorMessage(null);
      setIsLoading(false);
      return;
    }

    let isActive = true;

    setErrorMessage(null);
    setIsLoading(true);

    fetchAdminBootstrap(apiBaseUrl, session.token)
      .then((payload) => {
        if (!isActive) {
          return;
        }

        setSnapshot(payload);
      })
      .catch((error: unknown) => {
        if (!isActive) {
          return;
        }

        if (isUnauthorizedError(error)) {
          session.logout();
          router.replace('/admin/login');
          return;
        }

        setErrorMessage('靶场实例加载失败，请刷新页面后重试。');
      })
      .finally(() => {
        if (!isActive) {
          return;
        }

        setIsLoading(false);
      });

    return () => {
      isActive = false;
    };
  }, [apiBaseUrl, router, session.isReady, session.token]);

  const teamsById = useMemo(() => {
    return new Map((snapshot?.teams ?? []).map((team) => [team.id, team]));
  }, [snapshot]);

  async function handleViewDetail(instanceId: string) {
    if (!session.token) {
      return;
    }

    setSelectedInstanceId(instanceId);
    setSelectedDetail(null);
    setErrorMessage(null);
    setIsLoadingDetail(true);

    try {
      const detail = await fetchRangeInstanceDetail(apiBaseUrl, session.token, instanceId);
      setSelectedDetail(detail);
    } catch (error: unknown) {
      if (isUnauthorizedError(error)) {
        session.logout();
        router.replace('/admin/login');
        return;
      }

      setErrorMessage('实例详情加载失败，请稍后重试。');
    } finally {
      setIsLoadingDetail(false);
    }
  }

  async function handleTriggerAction(action: 'create' | 'destroy') {
    if (!session.token || !selectedDetail) {
      return;
    }

    setErrorMessage(null);
    setIsSubmittingAction(action);

    try {
      const job = await triggerRangeAction(apiBaseUrl, session.token, selectedDetail.id, action, 'admin');
      setSnapshot((current) => {
        if (!current) {
          return current;
        }

        return {
          ...current,
          rangeInstances: current.rangeInstances.map((instance) =>
            instance.id === selectedDetail.id ? { ...instance, lastJobId: job.id } : instance,
          ),
          provisionJobs: [job, ...current.provisionJobs],
        };
      });
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
        <p className="admin-description">查看实例状态、公网入口、资源摘要，并从详情区直接发起创建或销毁任务。</p>
      </section>

      {errorMessage ? <p className="admin-error">{errorMessage}</p> : null}

      <section className="admin-grid">
        <article className="admin-panel">
          <div className="admin-section-header">
            <h2>实例列表</h2>
            <span>{snapshot?.rangeInstances.length ?? 0} 个实例</span>
          </div>

          {snapshot?.rangeInstances.length ? (
            <ul className="admin-list">
              {snapshot.rangeInstances.map((instance) => {
                const team = teamsById.get(instance.teamId);

                return (
                  <li key={instance.id}>
                    <div className="admin-list-copy">
                      <strong>{instance.id}</strong>
                      <span>状态：{getStatusLabel(instance.status)}</span>
                      <span>{team ? `队伍：${team.name}` : `队伍 ID：${instance.teamId}`}</span>
                      {instance.errorSummary ? <span>异常：{instance.errorSummary}</span> : null}
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
            <p className="admin-empty">当前没有靶场实例。</p>
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
            <div className="admin-list-copy">
              <strong>{selectedDetail.id}</strong>
              <span>状态：{getStatusLabel(selectedDetail.status)}</span>
              <span>竞赛：{selectedDetail.competitionId}</span>
              <span>模板：{selectedDetail.templateId}</span>

              <strong>公网入口</strong>
              <span>{selectedDetail.accessEntry?.publicIp ?? '暂无公网 IP'}</span>
              <span>{selectedDetail.accessEntry?.ssh ?? '暂无 SSH 信息'}</span>
              {selectedDetail.accessEntry?.url ? <span>{selectedDetail.accessEntry.url}</span> : null}

              <strong>资源摘要</strong>
              <span>VPC：{selectedDetail.resourceSummary?.vpcId ?? '暂无'}</span>
              <span>模式：{selectedDetail.resourceSummary?.mode ?? '暂无'}</span>
              <span>网段：{selectedDetail.resourceSummary?.topologySpec?.vpcCidr ?? '暂无'}</span>

              <div className="admin-list-actions">
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
            </div>
          ) : (
            <p className="admin-empty">请选择一个实例查看公网入口与资源摘要。</p>
          )}
        </article>
      </section>
    </div>
  );
}
