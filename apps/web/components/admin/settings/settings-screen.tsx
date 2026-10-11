'use client';

import { type FormEvent, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { MoreHorizontal, Plus, RefreshCw } from 'lucide-react';
import { deleteCloudAccount, fetchCloudWorkspaces, saveCloudAccount } from '@/lib/admin-api';
import { isUnauthorizedAdminError } from '@/lib/admin-screen';
import type { CloudWorkspaceView, SaveCloudAccountInput } from '@/lib/admin-types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { TableRow } from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useAdminRouteIsActive } from '../admin-page-cache';
import { useAdminSession } from '../use-admin-session';
import { cloudProviderLabel, useCloudWorkspace } from '../cloud-workspace-provider';
import { AdminPageHeader } from '../shared/admin-page-header';
import { AdminDataTable, AdminDataTableCell, AdminDataTableState, AdminDataTableText, type AdminDataColumn } from '../shared/admin-data-table';
import { TableLoadingState } from '../shared/table-loading-state';
import { ConfirmActionDialog } from '../shared/confirm-action-dialog';
import { AdminDialog } from '../shared/admin-dialog';

const columns: readonly AdminDataColumn[] = [
  { id: 'account', label: '云账号', priority: 'primary', width: '42%' },
  { id: 'region', label: '默认地域 / 可用区', priority: 'secondary', width: '28%' },
  { id: 'actions', label: '操作', priority: 'primary', align: 'right', width: '30%' },
];
const emptyForm = { displayName: '', regionId: '', zoneId: '', accessKeyId: '', accessKeySecret: '', imageImportBucket: '' };

export function SettingsScreen({ apiBaseUrl = 'http://localhost:3001' }: { apiBaseUrl?: string }) {
  const router = useRouter();
  const session = useAdminSession();
  const current = useCloudWorkspace();
  const isPageActive = useAdminRouteIsActive('/admin/settings/cloud');
  const [workspaces, setWorkspaces] = useState<CloudWorkspaceView[]>([]);
  const [provider, setProvider] = useState<CloudWorkspaceView['provider']>(current?.workspace?.provider ?? 'alibaba_cloud');
  const [form, setForm] = useState(emptyForm);
  const [editing, setEditing] = useState<CloudWorkspaceView | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [deleting, setDeleting] = useState<CloudWorkspaceView | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const saving = useRef(false);
  const removing = useRef(false);
  const alive = useRef(true);
  const accountNameRef = useRef<HTMLInputElement>(null);
  const source = session.profile?.id ?? '';
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const workspaceRef = useRef(current?.workspace?.id);
  workspaceRef.current = current?.workspace?.id;
  const canBind = current?.isReady === true && current.profile?.isPlatformManager === true;

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (!isPageActive || !canBind) {
      setShowForm(false); setEditing(null); setForm(emptyForm); setActionError(null);
    }
  }, [isPageActive, canBind]);
  useEffect(() => {
    if (!isPageActive || !session.isReady || !session.token || !session.isAdmin) return;
    let active = true;
    setIsLoading(true);
    setError(null);
    fetchCloudWorkspaces(apiBaseUrl, session.token).then(items => { if (active) setWorkspaces(items); }).catch(failure => {
      if (!active) return;
      if (isUnauthorizedAdminError(failure)) { session.logout(); router.replace('/admin/login'); }
      else setError(failure instanceof Error ? failure.message : '绑定云账号加载失败。');
    }).finally(() => { if (active) setIsLoading(false); });
    return () => { active = false; };
  }, [apiBaseUrl, isPageActive, refresh, session.isReady, session.token, session.isAdmin]);

  function changeProvider(value: string) {
    if (value !== 'alibaba_cloud' && value !== 'tencent_cloud') return;
    setProvider(value); setForm(emptyForm); setEditing(null); setShowForm(false); setDeleting(null); setActionError(null); setSuccess(null);
  }
  function edit(workspace: CloudWorkspaceView) {
    const context = workspace.contexts.find(item => item.id === workspace.activeCloudAccountContextId) ?? workspace.contexts[0];
    setEditing(workspace); setShowForm(true); setActionError(null); setSuccess(null);
    setForm({ ...emptyForm, displayName: workspace.displayName, regionId: context?.regionId ?? '', zoneId: context?.zoneId ?? '', imageImportBucket: context?.imageImportBucket ?? '' });
  }
  function closeAccountForm() {
    if (saving.current) return;
    setShowForm(false); setEditing(null); setForm(emptyForm); setActionError(null);
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session.token || !canBind || saving.current) return;
    saving.current = true; setIsSaving(true); setActionError(null); setSuccess(null);
    const requestSource = source;
    try {
      const input: SaveCloudAccountInput = { provider, ...form, ...(editing ? { cloudWorkspaceId: editing.id } : {}) };
      const result = await saveCloudAccount(apiBaseUrl, session.token, input);
      if (!alive.current || sourceRef.current !== requestSource) return;
      if (result.provider !== provider || !result.cloudWorkspaceId || (editing && result.cloudWorkspaceId !== editing.id)) throw new Error('保存返回的绑定账号不一致，请刷新核对。');
      if (result.cloudWorkspaceId === current?.workspace?.id) await current.refreshCurrent();
      if (!alive.current || sourceRef.current !== requestSource) return;
      setForm(emptyForm); setEditing(null); setShowForm(false); setRefresh(value => value + 1);
      setSuccess('账号已保存。');
    } catch (failure) {
      if (!alive.current || sourceRef.current !== requestSource) return;
      if (isUnauthorizedAdminError(failure)) { session.logout(); router.replace('/admin/login'); }
      else setActionError(failure instanceof Error ? failure.message : '云账号保存失败。');
    } finally { saving.current = false; if (alive.current && sourceRef.current === requestSource) setIsSaving(false); }
  }
  async function select(workspace: CloudWorkspaceView) {
    if (!current) return;
    setActionError(null); setSuccess(null);
    try { await current.switchTo(workspace.id); } catch (failure) { if (alive.current) setActionError(failure instanceof Error ? failure.message : '云账号切换失败。'); }
  }
  async function remove() {
    const target = deleting;
    if (!session.token || !canBind || !target || removing.current || target.id === workspaceRef.current) return;
    removing.current = true; setIsDeleting(true); setActionError(null); setSuccess(null);
    const requestSource = source;
    try {
      const result = await deleteCloudAccount(apiBaseUrl, session.token, target.id);
      if (!alive.current || sourceRef.current !== requestSource) return;
      if (result.id !== target.id || result.provider !== target.provider || result.accountUid !== target.accountUid || result.retainedData !== true) {
        throw new Error('删除返回的账号不一致，请刷新核对。');
      }
      setWorkspaces(items => items.filter(item => item.id !== target.id));
      if (editing?.id === target.id) { setEditing(null); setShowForm(false); setForm(emptyForm); }
      setSuccess('账号已删除，历史数据已保留。');
      setRefresh(value => value + 1);
    } catch (failure) {
      if (!alive.current || sourceRef.current !== requestSource) return;
      if (isUnauthorizedAdminError(failure)) { session.logout(); router.replace('/admin/login'); }
      else setActionError(failure instanceof Error ? failure.message : '云账号删除失败。');
    } finally {
      removing.current = false;
      if (alive.current && sourceRef.current === requestSource) { setIsDeleting(false); setDeleting(null); }
    }
  }
  if (!session.isReady || !session.token) return null;
  if (!session.isAdmin) return <p className="admin-empty">当前账号无权访问基础配置。</p>;
  const historyWorkspace = workspaces.find(workspace => workspace.id === 'legacy-unbound');
  const visible = workspaces.filter(workspace => workspace.provider === provider && workspace.id !== historyWorkspace?.id);
  const isBusy = isSaving || isDeleting || current?.isSwitching === true;

  return <div className="admin-screen"><section className="admin-workbench-surface">
    <AdminPageHeader title="基础配置" />
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
      <Tabs value={provider} onValueChange={changeProvider}><TabsList aria-label="云厂商" variant="line"><TabsTrigger disabled={isBusy} value="alibaba_cloud">阿里云</TabsTrigger><TabsTrigger disabled={isBusy} value="tencent_cloud">腾讯云</TabsTrigger></TabsList></Tabs>
      <div className="flex flex-wrap items-center gap-2">
        <Button aria-label="刷新账号" disabled={isLoading || isBusy} size="icon-sm" variant="ghost" onClick={() => setRefresh(value => value + 1)}><RefreshCw aria-hidden="true" /></Button>
        {canBind ? <Button aria-label={`绑定${cloudProviderLabel(provider)}账号`} disabled={isBusy} onClick={() => { setEditing(null); setForm(emptyForm); setShowForm(true); setActionError(null); setSuccess(null); }}><Plus aria-hidden="true" />绑定账号</Button> : null}
      </div>
    </div>
    {actionError && !showForm ? <p className="mt-4 break-words text-sm text-destructive" role="alert">{actionError}</p> : null}
    {success ? <p className="mt-4 text-sm text-emerald-700" role="status">{success}</p> : null}
    <div className="mt-4"><AdminDataTable columns={columns} contentVersion={refresh} isRefreshing={isLoading} label="已绑定云账号">
      {visibleColumns => isLoading ? <TableLoadingState columnCount={visibleColumns.length} rowCount={3} label="正在加载绑定云账号" /> : error ? <AdminDataTableState columns={visibleColumns} title="云账号加载失败" description={error} variant="error" onRetry={() => setRefresh(value => value + 1)} /> : !visible.length ? <AdminDataTableState columns={visibleColumns} title={`尚未绑定${cloudProviderLabel(provider)}账号`} description={canBind ? '点击“绑定账号”添加。' : '联系平台管理员绑定云账号。'} variant="empty" /> : visible.map(workspace => {
        const context = workspace.contexts.find(item => item.id === workspace.activeCloudAccountContextId) ?? workspace.contexts[0];
        const selected = workspace.id === current?.workspace?.id;
        return <TableRow key={workspace.id}>{visibleColumns.map(column => <AdminDataTableCell column={column} key={column.id}>
          {column.id === 'account' ? <div className="grid min-w-0 gap-1">
            <div className="flex min-w-0 items-center gap-2"><div className="min-w-0"><AdminDataTableText className="font-medium">{workspace.displayName}</AdminDataTableText></div>{selected ? <span className="admin-pill admin-pill-success shrink-0">当前</span> : null}</div>
            <span className="break-all text-xs text-muted-foreground">{workspace.accountUid ?? '历史来源未确认'}</span>
            {context ? <span className="break-words text-xs text-muted-foreground md:hidden">{context.regionId} · {context.zoneId}</span> : null}
            {workspace.isReadOnly ? <span className="text-xs text-muted-foreground">只读历史</span> : context?.status !== 'ready' ? <span className="text-xs text-amber-700">待配置</span> : null}
          </div> : column.id === 'region' ? <div className="grid gap-1 text-xs"><AdminDataTableText>{context?.regionId ?? '—'}</AdminDataTableText><AdminDataTableText className="text-muted-foreground">{context?.zoneId ?? '—'}</AdminDataTableText></div> : <div className="flex items-center justify-end gap-1">
            {!selected ? <Button aria-label={`切换到此账号：${workspace.displayName}`} disabled={isBusy} size="sm" variant="outline" onClick={() => void select(workspace)}>切换</Button> : null}
            {canBind && workspace.accountUid && !workspace.isReadOnly ? <DropdownMenu>
              <DropdownMenuTrigger asChild><Button aria-label={`账号“${workspace.displayName}”的更多操作`} disabled={isBusy} size="icon-sm" variant="ghost"><MoreHorizontal aria-hidden="true" /></Button></DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => edit(workspace)}>编辑配置</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem disabled={selected} variant="destructive" onSelect={() => { setDeleting(workspace); setActionError(null); setSuccess(null); }}>删除账号{selected ? '（先切换到其他账号）' : ''}</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu> : null}
          </div>}
        </AdminDataTableCell>)}</TableRow>;
      })}
    </AdminDataTable></div>
    {!isLoading && !error && historyWorkspace ? <section aria-label="历史数据" className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2"><span className="text-sm font-medium">历史数据</span><span className="text-xs text-muted-foreground">只读</span>{historyWorkspace.id === current?.workspace?.id ? <span className="admin-pill admin-pill-success">当前视图</span> : null}</div>
        <p className="mt-1 text-xs text-muted-foreground">旧版本中账号归属待确认的记录，保留用于账单核对和审计。</p>
      </div>
      {historyWorkspace.id !== current?.workspace?.id ? <Button disabled={isBusy} size="sm" variant="outline" onClick={() => void select(historyWorkspace)}>查看历史</Button> : null}
    </section> : null}
    <AdminDialog
      open={showForm && canBind && isPageActive}
      title={`${editing ? '编辑' : '绑定'}${cloudProviderLabel(provider)}账号`}
      description={editing ? '请重新输入该账号凭据。' : undefined}
      initialFocusRef={accountNameRef}
      pending={isSaving}
      onOpenChange={open => { if (!open) closeAccountForm(); }}
      footer={<><Button disabled={isBusy} type="button" variant="outline" onClick={closeAccountForm}>取消</Button><Button disabled={isBusy} type="submit" form="cloud-account-form">{isSaving ? '正在验证…' : '验证并保存'}</Button></>}
    >
      <form id="cloud-account-form" className="grid gap-4" aria-label="云账号绑定表单" aria-busy={isSaving} onSubmit={save}>
        <div className="grid gap-4 sm:grid-cols-2">{([['displayName', '账号名称', '例如：训练环境'], ['regionId', '默认地域', provider === 'tencent_cloud' ? 'ap-nanjing' : 'cn-hangzhou'], ['zoneId', '默认可用区', provider === 'tencent_cloud' ? 'ap-nanjing-1' : 'cn-hangzhou-h'], ['accessKeyId', provider === 'tencent_cloud' ? 'SecretId' : 'AccessKey ID', ''], ['accessKeySecret', provider === 'tencent_cloud' ? 'SecretKey' : 'AccessKey Secret', ''], ...(provider === 'alibaba_cloud' ? [['imageImportBucket', '镜像导入 OSS Bucket', '可选：现有 Bucket 名称']] : [])] as Array<[keyof typeof form, string, string]>).map(([field, label, placeholder]) => <div className={field === 'displayName' || field === 'imageImportBucket' ? 'grid gap-2 sm:col-span-2' : 'grid gap-2'} key={field}><Label htmlFor={`cloud-account-${field}`}>{label}</Label><Input ref={field === 'displayName' ? accountNameRef : undefined} id={`cloud-account-${field}`} name={field} autoComplete={field === 'accessKeySecret' ? 'new-password' : 'off'} disabled={isBusy} required={field !== 'displayName' && field !== 'imageImportBucket'} type={field === 'accessKeySecret' ? 'password' : 'text'} placeholder={placeholder} value={form[field]} onChange={event => { setForm(value => ({ ...value, [field]: event.target.value })); setActionError(null); }} /></div>)}</div>
        {actionError ? <p className="break-words text-sm text-destructive" role="alert">{actionError}</p> : null}
      </form>
    </AdminDialog>
    <ConfirmActionDialog
      open={Boolean(deleting)} title="删除云账号" confirmLabel={isDeleting ? '正在删除…' : '删除账号'} pending={isDeleting}
      description={`删除${deleting ? cloudProviderLabel(deleting.provider) : ''}账号“${deleting?.displayName ?? ''}”（UID ${deleting?.accountUid ?? ''}）的绑定与凭据，历史数据保留。账单同步将停止，未出账费用需重新绑定同一账号后同步。此操作不会删除云上资源。`}
      onOpenChange={open => { if (!open && !isDeleting) setDeleting(null); }} onConfirm={() => void remove()}
    />
  </section></div>;
}
