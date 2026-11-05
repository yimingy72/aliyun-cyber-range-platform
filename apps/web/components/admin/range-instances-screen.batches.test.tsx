import React from 'react';
async function batchDestroyItem() {
  const existing = screen.queryByRole('menuitem', { name: '销毁批次 批次A' });
  if (existing) return existing;
  const row = (await screen.findByText('批次A', { selector: 'strong' })).closest('tr')!;
  const trigger = within(row).getByRole('button', { name: '更多批次操作' });
  if ((trigger as HTMLButtonElement).disabled) return trigger;
  fireEvent.keyDown(trigger, { key: 'Enter' });
  return screen.getByRole('menuitem', { name: '销毁批次 批次A' });
}
const actionDisabled = (node: HTMLElement) => (node as HTMLButtonElement).disabled || node.getAttribute('aria-disabled') === 'true';

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RangeInstance, RangeInstanceDetail } from '../../lib/admin-types';
import { beginRangeRecoveryIntent, readRangeRecoveryIntent } from '../../lib/range-recovery-intent';

const mock = vi.hoisted(() => ({ list: vi.fn(), jobs: vi.fn(), detail: vi.fn(), access: vi.fn(), destroy: vi.fn(), download: vi.fn(),
  push: vi.fn(), replace: vi.fn(), logout: vi.fn(), active: true,
  workspace: { id: 'workspace-a', isReadOnly: false },
}));
vi.mock('next/navigation', () => ({ useRouter: () => mock, useSearchParams: () => new URLSearchParams() }));
vi.mock('./range-instance-create-button', () => ({ RangeInstanceCreateButton: () => null }));
vi.mock('./cloud-workspace-provider', () => ({ useCloudWorkspace: () => ({ workspace: mock.workspace }) }));
vi.mock('./admin-page-cache', () => ({ useAdminRouteIsActive: () => mock.active }));
vi.mock('./use-admin-session', () => ({ useAdminSession: () => ({ token: 'fixture-token', profile: { id: 'admin', username: 'admin', role: 'admin' }, isReady: true, logout: mock.logout }) }));
vi.mock('../../lib/admin-api', () => ({ AdminApiError: class extends Error { constructor(readonly status: number, message?: string) { super(message); } },
  fetchRangeInstances: mock.list, fetchProvisionJobs: mock.jobs, fetchRangeInstanceDetail: mock.detail,
  fetchRangeInstanceAccess: mock.access, triggerRangeAction: mock.destroy,
}));
vi.mock('../../lib/range-instance-export', async importOriginal => ({ ...await importOriginal<typeof import('../../lib/range-instance-export')>(), downloadRangeInstancesCsv: mock.download }));
import { RangeInstancesScreen } from './range-instances-screen';
import { AdminApiError } from '../../lib/admin-api';

function batch(id = 'batch-a', name = '批次A', count = 2): RangeInstance[] {
  return Array.from({ length: count }, (_, index) => ({ id: `${id}-${index + 1}`, name: `${name}-${index + 1}`, status: 'running',
    createdBy: 'admin', createdAt: '2026-10-20T00:00:00Z', templateId: 'template-a', templateNameSnapshot: '测试拓扑',
    launchBatch: { id, name, index: index + 1, quantity: count } }));
}
function detail(instance: RangeInstance): RangeInstanceDetail {
  return { ...instance, templateId: 'template-a', accessEntry: { publicIp: '198.51.100.1' },
    runtimeTopologyGraph: { nodes: [{ id: 'host', kind: 'ecs', label: '测试节点', nics: [{ privateIp: '172.16.10.10' }] }] },
    runtimeCredentials: { host: { username: 'not-exported', password: 'detail-secret-not-exported' } } };
}
const recoveryScope = (id: string) => ({ apiBaseUrl: 'http://localhost:3001', userId: 'admin', workspaceId: 'workspace-a', rangeId: id });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(next => { resolve = next; }); return { promise, resolve }; }

