'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

import { Button } from '@/components/ui/button';
import { TableCell, TableRow } from '@/components/ui/table';
import {
  deleteRangeInstance,
  fetchProvisionJobs,
  fetchRangeInstances,
  triggerRangeAction,
} from '../../lib/admin-api';
import { formatAdminDateTime, isUnauthorizedAdminError } from '../../lib/admin-screen';
import type {
  ProvisionJob,
  RangeInstance,
} from '../../lib/admin-types';
import {
  AdminPaginationControls,
  buildVisiblePages,
  getPagination,
  PAGE_SIZE_AUTO,
  useAdminPageSize,
} from './admin-pagination';
import { AdminDataTable, AdminDataTableCell, AdminDataTableState, type AdminDataColumn } from './shared/admin-data-table';
import { AdminListToolbar } from './shared/admin-list-toolbar';
import { AdminPageHeader } from './shared/admin-page-header';
import { StatusBadge } from './shared/status-badge';
import { TableLoadingState } from './shared/table-loading-state';
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

type RangeListRecord<T> = Record<RangeListMode, T>;

const RANGE_ACTIVE_COLUMNS: readonly AdminDataColumn[] = [
  { id: 'name', label: '实例名称', priority: 'primary' },
  { id: 'createdBy', label: '创建人', priority: 'tertiary' },
  { id: 'template', label: '所属靶场', priority: 'secondary' },
  { id: 'status', label: '状态', priority: 'primary' },
  { id: 'createdAt', label: '创建时间', priority: 'secondary' },
  { id: 'actions', label: '操作', priority: 'primary', width: '12rem' },
];

const RANGE_HISTORY_COLUMNS: readonly AdminDataColumn[] = [
  { id: 'name', label: '实例名称', priority: 'primary' },
  { id: 'createdBy', label: '创建人', priority: 'tertiary' },
  { id: 'template', label: '所属靶场', priority: 'secondary' },
  { id: 'createdAt', label: '开启时间', priority: 'secondary' },
  { id: 'endedAt', label: '回收时间', priority: 'tertiary' },
  { id: 'duration', label: '运行时长', priority: 'detail' },
  { id: 'actions', label: '操作', priority: 'primary', width: '8rem' },
];

function readRangeListMode(value: string | null): RangeListMode {
  return value === 'history' ? 'history' : 'active';
}

function getRangeColumn(columns: readonly AdminDataColumn[], id: string) {
  const column = columns.find((item) => item.id === id);

  if (!column) {
    throw new Error(`Missing range instance column: ${id}`);
  }

  return column;
}

