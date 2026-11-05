'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ChevronDown, ChevronRight, Download, Trash2 } from 'lucide-react';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';

import { Button } from '@/components/ui/button';
import { InstancePowerBadge, InstancePowerMenu } from './instance-power-menu';
import { RangeInstanceCreateButton } from './range-instance-create-button';
import { TableCell, TableRow } from '@/components/ui/table';
import { Checkbox } from '@/components/ui/checkbox';
import {
  fetchProvisionJobs,
  fetchRangeInstances,
  fetchRangeInstanceDetail,
  fetchRangeInstanceAccess,
  triggerRangeAction,
} from '../../lib/admin-api';
import { useAdminScreenCache } from '../../lib/admin-screen-cache';
import { readCloudWorkspaceSelection } from '@/lib/cloud-workspace-selection';
import { readAdminSession } from '@/lib/admin-auth-storage';
import { beginRangeRecoveryIntent, readRangeRecoveryIntent } from '@/lib/range-recovery-intent';
import { groupRangeInstances, rangeBatchBusy, rangeBatchStatus, type RangeInstanceGroup } from '@/lib/range-instance-batches';
import { downloadRangeInstancesCsv, rangeInstancesCsv, type RangeExportItem } from '@/lib/range-instance-export';
import { useCloudWorkspace } from './cloud-workspace-provider';
import { formatAdminDateTime, isUnauthorizedAdminError } from '../../lib/admin-screen';
import type {
  ProvisionJob,
  RangeInstance,
} from '../../lib/admin-types';
import {
  AdminPaginationControls,

  getPagination,
  useAdminPageSize,
} from './admin-pagination';
import { useAdminRouteIsActive } from './admin-page-cache';
import { ConfirmActionDialog } from './shared/confirm-action-dialog';
import { AdminDialog } from './shared/admin-dialog';
import {
  AdminDataTable,
  AdminDataTableCell,
  AdminDataTableRevalidationNotice,
  AdminDataTableState,
  ADMIN_TABLE_WIDTHS,
  type AdminDataColumn,
} from './shared/admin-data-table';
import { AdminListToolbar } from './shared/admin-list-toolbar';
import { AdminPaginatedList } from './shared/admin-paginated-list';
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

type RangeListSnapshot = {
  instances: ExtendedRangeInstance[];
  jobs: ExtendedProvisionJob[];
};

const RANGE_ACTIVE_COLUMNS: readonly AdminDataColumn[] = [
  { id: 'name', label: '实例 / 批次', priority: 'primary', minWidth: '14rem' },
  { id: 'template', label: '所属靶场', priority: 'secondary', minWidth: '14rem' },
  { id: 'dnatPublicIp', label: '公网 IP（DNAT IP）', priority: 'primary', width: '10rem' },
  { id: 'status', label: '状态', priority: 'primary', width: ADMIN_TABLE_WIDTHS.status },
  { id: 'createdAt', label: '创建时间', priority: 'secondary', width: ADMIN_TABLE_WIDTHS.dateTime },
  { id: 'createdBy', label: '创建人', priority: 'tertiary', width: ADMIN_TABLE_WIDTHS.creator },
  { id: 'actions', label: '操作', priority: 'primary', width: ADMIN_TABLE_WIDTHS.actions },
];

