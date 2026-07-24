'use client';

import React from 'react';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { MoreHorizontal, RefreshCw, Upload } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { TableCell, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

import {
  collectPlatformImage,
  completeImageImport,
  createPlatformImageTag,
  createImageImport,
  deleteCustomImageSnapshot,
  disablePlatformImage,
  enablePlatformImage,
  fetchCustomImageCatalogScope,
  fetchCloudAccountContexts,
  fetchImageImportJobs,
  fetchPlatformImageTags,
  fetchPlatformImages,
  fetchPublicImageCatalogScope,
  publishPlatformImage,
  removePlatformImage,
  renamePlatformImage,
  retryImageImport,
  setPlatformImageTags,
  syncCustomImages,
  syncPublicImages,
  unpublishPlatformImage,
} from '../../lib/admin-api';
import { isUnauthorizedAdminError } from '../../lib/admin-screen';
import type {
  ImageCatalogScopePayload,
  ImageSnapshot,
  CloudAccountContext,
  ImageImportJob,
  PlatformImageAsset,
  PlatformImageTag,
} from '../../lib/admin-types';
import {
  AdminPaginationControls,
  buildVisiblePages,
  getPagination,
  PAGE_SIZE_AUTO,
  useAdminPageSize,
} from './admin-pagination';
import { AdminPageHeader } from './shared/admin-page-header';
import { AdminSelectField } from './shared/admin-select-field';
import {
  AdminDataTable,
  AdminDataTableCell,
  AdminDataTableState,
  type AdminDataColumn,
} from './shared/admin-data-table';
import { AdminListToolbar } from './shared/admin-list-toolbar';
import { TableLoadingState } from './shared/table-loading-state';
import { useAdminSession } from './use-admin-session';

type ImageCenterScreenProps = {
  apiBaseUrl?: string;
};

type ActiveTab = 'platform' | 'mine' | 'custom' | 'public';
type TabPageMap = Record<ActiveTab, number>;
type TabErrorMap = Partial<Record<ActiveTab, string>>;
type ImageCenterConfirmState =
  | { type: 'remove-platform'; asset: PlatformImageAsset }
  | { type: 'delete-custom'; snapshot: ImageSnapshot }
  | null;
type ImageImportDialogDraft = {
  file: File | null;
  displayName: string;
  defaultHostName: string;
  defaultPassword: string;
  description: string;
  osType: 'linux' | 'windows';
  platform: string;
  architecture: 'x86_64' | 'arm64';
  bootMode: 'BIOS' | 'UEFI';
  imageFormat: 'qcow2' | 'raw' | 'vhd';
  systemDiskSize: string;
};

const ASSET_COLUMNS: readonly AdminDataColumn[] = [
  { id: 'name', label: '镜像名', priority: 'primary' },
  { id: 'imageId', label: '镜像 ID', priority: 'secondary' },
  { id: 'createdBy', label: '创建人', priority: 'tertiary' },
  { id: 'tags', label: '标签', priority: 'tertiary' },
  { id: 'status', label: '状态', priority: 'secondary' },
  { id: 'actions', label: '操作', priority: 'primary', width: '11rem' },
];

const CLOUD_IMAGE_COLUMNS: readonly AdminDataColumn[] = [
  { id: 'name', label: '镜像名', priority: 'primary' },
  { id: 'imageId', label: '镜像 ID', priority: 'secondary' },
  { id: 'status', label: '状态', priority: 'secondary' },
  { id: 'actions', label: '操作', priority: 'primary', width: '11rem' },
];

function createImageImportDraft(): ImageImportDialogDraft {
  return {
    file: null,
    displayName: '',
    defaultHostName: '',
    defaultPassword: '',
    description: '',
    osType: 'linux',
    platform: '',
    architecture: 'x86_64',
    bootMode: 'BIOS',
    imageFormat: 'qcow2',
    systemDiskSize: '40',
  };
}

function inferImageFormat(fileName: string): ImageImportDialogDraft['imageFormat'] | null {
  const extension = fileName.trim().split('.').pop()?.toLowerCase();

  if (extension === 'qcow2' || extension === 'raw' || extension === 'vhd') {
    return extension;
  }

  return null;
}

function formatImportStatus(status: ImageImportJob['status']) {
  if (status === 'awaiting_upload') return '等待上传';
  if (status === 'importing') return '正在导入';
  if (status === 'available') return '导入完成';
  if (status === 'failed') return '导入失败';
  return '已取消';
}

function uploadFileToOss(input: { url: string; headers: Record<string, string>; file: File; onProgress: (value: number) => void }) {
  return new Promise<void>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('PUT', input.url);
    Object.entries(input.headers).forEach(([key, value]) => request.setRequestHeader(key, value));
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        input.onProgress(Math.min(100, Math.round((event.loaded / event.total) * 100)));
      }
    };
    request.onerror = () => reject(new Error('镜像文件上传到 OSS 失败，请检查网络和 Bucket CORS 配置。'));
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) {
        input.onProgress(100);
        resolve();
        return;
      }
      reject(new Error(`镜像文件上传到 OSS 失败（HTTP ${request.status}）。`));
    };
    request.send(input.file);
  });
}

function formatCloudImageStatusText(status?: string | null, isAvailable?: boolean | null) {
  const normalizedStatus = status?.trim();

  if (!normalizedStatus) {
    return isAvailable ? '可用' : '不可用';
  }

  if (normalizedStatus === 'Available') {
    return '可用';
  }

  const creatingMatch = normalizedStatus.match(/^Creating(?:\s+(\d+%))?$/i);
  if (creatingMatch) {
    return creatingMatch[1] ?? '创建中';
  }

  if (/CreateFailed/i.test(normalizedStatus)) {
    return '创建失败';
  }

  if (/Unavailable/i.test(normalizedStatus)) {
    return '不可用';
  }

  return normalizedStatus;
}

function formatImageStatus(snapshot: ImageSnapshot) {
  return formatCloudImageStatusText(snapshot.status, snapshot.isAvailable);
}

function formatAssetStatus(asset: PlatformImageAsset) {
  if (asset.sourceSnapshotAvailable === false) {
    return formatCloudImageStatusText(asset.sourceSnapshotStatus, asset.sourceSnapshotAvailable);
  }

  return asset.enabled ? '已启用' : '已禁用';
}

function canCreateInstanceFromAsset(asset: PlatformImageAsset) {
  return asset.enabled && asset.sourceSnapshotAvailable !== false;
}

function shouldShowImageImportJob(job: ImageImportJob, resolvedAssetIds: ReadonlySet<string>) {
  if (job.status === 'available') {
    return Boolean(job.errorMessage && !job.temporaryObjectDeletedAt);
  }

  if (job.status === 'cancelled' && job.temporaryObjectDeletedAt) {
    return false;
  }

  if (
    job.status === 'importing' &&
    !job.errorMessage &&
    job.platformImageAssetId &&
    resolvedAssetIds.has(job.platformImageAssetId)
  ) {
    return false;
  }

  return true;
}

function normalizeKeyword(keyword: string) {
  return keyword.trim().toLowerCase();
}

function matchesSnapshotSearch(snapshot: ImageSnapshot, keyword: string) {
  const normalizedKeyword = normalizeKeyword(keyword);
  if (!normalizedKeyword) {
    return true;
  }

  return (
    snapshot.sourceImageName.toLowerCase().includes(normalizedKeyword) ||
    snapshot.imageId.toLowerCase().includes(normalizedKeyword)
  );
}

function matchesPlatformAssetSearch(asset: PlatformImageAsset, keyword: string) {
  const normalizedKeyword = normalizeKeyword(keyword);
  if (!normalizedKeyword) {
    return true;
  }

  return asset.displayName.toLowerCase().includes(normalizedKeyword) || asset.imageId.toLowerCase().includes(normalizedKeyword);
}

function getPlatformAssetCreator(asset: PlatformImageAsset) {
  return asset.createdBy?.trim() || 'admin';
}

function buildCollectedImageIdSet(items: PlatformImageAsset[]) {
  return new Set(items.filter((item) => item.enabled).map((item) => item.imageId));
}

function replacePlatformAsset(items: PlatformImageAsset[], nextAsset: PlatformImageAsset) {
  return items.map((item) => (item.id === nextAsset.id ? nextAsset : item));
}

function upsertPlatformAsset(items: PlatformImageAsset[], nextAsset: PlatformImageAsset) {
  return items.some((item) => item.id === nextAsset.id) ? replacePlatformAsset(items, nextAsset) : [nextAsset, ...items];
}

function removeSnapshot(scopePayload: ImageCatalogScopePayload | null, snapshotId: string) {
  if (!scopePayload) {
    return scopePayload;
  }

  return {
    ...scopePayload,
    snapshots: scopePayload.snapshots.filter((snapshot) => snapshot.id !== snapshotId),
  } satisfies ImageCatalogScopePayload;
}

