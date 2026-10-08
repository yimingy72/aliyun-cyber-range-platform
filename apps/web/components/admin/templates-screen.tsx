'use client';

import { type MouseEvent, useEffect, useLayoutEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { MoreHorizontal, Plus } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { TableRow } from '@/components/ui/table';

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
import { useAdminScreenCache } from '../../lib/admin-screen-cache';
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
  useAdminPageSize,
} from './admin-pagination';
import { useAdminRouteIsActive } from './admin-page-cache';
import { AdminPageHeader } from './shared/admin-page-header';
import {
  AdminDataTable,
  AdminDataTableCell,
  AdminDataTableRevalidationNotice,
  AdminDataTableState,
  type AdminDataColumn,
} from './shared/admin-data-table';
import { AdminListToolbar } from './shared/admin-list-toolbar';
import { AdminDialog } from './shared/admin-dialog';
import { AdminPaginatedList } from './shared/admin-paginated-list';
import { ConfirmActionDialog } from './shared/confirm-action-dialog';
import { StatusBadge } from './shared/status-badge';
import { TableLoadingState } from './shared/table-loading-state';
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

const TEMPLATE_COLUMNS: readonly AdminDataColumn[] = [
  { id: 'template', label: '靶场', priority: 'primary' },
  { id: 'creator', label: '创建人', priority: 'secondary' },
  { id: 'description', label: '靶场描述', priority: 'detail' },
  { id: 'topology', label: '拓扑概览', priority: 'tertiary' },
  { id: 'status', label: '状态', priority: 'primary' },
  { id: 'actions', label: '操作', priority: 'primary', width: '12rem' },
];

function readTemplateView(value: string | null): RangeTemplateView {
  return value === 'platform' ? 'platform' : 'mine';
}

