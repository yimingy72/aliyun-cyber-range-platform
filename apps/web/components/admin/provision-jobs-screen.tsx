'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

import { AdminApiError, fetchAdminBootstrap, fetchProvisionJobDetail } from '../../lib/admin-api';
import type { AdminBootstrapData, ProvisionJob, ProvisionJobStep } from '../../lib/admin-types';
import { useAdminSession } from './use-admin-session';

type ProvisionJobsScreenProps = {
  apiBaseUrl?: string;
};

type ExtendedProvisionJob = ProvisionJob & {
  startedAt?: string | null;
  finishedAt?: string | null;
};

type ExtendedProvisionJobStep = ProvisionJobStep & {
  startedAt?: string | null;
  finishedAt?: string | null;
};

const TWO_COLUMN_LAYOUT = {
  display: 'grid',
  gap: '1.5rem',
  gridTemplateColumns: 'minmax(0, 1.2fr) minmax(22rem, 1fr)',
  alignItems: 'start',
} as const;

function isUnauthorizedError(error: unknown) {
  return error instanceof AdminApiError && error.status === 401;
}

function getJobLabel(jobType: string) {
  if (jobType === 'create') {
    return '创建';
  }

  if (jobType === 'destroy') {
    return '销毁';
  }

  return jobType;
}