function ImageCenterDialog({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
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

function CloudSourceTabs({
  activeTab,
  children,
  isCloudView,
  onTabChange,
}: {
  activeTab: ActiveTab;
  children: React.ReactNode;
  isCloudView: boolean;
  onTabChange: (tab: 'custom' | 'public') => void;
}) {
  if (!isCloudView) {
    return <>{children}</>;
  }

  const cloudTab = activeTab === 'public' ? 'public' : 'custom';

  return (
    <Tabs
      onValueChange={(tab) => {
        if (tab === 'custom' || tab === 'public') {
          onTabChange(tab);
        }
      }}
      value={cloudTab}
    >
      <TabsList aria-label="云上镜像来源切换" variant="line">
        <TabsTrigger value="custom">阿里云自定义镜像</TabsTrigger>
        <TabsTrigger value="public">阿里云公共镜像</TabsTrigger>
      </TabsList>
      <TabsContent className="mt-4" value={cloudTab}>
        {children}
      </TabsContent>
    </Tabs>
  );
}

export function ImageCenterScreen({
  apiBaseUrl = 'http://localhost:3001',
}: ImageCenterScreenProps) {
  const router = useRouter();
  const session = useAdminSession();
  const [activeTab, setActiveTab] = useState<ActiveTab>('platform');
  const [searchName, setSearchName] = useState('');
  const [platformAssets, setPlatformAssets] = useState<PlatformImageAsset[]>([]);
  const [myAssets, setMyAssets] = useState<PlatformImageAsset[]>([]);
  const [platformImageTags, setAvailablePlatformImageTags] = useState<PlatformImageTag[]>([]);
  const [platformCreatedByFilter, setPlatformCreatedByFilter] = useState('');
  const [platformTagFilter, setPlatformTagFilter] = useState('');
  const [publicScope, setPublicScope] = useState<ImageCatalogScopePayload | null>(null);
  const [customScope, setCustomScope] = useState<ImageCatalogScopePayload | null>(null);
  const [loadedTabs, setLoadedTabs] = useState<Record<ActiveTab, boolean>>({
    platform: false,
    mine: false,
    custom: false,
    public: false,
  });
  const [tabErrors, setTabErrors] = useState<TabErrorMap>({});
  const [revalidationErrors, setRevalidationErrors] = useState<TabErrorMap>({});
  const [actionErrorMessage, setActionErrorMessage] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [refreshingTabs, setRefreshingTabs] = useState<Record<ActiveTab, boolean>>({
    platform: false,
    mine: false,
    custom: false,
    public: false,
  });
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [pendingActionKeys, setPendingActionKeys] = useState<string[]>([]);
  const [tabPages, setTabPages] = useState<TabPageMap>({ platform: 1, mine: 1, custom: 1, public: 1 });
  const [jumpPageValue, setJumpPageValue] = useState('1');
  const [renamingAsset, setRenamingAsset] = useState<PlatformImageAsset | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [taggingAsset, setTaggingAsset] = useState<PlatformImageAsset | null>(null);
  const [taggingTagIds, setTaggingTagIds] = useState<string[]>([]);
  const [newTagName, setNewTagName] = useState('');
  const [taggingErrorMessage, setTaggingErrorMessage] = useState('');
  const [confirmState, setConfirmState] = useState<ImageCenterConfirmState>(null);
  const [cloudContexts, setCloudContexts] = useState<CloudAccountContext[]>([]);
  const [imageImportJobs, setImageImportJobs] = useState<ImageImportJob[]>([]);
  const [imageImportDraft, setImageImportDraft] = useState<ImageImportDialogDraft | null>(null);
  const [imageImportErrorMessage, setImageImportErrorMessage] = useState('');
  const [imageImportSuccessMessage, setImageImportSuccessMessage] = useState('');
  const [imageImportProgress, setImageImportProgress] = useState<number | null>(null);
  const platformRequestVersionRef = useRef(0);
  const mineRequestVersionRef = useRef(0);
  const platformImageTagsRequestVersionRef = useRef(0);
  const imageImportJobsRequestVersionRef = useRef(0);
  const publicScopeRequestVersionRef = useRef(0);
  const customScopeRequestVersionRef = useRef(0);
  const loadedTabsRef = useRef(loadedTabs);
  const { pageSizeMode, pageSize, setPageSizeMode, setPageSize } = useAdminPageSize();

  function beginAction(actionKey: string) {
    setPendingActionKeys((previous) => (previous.includes(actionKey) ? previous : [...previous, actionKey]));
  }

  function endAction(actionKey: string) {
    setPendingActionKeys((previous) => previous.filter((item) => item !== actionKey));
  }

  function clearTabError(tab: ActiveTab) {
    setTabErrors((current) => {
      if (!current[tab]) {
        return current;
      }

      const { [tab]: _removed, ...remaining } = current;
      return remaining;
    });
  }

  function clearRevalidationError(tab: ActiveTab) {
    setRevalidationErrors((current) => {
      if (!current[tab]) {
        return current;
      }

      const { [tab]: _removed, ...remaining } = current;
      return remaining;
    });
  }

  function markTabLoaded(tab: ActiveTab) {
    if (loadedTabsRef.current[tab]) {
      return;
    }

    loadedTabsRef.current = { ...loadedTabsRef.current, [tab]: true };
    setLoadedTabs((current) => {
      if (current[tab]) {
        return current;
      }

      return { ...current, [tab]: true };
    });
  }

  function setTabRefreshing(tab: ActiveTab, isRefreshing: boolean) {
    setRefreshingTabs((current) => (current[tab] === isRefreshing ? current : { ...current, [tab]: isRefreshing }));
  }

  function reportTabLoadError(tab: ActiveTab, error: unknown, fallback: string) {
    const message = error instanceof Error ? error.message : fallback;

    if (loadedTabsRef.current[tab]) {
      setRevalidationErrors((current) => ({ ...current, [tab]: message }));
      return;
    }

    setTabErrors((current) => ({ ...current, [tab]: message }));
  }

  function setPage(tab: ActiveTab, page: number) {
    setTabPages((previous) => ({
      ...previous,
      [tab]: page,
    }));
  }

  function syncAssetAcrossViews(nextAsset: PlatformImageAsset) {
    setPlatformAssets((previous) => {
      if (nextAsset.visibility === 'private') {
        return previous.filter((item) => item.id !== nextAsset.id);
      }

      return previous.some((item) => item.id === nextAsset.id)
        ? replacePlatformAsset(previous, nextAsset)
        : upsertPlatformAsset(previous, nextAsset);
    });
    setMyAssets((previous) =>
      previous.some((item) => item.id === nextAsset.id)
        ? replacePlatformAsset(previous, nextAsset)
        : previous,
    );
  }

  function removeAssetFromViews(assetId: string) {
    setPlatformAssets((previous) => previous.filter((item) => item.id !== assetId));
    setMyAssets((previous) => previous.filter((item) => item.id !== assetId));
  }

  function handleCreateInstance(asset: PlatformImageAsset) {
    const nextSearchParams = new URLSearchParams({
      create: '1',
      platformImageAssetId: asset.id,
    });
    router.push(`/admin/instances?${nextSearchParams.toString()}`);
  }

  function setActiveMainView(nextView: 'platform' | 'mine' | 'cloud') {
    if (nextView === 'cloud' && !session.isAdmin) {
      setActiveTab('platform');
      return;
    }

    if (nextView === 'cloud') {
      setActiveTab((previous) => (previous === 'platform' || previous === 'mine' ? 'custom' : previous));
      return;
    }

    setActiveTab(nextView);
  }

  const activeCloudContext = cloudContexts.find((context) => context.isActive && context.status === 'ready') ?? null;
  const imageImportUnavailableMessage = !activeCloudContext
    ? '请先由管理员保存云配置并完成阿里云账号验证。'
    : !activeCloudContext.imageImportBucket.trim() || activeCloudContext.bucketStatus === 'unconfigured'
      ? '当前阿里云账号未配置镜像导入 Bucket，请先在云配置中填写自定义 OSS 存储桶名。'
      : activeCloudContext.bucketStatus !== 'ready'
        ? '配置的镜像导入 Bucket 不可用，请检查名称、地域和权限。'
        : null;
  const canImportImages = imageImportUnavailableMessage === null;

  function openImageImportDialog() {
    setImageImportDraft(createImageImportDraft());
    setImageImportErrorMessage('');
    setImageImportSuccessMessage('');
    setImageImportProgress(null);
  }

  function closeImageImportDialog() {
    if (imageImportProgress !== null && imageImportProgress < 100) {
      return;
    }
    setImageImportDraft(null);
    setImageImportErrorMessage('');
    setImageImportProgress(null);
  }

  function updateImageImportDraft(patch: Partial<ImageImportDialogDraft>) {
    setImageImportDraft((current) => (current ? { ...current, ...patch } : current));
    setImageImportErrorMessage('');
  }

  async function refreshMyAssets(
    token: string,
    isActive = () => true,
    options: {
      isRevalidation?: boolean;
    } = {},
  ) {
    const requestVersion = mineRequestVersionRef.current + 1;
    mineRequestVersionRef.current = requestVersion;
    const imageImportJobsRequestVersion = imageImportJobsRequestVersionRef.current + 1;
    imageImportJobsRequestVersionRef.current = imageImportJobsRequestVersion;

    if (options.isRevalidation) {
      clearRevalidationError('mine');
      setTabRefreshing('mine', true);
    }

    try {
      const [jobsPayload, myAssetsPayload] = await Promise.all([
        fetchImageImportJobs(apiBaseUrl, token),
        fetchPlatformImages(apiBaseUrl, token, 'mine'),
      ]);

      if (
        !isActive() ||
        mineRequestVersionRef.current !== requestVersion ||
        imageImportJobsRequestVersionRef.current !== imageImportJobsRequestVersion
      ) {
        return false;
      }

      setImageImportJobs(jobsPayload.items);
      setMyAssets(myAssetsPayload.items);
      markTabLoaded('mine');
      return true;
    } catch (error) {
      if (
        !isActive() ||
        mineRequestVersionRef.current !== requestVersion ||
        imageImportJobsRequestVersionRef.current !== imageImportJobsRequestVersion
      ) {
        return false;
      }
      if (isUnauthorizedAdminError(error)) {
        session.logout();
        return false;
      }
      reportTabLoadError('mine', error, '我的镜像刷新失败');
      return false;
    } finally {
      if (options.isRevalidation && isActive()) {
        setTabRefreshing('mine', false);
      }
    }
  }

  useEffect(() => {
    if (!session.isReady || !session.token) {
      setCloudContexts([]);
      setImageImportJobs([]);
      setAvailablePlatformImageTags([]);
      return;
    }

    let isActive = true;
    const imageImportJobsRequestVersion = imageImportJobsRequestVersionRef.current + 1;
    imageImportJobsRequestVersionRef.current = imageImportJobsRequestVersion;
    const platformImageTagsRequestVersion = platformImageTagsRequestVersionRef.current + 1;
    platformImageTagsRequestVersionRef.current = platformImageTagsRequestVersion;

    Promise.all([
      fetchCloudAccountContexts(apiBaseUrl, session.token),
      fetchImageImportJobs(apiBaseUrl, session.token),
      fetchPlatformImageTags(apiBaseUrl, session.token),
    ])
      .then(([contextsPayload, jobsPayload, tagsPayload]) => {
        if (!isActive) {
          return;
        }
        setCloudContexts(contextsPayload);
        if (imageImportJobsRequestVersionRef.current === imageImportJobsRequestVersion) {
          setImageImportJobs(jobsPayload.items);
        }
        if (platformImageTagsRequestVersionRef.current === platformImageTagsRequestVersion) {
          setAvailablePlatformImageTags(tagsPayload.items);
        }
      })
      .catch((error) => {
        if (!isActive) {
          return;
        }
        if (isUnauthorizedAdminError(error)) {
          session.logout();
          return;
        }
        setActionErrorMessage(error instanceof Error ? error.message : '云账号上下文加载失败');
      });

    return () => {
      isActive = false;
    };
  }, [apiBaseUrl, session.isReady, session.token]);

  const hasImportingJobs = imageImportJobs.some((job) => job.status === 'importing');

  useEffect(() => {
    if (!session.token || !hasImportingJobs) {
      return;
    }

    const token = session.token;
    let isActive = true;
    let refreshing = false;

    const refresh = async () => {
      if (refreshing) {
        return;
      }
      refreshing = true;
      await refreshMyAssets(token, () => isActive, { isRevalidation: true });
      refreshing = false;
    };

    void refresh();
    const interval = window.setInterval(() => void refresh(), 5_000);

    return () => {
      isActive = false;
      window.clearInterval(interval);
    };
  }, [apiBaseUrl, hasImportingJobs, session.token]);

  useEffect(() => {
    if (!session.isReady) {
      return;
    }

    if (!session.token) {
      setPlatformAssets([]);
      setMyAssets([]);
      setAvailablePlatformImageTags([]);
      setPlatformCreatedByFilter('');
      setPlatformTagFilter('');
      setPublicScope(null);
      setCustomScope(null);
      const resetLoadedTabs = { platform: false, mine: false, custom: false, public: false };
      loadedTabsRef.current = resetLoadedTabs;
      setLoadedTabs(resetLoadedTabs);
      setTabErrors({});
      setRevalidationErrors({});
      setRefreshingTabs({ platform: false, mine: false, custom: false, public: false });
      setIsLoading(false);
      return;
    }

    if (loadedTabs[activeTab]) {
      setIsLoading(false);
      return;
    }

    const platformRequestVersion = platformRequestVersionRef.current + 1;
    const mineRequestVersion = mineRequestVersionRef.current + 1;
    const publicRequestVersion = publicScopeRequestVersionRef.current + 1;
    const customRequestVersion = customScopeRequestVersionRef.current + 1;
    platformRequestVersionRef.current = platformRequestVersion;
    mineRequestVersionRef.current = mineRequestVersion;
    publicScopeRequestVersionRef.current = publicRequestVersion;
    customScopeRequestVersionRef.current = customRequestVersion;
    const token = session.token;
    let isActive = true;
    setIsLoading(true);
    clearTabError(activeTab);

    const request =
      activeTab === 'platform'
        ? fetchPlatformImages(apiBaseUrl, token, 'platform').then((payload) => {
            if (!isActive || platformRequestVersionRef.current !== platformRequestVersion) {
              return;
            }

            setPlatformAssets(payload.items);
          })
        : activeTab === 'mine'
          ? refreshMyAssets(token, () => isActive)
          : activeTab === 'custom'
            ? fetchCustomImageCatalogScope(apiBaseUrl, token).then((scope) => {
                if (!isActive || customScopeRequestVersionRef.current !== customRequestVersion) {
                  return;
                }

                setCustomScope(scope);
              })
            : fetchPublicImageCatalogScope(apiBaseUrl, token).then((scope) => {
                if (!isActive || publicScopeRequestVersionRef.current !== publicRequestVersion) {
                  return;
                }

                setPublicScope(scope);
              });

    request
      .then((didLoad) => {
        if (!isActive) {
          return;
        }

        if (didLoad === false) {
          return;
        }

        markTabLoaded(activeTab);
      })
      .catch((error) => {
        if (!isActive) {
          return;
        }

        if (isUnauthorizedAdminError(error)) {
          session.logout();
          return;
        }

        reportTabLoadError(activeTab, error, '镜像中心加载失败');
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
  }, [activeTab, apiBaseUrl, loadAttempt, loadedTabs[activeTab], session.isReady, session.token]);

  async function handleSyncPublicImages() {
    if (!session.token) {
      return;
    }

    const actionKey = 'sync:public';
    const requestVersion = publicScopeRequestVersionRef.current + 1;
    publicScopeRequestVersionRef.current = requestVersion;

    try {
      setActionErrorMessage('');
      setTabRefreshing('public', true);
      beginAction(actionKey);
      const nextScope = await syncPublicImages(apiBaseUrl, session.token);

      if (publicScopeRequestVersionRef.current === requestVersion) {
        setPublicScope(nextScope);
      }
    } catch (error) {
      if (isUnauthorizedAdminError(error)) {
        session.logout();
        return;
      }

      setActionErrorMessage(error instanceof Error ? error.message : '公共镜像同步失败');
    } finally {
      endAction(actionKey);
      setTabRefreshing('public', false);
    }
  }

  async function handleSyncCustomImages() {
    if (!session.token) {
      return;
    }

    const actionKey = 'sync:custom';
    const requestVersion = customScopeRequestVersionRef.current + 1;
    customScopeRequestVersionRef.current = requestVersion;

    try {
      setActionErrorMessage('');
      setTabRefreshing('custom', true);
      beginAction(actionKey);
      const nextScope = await syncCustomImages(apiBaseUrl, session.token);

      if (customScopeRequestVersionRef.current === requestVersion) {
        setCustomScope(nextScope);
      }
    } catch (error) {
      if (isUnauthorizedAdminError(error)) {
        session.logout();
        return;
      }

      setActionErrorMessage(error instanceof Error ? error.message : '自定义镜像同步失败');
    } finally {
      endAction(actionKey);
      setTabRefreshing('custom', false);
    }
  }

  async function handleSubmitImageImport() {
    if (!session.token || !imageImportDraft || !activeCloudContext || !canImportImages) {
      setImageImportErrorMessage(imageImportUnavailableMessage ?? '当前镜像导入不可用。');
      return;
    }

    const file = imageImportDraft.file;
    const imageFormat = file ? inferImageFormat(file.name) : null;
    const systemDiskSize = Number.parseInt(imageImportDraft.systemDiskSize, 10);

    if (!file) {
      setImageImportErrorMessage('请选择 QCOW2、RAW 或 VHD 格式的系统盘镜像文件。');
      return;
    }
    if (!imageFormat) {
      setImageImportErrorMessage('当前仅支持 .qcow2、.raw 和 .vhd 镜像文件。');
      return;
    }
    if (!imageImportDraft.displayName.trim()) {
      setImageImportErrorMessage('请填写镜像名。');
      return;
    }
    if (!Number.isInteger(systemDiskSize) || systemDiskSize < 1 || systemDiskSize > 2048) {
      setImageImportErrorMessage('系统盘大小必须是 1 至 2048 GiB 的整数。');
      return;
    }

    const actionKey = 'create:image-import';

    try {
      beginAction(actionKey);
      setImageImportErrorMessage('');
      setImageImportSuccessMessage('');
      setImageImportProgress(0);
      const sessionPayload = await createImageImport(apiBaseUrl, session.token, {
        cloudContextId: activeCloudContext.id,
        displayName: imageImportDraft.displayName.trim(),
        defaultHostName: imageImportDraft.defaultHostName.trim() || undefined,
        defaultPassword: imageImportDraft.defaultPassword || undefined,
        description: imageImportDraft.description.trim() || undefined,
        osType: imageImportDraft.osType,
        platform: imageImportDraft.platform.trim() || undefined,
        architecture: imageImportDraft.architecture,
        bootMode: imageImportDraft.bootMode,
        imageFormat,
        systemDiskSize,
        sourceFileName: file.name,
        sourceContentType: file.type || 'application/octet-stream',
        sourceSizeBytes: file.size,
      });
      setImageImportJobs((current) => [sessionPayload.job, ...current.filter((job) => job.id !== sessionPayload.job.id)]);
      await uploadFileToOss({
        url: sessionPayload.upload.url,
        headers: sessionPayload.upload.headers,
        file,
        onProgress: setImageImportProgress,
      });
      const completedJob = await completeImageImport(apiBaseUrl, session.token, sessionPayload.job.id);
      setImageImportJobs((current) => [completedJob, ...current.filter((job) => job.id !== completedJob.id)]);

      if (completedJob.status === 'failed' && !completedJob.imageId) {
        setImageImportDraft(null);
        setImageImportProgress(null);
        setActionErrorMessage(
          `${completedJob.errorMessage || '阿里云尚未接受导入请求。'} 已保留已上传文件，请在“我的镜像”的导入任务中点击“重试导入”。`,
        );
        return;
      }

      setActiveTab('mine');
      setImageImportDraft(null);
      setImageImportProgress(null);
      setImageImportSuccessMessage('镜像文件已上传，阿里云正在导入；导入完成后会自动启用“我的镜像”。');
      void refreshMyAssets(session.token, () => true, { isRevalidation: true });
    } catch (error) {
      if (isUnauthorizedAdminError(error)) {
        session.logout();
        return;
      }
      setImageImportProgress(null);
      setImageImportErrorMessage(error instanceof Error ? error.message : '镜像上传或导入请求失败。');
    } finally {
      endAction(actionKey);
    }
  }

  async function handleRetryImageImport(job: ImageImportJob) {
    if (!session.token) {
      return;
    }

    const actionKey = `retry:image-import:${job.id}`;

    try {
      beginAction(actionKey);
      setImageImportErrorMessage('');
      const nextJob = await retryImageImport(apiBaseUrl, session.token, job.id);
      setImageImportJobs((current) => [nextJob, ...current.filter((item) => item.id !== nextJob.id)]);
    } catch (error) {
      if (isUnauthorizedAdminError(error)) {
        session.logout();
        return;
      }

      setActionErrorMessage(error instanceof Error ? error.message : '镜像导入重试失败。');
    } finally {
      endAction(actionKey);
    }
  }

  async function handleCollectSnapshot(snapshot: ImageSnapshot) {
    if (!session.token) {
      return;
    }

    const actionKey = `collect:${snapshot.scope}:${snapshot.imageId}`;

    try {
      setActionErrorMessage('');
      beginAction(actionKey);
      const nextPlatformAsset = await collectPlatformImage(apiBaseUrl, session.token, {
        snapshotId: snapshot.id,
        displayName: snapshot.sourceImageName,
      });

      syncAssetAcrossViews(nextPlatformAsset);
    } catch (error) {
      if (isUnauthorizedAdminError(error)) {
        session.logout();
        return;
      }

      setActionErrorMessage(error instanceof Error ? error.message : '镜像收录失败');
    } finally {
      endAction(actionKey);
    }
  }

  function openRenameDialog(asset: PlatformImageAsset) {
    setRenamingAsset(asset);
    setRenameDraft(asset.displayName);
  }

  function closeRenameDialog() {
    setRenamingAsset(null);
    setRenameDraft('');
  }

  function openTaggingDialog(asset: PlatformImageAsset) {
    setTaggingAsset(asset);
    setTaggingTagIds(asset.tags.map((tag) => tag.id));
    setNewTagName('');
    setTaggingErrorMessage('');
  }

  function closeTaggingDialog() {
    setTaggingAsset(null);
    setTaggingTagIds([]);
    setNewTagName('');
    setTaggingErrorMessage('');
  }

  function toggleTaggingTag(tagId: string, checked: boolean) {
    setTaggingTagIds((current) =>
      checked ? (current.includes(tagId) ? current : [...current, tagId]) : current.filter((currentTagId) => currentTagId !== tagId),
    );
  }

  async function handleCreatePlatformImageTag() {
    if (!session.token || !session.isAdmin) {
      return;
    }

    const name = newTagName.trim();

    if (!name) {
      setTaggingErrorMessage('请填写标签名称。');
      return;
    }

    const actionKey = 'create:platform-image-tag';

    try {
      setTaggingErrorMessage('');
      beginAction(actionKey);
      const tag = await createPlatformImageTag(apiBaseUrl, session.token, name);
      setAvailablePlatformImageTags((current) =>
        [...current.filter((item) => item.id !== tag.id), tag].sort((left, right) => left.name.localeCompare(right.name, 'zh-CN')),
      );
      setTaggingTagIds((current) => (current.includes(tag.id) ? current : [...current, tag.id]));
      setNewTagName('');
    } catch (error) {
      if (isUnauthorizedAdminError(error)) {
        session.logout();
        return;
      }

      setTaggingErrorMessage(error instanceof Error ? error.message : '镜像标签创建失败');
    } finally {
      endAction(actionKey);
    }
  }

  async function handleSavePlatformImageTags() {
    if (!taggingAsset || !session.token) {
      return;
    }

    const actionKey = `tags:platform:${taggingAsset.id}`;

    try {
      setTaggingErrorMessage('');
      beginAction(actionKey);
      const nextAsset = await setPlatformImageTags(apiBaseUrl, session.token, taggingAsset.id, taggingTagIds);
      syncAssetAcrossViews(nextAsset);
      closeTaggingDialog();
    } catch (error) {
      if (isUnauthorizedAdminError(error)) {
        session.logout();
        return;
      }

      setTaggingErrorMessage(error instanceof Error ? error.message : '镜像标签保存失败');
    } finally {
      endAction(actionKey);
    }
  }

  function closeConfirmDialog() {
    setConfirmState(null);
  }

  async function handleRenamePlatformAsset() {
    if (!renamingAsset || !session.token) {
      return;
    }

    const nextDisplayName = renameDraft.trim();
    if (!nextDisplayName || nextDisplayName === renamingAsset.displayName) {
      closeRenameDialog();
      return;
    }

    const actionKey = `rename:platform:${renamingAsset.id}`;

    try {
      setActionErrorMessage('');
      beginAction(actionKey);
      const nextAsset = await renamePlatformImage(apiBaseUrl, session.token, renamingAsset.id, nextDisplayName);
      syncAssetAcrossViews(nextAsset);
      closeRenameDialog();
    } catch (error) {
      if (isUnauthorizedAdminError(error)) {
        session.logout();
        return;
      }

      setActionErrorMessage(error instanceof Error ? error.message : '平台镜像重命名失败');
    } finally {
      endAction(actionKey);
    }
  }

  async function handleTogglePlatformAsset(asset: PlatformImageAsset) {
    if (!session.token) {
      return;
    }

    const actionKey = `${asset.enabled ? 'disable' : 'enable'}:platform:${asset.id}`;

    try {
      setActionErrorMessage('');
      beginAction(actionKey);
      const nextAsset = asset.enabled
        ? await disablePlatformImage(apiBaseUrl, session.token, asset.id)
        : await enablePlatformImage(apiBaseUrl, session.token, asset.id);
      syncAssetAcrossViews(nextAsset);
    } catch (error) {
      if (isUnauthorizedAdminError(error)) {
        session.logout();
        return;
      }

      setActionErrorMessage(error instanceof Error ? error.message : '平台镜像状态更新失败');
    } finally {
      endAction(actionKey);
    }
  }

  async function handlePublishPlatformAsset(asset: PlatformImageAsset) {
    if (!session.token) {
      return;
    }

    const actionKey = `publish:platform:${asset.id}`;

    try {
      setActionErrorMessage('');
      beginAction(actionKey);
      const nextAsset = await publishPlatformImage(apiBaseUrl, session.token, asset.id);
      syncAssetAcrossViews(nextAsset);
    } catch (error) {
      if (isUnauthorizedAdminError(error)) {
        session.logout();
        return;
      }

      setActionErrorMessage(error instanceof Error ? error.message : '镜像发布失败');
    } finally {
      endAction(actionKey);
    }
  }

  async function handleUnpublishPlatformAsset(asset: PlatformImageAsset) {
    if (!session.token) {
      return;
    }

    const actionKey = `unpublish:platform:${asset.id}`;

    try {
      setActionErrorMessage('');
      beginAction(actionKey);
      const nextAsset = await unpublishPlatformImage(apiBaseUrl, session.token, asset.id);
      syncAssetAcrossViews(nextAsset);
    } catch (error) {
      if (isUnauthorizedAdminError(error)) {
        session.logout();
        return;
      }

      setActionErrorMessage(error instanceof Error ? error.message : '镜像已回退为私有失败');
    } finally {
      endAction(actionKey);
    }
  }

  async function handleRemovePlatformAsset(asset: PlatformImageAsset) {
    if (!session.token) {
      return;
    }

    const actionKey = `remove:platform:${asset.id}`;

    try {
      setActionErrorMessage('');
      beginAction(actionKey);
      await removePlatformImage(apiBaseUrl, session.token, asset.id);
      removeAssetFromViews(asset.id);
      closeConfirmDialog();
    } catch (error) {
      if (isUnauthorizedAdminError(error)) {
        session.logout();
        return;
      }

      setActionErrorMessage(error instanceof Error ? error.message : '平台镜像删除失败');
    } finally {
      endAction(actionKey);
    }
  }

  async function handleDeleteCustomSnapshot(snapshot: ImageSnapshot) {
    if (!session.token) {
      return;
    }

    const actionKey = `delete:custom:${snapshot.id}`;
    const requestVersion = customScopeRequestVersionRef.current + 1;
    customScopeRequestVersionRef.current = requestVersion;

    try {
      setActionErrorMessage('');
      beginAction(actionKey);
      await deleteCustomImageSnapshot(apiBaseUrl, session.token, snapshot.id);

      if (customScopeRequestVersionRef.current === requestVersion) {
        setCustomScope((previous) => removeSnapshot(previous, snapshot.id));
      }
      closeConfirmDialog();
    } catch (error) {
      if (isUnauthorizedAdminError(error)) {
        session.logout();
        return;
      }

      setActionErrorMessage(error instanceof Error ? error.message : '云上镜像删除失败');
    } finally {
      endAction(actionKey);
    }
  }

  const platformCreators = [...new Set(platformAssets.map(getPlatformAssetCreator))].sort((left, right) =>
    left.localeCompare(right, 'zh-CN'),
  );
  const filteredPlatformAssets = platformAssets.filter(
    (asset) =>
      matchesPlatformAssetSearch(asset, searchName) &&
      (!platformCreatedByFilter || getPlatformAssetCreator(asset) === platformCreatedByFilter) &&
      (!platformTagFilter || asset.tags.some((tag) => tag.id === platformTagFilter)),
  );
  const filteredMyAssets = myAssets.filter((asset) => matchesPlatformAssetSearch(asset, searchName));
  const filteredCustomSnapshots = (customScope?.snapshots ?? []).filter((snapshot) => matchesSnapshotSearch(snapshot, searchName));
  const filteredPublicSnapshots = (publicScope?.snapshots ?? []).filter((snapshot) => matchesSnapshotSearch(snapshot, searchName));

  const activeItemsCount =
    activeTab === 'platform'
      ? filteredPlatformAssets.length
      : activeTab === 'mine'
        ? filteredMyAssets.length
      : activeTab === 'custom'
        ? filteredCustomSnapshots.length
        : filteredPublicSnapshots.length;

  const activePagination = getPagination(activeItemsCount, tabPages[activeTab], pageSize);
  const visiblePages = buildVisiblePages(activePagination.totalPages, activePagination.page);

  useEffect(() => {
    if (tabPages[activeTab] !== activePagination.page) {
      setPage(activeTab, activePagination.page);
    }
  }, [activePagination.page, activeTab, tabPages]);

  useEffect(() => {
    setJumpPageValue(String(activePagination.page));
  }, [activePagination.page, activeTab]);

  function goToPreviousPage() {
    setPage(activeTab, activePagination.page - 1);
  }

  function goToNextPage() {
    setPage(activeTab, activePagination.page + 1);
  }

  function handlePageSizeChange(nextValue: string) {
    if (nextValue === PAGE_SIZE_AUTO) {
      setPageSizeMode(PAGE_SIZE_AUTO);
      setTabPages({ platform: 1, mine: 1, custom: 1, public: 1 });
      return;
    }

    const nextPageSize = Number(nextValue);
    setPageSizeMode(nextValue);
    setPageSize(nextPageSize);
    setTabPages({ platform: 1, mine: 1, custom: 1, public: 1 });
  }

  function handleJumpToPage() {
    const parsedPage = Number.parseInt(jumpPageValue, 10);
    if (Number.isNaN(parsedPage)) {
      setJumpPageValue(String(activePagination.page));
      return;
    }

    setPage(activeTab, parsedPage);
  }

  const pagedPlatformAssets = filteredPlatformAssets.slice(activePagination.startIndex, activePagination.endIndex);
  const pagedMyAssets = filteredMyAssets.slice(activePagination.startIndex, activePagination.endIndex);
  const pagedCustomSnapshots = filteredCustomSnapshots.slice(activePagination.startIndex, activePagination.endIndex);
  const pagedPublicSnapshots = filteredPublicSnapshots.slice(activePagination.startIndex, activePagination.endIndex);

  const collectedImageIds = buildCollectedImageIdSet(platformAssets);
  const myAssetIds = new Set(myAssets.map((asset) => asset.id));
  const visibleImageImportJobs = imageImportJobs.filter((job) => shouldShowImageImportJob(job, myAssetIds));
  const importingAssetIds = new Set(
    imageImportJobs
      .filter((job) => job.status === 'importing')
      .flatMap((job) => [job.platformImageAssetId, job.imageId].filter((value): value is string => Boolean(value))),
  );

  function renderAssetRows(
    items: PlatformImageAsset[],
    columns: readonly AdminDataColumn[],
    options: {
      allowManagement: boolean | ((asset: PlatformImageAsset) => boolean);
      allowVisibilityToggle?: boolean | ((asset: PlatformImageAsset) => boolean);
    },
  ) {
    return items.map((asset) => {
      const [nameColumn, imageIdColumn, createdByColumn, tagsColumn, statusColumn, actionsColumn] = columns;
      const renameActionKey = `rename:platform:${asset.id}`;
      const toggleActionKey = `${asset.enabled ? 'disable' : 'enable'}:platform:${asset.id}`;
      const visibilityActionKey = `${asset.visibility === 'platform' ? 'unpublish' : 'publish'}:platform:${asset.id}`;
      const taggingActionKey = `tags:platform:${asset.id}`;
      const removeActionKey = `remove:platform:${asset.id}`;
      const isPending = [renameActionKey, toggleActionKey, visibilityActionKey, taggingActionKey, removeActionKey].some((key) =>
        pendingActionKeys.includes(key),
      );
      const canManageAsset =
        typeof options.allowManagement === 'function' ? options.allowManagement(asset) : options.allowManagement;
      const canToggleVisibility =
        typeof options.allowVisibilityToggle === 'function'
          ? options.allowVisibilityToggle(asset)
          : options.allowVisibilityToggle ?? false;
      const isImportingAsset =
        importingAssetIds.has(asset.id) ||
        importingAssetIds.has(asset.imageId) ||
        /^Creating\b/i.test(asset.sourceSnapshotStatus?.trim() ?? '');
      const canCreate = canCreateInstanceFromAsset(asset);
      const statusVariant = asset.sourceSnapshotAvailable === false || !asset.enabled ? 'secondary' : 'default';

      return (
        <TableRow key={asset.id}>
          <AdminDataTableCell className="font-medium" column={nameColumn!}>
            <div className="flex min-w-48 flex-col gap-1">
              <span>{asset.displayName}</span>
              <span className="text-xs text-muted-foreground">
                来源：{asset.sourceScope === 'custom' ? '阿里云自定义镜像' : '阿里云公共镜像'}
              </span>
            </div>
          </AdminDataTableCell>
          <AdminDataTableCell className="font-mono text-xs text-muted-foreground" column={imageIdColumn!}>
            {asset.imageId}
          </AdminDataTableCell>
          <AdminDataTableCell column={createdByColumn!}>{getPlatformAssetCreator(asset)}</AdminDataTableCell>
          <AdminDataTableCell column={tagsColumn!}>
            {asset.tags.length > 0 ? (
              <div className="flex flex-wrap gap-1">
                {asset.tags.map((tag) => (
                  <Badge key={tag.id} variant="outline">
                    {tag.name}
                  </Badge>
                ))}
              </div>
            ) : (
              <span className="text-muted-foreground">-</span>
            )}
          </AdminDataTableCell>
          <AdminDataTableCell column={statusColumn!}>
            <Badge variant={statusVariant}>{formatAssetStatus(asset)}</Badge>
          </AdminDataTableCell>
          <AdminDataTableCell column={actionsColumn!}>
            <div className="flex justify-start gap-1">
              {canCreate ? (
                <Button
                  aria-label={`创建实例 ${asset.displayName}`}
                  onClick={() => handleCreateInstance(asset)}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  创建实例
                </Button>
              ) : null}
              {canManageAsset ? (
                <>
                  {!isImportingAsset ? (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button aria-label="更多操作" disabled={isPending} size="icon-sm" type="button" variant="ghost">
                          <MoreHorizontal aria-hidden="true" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {canToggleVisibility ? (
                          <DropdownMenuItem
                            disabled={isPending || asset.sourceSnapshotAvailable === false}
                            onSelect={() =>
                              void (asset.visibility === 'platform'
                                ? handleUnpublishPlatformAsset(asset)
                                : handlePublishPlatformAsset(asset))
                            }
                          >
                            {asset.visibility === 'platform' ? '回退为私有' : '发布到平台'}
                          </DropdownMenuItem>
                        ) : null}
                        <DropdownMenuItem onSelect={() => openTaggingDialog(asset)}>管理标签</DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => openRenameDialog(asset)}>重命名</DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => void handleTogglePlatformAsset(asset)}>
                          {asset.enabled ? '禁用' : '启用'}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          variant="destructive"
                          onSelect={() => setConfirmState({ type: 'remove-platform', asset })}
                        >
                          删除
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : null}
                </>
              ) : null}
            </div>
          </AdminDataTableCell>
        </TableRow>
      );
    });
  }

  function renderScopeRows(scope: 'custom' | 'public', snapshots: ImageSnapshot[], columns: readonly AdminDataColumn[]) {
    return snapshots.map((snapshot) => {
      const [nameColumn, imageIdColumn, statusColumn, actionsColumn] = columns;
      const isCollected = collectedImageIds.has(snapshot.imageId);
      const collectActionKey = `collect:${snapshot.scope}:${snapshot.imageId}`;
      const deleteActionKey = `delete:custom:${snapshot.id}`;
      const isCollectPending = pendingActionKeys.includes(collectActionKey);
      const isDeletePending = pendingActionKeys.includes(deleteActionKey);
      const isImportingSnapshot = imageImportJobs.some(
        (job) =>
          job.status === 'importing' &&
          (job.sourceSnapshotId === snapshot.id || (job.imageId !== null && job.imageId === snapshot.imageId)),
      );

      return (
        <TableRow key={snapshot.id}>
          <AdminDataTableCell className="font-medium" column={nameColumn!}>
            <div className="flex min-w-48 flex-col gap-1">
              <span>{snapshot.sourceImageName}</span>
              <span className="text-xs text-muted-foreground">平台：{snapshot.platform || '-'}</span>
            </div>
          </AdminDataTableCell>
          <AdminDataTableCell className="font-mono text-xs text-muted-foreground" column={imageIdColumn!}>
            {snapshot.imageId}
          </AdminDataTableCell>
          <AdminDataTableCell column={statusColumn!}>
            <Badge variant={snapshot.isAvailable ? 'default' : 'secondary'}>{formatImageStatus(snapshot)}</Badge>
          </AdminDataTableCell>
          <AdminDataTableCell column={actionsColumn!}>
            <div className="flex justify-start gap-1">
              {session.isAdmin ? (
                <Button
                  disabled={isCollected || isCollectPending}
                  aria-label={`${isCollected ? '已收录' : '收录到平台'} ${snapshot.sourceImageName}`}
                  onClick={() => void handleCollectSnapshot(snapshot)}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  {isCollected ? '已收录' : '收录到平台'}
                </Button>
              ) : null}
              {scope === 'custom' && session.isAdmin && !isImportingSnapshot ? (
                <Button
                  disabled={isDeletePending}
                  aria-label={`删除 ${snapshot.sourceImageName}`}
                  onClick={() => setConfirmState({ type: 'delete-custom', snapshot })}
                  size="sm"
                  type="button"
                  variant="destructive"
                >
                  删除
                </Button>
              ) : null}
            </div>
          </AdminDataTableCell>
        </TableRow>
      );
    });
  }

  const activeMainView = !session.isAdmin
    ? activeTab === 'mine'
      ? 'mine'
      : 'platform'
    : activeTab === 'platform' || activeTab === 'mine'
      ? activeTab
      : 'cloud';
  const activeTabTitle =
    activeTab === 'platform'
      ? '平台镜像'
      : activeTab === 'mine'
        ? '我的镜像'
        : activeTab === 'custom'
          ? '阿里云自定义镜像'
          : '阿里云公共镜像';
  const activeColumns = activeTab === 'platform' || activeTab === 'mine' ? ASSET_COLUMNS : CLOUD_IMAGE_COLUMNS;
  const activeTabError = tabErrors[activeTab] ?? '';
  const activeRevalidationError = revalidationErrors[activeTab] ?? '';
  const isActiveTabLoading = !loadedTabs[activeTab] && !activeTabError;
  const isRefreshing = refreshingTabs[activeTab] || (isLoading && loadedTabs[activeTab]);
  const emptyState =
    activeTab === 'platform'
      ? {
          title: '当前没有平台镜像',
          description: '当前没有平台镜像。',
        }
      : activeTab === 'mine'
        ? {
            title: '当前没有我的镜像',
            description: '当前没有我的镜像。',
          }
        : {
            title: '当前没有可展示的云镜像',
            description: '当前没有可展示的云镜像。',
          };

  function retryActiveTabLoad() {
    clearTabError(activeTab);
    setLoadAttempt((current) => current + 1);
  }

  function retryRevalidation(tab: ActiveTab) {
    clearRevalidationError(tab);

    if (tab === 'mine' && session.token) {
      void refreshMyAssets(session.token, () => true, { isRevalidation: true });
    }
  }

  if (!session.isReady) {
    return null;
  }

  if (!session.token) {
    return null;
  }

  return (
    <div className="admin-screen image-center-screen">
      <section className="admin-workbench-surface">
        <AdminPageHeader description="收录、导入和维护演练镜像资产。" title="镜像中心" />
        {imageImportSuccessMessage ? <p className="mt-4 text-sm text-emerald-700" aria-live="polite">{imageImportSuccessMessage}</p> : null}

        <div className="mt-4">
          <AdminListToolbar
            activeView={activeMainView}
            onSearchChange={setSearchName}
            onViewChange={(view) => {
              if (view === 'platform' || view === 'mine' || view === 'cloud') {
                setActiveMainView(view);
              }
            }}
            searchLabel="筛选镜像名"
            searchPlaceholder="搜索镜像名或镜像 ID"
            searchValue={searchName}
            views={[
              { label: '平台镜像', value: 'platform' },
              { label: '我的镜像', value: 'mine' },
              ...(session.isAdmin ? [{ label: '云上镜像来源', value: 'cloud' }] : []),
            ]}
            action={
              activeTab === 'mine' ? (
                <Button
                  disabled={!canImportImages || pendingActionKeys.includes('create:image-import')}
                  title={imageImportUnavailableMessage ?? undefined}
                  onClick={openImageImportDialog}
                  size="sm"
                  type="button"
                >
                  <Upload aria-hidden="true" />
                  上传镜像
                </Button>
              ) : activeTab === 'custom' && session.isAdmin ? (
                <Button
                  disabled={pendingActionKeys.includes('sync:custom')}
                  onClick={() => void handleSyncCustomImages()}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  <RefreshCw aria-hidden="true" />
                  同步自定义镜像
                </Button>
              ) : activeTab === 'public' && session.isAdmin ? (
                <Button
                  disabled={pendingActionKeys.includes('sync:public')}
                  onClick={() => void handleSyncPublicImages()}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  <RefreshCw aria-hidden="true" />
                  同步公共镜像
                </Button>
              ) : undefined
            }
          >
            <div className="mt-4">
              <CloudSourceTabs
                activeTab={activeTab}
                isCloudView={activeMainView === 'cloud'}
                onTabChange={setActiveTab}
              >
                <div className="space-y-4">
                  {activeTab === 'platform' ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <AdminSelectField
                        ariaLabel="按创建人筛选"
                        className="w-full sm:w-44"
                        emptyOptionLabel="全部创建人"
                        onValueChange={(value) => {
                          setPlatformCreatedByFilter(value);
                          setPage('platform', 1);
                        }}
                        options={platformCreators.map((creator) => ({ label: creator, value: creator }))}
                        value={platformCreatedByFilter}
                      />
                      <AdminSelectField
                        ariaLabel="按标签筛选"
                        className="w-full sm:w-44"
                        emptyOptionLabel="全部标签"
                        onValueChange={(value) => {
                          setPlatformTagFilter(value);
                          setPage('platform', 1);
                        }}
                        options={platformImageTags.map((tag) => ({ label: tag.name, value: tag.id }))}
                        value={platformTagFilter}
                      />
                    </div>
                  ) : null}
                  {activeTab === 'mine' && visibleImageImportJobs.length > 0 ? (
                    <div className="image-import-job-list" aria-live="polite">
                      {visibleImageImportJobs.slice(0, 3).map((job) => (
                        <div key={job.id} className={`image-import-job image-import-job--${job.status}`}>
                          <strong>{job.displayName}</strong>
                          <span>{job.status === 'available' && job.errorMessage ? '临时文件清理重试中' : formatImportStatus(job.status)}</span>
                          {job.errorMessage ? <p role="alert">{job.errorMessage}</p> : null}
                          {job.status === 'failed' && !job.imageId ? (
                            <Button
                              disabled={pendingActionKeys.includes(`retry:image-import:${job.id}`)}
                              onClick={() => void handleRetryImageImport(job)}
                              size="sm"
                              type="button"
                              variant="outline"
                            >
                              重试导入
                            </Button>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  ) : null}

                  <div>
                    <AdminDataTable columns={activeColumns} isRefreshing={isRefreshing} label={activeTabTitle}>
                      {(columns) => {
                        const actionErrorRow = actionErrorMessage ? (
                          <TableRow className="hover:bg-transparent">
                            <TableCell className="px-3 py-3 text-sm text-destructive whitespace-normal" colSpan={columns.length}>
                              <p role="alert">{actionErrorMessage}</p>
                            </TableCell>
                          </TableRow>
                        ) : null;
                        const revalidationErrorRow = activeRevalidationError ? (
                          <TableRow className="hover:bg-transparent">
                            <TableCell className="px-3 py-3 text-sm text-destructive whitespace-normal" colSpan={columns.length}>
                              <div className="flex flex-wrap items-center justify-between gap-3">
                                <p role="alert">{activeRevalidationError}</p>
                                {activeTab === 'mine' ? (
                                  <Button
                                    aria-label="重试加载我的镜像"
                                    onClick={() => retryRevalidation('mine')}
                                    size="sm"
                                    type="button"
                                    variant="outline"
                                  >
                                    重试
                                  </Button>
                                ) : null}
                              </div>
                            </TableCell>
                          </TableRow>
                        ) : null;

                        if (activeTabError) {
                          return (
                            <AdminDataTableState
                              columns={columns}
                              description={activeTabError}
                              onRetry={retryActiveTabLoad}
                              title={`无法加载${activeTabTitle}`}
                              variant="error"
                            />
                          );
                        }

                        if (isActiveTabLoading) {
                          return (
                            <TableLoadingState
                              columnCount={columns.length}
                              label={`正在加载${activeTabTitle}`}
                              rowCount={5}
                            />
                          );
                        }

                        if (!activeItemsCount) {
                          return (
                            <>
                              {revalidationErrorRow}
                              {actionErrorRow}
                              <AdminDataTableState
                                columns={columns}
                                description={emptyState.description}
                                title={emptyState.title}
                                variant="empty"
                              />
                            </>
                          );
                        }

                        if (activeTab === 'platform') {
                          return (
                            <>
                              {revalidationErrorRow}
                              {actionErrorRow}
                              {renderAssetRows(pagedPlatformAssets, columns, {
                                allowManagement: (asset) => asset.canManage ?? session.isAdmin,
                                allowVisibilityToggle: (asset) =>
                                  asset.canChangeVisibility ?? (session.isAdmin && Boolean(asset.ownerUserId)),
                              })}
                            </>
                          );
                        }

                        if (activeTab === 'mine') {
                          return (
                            <>
                              {revalidationErrorRow}
                              {actionErrorRow}
                              {renderAssetRows(pagedMyAssets, columns, {
                                allowManagement: true,
                                allowVisibilityToggle: (asset) => asset.canChangeVisibility ?? session.isAdmin,
                              })}
                            </>
                          );
                        }

                        return (
                          <>
                            {revalidationErrorRow}
                            {actionErrorRow}
                            {activeTab === 'custom'
                              ? renderScopeRows('custom', pagedCustomSnapshots, columns)
                              : renderScopeRows('public', pagedPublicSnapshots, columns)}
                          </>
                        );
                      }}
                    </AdminDataTable>
                  </div>

                  {!isActiveTabLoading && !activeTabError && activeItemsCount ? (
                    <AdminPaginationControls
                      jumpPageValue={jumpPageValue}
                      label={`${activeTabTitle} 分页`}
                      pageSizeMode={pageSizeMode}
                      pagination={activePagination}
                      visiblePages={visiblePages}
                      onJumpPage={handleJumpToPage}
                      onJumpPageValueChange={setJumpPageValue}
                      onNextPage={goToNextPage}
                      onPageSelect={(pageNumber) => setPage(activeTab, pageNumber)}
                      onPageSizeChange={handlePageSizeChange}
                      onPreviousPage={goToPreviousPage}
                    />
                  ) : null}
                </div>
              </CloudSourceTabs>
            </div>
          </AdminListToolbar>
        </div>

          {imageImportDraft ? (
            <ImageCenterDialog title="上传本地镜像">
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void handleSubmitImageImport();
                }}
              >
                <p className="image-import-dialog-copy">
                  文件会直接上传到当前云账号的私有 OSS Bucket，再由阿里云导入为自定义镜像。主机名和密码会作为后续创建实例的默认值，不会修改原始镜像文件。
                </p>
                <fieldset className="template-workbench-dialog-grid image-import-dialog-grid" disabled={pendingActionKeys.includes('create:image-import')}>
                  <label className="image-import-file-field">
                    <span>系统盘镜像文件</span>
                    <input
                      aria-label="系统盘镜像文件"
                      type="file"
                      accept=".qcow2,.raw,.vhd"
                      onChange={(event) => {
                        const file = event.target.files?.[0] ?? null;
                        const format = file ? inferImageFormat(file.name) : null;
                        updateImageImportDraft({
                          file,
                          ...(format ? { imageFormat: format } : {}),
                          ...(!imageImportDraft.displayName.trim() && file
                            ? { displayName: file.name.replace(/\.[^.]+$/, '') }
                            : {}),
                        });
                      }}
                      required
                    />
                    <small>仅支持 QCOW2、RAW、VHD；首期只导入系统盘。</small>
                  </label>
                  <label>
                    <span>镜像名</span>
                    <input aria-label="上传镜像名" value={imageImportDraft.displayName} onChange={(event) => updateImageImportDraft({ displayName: event.target.value })} required />
                  </label>
                  <label>
                    <span>默认主机名</span>
                    <input aria-label="上传镜像默认主机名" value={imageImportDraft.defaultHostName} onChange={(event) => updateImageImportDraft({ defaultHostName: event.target.value })} placeholder="可选，创建实例时使用" />
                  </label>
                  <label>
                    <span>默认登录密码</span>
                    <input aria-label="上传镜像默认登录密码" type="password" value={imageImportDraft.defaultPassword} onChange={(event) => updateImageImportDraft({ defaultPassword: event.target.value })} autoComplete="new-password" placeholder="可选，保存后不再回显" />
                  </label>
                  <label>
                    <span>备注</span>
                    <input aria-label="上传镜像备注" value={imageImportDraft.description} onChange={(event) => updateImageImportDraft({ description: event.target.value })} placeholder="镜像用途或来源说明" />
                  </label>
                  <label>
                    <span>操作系统</span>
                    <AdminSelectField
                      ariaLabel="上传镜像操作系统"
                      className="h-[46px] w-full"
                      onValueChange={(value) =>
                        updateImageImportDraft({ osType: value as ImageImportDialogDraft['osType'] })
                      }
                      options={[
                        { label: 'Linux', value: 'linux' },
                        { label: 'Windows', value: 'windows' },
                      ]}
                      value={imageImportDraft.osType}
                    />
                  </label>
                  <label>
                    <span>系统版本 / 平台</span>
                    <input aria-label="上传镜像系统版本" value={imageImportDraft.platform} onChange={(event) => updateImageImportDraft({ platform: event.target.value })} placeholder="例如 Ubuntu 22.04" />
                  </label>
                  <label>
                    <span>架构</span>
                    <AdminSelectField
                      ariaLabel="上传镜像架构"
                      className="h-[46px] w-full"
                      onValueChange={(value) =>
                        updateImageImportDraft({ architecture: value as ImageImportDialogDraft['architecture'] })
                      }
                      options={[
                        { label: 'x86_64', value: 'x86_64' },
                        { label: 'arm64', value: 'arm64' },
                      ]}
                      value={imageImportDraft.architecture}
                    />
                  </label>
                  <label>
                    <span>启动模式</span>
                    <AdminSelectField
                      ariaLabel="上传镜像启动模式"
                      className="h-[46px] w-full"
                      onValueChange={(value) =>
                        updateImageImportDraft({ bootMode: value as ImageImportDialogDraft['bootMode'] })
                      }
                      options={[
                        { label: 'BIOS', value: 'BIOS' },
                        { label: 'UEFI', value: 'UEFI' },
                      ]}
                      value={imageImportDraft.bootMode}
                    />
                  </label>
                  <label>
                    <span>镜像格式</span>
                    <AdminSelectField
                      ariaLabel="上传镜像格式"
                      className="h-[46px] w-full"
                      onValueChange={(value) =>
                        updateImageImportDraft({ imageFormat: value as ImageImportDialogDraft['imageFormat'] })
                      }
                      options={[
                        { label: 'QCOW2', value: 'qcow2' },
                        { label: 'RAW', value: 'raw' },
                        { label: 'VHD', value: 'vhd' },
                      ]}
                      value={imageImportDraft.imageFormat}
                    />
                  </label>
                  <label>
                    <span>系统盘大小（GiB）</span>
                    <input aria-label="上传镜像系统盘大小" type="number" min="1" max="2048" value={imageImportDraft.systemDiskSize} onChange={(event) => updateImageImportDraft({ systemDiskSize: event.target.value })} required />
                  </label>
                </fieldset>
                {imageImportProgress !== null ? (
                  <div className="image-import-progress" aria-live="polite">
                    <span>{imageImportProgress < 100 ? `正在上传到 OSS：${imageImportProgress}%` : '文件上传完成，正在提交阿里云导入任务…'}</span>
                    <progress value={imageImportProgress} max="100">{imageImportProgress}%</progress>
                  </div>
                ) : null}
                {imageImportErrorMessage ? <p className="admin-error image-import-dialog-error" role="alert">{imageImportErrorMessage}</p> : null}
                <div className="template-workbench-dialog-actions">
                  <button type="submit" disabled={pendingActionKeys.includes('create:image-import') || !canImportImages}>
                    {pendingActionKeys.includes('create:image-import') ? '正在处理…' : '上传并导入'}
                  </button>
                  <button type="button" disabled={pendingActionKeys.includes('create:image-import')} onClick={closeImageImportDialog}>
                    取消
                  </button>
                </div>
              </form>
            </ImageCenterDialog>
          ) : null}

          {taggingAsset ? (
            <ImageCenterDialog title="管理镜像标签">
              <div className="space-y-4">
                <div className="space-y-2">
                  {platformImageTags.length > 0 ? (
                    platformImageTags.map((tag) => (
                      <label className="flex items-center gap-2 text-sm" key={tag.id}>
                        <input
                          aria-label={`选择标签 ${tag.name}`}
                          checked={taggingTagIds.includes(tag.id)}
                          disabled={pendingActionKeys.includes(`tags:platform:${taggingAsset.id}`)}
                          onChange={(event) => toggleTaggingTag(tag.id, event.currentTarget.checked)}
                          type="checkbox"
                        />
                        <span>{tag.name}</span>
                      </label>
                    ))
                  ) : (
                    <p className="text-sm text-muted-foreground">暂无可用标签。</p>
                  )}
                </div>
                {session.isAdmin ? (
                  <div className="flex flex-wrap gap-2">
                    <input
                      aria-label="新标签名称"
                      className="min-w-40 flex-1"
                      disabled={pendingActionKeys.includes('create:platform-image-tag')}
                      maxLength={32}
                      onChange={(event) => {
                        setNewTagName(event.currentTarget.value);
                        setTaggingErrorMessage('');
                      }}
                      placeholder="新建标签"
                      value={newTagName}
                    />
                    <button
                      disabled={pendingActionKeys.includes('create:platform-image-tag')}
                      onClick={() => void handleCreatePlatformImageTag()}
                      type="button"
                    >
                      新建标签
                    </button>
                  </div>
                ) : null}
                {taggingErrorMessage ? <p className="admin-error" role="alert">{taggingErrorMessage}</p> : null}
              </div>
              <div className="template-workbench-dialog-actions">
                <button
                  disabled={
                    pendingActionKeys.includes(`tags:platform:${taggingAsset.id}`) ||
                    pendingActionKeys.includes('create:platform-image-tag')
                  }
                  onClick={() => void handleSavePlatformImageTags()}
                  type="button"
                >
                  保存标签
                </button>
                <button
                  disabled={
                    pendingActionKeys.includes(`tags:platform:${taggingAsset.id}`) ||
                    pendingActionKeys.includes('create:platform-image-tag')
                  }
                  onClick={closeTaggingDialog}
                  type="button"
                >
                  取消
                </button>
              </div>
            </ImageCenterDialog>
          ) : null}

          {renamingAsset ? (
            <ImageCenterDialog title="编辑镜像名称">
              <div className="template-workbench-dialog-grid">
                <label>
                  <span>镜像名</span>
                  <input aria-label="镜像名" value={renameDraft} onChange={(event) => setRenameDraft(event.target.value)} />
                </label>
              </div>
              <div className="template-workbench-dialog-actions">
                <button type="button" disabled={pendingActionKeys.includes(`rename:platform:${renamingAsset.id}`)} onClick={() => void handleRenamePlatformAsset()}>
                  保存信息
                </button>
                <button type="button" disabled={pendingActionKeys.includes(`rename:platform:${renamingAsset.id}`)} onClick={closeRenameDialog}>
                  取消编辑
                </button>
              </div>
            </ImageCenterDialog>
          ) : null}

          {confirmState?.type === 'remove-platform' ? (
            <ImageCenterDialog title="确认删除镜像">
              <p className="template-workbench-confirm-copy">
                删除“{confirmState.asset.displayName}”后会将其移出平台收录目录，但不会删除阿里云上的原始镜像。
              </p>
              <div className="template-workbench-dialog-actions">
                <button
                  type="button"
                  disabled={pendingActionKeys.includes(`remove:platform:${confirmState.asset.id}`)}
                  onClick={() => void handleRemovePlatformAsset(confirmState.asset)}
                >
                  确认删除
                </button>
                <button type="button" disabled={pendingActionKeys.includes(`remove:platform:${confirmState.asset.id}`)} onClick={closeConfirmDialog}>
                  取消
                </button>
              </div>
            </ImageCenterDialog>
          ) : null}

          {confirmState?.type === 'delete-custom' ? (
            <ImageCenterDialog title="确认删除阿里云自定义镜像">
              <p className="template-workbench-confirm-copy">
                即将删除阿里云上的自定义镜像“{confirmState.snapshot.sourceImageName}”，此操作会影响当前账号下该镜像的后续使用。
              </p>
              <div className="template-workbench-dialog-actions">
                <button
                  type="button"
                  disabled={pendingActionKeys.includes(`delete:custom:${confirmState.snapshot.id}`)}
                  onClick={() => void handleDeleteCustomSnapshot(confirmState.snapshot)}
                >
                  确认删除
                </button>
                <button
                  type="button"
                  disabled={pendingActionKeys.includes(`delete:custom:${confirmState.snapshot.id}`)}
                  onClick={closeConfirmDialog}
                >
                  取消
                </button>
              </div>
            </ImageCenterDialog>
          ) : null}
      </section>
    </div>
  );
}
