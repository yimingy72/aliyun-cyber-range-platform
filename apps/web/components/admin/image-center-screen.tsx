'use client';

import { useEffect, useRef, useState } from 'react';

import {
  AdminApiError,
  collectImageCatalogItem,
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
  ImageCatalogItem,
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

const PAGE_SIZE = 2;

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

function buildCollectedImageIdSet(scopePayload: ImageCatalogScopePayload | null) {
  return new Set((scopePayload?.catalogItems ?? []).filter((item) => item.enabled).map((item) => item.imageId));
}

function upsertCatalogItem(scopePayload: ImageCatalogScopePayload | null, catalogItem: ImageCatalogItem) {
  if (!scopePayload) {
    return scopePayload;
  }

  const nextCatalogItems = scopePayload.catalogItems.some((item) => item.imageId === catalogItem.imageId)
    ? scopePayload.catalogItems.map((item) => (item.imageId === catalogItem.imageId ? catalogItem : item))
    : [...scopePayload.catalogItems, catalogItem];

  return {
    ...scopePayload,
    catalogItems: nextCatalogItems,
  } satisfies ImageCatalogScopePayload;
}

function replacePlatformAsset(items: PlatformImageAsset[], nextAsset: PlatformImageAsset) {
  return items.map((item) => (item.id === nextAsset.id ? nextAsset : item));
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

function getPagination(totalItems: number, currentPage: number) {
  const totalPages = Math.max(1, Math.ceil(totalItems / PAGE_SIZE));
  const page = Math.min(Math.max(currentPage, 1), totalPages);
  const startIndex = (page - 1) * PAGE_SIZE;

  return {
    page,
    totalPages,
    startIndex,
    endIndex: startIndex + PAGE_SIZE,
  };
}

export function ImageCenterScreen({ apiBaseUrl = 'http://localhost:3001' }: ImageCenterScreenProps) {
  const session = useAdminSession();
  const [activeTab, setActiveTab] = useState<ActiveTab>('platform');
  const [searchName, setSearchName] = useState('');
  const [platformAssets, setPlatformAssets] = useState<PlatformImageAsset[]>([]);
  const [publicScope, setPublicScope] = useState<ImageCatalogScopePayload | null>(null);
  const [customScope, setCustomScope] = useState<ImageCatalogScopePayload | null>(null);
  const [statusMessage, setStatusMessage] = useState('');
  const [pendingActionKeys, setPendingActionKeys] = useState<string[]>([]);
  const [tabPages, setTabPages] = useState<TabPageMap>({ platform: 1, custom: 1, public: 1 });
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

        setStatusMessage(error instanceof Error ? error.message : '镜像中心加载失败');
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
      beginAction(actionKey);
      const nextScope = await syncPublicImages(apiBaseUrl, session.token);

      if (publicScopeRequestVersionRef.current === requestVersion) {
        setPublicScope(nextScope);
      }

      setStatusMessage('公共镜像同步完成');
    } catch (error) {
      if (isUnauthorizedError(error)) {
        session.logout();
        return;
      }

      setStatusMessage(error instanceof Error ? error.message : '公共镜像同步失败');
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
      beginAction(actionKey);
      const nextScope = await syncCustomImages(apiBaseUrl, session.token);

      if (customScopeRequestVersionRef.current === requestVersion) {
        setCustomScope(nextScope);
      }

      setStatusMessage('自定义镜像同步完成');
    } catch (error) {
      if (isUnauthorizedError(error)) {
        session.logout();
        return;
      }

      setStatusMessage(error instanceof Error ? error.message : '自定义镜像同步失败');
    } finally {
      endAction(actionKey);
    }
  }

  async function handleCollectSnapshot(snapshot: ImageSnapshot) {
    if (!session.token) {
      return;
    }

    const actionKey = `collect:${snapshot.scope}:${snapshot.imageId}`;
    const isPublicScope = snapshot.scope === 'public';
    const requestVersion = (isPublicScope ? publicScopeRequestVersionRef.current : customScopeRequestVersionRef.current) + 1;

    if (isPublicScope) {
      publicScopeRequestVersionRef.current = requestVersion;
    } else {
      customScopeRequestVersionRef.current = requestVersion;
    }

    try {
      beginAction(actionKey);
      const nextCatalogItem = await collectImageCatalogItem(apiBaseUrl, session.token, {
        snapshotId: snapshot.id,
        displayName: snapshot.sourceImageName,
      });

      setStatusMessage(`${snapshot.sourceImageName} 已收录到目录`);

      if (isPublicScope) {
        if (publicScopeRequestVersionRef.current === requestVersion) {
          setPublicScope((previous) => upsertCatalogItem(previous, nextCatalogItem));
        }
      } else if (customScopeRequestVersionRef.current === requestVersion) {
        setCustomScope((previous) => upsertCatalogItem(previous, nextCatalogItem));
      }
    } catch (error) {
      if (isUnauthorizedError(error)) {
        session.logout();
        return;
      }

      setStatusMessage(error instanceof Error ? error.message : '镜像收录失败');
    } finally {
      endAction(actionKey);
    }
  }

  async function handleRenamePlatformAsset(asset: PlatformImageAsset) {
    if (!session.token) {
      return;
    }

    const nextDisplayName = window.prompt('请输入新的镜像名称', asset.displayName)?.trim();
    if (!nextDisplayName || nextDisplayName === asset.displayName) {
      return;
    }

    const actionKey = `rename:platform:${asset.id}`;

    try {
      beginAction(actionKey);
      const nextAsset = await renamePlatformImage(apiBaseUrl, session.token, asset.id, nextDisplayName);
      setPlatformAssets((previous) => replacePlatformAsset(previous, nextAsset));
      setStatusMessage(`${asset.displayName} 已重命名为 ${nextAsset.displayName}`);
    } catch (error) {
      if (isUnauthorizedError(error)) {
        session.logout();
        return;
      }

      setStatusMessage(error instanceof Error ? error.message : '平台镜像重命名失败');
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
      beginAction(actionKey);
      const nextAsset = asset.enabled
        ? await disablePlatformImage(apiBaseUrl, session.token, asset.id)
        : await enablePlatformImage(apiBaseUrl, session.token, asset.id);
      setPlatformAssets((previous) => replacePlatformAsset(previous, nextAsset));
      setStatusMessage(`${nextAsset.displayName} 已${nextAsset.enabled ? '启用' : '禁用'}`);
    } catch (error) {
      if (isUnauthorizedError(error)) {
        session.logout();
        return;
      }

      setStatusMessage(error instanceof Error ? error.message : '平台镜像状态更新失败');
    } finally {
      endAction(actionKey);
    }
  }

  async function handleRemovePlatformAsset(asset: PlatformImageAsset) {
    if (!session.token || !window.confirm(`确认将 ${asset.displayName} 移出平台目录吗？`)) {
      return;
    }

    const actionKey = `remove:platform:${asset.id}`;

    try {
      beginAction(actionKey);
      await removePlatformImage(apiBaseUrl, session.token, asset.id);
      setPlatformAssets((previous) => previous.filter((item) => item.id !== asset.id));
      setStatusMessage(`${asset.displayName} 已移出目录`);
    } catch (error) {
      if (isUnauthorizedError(error)) {
        session.logout();
        return;
      }

      setStatusMessage(error instanceof Error ? error.message : '平台镜像移出目录失败');
    } finally {
      endAction(actionKey);
    }
  }

  async function handleDeleteCustomSnapshot(snapshot: ImageSnapshot) {
    if (!session.token || !window.confirm(`确认删除云上镜像 ${snapshot.sourceImageName} 吗？`)) {
      return;
    }

    const actionKey = `delete:custom:${snapshot.id}`;
    const requestVersion = customScopeRequestVersionRef.current + 1;
    customScopeRequestVersionRef.current = requestVersion;

    try {
      beginAction(actionKey);
      await deleteCustomImageSnapshot(apiBaseUrl, session.token, snapshot.id);

      if (customScopeRequestVersionRef.current === requestVersion) {
        setCustomScope((previous) => removeSnapshot(previous, snapshot.id));
      }

      setStatusMessage(`${snapshot.sourceImageName} 已从云端删除`);
    } catch (error) {
      if (isUnauthorizedError(error)) {
        session.logout();
        return;
      }

      setStatusMessage(error instanceof Error ? error.message : '云上镜像删除失败');
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

  const activePagination = getPagination(activeItemsCount, tabPages[activeTab]);

  useEffect(() => {
    if (tabPages[activeTab] !== activePagination.page) {
      setPage(activeTab, activePagination.page);
    }
  }, [activePagination.page, activeTab, tabPages]);

  function goToPreviousPage() {
    setPage(activeTab, activePagination.page - 1);
  }

  function goToNextPage() {
    setPage(activeTab, activePagination.page + 1);
  }

  const pagedPlatformAssets = filteredPlatformAssets.slice(activePagination.startIndex, activePagination.endIndex);
  const pagedCustomSnapshots = filteredCustomSnapshots.slice(activePagination.startIndex, activePagination.endIndex);
  const pagedPublicSnapshots = filteredPublicSnapshots.slice(activePagination.startIndex, activePagination.endIndex);

  const customCollectedImageIds = buildCollectedImageIdSet(customScope);
  const publicCollectedImageIds = buildCollectedImageIdSet(publicScope);

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
          className="template-workbench-row image-center-row"
        >
          <div className="template-workbench-column-cell image-center-main-cell">
            <strong>{asset.displayName}</strong>
            <span className="image-center-row-meta">来源：{asset.sourceScope === 'custom' ? '阿里云自定义镜像' : '阿里云公共镜像'}</span>
          </div>
          <div className="template-workbench-column-cell">
            <span>{asset.imageId}</span>
          </div>
          <div className="template-workbench-column-cell">
            <span className={`template-workbench-status-pill ${asset.enabled ? 'is-published' : 'is-draft'}`}>
              {asset.enabled ? '已启用' : '已禁用'}
            </span>
          </div>
          <div className="template-workbench-column-cell image-center-actions-cell">
            <button type="button" disabled={isPending} aria-label={`重命名 ${asset.displayName}`} onClick={() => void handleRenamePlatformAsset(asset)}>
              重命名
            </button>
            <button type="button" disabled={isPending} aria-label={`${asset.enabled ? '禁用' : '启用'} ${asset.displayName}`} onClick={() => void handleTogglePlatformAsset(asset)}>
              {asset.enabled ? '禁用' : '启用'}
            </button>
            <button type="button" disabled={isPending} aria-label={`移出目录 ${asset.displayName}`} onClick={() => void handleRemovePlatformAsset(asset)}>
              移出目录
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

    const collectedImageIds = scope === 'custom' ? customCollectedImageIds : publicCollectedImageIds;

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
          className="template-workbench-row image-center-row"
        >
          <div className="template-workbench-column-cell image-center-main-cell">
            <strong>{snapshot.sourceImageName}</strong>
            <span className="image-center-row-meta">平台：{snapshot.platform || '-'}</span>
          </div>
          <div className="template-workbench-column-cell">
            <span>{snapshot.imageId}</span>
          </div>
          <div className="template-workbench-column-cell">
            <span>{formatImageStatus(snapshot)}</span>
          </div>
          <div className="template-workbench-column-cell image-center-actions-cell">
            <button
              type="button"
              disabled={isCollected || isCollectPending}
              aria-label={`${isCollected ? '已收录' : '收录到目录'} ${snapshot.sourceImageName}`}
              onClick={() => void handleCollectSnapshot(snapshot)}
            >
              {isCollected ? '已收录' : '收录到目录'}
            </button>
            {scope === 'custom' ? (
              <button
                type="button"
                disabled={isDeletePending}
                aria-label={`删除云上镜像 ${snapshot.sourceImageName}`}
                onClick={() => void handleDeleteCustomSnapshot(snapshot)}
              >
                删除云上镜像
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
      <section className="template-workbench-shell">
        <div className="template-workbench-controls image-center-controls">
          <div className="template-workbench-segmented image-center-tabs" role="tablist" aria-label="镜像中心视图切换">
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
        </div>

        {statusMessage ? <p className="admin-empty">{statusMessage}</p> : null}

        <div className="template-workbench-list image-center-list">
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

          <div className="image-center-column-head" aria-hidden="true">
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
            <button type="button" aria-label="上一页" disabled={activePagination.page <= 1} onClick={goToPreviousPage}>
              上一页
            </button>
            <span>
              第 {activePagination.page} / {activePagination.totalPages} 页
            </span>
            <button
              type="button"
              aria-label="下一页"
              disabled={activePagination.page >= activePagination.totalPages}
              onClick={goToNextPage}
            >
              下一页
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