function getStatusLabel(status: string) {
  if (status === 'running') {
    return '运行中';
  }

  if (status === 'failed') {
    return '失败';
  }

  if (status === 'succeeded') {
    return '成功';
  }

  if (status === 'pending') {
    return '处理中';
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

function getResolvedSignal(step: ExtendedProvisionJobStep) {
  return step.message ?? step.stderrExcerpt ?? step.stdoutExcerpt ?? step.status;
}

function getParsedInsights(job: ExtendedProvisionJob, steps: ExtendedProvisionJobStep[]) {
  const insights = new Set<string>();

  if (job.errorSummary) {
    insights.add(`失败原因：${job.errorSummary}`);
  }

  for (const step of steps) {
    if (step.message) {
      insights.add(`消息：${step.message}`);
    }

    const ipMatch = (step.stdoutExcerpt ?? step.stderrExcerpt ?? '').match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/);
    if (ipMatch) {
      insights.add(`入口 IP：${ipMatch[0]}`);
    }
  }

  return Array.from(insights);
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

export function ProvisionJobsScreen({
  apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3001',
}: ProvisionJobsScreenProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const session = useAdminSession();
  const [snapshot, setSnapshot] = useState<AdminBootstrapData | null>(null);
  const [selectedJob, setSelectedJob] = useState<ExtendedProvisionJob | null>(null);
  const [selectedSteps, setSelectedSteps] = useState<ExtendedProvisionJobStep[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);
  const detailRequestIdRef = useRef(0);

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

  const jobs = useMemo(() => {
    return (snapshot?.provisionJobs ?? []) as ExtendedProvisionJob[];
  }, [snapshot]);
  const instancesById = useMemo(() => {
    return new Map((snapshot?.rangeInstances ?? []).map((instance) => [instance.id, instance]));
  }, [snapshot]);

  useEffect(() => {
    const targetJobId = searchParams.get('jobId');

    if (!targetJobId || !session.token || !jobs.some((job) => job.id === targetJobId) || selectedJob?.id === targetJobId) {
      return;
    }

    void handleViewDetail(targetJobId);
  }, [apiBaseUrl, jobs, searchParams, selectedJob?.id, session.token]);

  async function handleViewDetail(jobId: string) {
    if (!session.token) {
      return;
    }

    const requestId = detailRequestIdRef.current + 1;
    detailRequestIdRef.current = requestId;
    setErrorMessage(null);
    setIsLoadingDetail(true);

    try {
      const detail = await fetchProvisionJobDetail(apiBaseUrl, session.token, jobId);

      if (detailRequestIdRef.current !== requestId) {
        return;
      }

      setSelectedJob(detail.job as ExtendedProvisionJob);
      setSelectedSteps(detail.steps as ExtendedProvisionJobStep[]);
    } catch (error: unknown) {
      if (detailRequestIdRef.current !== requestId) {
        return;
      }

      if (isUnauthorizedError(error)) {
        session.logout();
        router.replace('/admin/login');
        return;
      }

      setErrorMessage('任务详情加载失败，请稍后重试。');
    } finally {
      if (detailRequestIdRef.current === requestId) {
        setIsLoadingDetail(false);
      }
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

  const parsedInsights = selectedJob ? getParsedInsights(selectedJob, selectedSteps) : [];
  const currentStep = selectedSteps.find((step) => step.status === 'running' || !step.finishedAt) ?? selectedSteps[0] ?? null;
  const selectedInstance = selectedJob ? instancesById.get(selectedJob.rangeInstanceId) : null;

  return (
    <div className="admin-screen">
      <section className="admin-hero">
        <p className="auth-eyebrow">后台二级页</p>
        <h1>编排任务</h1>
        <p className="admin-description">保持任务列表与步骤详情并列，便于从失败摘要快速钻取到时间线和标准输出。</p>
      </section>

      {errorMessage ? <p className="admin-error">{errorMessage}</p> : null}

      <section style={TWO_COLUMN_LAYOUT}>
        <article className="admin-panel">
          <div className="admin-section-header">
            <h2>任务列表</h2>
            <span>{jobs.length} 个任务</span>
          </div>

          {jobs.length ? (
            <ul className="admin-list">
                {jobs.map((job) => (
                  <li key={job.id}>
                    <div className="admin-list-copy">
                      <strong>{job.id}</strong>
                      <span>任务类型：{getJobLabel(job.jobType)}</span>
                      <span>关联实例：{job.rangeInstanceId}</span>
                      <span>恢复分类：{getRecoveryCategoryLabel(instancesById.get(job.rangeInstanceId)?.recoverySummary?.category)}</span>
                      <span>触发人：{job.triggeredBy}</span>
                      <span>开始时间：{formatDateTime(job.startedAt)}</span>
                      <span>当前状态：{getStatusLabel(job.status)}</span>
                    <span>失败摘要：{job.errorSummary ?? '无'}</span>
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
            <h2>任务详情</h2>
            <span>{selectedJob?.id ?? '未选择'}</span>
          </div>

          {isLoadingDetail ? (
            <p className="admin-empty">正在加载任务详情...</p>
          ) : selectedJob ? (
            <>
              <div className="admin-list-copy">
                <strong>任务概览</strong>
                <span>任务类型：{getJobLabel(selectedJob.jobType)}</span>
                <span>关联实例：{selectedJob.rangeInstanceId}</span>
                <span>恢复分类：{getRecoveryCategoryLabel(selectedInstance?.recoverySummary?.category)}</span>
                <span>触发人：{selectedJob.triggeredBy}</span>
                <span>开始时间：{formatDateTime(selectedJob.startedAt)}</span>
                <span>当前状态：{getStatusLabel(selectedJob.status)}</span>
                <span>失败摘要：{selectedJob.errorSummary ?? '无'}</span>
                <span>当前步骤：{currentStep ? currentStep.stepName : '暂无'}</span>
              </div>

              <div className="admin-list-copy" style={{ marginTop: '1rem' }}>
                <strong>已解析出的关键信息</strong>
                {parsedInsights.length ? parsedInsights.map((item) => <span key={item}>{item}</span>) : <span>暂无关键信息。</span>}
              </div>

              <div className="admin-list-copy" style={{ marginTop: '1rem' }}>
                <strong>步骤日志</strong>
                <span>时间线视图</span>
              </div>

              {selectedSteps.length ? (
                <ul className="admin-list">
                  {selectedSteps.map((step) => (
                    <li key={step.id}>
                      <div className="admin-list-copy">
                        <strong>{step.stepName}</strong>
                        <span>状态：{getStatusLabel(step.status)}</span>
                        <span>开始：{formatDateTime(step.startedAt)}</span>
                        <span>结束：{formatDateTime(step.finishedAt)}</span>
                        <span>消息：{step.message ?? '暂无'}</span>
                        <span>标准输出摘要：{step.stdoutExcerpt ?? '暂无'}</span>
                        <span>标准错误摘要：{step.stderrExcerpt ?? '暂无'}</span>
                        <span>解析结果：{getResolvedSignal(step)}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="admin-empty">当前任务还没有步骤日志。</p>
              )}
            </>
          ) : (
            <p className="admin-empty">请选择一个任务查看时间线、输出摘要和解析信息。</p>
          )}
        </article>
      </section>
    </div>
  );
}
