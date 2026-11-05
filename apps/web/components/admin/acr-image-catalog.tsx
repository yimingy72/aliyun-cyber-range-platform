'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { RefreshCw } from 'lucide-react';
import type { AcrImageCatalog } from '@aliyun-cyber-range/platform-api-client';
import { Button } from '@/components/ui/button';
import { TableRow } from '@/components/ui/table';
import { fetchAcrImageCatalog, syncAcrImageCatalog } from '../../lib/admin-api';
import { isUnauthorizedAdminError } from '../../lib/admin-screen';
import { AdminPaginationControls, getPagination, useAdminPageSize } from './admin-pagination';
import { AdminDataTable, AdminDataTableCell, AdminDataTableState, AdminDataTableText, type AdminDataColumn } from './shared/admin-data-table';
import { AdminPaginatedList } from './shared/admin-paginated-list';
import { TableLoadingState } from './shared/table-loading-state';

const columns: readonly AdminDataColumn[] = [
  { id: 'repository', label: '镜像仓库', priority: 'primary' },
  { id: 'tag', label: '镜像标签', priority: 'primary', width: '9rem' },
  { id: 'instance', label: 'ACR 实例', priority: 'secondary', width: '12rem' },
  { id: 'region', label: '地域', priority: 'secondary', width: '9rem' },
  { id: 'registry', label: '仓库域名', priority: 'tertiary', width: '19rem' },
  { id: 'status', label: '状态', priority: 'secondary', width: '7rem' },
];

export function AcrImageCatalogView({ apiBaseUrl, token, search, actionHost, readOnly, logout, onCatalogChanged }: {
  apiBaseUrl: string; token: string; search: string; actionHost: HTMLElement | null;
  readOnly: boolean; logout: () => void; onCatalogChanged: () => void;
}) {
  const [catalog, setCatalog] = useState<AcrImageCatalog | null>(null);
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState(search);
  const [revision, setRevision] = useState(0);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const { pageSize, setPageSize } = useAdminPageSize();
  const lastSync = useRef<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => { setPage(1); setQuery(search); }, 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    async function load() {
      try {
        const result = await fetchAcrImageCatalog(apiBaseUrl, token, page, pageSize, query);
        if (!active) return;
        setCatalog(result);
        setError('');
        if (result.syncedAt && lastSync.current !== result.syncedAt) {
          lastSync.current = result.syncedAt;
          onCatalogChanged();
        }
        if (result.state === 'running') timer = window.setTimeout(() => void load(), 2000);
      } catch (cause) {
        if (!active) return;
        if (isUnauthorizedAdminError(cause)) logout();
        else setError(cause instanceof Error ? cause.message : '未能加载 ACR 镜像目录。');
      }
    }
    void load();
    return () => { active = false; window.clearTimeout(timer); };
  }, [apiBaseUrl, token, page, pageSize, query, revision, logout, onCatalogChanged]);

  async function sync() {
    setStarting(true);
    setError('');
    try {
      await syncAcrImageCatalog(apiBaseUrl, token);
      if (!mounted.current) return;
      onCatalogChanged();
      setCatalog(previous => previous ? { ...previous, state: 'running', error: null } : null);
      setRevision(value => value + 1);
    } catch (cause) {
      if (!mounted.current) return;
      if (isUnauthorizedAdminError(cause)) logout();
      else setError(cause instanceof Error ? cause.message : '未能同步 ACR 镜像目录。');
    } finally {
      if (mounted.current) setStarting(false);
    }
  }

  const syncing = starting || catalog?.state === 'running';
  const failure = error || catalog?.error;
  const pagination = getPagination(catalog?.total ?? 0, catalog?.page ?? 1, pageSize);
  return (
    <AdminPaginatedList className="mt-4" footer={catalog?.total ? (
      <AdminPaginationControls label="ACR 镜像分页" pageSize={pageSize} pagination={pagination}
        onPageSelect={setPage} onPageSizeChange={value => { setPageSize(value); setPage(1); }} />
    ) : null}>
      {actionHost ? createPortal(
        <Button aria-label={syncing ? '正在同步 ACR 镜像' : '同步 ACR 镜像'} disabled={readOnly || syncing} onClick={() => void sync()} size="sm" type="button" variant="outline">
          <RefreshCw aria-hidden="true" />{syncing ? '同步中…' : '同步 ACR'}
        </Button>, actionHost) : null}
      {failure && catalog?.syncedAt ? <p role="alert" className="mb-3 text-sm text-destructive">{failure} 当前仍显示上次成功同步的目录。</p> : null}
      {catalog?.syncedAt ? <p className="mb-2 text-xs text-muted-foreground">
        {catalog.regionCount} 个地域 · {catalog.instanceCount} 个实例 · {catalog.repositoryCount} 个仓库 · {catalog.imageCount} 个镜像标签
      </p> : null}
      <AdminDataTable columns={columns} label="ACR 容器镜像" isRefreshing={syncing && Boolean(catalog?.syncedAt)}>
        {visible => {
          if (failure && !catalog?.syncedAt) return <AdminDataTableState columns={visible} title="无法读取 ACR 目录" description={failure} variant="error" />;
          if (!catalog || (syncing && !catalog.syncedAt)) return <TableLoadingState columnCount={visible.length} rowCount={4} label="正在读取 ACR 目录" />;
          if (!catalog.items.length) return <AdminDataTableState columns={visible} title={catalog.syncedAt ? '没有匹配的 ACR 镜像' : '尚未同步 ACR 镜像'}
            description={catalog.syncedAt ? '请调整搜索条件，或确认 ACR 仓库中已有镜像标签。' : '点击「同步 ACR 镜像」读取当前账号的企业版实例、仓库和标签。'} variant="empty" />;
          const [repo, tag, instance, region, registry, status] = visible;
          return catalog.items.map(item => (
            <TableRow key={item.id}>
              <AdminDataTableCell column={repo!}><AdminDataTableText>{item.repository}</AdminDataTableText></AdminDataTableCell>
              <AdminDataTableCell column={tag!}><AdminDataTableText tooltipContent={item.digest ?? undefined}>{item.tag}</AdminDataTableText></AdminDataTableCell>
              <AdminDataTableCell column={instance!}>{item.instance}</AdminDataTableCell>
              <AdminDataTableCell column={region!}>{item.region}</AdminDataTableCell>
              <AdminDataTableCell column={registry!}><AdminDataTableText tooltipContent={item.domains.length > 1 ? item.domains.join(' · ') : undefined}>{item.domains[0] ?? '—'}</AdminDataTableText></AdminDataTableCell>
              <AdminDataTableCell column={status!}>{item.status === 'NORMAL' ? '正常' : item.status}</AdminDataTableCell>
            </TableRow>
          ));
        }}
      </AdminDataTable>
    </AdminPaginatedList>
  );
}
