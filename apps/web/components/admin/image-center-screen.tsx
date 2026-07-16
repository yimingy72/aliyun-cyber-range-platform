'use client';

import React from 'react';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

import {
  collectPlatformImage,
  deleteCustomImageSnapshot,
  disablePlatformImage,
  enablePlatformImage,
  fetchCustomImageCatalogScope,
  fetchPlatformImages,
  fetchPublicImageCatalogScope,
  publishPlatformImage,
  removePlatformImage,
  renamePlatformImage,
  syncCustomImages,
  syncPublicImages,
  unpublishPlatformImage,
} from '../../lib/admin-api';
import { isUnauthorizedAdminError } from '../../lib/admin-screen';
import type {
  ImageCatalogScopePayload,
  ImageSnapshot,
  PlatformImageAsset,
} from '../../lib/admin-types';
import {
  AdminPaginationControls,
  buildVisiblePages,
  getPagination,
  PAGE_SIZE_AUTO,
  useAdminPageSize,
} from './admin-pagination';
import { useAdminSession } from './use-admin-session';

type ImageCenterScreenProps = {
  apiBaseUrl?: string;
};

type ActiveTab = 'platform' | 'mine' | 'custom' | 'public';
type TabPageMap = Record<ActiveTab, number>;
type ImageCenterConfirmState =
  | { type: 'remove-platform'; asset: PlatformImageAsset }
  | { type: 'delete-custom'; snapshot: ImageSnapshot }
  | null;
type ActionMenuPlacement = 'down' | 'up';

