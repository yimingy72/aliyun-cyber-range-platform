'use client';

import React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ChevronDown, ChevronRight, Copy, MoreHorizontal, Plus } from 'lucide-react';

import {
  AdminApiError,
  deleteRangeInstance,
  destroySingleInstanceBatch,
  fetchInstanceTypeAvailability,
  fetchPlatformImages,
  fetchProvisionJobs,
  fetchSingleInstances,
  launchSingleInstances,
  triggerSingleInstanceAction,
} from '../../lib/admin-api';
import type {
  InstanceTypeAvailabilitySnapshot,
  PlatformImageAsset,
  ProvisionJob,
  RangeInstance,
  SingleInstanceBatchGroup,
  SingleInstanceListPayload,
  SingleInstanceAction,
  SingleInstanceLaunchInput,
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
import { Button } from '@/components/ui/button';
import { TableRow } from '@/components/ui/table';

type SingleInstancesScreenProps = {
  apiBaseUrl?: string;
  pollIntervalMs?: number;
};

type ListMode = 'active' | 'history';

const activeInstanceColumns = [
  { id: 'name', label: '实例 / 批次', priority: 'primary' },
  { id: 'image', label: '镜像', priority: 'secondary' },
  { id: 'specification', label: '规格', priority: 'secondary' },
  { id: 'public-ip', label: '公网 IP', priority: 'tertiary' },
  { id: 'status', label: '状态', priority: 'secondary' },
  { id: 'created-at', label: '创建时间', priority: 'detail' },
  { id: 'expires-at', label: '到期时间', priority: 'detail' },
  { id: 'created-by', label: '创建人', priority: 'detail' },
  { id: 'credentials', label: '账号 / 密码', priority: 'detail' },
  { id: 'actions', label: '操作', priority: 'primary', width: '13rem' },
] as const satisfies readonly AdminDataColumn[];

const historyInstanceColumns = [
  { id: 'name', label: '实例 / 批次', priority: 'primary' },
  { id: 'image', label: '镜像', priority: 'secondary' },
  { id: 'summary', label: '规格 / 汇总', priority: 'secondary' },
  { id: 'public-ip', label: '公网 IP', priority: 'tertiary' },
  { id: 'started-at', label: '开启时间', priority: 'detail' },
  { id: 'ended-at', label: '结束时间', priority: 'secondary' },
  { id: 'duration', label: '运行时长', priority: 'detail' },
  { id: 'created-by', label: '创建人', priority: 'detail' },
] as const satisfies readonly AdminDataColumn[];

type CreateDialogState = {
  name: string;
  hostName: string;
  platformImageQuery: string;
  cpu: string;
  memory: string;
  systemDiskSize: string;
  expiresAt: string;
  password: string;
  quantity: string;
  remark: string;
};

type MenuAction = SingleInstanceAction | 'delete-record';

type InstanceCredential = {
  username: string;
  password: string;
};

type CsvExportRow = {
  name: string;
  publicIp: string;
  username: string;
  password: string;
};

function detectDefaultAccount(instance: RangeInstance) {
  const imageName = String(instance.singleInstanceConfig?.imageDisplayName ?? instance.singleInstanceConfig?.imageId ?? '').toLowerCase();
  return imageName.includes('windows') ? 'Administrator' : 'root';
}

type PackImageDialogState = {
  instanceId: string;
  displayName: string;
  defaultHostName: string;
  defaultPassword: string;
  description: string;
};

type ActionMenuPlacement = 'down' | 'up';

const ACTION_MENU_VERTICAL_OFFSET_PX = 8;
const ACTION_MENU_ESTIMATED_HEIGHT_PX = 88;

function isUnauthorizedError(error: unknown) {
  return error instanceof AdminApiError && error.status === 401;
}

function readListMode(value: string | null): ListMode {
  return value === 'history' ? 'history' : 'active';
}

function readCreateImageId(value: string | null) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
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

function formatDuration(start?: string | null, end?: string | null) {
  if (!start || !end) {
    return '暂无';
  }

  const startedAt = new Date(start);
  const endedAt = new Date(end);

  if (Number.isNaN(startedAt.getTime()) || Number.isNaN(endedAt.getTime())) {
    return '暂无';
  }

  const totalMinutes = Math.floor((endedAt.getTime() - startedAt.getTime()) / 60000);

  if (totalMinutes <= 0) {
    return '暂无';
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  return hours > 0 ? `${hours} 小时 ${minutes} 分钟` : `${minutes} 分钟`;
}

function getStatusLabel(status: string) {
  if (status === 'running') {
    return '运行中';
  }

  if (status === 'pending_create' || status === 'creating') {
    return '创建中';
  }

  if (status === 'create_failed') {
    return '创建失败';
  }

  if (status === 'pending_destroy' || status === 'destroying') {
    return '销毁中';
  }

  if (status === 'destroy_failed') {
    return '销毁失败';
  }

  if (status === 'destroyed') {
    return '已销毁';
  }

  return status;
}

function getStatusTone(status: string) {
  if (status === 'running') {
    return 'is-published';
  }

  if (status === 'create_failed' || status === 'destroy_failed') {
    return 'is-danger';
  }

  return 'is-draft';
}

function getImageLabel(instance: RangeInstance) {
  return instance.singleInstanceConfig?.imageDisplayName?.trim() || '暂无';
}

function getSpecLabel(instance: RangeInstance) {
  const cpu = instance.singleInstanceConfig?.cpu;
  const memory = instance.singleInstanceConfig?.memory;

  if (!cpu || !memory) {
    return '暂无';
  }

  return `${cpu} 核 / ${memory} G`;
}

function getBatchSpecLabel(group: SingleInstanceBatchGroup) {
  return `${group.batch.quantity} 台 · ${group.batch.cpu} 核 / ${group.batch.memory} G`;
}

function getPublicIp(instance: RangeInstance) {
  return instance.accessEntry?.publicIp?.trim() || '暂无';
}

function escapeCsvCell(value: string) {
  const normalizedValue = value.replaceAll('"', '""');
  return /[",\n]/.test(normalizedValue) ? `"${normalizedValue}"` : normalizedValue;
}

function readPrimaryCredential(instance: RangeInstance): InstanceCredential | null {
  const hostKey =
    instance.singleInstanceConfig?.hostKey?.trim() ||
    Object.keys(instance.runtimeCredentials ?? {})[0] ||
    '';
  const credential = hostKey ? instance.runtimeCredentials?.[hostKey] : null;
  const username = credential?.username?.trim();
  const password = credential?.password?.trim();

  if (!username || !password) {
    return null;
  }

  const normalizedUsername = username === 'root' && detectDefaultAccount(instance) === 'Administrator'
    ? 'Administrator'
    : username;

  return { username: normalizedUsername, password };
}

function formatMaskedCredential(instance: RangeInstance) {
  const credential = readPrimaryCredential(instance);

  if (!credential) {
    return '暂无';
  }

  return `${credential.username} / ******`;
}

function formatFullCredential(instance: RangeInstance) {
  const credential = readPrimaryCredential(instance);

  if (!credential) {
    return '暂无';
  }

  return `${credential.username} / ${credential.password}`;
}

function exportBatchInstancesCsv(batchName: string, rows: CsvExportRow[]) {
  const header = ['实例名', '公网 IP', '账号', '密码'];
  const csv = [
    header.join(','),
    ...rows.map((row) =>
      [row.name, row.publicIp, row.username, row.password].map((value) => escapeCsvCell(value)).join(','),
    ),
  ].join('\n');
  const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8;' });
  const downloadUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  const safeBatchName = batchName.trim() || 'single-instance-batch';

  link.href = downloadUrl;
  link.download = `${safeBatchName}-instances.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(downloadUrl);
}

function readDefaultPackImageName(instance: RangeInstance) {
  const displayName =
    instance.name?.trim() ||
    instance.singleInstanceConfig?.hostName?.trim() ||
    instance.singleInstanceConfig?.imageDisplayName?.trim() ||
    instance.id;

  return `${displayName}-snapshot`;
}

function normalizeSingleInstanceListPayload(payload: RangeInstance[] | SingleInstanceListPayload) {
  if (Array.isArray(payload)) {
    return {
      batches: [] as SingleInstanceBatchGroup[],
      standaloneInstances: payload,
    };
  }

  return {
    batches: payload.batches ?? [],
    standaloneInstances: payload.standaloneInstances ?? [],
  };
}

function summarizeBatch(instances: RangeInstance[]) {
  return instances.reduce(
    (summary, instance) => {
      if (instance.status === 'running') summary.running += 1;
      else if (instance.status === 'pending_create' || instance.status === 'creating') summary.creating += 1;
      else if (instance.status === 'create_failed') summary.createFailed += 1;
      else if (instance.status === 'pending_destroy' || instance.status === 'destroying') summary.destroying += 1;
      else if (instance.status === 'destroy_failed') summary.destroyFailed += 1;
      else if (instance.status === 'destroyed') summary.destroyed += 1;
      return summary;
    },
    { running: 0, creating: 0, createFailed: 0, destroying: 0, destroyFailed: 0, destroyed: 0 },
  );
}

function formatBatchSummary(instances: RangeInstance[]) {
  const summary = summarizeBatch(instances);
  const parts = [
    summary.running ? `${summary.running} 运行中` : null,
    summary.creating ? `${summary.creating} 创建中` : null,
    summary.createFailed ? `${summary.createFailed} 创建失败` : null,
    summary.destroying ? `${summary.destroying} 销毁中` : null,
    summary.destroyFailed ? `${summary.destroyFailed} 销毁失败` : null,
    summary.destroyed ? `${summary.destroyed} 已关闭` : null,
  ].filter(Boolean);

  return parts.join(' / ') || '暂无';
}

function isHistoryBatch(group: SingleInstanceBatchGroup) {
  return group.instances.length > 0 && group.instances.every((instance) => instance.status === 'destroyed');
}

function readJobTimestamp(job: ProvisionJob | undefined, edge: 'start' | 'end') {
  if (!job) {
    return null;
  }

  if (edge === 'start') {
    return job.startedAt ?? job.finishedAt ?? null;
  }

  return job.finishedAt ?? job.startedAt ?? null;
}

function compareJobTimeAscending(left: ProvisionJob, right: ProvisionJob) {
  return String(left.startedAt ?? left.finishedAt ?? '').localeCompare(String(right.startedAt ?? right.finishedAt ?? ''));
}

function getAvailableActions(status: string): MenuAction[] {
  if (status === 'running') {
    return ['destroy', 'reboot', 'open-vnc', 'pack-image'];
  }

  if (status === 'destroy_failed') {
    return ['retry'];
  }

  if (status === 'create_failed') {
    return ['retry', 'delete-record'];
  }

  return [];
}

function getActionLabel(action: MenuAction, status: string) {
  if (action === 'delete-record') {
    return '删除记录';
  }

  if (action === 'destroy') {
    return '关闭实例';
  }

  if (action === 'retry') {
    return status === 'destroy_failed' ? '重试关闭' : '重试创建';
  }

  if (action === 'reboot') {
    return '重启实例';
  }

  if (action === 'open-vnc') {
    return '打开 VNC';
  }

  return '打包为镜像';
}

function resolveActionMenuPlacement(triggerElement: HTMLElement): ActionMenuPlacement {
  const triggerRect = triggerElement.getBoundingClientRect();
  const containerRect =
    triggerElement.closest('.admin-workbench-panel')?.getBoundingClientRect() ??
    triggerElement.closest('.admin-main-content')?.getBoundingClientRect();
  const availableBelow = (containerRect?.bottom ?? window.innerHeight) - triggerRect.bottom;

  return availableBelow < ACTION_MENU_ESTIMATED_HEIGHT_PX + ACTION_MENU_VERTICAL_OFFSET_PX ? 'up' : 'down';
}

function isPrimaryInlineAction(action: MenuAction) {
  return action === 'destroy' || action === 'open-vnc';
}

function buildPlatformImageOptionLabel(image: PlatformImageAsset) {
  return `${image.displayName} (${image.imageId})`;
}

function findPlatformImageAsset(query: string, images: PlatformImageAsset[]) {
  const normalized = query.trim();

  if (!normalized) {
    return null;
  }

  return (
    images.find((item) => buildPlatformImageOptionLabel(item) === normalized) ??
    images.find((item) => item.displayName === normalized) ??
    images.find((item) => item.imageId === normalized) ??
    null
  );
}

function buildDefaultDialogState(platformImages: PlatformImageAsset[]): CreateDialogState {
  const defaultImage = platformImages.find((item) => item.enabled) ?? platformImages[0] ?? null;

  return {
    name: '',
    hostName: defaultImage?.defaultHostName?.trim() || '',
    platformImageQuery: defaultImage ? buildPlatformImageOptionLabel(defaultImage) : '',
    cpu: '2',
    memory: '2',
    systemDiskSize: '40',
    expiresAt: '',
    password: '',
    quantity: '1',
    remark: '',
  };
}

function SingleInstanceDialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="template-workbench-dialog-backdrop single-instance-dialog-backdrop" role="presentation">
      <section className="template-workbench-dialog single-instance-dialog" role="dialog" aria-modal="true" aria-label={title}>
        <div className="template-workbench-dialog-header">
          <h2>{title}</h2>
          <button type="button" className="single-instance-dialog-close" aria-label="关闭创建实例弹窗" onClick={onClose}>
            ×
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}

export function SingleInstancesScreen({
  apiBaseUrl = 'http://localhost:3001',
  pollIntervalMs = 5000,
}: SingleInstancesScreenProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const session = useAdminSession();
  const [listMode, setListMode] = useState<ListMode>(() => readListMode(searchParams.get('view')));
  const [searchName, setSearchName] = useState('');
  const [instances, setInstances] = useState<RangeInstance[]>([]);
  const [batchGroups, setBatchGroups] = useState<SingleInstanceBatchGroup[]>([]);
  const [jobs, setJobs] = useState<ProvisionJob[]>([]);
  const [platformImages, setPlatformImages] = useState<PlatformImageAsset[]>([]);
  const [hasLoadedPlatformImages, setHasLoadedPlatformImages] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [loadedListMode, setLoadedListMode] = useState<ListMode | null>(null);
  const [listErrorMessage, setListErrorMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [menuInstanceId, setMenuInstanceId] = useState<string | null>(null);
  const [menuPlacement, setMenuPlacement] = useState<ActionMenuPlacement>('down');
  const [pendingActionInstanceId, setPendingActionInstanceId] = useState<string | null>(null);
  const [expandedBatchIds, setExpandedBatchIds] = useState<string[]>([]);
  const [copiedPasswordInstanceId, setCopiedPasswordInstanceId] = useState<string | null>(null);
  const [createForm, setCreateForm] = useState<CreateDialogState>(buildDefaultDialogState([]));
  const [instanceTypeAvailability, setInstanceTypeAvailability] = useState<InstanceTypeAvailabilitySnapshot | null>(null);
  const [createFormError, setCreateFormError] = useState<string | null>(null);
  const [packImageDialog, setPackImageDialog] = useState<PackImageDialogState | null>(null);
  const [listPages, setListPages] = useState<Record<ListMode, number>>({ active: 1, history: 1 });
  const [jumpPageValue, setJumpPageValue] = useState('1');
  const instanceTypeAvailabilityRequestRef = useRef(0);
  const listRequestIdRef = useRef(0);
  const loadedListModeRef = useRef<ListMode | null>(null);
  const copiedPasswordTimerRef = useRef<number | null>(null);
  const consumedPrefillRef = useRef<string | null>(null);
  const { pageSizeMode, pageSize, setPageSizeMode, setPageSize } = useAdminPageSize();

  async function fetchSingleInstanceRows(token: string, nextListMode: ListMode) {
    const [nextPayload, nextJobs] = await Promise.all([
      fetchSingleInstances(apiBaseUrl, token, {
        view: nextListMode === 'history' ? 'history' : 'active',
      }),
      nextListMode === 'history'
        ? fetchProvisionJobs(apiBaseUrl, token, { instanceMode: 'single' })
        : Promise.resolve([] as ProvisionJob[]),
    ]);
    const normalizedPayload = normalizeSingleInstanceListPayload(nextPayload);
    const singleInstances = normalizedPayload.standaloneInstances.filter((instance) => instance.instanceMode === 'single');
    const batchInstanceIds = normalizedPayload.batches.flatMap((group) => group.instances.map((instance) => instance.id));
    const trackedInstanceIds = new Set([...singleInstances.map((instance) => instance.id), ...batchInstanceIds]);

    return {
      batchGroups: normalizedPayload.batches,
      instances: singleInstances,
      jobs: nextJobs.filter((job) => trackedInstanceIds.has(job.rangeInstanceId)),
    };
  }

  async function refreshSingleInstanceRows(token: string, nextListMode: ListMode) {
    const requestId = listRequestIdRef.current + 1;
    const hasCurrentSnapshot = loadedListModeRef.current === nextListMode;
    listRequestIdRef.current = requestId;
    setListErrorMessage(null);

    if (hasCurrentSnapshot) {
      setIsRefreshing(true);
    } else {
      setIsLoading(true);
    }

    try {
      const nextRows = await fetchSingleInstanceRows(token, nextListMode);

      if (requestId !== listRequestIdRef.current) {
        return nextRows;
      }

      setBatchGroups(nextRows.batchGroups);
      setInstances(nextRows.instances);
      setJobs(nextRows.jobs);
      loadedListModeRef.current = nextListMode;
      setLoadedListMode(nextListMode);
      return nextRows;
    } catch (error: unknown) {
      if (requestId === listRequestIdRef.current && !isUnauthorizedError(error)) {
        setListErrorMessage('实例管理数据加载失败，请稍后重试。');
      }

      throw error;
    } finally {
      if (requestId === listRequestIdRef.current) {
        setIsLoading(false);
        setIsRefreshing(false);
      }
    }
  }

  useEffect(() => {
    if (!session.isReady || !session.token) {
      setBatchGroups([]);
      setInstances([]);
      setJobs([]);
      loadedListModeRef.current = null;
      setLoadedListMode(null);
      setListErrorMessage(null);
      setErrorMessage(null);
      setIsLoading(false);
      setIsRefreshing(false);
      return;
    }

    let isActive = true;

    void refreshSingleInstanceRows(session.token, listMode)
      .catch((error: unknown) => {
        if (!isActive) {
          return;
        }

        if (isUnauthorizedError(error)) {
          session.logout();
          router.replace('/admin/login');
        }
      });

    return () => {
      isActive = false;
      listRequestIdRef.current += 1;
    };
  }, [apiBaseUrl, listMode, router, session.isReady, session.token]);

  useEffect(() => {
    if (!session.isReady) {
      return;
    }

    if (!session.token) {
      setPlatformImages([]);
      setHasLoadedPlatformImages(false);
      return;
    }

    let isActive = true;

    setPlatformImages([]);
    setHasLoadedPlatformImages(false);

    void fetchPlatformImages(apiBaseUrl, session.token)
      .then((nextImages) => {
        if (!isActive) {
          return;
        }

        setPlatformImages(nextImages.items);
        setHasLoadedPlatformImages(true);
        setCreateForm((current) =>
          current.platformImageQuery ? current : buildDefaultDialogState(nextImages.items.filter((item) => item.enabled)),
        );
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

        setHasLoadedPlatformImages(true);
      });

    return () => {
      isActive = false;
    };
  }, [apiBaseUrl, router, session.isReady, session.token]);

  useEffect(() => {
    if (!session.isReady || !session.token || pollIntervalMs <= 0 || listMode === 'history') {
      return;
    }

    const token = session.token;
    const timer = window.setInterval(() => {
      void refreshSingleInstanceRows(token, listMode).catch((error: unknown) => {
        if (isUnauthorizedError(error)) {
          session.logout();
          router.replace('/admin/login');
        }
      });
    }, pollIntervalMs);

    return () => {
      window.clearInterval(timer);
    };
  }, [listMode, loadedListMode, pollIntervalMs, router, session, session.isReady, session.token]);

  useEffect(() => {
    return () => {
      if (copiedPasswordTimerRef.current !== null) {
        window.clearTimeout(copiedPasswordTimerRef.current);
      }
    };
  }, []);

  const jobsByInstanceId = useMemo(() => {
    return jobs.reduce<Map<string, ProvisionJob[]>>((map, job) => {
      const existing = map.get(job.rangeInstanceId) ?? [];
      existing.push(job);
      map.set(job.rangeInstanceId, existing);
      return map;
    }, new Map<string, ProvisionJob[]>());
  }, [jobs]);

  const lifecycleByInstanceId = useMemo(() => {
    return Array.from(jobsByInstanceId.entries()).reduce<
      Map<string, { createJob?: ProvisionJob; destroyJob?: ProvisionJob }>
    >((map, [instanceId, instanceJobs]) => {
      let createJob: ProvisionJob | undefined;
      let destroyJob: ProvisionJob | undefined;
      let retryPhase: 'create' | 'destroy' | null = null;

      for (const job of instanceJobs.slice().sort(compareJobTimeAscending)) {
        if (job.jobType === 'create') {
          retryPhase = 'create';

          if (job.status === 'succeeded') {
            createJob = job;
          }

          continue;
        }

        if (job.jobType === 'destroy') {
          retryPhase = 'destroy';

          if (job.status === 'succeeded') {
            destroyJob = job;
          }

          continue;
        }

        if (job.jobType === 'retry' && job.status === 'succeeded') {
          if (retryPhase === 'create') {
            createJob = job;
          }

          if (retryPhase === 'destroy') {
            destroyJob = job;
          }
        }
      }

      map.set(instanceId, {
        createJob,
        destroyJob,
      });
      return map;
    }, new Map<string, { createJob?: ProvisionJob; destroyJob?: ProvisionJob }>());
  }, [jobsByInstanceId]);

  const activeInstances = useMemo(
    () => instances.filter((instance) => instance.status !== 'destroyed'),
    [instances],
  );
  const historyInstances = useMemo(
    () => instances.filter((instance) => instance.status === 'destroyed'),
    [instances],
  );
  const enabledPlatformImages = useMemo(
    () => platformImages.filter((item) => item.enabled),
    [platformImages],
  );

  useEffect(() => {
    if (!session.isReady || !session.token) {
      return;
    }

    const platformImageAssetId = readCreateImageId(searchParams.get('platformImageAssetId'));
    const shouldOpenCreate = searchParams.get('create') === '1';

    if (!shouldOpenCreate || !platformImageAssetId || consumedPrefillRef.current === platformImageAssetId) {
      return;
    }

    const selectedImage = enabledPlatformImages.find((item) => item.id === platformImageAssetId);

    if (!selectedImage) {
      return;
    }

    consumedPrefillRef.current = platformImageAssetId;
    setCreateForm({
      ...buildDefaultDialogState(enabledPlatformImages),
      hostName: selectedImage.defaultHostName?.trim() || '',
      platformImageQuery: buildPlatformImageOptionLabel(selectedImage),
    });
    setCreateFormError(null);
    setIsCreateOpen(true);

    const nextSearchParams = new URLSearchParams(searchParams.toString());
    nextSearchParams.delete('create');
    nextSearchParams.delete('platformImageAssetId');
    const nextQuery = nextSearchParams.toString();
    window.history.replaceState(null, '', nextQuery ? `${window.location.pathname}?${nextQuery}` : window.location.pathname);
  }, [enabledPlatformImages, searchParams, session.isReady, session.token]);
  const activeBatchGroups = useMemo(
    () => batchGroups.filter((group) => !isHistoryBatch(group)),
    [batchGroups],
  );
  const historyBatchGroups = useMemo(
    () => batchGroups.filter((group) => isHistoryBatch(group)),
    [batchGroups],
  );
  const normalizedSearchName = searchName.trim().toLowerCase();

  function updateCreateForm<K extends keyof CreateDialogState>(field: K, value: CreateDialogState[K]) {
    setCreateFormError(null);
    setCreateForm((current) => ({
      ...current,
      [field]: value,
    }));
  }

  function openCreateDialog() {
    setCreateForm(buildDefaultDialogState(enabledPlatformImages));
    setCreateFormError(null);
    setIsCreateOpen(true);
  }

  function setListModeWithUrl(nextMode: ListMode) {
    if (loadedListModeRef.current !== nextMode) {
      setListErrorMessage(null);
      setIsLoading(true);
    }

    setListMode(nextMode);

    const nextSearchParams = new URLSearchParams(searchParams.toString());
    if (nextMode === 'history') {
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

  function toggleActionMenu(instanceId: string, triggerElement: HTMLElement) {
    if (menuInstanceId === instanceId) {
      setMenuInstanceId(null);
      setMenuPlacement('down');
      return;
    }

    setMenuInstanceId(instanceId);
    setMenuPlacement(resolveActionMenuPlacement(triggerElement));
  }

  useEffect(() => {
    if (!isCreateOpen) {
      setInstanceTypeAvailability(null);
      return;
    }

    if (!session.isReady || !session.token) {
      return;
    }

    const cpu = Number(createForm.cpu);
    const memory = Number(createForm.memory);

    if (!Number.isInteger(cpu) || cpu <= 0 || !Number.isInteger(memory) || memory <= 0) {
      setInstanceTypeAvailability(null);
      return;
    }

    let isActive = true;
    const requestId = instanceTypeAvailabilityRequestRef.current + 1;
    instanceTypeAvailabilityRequestRef.current = requestId;

    fetchInstanceTypeAvailability(apiBaseUrl, session.token, cpu, memory)
      .then((payload) => {
        if (!isActive || requestId !== instanceTypeAvailabilityRequestRef.current) {
          return;
        }

        setInstanceTypeAvailability(payload);
      })
      .catch((error) => {
        if (!isActive || requestId !== instanceTypeAvailabilityRequestRef.current) {
          return;
        }

        if (error instanceof AdminApiError && error.status === 401) {
          session.logout();
          router.replace('/admin/login');
          return;
        }

        setInstanceTypeAvailability({
          cpu,
          memory,
          regionId: '',
          zoneId: '',
          exactAvailable: false,
          matches: [],
          warning: error instanceof Error ? `规格校验失败：${error.message}` : '规格校验失败，请稍后重试',
        });
      });

    return () => {
      isActive = false;
    };
  }, [apiBaseUrl, createForm.cpu, createForm.memory, isCreateOpen, session.isReady, session.token]);

  async function handleCreateSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!session.token) {
      return;
    }

    const selectedPlatformImage = findPlatformImageAsset(createForm.platformImageQuery, enabledPlatformImages);
    const cpu = Number(createForm.cpu);
    const memory = Number(createForm.memory);

    if (!selectedPlatformImage) {
      setCreateFormError('请先选择一个可用的平台镜像。');
      return;
    }

    if (
      !instanceTypeAvailability ||
      instanceTypeAvailability.cpu !== cpu ||
      instanceTypeAvailability.memory !== memory ||
      !instanceTypeAvailability.exactAvailable
    ) {
      setCreateFormError('当前规格未通过可售校验，请调整 CPU / 内存或稍后重试。');
      return;
    }

    const payload: SingleInstanceLaunchInput = {
      name: createForm.name.trim(),
      hostName: createForm.hostName.trim() || undefined,
      platformImageAssetId: selectedPlatformImage.id,
      cpu,
      memory,
      ...(createForm.systemDiskSize.trim() ? { systemDiskSize: Number(createForm.systemDiskSize) } : {}),
      expiresAt: new Date(createForm.expiresAt).toISOString(),
      password: createForm.password.trim() || undefined,
      quantity: Number(createForm.quantity),
      remark: createForm.remark.trim() || undefined,
    };

    setIsSubmitting(true);
    setCreateFormError(null);
    setErrorMessage(null);

    try {
      await launchSingleInstances(apiBaseUrl, session.token, payload);
      await refreshSingleInstanceRows(session.token, listMode);
      setIsCreateOpen(false);
    } catch (error: unknown) {
      if (isUnauthorizedError(error)) {
        session.logout();
        router.replace('/admin/login');
        return;
      }

      setErrorMessage('创建实例失败，请稍后重试。');
    } finally {
      setIsSubmitting(false);
    }
  }

  function openPackImageDialog(instance: RangeInstance) {
    setMenuInstanceId(null);
    setMenuPlacement('down');
    setPackImageDialog({
      instanceId: instance.id,
      displayName: readDefaultPackImageName(instance),
      defaultHostName: instance.singleInstanceConfig?.hostName?.trim() || '',
      defaultPassword: '',
      description: '',
    });
  }

  async function handleConfirmPackImage() {
    if (!session.token || !packImageDialog) {
      return;
    }

    setErrorMessage(null);
    setPendingActionInstanceId(packImageDialog.instanceId);

    try {
      const result = await triggerSingleInstanceAction(
        apiBaseUrl,
        session.token,
        packImageDialog.instanceId,
        'pack-image',
        {
          displayName: packImageDialog.displayName,
          defaultHostName: packImageDialog.defaultHostName,
          defaultPassword: packImageDialog.defaultPassword,
          description: packImageDialog.description,
        },
      );

      setPackImageDialog(null);
      setErrorMessage(
        result &&
          typeof result === 'object' &&
          'imageReady' in result &&
          (result as { imageReady?: unknown }).imageReady === true
          ? `镜像打包完成，已保存到我的镜像：${packImageDialog.displayName}`
          : `镜像打包任务已提交，镜像可用后会出现在我的镜像：${packImageDialog.displayName}`,
      );
      await refreshSingleInstanceRows(session.token, listMode);
    } catch (error: unknown) {
      if (isUnauthorizedError(error)) {
        session.logout();
        router.replace('/admin/login');
        return;
      }

      setErrorMessage('镜像打包失败，请稍后重试。');
    } finally {
      setPendingActionInstanceId(null);
    }
  }

  async function handleAction(instance: RangeInstance, action: MenuAction) {
    if (!session.token) {
      return;
    }

    if (action === 'pack-image') {
      openPackImageDialog(instance);
      return;
    }

    if (pendingActionInstanceId) {
      return;
    }

    setMenuInstanceId(null);
    setMenuPlacement('down');
    setErrorMessage(null);
    setPendingActionInstanceId(instance.id);
    const openedWindow =
      action === 'open-vnc'
        ? window.open('', '_blank')
        : null;

    try {
      const vncWindow = action === 'open-vnc' ? openedWindow : null;
      if (action === 'open-vnc') {
        if (!vncWindow) {
          setErrorMessage('浏览器阻止了新窗口，请允许弹窗后重试。');
          return;
        }

        vncWindow.opener = null;
      }

      if (action === 'delete-record') {
        await deleteRangeInstance(apiBaseUrl, session.token, instance.id);
        await refreshSingleInstanceRows(session.token, listMode);
        return;
      }

      const result = await triggerSingleInstanceAction(apiBaseUrl, session.token, instance.id, action, {});

      if (action === 'open-vnc') {
        if (!vncWindow) {
          setErrorMessage('浏览器阻止了新窗口，请允许弹窗后重试。');
          return;
        }

        const nextUrl =
          result &&
          typeof result === 'object' &&
          'webTerminalUrl' in result &&
          typeof (result as { webTerminalUrl?: unknown }).webTerminalUrl === 'string'
            ? (result as { webTerminalUrl: string }).webTerminalUrl.trim()
            : result &&
                typeof result === 'object' &&
                'vncUrl' in result &&
                typeof (result as { vncUrl?: unknown }).vncUrl === 'string'
              ? (result as { vncUrl: string }).vncUrl.trim()
            : '';

        if (!nextUrl) {
          vncWindow.close();
          setErrorMessage('VNC 地址未返回，请稍后重试。');
          return;
        }

        vncWindow.location.href = nextUrl;
        return;
      }

      await refreshSingleInstanceRows(session.token, listMode);
    } catch (error: unknown) {
      openedWindow?.close();
      if (isUnauthorizedError(error)) {
        session.logout();
        router.replace('/admin/login');
        return;
      }

      setErrorMessage('实例操作失败，请稍后重试。');
    } finally {
      setPendingActionInstanceId(null);
    }
  }

  async function handleCopyPassword(instance: RangeInstance) {
    const credential = readPrimaryCredential(instance);

    if (!credential) {
      setErrorMessage('当前实例暂无可复制的密码。');
      return;
    }

    try {
      await navigator.clipboard.writeText(credential.password);
      setCopiedPasswordInstanceId(instance.id);
      if (copiedPasswordTimerRef.current !== null) {
        window.clearTimeout(copiedPasswordTimerRef.current);
      }
      copiedPasswordTimerRef.current = window.setTimeout(() => {
        setCopiedPasswordInstanceId((current) => (current === instance.id ? null : current));
        copiedPasswordTimerRef.current = null;
      }, 1600);
    } catch {
      setErrorMessage('复制密码失败，请手动复制。');
    }
  }

  async function handleBatchDestroy(batchId: string) {
    if (!session.token) {
      return;
    }

    setMenuInstanceId(null);
    setMenuPlacement('down');
    setErrorMessage(null);

    try {
      await destroySingleInstanceBatch(apiBaseUrl, session.token, batchId);
      await refreshSingleInstanceRows(session.token, listMode);
    } catch (error: unknown) {
      if (isUnauthorizedError(error)) {
        session.logout();
        router.replace('/admin/login');
        return;
      }

      setErrorMessage('批量关闭失败，请稍后重试。');
    }
  }

  function handleListRetry() {
    if (!session.token) {
      return;
    }

    void refreshSingleInstanceRows(session.token, listMode).catch((error: unknown) => {
      if (isUnauthorizedError(error)) {
        session.logout();
        router.replace('/admin/login');
      }
    });
  }

  function handleBatchExport(group: SingleInstanceBatchGroup) {
    exportBatchInstancesCsv(
      group.batch.name,
      group.instances.map((instance) => {
        const credential = readPrimaryCredential(instance);

        return {
          name: instance.name?.trim() || instance.id,
          publicIp: getPublicIp(instance),
          username: credential?.username || '暂无',
          password: credential?.password || '暂无',
        };
      }),
    );
  }

  const visibleInstances = (listMode === 'history' ? historyInstances : activeInstances).filter((instance) =>
    normalizedSearchName
      ? (instance.name?.trim().toLowerCase() || '').includes(normalizedSearchName)
      : true,
  );
  const visibleBatchGroups = (listMode === 'history' ? historyBatchGroups : activeBatchGroups).filter((group) =>
    normalizedSearchName ? group.batch.name.trim().toLowerCase().includes(normalizedSearchName) : true,
  );
  const hasCurrentViewSnapshot = loadedListMode === listMode;
  const currentItemsCount = hasCurrentViewSnapshot ? visibleBatchGroups.length + visibleInstances.length : 0;
  const activePagination = getPagination(currentItemsCount, listPages[listMode], pageSize);
  const visiblePages = buildVisiblePages(activePagination.totalPages, activePagination.page);
  const pagedBatchGroups = visibleBatchGroups.slice(activePagination.startIndex, activePagination.endIndex);
  const pagedInstances = visibleInstances.slice(
    Math.max(0, activePagination.startIndex - visibleBatchGroups.length),
    Math.max(0, activePagination.endIndex - visibleBatchGroups.length),
  );
  const hasVisibleContent = hasCurrentViewSnapshot && (visibleBatchGroups.length > 0 || visibleInstances.length > 0);
  const isBootstrapLoading = !hasCurrentViewSnapshot && !listErrorMessage;

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

  function renderCredentials(instance: RangeInstance) {
    return (
      <div className="flex min-w-40 items-center gap-1.5" title={formatFullCredential(instance)}>
        <span className="truncate">{formatMaskedCredential(instance)}</span>
        <Button
          aria-label="复制密码"
          className="shrink-0"
          onClick={() => void handleCopyPassword(instance)}
          size="icon-xs"
          type="button"
          variant="ghost"
        >
          <Copy aria-hidden="true" />
        </Button>
      </div>
    );
  }

  function renderInstanceActions(instance: RangeInstance, actions: MenuAction[]) {
    const inlineActions = actions.filter(isPrimaryInlineAction);
    const menuActions = actions.filter((action) => !isPrimaryInlineAction(action));
    const isActionPending = pendingActionInstanceId === instance.id;

    if (!actions.length) {
      return null;
    }

    return (
      <div className="template-workbench-row-menu relative flex justify-start gap-1">
        {inlineActions.map((action) => (
          <Button
            disabled={isActionPending}
            key={action}
            onClick={() => void handleAction(instance, action)}
            size="sm"
            type="button"
            variant="outline"
          >
            {getActionLabel(action, instance.status)}
          </Button>
        ))}
        {menuActions.length ? (
          <>
            <Button
              aria-label="更多操作"
              disabled={isActionPending}
              onClick={(event) => toggleActionMenu(instance.id, event.currentTarget)}
              size="icon-sm"
              type="button"
              variant="ghost"
            >
              <MoreHorizontal aria-hidden="true" />
            </Button>
            {menuInstanceId === instance.id ? (
              <div className={`template-workbench-action-menu${menuPlacement === 'up' ? ' is-upward' : ''}`}>
                {menuActions.map((action) => (
                  <Button
                    disabled={isActionPending}
                    key={action}
                    onClick={() => void handleAction(instance, action)}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    {getActionLabel(action, instance.status)}
                  </Button>
                ))}
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    );
  }

  function renderActiveInstanceCells(
    instance: RangeInstance,
    columns: readonly AdminDataColumn[],
    { indented = false, canPackImage = true }: { indented?: boolean; canPackImage?: boolean } = {},
  ) {
    const actions = getAvailableActions(instance.status).filter((action) => action !== 'pack-image' || canPackImage);

    return (
      <>
        <AdminDataTableCell className={indented ? 'pl-10' : undefined} column={columns[0]}>
          <strong>{instance.name?.trim() || instance.id}</strong>
        </AdminDataTableCell>
        <AdminDataTableCell column={columns[1]}>{getImageLabel(instance)}</AdminDataTableCell>
        <AdminDataTableCell column={columns[2]}>{getSpecLabel(instance)}</AdminDataTableCell>
        <AdminDataTableCell column={columns[3]}>{getPublicIp(instance)}</AdminDataTableCell>
        <AdminDataTableCell column={columns[4]}>
          <StatusBadge status={instance.status} />
        </AdminDataTableCell>
        <AdminDataTableCell column={columns[5]}>{formatDateTime(instance.createdAt)}</AdminDataTableCell>
        <AdminDataTableCell column={columns[6]}>{formatDateTime(instance.expiresAt)}</AdminDataTableCell>
        <AdminDataTableCell column={columns[7]}>{instance.createdBy?.trim() || '暂无'}</AdminDataTableCell>
        <AdminDataTableCell column={columns[8]}>{renderCredentials(instance)}</AdminDataTableCell>
        <AdminDataTableCell column={columns[9]}>{renderInstanceActions(instance, actions)}</AdminDataTableCell>
      </>
    );
  }

  function renderHistoryInstanceCells(
    instance: RangeInstance,
    columns: readonly AdminDataColumn[],
    { indented = false }: { indented?: boolean } = {},
  ) {
    const lifecycle = lifecycleByInstanceId.get(instance.id);
    const startedAt = readJobTimestamp(lifecycle?.createJob, 'start') ?? instance.createdAt ?? null;
    const endedAt = readJobTimestamp(lifecycle?.destroyJob, 'end') ?? null;

    return (
      <>
        <AdminDataTableCell className={indented ? 'pl-10' : undefined} column={columns[0]}>
          <strong>{instance.name?.trim() || instance.id}</strong>
        </AdminDataTableCell>
        <AdminDataTableCell column={columns[1]}>{getImageLabel(instance)}</AdminDataTableCell>
        <AdminDataTableCell column={columns[2]}>{getSpecLabel(instance)}</AdminDataTableCell>
        <AdminDataTableCell column={columns[3]}>{getPublicIp(instance)}</AdminDataTableCell>
        <AdminDataTableCell column={columns[4]}>{formatDateTime(startedAt)}</AdminDataTableCell>
        <AdminDataTableCell column={columns[5]}>{formatDateTime(endedAt)}</AdminDataTableCell>
        <AdminDataTableCell column={columns[6]}>{formatDuration(startedAt, endedAt)}</AdminDataTableCell>
        <AdminDataTableCell column={columns[7]}>{instance.createdBy?.trim() || 'admin'}</AdminDataTableCell>
      </>
    );
  }

  if (!session.isReady) {
    return null;
  }

  if (!session.token) {
    return (
      <main className="admin-shell">
        <section className="admin-panel admin-login-panel">
          <h2>正在跳转到管理员登录页...</h2>
        </section>
      </main>
    );
  }

  const tableColumns = listMode === 'history' ? historyInstanceColumns : activeInstanceColumns;
  const tableLabel = listMode === 'history' ? '实例历史' : '实例列表';
  const tableLoadingLabel = `正在加载${tableLabel}`;
  const emptyTitle = listMode === 'history' ? '暂无实例历史' : '暂无实例';
  const emptyDescription = normalizedSearchName ? '没有找到匹配的实例或批次。' : '当前视图还没有可查看的实例。';

  return (
    <div className="admin-screen admin-workbench-screen single-instance-screen">
      {errorMessage ? (
        <p className="mb-3 text-sm text-destructive" role="alert">
          {errorMessage}
        </p>
      ) : null}

      <section className="admin-workbench-surface">
        <AdminPageHeader description="创建并管理训练实例、批次与生命周期。" title="实例管理" />

        <div className="mt-4 space-y-4">
            <AdminListToolbar
              activeView={listMode}
              action={
                <Button disabled={!enabledPlatformImages.length} onClick={openCreateDialog} type="button">
                  <Plus aria-hidden="true" data-icon="inline-start" />
                  创建实例
                </Button>
              }
              onSearchChange={setSearchName}
              onViewChange={(nextView) => setListModeWithUrl(nextView === 'history' ? 'history' : 'active')}
              searchLabel="筛选实例名"
              searchPlaceholder="搜索实例名"
              searchValue={searchName}
              views={[
                { value: 'active', label: '实例列表' },
                { value: 'history', label: '实例历史' },
              ]}
            >
              <div>
                <AdminDataTable
                  columns={tableColumns}
                  isRefreshing={isBootstrapLoading || (isRefreshing && hasCurrentViewSnapshot)}
                  label={tableLabel}
                >
                  {(columns) => {
                    if (isBootstrapLoading) {
                      return <TableLoadingState columnCount={columns.length} label={tableLoadingLabel} rowCount={5} />;
                    }

                    if (listErrorMessage && !hasCurrentViewSnapshot) {
                      return (
                        <AdminDataTableState
                          columns={columns}
                          description="请检查网络连接后重试。"
                          onRetry={handleListRetry}
                          title={listErrorMessage}
                          variant="error"
                        />
                      );
                    }

                    const retainedSnapshotError =
                      listErrorMessage && hasCurrentViewSnapshot ? (
                        <AdminDataTableState
                          columns={columns}
                          description="已保留最近一次加载的实例数据。请重试刷新以获取最新状态。"
                          onRetry={handleListRetry}
                          title={listErrorMessage}
                          variant="error"
                        />
                      ) : null;

                    if (retainedSnapshotError && !hasVisibleContent) {
                      return retainedSnapshotError;
                    }

                    if (!hasVisibleContent) {
                      return (
                        <AdminDataTableState
                          columns={columns}
                          description={emptyDescription}
                          title={emptyTitle}
                          variant="empty"
                        />
                      );
                    }

                    const listRows = (
                      <>
                        {pagedBatchGroups.map((group) => {
                          const isExpanded = expandedBatchIds.includes(group.batch.id);
                          const isHistoryGroup = listMode === 'history';

                          return (
                            <React.Fragment key={group.batch.id}>
                              <TableRow className="bg-muted/20 hover:bg-muted/30">
                                <AdminDataTableCell column={columns[0]}>
                                  <div className="flex min-w-44 items-center gap-2">
                                    <Button
                                      aria-label={`${isExpanded ? '收起' : '展开'}批次 ${group.batch.name}`}
                                      onClick={() =>
                                        setExpandedBatchIds((current) =>
                                          current.includes(group.batch.id)
                                            ? current.filter((id) => id !== group.batch.id)
                                            : [...current, group.batch.id],
                                        )
                                      }
                                      size="icon-xs"
                                      type="button"
                                      variant="ghost"
                                    >
                                      {isExpanded ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
                                    </Button>
                                    <div className="min-w-0">
                                      <span className="block text-xs text-muted-foreground">批次</span>
                                      <strong className="block truncate">{group.batch.name}</strong>
                                    </div>
                                  </div>
                                </AdminDataTableCell>
                                <AdminDataTableCell column={columns[1]}>{group.batch.imageDisplayName}</AdminDataTableCell>
                                <AdminDataTableCell column={columns[2]}>
                                  {isHistoryGroup ? `${getBatchSpecLabel(group)} · ${formatBatchSummary(group.instances)}` : getBatchSpecLabel(group)}
                                </AdminDataTableCell>
                                <AdminDataTableCell column={columns[3]}>批次实例</AdminDataTableCell>
                                {isHistoryGroup ? (
                                  <>
                                    <AdminDataTableCell column={columns[4]}>{formatDateTime(group.batch.createdAt)}</AdminDataTableCell>
                                    <AdminDataTableCell column={columns[5]}>{formatDateTime(group.batch.expiresAt)}</AdminDataTableCell>
                                    <AdminDataTableCell column={columns[6]}>
                                      {formatDuration(group.batch.createdAt, group.batch.expiresAt)}
                                    </AdminDataTableCell>
                                    <AdminDataTableCell column={columns[7]}>{group.batch.createdBy?.trim() || 'admin'}</AdminDataTableCell>
                                  </>
                                ) : (
                                  <>
                                    <AdminDataTableCell column={columns[4]}>{formatBatchSummary(group.instances)}</AdminDataTableCell>
                                    <AdminDataTableCell column={columns[5]}>{formatDateTime(group.batch.createdAt)}</AdminDataTableCell>
                                    <AdminDataTableCell column={columns[6]}>{formatDateTime(group.batch.expiresAt)}</AdminDataTableCell>
                                    <AdminDataTableCell column={columns[7]}>{group.batch.createdBy?.trim() || 'admin'}</AdminDataTableCell>
                                    <AdminDataTableCell column={columns[8]}>批次内实例</AdminDataTableCell>
                                    <AdminDataTableCell column={columns[9]}>
                                      <div className="flex justify-start gap-1">
                                        <Button onClick={() => handleBatchExport(group)} size="sm" type="button" variant="outline">
                                          导出
                                        </Button>
                                        <Button onClick={() => void handleBatchDestroy(group.batch.id)} size="sm" type="button" variant="destructive">
                                          关闭
                                        </Button>
                                      </div>
                                    </AdminDataTableCell>
                                  </>
                                )}
                              </TableRow>
                              {isExpanded
                                ? group.instances.map((instance) => (
                                    <TableRow className="bg-muted/10 hover:bg-muted/20" key={instance.id}>
                                      {isHistoryGroup
                                        ? renderHistoryInstanceCells(instance, columns, { indented: true })
                                        : renderActiveInstanceCells(instance, columns, {
                                            indented: true,
                                            canPackImage: group.batch.quantity <= 1,
                                          })}
                                    </TableRow>
                                  ))
                                : null}
                            </React.Fragment>
                          );
                        })}
                        {pagedInstances.map((instance) => (
                          <TableRow key={instance.id}>
                            {listMode === 'history'
                              ? renderHistoryInstanceCells(instance, columns)
                              : renderActiveInstanceCells(instance, columns)}
                          </TableRow>
                        ))}
                      </>
                    );
                    return (
                      <>
                        {retainedSnapshotError}
                        {listRows}
                      </>
                    );
                  }}
                </AdminDataTable>
              </div>

              {hasVisibleContent ? (
                <AdminPaginationControls
                  jumpPageValue={jumpPageValue}
                  label={`${tableLabel} 分页`}
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
              ) : null}
            </AdminListToolbar>

            {hasLoadedPlatformImages && !enabledPlatformImages.length ? (
              <p className="text-sm text-muted-foreground">请先前往镜像中心收录或启用至少一个平台镜像。</p>
            ) : null}
        </div>
      </section>

      {false ? (
      <section>
        <article className="admin-workbench-panel range-workbench-shell">
          <div className="template-workbench-list-header range-workbench-header">
            <div className="template-workbench-list-header-copy">
              <h2>实例管理</h2>
            </div>
          </div>

          <div className="template-workbench-controls range-workbench-controls">
            <div className="template-workbench-search-grid">
              <label className="template-workbench-search-field">
                <span className="sr-only">实例名搜索</span>
                <input
                  aria-label="筛选实例名"
                  value={searchName}
                  onChange={(event) => setSearchName(event.target.value)}
                  placeholder="搜索实例名"
                />
              </label>
            </div>

            <div className="single-instance-toolbar-actions">
              <div className="template-workbench-segmented range-workbench-segmented" role="tablist" aria-label="实例视图切换">
                <button type="button" aria-pressed={listMode === 'active'} onClick={() => setListModeWithUrl('active')}>
                  实例列表
                </button>
                <button type="button" aria-pressed={listMode === 'history'} onClick={() => setListModeWithUrl('history')}>
                  实例历史
                </button>
              </div>

              <button
                type="button"
                className="template-workbench-primary-action"
                onClick={openCreateDialog}
                disabled={!enabledPlatformImages.length}
              >
                创建实例
              </button>
            </div>
          </div>
          {hasLoadedPlatformImages && !enabledPlatformImages.length ? (
            <p className="admin-empty">请先前往镜像中心收录或启用至少一个平台镜像。</p>
          ) : null}

          {isBootstrapLoading ? (
            listMode === 'active' ? (
              <div className="single-instance-batch-section">
                <div className="single-instance-batch-header">
                  <div></div>
                  <div>批次名</div>
                  <div>镜像</div>
                  <div>数量</div>
                  <div>状态汇总</div>
                  <div>创建时间</div>
                  <div>到期时间</div>
                  <div>创建人</div>
                  <div>批量操作</div>
                </div>
                <div className="admin-workbench-empty" aria-hidden="true" />
              </div>
            ) : (
              <div className="admin-workbench-empty" aria-hidden="true" />
            )
          ) : hasVisibleContent ? (
            <>
              {pagedBatchGroups.length > 0 ? (
                <div className="single-instance-batch-section">
                  <div className={`single-instance-batch-header${listMode === 'history' ? ' is-history' : ''}`}>
                    <div></div>
                    <div>批次名</div>
                    <div>镜像</div>
                    <div>数量</div>
                    <div>{listMode === 'history' ? '结果汇总' : '状态汇总'}</div>
                    <div>创建时间</div>
                    <div>{listMode === 'history' ? '结束时间' : '到期时间'}</div>
                    <div>创建人</div>
                    {listMode === 'history' ? null : <div>批量操作</div>}
                  </div>
                  {pagedBatchGroups.map((group) => {
                    const isExpanded = expandedBatchIds.includes(group.batch.id);
                    const isHistoryGroup = isHistoryBatch(group);

                    return (
                      <div key={group.batch.id} className="single-instance-batch-card">
                        <div className={`single-instance-batch-row${isHistoryGroup ? ' is-history' : ''}`}>
                          <button
                            type="button"
                            className="single-instance-batch-toggle"
                            aria-label={`展开批次 ${group.batch.name}`}
                            onClick={() =>
                              setExpandedBatchIds((current) =>
                                current.includes(group.batch.id)
                                  ? current.filter((id) => id !== group.batch.id)
                                  : [...current, group.batch.id],
                              )
                            }
                          >
                            {isExpanded ? '−' : '+'}
                          </button>
                          <div className="range-workbench-main">
                            <strong>{group.batch.name}</strong>
                          </div>
                          <div className="range-workbench-main">
                            <span>{group.batch.imageDisplayName}</span>
                          </div>
                          <div className="range-workbench-main">
                            <span>{group.batch.quantity}</span>
                          </div>
                          <div className="range-workbench-main">
                            <span>{formatBatchSummary(group.instances)}</span>
                          </div>
                          <div className="range-workbench-created-at">
                            <span>{formatDateTime(group.batch.createdAt)}</span>
                          </div>
                          <div className="range-workbench-created-at">
                            <span>{formatDateTime(group.batch.expiresAt)}</span>
                          </div>
                          <div className="range-workbench-main">
                            <span>{group.batch.createdBy?.trim() || 'admin'}</span>
                          </div>
                          {!isHistoryGroup ? (
                            <div className="single-instance-batch-actions">
                              <button type="button" onClick={() => handleBatchExport(group)}>
                                一键导出
                              </button>
                              <button type="button" onClick={() => void handleBatchDestroy(group.batch.id)}>
                                一键关闭
                              </button>
                            </div>
                          ) : null}
                        </div>
                        {isExpanded ? (
                          <div className="single-instance-batch-children">
                            <div className={`single-instance-batch-child-head${isHistoryGroup ? ' is-history' : ''}`}>
                              <div>实例名</div>
                              <div>规格</div>
                              <div>公网 IP</div>
                              <div>账号/密码</div>
                              <div>状态</div>
                              {isHistoryGroup ? null : <div className="single-instance-batch-child-action-head">操作</div>}
                            </div>
                            {group.instances.map((instance) => {
                              const actions = getAvailableActions(instance.status).filter(
                                (action) => action !== 'pack-image' || group.batch.quantity <= 1,
                              );
                              const inlineActions = actions.filter(isPrimaryInlineAction);
                              const menuActions = actions.filter((action) => !isPrimaryInlineAction(action));
                              const isActionPending = pendingActionInstanceId === instance.id;

                              return (
                                <div
                                  key={instance.id}
                                  className={`single-instance-batch-child-row${isHistoryGroup ? ' is-history' : ''}${menuInstanceId === instance.id ? ' is-menu-open' : ''}`}
                                >
                                  <div className="range-workbench-main">
                                    <strong>{instance.name?.trim() || instance.id}</strong>
                                  </div>
                                  <div className="range-workbench-main">
                                    <span>{getSpecLabel(instance)}</span>
                                  </div>
                                  <div className="range-workbench-main">
                                    <span>{getPublicIp(instance)}</span>
                                  </div>
                                  <div className="single-instance-credential-cell">
                                    <span className="single-instance-credential-mask">{formatMaskedCredential(instance)}</span>
                                    <span className="single-instance-credential-tooltip">{formatFullCredential(instance)}</span>
                                    <button type="button" aria-label="复制密码" className="single-instance-copy-button" onClick={() => void handleCopyPassword(instance)}>
                                      {copiedPasswordInstanceId === instance.id ? '已复制' : '复制'}
                                    </button>
                                  </div>
                                  <div className="range-workbench-main">
                                    <span className={`template-workbench-status-pill ${getStatusTone(instance.status)}`}>
                                      {getStatusLabel(instance.status)}
                                    </span>
                                  </div>
                                  {!isHistoryGroup ? (
                                    <div className="single-instance-batch-child-actions">
                                      {inlineActions.map((action) => (
                                        <button key={action} type="button" disabled={isActionPending} onClick={() => void handleAction(instance, action)}>
                                          {getActionLabel(action, instance.status)}
                                        </button>
                                      ))}
                                      {menuActions.length ? (
                                        <div className="template-workbench-row-menu">
                                          <button
                                            type="button"
                                            disabled={isActionPending}
                                            onClick={(event) => toggleActionMenu(instance.id, event.currentTarget)}
                                          >
                                            更多操作
                                          </button>
                                          {menuInstanceId === instance.id ? (
                                            <div className={`template-workbench-action-menu${menuPlacement === 'up' ? ' is-upward' : ''}`}>
                                              {menuActions.map((action) => (
                                                <button key={action} type="button" disabled={isActionPending} onClick={() => void handleAction(instance, action)}>
                                                  {getActionLabel(action, instance.status)}
                                                </button>
                                              ))}
                                            </div>
                                          ) : null}
                                        </div>
                                      ) : null}
                                    </div>
                                  ) : null}
                                </div>
                              );
                            })}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              ) : null}

              {pagedInstances.length > 0 ? (
                <>
                {listMode === 'history' ? (
                  <div className="single-instance-history-column-head">
                    <div className="template-workbench-column-cell"><strong>实例名</strong></div>
                    <div className="template-workbench-column-cell"><strong>创建人</strong></div>
                    <div className="template-workbench-column-cell"><strong>镜像</strong></div>
                    <div className="template-workbench-column-cell"><strong>规格</strong></div>
                    <div className="template-workbench-column-cell"><strong>公网 IP</strong></div>
                    <div className="template-workbench-column-cell"><strong>开启时间</strong></div>
                    <div className="template-workbench-column-cell"><strong>回收时间</strong></div>
                    <div className="template-workbench-column-cell"><strong>运行时长</strong></div>
                  </div>
                ) : (
                  <div className="single-instance-workbench-column-head">
                    <div className="template-workbench-column-cell"><strong>实例名</strong></div>
                    <div className="template-workbench-column-cell"><strong>镜像</strong></div>
                    <div className="template-workbench-column-cell"><strong>规格</strong></div>
                    <div className="template-workbench-column-cell"><strong>公网 IP</strong></div>
                    <div className="template-workbench-column-cell"><strong>状态</strong></div>
                    <div className="template-workbench-column-cell"><strong>创建时间</strong></div>
                    <div className="template-workbench-column-cell"><strong>到期时间</strong></div>
                    <div className="template-workbench-column-cell"><strong>创建人</strong></div>
                    <div className="template-workbench-column-cell"><strong>账号/密码</strong></div>
                    <div className="template-workbench-column-cell workbench-action-cell"><strong>操作</strong></div>
                  </div>
                )}
                <div className="range-workbench-rows">
              {pagedInstances.map((instance) => {
                const isHistory = listMode === 'history';
                const lifecycle = lifecycleByInstanceId.get(instance.id);
                const startedAt =
                  readJobTimestamp(lifecycle?.createJob, 'start') ??
                  instance.createdAt ??
                  null;
                const endedAt =
                  readJobTimestamp(lifecycle?.destroyJob, 'end') ??
                  null;
                const actions = getAvailableActions(instance.status);
                const inlineActions = actions.filter(isPrimaryInlineAction);
                const menuActions = actions.filter((action) => !isPrimaryInlineAction(action));
                const isActionPending = pendingActionInstanceId === instance.id;
                return (
                  <article
                    key={instance.id}
                    className={
                      isHistory
                        ? `single-instance-history-row${menuInstanceId === instance.id ? ' is-menu-open' : ''}`
                        : `single-instance-workbench-row${menuInstanceId === instance.id ? ' is-menu-open' : ''}`
                    }
                  >
                    <div className="range-workbench-main">
                      <strong>{instance.name?.trim() || instance.id}</strong>
                    </div>
                    {isHistory ? (
                      <div className="range-workbench-main">
                        <span>{instance.createdBy?.trim() || 'admin'}</span>
                      </div>
                    ) : null}
                    <div className="range-workbench-main">
                      <span>{getImageLabel(instance)}</span>
                    </div>
                    <div className="range-workbench-main">
                      <span>{getSpecLabel(instance)}</span>
                    </div>
                    <div className="range-workbench-main">
                      <span>{getPublicIp(instance)}</span>
                    </div>
                    {isHistory ? (
                      <>
                        <div className="range-workbench-created-at">
                          <span>{formatDateTime(startedAt)}</span>
                        </div>
                        <div className="range-workbench-created-at">
                          <span>{formatDateTime(endedAt)}</span>
                        </div>
                        <div className="range-workbench-created-at">
                          <span>{formatDuration(startedAt, endedAt)}</span>
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="template-workbench-status">
                          <span className={`template-workbench-status-pill ${getStatusTone(instance.status)}`}>
                            {getStatusLabel(instance.status)}
                          </span>
                        </div>
                        <div className="range-workbench-created-at">
                          <span>{formatDateTime(instance.createdAt)}</span>
                        </div>
                        <div className="range-workbench-created-at">
                          <span>{formatDateTime(instance.expiresAt)}</span>
                        </div>
                        <div className="range-workbench-main">
                          <span>{instance.createdBy?.trim() || '暂无'}</span>
                        </div>
                        <div className="single-instance-credential-cell">
                          <span className="single-instance-credential-mask">{formatMaskedCredential(instance)}</span>
                          <span className="single-instance-credential-tooltip">{formatFullCredential(instance)}</span>
                          <button type="button" aria-label="复制密码" className="single-instance-copy-button" onClick={() => void handleCopyPassword(instance)}>
                            {copiedPasswordInstanceId === instance.id ? '已复制' : '复制'}
                          </button>
                        </div>
                      </>
                    )}
                    {!isHistory ? (
                      <div className="template-workbench-row-menu range-workbench-actions workbench-action-cell">
                        {actions.length ? (
                          <>
                            {inlineActions.map((action) => (
                              <button key={action} type="button" disabled={isActionPending} onClick={() => void handleAction(instance, action)}>
                                {getActionLabel(action, instance.status)}
                              </button>
                            ))}
                            {menuActions.length ? (
                              <>
                                <button
                                  type="button"
                                  disabled={isActionPending}
                                  onClick={(event) => toggleActionMenu(instance.id, event.currentTarget)}
                                >
                                  更多操作
                                </button>
                                {menuInstanceId === instance.id ? (
                                  <div className={`template-workbench-action-menu${menuPlacement === 'up' ? ' is-upward' : ''}`}>
                                    {menuActions.map((action) => (
                                      <button key={action} type="button" disabled={isActionPending} onClick={() => void handleAction(instance, action)}>
                                        {getActionLabel(action, instance.status)}
                                      </button>
                                    ))}
                                  </div>
                                ) : null}
                              </>
                            ) : null}
                          </>
                        ) : null}
                      </div>
                    ) : null}
                  </article>
                );
              })}
                </div>
                </>
              ) : null}
            </>
          ) : (
            <div className="template-workbench-empty">
              <strong>{listMode === 'history' ? '暂无实例历史' : '暂无实例'}</strong>
            </div>
          )}
          {hasVisibleContent ? (
            <AdminPaginationControls
              label={`${listMode === 'history' ? '实例历史' : '实例列表'} 分页`}
              pageSizeMode={pageSizeMode}
              pagination={activePagination}
              visiblePages={visiblePages}
              jumpPageValue={jumpPageValue}
              onPageSizeChange={handlePageSizeChange}
              onPreviousPage={() =>
                setListPages((current) => ({
                  ...current,
                  [listMode]: activePagination.page - 1,
                }))
              }
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
              onJumpPageValueChange={setJumpPageValue}
              onJumpPage={handleJumpToPage}
            />
          ) : null}
        </article>
      </section>
      ) : null}

      {isCreateOpen ? (
        <SingleInstanceDialog title="创建实例" onClose={() => setIsCreateOpen(false)}>
          <form onSubmit={handleCreateSubmit}>
            <div className="single-instance-dialog-body">
              <div className="single-instance-dialog-grid">
                <div className="single-instance-form-row single-instance-form-row-full">
                  <label className="single-instance-form-label" htmlFor="single-instance-name">
                    实例名
                  </label>
                  <div className="single-instance-form-control">
                    <input id="single-instance-name" aria-label="实例名" value={createForm.name} onChange={(event) => updateCreateForm('name', event.target.value)} required />
                  </div>
                </div>

                <div className="single-instance-form-row single-instance-form-row-full">
                  <label className="single-instance-form-label" htmlFor="single-instance-host-name">
                    主机名
                  </label>
                  <div className="single-instance-form-control">
                    <input id="single-instance-host-name" aria-label="主机名" value={createForm.hostName} onChange={(event) => updateCreateForm('hostName', event.target.value)} />
                  </div>
                </div>

                <div className="single-instance-form-row single-instance-form-row-full">
                  <label className="single-instance-form-label" htmlFor="single-instance-image">
                    镜像
                  </label>
                  <div className="single-instance-form-control">
                    <input
                      id="single-instance-image"
                      aria-label="镜像"
                      list="single-instance-platform-images"
                      value={createForm.platformImageQuery}
                      onChange={(event) => updateCreateForm('platformImageQuery', event.target.value)}
                      placeholder="搜索或选择平台镜像"
                      disabled={!enabledPlatformImages.length}
                    />
                    <datalist id="single-instance-platform-images">
                      {enabledPlatformImages.map((item) => (
                        <option key={item.id} value={buildPlatformImageOptionLabel(item)} />
                      ))}
                    </datalist>
                  </div>
                </div>

                <div className="single-instance-form-row single-instance-form-row-full">
                  <span className="single-instance-form-label">CPU/内存</span>
                  <div className="single-instance-inline-grid">
                    <div className="single-instance-inline-field">
                      <input aria-label="CPU" type="number" min="1" value={createForm.cpu} onChange={(event) => updateCreateForm('cpu', event.target.value)} required />
                      <span className="single-instance-inline-unit">核</span>
                    </div>
                    <div className="single-instance-inline-field">
                      <input aria-label="内存" type="number" min="1" value={createForm.memory} onChange={(event) => updateCreateForm('memory', event.target.value)} required />
                      <span className="single-instance-inline-unit">G</span>
                    </div>
                  </div>
                </div>

                <div className="single-instance-form-row single-instance-form-row-full">
                  <label className="single-instance-form-label" htmlFor="single-instance-disk">
                    磁盘大小
                  </label>
                  <div className="single-instance-inline-field single-instance-form-control">
                    <input
                      id="single-instance-disk"
                      aria-label="磁盘大小"
                      type="number"
                      min="20"
                      value={createForm.systemDiskSize}
                      onChange={(event) => updateCreateForm('systemDiskSize', event.target.value)}
                    />
                    <span className="single-instance-inline-unit">G</span>
                  </div>
                </div>

                <div className="single-instance-form-row single-instance-form-row-full">
                  <label className="single-instance-form-label" htmlFor="single-instance-quantity">
                    启动数量
                  </label>
                  <div className="single-instance-form-control">
                    <input
                      id="single-instance-quantity"
                      aria-label="启动实例数量"
                      type="number"
                      min="1"
                      max="99"
                      value={createForm.quantity}
                      onChange={(event) => updateCreateForm('quantity', event.target.value)}
                      required
                    />
                  </div>
                </div>

                <div className="single-instance-form-row single-instance-form-row-full">
                  <label className="single-instance-form-label" htmlFor="single-instance-expire">
                    到期时间
                  </label>
                  <div className="single-instance-form-control">
                    <input
                      id="single-instance-expire"
                      aria-label="到期时间"
                      type="datetime-local"
                      value={createForm.expiresAt}
                      onChange={(event) => updateCreateForm('expiresAt', event.target.value)}
                      required
                    />
                  </div>
                </div>

                <div className="single-instance-form-row single-instance-form-row-full">
                  <label className="single-instance-form-label" htmlFor="single-instance-password">
                    密码
                  </label>
                  <div className="single-instance-form-control">
                    <input id="single-instance-password" aria-label="密码" type="password" value={createForm.password} onChange={(event) => updateCreateForm('password', event.target.value)} />
                  </div>
                </div>

                <div className="single-instance-form-row single-instance-form-row-full single-instance-form-row-textarea">
                  <label className="single-instance-form-label" htmlFor="single-instance-remark">
                    备注
                  </label>
                  <div className="single-instance-form-control">
                    <textarea id="single-instance-remark" aria-label="备注" value={createForm.remark} onChange={(event) => updateCreateForm('remark', event.target.value)} rows={3} />
                  </div>
                </div>

                {createFormError ? <p className="admin-error single-instance-form-message">{createFormError}</p> : null}
                {!enabledPlatformImages.length ? (
                  <p className="admin-empty single-instance-form-message">请先前往镜像中心收录或启用平台镜像后，再创建实例。</p>
                ) : null}
                {instanceTypeAvailability && !instanceTypeAvailability.exactAvailable ? (
                  <p className="admin-empty single-instance-form-message">
                    {instanceTypeAvailability.warning ?? `默认可用区暂无 ${createForm.cpu} 核 / ${createForm.memory} G 的精确可售规格。`}
                  </p>
                ) : null}
              </div>
            </div>
            <div className="template-workbench-dialog-actions single-instance-dialog-actions">
              <button type="submit" disabled={isSubmitting || !enabledPlatformImages.length}>
                确认创建
              </button>
              <button type="button" onClick={() => setIsCreateOpen(false)}>
                取消
              </button>
            </div>
          </form>
        </SingleInstanceDialog>
      ) : null}

      {packImageDialog ? (
        <SingleInstanceDialog title="打包为镜像" onClose={() => setPackImageDialog(null)}>
          <div className="single-instance-dialog-body">
            <div className="single-instance-dialog-grid">
              <div className="single-instance-form-row single-instance-form-row-full">
                <label className="single-instance-form-label" htmlFor="single-instance-pack-image-name">
                  镜像名
                </label>
                <div className="single-instance-form-control">
                  <input
                    id="single-instance-pack-image-name"
                    aria-label="镜像名"
                    value={packImageDialog.displayName}
                    onChange={(event) =>
                      setPackImageDialog((current) =>
                        current
                          ? {
                              ...current,
                              displayName: event.target.value,
                            }
                          : current,
                      )
                    }
                  />
                </div>
              </div>

              <div className="single-instance-form-row single-instance-form-row-full">
                <label className="single-instance-form-label" htmlFor="single-instance-pack-image-hostname">
                  默认主机名
                </label>
                <div className="single-instance-form-control">
                  <input
                    id="single-instance-pack-image-hostname"
                    aria-label="默认主机名"
                    placeholder="留空则使用当前主机名"
                    value={packImageDialog.defaultHostName}
                    onChange={(event) =>
                      setPackImageDialog((current) =>
                        current
                          ? {
                              ...current,
                              defaultHostName: event.target.value,
                            }
                          : current,
                      )
                    }
                  />
                </div>
              </div>

              <div className="single-instance-form-row single-instance-form-row-full">
                <label className="single-instance-form-label" htmlFor="single-instance-pack-image-password">
                  默认密码
                </label>
                <div className="single-instance-form-control">
                  <input
                    id="single-instance-pack-image-password"
                    aria-label="默认密码"
                    placeholder="留空则随机生成"
                    value={packImageDialog.defaultPassword}
                    onChange={(event) =>
                      setPackImageDialog((current) =>
                        current
                          ? {
                              ...current,
                              defaultPassword: event.target.value,
                            }
                          : current,
                      )
                    }
                  />
                </div>
              </div>

              <div className="single-instance-form-row single-instance-form-row-full">
                <label className="single-instance-form-label" htmlFor="single-instance-pack-image-description">
                  镜像备注
                </label>
                <div className="single-instance-form-control">
                  <input
                    id="single-instance-pack-image-description"
                    aria-label="镜像备注"
                    placeholder="选填"
                    value={packImageDialog.description}
                    onChange={(event) =>
                      setPackImageDialog((current) =>
                        current
                          ? {
                              ...current,
                              description: event.target.value,
                            }
                          : current,
                      )
                    }
                  />
                </div>
              </div>
            </div>
          </div>
          <div className="template-workbench-dialog-actions single-instance-dialog-actions">
            <button type="button" onClick={() => setPackImageDialog(null)}>
              取消
            </button>
            <button
              type="button"
              disabled={pendingActionInstanceId === packImageDialog.instanceId || packImageDialog.displayName.trim().length === 0}
              onClick={() => void handleConfirmPackImage()}
            >
              {pendingActionInstanceId === packImageDialog.instanceId ? '处理中...' : '确认打包'}
            </button>
          </div>
        </SingleInstanceDialog>
      ) : null}
    </div>
  );
}
