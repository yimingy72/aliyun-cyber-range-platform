'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { RefreshCw } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { TableRow } from '@/components/ui/table';
import { collectMogongImage, fetchCustomImageCatalogScope, fetchMogongImageCatalog, fetchPlatformContainerImages, fetchPlatformImages, syncCustomImages, type MogongImageCatalog } from '../../lib/admin-api';
import { isUnauthorizedAdminError } from '../../lib/admin-screen';
import { useAdminScreenCache } from '../../lib/admin-screen-cache';
import type { ImageCatalogScopePayload, ImageSnapshot, PlatformContainerImage, PlatformImageAsset } from '../../lib/admin-types';
import { AdminPaginationControls, buildVisiblePages, getPagination, useAdminPageSize } from './admin-pagination';
import { AdminDataTable, AdminDataTableCell, AdminDataTableState, AdminDataTableText, type AdminDataColumn } from './shared/admin-data-table';
import { AdminPaginatedList } from './shared/admin-paginated-list';
import { TableLoadingState } from './shared/table-loading-state';

const columns: readonly AdminDataColumn[] = [
  { id: 'name', label: '镜像名', priority: 'primary' },
  { id: 'type', label: '镜像类型', priority: 'primary' },
  { id: 'imageId', label: '阿里云镜像 ID', priority: 'secondary' },
  { id: 'status', label: '状态', priority: 'primary' },
  { id: 'creator', label: '创建人', priority: 'primary' },
  { id: 'actions', label: '操作', priority: 'primary', width: '11rem' },
];

type MogongImage = MogongImageCatalog['items'][number];
type MogongCache = { catalog: MogongImageCatalog; cloud: ImageCatalogScopePayload; platform: PlatformImageAsset[]; mine: PlatformImageAsset[]; containers: PlatformContainerImage[] };

function imageStatus(image: MogongImage, snapshot: ImageSnapshot | undefined, collected: boolean, privateAsset: boolean, containersCollectable: boolean) {
  if (!image.active) return '墨攻已停用';
  if (/废弃|弃用|已淘汰|已废止/i.test(image.name)) return '墨攻已废弃';
  if (image.status !== 'successful') return '墨攻处理未完成';
  if (image.type === 'docker') {
    if (collected) return '已收录';
    if (!containersCollectable) return '目录待更新';
    return image.containerReferenceStatus === 'needs_review' ? '引用待核验' : '可收录';
  }
  if (image.type !== 'vm') return '不支持的镜像类型';
  if (!image.imageId) return '无阿里云镜像 ID';
  if (!snapshot) return '云目录未匹配';
  if (!snapshot.isAvailable) return '云镜像不可用';
  return collected ? '已收录' : privateAsset ? '私有镜像待发布' : '可收录';
}

