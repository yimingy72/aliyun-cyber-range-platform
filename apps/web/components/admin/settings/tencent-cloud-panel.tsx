'use client';

import { type FormEvent, useEffect, useRef, useState } from 'react';

import { fetchCloudAccountContexts, fetchTencentCloudImages, saveTencentCloudAccount } from '@/lib/admin-api';
import type { CloudAccountContext, TencentCloudImagesPayload } from '@/lib/admin-types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { TableRow } from '@/components/ui/table';
import { AdminSelectField } from '../shared/admin-select-field';
import { AdminDataTable, AdminDataTableCell, AdminDataTableState, type AdminDataColumn } from '../shared/admin-data-table';
import { TableLoadingState } from '../shared/table-loading-state';
import { AdminPaginationControls, buildVisiblePages, getPagination, useAdminPageSize } from '../admin-pagination';

const columns: readonly AdminDataColumn[] = [
  { id: 'displayName', label: '镜像名称', priority: 'primary', width: '38%' },
  { id: 'imageId', label: '镜像 ID', priority: 'primary', width: '26%' },
  { id: 'platform', label: '系统', priority: 'secondary', width: '20%' },
  { id: 'status', label: '状态', priority: 'primary', width: '16%' },
];
const emptyForm = { regionId: '', zoneId: '', accessKeyId: '', accessKeySecret: '' };

type Props = { apiBaseUrl: string; token: string; onError: (error: unknown) => boolean };

export function TencentCloudPanel({ apiBaseUrl, token, onError }: Props) {
  return <TencentCloudPanelContent apiBaseUrl={apiBaseUrl} token={token} onError={onError} key={`${apiBaseUrl}\u0000${token}`} />;
}