const ACTION_MENU_VERTICAL_OFFSET_PX = 8;
const ACTION_MENU_ESTIMATED_HEIGHT_PX = 132;

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
    return creatingMatch[1] ? `导出中 ${creatingMatch[1]}` : '导出中';
  }

  if (/CreateFailed/i.test(normalizedStatus)) {
    return '导出失败';
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

function getAssetStatusTone(asset: PlatformImageAsset) {
  if (asset.sourceSnapshotAvailable === false) {
    return 'is-draft';
  }

  return asset.enabled ? 'is-published' : 'is-draft';
}

function canCreateInstanceFromAsset(asset: PlatformImageAsset) {
  return asset.enabled && asset.sourceSnapshotAvailable !== false;
}

function resolveActionMenuPlacement(triggerElement: HTMLElement): ActionMenuPlacement {
  const triggerRect = triggerElement.getBoundingClientRect();
  const containerRect =
    triggerElement.closest('.image-center-list')?.getBoundingClientRect() ??
    triggerElement.closest('.admin-main-content')?.getBoundingClientRect();
  const availableBelow = (containerRect?.bottom ?? window.innerHeight) - triggerRect.bottom;

  return availableBelow < ACTION_MENU_ESTIMATED_HEIGHT_PX + ACTION_MENU_VERTICAL_OFFSET_PX ? 'up' : 'down';
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

export function ImageCenterScreen({
  apiBaseUrl = 'http://localhost:3001',
}: ImageCenterScreenProps) {
  const router = useRouter();
  const session = useAdminSession();
  const [activeTab, setActiveTab] = useState<ActiveTab>('platform');
  const [searchName, setSearchName] = useState('');
  const [platformAssets, setPlatformAssets] = useState<PlatformImageAsset[]>([]);
  const [myAssets, setMyAssets] = useState<PlatformImageAsset[]>([]);
  const [publicScope, setPublicScope] = useState<ImageCatalogScopePayload | null>(null);
  const [customScope, setCustomScope] = useState<ImageCatalogScopePayload | null>(null);
  const [loadedTabs, setLoadedTabs] = useState<Record<ActiveTab, boolean>>({
    platform: false,
    mine: false,
    custom: false,
    public: false,
  });
  const [errorMessage, setErrorMessage] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [pendingActionKeys, setPendingActionKeys] = useState<string[]>([]);
  const [tabPages, setTabPages] = useState<TabPageMap>({ platform: 1, mine: 1, custom: 1, public: 1 });
  const [jumpPageValue, setJumpPageValue] = useState('1');
  const [renamingAsset, setRenamingAsset] = useState<PlatformImageAsset | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [confirmState, setConfirmState] = useState<ImageCenterConfirmState>(null);
  const [menuAssetId, setMenuAssetId] = useState<string | null>(null);
  const [menuPlacement, setMenuPlacement] = useState<ActionMenuPlacement>('down');
  const platformRequestVersionRef = useRef(0);
  const mineRequestVersionRef = useRef(0);
  const publicScopeRequestVersionRef = useRef(0);
  const customScopeRequestVersionRef = useRef(0);
  const { pageSizeMode, pageSize, setPageSizeMode, setPageSize } = useAdminPageSize();

  function beginAction(actionKey: string) {
    setPendingActionKeys((previous) => (previous.includes(actionKey) ? previous : [...previous, actionKey]));
  }

  function endAction(actionKey: string) {
    setPendingActionKeys((previous) => previous.filter((item) => item !== actionKey));
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
        : nextAsset.ownerUserId === session.profile?.id
          ? upsertPlatformAsset(previous, nextAsset)
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

  useEffect(() => {
    if (!session.isReady) {
      return;
    }

    if (!session.token) {
      setPlatformAssets([]);
      setMyAssets([]);
      setPublicScope(null);
      setCustomScope(null);
      setLoadedTabs({ platform: false, mine: false, custom: false, public: false });
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
    setErrorMessage('');

    const request =
      activeTab === 'platform'
        ? fetchPlatformImages(apiBaseUrl, token, 'platform').then((payload) => {
            if (!isActive || platformRequestVersionRef.current !== platformRequestVersion) {
              return;
            }

            setPlatformAssets(payload.items);
          })
        : activeTab === 'mine'
          ? fetchPlatformImages(apiBaseUrl, token, 'mine').then((payload) => {
              if (!isActive || mineRequestVersionRef.current !== mineRequestVersion) {
                return;
              }

              setMyAssets(payload.items);
            })
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
      .then(() => {
        if (!isActive) {
          return;
        }

        setLoadedTabs((current) => ({
          ...current,
          [activeTab]: true,
        }));
      })
      .catch((error) => {
        if (!isActive) {
          return;
        }

        if (isUnauthorizedAdminError(error)) {
          session.logout();
          return;
        }

        setErrorMessage(error instanceof Error ? error.message : '镜像中心加载失败');
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
  }, [activeTab, apiBaseUrl, loadedTabs[activeTab], session.isReady, session.token]);

  async function handleSyncPublicImages() {
    if (!session.token) {
      return;
    }

    const actionKey = 'sync:public';
    const requestVersion = publicScopeRequestVersionRef.current + 1;
    publicScopeRequestVersionRef.current = requestVersion;

    try {
      setErrorMessage('');
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

      setErrorMessage(error instanceof Error ? error.message : '公共镜像同步失败');
    } finally {
      endAction(actionKey);
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
      setErrorMessage('');
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

      setErrorMessage(error instanceof Error ? error.message : '自定义镜像同步失败');
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
      setErrorMessage('');
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

      setErrorMessage(error instanceof Error ? error.message : '镜像收录失败');
    } finally {
      endAction(actionKey);
    }
  }

  function openRenameDialog(asset: PlatformImageAsset) {
    setMenuAssetId(null);
    setMenuPlacement('down');
    setRenamingAsset(asset);
    setRenameDraft(asset.displayName);
  }

  function closeRenameDialog() {
    setRenamingAsset(null);
    setRenameDraft('');
  }

  function closeConfirmDialog() {
    setConfirmState(null);
  }

  function toggleActionMenu(assetId: string, triggerElement: HTMLElement) {
    if (menuAssetId === assetId) {
      setMenuAssetId(null);
      setMenuPlacement('down');
      return;
    }

    setMenuAssetId(assetId);
    setMenuPlacement(resolveActionMenuPlacement(triggerElement));
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
      setErrorMessage('');
      beginAction(actionKey);
      const nextAsset = await renamePlatformImage(apiBaseUrl, session.token, renamingAsset.id, nextDisplayName);
      syncAssetAcrossViews(nextAsset);
      closeRenameDialog();
    } catch (error) {
      if (isUnauthorizedAdminError(error)) {
        session.logout();
        return;
      }

      setErrorMessage(error instanceof Error ? error.message : '平台镜像重命名失败');
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
      setErrorMessage('');
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

      setErrorMessage(error instanceof Error ? error.message : '平台镜像状态更新失败');
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
      setErrorMessage('');
      beginAction(actionKey);
      const nextAsset = await publishPlatformImage(apiBaseUrl, session.token, asset.id);
      syncAssetAcrossViews(nextAsset);
    } catch (error) {
      if (isUnauthorizedAdminError(error)) {
        session.logout();
        return;
      }

      setErrorMessage(error instanceof Error ? error.message : '镜像发布失败');
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
      setErrorMessage('');
      beginAction(actionKey);
      const nextAsset = await unpublishPlatformImage(apiBaseUrl, session.token, asset.id);
      syncAssetAcrossViews(nextAsset);
    } catch (error) {
      if (isUnauthorizedAdminError(error)) {
        session.logout();
        return;
      }

      setErrorMessage(error instanceof Error ? error.message : '镜像已回退为私有失败');
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
      setErrorMessage('');
      beginAction(actionKey);
      await removePlatformImage(apiBaseUrl, session.token, asset.id);
      removeAssetFromViews(asset.id);
      closeConfirmDialog();
    } catch (error) {
      if (isUnauthorizedAdminError(error)) {
        session.logout();
        return;
      }

      setErrorMessage(error instanceof Error ? error.message : '平台镜像删除失败');
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
      setErrorMessage('');
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

      setErrorMessage(error instanceof Error ? error.message : '云上镜像删除失败');
    } finally {
      endAction(actionKey);
    }
  }

  const filteredPlatformAssets = platformAssets.filter((asset) => matchesPlatformAssetSearch(asset, searchName));
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

  function renderAssetRows(
    items: PlatformImageAsset[],
    options: {
      emptyMessage: string;
      allowManagement: boolean | ((asset: PlatformImageAsset) => boolean);
      allowVisibilityToggle?: boolean | ((asset: PlatformImageAsset) => boolean);
      compactActions?: boolean;
    },
  ) {
    if (items.length === 0) {
      return <div className="template-workbench-empty image-center-empty-state">{options.emptyMessage}</div>;
    }

    return items.map((asset) => {
      const menuOpen = menuAssetId === asset.id;
      const renameActionKey = `rename:platform:${asset.id}`;
      const toggleActionKey = `${asset.enabled ? 'disable' : 'enable'}:platform:${asset.id}`;
      const visibilityActionKey = `${asset.visibility === 'platform' ? 'unpublish' : 'publish'}:platform:${asset.id}`;
      const removeActionKey = `remove:platform:${asset.id}`;
      const isPending = [renameActionKey, toggleActionKey, visibilityActionKey, removeActionKey].some((key) =>
        pendingActionKeys.includes(key),
      );
      const canManageAsset =
        typeof options.allowManagement === 'function' ? options.allowManagement(asset) : options.allowManagement;
      const canToggleVisibility =
        typeof options.allowVisibilityToggle === 'function'
          ? options.allowVisibilityToggle(asset)
          : options.allowVisibilityToggle ?? false;
      const canCreate = canCreateInstanceFromAsset(asset);
      const showCompactActions = options.compactActions && canManageAsset;

      return (
        <article
          key={asset.id}
          aria-label={`${asset.displayName} ${asset.imageId}`}
          className={`range-workbench-row image-center-row${menuOpen ? ' is-menu-open' : ''}`}
        >
          <div className="range-workbench-main image-center-main-cell">
            <strong>{asset.displayName}</strong>
            <span className="image-center-row-meta">来源：{asset.sourceScope === 'custom' ? '阿里云自定义镜像' : '阿里云公共镜像'}</span>
          </div>
          <div className="range-workbench-created-at image-center-secondary-cell">
            <span>{asset.imageId}</span>
          </div>
          <div className="range-workbench-created-at image-center-secondary-cell">
            <span>{asset.createdBy?.trim() || 'admin'}</span>
          </div>
          <div className="range-workbench-status-cell image-center-status-cell">
            <span className={`template-workbench-status-pill ${getAssetStatusTone(asset)}`}>
              {formatAssetStatus(asset)}
            </span>
          </div>
          <div className={`range-workbench-actions image-center-actions-cell${showCompactActions ? ' image-center-actions-cell-compact' : ''}`}>
            {canCreate ? (
              <button
                type="button"
                aria-label={`创建实例 ${asset.displayName}`}
                onClick={() => handleCreateInstance(asset)}
              >
                创建实例
              </button>
            ) : null}
            {canManageAsset ? (
              <>
                {canToggleVisibility ? (
                  <button
                    type="button"
                    disabled={isPending || asset.sourceSnapshotAvailable === false}
                    aria-label={`${asset.visibility === 'platform' ? '回退为私有' : '发布到平台'} ${asset.displayName}`}
                    onClick={() =>
                      void (asset.visibility === 'platform'
                        ? handleUnpublishPlatformAsset(asset)
                        : handlePublishPlatformAsset(asset))
                    }
                  >
                    {asset.visibility === 'platform' ? '回退为私有' : '发布到平台'}
                  </button>
                ) : null}
                {showCompactActions ? (
                  <div className="template-workbench-row-menu">
                    <button
                      type="button"
                      className="template-workbench-secondary-action"
                      aria-expanded={menuOpen}
                      disabled={isPending}
                      onClick={(event) => toggleActionMenu(asset.id, event.currentTarget)}
                    >
                      更多操作
                    </button>

                    {menuOpen ? (
                      <div className={`template-workbench-action-menu${menuPlacement === 'up' ? ' is-upward' : ''}`}>
                        <button type="button" disabled={isPending} onClick={() => openRenameDialog(asset)}>
                          重命名
                        </button>
                        <button
                          type="button"
                          disabled={isPending}
                          onClick={() => {
                            setMenuAssetId(null);
                            setMenuPlacement('down');
                            void handleTogglePlatformAsset(asset);
                          }}
                        >
                          {asset.enabled ? '禁用' : '启用'}
                        </button>
                        <button
                          type="button"
                          disabled={isPending}
                          onClick={() => {
                            setMenuAssetId(null);
                            setMenuPlacement('down');
                            setConfirmState({ type: 'remove-platform', asset });
                          }}
                        >
                          删除
                        </button>
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <>
                    <button type="button" disabled={isPending} aria-label={`重命名 ${asset.displayName}`} onClick={() => openRenameDialog(asset)}>
                      重命名
                    </button>
                    <button
                      type="button"
                      disabled={isPending}
                      aria-label={`${asset.enabled ? '禁用' : '启用'} ${asset.displayName}`}
                      onClick={() => void handleTogglePlatformAsset(asset)}
                    >
                      {asset.enabled ? '禁用' : '启用'}
                    </button>
                    <button
                      type="button"
                      disabled={isPending}
                      aria-label={`删除 ${asset.displayName}`}
                      onClick={() => setConfirmState({ type: 'remove-platform', asset })}
                    >
                      删除
                    </button>
                  </>
                )}
              </>
            ) : null}
          </div>
        </article>
      );
    });
  }

  function renderScopeRows(scope: 'custom' | 'public', snapshots: ImageSnapshot[]) {
    if (snapshots.length === 0) {
      return <div className="template-workbench-empty image-center-empty-state">当前没有可展示的云镜像。</div>;
    }

    return snapshots.map((snapshot) => {
      const isCollected = collectedImageIds.has(snapshot.imageId);
      const collectActionKey = `collect:${snapshot.scope}:${snapshot.imageId}`;
      const deleteActionKey = `delete:custom:${snapshot.id}`;
      const isCollectPending = pendingActionKeys.includes(collectActionKey);
      const isDeletePending = pendingActionKeys.includes(deleteActionKey);

      return (
        <article
          key={snapshot.id}
          aria-label={`${snapshot.sourceImageName} ${snapshot.imageId}`}
          className="range-workbench-row image-center-row"
        >
          <div className="range-workbench-main image-center-main-cell">
            <strong>{snapshot.sourceImageName}</strong>
            <span className="image-center-row-meta">平台：{snapshot.platform || '-'}</span>
          </div>
          <div className="range-workbench-created-at image-center-secondary-cell">
            <span>{snapshot.imageId}</span>
          </div>
          <div className="range-workbench-status-cell image-center-status-cell image-center-status-text">
            <span>{formatImageStatus(snapshot)}</span>
          </div>
          <div className="range-workbench-actions image-center-actions-cell">
            {session.isAdmin ? (
              <button
                type="button"
                disabled={isCollected || isCollectPending}
                aria-label={`${isCollected ? '已收录' : '收录到平台'} ${snapshot.sourceImageName}`}
                onClick={() => void handleCollectSnapshot(snapshot)}
              >
                {isCollected ? '已收录' : '收录到平台'}
              </button>
            ) : null}
            {scope === 'custom' && session.isAdmin ? (
              <button
                type="button"
                disabled={isDeletePending}
                aria-label={`删除 ${snapshot.sourceImageName}`}
                onClick={() => setConfirmState({ type: 'delete-custom', snapshot })}
              >
                删除
              </button>
            ) : null}
          </div>
        </article>
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
        : '云上镜像来源';

  if (!session.isReady) {
    return null;
  }

  if (!session.token) {
    return null;
  }

  const isBootstrapLoading = isLoading && !loadedTabs[activeTab];

  return (
    <div className="admin-screen admin-workbench-screen image-center-screen">
      {errorMessage ? <p className="admin-error">{errorMessage}</p> : null}

      <section>
        <article className="admin-workbench-panel range-workbench-shell">
          <div className="template-workbench-list-header range-workbench-header">
            <div className="template-workbench-list-header-copy">
              <h2>镜像中心</h2>
            </div>
          </div>

          <div className="template-workbench-controls range-workbench-controls image-center-controls">
            <div className="template-workbench-search-grid">
              <label className="template-workbench-search-field">
                <span className="sr-only">镜像名搜索</span>
                <input
                  aria-label="筛选镜像名"
                  value={searchName}
                  onChange={(event) => setSearchName(event.target.value)}
                  placeholder="搜索镜像名或镜像 ID"
                />
              </label>
            </div>

            <div className="template-workbench-segmented range-workbench-segmented image-center-tabs" role="tablist" aria-label="镜像中心视图切换">
              <button type="button" aria-pressed={activeMainView === 'platform'} onClick={() => setActiveMainView('platform')}>
                平台镜像
              </button>
              <button type="button" aria-pressed={activeMainView === 'mine'} onClick={() => setActiveMainView('mine')}>
                我的镜像
              </button>
              {session.isAdmin ? (
                <button type="button" aria-pressed={activeMainView === 'cloud'} onClick={() => setActiveMainView('cloud')}>
                  云上镜像来源
                </button>
              ) : null}
            </div>
          </div>

          <div className={`template-workbench-list image-center-list image-center-list--${activeTab}`}>
          <div className="template-workbench-list-header">
            <div className="template-workbench-list-header-copy">
              <h2>{activeTabTitle}</h2>
            </div>

            <div className="template-workbench-list-header-meta image-center-list-meta">
              <span>{activeItemsCount} 条记录</span>
              {activeMainView === 'cloud' ? (
                <div className="template-workbench-segmented image-center-tabs" role="tablist" aria-label="云上镜像来源切换">
                  <button type="button" aria-pressed={activeTab === 'custom'} onClick={() => setActiveTab('custom')}>
                    阿里云自定义镜像
                  </button>
                  <button type="button" aria-pressed={activeTab === 'public'} onClick={() => setActiveTab('public')}>
                    阿里云公共镜像
                  </button>
                </div>
              ) : null}
              {activeTab === 'custom' && session.isAdmin ? (
                <button type="button" disabled={pendingActionKeys.includes('sync:custom')} onClick={() => void handleSyncCustomImages()}>
                  同步自定义镜像
                </button>
              ) : null}
              {activeTab === 'public' && session.isAdmin ? (
                <button type="button" disabled={pendingActionKeys.includes('sync:public')} onClick={() => void handleSyncPublicImages()}>
                  同步公共镜像
                </button>
              ) : null}
            </div>
          </div>

          <div className="range-workbench-column-head image-center-column-head" aria-hidden="true">
            <div className="template-workbench-column-cell">
              <strong>镜像名</strong>
            </div>
            <div className="template-workbench-column-cell">
              <strong>镜像 ID</strong>
            </div>
            {activeTab === 'platform' || activeTab === 'mine' ? (
              <div className="template-workbench-column-cell">
                <strong>创建人</strong>
              </div>
            ) : null}
            <div className="template-workbench-column-cell">
              <strong>状态</strong>
            </div>
            <div className="template-workbench-column-cell">
              <strong>操作</strong>
            </div>
          </div>

          <div className="image-center-rows">
            {isBootstrapLoading ? (
              <div className="template-workbench-empty image-center-empty-state" aria-hidden="true" />
            ) : activeTab === 'platform' ? (
              renderAssetRows(pagedPlatformAssets, {
                emptyMessage: '当前没有平台镜像。',
                allowManagement: (asset) => session.isAdmin || asset.ownerUserId === session.profile?.id,
                allowVisibilityToggle: (asset) => asset.ownerUserId === session.profile?.id,
                compactActions: true,
              })
            ) : activeTab === 'mine' ? (
              renderAssetRows(pagedMyAssets, {
                emptyMessage: '当前没有我的镜像。',
                allowManagement: true,
                allowVisibilityToggle: true,
                compactActions: true,
              })
            ) : activeTab === 'custom' ? (
              renderScopeRows('custom', pagedCustomSnapshots)
            ) : (
              renderScopeRows('public', pagedPublicSnapshots)
            )}
          </div>

          <AdminPaginationControls
            label={`${activeTabTitle} 分页`}
            pageSizeMode={pageSizeMode}
            pagination={activePagination}
            visiblePages={visiblePages}
            jumpPageValue={jumpPageValue}
            onPageSizeChange={handlePageSizeChange}
            onPreviousPage={goToPreviousPage}
            onNextPage={goToNextPage}
            onPageSelect={(pageNumber) => setPage(activeTab, pageNumber)}
            onJumpPageValueChange={setJumpPageValue}
            onJumpPage={handleJumpToPage}
          />
          </div>

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
        </article>
      </section>
    </div>
  );
}
