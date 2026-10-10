import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloudWorkspaceView } from '@/lib/admin-types';

const { list, save, remove, select, replace, logout, state } = vi.hoisted(() => ({ list: vi.fn(), save: vi.fn(), remove: vi.fn(), select: vi.fn(), replace: vi.fn(), logout: vi.fn(), state: { manager: true, sessionManager: true } }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace }) }));
vi.mock('@/lib/admin-api', async () => ({ ...await vi.importActual<typeof import('@/lib/admin-api')>('@/lib/admin-api'), fetchCloudWorkspaces: list, saveCloudAccount: save, deleteCloudAccount: remove }));
vi.mock('../use-admin-session', () => ({ useAdminSession: () => ({ token: 'fixture-token', profile: { id: 'root', username: 'admin', role: 'admin', isPlatformManager: state.sessionManager }, isAdmin: true, isReady: true, logout }) }));
vi.mock('../cloud-workspace-provider', () => ({ cloudProviderLabel: (provider: string) => provider === 'tencent_cloud' ? '腾讯云' : '阿里云', useCloudWorkspace: () => ({ workspace: ali, profile: { id: 'root', username: 'admin', role: 'admin', isPlatformManager: state.manager }, isReady: true, isSwitching: false, refreshCurrent: async () => undefined, switchTo: select }) }));
import { SettingsScreen } from './settings-screen';
import { AdminApiError } from '@/lib/admin-api';
const ali: CloudWorkspaceView = { id: 'ali', provider: 'alibaba_cloud', accountUid: '111', displayName: '杭州训练账号', isReadOnly: false, activeCloudAccountContextId: 'ctx-ali', contexts: [{ id: 'ctx-ali', cloudWorkspaceId: 'ali', provider: 'alibaba_cloud', accountUid: '111', displayName: '杭州', regionId: 'cn-hangzhou', zoneId: 'cn-hangzhou-h', isActive: true, status: 'ready', imageImportBucket: 'owned-bucket', bucketStatus: 'ready' }], capabilities: { provisioning: true, imageImport: true, billingSync: true } };
const tencent: CloudWorkspaceView = { ...ali, id: 'tencent', provider: 'tencent_cloud', accountUid: '222', displayName: '南京训练账号', activeCloudAccountContextId: 'ctx-tencent', contexts: [{ ...ali.contexts[0]!, id: 'ctx-tencent', cloudWorkspaceId: 'tencent', provider: 'tencent_cloud', accountUid: '222', regionId: 'ap-nanjing', zoneId: 'ap-nanjing-1', imageImportBucket: '' }] };
function openTencent() { fireEvent.mouseDown(screen.getByRole('tab', { name: '腾讯云' }), { button: 0, ctrlKey: false }); }
async function openMore(name: string) {
  fireEvent.keyDown(screen.getByRole('button', { name: `账号“${name}”的更多操作` }), { key: 'ArrowDown' });
  await screen.findByRole('menu');
}
function fillTencent() {
  fireEvent.click(screen.getByRole('button', { name: '绑定腾讯云账号' }));
  for (const [label, value] of [['默认地域', 'ap-nanjing'], ['默认可用区', 'ap-nanjing-1'], ['SecretId', 'fixture-secret-id'], ['SecretKey', 'fixture-secret-key']]) fireEvent.change(screen.getByLabelText(label!), { target: { value } });
}
describe('settings cloud workspaces', () => {
  beforeEach(() => { vi.clearAllMocks(); state.manager = true; state.sessionManager = true; list.mockResolvedValue([ali, tencent]); save.mockResolvedValue(tencent.contexts[0]); select.mockResolvedValue(undefined); remove.mockResolvedValue({ id: tencent.id, provider: tencent.provider, accountUid: tencent.accountUid, displayName: tencent.displayName, deletedAt: '2026-10-10T00:00:00Z', retainedData: true }); });
  afterEach(cleanup);
  it('filters providers without switching data and keeps image queries out of settings', async () => {
    render(<SettingsScreen apiBaseUrl="https://fixture.invalid" />);
    await screen.findByText('111');
    expect(screen.queryByText('222')).toBeNull();
    openTencent();
    expect(await screen.findByText('222')).toBeTruthy();
    expect(screen.queryByText('111')).toBeNull();
    expect(select).not.toHaveBeenCalled();
    expect(screen.queryByRole('table', { name: '腾讯云镜像目录' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /切换到此账号/ }));
    await waitFor(() => expect(select).toHaveBeenCalledWith('tencent'));
  });
  it('saves account binding without switching, exposing or retaining credentials', async () => {
    render(<SettingsScreen apiBaseUrl="https://fixture.invalid" />); await screen.findByText('111'); openTencent(); fillTencent();
    fireEvent.submit(screen.getByRole('form', { name: '云账号绑定表单' }));
    await screen.findByText('账号已保存。');
    expect(save).toHaveBeenCalledWith('https://fixture.invalid', 'fixture-token', expect.objectContaining({ provider: 'tencent_cloud', accessKeyId: 'fixture-secret-id', accessKeySecret: 'fixture-secret-key' }));
    expect(select).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '绑定腾讯云账号' }));
    expect((screen.getByLabelText('SecretKey') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('SecretId') as HTMLInputElement).value).toBe('');
  });
  it('edits a named account with an explicit workspace and fresh credentials', async () => {
    save.mockResolvedValue(ali.contexts[0]);
    render(<SettingsScreen apiBaseUrl="https://fixture.invalid" />); await screen.findByText('111');
    await openMore(ali.displayName);
    fireEvent.click(screen.getByRole('menuitem', { name: '编辑配置' }));
    expect((screen.getByLabelText('AccessKey Secret') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('AccessKey ID') as HTMLInputElement).value).toBe('');
    fireEvent.change(screen.getByLabelText('AccessKey ID'), { target: { value: 'fixture-id' } });
    fireEvent.change(screen.getByLabelText('AccessKey Secret'), { target: { value: 'fixture-key' } });
    fireEvent.submit(screen.getByRole('form', { name: '云账号绑定表单' }));
    await waitFor(() => expect(save).toHaveBeenCalledWith('https://fixture.invalid', 'fixture-token', expect.objectContaining({ cloudWorkspaceId: 'ali', provider: 'alibaba_cloud' })));
  });
  it('preserves current workspace on failed switch and reports its error', async () => {
    select.mockRejectedValue(new Error('账号不可切换'));
    render(<SettingsScreen />); await screen.findByText('111'); openTencent();
    fireEvent.click(screen.getByRole('button', { name: /切换到此账号/ }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '账号不可切换');
    expect(screen.queryByText('当前工作空间')).toBeNull();
    expect(select).toHaveBeenCalledWith(tencent.id);
  });
  it('keeps workspace administrators from binding unrelated cloud accounts', async () => {
    state.manager = false; render(<SettingsScreen />); await screen.findByText('111');
    expect(screen.queryByRole('button', { name: '绑定阿里云账号' })).toBeNull();
    expect(screen.queryByRole('button', { name: /更多操作/ })).toBeNull();
  });
  it('keeps binding controls based on the verified profile when same-user stored metadata loses its manager flag', async () => {
    const page = render(<SettingsScreen />); await screen.findByText('111');
    expect(screen.getByRole('button', { name: '绑定阿里云账号' })).toBeTruthy();
    state.sessionManager = false; page.rerender(<SettingsScreen />);
    expect(screen.getByRole('button', { name: '绑定阿里云账号' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /更多操作/ })).toBeTruthy();
  });
  it('rejects mismatched saves and suppresses a late completion after leaving the page', async () => {
    save.mockResolvedValue(ali.contexts[0]); render(<SettingsScreen />); await screen.findByText('111'); openTencent(); fillTencent();
    fireEvent.submit(screen.getByRole('form', { name: '云账号绑定表单' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '保存返回的绑定账号不一致，请刷新核对。');
    let resolve!: (value: typeof tencent.contexts[0]) => void;
    save.mockImplementation(() => new Promise(done => { resolve = done; }));
    fireEvent.submit(screen.getByRole('form', { name: '云账号绑定表单' }));
    cleanup(); await act(async () => { resolve(tencent.contexts[0]); });
    expect(select).not.toHaveBeenCalled();
  });
  it('uses the normal session expiration path for account list failures', async () => {
    list.mockRejectedValue(new AdminApiError(401)); render(<SettingsScreen />);
    await waitFor(() => expect(logout).toHaveBeenCalled()); expect(replace).toHaveBeenCalledWith('/admin/login');
  });
  it('keeps the current marker in its account row and removes repeated explanatory blocks', async () => {
    render(<SettingsScreen />); await screen.findByText('111');
    const row = screen.getByText(ali.displayName).closest('tr')!;
    expect(within(row).getByText('当前')).toBeTruthy();
    expect(screen.queryByText('当前工作空间')).toBeNull();
    expect(screen.queryByText(/每个云厂商主账号对应独立/)).toBeNull();
    expect(screen.queryByRole('button', { name: '当前账号' })).toBeNull();
    expect(screen.queryByRole('form')).toBeNull();
    await openMore(ali.displayName);
    expect((await screen.findByRole('menuitem', { name: /删除账号/ })).getAttribute('aria-disabled')).toBe('true');
    expect(remove).not.toHaveBeenCalled();
  });
  it('confirms the exact non-current account before removing it and keeps the current account', async () => {
    render(<SettingsScreen apiBaseUrl="https://fixture.invalid" />); await screen.findByText('111'); openTencent();
    await openMore(tencent.displayName);
    fireEvent.click(screen.getByRole('menuitem', { name: '删除账号' }));
    const dialog = await screen.findByRole('dialog', { name: '删除云账号' });
    expect(within(dialog).getByText(/南京训练账号.*历史数据保留/)).toBeTruthy();
    expect(within(dialog).getByText(/账单同步将停止，未出账费用需重新绑定/)).toBeTruthy();
    expect(remove).not.toHaveBeenCalled();
    list.mockResolvedValue([ali]);
    fireEvent.click(within(dialog).getByRole('button', { name: '删除账号' }));
    await screen.findByText('账号已删除，历史数据已保留。');
    expect(remove).toHaveBeenCalledWith('https://fixture.invalid', 'fixture-token', tencent.id);
    expect(select).not.toHaveBeenCalled();
    expect(screen.queryByText('222')).toBeNull();
  });
  it('cancels without deleting and keeps the account on a server resource conflict', async () => {
    render(<SettingsScreen />); await screen.findByText('111'); openTencent(); await openMore(tencent.displayName);
    fireEvent.click(screen.getByRole('menuitem', { name: '删除账号' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '取消' }));
    expect(remove).not.toHaveBeenCalled();
    await openMore(tencent.displayName); fireEvent.click(screen.getByRole('menuitem', { name: '删除账号' }));
    remove.mockRejectedValue(new AdminApiError(409, '该账号仍有未回收资源。'));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '删除账号' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '该账号仍有未回收资源。');
    expect(screen.getByText('222')).toBeTruthy();
  });
  it('rejects a mismatched deletion receipt and keeps the row for reconciliation', async () => {
    remove.mockResolvedValue({ id: ali.id, provider: ali.provider, accountUid: ali.accountUid, retainedData: true });
    render(<SettingsScreen />); await screen.findByText('111'); openTencent(); await openMore(tencent.displayName);
    fireEvent.click(screen.getByRole('menuitem', { name: '删除账号' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '删除账号' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '删除返回的账号不一致，请刷新核对。');
    expect(screen.getByText('222')).toBeTruthy();
  });
});
