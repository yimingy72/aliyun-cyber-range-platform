import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InstancePowerDialog, InstancePowerBadge, InstancePowerMenu } from './instance-power-menu';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { AdminDialog } from './shared/admin-dialog';
import { Button } from '@/components/ui/button';
import type { InstancePowerPreview, RangeInstance } from '@/lib/admin-types';
const api = vi.hoisted(() => ({ fetchInstancePower: vi.fn(), previewInstancePower: vi.fn(), submitInstancePower: vi.fn(), cancelInstancePowerSchedule: vi.fn(), verifyInstancePowerJob: vi.fn() }));
vi.mock('@/lib/instance-power-api', () => api);
vi.mock('@/components/ui/date-time-picker', () => ({ DateTimePicker: ({ value, onValueChange, ...props }: any) => <input {...props} type="datetime-local" value={value} onChange={event => onValueChange(event.target.value)} /> }));
const preview: InstancePowerPreview = { target: { kind: 'single', id: 'logical-id' }, action: 'economical_stop', scheduledAt: null, planDigest: 'a'.repeat(64),
  plans: [{ instanceId: 'logical-id', instanceName: 'Temporary', hosts: [{ instanceId: 'i-original', nodeId: 'host', name: 'Host', originalStatus: 'Running', originalStoppedMode: null }], expiresAt: null }], skipped: [], warnings: ['云盘仍可能计费'], replacingSchedule: false };
const defaults = { apiBaseUrl: '', token: 'token', scopeKey: 'scope', target: preview.target, name: 'Temp', initialMode: 'stop' as const, onClose: vi.fn() };
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const ready = () => { api.fetchInstancePower.mockResolvedValue({ instances: [], jobs: [], warnings: ['云盘仍可能计费'] }); api.previewInstancePower.mockResolvedValue(preview); api.submitInstancePower.mockResolvedValue({ status: 'accepted' }); };
describe('power dialog', () => {
  it('requires target preview and a separate acknowledgement before submission', async () => {
    ready(); render(<InstancePowerDialog {...defaults} />);
    fireEvent.click(screen.getByRole('button', { name: '核对目标与影响' }));
    const confirm = await screen.findByRole('button', { name: '确认节省停机' }) as HTMLButtonElement;
    expect(screen.getByText('i-original')).toBeTruthy(); expect(confirm.disabled).toBe(true); expect(api.submitInstancePower).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('checkbox', { name: '确认启停操作影响' })); fireEvent.click(confirm);
    await waitFor(() => expect(api.submitInstancePower).toHaveBeenCalledTimes(1));
  });
  it('uses Beijing time independently of the browser timezone', async () => {
    ready(); render(<InstancePowerDialog {...defaults} initialMode="schedule" />);
    fireEvent.change(screen.getByLabelText('节省停机预约时间'), { target: { value: '2028-01-01T09:30' } });
    fireEvent.click(screen.getByRole('button', { name: '核对目标与影响' }));
    await waitFor(() => expect(api.previewInstancePower).toHaveBeenCalledWith('', 'token', preview.target, 'economical_stop', '2028-01-01T01:30:00.000Z'));
  });
  it('offers original-task lookup instead of a second submission after an unknown result', async () => {
    ready(); api.submitInstancePower.mockRejectedValue(new Error('结果未确认'));
    render(<InstancePowerDialog {...defaults} />); fireEvent.click(screen.getByRole('button', { name: '核对目标与影响' }));
    await screen.findByRole('button', { name: '确认节省停机' }); fireEvent.click(screen.getByRole('checkbox')); fireEvent.click(screen.getByRole('button', { name: '确认节省停机' }));
    expect(await screen.findByRole('button', { name: '查询原任务' })).toBeTruthy();
    expect((screen.getByRole('button', { name: '确认节省停机' }) as HTMLButtonElement).disabled).toBe(true); expect(api.submitInstancePower).toHaveBeenCalledTimes(1);
  });
  it('discards an old-scope preview', async () => {
    ready(); let resolve!: (value: any) => void; api.previewInstancePower.mockReturnValue(new Promise(done => { resolve = done; }));
    const { rerender } = render(<InstancePowerDialog {...defaults} />); fireEvent.click(screen.getByRole('button', { name: '核对目标与影响' }));
    rerender(<InstancePowerDialog {...defaults} scopeKey="different" token="different-token" />);
    await act(async () => resolve(preview)); expect(screen.queryByText('i-original')).toBeNull(); expect(api.submitInstancePower).not.toHaveBeenCalled();
  });
  it('renders a verified economical state instead of the allocated lifecycle running state', () => {
    render(<InstancePowerBadge instance={{ status: 'running', powerControl: { version: 1, state: 'economical_stopped' } } as RangeInstance} />);
    expect(screen.getByText('节省停机')).toBeTruthy(); expect(screen.queryByText('运行中')).toBeNull();
  });
});

