'use client';

import React from 'react';
import { type MouseEvent, type ReactNode, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';

import {
  AdminApiError,
  cloneRangeTemplate,
  createRangeTemplate,
  deleteRangeTemplate,
  fetchAdminBootstrap,
  launchRangeInstance,
  publishRangeTemplate,
  unpublishRangeTemplate,
  updateRangeTemplate,
} from '../../lib/admin-api';
import { createDefaultEnterpriseTopologySpec, DEFAULT_TEMPLATE_MODULE_PATH } from '../../lib/admin-template-defaults';
import type {
  AdminBootstrapData,
  Scenario,
  ScenarioCreateInput,
  ScenarioUpdateInput,
} from '../../lib/admin-types';
import { useAdminSession } from './use-admin-session';

type TemplatesScreenProps = {
  apiBaseUrl?: string;
};

type TemplateDraft = {
  name: string;
  slug: string;
  version: string;
  description: string;
  modulePathOrRef: string;
  defaultRegion: string;
};

type CreateTemplateDraft = {
  name: string;
  description: string;
};

type LaunchInstanceDraft = {
  templateId: string;
  templateName: string;
  name: string;
  expiresAt: string;
};

type TemplateStatusFilter = 'all' | 'published' | 'draft';
type TemplateConfirmState =
  | {
      type: 'delete' | 'unpublish';
      template: Scenario;
    }
  | null;

const EMPTY_TEMPLATE_DRAFT: TemplateDraft = {
  name: '',
  slug: '',
  version: 'v1',
  description: '',
  modulePathOrRef: DEFAULT_TEMPLATE_MODULE_PATH,
  defaultRegion: 'cn-hangzhou',
};

const EMPTY_CREATE_TEMPLATE_DRAFT: CreateTemplateDraft = {
  name: '',
  description: '',
};

const EMPTY_LAUNCH_INSTANCE_DRAFT: LaunchInstanceDraft = {
  templateId: '',
  templateName: '',
  name: '',
  expiresAt: '',
};

function isUnauthorizedError(error: unknown) {
  return error instanceof AdminApiError && error.status === 401;
}

function readNodeCount(scenario: Scenario) {
  const graph = scenario.currentDraftVersion?.topologyGraph;

  if (!graph || typeof graph !== 'object') {
    return 0;
  }

  const nodes = 'nodes' in graph ? graph.nodes : null;
  return Array.isArray(nodes) ? nodes.length : 0;
}

function readZoneCount(scenario: Scenario) {
  const zones = scenario.currentDraftVersion?.topologySpec?.networkZones;
  return Array.isArray(zones) ? zones.length : 0;
}

function readHostCount(scenario: Scenario) {
  const hosts = scenario.currentDraftVersion?.topologySpec?.hosts;
  return Array.isArray(hosts) ? hosts.length : 0;
}

function getScenarioDisplayName(scenario: Scenario) {
  return scenario.name?.trim() || scenario.slug;
}

function getScenarioDescription(scenario: Scenario) {
  return (scenario as Scenario & { description?: string | null }).description?.trim() || '暂无描述';
}

function readPublishedLabel(scenario: Scenario) {
  return scenario.currentPublishedVersion ? '已发布' : '草稿';
}

function buildClonedSlug(sourceSlug: string, existingScenarios: Scenario[]) {
  const normalizedSlug = `${sourceSlug}-copy`;
  const existingSlugs = new Set(existingScenarios.map((scenario) => scenario.slug));

  if (!existingSlugs.has(normalizedSlug)) {
    return normalizedSlug;
  }

  let suffix = 2;

  while (existingSlugs.has(`${normalizedSlug}-${suffix}`)) {
    suffix += 1;
  }

  return `${normalizedSlug}-${suffix}`;
}

function buildGeneratedSlug(name: string, existingScenarios: Scenario[]) {
  const normalizedBase =
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'scenario';
  const existingSlugs = new Set(existingScenarios.map((scenario) => scenario.slug));

  if (!existingSlugs.has(normalizedBase)) {
    return normalizedBase;
  }

  let suffix = 2;

  while (existingSlugs.has(`${normalizedBase}-${suffix}`)) {
    suffix += 1;
  }

  return `${normalizedBase}-${suffix}`;
}

function buildCreatePayload(payload: TemplateDraft): ScenarioCreateInput {
  return {
    name: payload.name,
    slug: payload.slug,
    version: payload.version,
    description: payload.description,
    modulePathOrRef: payload.modulePathOrRef || DEFAULT_TEMPLATE_MODULE_PATH,
    cloudProvider: 'alibaba_cloud',
    iacType: 'opentofu',
    topologySpec: createDefaultEnterpriseTopologySpec(),
    variableSchema: {
      vpc_cidr: 'string',
      default_region: payload.defaultRegion,
    },
    outputSchema: {
      public_entry: 'object',
    },
  };
}

function buildRangeInstanceName(template: Scenario) {
  return `${getScenarioDisplayName(template)} 实例`;
}

function isPublishedScenario(scenario: Scenario) {
  return Boolean(scenario.currentPublishedVersionId);
}

function TemplateDialog({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="template-workbench-dialog-backdrop" role="presentation">
      <section className="template-workbench-dialog" role="dialog" aria-modal="true" aria-label={title}>
        <div className="template-workbench-dialog-header">
          <div>
            <h2>{title}</h2>
          </div>
        </div>
        {children}
      </section>
    </div>
  );
}

export function TemplatesScreen({
  apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3001',
}: TemplatesScreenProps) {
  const router = useRouter();
  const session = useAdminSession();
  const [snapshot, setSnapshot] = useState<AdminBootstrapData | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [actionErrorMessage, setActionErrorMessage] = useState<string | null>(null);
  const [actionSuccessMessage, setActionSuccessMessage] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [editingTemplateId, setEditingTemplateId] = useState<string | null>(null);
  const [menuTemplateId, setMenuTemplateId] = useState<string | null>(null);
  const [confirmState, setConfirmState] = useState<TemplateConfirmState>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [searchName, setSearchName] = useState('');
  const [statusFilter, setStatusFilter] = useState<TemplateStatusFilter>('all');
  const [createDraft, setCreateDraft] = useState<CreateTemplateDraft>(EMPTY_CREATE_TEMPLATE_DRAFT);
  const [editDraft, setEditDraft] = useState<TemplateDraft>(EMPTY_TEMPLATE_DRAFT);
  const [launchDraft, setLaunchDraft] = useState<LaunchInstanceDraft>(EMPTY_LAUNCH_INSTANCE_DRAFT);

  useEffect(() => {
    if (!session.isReady) {
      return;
    }

    if (!session.token) {
      setSnapshot(null);
      setErrorMessage(null);
      setActionErrorMessage(null);
      setActionSuccessMessage(null);
      setIsLoading(false);
      return;
    }

    let isActive = true;

    setSnapshot(null);
    setErrorMessage(null);
    setActionErrorMessage(null);
    setActionSuccessMessage(null);
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

      setErrorMessage('靶场编排加载失败，请刷新页面后重试。');
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
  }, [apiBaseUrl, session.isReady, session.token]);

  const scenarios = snapshot?.scenarios ?? snapshot?.rangeTemplates ?? [];
  const publishedCount = useMemo(
    () => scenarios.filter((scenario) => isPublishedScenario(scenario)).length,
    [scenarios],
  );
  const draftCount = scenarios.length - publishedCount;
  const totalNodeCount = useMemo(() => scenarios.reduce((sum, scenario) => sum + readNodeCount(scenario), 0), [scenarios]);

  const filteredTemplates = useMemo(() => {
    return scenarios.filter((scenario) => {
      const displayName = getScenarioDisplayName(scenario).toLowerCase();
      const matchesName = searchName.trim().length === 0 || displayName.includes(searchName.trim().toLowerCase());
      const matchesStatus =
        statusFilter === 'all' ? true : statusFilter === 'published' ? isPublishedScenario(scenario) : !isPublishedScenario(scenario);

      return matchesName && matchesStatus;
    });
  }, [searchName, statusFilter, scenarios]);

  const editingTemplate = useMemo(
    () => scenarios.find((scenario) => scenario.id === editingTemplateId) ?? null,
    [editingTemplateId, scenarios],
  );

  function upsertTemplateInSnapshot(savedScenario: Scenario) {
    setSnapshot((previous) => {
      if (!previous) {
        return previous;
      }

      const currentScenarios = previous.scenarios ?? previous.rangeTemplates;
      const alreadyExists = currentScenarios.some((scenario) => scenario.id === savedScenario.id);

      return {
        ...previous,
        scenarios: alreadyExists
          ? currentScenarios.map((scenario) => (scenario.id === savedScenario.id ? savedScenario : scenario))
          : [savedScenario, ...currentScenarios],
        rangeTemplates: alreadyExists
          ? previous.rangeTemplates.map((scenario) => (scenario.id === savedScenario.id ? savedScenario : scenario))
          : [savedScenario, ...previous.rangeTemplates],
      };
    });
  }

  function handleProtectedActionError(error: unknown, fallbackMessage: string): never {
    if (isUnauthorizedError(error)) {
      session.logout();
      router.replace('/admin/login');
      throw error;
    }

    const nextMessage =
      error instanceof AdminApiError || error instanceof Error
        ? error.message || fallbackMessage
        : fallbackMessage;

    setActionErrorMessage(nextMessage);
    throw error instanceof Error ? error : new Error(fallbackMessage);
  }

  function getDeleteTemplateConflictMessage(error: unknown) {
    if (error instanceof AdminApiError && error.status === 409) {
      return '当前模板仍有关联的未销毁实例，请先销毁这些实例后再删除模板。已销毁实例历史会继续保留。';
    }

    return null;
  }

  function handleScreenClickCapture(event: MouseEvent<HTMLDivElement>) {
    if (!actionSuccessMessage) {
      return;
    }

    if (event.target instanceof Element && event.target.closest('button')) {
      setActionSuccessMessage(null);
    }
  }

  function closeCreateDialog() {
    setIsCreateDialogOpen(false);
    setCreateDraft(EMPTY_CREATE_TEMPLATE_DRAFT);
  }

  function openEditDialog(scenario: Scenario) {
    setEditingTemplateId(scenario.id);
    setMenuTemplateId(null);
    setEditDraft({
      name: scenario.name?.trim() || scenario.slug,
      slug: scenario.slug,
      version: scenario.version,
      description: getScenarioDescription(scenario) === '暂无描述' ? '' : getScenarioDescription(scenario),
      modulePathOrRef: scenario.modulePathOrRef?.trim() || DEFAULT_TEMPLATE_MODULE_PATH,
      defaultRegion: 'cn-hangzhou',
    });
  }

  function closeEditDialog() {
    setEditingTemplateId(null);
    setEditDraft(EMPTY_TEMPLATE_DRAFT);
  }

  function openLaunchDialog(template: Scenario) {
    setMenuTemplateId(null);
    setLaunchDraft({
      templateId: template.id,
      templateName: getScenarioDisplayName(template),
      name: buildRangeInstanceName(template),
      expiresAt: '',
    });
  }

  function closeLaunchDialog() {
    setLaunchDraft(EMPTY_LAUNCH_INSTANCE_DRAFT);
  }

  function closeConfirmDialog() {
    setConfirmState(null);
  }

  function openConfirmDialog(type: 'delete' | 'unpublish', template: Scenario) {
    setMenuTemplateId(null);
    setConfirmState({ type, template });
  }

  async function handleCreateTemplate() {
    if (!session.token) {
      throw new Error('admin session missing');
    }

    const payload = {
      name: createDraft.name.trim(),
      description: createDraft.description.trim(),
      slug: buildGeneratedSlug(createDraft.name, scenarios),
      version: 'v1',
      modulePathOrRef: DEFAULT_TEMPLATE_MODULE_PATH,
      defaultRegion: 'cn-hangzhou',
    };

    if (!payload.name) {
      setActionErrorMessage('请至少填写靶场名。');
      return;
    }

    setActionErrorMessage(null);
    setActionSuccessMessage(null);
    setIsSubmitting(true);

    try {
      const savedTemplate = await createRangeTemplate(apiBaseUrl, session.token, buildCreatePayload(payload));
      upsertTemplateInSnapshot(savedTemplate);
      closeCreateDialog();
      router.push(`/admin/scenarios/${savedTemplate.id}`);
    } catch (error: unknown) {
      handleProtectedActionError(error, '靶场编排创建失败，请检查输入后重试。');
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleUpdateTemplate(id: string) {
    if (!session.token) {
      throw new Error('admin session missing');
    }

    const payload: ScenarioUpdateInput = {
      name: editDraft.name.trim(),
      slug: editDraft.slug.trim(),
      version: editDraft.version.trim(),
      description: editDraft.description.trim(),
      modulePathOrRef: editDraft.modulePathOrRef.trim() || DEFAULT_TEMPLATE_MODULE_PATH,
    };

    setActionErrorMessage(null);
    setActionSuccessMessage(null);
    setIsSubmitting(true);

    try {
      const savedTemplate = await updateRangeTemplate(apiBaseUrl, session.token, id, payload);
      upsertTemplateInSnapshot(savedTemplate);
      closeEditDialog();
      setActionSuccessMessage('靶场信息已保存。');
    } catch (error: unknown) {
      handleProtectedActionError(error, '靶场编排保存失败，请检查输入后重试。');
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handlePublishTemplate(id: string): Promise<Scenario> {
    if (!session.token) {
      throw new Error('admin session missing');
    }

    setActionErrorMessage(null);
    setActionSuccessMessage(null);

    try {
      const savedTemplate = await publishRangeTemplate(apiBaseUrl, session.token, id);
      upsertTemplateInSnapshot(savedTemplate);
      setMenuTemplateId(null);
      setActionSuccessMessage('靶场模板已发布。');
      return savedTemplate;
    } catch (error: unknown) {
      return handleProtectedActionError(error, '靶场编排发布失败，请检查拓扑与编译结果后重试。');
    }
  }

  async function handleUnpublishTemplate(id: string): Promise<Scenario> {
    if (!session.token) {
      throw new Error('admin session missing');
    }

    setActionErrorMessage(null);
    setActionSuccessMessage(null);

    try {
      const savedTemplate = await unpublishRangeTemplate(apiBaseUrl, session.token, id);
      upsertTemplateInSnapshot(savedTemplate);
      setMenuTemplateId(null);
      closeConfirmDialog();
      setActionSuccessMessage('已取消发布。');
      return savedTemplate;
    } catch (error: unknown) {
      return handleProtectedActionError(error, '取消发布失败，请稍后重试。');
    }
  }

  async function handleDeleteTemplate(id: string): Promise<void> {
    if (!session.token) {
      throw new Error('admin session missing');
    }

    setActionErrorMessage(null);
    setActionSuccessMessage(null);

    try {
      await deleteRangeTemplate(apiBaseUrl, session.token, id);
      setSnapshot((previous) => {
        if (!previous) {
          return previous;
        }

        const nextScenarios = previous.rangeTemplates.filter((template) => template.id !== id);

        return {
          ...previous,
          scenarios: nextScenarios,
          rangeTemplates: nextScenarios,
        };
      });
      setMenuTemplateId(null);
      closeConfirmDialog();
      setActionSuccessMessage('靶场模板已删除。');
    } catch (error: unknown) {
      if (isUnauthorizedError(error)) {
        session.logout();
        router.replace('/admin/login');
        throw error;
      }

      const conflictMessage = getDeleteTemplateConflictMessage(error);
      setActionErrorMessage(conflictMessage ?? '靶场编排删除失败，请稍后重试。');
    }
  }

  async function handleCloneTemplate(scenario: Scenario) {
    if (!session.token) {
      throw new Error('admin session missing');
    }

    setActionErrorMessage(null);
    setActionSuccessMessage(null);
    setIsSubmitting(true);

    try {
      const savedTemplate = await cloneRangeTemplate(apiBaseUrl, session.token, scenario.id);
      upsertTemplateInSnapshot(savedTemplate);
      setMenuTemplateId(null);
      setActionSuccessMessage('靶场模板副本已创建。');
    } catch (error: unknown) {
      handleProtectedActionError(error, '编排复制失败，请稍后重试。');
    } finally {
      setIsSubmitting(false);
    }
  }

  function handleOpenTemplateEditor(id: string) {
    router.push(`/admin/scenarios/${id}`);
  }

  async function handleOpenGenerateInstance(template: Scenario) {
    if (!session.token) {
      throw new Error('admin session missing');
    }

    if (!template.id) {
      setActionErrorMessage('当前靶场缺少有效标识，无法生成实例。');
      return;
    }

    openLaunchDialog(template);
  }

  async function handleLaunchInstance() {
    if (!session.token) {
      throw new Error('admin session missing');
    }

    const name = launchDraft.name.trim();
    const expiresAt = launchDraft.expiresAt.trim();

    if (!name) {
      setActionErrorMessage('请填写实例名。');
      return;
    }

    if (!expiresAt) {
      setActionErrorMessage('请选择到期时间。');
      return;
    }

    setActionErrorMessage(null);
    setActionSuccessMessage(null);
    setIsSubmitting(true);

    try {
      const instance = await launchRangeInstance(apiBaseUrl, session.token, {
        templateId: launchDraft.templateId,
        name,
        expiresAt: new Date(expiresAt).toISOString(),
        triggeredBy: 'admin',
      });
      closeLaunchDialog();
      router.push(`/admin/ranges/${instance.id}`);
    } catch (error: unknown) {
      handleProtectedActionError(error, '实例生成失败，请稍后重试。');
    } finally {
      setIsSubmitting(false);
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

  if (isLoading && !snapshot) {
    return null;
  }

  return (
    <div className="admin-screen template-workbench-screen" onClickCapture={handleScreenClickCapture}>
      <h1 className="sr-only">靶场编排</h1>
      {errorMessage ? <p className="admin-error">{errorMessage}</p> : null}
      {actionErrorMessage ? <p className="admin-error">{actionErrorMessage}</p> : null}
      {actionSuccessMessage ? <p className="admin-success">{actionSuccessMessage}</p> : null}

      <section className="template-workbench-shell">
        <div className="template-workbench-list">
          <div className="template-workbench-list-header">
            <div className="template-workbench-list-header-copy">
              <h2>靶场列表</h2>
            </div>
          </div>

          <div className="template-workbench-controls">
            <div className="template-workbench-search-grid">
              <label className="template-workbench-search-field">
                <span className="sr-only">靶场名搜索</span>
                <input
                  aria-label="筛选靶场名"
                  value={searchName}
                  onChange={(event) => setSearchName(event.target.value)}
                  placeholder="搜索靶场名"
                />
              </label>
            </div>

            <div className="template-workbench-segmented" role="tablist" aria-label="靶场编排状态筛选">
              <div className="template-workbench-list-meta" aria-label="靶场编排统计">
                <span>已发布 {publishedCount}</span>
                <span>草稿 {draftCount}</span>
                <span>总节点 {totalNodeCount}</span>
              </div>

              <button type="button" aria-pressed={statusFilter === 'all'} onClick={() => setStatusFilter('all')}>
                全部编排
              </button>
              <button type="button" aria-pressed={statusFilter === 'published'} onClick={() => setStatusFilter('published')}>
                已发布
              </button>
              <button type="button" aria-pressed={statusFilter === 'draft'} onClick={() => setStatusFilter('draft')}>
                草稿中
              </button>

              <button type="button" className="template-workbench-create-button" onClick={() => setIsCreateDialogOpen(true)}>
                新建靶场
              </button>
            </div>
          </div>

          <div className="template-workbench-column-head">
            <div className="template-workbench-column-cell">
              <strong>靶场</strong>
            </div>
            <div className="template-workbench-column-cell">
              <strong>靶场描述</strong>
            </div>
            <div className="template-workbench-column-cell">
              <strong>拓扑概览</strong>
            </div>
            <div className="template-workbench-column-cell">
              <strong>状态</strong>
            </div>
            <div className="template-workbench-column-cell workbench-action-cell">
              <strong>操作</strong>
            </div>
          </div>

          {filteredTemplates.length ? (
            <div className="template-workbench-rows">
              {filteredTemplates.map((template) => {
                const menuOpen = menuTemplateId === template.id;
                const isPublished = isPublishedScenario(template);

                return (
                  <article key={template.id} className={`template-workbench-row${menuOpen ? ' is-menu-open' : ''}`}>
                    <div className="template-workbench-main">
                      <div className="template-workbench-main-top">
                        <strong>{getScenarioDisplayName(template)}</strong>
                      </div>
                    </div>

                    <div className="template-workbench-description-cell">
                      <p className="template-workbench-description">{getScenarioDescription(template)}</p>
                    </div>

                    <div className="template-workbench-topology">
                      <div className="template-workbench-metric-pills">
                        <span>区域 {readZoneCount(template)}</span>
                        <span>主机 {readHostCount(template)}</span>
                        <span>节点 {readNodeCount(template)}</span>
                      </div>
                    </div>

                    <div className="template-workbench-status">
                      <span className={isPublished ? 'template-workbench-status-pill is-published' : 'template-workbench-status-pill is-draft'}>
                        {readPublishedLabel(template)}
                      </span>
                    </div>

                    <div className="template-workbench-actions workbench-action-cell">
                      <button
                        type="button"
                        className="template-workbench-primary-action"
                        disabled={isSubmitting}
                        onClick={() => handleOpenTemplateEditor(template.id)}
                      >
                        进入编排
                      </button>

                      <div className="template-workbench-row-menu">
                        <button
                          type="button"
                          className="template-workbench-secondary-action"
                          aria-expanded={menuOpen}
                          disabled={isSubmitting}
                          onClick={() => setMenuTemplateId((previous) => (previous === template.id ? null : template.id))}
                        >
                          更多操作
                        </button>

                        {menuOpen ? (
                          <div className="template-workbench-action-menu">
                            <button type="button" onClick={() => openEditDialog(template)}>
                              编辑信息
                            </button>
                            <button type="button" onClick={() => void handleCloneTemplate(template)}>
                              复制模板
                            </button>
                            {isPublished ? (
                              <button type="button" onClick={() => openConfirmDialog('unpublish', template)}>
                                取消发布
                              </button>
                            ) : (
                              <button type="button" onClick={() => void handlePublishTemplate(template.id)}>
                                发布模板
                              </button>
                            )}
                            <button type="button" onClick={() => void handleOpenGenerateInstance(template)}>
                              生成实例
                            </button>
                            <button type="button" onClick={() => openConfirmDialog('delete', template)}>
                              删除模板
                            </button>
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="template-workbench-empty">
              <strong>当前筛选条件下没有靶场。</strong>
              <p>你可以调整筛选条件，或者直接新建靶场进入拓扑编排页。</p>
            </div>
          )}
        </div>
      </section>

      {isCreateDialogOpen ? (
        <TemplateDialog title="创建靶场">
          <div className="template-workbench-dialog-grid">
            <label>
              <span>靶场名</span>
              <input
                aria-label="靶场名"
                value={createDraft.name}
                onChange={(event) => setCreateDraft((previous) => ({ ...previous, name: event.target.value }))}
              />
            </label>
            <label>
              <span>靶场描述</span>
              <input
                aria-label="靶场描述"
                value={createDraft.description}
                onChange={(event) => setCreateDraft((previous) => ({ ...previous, description: event.target.value }))}
              />
            </label>
          </div>
          <div className="template-workbench-dialog-actions">
            <button type="button" disabled={isSubmitting} onClick={() => void handleCreateTemplate()}>
              创建并进入编排
            </button>
            <button type="button" disabled={isSubmitting} onClick={closeCreateDialog}>
              取消
            </button>
          </div>
        </TemplateDialog>
      ) : null}

      {editingTemplate ? (
        <TemplateDialog title="编辑靶场">
          <div className="template-workbench-dialog-grid">
            <label>
              <span>靶场名</span>
              <input
                aria-label="靶场名"
                value={editDraft.name}
                onChange={(event) => setEditDraft((previous) => ({ ...previous, name: event.target.value }))}
              />
            </label>
            <label>
              <span>靶场描述</span>
              <input
                aria-label="靶场描述"
                value={editDraft.description}
                onChange={(event) => setEditDraft((previous) => ({ ...previous, description: event.target.value }))}
              />
            </label>
          </div>
          <div className="template-workbench-dialog-actions">
            <button type="button" disabled={isSubmitting} onClick={() => void handleUpdateTemplate(editingTemplate.id)}>
              保存信息
            </button>
            <button type="button" disabled={isSubmitting} onClick={closeEditDialog}>
              取消编辑
            </button>
          </div>
        </TemplateDialog>
      ) : null}

      {launchDraft.templateId ? (
        <TemplateDialog title="生成实例">
          <div className="template-workbench-dialog-grid">
            <label>
              <span>实例名</span>
              <input
                aria-label="实例名"
                value={launchDraft.name}
                onChange={(event) => setLaunchDraft((previous) => ({ ...previous, name: event.target.value }))}
              />
            </label>
            <label>
              <span>到期时间</span>
              <input
                aria-label="到期时间"
                type="datetime-local"
                value={launchDraft.expiresAt}
                onChange={(event) => setLaunchDraft((previous) => ({ ...previous, expiresAt: event.target.value }))}
              />
            </label>
          </div>
          <div className="template-workbench-dialog-actions">
            <button type="button" disabled={isSubmitting} onClick={() => void handleLaunchInstance()}>
              确认生成
            </button>
            <button type="button" disabled={isSubmitting} onClick={closeLaunchDialog}>
              取消
            </button>
          </div>
        </TemplateDialog>
      ) : null}

      {confirmState?.type === 'unpublish' ? (
        <TemplateDialog title="确认取消发布">
          <p className="template-workbench-confirm-copy">
            当前将撤销“{getScenarioDisplayName(confirmState.template)}”的发布状态，后续将无法直接基于它创建实例。
          </p>
          <div className="template-workbench-dialog-actions">
            <button type="button" disabled={isSubmitting} onClick={() => void handleUnpublishTemplate(confirmState.template.id)}>
              确认取消发布
            </button>
            <button type="button" disabled={isSubmitting} onClick={closeConfirmDialog}>
              取消
            </button>
          </div>
        </TemplateDialog>
      ) : null}

      {confirmState?.type === 'delete' ? (
        <TemplateDialog title="确认删除靶场">
          <p className="template-workbench-confirm-copy">
            删除“{getScenarioDisplayName(confirmState.template)}”后将无法恢复，请确认当前不再需要这套编排模板。
          </p>
          <p className="template-workbench-confirm-copy">
            如果存在未销毁实例，必须先销毁这些实例后才能删除模板；已销毁实例历史会保留。
          </p>
          <div className="template-workbench-dialog-actions">
            <button type="button" disabled={isSubmitting} onClick={() => void handleDeleteTemplate(confirmState.template.id)}>
              确认删除
            </button>
            <button type="button" disabled={isSubmitting} onClick={closeConfirmDialog}>
              取消
            </button>
          </div>
        </TemplateDialog>
      ) : null}
    </div>
  );
}
