'use client';

import React, { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { DateTimePicker } from '@/components/ui/date-time-picker';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { AdminDialog } from './shared/admin-dialog';
import type { InstancePowerTarget } from '@/lib/admin-types';
import { fetchInstanceExpiry, previewInstanceExpiry, submitInstanceExpiry, verifyInstanceExpiry,
  type ExpiryOperation, type ExpiryPreview, type ExpiryView } from '@/lib/instance-expiry-api';

const time = (value?: string | null) => value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '未设置';
const localTime = (value: string) => new Date(Date.parse(value) + 8 * 3600_000).toISOString().slice(0, 16);
const states: Record<string, string> = { pending: '等待同步 / 核验', running: '同步中', succeeded: '已生效', failed: '未完成 / 待核验', cancelled: '已取消' };
type Props = { apiBaseUrl: string; token: string; scopeKey: string; target: InstancePowerTarget; name: string; disabled?: boolean;
  onClose: () => void; onChanged?: () => void };

export function InstanceExpiryDialog(props: Props) {
  return <ExpiryDialogContent key={JSON.stringify([props.apiBaseUrl, props.token, props.scopeKey, props.target])} {...props} />;
}

function ExpiryDialogContent({ apiBaseUrl, token, target, name, disabled, onClose, onChanged }: Props) {
  const [view, setView] = useState<ExpiryView | null>(null), [date, setDate] = useState('');
  const [preview, setPreview] = useState<ExpiryPreview | null>(null), [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false), [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false), [revision, setRevision] = useState(0);
  const mounted = useRef(true), busy = useRef(false), operation = useRef<ExpiryOperation | null>(null);
  const submission = useRef(new AbortController());
  const initialized = useRef(false), onChangedRef = useRef(onChanged), signature = useRef('');
  onChangedRef.current = onChanged;
  useEffect(() => { mounted.current = true; submission.current = new AbortController(); return () => { mounted.current = false; submission.current.abort(); }; }, []);
  useEffect(() => {
    let disposed = false, reading = false;
    const load = async () => {
      if (disposed || reading || busy.current) return;
      reading = true;
      try {
        const result = await fetchInstanceExpiry(apiBaseUrl, token, target);
        if (disposed) return;
        setView(result);
        if (!initialized.current) {
          const times = [...new Set(result.instances.filter(row => row.status === 'running').map(row => row.expiresAt))];
          if (times.length === 1 && times[0]) setDate(localTime(times[0]));
          initialized.current = true;
        }
        const next = JSON.stringify([result.instances.map(row => [row.id, row.expiresAt]), result.jobs.map(job => [job.id, job.status])]);
        if (signature.current && signature.current !== next) onChangedRef.current?.();
        signature.current = next;
      } catch (failure) { if (!disposed) setError(failure instanceof Error ? failure.message : '读取回收时间失败。'); }
      finally { reading = false; }
    };
    void load();
    const timer = window.setInterval(() => { if (document.visibilityState !== 'hidden') void load(); }, 5000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [apiBaseUrl, token, target.kind, target.id, revision]);

  async function act(run: () => Promise<void>) {
    if (busy.current || disabled) return;
    busy.current = true; setPending(true); setError(null);
    try { await run(); }
    catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : '请求结果未确认，请查看原任务。'); }
    finally { if (mounted.current) { busy.current = false; setPending(false); } }
  }
  async function prepare() {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(date)) throw new Error('请选择完整的新回收时间。');
    const at = new Date(date + ':00+08:00');
    if (!Number.isFinite(at.getTime()) || at.getTime() < Date.now() + 30 * 60_000) throw new Error('新回收时间需至少在 30 分钟后（北京时间）。');
    const result = await previewInstanceExpiry(apiBaseUrl, token, target, at.toISOString());
    if (!mounted.current) return;
    setPreview(result); setConfirmed(false); setNotice(null); operation.current = { idempotencyKey: crypto.randomUUID() };
  }
  async function submit() {
    if (!preview || !confirmed || !operation.current) return;
    try {
      await submitInstanceExpiry(apiBaseUrl, token, preview, operation.current, submission.current.signal);
      if (!mounted.current) return;
      setUncertain(false); setPreview(null); setConfirmed(false);
      setNotice('修改任务已受理，请以“已生效”为准。延期尚未完成时仍按原时间回收；提前回收已按新时间安排。');
      setRevision(value => value + 1); onChangedRef.current?.();
    } catch (failure) { if (mounted.current) setUncertain(true); throw failure; }
  }
  async function verify(jobId: string) {
    await verifyInstanceExpiry(apiBaseUrl, token, target, jobId);
    if (!mounted.current) return;
    setNotice('已请求核验原任务；本次不会重新发送云端修改。'); setRevision(value => value + 1);
  }
  const processing = view?.jobs.some(job => ['pending', 'running'].includes(job.status));
  return <AdminDialog open title={target.kind.endsWith('_batch') ? '修改整批回收时间' : '修改回收时间'} description={name} pending={pending} onOpenChange={open => { if (!open) onClose(); }}
    footer={<><Button type="button" variant="outline" disabled={pending} onClick={onClose}>关闭</Button>
      {preview ? <><Button type="button" variant="outline" disabled={pending || uncertain} onClick={() => { setPreview(null); setConfirmed(false); }}>返回修改</Button>
        <Button type="button" disabled={pending || disabled || !confirmed} onClick={() => void act(submit)}>{pending ? '正在提交…' : uncertain ? '核对提交结果' : '确认修改'}</Button></>
        : <Button type="button" disabled={pending || disabled || !view || !date || processing} onClick={() => void act(prepare)}>{pending ? '正在核验…' : '预览修改'}</Button>}</>}>
    <div className="space-y-4">
      {error ? <p role="alert" className="whitespace-pre-wrap text-sm text-destructive">{error}</p> : null}
      {notice ? <p role="status" className="text-sm">{notice}</p> : null}
      {uncertain ? <p className="text-sm text-destructive">提交结果未确认，请核对原提交结果或查看下方任务，勿重新建立请求。</p> : null}
      {!view ? <p role="status">正在读取当前回收时间…</p> : null}
      {!preview ? <>
        <div className="space-y-2"><label htmlFor="instance-expiry-time" className="text-sm font-medium">新回收时间（北京时间）</label>
          <DateTimePicker id="instance-expiry-time" aria-label="新回收时间（北京时间）" value={date} disabled={pending || disabled || processing}
            onValueChange={value => { initialized.current = true; setDate(value); setError(null); }} />
          <p className="text-xs text-muted-foreground">至少 30 分钟后。原回收时间不足 5 分钟、已有活动任务或节省停机预约时不可修改。</p></div>
        {view ? <div className="max-h-48 overflow-auto rounded-md border"><Table><TableHeader><TableRow><TableHead>实例</TableHead><TableHead>当前平台回收时间</TableHead></TableRow></TableHeader>
          <TableBody>{view.instances.map(row => <TableRow key={row.id}><TableCell className="whitespace-normal">{row.name}</TableCell><TableCell>{time(row.expiresAt)}</TableCell></TableRow>)}</TableBody></Table></div> : null}
      </> : <>
        <div className="rounded-md border bg-muted/30 p-3"><p className="text-sm text-muted-foreground">统一修改为 · 北京时间</p><p className="mt-1 font-semibold">{time(preview.expiresAt)}</p>
          <p className="mt-1 text-sm">影响 {preview.plans.length} 个实例，共 {preview.plans.reduce((sum, plan) => sum + plan.hosts.length, 0)} 台云主机</p></div>
        <div className="max-h-48 overflow-auto rounded-md border"><Table><TableHeader><TableRow><TableHead>实例</TableHead><TableHead>原回收时间</TableHead><TableHead>变更</TableHead></TableRow></TableHeader><TableBody>
          {preview.plans.map(plan => <TableRow key={plan.instanceId}><TableCell className="whitespace-normal">{plan.instanceName}</TableCell><TableCell>{time(plan.expiresAt)}</TableCell>
            <TableCell className={Date.parse(plan.expiresAt) > Date.parse(preview.expiresAt) ? 'text-destructive' : ''}>{Date.parse(plan.expiresAt) > Date.parse(preview.expiresAt) ? '提前回收' : '延长使用'}</TableCell></TableRow>)}</TableBody></Table></div>
        {preview.skipped.length ? <p className="text-sm text-muted-foreground">不修改：{preview.skipped.map(row => row.name + '（' + row.reason + '）').join('、')}</p> : null}
        <ul className="list-disc space-y-1 pl-5 text-sm">{preview.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul>
        <label className="flex items-start gap-2 text-sm"><Checkbox checked={confirmed} disabled={pending || uncertain} onCheckedChange={value => setConfirmed(value === true)} aria-label="确认回收范围和时间" />
          已核对实例范围和时间；到点后将销毁实例及关联资源，不是停机。</label>
      </>}
      {view?.jobs.length ? <section aria-label="回收时间修改记录" className="space-y-2 border-t pt-3"><div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">修改记录</h3><Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => setRevision(value => value + 1)}>刷新</Button></div>
        {view.jobs.slice(0, 20).map(job => <details key={job.id} className="text-sm"><summary className="cursor-pointer py-1">{view.instances.find(row => row.id === job.instanceId)?.name ?? job.instanceId} · {states[job.status] ?? job.status}</summary>
          <div className="space-y-2 pb-3 pl-4"><p>申请回收时间：{time(job.requestedExpiresAt)}</p><p className="break-all text-xs text-muted-foreground">任务 {job.id}</p>
            {job.error ? <p className="text-destructive">{job.error}</p> : null}
            {job.status === 'failed' ? <Button type="button" size="sm" variant="outline" disabled={pending || disabled} onClick={() => void act(() => verify(job.id))}>核验原任务</Button> : null}</div></details>)}</section> : null}
    </div>
  </AdminDialog>;
}
