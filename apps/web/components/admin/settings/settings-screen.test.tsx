import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchCloudConfigMock, saveCloudConfigMock, replaceMock } = vi.hoisted(() => ({
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
};

describe('SettingsScreen', () => {
  beforeEach(() => {
    replaceMock.mockReset();
    fetchCloudConfigMock.mockReset();
    saveCloudConfigMock.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('shows only provider, region, zone, access key id and access key secret fields', async () => {
    vi.spyOn(adminSessionModule, 'useAdminSession').mockReturnValue({
      token: 'dev-admin-token',
      isReady: true,
      login: vi.fn(),
      logout: vi.fn(),
    });
    fetchCloudConfigMock.mockResolvedValue(cloudConfigPayload);

    render(<SettingsScreen apiBaseUrl="http://localhost:3001" />);

    await screen.findByDisplayValue('cn-hangzhou');

    expect(screen.getByLabelText('云平台')).toBeTruthy();
    expect(screen.getByText('5 项配置')).toBeTruthy();
    expect(screen.queryByText('阿里云接入')).toBeNull();
    expect(screen.queryByText('当前阶段基础配置只保留云平台、默认地域、默认可用区和阿里云访问凭据。')).toBeNull();
    expect(screen.getByLabelText('默认地域')).toBeTruthy();
    expect(screen.getByLabelText('默认可用区')).toBeTruthy();
    expect(screen.getByLabelText('AccessKey ID')).toBeTruthy();
    expect(screen.getByLabelText('AccessKey Secret')).toBeTruthy();
    expect(screen.queryByText('比赛')).toBeNull();
    expect(screen.queryByText('队伍')).toBeNull();
    expect(screen.queryByText('模板')).toBeNull();
    expect(screen.queryByText('编排模式')).toBeNull();
  });

  it('submits only the cloud config fields used by the new page', async () => {
    vi.spyOn(adminSessionModule, 'useAdminSession').mockReturnValue({
      token: 'dev-admin-token',
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

  it('renders nothing before the admin session is ready', () => {
    vi.spyOn(adminSessionModule, 'useAdminSession').mockReturnValue({
      token: null,
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
      isReady: true,
      login: vi.fn(),
      logout: vi.fn(),
    });
    fetchCloudConfigMock.mockRejectedValue(new Error('cloud config unavailable'));

    render(<SettingsScreen apiBaseUrl="http://localhost:3001" />);

    await screen.findByText('云配置加载失败，请稍后重试。');
  });

  it('keeps the page shell visible while cloud config is still loading', () => {
    vi.spyOn(adminSessionModule, 'useAdminSession').mockReturnValue({
      token: 'dev-admin-token',
      isReady: true,
      login: vi.fn(),
      logout: vi.fn(),
    });
    fetchCloudConfigMock.mockImplementation(() => new Promise(() => undefined));

    render(<SettingsScreen apiBaseUrl="http://localhost:3001" />);

    expect(screen.getAllByRole('heading', { name: '云配置' }).length).toBeGreaterThan(0);
    expect(screen.queryByText('正在加载云配置...')).toBeNull();
  });
});
