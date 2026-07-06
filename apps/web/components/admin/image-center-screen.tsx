'use client';

import React from 'react';
import { useEffect, useRef, useState } from 'react';

import {
  AdminApiError,
  collectPlatformImage,
  deleteCustomImageSnapshot,
  disablePlatformImage,
  enablePlatformImage,
  fetchCustomImageCatalogScope,
  fetchPlatformImages,
  fetchPublicImageCatalogScope,
  removePlatformImage,
  renamePlatformImage,
  syncCustomImages,
  syncPublicImages,
} from '../../lib/admin-api';
import type {
  ImageCatalogScopePayload,
  ImageSnapshot,
  PlatformImageAsset,
} from '../../lib/admin-types';
import { useAdminSession } from './use-admin-session';

type ImageCenterScreenProps = {
  apiBaseUrl?: string;
};

type ActiveTab = 'platform' | 'custom' | 'public';
type TabPageMap = Record<ActiveTab, number>;
type ImageCenterConfirmState =
  | { type: 'remove-platform'; asset: PlatformImageAsset }
  | { type: 'delete-custom'; snapshot: ImageSnapshot }
  | null;

const PAGE_SIZE_AUTO = 'auto';
const MANUAL_PAGE_SIZE_OPTIONS = [50, 100, 200];
const ROWS_BASED_PAGE_SIZE_FALLBACK = 8;
const ROW_HEIGHT = 72;
const PAGE_SIZE_RESERVED_HEIGHT = 470;

function getAutoPageSize(viewportHeight?: number) {
  if (!viewportHeight || Number.isNaN(viewportHeight)) {
    return ROWS_BASED_PAGE_SIZE_FALLBACK;
  }

  return Math.max(1, Math.floor((viewportHeight - PAGE_SIZE_RESERVED_HEIGHT) / ROW_HEIGHT));
}

function isUnauthorizedError(error: unknown) {
  return error instanceof AdminApiError && error.status === 401;
}

