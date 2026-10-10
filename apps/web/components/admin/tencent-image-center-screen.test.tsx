import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloudWorkspaceView, TencentCloudImagesInput, TencentCloudImagesPayload } from '@/lib/admin-types';
const { images, assets } = vi.hoisted(() => ({ images: vi.fn(), assets: vi.fn() }));
vi.mock('@/lib/admin-api', async () => ({ ...await vi.importActual<typeof import('@/lib/admin-api')>('@/lib/admin-api'), fetchTencentCloudImages: images, fetchPlatformImages: assets }));
vi.mock('./use-admin-session', () => ({ useAdminSession: () => ({ token: 'fixture-token', isAdmin: true, isReady: true, logout: vi.fn() }) }));
import { TencentImageCenterScreen } from './tencent-image-center-screen';
const workspace: CloudWorkspaceView = { id: 'tencent-space', provider: 'tencent_cloud', accountUid: '222', displayName: '南京训练账号', isReadOnly: false, activeCloudAccountContextId: 'context', contexts: [{ id: 'context', cloudWorkspaceId: 'tencent-space', provider: 'tencent_cloud', accountUid: '222', displayName: '南京', regionId: 'ap-nanjing', zoneId: 'ap-nanjing-1', isActive: true, status: 'ready', imageImportBucket: '', bucketStatus: 'unconfigured' }], capabilities: { provisioning: false, imageImport: false, billingSync: false } };
function result(input: TencentCloudImagesInput, name = '腾讯测试镜像'): TencentCloudImagesPayload { return { provider: 'tencent_cloud', cloudAccountContextId: input.cloudAccountContextId, accountUid: '222', regionId: 'ap-nanjing', zoneId: 'ap-nanjing-1', scope: input.scope, offset: input.offset ?? 0, limit: input.limit ?? 20, totalCount: 1, items: [{ imageId: 'img-fixture', displayName: name, platform: 'Ubuntu', status: 'NORMAL', isAvailable: true, architecture: 'x86_64' }] }; }
function cloud() { fireEvent.mouseDown(screen.getByRole('tab', { name: '云上镜像来源' }), { button: 0, ctrlKey: false }); }
describe('Tencent images in the image center', () => {
  beforeEach(() => { vi.clearAllMocks(); assets.mockResolvedValue({ items: [] }); images.mockImplementation(async (_url, _token, input) => result(input)); });
  afterEach(cleanup);
  it('queries only the current workspace context and never renders credentials or an account selector', async () => {
    render(<TencentImageCenterScreen apiBaseUrl="https://fixture.invalid" workspace={workspace} />);
    await screen.findByText('当前没有该类型镜像'); cloud();
    expect(await screen.findByText('腾讯测试镜像')).toBeTruthy();
    expect(images).toHaveBeenCalledWith('https://fixture.invalid', 'fixture-token', { cloudAccountContextId: 'context', scope: 'custom', offset: 0, limit: 20 });
    expect(screen.queryByLabelText('SecretKey')).toBeNull(); expect(screen.queryByLabelText('腾讯云镜像账号')).toBeNull();
  });
  it('refuses mismatched account results and contexts from another workspace', async () => {
    images.mockImplementation(async (_url, _token, input) => ({ ...result(input, '外国账号镜像'), accountUid: '999' }));
    const view = render(<TencentImageCenterScreen apiBaseUrl="https://fixture.invalid" workspace={workspace} />);
    await screen.findByText('当前没有该类型镜像'); cloud();
    expect(await screen.findByText('镜像返回的账号或查询范围不一致，请刷新核对。')).toBeTruthy();
    expect(screen.queryByText('外国账号镜像')).toBeNull();
    images.mockClear();
    view.rerender(<TencentImageCenterScreen apiBaseUrl="https://fixture.invalid" workspace={{ ...workspace, contexts: [{ ...workspace.contexts[0]!, cloudWorkspaceId: 'another' }] }} />);
    await screen.findByText('当前工作空间尚未配置可用的腾讯云地域。'); expect(images).not.toHaveBeenCalled();
  });
  it('does not show a late response after the workspace source has changed', async () => {
    let resolve!: (result: TencentCloudImagesPayload) => void;
    images.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const view = render(<TencentImageCenterScreen apiBaseUrl="https://fixture.invalid" workspace={workspace} />);
    await screen.findByText('当前没有该类型镜像'); cloud(); await waitFor(() => expect(images).toHaveBeenCalledTimes(1));
    view.rerender(<TencentImageCenterScreen apiBaseUrl="https://fixture.invalid" workspace={{ ...workspace, id: 'other', contexts: [] }} />);
    await act(async () => resolve(result({ cloudAccountContextId: 'context', scope: 'custom', offset: 0, limit: 20 }, '旧空间镜像')));
    expect(screen.queryByText('旧空间镜像')).toBeNull();
  });
});
