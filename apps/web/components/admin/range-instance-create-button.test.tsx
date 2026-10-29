import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ templates: vi.fn(), launch: vi.fn(), push: vi.fn(), replace: vi.fn(), workspace: null as null | { workspace: { id: string; provider: 'alibaba_cloud' | 'tencent_cloud'; isReadOnly: boolean; activeCloudAccountContextId?: string; capabilities: { provisioning: boolean; rangeProvisioning?: boolean } } } }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: state.push, replace: state.replace }) }));
vi.mock('./use-admin-session', () => ({ useAdminSession: () => ({ token: 'fixture-token', profile: { id: 'user-1' }, logout: vi.fn() }) }));
vi.mock('./cloud-workspace-provider', () => ({ useCloudWorkspace: () => state.workspace }));
vi.mock('./admin-page-cache', () => ({ useAdminRouteIsActive: () => true }));
vi.mock('@/lib/admin-api', async () => ({ ...(await vi.importActual('@/lib/admin-api')), fetchRangeTemplates: state.templates, launchRangeInstance: state.launch }));
import { RangeInstanceCreateButton } from './range-instance-create-button';

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  state.workspace = null;
  state.templates.mockResolvedValue([{ id: 'template-1', name: '训练模板', slug: 'training' }]);
  state.launch.mockResolvedValue({ id: 'range-1' });
});

