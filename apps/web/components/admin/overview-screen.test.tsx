import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchAdminBootstrapMock, pathnameState, replaceMock, routerState } = vi.hoisted(() => ({
  fetchAdminBootstrapMock: vi.fn(),
  pathnameState: { value: '/admin' },
  replaceMock: vi.fn(),
  routerState: {
    replace: vi.fn(),
  },
}));

routerState.replace = replaceMock;

vi.mock('next/navigation', () => ({
  usePathname: () => pathnameState.value,
  useRouter: () => routerState,
}));

vi.mock('../../lib/admin-api', async () => {
  const actual = await vi.importActual<typeof import('../../lib/admin-api')>('../../lib/admin-api');

  return {
    ...actual,
    fetchAdminBootstrap: fetchAdminBootstrapMock,
  };
});

import { AdminApiError } from '../../lib/admin-api';
import { ADMIN_TOKEN_STORAGE_KEY } from '../../lib/admin-auth-storage';
import { AdminWorkspaceShell } from './admin-workspace-shell';
import { OverviewScreen } from './overview-screen';
import * as adminSessionModule from './use-admin-session';

const bootstrapPayload = {
  competitions: [{ id: 'competition-1', name: '总决赛' }],
  teams: [{ id: 'team-1', name: '蓝队', competitionId: 'competition-1' }],
  rangeTemplates: [{ id: 'template-1', slug: 'enterprise-range', version: 'v1' }],
  rangeInstances: [
    { id: 'range-1', teamId: 'team-1', status: 'running', errorSummary: null, lastJobId: 'job-1' },
    { id: 'range-2', teamId: 'team-1', status: 'create_failed', errorSummary: 'EIP failed', lastJobId: 'job-2' },
  ],
  provisionJobs: [
    { id: 'job-1', rangeInstanceId: 'range-1', jobType: 'create', status: 'succeeded', triggeredBy: 'admin' },
    { id: 'job-2', rangeInstanceId: 'range-2', jobType: 'create', status: 'running', triggeredBy: 'admin' },
  ],
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

function renderOverviewInShell() {
  return render(
    <AdminWorkspaceShell>
      <OverviewScreen apiBaseUrl="http://localhost:3001" />
    </AdminWorkspaceShell>,
  );
}

describe('OverviewScreen', () => {
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

    pathnameState.value = '/admin';
    replaceMock.mockReset();
    fetchAdminBootstrapMock.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders Chinese KPI cards and recent activity sections', async () => {
    window.localStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, 'dev-admin-token');
    fetchAdminBootstrapMock.mockResolvedValue(bootstrapPayload);

    renderOverviewInShell();

    await screen.findByText('运行中靶场');
    expect(screen.getByText('运行中靶场')).toBeTruthy();
    expect(screen.getByText('创建中任务')).toBeTruthy();
    expect(screen.getByText('失败实例')).toBeTruthy();
    expect(screen.getByText('最近任务')).toBeTruthy();
    expect(screen.queryByText('Running')).toBeNull();
    expect(screen.queryByText('Provisioning')).toBeNull();
    expect(screen.queryByText('Failures')).toBeNull();
    expect(screen.queryByText('Templates')).toBeNull();
    expect(screen.queryByText('Recent Jobs')).toBeNull();
  });

  it('shows a loading state instead of zero-state content before the admin session is ready', () => {
    const useAdminSessionSpy = vi.spyOn(adminSessionModule, 'useAdminSession').mockReturnValue({
      token: null,
      isReady: false,
      login: vi.fn(),
      logout: vi.fn(),
    });

    render(<OverviewScreen apiBaseUrl="http://localhost:3001" />);

    expect(screen.getByText('正在恢复管理员会话...')).toBeTruthy();
    expect(screen.queryByText('运行中靶场')).toBeNull();
    expect(screen.queryByText('暂无编排任务。')).toBeNull();
    expect(fetchAdminBootstrapMock).not.toHaveBeenCalled();

    useAdminSessionSpy.mockRestore();
  });

  it('shows a loading state while the first bootstrap request is still pending', async () => {
    const deferred = createDeferred<typeof bootstrapPayload>();
    fetchAdminBootstrapMock.mockImplementation(() => deferred.promise);
    window.localStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, 'dev-admin-token');

    renderOverviewInShell();

    await screen.findByText('正在加载靶场总览...');
    expect(screen.queryByText('暂无编排任务。')).toBeNull();
    expect(screen.queryByText('当前没有异常实例。')).toBeNull();

    deferred.resolve(bootstrapPayload);

    await screen.findByText('运行中靶场');
  });

  it('clears the shared admin session and redirects to login when bootstrap returns 401', async () => {
    fetchAdminBootstrapMock.mockRejectedValue(new AdminApiError(401));
    window.localStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, 'dev-admin-token');

    renderOverviewInShell();

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith('/admin/login');
    });

    expect(window.localStorage.getItem(ADMIN_TOKEN_STORAGE_KEY)).toBeNull();
    await waitFor(() => {
      expect(screen.queryByText('管理后台')).toBeNull();
    });
    expect(screen.queryByText('靶场总览加载失败，请刷新页面后重试。')).toBeNull();
  });
});
