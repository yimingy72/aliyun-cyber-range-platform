'use client';

import { useEffect, useRef, useState } from 'react';
import { fetchPlatformImages, fetchTencentCloudImages } from '@/lib/admin-api';
import { isUnauthorizedAdminError } from '@/lib/admin-screen';
import type { CloudWorkspaceView, PlatformImageAsset, TencentCloudImagesPayload } from '@/lib/admin-types';
import { Button } from '@/components/ui/button';
import { TableRow } from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAdminRouteIsActive } from './admin-page-cache';
import { useAdminSession } from './use-admin-session';
import { usePlatformTheme } from './platform-theme-menu';
import { AdminWorkbenchIcon, imageSourceIcons } from './shared/admin-workbench-icon';
import { AdminWorkbenchControls } from './shared/admin-workbench-controls';
import { AdminPageHeader } from './shared/admin-page-header';
import { ADMIN_TABLE_WIDTHS, AdminDataTable, AdminDataTableCell, AdminDataTableState, AdminDataTableText, type AdminDataColumn } from './shared/admin-data-table';
import { TableLoadingState } from './shared/table-loading-state';
import { AdminPaginationControls, getPagination, useAdminPageSize } from './admin-pagination';
import { AdminPaginatedList } from './shared/admin-paginated-list';

const columns: readonly AdminDataColumn[] = [
  { id: 'displayName', label: '镜像名', priority: 'primary' },
  { id: 'imageId', label: '镜像 ID', priority: 'secondary', width: ADMIN_TABLE_WIDTHS.identifier },
  { id: 'platform', label: '系统', priority: 'secondary', width: '10rem' },
  { id: 'status', label: '状态', priority: 'primary', width: ADMIN_TABLE_WIDTHS.status },
];