const RANGE_HISTORY_COLUMNS: readonly AdminDataColumn[] = [
  { id: 'name', label: '实例 / 批次', priority: 'primary', minWidth: '14rem' },
  { id: 'template', label: '所属靶场', priority: 'secondary', minWidth: '14rem' },
  { id: 'dnatPublicIp', label: '公网 IP（DNAT IP）', priority: 'primary', width: '10rem' },
  { id: 'status', label: '状态', priority: 'primary', width: ADMIN_TABLE_WIDTHS.status },
  { id: 'createdAt', label: '创建时间', priority: 'secondary', width: ADMIN_TABLE_WIDTHS.dateTime },
  { id: 'endedAt', label: '结束时间', priority: 'tertiary', width: ADMIN_TABLE_WIDTHS.dateTime },
  { id: 'duration', label: '持续时长', priority: 'detail', width: '8rem' },
  { id: 'createdBy', label: '创建人', priority: 'tertiary', width: ADMIN_TABLE_WIDTHS.creator },
  { id: 'actions', label: '操作', priority: 'primary', width: ADMIN_TABLE_WIDTHS.actions },
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

function getActionTrigger(instance: RangeInstance) {
  if (instance.status === 'destroy_failed') {
    return 'retry' as const;
  }

  return 'destroy' as const;
}

function getInstanceDisplayName(instance: ExtendedRangeInstance) {
  return instance.name?.trim() || instance.id;
}

function getInstanceCreatedAt(instance: ExtendedRangeInstance, recentJob?: ExtendedProvisionJob | null) {
  return formatAdminDateTime(instance.createdAt ?? recentJob?.startedAt ?? null);
}

function getInstanceActionLabel(instance: ExtendedRangeInstance) {
  if (instance.status === 'running') {
    return '销毁实例';
  }

  if (instance.status === 'destroy_failed') {
    return '销毁';
  }

  return null;
}

function isRangeInstanceHistoryStatus(status: string) {
  return status === 'destroyed' || status === 'create_failed';
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
  const workspace = useCloudWorkspace()?.workspace;
  const isPageActive = useAdminRouteIsActive('/admin/ranges');
  const actionSession = readAdminSession();
  const actionWorkspaceId = workspace?.id ?? readCloudWorkspaceSelection() ?? '';
  const actionScopeKey = JSON.stringify([apiBaseUrl, session.profile?.id, session.profile?.role, actionWorkspaceId, workspace?.isReadOnly, session.token, actionSession?.sessionGeneration, isPageActive]);
  const actionContextRef = useRef({ scope: actionScopeKey });
  if (actionContextRef.current.scope !== actionScopeKey) actionContextRef.current = { scope: actionScopeKey };
  const mountedRef = useRef(true);
  const submittingRef = useRef<string | null>(null);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);
  function recoveryScopeFor(instanceId: string) {
    return { apiBaseUrl, userId: session.profile?.id ?? '', workspaceId: actionWorkspaceId, rangeId: instanceId };
  }
  const pageActiveRef = useRef(isPageActive); pageActiveRef.current = isPageActive;
  const [listMode, setListMode] = useState<RangeListMode>(() => readRangeListMode(searchParams.get('view')));
  const screenCache = useAdminScreenCache();
  const cachedActiveSnapshot = screenCache?.read<RangeListSnapshot>(apiBaseUrl, session.token, 'range-instances:active');
  const cachedHistorySnapshot = screenCache?.read<RangeListSnapshot>(apiBaseUrl, session.token, 'range-instances:history');
  const [instancesByView, setInstancesByView] = useState<RangeListRecord<ExtendedRangeInstance[]>>(() => ({
    active: cachedActiveSnapshot?.data.instances ?? [],
    history: cachedHistorySnapshot?.data.instances ?? [],
  }));
  const [jobsByView, setJobsByView] = useState<RangeListRecord<ExtendedProvisionJob[]>>(() => ({
    active: cachedActiveSnapshot?.data.jobs ?? [],
    history: cachedHistorySnapshot?.data.jobs ?? [],
  }));
  const [searchName, setSearchName] = useState('');
  const [listErrors, setListErrors] = useState<RangeListRecord<string | null>>({
    active: null,
    history: null,
  });
  const [actionErrorMessage, setActionErrorMessage] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [expandedBatches, setExpandedBatches] = useState<string[]>([]);
  const [batchDestroyTarget, setBatchDestroyTarget] = useState<{ name: string; instances: RangeInstance[]; skipped: number } | null>(null);
  const [batchProgress, setBatchProgress] = useState(0);
  const [exportTarget, setExportTarget] = useState<RangeInstanceGroup | null>(null);
  const [includeCredentials, setIncludeCredentials] = useState(false);
  const [exportPending, setExportPending] = useState(false);
  const exportPendingRef = useRef<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [loadedViews, setLoadedViews] = useState<RangeListRecord<boolean>>({
    active: Boolean(cachedActiveSnapshot),
    history: Boolean(cachedHistorySnapshot),
  });
  const [tableContentVersions, setTableContentVersions] = useState<RangeListRecord<number>>({
    active: 0,
    history: 0,
  });
  const [loadingViews, setLoadingViews] = useState<RangeListRecord<boolean>>({
    active: !cachedActiveSnapshot,
    history: !cachedHistorySnapshot,
  });
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [isSubmittingAction, setIsSubmittingAction] = useState<'destroy' | null>(null);
  const [confirmDestroyTarget, setConfirmDestroyTarget] = useState<ExtendedRangeInstance | null>(null);
  const [isConfirmingDestroy, setIsConfirmingDestroy] = useState(false);
  useEffect(() => {
    submittingRef.current = null; setIsSubmittingAction(null); setIsConfirmingDestroy(false); setConfirmDestroyTarget(null); setActionErrorMessage(null);
    setBatchDestroyTarget(null); setExpandedBatches([]); setActionNotice(null); setExportTarget(null); setExportPending(false); setExportError(null);
    exportPendingRef.current = null;
  }, [actionScopeKey]);
  const [listPages, setListPages] = useState<Record<RangeListMode, number>>({ active: 1, history: 1 });
  const { pageSize, setPageSize } = useAdminPageSize();

  function markTableContentUpdated(view: RangeListMode) {
    setTableContentVersions((current) => ({
      ...current,
      [view]: current[view] + 1,
    }));
  }

  async function reloadRangeInstanceRows(token: string, nextListMode: RangeListMode, force = false) {
    const load = async (): Promise<RangeListSnapshot> => {
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
    };

    return screenCache
      ? screenCache.load(apiBaseUrl, token, `range-instances:${nextListMode}`, load, { force })
      : load();
  }

  useEffect(() => {
    if (!isPageActive || !session.isReady) {
      return;
    }

    if (!session.token) {
      setInstancesByView({ active: [], history: [] });
      setJobsByView({ active: [], history: [] });
      setListErrors({ active: null, history: null });
      setActionErrorMessage(null);
      setLoadedViews({ active: false, history: false });
      setTableContentVersions({ active: 0, history: 0 });
      setLoadingViews({ active: false, history: false });
      return;
    }

    const token = session.token;
    let isActive = true;
    const cachedSnapshot = screenCache?.read<RangeListSnapshot>(apiBaseUrl, token, `range-instances:${listMode}`);

    setListErrors((current) => ({
      ...current,
      [listMode]: null,
    }));

    if (cachedSnapshot?.isFresh && loadAttempt === 0) {
      setInstancesByView((current) => ({
        ...current,
        [listMode]: cachedSnapshot.data.instances,
      }));
      setJobsByView((current) => ({
        ...current,
        [listMode]: cachedSnapshot.data.jobs,
      }));
      setLoadedViews((current) => ({
        ...current,
        [listMode]: true,
      }));
      setLoadingViews((current) => ({
        ...current,
        [listMode]: false,
      }));

      return () => {
        isActive = false;
      };
    }

    setLoadingViews((current) => ({
      ...current,
      [listMode]: true,
    }));

    void reloadRangeInstanceRows(token, listMode, loadAttempt > 0)
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
        markTableContentUpdated(listMode);
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
  }, [apiBaseUrl, isPageActive, listMode, loadAttempt, router, screenCache, session.isReady, session.token]);

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

  const visibleListInstances = useMemo(() => {
    const matchingModeInstances = currentInstances.filter((instance) =>
      listMode === 'history' ? isRangeInstanceHistoryStatus(instance.status) : !isRangeInstanceHistoryStatus(instance.status),
    );

    return matchingModeInstances;
  }, [currentInstances, listMode]);
  const visibleGroups = useMemo(() => groupRangeInstances(visibleListInstances, searchName), [visibleListInstances, searchName]);

  useEffect(() => {
    if (!session.token || !isPageActive || listMode !== 'active' || isSubmittingAction !== null
      || !currentInstances.some(instance => Boolean(instance.powerControl?.phase) || instance.launchBatch && ['pending_create', 'creating', 'pending_destroy', 'destroying', 'pending_update', 'updating'].includes(instance.status))) return;
    let live = true;
    const context = actionContextRef.current;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const snapshot = await reloadRangeInstanceRows(session.token!, 'active', true);
        if (!live || !isCurrentAction(context)) return;
        if (JSON.stringify(snapshot.instances) !== JSON.stringify(currentInstances)) {
          setInstancesByView(current => ({ ...current, active: snapshot.instances }));
          markTableContentUpdated('active');
        }
        setListErrors(current => ({ ...current, active: null }));
      } catch (error) {
        if (!live || !isCurrentAction(context)) return;
        if (isUnauthorizedAdminError(error)) { session.logout(); router.replace('/admin/login'); }
        else setListErrors(current => ({ ...current, active: '批次状态刷新失败，已保留现有记录，请稍后重试。' }));
      } finally { if (live) timer = setTimeout(() => void refresh(), 5000); }
    };
    timer = setTimeout(() => void refresh(), 5000);
    return () => { live = false; clearTimeout(timer); };
  }, [apiBaseUrl, actionScopeKey, currentInstances, isPageActive, isSubmittingAction, listMode, router, screenCache, session.token]);

  useEffect(() => {
    setListPages((current) => ({
      ...current,
      [listMode]: 1,
    }));
  }, [listMode, searchName]);

  const activePagination = getPagination(visibleGroups.length, listPages[listMode], pageSize);
  const pagedGroups = visibleGroups.slice(activePagination.startIndex, activePagination.endIndex);

  useEffect(() => {
    if (listPages[listMode] !== activePagination.page) {
      setListPages((current) => ({
        ...current,
        [listMode]: activePagination.page,
      }));
    }
  }, [activePagination.page, listMode, listPages]);

  function handlePageSizeChange(nextValue: 20 | 50 | 100) {
    setPageSize(nextValue);
    setListPages({ active: 1, history: 1 });
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

  function prefetchDetail(instanceId: string) {
    router.prefetch?.(`/admin/ranges/${instanceId}`);
    if (session.token && screenCache) {
      void screenCache.load(apiBaseUrl, session.token, `range-instance-detail:${instanceId}:${session.profile?.id ?? 'current-session'}:${session.profile?.role ?? ''}`,
        () => fetchRangeInstanceDetail(apiBaseUrl, session.token!, instanceId)).catch(() => {});
    }
  }

  function handleViewDetail(instanceId: string) {
    prefetchDetail(instanceId);
    router.push(`/admin/ranges/${instanceId}`);
  }

  function isCurrentAction(context: { scope: string }) {
    const selected = readCloudWorkspaceSelection(session.profile?.id);
    const currentSession = readAdminSession();
    return mountedRef.current && pageActiveRef.current && actionContextRef.current === context && (!selected || selected === actionWorkspaceId)
      && (!actionSession || currentSession?.profile.id === actionSession.profile.id && currentSession.sessionGeneration === actionSession.sessionGeneration);
  }

  async function submitDestroy(instance: RangeInstance, isCurrent: () => boolean) {
    const recoveryScope = recoveryScopeFor(instance.id);
    if (readRangeRecoveryIntent(recoveryScope)) return 'pending';
    let persisted = false;
    try {
      const intent = beginRangeRecoveryIntent(recoveryScope, getActionTrigger(instance));
      persisted = true;
      const job = (await triggerRangeAction(apiBaseUrl, session.token!, instance.id, intent.trigger, intent.key)) as ExtendedProvisionJob | null;
      if (!isCurrent()) return 'stale';
      screenCache?.invalidate(apiBaseUrl, session.token, 'range-instances:');
      if (!job?.id || job.rangeInstanceId && job.rangeInstanceId !== instance.id) return 'unknown';
      upsertInstanceInSnapshot({ ...instance, status: 'pending_destroy', lastJobId: job.id });
      upsertJobInSnapshot(job);
      return 'accepted';
    } catch (error) {
      if (!isCurrent()) return 'stale';
      if (isUnauthorizedAdminError(error)) return 'unauthorized';
      return persisted ? 'unknown' : 'storage_failed';
    }
  }

  async function performListDestroyAction(instance: ExtendedRangeInstance) {
    if (!session.token || submittingRef.current || workspace?.isReadOnly) return;
    if (readRangeRecoveryIntent(recoveryScopeFor(instance.id))) { handleViewDetail(instance.id); return; }
    const context = actionContextRef.current;
    const marker = crypto.randomUUID(); submittingRef.current = marker;
    setActionErrorMessage(null); setActionNotice(null); setIsSubmittingAction('destroy');
    try {
      const result = await submitDestroy(instance, () => isCurrentAction(context));
      if (!isCurrentAction(context)) return;
      if (result === 'unauthorized') { session.logout(); router.replace('/admin/login'); }
      else if (result === 'unknown') setActionErrorMessage('回收请求结果尚未确认，请进入实例详情查询原请求。');
      else if (result === 'storage_failed') setActionErrorMessage('无法保存回收请求标识，请检查浏览器存储后重试。');
    } finally {
      if (mountedRef.current && actionContextRef.current === context) {
        if (submittingRef.current === marker) submittingRef.current = null;
        setIsSubmittingAction(null);
      }
    }
  }

  function openBatchDestroy(group: RangeInstanceGroup) {
    const targets = group.instances.filter(instance => Boolean(getInstanceActionLabel(instance)) && !readRangeRecoveryIntent(recoveryScopeFor(instance.id)));
    if (!targets.length || rangeBatchBusy(group.instances) || submittingRef.current || workspace?.isReadOnly) return;
    setBatchProgress(0);
    setBatchDestroyTarget({ name: group.name, instances: targets, skipped: group.instances.length - targets.length });
  }

  async function performBatchDestroy() {
    if (!session.token || !batchDestroyTarget || submittingRef.current || workspace?.isReadOnly) return;
    const target = batchDestroyTarget, context = actionContextRef.current;
    const marker = crypto.randomUUID(); submittingRef.current = marker;
    setIsSubmittingAction('destroy'); setActionErrorMessage(null); setActionNotice(null);
    let accepted = 0, unknown = 0, processed = 0, skipped = target.skipped, storageFailed = false;
    try {
      for (const instance of target.instances) {
        if (!isCurrentAction(context)) return;
        const result = await submitDestroy(instance, () => isCurrentAction(context));
        if (!isCurrentAction(context)) return;
        if (result === 'unauthorized') { session.logout(); router.replace('/admin/login'); return; }
        processed++;
        setBatchProgress(processed);
        if (result === 'accepted') accepted++;
        else if (result === 'pending') skipped++;
        else if (result === 'unknown') unknown++;
        else if (result === 'storage_failed') { storageFailed = true; break; }
      }
      const summary = `批次“${target.name}”：已受理 ${accepted} 套回收请求${skipped ? `，跳过 ${skipped} 套处理中或待确认记录` : ''}。`;
      if (unknown || storageFailed) {
        setActionErrorMessage(`${summary}${unknown ? ` ${unknown} 套结果待确认，请展开批次进入详情查询原请求，不要重复提交。` : ''}${storageFailed ? ` 浏览器无法保存回收标识，已停止后续提交，${target.instances.length - processed + 1} 套尚未提交。` : ''}`);
      } else setActionNotice(`${summary}云端回收仍在进行，可展开查看各套实例状态。`);
    } finally {
      if (mountedRef.current && actionContextRef.current === context) {
        if (submittingRef.current === marker) submittingRef.current = null;
        setIsSubmittingAction(null); setBatchDestroyTarget(null);
      }
    }
  }

  function openExport(group: RangeInstanceGroup) {
    if (exportPendingRef.current) return;
    setIncludeCredentials(false); setExportError(null); setExportTarget(group);
  }

  function openInstanceExport(instance: RangeInstance) {
    openExport({ id: instance.id, name: getInstanceDisplayName(instance), isBatch: false, quantity: 1, instances: [instance] });
  }

  async function exportInstances() {
    if (!session.token || !exportTarget || exportPendingRef.current) return;
    const context = actionContextRef.current, target = exportTarget;
    const marker = crypto.randomUUID(); exportPendingRef.current = marker;
    setExportPending(true); setExportError(null);
    try {
      const items: RangeExportItem[] = [];
      for (const instance of target.instances) {
        if (!isCurrentAction(context)) return;
        const detail = await fetchRangeInstanceDetail(apiBaseUrl, session.token, instance.id);
        if (!isCurrentAction(context)) return;
        if (detail.id !== instance.id) throw new Error('返回的编排实例与导出目标不符。');
        const access = includeCredentials ? await fetchRangeInstanceAccess(apiBaseUrl, session.token, instance.id) : undefined;
        if (!isCurrentAction(context)) return;
        if (access && access.id !== instance.id) throw new Error('返回的访问数据与导出目标不符。');
        items.push({ detail, access });
      }
      downloadRangeInstancesCsv(target.name, rangeInstancesCsv(target.isBatch ? target.name : '', items, includeCredentials));
      setExportTarget(null);
    } catch (error) {
      if (!isCurrentAction(context)) return;
      if (isUnauthorizedAdminError(error)) { session.logout(); router.replace('/admin/login'); }
      else setExportError(`导出失败，未生成文件。${error instanceof Error ? error.message : '请稍后重试。'}`);
    } finally {
      if (exportPendingRef.current === marker) exportPendingRef.current = null;
      if (mountedRef.current && actionContextRef.current === context) setExportPending(false);
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
    <div className="admin-screen admin-pagination-screen">
      {actionErrorMessage ? <p className="admin-error" role="alert">{actionErrorMessage}</p> : null}
      {actionNotice ? <p className="text-sm text-muted-foreground" role="status">{actionNotice}</p> : null}

      <section className="admin-workbench-surface admin-pagination-surface">
        <AdminPageHeader description="查看靶场实例状态和生命周期。" title="编排实例" />

        <div className="mt-4 flex min-h-0 flex-1 flex-col">
          <AdminListToolbar
            action={<RangeInstanceCreateButton apiBaseUrl={apiBaseUrl} onCreated={retryListLoad} />}
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
            <AdminPaginatedList
              className="mt-4"
              footer={
                visibleGroups.length ? (
                  <AdminPaginationControls
                    label={`${listMode === 'history' ? '实例历史' : '实例列表'} 分页`}
                    onPageSelect={(pageNumber) =>
                      setListPages((current) => ({
                        ...current,
                        [listMode]: pageNumber,
                      }))
                    }
                    onPageSizeChange={handlePageSizeChange}
                    pageSize={pageSize}
                    pagination={activePagination}
                  />
                ) : null
              }
            >
              <div className="range-instance-list-table min-w-0"><AdminDataTable
                columns={columns}
                contentVersion={tableContentVersions[listMode]}
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
                    <AdminDataTableRevalidationNotice
                      columns={tableColumns}
                      description={listErrorMessage}
                      key="retained-list-error"
                      onRetry={retryListLoad}
                    />
                  ) : null;

                  if (!visibleGroups.length) {
                    return retainedErrorRow ?? (
                      <AdminDataTableState
                        columns={tableColumns}
                        description={
                          listMode === 'history'
                            ? '实例完成销毁或创建失败后，会自动沉淀到这里。'
                            : '实例会在靶场编排页生成后进入这里。'
                        }
                        title={listMode === 'history' ? '还没有历史实例' : '还没有编排实例'}
                        variant="empty"
                      />
                    );
                  }

                  const renderInstanceRow = (instance: ExtendedRangeInstance, indented = false) => {
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
                          <AdminDataTableCell className={indented ? 'pl-10 font-medium' : 'font-medium'} column={nameColumn}>
                            {getInstanceDisplayName(instance)}
                          </AdminDataTableCell>
                          <AdminDataTableCell column={templateColumn}>
                            {getInstanceTemplateLabel(instance)}
                          </AdminDataTableCell>
                          <AdminDataTableCell column={getRangeColumn(tableColumns, 'dnatPublicIp')}>
                            {instance.dnatPublicIp?.trim() || '暂无'}
                          </AdminDataTableCell>
                          <AdminDataTableCell column={getRangeColumn(tableColumns, 'status')}>
                            <InstancePowerBadge instance={instance} />
                          </AdminDataTableCell>
                          <AdminDataTableCell className="text-xs tabular-nums" column={createdAtColumn}>
                            {formatAdminDateTime(instance.createdAt)}
                          </AdminDataTableCell>
                          <AdminDataTableCell className="text-xs tabular-nums" column={getRangeColumn(tableColumns, 'endedAt')}>
                            {getEndedAtLabel(recentJob)}
                          </AdminDataTableCell>
                          <AdminDataTableCell column={getRangeColumn(tableColumns, 'duration')}>
                            {getDurationLabel(instance.createdAt, endedAt)}
                          </AdminDataTableCell>
                          <AdminDataTableCell column={createdByColumn}>
                            {instance.createdBy?.trim() || 'admin'}
                          </AdminDataTableCell>
                          <AdminDataTableCell column={actionsColumn}>
                            <div className="flex justify-start gap-1" data-slot="range-history-detail-action">
                              <Button onMouseEnter={() => prefetchDetail(instance.id)} onFocus={() => prefetchDetail(instance.id)} onClick={() => void handleViewDetail(instance.id)} size="sm" type="button" variant="outline">
                                查看详情
                              </Button>
                              <Button aria-label={`导出靶场信息 ${getInstanceDisplayName(instance)}`} onClick={() => openInstanceExport(instance)} size="sm" type="button" variant="outline">导出</Button>
                            </div>
                          </AdminDataTableCell>
                        </TableRow>
                      );
                    }

                    const pendingIntent = readRangeRecoveryIntent(recoveryScopeFor(instance.id));
                    const actionLabel = getInstanceActionLabel(instance);
                    const statusActionLabel = ['pending_destroy', 'destroying'].includes(instance.status)
                      ? '查看回收进度'
                      : pendingIntent ? '确认回收状态' : null;

                    return (
                      <TableRow key={instance.id}>
                        <AdminDataTableCell className={indented ? 'pl-10 font-medium' : 'font-medium'} column={nameColumn}>
                          {getInstanceDisplayName(instance)}
                        </AdminDataTableCell>
                        <AdminDataTableCell column={templateColumn}>
                          {getInstanceTemplateLabel(instance)}
                        </AdminDataTableCell>
                        <AdminDataTableCell column={getRangeColumn(tableColumns, 'dnatPublicIp')}>
                          {instance.dnatPublicIp?.trim() || '暂无'}
                        </AdminDataTableCell>
                        <AdminDataTableCell column={getRangeColumn(tableColumns, 'status')}>
                          <InstancePowerBadge instance={instance} />
                        </AdminDataTableCell>
                        <AdminDataTableCell className="text-xs tabular-nums" column={createdAtColumn}>
                          {getInstanceCreatedAt(instance)}
                        </AdminDataTableCell>
                        <AdminDataTableCell column={createdByColumn}>
                          {instance.createdBy?.trim() || 'admin'}
                        </AdminDataTableCell>
                        <AdminDataTableCell column={actionsColumn}>
                          <div className="inline-flex flex-nowrap! items-center justify-start gap-1 whitespace-nowrap" data-slot="range-instance-actions">
                            <Button onMouseEnter={() => prefetchDetail(instance.id)} onFocus={() => prefetchDetail(instance.id)} onClick={() => void handleViewDetail(instance.id)} size="sm" type="button" variant="outline">
                              查看详情
                            </Button>
                            <InstancePowerMenu apiBaseUrl={apiBaseUrl} token={session.token} scopeKey={`${session.profile?.id}:${session.profile?.role}:${workspace?.id}`}
                              target={{ kind: 'range', id: instance.id }} name={getInstanceDisplayName(instance)} label="更多" sources={[instance]}
                              showPowerActions={instance.status === 'running' && !workspace?.isReadOnly && workspace?.provider !== 'tencent_cloud'}
                              disabled={isSubmittingAction !== null} onChanged={retryListLoad}
                              destructive={actionLabel ? <DropdownMenuItem variant="destructive" disabled={workspace?.isReadOnly || Boolean(instance.powerControl?.phase)}
                                onSelect={() => setConfirmDestroyTarget(instance)}><Trash2 aria-hidden="true" />{actionLabel}</DropdownMenuItem> : undefined}>
                              <DropdownMenuItem aria-label={`导出靶场信息 ${getInstanceDisplayName(instance)}`} onSelect={() => openInstanceExport(instance)}><Download aria-hidden="true" />导出靶场信息</DropdownMenuItem>
                              {statusActionLabel ? <DropdownMenuItem onSelect={() => void handleViewDetail(instance.id)}>{statusActionLabel}</DropdownMenuItem> : null}
                            </InstancePowerMenu>
                          </div>
                        </AdminDataTableCell>
                      </TableRow>
                    );
                  };

                  const rows = pagedGroups.flatMap(group => {
                    if (!group.isBatch) return [renderInstanceRow(group.instances[0])];
                    const first = group.instances[0], expanded = expandedBatches.includes(group.id);
                    const publicIps = [...new Set(group.instances.map(instance => instance.dnatPublicIp?.trim()).filter(Boolean))];
                    const endedAt = group.instances.map(instance => jobsByInstanceId.get(instance.id))
                      .map(job => job?.finishedAt ?? job?.startedAt).filter((value): value is string => Boolean(value))
                      .sort((a, b) => Date.parse(b) - Date.parse(a))[0];
                    const closeable = group.instances.some(instance => Boolean(getInstanceActionLabel(instance)) && !readRangeRecoveryIntent(recoveryScopeFor(instance.id)));
                    const busy = rangeBatchBusy(group.instances);
                    const header = <TableRow className="bg-muted/20 hover:bg-muted/30" data-row-kind="batch" key={group.id}>
                      {tableColumns.map(column => <AdminDataTableCell column={column} key={column.id}>
                        {column.id === 'name' ? <div className="flex min-w-0 items-center gap-2">
                          <Button aria-expanded={expanded} aria-label={`${expanded ? '收起' : '展开'}批次 ${group.name}`} onClick={() => setExpandedBatches(current =>
                            expanded ? current.filter(id => id !== group.id) : [...current, group.id])} size="icon-xs" type="button" variant="ghost">
                            {expanded ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
                          </Button>
                          <div className="min-w-0"><strong className="block truncate" title={group.name}>{group.name}</strong>
                            <span className="text-xs text-muted-foreground">{group.instances.length === group.quantity ? `${group.quantity} 套` : `当前 ${group.instances.length} 套 / 批次 ${group.quantity} 套`}</span>
                          </div>
                        </div> : column.id === 'createdBy' ? first.createdBy?.trim() || 'admin'
                          : column.id === 'template' ? getInstanceTemplateLabel(first)
                          : column.id === 'status' ? <span className="text-xs whitespace-normal">{rangeBatchStatus(group.instances)}</span>
                          : column.id === 'dnatPublicIp' ? <span title={publicIps.join('、')}>{publicIps.length ? `${publicIps.length} 个公网入口` : '暂无'}</span>
                          : column.id === 'createdAt' ? <span className="text-xs tabular-nums">{getInstanceCreatedAt(first)}</span>
                          : column.id === 'endedAt' ? <span className="text-xs tabular-nums">{formatAdminDateTime(endedAt)}</span>
                          : column.id === 'duration' ? getDurationLabel(first.createdAt, endedAt)
                          : column.id === 'actions' ? <div className="inline-flex flex-nowrap! items-center gap-1 whitespace-nowrap" data-slot="range-batch-actions">
                            <Button aria-label={`导出批次 ${group.name}`} onClick={() => openExport(group)} size="sm" type="button" variant="outline">导出</Button>
                            {listMode === 'active' && first.launchBatch ? <InstancePowerMenu apiBaseUrl={apiBaseUrl} token={session.token} scopeKey={`${session.profile?.id}:${session.profile?.role}:${workspace?.id}`}
                              target={{ kind: 'range_batch', id: first.launchBatch.id }} name={group.name} label="更多" sources={group.instances}
                              showPowerActions={workspace?.provider !== 'tencent_cloud'} disabled={workspace?.isReadOnly || isSubmittingAction !== null} onChanged={retryListLoad}
                              destructive={<DropdownMenuItem aria-label={`销毁批次 ${group.name}`} variant="destructive" disabled={busy || !closeable}
                                title={busy ? '创建、更新或启停任务完成后，才能整批销毁。' : '仅销毁本批次中可回收的编排实例。'}
                                onSelect={() => openBatchDestroy(group)}><Trash2 aria-hidden="true" />销毁整批</DropdownMenuItem>} /> : null}
                          </div> : null}
                      </AdminDataTableCell>)}
                    </TableRow>;
                    return [header, ...(expanded ? group.instances.map(instance => renderInstanceRow(instance, true)) : [])];
                  });

                  return retainedErrorRow ? [retainedErrorRow, ...rows] : rows;
                }}
              </AdminDataTable></div>
            </AdminPaginatedList>
          </AdminListToolbar>
        </div>
      </section>

      {confirmDestroyTarget ? (
        <ConfirmActionDialog
          confirmLabel={confirmDestroyTarget.status === 'destroy_failed' ? '确认重试' : '确认销毁'}
          description={confirmDestroyTarget.status === 'destroy_failed'
            ? `将重新执行回收任务，继续删除“${getInstanceDisplayName(confirmDestroyTarget)}”的剩余云资源；回收完成后无法恢复。`
            : `将销毁“${getInstanceDisplayName(confirmDestroyTarget)}”的全部云主机与随实例磁盘；销毁后无法恢复。`}
          open
          pending={isConfirmingDestroy}
          title={confirmDestroyTarget.status === 'destroy_failed' ? '重试回收编排实例' : '销毁编排实例'}
          onConfirm={() => {
            if (!confirmDestroyTarget || isConfirmingDestroy) {
              return;
            }
            const target = confirmDestroyTarget;
            const context = actionContextRef.current;
            void (async () => {
              setIsConfirmingDestroy(true);
              try {
                await performListDestroyAction(target);
              } finally {
                if (mountedRef.current && actionContextRef.current === context) {
                  setIsConfirmingDestroy(false);
                  setConfirmDestroyTarget(null);
                }
              }
            })();
          }}
          onOpenChange={(open) => {
            if (!open && !isConfirmingDestroy) {
              setConfirmDestroyTarget(null);
            }
          }}
        />
      ) : null}

      {batchDestroyTarget && isPageActive ? <AdminDialog open title="销毁整批编排实例" size="compact"
        description={`将回收批次“${batchDestroyTarget.name}”中以下 ${batchDestroyTarget.instances.length} 套编排实例的全部云主机、磁盘及靶场网络，数据无法恢复。不会影响其他批次。`}
        pending={isSubmittingAction !== null} onOpenChange={open => { if (!open && !submittingRef.current) setBatchDestroyTarget(null); }}
        footer={<><Button disabled={isSubmittingAction !== null} onClick={() => setBatchDestroyTarget(null)} type="button" variant="outline">取消</Button>
          <Button disabled={isSubmittingAction !== null} onClick={() => void performBatchDestroy()} type="button" variant="destructive">确认销毁整批</Button></>}>
        <ul className="grid max-h-56 gap-2 overflow-y-auto text-sm">
          {batchDestroyTarget.instances.map(instance => <li className="break-all" key={instance.id}><strong>{getInstanceDisplayName(instance)}</strong>
            <span className="block text-xs text-muted-foreground">{instance.id}{instance.status === 'destroy_failed' ? ' · 重试回收剩余资源' : ''}</span></li>)}
        </ul>
        {batchDestroyTarget.skipped ? <p className="mt-3 text-xs text-muted-foreground">另有 {batchDestroyTarget.skipped} 套处理中、待确认或不可回收记录，本次跳过，不重复提交。</p> : null}
        {isSubmittingAction ? <p className="mt-3 text-sm" role="status">已处理 {batchProgress} / {batchDestroyTarget.instances.length} 套请求，受理不代表云端已回收。</p> : null}
      </AdminDialog> : null}

      {exportTarget && isPageActive ? <AdminDialog open title="导出靶场信息" size="compact"
        description={`导出“${exportTarget.name}”当前视图中的 ${exportTarget.instances.length} 套编排实例，每个主机节点一行。IP、端口和状态以平台已部署记录为准。`}
        pending={exportPending} onOpenChange={open => { if (!open && !exportPendingRef.current) setExportTarget(null); }}
        footer={<><Button disabled={exportPending} onClick={() => setExportTarget(null)} type="button" variant="outline">取消</Button>
          <Button disabled={exportPending} onClick={() => void exportInstances()} type="button">{exportPending ? '正在导出…' : '导出 CSV'}</Button></>}>
        <p className="text-sm text-muted-foreground">包含批次、实例、节点、镜像、私网 IP、公网入口、端口映射和到期时间。不会修改云资源。</p>
        <label className="mt-4 flex items-start gap-2 text-sm">
          <Checkbox checked={includeCredentials} disabled={exportPending} onCheckedChange={checked => setIncludeCredentials(checked === true)} />
          包含节点登录账号和密码（敏感）
        </label>
        {includeCredentials ? <p className="mt-2 text-xs text-destructive">CSV 将包含明文登录凭据，请妥善保管；仅在本次导出中读取，不写入列表缓存。</p> : null}
        {exportError ? <p className="mt-3 text-sm text-destructive" role="alert">{exportError}</p> : null}
      </AdminDialog> : null}
    </div>
  );
}
