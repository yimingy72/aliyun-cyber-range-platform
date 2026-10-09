import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloudWorkspaceView } from '@/lib/admin-types';
import { clearAdminSession, writeAdminSession } from '@/lib/admin-auth-storage';
import { readCloudWorkspaceSelection, setCloudWorkspaceSelection } from '@/lib/cloud-workspace-selection';
const { profile, current, select } = vi.hoisted(() => ({ profile: vi.fn(), current: vi.fn(), select: vi.fn() }));
vi.mock('@/lib/admin-api', async () => ({ ...await vi.importActual<typeof import('@/lib/admin-api')>('@/lib/admin-api'), fetchAuthenticatedAdminProfile: profile, fetchCurrentCloudWorkspace: current, switchCloudWorkspace: select }));
import { CloudWorkspaceProvider, useCloudWorkspace } from './cloud-workspace-provider';
const ali: CloudWorkspaceView = { id: 'ali', provider: 'alibaba_cloud', accountUid: '111', displayName: '阿里训练', isReadOnly: false, activeCloudAccountContextId: null, contexts: [], capabilities: { provisioning: true, imageImport: true, billingSync: true } };
const tencent = { ...ali, id: 'tencent', provider: 'tencent_cloud' as const, displayName: '腾讯训练' };
function TestPage() {
  const state = useCloudWorkspace()!;
  return <><span>{state.isReady ? state.workspace?.displayName ?? '未绑定' : '未恢复'}</span>{state.error ? <p role="alert">{state.error}</p> : null}<button onClick={() => void state.switchTo('tencent').catch(() => undefined)}>切换腾讯</button><button onClick={() => void state.refreshCurrent()}>刷新配置</button><button onClick={state.resetSelection}>使用默认账号</button></>;
}
describe('cloud workspace request selection', () => {
  beforeEach(() => {
    window.localStorage.clear(); window.sessionStorage.clear(); clearAdminSession(); vi.clearAllMocks();
    writeAdminSession({ token: 'fixture-token', profile: { id: 'root', username: 'admin', role: 'admin' } });
    profile.mockResolvedValue({ id: 'root', username: 'admin', role: 'admin', isPlatformManager: true, cloudWorkspaceId: null });
    current.mockResolvedValue(ali); select.mockResolvedValue(tencent); setCloudWorkspaceSelection('root', null);
  });
  afterEach(cleanup);
  it('waits for verified profile and workspace before establishing a business request scope', async () => {
    let resolve!: (value: typeof ali) => void; current.mockImplementation(() => new Promise(done => { resolve = done; }));
    render(<CloudWorkspaceProvider><TestPage /></CloudWorkspaceProvider>);
    expect(screen.getByText('未恢复')).toBeTruthy(); expect(readCloudWorkspaceSelection()).toBeNull();
    await act(async () => resolve(ali));
    expect(await screen.findByText('阿里训练')).toBeTruthy(); expect(readCloudWorkspaceSelection()).toBe('ali');
  });
  it('keeps an explicit window selection through token renewal and switches only on a deliberate action', async () => {
    setCloudWorkspaceSelection('root', 'ali');
    render(<CloudWorkspaceProvider><TestPage /></CloudWorkspaceProvider>);
    await screen.findByText('阿里训练');
    expect(current).toHaveBeenCalledWith(expect.any(String), 'fixture-token', 'ali');
    fireEvent.click(screen.getByText('切换腾讯'));
    await screen.findByText('腾讯训练'); expect(readCloudWorkspaceSelection()).toBe('tencent');
    await act(async () => { writeAdminSession({ token: 'renewed-token', profile: { id: 'root', username: 'admin', role: 'admin', isPlatformManager: true } }); });
    expect(screen.getByText('腾讯训练')).toBeTruthy(); expect(current).toHaveBeenCalledTimes(1);
  });
  it('fails closed for an invalid saved scope and allows an explicit reset', async () => {
    setCloudWorkspaceSelection('root', 'forbidden'); current.mockRejectedValueOnce(new Error('工作空间不可访问'));
    render(<CloudWorkspaceProvider><TestPage /></CloudWorkspaceProvider>);
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '工作空间不可访问');
    expect(screen.queryByText('阿里训练')).toBeNull(); expect(readCloudWorkspaceSelection()).toBe('forbidden');
    fireEvent.click(screen.getByText('使用默认账号'));
    await screen.findByText('阿里训练'); expect(current).toHaveBeenLastCalledWith(expect.any(String), 'fixture-token', null);
  });
  it('keeps the previous selection if the switch fails or replies with a different workspace', async () => {
    select.mockResolvedValue({ ...tencent, id: 'other' });
    render(<CloudWorkspaceProvider><TestPage /></CloudWorkspaceProvider>); await screen.findByText('阿里训练');
    fireEvent.click(screen.getByText('切换腾讯')); await waitFor(() => expect(select).toHaveBeenCalledTimes(1));
    expect(screen.getByText('阿里训练')).toBeTruthy(); expect(readCloudWorkspaceSelection()).toBe('ali');
  });
  it('waits for token renewal instead of querying metadata with an expiring credential', async () => {
    const token = (expiresAt: number) => `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ exp: expiresAt })).toString('base64url')}.fixture`;
    const initial = { token: token(Math.floor(Date.now() / 1000) - 1), refreshToken: 'fixture-refresh', profile: { id: 'root', username: 'admin', role: 'admin' as const } };
    writeAdminSession(initial); render(<CloudWorkspaceProvider><TestPage /></CloudWorkspaceProvider>);
    expect(current).not.toHaveBeenCalled();
    await act(async () => writeAdminSession({ ...initial, token: token(Math.floor(Date.now() / 1000) + 3600) }));
    await screen.findByText('阿里训练'); expect(current).toHaveBeenCalledTimes(1);
  });
  it('does not let a delayed refresh from A replace B after a same-user account switch', async () => {
    render(<CloudWorkspaceProvider><TestPage /></CloudWorkspaceProvider>); await screen.findByText('阿里训练');
    let resolve!: (value: CloudWorkspaceView) => void;
    current.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    fireEvent.click(screen.getByText('刷新配置'));
    fireEvent.click(screen.getByText('切换腾讯'));
    await screen.findByText('腾讯训练'); expect(readCloudWorkspaceSelection()).toBe('tencent');
    await act(async () => { resolve({ ...ali, displayName: '旧阿里配置' }); });
    expect(screen.getByText('腾讯训练')).toBeTruthy(); expect(screen.queryByText('旧阿里配置')).toBeNull();
    expect(readCloudWorkspaceSelection()).toBe('tencent');
  });
  it('keeps the newer refresh when concurrent requests resolve in reverse order', async () => {
    render(<CloudWorkspaceProvider><TestPage /></CloudWorkspaceProvider>); await screen.findByText('阿里训练');
    let older!: (value: CloudWorkspaceView) => void; let newer!: (value: CloudWorkspaceView) => void;
    current.mockImplementationOnce(() => new Promise(done => { older = done; })).mockImplementationOnce(() => new Promise(done => { newer = done; }));
    fireEvent.click(screen.getByText('刷新配置')); fireEvent.click(screen.getByText('刷新配置'));
    await act(async () => { newer({ ...ali, displayName: '最新阿里配置' }); });
    expect(screen.getByText('最新阿里配置')).toBeTruthy();
    await act(async () => { older({ ...ali, displayName: '旧阿里配置' }); });
    expect(screen.getByText('最新阿里配置')).toBeTruthy(); expect(screen.queryByText('旧阿里配置')).toBeNull();
    expect(readCloudWorkspaceSelection()).toBe('ali');
  });
});