async function fill() {
  fireEvent.click(screen.getByRole('button', { name: '创建实例', exact: true }));
  await waitFor(() => expect((screen.getByRole('combobox', { name: '靶场模板' }) as HTMLInputElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('combobox', { name: '靶场模板' }));
  fireEvent.click(screen.getByRole('option', { name: '训练模板' }));
  fireEvent.change(screen.getByLabelText('实例名', { exact: true }), { target: { value: '训练实例' } });
  fireEvent.change(screen.getByLabelText('到期时间', { exact: true }), { target: { value: '2100-01-01T12:00' } });
}

describe('range list creation entry', () => {
  it.each([undefined, false])('hides Tencent creation when rangeProvisioning is %s', (rangeProvisioning) => {
    state.workspace = { workspace: { id: 'tencent', provider: 'tencent_cloud', isReadOnly: false, capabilities: { provisioning: true, rangeProvisioning } } };
    render(<RangeInstanceCreateButton apiBaseUrl="http://localhost:3001" />);
    expect(screen.queryByRole('button', { name: '创建实例' })).toBeNull();
    expect(state.templates).not.toHaveBeenCalled();
    expect(state.launch).not.toHaveBeenCalled();
  });

  it('preserves explicitly enabled Tencent launches', async () => {
    state.workspace = { workspace: { id: 'tencent', provider: 'tencent_cloud', isReadOnly: false, capabilities: { provisioning: true, rangeProvisioning: true } } };
    render(<RangeInstanceCreateButton apiBaseUrl="http://localhost:3001" />);
    await fill();
    fireEvent.click(screen.getByRole('button', { name: '确认创建' }));
    await waitFor(() => expect(state.push).toHaveBeenCalledWith('/admin/ranges/range-1'));
  });

  it('drops stale templates and dialogs when switching accounts during a delayed list response', async () => {
    let resolve!: (value: Array<{ id: string; name: string }>) => void;
    state.workspace = { workspace: { id: 'ali', provider: 'alibaba_cloud', isReadOnly: false, capabilities: { provisioning: true } } };
    state.templates.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const { rerender } = render(<RangeInstanceCreateButton apiBaseUrl="http://localhost:3001" />);
    fireEvent.click(screen.getByRole('button', { name: '创建实例' }));
    state.workspace = { workspace: { id: 'tencent', provider: 'tencent_cloud', isReadOnly: false, capabilities: { provisioning: true, rangeProvisioning: false } } };
    rerender(<RangeInstanceCreateButton apiBaseUrl="http://localhost:3001" />);
    await act(async () => resolve([{ id: 'ali-only', name: '旧阿里模板' }]));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByText('旧阿里模板')).toBeNull();
    expect(state.launch).not.toHaveBeenCalled();
    state.workspace = { workspace: { id: 'ali', provider: 'alibaba_cloud', isReadOnly: false, capabilities: { provisioning: true } } };
    rerender(<RangeInstanceCreateButton apiBaseUrl="http://localhost:3001" />);
    await fill();
    expect(screen.queryByText('旧阿里模板')).toBeNull();
  });

  it('does not navigate from an old launch after switching away and back to the same account', async () => {
    let resolve!: (value: { id: string }) => void;
    state.workspace = { workspace: { id: 'ali', provider: 'alibaba_cloud', isReadOnly: false, capabilities: { provisioning: true } } };
    state.launch.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const { rerender } = render(<RangeInstanceCreateButton apiBaseUrl="http://localhost:3001" />);
    await fill();
    fireEvent.click(screen.getByRole('button', { name: '确认创建' }));
    fireEvent.submit(document.querySelector('[role=dialog] form')!);
    expect(state.launch).toHaveBeenCalledTimes(1);
    state.workspace = { workspace: { id: 'tencent', provider: 'tencent_cloud', isReadOnly: false, capabilities: { provisioning: true, rangeProvisioning: false } } };
    rerender(<RangeInstanceCreateButton apiBaseUrl="http://localhost:3001" />);
    state.workspace = { workspace: { id: 'ali', provider: 'alibaba_cloud', isReadOnly: false, capabilities: { provisioning: true } } };
    rerender(<RangeInstanceCreateButton apiBaseUrl="http://localhost:3001" />);
    await act(async () => resolve({ id: 'old-range' }));
    expect(state.push).not.toHaveBeenCalled();
    await fill();
    fireEvent.click(screen.getByRole('button', { name: '确认创建' }));
    await waitFor(() => expect(state.push).toHaveBeenCalledWith('/admin/ranges/range-1'));
    expect(state.launch).toHaveBeenCalledTimes(2);
  });

  it('selects a visible template and opens the created instance', async () => {
    render(<RangeInstanceCreateButton apiBaseUrl="http://localhost:3001" />);
    await fill();
    fireEvent.click(screen.getByRole('button', { name: '确认创建' }));
    await waitFor(() => expect(state.push).toHaveBeenCalledWith('/admin/ranges/range-1'));
    expect(state.launch).toHaveBeenCalledWith('http://localhost:3001', 'fixture-token', { templateId: 'template-1', name: '训练实例', expiresAt: new Date('2100-01-01T12:00').toISOString() }, expect.any(String));
  });

  it('reuses the original payload and key after an unknown create result', async () => {
    state.launch.mockRejectedValueOnce(new TypeError('network')).mockResolvedValueOnce({ id: 'range-1' });
    render(<RangeInstanceCreateButton apiBaseUrl="http://localhost:3001" />);
    await fill();
    fireEvent.click(screen.getByRole('button', { name: '确认创建' }));
    await screen.findByText(/创建结果尚未确认/);
    fireEvent.click(screen.getByRole('button', { name: '查询原请求' }));
    await waitFor(() => expect(state.launch).toHaveBeenCalledTimes(2));
    expect(state.launch.mock.calls[1]).toEqual(state.launch.mock.calls[0]);
  });

  it('disables the entry for a read-only workspace and permits retrying a template load failure', async () => {
    state.workspace = { workspace: { id: 'old', provider: 'alibaba_cloud', isReadOnly: true, capabilities: { provisioning: true } } };
    const { rerender } = render(<RangeInstanceCreateButton apiBaseUrl="http://localhost:3001" />);
    expect((screen.getByRole('button', { name: '创建实例' }) as HTMLButtonElement).disabled).toBe(true);
    state.workspace = null;
    state.templates.mockRejectedValueOnce(new Error('network'));
    rerender(<RangeInstanceCreateButton apiBaseUrl="http://localhost:3001" />);
    fireEvent.click(screen.getByRole('button', { name: '创建实例' }));
    await screen.findByText('模板读取失败，请重试。');
    fireEvent.click(screen.getByRole('button', { name: '重试', exact: true }));
    await waitFor(() => expect((screen.getByRole('combobox', { name: '靶场模板' }) as HTMLInputElement).disabled).toBe(false));
  });
});