describe('unified instance action menu', () => {
  const source = (state: string) => ({ status: 'running', powerControl: { version: 1, state } }) as RangeInstance;
  const open = () => fireEvent.keyDown(screen.getByRole('button', { name: '更多操作' }), { key: 'Enter' });
  it('keeps actions grouped, destruction last, and opening the menu read-only', () => {
    render(<InstancePowerMenu {...defaults} label="更多" sources={[source('running')]} destructive={<DropdownMenuItem variant="destructive">销毁实例</DropdownMenuItem>}>
      <DropdownMenuItem>重启实例</DropdownMenuItem><DropdownMenuItem>打包为镜像</DropdownMenuItem>
    </InstancePowerMenu>);
    expect(screen.queryByRole('button', { name: '电源' })).toBeNull(); open();
    const items = screen.getAllByRole('menuitem');
    expect(items.map(item => item.textContent)).toEqual(['节省停机', '预约节省停机', '恢复开机', '查看启停任务', '修改回收时间', '重启实例', '打包为镜像', '销毁实例']);
    expect(screen.getByRole('menuitem', { name: '恢复开机' }).getAttribute('aria-disabled')).toBe('true');
    expect(items.at(-1)?.getAttribute('data-variant')).toBe('destructive');
    expect(api.fetchInstancePower).not.toHaveBeenCalled(); expect(api.submitInstancePower).not.toHaveBeenCalled();
  });
  it('enables resume for an economically stopped source, and preserves preview confirmation', async () => {
    ready(); render(<InstancePowerMenu {...defaults} label="更多" sources={[source('economical_stopped')]} />); open();
    expect(screen.getByRole('menuitem', { name: '节省停机' }).getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(screen.getByRole('menuitem', { name: '恢复开机' }));
    expect(await screen.findByRole('dialog', { name: '恢复原实例开机 · Temp' })).toBeTruthy();
    expect(api.previewInstancePower).not.toHaveBeenCalled(); expect(api.submitInstancePower).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '核对目标与影响' }));
    await waitFor(() => expect(api.previewInstancePower).toHaveBeenCalledWith('', 'token', preview.target, 'resume', undefined));
  });
  it.each(['unknown', 'stopping'] as const)('keeps original-task lookup available while %s prevents new writes', async state => {
    ready(); const current = state === 'stopping' ? { ...source('running'), powerControl: { version: 1 as const, state: 'running' as const, phase: 'stopping' as const } } : source(state);
    render(<InstancePowerMenu {...defaults} label="更多" sources={[current]} />); open();
    for (const name of ['节省停机', '预约节省停机', '恢复开机']) expect(screen.getByRole('menuitem', { name }).getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(screen.getByRole('menuitem', { name: '查看启停任务' }));
    expect(await screen.findByRole('dialog', { name: '启停任务 · Temp' })).toBeTruthy();
    expect(api.previewInstancePower).not.toHaveBeenCalled(); expect(api.submitInstancePower).not.toHaveBeenCalled();
  });
  it('labels batch scope explicitly and enables a mixed batch to resume', () => {
    render(<InstancePowerMenu {...defaults} target={{ kind: 'single_batch', id: 'batch' }} label="更多" sources={[source('running'), source('economical_stopped')]} />);
    fireEvent.keyDown(screen.getByRole('button', { name: '更多批次操作' }), { key: 'Enter' });
    expect(screen.getByRole('menuitem', { name: '恢复开机（整批）' }).getAttribute('aria-disabled')).toBeNull();
    expect(screen.getByRole('menuitem', { name: '查看批次启停任务' })).toBeTruthy();
  });
  it('does not disable existing non-Alibaba actions when power control is unavailable', () => {
    render(<InstancePowerMenu {...defaults} label="更多" showPowerActions={false} destructive={<DropdownMenuItem variant="destructive">销毁实例</DropdownMenuItem>}><DropdownMenuItem>打包为镜像</DropdownMenuItem></InstancePowerMenu>);
    open(); expect(screen.queryByRole('menuitem', { name: '节省停机' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: '打包为镜像' }).getAttribute('aria-disabled')).toBeNull();
    expect(screen.getByRole('menuitem', { name: '销毁实例' }).getAttribute('aria-disabled')).toBeNull();
  });
  it('closes an old-scope menu and dialog when changing workspace', async () => {
    ready(); const view = render(<InstancePowerMenu {...defaults} label="更多" />); open();
    fireEvent.click(screen.getByRole('menuitem', { name: '预约节省停机' }));
    await screen.findByRole('dialog'); view.rerender(<InstancePowerMenu {...defaults} label="更多" scopeKey="different" />);
    expect(screen.queryByRole('dialog')).toBeNull(); expect(api.submitInstancePower).not.toHaveBeenCalled();
  });
  it('leaves focus on the destruction confirmation rather than restoring it behind the dialog', async () => {
    function ConfirmingMenu() {
      const [confirm, setConfirm] = React.useState(false);
      return <><InstancePowerMenu {...defaults} label="更多" destructive={<DropdownMenuItem variant="destructive" onSelect={() => setConfirm(true)}>销毁实例</DropdownMenuItem>} />
        {confirm ? <AdminDialog open title="销毁确认" onOpenChange={setConfirm} footer={<Button onClick={() => setConfirm(false)}>取消销毁</Button>}>确认前不执行销毁</AdminDialog> : null}</>;
    }
    render(<ConfirmingMenu />); open(); fireEvent.click(screen.getByRole('menuitem', { name: '销毁实例' }));
    await screen.findByRole('dialog', { name: '销毁确认' });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: '取消销毁' })));
    expect(api.submitInstancePower).not.toHaveBeenCalled();
  });
});
