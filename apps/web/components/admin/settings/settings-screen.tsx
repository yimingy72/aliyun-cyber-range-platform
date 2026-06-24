'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

import { createDefaultEnterpriseTopologySpec, DEFAULT_TEMPLATE_MODULE_PATH } from '../../../lib/admin-template-defaults';
import {
  AdminApiError,
  createCompetition,
  createRangeTemplate,
  createTeam,
  deleteCompetition,
  deleteRangeTemplate,
  deleteTeam,
  fetchAdminBootstrap,
  fetchCloudConfig,
  updateCompetition,
  updateRangeTemplate,
  updateTeam,
} from '../../../lib/admin-api';
import type {
  AdminBootstrapData,
  CloudConfigSnapshot,
  Competition,
  CompetitionInput,
  RangeTemplate,
  RangeTemplateCreateInput,
  RangeTemplateUpdateInput,
  Team,
  TeamInput,
} from '../../../lib/admin-types';
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
  borderWidth: '1px',
  borderStyle: 'solid',
  borderColor: 'rgba(24, 44, 74, 0.14)',
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
  const [bootstrapErrorMessage, setBootstrapErrorMessage] = useState<string | null>(null);
  const [cloudConfigErrorMessage, setCloudConfigErrorMessage] = useState<string | null>(null);
  const [actionErrorMessage, setActionErrorMessage] = useState<string | null>(null);
  const [isLoadingBootstrap, setIsLoadingBootstrap] = useState(false);
  const [isLoadingCloudConfig, setIsLoadingCloudConfig] = useState(false);

  useEffect(() => {
    if (!session.isReady) {
      return;
    }

    if (!session.token) {
      setSnapshot(null);
      setCloudConfig(null);
      setBootstrapErrorMessage(null);
      setCloudConfigErrorMessage(null);
      setActionErrorMessage(null);
      setIsLoadingBootstrap(false);
      setIsLoadingCloudConfig(false);
      return;
    }

    let isActive = true;

    setBootstrapErrorMessage(null);
    setCloudConfigErrorMessage(null);
    setActionErrorMessage(null);
    setIsLoadingBootstrap(true);
    setIsLoadingCloudConfig(true);

    fetchAdminBootstrap(apiBaseUrl, session.token)
      .then((bootstrapPayload) => {
        if (!isActive) {
          return;
        }

        setSnapshot(bootstrapPayload);
        setBootstrapErrorMessage(null);
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

        setBootstrapErrorMessage('基础配置加载失败，请刷新页面后重试。');
      })
      .finally(() => {
        if (!isActive) {
          return;
        }

        setIsLoadingBootstrap(false);
      });

    fetchCloudConfig(apiBaseUrl, session.token)
      .then((cloudConfigPayload) => {
        if (!isActive) {
          return;
        }

        setCloudConfig(cloudConfigPayload);
        setCloudConfigErrorMessage(null);
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

        setCloudConfigErrorMessage('云配置加载失败，请稍后重试。');
      })
      .finally(() => {
        if (!isActive) {
          return;
        }

        setIsLoadingCloudConfig(false);
      });

    return () => {
      isActive = false;
    };
  }, [apiBaseUrl, router, session.isReady, session.token]);

  function upsertCompetitionInSnapshot(savedCompetition: Competition) {
    setSnapshot((previous) => {
      if (!previous) {
        return previous;
      }

      const alreadyExists = previous.competitions.some((competition) => competition.id === savedCompetition.id);

      return {
        ...previous,
        competitions: alreadyExists
          ? previous.competitions.map((competition) =>
              competition.id === savedCompetition.id ? savedCompetition : competition,
            )
          : [savedCompetition, ...previous.competitions],
      };
    });
  }

  function upsertTeamInSnapshot(savedTeam: Team) {
    setSnapshot((previous) => {
      if (!previous) {
        return previous;
      }

      const alreadyExists = previous.teams.some((team) => team.id === savedTeam.id);

      return {
        ...previous,
        teams: alreadyExists ? previous.teams.map((team) => (team.id === savedTeam.id ? savedTeam : team)) : [savedTeam, ...previous.teams],
      };
    });
  }

  function upsertTemplateInSnapshot(savedTemplate: RangeTemplate) {
    setSnapshot((previous) => {
      if (!previous) {
        return previous;
      }

      const alreadyExists = previous.rangeTemplates.some((template) => template.id === savedTemplate.id);

      return {
        ...previous,
        rangeTemplates: alreadyExists
          ? previous.rangeTemplates.map((template) => (template.id === savedTemplate.id ? savedTemplate : template))
          : [savedTemplate, ...previous.rangeTemplates],
      };
    });
  }

  function handleProtectedActionError(error: unknown, fallbackMessage: string): never {
    if (isUnauthorizedError(error)) {
      session.logout();
      router.replace('/admin/login');
      throw error;
    }

    setActionErrorMessage(fallbackMessage);
    throw error;
  }

  async function handleCreateCompetition(payload: CompetitionInput): Promise<Competition> {
    if (!session.token) {
      throw new Error('admin session missing');
    }

    setActionErrorMessage(null);

    try {
      const savedCompetition = await createCompetition(apiBaseUrl, session.token, payload);
      upsertCompetitionInSnapshot(savedCompetition);
      return savedCompetition;
    } catch (error: unknown) {
      return handleProtectedActionError(error, '比赛保存失败，请检查输入后重试。');
    }
  }

  async function handleUpdateCompetition(id: string, payload: CompetitionInput): Promise<Competition> {
    if (!session.token) {
      throw new Error('admin session missing');
    }

    setActionErrorMessage(null);

    try {
      const savedCompetition = await updateCompetition(apiBaseUrl, session.token, id, payload);
      upsertCompetitionInSnapshot(savedCompetition);
      return savedCompetition;
    } catch (error: unknown) {
      return handleProtectedActionError(error, '比赛保存失败，请检查输入后重试。');
    }
  }

  async function handleDeleteCompetition(id: string) {
    if (!session.token) {
      throw new Error('admin session missing');
    }

    setActionErrorMessage(null);

    try {
      await deleteCompetition(apiBaseUrl, session.token, id);
      setSnapshot((previous) => {
        if (!previous) {
          return previous;
        }

        return {
          ...previous,
          competitions: previous.competitions.filter((competition) => competition.id !== id),
          teams: previous.teams.filter((team) => team.competitionId !== id),
        };
      });
    } catch (error: unknown) {
      handleProtectedActionError(error, '比赛删除失败，请稍后重试。');
    }
  }

  async function handleCreateTeam(payload: TeamInput): Promise<Team> {
    if (!session.token) {
      throw new Error('admin session missing');
    }

    setActionErrorMessage(null);

    try {
      const savedTeam = await createTeam(apiBaseUrl, session.token, payload);
      upsertTeamInSnapshot(savedTeam);
      return savedTeam;
    } catch (error: unknown) {
      return handleProtectedActionError(error, '队伍保存失败，请检查输入后重试。');
    }
  }

  async function handleUpdateTeam(id: string, payload: TeamInput): Promise<Team> {
    if (!session.token) {
      throw new Error('admin session missing');
    }

    setActionErrorMessage(null);

    try {
      const savedTeam = await updateTeam(apiBaseUrl, session.token, id, payload);
      upsertTeamInSnapshot(savedTeam);
      return savedTeam;
    } catch (error: unknown) {
      return handleProtectedActionError(error, '队伍保存失败，请检查输入后重试。');
    }
  }

  async function handleDeleteTeam(id: string) {
    if (!session.token) {
      throw new Error('admin session missing');
    }

    setActionErrorMessage(null);

    try {
      await deleteTeam(apiBaseUrl, session.token, id);
      setSnapshot((previous) => {
        if (!previous) {
          return previous;
        }

        return {
          ...previous,
          teams: previous.teams.filter((team) => team.id !== id),
        };
      });
    } catch (error: unknown) {
      handleProtectedActionError(error, '队伍删除失败，请稍后重试。');
    }
  }

  async function handleCreateTemplate(payload: {
    name: string;
    slug: string;
    version: string;
    modulePathOrRef: string;
  }): Promise<RangeTemplate> {
    if (!session.token) {
      throw new Error('admin session missing');
    }

    setActionErrorMessage(null);

    try {
      const createPayload: RangeTemplateCreateInput = {
        ...payload,
        modulePathOrRef: payload.modulePathOrRef || DEFAULT_TEMPLATE_MODULE_PATH,
        cloudProvider: 'alibaba_cloud',
        iacType: 'opentofu',
        topologySpec: createDefaultEnterpriseTopologySpec(),
        variableSchema: {
          vpc_cidr: 'string',
        },
        outputSchema: {
          public_entry: 'object',
        },
      };
      const savedTemplate = await createRangeTemplate(apiBaseUrl, session.token, createPayload);
      upsertTemplateInSnapshot(savedTemplate);
      return savedTemplate;
    } catch (error: unknown) {
      return handleProtectedActionError(error, '模板保存失败，请检查输入后重试。');
    }
  }

  async function handleUpdateTemplate(id: string, payload: RangeTemplateUpdateInput): Promise<RangeTemplate> {
    if (!session.token) {
      throw new Error('admin session missing');
    }

    setActionErrorMessage(null);

    try {
      const savedTemplate = await updateRangeTemplate(apiBaseUrl, session.token, id, payload);
      upsertTemplateInSnapshot(savedTemplate);
      return savedTemplate;
    } catch (error: unknown) {
      return handleProtectedActionError(error, '模板保存失败，请检查输入后重试。');
    }
  }

  async function handleDeleteTemplate(id: string) {
    if (!session.token) {
      throw new Error('admin session missing');
    }

    setActionErrorMessage(null);

    try {
      await deleteRangeTemplate(apiBaseUrl, session.token, id);
      setSnapshot((previous) => {
        if (!previous) {
          return previous;
        }

        return {
          ...previous,
          rangeTemplates: previous.rangeTemplates.filter((template) => template.id !== id),
        };
      });
    } catch (error: unknown) {
      handleProtectedActionError(error, '模板删除失败，请稍后重试。');
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

  if (!snapshot && isLoadingBootstrap) {
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

      {bootstrapErrorMessage ? <p className="admin-error">{bootstrapErrorMessage}</p> : null}
      {actionErrorMessage ? <p className="admin-error">{actionErrorMessage}</p> : null}

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
        {activeTab === '比赛' ? (
          <CompetitionsPanel
            competitions={snapshot?.competitions ?? []}
            onCreate={handleCreateCompetition}
            onUpdate={handleUpdateCompetition}
            onDelete={handleDeleteCompetition}
          />
        ) : null}
        {activeTab === '队伍' ? (
          <TeamsPanel
            teams={snapshot?.teams ?? []}
            competitions={snapshot?.competitions ?? []}
            onCreate={handleCreateTeam}
            onUpdate={handleUpdateTeam}
            onDelete={handleDeleteTeam}
          />
        ) : null}
        {activeTab === '模板' ? (
          <TemplatesPanel
            templates={snapshot?.rangeTemplates ?? []}
            onCreate={handleCreateTemplate}
            onUpdate={handleUpdateTemplate}
            onDelete={handleDeleteTemplate}
          />
        ) : null}
        {activeTab === '云配置' ? (
          <>
            {cloudConfigErrorMessage ? <p className="admin-error">{cloudConfigErrorMessage}</p> : null}
            <CloudConfigPanel config={cloudConfig} />
          </>
        ) : null}
      </div>
    </div>
  );
}
