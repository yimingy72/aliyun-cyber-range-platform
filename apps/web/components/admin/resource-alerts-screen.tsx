'use client';

import { AdminNotice } from './shared/admin-notice';
import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { ResourceAlert, ResourceAlertStatus, ResourcePatrol, ResourceReclaimPreview } from '@aliyun-cyber-range/platform-api-client';
import { AdminApiError, fetchResourceAlerts, fetchResourcePatrol, previewResourceReclaim, reclaimResourceAlert, setResourcePatrolManager } from '@/lib/admin-api';
import { formatAdminDateTime } from '@/lib/admin-screen';
import { useCloudWorkspace } from './cloud-workspace-provider';
import { useAdminSession } from './use-admin-session';
import { useAdminRouteIsActive } from './admin-page-cache';
import { AdminActionNotice } from './shared/admin-action-notice';
import { AdminDialog } from './shared/admin-dialog';
import { AdminDataTable, AdminDataTableCell, AdminDataTableState, type AdminDataColumn } from './shared/admin-data-table';
import { TableLoadingState } from './shared/table-loading-state';
import { Button } from '@/components/ui/button';
import { AdminSelectField } from './shared/admin-select-field';
import { TableRow } from '@/components/ui/table';

const labels: Record<ResourceAlertStatus, string> = { pending: '待处理', unverified: '来源待核验', reclaiming: '回收中', failed: '回收失败', resolved: '已解决' };
const types: Record<string, string> = { ecs: '云主机', disk: '系统盘', eip: 'EIP', nat_gateway: 'NAT', eni: '网卡', vpc: 'VPC',
  vswitch: '交换机', security_group: '安全组', network_acl: 'ACL', route_table: '路由表', snat_entry: 'SNAT', dnat_entry: 'DNAT' };
const columns: readonly AdminDataColumn[] = [
  { id: 'resource', label: '资源', priority: 'primary', width: '18rem' },
  { id: 'source', label: '所属实例 / 账号', priority: 'secondary', width: '18rem' },
  { id: 'reason', label: '告警原因', priority: 'primary', minWidth: '20rem' },
  { id: 'action', label: '操作', priority: 'primary', width: '8.5rem' },
];
type Review = { preview: ResourceReclaimPreview; workspaceId: string; idempotencyKey: string };

