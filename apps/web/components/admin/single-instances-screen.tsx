'use client';

import React from 'react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Check, ChevronDown, ChevronRight, Copy, MoreHorizontal, Plus } from 'lucide-react';

import {
  AdminApiError,
  destroySingleInstanceBatch,
  fetchInstanceTypeAvailability,
  fetchPlatformImages,
  fetchProvisionJobs,
  fetchSingleInstances,
  launchSingleInstances,
  triggerSingleInstanceAction,
} from '../../lib/admin-api';
import { useAdminScreenCache } from '../../lib/admin-screen-cache';
import { cloudExpiryError, minimumSystemDiskSize, tencentImageError, verifiedTencentInstanceTypes } from '@/lib/cloud-execution-policy';
import { cloudProviderLabel, useCloudWorkspace } from './cloud-workspace-provider';
import type {
  InstanceTypeAvailabilitySnapshot,
  PlatformImageAsset,
  PlatformImageAssetListPayload,
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
  useAdminPageSize,
} from './admin-pagination';
import { useAdminRouteIsActive } from './admin-page-cache';
import {
  AdminDataTable,
  AdminDataTableCell,
  AdminDataTableRevalidationNotice,
  AdminDataTableState,
  AdminDataTableText,
  type AdminDataColumn,
} from './shared/admin-data-table';
import { AdminListToolbar } from './shared/admin-list-toolbar';
import { AdminDialog, type AdminDialogSize } from './shared/admin-dialog';
import { AdminPaginatedList } from './shared/admin-paginated-list';
import { AdminPageHeader } from './shared/admin-page-header';
import { CloudReleaseStatus } from './shared/cloud-release-status';
import Link from 'next/link';
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
  { id: 'specification', label: '数量 / 规格', priority: 'primary' },
  { id: 'public-ip', label: '公网 IP', priority: 'primary' },
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
  { id: 'summary', label: '数量 / 规格', priority: 'primary' },
  { id: 'public-ip', label: '公网 IP', priority: 'primary' },
  { id: 'status', label: '状态', priority: 'secondary' },
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

type MenuAction = SingleInstanceAction;

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

