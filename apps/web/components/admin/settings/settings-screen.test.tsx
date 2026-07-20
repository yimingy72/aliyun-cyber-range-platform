import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  fetchCloudConfigMock,
  fetchCloudAccountContextsMock,
  createCloudAccountContextMock,
  activateCloudAccountContextMock,
  ensureCloudAccountContextBucketMock,
  saveCloudConfigMock,
  replaceMock,
} = vi.hoisted(() => ({
  fetchCloudConfigMock: vi.fn(),
  fetchCloudAccountContextsMock: vi.fn(),
  createCloudAccountContextMock: vi.fn(),
  activateCloudAccountContextMock: vi.fn(),
  ensureCloudAccountContextBucketMock: vi.fn(),
  saveCloudConfigMock: vi.fn(),
  replaceMock: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    replace: replaceMock,
  }),
}));

vi.mock('../../../lib/admin-api', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/admin-api')>('../../../lib/admin-api');

  return {
    ...actual,
    fetchCloudConfig: fetchCloudConfigMock,
    fetchCloudAccountContexts: fetchCloudAccountContextsMock,
    createCloudAccountContext: createCloudAccountContextMock,
    activateCloudAccountContext: activateCloudAccountContextMock,
    ensureCloudAccountContextBucket: ensureCloudAccountContextBucketMock,
    saveCloudConfig: saveCloudConfigMock,
  };
});

import { AdminApiError } from '../../../lib/admin-api';
import * as adminSessionModule from '../use-admin-session';
import { SettingsScreen } from './settings-screen';

const cloudConfigPayload = {
  provider: 'alibaba_cloud' as const,
  defaultRegion: 'cn-hangzhou',
  defaultZoneId: 'cn-hangzhou-h',
  accessKeyId: 'LTAI-test-ak',
  accessKeySecret: 'test-secret',
};