export function MogongImageCatalogView({ apiBaseUrl, actionHost, token, search, readOnly, refreshRevision, logout, onCollected, onContainerCollected, onCloudSynced }: {
  apiBaseUrl: string;
  actionHost: HTMLElement | null;
  token: string;
  search: string;
  readOnly: boolean;
  refreshRevision: number;
  logout: () => void;
  onCollected: (asset: PlatformImageAsset) => void;
  onContainerCollected: (asset: PlatformContainerImage) => void;
  onCloudSynced: (scope: ImageCatalogScopePayload) => void;
}) {
  const screenCache = useAdminScreenCache();
  const cached = screenCache?.read<MogongCache>(apiBaseUrl, token, 'image-center:mogong');
  const [catalog, setCatalog] = useState<MogongImageCatalog | null>(() => cached?.data.catalog ?? null);
  const [cloud, setCloud] = useState<ImageCatalogScopePayload | null>(() => cached?.data.cloud ?? null);
  const [collectedIds, setCollectedIds] = useState<Set<string>>(() => new Set(cached?.data.platform.map(asset => asset.imageId) ?? []));
  const [privateIds, setPrivateIds] = useState<Set<string>>(() => new Set(cached?.data.mine.filter(asset => asset.visibility === 'private').map(asset => asset.imageId) ?? []));
  const [collectedContainerIds, setCollectedContainerIds] = useState<Set<number>>(() => new Set(cached?.data.containers.map(asset => asset.sourceId) ?? []));
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(!cached);
  const [pending, setPending] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [page, setPage] = useState(1);
  const [jumpPage, setJumpPage] = useState('1');
  const requestVersion = useRef(0);
  const { pageSize, setPageSize } = useAdminPageSize();

  useEffect(() => {
    let active = true;
    const version = ++requestVersion.current;
    const existing = screenCache?.read<MogongCache>(apiBaseUrl, token, 'image-center:mogong');
    setLoading(!existing);
    setError('');
    const load = async (): Promise<MogongCache> => {
      const [nextCatalog, nextCloud, platform, mine, containers] = await Promise.all([
        fetchMogongImageCatalog(apiBaseUrl, token), fetchCustomImageCatalogScope(apiBaseUrl, token),
        fetchPlatformImages(apiBaseUrl, token, 'platform'), fetchPlatformImages(apiBaseUrl, token, 'mine'),
        fetchPlatformContainerImages(apiBaseUrl, token),
      ]);
      return { catalog: nextCatalog, cloud: nextCloud, platform: platform.items, mine: mine.items, containers: containers.items };
    };
    const request = screenCache ? screenCache.load(apiBaseUrl, token, 'image-center:mogong', load, { force: attempt > 0 }) : load();
    request.then((data) => {
      if (!active || requestVersion.current !== version) return;
      setCatalog(data.catalog);
      setCloud(data.cloud);
      setCollectedIds(new Set(data.platform.map((asset) => asset.imageId)));
      setPrivateIds(new Set(data.mine.filter((asset) => asset.visibility === 'private').map((asset) => asset.imageId)));
      setCollectedContainerIds(new Set(data.containers.map((asset) => asset.sourceId)));
      if (attempt) setAttempt(0);
    }).catch((err: unknown) => {
      if (!active || requestVersion.current !== version) return;
      if (isUnauthorizedAdminError(err)) logout();
      else setError(err instanceof Error ? err.message : '墨攻镜像目录加载失败');
    }).finally(() => { if (active && requestVersion.current === version) setLoading(false); });
    return () => { active = false; };
  }, [apiBaseUrl, token, attempt, screenCache, refreshRevision]);

  useEffect(() => { setPage(1); }, [search]);

  async function handleSyncCloud() {
    requestVersion.current += 1;
    screenCache?.invalidate(apiBaseUrl, token, 'image-center:mogong');
    setPending('sync');
    setError('');
    try {
      const next = await syncCustomImages(apiBaseUrl, token);
      setCloud(next);
      onCloudSynced(next);
      setCatalog(await fetchMogongImageCatalog(apiBaseUrl, token));
    } catch (err) {
      if (isUnauthorizedAdminError(err)) logout();
      else setError(err instanceof Error ? err.message : '同步云镜像失败');
    } finally {
      setPending(null);
    }
  }

  async function handleCollect(image: MogongImage) {
    requestVersion.current += 1;
    screenCache?.invalidate(apiBaseUrl, token, 'image-center:mogong');
    setPending(String(image.id));
    setError('');
    try {
      const asset = await collectMogongImage(apiBaseUrl, token, image.id);
      screenCache?.invalidate(apiBaseUrl, token, 'image-center:mogong');
      if ('sourceId' in asset) {
        setCollectedContainerIds((current) => new Set([...current, asset.sourceId]));
        onContainerCollected(asset);
      } else if (asset.visibility === 'private') {
        setPrivateIds((current) => new Set([...current, asset.imageId]));
        setError('该镜像已存在为私有资产，请由管理员将其发布到平台。');
        onCollected(asset);
      } else {
        setCollectedIds((current) => new Set([...current, asset.imageId]));
        onCollected(asset);
      }
    } catch (err) {
      if (isUnauthorizedAdminError(err)) logout();
      else setError(err instanceof Error ? err.message : '镜像收录失败');
    } finally {
      setPending(null);
    }
  }

  const normalizedSearch = search.trim().toLowerCase();
  const items = (catalog?.items ?? []).filter((item) =>
    !normalizedSearch || [item.name, item.imageId ?? ''].some((value) => value.toLowerCase().includes(normalizedSearch)),
  );
  const pagination = getPagination(items.length, page, pageSize);
  const snapshots = new Map((cloud?.snapshots ?? []).filter((snapshot) => snapshot.provider === 'alibaba_cloud').map((snapshot) => [snapshot.imageId, snapshot]));

  useEffect(() => { setJumpPage(String(pagination.page)); }, [pagination.page]);

  return (
    <AdminPaginatedList
      className="mt-4"
      footer={!loading && items.length ? (
        <AdminPaginationControls
          jumpPageValue={jumpPage}
          label="墨攻镜像中心分页"
          pageSize={pageSize}
          pagination={pagination}
          visiblePages={buildVisiblePages(pagination.totalPages, pagination.page)}
          onJumpPage={() => setPage(Number.parseInt(jumpPage, 10) || pagination.page)}
          onJumpPageValueChange={setJumpPage}
          onNextPage={() => setPage(pagination.page + 1)}
          onPageSelect={setPage}
          onPageSizeChange={(value) => { setPageSize(value); setPage(1); }}
          onPreviousPage={() => setPage(pagination.page - 1)}
        />
      ) : undefined}
    >
      {actionHost ? createPortal(
        <Button disabled={readOnly || pending !== null || loading} onClick={() => void handleSyncCloud()} size="sm" type="button" variant="outline">
          <RefreshCw aria-hidden="true" />同步云镜像
        </Button>,
        actionHost,
      ) : null}
      {error && catalog ? <p className="mb-3 text-sm text-destructive" role="alert">{error}</p> : null}
      <AdminDataTable columns={columns} label="墨攻镜像中心">
        {(visibleColumns) => {
          if (loading) return <TableLoadingState columnCount={visibleColumns.length} label="正在加载墨攻镜像" rowCount={5} />;
          if (!catalog || !cloud) return <AdminDataTableState columns={visibleColumns} description={error} onRetry={() => setAttempt((value) => value + 1)} title="无法加载墨攻镜像" variant="error" />;
          if (!items.length) return <AdminDataTableState columns={visibleColumns} description="请同步云镜像，或调整名称和镜像 ID 筛选条件。" title="没有匹配的墨攻镜像" variant="empty" />;
          return items.slice(pagination.startIndex, pagination.endIndex).map((item) => {
            const snapshot = item.imageId ? snapshots.get(item.imageId) : undefined;
            const isCollected = item.type === 'docker' ? collectedContainerIds.has(item.id) : Boolean(item.imageId && collectedIds.has(item.imageId));
            const status = imageStatus(item, snapshot, isCollected, Boolean(item.imageId && privateIds.has(item.imageId)), catalog.containersCollectable);
            const canCollect = status === '可收录' || status === '引用待核验';
            const [nameColumn, typeColumn, imageIdColumn, statusColumn, creatorColumn, actionColumn] = visibleColumns;
            return (
              <TableRow key={item.id}>
                <AdminDataTableCell column={nameColumn!}><AdminDataTableText>{item.name}</AdminDataTableText></AdminDataTableCell>
                <AdminDataTableCell column={typeColumn!}>{item.type === 'docker' ? '容器' : item.type === 'vm' ? '虚拟机' : '其他'}</AdminDataTableCell>
                <AdminDataTableCell className="font-mono text-xs text-muted-foreground" column={imageIdColumn!}>{item.imageId || '—'}</AdminDataTableCell>
                <AdminDataTableCell column={statusColumn!}><Badge variant={status === '可收录' || status === '已收录' ? 'default' : 'secondary'}>{status}</Badge></AdminDataTableCell>
                <AdminDataTableCell column={creatorColumn!}>{item.creator || '—'}</AdminDataTableCell>
                <AdminDataTableCell column={actionColumn!}>
                  <Button aria-label={`${status === '已收录' ? '已收录' : '收录到平台'} ${item.name}`} disabled={readOnly || pending !== null || !canCollect} onClick={() => void handleCollect(item)} size="sm" type="button" variant="outline">
                    {status === '已收录' ? '已收录' : '收录到平台'}
                  </Button>
                </AdminDataTableCell>
              </TableRow>
            );
          });
        }}
      </AdminDataTable>
    </AdminPaginatedList>
  );
}
