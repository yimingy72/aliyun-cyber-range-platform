import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchAdminBootstrapMock, fetchCloudConfigMock, replaceMock } = vi.hoisted(() => ({
  fetchAdminBootstrapMock: vi.fn(),
  fetchCloudConfigMock: vi.fn(),
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
    fetchAdminBootstrap: fetchAdminBootstrapMock,
    fetchCloudConfig: fetchCloudConfigMock,
  };
});

import { AdminApiError } from '../../../lib/admin-api';
import { ADMIN_TOKEN_STORAGE_KEY } from '../../../lib/admin-auth-storage';
import { SettingsScreen } from './settings-screen';
import * as adminSessionModule from '../use-admin-session';

const bootstrapPayload = {
  competitions: [{ id: 'competition-1', name: '总决赛', status: 'scheduled' }],
  teams: [{ id: 'team-1', name: '蓝队', competitionId: 'competition-1', contactName: '王教练' }],
  rangeTemplates: [{ id: 'template-1', slug: 'enterprise-range', version: 'v1', name: '企业攻防靶场' }],
  rangeInstances: [],
  provisionJobs: [],
};

const cloudConfigPayload = {
  region: 'cn-hangzhou',
  zoneId: 'cn-hangzhou-h',
  provisionerMode: 'dry-run',
  instanceTypeStrategy: 'auto',
  instanceTypePreferences: ['ecs.t6-c1m2.large'],
};

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });

  return { promise, resolve, reject };
}

describe('SettingsScreen', () => {
  beforeEach(() => {
    const storage = new Map<string, string>();

    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => {
          storage.set(key, value);
        },
        removeItem: (key: string) => {
          storage.delete(key);
        },
      },
    });

    replaceMock.mockReset();
    fetchAdminBootstrapMock.mockReset();
    fetchCloudConfigMock.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders tabbed settings sections including cloud config', async () => {
    window.localStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, 'dev-admin-token');
    fetchAdminBootstrapMock.mockResolvedValue(bootstrapPayload);
    fetchCloudConfigMock.mockResolvedValue(cloudConfigPayload);

    render(<SettingsScreen apiBaseUrl="http://localhost:3001" />);

    await screen.findByText('基础配置');
    expect(screen.getByRole('tab', { name: '比赛' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: '云配置' })).toBeTruthy();
  });

  it('shows a loading state instead of tab content before the admin session is ready', () => {
    const useAdminSessionSpy = vi.spyOn(adminSessionModule, 'useAdminSession').mockReturnValue({
      token: null,
      isReady: false,
      login: vi.fn(),
      logout: vi.fn(),
    });

    render(<SettingsScreen apiBaseUrl="http://localhost:3001" />);

    expect(screen.getByText('正在恢复管理员会话...')).toBeTruthy();
    expect(screen.queryByRole('tab', { name: '比赛' })).toBeNull();
    expect(fetchAdminBootstrapMock).not.toHaveBeenCalled();
    expect(fetchCloudConfigMock).not.toHaveBeenCalled();

    useAdminSessionSpy.mockRestore();
  });

  it('shows a loading state while the first settings requests are still pending', async () => {
    const bootstrapDeferred = createDeferred<typeof bootstrapPayload>();
    const cloudConfigDeferred = createDeferred<typeof cloudConfigPayload>();

    window.localStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, 'dev-admin-token');
    fetchAdminBootstrapMock.mockImplementation(() => bootstrapDeferred.promise);
    fetchCloudConfigMock.mockImplementation(() => cloudConfigDeferred.promise);

    render(<SettingsScreen apiBaseUrl="http://localhost:3001" />);

    await screen.findByText('正在加载基础配置...');
    expect(screen.queryByText('暂无比赛配置。')).toBeNull();
    expect(screen.queryByText('暂无云配置。')).toBeNull();

    bootstrapDeferred.resolve(bootstrapPayload);
    cloudConfigDeferred.resolve(cloudConfigPayload);

    await screen.findByRole('tab', { name: '比赛' });
  });

  it('clears the shared admin session and redirects to login when settings bootstrap returns 401', async () => {
    window.localStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, 'dev-admin-token');
    fetchAdminBootstrapMock.mockRejectedValue(new AdminApiError(401));
    fetchCloudConfigMock.mockResolvedValue(cloudConfigPayload);

    render(<SettingsScreen apiBaseUrl="http://localhost:3001" />);

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith('/admin/login');
    });

    expect(window.localStorage.getItem(ADMIN_TOKEN_STORAGE_KEY)).toBeNull();
    expect(screen.queryByText('基础配置加载失败，请刷新页面后重试。')).toBeNull();
  });

  it('keeps bootstrap data visible when cloud config fails', async () => {
    window.localStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, 'dev-admin-token');
    fetchAdminBootstrapMock.mockResolvedValue(bootstrapPayload);
    fetchCloudConfigMock.mockRejectedValue(new Error('cloud config unavailable'));

    render(<SettingsScreen apiBaseUrl="http://localhost:3001" />);

    await screen.findByText('基础配置');
    await screen.findByText('总决赛');
    expect(screen.queryByText('暂无比赛配置。')).toBeNull();
  });
});