export function TencentImageCenterScreen({ apiBaseUrl, workspace }: { apiBaseUrl: string; workspace: CloudWorkspaceView }) {
  const session = useAdminSession();
  const isActive = useAdminRouteIsActive('/admin/image-center');
  const isCel = usePlatformTheme() === 'cel';
  const [view, setView] = useState<'platform' | 'mine' | 'cloud'>('platform');
  const [scope, setScope] = useState<'public' | 'custom'>('custom');
  const [images, setImages] = useState<TencentCloudImagesPayload | null>(null);
  const [assets, setAssets] = useState<PlatformImageAsset[]>([]);
  const [page, setPage] = useState(1);
  const { pageSize, setPageSize } = useAdminPageSize();
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const logoutRef = useRef(session.logout);
  logoutRef.current = session.logout;
  const context = workspace.contexts.find(item => item.id === workspace.activeCloudAccountContextId);
  const pagination = getPagination(view === 'cloud' ? images?.totalCount ?? 0 : assets.length, page, pageSize);

  useEffect(() => {
    if (!isActive || !session.token) return;
    let current = true;
    setIsLoading(true); setError(null); setImages(null); setAssets([]);
    if (view === 'cloud' && (!context || context.provider !== 'tencent_cloud' || context.accountUid !== workspace.accountUid || context.cloudWorkspaceId !== workspace.id)) {
      setError('当前工作空间尚未配置可用的腾讯云地域。'); setIsLoading(false); return;
    }
    const request = view === 'cloud'
      ? fetchTencentCloudImages(apiBaseUrl, session.token, { cloudAccountContextId: context!.id, scope, offset: (page - 1) * pageSize, limit: pageSize }).then(result => {
        if (!current) return;
        if (result.provider !== 'tencent_cloud' || result.cloudAccountContextId !== context!.id || result.accountUid !== workspace.accountUid || result.regionId !== context!.regionId || result.zoneId !== context!.zoneId || result.scope !== scope || result.offset !== (page - 1) * pageSize || result.limit !== pageSize || !Number.isSafeInteger(result.totalCount) || result.totalCount < 0) throw new Error('镜像返回的账号或查询范围不一致，请刷新核对。');
        const lastPage = Math.max(1, Math.ceil(result.totalCount / pageSize));
        if (page > lastPage) { setPage(lastPage); return; }
        setImages(result);
      })
      : fetchPlatformImages(apiBaseUrl, session.token, view).then(result => { if (current) setAssets(result.items); });
    request.catch(failure => {
      if (!current) return;
      if (isUnauthorizedAdminError(failure)) logoutRef.current();
      else setError(failure instanceof Error ? failure.message : '镜像查询失败，请重试。');
    }).finally(() => { if (current) setIsLoading(false); });
    return () => { current = false; };
  }, [apiBaseUrl, isActive, session.token, workspace.id, workspace.accountUid, context, view, scope, page, pageSize, refresh]);

  if (!session.isReady || !session.token) return null;
  const rows = view === 'cloud' ? images?.items ?? [] : assets.slice(pagination.startIndex, pagination.endIndex).map(asset => ({ displayName: asset.displayName, imageId: asset.imageId, platform: null, status: asset.enabled ? '可用' : '已停用', isAvailable: asset.enabled }));

  const viewTabs = <Tabs value={view} onValueChange={value => { setView(value as typeof view); setPage(1); }}><TabsList variant="line" aria-label="镜像视图"><TabsTrigger value="platform">{isCel && <AdminWorkbenchIcon {...imageSourceIcons.platform} />}平台镜像</TabsTrigger><TabsTrigger value="mine">{isCel && <AdminWorkbenchIcon {...imageSourceIcons.mine} />}我的镜像</TabsTrigger>{session.isAdmin ? <TabsTrigger value="cloud">{isCel && <AdminWorkbenchIcon {...imageSourceIcons.cloud} />}云上镜像来源</TabsTrigger> : null}</TabsList></Tabs>;
  const refreshAction = <Button disabled={isLoading} size="sm" variant="outline" onClick={() => setRefresh(value => value + 1)}>刷新镜像</Button>;
  const scopeTabs = view === 'cloud' ? <Tabs value={scope} onValueChange={value => { setScope(value as typeof scope); setPage(1); }}><TabsList variant="line" aria-label="云上镜像来源切换"><TabsTrigger value="custom">腾讯云自定义镜像</TabsTrigger><TabsTrigger value="public">腾讯云公共镜像</TabsTrigger></TabsList></Tabs> : null;
  const description = workspace.displayName + ' · ' + (context?.regionId ?? '未配置地域') + '。腾讯云镜像收录、导入和实例创建仍在开发。';

  return <div className="admin-screen image-center-screen admin-pagination-screen"><section className="admin-workbench-surface admin-pagination-surface">
    <AdminPageHeader artwork="images" title="镜像中心" description={isCel ? description : '查看当前腾讯云账号的镜像资产与云上来源。'} />
    {isCel ? <>
      <div className="cel-source-tabs">{viewTabs}</div>
      <AdminWorkbenchControls title="镜像清单" views={scopeTabs} actions={refreshAction} />
    </> : <>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">{viewTabs}{refreshAction}</div>
      {scopeTabs && <div className="mt-4">{scopeTabs}</div>}
      <p className="mt-3 text-xs leading-5 text-muted-foreground">{description}</p>
    </>}
    <AdminPaginatedList className="mt-4" footer={!isLoading && !error && pagination.totalItems ? <AdminPaginationControls label="腾讯云镜像分页" pageSize={pageSize} pagination={pagination} onPageSizeChange={value => { setPageSize(value); setPage(1); }} onPageSelect={setPage} /> : null}>
      <AdminDataTable columns={columns} isRefreshing={isLoading} label="腾讯云镜像目录">{visibleColumns => isLoading ? <TableLoadingState columnCount={visibleColumns.length} rowCount={3} label="正在查询腾讯云镜像" /> : error ? <AdminDataTableState columns={visibleColumns} title="镜像查询失败" description={error} variant="error" onRetry={() => setRefresh(value => value + 1)} /> : !rows.length ? <AdminDataTableState columns={visibleColumns} title="当前没有该类型镜像" description={view === 'cloud' ? '切换镜像类型或刷新查询。' : '当前账号工作空间尚未收录镜像。'} variant="empty" /> : rows.map(image => <TableRow key={image.imageId}>{visibleColumns.map(column => <AdminDataTableCell column={column} key={column.id}><AdminDataTableText>{column.id === 'status' ? (image.isAvailable ? '可用' : image.status) : image[column.id as 'displayName' | 'imageId' | 'platform'] ?? '—'}</AdminDataTableText></AdminDataTableCell>)}</TableRow>)}</AdminDataTable>
    </AdminPaginatedList>
  </section></div>;
}