type SingleInstanceRows = {
  batchGroups: SingleInstanceBatchGroup[];
  instances: RangeInstance[];
  jobs: ProvisionJob[];
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

function getBatchQuantityLabel(group: SingleInstanceBatchGroup) {
  return `${group.batch.quantity} 台`;
}

function getPublicIp(instance: RangeInstance) {
  return instance.accessEntry?.publicIp?.trim() || '暂无';
}

function getBatchPublicIp(group: SingleInstanceBatchGroup) {
  const firstInstance = group.instances[0];
  return firstInstance ? getPublicIp(firstInstance) : '暂无';
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
  return group.instances.length > 0 && group.instances.every((instance) => isSingleInstanceHistoryStatus(instance.status));
}

function isSingleInstanceHistoryStatus(status: string) {
  return status === 'destroyed' || status === 'create_failed';
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

  return [];
}

function getActionLabel(action: MenuAction, status: string) {
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

function buildDefaultDialogState(platformImages: PlatformImageAsset[], provider: 'alibaba_cloud' | 'tencent_cloud' = 'alibaba_cloud'): CreateDialogState {
  const defaultImage = platformImages.find((item) => item.enabled) ?? platformImages[0] ?? null;

  return {
    name: '',
    hostName: defaultImage?.defaultHostName?.trim() || '',
    platformImageQuery: defaultImage ? buildPlatformImageOptionLabel(defaultImage) : '',
    cpu: '2',
    memory: '2',
    systemDiskSize: String(Math.max(provider === 'tencent_cloud' ? 50 : 40, minimumSystemDiskSize(provider, defaultImage))),
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
  footer,
  pending = false,
  size = 'wide',
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer: React.ReactNode;
  pending?: boolean;
  size?: AdminDialogSize;
}) {
  return (
    <AdminDialog footer={footer} open pending={pending} size={size} title={title} onOpenChange={(open) => !open && onClose()}>
      {children}
    </AdminDialog>
  );
}

export function SingleInstancesScreen({
  apiBaseUrl = 'http://localhost:3001',
  pollIntervalMs = 5000,
}: SingleInstancesScreenProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const session = useAdminSession();
  const workspace = useCloudWorkspace()?.workspace;
  const canProvision = !workspace || (!workspace.isReadOnly && workspace.capabilities.provisioning);
  const isPageActive = useAdminRouteIsActive('/admin/instances');
  const [listMode, setListMode] = useState<ListMode>(() => readListMode(searchParams.get('view')));
  const screenCache = useAdminScreenCache();
  const cachedActiveRows = screenCache?.read<SingleInstanceRows>(apiBaseUrl, session.token, 'single-instances:active');
  const cachedHistoryRows = screenCache?.read<SingleInstanceRows>(apiBaseUrl, session.token, 'single-instances:history');
  const cachedPlatformImages = screenCache?.read<PlatformImageAssetListPayload>(
    apiBaseUrl,
    session.token,
    'platform-images:platform',
  );
  const cachedCurrentRows = listMode === 'active' ? cachedActiveRows : cachedHistoryRows;
  const [searchName, setSearchName] = useState('');
  const [instances, setInstances] = useState<RangeInstance[]>(() => cachedCurrentRows?.data.instances ?? []);
  const [batchGroups, setBatchGroups] = useState<SingleInstanceBatchGroup[]>(() => cachedCurrentRows?.data.batchGroups ?? []);
  const [jobs, setJobs] = useState<ProvisionJob[]>(() => cachedCurrentRows?.data.jobs ?? []);
  const [platformImages, setPlatformImages] = useState<PlatformImageAsset[]>(() => cachedPlatformImages?.data.items ?? []);
  const [hasLoadedPlatformImages, setHasLoadedPlatformImages] = useState(Boolean(cachedPlatformImages));
  const [isLoading, setIsLoading] = useState(() => !cachedCurrentRows);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [loadedListMode, setLoadedListMode] = useState<ListMode | null>(() => (cachedCurrentRows ? listMode : null));
  const [tableContentVersions, setTableContentVersions] = useState<Record<ListMode, number>>({
    active: 0,
    history: 0,
  });
  const [listErrorMessage, setListErrorMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const launchScope = JSON.stringify([apiBaseUrl, session.profile?.id, workspace?.id]);
  const launchContextRef = useRef({ scope: launchScope, token: session.token });
  launchContextRef.current = { scope: launchScope, token: session.token };
  const launchMountedRef = useRef(true);
  useEffect(() => { launchMountedRef.current = true; return () => { launchMountedRef.current = false; }; }, []);
  const isCurrentLaunch = () => launchMountedRef.current && launchContextRef.current.scope === launchScope;
  const launchPendingRef = useRef(false);
  const launchRequestRef = useRef<{ fingerprint: string; key: string; payload: SingleInstanceLaunchInput } | null>(null);
  const [menuInstanceId, setMenuInstanceId] = useState<string | null>(null);
  const [menuPlacement, setMenuPlacement] = useState<ActionMenuPlacement>('down');
  const [pendingActionInstanceId, setPendingActionInstanceId] = useState<string | null>(null);
  const [expandedBatchIds, setExpandedBatchIds] = useState<string[]>([]);
  const [copiedPasswordInstanceId, setCopiedPasswordInstanceId] = useState<string | null>(null);
  const [createForm, setCreateForm] = useState<CreateDialogState>(buildDefaultDialogState([], workspace?.provider ?? 'alibaba_cloud'));
  const launchFingerprint = JSON.stringify([launchScope, createForm]);
  const canReplayLaunch = launchRequestRef.current?.fingerprint === launchFingerprint;
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
  const { pageSize, setPageSize } = useAdminPageSize();

  function markTableContentUpdated(view: ListMode) {
    setTableContentVersions((current) => ({
      ...current,
      [view]: current[view] + 1,
    }));
  }

  async function fetchSingleInstanceRows(token: string, nextListMode: ListMode, force = false) {
    const load = async (): Promise<SingleInstanceRows> => {
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
    };

    return screenCache
      ? screenCache.load(apiBaseUrl, token, `single-instances:${nextListMode}`, load, { force })
      : load();
  }

  async function refreshSingleInstanceRows(token: string, nextListMode: ListMode, force = false) {
    const requestId = listRequestIdRef.current + 1;
    const hasCurrentSnapshot = loadedListModeRef.current === nextListMode;
    const cachedRows = screenCache?.read<SingleInstanceRows>(apiBaseUrl, token, `single-instances:${nextListMode}`);
    listRequestIdRef.current = requestId;
    setListErrorMessage(null);

    if (cachedRows?.isFresh && !force) {
      setBatchGroups(cachedRows.data.batchGroups);
      setInstances(cachedRows.data.instances);
      setJobs(cachedRows.data.jobs);
      loadedListModeRef.current = nextListMode;
      setLoadedListMode(nextListMode);
      setIsLoading(false);
      setIsRefreshing(false);
      return cachedRows.data;
    }

    if (hasCurrentSnapshot) {
      setIsRefreshing(true);
    } else {
      setIsLoading(true);
    }

    try {
      const nextRows = await fetchSingleInstanceRows(token, nextListMode, force);

      if (requestId !== listRequestIdRef.current) {
        return nextRows;
      }

      setBatchGroups(nextRows.batchGroups);
      setInstances(nextRows.instances);
      setJobs(nextRows.jobs);
      loadedListModeRef.current = nextListMode;
      setLoadedListMode(nextListMode);
      markTableContentUpdated(nextListMode);
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
    if (!isPageActive) {
      return;
    }

    if (!session.isReady || !session.token) {
      setBatchGroups([]);
      setInstances([]);
      setJobs([]);
      loadedListModeRef.current = null;
      setLoadedListMode(null);
      setTableContentVersions({ active: 0, history: 0 });
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
  }, [apiBaseUrl, isPageActive, listMode, router, screenCache, session.isReady, session.token]);

  useEffect(() => {
    if (!isPageActive || !session.isReady) {
      return;
    }

    if (!session.token) {
      setPlatformImages([]);
      setHasLoadedPlatformImages(false);
      return;
    }

    let isActive = true;
    const token = session.token;
    const cachedImages = screenCache?.read<PlatformImageAssetListPayload>(
      apiBaseUrl,
      token,
      'platform-images:platform',
    );

    if (cachedImages?.isFresh) {
      setPlatformImages(cachedImages.data.items);
      setHasLoadedPlatformImages(true);
      setCreateForm((current) =>
        current.platformImageQuery
          ? current
          : buildDefaultDialogState(cachedImages.data.items.filter((item) => item.enabled), workspace?.provider ?? 'alibaba_cloud'),
      );

      return () => {
        isActive = false;
      };
    }

    const loadPlatformImages = () => fetchPlatformImages(apiBaseUrl, token);
    const request = screenCache
      ? screenCache.load(apiBaseUrl, token, 'platform-images:platform', loadPlatformImages)
      : loadPlatformImages();

    void request
      .then((nextImages) => {
        if (!isActive) {
          return;
        }

        setPlatformImages(nextImages.items);
        setHasLoadedPlatformImages(true);
        setCreateForm((current) =>
          current.platformImageQuery ? current : buildDefaultDialogState(nextImages.items.filter((item) => item.enabled), workspace?.provider ?? 'alibaba_cloud'),
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
  }, [apiBaseUrl, isPageActive, router, screenCache, session.isReady, session.token]);

  useEffect(() => {
    if (!isPageActive || !session.isReady || !session.token || pollIntervalMs <= 0 || listMode === 'history') {
      return;
    }

    const token = session.token;
    const timer = window.setInterval(() => {
      void refreshSingleInstanceRows(token, listMode, true).catch((error: unknown) => {
        if (isUnauthorizedError(error)) {
          session.logout();
          router.replace('/admin/login');
        }
      });
    }, pollIntervalMs);

    return () => {
      window.clearInterval(timer);
    };
  }, [isPageActive, listMode, loadedListMode, pollIntervalMs, router, session, session.isReady, session.token]);

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
      Map<string, { createJob?: ProvisionJob; createFailureJob?: ProvisionJob; destroyJob?: ProvisionJob }>
    >((map, [instanceId, instanceJobs]) => {
      let createJob: ProvisionJob | undefined;
      let createFailureJob: ProvisionJob | undefined;
      let destroyJob: ProvisionJob | undefined;
      let retryPhase: 'create' | 'destroy' | null = null;

      for (const job of instanceJobs.slice().sort(compareJobTimeAscending)) {
        if (job.jobType === 'create') {
          retryPhase = 'create';

          if (job.status === 'succeeded') {
            createJob = job;
          } else if (job.status === 'failed') {
            createFailureJob = job;
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

        if (job.jobType === 'retry') {
          if (retryPhase === 'create') {
            if (job.status === 'succeeded') {
              createJob = job;
            } else if (job.status === 'failed') {
              createFailureJob = job;
            }
          }

          if (retryPhase === 'destroy' && job.status === 'succeeded') {
            destroyJob = job;
          }
        }
      }

      map.set(instanceId, {
        createJob,
        createFailureJob,
        destroyJob,
      });
      return map;
    }, new Map<string, { createJob?: ProvisionJob; createFailureJob?: ProvisionJob; destroyJob?: ProvisionJob }>());
  }, [jobsByInstanceId]);

  const activeInstances = useMemo(
    () => instances.filter((instance) => !isSingleInstanceHistoryStatus(instance.status)),
    [instances],
  );
  const historyInstances = useMemo(
    () => instances.filter((instance) => isSingleInstanceHistoryStatus(instance.status)),
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
    launchRequestRef.current = null;
    setCreateForm({
      ...buildDefaultDialogState(enabledPlatformImages, workspace?.provider ?? 'alibaba_cloud'),
      hostName: selectedImage.defaultHostName?.trim() || '',
      systemDiskSize: String(Math.max(workspace?.provider === 'tencent_cloud' ? 50 : 40, minimumSystemDiskSize(workspace?.provider ?? 'alibaba_cloud', selectedImage))),
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
      ...(field === 'platformImageQuery' && workspace?.provider === 'tencent_cloud'
        ? { systemDiskSize: String(Math.max(Number(current.systemDiskSize) || 50, minimumSystemDiskSize(workspace.provider, findPlatformImageAsset(String(value), enabledPlatformImages)))) } : {}),
    }));
  }

  function openCreateDialog() {
    launchRequestRef.current = null;
    setCreateForm(buildDefaultDialogState(enabledPlatformImages, workspace?.provider ?? 'alibaba_cloud'));
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

    if (!session.token || !canProvision || launchPendingRef.current) {
      return;
    }

    if (!canReplayLaunch) {
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

      if (workspace?.provider === 'tencent_cloud') {
        try { verifiedTencentInstanceTypes(instanceTypeAvailability, cpu, memory); }
        catch (error) { setCreateFormError(error instanceof Error ? error.message : '腾讯云规格校验失败。'); return; }
      }
      const provider = workspace?.provider ?? 'alibaba_cloud';
      const expiryError = provider === 'tencent_cloud' ? cloudExpiryError(createForm.expiresAt, provider) : null;
      const imageError = provider === 'tencent_cloud' ? tencentImageError(selectedPlatformImage) : null;
      const diskSize = Number(createForm.systemDiskSize);
      if (expiryError || imageError || provider === 'tencent_cloud' && (!Number.isInteger(diskSize) || diskSize < minimumSystemDiskSize(provider, selectedPlatformImage))) {
        setCreateFormError(expiryError ?? imageError ?? `系统盘至少需要 ${minimumSystemDiskSize(provider, selectedPlatformImage)} G。`);
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
      launchRequestRef.current = { fingerprint: launchFingerprint, key: crypto.randomUUID(), payload };
    }
    const request = launchRequestRef.current!;
    launchPendingRef.current = true;
    setIsSubmitting(true);
    setCreateFormError(null);
    setErrorMessage(null);

    try {
      await launchSingleInstances(apiBaseUrl, session.token, request.payload, request.key);
      if (!isCurrentLaunch()) return;
      launchRequestRef.current = null;
      screenCache?.invalidate(apiBaseUrl, session.token, 'single-instances:');
      setIsCreateOpen(false);
      // A failed read must never turn an accepted paid launch into a retryable write.
      try {
        await refreshSingleInstanceRows(session.token, listMode, true);
      } catch (error) {
        if (!isCurrentLaunch()) return;
        if (isUnauthorizedError(error)) {
          if (launchContextRef.current.token !== session.token) return;
          session.logout();
          router.replace('/admin/login');
        } else {
          setListErrorMessage('创建任务已受理，实例列表刷新失败。请刷新列表，不要重复创建。');
        }
      }
    } catch (error: unknown) {
      if (!isCurrentLaunch()) return;
      if (isUnauthorizedError(error)) {
        if (launchContextRef.current.token !== session.token) return;
        session.logout();
        router.replace('/admin/login');
        return;
      }

      setErrorMessage(error instanceof AdminApiError ? error.message : '创建结果尚未确认，可重试当前提交查询原任务；请勿新建重复批次。');
    } finally {
      launchPendingRef.current = false;
      if (isCurrentLaunch()) setIsSubmitting(false);
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
      screenCache?.invalidate(apiBaseUrl, session.token, 'single-instances:');
      screenCache?.invalidate(apiBaseUrl, session.token, 'platform-images:');

      setPackImageDialog(null);
      setErrorMessage(
        result &&
          typeof result === 'object' &&
          'imageReady' in result &&
          (result as { imageReady?: unknown }).imageReady === true
          ? `镜像打包完成，已保存到我的镜像：${packImageDialog.displayName}`
          : `镜像打包任务已提交，镜像可用后会出现在我的镜像：${packImageDialog.displayName}`,
      );
      try {
        await refreshSingleInstanceRows(session.token, listMode, true);
      } catch (error) {
        if (isUnauthorizedError(error)) {
          session.logout();
          router.replace('/admin/login');
        } else {
          setListErrorMessage('镜像打包任务已受理，实例列表刷新失败。请刷新列表，不要重复打包。');
        }
      }
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

      screenCache?.invalidate(apiBaseUrl, session.token, 'single-instances:');
      await refreshSingleInstanceRows(session.token, listMode, true);
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
      screenCache?.invalidate(apiBaseUrl, session.token, 'single-instances:');
      await refreshSingleInstanceRows(session.token, listMode, true);
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

    void refreshSingleInstanceRows(session.token, listMode, true).catch((error: unknown) => {
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

  useEffect(() => {
    setListPages((current) => ({
      ...current,
      [listMode]: 1,
    }));
  }, [listMode, normalizedSearchName]);

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

  useLayoutEffect(() => {
    setJumpPageValue(String(activePagination.page));
  }, [activePagination.page, listMode]);

  function handlePageSizeChange(nextValue: 20 | 50 | 100) {
    setPageSize(nextValue);
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
    const isCopied = copiedPasswordInstanceId === instance.id;

    return (
      <div className="flex min-w-0 items-center gap-1.5">
        <AdminDataTableText
          className="flex-1 text-muted-foreground"
          tooltipContent={
            <span className="flex flex-col gap-1">
              <span className="font-medium text-sky-900">账号信息</span>
              <span>{formatFullCredential(instance)}</span>
            </span>
          }
        >
          {formatMaskedCredential(instance)}
        </AdminDataTableText>
        <Button
          aria-label="复制密码"
          className={`shrink-0 transition-colors ${isCopied ? 'bg-primary text-primary-foreground hover:bg-primary/90' : 'hover:bg-sky-100 hover:text-sky-900'}`}
          onClick={() => void handleCopyPassword(instance)}
          size="icon-xs"
          title={isCopied ? '已复制密码' : '复制密码'}
          type="button"
          variant="ghost"
        >
          {isCopied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        </Button>
      </div>
    );
  }

  function renderInstanceActions(instance: RangeInstance, actions: MenuAction[]) {
    if (workspace?.isReadOnly) return null;
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
          <AdminDataTableText className="font-semibold">{instance.name?.trim() || instance.id}</AdminDataTableText>
        </AdminDataTableCell>
        <AdminDataTableCell column={columns[1]}>{getImageLabel(instance)}</AdminDataTableCell>
        <AdminDataTableCell column={columns[2]}>{getSpecLabel(instance)}</AdminDataTableCell>
        <AdminDataTableCell column={columns[3]}>{getPublicIp(instance)}</AdminDataTableCell>
        <AdminDataTableCell column={columns[4]}>
          <StatusBadge status={instance.status} />
        </AdminDataTableCell>
        <AdminDataTableCell column={columns[5]}>{formatDateTime(instance.createdAt)}</AdminDataTableCell>
        <AdminDataTableCell column={columns[6]}><span>{formatDateTime(instance.expiresAt)}</span><CloudReleaseStatus deadline={Object.values(instance.resourceSummary?.cloudReleaseDeadlines ?? {})[0]} /></AdminDataTableCell>
        <AdminDataTableCell column={columns[7]}>{instance.createdBy?.trim() || '暂无'}</AdminDataTableCell>
        <AdminDataTableCell column={columns[8]}>{renderCredentials(instance)}</AdminDataTableCell>
        <AdminDataTableCell column={columns[9]}>{renderInstanceActions(instance, actions)}</AdminDataTableCell>
      </>
    );
  }

  function getHistoryLifecycleTimestamps(instance: RangeInstance) {
    const lifecycle = lifecycleByInstanceId.get(instance.id);
    const isCreateFailure = instance.status === 'create_failed';
    const createJob = lifecycle?.createJob ?? lifecycle?.createFailureJob;
    const startedAt = readJobTimestamp(createJob, 'start') ?? instance.createdAt ?? null;
    const endedAt = isCreateFailure
      ? readJobTimestamp(lifecycle?.createFailureJob ?? lifecycle?.createJob, 'end')
      : readJobTimestamp(lifecycle?.destroyJob, 'end');

    return { startedAt, endedAt };
  }

  function getBatchHistoryEndedAt(group: SingleInstanceBatchGroup) {
    return group.instances
      .map((instance) => getHistoryLifecycleTimestamps(instance).endedAt)
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(-1) ?? null;
  }

  function renderHistoryInstanceCells(
    instance: RangeInstance,
    columns: readonly AdminDataColumn[],
    { indented = false }: { indented?: boolean } = {},
  ) {
    const { startedAt, endedAt } = getHistoryLifecycleTimestamps(instance);

    return (
      <>
        <AdminDataTableCell className={indented ? 'pl-10' : undefined} column={columns[0]}>
          <AdminDataTableText className="font-semibold">{instance.name?.trim() || instance.id}</AdminDataTableText>
        </AdminDataTableCell>
        <AdminDataTableCell column={columns[1]}>{getImageLabel(instance)}</AdminDataTableCell>
        <AdminDataTableCell column={columns[2]}>{getSpecLabel(instance)}</AdminDataTableCell>
        <AdminDataTableCell column={columns[3]}>{getPublicIp(instance)}</AdminDataTableCell>
        <AdminDataTableCell column={columns[4]}><StatusBadge status={instance.status} /></AdminDataTableCell>
        <AdminDataTableCell column={columns[5]}>{formatDateTime(startedAt)}</AdminDataTableCell>
        <AdminDataTableCell column={columns[6]}>{formatDateTime(endedAt)}</AdminDataTableCell>
        <AdminDataTableCell column={columns[7]}>{formatDuration(startedAt, endedAt)}</AdminDataTableCell>
        <AdminDataTableCell column={columns[8]}>{instance.createdBy?.trim() || 'admin'}</AdminDataTableCell>
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
    <div className="admin-screen admin-workbench-screen single-instance-screen admin-pagination-screen">
      {errorMessage ? (
        <p className="mb-3 text-sm text-destructive" role="alert">
          {errorMessage}
        </p>
      ) : null}

      <section className="admin-workbench-surface admin-pagination-surface">
        <AdminPageHeader description="创建并管理训练实例、批次与生命周期。" title="实例管理" action={session.profile?.isPlatformManager ? <Button asChild variant="outline"><Link href="/admin/resource-alerts">资源告警</Link></Button> : undefined} />
        {!canProvision && workspace ? <p className="mt-4 text-sm text-muted-foreground">{workspace.isReadOnly ? "当前账号工作空间为只读历史。" : `${cloudProviderLabel(workspace.provider)}实例创建仍在开发。`}</p> : null}

        <div className="mt-4 flex min-h-0 flex-1 flex-col gap-4">
          {hasLoadedPlatformImages && !enabledPlatformImages.length ? (
            <p className="text-sm text-muted-foreground">请先前往镜像中心收录或启用至少一个平台镜像。</p>
          ) : null}
            <AdminListToolbar
              activeView={listMode}
              action={
                <Button disabled={!canProvision || !enabledPlatformImages.length} onClick={openCreateDialog} type="button">
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
              <AdminPaginatedList
                footer={
                  hasVisibleContent ? (
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
                      pageSize={pageSize}
                      pagination={activePagination}
                      visiblePages={visiblePages}
                    />
                  ) : null
                }
              >
                <AdminDataTable
                  columns={tableColumns}
                  contentVersion={tableContentVersions[listMode]}
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
                        <AdminDataTableRevalidationNotice
                          columns={columns}
                          description={listErrorMessage}
                          onRetry={handleListRetry}
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
                                      <strong className="block truncate">{group.batch.name}</strong>
                                    </div>
                                  </div>
                                </AdminDataTableCell>
                                <AdminDataTableCell column={columns[1]}>{group.batch.imageDisplayName}</AdminDataTableCell>
                                <AdminDataTableCell column={columns[2]}>
                                  {getBatchQuantityLabel(group)}
                                </AdminDataTableCell>
                                <AdminDataTableCell column={columns[3]}>{getBatchPublicIp(group)}</AdminDataTableCell>
                                {isHistoryGroup ? (
                                  <>
                                    <AdminDataTableCell column={columns[4]}>
                                      {formatBatchSummary(group.instances)}
                                    </AdminDataTableCell>
                                    <AdminDataTableCell column={columns[5]}>{formatDateTime(group.batch.createdAt)}</AdminDataTableCell>
                                    <AdminDataTableCell column={columns[6]}>{formatDateTime(group.batch.expiresAt)}</AdminDataTableCell>
                                    <AdminDataTableCell column={columns[7]}>
                                      {formatDuration(group.batch.createdAt, group.batch.expiresAt)}
                                    </AdminDataTableCell>
                                    <AdminDataTableCell column={columns[8]}>{group.batch.createdBy?.trim() || 'admin'}</AdminDataTableCell>
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
              </AdminPaginatedList>
            </AdminListToolbar>
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
                disabled={!canProvision || !enabledPlatformImages.length}
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
                    const batchEndedAt = isHistoryGroup ? getBatchHistoryEndedAt(group) : group.batch.expiresAt;

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
                            <span>{group.instances.length}</span>
                          </div>
                          <div className="range-workbench-main">
                            <span>{formatBatchSummary(group.instances)}</span>
                          </div>
                          <div className="range-workbench-created-at">
                            <span>{formatDateTime(group.batch.createdAt)}</span>
                          </div>
                          <div className="range-workbench-created-at">
                            <span>{formatDateTime(batchEndedAt)}</span>
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
                                    <button
                                      type="button"
                                      aria-label="复制密码"
                                      className={`single-instance-copy-button${copiedPasswordInstanceId === instance.id ? ' is-copied' : ''}`}
                                      onClick={() => void handleCopyPassword(instance)}
                                    >
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
                          <button
                            type="button"
                            aria-label="复制密码"
                            className={`single-instance-copy-button${copiedPasswordInstanceId === instance.id ? ' is-copied' : ''}`}
                            onClick={() => void handleCopyPassword(instance)}
                          >
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
              pageSize={pageSize}
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
        <SingleInstanceDialog
          footer={
            <>
              <Button disabled={isSubmitting} type="button" variant="outline" onClick={() => setIsCreateOpen(false)}>
                取消
              </Button>
              <Button disabled={!canProvision || isSubmitting || !canReplayLaunch && !enabledPlatformImages.length} form="single-instance-create-form" formNoValidate={canReplayLaunch} type="submit">
                {canReplayLaunch && !isSubmitting ? '查询原请求' : '确认创建'}
              </Button>
            </>
          }
          pending={isSubmitting}
          title="创建实例"
          onClose={() => setIsCreateOpen(false)}
        >
          <form id="single-instance-create-form" onSubmit={handleCreateSubmit}>
            <div className="single-instance-dialog-body">
              <div className="single-instance-dialog-grid">
                <div className="single-instance-form-row single-instance-form-row-full">
                  <label className="single-instance-form-label" htmlFor="single-instance-name">
                    实例名
                  </label>
                  <div className="single-instance-form-control">
                    <input autoFocus id="single-instance-name" aria-label="实例名" value={createForm.name} onChange={(event) => updateCreateForm('name', event.target.value)} required />
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
                      min={minimumSystemDiskSize(workspace?.provider ?? 'alibaba_cloud', findPlatformImageAsset(createForm.platformImageQuery, enabledPlatformImages))}
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
                    {workspace?.provider === 'tencent_cloud' ? <p className="text-sm text-muted-foreground">到期时间至少在 10 分钟后。</p> : null}
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
          </form>
        </SingleInstanceDialog>
      ) : null}

      {packImageDialog ? (
        <SingleInstanceDialog
          footer={
            <>
              <Button disabled={pendingActionInstanceId === packImageDialog.instanceId} type="button" variant="outline" onClick={() => setPackImageDialog(null)}>
                取消
              </Button>
              <Button
                disabled={pendingActionInstanceId === packImageDialog.instanceId || packImageDialog.displayName.trim().length === 0}
                type="button"
                onClick={() => void handleConfirmPackImage()}
              >
                {pendingActionInstanceId === packImageDialog.instanceId ? '处理中...' : '确认打包'}
              </Button>
            </>
          }
          pending={pendingActionInstanceId === packImageDialog.instanceId}
          title="打包为镜像"
          onClose={() => setPackImageDialog(null)}
        >
          <div className="single-instance-dialog-body">
            <div className="single-instance-dialog-grid">
              <div className="single-instance-form-row single-instance-form-row-full">
                <label className="single-instance-form-label" htmlFor="single-instance-pack-image-name">
                  镜像名
                </label>
                <div className="single-instance-form-control">
                  <input
                    autoFocus
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
        </SingleInstanceDialog>
      ) : null}
    </div>
  );
}