function TencentCloudPanelContent({ apiBaseUrl, token, onError }: Props) {
  const [form, setForm] = useState(emptyForm);
  const [accounts, setAccounts] = useState<CloudAccountContext[]>([]);
  const [contextId, setContextId] = useState('');
  const [scope, setScope] = useState<'public' | 'custom'>('custom');
  const [images, setImages] = useState<TencentCloudImagesPayload | null>(null);
  const [page, setPage] = useState(1);
  const [jumpPage, setJumpPage] = useState('1');
  const { pageSize, setPageSize } = useAdminPageSize();
  const [isLoadingAccounts, setIsLoadingAccounts] = useState(true);
  const [isLoadingImages, setIsLoadingImages] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const active = useRef(true);
  const saving = useRef(false);
  const accountRevision = useRef(0);
  const errorHandler = useRef(onError);
  errorHandler.current = onError;
  const source = `${apiBaseUrl}\u0000${token}`;
  const currentSource = useRef(source);
  currentSource.current = source;
  const selectedContext = useRef(contextId);
  selectedContext.current = contextId;
  const pagination = getPagination(images?.totalCount ?? 0, page, pageSize);

  useEffect(() => {
    active.current = true;
    setForm(emptyForm);
    setAccounts([]);
    setContextId('');
    setSuccess(null);
    setSaveError(null);
    setIsSaving(false);
    saving.current = false;
    return () => { active.current = false; };
  }, [apiBaseUrl, token]);

  useEffect(() => { setJumpPage(String(page)); }, [page]);

  useEffect(() => {
    let current = true;
    const revision = ++accountRevision.current;
    setAccountError(null);
    setIsLoadingAccounts(true);
    fetchCloudAccountContexts(apiBaseUrl, token, true).then((items) => {
      if (!current || revision !== accountRevision.current) return;
      const tencent = items.filter(item => item.provider === 'tencent_cloud');
      setAccounts(tencent);
      const previous = selectedContext.current;
      const next = tencent.some(item => item.id === previous && item.status === 'ready')
        ? previous : tencent.find(item => item.status === 'ready')?.id ?? '';
      setContextId(next);
      if (next !== previous) setPage(1);
    }).catch((error: unknown) => {
      if (current && revision === accountRevision.current && !errorHandler.current(error)) setAccountError('腾讯云账号加载失败，请重试。');
    }).finally(() => { if (current && revision === accountRevision.current) setIsLoadingAccounts(false); });
    return () => { current = false; };
  }, [apiBaseUrl, token, refresh]);

  useEffect(() => {
    let current = true;
    setImages(null);
    setImageError(null);
    const selectedAccount = accounts.find(item => item.id === contextId && item.status === 'ready');
    if (!selectedAccount) { setIsLoadingImages(false); return; }
    setIsLoadingImages(true);
    fetchTencentCloudImages(apiBaseUrl, token, { cloudAccountContextId: contextId, scope, offset: (page - 1) * pageSize, limit: pageSize }).then((result) => {
      if (!current) return;
      if (result.provider !== 'tencent_cloud' || result.cloudAccountContextId !== contextId
        || result.accountUid !== selectedAccount.accountUid || result.regionId !== selectedAccount.regionId
        || result.zoneId !== selectedAccount.zoneId || result.scope !== scope
        || result.offset !== (page - 1) * pageSize || result.limit !== pageSize
        || !Number.isSafeInteger(result.totalCount) || result.totalCount < 0) {
        throw new Error('腾讯云镜像返回的账号或查询范围不一致，请刷新核对。');
      }
      const lastPage = Math.max(1, Math.ceil(result.totalCount / pageSize));
      if (page > lastPage) { setPage(lastPage); return; }
      setImages(result);
    }).catch((error: unknown) => {
      if (current && !errorHandler.current(error)) setImageError(error instanceof Error ? error.message : '腾讯云镜像查询失败，请重试。');
    }).finally(() => { if (current) setIsLoadingImages(false); });
    return () => { current = false; };
  }, [apiBaseUrl, token, accounts, contextId, scope, page, pageSize, refresh]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving.current) return;
    saving.current = true;
    setIsSaving(true);
    setSaveError(null);
    setSuccess(null);
    const saveSource = source;
    try {
      const account = await saveTencentCloudAccount(apiBaseUrl, token, { provider: 'tencent_cloud', ...form });
      if (!active.current || currentSource.current !== saveSource) return;
      if (account.provider !== 'tencent_cloud' || account.status !== 'ready' || account.isActive) {
        throw new Error('腾讯云账号返回状态异常，请刷新核对。');
      }
      ++accountRevision.current;
      setIsLoadingAccounts(false);
      setAccountError(null);
      setForm(emptyForm);
      setAccounts(previous => [account, ...previous.filter(item => item.id !== account.id)]);
      setContextId(account.id);
      setPage(1);
      setSuccess('腾讯云账号已验证并保存，可查询镜像与可用机型。');
    } catch (error) {
      if (active.current && currentSource.current === saveSource && !errorHandler.current(error)) setSaveError(error instanceof Error ? error.message : '腾讯云账号保存失败，请检查凭据和地域。');
    } finally {
      if (currentSource.current === saveSource) {
        saving.current = false;
        if (active.current) setIsSaving(false);
      }
    }
  }

  const selected = accounts.find(item => item.id === contextId);

  return (
    <div className="grid min-w-0 gap-6 pt-4">
      <p className="text-sm leading-6 text-muted-foreground">腾讯云目前支持账号验证与镜像、机型查询。实例创建、编排和费用同步尚未开放。</p>
      <form aria-busy={isSaving} className="grid gap-4" onSubmit={save}>
        <h3 className="text-base font-semibold">添加或更新腾讯云账号</h3>
        <div className="grid gap-4 sm:grid-cols-2">
          {([
            ['regionId', '腾讯云地域', 'ap-nanjing'], ['zoneId', '腾讯云可用区', 'ap-nanjing-1'],
            ['accessKeyId', 'SecretId', ''], ['accessKeySecret', 'SecretKey', ''],
          ] as const).map(([field, label, placeholder]) => (
            <div className="grid gap-2" key={field}>
              <Label htmlFor={`tencent-${field}`}>{label}</Label>
              <Input autoComplete={field === 'accessKeySecret' ? 'new-password' : 'off'} disabled={isSaving} id={`tencent-${field}`} name={field} required placeholder={placeholder} type={field === 'accessKeySecret' ? 'password' : 'text'} value={form[field]} onChange={event => { setForm(previous => ({ ...previous, [field]: event.target.value })); setSaveError(null); setSuccess(null); }} />
            </div>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button disabled={isSaving} type="submit">{isSaving ? '正在验证…' : '验证并保存腾讯云账号'}</Button>
          <span className="text-sm text-muted-foreground">凭据加密保存；账号尚未启用创建。</span>
        </div>
        {saveError ? <p className="break-words text-sm text-destructive" role="alert">{saveError}</p> : null}
        {success ? <p className="break-words text-sm text-emerald-700" role="status">{success}</p> : null}
      </form>
      <div className="grid min-w-0 gap-4 border-t border-border pt-5">
        <div className="flex flex-wrap items-center gap-3">
          <h3 className="mr-auto text-base font-semibold">腾讯云镜像查询</h3>
          <AdminSelectField ariaLabel="腾讯云镜像账号" className="min-w-0 w-full sm:w-64" value={contextId} options={accounts.map(item => ({ value: item.id, label: item.displayName, disabled: item.status !== 'ready' }))} emptyOptionLabel="请选择已验证账号" disabled={isLoadingAccounts} onValueChange={id => { setContextId(accounts.some(item => item.id === id && item.status === 'ready') ? id : ''); setPage(1); }} />
          <AdminSelectField ariaLabel="腾讯云镜像类型" className="w-full sm:w-40" value={scope} options={[{ value: 'custom', label: '自定义镜像' }, { value: 'public', label: '公共镜像' }]} onValueChange={value => { setScope(value as 'public' | 'custom'); setPage(1); }} />
          <Button disabled={isLoadingAccounts || isLoadingImages} onClick={() => setRefresh(value => value + 1)} type="button" variant="outline">刷新</Button>
        </div>
        {selected ? <p className="break-all text-sm text-muted-foreground">账号 {selected.accountUid} · {selected.regionId} · {selected.zoneId}</p> : null}
        {accountError ? <p className="break-words text-sm text-destructive" role="alert">{accountError}</p> : null}
        <AdminDataTable columns={columns} isRefreshing={isLoadingImages} label="腾讯云镜像目录">
          {visibleColumns => isLoadingImages || isLoadingAccounts ? <TableLoadingState columnCount={visibleColumns.length} rowCount={3} label="正在查询腾讯云镜像" />
            : imageError ? <AdminDataTableState columns={visibleColumns} title="镜像查询失败" description={imageError} variant="error" onRetry={() => setRefresh(value => value + 1)} />
              : !images?.items.length ? <AdminDataTableState columns={visibleColumns} title={contextId ? '当前没有该类型镜像' : '先添加腾讯云账号'} description={contextId ? '切换镜像类型或刷新查询。' : '验证账号后，可按账号与地域查看云端镜像。'} variant="empty" />
                : images.items.map(image => <TableRow key={image.imageId}>{visibleColumns.map(column => <AdminDataTableCell column={column} key={column.id}>{column.id === 'status' ? (image.isAvailable ? '可用' : image.status) : image[column.id as 'displayName' | 'imageId' | 'platform'] ?? '—'}</AdminDataTableCell>)}</TableRow>)}
        </AdminDataTable>
        {images ? <AdminPaginationControls label="腾讯云镜像分页" pageSize={pageSize} pagination={pagination} visiblePages={buildVisiblePages(pagination.totalPages, page)} jumpPageValue={jumpPage} onPageSizeChange={value => { setPageSize(value); setPage(1); }} onPreviousPage={() => setPage(Math.max(1, page - 1))} onNextPage={() => setPage(Math.min(pagination.totalPages, page + 1))} onPageSelect={setPage} onJumpPageValueChange={setJumpPage} onJumpPage={() => { const next = Number(jumpPage); if (Number.isInteger(next) && next >= 1) setPage(Math.min(pagination.totalPages, next)); }} /> : null}
      </div>
    </div>
  );
}
