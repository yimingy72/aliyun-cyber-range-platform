import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  fetchMogongImageCatalog: vi.fn(), fetchCustomImageCatalogScope: vi.fn(), fetchPlatformImages: vi.fn(),
  fetchPlatformContainerImages: vi.fn(),
  syncCustomImages: vi.fn(), collectMogongImage: vi.fn(),
}));
vi.mock('../../lib/admin-api', async () => ({ ...await vi.importActual<typeof import('../../lib/admin-api')>('../../lib/admin-api'), ...api }));

import { MogongImageCatalogView } from './mogong-image-catalog';
import { AdminScreenCacheProvider } from '../../lib/admin-screen-cache';
import { clearAdminSession, writeAdminSession } from '../../lib/admin-auth-storage';
import { setCloudWorkspaceSelection } from '../../lib/cloud-workspace-selection';

const snapshots = [
  { id: 'cloud-1', provider: 'alibaba_cloud', imageId: 'm-ready', isAvailable: true },
  { id: 'cloud-2', provider: 'alibaba_cloud', imageId: 'm-disabled', isAvailable: true },
  { id: 'cloud-3', provider: 'alibaba_cloud', imageId: 'm-retired', isAvailable: true },
];
const catalog = { capturedAt: '2026-10-28T00:00:00Z', total: 5, containersCollectable: true, items: [
  { id: 1, name: '可用靶机', type: 'vm', imageId: 'm-ready', active: true, status: 'successful', creator: '张三' },
  { id: 2, name: '停用靶机', type: 'vm', imageId: 'm-disabled', active: false, status: 'successful', creator: null },
  { id: 3, name: '靶机-废弃', type: 'vm', imageId: 'm-retired', active: true, status: 'successful', creator: null },
  { id: 4, name: '容器靶机', type: 'docker', imageId: null, active: true, status: 'successful', creator: null, containerReferenceStatus: 'recorded' },
  { id: 5, name: '未匹配靶机', type: 'vm', imageId: 'm-missing', active: true, status: 'successful', creator: null },
] };
const props = { apiBaseUrl: 'http://api', token: 'token', search: '', readOnly: false, refreshRevision: 0, logout: vi.fn(), onCollected: vi.fn(), onContainerCollected: vi.fn(), onCloudSynced: vi.fn() };
let actionHost: HTMLDivElement;

beforeEach(() => {
  actionHost = document.createElement('div');
  document.body.appendChild(actionHost);
  vi.clearAllMocks();
  api.fetchMogongImageCatalog.mockResolvedValue(catalog);
  api.fetchCustomImageCatalogScope.mockResolvedValue({ snapshots, catalogItems: [] });
  api.fetchPlatformImages.mockResolvedValue({ items: [] });
  api.fetchPlatformContainerImages.mockResolvedValue({ items: [] });
  api.syncCustomImages.mockResolvedValue({ snapshots: [...snapshots, { id: 'cloud-5', provider: 'alibaba_cloud', imageId: 'm-missing', isAvailable: true }], catalogItems: [] });
  api.collectMogongImage.mockResolvedValue({ id: 'asset-1', imageId: 'm-ready' });
});
afterEach(() => { cleanup(); actionHost.remove(); setCloudWorkspaceSelection('cache-user', null); clearAdminSession(); });