describe('SettingsScreen', () => {
  beforeEach(() => {
    replaceMock.mockReset();
    fetchCloudConfigMock.mockReset();
    fetchCloudAccountContextsMock.mockReset();
    createCloudAccountContextMock.mockReset();
    activateCloudAccountContextMock.mockReset();
    ensureCloudAccountContextBucketMock.mockReset();
    saveCloudConfigMock.mockReset();
    fetchCloudAccountContextsMock.mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('keeps legacy cloud fields and exposes a separate cloud-account image-import profile form', async () => {
    vi.spyOn(adminSessionModule, 'useAdminSession').mockReturnValue({
      token: 'dev-admin-token',
      profile: { id: 'admin', username: 'admin', role: 'admin' },
      isAdmin: true,
      isReady: true,
      login: vi.fn(),
      logout: vi.fn(),
    });
    fetchCloudConfigMock.mockResolvedValue(cloudConfigPayload);

    render(<SettingsScreen apiBaseUrl="http://localhost:3001" />);

    await screen.findByDisplayValue('cn-hangzhou');

    expect(screen.getByLabelText('云平台')).toBeTruthy();
    expect(screen.getByText('5 项配置')).toBeTruthy();
    expect(screen.getByRole('heading', { name: '阿里云账号与镜像存储' })).toBeTruthy();
    expect(screen.getByLabelText('账号名称')).toBeTruthy();
    expect(screen.getByLabelText('镜像导入地域')).toBeTruthy();
    expect(screen.getByLabelText('镜像导入可用区')).toBeTruthy();
    expect(screen.getByLabelText('镜像导入 AccessKey ID')).toBeTruthy();
    expect(screen.getByLabelText('镜像导入 AccessKey Secret')).toBeTruthy();
    expect(screen.getByLabelText('导入 Bucket')).toBeTruthy();
    expect(screen.queryByText('阿里云接入')).toBeNull();
    expect(screen.queryByText('当前阶段基础配置只保留云平台、默认地域、默认可用区和阿里云访问凭据。')).toBeNull();
    expect(screen.getByLabelText('默认地域')).toBeTruthy();
    expect(screen.getByLabelText('默认可用区')).toBeTruthy();
    expect(screen.getByDisplayValue('LTAI-test-ak')).toBeTruthy();
    expect(screen.getByDisplayValue('test-secret')).toBeTruthy();
    expect(screen.queryByText('比赛')).toBeNull();
    expect(screen.queryByText('队伍')).toBeNull();
    expect(screen.queryByText('模板')).toBeNull();
    expect(screen.queryByText('编排模式')).toBeNull();
  });

  it('submits only the cloud config fields used by the new page', async () => {
    vi.spyOn(adminSessionModule, 'useAdminSession').mockReturnValue({
      token: 'dev-admin-token',
      profile: { id: 'admin', username: 'admin', role: 'admin' },
      isAdmin: true,
      isReady: true,
      login: vi.fn(),
      logout: vi.fn(),
    });
    fetchCloudConfigMock.mockResolvedValue(cloudConfigPayload);
    saveCloudConfigMock.mockResolvedValue({
      ...cloudConfigPayload,
    });

    render(<SettingsScreen apiBaseUrl="http://localhost:3001" />);

    await screen.findByDisplayValue('cn-hangzhou');
    fireEvent.click(await screen.findByRole('button', { name: '保存云配置' }));

    await waitFor(() => {
      expect(saveCloudConfigMock).toHaveBeenCalledWith('http://localhost:3001', 'dev-admin-token', {
        provider: 'alibaba_cloud',
        defaultRegion: 'cn-hangzhou',
        defaultZoneId: 'cn-hangzhou-h',
        accessKeyId: 'LTAI-test-ak',
        accessKeySecret: 'test-secret',
      });
    });
  });

  it('locks legacy cloud configuration after a ready account context becomes active', async () => {
    vi.spyOn(adminSessionModule, 'useAdminSession').mockReturnValue({
      token: 'dev-admin-token',
      profile: { id: 'admin', username: 'admin', role: 'admin' },
      isAdmin: true,
      isReady: true,
      login: vi.fn(),
      logout: vi.fn(),
    });
    fetchCloudConfigMock.mockResolvedValue(cloudConfigPayload);
    fetchCloudAccountContextsMock.mockResolvedValue([
      {
        id: 'context-active',
        displayName: '当前训练账号',
        provider: 'alibaba_cloud',
        accountUid: '1234567890',
        regionId: 'cn-hangzhou',
        zoneId: 'cn-hangzhou-h',
        imageImportBucket: 'bucket-active',
        isActive: true,
        status: 'ready',
        bucketStatus: 'ready',
      },
    ]);

    render(<SettingsScreen apiBaseUrl="http://localhost:3001" />);

    expect(await screen.findByText('当前默认云账号由下方“阿里云账号与镜像存储”管理。')).toBeTruthy();
    expect((screen.getByLabelText('默认地域') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '保存云配置' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('creates a cloud account context and lets an administrator repair and switch its import Bucket', async () => {
    vi.spyOn(adminSessionModule, 'useAdminSession').mockReturnValue({
      token: 'dev-admin-token',
      profile: { id: 'admin', username: 'admin', role: 'admin' },
      isAdmin: true,
      isReady: true,
      login: vi.fn(),
      logout: vi.fn(),
    });
    fetchCloudConfigMock.mockResolvedValue(cloudConfigPayload);
    fetchCloudAccountContextsMock.mockResolvedValue([
      {
        id: 'context-degraded',
        displayName: '待修复账号',
        provider: 'alibaba_cloud',
        accountUid: '1234567890',
        regionId: 'cn-hangzhou',
        zoneId: 'cn-hangzhou-h',
        imageImportBucket: 'bucket-degraded',
        isActive: false,
        status: 'degraded',
        bucketStatus: 'failed',
        lastError: 'Bucket permission denied',
      },
      {
        id: 'context-ready',
        displayName: '可切换账号',
        provider: 'alibaba_cloud',
        accountUid: '9876543210',
        regionId: 'cn-shanghai',
        zoneId: 'cn-shanghai-g',
        imageImportBucket: 'bucket-ready',
        isActive: false,
        status: 'ready',
        bucketStatus: 'ready',
      },
    ]);
    ensureCloudAccountContextBucketMock.mockResolvedValue({
      id: 'context-degraded',
      displayName: '待修复账号',
      provider: 'alibaba_cloud',
      accountUid: '1234567890',
      regionId: 'cn-hangzhou',
      zoneId: 'cn-hangzhou-h',
      imageImportBucket: 'bucket-degraded',
      isActive: false,
      status: 'ready',
      bucketStatus: 'ready',
      lastError: null,
    });
    activateCloudAccountContextMock.mockResolvedValue({
      id: 'context-ready',
      displayName: '可切换账号',
      provider: 'alibaba_cloud',
      accountUid: '9876543210',
      regionId: 'cn-shanghai',
      zoneId: 'cn-shanghai-g',
      imageImportBucket: 'bucket-ready',
      isActive: true,
      status: 'ready',
      bucketStatus: 'ready',
      lastError: null,
    });
    createCloudAccountContextMock.mockResolvedValue({
      id: 'context-created',
      displayName: '新训练账号',
      provider: 'alibaba_cloud',
      accountUid: '1122334455',
      regionId: 'cn-beijing',
      zoneId: 'cn-beijing-k',
      imageImportBucket: 'bucket-created',
      isActive: false,
      status: 'ready',
      bucketStatus: 'ready',
      lastError: null,
    });

    render(<SettingsScreen apiBaseUrl="http://localhost:3001" />);

    expect(await screen.findByText('待修复账号 · 1234567890 · cn-hangzhou')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '修复 Bucket' }));
    await waitFor(() => {
      expect(ensureCloudAccountContextBucketMock).toHaveBeenCalledWith(
        'http://localhost:3001',
        'dev-admin-token',
        'context-degraded',
      );
    });
    expect(await screen.findByText('OSS Bucket 已修复并可用于镜像导入。')).toBeTruthy();

    const readyContextRow = screen.getByText('可切换账号 · 9876543210 · cn-shanghai').closest('article');
    expect(readyContextRow).toBeTruthy();
    fireEvent.click(within(readyContextRow as HTMLElement).getByRole('button', { name: '切换到此账号' }));
    await waitFor(() => {
      expect(activateCloudAccountContextMock).toHaveBeenCalledWith(
        'http://localhost:3001',
        'dev-admin-token',
        'context-ready',
      );
    });
    expect(await screen.findByText('已切换当前阿里云账号。')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('账号名称'), { target: { value: '新训练账号' } });
    fireEvent.change(screen.getByLabelText('镜像导入地域'), { target: { value: 'cn-beijing' } });
    fireEvent.change(screen.getByLabelText('镜像导入可用区'), { target: { value: 'cn-beijing-k' } });
    fireEvent.change(screen.getByLabelText('镜像导入 AccessKey ID'), { target: { value: 'new-access-key' } });
    fireEvent.change(screen.getByLabelText('镜像导入 AccessKey Secret'), { target: { value: 'new-access-secret' } });
    fireEvent.change(screen.getByLabelText('导入 Bucket'), { target: { value: 'bucket-created' } });
    fireEvent.click(screen.getByRole('button', { name: '添加并初始化 OSS Bucket' }));

    await waitFor(() => {
      expect(createCloudAccountContextMock).toHaveBeenCalledWith('http://localhost:3001', 'dev-admin-token', {
        displayName: '新训练账号',
        regionId: 'cn-beijing',
        zoneId: 'cn-beijing-k',
        accessKeyId: 'new-access-key',
        accessKeySecret: 'new-access-secret',
        imageImportBucket: 'bucket-created',
      });
    });
    expect(await screen.findByText('云账号已验证，OSS Bucket 已就绪。')).toBeTruthy();
  });

  it('renders nothing before the admin session is ready', () => {
    vi.spyOn(adminSessionModule, 'useAdminSession').mockReturnValue({
      token: null,
      profile: null,
      isAdmin: false,
      isReady: false,
      login: vi.fn(),
      logout: vi.fn(),
    });

    const { container } = render(<SettingsScreen apiBaseUrl="http://localhost:3001" />);

    expect(container.firstChild).toBeNull();
    expect(fetchCloudConfigMock).not.toHaveBeenCalled();
  });

  it('redirects to login when cloud config returns 401', async () => {
    const logoutMock = vi.fn();

    vi.spyOn(adminSessionModule, 'useAdminSession').mockReturnValue({
      token: 'dev-admin-token',
      profile: { id: 'admin', username: 'admin', role: 'admin' },
      isAdmin: true,
      isReady: true,
      login: vi.fn(),
      logout: logoutMock,
    });
    fetchCloudConfigMock.mockRejectedValue(new AdminApiError(401));

    render(<SettingsScreen apiBaseUrl="http://localhost:3001" />);

    await waitFor(() => {
      expect(logoutMock).toHaveBeenCalled();
      expect(replaceMock).toHaveBeenCalledWith('/admin/login');
    });
  });

  it('shows an error message when cloud config loading fails', async () => {
    vi.spyOn(adminSessionModule, 'useAdminSession').mockReturnValue({
      token: 'dev-admin-token',
      profile: { id: 'admin', username: 'admin', role: 'admin' },
      isAdmin: true,
      isReady: true,
      login: vi.fn(),
      logout: vi.fn(),
    });
    fetchCloudConfigMock.mockRejectedValue(new Error('cloud config unavailable'));

    render(<SettingsScreen apiBaseUrl="http://localhost:3001" />);

    await screen.findByText('云配置加载失败，请稍后重试。');
  });

  it('keeps the page shell visible while cloud config is still loading', async () => {
    vi.spyOn(adminSessionModule, 'useAdminSession').mockReturnValue({
      token: 'dev-admin-token',
      profile: { id: 'admin', username: 'admin', role: 'admin' },
      isAdmin: true,
      isReady: true,
      login: vi.fn(),
      logout: vi.fn(),
    });
    let resolveCloudConfig: ((value: typeof cloudConfigPayload) => void) | null = null;
    fetchCloudConfigMock.mockImplementation(
      () =>
        new Promise<typeof cloudConfigPayload>((resolve) => {
          resolveCloudConfig = resolve;
        }),
    );

    render(<SettingsScreen apiBaseUrl="http://localhost:3001" />);

    expect(screen.getAllByRole('heading', { name: '云配置' }).length).toBeGreaterThan(0);
    expect(screen.queryByText('正在加载云配置...')).toBeNull();

    await waitFor(() => expect(resolveCloudConfig).not.toBeNull());
    resolveCloudConfig?.(cloudConfigPayload);
    await waitFor(() => expect(screen.getByDisplayValue('cn-hangzhou')).toBeTruthy());
  });

  it('redirects regular users away from the cloud settings page without loading config', async () => {
    vi.spyOn(adminSessionModule, 'useAdminSession').mockReturnValue({
      token: 'user-token',
      profile: { id: 'user-1', username: 'alice', role: 'user' },
      isAdmin: false,
      isReady: true,
      login: vi.fn(),
      logout: vi.fn(),
    });

    render(<SettingsScreen apiBaseUrl="http://localhost:3001" />);

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith('/admin/scenarios');
    });

    expect(fetchCloudConfigMock).not.toHaveBeenCalled();
    expect(screen.getByText('当前账号无权访问基础配置。')).toBeTruthy();
  });
});
