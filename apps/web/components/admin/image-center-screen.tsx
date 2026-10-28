'use client';

import React from 'react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronDown, MoreHorizontal, RefreshCw, Upload } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Label } from '@/components/ui/label';
import { TableCell, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

import {
  collectPlatformImage,
  completeImageImport,
  createPlatformImageTag,
  deletePlatformImageTag,
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
import { useAdminScreenCache } from '../../lib/admin-screen-cache';
import { isUnauthorizedAdminError } from '../../lib/admin-screen';
import type {
  ImageCatalogScopePayload,
  ImageSnapshot,
  CloudAccountContext,
  ImageImportJob,
  PlatformImageAsset,
  PlatformImageAssetListPayload,
  PlatformImageTag,
} from '../../lib/admin-types';
import {
  AdminPaginationControls,
  buildVisiblePages,
  getPagination,
  useAdminPageSize,
} from './admin-pagination';
import { useAdminRouteIsActive } from './admin-page-cache';
import { AdminPageHeader } from './shared/admin-page-header';
import { AdminSelectField } from './shared/admin-select-field';
import {
  AdminDataTable,
  AdminDataTableCell,
  AdminDataTableRevalidationNotice,
  AdminDataTableState,
  AdminDataTableText,
  type AdminDataColumn,
} from './shared/admin-data-table';
import { AdminListToolbar } from './shared/admin-list-toolbar';
import { AdminDialog, AdminConfirmationDialog, type AdminDialogSize } from './shared/admin-dialog';
import { AdminPaginatedList } from './shared/admin-paginated-list';
import { TableLoadingState } from './shared/table-loading-state';
import { MogongImageCatalogView } from './mogong-image-catalog';
import { useAdminSession } from './use-admin-session';
import { useCloudWorkspace } from './cloud-workspace-provider';
import { cloudProviderLabel } from './cloud-workspace-provider';
import { readCloudWorkspaceSelection } from '@/lib/cloud-workspace-selection';

type ImageCenterScreenProps = {
  apiBaseUrl?: string;
};

type ActiveTab = 'platform' | 'mine' | 'custom' | 'public';
type TabPageMap = Record<ActiveTab, number>;
type TabErrorMap = Partial<Record<ActiveTab, string>>;
type ImageCenterMineSnapshot = {
  assets: PlatformImageAsset[];
  jobs: ImageImportJob[];
};
type ImageCenterMetadata = {
  cloudContexts: CloudAccountContext[];
  imageImportJobs: ImageImportJob[];
  platformImageTags: PlatformImageTag[];
};
type ImageCenterConfirmState =
  | { type: 'remove-platform'; asset: PlatformImageAsset }
  | { type: 'delete-custom'; snapshot: ImageSnapshot; deleteOwnedSnapshots: boolean }
  | null;
type ImageImportDialogDraft = {
  file: File | null;
  displayName: string;
  defaultHostName: string;
  defaultPassword: string;
  description: string;
  osType: 'linux' | 'windows';
  platform: string;
  osVersion: string;
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

function createImageImportDraft(provider: 'alibaba_cloud' | 'tencent_cloud' = 'alibaba_cloud'): ImageImportDialogDraft {
  return {
    file: null,
    displayName: '',
    defaultHostName: '',
    defaultPassword: '',
    description: '',
    osType: 'linux',
    platform: '',
    osVersion: '',
    architecture: 'x86_64',
    bootMode: 'BIOS',
    imageFormat: 'qcow2',
    systemDiskSize: provider === 'tencent_cloud' ? '50' : '40',
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
    request.onerror = () => reject(new Error('镜像文件上传到对象存储失败，请检查网络和 Bucket CORS 配置。'));
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) {
        input.onProgress(100);
        resolve();
        return;
      }
      reject(new Error(`镜像文件上传到对象存储失败（HTTP ${request.status}）。`));
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
  if (normalizedStatus === 'Missing') return '云端已不存在';
  if (normalizedStatus === 'Deleting') return '清理中';
  if (normalizedStatus === 'Deleted') return '已删除';

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
  if (asset.sourceSnapshotAvailable == null) return '来源待确认';
  if (asset.sourceSnapshotAvailable === false) {
    return formatCloudImageStatusText(asset.sourceSnapshotStatus, asset.sourceSnapshotAvailable);
  }

  return asset.enabled ? '已启用' : '已禁用';
}

function canCreateInstanceFromAsset(asset: PlatformImageAsset) {
  return asset.enabled && asset.sourceSnapshotAvailable === true;
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
  return new Set(items.map((item) => item.imageId));
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
    catalogItems: scopePayload.catalogItems.filter(item => item.sourceSnapshotId !== snapshotId),
  } satisfies ImageCatalogScopePayload;
}

function ImageTagBadges({ tags }: { tags: PlatformImageTag[] }) {
  if (tags.length === 0) {
    return <span className="text-muted-foreground">-</span>;
  }

  return (
    <span className="flex min-w-0 gap-1 overflow-hidden">
      {tags.map((tag) => (
        <Badge className="max-w-32 truncate" key={tag.id} variant="outline">
          {tag.name}
        </Badge>
      ))}
    </span>
  );
}

function ImageTagsDropdown({
  asset,
  availableTags,
  canCreateTags,
  canManage,
  onCreateTag,
  onSave,
}: {
  asset: PlatformImageAsset;
  availableTags: PlatformImageTag[];
  canCreateTags: boolean;
  canManage: boolean;
  onCreateTag: (name: string) => Promise<PlatformImageTag>;
  onSave: (asset: PlatformImageAsset, tagIds: string[]) => Promise<void>;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>(asset.tags.map((tag) => tag.id));
  const [newTagName, setNewTagName] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [isCreating, setIsCreating] = useState(false);

  useEffect(() => {
    setSelectedTagIds(asset.tags.map((tag) => tag.id));
  }, [asset.id, asset.tags]);

  if (!canManage) {
    return <ImageTagBadges tags={asset.tags} />;
  }

  const hasChanges =
    selectedTagIds.length !== asset.tags.length ||
    selectedTagIds.some((tagId) => !asset.tags.some((tag) => tag.id === tagId));

  function toggleTag(tagId: string, checked: boolean) {
    setSelectedTagIds((current) =>
      checked ? (current.includes(tagId) ? current : [...current, tagId]) : current.filter((currentTagId) => currentTagId !== tagId),
    );
  }

  async function handleCreateTag() {
    const name = newTagName.trim();

    if (!name) {
      setErrorMessage('请填写标签名称。');
      return;
    }

    try {
      setErrorMessage('');
      setIsCreating(true);
      const tag = await onCreateTag(name);
      setSelectedTagIds((current) => (current.includes(tag.id) ? current : [...current, tag.id]));
      setNewTagName('');
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '镜像标签创建失败');
    } finally {
      setIsCreating(false);
    }
  }

  async function handleSave() {
    try {
      setErrorMessage('');
      setIsSaving(true);
      await onSave(asset, selectedTagIds);
      setIsOpen(false);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '镜像标签保存失败');
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <DropdownMenu onOpenChange={setIsOpen} open={isOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label={`编辑标签 ${asset.displayName}`}
          className="h-7 max-w-56 justify-between gap-2 px-2 text-left whitespace-nowrap"
          size="sm"
          type="button"
          variant="outline"
        >
          <span className="min-w-0 flex-1 overflow-hidden">
            <ImageTagBadges tags={asset.tags} />
          </span>
          <ChevronDown aria-hidden="true" className="shrink-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel>设置标签</DropdownMenuLabel>
        <div className="max-h-44 overflow-y-auto py-1">
          {availableTags.length > 0 ? (
            availableTags.map((tag) => (
              <DropdownMenuCheckboxItem
                checked={selectedTagIds.includes(tag.id)}
                disabled={isSaving || isCreating}
                key={tag.id}
                onCheckedChange={(checked) => toggleTag(tag.id, checked)}
                onSelect={(event) => event.preventDefault()}
              >
                {tag.name}
              </DropdownMenuCheckboxItem>
            ))
          ) : (
            <p className="px-2 py-1.5 text-sm text-muted-foreground">暂无可用标签。</p>
          )}
        </div>
        {canCreateTags ? (
          <>
            <DropdownMenuSeparator />
            <div className="flex gap-2 p-2" onKeyDown={(event) => event.stopPropagation()}>
              <Input
                aria-label={`新标签名称 ${asset.displayName}`}
                disabled={isSaving || isCreating}
                maxLength={32}
                onChange={(event) => {
                  setNewTagName(event.currentTarget.value);
                  setErrorMessage('');
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void handleCreateTag();
                  }
                }}
                placeholder="新建标签"
                value={newTagName}
              />
              <Button
                aria-label={`新建标签 ${asset.displayName}`}
                disabled={isSaving || isCreating}
                onClick={() => void handleCreateTag()}
                size="sm"
                type="button"
              >
                新建
              </Button>
            </div>
          </>
        ) : null}
        {errorMessage ? <p className="px-2 pb-1 text-sm text-destructive" role="alert">{errorMessage}</p> : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={!hasChanges || isSaving || isCreating}
          onSelect={(event) => {
            event.preventDefault();
            void handleSave();
          }}
        >
          保存标签
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ImageCenterDialog({
  title,
  children,
  footer,
  pending = false,
  size = 'standard',
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  pending?: boolean;
  size?: AdminDialogSize;
  onClose: () => void;
}) {
  return (
    <AdminDialog footer={footer} open pending={pending} size={size} title={title} onOpenChange={(open) => !open && onClose()}>
      {children}
    </AdminDialog>
  );
}

function CloudSourceTabs({
  activeTab,
  children,
  isCloudView,
  providerName,
  onTabChange,
}: {
  activeTab: ActiveTab;
  children: React.ReactNode;
  isCloudView: boolean;
  providerName: string;
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
        <TabsTrigger value="custom">{providerName}自定义镜像</TabsTrigger>
        <TabsTrigger value="public">{providerName}公共镜像</TabsTrigger>
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
  const current = useCloudWorkspace();
  return <CloudImageCenterScreen key={current?.workspace?.id ?? 'legacy'} apiBaseUrl={apiBaseUrl} />;
}

function CloudImageCenterScreen({
  apiBaseUrl = 'http://localhost:3001',
}: ImageCenterScreenProps) {
  const router = useRouter();
  const session = useAdminSession();
  const workspace = useCloudWorkspace()?.workspace;
  const provider = workspace?.provider ?? 'alibaba_cloud';
  const providerName = cloudProviderLabel(provider);
  const objectStorageName = provider === 'tencent_cloud' ? 'COS' : 'OSS';
  const isPageActive = useAdminRouteIsActive('/admin/image-center');
  function verifyImageSpace(items: Array<{ provider: string; accountUid?: string | null }>) {
    if (workspace?.provider === 'tencent_cloud' && (!workspace.accountUid || items.some(item => item.provider !== workspace.provider || item.accountUid !== workspace.accountUid))) {
      throw new Error('镜像返回的账号或查询范围不一致，请刷新核对。');
    }
  }
  async function checkedPlatformImages(url: string, token: string, view: 'platform' | 'mine') {
    const payload = await fetchPlatformImages(url, token, view);
    verifyImageSpace(payload.items);
    return payload;
  }
  async function checkedPublicCatalog(url: string, token: string) {
    const payload = await fetchPublicImageCatalogScope(url, token);
    verifyImageSpace([...payload.snapshots, ...payload.catalogItems]);
    return payload;
  }
  async function checkedCustomCatalog(url: string, token: string) {
    const payload = await fetchCustomImageCatalogScope(url, token);
    verifyImageSpace([...payload.snapshots, ...payload.catalogItems]);
    return payload;
  }

  const [activeTab, setActiveTab] = useState<ActiveTab>('platform');
  const [showMogong, setShowMogong] = useState(false);
  const [mogongActionHost, setMogongActionHost] = useState<HTMLDivElement | null>(null);
  const screenCache = useAdminScreenCache();
  const cachedPlatformAssets = screenCache?.read<PlatformImageAssetListPayload>(
    apiBaseUrl,
    session.token,
    'platform-images:platform',
  );
  const cachedMineAssets = screenCache?.read<ImageCenterMineSnapshot>(apiBaseUrl, session.token, 'image-center:mine');
  const cachedCustomScope = screenCache?.read<ImageCatalogScopePayload>(apiBaseUrl, session.token, 'image-center:custom');
  const cachedPublicScope = screenCache?.read<ImageCatalogScopePayload>(apiBaseUrl, session.token, 'image-center:public');
  const cachedMetadata = screenCache?.read<ImageCenterMetadata>(apiBaseUrl, session.token, 'image-center:metadata');
  const cachedActiveTab =
    activeTab === 'platform'
      ? cachedPlatformAssets
      : activeTab === 'mine'
        ? cachedMineAssets
        : activeTab === 'custom'
          ? cachedCustomScope
          : cachedPublicScope;
  const [searchName, setSearchName] = useState('');
  const [platformAssets, setPlatformAssets] = useState<PlatformImageAsset[]>(() => cachedPlatformAssets?.data.items ?? []);
  const [myAssets, setMyAssets] = useState<PlatformImageAsset[]>(() => cachedMineAssets?.data.assets ?? []);
  const [platformImageTags, setAvailablePlatformImageTags] = useState<PlatformImageTag[]>(
    () => cachedMetadata?.data.platformImageTags ?? [],
  );
  const [tagManagerOpen, setTagManagerOpen] = useState(false);
  const [deletingTag, setDeletingTag] = useState<PlatformImageTag | null>(null);
  const [tagManagerError, setTagManagerError] = useState('');
  const mountedRef = useRef(true);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);
  const [platformCreatedByFilter, setPlatformCreatedByFilter] = useState('');
  const [platformTagFilter, setPlatformTagFilter] = useState('');
  const [myTagFilter, setMyTagFilter] = useState('');
  const [publicScope, setPublicScope] = useState<ImageCatalogScopePayload | null>(() => cachedPublicScope?.data ?? null);
  const [customScope, setCustomScope] = useState<ImageCatalogScopePayload | null>(() => cachedCustomScope?.data ?? null);
  const [loadedTabs, setLoadedTabs] = useState<Record<ActiveTab, boolean>>(() => ({
    platform: Boolean(cachedPlatformAssets),
    mine: Boolean(cachedMineAssets),
    custom: Boolean(cachedCustomScope),
    public: Boolean(cachedPublicScope),
  }));
  const [tabErrors, setTabErrors] = useState<TabErrorMap>({});
  const [revalidationErrors, setRevalidationErrors] = useState<TabErrorMap>({});
  const [actionErrorMessage, setActionErrorMessage] = useState('');
  const [isLoading, setIsLoading] = useState(() => !cachedActiveTab);
  const [refreshingTabs, setRefreshingTabs] = useState<Record<ActiveTab, boolean>>({
    platform: false,
    mine: false,
    custom: false,
    public: false,
  });
  const [tableContentVersions, setTableContentVersions] = useState<Record<ActiveTab, number>>({
    platform: 0,
    mine: 0,
    custom: 0,
    public: 0,
  });
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [pendingActionKeys, setPendingActionKeys] = useState<string[]>([]);
  const [tabPages, setTabPages] = useState<TabPageMap>({ platform: 1, mine: 1, custom: 1, public: 1 });
  const [jumpPageValue, setJumpPageValue] = useState('1');
  const [renamingAsset, setRenamingAsset] = useState<PlatformImageAsset | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [confirmState, setConfirmState] = useState<ImageCenterConfirmState>(null);
  const [cloudContexts, setCloudContexts] = useState<CloudAccountContext[]>(() => cachedMetadata?.data.cloudContexts ?? []);
  const [imageImportJobs, setImageImportJobs] = useState<ImageImportJob[]>(
    () => cachedMetadata?.data.imageImportJobs ?? cachedMineAssets?.data.jobs ?? [],
  );
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
  const { pageSize, setPageSize } = useAdminPageSize();

  function beginAction(actionKey: string) {
    screenCache?.invalidate(apiBaseUrl, session.token, 'image-center:');
    screenCache?.invalidate(apiBaseUrl, session.token, 'platform-images:');
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

  function markTableContentUpdated(tab: ActiveTab) {
    setTableContentVersions((current) => ({
      ...current,
      [tab]: current[tab] + 1,
    }));
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
    if (!mountedRef.current) return;
    verifyImageSpace([nextAsset]);
    discardAssetListRequests();
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
    if (!mountedRef.current) return;
    discardAssetListRequests();
    setPlatformAssets((previous) => previous.filter((item) => item.id !== assetId));
    setMyAssets((previous) => previous.filter((item) => item.id !== assetId));
  }

  function discardAssetListRequests() {
    platformRequestVersionRef.current += 1;
    mineRequestVersionRef.current += 1;
    screenCache?.invalidate(apiBaseUrl, session.token, 'platform-images:');
    screenCache?.invalidate(apiBaseUrl, session.token, 'image-center:mine');
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

  const activeCloudContext = (workspace ? workspace.contexts : cloudContexts).find((context) => context.provider === provider && context.status === 'ready' && (workspace ? context.id === workspace.activeCloudAccountContextId && context.cloudWorkspaceId === workspace.id : context.isActive)) ?? null;
  const imageImportUnavailableMessage = !activeCloudContext
    ? `请先由管理员保存云配置并完成${providerName}账号验证。`
    : !activeCloudContext.imageImportBucket.trim() || activeCloudContext.bucketStatus === 'unconfigured'
      ? `当前${providerName}账号未配置镜像导入 Bucket，请先在云配置中填写自定义 ${objectStorageName} 存储桶名。`
      : activeCloudContext.bucketStatus !== 'ready'
        ? activeCloudContext.lastError?.trim() || '配置的镜像导入 Bucket 不可用，请检查名称、地域和权限。'
        : null;
  const canImportImages = !workspace?.isReadOnly && (!workspace || workspace.capabilities.imageImport) && imageImportUnavailableMessage === null;

  function openImageImportDialog() {
    setImageImportDraft(createImageImportDraft(provider));
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
      force?: boolean;
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
      const cachedMineSnapshot = screenCache?.read<ImageCenterMineSnapshot>(apiBaseUrl, token, 'image-center:mine');
      const snapshot =
        cachedMineSnapshot?.isFresh && !options.force
          ? cachedMineSnapshot.data
          : await (
              screenCache
                ? screenCache.load(
                    apiBaseUrl,
                    token,
                    'image-center:mine',
                    async (): Promise<ImageCenterMineSnapshot> => {
                      const [jobsPayload, myAssetsPayload] = await Promise.all([
                        fetchImageImportJobs(apiBaseUrl, token),
                        checkedPlatformImages(apiBaseUrl, token, 'mine'),
                      ]);

                      return {
                        assets: myAssetsPayload.items,
                        jobs: jobsPayload.items,
                      };
                    },
                    { force: options.force },
                  )
                : Promise.all([
                    fetchImageImportJobs(apiBaseUrl, token),
                    checkedPlatformImages(apiBaseUrl, token, 'mine'),
                  ]).then(([jobsPayload, myAssetsPayload]) => ({
                    assets: myAssetsPayload.items,
                    jobs: jobsPayload.items,
                  }))
            );

      if (
        !isActive() ||
        mineRequestVersionRef.current !== requestVersion ||
        imageImportJobsRequestVersionRef.current !== imageImportJobsRequestVersion
      ) {
        return false;
      }

      setImageImportJobs(snapshot.jobs);
      setMyAssets(snapshot.assets);
      if (!cachedMineSnapshot?.isFresh || options.force) {
        markTableContentUpdated('mine');
      }
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
    if (!isPageActive) {
      return;
    }

    if (!session.isReady || !session.token) {
      setCloudContexts([]);
      setImageImportJobs([]);
      setAvailablePlatformImageTags([]);
      return;
    }

    let isActive = true;
    const token = session.token;
    const imageImportJobsRequestVersion = imageImportJobsRequestVersionRef.current + 1;
    imageImportJobsRequestVersionRef.current = imageImportJobsRequestVersion;
    const platformImageTagsRequestVersion = platformImageTagsRequestVersionRef.current + 1;
    platformImageTagsRequestVersionRef.current = platformImageTagsRequestVersion;
    const cachedMetadata = screenCache?.read<ImageCenterMetadata>(apiBaseUrl, token, 'image-center:metadata');

    if (cachedMetadata?.isFresh) {
      setCloudContexts(cachedMetadata.data.cloudContexts);
      setImageImportJobs(cachedMetadata.data.imageImportJobs);
      setAvailablePlatformImageTags(cachedMetadata.data.platformImageTags);

      return () => {
        isActive = false;
      };
    }

    const loadMetadata = async (): Promise<ImageCenterMetadata> => {
      const [cloudContexts, imageImportJobs, platformImageTags] = await Promise.all([
        fetchCloudAccountContexts(apiBaseUrl, token),
        fetchImageImportJobs(apiBaseUrl, token),
        fetchPlatformImageTags(apiBaseUrl, token),
      ]);

      return {
        cloudContexts,
        imageImportJobs: imageImportJobs.items,
        platformImageTags: platformImageTags.items,
      };
    };
    const request = screenCache
      ? screenCache.load(apiBaseUrl, token, 'image-center:metadata', loadMetadata)
      : loadMetadata();

    request
      .then((metadata) => {
        if (!isActive) {
          return;
        }
        setCloudContexts(metadata.cloudContexts);
        if (imageImportJobsRequestVersionRef.current === imageImportJobsRequestVersion) {
          setImageImportJobs(metadata.imageImportJobs);
        }
        if (platformImageTagsRequestVersionRef.current === platformImageTagsRequestVersion) {
          setAvailablePlatformImageTags(metadata.platformImageTags);
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
  }, [apiBaseUrl, isPageActive, screenCache, session.isReady, session.token]);

  const hasImportingJobs = imageImportJobs.some((job) => job.status === 'importing');
  const hasCreatingImages = myAssets.some((asset) => /^Creating\b/i.test(asset.sourceSnapshotStatus?.trim() ?? ''));

  useEffect(() => {
    if (!isPageActive || !session.token || (!hasImportingJobs && !hasCreatingImages)) {
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
      await refreshMyAssets(token, () => isActive, { isRevalidation: true, force: true });
      refreshing = false;
    };

    void refresh();
    const interval = window.setInterval(() => void refresh(), 5_000);

    return () => {
      isActive = false;
      window.clearInterval(interval);
    };
  }, [apiBaseUrl, hasCreatingImages, hasImportingJobs, isPageActive, session.token]);

  useEffect(() => {
    if (!isPageActive || !session.isReady) {
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
      setTableContentVersions({ platform: 0, mine: 0, custom: 0, public: 0 });
      setIsLoading(false);
      return;
    }

    const cachedActiveTab = screenCache?.read(
      apiBaseUrl,
      session.token,
      activeTab === 'platform'
        ? 'platform-images:platform'
        : activeTab === 'mine'
          ? 'image-center:mine'
          : `image-center:${activeTab}`,
    );

    if (
      loadedTabs[activeTab] &&
      (!screenCache || (cachedActiveTab?.isFresh && loadAttempt === 0))
    ) {
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
    setIsLoading(!loadedTabs[activeTab]);
    clearTabError(activeTab);
    const isCurrentListRequest = () => isActive && (activeTab === 'platform'
      ? platformRequestVersionRef.current === platformRequestVersion
      : activeTab === 'custom' ? customScopeRequestVersionRef.current === customRequestVersion
        : activeTab === 'public' ? publicScopeRequestVersionRef.current === publicRequestVersion : true);

    const request =
      activeTab === 'platform'
        ? (
            screenCache
              ? screenCache.load(
                  apiBaseUrl,
                  token,
                  'platform-images:platform',
                  () => checkedPlatformImages(apiBaseUrl, token, 'platform'),
                  { force: loadAttempt > 0 },
                )
              : checkedPlatformImages(apiBaseUrl, token, 'platform')
          ).then((payload) => {
            if (!isActive || platformRequestVersionRef.current !== platformRequestVersion) {
              return;
            }

            setPlatformAssets(payload.items);
            markTableContentUpdated('platform');
          })
        : activeTab === 'mine'
          ? refreshMyAssets(token, () => isActive, { force: loadAttempt > 0 })
          : activeTab === 'custom'
            ? (
                screenCache
                  ? screenCache.load(
                      apiBaseUrl,
                      token,
                      'image-center:custom',
                      () => checkedCustomCatalog(apiBaseUrl, token),
                      { force: loadAttempt > 0 },
                    )
                  : checkedCustomCatalog(apiBaseUrl, token)
              ).then((scope) => {
                if (!isActive || customScopeRequestVersionRef.current !== customRequestVersion) {
                  return;
                }

                setCustomScope(scope);
                markTableContentUpdated('custom');
              })
            : (
                screenCache
                  ? screenCache.load(
                      apiBaseUrl,
                      token,
                      'image-center:public',
                      () => checkedPublicCatalog(apiBaseUrl, token),
                      { force: loadAttempt > 0 },
                    )
                  : checkedPublicCatalog(apiBaseUrl, token)
              ).then((scope) => {
                if (!isActive || publicScopeRequestVersionRef.current !== publicRequestVersion) {
                  return;
                }

                setPublicScope(scope);
                markTableContentUpdated('public');
              });

    request
      .then((didLoad) => {
        if (!isCurrentListRequest()) {
          return;
        }

        if (didLoad === false) {
          return;
        }

        markTabLoaded(activeTab);
        if (loadAttempt > 0) {
          setLoadAttempt(0);
        }
      })
      .catch((error) => {
        if (!isCurrentListRequest()) {
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
  }, [
    activeTab,
    apiBaseUrl,
    isPageActive,
    loadAttempt,
    loadedTabs[activeTab],
    screenCache,
    session.isReady,
    session.token,
  ]);

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
      verifyImageSpace([...nextScope.snapshots, ...nextScope.catalogItems]);

      if (publicScopeRequestVersionRef.current === requestVersion) {
        setPublicScope(nextScope);
        markTabLoaded('public');
        markTableContentUpdated('public');
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
      verifyImageSpace([...nextScope.snapshots, ...nextScope.catalogItems]);

      if (customScopeRequestVersionRef.current === requestVersion) {
        setCustomScope(nextScope);
        markTabLoaded('custom');
        markTableContentUpdated('custom');
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
    if (imageImportDraft.imageFormat !== imageFormat) {
      setImageImportErrorMessage(`所选镜像格式与文件扩展名不一致，请选择 ${imageFormat.toUpperCase()}。`);
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

    if (provider === 'tencent_cloud' && (!imageImportDraft.platform.trim() || !imageImportDraft.osVersion.trim())) {
      setImageImportErrorMessage('请填写实际操作系统发行版和版本，腾讯云会核对支持的导入系统。');
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
        ...(provider === 'tencent_cloud' ? { osVersion: imageImportDraft.osVersion.trim() } : {}),
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
      const completedJob = workspace
        ? await completeImageImport(apiBaseUrl, session.token, sessionPayload.job.id, workspace.id)
        : await completeImageImport(apiBaseUrl, session.token, sessionPayload.job.id);
      if (workspace && readCloudWorkspaceSelection() !== workspace.id) return;
      setImageImportJobs((current) => [completedJob, ...current.filter((job) => job.id !== completedJob.id)]);

      if (completedJob.status === 'failed' && !completedJob.imageId) {
        setImageImportDraft(null);
        setImageImportProgress(null);
        setActionErrorMessage(
          `${completedJob.errorMessage || `${providerName}尚未接受导入请求。`} 已保留已上传文件，请在“我的镜像”的导入任务中点击“重试导入”。`,
        );
        return;
      }

      setActiveTab('mine');
      setImageImportDraft(null);
      setImageImportProgress(null);
      setImageImportSuccessMessage(`镜像文件已上传，${providerName}正在导入；导入完成后会自动启用“我的镜像”。`);
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

  async function createPlatformImageTagForAsset(name: string) {
    if (!session.token || !session.isAdmin) {
      throw new Error('仅管理员可以新建镜像标签。');
    }

    const actionKey = 'create:platform-image-tag';

    try {
      setActionErrorMessage('');
      beginAction(actionKey);
      const tag = await createPlatformImageTag(apiBaseUrl, session.token, name);
      setAvailablePlatformImageTags((current) =>
        [...current.filter((item) => item.id !== tag.id), tag].sort((left, right) => left.name.localeCompare(right.name, 'zh-CN')),
      );
      return tag;
    } catch (error) {
      if (isUnauthorizedAdminError(error)) {
        session.logout();
      }

      setActionErrorMessage(error instanceof Error ? error.message : '镜像标签创建失败');
      throw error;
    } finally {
      endAction(actionKey);
    }
  }

  async function handleDeleteTag() {
    if (!deletingTag || !session.token || !session.isAdmin || pendingActionKeys.includes('delete:platform-image-tag')) return;
    const tagId = deletingTag.id;
    const actionKey = 'delete:platform-image-tag';
    try {
      setTagManagerError('');
      beginAction(actionKey);
      await deletePlatformImageTag(apiBaseUrl, session.token, tagId);
      if (!mountedRef.current) return;
      // Older list requests must not restore deleted tags or their asset associations.
      platformImageTagsRequestVersionRef.current += 1;
      platformRequestVersionRef.current += 1;
      mineRequestVersionRef.current += 1;
      screenCache?.invalidate(apiBaseUrl, session.token, 'image-center:');
      screenCache?.invalidate(apiBaseUrl, session.token, 'platform-images:');
      setAvailablePlatformImageTags(current => current.filter(tag => tag.id !== tagId));
      const removeTag = (assets: PlatformImageAsset[]) => assets.map(asset => ({ ...asset, tags: asset.tags.filter(tag => tag.id !== tagId) }));
      setPlatformAssets(removeTag);
      setMyAssets(removeTag);
      setPlatformTagFilter(current => current === tagId ? '' : current);
      setMyTagFilter(current => current === tagId ? '' : current);
      setDeletingTag(null);
      setLoadAttempt(current => current + 1);
    } catch (error) {
      if (!mountedRef.current) return;
      if (isUnauthorizedAdminError(error)) { session.logout(); return; }
      setTagManagerError(error instanceof Error ? error.message : '镜像标签删除失败');
    } finally {
      if (mountedRef.current) endAction(actionKey);
    }
  }

  async function savePlatformImageTags(asset: PlatformImageAsset, tagIds: string[]) {
    if (!session.token) {
      throw new Error('登录已失效。');
    }

    const actionKey = `tags:platform:${asset.id}`;

    try {
      setActionErrorMessage('');
      beginAction(actionKey);
      const nextAsset = await setPlatformImageTags(apiBaseUrl, session.token, asset.id, tagIds);
      syncAssetAcrossViews(nextAsset);
    } catch (error) {
      if (isUnauthorizedAdminError(error)) {
        session.logout();
      }

      setActionErrorMessage(error instanceof Error ? error.message : '镜像标签保存失败');
      throw error;
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

  async function handleDeleteCustomSnapshot(snapshot: ImageSnapshot, deleteOwnedSnapshots: boolean) {
    if (!session.token) {
      return;
    }

    const actionKey = `delete:custom:${snapshot.id}`;
    customScopeRequestVersionRef.current += 1;

    try {
      setActionErrorMessage('');
      beginAction(actionKey);
      await deleteCustomImageSnapshot(apiBaseUrl, session.token, snapshot.id, { deleteOwnedSnapshots });
      if (!mountedRef.current) return;
      customScopeRequestVersionRef.current += 1;
      setCustomScope((previous) => {
        const withoutImage = removeSnapshot(previous, snapshot.id);
        if (!withoutImage || !previous || deleteOwnedSnapshots || !snapshot.ownedSnapshotCleanup) return withoutImage;
        return { ...withoutImage, snapshots: previous.snapshots.map(item => item.id === snapshot.id ? { ...item, status: 'Deleted', isAvailable: false } : item) };
      });
      for (const asset of [...platformAssets, ...myAssets]) if (asset.sourceSnapshotId === snapshot.id) removeAssetFromViews(asset.id);
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
  const filteredMyAssets = myAssets.filter(
    (asset) => matchesPlatformAssetSearch(asset, searchName) && (!myTagFilter || asset.tags.some((tag) => tag.id === myTagFilter)),
  );
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

  useEffect(() => {
    setPage(activeTab, 1);
  }, [activeTab, myTagFilter, platformCreatedByFilter, platformTagFilter, searchName]);

  const activePagination = getPagination(activeItemsCount, tabPages[activeTab], pageSize);
  const visiblePages = buildVisiblePages(activePagination.totalPages, activePagination.page);

  useEffect(() => {
    if (tabPages[activeTab] !== activePagination.page) {
      setPage(activeTab, activePagination.page);
    }
  }, [activePagination.page, activeTab, tabPages]);

  useLayoutEffect(() => {
    setJumpPageValue(String(activePagination.page));
  }, [activePagination.page, activeTab]);

  function goToPreviousPage() {
    setPage(activeTab, activePagination.page - 1);
  }

  function goToNextPage() {
    setPage(activeTab, activePagination.page + 1);
  }

  function handlePageSizeChange(nextValue: 20 | 50 | 100) {
    setPageSize(nextValue);
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
      const canManageAsset = !workspace?.isReadOnly &&
        (typeof options.allowManagement === 'function' ? options.allowManagement(asset) : options.allowManagement);
      const canToggleVisibility =
        typeof options.allowVisibilityToggle === 'function'
          ? options.allowVisibilityToggle(asset)
          : options.allowVisibilityToggle ?? false;
      const canManageTags = !workspace?.isReadOnly && ((activeTab === 'platform' && session.isAdmin) || (activeTab === 'mine' && canManageAsset));
      const isImportingAsset =
        importingAssetIds.has(asset.id) ||
        importingAssetIds.has(asset.imageId) ||
        /^Creating\b/i.test(asset.sourceSnapshotStatus?.trim() ?? '');
      const canCreate = !workspace?.isReadOnly && (!workspace || workspace.capabilities.provisioning) && canCreateInstanceFromAsset(asset);
      const statusVariant = asset.sourceSnapshotAvailable !== true || !asset.enabled ? 'secondary' : 'default';

      return (
        <TableRow key={asset.id}>
          <AdminDataTableCell className="font-medium" column={nameColumn!}>
            <div className="flex min-w-48 flex-col gap-1">
              <AdminDataTableText>{asset.displayName}</AdminDataTableText>
              <span className="text-xs text-muted-foreground">
                来源：{asset.sourceScope === 'custom' ? `${providerName}自定义镜像` : `${providerName}公共镜像`}
              </span>
            </div>
          </AdminDataTableCell>
          <AdminDataTableCell className="font-mono text-xs text-muted-foreground" column={imageIdColumn!}>
            {asset.imageId}
          </AdminDataTableCell>
          <AdminDataTableCell column={createdByColumn!}>{getPlatformAssetCreator(asset)}</AdminDataTableCell>
          <AdminDataTableCell column={tagsColumn!}>
            <ImageTagsDropdown
              asset={asset}
              availableTags={platformImageTags}
              canCreateTags={session.isAdmin && activeTab === 'platform'}
              canManage={canManageTags}
              onCreateTag={createPlatformImageTagForAsset}
              onSave={savePlatformImageTags}
            />
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
                            disabled={isPending || (!asset.enabled && asset.sourceSnapshotAvailable !== true)}
                            onSelect={() =>
                              void (asset.visibility === 'platform'
                                ? handleUnpublishPlatformAsset(asset)
                                : handlePublishPlatformAsset(asset))
                            }
                          >
                            {asset.visibility === 'platform' ? '回退为私有' : '发布到平台'}
                          </DropdownMenuItem>
                        ) : null}
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
              <AdminDataTableText>{snapshot.sourceImageName}</AdminDataTableText>
              <span className="text-xs text-muted-foreground">平台：{snapshot.platform || '-'}</span>
            </div>
          </AdminDataTableCell>
          <AdminDataTableCell className="font-mono text-xs text-muted-foreground" column={imageIdColumn!}>
            {snapshot.imageId}
          </AdminDataTableCell>
          <AdminDataTableCell column={statusColumn!}>
            <Badge variant={snapshot.isAvailable ? 'default' : 'secondary'}>{snapshot.status === 'Deleted' && snapshot.ownedSnapshotCleanup ? '快照待回收' : formatImageStatus(snapshot)}</Badge>
          </AdminDataTableCell>
          <AdminDataTableCell column={actionsColumn!}>
            <div className="flex justify-start gap-1">
              {session.isAdmin && !workspace?.isReadOnly ? (
                <Button
                  disabled={isCollected || isCollectPending || !snapshot.isAvailable || isImportingSnapshot}
                  aria-label={`${isCollected ? '已收录' : '收录到平台'} ${snapshot.sourceImageName}`}
                  onClick={() => void handleCollectSnapshot(snapshot)}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  {isCollected ? '已收录' : '收录到平台'}
                </Button>
              ) : null}
              {scope === 'custom' && session.isAdmin && !workspace?.isReadOnly && !isImportingSnapshot ? (
                <Button
                  disabled={isDeletePending}
                  aria-label={`${snapshot.status === 'Deleted' && snapshot.ownedSnapshotCleanup ? '回收快照' : '删除'} ${snapshot.sourceImageName}`}
                  onClick={() => {
                    setActionErrorMessage('');
                    setConfirmState({ type: 'delete-custom', snapshot, deleteOwnedSnapshots: Boolean(snapshot.ownedSnapshotCleanup && (snapshot.status === 'Deleted' || snapshot.ownedSnapshotCleanup.status === 'deleting')) });
                  }}
                  size="sm"
                  type="button"
                  variant="destructive"
                >
                  {snapshot.status === 'Deleted' && snapshot.ownedSnapshotCleanup ? '回收快照' : '删除'}
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
          ? `${providerName}自定义镜像`
          : `${providerName}公共镜像`;
  const activeColumns = activeTab === 'platform' || activeTab === 'mine' ? ASSET_COLUMNS : CLOUD_IMAGE_COLUMNS;
  const activeTabError = tabErrors[activeTab] ?? '';
  const activeRevalidationError = revalidationErrors[activeTab] ?? '';
  const isActiveTabLoading = !loadedTabs[activeTab] && !activeTabError;
  const isRefreshing = refreshingTabs[activeTab] || (isLoading && loadedTabs[activeTab]);
  const hasActiveFilters = !!searchName || (activeTab === 'platform' && (!!platformCreatedByFilter || !!platformTagFilter)) || (activeTab === 'mine' && !!myTagFilter);
  const emptyState = hasActiveFilters
    ? {
        title: '没有匹配的镜像',
        description: activeMainView === 'cloud'
          ? '请调整名称或镜像 ID 筛选条件。'
          : activeMainView === 'mine'
            ? '请调整名称或标签筛选条件。'
            : '请调整名称、创建人或标签筛选条件。',
      }
    : activeTab === 'platform'
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
      void refreshMyAssets(session.token, () => true, { isRevalidation: true, force: true });
    }
  }

  if (!session.isReady) {
    return null;
  }

  if (!session.token) {
    return null;
  }

  return (
    <div className="admin-screen image-center-screen admin-pagination-screen">
      <section className="admin-workbench-surface admin-pagination-surface">
        <AdminPageHeader description="收录、导入和维护演练镜像资产。" title="镜像中心" />
        {imageImportSuccessMessage ? <p className="mt-4 text-sm text-emerald-700" aria-live="polite">{imageImportSuccessMessage}</p> : null}

        <div className="mt-4 flex min-h-0 flex-1 flex-col">
          <AdminListToolbar
            activeView={showMogong ? 'mogong' : activeMainView}
            compactViewAction
            onSearchChange={setSearchName}
            onViewChange={(view) => {
              if (view === 'mogong' && session.isAdmin && provider === 'alibaba_cloud') {
                setShowMogong(true);
                return;
              }
              if (view === 'platform' || view === 'mine' || view === 'cloud') {
                setShowMogong(false);
                setActiveMainView(view);
              }
            }}
            searchLabel="筛选镜像名"
            searchPlaceholder="搜索镜像名或镜像 ID"
            searchValue={searchName}
            views={[
              { label: '平台镜像', value: 'platform' },
              { label: '我的镜像', value: 'mine' },
              ...(session.isAdmin && provider === 'alibaba_cloud' ? [{ label: '墨攻镜像中心', value: 'mogong' }] : []),
              ...(session.isAdmin ? [{ label: '云上镜像来源', value: 'cloud' }] : []),
            ]}
            searchControls={
              <div className={session.isAdmin ? `${showMogong || (activeTab !== 'platform' && activeTab !== 'mine') ? 'hidden sm:block ' : ''}w-full sm:w-[22.5rem]` : 'w-full sm:w-auto'}>
                {!showMogong && activeTab === 'platform' ? (
                  <div className="grid w-full gap-2 sm:w-auto sm:grid-cols-[11rem_11rem]">
                    <AdminSelectField
                      ariaLabel="按创建人筛选"
                      className="w-full"
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
                      className="w-full"
                      emptyOptionLabel="全部标签"
                      onValueChange={(value) => {
                        setPlatformTagFilter(value);
                        setPage('platform', 1);
                      }}
                      options={platformImageTags.map((tag) => ({ label: tag.name, value: tag.id }))}
                      value={platformTagFilter}
                    />
                  </div>
                ) : !showMogong && activeTab === 'mine' ? (
                  <AdminSelectField
                    ariaLabel="按标签筛选"
                    className="w-full sm:w-44"
                    emptyOptionLabel="全部标签"
                    onValueChange={(value) => {
                      setMyTagFilter(value);
                      setPage('mine', 1);
                    }}
                    options={platformImageTags.map((tag) => ({ label: tag.name, value: tag.id }))}
                    value={myTagFilter}
                  />
                ) : undefined}
              </div>
            }
            action={
              <div className={session.isAdmin ? 'flex w-56 flex-wrap items-center gap-2' : 'flex flex-wrap items-center gap-2'}>
                {session.isAdmin ? <Button disabled={workspace?.isReadOnly || pendingActionKeys.length > 0} onClick={() => { setTagManagerError(''); setTagManagerOpen(true); }} size="sm" type="button" variant="outline">管理标签</Button> : null}
                {showMogong ? <div ref={setMogongActionHost} /> : activeTab === 'platform' || activeTab === 'mine' ? (
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
                    disabled={workspace?.isReadOnly || pendingActionKeys.includes('sync:custom')}
                    onClick={() => void handleSyncCustomImages()}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    <RefreshCw aria-hidden="true" />
                    同步镜像
                  </Button>
                ) : activeTab === 'public' && session.isAdmin ? (
                  <Button
                    disabled={workspace?.isReadOnly || pendingActionKeys.includes('sync:public')}
                    onClick={() => void handleSyncPublicImages()}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    <RefreshCw aria-hidden="true" />
                    同步公共镜像
                  </Button>
                ) : undefined}
              </div>
            }
          >
            {showMogong ? (
              <MogongImageCatalogView
                apiBaseUrl={apiBaseUrl}
                actionHost={mogongActionHost}
                token={session.token}
                search={searchName}
                readOnly={Boolean(workspace?.isReadOnly)}
                logout={session.logout}
                onCollected={syncAssetAcrossViews}
                onCloudSynced={(scope) => {
                  customScopeRequestVersionRef.current += 1;
                  screenCache?.invalidate(apiBaseUrl, session.token, 'image-center:custom');
                  setCustomScope(scope);
                  markTabLoaded('custom');
                  markTableContentUpdated('custom');
                }}
              />
            ) : <AdminPaginatedList
              className="mt-4"
              footer={
                !isActiveTabLoading && !activeTabError && activeItemsCount ? (
                  <AdminPaginationControls
                    jumpPageValue={jumpPageValue}
                    label={`${activeTabTitle} 分页`}
                    pageSize={pageSize}
                    pagination={activePagination}
                    visiblePages={visiblePages}
                    onJumpPage={handleJumpToPage}
                    onJumpPageValueChange={setJumpPageValue}
                    onNextPage={goToNextPage}
                    onPageSelect={(pageNumber) => setPage(activeTab, pageNumber)}
                    onPageSizeChange={handlePageSizeChange}
                    onPreviousPage={goToPreviousPage}
                  />
                ) : null
              }
            >
              <CloudSourceTabs
                providerName={providerName}
                activeTab={activeTab}
                isCloudView={activeMainView === 'cloud'}
                onTabChange={setActiveTab}
              >
                <div className="space-y-4">
                  {activeTab === 'mine' && visibleImageImportJobs.length > 0 ? (
                    <div className="image-import-job-list" aria-live="polite">
                      {visibleImageImportJobs.slice(0, 3).map((job) => (
                        <div key={job.id} className={`image-import-job image-import-job--${job.status}`}>
                          <strong>{job.displayName}</strong>
                          <span>{job.status === 'available' && job.errorMessage ? '临时文件清理重试中' : formatImportStatus(job.status)}</span>
                          {job.errorMessage ? <p role="alert">{job.errorMessage}</p> : null}
                          {job.status === 'failed' && !job.imageId ? (
                            <Button
                              disabled={workspace?.isReadOnly || pendingActionKeys.includes(`retry:image-import:${job.id}`)}
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
                    <AdminDataTable
                      columns={activeColumns}
                      contentVersion={tableContentVersions[activeTab]}
                      isRefreshing={isRefreshing}
                      label={activeTabTitle}
                    >
                      {(columns) => {
                        const actionErrorRow = actionErrorMessage ? (
                          <TableRow className="hover:bg-transparent">
                            <TableCell className="px-3 py-3 text-sm text-destructive whitespace-normal" colSpan={columns.length}>
                              <p role="alert">{actionErrorMessage}</p>
                            </TableCell>
                          </TableRow>
                        ) : null;
                        const revalidationErrorRow = activeRevalidationError ? (
                          <AdminDataTableRevalidationNotice
                            columns={columns}
                            description={activeRevalidationError}
                            onRetry={activeTab === 'mine' ? () => retryRevalidation('mine') : undefined}
                            retryAriaLabel={activeTab === 'mine' ? '重试加载我的镜像' : undefined}
                          />
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

                </div>
              </CloudSourceTabs>
            </AdminPaginatedList>}
          </AdminListToolbar>
        </div>

          {tagManagerOpen && session.isAdmin ? (
            <AdminDialog
              open
              title={deletingTag ? '确认删除镜像标签' : '管理镜像标签'}
              description={deletingTag ? `删除“${deletingTag.name}”及当前账号下所有镜像的此标签关联，镜像和云资源会保留。` : undefined}
              pending={pendingActionKeys.includes('delete:platform-image-tag')}
              onOpenChange={(open) => { if (!open) { setTagManagerOpen(false); setDeletingTag(null); setTagManagerError(''); } }}
              footer={deletingTag ? <>
                <Button disabled={pendingActionKeys.includes('delete:platform-image-tag')} onClick={() => { setDeletingTag(null); setTagManagerError(''); }} type="button" variant="outline">取消</Button>
                <Button disabled={pendingActionKeys.includes('delete:platform-image-tag')} onClick={() => void handleDeleteTag()} type="button" variant="destructive">确认删除标签</Button>
              </> : undefined}
            >
              {tagManagerError ? <p role="alert" className="text-sm text-destructive">{tagManagerError}</p> : null}
              {!deletingTag ? <ul className="max-h-80 divide-y overflow-y-auto">
                {platformImageTags.map(tag => <li className="flex min-w-0 items-center justify-between gap-3 py-2" key={tag.id}>
                  <span className="min-w-0 break-words">{tag.name}</span>
                  <Button aria-label={`删除标签 ${tag.name}`} onClick={() => { setTagManagerError(''); setDeletingTag(tag); }} size="sm" type="button" variant="destructive">删除</Button>
                </li>)}
                {platformImageTags.length === 0 ? <li className="py-4 text-sm text-muted-foreground">暂无镜像标签</li> : null}
              </ul> : null}
            </AdminDialog>
          ) : null}

          {imageImportDraft ? (
            <ImageCenterDialog
              footer={
                <>
                  <Button disabled={pendingActionKeys.includes('create:image-import')} type="button" variant="outline" onClick={closeImageImportDialog}>
                    取消
                  </Button>
                  <Button
                    disabled={pendingActionKeys.includes('create:image-import') || !canImportImages}
                    form="image-import-form"
                    type="submit"
                  >
                    {pendingActionKeys.includes('create:image-import') ? '正在处理…' : '上传并导入'}
                  </Button>
                </>
              }
              pending={pendingActionKeys.includes('create:image-import')}
              title="上传本地镜像"
              onClose={closeImageImportDialog}
            >
              <form
                className="grid gap-3"
                id="image-import-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void handleSubmitImageImport();
                }}
              >
                <p className="image-import-dialog-copy">
                  文件会直接上传到当前云账号的私有 {objectStorageName} Bucket，再由{providerName}导入为自定义镜像。主机名和密码会作为后续创建实例的默认值，不会修改原始镜像文件。
                </p>
                <fieldset className="grid gap-4 border-0 p-0" disabled={pendingActionKeys.includes('create:image-import')}>
                  <div className="grid gap-1.5">
                    <Label htmlFor="image-import-file">系统盘镜像文件</Label>
                    <Input
                      autoFocus
                      aria-label="系统盘镜像文件"
                      className="h-auto py-2"
                      id="image-import-file"
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
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="image-import-name">镜像名</Label>
                    <Input aria-label="上传镜像名" id="image-import-name" value={imageImportDraft.displayName} onChange={(event) => updateImageImportDraft({ displayName: event.target.value })} required />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="image-import-host-name">默认主机名</Label>
                    <Input aria-label="上传镜像默认主机名" id="image-import-host-name" value={imageImportDraft.defaultHostName} onChange={(event) => updateImageImportDraft({ defaultHostName: event.target.value })} placeholder="可选，创建实例时使用" />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="image-import-password">默认登录密码</Label>
                    <Input aria-label="上传镜像默认登录密码" id="image-import-password" type="password" value={imageImportDraft.defaultPassword} onChange={(event) => updateImageImportDraft({ defaultPassword: event.target.value })} autoComplete="new-password" placeholder="可选，保存后不再回显" />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="image-import-description">备注</Label>
                    <Input aria-label="上传镜像备注" id="image-import-description" value={imageImportDraft.description} onChange={(event) => updateImageImportDraft({ description: event.target.value })} placeholder="镜像用途或来源说明" />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="image-import-os-type">操作系统</Label>
                    <AdminSelectField
                      ariaLabel="上传镜像操作系统"
                      className="w-full"
                      id="image-import-os-type"
                      onValueChange={(value) =>
                        updateImageImportDraft({ osType: value as ImageImportDialogDraft['osType'] })
                      }
                      options={[
                        { label: 'Linux', value: 'linux' },
                        { label: 'Windows', value: 'windows' },
                      ]}
                      value={imageImportDraft.osType}
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="image-import-platform">{provider === 'tencent_cloud' ? '操作系统发行版' : '系统版本 / 平台'}</Label>
                    <Input aria-label="上传镜像系统版本" id="image-import-platform" value={imageImportDraft.platform} onChange={(event) => updateImageImportDraft({ platform: event.target.value })} placeholder={provider === 'tencent_cloud' ? '例如 Ubuntu' : '例如 Ubuntu 22.04'} required={provider === 'tencent_cloud'} />
                  </div>
                  {provider === 'tencent_cloud' ? <div className="grid gap-1.5">
                    <Label htmlFor="image-import-os-version">操作系统版本</Label>
                    <Input aria-label="上传镜像操作系统版本" id="image-import-os-version" value={imageImportDraft.osVersion} onChange={(event) => updateImageImportDraft({ osVersion: event.target.value })} placeholder="填写镜像实际系统版本" required />
                    <p className="text-sm text-muted-foreground">发行版和版本须与镜像一致，提交后由腾讯云核验支持矩阵。</p>
                  </div> : null}
                  <div className="grid gap-1.5">
                    <Label htmlFor="image-import-architecture">架构</Label>
                    <AdminSelectField
                      ariaLabel="上传镜像架构"
                      className="w-full"
                      id="image-import-architecture"
                      onValueChange={(value) =>
                        updateImageImportDraft({ architecture: value as ImageImportDialogDraft['architecture'] })
                      }
                      options={[
                        { label: 'x86_64', value: 'x86_64' },
                        { label: 'arm64', value: 'arm64' },
                      ]}
                      value={imageImportDraft.architecture}
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="image-import-boot-mode">启动模式</Label>
                    <AdminSelectField
                      ariaLabel="上传镜像启动模式"
                      className="w-full"
                      id="image-import-boot-mode"
                      onValueChange={(value) =>
                        updateImageImportDraft({ bootMode: value as ImageImportDialogDraft['bootMode'] })
                      }
                      options={[
                        { label: 'BIOS', value: 'BIOS' },
                        { label: 'UEFI', value: 'UEFI' },
                      ]}
                      value={imageImportDraft.bootMode}
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="image-import-format">镜像格式</Label>
                    <AdminSelectField
                      ariaLabel="上传镜像格式"
                      className="w-full"
                      id="image-import-format"
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
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="image-import-system-disk-size">系统盘大小（GiB）</Label>
                    <Input aria-label="上传镜像系统盘大小" id="image-import-system-disk-size" type="number" min="1" max="2048" value={imageImportDraft.systemDiskSize} onChange={(event) => updateImageImportDraft({ systemDiskSize: event.target.value })} required />
                  </div>
                </fieldset>
                {imageImportProgress !== null ? (
                  <div className="image-import-progress" aria-live="polite">
                    <span>{imageImportProgress < 100 ? `正在上传到 ${objectStorageName}：${imageImportProgress}%` : `文件上传完成，正在提交${providerName}导入任务…`}</span>
                    <progress value={imageImportProgress} max="100">{imageImportProgress}%</progress>
                  </div>
                ) : null}
                {imageImportErrorMessage ? <p className="admin-error image-import-dialog-error" role="alert">{imageImportErrorMessage}</p> : null}
              </form>
            </ImageCenterDialog>
          ) : null}

          {renamingAsset ? (
            <ImageCenterDialog
              footer={
                <>
                  <Button disabled={pendingActionKeys.includes(`rename:platform:${renamingAsset.id}`)} type="button" variant="outline" onClick={closeRenameDialog}>
                    取消编辑
                  </Button>
                  <Button disabled={pendingActionKeys.includes(`rename:platform:${renamingAsset.id}`)} type="button" onClick={() => void handleRenamePlatformAsset()}>
                    保存信息
                  </Button>
                </>
              }
              pending={pendingActionKeys.includes(`rename:platform:${renamingAsset.id}`)}
              title="编辑镜像名称"
              onClose={closeRenameDialog}
            >
              <div className="grid gap-3">
                <div className="grid gap-1.5">
                  <Label htmlFor="rename-platform-image">镜像名</Label>
                  <Input aria-label="镜像名" autoFocus id="rename-platform-image" value={renameDraft} onChange={(event) => setRenameDraft(event.target.value)} />
                </div>
              </div>
            </ImageCenterDialog>
          ) : null}

          {confirmState?.type === 'remove-platform' ? (
            <AdminConfirmationDialog
              confirmLabel="确认删除"
              description={`删除“${confirmState.asset.displayName}”后会将其移出平台收录目录，但不会删除${providerName}上的原始镜像。`}
              open
              pending={pendingActionKeys.includes(`remove:platform:${confirmState.asset.id}`)}
              title="确认删除镜像"
              onConfirm={() => void handleRemovePlatformAsset(confirmState.asset)}
              onOpenChange={(open) => !open && closeConfirmDialog()}
            />
          ) : null}

          {confirmState?.type === 'delete-custom' ? (
            <AdminDialog
              description={`镜像：${confirmState.snapshot.sourceImageName}（${confirmState.snapshot.imageId}）。${confirmState.snapshot.status === 'Deleted' ? '云镜像已删除，所属快照仍需单独回收。' : '删除后无法再使用该镜像创建实例。'}`}
              open
              pending={pendingActionKeys.includes(`delete:custom:${confirmState.snapshot.id}`)}
              size="compact"
              title={confirmState.snapshot.status === 'Deleted' ? '回收所属快照' : `确认删除${providerName}自定义镜像`}
              onOpenChange={(open) => !open && closeConfirmDialog()}
              footer={<>
                <Button disabled={pendingActionKeys.includes(`delete:custom:${confirmState.snapshot.id}`)} type="button" variant="outline" onClick={closeConfirmDialog}>取消</Button>
                <Button disabled={pendingActionKeys.includes(`delete:custom:${confirmState.snapshot.id}`)} type="button" variant="destructive" onClick={() => void handleDeleteCustomSnapshot(confirmState.snapshot, confirmState.deleteOwnedSnapshots)}>
                  {confirmState.deleteOwnedSnapshots ? (confirmState.snapshot.status === 'Deleted' ? '确认回收快照' : '确认回收镜像及快照') : '确认删除'}
                </Button>
              </>}
            >
              <fieldset className="grid gap-3 text-sm" disabled={pendingActionKeys.includes(`delete:custom:${confirmState.snapshot.id}`)}>
                <legend className="mb-2 font-medium">删除范围</legend>
                <RadioGroup aria-label="删除范围" disabled={pendingActionKeys.includes(`delete:custom:${confirmState.snapshot.id}`)} name="custom-image-delete-scope" value={confirmState.deleteOwnedSnapshots ? 'snapshots' : 'image'} onValueChange={(value) => setConfirmState({ ...confirmState, deleteOwnedSnapshots: value === 'snapshots' })}>
                {confirmState.snapshot.status !== 'Deleted' && confirmState.snapshot.ownedSnapshotCleanup?.status !== 'deleting' ? <label className="flex items-start gap-2">
                  <RadioGroupItem value="image" />
                  <span>仅删除镜像<span className="mt-1 block text-xs text-muted-foreground">保留关联快照，快照存储费用继续产生。</span></span>
                </label> : null}
                {confirmState.snapshot.ownedSnapshotCleanup ? <label className="flex items-start gap-2">
                  <RadioGroupItem value="snapshots" />
                  <span>{confirmState.snapshot.status === 'Deleted' ? '回收所属快照' : '同时清理所属快照'}<span className="mt-1 block text-xs text-muted-foreground">{confirmState.snapshot.ownedSnapshotCleanup.snapshotCount} 个待回收。仅清理本平台打包生成且无其它引用的快照；回收后无法恢复。</span></span>
                </label> : <p className="text-xs text-muted-foreground">该镜像缺少可核验的打包快照来源，平台不会自动删除其快照。</p>}
                </RadioGroup>
              </fieldset>
              {actionErrorMessage ? <p className="mt-3 text-sm text-destructive" role="alert">{actionErrorMessage}</p> : null}
            </AdminDialog>
          ) : null}
      </section>
    </div>
  );
}
