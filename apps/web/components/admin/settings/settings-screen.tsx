'use client';

import { type FormEvent, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { fetchCloudWorkspaces, saveCloudAccount } from '@/lib/admin-api';
import { isUnauthorizedAdminError } from '@/lib/admin-screen';
import type { CloudWorkspaceView, SaveCloudAccountInput } from '@/lib/admin-types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { TableRow } from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAdminRouteIsActive } from '../admin-page-cache';
import { useAdminSession } from '../use-admin-session';
import { cloudProviderLabel, useCloudWorkspace } from '../cloud-workspace-provider';
import { AdminPageHeader } from '../shared/admin-page-header';
import { AdminDataTable, AdminDataTableCell, AdminDataTableState, AdminDataTableText, type AdminDataColumn } from '../shared/admin-data-table';
import { TableLoadingState } from '../shared/table-loading-state';

const columns: readonly AdminDataColumn[] = [
  { id: 'account', label: '绑定账号', priority: 'primary', width: '35%' },
  { id: 'region', label: '默认地域 / 可用区', priority: 'secondary', width: '28%' },
  { id: 'status', label: '状态', priority: 'secondary', width: '13%' },
  { id: 'actions', label: '操作', priority: 'primary', width: '24%' },
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
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const saving = useRef(false);
  const alive = useRef(true);
  const source = session.profile?.id ?? '';
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const canBind = session.profile?.isPlatformManager === true;

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
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
    setProvider(value); setForm(emptyForm); setEditing(null); setShowForm(false); setActionError(null); setSuccess(null);
  }
  function edit(workspace: CloudWorkspaceView) {
    const context = workspace.contexts.find(item => item.id === workspace.activeCloudAccountContextId) ?? workspace.contexts[0];
    setEditing(workspace); setShowForm(true); setActionError(null); setSuccess(null);
    setForm({ ...emptyForm, displayName: workspace.displayName, regionId: context?.regionId ?? '', zoneId: context?.zoneId ?? '', imageImportBucket: context?.imageImportBucket ?? '' });
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
      setSuccess('云账号已验证并保存。点击“切换到此账号”后查看对应平台数据。');
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
  if (!session.isReady || !session.token) return null;
  if (!session.isAdmin) return <p className="admin-empty">当前账号无权访问基础配置。</p>;
  const visible = workspaces.filter(workspace => workspace.provider === provider);
  const isBusy = isSaving || current?.isSwitching === true;

  return <div className="admin-screen"><section className="admin-workbench-surface">
    <AdminPageHeader title="基础配置" description="绑定云厂商账号，并显式切换对应的平台数据。" />
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-b border-border pb-4">
      <div className="min-w-0 text-sm"><span className="text-muted-foreground">当前工作空间</span><p className="mt-1 break-words font-semibold">{current?.workspace ? `${cloudProviderLabel(current.workspace.provider)} · ${current.workspace.displayName}` : '尚未绑定云账号'}</p></div>
      {current?.workspace ? <span className="break-all text-xs text-muted-foreground">账号 {current.workspace.accountUid ?? '历史数据'} · {current.workspace.contexts.find(item => item.id === current.workspace?.activeCloudAccountContextId)?.regionId ?? '未配置地域'}</span> : null}
    </div>
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
      <Tabs value={provider} onValueChange={changeProvider}><TabsList aria-label="云厂商" variant="line"><TabsTrigger disabled={isBusy} value="alibaba_cloud">阿里云</TabsTrigger><TabsTrigger disabled={isBusy} value="tencent_cloud">腾讯云</TabsTrigger></TabsList></Tabs>
      <div className="flex flex-wrap gap-2"><Button disabled={isLoading || isBusy} variant="outline" onClick={() => setRefresh(value => value + 1)}>刷新账号</Button>{canBind ? <Button disabled={isBusy} onClick={() => { setEditing(null); setForm(emptyForm); setShowForm(true); setActionError(null); setSuccess(null); }}>绑定{cloudProviderLabel(provider)}账号</Button> : null}</div>
    </div>
    <p className="mt-3 text-sm leading-6 text-muted-foreground">每个云厂商主账号对应独立的镜像、靶场、实例、用户与账单。切换回来时恢复该账号的数据。</p>
    {actionError ? <p className="mt-4 break-words text-sm text-destructive" role="alert">{actionError}</p> : null}
    {success ? <p className="mt-4 text-sm text-emerald-700" role="status">{success}</p> : null}
    <div className="mt-4"><AdminDataTable columns={columns} isRefreshing={isLoading} label="已绑定云账号">
      {visibleColumns => isLoading ? <TableLoadingState columnCount={visibleColumns.length} rowCount={3} label="正在加载绑定云账号" /> : error ? <AdminDataTableState columns={visibleColumns} title="云账号加载失败" description={error} variant="error" onRetry={() => setRefresh(value => value + 1)} /> : !visible.length ? <AdminDataTableState columns={visibleColumns} title={`尚未绑定${cloudProviderLabel(provider)}账号`} description={canBind ? '绑定账号并验证身份后，可显式切换到该账号工作空间。' : '联系平台管理员绑定云账号。'} variant="empty" /> : visible.map(workspace => {
        const context = workspace.contexts.find(item => item.id === workspace.activeCloudAccountContextId) ?? workspace.contexts[0];
        const selected = workspace.id === current?.workspace?.id;
        return <TableRow key={workspace.id}>{visibleColumns.map(column => <AdminDataTableCell column={column} key={column.id}>
          {column.id === 'account' ? <div className="grid min-w-0 gap-1"><AdminDataTableText>{workspace.displayName}</AdminDataTableText><span className="break-all text-xs text-muted-foreground">{workspace.accountUid ?? '历史来源未确认'}</span></div> : column.id === 'region' ? <div className="grid gap-1 text-xs"><span>{context?.regionId ?? '—'}</span><span className="text-muted-foreground">{context?.zoneId ?? '—'}</span></div> : column.id === 'status' ? <span className={`admin-pill ${selected ? 'admin-pill-success' : 'admin-pill-neutral'}`}>{selected ? '当前空间' : workspace.isReadOnly ? '只读历史' : '已绑定'}</span> : <div className="flex flex-wrap gap-2"><Button disabled={selected || isBusy} size="sm" variant={selected ? 'outline' : 'default'} onClick={() => void select(workspace)}>{selected ? '当前账号' : '切换到此账号'}</Button>{canBind && workspace.accountUid ? <Button disabled={isBusy} size="sm" variant="outline" onClick={() => edit(workspace)}>编辑配置</Button> : null}</div>}
        </AdminDataTableCell>)}</TableRow>;
      })}
    </AdminDataTable></div>
    {showForm && canBind ? <form className="mt-6 grid gap-4 border-t border-border pt-5" aria-label="云账号绑定表单" aria-busy={isSaving} onSubmit={save}>
      <h2 className="text-base font-semibold">{editing ? '编辑' : '绑定'}{cloudProviderLabel(provider)}账号</h2>
      <div className="grid gap-4 sm:grid-cols-2">{([['displayName', '账号名称', '例如：训练环境'], ['regionId', '默认地域', provider === 'tencent_cloud' ? 'ap-nanjing' : 'cn-hangzhou'], ['zoneId', '默认可用区', provider === 'tencent_cloud' ? 'ap-nanjing-1' : 'cn-hangzhou-h'], ['accessKeyId', provider === 'tencent_cloud' ? 'SecretId' : 'AccessKey ID', ''], ['accessKeySecret', provider === 'tencent_cloud' ? 'SecretKey' : 'AccessKey Secret', ''], ...(provider === 'alibaba_cloud' ? [['imageImportBucket', '镜像导入 OSS Bucket', '可选：现有 Bucket 名称']] : [])] as Array<[keyof typeof form, string, string]>).map(([field, label, placeholder]) => <div className="grid gap-2" key={field}><Label htmlFor={`cloud-account-${field}`}>{label}</Label><Input id={`cloud-account-${field}`} name={field} autoComplete={field === 'accessKeySecret' ? 'new-password' : 'off'} disabled={isBusy} required={field !== 'displayName' && field !== 'imageImportBucket'} type={field === 'accessKeySecret' ? 'password' : 'text'} placeholder={placeholder} value={form[field]} onChange={event => { setForm(value => ({ ...value, [field]: event.target.value })); setActionError(null); }} /></div>)}</div>
      <p className="text-sm text-muted-foreground">{editing ? '重新输入该主账号的凭据完成验证。' : '身份验证后绑定主账号。'}凭据加密保存；保存配置不会切换工作空间。</p>
      <div className="flex flex-wrap gap-2"><Button disabled={isBusy} type="submit">{isSaving ? '正在验证…' : '验证并保存账号'}</Button><Button disabled={isBusy} type="button" variant="outline" onClick={() => { setShowForm(false); setEditing(null); setForm(emptyForm); }}>取消</Button></div>
    </form> : null}
  </section></div>;
}
