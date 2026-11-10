'use client';

import { AdminNotice } from './shared/admin-notice';
import React, { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { DateTimePicker } from '@/components/ui/date-time-picker';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { CalendarClock, ChevronDown, ClipboardList, Play, Power } from 'lucide-react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { AdminDialog } from './shared/admin-dialog';
import { ADMIN_TABLE_WIDTHS } from './shared/admin-data-table';
import { InstanceExpiryDialog } from './instance-expiry-dialog';
import { StatusBadge } from './shared/status-badge';
import { instancePowerStatus } from '@/lib/instance-power-state';
import type { InstancePowerAction, InstancePowerControl, InstancePowerPreview, InstancePowerTarget, InstancePowerView, RangeInstance } from '@/lib/admin-types';
import { cancelInstancePowerSchedule, fetchInstancePower, previewInstancePower, submitInstancePower, verifyInstancePowerJob, type PowerOperation } from '@/lib/instance-power-api';

const time = (value?: string | null) => value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '—';
const STATE: Record<string, string> = { running: '运行中', economical_stopped: '节省停机', stopped_standard: '普通停机（未节省）', partial: '部分主机状态不同', unknown: '启停结果待核验', stopping: '节省停机中', starting: '恢复开机中' };
const JOB: Record<string, string> = { pending: '等待执行 / 核验', running: '正在处理', succeeded: '已核验完成', failed: '失败或待核验', cancelled: '已取消' };
const SCHEDULE: Record<string, string> = { scheduled: '已预约', queued: '已进入执行队列', succeeded: '已执行并核验', failed: '预约未完成', cancelled: '已取消' };

export function instancePowerLabel(control?: InstancePowerControl | null) {
  return control ? STATE[control.phase ?? control.state] ?? '启停待核验' : null;
}
export function InstancePowerBadge({ instance }: { instance: RangeInstance }) {
  if (!instance.powerControl || instance.status !== 'running') return <StatusBadge status={instance.status} />;
  const control = instance.powerControl;
  return <div className="mt-1 space-y-1 text-xs">
    <StatusBadge status={instancePowerStatus(instance)} />
    {control.schedule?.status === 'scheduled' ? <p className="whitespace-normal">预约节省停机：{time(control.schedule.at)}</p> : null}
    {control.error ? <p className="whitespace-normal text-destructive">{control.error}</p> : null}
    {control.schedule?.status === 'failed' ? <p className="whitespace-normal text-destructive">{control.schedule.message ?? '预约未完成，请查看启停任务。'}</p> : null}
  </div>;
}

type Mode = 'stop' | 'schedule' | 'resume' | 'manage';
type Props = { apiBaseUrl: string; token: string | null; scopeKey: string; target: InstancePowerTarget; name: string; disabled?: boolean; onChanged?: () => void };
type MenuProps = Props & { label?: string; showPowerActions?: boolean; busy?: boolean;
  sources?: Pick<RangeInstance, 'status' | 'powerControl'>[]; children?: React.ReactNode; destructive?: React.ReactNode };

export function InstancePowerMenu(props: MenuProps) {
  return <InstancePowerMenuContent key={`${props.scopeKey}:${props.target.kind}:${props.target.id}`} {...props} />;
}

function InstancePowerMenuContent(props: MenuProps) {
  const [mode, setMode] = useState<Mode | null>(null);
  const [expiryOpen, setExpiryOpen] = useState(false);
  const label = props.label ?? '启停管理', showPower = props.showPowerActions !== false;
  const sources = props.sources?.filter(source => !['destroyed', 'create_failed'].includes(source.status)) ?? [];
  const busy = props.busy || sources.some(source => source.status !== 'running' || source.powerControl?.phase);
  const unknown = sources.some(source => source.powerControl?.state === 'unknown');
  const running = sources.length > 0 && sources.every(source => !source.powerControl || source.powerControl.state === 'running');
  const stopped = sources.length > 0 && sources.every(source => source.powerControl?.state === 'economical_stopped');
  const standardStopped = sources.some(source => source.powerControl?.state === 'stopped_standard');
  const batch = props.target.kind.endsWith('_batch'), suffix = batch ? '（整批）' : '';
  const unavailable = busy || unknown;
  return <>
    <DropdownMenu><DropdownMenuTrigger asChild><Button aria-label={label === '更多' ? batch ? '更多批次操作' : '更多操作' : label} size="sm" variant="outline" type="button" disabled={props.disabled || !props.token}>{label}<ChevronDown aria-hidden="true" className="size-3" /></Button></DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60" onCloseAutoFocus={event => {
        if (mode || expiryOpen || document.querySelector('dialog[open], [role="dialog"][data-state="open"]')) event.preventDefault();
      }}>
        {showPower ? <>
          <DropdownMenuItem disabled={unavailable || stopped || standardStopped} onSelect={() => setMode('stop')}><Power aria-hidden="true" />节省停机{suffix}</DropdownMenuItem>
          <DropdownMenuItem disabled={unavailable || standardStopped} onSelect={() => setMode('schedule')}><CalendarClock aria-hidden="true" />预约节省停机{suffix}</DropdownMenuItem>
          <DropdownMenuItem disabled={unavailable || running} onSelect={() => setMode('resume')}><Play aria-hidden="true" />恢复开机{suffix}</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setMode('manage')}><ClipboardList aria-hidden="true" />{batch ? '查看批次启停任务' : '查看启停任务'}</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setExpiryOpen(true)}><CalendarClock aria-hidden="true" />修改回收时间{suffix}</DropdownMenuItem>
        </> : null}
        {showPower && props.children ? <DropdownMenuSeparator /> : null}
        {props.children}
        {props.destructive ? <>{showPower || props.children ? <DropdownMenuSeparator /> : null}{props.destructive}</> : null}
      </DropdownMenuContent></DropdownMenu>
    {mode && props.token ? <InstancePowerDialog key={`${props.scopeKey}:${props.target.kind}:${props.target.id}`} {...props} token={props.token} initialMode={mode} onClose={() => setMode(null)} /> : null}
    {expiryOpen && props.token ? <InstanceExpiryDialog {...props} token={props.token} onClose={() => setExpiryOpen(false)} /> : null}
  </>;
}