function formatImageStatus(snapshot: ImageSnapshot) {
  if (snapshot.status?.trim()) {
    return snapshot.status;
  }

  return snapshot.isAvailable ? 'Available' : 'Unavailable';
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

function getPagination(totalItems: number, currentPage: number, pageSize: number) {
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const page = Math.min(Math.max(currentPage, 1), totalPages);
  const startIndex = (page - 1) * pageSize;

  return {
    page,
    totalPages,
    startIndex,
    endIndex: startIndex + pageSize,
  };
}

function buildVisiblePages(totalPages: number, currentPage: number) {
  const startPage = Math.max(1, currentPage - 1);
  const endPage = Math.min(totalPages, startPage + 2);
  const adjustedStartPage = Math.max(1, endPage - 2);

  return Array.from({ length: endPage - adjustedStartPage + 1 }, (_, index) => adjustedStartPage + index);
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

export function ImageCenterScreen({ apiBaseUrl = 'http://localhost:3001' }: ImageCenterScreenProps) {
  const session = useAdminSession();
  const [activeTab, setActiveTab] = useState<ActiveTab>('platform');
  const [searchName, setSearchName] = useState('');
  const [platformAssets, setPlatformAssets] = useState<PlatformImageAsset[]>([]);
  const [publicScope, setPublicScope] = useState<ImageCatalogScopePayload | null>(null);
  const [customScope, setCustomScope] = useState<ImageCatalogScopePayload | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [pendingActionKeys, setPendingActionKeys] = useState<string[]>([]);
  const [pageSizeMode, setPageSizeMode] = useState<string>(PAGE_SIZE_AUTO);
  const [pageSize, setPageSize] = useState(() => getAutoPageSize(typeof window === 'undefined' ? undefined : window.innerHeight));
  const [tabPages, setTabPages] = useState<TabPageMap>({ platform: 1, custom: 1, public: 1 });
  const [jumpPageValue, setJumpPageValue] = useState('1');
  const [renamingAsset, setRenamingAsset] = useState<PlatformImageAsset | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [confirmState, setConfirmState] = useState<ImageCenterConfirmState>(null);
  const platformRequestVersionRef = useRef(0);
  const publicScopeRequestVersionRef = useRef(0);
  const customScopeRequestVersionRef = useRef(0);

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

  useEffect(() => {
    if (pageSizeMode !== PAGE_SIZE_AUTO) {
      return;
    }

    function syncAutoPageSize() {
      setPageSize(getAutoPageSize(window.innerHeight));
    }

    syncAutoPageSize();
    window.addEventListener('resize', syncAutoPageSize);

    return () => {
      window.removeEventListener('resize', syncAutoPageSize);
    };
  }, [pageSizeMode]);

  useEffect(() => {
    if (!session.isReady || !session.token) {
      return;
    }

    const platformRequestVersion = platformRequestVersionRef.current + 1;
    const publicRequestVersion = publicScopeRequestVersionRef.current + 1;
    const customRequestVersion = customScopeRequestVersionRef.current + 1;
    platformRequestVersionRef.current = platformRequestVersion;
    publicScopeRequestVersionRef.current = publicRequestVersion;
    customScopeRequestVersionRef.current = customRequestVersion;
    let isActive = true;

    Promise.all([
      fetchPlatformImages(apiBaseUrl, session.token),
      fetchPublicImageCatalogScope(apiBaseUrl, session.token),
      fetchCustomImageCatalogScope(apiBaseUrl, session.token),
    ])
      .then(([platformPayload, nextPublicScope, nextCustomScope]) => {
        if (!isActive) {
          return;
        }

        if (platformRequestVersionRef.current === platformRequestVersion) {
          setPlatformAssets(platformPayload.items);
        }

        if (publicScopeRequestVersionRef.current === publicRequestVersion) {
          setPublicScope(nextPublicScope);
        }

        if (customScopeRequestVersionRef.current === customRequestVersion) {
          setCustomScope(nextCustomScope);
        }
      })
      .catch((error) => {
        if (!isActive) {
          return;
        }

        if (isUnauthorizedError(error)) {
          session.logout();
          return;
        }

        setErrorMessage(error instanceof Error ? error.message : '镜像中心加载失败');
      });

    return () => {
      isActive = false;
    };
  }, [apiBaseUrl, session.isReady, session.token]);

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
      if (isUnauthorizedError(error)) {
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
      if (isUnauthorizedError(error)) {
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

      setPlatformAssets((previous) => upsertPlatformAsset(previous, nextPlatformAsset));
    } catch (error) {
      if (isUnauthorizedError(error)) {
        session.logout();
        return;
      }

      setErrorMessage(error instanceof Error ? error.message : '镜像收录失败');
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
      setErrorMessage('');
      beginAction(actionKey);
      const nextAsset = await renamePlatformImage(apiBaseUrl, session.token, renamingAsset.id, nextDisplayName);
      setPlatformAssets((previous) => replacePlatformAsset(previous, nextAsset));
      closeRenameDialog();
    } catch (error) {
      if (isUnauthorizedError(error)) {
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
      setPlatformAssets((previous) => replacePlatformAsset(previous, nextAsset));
    } catch (error) {
      if (isUnauthorizedError(error)) {
        session.logout();
        return;
      }

      setErrorMessage(error instanceof Error ? error.message : '平台镜像状态更新失败');
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
      setPlatformAssets((previous) => previous.filter((item) => item.id !== asset.id));
      closeConfirmDialog();
    } catch (error) {
      if (isUnauthorizedError(error)) {
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
      if (isUnauthorizedError(error)) {
        session.logout();
        return;
      }

      setErrorMessage(error instanceof Error ? error.message : '云上镜像删除失败');
    } finally {
      endAction(actionKey);
    }
  }

  const filteredPlatformAssets = platformAssets.filter((asset) => matchesPlatformAssetSearch(asset, searchName));
  const filteredCustomSnapshots = (customScope?.snapshots ?? []).filter((snapshot) => matchesSnapshotSearch(snapshot, searchName));
  const filteredPublicSnapshots = (publicScope?.snapshots ?? []).filter((snapshot) => matchesSnapshotSearch(snapshot, searchName));

  const activeItemsCount =
    activeTab === 'platform'
      ? filteredPlatformAssets.length
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
      setPageSize(getAutoPageSize(typeof window === 'undefined' ? undefined : window.innerHeight));
      setTabPages({ platform: 1, custom: 1, public: 1 });
      return;
    }

    const nextPageSize = Number(nextValue);
    setPageSizeMode(nextValue);
    setPageSize(nextPageSize);
    setTabPages({ platform: 1, custom: 1, public: 1 });
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
  const pagedCustomSnapshots = filteredCustomSnapshots.slice(activePagination.startIndex, activePagination.endIndex);
  const pagedPublicSnapshots = filteredPublicSnapshots.slice(activePagination.startIndex, activePagination.endIndex);

  const collectedImageIds = buildCollectedImageIdSet(platformAssets);

  function renderPlatformRows(items: PlatformImageAsset[]) {
    if (items.length === 0) {
      return <div className="template-workbench-empty image-center-empty-state">当前没有平台收录镜像。</div>;
    }

    return items.map((asset) => {
      const renameActionKey = `rename:platform:${asset.id}`;
      const toggleActionKey = `${asset.enabled ? 'disable' : 'enable'}:platform:${asset.id}`;
      const removeActionKey = `remove:platform:${asset.id}`;
      const isPending = [renameActionKey, toggleActionKey, removeActionKey].some((key) => pendingActionKeys.includes(key));

      return (
        <article
          key={asset.id}
          aria-label={`${asset.displayName} ${asset.imageId}`}
          className="range-workbench-row image-center-row"
        >
          <div className="range-workbench-main image-center-main-cell">
            <strong>{asset.displayName}</strong>
            <span className="image-center-row-meta">来源：{asset.sourceScope === 'custom' ? '阿里云自定义镜像' : '阿里云公共镜像'}</span>
          </div>
          <div className="range-workbench-created-at image-center-secondary-cell">
            <span>{asset.imageId}</span>
          </div>
          <div className="range-workbench-status-cell image-center-status-cell">
            <span className={`template-workbench-status-pill ${asset.enabled ? 'is-published' : 'is-draft'}`}>
              {asset.enabled ? '已启用' : '已禁用'}
            </span>
          </div>
          <div className="range-workbench-actions image-center-actions-cell">
            <button type="button" disabled={isPending} aria-label={`重命名 ${asset.displayName}`} onClick={() => openRenameDialog(asset)}>
              重命名
            </button>
            <button type="button" disabled={isPending} aria-label={`${asset.enabled ? '禁用' : '启用'} ${asset.displayName}`} onClick={() => void handleTogglePlatformAsset(asset)}>
              {asset.enabled ? '禁用' : '启用'}
            </button>
            <button type="button" disabled={isPending} aria-label={`删除 ${asset.displayName}`} onClick={() => setConfirmState({ type: 'remove-platform', asset })}>
              删除
            </button>
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
            <button
              type="button"
              disabled={isCollected || isCollectPending}
              aria-label={`${isCollected ? '已收录' : '收录到平台'} ${snapshot.sourceImageName}`}
              onClick={() => void handleCollectSnapshot(snapshot)}
            >
              {isCollected ? '已收录' : '收录到平台'}
            </button>
            {scope === 'custom' ? (
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

  const activeTabTitle =
    activeTab === 'platform' ? '平台收录镜像' : activeTab === 'custom' ? '阿里云自定义镜像' : '阿里云公共镜像';

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
              <button type="button" aria-pressed={activeTab === 'platform'} onClick={() => setActiveTab('platform')}>
                平台收录镜像
              </button>
              <button type="button" aria-pressed={activeTab === 'custom'} onClick={() => setActiveTab('custom')}>
                阿里云自定义镜像
              </button>
              <button type="button" aria-pressed={activeTab === 'public'} onClick={() => setActiveTab('public')}>
                阿里云公共镜像
              </button>
            </div>
          </div>

          <div className={`template-workbench-list image-center-list image-center-list--${activeTab}`}>
          <div className="template-workbench-list-header">
            <div className="template-workbench-list-header-copy">
              <h2>{activeTabTitle}</h2>
            </div>

            <div className="template-workbench-list-header-meta image-center-list-meta">
              <span>{activeItemsCount} 条记录</span>
              {activeTab === 'custom' ? (
                <button type="button" disabled={pendingActionKeys.includes('sync:custom')} onClick={() => void handleSyncCustomImages()}>
                  同步自定义镜像
                </button>
              ) : null}
              {activeTab === 'public' ? (
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
            <div className="template-workbench-column-cell">
              <strong>状态</strong>
            </div>
            <div className="template-workbench-column-cell">
              <strong>操作</strong>
            </div>
          </div>

          <div className="image-center-rows">
            {activeTab === 'platform' ? renderPlatformRows(pagedPlatformAssets) : null}
            {activeTab === 'custom' ? renderScopeRows('custom', pagedCustomSnapshots) : null}
            {activeTab === 'public' ? renderScopeRows('public', pagedPublicSnapshots) : null}
          </div>

          <div className="image-center-pagination" aria-label={`${activeTabTitle} 分页`}>
            <label className="image-center-pagination-size">
              <span>每页条数</span>
              <select aria-label="每页条数" value={pageSizeMode} onChange={(event) => handlePageSizeChange(event.target.value)}>
                <option value={PAGE_SIZE_AUTO}>自动</option>
                {MANUAL_PAGE_SIZE_OPTIONS.map((option) => (
                  <option key={option} value={String(option)}>
                    {option} 条
                  </option>
                ))}
              </select>
            </label>
            <button type="button" aria-label="上一页" disabled={activePagination.page <= 1} onClick={goToPreviousPage}>
              上一页
            </button>
            <div className="image-center-pagination-pages" aria-label="页码">
              {visiblePages.map((pageNumber) => (
                <button
                  key={pageNumber}
                  type="button"
                  aria-label={`第 ${pageNumber} 页`}
                  aria-pressed={pageNumber === activePagination.page}
                  onClick={() => setPage(activeTab, pageNumber)}
                >
                  {pageNumber}
                </button>
              ))}
            </div>
            <button
              type="button"
              aria-label="下一页"
              disabled={activePagination.page >= activePagination.totalPages}
              onClick={goToNextPage}
            >
              下一页
            </button>
            <label className="image-center-pagination-jump">
              <span>跳转到</span>
              <input
                aria-label="跳转到页码"
                type="number"
                min={1}
                max={activePagination.totalPages}
                value={jumpPageValue}
                onChange={(event) => setJumpPageValue(event.target.value)}
              />
            </label>
            <button type="button" aria-label="跳转" onClick={handleJumpToPage}>
              跳转
            </button>
            <span className="image-center-pagination-summary">
              第 {activePagination.page} / {activePagination.totalPages} 页
            </span>
          </div>
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