export function ResourceAlertsPanel({ apiBaseUrl = '/api' }: { apiBaseUrl?: string }) {
  const session = useAdminSession();
  const workspace = useCloudWorkspace();
  const active = useAdminRouteIsActive('/admin/billing');
  const workspaceId = workspace?.workspace?.id ?? '';
  const source = `${workspaceId}:${session.profile?.id ?? ''}`;
  const sourceRef = useRef(source); sourceRef.current = source;
  const [rows, setRows] = useState<ResourceAlert[] | null>(null);
  const [patrol, setPatrol] = useState<ResourcePatrol | null>(null);
  const [filter, setFilter] = useState<ResourceAlertStatus | 'open' | 'all'>('open');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [review, setReview] = useState<Review | null>(null);
  const [busy, setBusy] = useState(false);
  const mutation = useRef(false);
  const request = useRef(0);
  const refresh = useCallback(async () => {
    if (!session.token || !session.profile?.isPlatformManager || !active) return;
    const started = sourceRef.current, revision = ++request.current;
    setLoading(true);
    try {
      const [alerts, state] = await Promise.all([fetchResourceAlerts(apiBaseUrl, session.token), fetchResourcePatrol(apiBaseUrl, session.token)]);
      if (sourceRef.current !== started || request.current !== revision) return;
      if (alerts.some(alert => alert.cloudWorkspaceId !== workspaceId)) throw new Error('告警账号与当前工作空间不一致。');
      setRows(alerts); setPatrol(state); setError(null);
    } catch (failure) {
      if (sourceRef.current === started && request.current === revision) setError(failure instanceof Error ? failure.message : '资源告警读取失败。');
    } finally { if (sourceRef.current === started && request.current === revision) setLoading(false); }
  }, [session.token, session.profile?.isPlatformManager, active, apiBaseUrl, workspaceId]);
  useEffect(() => {
    setRows(null); setPatrol(null); setReview(null); setError(null); setNotice(null);
  }, [source]);
  useEffect(() => {
    void refresh();
    if (!active) return;
    const timer = setInterval(() => void refresh(), 30_000);
    return () => { clearInterval(timer); request.current++; };
  }, [active, refresh]);

  async function followMe() {
    if (!session.token || !session.profile || mutation.current) return;
    mutation.current = true; setBusy(true);
    const started = sourceRef.current;
    try {
      const result = await setResourcePatrolManager(apiBaseUrl, session.token, session.profile.id);
      if (sourceRef.current === started) { setPatrol(result); setNotice('后台巡检已跟随你的当前工作账号。'); }
    } catch (failure) { if (sourceRef.current === started) setError(failure instanceof Error ? failure.message : '巡检配置失败。'); }
    finally { mutation.current = false; setBusy(false); }
  }
  async function inspect(id: string) {
    if (!session.token || mutation.current) return;
    mutation.current = true; setBusy(true); setError(null);
    const started = sourceRef.current;
    try {
      const preview = await previewResourceReclaim(apiBaseUrl, session.token, id);
      if (sourceRef.current !== started) return;
      if (preview.cloudWorkspaceId !== workspaceId) throw new Error('预览账号已变化，请重新查看。');
      setReview({ preview, workspaceId, idempotencyKey: crypto.randomUUID() });
    } catch (failure) { if (sourceRef.current === started) setError(failure instanceof Error ? failure.message : '资源核验失败。'); }
    finally { mutation.current = false; setBusy(false); }
  }
  async function confirm() {
    const selected = review;
    if (!session.token || !selected?.preview.reclaimable || mutation.current || selected.workspaceId !== workspaceId) return;
    mutation.current = true; setBusy(true);
    const started = sourceRef.current;
    try {
      let result;
      try {
        result = await reclaimResourceAlert(apiBaseUrl, session.token, selected.preview, selected.workspaceId, { idempotencyKey: selected.idempotencyKey });
      } catch (failure) {
        const challenge = failure instanceof AdminApiError ? failure.details as { code?: string; confirmationId?: string; idempotencyKey?: string; summary?: ResourceReclaimPreview } : null;
        if (challenge?.code !== 'CONFIRMATION_REQUIRED' || !challenge.confirmationId
          || challenge.idempotencyKey !== selected.idempotencyKey || challenge.summary?.planDigest !== selected.preview.planDigest) throw failure;
        if (sourceRef.current !== started) return;
        result = await reclaimResourceAlert(apiBaseUrl, session.token, selected.preview, selected.workspaceId,
          { idempotencyKey: selected.idempotencyKey, confirmationId: challenge.confirmationId });
      }
      if (sourceRef.current !== started) return;
      if (result.alertId !== selected.preview.alertId) throw new Error('回收任务响应不一致，请核查原任务。');
      setReview(null); setNotice('回收作业已受理，云端核验完成后关闭告警。'); await refresh();
    } catch (failure) {
      if (sourceRef.current === started) {
        setError(failure instanceof Error ? failure.message : '回收结果未知，请查看原告警与作业。');
        setReview(null); void refresh();
      }
    } finally { mutation.current = false; setBusy(false); }
  }
  if (!session.isReady || !session.token) return null;
  if (!session.profile?.isPlatformManager) return <p className="admin-empty">仅平台超管可查看和处理资源告警。</p>;
  const visible = (rows ?? []).filter(row => filter === 'all' || (filter === 'open' ? row.status !== 'resolved' : row.status === filter));
  return <section aria-label="资源告警" className="mt-3 grid min-w-0 gap-3">
    <div className="flex flex-wrap items-center gap-2">
      <h2 className="mr-auto text-sm font-semibold">资源告警</h2>
      <AdminSelectField ariaLabel="告警状态" className="h-8 w-28" value={filter} onValueChange={value => setFilter(value as typeof filter)} options={[{ value: 'open', label: '未解决' }, { value: 'all', label: '全部' }, ...Object.entries(labels).map(([value, label]) => ({ value, label }))]} />
      <Button disabled={loading || busy} size="sm" variant="outline" onClick={() => void refresh()}><RefreshCw aria-hidden="true" />刷新</Button>
    </div>
    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
      <div className="min-w-0">
        <span>后台巡检：{patrol?.managerUsername ?? '未指定超管'}</span>
        {patrol?.accountUid ? <span className="ml-3">{patrol.accountUid} · 每 1 小时</span> : null}
        {patrol?.lastScanAt && patrol.lastCompleted ? <span className="ml-3 text-muted-foreground">最近检查 {formatAdminDateTime(patrol.lastScanAt)}</span> : null}
        {patrol && ['pending', 'not_configured', 'unavailable'].includes(patrol.status) ? <span className="ml-3 text-amber-800">{patrol.status === 'pending' ? '当前账号待检查' : '巡检尚未就绪'}</span> : null}
      </div>
      <Button size="sm" disabled={busy || patrol?.managerUserId === session.profile.id} variant="ghost" onClick={() => void followMe()}>跟随我的账号</Button>
    </div>
    {patrol?.lastScanError ? <AdminNotice tone="error" className="mb-3">巡检失败：{patrol.lastScanError} 现有告警已保留。</AdminNotice> : null}
    {error ? <AdminNotice tone="error" className="mb-3">{error}</AdminNotice> : null}
    <AdminActionNotice message={notice} tone="info" onDismiss={() => setNotice(null)} />
    <AdminDataTable columns={columns} label="资源告警列表" isRefreshing={loading && rows !== null}>
      {cols => rows === null && !error ? <TableLoadingState columnCount={cols.length} rowCount={5} label="读取资源告警" /> : !visible.length ? <AdminDataTableState columns={cols} variant={error ? 'error' : 'empty'} title={error ? '检查未完成' : '暂无平台资源告警'} description={error ?? '范围仅限已证明由平台创建的资源；检查状态见上方。'} onRetry={error ? () => void refresh() : undefined} /> :
        visible.map(row => <TableRow key={row.id}>
          <AdminDataTableCell column={cols[0]}><div className="flex items-center gap-2">{types[row.type] ?? row.type}<span className={`admin-pill admin-pill-${row.status === 'resolved' ? 'success' : row.status === 'failed' ? 'danger' : 'warning'}`}>{labels[row.status]}</span></div><div className="mt-1 break-all whitespace-normal text-xs text-muted-foreground">{row.resourceId}</div></AdminDataTableCell>
          <AdminDataTableCell column={cols[1]}><div className="truncate" title={row.rangeInstanceId ?? undefined}>{row.rangeName ?? row.rangeInstanceId ?? '无完整关联记录'}</div><div className="mt-1 text-xs text-muted-foreground">{row.accountUid} · {row.regionId}</div></AdminDataTableCell>
          <AdminDataTableCell className="whitespace-normal" column={cols[2]}><p className="text-sm">{row.reason}</p><p className="mt-1 text-xs text-muted-foreground" title={`首次发现 ${formatAdminDateTime(row.firstSeenAt)}`}>{row.evidenceSummary.recordedInventory ? '已记录准确库存' : '创建来源待核验'} · 最近发现 {formatAdminDateTime(row.lastSeenAt)}</p>{row.errorSummary ? <p className="mt-1 text-xs text-destructive">{row.errorSummary}</p> : null}</AdminDataTableCell>
          <AdminDataTableCell column={cols[3]}><Button disabled={busy || row.status === 'reclaiming' || row.status === 'resolved'} size="sm" variant="outline" onClick={() => void inspect(row.id)}>查看清单</Button></AdminDataTableCell>
        </TableRow>)}
    </AdminDataTable>
    <AdminDialog open={Boolean(review)} title="确认残留资源回收" description="只回收以下准确资源；来源和占用会在确认后再次核验。" pending={busy} onOpenChange={open => { if (!open) setReview(null); }}
      footer={<><Button disabled={busy} variant="outline" onClick={() => setReview(null)}>取消</Button><Button disabled={busy || !review?.preview.reclaimable} variant="destructive" onClick={() => void confirm()}>确认回收</Button></>}>
      {review ? <><p className="mb-3 text-sm">{review.preview.accountUid} · {review.preview.regionId}</p>
        {review.preview.reason ? <AdminNotice tone="error" className="mb-3">{review.preview.reason}</AdminNotice> : null}
        <ul className="grid gap-2 text-sm">{review.preview.resources.map(item => <li className="break-all" key={`${item.type}:${item.id}`}>{types[item.type] ?? item.type} · {item.id}</li>)}</ul>
      </> : null}
    </AdminDialog>
  </section>;
}
