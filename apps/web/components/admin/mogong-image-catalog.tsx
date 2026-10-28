'use client';

import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { TableRow } from '@/components/ui/table';
import { collectMogongImage, fetchCustomImageCatalogScope, fetchMogongImageCatalog, fetchPlatformImages, syncCustomImages, type MogongImageCatalog } from '../../lib/admin-api';
import { isUnauthorizedAdminError } from '../../lib/admin-screen';
import type { ImageCatalogScopePayload, ImageSnapshot, PlatformImageAsset } from '../../lib/admin-types';
import { AdminPaginationControls, buildVisiblePages, getPagination, useAdminPageSize } from './admin-pagination';
import { AdminDataTable, AdminDataTableCell, AdminDataTableState, AdminDataTableText, type AdminDataColumn } from './shared/admin-data-table';
import { AdminPaginatedList } from './shared/admin-paginated-list';
import { TableLoadingState } from './shared/table-loading-state';

const columns: readonly AdminDataColumn[] = [
  { id: 'name', label: '镜像名', priority: 'primary' },
  { id: 'imageId', label: '阿里云镜像 ID', priority: 'secondary' },
  { id: 'status', label: '状态', priority: 'primary' },
  { id: 'creator', label: '创建人', priority: 'primary' },
  { id: 'actions', label: '操作', priority: 'primary', width: '11rem' },
];

type MogongImage = MogongImageCatalog['items'][number];

function imageStatus(image: MogongImage, snapshot: ImageSnapshot | undefined, collected: boolean, privateAsset: boolean) {
  if (!image.active) return '墨攻已停用';
  if (/废弃|弃用|已淘汰|已废止/i.test(image.name)) return '墨攻已废弃';
  if (image.status !== 'successful') return '墨攻处理未完成';
  if (image.type !== 'vm') return '容器镜像暂不支持';
  if (!image.imageId) return '无阿里云镜像 ID';
  if (!snapshot) return '云目录未匹配';
  if (!snapshot.isAvailable) return '云镜像不可用';
  return collected ? '已收录' : privateAsset ? '私有镜像待发布' : '可收录';
}

export function MogongImageCatalogView({ apiBaseUrl, token, search, readOnly, logout, onCollected, onCloudSynced }: {
  apiBaseUrl: string;
  token: string;
  search: string;
  readOnly: boolean;
  logout: () => void;
  onCollected: (asset: PlatformImageAsset) => void;
  onCloudSynced: (scope: ImageCatalogScopePayload) => void;
}) {
  const [catalog, setCatalog] = useState<MogongImageCatalog | null>(null);
  const [cloud, setCloud] = useState<ImageCatalogScopePayload | null>(null);
  const [collectedIds, setCollectedIds] = useState<Set<string>>(new Set());
  const [privateIds, setPrivateIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [page, setPage] = useState(1);
  const [jumpPage, setJumpPage] = useState('1');
  const { pageSize, setPageSize } = useAdminPageSize();

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    Promise.all([
      fetchMogongImageCatalog(apiBaseUrl, token),
      fetchCustomImageCatalogScope(apiBaseUrl, token),
      fetchPlatformImages(apiBaseUrl, token, 'platform'),
      fetchPlatformImages(apiBaseUrl, token, 'mine'),
    ]).then(([nextCatalog, nextCloud, platform, mine]) => {
      if (!active) return;
      setCatalog(nextCatalog);
      setCloud(nextCloud);
      setCollectedIds(new Set(platform.items.map((asset) => asset.imageId)));
      setPrivateIds(new Set(mine.items.filter((asset) => asset.visibility === 'private').map((asset) => asset.imageId)));
    }).catch((err: unknown) => {
      if (!active) return;
      if (isUnauthorizedAdminError(err)) logout();
      else setError(err instanceof Error ? err.message : '墨攻镜像目录加载失败');
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [apiBaseUrl, token, attempt]);

  useEffect(() => { setPage(1); }, [search]);

  async function handleSyncCloud() {
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
    setPending(String(image.id));
    setError('');
    try {
      const asset = await collectMogongImage(apiBaseUrl, token, image.id);
      if (asset.visibility === 'private') {
        setPrivateIds((current) => new Set([...current, asset.imageId]));
        setError('该镜像已存在为私有资产，请由管理员将其发布到平台。');
      } else {
        setCollectedIds((current) => new Set([...current, asset.imageId]));
      }
      onCollected(asset);
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
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
        <span>墨攻目录快照：{catalog ? new Date(catalog.capturedAt).toLocaleString('zh-CN') : '加载中'}。仅显示与当前账号和地域的云镜像匹配的记录。</span>
        <Button disabled={readOnly || pending !== null || loading} onClick={() => void handleSyncCloud()} size="sm" type="button" variant="outline">
          <RefreshCw aria-hidden="true" />同步云镜像
        </Button>
      </div>
      {error && catalog ? <p className="mb-3 text-sm text-destructive" role="alert">{error}</p> : null}
      <AdminDataTable columns={columns} label="墨攻镜像中心">
        {(visibleColumns) => {
          if (loading) return <TableLoadingState columnCount={visibleColumns.length} label="正在加载墨攻镜像" rowCount={5} />;
          if (!catalog || !cloud) return <AdminDataTableState columns={visibleColumns} description={error} onRetry={() => setAttempt((value) => value + 1)} title="无法加载墨攻镜像" variant="error" />;
          if (!items.length) return <AdminDataTableState columns={visibleColumns} description="请同步云镜像，或调整名称和镜像 ID 筛选条件。" title="没有匹配的墨攻镜像" variant="empty" />;
          return items.slice(pagination.startIndex, pagination.endIndex).map((item) => {
            const snapshot = item.imageId ? snapshots.get(item.imageId) : undefined;
            const status = imageStatus(item, snapshot, Boolean(item.imageId && collectedIds.has(item.imageId)), Boolean(item.imageId && privateIds.has(item.imageId)));
            const [nameColumn, imageIdColumn, statusColumn, creatorColumn, actionColumn] = visibleColumns;
            return (
              <TableRow key={item.id}>
                <AdminDataTableCell column={nameColumn!}><AdminDataTableText>{item.name}</AdminDataTableText><span className="block text-xs text-muted-foreground">类型：{item.type}</span></AdminDataTableCell>
                <AdminDataTableCell className="font-mono text-xs text-muted-foreground" column={imageIdColumn!}>{item.imageId || '—'}</AdminDataTableCell>
                <AdminDataTableCell column={statusColumn!}><Badge variant={status === '可收录' || status === '已收录' ? 'default' : 'secondary'}>{status}</Badge></AdminDataTableCell>
                <AdminDataTableCell column={creatorColumn!}>{item.creator || '—'}</AdminDataTableCell>
                <AdminDataTableCell column={actionColumn!}>
                  <Button aria-label={`${status === '已收录' ? '已收录' : '收录到平台'} ${item.name}`} disabled={readOnly || pending !== null || status !== '可收录'} onClick={() => void handleCollect(item)} size="sm" type="button" variant="outline">
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