describe('range batch list actions', () => {
  let instances: RangeInstance[];
  beforeEach(() => {
    vi.clearAllMocks();
    mock.active = true; mock.workspace = { id: 'workspace-a', isReadOnly: false };
    window.localStorage.clear(); window.sessionStorage.clear();
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    instances = [...batch(), ...batch('batch-b', '批次B'), { id: 'standalone', name: '独立靶场', templateId: 'template-a', status: 'running' }];
    mock.list.mockReset().mockImplementation(async (_url, _token, options) => instances.filter(instance =>
      options.view === 'history' ? ['destroyed', 'create_failed'].includes(instance.status) : !['destroyed', 'create_failed'].includes(instance.status)));
    mock.jobs.mockReset().mockResolvedValue([]);
    mock.detail.mockReset().mockImplementation(async (_url, _token, id) => detail(instances.find(instance => instance.id === id)!));
    mock.access.mockReset().mockImplementation(async (_url, _token, id) => ({ id, runtimeCredentials: { host: { username: 'Administrator', password: 'fixture-access-secret' } } }));
    mock.destroy.mockReset().mockImplementation(async (_url, _token, id) => ({ id: `job-${id}`, rangeInstanceId: id, status: 'pending' }));
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); window.localStorage.clear(); window.sessionStorage.clear(); });

  it('shows one row per batch and expands members in launch order', async () => {
    instances = [...batch().reverse(), ...batch('batch-b', '批次B'), instances[4]];
    render(<RangeInstancesScreen />);
    const expand = await screen.findByRole('button', { name: '展开批次 批次A' });
    expect(screen.queryByText('批次A-1')).toBeNull();
    expect(screen.getByText('独立靶场')).toBeTruthy();
    fireEvent.click(expand);
    expect(screen.getByRole('button', { name: '收起批次 批次A' }).getAttribute('aria-expanded')).toBe('true');
    const names = [...screen.getByRole('table').querySelectorAll('tbody tr')].map(row => row.textContent!);
    expect(names.findIndex(name => name.startsWith('批次A-1'))).toBeLessThan(names.findIndex(name => name.startsWith('批次A-2')));
  });
  it('keeps the entire batch when searching by a member, and cancels close without a write', async () => {
    render(<RangeInstancesScreen />);
    await screen.findByRole('button', { name: '展开批次 批次A' });
    fireEvent.change(screen.getByRole('searchbox', { name: '筛选实例名' }), { target: { value: '批次A-2' } });
    expect(screen.queryByRole('button', { name: '展开批次 批次B' })).toBeNull();
    fireEvent.click(await batchDestroyItem());
    const dialog = await screen.findByRole('dialog', { name: '销毁整批编排实例' });
    expect(within(dialog).getByText('批次A-1')).toBeTruthy(); expect(within(dialog).getByText('批次A-2')).toBeTruthy();
    expect(mock.destroy).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
    expect(mock.destroy).not.toHaveBeenCalled();
  });
  it('paginates parent groups, never splitting a batch across pages', async () => {
    instances = Array.from({ length: 21 }, (_, index) => batch(`batch-${index}`, `分组-${index}`, 3)).flat();
    render(<RangeInstancesScreen />);
    await screen.findByRole('button', { name: '展开批次 分组-0' });
    expect(screen.getAllByRole('button', { name: /^展开批次/ })).toHaveLength(20);
    fireEvent.click(screen.getByRole('link', { name: '第 2 页' }));
    fireEvent.click(await screen.findByRole('button', { name: '展开批次 分组-20' }));
    for (const index of [1, 2, 3]) expect(screen.getByText(`分组-20-${index}`)).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /^(展开|收起)批次/ })).toHaveLength(1);
  });
  it('confirms exactly one batch, uses per-member recovery keys and retries only destroy failures', async () => {
    instances[1].status = 'destroy_failed';
    render(<RangeInstancesScreen />);
    fireEvent.click(await batchDestroyItem());
    const confirm = await screen.findByRole('button', { name: '确认销毁整批' });
    fireEvent.click(confirm); fireEvent.click(confirm);
    await screen.findByText(/已受理 2 套回收请求/);
    expect(mock.destroy).toHaveBeenCalledTimes(2);
    expect(mock.destroy.mock.calls.map(args => [args[2], args[3]])).toEqual([['batch-a-1', 'destroy'], ['batch-a-2', 'retry']]);
    for (const instance of instances.slice(0, 2)) expect(mock.destroy.mock.calls.find(args => args[2] === instance.id)![4]).toBe(readRangeRecoveryIntent(recoveryScope(instance.id))!.key);
    expect(actionDisabled(await batchDestroyItem())).toBe(true);
  });
  it.each(['pending_create', 'creating', 'pending_update', 'updating'])('disables whole-batch closure while a member is %s', async status => {
    instances[1].status = status;
    render(<RangeInstancesScreen />);
    expect(actionDisabled(await batchDestroyItem())).toBe(true);
    expect(mock.destroy).not.toHaveBeenCalled();
  });
  it('skips an unknown intake, never replacing its original key', async () => {
    const original = beginRangeRecoveryIntent(recoveryScope('batch-a-1'), 'destroy');
    render(<RangeInstancesScreen />);
    fireEvent.click(await batchDestroyItem());
    const dialog = await screen.findByRole('dialog', { name: '销毁整批编排实例' });
    expect(within(dialog).queryByText('批次A-1')).toBeNull();
    expect(within(dialog).getByText(/另有 1 套/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: '确认销毁整批' }));
    await screen.findByText(/已受理 1 套回收请求/);
    expect(mock.destroy).toHaveBeenCalledTimes(1); expect(mock.destroy.mock.calls[0][2]).toBe('batch-a-2');
    expect(readRangeRecoveryIntent(recoveryScope('batch-a-1'))).toEqual(original);
  });
  it('reports partial/unknown results without resubmitting the lost request', async () => {
    mock.destroy.mockRejectedValueOnce(new Error('response lost'));
    render(<RangeInstancesScreen />);
    fireEvent.click(await batchDestroyItem());
    fireEvent.click(await screen.findByRole('button', { name: '确认销毁整批' }));
    expect((await screen.findByRole('alert')).textContent).toContain('1 套结果待确认');
    expect(mock.destroy).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: '展开批次 批次A' }));
    const row = screen.getByText('批次A-1').closest('tr')!;
    fireEvent.keyDown(within(row).getByRole('button', { name: '更多操作' }), { key: 'Enter' });
    fireEvent.click(screen.getByRole('menuitem', { name: '确认回收状态' }));
    expect(mock.push).toHaveBeenCalledWith('/admin/ranges/batch-a-1'); expect(mock.destroy).toHaveBeenCalledTimes(2);
  });
  it('stops all remaining submissions if the workspace changes during a request', async () => {
    const pending = deferred<{ id: string; rangeInstanceId: string }>(); mock.destroy.mockReturnValueOnce(pending.promise);
    const view = render(<RangeInstancesScreen />);
    fireEvent.click(await batchDestroyItem());
    fireEvent.click(await screen.findByRole('button', { name: '确认销毁整批' }));
    await waitFor(() => expect(mock.destroy).toHaveBeenCalledTimes(1));
    mock.workspace = { id: 'workspace-b', isReadOnly: false }; view.rerender(<RangeInstancesScreen />);
    await act(async () => pending.resolve({ id: 'old-job', rangeInstanceId: 'batch-a-1' }));
    expect(mock.destroy).toHaveBeenCalledTimes(1); expect(screen.queryByText(/已受理/)).toBeNull();
  });
  it('stops rather than issuing untracked requests if browser storage fails', async () => {
    render(<RangeInstancesScreen />);
    fireEvent.click(await batchDestroyItem());
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage unavailable'); });
    fireEvent.click(await screen.findByRole('button', { name: '确认销毁整批' }));
    expect((await screen.findByRole('alert')).textContent).toContain('2 套尚未提交'); expect(mock.destroy).not.toHaveBeenCalled();
  });
  it('stops on authentication failure without dispatching other members', async () => {
    mock.destroy.mockRejectedValueOnce(new AdminApiError(401, 'expired'));
    render(<RangeInstancesScreen />);
    fireEvent.click(await batchDestroyItem());
    fireEvent.click(await screen.findByRole('button', { name: '确认销毁整批' }));
    await waitFor(() => expect(mock.logout).toHaveBeenCalledOnce()); expect(mock.destroy).toHaveBeenCalledOnce();
  });
  it('exports every member, but never reads or exports credentials by default', async () => {
    render(<RangeInstancesScreen />);
    fireEvent.click(await screen.findByRole('button', { name: '导出批次 批次A' }));
    const dialog = await screen.findByRole('dialog', { name: '导出靶场信息' });
    expect(within(dialog).getByRole('checkbox').getAttribute('aria-checked')).toBe('false');
    fireEvent.click(within(dialog).getByRole('button', { name: '导出 CSV' }));
    await waitFor(() => expect(mock.download).toHaveBeenCalledOnce());
    expect(mock.detail.mock.calls.map(args => args[2])).toEqual(['batch-a-1', 'batch-a-2']);
    expect(mock.access).not.toHaveBeenCalled();
    const csv = mock.download.mock.calls[0][1];
    expect(csv).toContain('批次A-1'); expect(csv).toContain('批次A-2'); expect(csv).not.toContain('detail-secret-not-exported'); expect(csv).not.toContain('密码');
  });
  it('reads explicit access data only after the sensitive export checkbox is selected', async () => {
    render(<RangeInstancesScreen />);
    fireEvent.click(await screen.findByRole('button', { name: '导出批次 批次A' }));
    const dialog = await screen.findByRole('dialog', { name: '导出靶场信息' });
    fireEvent.click(within(dialog).getByRole('checkbox'));
    fireEvent.click(within(dialog).getByRole('button', { name: '导出 CSV' }));
    await waitFor(() => expect(mock.download).toHaveBeenCalledOnce());
    expect(mock.access).toHaveBeenCalledTimes(2); expect(mock.download.mock.calls[0][1]).toContain('fixture-access-secret');
  });
  it('keeps failures in the export dialog and generates no misleading partial file', async () => {
    mock.detail.mockRejectedValueOnce(new Error('read failed'));
    render(<RangeInstancesScreen />);
    fireEvent.click(await screen.findByRole('button', { name: '导出批次 批次A' }));
    const dialog = await screen.findByRole('dialog', { name: '导出靶场信息' });
    fireEvent.click(within(dialog).getByRole('button', { name: '导出 CSV' }));
    expect((await within(dialog).findByRole('alert')).textContent).toContain('未生成文件');
    expect(mock.download).not.toHaveBeenCalled(); expect(mock.access).not.toHaveBeenCalled();
  });
  it('discards an old export response after a workspace switch', async () => {
    const pending = deferred<RangeInstanceDetail>(); mock.detail.mockReturnValueOnce(pending.promise);
    const view = render(<RangeInstancesScreen />);
    fireEvent.click(await screen.findByRole('button', { name: '导出批次 批次A' }));
    fireEvent.click(await screen.findByRole('button', { name: '导出 CSV' }));
    mock.workspace = { id: 'workspace-b', isReadOnly: false }; view.rerender(<RangeInstancesScreen />);
    await act(async () => pending.resolve(detail(instances[0])));
    expect(mock.download).not.toHaveBeenCalled(); expect(mock.detail).toHaveBeenCalledOnce(); expect(mock.access).not.toHaveBeenCalled();
  });
  it('keeps historical batches expandable/exportable without a close action', async () => {
    instances[0].status = 'destroyed'; instances[1].status = 'create_failed';
    render(<RangeInstancesScreen />);
    await screen.findByRole('button', { name: '展开批次 批次B' });
    fireEvent.mouseDown(screen.getByRole('tab', { name: '实例历史' }), { button: 0 });
    fireEvent.click(await screen.findByRole('button', { name: '展开批次 批次A' }));
    expect(screen.getByText('批次A-1')).toBeTruthy(); expect(screen.queryByRole('button', { name: '更多批次操作' })).toBeNull();
    expect(screen.getByRole('button', { name: '导出批次 批次A' })).toBeTruthy();
  });
  it('refreshes in-progress batch counts without dispatching operations and stops polling at a terminal state', async () => {
    vi.useFakeTimers();
    const pending = batch().map(instance => ({ ...instance, status: 'pending_create' }));
    mock.list.mockReset().mockResolvedValueOnce(pending).mockResolvedValue(batch());
    await act(async () => { render(<RangeInstancesScreen />); await vi.advanceTimersByTimeAsync(0); });
    expect(mock.list).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(screen.getByText('2 运行中')).toBeTruthy(); expect(mock.list).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
    expect(mock.list).toHaveBeenCalledTimes(2); expect(mock.destroy).not.toHaveBeenCalled();
  });
  it('preserves batch rows on a polling failure and recovers on the next read', async () => {
    vi.useFakeTimers();
    mock.list.mockReset().mockResolvedValueOnce(batch().map(instance => ({ ...instance, status: 'destroying' })))
      .mockRejectedValueOnce(new Error('transient read failure')).mockResolvedValue(batch());
    await act(async () => { render(<RangeInstancesScreen />); await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(screen.getByRole('button', { name: '展开批次 批次A' })).toBeTruthy();
    expect(screen.getByText('批次状态刷新失败，已保留现有记录，请稍后重试。')).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(screen.getByText('2 运行中')).toBeTruthy(); expect(mock.destroy).not.toHaveBeenCalled();
  });
  it('stops subsequent close requests when leaving the page, then releases the local busy state', async () => {
    const pending = deferred<{ id: string; rangeInstanceId: string }>(); mock.destroy.mockReturnValueOnce(pending.promise);
    const view = render(<RangeInstancesScreen />);
    fireEvent.click(await batchDestroyItem());
    fireEvent.click(await screen.findByRole('button', { name: '确认销毁整批' }));
    mock.active = false; view.rerender(<RangeInstancesScreen />);
    mock.active = true; view.rerender(<RangeInstancesScreen />);
    await act(async () => pending.resolve({ id: 'old-job', rangeInstanceId: 'batch-a-1' }));
    expect(mock.destroy).toHaveBeenCalledOnce();
    expect(actionDisabled(await batchDestroyItem())).toBe(false);
  });
  it('does not allow bulk closure from a read-only workspace', async () => {
    mock.workspace.isReadOnly = true; render(<RangeInstancesScreen />);
    expect(actionDisabled(await batchDestroyItem())).toBe(true);
    expect(mock.destroy).not.toHaveBeenCalled();
  });
  it('rejects a mismatched access response rather than exporting another instance credentials', async () => {
    mock.access.mockResolvedValueOnce({ id: 'different-instance', runtimeCredentials: {} });
    render(<RangeInstancesScreen />);
    fireEvent.click(await screen.findByRole('button', { name: '导出批次 批次A' }));
    fireEvent.click(await screen.findByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: '导出 CSV' }));
    expect((await screen.findByRole('alert')).textContent).toContain('访问数据与导出目标不符');
    expect(mock.download).not.toHaveBeenCalled();
  });
});
