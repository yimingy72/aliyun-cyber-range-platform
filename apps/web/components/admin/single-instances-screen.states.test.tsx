import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { flushSync } from 'react-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  fetchSingleInstancesMock,
  fetchProvisionJobsMock,
  fetchPlatformImagesMock,
  fetchInstanceTypeAvailabilityMock,
  launchSingleInstancesMock,
  deleteRangeInstanceMock,
  destroySingleInstanceBatchMock,
  triggerSingleInstanceActionMock,
} = vi.hoisted(() => ({
  fetchSingleInstancesMock: vi.fn(),
  fetchProvisionJobsMock: vi.fn(),
  fetchPlatformImagesMock: vi.fn(),
  fetchInstanceTypeAvailabilityMock: vi.fn(),
  launchSingleInstancesMock: vi.fn(),
  deleteRangeInstanceMock: vi.fn(),
  destroySingleInstanceBatchMock: vi.fn(),
  triggerSingleInstanceActionMock: vi.fn(),
}));

const { adminSession, replaceMock, router, searchParamsState } = vi.hoisted(() => {
  const replace = vi.fn();

  return {
    adminSession: {
      token: 'dev-admin-token',
      isReady: true,
      login: vi.fn(),
      logout: vi.fn(),
    },
    replaceMock: replace,
    router: { replace },
    searchParamsState: { value: '' },
  };
});

vi.mock('next/navigation', () => ({
  useRouter: () => router,
  useSearchParams: () => new URLSearchParams(searchParamsState.value),
}));

vi.mock('./use-admin-session', () => ({
  useAdminSession: () => adminSession,
}));

vi.mock('../../lib/admin-api', () => ({
  AdminApiError: class AdminApiError extends Error {
    constructor(
      readonly status: number,
      message = `Admin API request failed with status ${status}`,
    ) {
      super(message);
    }
  },
  fetchSingleInstances: fetchSingleInstancesMock,
  fetchProvisionJobs: fetchProvisionJobsMock,
  fetchPlatformImages: fetchPlatformImagesMock,
  fetchInstanceTypeAvailability: fetchInstanceTypeAvailabilityMock,
  launchSingleInstances: launchSingleInstancesMock,
  deleteRangeInstance: deleteRangeInstanceMock,
  destroySingleInstanceBatch: destroySingleInstanceBatchMock,
  triggerSingleInstanceAction: triggerSingleInstanceActionMock,
}));

import { SingleInstancesScreen } from './single-instances-screen';

function createDeferred<T>() {
  let resolve: (value: T) => void;
  let reject: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });

  return { promise, reject: reject!, resolve: resolve! };
}

const activeInstance = {
  id: 'single-active-1',
  name: 'web-lab-01',
  createdBy: 'admin',
  instanceMode: 'single' as const,
  status: 'running',
  createdAt: '2026-07-08T09:00:00.000Z',
  expiresAt: '2026-07-10T12:00:00.000Z',
  accessEntry: { publicIp: '47.1.2.3' },
  runtimeCredentials: {
    'single-ecs-1': {
      username: 'root',
      password: 'secret',
    },
  },
  singleInstanceConfig: {
    hostKey: 'single-ecs-1',
    imageDisplayName: 'Ubuntu 24.04 LTS',
    cpu: 2,
    memory: 2,
  },
};

