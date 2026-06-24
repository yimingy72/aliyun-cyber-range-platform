'use client';

import { useEffect, useState } from 'react';

import { fetchAdminBootstrap } from '../../lib/admin-api';
import type { AdminBootstrapData, ProvisionJob } from '../../lib/admin-types';
import { useAdminSession } from './use-admin-session';

type OverviewScreenProps = {
  apiBaseUrl?: string;
};

function getJobLabel(jobType: ProvisionJob['jobType']) {
  if (jobType === 'create') {
    return '创建任务';
  }

  if (jobType === 'destroy') {
    return '销毁任务';
  }

  return `${jobType} 任务`;
}

export function OverviewScreen({
  apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3001',
}: OverviewScreenProps) {
  const { token } = useAdminSession();
  const [snapshot, setSnapshot] = useState<AdminBootstrapData | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      return;
    }

    let isActive = true;

    setErrorMessage(null);

    fetchAdminBootstrap(apiBaseUrl, token)
      .then((payload) => {
        if (!isActive) {
          return;
        }

        setSnapshot(payload);
      })
      .catch(() => {
        if (!isActive) {
          return;
        }

        setErrorMessage('靶场总览加载失败，请刷新页面后重试。');
      });

    return () => {
      isActive = false;
    };
  }, [apiBaseUrl, token]);

  const runningCount = snapshot?.rangeInstances.filter((item) => item.status === 'running').length ?? 0;
  const runningJobsCount = snapshot?.provisionJobs.filter((item) => item.status === 'running').length ?? 0;
  const failedCount =
    snapshot?.rangeInstances.filter((item) => item.status.includes('failed') || item.errorSummary).length ?? 0;
  const failingInstances =
    snapshot?.rangeInstances.filter((item) => item.status.includes('failed') || item.errorSummary).slice(0, 5) ?? [];
  const recentJobs = snapshot?.provisionJobs.slice(0, 5) ?? [];

  return (
    <div className="admin-screen">
      <section className="admin-hero">
        <p className="auth-eyebrow">后台首页</p>
        <h1>靶场总览</h1>
        <p className="admin-description">登录后的第一屏优先展示实例状态、任务状态、公网入口与失败排障信息。</p>
      </section>

      {errorMessage ? <p className="admin-error">{errorMessage}</p> : null}

      <section className="admin-grid">
        <article className="admin-panel">
          <div className="admin-section-header">
            <h2>运行中靶场</h2>
            <span>运行态</span>
          </div>
          <p className="admin-description">{runningCount}</p>
        </article>

        <article className="admin-panel">
          <div className="admin-section-header">
            <h2>创建中任务</h2>
            <span>编排中</span>
          </div>
          <p className="admin-description">{runningJobsCount}</p>
        </article>

        <article className="admin-panel">
          <div className="admin-section-header">
            <h2>失败实例</h2>
            <span>异常告警</span>
          </div>
          <p className="admin-description">{failedCount}</p>
        </article>

        <article className="admin-panel">
          <div className="admin-section-header">
            <h2>模板数量</h2>
            <span>模板库</span>
          </div>
          <p className="admin-description">{snapshot?.rangeTemplates.length ?? 0}</p>
        </article>

        <article className="admin-panel">
          <div className="admin-section-header">
            <h2>最近任务</h2>
            <span>最近编排</span>
          </div>

          {recentJobs.length ? (
            <ul className="admin-list">
              {recentJobs.map((job) => (
                <li key={job.id}>
                  <div className="admin-list-copy">
                    <strong>{getJobLabel(job.jobType)}</strong>
                    <span>状态：{job.status}</span>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="admin-empty">暂无编排任务。</p>
          )}
        </article>

        <article className="admin-panel">
          <div className="admin-section-header">
            <h2>异常实例</h2>
            <span>故障定位</span>
          </div>

          {failingInstances.length ? (
            <ul className="admin-list">
              {failingInstances.map((instance) => (
                <li key={instance.id}>
                  <div className="admin-list-copy">
                    <strong>{instance.id}</strong>
                    <span>{instance.errorSummary ?? `状态：${instance.status}`}</span>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="admin-empty">当前没有异常实例。</p>
          )}
        </article>
      </section>
    </div>
  );
}