export function InstancePowerDialog({ apiBaseUrl, token, scopeKey, target, name, disabled, onChanged, initialMode, onClose }: Props & { token: string; initialMode: Mode; onClose: () => void }) {
  const [mode, setMode] = useState(initialMode), [view, setView] = useState<InstancePowerView | null>(null);
  const [date, setDate] = useState(''), [preview, setPreview] = useState<InstancePowerPreview | null>(null), [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false), [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false), [attempt, setAttempt] = useState(0), [uncertain, setUncertain] = useState(false);
  const operation = useRef<PowerOperation | null>(null), busy = useRef(false), generation = useRef(0), changedRef = useRef(onChanged);
  changedRef.current = onChanged;
  const scope = JSON.stringify([apiBaseUrl, token, scopeKey, target.kind, target.id]), scopeRef = useRef(scope); scopeRef.current = scope;
  const lastStatus = useRef('');
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; ++generation.current; }; }, []);
  useEffect(() => { ++generation.current; busy.current = false; setPending(false); setPreview(null); setConfirmed(false); operation.current = null; setView(null); setError(null); setNotice(null); setUncertain(false); lastStatus.current = ''; }, [scope]);
  useEffect(() => {
    let disposed = false, reading = false;
    const read = async () => {
      if (disposed || reading || busy.current) return;
      reading = true;
      try {
        const result = await fetchInstancePower(apiBaseUrl, token, target);
        if (disposed) return;
        setView(result);
        const signature = JSON.stringify(result.jobs.map(job => [job.id, job.status]));
        if (lastStatus.current && lastStatus.current !== signature) changedRef.current?.();
        lastStatus.current = signature;
      } catch (failure) { if (!disposed) setError(failure instanceof Error ? failure.message : '启停任务读取失败。'); }
      finally { reading = false; }
    };
    void read();
    const interval = window.setInterval(() => { if (document.visibilityState !== 'hidden') void read(); }, 5000);
    return () => { disposed = true; window.clearInterval(interval); };
  }, [scope, attempt]);

  async function act(run: () => Promise<void>) {
    if (busy.current || disabled) return;
    const request = ++generation.current;
    busy.current = true; setPending(true); setError(null);
    try { await run(); }
    catch (failure) { if (request === generation.current && scopeRef.current === scope) setError(failure instanceof Error ? failure.message : '任务结果未确认，请先读取原任务。'); }
    finally { if (request === generation.current && scopeRef.current === scope) { busy.current = false; setPending(false); } }
  }
  async function prepare() {
    const request = generation.current;
    const action: InstancePowerAction = mode === 'resume' ? 'resume' : 'economical_stop';
    let at: string | undefined;
    if (mode === 'schedule') {
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(date)) throw new Error('请选定完整预约时间（北京时间）。');
      const instant = new Date(date + ':00+08:00');
      if (!Number.isFinite(instant.getTime()) || instant.getTime() <= Date.now()) throw new Error('预约时间必须在未来。');
      at = instant.toISOString();
    }
    const scopeAtRequest = scope;
    const result = await previewInstancePower(apiBaseUrl, token, target, action, at);
    if (!mounted.current || request !== generation.current || scopeRef.current !== scopeAtRequest) return;
    setPreview(result); setConfirmed(false); operation.current = { idempotencyKey: crypto.randomUUID() };
  }
  async function submit() {
    if (!preview || !confirmed || !operation.current || uncertain) return;
    const request = generation.current;
    try {
      await submitInstancePower(apiBaseUrl, token, preview, operation.current);
      if (!mounted.current || request !== generation.current || scopeRef.current !== scope) return;
      setNotice(preview.scheduledAt ? '预约已保存，届时会重新核验原实例。原到期时间未改变。' : '启停任务已受理；以逐台云端核验结果为准，不代表现在已经停止计费或已开机。');
      setPreview(null); setMode('manage'); setAttempt(value => value + 1); changedRef.current?.();
    } catch (failure) { if (mounted.current && request === generation.current && scopeRef.current === scope) setUncertain(true); throw failure; }
  }
  const schedules = view?.instances.filter(instance => instance.powerControl?.schedule?.status === 'scheduled') ?? [];
  async function cancel() {
    const request = generation.current;
    await cancelInstancePowerSchedule(apiBaseUrl, token, target, schedules.map(instance => ({ instanceId: instance.id, scheduleId: instance.powerControl!.schedule!.id, revision: instance.powerControl!.schedule!.revision })), { idempotencyKey: crypto.randomUUID() });
    if (!mounted.current || request !== generation.current || scopeRef.current !== scope) return;
    setCancelOpen(false); setNotice('已取消所列预约，没有执行停机。'); setAttempt(value => value + 1); changedRef.current?.();
  }
  async function verify(jobId: string) {
    const request = generation.current;
    await verifyInstancePowerJob(apiBaseUrl, token, target, jobId);
    if (!mounted.current || request !== generation.current || scopeRef.current !== scope) return;
    setNotice('已请求核验原任务，不会补发停机或开机。'); setAttempt(value => value + 1);
  }
  function switchMode(next: Mode) {
    setMode(next); setPreview(null); setConfirmed(false); setUncertain(false); operation.current = null;
  }
  return <>
    <AdminDialog open onOpenChange={open => !open && onClose()} pending={pending} title={`${mode === 'manage' ? '启停任务' : mode === 'schedule' ? '预约节省停机' : mode === 'resume' ? '恢复原实例开机' : '立即节省停机'} · ${name}`} size="wide"
      description="只控制原 ECS 启停，不销毁主机、磁盘或靶场网络。所有预约时间均为北京时间（UTC+08:00）。"
      footer={<><Button variant="outline" type="button" disabled={pending} onClick={onClose}>关闭</Button>
        {mode !== 'manage' ? preview ? <Button type="button" disabled={pending || !confirmed || uncertain} onClick={() => void act(submit)}>{pending ? '提交中…' : mode === 'schedule' ? '确认保存预约' : mode === 'resume' ? '确认恢复开机' : '确认节省停机'}</Button>
          : <Button type="button" disabled={pending || mode === 'schedule' && !date} onClick={() => void act(prepare)}>{pending ? '核验中…' : '核对目标与影响'}</Button> : null}</>}>
      <div className="space-y-4">
        {error ? <AdminNotice tone="error">{error}</AdminNotice> : null}
        {notice ? <AdminNotice tone="info">{notice}</AdminNotice> : null}
        {uncertain ? <div className="space-y-2 text-sm"><p>提交结果尚需核对，请先查看原任务，不要新建重复请求。</p><Button variant="outline" type="button" onClick={() => { setMode('manage'); setAttempt(value => value + 1); }}>查询原任务</Button></div> : null}
        {mode === 'schedule' ? <label className="block space-y-2"><span className="text-sm font-medium">一次性预约时间 · 北京时间</span><DateTimePicker aria-label="节省停机预约时间" value={date} disabled={pending} onValueChange={value => { setDate(value); setPreview(null); setConfirmed(false); }} /><p className="text-xs text-muted-foreground">支持修改、取消。到点遇到其他任务会等待最多 5 分钟；错过窗口会标记未执行，不会无限延后补发。</p></label> : null}
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">{(preview?.warnings ?? view?.warnings ?? []).map(warning => <li key={warning}>{warning}</li>)}</ul>
        {preview ? <section aria-label="启停操作确认清单" className="space-y-3 border-t pt-3">
          <h3 className="font-semibold">将处理 {preview.plans.length} 个实例 / {preview.plans.reduce((count, plan) => count + plan.hosts.length, 0)} 台 ECS</h3>
          {preview.scheduledAt ? <p>预约执行：{time(preview.scheduledAt)}</p> : null}
          {preview.replacingSchedule ? <p className="text-sm">本次将替换所列实例已有的未来预约，不新增第二份预约。</p> : null}
          <div className="max-h-64 overflow-auto rounded-md border" tabIndex={0}><Table className="min-w-[46.5rem] table-fixed"><colgroup><col/><col style={{width:ADMIN_TABLE_WIDTHS.identifier}}/><col style={{width:ADMIN_TABLE_WIDTHS.status}}/><col style={{width:ADMIN_TABLE_WIDTHS.dateTime}}/></colgroup><TableHeader className="sticky top-0 z-10 bg-background"><TableRow><TableHead>实例 / 节点</TableHead><TableHead>原云主机 ID</TableHead><TableHead>当前启停</TableHead><TableHead>原到期时间</TableHead></TableRow></TableHeader>
            <TableBody>{preview.plans.flatMap(plan => plan.hosts.map(host => <TableRow key={plan.instanceId + host.nodeId}><TableCell className="whitespace-normal">{plan.instanceName} / {host.name}</TableCell><TableCell>{host.instanceId}</TableCell><TableCell>{host.originalStatus} {host.originalStoppedMode ?? ''}</TableCell><TableCell>{time(plan.expiresAt)}</TableCell></TableRow>))}</TableBody></Table></div>
          {preview.skipped.length ? <p className="text-xs text-muted-foreground">跳过已回收 / 创建失败记录：{preview.skipped.map(item => item.name).join('、')}</p> : null}
          <label className="flex items-start gap-2 text-sm"><Checkbox checked={confirmed} onCheckedChange={value => setConfirmed(value === true)} aria-label="确认启停操作影响" /><span>我已核对以上准确目标与时间，接受断开连接、剩余费用和再次开机可能失败的影响。</span></label>
        </section> : null}
        {mode === 'manage' ? <>
          <div className="flex flex-wrap gap-2"><Button type="button" variant="outline" disabled={pending} onClick={() => switchMode('schedule')}>新建 / 修改预约</Button><Button type="button" variant="outline" disabled={pending} onClick={() => switchMode('resume')}>恢复开机</Button>
            {schedules.length ? <Button type="button" variant="outline" disabled={pending} onClick={() => setCancelOpen(true)}>取消所列预约（{schedules.length} 项）</Button> : null}
            <Button type="button" variant="outline" disabled={pending} onClick={() => setAttempt(value => value + 1)}>刷新状态</Button></div>
          {!view ? <p role="status">正在读取启停任务…</p> : <div className="max-h-56 overflow-auto rounded-md border" tabIndex={0}><Table className="min-w-[38rem] table-fixed"><colgroup><col/><col style={{width:'12rem'}}/><col style={{width:'14rem'}}/></colgroup><TableHeader className="sticky top-0 z-10 bg-background"><TableRow><TableHead>实例</TableHead><TableHead>启停状态</TableHead><TableHead>预约</TableHead></TableRow></TableHeader><TableBody>{view.instances.map(instance => <TableRow key={instance.id}>
            <TableCell className="whitespace-normal">{instance.name}</TableCell><TableCell className="whitespace-normal">{instancePowerLabel(instance.powerControl) ?? '未记录节省停机'}{instance.powerControl?.error ? <p className="text-destructive">{instance.powerControl.error}</p> : null}</TableCell>
            <TableCell className="whitespace-normal">{instance.powerControl?.schedule ? <>{SCHEDULE[instance.powerControl.schedule.status]} · {time(instance.powerControl.schedule.at)}<p>{instance.powerControl.schedule.message}</p></> : '无预约'}</TableCell></TableRow>)}</TableBody></Table></div>}
          <section className="space-y-3" aria-label="启停任务记录"><h3 className="font-semibold">原任务及逐台核验记录</h3>
            {view && !view.jobs.length ? <p className="text-sm text-muted-foreground">尚无执行任务。未来预约会在到点时进入队列，服务重启不会丢失预约。</p> : null}
            {view?.jobs.slice(0, 20).map(job => <details key={job.id} className="border-t pt-2"><summary className="cursor-pointer text-sm">{job.action === 'economical_stop' ? '节省停机' : '恢复开机'} · {JOB[job.status] ?? job.status} · {time(job.createdAt)}</summary>
              <div className="space-y-2 py-2 text-sm"><p className="break-all">任务 ID：{job.id}</p>{job.error ? <p className="text-destructive">{job.error}</p> : null}
                {job.steps.map((step, index) => <p key={step.name + index} className="break-all">{step.name}：{step.message}</p>)}
                {job.status === 'failed' ? <Button type="button" variant="outline" disabled={pending} onClick={() => void act(() => verify(job.id))}>核验原任务</Button> : null}
              </div></details>)}
          </section>
        </> : null}
      </div>
    </AdminDialog>
    {cancelOpen ? <AdminDialog open title="取消预约节省停机" description={`仅取消以下 ${schedules.length} 个实例尚未执行的预约，不执行开机或停机。`} pending={pending} onOpenChange={setCancelOpen} footer={<><Button type="button" variant="outline" disabled={pending} onClick={() => setCancelOpen(false)}>返回</Button><Button type="button" variant="destructive" disabled={pending} onClick={() => void act(cancel)}>确认取消预约</Button></>}>
      <ul className="list-disc pl-5 text-sm">{schedules.map(instance => <li key={instance.id}>{instance.name} · {time(instance.powerControl!.schedule!.at)}</li>)}</ul>
    </AdminDialog> : null}
  </>;
}