describe('墨攻镜像中心', () => {
  it('collects only eligible cloud-matched entries and updates the platform view', async () => {
    render(<MogongImageCatalogView {...props} actionHost={actionHost} />);
    await screen.findByText('可用靶机');
    const table = screen.getByRole('table', { name: '墨攻镜像中心' });
    const headers = within(table).getAllByRole('columnheader').map((header) => header.textContent);
    expect(headers).toEqual(['镜像名', '镜像类型', '阿里云镜像 ID', '状态', '创建人', '操作']);
    expect(within(screen.getByText('可用靶机').closest('tr')!).getByText('张三')).toBeTruthy();
    expect((screen.getByRole('button', { name: '收录到平台 停用靶机' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '收录到平台 靶机-废弃' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '收录到平台 容器靶机' }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole('button', { name: '收录到平台 未匹配靶机' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '收录到平台 可用靶机' }));
    await waitFor(() => expect(api.collectMogongImage).toHaveBeenCalledWith('http://api', 'token', 1));
    expect(await screen.findByRole('button', { name: '已收录 可用靶机' })).toBeTruthy();
    expect(props.onCollected).toHaveBeenCalledWith({ id: 'asset-1', imageId: 'm-ready' });
    api.collectMogongImage.mockResolvedValueOnce({ id: 'container-1', sourceId: 4, displayName: '容器靶机', creator: null, referenceStatus: 'recorded', createdAt: '2026-10-28T00:00:00Z' });
    fireEvent.click(screen.getByRole('button', { name: '收录到平台 容器靶机' }));
    expect(await screen.findByRole('button', { name: '已收录 容器靶机' })).toBeTruthy();
    expect(props.onContainerCollected).toHaveBeenCalledWith(expect.objectContaining({ sourceId: 4 }));
  });

  it('matches newly synced cloud images and searches by source or cloud ID', async () => {
    const { rerender } = render(<MogongImageCatalogView {...props} actionHost={actionHost} />);
    await screen.findByText('未匹配靶机');
    fireEvent.click(screen.getByRole('button', { name: '同步云镜像' }));
    await waitFor(() => expect((screen.getByRole('button', { name: '收录到平台 未匹配靶机' }) as HTMLButtonElement).disabled).toBe(false));
    expect(props.onCloudSynced).toHaveBeenCalled();
    rerender(<MogongImageCatalogView {...props} actionHost={actionHost} search="m-missing" />);
    expect(screen.getByText('未匹配靶机')).toBeTruthy();
    expect(screen.queryByText('可用靶机')).toBeNull();
  });

  it('does not report a reused private asset as a published platform image', async () => {
    api.collectMogongImage.mockResolvedValue({ id: 'private-1', imageId: 'm-ready', visibility: 'private' });
    render(<MogongImageCatalogView {...props} actionHost={actionHost} />);
    fireEvent.click(await screen.findByRole('button', { name: '收录到平台 可用靶机' }));
    expect(await screen.findByText('该镜像已存在为私有资产，请由管理员将其发布到平台。')).toBeTruthy();
    expect(screen.getByText('私有镜像待发布')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '已收录 可用靶机' })).toBeNull();
  });

  it('shows sync failures and re-enables the toolbar action', async () => {
    api.syncCustomImages.mockRejectedValueOnce(new Error('同步失败'));
    render(<MogongImageCatalogView {...props} actionHost={actionHost} />);
    await screen.findByText('可用靶机');
    const syncButton = within(actionHost).getByRole('button', { name: '同步云镜像' }) as HTMLButtonElement;
    fireEvent.click(syncButton);
    expect((await screen.findByRole('alert')).textContent).toContain('同步失败');
    await waitFor(() => expect(syncButton.disabled).toBe(false));
    expect(screen.queryByText(/墨攻目录快照/)).toBeNull();
  });

  it('reuses the current workspace cache on revisit and invalidates it after collecting', async () => {
    const screenFor = (visible: boolean) => <AdminScreenCacheProvider>{visible ? <MogongImageCatalogView {...props} actionHost={actionHost} /> : <span>其他页面</span>}</AdminScreenCacheProvider>;
    const { rerender } = render(screenFor(true));
    await screen.findByText('可用靶机');
    rerender(screenFor(false));
    rerender(screenFor(true));
    expect(await screen.findByText('可用靶机')).toBeTruthy();
    expect(api.fetchMogongImageCatalog).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: '收录到平台 可用靶机' }));
    await screen.findByRole('button', { name: '已收录 可用靶机' });
    rerender(screenFor(false));
    rerender(screenFor(true));
    await waitFor(() => expect(api.fetchMogongImageCatalog).toHaveBeenCalledTimes(2));
  });

  it('does not reuse the cached catalog after switching workspaces', async () => {
    writeAdminSession({ token: 'token', profile: { id: 'cache-user', username: 'cache-user', role: 'admin' } });
    setCloudWorkspaceSelection('cache-user', 'workspace-a');
    const screenFor = (visible: boolean) => <AdminScreenCacheProvider>{visible ? <MogongImageCatalogView {...props} actionHost={actionHost} /> : <span>其他页面</span>}</AdminScreenCacheProvider>;
    const { rerender } = render(screenFor(true));
    await screen.findByText('可用靶机');
    rerender(screenFor(false));
    setCloudWorkspaceSelection('cache-user', 'workspace-b');
    rerender(screenFor(true));
    await waitFor(() => expect(api.fetchMogongImageCatalog).toHaveBeenCalledTimes(2));
    setCloudWorkspaceSelection('cache-user', null);
    clearAdminSession();
  });
});
