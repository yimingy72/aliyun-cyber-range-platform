import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  fetchCloudConfigMock,
  saveCloudConfigMock,
  fetchContextsMock,
  fetchTencentImagesMock,
  saveTencentAccountMock,
  replaceMock,
  routerMock,
} = vi.hoisted(() => {
  const replaceMock = vi.fn();

  return {
    fetchCloudConfigMock: vi.fn(),
    saveCloudConfigMock: vi.fn(),
    fetchContextsMock: vi.fn(),
    fetchTencentImagesMock: vi.fn(),
    saveTencentAccountMock: vi.fn(),
    replaceMock,
    routerMock: {
      replace: replaceMock,
    },
  };
});

vi.mock('next/navigation', () => ({
  useRouter: () => routerMock,
}));

vi.mock('../../../lib/admin-api', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/admin-api')>('../../../lib/admin-api');

  return {
    ...actual,
    fetchCloudConfig: fetchCloudConfigMock,
    saveCloudConfig: saveCloudConfigMock,
    fetchCloudAccountContexts: fetchContextsMock,
    fetchTencentCloudImages: fetchTencentImagesMock,
    saveTencentCloudAccount: saveTencentAccountMock,
  };
});

import { AdminApiError } from '../../../lib/admin-api';
import { AdminScreenCacheProvider } from '../../../lib/admin-screen-cache';
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
    idToken: null,
    refreshToken: null,
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
    fetchContextsMock.mockReset().mockResolvedValue([]);
    fetchTencentImagesMock.mockReset();
    saveTencentAccountMock.mockReset();
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

  it('opens an independent Tencent form without copying cached Aliyun credentials or submitting the Aliyun save action', async () => {
    mockAdminSession();
    fetchCloudConfigMock.mockResolvedValue(cloudConfigPayload);
    render(<AdminScreenCacheProvider><SettingsScreen apiBaseUrl="http://localhost:3001" /></AdminScreenCacheProvider>);
    await screen.findByDisplayValue(cloudConfigPayload.accessKeyId);
    fireEvent.mouseDown(screen.getByRole('tab', { name: '腾讯云接入' }), { button: 0, ctrlKey: false });
    await screen.findByLabelText('SecretKey');
    for (const label of ['SecretId', 'SecretKey', '腾讯云地域', '腾讯云可用区']) expect((screen.getByLabelText(label) as HTMLInputElement).value).toBe('');
    expect(screen.queryByRole('button', { name: '保存云配置' })).toBeNull();
    expect(saveCloudConfigMock).not.toHaveBeenCalled();
    expect(fetchContextsMock).toHaveBeenCalledWith('http://localhost:3001', 'dev-admin-token', true);
    expect(fetchTencentImagesMock).not.toHaveBeenCalled();
    fireEvent.mouseDown(screen.getByRole('tab', { name: '阿里云配置' }), { button: 0, ctrlKey: false });
    expect(await screen.findByDisplayValue(cloudConfigPayload.accessKeyId)).toBeTruthy();
    expect(saveTencentAccountMock).not.toHaveBeenCalled();
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

    expect((await within(screen.getByTestId('cloud-config-form')).findByRole('status')).textContent).toBe('云配置已保存。');
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
      idToken: null,
      refreshToken: null,
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
      idToken: null,
      refreshToken: null,
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
    const deferred = { resolve: null as ((value: typeof cloudConfigPayload) => void) | null };
    fetchCloudConfigMock.mockImplementation(
      () => new Promise<typeof cloudConfigPayload>((resolve) => {
        deferred.resolve = resolve;
      }),
    );

    render(<SettingsScreen apiBaseUrl="http://localhost:3001" />);

    expect(screen.getByRole('heading', { name: '云配置' })).toBeTruthy();
    expect((screen.getByRole('button', { name: '保存云配置' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('cloud-config-form').getAttribute('aria-busy')).toBe('true');
    expect(screen.getByTestId('cloud-config-form-skeleton')).toBeTruthy();
    expect(screen.queryByLabelText('默认地域')).toBeNull();

    await waitFor(() => expect(deferred.resolve).not.toBeNull());
    deferred.resolve?.(cloudConfigPayload);
    await screen.findByDisplayValue('cn-hangzhou');
  });

  it('restores fresh cloud configuration without another request after returning', async () => {
    mockAdminSession();
    fetchCloudConfigMock.mockResolvedValue(cloudConfigPayload);

    function CachedSettingsScreen({ visible }: { visible: boolean }) {
      return (
        <AdminScreenCacheProvider>
          {visible ? <SettingsScreen apiBaseUrl="http://localhost:3001" /> : null}
        </AdminScreenCacheProvider>
      );
    }

    const { rerender } = render(<CachedSettingsScreen visible />);

    await screen.findByDisplayValue('cn-hangzhou');
    expect(fetchCloudConfigMock).toHaveBeenCalledTimes(1);

    rerender(<CachedSettingsScreen visible={false} />);
    rerender(<CachedSettingsScreen visible />);

    expect(screen.getByDisplayValue('cn-hangzhou')).toBeTruthy();
    await waitFor(() => expect(fetchCloudConfigMock).toHaveBeenCalledTimes(1));
  });

  it('keeps cloud configuration load failures inside the form and retries from there', async () => {
    mockAdminSession();
    fetchCloudConfigMock
      .mockRejectedValueOnce(new Error('网络暂时不可用'))
      .mockResolvedValueOnce(cloudConfigPayload);

    render(<SettingsScreen apiBaseUrl="http://localhost:3001" />);

    const form = await screen.findByTestId('cloud-config-form');
    expect(within(form).getByRole('alert').textContent).toContain('云配置加载失败，请稍后重试。');

    fireEvent.click(within(form).getByRole('button', { name: '重试加载' }));

    expect(screen.getByTestId('cloud-config-form-skeleton')).toBeTruthy();
    expect(await screen.findByDisplayValue('cn-hangzhou')).toBeTruthy();
    expect(fetchCloudConfigMock).toHaveBeenCalledTimes(2);
  });

  it('redirects regular users away from cloud settings without loading configuration', async () => {
    vi.spyOn(adminSessionModule, 'useAdminSession').mockReturnValue({
      idToken: null,
      refreshToken: null,
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