function getInstanceTemplateLabel(
  instance: ExtendedRangeInstance,
) {
  return instance.templateNameSnapshot?.trim() || '未知靶场';
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
  apiBaseUrl = 'http://localhost:3001',
}: RangeInstancesScreenProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const session = useAdminSession();
  const [instancesByView, setInstancesByView] = useState<RangeListRecord<ExtendedRangeInstance[]>>({
    active: [],
    history: [],
  });
  const [jobsByView, setJobsByView] = useState<RangeListRecord<ExtendedProvisionJob[]>>({
    active: [],
    history: [],
  });
  const [listMode, setListMode] = useState<RangeListMode>(() => readRangeListMode(searchParams.get('view')));
  const [searchName, setSearchName] = useState('');
  const [listErrors, setListErrors] = useState<RangeListRecord<string | null>>({
    active: null,
    history: null,
  });
  const [actionErrorMessage, setActionErrorMessage] = useState<string | null>(null);
  const [loadedViews, setLoadedViews] = useState<RangeListRecord<boolean>>({
    active: false,
    history: false,
  });
  const [loadingViews, setLoadingViews] = useState<RangeListRecord<boolean>>({
    active: true,
    history: true,
  });
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [isSubmittingAction, setIsSubmittingAction] = useState<'create' | 'destroy' | null>(null);
  const [removedInstanceIds, setRemovedInstanceIds] = useState<string[]>([]);
  const [listPages, setListPages] = useState<Record<RangeListMode, number>>({ active: 1, history: 1 });
  const [jumpPageValue, setJumpPageValue] = useState('1');
  const { pageSizeMode, pageSize, setPageSizeMode, setPageSize } = useAdminPageSize();

  async function reloadRangeInstanceRows(token: string, nextListMode: RangeListMode) {
    const [nextInstances, nextJobs] = await Promise.all([
      fetchRangeInstances(apiBaseUrl, token, {
        view: nextListMode === 'history' ? 'history' : 'active',
      }),
      nextListMode === 'history'
        ? fetchProvisionJobs(apiBaseUrl, token, { instanceMode: 'range' })
        : Promise.resolve([] as ProvisionJob[]),
    ]);

    return {
      instances: nextInstances as ExtendedRangeInstance[],
      jobs: nextJobs as ExtendedProvisionJob[],
    };
  }

  useEffect(() => {
    if (!session.isReady) {
      return;
    }

    if (!session.token) {
      setInstancesByView({ active: [], history: [] });
      setJobsByView({ active: [], history: [] });
      setListErrors({ active: null, history: null });
      setActionErrorMessage(null);
      setLoadedViews({ active: false, history: false });
      setLoadingViews({ active: false, history: false });
      return;
    }

    const token = session.token;
    let isActive = true;

    setListErrors((current) => ({
      ...current,
      [listMode]: null,
    }));
    setLoadingViews((current) => ({
      ...current,
      [listMode]: true,
    }));

    void reloadRangeInstanceRows(token, listMode)
      .then((nextSnapshot) => {
        if (!isActive) {
          return;
        }

        setInstancesByView((current) => ({
          ...current,
          [listMode]: nextSnapshot.instances,
        }));
        setJobsByView((current) => ({
          ...current,
          [listMode]: nextSnapshot.jobs,
        }));
        setLoadedViews((current) => ({
          ...current,
          [listMode]: true,
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

        setListErrors((current) => ({
          ...current,
          [listMode]: '靶场实例加载失败，请刷新页面后重试。',
        }));
      })
      .finally(() => {
        if (!isActive) {
          return;
        }

        setLoadingViews((current) => ({
          ...current,
          [listMode]: false,
        }));
      });

    return () => {
      isActive = false;
    };
  }, [apiBaseUrl, listMode, loadAttempt, router, session.isReady, session.token]);

  const currentJobs = jobsByView[listMode];
  const currentInstances = instancesByView[listMode];
  const isListLoading = loadingViews[listMode];
  const hasLoadedList = loadedViews[listMode];
  const listErrorMessage = listErrors[listMode];

  const jobsByInstanceId = useMemo(() => {
    const map = new Map<string, ExtendedProvisionJob>();

    for (const job of currentJobs) {
      if (!map.has(job.rangeInstanceId)) {
        map.set(job.rangeInstanceId, job as ExtendedProvisionJob);
      }
    }

    return map;
  }, [currentJobs]);

  const visibleInstances = useMemo(() => {
    return currentInstances.filter(
      (instance) => !removedInstanceIds.includes(instance.id),
    );
  }, [currentInstances, removedInstanceIds]);

  const visibleListInstances = useMemo(() => {
    const keyword = searchName.trim().toLowerCase();
    const matchingModeInstances = visibleInstances.filter((instance) =>
      listMode === 'history' ? instance.status === 'destroyed' : instance.status !== 'destroyed',
    );

    if (!keyword) {
      return matchingModeInstances;
    }

    return matchingModeInstances.filter((instance) => getInstanceDisplayName(instance).toLowerCase().includes(keyword));
  }, [listMode, searchName, visibleInstances]);

  const activePagination = getPagination(visibleListInstances.length, listPages[listMode], pageSize);
  const visiblePages = buildVisiblePages(activePagination.totalPages, activePagination.page);
  const pagedVisibleListInstances = visibleListInstances.slice(activePagination.startIndex, activePagination.endIndex);

  useEffect(() => {
    if (listPages[listMode] !== activePagination.page) {
      setListPages((current) => ({
        ...current,
        [listMode]: activePagination.page,
      }));
    }
  }, [activePagination.page, listMode, listPages]);

  useEffect(() => {
    setJumpPageValue(String(activePagination.page));
  }, [activePagination.page, listMode]);

  function handlePageSizeChange(nextValue: string) {
    if (nextValue === PAGE_SIZE_AUTO) {
      setPageSizeMode(PAGE_SIZE_AUTO);
      setListPages({ active: 1, history: 1 });
      return;
    }

    setPageSizeMode(nextValue);
    setPageSize(Number(nextValue));
    setListPages({ active: 1, history: 1 });
  }

  function handleJumpToPage() {
    const parsedPage = Number.parseInt(jumpPageValue, 10);

    if (Number.isNaN(parsedPage)) {
      setJumpPageValue(String(activePagination.page));
      return;
    }

    setListPages((current) => ({
      ...current,
      [listMode]: parsedPage,
    }));
  }

  function upsertInstanceInSnapshot(instance: ExtendedRangeInstance) {
    setInstancesByView((current) => {
      const currentInstances = current[listMode];

      return {
        ...current,
        [listMode]: currentInstances.some((item) => item.id === instance.id)
          ? currentInstances.map((item) => (item.id === instance.id ? { ...item, ...instance } : item))
          : [instance, ...currentInstances],
      };
    });
  }

  function upsertJobInSnapshot(job: ExtendedProvisionJob) {
    setJobsByView((current) => ({
      ...current,
      [listMode]: [job, ...current[listMode].filter((item) => item.id !== job.id)],
    }));
  }

  function removeInstanceFromSnapshot(instanceId: string) {
    setInstancesByView((current) => ({
      ...current,
      [listMode]: current[listMode].filter((item) => item.id !== instanceId),
    }));
    setJobsByView((current) => ({
      ...current,
      [listMode]: current[listMode].filter((item) => item.rangeInstanceId !== instanceId),
    }));
  }

  function handleViewDetail(instanceId: string) {
    router.push(`/admin/ranges/${instanceId}`);
  }

  async function handleListDestroyAction(instance: ExtendedRangeInstance) {
    if (!session.token) {
      return;
    }

    setActionErrorMessage(null);
    setIsSubmittingAction('destroy');

    try {
      const trigger = getActionTrigger(instance, 'destroy');
      const job = (await triggerRangeAction(apiBaseUrl, session.token, instance.id, trigger)) as ExtendedProvisionJob;

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

      setActionErrorMessage('实例生命周期操作失败，请稍后重试。');
    } finally {
      setIsSubmittingAction(null);
    }
  }

  async function handleDeleteFailedInstance(instance: ExtendedRangeInstance) {
    if (!session.token) {
      return;
    }

    setActionErrorMessage(null);
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

      setActionErrorMessage('删除失败实例失败，请稍后重试。');
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

  const isInitialLoading = !hasLoadedList && !listErrorMessage;
  const isRefreshing = isListLoading && hasLoadedList;
  const shouldShowTableError = Boolean(listErrorMessage && !hasLoadedList);
  const columns = listMode === 'history' ? RANGE_HISTORY_COLUMNS : RANGE_ACTIVE_COLUMNS;

  function setListModeWithUrl(nextListMode: RangeListMode) {
    if (nextListMode === listMode) {
      return;
    }

    setListMode(nextListMode);

    const nextSearchParams = new URLSearchParams(searchParams.toString());
    if (nextListMode === 'history') {
      nextSearchParams.set('view', 'history');
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

  function retryListLoad() {
    setLoadingViews((current) => ({
      ...current,
      [listMode]: true,
    }));
    setListErrors((current) => ({
      ...current,
      [listMode]: null,
    }));
    setLoadAttempt((current) => current + 1);
  }

  return (
    <div className="admin-screen">
      {actionErrorMessage ? <p className="admin-error" role="alert">{actionErrorMessage}</p> : null}

      <section className="admin-workbench-surface">
        <AdminPageHeader description="查看靶场实例状态和生命周期。" title="编排实例" />

        <div className="mt-4">
          <AdminListToolbar
            activeView={listMode}
            onSearchChange={setSearchName}
            onViewChange={(value) => {
              if (value === 'active' || value === 'history') {
                setListModeWithUrl(value);
              }
            }}
            searchLabel="筛选实例名"
            searchPlaceholder="搜索实例名"
            searchValue={searchName}
            views={[
              { value: 'active', label: '实例列表' },
              { value: 'history', label: '实例历史' },
            ]}
          >
            <div className="mt-4">
              <AdminDataTable
                columns={columns}
                isRefreshing={isRefreshing}
                label={listMode === 'history' ? '编排实例历史' : '编排实例列表'}
              >
                {(tableColumns) => {
                  if (isInitialLoading) {
                    return (
                      <TableLoadingState
                        columnCount={tableColumns.length}
                        label="正在加载编排实例"
                        rowCount={5}
                      />
                    );
                  }

                  if (shouldShowTableError && listErrorMessage) {
                    return (
                      <AdminDataTableState
                        columns={tableColumns}
                        description={listErrorMessage}
                        onRetry={retryListLoad}
                        title="无法加载编排实例"
                        variant="error"
                      />
                    );
                  }

                  const retainedErrorRow = listErrorMessage && hasLoadedList ? (
                    <TableRow className="hover:bg-transparent" key="retained-list-error">
                      <TableCell className="px-3 py-2" colSpan={tableColumns.length}>
                        <div className="flex flex-wrap items-center justify-between gap-2 text-sm" role="alert">
                          <span className="text-destructive">
                            {listErrorMessage} 正在显示上次成功加载的列表。
                          </span>
                          <Button onClick={retryListLoad} size="sm" type="button" variant="outline">
                            重试加载
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ) : null;

                  if (!visibleListInstances.length) {
                    return retainedErrorRow ?? (
                      <AdminDataTableState
                        columns={tableColumns}
                        description={
                          listMode === 'history'
                            ? '实例完成销毁后，会自动沉淀到这里。'
                            : '实例会在靶场编排页生成后进入这里。'
                        }
                        title={listMode === 'history' ? '还没有已回收实例' : '还没有编排实例'}
                        variant="empty"
                      />
                    );
                  }

                  const rows = pagedVisibleListInstances.map((instance) => {
                    const nameColumn = getRangeColumn(tableColumns, 'name');
                    const createdByColumn = getRangeColumn(tableColumns, 'createdBy');
                    const templateColumn = getRangeColumn(tableColumns, 'template');
                    const createdAtColumn = getRangeColumn(tableColumns, 'createdAt');
                    const actionsColumn = getRangeColumn(tableColumns, 'actions');

                    if (listMode === 'history') {
                      const recentJob = jobsByInstanceId.get(instance.id);
                      const endedAt = recentJob?.finishedAt ?? recentJob?.startedAt ?? null;

                      return (
                        <TableRow key={instance.id}>
                          <AdminDataTableCell className="font-medium" column={nameColumn}>
                            {getInstanceDisplayName(instance)}
                          </AdminDataTableCell>
                          <AdminDataTableCell column={createdByColumn}>
                            {instance.createdBy?.trim() || 'admin'}
                          </AdminDataTableCell>
                          <AdminDataTableCell column={templateColumn}>
                            {getInstanceTemplateLabel(instance)}
                          </AdminDataTableCell>
                          <AdminDataTableCell column={createdAtColumn}>
                            {formatAdminDateTime(instance.createdAt)}
                          </AdminDataTableCell>
                          <AdminDataTableCell column={getRangeColumn(tableColumns, 'endedAt')}>
                            {getEndedAtLabel(recentJob)}
                          </AdminDataTableCell>
                          <AdminDataTableCell column={getRangeColumn(tableColumns, 'duration')}>
                            {getDurationLabel(instance.createdAt, endedAt)}
                          </AdminDataTableCell>
                          <AdminDataTableCell column={actionsColumn}>
                            <div className="flex justify-start">
                              <Button onClick={() => void handleViewDetail(instance.id)} size="sm" type="button" variant="outline">
                                查看详情
                              </Button>
                            </div>
                          </AdminDataTableCell>
                        </TableRow>
                      );
                    }

                    const actionLabel = getInstanceActionLabel(instance);

                    return (
                      <TableRow key={instance.id}>
                        <AdminDataTableCell className="font-medium" column={nameColumn}>
                          {getInstanceDisplayName(instance)}
                        </AdminDataTableCell>
                        <AdminDataTableCell column={createdByColumn}>
                          {instance.createdBy?.trim() || 'admin'}
                        </AdminDataTableCell>
                        <AdminDataTableCell column={templateColumn}>
                          {getInstanceTemplateLabel(instance)}
                        </AdminDataTableCell>
                        <AdminDataTableCell column={getRangeColumn(tableColumns, 'status')}>
                          <StatusBadge status={instance.status} />
                        </AdminDataTableCell>
                        <AdminDataTableCell column={createdAtColumn}>
                          {getInstanceCreatedAt(instance)}
                        </AdminDataTableCell>
                        <AdminDataTableCell column={actionsColumn}>
                          <div className="flex justify-start gap-1">
                            <Button onClick={() => void handleViewDetail(instance.id)} size="sm" type="button" variant="outline">
                              查看详情
                            </Button>
                            {actionLabel ? (
                              <Button
                                disabled={isSubmittingAction !== null}
                                onClick={() =>
                                  void (instance.status === 'create_failed'
                                    ? handleDeleteFailedInstance(instance)
                                    : handleListDestroyAction(instance))
                                }
                                size="sm"
                                type="button"
                                variant="destructive"
                              >
                                {isSubmittingAction !== null ? '处理中...' : actionLabel}
                              </Button>
                            ) : null}
                          </div>
                        </AdminDataTableCell>
                      </TableRow>
                    );
                  });

                  return retainedErrorRow ? [retainedErrorRow, ...rows] : rows;
                }}
              </AdminDataTable>
            </div>
          </AdminListToolbar>
        </div>

        {visibleListInstances.length ? (
          <div className="mt-4">
            <AdminPaginationControls
              jumpPageValue={jumpPageValue}
              label={`${listMode === 'history' ? '实例历史' : '实例列表'} 分页`}
              onJumpPage={handleJumpToPage}
              onJumpPageValueChange={setJumpPageValue}
              onNextPage={() =>
                setListPages((current) => ({
                  ...current,
                  [listMode]: activePagination.page + 1,
                }))
              }
              onPageSelect={(pageNumber) =>
                setListPages((current) => ({
                  ...current,
                  [listMode]: pageNumber,
                }))
              }
              onPageSizeChange={handlePageSizeChange}
              onPreviousPage={() =>
                setListPages((current) => ({
                  ...current,
                  [listMode]: activePagination.page - 1,
                }))
              }
              pageSizeMode={pageSizeMode}
              pagination={activePagination}
              visiblePages={visiblePages}
            />
          </div>
        ) : null}
      </section>
    </div>
  );
}