function createNewTemplateDraftId() {
  if (typeof window !== 'undefined' && typeof window.crypto?.randomUUID === 'function') {
    return window.crypto.randomUUID();
  }

  return `draft-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
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

export function TemplatesScreen({
  apiBaseUrl = 'http://localhost:3001',
}: TemplatesScreenProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const session = useAdminSession();
  const isPageActive = useAdminRouteIsActive('/admin/scenarios');
  const [activeView, setActiveView] = useState<RangeTemplateView>(() => readTemplateView(searchParams.get('view')));
  const screenCache = useAdminScreenCache();
  const cachedPlatformTemplates = screenCache?.read<Scenario[]>(apiBaseUrl, session.token, 'templates:platform');
  const cachedMyTemplates = screenCache?.read<Scenario[]>(apiBaseUrl, session.token, 'templates:mine');
  const cachedActiveTemplates = activeView === 'platform' ? cachedPlatformTemplates : cachedMyTemplates;
  const [platformTemplates, setPlatformTemplates] = useState<Scenario[]>(() => cachedPlatformTemplates?.data ?? []);
  const [myTemplates, setMyTemplates] = useState<Scenario[]>(() => cachedMyTemplates?.data ?? []);
  const [loadedViews, setLoadedViews] = useState<Record<RangeTemplateView, boolean>>(() => ({
    platform: cachedPlatformTemplates !== null && cachedPlatformTemplates !== undefined,
    mine: cachedMyTemplates !== null && cachedMyTemplates !== undefined,
  }));
  const [tableContentVersions, setTableContentVersions] = useState<Record<RangeTemplateView, number>>({
    platform: 0,
    mine: 0,
  });
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [revalidationErrorMessage, setRevalidationErrorMessage] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [actionErrorMessage, setActionErrorMessage] = useState<string | null>(null);
  const [actionSuccessMessage, setActionSuccessMessage] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(() => !cachedActiveTemplates);
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [editingTemplateId, setEditingTemplateId] = useState<string | null>(null);
  const [confirmState, setConfirmState] = useState<TemplateConfirmState>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [pendingEditorTemplateId, setPendingEditorTemplateId] = useState<string | null>(null);
  const [searchName, setSearchName] = useState('');
  const [createDraft, setCreateDraft] = useState<CreateTemplateDraft>(EMPTY_CREATE_TEMPLATE_DRAFT);
  const [editDraft, setEditDraft] = useState<TemplateDraft>(EMPTY_TEMPLATE_DRAFT);
  const [launchDraft, setLaunchDraft] = useState<LaunchInstanceDraft>(EMPTY_LAUNCH_INSTANCE_DRAFT);
  const createNameRef = useRef<HTMLInputElement>(null);
  const editNameRef = useRef<HTMLInputElement>(null);
  const launchNameRef = useRef<HTMLInputElement>(null);
  const [viewPages, setViewPages] = useState<Record<RangeTemplateView, number>>({ platform: 1, mine: 1 });
  const [jumpPageValue, setJumpPageValue] = useState('1');
  const { pageSize, setPageSize } = useAdminPageSize();

  function markTableContentUpdated(view: RangeTemplateView) {
    setTableContentVersions((current) => ({
      ...current,
      [view]: current[view] + 1,
    }));
  }

  useLayoutEffect(() => {
    if (isPageActive) {
      setPendingEditorTemplateId(null);
    }
  }, [isPageActive]);

  useEffect(() => {
    if (!isPageActive || !session.isReady) {
      return;
    }

    if (!session.token) {
      setPlatformTemplates([]);
      setMyTemplates([]);
      setLoadedViews({ platform: false, mine: false });
      setTableContentVersions({ platform: 0, mine: 0 });
      setErrorMessage(null);
      setRevalidationErrorMessage(null);
      setActionErrorMessage(null);
      setActionSuccessMessage(null);
      setIsLoading(false);
      return;
    }
  }, [apiBaseUrl, isPageActive, session.isReady, session.token]);

  useEffect(() => {
    if (!isPageActive || !session.isReady || !session.token) {
      return;
    }

    const cachedTemplates = screenCache?.read<Scenario[]>(apiBaseUrl, session.token, `templates:${activeView}`);

    if (
      loadedViews[activeView] &&
      (!screenCache || (cachedTemplates?.isFresh && loadAttempt === 0))
    ) {
      setIsLoading(false);
      return;
    }

    let isActive = true;
    const token = session.token;

    const hasActiveViewSnapshot = loadedViews[activeView];

    if (hasActiveViewSnapshot) {
      setRevalidationErrorMessage(null);
    } else {
      setErrorMessage(null);
    }
    setActionErrorMessage(null);
    setActionSuccessMessage(null);
    setIsLoading(true);

    const loadTemplates = () => fetchRangeTemplates(apiBaseUrl, token, activeView);
    const request = screenCache
      ? screenCache.load(apiBaseUrl, token, `templates:${activeView}`, loadTemplates, {
          force: loadAttempt > 0,
        })
      : loadTemplates();

    request
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
        markTableContentUpdated(activeView);
        if (loadAttempt > 0) {
          setLoadAttempt(0);
        }
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

        const message = '靶场编排加载失败，请刷新页面后重试。';

        if (hasActiveViewSnapshot) {
          setRevalidationErrorMessage(message);
          return;
        }

        setErrorMessage(message);
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
  }, [
    activeView,
    apiBaseUrl,
    isPageActive,
    loadAttempt,
    loadedViews.mine,
    loadedViews.platform,
    router,
    screenCache,
    session.isReady,
    session.token,
  ]);

  const scenarios = activeView === 'platform' ? platformTemplates : myTemplates;

  const filteredTemplates = useMemo(() => {
    return scenarios.filter((scenario) => {
      const displayName = getScenarioDisplayName(scenario).toLowerCase();
      return searchName.trim().length === 0 || displayName.includes(searchName.trim().toLowerCase());
    });
  }, [searchName, scenarios]);

  useEffect(() => {
    setViewPages((current) => ({
      ...current,
      [activeView]: 1,
    }));
  }, [activeView, searchName]);

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

  useLayoutEffect(() => {
    setJumpPageValue(String(activePagination.page));
  }, [activePagination.page, activeView]);

  function handlePageSizeChange(nextValue: 20 | 50 | 100) {
    setPageSize(nextValue);
    setViewPages({ platform: 1, mine: 1 });
  }

  function setActiveViewWithUrl(nextView: RangeTemplateView) {
    setErrorMessage(null);
    setRevalidationErrorMessage(null);
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

  function retryActiveView() {
    setErrorMessage(null);
    setRevalidationErrorMessage(null);
    setLoadAttempt((current) => current + 1);
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

  function syncOwnedTemplate(savedScenario: Scenario, options: { addToMyTemplates?: boolean } = {}) {
    screenCache?.invalidate(apiBaseUrl, session.token, 'templates:');
    setMyTemplates((previous) =>
      previous.some((scenario) => scenario.id === savedScenario.id) || options.addToMyTemplates
        ? upsertScenario(previous, savedScenario)
        : previous,
    );
    setPlatformTemplates((previous) =>
      savedScenario.visibility === 'platform' ? upsertScenario(previous, savedScenario) : removeScenario(previous, savedScenario.id),
    );
  }

  function removeTemplateFromViews(id: string) {
    screenCache?.invalidate(apiBaseUrl, session.token, 'templates:');
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
    setConfirmState({ type, template });
  }

  async function handleCreateTemplate() {
    const payload = {
      draftId: createNewTemplateDraftId(),
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
    setIsSubmitting(true);

    try {
      await deleteRangeTemplate(apiBaseUrl, session.token, id);
      removeTemplateFromViews(id);
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
    } finally {
      setIsSubmitting(false);
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
      syncOwnedTemplate(savedTemplate, { addToMyTemplates: true });
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
    if (pendingEditorTemplateId) {
      return;
    }

    if (canManageTemplate(template)) {
      setPendingEditorTemplateId(template.id);
      router.push(`/admin/scenarios/${template.id}`);
      return;
    }

    setPendingEditorTemplateId(template.id);

    try {
      const savedTemplate = await cloneTemplateToOwnedScenario(template);
      router.push(`/admin/scenarios/${savedTemplate.id}`);
    } catch {
      setPendingEditorTemplateId(null);
    }
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
      screenCache?.invalidate(apiBaseUrl, session.token, 'range-instances:');
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

  const isActiveViewLoading = !loadedViews[activeView] && !errorMessage;

  function canManageTemplate(template: Scenario) {
    return template.canManage ?? session.isAdmin;
  }

  return (
    <div className="admin-screen template-workbench-screen admin-pagination-screen" onClickCapture={handleScreenClickCapture}>
      {actionErrorMessage ? <p className="admin-error">{actionErrorMessage}</p> : null}
      {actionSuccessMessage ? <p className="admin-success">{actionSuccessMessage}</p> : null}

      <section className="admin-workbench-surface admin-pagination-surface">
        <AdminPageHeader description="管理可复用的演练蓝图" title="靶场编排" />
        <div className="mt-4 flex min-h-0 flex-1 flex-col">
          <AdminListToolbar
            activeView={activeView}
            onSearchChange={setSearchName}
            onViewChange={(nextView) => {
              if (nextView === 'mine' || nextView === 'platform') {
                setActiveViewWithUrl(nextView);
              }
            }}
            searchLabel="筛选靶场名"
            searchPlaceholder="筛选靶场名"
            searchValue={searchName}
            views={[
              { label: '我的拓扑', value: 'mine' },
              { label: '平台拓扑', value: 'platform' },
            ]}
            action={
              <Button onClick={() => setIsCreateDialogOpen(true)} type="button">
                <Plus aria-hidden="true" />
                新建拓扑
              </Button>
            }
          >
            <AdminPaginatedList
              className="mt-4"
              footer={
                filteredTemplates.length ? (
                  <AdminPaginationControls
                    jumpPageValue={jumpPageValue}
                    label="靶场列表分页"
                    pageSize={pageSize}
                    pagination={activePagination}
                    visiblePages={visiblePages}
                    onJumpPage={handleJumpToPage}
                    onJumpPageValueChange={setJumpPageValue}
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
                    onPageSizeChange={handlePageSizeChange}
                    onPreviousPage={() =>
                      setViewPages((current) => ({
                        ...current,
                        [activeView]: activePagination.page - 1,
                      }))
                    }
                  />
                ) : null
              }
            >
              <AdminDataTable
                columns={TEMPLATE_COLUMNS}
                contentVersion={tableContentVersions[activeView]}
                isRefreshing={isLoading || isActiveViewLoading}
                label="靶场列表"
              >
                {(columns) => {
                  const [templateColumn, creatorColumn, descriptionColumn, topologyColumn, statusColumn, actionsColumn] = columns;

                  if (errorMessage) {
                    return (
                      <AdminDataTableState
                        columns={columns}
                        description={errorMessage}
                        onRetry={retryActiveView}
                        title="无法加载靶场列表"
                        variant="error"
                      />
                    );
                  }

                  if (isActiveViewLoading) {
                    return <TableLoadingState columnCount={columns.length} label="正在加载靶场列表" rowCount={5} />;
                  }

                  const revalidationErrorRow = revalidationErrorMessage ? (
                    <AdminDataTableRevalidationNotice
                      columns={columns}
                      description={revalidationErrorMessage}
                      key="revalidation-error"
                      onRetry={retryActiveView}
                    />
                  ) : null;

                  if (!pagedTemplates.length) {
                    return (
                      <>
                        {revalidationErrorRow}
                        <AdminDataTableState
                          columns={columns}
                          description={
                            activeView === 'mine'
                              ? '你可以新建一个靶场并开始编排。'
                              : '平台暂时没有可用的已发布拓扑。'
                          }
                          title="当前筛选条件下没有靶场"
                          variant="empty"
                        />
                      </>
                    );
                  }

                  const rows = pagedTemplates.map((template) => {
                    const isPublished = isPublishedScenario(template);
                    const isShared = template.visibility === 'platform';
                    const canManageCurrentTemplate = canManageTemplate(template);
                    const canConsumeTemplate = canManageCurrentTemplate || isPublished;
                    const canEnterTemplate = canManageCurrentTemplate || isShared;

                    return (
                      <TableRow key={template.id}>
                        <AdminDataTableCell className="font-medium" column={templateColumn!}>
                          {getScenarioDisplayName(template)}
                        </AdminDataTableCell>
                        <AdminDataTableCell column={creatorColumn!}>
                          {template.createdBy?.trim() || 'admin'}
                        </AdminDataTableCell>
                        <AdminDataTableCell
                          className="max-w-72 whitespace-normal text-muted-foreground"
                          column={descriptionColumn!}
                        >
                          {getScenarioDescription(template)}
                        </AdminDataTableCell>
                        <AdminDataTableCell column={topologyColumn!}>
                          <div className="flex flex-wrap gap-1 text-xs text-muted-foreground">
                            <span>区域 {readZoneCount(template)}</span>
                            <span>主机 {readHostCount(template)}</span>
                            <span>节点 {readNodeCount(template)}</span>
                          </div>
                        </AdminDataTableCell>
                        <AdminDataTableCell column={statusColumn!}>
                          <StatusBadge status={isPublished ? 'published' : 'private'} />
                        </AdminDataTableCell>
                        <AdminDataTableCell column={actionsColumn!}>
                          <div className="flex justify-start gap-1">
                            <Button
                              disabled={isSubmitting || pendingEditorTemplateId !== null || !canEnterTemplate}
                              size="sm"
                              type="button"
                              onClick={() => void handleOpenTemplateEditor(template)}
                            >
                              {pendingEditorTemplateId === template.id ? '正在进入编排...' : '进入编排'}
                            </Button>
                            {canConsumeTemplate ? (
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <Button
                                    aria-label="更多操作"
                                    disabled={isSubmitting}
                                    size="icon-sm"
                                    type="button"
                                    variant="ghost"
                                  >
                                    <MoreHorizontal aria-hidden="true" />
                                  </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                  <DropdownMenuItem onSelect={() => void handleCloneTemplate(template)}>
                                    复制模板
                                  </DropdownMenuItem>
                                  {canManageCurrentTemplate ? (
                                    <>
                                      <DropdownMenuItem onSelect={() => openEditDialog(template)}>
                                        编辑信息
                                      </DropdownMenuItem>
                                      {isShared ? (
                                        <DropdownMenuItem onSelect={() => void handleUnshareTemplate(template.id)}>
                                          回退为私有
                                        </DropdownMenuItem>
                                      ) : (
                                        <DropdownMenuItem onSelect={() => void handleShareTemplate(template.id)}>
                                          发布到平台
                                        </DropdownMenuItem>
                                      )}
                                    </>
                                  ) : null}
                                  <DropdownMenuItem onSelect={() => void handleOpenGenerateInstance(template)}>
                                    生成实例
                                  </DropdownMenuItem>
                                  {canManageCurrentTemplate ? (
                                    <DropdownMenuItem
                                      variant="destructive"
                                      onSelect={() => openConfirmDialog('delete', template)}
                                    >
                                      删除模板
                                    </DropdownMenuItem>
                                  ) : null}
                                </DropdownMenuContent>
                              </DropdownMenu>
                            ) : null}
                          </div>
                        </AdminDataTableCell>
                      </TableRow>
                    );
                  });

                  return revalidationErrorRow ? [revalidationErrorRow, ...rows] : rows;
                }}
              </AdminDataTable>
            </AdminPaginatedList>
          </AdminListToolbar>
        </div>
      </section>

      <AdminDialog
        footer={
          <>
            <Button disabled={isSubmitting} type="button" variant="outline" onClick={closeCreateDialog}>
              取消
            </Button>
            <Button disabled={isSubmitting} type="button" onClick={() => void handleCreateTemplate()}>
              创建并进入编排
            </Button>
          </>
        }
        initialFocusRef={createNameRef}
        open={isCreateDialogOpen}
        pending={isSubmitting}
        title="创建靶场"
        onOpenChange={(open) => {
          if (!open) {
            closeCreateDialog();
          }
        }}
      >
          <div className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="create-template-name">靶场名</Label>
              <Input
                id="create-template-name"
                ref={createNameRef}
                value={createDraft.name}
                onChange={(event) => setCreateDraft((previous) => ({ ...previous, name: event.target.value }))}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="create-template-description">靶场描述</Label>
              <Input
                id="create-template-description"
                value={createDraft.description}
                onChange={(event) => setCreateDraft((previous) => ({ ...previous, description: event.target.value }))}
              />
            </div>
          </div>
      </AdminDialog>

      <AdminDialog
        footer={
          <>
            <Button disabled={isSubmitting} type="button" variant="outline" onClick={closeEditDialog}>
              取消编辑
            </Button>
            <Button
              disabled={isSubmitting || !editingTemplate}
              type="button"
              onClick={() => editingTemplate && void handleUpdateTemplate(editingTemplate.id)}
            >
              保存信息
            </Button>
          </>
        }
        initialFocusRef={editNameRef}
        open={Boolean(editingTemplate)}
        pending={isSubmitting}
        title="编辑靶场"
        onOpenChange={(open) => {
          if (!open) {
            closeEditDialog();
          }
        }}
      >
          <div className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="edit-template-name">靶场名</Label>
              <Input
                id="edit-template-name"
                ref={editNameRef}
                value={editDraft.name}
                onChange={(event) => setEditDraft((previous) => ({ ...previous, name: event.target.value }))}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="edit-template-description">靶场描述</Label>
              <Input
                id="edit-template-description"
                value={editDraft.description}
                onChange={(event) => setEditDraft((previous) => ({ ...previous, description: event.target.value }))}
              />
            </div>
          </div>
      </AdminDialog>

      <AdminDialog
        footer={
          <>
            <Button disabled={isSubmitting} type="button" variant="outline" onClick={closeLaunchDialog}>
              取消
            </Button>
            <Button disabled={isSubmitting} type="button" onClick={() => void handleLaunchInstance()}>
              确认生成
            </Button>
          </>
        }
        initialFocusRef={launchNameRef}
        open={Boolean(launchDraft.templateId)}
        pending={isSubmitting}
        title="生成实例"
        onOpenChange={(open) => {
          if (!open) {
            closeLaunchDialog();
          }
        }}
      >
          <div className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="launch-instance-name">实例名</Label>
              <Input
                id="launch-instance-name"
                ref={launchNameRef}
                value={launchDraft.name}
                onChange={(event) => setLaunchDraft((previous) => ({ ...previous, name: event.target.value }))}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="launch-instance-expires-at">到期时间</Label>
              <Input
                id="launch-instance-expires-at"
                type="datetime-local"
                value={launchDraft.expiresAt}
                onChange={(event) => setLaunchDraft((previous) => ({ ...previous, expiresAt: event.target.value }))}
              />
            </div>
          </div>
      </AdminDialog>

      <ConfirmActionDialog
        confirmLabel="删除模板"
        description={
          confirmState
            ? `删除“${getScenarioDisplayName(confirmState.template)}”后将无法恢复。如果存在未销毁实例，必须先销毁这些实例后才能删除模板；已销毁实例历史会保留。`
            : ''
        }
        open={confirmState?.type === 'delete'}
        pending={isSubmitting}
        title="删除靶场"
        onConfirm={() => confirmState && void handleDeleteTemplate(confirmState.template.id)}
        onOpenChange={(open) => {
          if (!open) {
            closeConfirmDialog();
          }
        }}
      />
    </div>
  );
}
