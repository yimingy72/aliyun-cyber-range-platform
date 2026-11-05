'use client';

import { ADMIN_TABLE_WIDTHS } from './shared/admin-data-table';

import React, { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { ArrowLeft, RefreshCw } from 'lucide-react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { fetchPackedImageTasks, verifyPackedImageTask } from '@/lib/admin-api';
import type { PackedImageTask } from '@/lib/admin-types';
import { readCloudWorkspaceSelection } from '@/lib/cloud-workspace-selection';
import { useCloudWorkspace } from './cloud-workspace-provider';
import { AdminDialog } from './shared/admin-dialog';
import { AdminPaginationControls, getPagination, useAdminPageSize } from './admin-pagination';

const STATES: Record<PackedImageTask['state'], string> = {
  pending: '等待回执', creating: '创建 / 核验中', unconfirmed: '提交结果待确认', blocked: '核验受阻',
  rejected: '云端已拒绝', failed: '导出失败', available: '已完成', needs_review: '配置待核对', deleting: '回收中', deleted: '已回收',
};
const PHASES: Record<string, string> = {
  unknown: '历史记录未提供阶段', source_disk_inventory: '源磁盘清单核验', create_image: '云端创建镜像',
  create_response: '接收创建回执', persist_image: '保存镜像标识', persist_asset: '恢复平台镜像资产',
  account_context: '原云账号与地域核验', describe_image: '查询原云镜像', rejection_audit: '查询原请求官方审计回执',
  verify_image: '镜像唯一来源与归属核验', snapshot_verify: '镜像依赖快照核验', snapshot_ledger: '保存快照计费来源',
  snapshot_tagging: '快照来源标记', persist_catalog: '收录平台镜像目录', cleanup: '回收镜像及所属快照',
};

export function packedImageFailureHint(task: PackedImageTask) {
  const code = task.diagnostic?.cloudErrorCode;
  if (!code || code === 'UNKNOWN') return '暂未取得云端错误码，请根据失败阶段核对原账号配置和网络。';
  if (/Forbidden|Unauthorized|AuthFailure|InvalidAccessKey|SignatureDoesNotMatch/.test(code)) return '云账号授权或认证未通过。修正权限后，核验此导出任务。';
  if (/Throttl|LimitExceeded|RequestLimit/.test(code)) return '云接口限流，请稍后点击“核验并恢复”。';
  if (/InvalidImageName/.test(code)) return '云端不接受此镜像名称，请核对命名规则后从源实例重新导出。';
  if (code === 'IncorrectInstanceStatus') return '源实例当前状态不支持导出，请在状态稳定后重新发起。';
  if (code === 'SnapshotBindingsIncomplete') return '镜像已生成，关联快照尚未全部确认，请稍后核验。';
  if (code === 'MultipleImagesMatched') return '同一任务匹配到多个云镜像，需要人工确认正确来源。';
  if (code === 'ImageNotVisible') return '暂时无法查询到该镜像，请核对原云账号、地域和镜像可见性。';
  if (code === 'OriginalDefaultsMissing') return '原始默认配置不完整，请到“我的镜像”核对配置与启用状态。';
  if (code === 'OriginalConfigUnverifiable') return '原镜像配置无法读取，需要恢复平台加密密钥后核验。';
  if (/^(SourceAccount|AssetSource|AssetOwnership|AssetBinding)Mismatch$/.test(code)) return '云账号、地域或镜像来源与原记录不一致，需要人工核对。';
  if (code === 'AuditUnavailable') return '暂时无法读取云端审计回执，请检查 ActionTrail 查询权限后再核验。';
  return '请根据错误码和云请求 ID 核对原因，再核验此任务。';
}

function time(value: string | null) {
  return value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '—';
}

type Props = {
  apiBaseUrl: string; token: string; open: boolean; onOpenChange: (open: boolean) => void;
  sourceRangeInstanceId?: string; initialTaskId?: string | null;
};

export function PackedImageTasksDialog({ apiBaseUrl, token, open, onOpenChange, sourceRangeInstanceId, initialTaskId }: Props) {
  const workspace = useCloudWorkspace()?.workspace;
  const scope = JSON.stringify([apiBaseUrl, token, workspace?.id, readCloudWorkspaceSelection(), sourceRangeInstanceId]);
  const scopeRef = useRef(scope); scopeRef.current = scope;
  const openRef = useRef(open); openRef.current = open;
  const requestRef = useRef(0);
  const readScopeRef = useRef<string | null>(null);
  const verifyingRef = useRef<string | null>(null);
  const [tasks, setTasks] = useState<PackedImageTask[]>([]);
  const [loadedScope, setLoadedScope] = useState(scope);
  const tasksRef = useRef(tasks); tasksRef.current = tasks;
  const [selectedId, setSelectedId] = useState<string | null>(initialTaskId ?? null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(open);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const { pageSize, setPageSize } = useAdminPageSize();

  useEffect(() => {
    if (!open || !token) return;
    let disposed = false, reading = false;
    if (readScopeRef.current !== scope) {
      setTasks([]); setPage(1); setSearch(''); setSelectedId(initialTaskId ?? null);
      readScopeRef.current = scope;
    }
    setError(null); setNotice(null); setPendingId(null); verifyingRef.current = null;
    const read = async () => {
      if (disposed || reading || verifyingRef.current) return;
      reading = true;
      const request = ++requestRef.current;
      setLoading(true);
      try {
        const result = await fetchPackedImageTasks(apiBaseUrl, token, sourceRangeInstanceId);
        if (!disposed && requestRef.current === request) { setTasks(result); setLoadedScope(scope); setError(null); }
      } catch (failure) {
        if (!disposed && requestRef.current === request) setError(failure instanceof Error ? failure.message : '导出记录读取失败，请稍后刷新。');
      } finally {
        reading = false;
        if (!disposed && requestRef.current === request) setLoading(false);
      }
    };
    void read();
    const interval = window.setInterval(() => {
      if (document.visibilityState !== 'hidden' && tasksRef.current.some(task => ['pending', 'creating', 'deleting'].includes(task.status))) void read();
    }, 5000);
    return () => { disposed = true; ++requestRef.current; window.clearInterval(interval); };
  }, [open, scope, attempt, initialTaskId]);

  async function verify(task: PackedImageTask) {
    if (verifyingRef.current || !task.canVerify || workspace?.isReadOnly) return;
    verifyingRef.current = task.id;
    const request = ++requestRef.current;
    setPendingId(task.id); setError(null); setNotice(null);
    try {
      const result = await verifyPackedImageTask(apiBaseUrl, token, task.id);
      if (openRef.current && scopeRef.current === scope && requestRef.current === request) {
        setTasks(rows => rows.map(row => row.id === result.id ? result : row));
        setNotice(`核验完成：${STATES[result.state]}。`);
      }
    } catch (failure) {
      if (openRef.current && scopeRef.current === scope && requestRef.current === request) setError(failure instanceof Error ? failure.message : '原任务核验未完成，请稍后继续核验同一任务。');
    } finally {
      if (scopeRef.current === scope && requestRef.current === request) {
        verifyingRef.current = null; setPendingId(null); setLoading(false);
      }
    }
  }

  const normalizedSearch = search.trim().toLowerCase();
  const visibleTasks = loadedScope === scope ? tasks : [];
  const filtered = visibleTasks.filter(task => `${task.displayName} ${task.sourceName} ${task.sourceHostKey} ${task.id} ${task.imageId ?? ''}`.toLowerCase().includes(normalizedSearch));
  const pagination = getPagination(filtered.length, page, pageSize);
  const selected = visibleTasks.find(task => task.id === selectedId);
  const initialMissing = initialTaskId && !loading && !error && !tasks.some(task => task.id === initialTaskId);
  return <AdminDialog open={open} onOpenChange={onOpenChange} title="镜像导出" size="wide"
    footer={<Button type="button" variant="outline" onClick={() => onOpenChange(false)}>关闭</Button>}>
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {selected ? <Button type="button" variant="ghost" size="sm" onClick={() => setSelectedId(null)}><ArrowLeft aria-hidden="true" />返回导出记录</Button>
          : <Input aria-label="搜索导出记录" placeholder="搜索镜像、来源或任务 ID" value={search} onChange={event => { setSearch(event.target.value); setPage(1); }} className="sm:max-w-sm" />}
        <div className="flex items-center gap-3">
          {!selected ? <span className="text-xs text-muted-foreground" role="status">共 {filtered.length} 项</span> : null}
          <Button type="button" variant="outline" size="sm" disabled={loading || Boolean(pendingId)} onClick={() => setAttempt(value => value + 1)}><RefreshCw aria-hidden="true" />{loading ? '刷新中…' : '刷新'}</Button>
        </div>
      </div>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      {notice ? <p role="status" className="text-sm text-emerald-700">{notice}</p> : null}
      {initialMissing ? <p role="alert" className="text-sm text-destructive">当前工作空间未找到任务 {initialTaskId}，请核对账号与访问权限。</p> : null}
      {selected ? <section id="packed-image-task-detail" className="space-y-5" aria-label="镜像导出详情">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b pb-4">
          <div className="min-w-0 flex-1 space-y-2">
            <h3 className="break-words text-lg font-semibold">{selected.displayName}</h3>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={['failed', 'rejected'].includes(selected.state) ? 'destructive' : selected.state === 'available' ? 'default' : 'secondary'}>{STATES[selected.state]}</Badge>
              {selected.cloudImageStatus ? <span className="text-xs text-muted-foreground">云端：{selected.cloudImageStatus}</span> : null}
            </div>
            <p className="text-sm text-muted-foreground">{selected.message}</p>
          </div>
          {selected.canVerify ? <Button type="button" disabled={Boolean(pendingId) || workspace?.isReadOnly} onClick={() => void verify(selected)} title="核对原请求的云端结果并恢复镜像收录">{pendingId === selected.id ? '核验中…' : '核验并恢复'}</Button> : null}
        </div>
        {selected.diagnostic ? <section className="space-y-2 border-l-2 border-destructive/60 pl-3 text-sm" aria-label="失败原因">
          <h4 className="font-medium">{PHASES[selected.diagnostic.phase] ?? '未知阶段'}未完成</h4>
          <p className="break-all font-mono text-xs">{selected.diagnostic.cloudErrorCode}</p>
          <p className="text-muted-foreground">{packedImageFailureHint(selected)}</p>
        </section> : selected.state !== 'available' ? <p className="text-sm text-muted-foreground">{selected.nextStep}</p> : null}
        <dl className="grid gap-x-6 gap-y-4 text-sm sm:grid-cols-2">
          <div><dt className="text-xs text-muted-foreground">来源实例</dt><dd className="mt-1 break-words">{selected.sourceName}</dd></div>
          <div><dt className="text-xs text-muted-foreground">来源节点</dt><dd className="mt-1 break-words">{selected.instanceMode === 'single' ? '单实例' : selected.sourceHostKey}</dd></div>
          <div><dt className="text-xs text-muted-foreground">云账号地域</dt><dd className="mt-1">{selected.cloudProvider === 'tencent_cloud' ? '腾讯云' : '阿里云'} · {selected.regionId}</dd></div>
          <div><dt className="text-xs text-muted-foreground">镜像 ID</dt><dd className="mt-1 break-all font-mono text-xs">{selected.imageId || '等待云端回执'}</dd></div>
          <div><dt className="text-xs text-muted-foreground">创建时间</dt><dd className="mt-1">{time(selected.createdAt)}</dd></div>
          <div><dt className="text-xs text-muted-foreground">最近核验</dt><dd className="mt-1">{time(selected.lastPolledAt)}</dd></div>
          {selected.completedAt ? <div><dt className="text-xs text-muted-foreground">完成时间</dt><dd className="mt-1">{time(selected.completedAt)}</dd></div> : null}
        </dl>
        <details className="border-t pt-3">
          <summary className="cursor-pointer text-sm font-medium">技术信息与快照</summary>
          <dl className="mt-3 grid gap-3 text-xs">
            <div><dt className="text-muted-foreground">任务 ID</dt><dd className="mt-1 break-all font-mono">{selected.id}</dd></div>
            <div><dt className="text-muted-foreground">源云实例 ID</dt><dd className="mt-1 break-all font-mono">{selected.sourceInstanceId}</dd></div>
            {selected.diagnostic ? <>
              <div><dt className="text-muted-foreground">云请求 ID</dt><dd className="mt-1 break-all font-mono">{selected.diagnostic.cloudRequestId || '未返回'}</dd></div>
              {selected.diagnostic.verificationCheck ? <div><dt className="text-muted-foreground">来源检查项</dt><dd className="mt-1 break-all">{selected.diagnostic.verificationCheck}</dd></div> : null}
            </> : null}
            <div><dt className="text-muted-foreground">关联快照</dt><dd className="mt-1 break-all font-mono">{selected.backingSnapshotIds.length ? selected.backingSnapshotIds.join('、') : '尚未返回'}{selected.deletedSnapshotIds.length ? `（已回收 ${selected.deletedSnapshotIds.length} 项）` : ''}</dd></div>
          </dl>
          {selected.state === 'available' ? <p className="mt-3 text-xs text-muted-foreground">镜像和关联快照保留期间可能继续计费。</p> : null}
        </details>
      </section> : <>
      <div className="max-h-80 overflow-auto rounded-md border" tabIndex={0} aria-label="镜像导出记录">
        <Table className="min-w-[40rem] table-fixed">
          <colgroup><col /><col style={{ width: ADMIN_TABLE_WIDTHS.status }} /><col style={{ width: ADMIN_TABLE_WIDTHS.dateTime }} /><col style={{ width: '7rem' }} /></colgroup>
          <TableHeader className="sticky top-0 z-10 bg-muted"><TableRow><TableHead>镜像 / 来源</TableHead><TableHead>状态</TableHead><TableHead>创建时间</TableHead><TableHead>操作</TableHead></TableRow></TableHeader>
          <TableBody>
            {!filtered.length ? <TableRow><TableCell className="h-32 text-center text-sm text-muted-foreground" colSpan={4}>{loading ? '正在读取导出记录…' : error ? '记录暂不可读，请刷新重试。' : search ? '没有匹配的导出记录。' : '暂无导出记录。可从实例的“打包为镜像”操作创建。'}</TableCell></TableRow> : null}
            {filtered.slice(pagination.startIndex, pagination.endIndex).map(task => <TableRow key={task.id}>
              <TableCell><strong className="block truncate" title={task.displayName}>{task.displayName}</strong><p className="truncate text-xs text-muted-foreground" title={`${task.sourceName} · ${task.sourceHostKey}`}>{task.sourceName} · {task.sourceHostKey}</p></TableCell>
              <TableCell><Badge variant={['failed', 'rejected'].includes(task.state) ? 'destructive' : task.state === 'available' ? 'default' : 'secondary'}>{STATES[task.state]}</Badge>{task.cloudImageStatus ? <p className="mt-1 text-xs text-muted-foreground">云端：{task.cloudImageStatus}</p> : null}</TableCell>
              <TableCell className="whitespace-normal text-xs">{time(task.createdAt)}</TableCell>
              <TableCell><Button type="button" size="sm" variant="outline" aria-label={`查看详情 ${task.displayName}`} onClick={() => setSelectedId(task.id)}>查看详情</Button></TableCell>
            </TableRow>)}
          </TableBody>
        </Table>
      </div>
      <AdminPaginationControls label="镜像导出分页" pageSize={pageSize} pagination={pagination} onPageSizeChange={value => { setPageSize(value); setPage(1); }} onPageSelect={setPage} />
      </>}
    </div>
  </AdminDialog>;
}
