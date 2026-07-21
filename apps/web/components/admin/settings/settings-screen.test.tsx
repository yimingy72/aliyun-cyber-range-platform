import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  fetchCloudConfigMock,
  saveCloudConfigMock,
  replaceMock,
} = vi.hoisted(() => ({
  fetchCloudConfigMock: vi.fn(),
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
  imageImportBucket: '',
};

function mockAdminSession() {
  vi.spyOn(adminSessionModule, 'useAdminSession').mockReturnValue({
    token: 'dev-admin-token',
    profile: { id: 'admin', username: 'admin', role: 'admin' },
    isAdmin: true,
    isReady: true,
    login: vi.fn(),
    logout: vi.fn(),
  });
}

describe('SettingsScreen', () => {
  beforeEach(() => {
    replaceMock.mockReset();
    fetchCloudConfigMock.mockReset();
    saveCloudConfigMock.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('uses cloud configuration as the only image-import storage setup entry point', async () => {
    mockAdminSession();
    fetchCloudConfigMock.mockResolvedValue(cloudConfigPayload);

    render(<SettingsScreen apiBaseUrl="http://localhost:3001" />);

    await screen.findByDisplayValue('cn-hangzhou');

    expect(screen.getByRole('heading', { name: '云配置' })).toBeTruthy();
    expect(screen.getByText('保存时将校验当前阿里云账号。镜像导入仅使用管理员提供的现有 OSS Bucket；平台不会创建 Bucket 或修改其权限、CORS。')).toBeTruthy();
    expect(screen.getByLabelText('自定义 OSS 存储桶名')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: '阿里云账号与镜像存储' })).toBeNull();
    expect(screen.queryByLabelText('账号名称')).toBeNull();
    expect(screen.queryByLabelText('导入 Bucket')).toBeNull();
  });

  it('saves cloud configuration without claiming that an optional Bucket is ready', async () => {
    mockAdminSession();
    fetchCloudConfigMock.mockResolvedValue(cloudConfigPayload);
    saveCloudConfigMock.mockResolvedValue({
      ...cloudConfigPayload,
      accessKeySecret: '********',
    });

    render(<SettingsScreen apiBaseUrl="http://localhost:3001" />);

    await screen.findByDisplayValue('cn-hangzhou');
    fireEvent.click(screen.getByRole('button', { name: '保存云配置' }));

    await waitFor(() => {
      expect(saveCloudConfigMock).toHaveBeenCalledWith('http://localhost:3001', 'dev-admin-token', cloudConfigPayload);
    });
    expect(await screen.findByText('云配置已保存。')).toBeTruthy();
  });

  it('shows the STS or OSS initialization error returned while saving', async () => {
    mockAdminSession();
    fetchCloudConfigMock.mockResolvedValue(cloudConfigPayload);
    saveCloudConfigMock.mockRejectedValue(new AdminApiError(400, '阿里云账号身份校验失败（HTTP 403）。'));

    render(<SettingsScreen apiBaseUrl="http://localhost:3001" />);

    await screen.findByDisplayValue('cn-hangzhou');
    fireEvent.click(screen.getByRole('button', { name: '保存云配置' }));

    expect(await screen.findByText('阿里云账号身份校验失败（HTTP 403）。')).toBeTruthy();
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

  it('redirects to login when cloud configuration returns 401', async () => {
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

  it('keeps the page shell visible while cloud configuration is loading', async () => {
    mockAdminSession();
    let resolveCloudConfig: ((value: typeof cloudConfigPayload) => void) | null = null;
    fetchCloudConfigMock.mockImplementation(
      () => new Promise<typeof cloudConfigPayload>((resolve) => {
        resolveCloudConfig = resolve;
      }),
    );

    render(<SettingsScreen apiBaseUrl="http://localhost:3001" />);

    expect(screen.getByRole('heading', { name: '云配置' })).toBeTruthy();
    expect((screen.getByRole('button', { name: '保存云配置' }) as HTMLButtonElement).disabled).toBe(true);

    await waitFor(() => expect(resolveCloudConfig).not.toBeNull());
    resolveCloudConfig?.(cloudConfigPayload);
    await screen.findByDisplayValue('cn-hangzhou');
  });

  it('redirects regular users away from cloud settings without loading configuration', async () => {
    vi.spyOn(adminSessionModule, 'useAdminSession').mockReturnValue({
      token: 'user-token',
      profile: { id: 'user-1', username: 'alice', role: 'user' },
      isAdmin: false,
      isReady: true,
      login: vi.fn(),
      logout: vi.fn(),
    });

    render(<SettingsScreen apiBaseUrl="http://localhost:3001" />);

    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith('/admin/scenarios'));
    expect(fetchCloudConfigMock).not.toHaveBeenCalled();
    expect(screen.getByText('当前账号无权访问基础配置。')).toBeTruthy();
  });
});
