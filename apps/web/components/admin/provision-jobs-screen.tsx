'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

import { AdminApiError, fetchAdminBootstrap, fetchProvisionJobDetail } from '../../lib/admin-api';
import type { AdminBootstrapData, ProvisionJob, ProvisionJobStep } from '../../lib/admin-types';
import { useAdminSession } from './use-admin-session';

type ProvisionJobsScreenProps = {
  apiBaseUrl?: string;
};

function isUnauthorizedError(error: unknown) {
  return error instanceof AdminApiError && error.status === 401;
}

function getJobLabel(job: ProvisionJob) {
  if (job.jobType === 'create') {
    return '创建';
  }

  if (job.jobType === 'destroy') {
    return '销毁';
  }

  return job.jobType;
}

function getStepMessage(step: ProvisionJobStep) {
  return step.message ?? step.stderrExcerpt ?? step.stdoutExcerpt ?? step.status;
}

export function ProvisionJobsScreen({
  apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3001',
}: ProvisionJobsScreenProps) {
  const router = useRouter();
  const session = useAdminSession();
  const [snapshot, setSnapshot] = useState<AdminBootstrapData | null>(null);
  const [selectedJob, setSelectedJob] = useState<ProvisionJob | null>(null);
  const [selectedSteps, setSelectedSteps] = useState<ProvisionJobStep[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);

  useEffect(() => {
    if (!session.isReady) {
      return;
    }

    if (!session.token) {
      setSnapshot(null);
      setSelectedJob(null);
      setSelectedSteps([]);
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

        setErrorMessage('编排任务加载失败，请刷新页面后重试。');
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

  async function handleViewDetail(jobId: string) {
    if (!session.token) {
      return;
    }

    setErrorMessage(null);
    setIsLoadingDetail(true);

    try {
      const detail = await fetchProvisionJobDetail(apiBaseUrl, session.token, jobId);
      setSelectedJob(detail.job);
      setSelectedSteps(detail.steps);
    } catch (error: unknown) {
      if (isUnauthorizedError(error)) {
        session.logout();
        router.replace('/admin/login');
        return;
      }

      setErrorMessage('任务详情加载失败，请稍后重试。');
    } finally {
      setIsLoadingDetail(false);
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
          <h2>正在加载编排任务...</h2>
          <p className="admin-empty">请稍候，正在拉取任务列表与步骤概览。</p>
        </section>
      </main>
    );
  }

  return (
    <div className="admin-screen">
      <section className="admin-hero">
        <p className="auth-eyebrow">后台二级页</p>
        <h1>编排任务</h1>
        <p className="admin-description">集中查看实例创建、销毁等编排任务，并在详情区追踪步骤日志。</p>
      </section>

      {errorMessage ? <p className="admin-error">{errorMessage}</p> : null}

      <section className="admin-grid">
        <article className="admin-panel">
          <div className="admin-section-header">
            <h2>任务列表</h2>
            <span>{snapshot?.provisionJobs.length ?? 0} 个任务</span>
          </div>

          {snapshot?.provisionJobs.length ? (
            <ul className="admin-list">
              {snapshot.provisionJobs.map((job) => (
                <li key={job.id}>
                  <div className="admin-list-copy">
                    <strong>{job.id}</strong>
                    <span>实例：{job.rangeInstanceId}</span>
                    <span>类型：{getJobLabel(job)}</span>
                    <span>状态：{job.status}</span>
                    <span>触发人：{job.triggeredBy}</span>
                  </div>
                  <div className="admin-list-actions">
                    <button type="button" onClick={() => void handleViewDetail(job.id)}>
                      查看任务 {job.id}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="admin-empty">当前没有编排任务。</p>
          )}
        </article>

        <article className="admin-panel">
          <div className="admin-section-header">
            <h2>步骤日志</h2>
            <span>{selectedJob?.id ?? '未选择'}</span>
          </div>

          {isLoadingDetail ? (
            <p className="admin-empty">正在加载任务详情...</p>
          ) : selectedJob ? (
            <>
              <div className="admin-list-copy">
                <strong>{selectedJob.id}</strong>
                <span>实例：{selectedJob.rangeInstanceId}</span>
                <span>类型：{getJobLabel(selectedJob)}</span>
                <span>状态：{selectedJob.status}</span>
              </div>

              {selectedSteps.length ? (
                <ul className="admin-list">
                  {selectedSteps.map((step) => (
                    <li key={step.id}>
                      <div className="admin-list-copy">
                        <strong>{step.stepName}</strong>
                        <span>状态：{step.status}</span>
                        <span>{getStepMessage(step)}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="admin-empty">当前任务还没有步骤日志。</p>
              )}
            </>
          ) : (
            <p className="admin-empty">请选择一个任务查看步骤日志。</p>
          )}
        </article>
      </section>
    </div>
  );
}