describe('SingleInstancesScreen list states', () => {
  beforeEach(() => {
    fetchSingleInstancesMock.mockReset();
    fetchProvisionJobsMock.mockReset();
    fetchPlatformImagesMock.mockReset();
    fetchInstanceTypeAvailabilityMock.mockReset();
    launchSingleInstancesMock.mockReset();
    deleteRangeInstanceMock.mockReset();
    destroySingleInstanceBatchMock.mockReset();
    triggerSingleInstanceActionMock.mockReset();
    replaceMock.mockReset();
    searchParamsState.value = '';
    fetchProvisionJobsMock.mockResolvedValue([]);
    fetchPlatformImagesMock.mockResolvedValue({
      items: [{ id: 'platform-image-1', imageId: 'm-123', displayName: 'Ubuntu 24.04 LTS', enabled: true }],
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('keeps the history URL view and its table frame during first load', async () => {
    const pendingHistory = createDeferred<unknown>();
    const replaceStateSpy = vi.spyOn(window.history, 'replaceState');
    searchParamsState.value = 'view=history';
    fetchSingleInstancesMock.mockReturnValue(pendingHistory.promise);

    render(<SingleInstancesScreen apiBaseUrl="http://localhost:3001" />);

    const heading = await screen.findByRole('heading', { level: 1, name: '实例管理' });

    expect(heading.closest('[data-slot="admin-page-header"]')).toBeTruthy();
    expect(heading.closest('.admin-workbench-surface')).toBeTruthy();
    expect(screen.getByRole('button', { name: '创建实例' })).toBeTruthy();
    expect(await screen.findByRole('tab', { name: '实例历史', selected: true })).toBeTruthy();
    expect(screen.getByRole('table', { name: '实例历史' })).toBeTruthy();
    expect(screen.getByText('结束时间')).toBeTruthy();
    expect(screen.getByRole('status', { name: '正在加载实例历史' })).toBeTruthy();
    expect(fetchSingleInstancesMock).toHaveBeenCalledWith('http://localhost:3001', 'dev-admin-token', { view: 'history' });
    expect(replaceStateSpy).not.toHaveBeenCalled();

    await act(async () => {
      pendingHistory.resolve([]);
    });

    expect(await screen.findByText('暂无实例历史')).toBeTruthy();
  });

  it('renders an active-list error inside the table body and retries in place', async () => {
    fetchSingleInstancesMock
      .mockRejectedValueOnce(new Error('network unavailable'))
      .mockResolvedValueOnce([activeInstance]);

    render(<SingleInstancesScreen apiBaseUrl="http://localhost:3001" />);

    expect(await screen.findByText('实例管理数据加载失败，请稍后重试。')).toBeTruthy();
    expect(screen.getByRole('table', { name: '实例列表' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '重试加载' }));

    expect(await screen.findByText('web-lab-01')).toBeTruthy();
    expect(fetchSingleInstancesMock).toHaveBeenCalledTimes(2);
  });

  it('shows a history table skeleton immediately when switching away from a loaded active view', async () => {
    const pendingHistory = createDeferred<unknown>();
    fetchSingleInstancesMock
      .mockResolvedValueOnce([activeInstance])
      .mockReturnValueOnce(pendingHistory.promise);

    render(<SingleInstancesScreen apiBaseUrl="http://localhost:3001" />);

    expect(await screen.findByText('web-lab-01')).toBeTruthy();
    const historyTab = screen.getByRole('tab', { name: '实例历史' });
    flushSync(() => {
      fireEvent.mouseDown(historyTab, { button: 0 });
    });

    expect(screen.getByRole('tab', { name: '实例历史', selected: true })).toBeTruthy();
    expect(screen.getByRole('table', { name: '实例历史' })).toBeTruthy();
    expect(screen.getByRole('status', { name: '正在加载实例历史' })).toBeTruthy();
    expect(screen.queryByText('暂无实例历史')).toBeNull();

    await waitFor(() => {
      expect(fetchSingleInstancesMock).toHaveBeenLastCalledWith(
        'http://localhost:3001',
        'dev-admin-token',
        { view: 'history' },
      );
    });

    await act(async () => {
      pendingHistory.resolve([]);
    });
  });

  it('keeps the active snapshot visible and marks the table busy during polling revalidation', async () => {
    const pendingRefresh = createDeferred<unknown>();
    const polls: Array<() => void> = [];
    vi.spyOn(window, 'setInterval').mockImplementation((callback, delay) => {
      if (delay === 100) {
        polls.push(callback as () => void);
      }
      return 1;
    });
    fetchSingleInstancesMock
      .mockResolvedValueOnce([activeInstance])
      .mockReturnValueOnce(pendingRefresh.promise);

    render(<SingleInstancesScreen apiBaseUrl="http://localhost:3001" pollIntervalMs={100} />);

    expect(await screen.findByText('web-lab-01')).toBeTruthy();

    await waitFor(() => {
      expect(polls).toHaveLength(2);
    });
    act(() => {
      polls.at(-1)?.();
    });

    expect(fetchSingleInstancesMock).toHaveBeenCalledTimes(2);
    const table = screen.getByRole('table', { name: '实例列表' });
    expect(table.getAttribute('aria-busy')).toBe('true');
    expect(screen.getByText('web-lab-01')).toBeTruthy();

    await act(async () => {
      pendingRefresh.resolve([activeInstance]);
    });
  });

  it('adds an in-table retryable error row ahead of retained rows when revalidation fails', async () => {
    const failedRefresh = createDeferred<unknown>();
    const polls: Array<() => void> = [];
    vi.spyOn(window, 'setInterval').mockImplementation((callback, delay) => {
      if (delay === 100) {
        polls.push(callback as () => void);
      }
      return 1;
    });
    fetchSingleInstancesMock
      .mockResolvedValueOnce([activeInstance])
      .mockReturnValueOnce(failedRefresh.promise)
      .mockResolvedValueOnce([activeInstance]);

    render(<SingleInstancesScreen apiBaseUrl="http://localhost:3001" pollIntervalMs={100} />);

    expect(await screen.findByText('web-lab-01')).toBeTruthy();
    await waitFor(() => {
      expect(polls).toHaveLength(2);
    });
    act(() => {
      polls.at(-1)?.();
    });
    await act(async () => {
      failedRefresh.reject(new Error('network unavailable'));
    });

    const table = screen.getByRole('table', { name: '实例列表' });
    const errorTitle = await screen.findByRole('heading', { name: '实例管理数据加载失败，请稍后重试。' });
    const errorRow = errorTitle.closest('tr');

    expect(errorRow).toBeTruthy();
    expect(table.querySelector('tbody tr')?.textContent).toContain('实例管理数据加载失败，请稍后重试。');
    expect(errorRow?.querySelector('td')?.getAttribute('colspan')).toBe(String(table.querySelectorAll('thead th').length));
    expect(screen.getByText('web-lab-01')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '重试加载' }));
    await waitFor(() => {
      expect(fetchSingleInstancesMock).toHaveBeenCalledTimes(3);
    });
  });

  it('keeps the in-table retry affordance above an empty search result when revalidation fails', async () => {
    const failedRefresh = createDeferred<unknown>();
    const polls: Array<() => void> = [];
    vi.spyOn(window, 'setInterval').mockImplementation((callback, delay) => {
      if (delay === 100) {
        polls.push(callback as () => void);
      }
      return 1;
    });
    fetchSingleInstancesMock
      .mockResolvedValueOnce([activeInstance])
      .mockReturnValueOnce(failedRefresh.promise)
      .mockResolvedValueOnce([activeInstance]);

    render(<SingleInstancesScreen apiBaseUrl="http://localhost:3001" pollIntervalMs={100} />);

    expect(await screen.findByText('web-lab-01')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('筛选实例名'), { target: { value: 'no-match' } });
    expect(await screen.findByText('暂无实例')).toBeTruthy();

    await waitFor(() => {
      expect(polls).toHaveLength(2);
    });
    act(() => {
      polls.at(-1)?.();
    });
    await act(async () => {
      failedRefresh.reject(new Error('network unavailable'));
    });

    const table = screen.getByRole('table', { name: '实例列表' });
    const errorTitle = await screen.findByRole('heading', { name: '实例管理数据加载失败，请稍后重试。' });
    const errorRow = errorTitle.closest('tr');

    expect(table.querySelector('tbody tr')?.textContent).toContain('实例管理数据加载失败，请稍后重试。');
    expect(errorRow?.querySelector('td')?.getAttribute('colspan')).toBe(String(table.querySelectorAll('thead th').length));
    expect(screen.queryByText('暂无实例')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '重试加载' }));
    await waitFor(() => {
      expect(fetchSingleInstancesMock).toHaveBeenCalledTimes(3);
    });
  });
});
