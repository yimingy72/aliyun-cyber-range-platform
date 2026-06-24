'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

import { AdminApiError, fetchAdminBootstrap, fetchCloudConfig } from '../../../lib/admin-api';
import type { AdminBootstrapData, CloudConfigSnapshot } from '../../../lib/admin-types';
import { useAdminSession } from '../use-admin-session';
import { CloudConfigPanel } from './cloud-config-panel';
import { CompetitionsPanel } from './competitions-panel';
import { TeamsPanel } from './teams-panel';
import { TemplatesPanel } from './templates-panel';

type SettingsScreenProps = {
  apiBaseUrl?: string;
};

const tabs = ['比赛', '队伍', '模板', '云配置'] as const;

const TAB_STRIP_STYLE = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '0.75rem',
  marginBottom: '1.5rem',
} as const;

const TAB_STYLE = {
  border: '1px solid rgba(24, 44, 74, 0.14)',
  borderRadius: '999px',
  background: '#ffffff',
  color: '#0f2038',
  padding: '0.7rem 1.1rem',
  cursor: 'pointer',
} as const;

const ACTIVE_TAB_STYLE = {
  ...TAB_STYLE,
  background: '#0f2038',
  color: '#ffffff',
  borderColor: '#0f2038',
} as const;

function isUnauthorizedError(error: unknown) {
  return error instanceof AdminApiError && error.status === 401;
}

export function SettingsScreen({
  apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3001',
}: SettingsScreenProps) {
  const router = useRouter();
  const session = useAdminSession();
  const [activeTab, setActiveTab] = useState<(typeof tabs)[number]>('比赛');
  const [snapshot, setSnapshot] = useState<AdminBootstrapData | null>(null);
  const [cloudConfig, setCloudConfig] = useState<CloudConfigSnapshot | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!session.isReady) {
      return;
    }

    if (!session.token) {
      setSnapshot(null);
      setCloudConfig(null);
      setErrorMessage(null);
      setIsLoading(false);
      return;
    }

    let isActive = true;

    setSnapshot(null);
    setCloudConfig(null);
    setErrorMessage(null);
    setIsLoading(true);

    void Promise.all([fetchAdminBootstrap(apiBaseUrl, session.token), fetchCloudConfig(apiBaseUrl, session.token)])
      .then(([bootstrapPayload, cloudConfigPayload]) => {
        if (!isActive) {
          return;
        }

        setSnapshot(bootstrapPayload);
        setCloudConfig(cloudConfigPayload);
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

        setErrorMessage('基础配置加载失败，请刷新页面后重试。');
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

  if (isLoading && !snapshot && !cloudConfig) {
    return (
      <main className="admin-shell">
        <section className="admin-panel admin-login-panel">
          <h2>正在加载基础配置...</h2>
          <p className="admin-empty">请稍候，正在拉取比赛、队伍、模板与云配置快照。</p>
        </section>
      </main>
    );
  }

  return (
    <div className="admin-screen">
      <section className="admin-hero">
        <p className="auth-eyebrow">后台二级页</p>
        <h1>基础配置</h1>
        <p className="admin-description">把比赛、队伍、模板与云配置集中到一个页内工作台中管理。</p>
      </section>

      {errorMessage ? <p className="admin-error">{errorMessage}</p> : null}

      <div role="tablist" aria-label="基础配置标签" style={TAB_STRIP_STYLE}>
        {tabs.map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={activeTab === tab}
            aria-controls={`settings-panel-${tab}`}
            id={`settings-tab-${tab}`}
            onClick={() => setActiveTab(tab)}
            style={activeTab === tab ? ACTIVE_TAB_STYLE : TAB_STYLE}
          >
            {tab}
          </button>
        ))}
      </div>

      <div id={`settings-panel-${activeTab}`} role="tabpanel" aria-labelledby={`settings-tab-${activeTab}`}>
        {activeTab === '比赛' ? <CompetitionsPanel competitions={snapshot?.competitions ?? []} /> : null}
        {activeTab === '队伍' ? <TeamsPanel teams={snapshot?.teams ?? []} /> : null}
        {activeTab === '模板' ? <TemplatesPanel templates={snapshot?.rangeTemplates ?? []} /> : null}
        {activeTab === '云配置' ? <CloudConfigPanel config={cloudConfig} /> : null}
      </div>
    </div>
  );
}
