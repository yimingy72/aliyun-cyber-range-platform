'use client';

import React from 'react';
import { type MouseEvent, type ReactNode, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

import {
  AdminApiError,
  cloneRangeTemplate,
  deleteRangeTemplate,
  fetchRangeTemplates,
  launchRangeInstance,
  shareRangeTemplate,
  unshareRangeTemplate,
  updateRangeTemplate,
} from '../../lib/admin-api';
import { isUnauthorizedAdminError } from '../../lib/admin-screen';
import type {
  RangeTemplateView,
  Scenario,
  ScenarioUpdateInput,
} from '../../lib/admin-types';
import {
  AdminPaginationControls,
  buildVisiblePages,
  getPagination,
  PAGE_SIZE_AUTO,
  useAdminPageSize,
} from './admin-pagination';
import { useAdminSession } from './use-admin-session';

type TemplatesScreenProps = {
  apiBaseUrl?: string;
};

type TemplateDraft = {
  name: string;
  description: string;
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

type TemplateConfirmState =
  | {
      type: 'delete';
      template: Scenario;
    }
  | null;

const EMPTY_TEMPLATE_DRAFT: TemplateDraft = {
  name: '',
  description: '',
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

function readTemplateView(value: string | null): RangeTemplateView {
  return value === 'platform' ? 'platform' : 'mine';
}

function readNodeCount(scenario: Scenario) {
  if (typeof scenario.nodeCount === 'number') {
    return scenario.nodeCount;
  }

  const graph = scenario.topologyGraph;

  if (!graph || typeof graph !== 'object') {
    return 0;
  }

  const nodes = 'nodes' in graph ? graph.nodes : null;
  return Array.isArray(nodes) ? nodes.length : 0;
}

function readZoneCount(scenario: Scenario) {
  if (typeof scenario.zoneCount === 'number') {
    return scenario.zoneCount;
  }

  const zones = scenario.topologySpec?.networkZones;
  return Array.isArray(zones) ? zones.length : 0;
}

function readHostCount(scenario: Scenario) {
  if (typeof scenario.hostCount === 'number') {
    return scenario.hostCount;
  }

  const hosts = scenario.topologySpec?.hosts;
  return Array.isArray(hosts) ? hosts.length : 0;
}

function getScenarioDisplayName(scenario: Scenario) {
  return scenario.name?.trim() || scenario.slug;
}

function getScenarioDescription(scenario: Scenario) {
  return (scenario as Scenario & { description?: string | null }).description?.trim() || '暂无描述';
}

function readPublishedLabel(scenario: Scenario) {
  return scenario.status === 'published' ? '已发布' : '私有';
}

function buildRangeInstanceName(template: Scenario) {
  return `${getScenarioDisplayName(template)} 实例`;
}

function isPublishedScenario(scenario: Scenario) {
  return scenario.status === 'published';
}

function upsertScenario(items: Scenario[], nextScenario: Scenario) {
  return items.some((scenario) => scenario.id === nextScenario.id)
    ? items.map((scenario) => (scenario.id === nextScenario.id ? nextScenario : scenario))
    : [nextScenario, ...items];
}

function removeScenario(items: Scenario[], scenarioId: string) {
  return items.filter((scenario) => scenario.id !== scenarioId);
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
  apiBaseUrl = 'http://localhost:3001',
}: TemplatesScreenProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const session = useAdminSession();
  const [activeView, setActiveView] = useState<RangeTemplateView>(() => readTemplateView(searchParams.get('view')));
  const [platformTemplates, setPlatformTemplates] = useState<Scenario[]>([]);
  const [myTemplates, setMyTemplates] = useState<Scenario[]>([]);
  const [loadedViews, setLoadedViews] = useState<Record<RangeTemplateView, boolean>>({
    platform: false,
    mine: false,
  });
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [actionErrorMessage, setActionErrorMessage] = useState<string | null>(null);
  const [actionSuccessMessage, setActionSuccessMessage] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [editingTemplateId, setEditingTemplateId] = useState<string | null>(null);
  const [menuTemplateId, setMenuTemplateId] = useState<string | null>(null);
  const [confirmState, setConfirmState] = useState<TemplateConfirmState>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [searchName, setSearchName] = useState('');
  const [createDraft, setCreateDraft] = useState<CreateTemplateDraft>(EMPTY_CREATE_TEMPLATE_DRAFT);
  const [editDraft, setEditDraft] = useState<TemplateDraft>(EMPTY_TEMPLATE_DRAFT);
  const [launchDraft, setLaunchDraft] = useState<LaunchInstanceDraft>(EMPTY_LAUNCH_INSTANCE_DRAFT);
  const [viewPages, setViewPages] = useState<Record<RangeTemplateView, number>>({ platform: 1, mine: 1 });
  const [jumpPageValue, setJumpPageValue] = useState('1');
  const { pageSizeMode, pageSize, setPageSizeMode, setPageSize } = useAdminPageSize();

  useEffect(() => {
    if (!session.isReady) {
      return;
    }

    if (!session.token) {
      setPlatformTemplates([]);
      setMyTemplates([]);
      setLoadedViews({ platform: false, mine: false });
      setErrorMessage(null);
      setActionErrorMessage(null);
      setActionSuccessMessage(null);
      setIsLoading(false);
      return;
    }
  }, [apiBaseUrl, session.isReady, session.token]);

  useEffect(() => {
    if (!session.isReady || !session.token) {
      return;
    }

    if (loadedViews[activeView]) {
      setIsLoading(false);
      return;
    }

    let isActive = true;

    setErrorMessage(null);
    setActionErrorMessage(null);
    setActionSuccessMessage(null);
    setIsLoading(true);

    fetchRangeTemplates(apiBaseUrl, session.token, activeView)
      .then((nextTemplates) => {
        if (!isActive) {
          return;
        }

        if (activeView === 'platform') {
          setPlatformTemplates(nextTemplates);
        } else {
          setMyTemplates(nextTemplates);
        }
        setLoadedViews((current) => ({
          ...current,
          [activeView]: true,
        }));
      })
      .catch((error: unknown) => {
        if (!isActive) {
          return;
        }

        if (isUnauthorizedAdminError(error)) {
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
  }, [activeView, apiBaseUrl, loadedViews.mine, loadedViews.platform, router, session.isReady, session.token]);

  const scenarios = activeView === 'platform' ? platformTemplates : myTemplates;

  const filteredTemplates = useMemo(() => {
    return scenarios.filter((scenario) => {
      const displayName = getScenarioDisplayName(scenario).toLowerCase();
      return searchName.trim().length === 0 || displayName.includes(searchName.trim().toLowerCase());
    });
  }, [searchName, scenarios]);
  const activePagination = getPagination(filteredTemplates.length, viewPages[activeView], pageSize);
  const visiblePages = buildVisiblePages(activePagination.totalPages, activePagination.page);
  const pagedTemplates = filteredTemplates.slice(activePagination.startIndex, activePagination.endIndex);

  useEffect(() => {
    if (viewPages[activeView] !== activePagination.page) {
      setViewPages((current) => ({
        ...current,
        [activeView]: activePagination.page,
      }));
    }
  }, [activePagination.page, activeView, viewPages]);

  useEffect(() => {
    setJumpPageValue(String(activePagination.page));
  }, [activePagination.page, activeView]);

  function handlePageSizeChange(nextValue: string) {
    if (nextValue === PAGE_SIZE_AUTO) {
      setPageSizeMode(PAGE_SIZE_AUTO);
      setViewPages({ platform: 1, mine: 1 });
      return;
    }

    setPageSizeMode(nextValue);
    setPageSize(Number(nextValue));
    setViewPages({ platform: 1, mine: 1 });
  }

  function setActiveViewWithUrl(nextView: RangeTemplateView) {
    setActiveView(nextView);

    const nextSearchParams = new URLSearchParams(searchParams.toString());
    if (nextView === 'platform') {
      nextSearchParams.set('view', 'platform');
    } else {
      nextSearchParams.delete('view');
    }

    const nextQuery = nextSearchParams.toString();
    window.history.replaceState(
      null,
      '',
      nextQuery ? `${window.location.pathname}?${nextQuery}` : window.location.pathname,
    );
  }

  function handleJumpToPage() {
    const parsedPage = Number.parseInt(jumpPageValue, 10);

    if (Number.isNaN(parsedPage)) {
      setJumpPageValue(String(activePagination.page));
      return;
    }

    setViewPages((current) => ({
      ...current,
      [activeView]: parsedPage,
    }));
  }

  const editingTemplate = useMemo(() => {
    if (!editingTemplateId) {
      return null;
    }

    return (
      myTemplates.find((scenario) => scenario.id === editingTemplateId) ??
      platformTemplates.find((scenario) => scenario.id === editingTemplateId) ??
      null
    );
  }, [editingTemplateId, myTemplates, platformTemplates]);

  function syncOwnedTemplate(savedScenario: Scenario) {
    setMyTemplates((previous) =>
      savedScenario.ownerUserId === session.profile?.id
        ? upsertScenario(previous, savedScenario)
        : removeScenario(previous, savedScenario.id),
    );
    setPlatformTemplates((previous) =>
      savedScenario.visibility === 'platform' ? upsertScenario(previous, savedScenario) : removeScenario(previous, savedScenario.id),
    );
  }

  function removeTemplateFromViews(id: string) {
    setMyTemplates((previous) => removeScenario(previous, id));
    setPlatformTemplates((previous) => removeScenario(previous, id));
  }

  function handleProtectedActionError(error: unknown, fallbackMessage: string): never {
    if (isUnauthorizedAdminError(error)) {
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
      description: getScenarioDescription(scenario) === '暂无描述' ? '' : getScenarioDescription(scenario),
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

  function openConfirmDialog(type: 'delete', template: Scenario) {
    setMenuTemplateId(null);
    setConfirmState({ type, template });
  }

  async function handleCreateTemplate() {
    const payload = {
      name: createDraft.name.trim(),
      description: createDraft.description.trim(),
    };

    if (!payload.name) {
      setActionErrorMessage('请至少填写靶场名。');
      return;
    }

    window.sessionStorage.setItem('template-editor:new-template', JSON.stringify(payload));
    closeCreateDialog();
    router.push('/admin/scenarios/new');
  }

  async function handleUpdateTemplate(id: string) {
    if (!session.token) {
      throw new Error('admin session missing');
    }

    const payload: ScenarioUpdateInput = {
      name: editDraft.name.trim(),
      description: editDraft.description.trim(),
      expectedRevision: editingTemplate?.revision ?? 0,
    };

    setActionErrorMessage(null);
    setActionSuccessMessage(null);
    setIsSubmitting(true);

    try {
      const savedTemplate = await updateRangeTemplate(apiBaseUrl, session.token, id, payload);
      syncOwnedTemplate(savedTemplate);
      closeEditDialog();
      setActionSuccessMessage('靶场信息已保存。');
    } catch (error: unknown) {
      handleProtectedActionError(error, '靶场编排保存失败，请检查输入后重试。');
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleShareTemplate(id: string): Promise<Scenario> {
    if (!session.token) {
      throw new Error('admin session missing');
    }

    setActionErrorMessage(null);
    setActionSuccessMessage(null);

    try {
      const template = myTemplates.find((item) => item.id === id) ?? platformTemplates.find((item) => item.id === id);
      const savedTemplate = await shareRangeTemplate(apiBaseUrl, session.token, id, {
        expectedRevision: template?.revision ?? 0,
      });
      syncOwnedTemplate(savedTemplate);
      setMenuTemplateId(null);
      setActionSuccessMessage('已发布到平台。');
      return savedTemplate;
    } catch (error: unknown) {
      return handleProtectedActionError(error, '发布到平台失败，请稍后重试。');
    }
  }

  async function handleUnshareTemplate(id: string): Promise<Scenario> {
    if (!session.token) {
      throw new Error('admin session missing');
    }

    setActionErrorMessage(null);
    setActionSuccessMessage(null);

    try {
      const template = myTemplates.find((item) => item.id === id) ?? platformTemplates.find((item) => item.id === id);
      const savedTemplate = await unshareRangeTemplate(apiBaseUrl, session.token, id, {
        expectedRevision: template?.revision ?? 0,
      });
      syncOwnedTemplate(savedTemplate);
      setMenuTemplateId(null);
      setActionSuccessMessage('已回退为私有。');
      return savedTemplate;
    } catch (error: unknown) {
      return handleProtectedActionError(error, '回退为私有失败，请稍后重试。');
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
      removeTemplateFromViews(id);
      setMenuTemplateId(null);
      closeConfirmDialog();
      setActionSuccessMessage('靶场模板已删除。');
    } catch (error: unknown) {
      if (isUnauthorizedAdminError(error)) {
        session.logout();
        router.replace('/admin/login');
        throw error;
      }

      const conflictMessage = getDeleteTemplateConflictMessage(error);
      setActionErrorMessage(conflictMessage ?? '靶场编排删除失败，请稍后重试。');
    }
  }

  async function cloneTemplateToOwnedScenario(scenario: Scenario) {
    if (!session.token) {
      throw new Error('admin session missing');
    }

    setActionErrorMessage(null);
    setActionSuccessMessage(null);
    setIsSubmitting(true);

    try {
      const savedTemplate = await cloneRangeTemplate(apiBaseUrl, session.token, scenario.id);
      syncOwnedTemplate(savedTemplate);
      setMenuTemplateId(null);
      return savedTemplate;
    } catch (error: unknown) {
      return handleProtectedActionError(error, '编排复制失败，请稍后重试。');
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleCloneTemplate(scenario: Scenario) {
    await cloneTemplateToOwnedScenario(scenario);
    setActionSuccessMessage('靶场模板副本已创建。');
  }

  async function handleOpenTemplateEditor(template: Scenario) {
    if (canManageTemplate(template)) {
      router.push(`/admin/scenarios/${template.id}`);
      return;
    }

    const savedTemplate = await cloneTemplateToOwnedScenario(template);
    router.push(`/admin/scenarios/${savedTemplate.id}`);
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

  const isBootstrapLoading = isLoading && platformTemplates.length === 0 && myTemplates.length === 0;

  function canManageTemplate(template: Scenario) {
    return session.isAdmin || template.ownerUserId === session.profile?.id;
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

            <div className="template-workbench-controls-actions">
              <div className="template-workbench-segmented" role="tablist" aria-label="靶场编排视图">
                <button type="button" aria-pressed={activeView === 'platform'} onClick={() => setActiveViewWithUrl('platform')}>
                  平台拓扑
                </button>
                <button type="button" aria-pressed={activeView === 'mine'} onClick={() => setActiveViewWithUrl('mine')}>
                  我的拓扑
                </button>
              </div>

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
              <strong>创建人</strong>
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

          {isBootstrapLoading ? (
            <div className="template-workbench-empty" aria-hidden="true" />
          ) : filteredTemplates.length ? (
            <div className="template-workbench-rows">
              {pagedTemplates.map((template) => {
                const menuOpen = menuTemplateId === template.id;
                const isPublished = isPublishedScenario(template);
                const isShared = template.visibility === 'platform';
                const canManageCurrentTemplate = canManageTemplate(template);
                const canConsumeTemplate = canManageCurrentTemplate || isPublished;
                const canOpenActionMenu = canConsumeTemplate;
                const canEnterTemplate = canManageCurrentTemplate || isShared;

                return (
                  <article key={template.id} className={`template-workbench-row${menuOpen ? ' is-menu-open' : ''}`}>
                    <div className="template-workbench-main">
                      <div className="template-workbench-main-top">
                        <strong>{getScenarioDisplayName(template)}</strong>
                      </div>
                    </div>

                    <div className="template-workbench-column-cell">
                      <strong>{template.createdBy?.trim() || 'admin'}</strong>
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
                      <span className={isPublished ? 'template-workbench-status-pill is-published' : 'template-workbench-status-pill is-private'}>
                        {readPublishedLabel(template)}
                      </span>
                    </div>

                    <div className="template-workbench-actions workbench-action-cell">
                      <button
                        type="button"
                        className="template-workbench-primary-action"
                        disabled={isSubmitting || !canEnterTemplate}
                        onClick={() => void handleOpenTemplateEditor(template)}
                      >
                        进入编排
                      </button>

                      {canOpenActionMenu ? (
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
                              {canConsumeTemplate ? (
                                <button type="button" onClick={() => void handleCloneTemplate(template)}>
                                  复制模板
                                </button>
                              ) : null}
                              {canManageCurrentTemplate ? (
                                <>
                                  <button type="button" onClick={() => openEditDialog(template)}>
                                    编辑信息
                                  </button>
                                  {isShared ? (
                                    <button type="button" onClick={() => void handleUnshareTemplate(template.id)}>
                                      回退为私有
                                    </button>
                                  ) : (
                                    <button type="button" onClick={() => void handleShareTemplate(template.id)}>
                                      发布到平台
                                    </button>
                                  )}
                                </>
                              ) : null}
                              {canConsumeTemplate ? (
                                <button type="button" onClick={() => void handleOpenGenerateInstance(template)}>
                                  生成实例
                                </button>
                              ) : null}
                              {canManageCurrentTemplate ? (
                                <button type="button" onClick={() => openConfirmDialog('delete', template)}>
                                  删除模板
                                </button>
                              ) : null}
                            </div>
                          ) : null}
                        </div>
                      ) : null}
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
          {filteredTemplates.length ? (
            <AdminPaginationControls
              label="靶场列表分页"
              pageSizeMode={pageSizeMode}
              pagination={activePagination}
              visiblePages={visiblePages}
              jumpPageValue={jumpPageValue}
              onPageSizeChange={handlePageSizeChange}
              onPreviousPage={() =>
                setViewPages((current) => ({
                  ...current,
                  [activeView]: activePagination.page - 1,
                }))
              }
              onNextPage={() =>
                setViewPages((current) => ({
                  ...current,
                  [activeView]: activePagination.page + 1,
                }))
              }
              onPageSelect={(pageNumber) =>
                setViewPages((current) => ({
                  ...current,
                  [activeView]: pageNumber,
                }))
              }
              onJumpPageValueChange={setJumpPageValue}
              onJumpPage={handleJumpToPage}
            />
          ) : null}
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
