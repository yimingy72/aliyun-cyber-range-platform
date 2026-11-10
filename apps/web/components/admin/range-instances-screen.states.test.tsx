import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  fetchProvisionJobsMock,
  fetchRangeInstancesMock,
  triggerRangeActionMock,
} = vi.hoisted(() => ({
  fetchProvisionJobsMock: vi.fn(),
  fetchRangeInstancesMock: vi.fn(),
  triggerRangeActionMock: vi.fn(),
}));

const { pushMock, replaceMock, routerMock, searchParamsState } = vi.hoisted(() => {
  const push = vi.fn();
  const replace = vi.fn();

  return {
    pushMock: push,
    replaceMock: replace,
    routerMock: {
      push,
      replace,
    },
    searchParamsState: { value: '' },
  };
});

vi.mock('next/navigation', () => ({
  useRouter: () => routerMock,
  useSearchParams: () => new URLSearchParams(searchParamsState.value),
}));

vi.mock('./use-admin-session', () => ({
  useAdminSession: () => ({
    token: 'dev-admin-token',
    profile: { id: 'admin', username: 'admin', role: 'admin' },
    isReady: true,
    logout: vi.fn(),
  }),
}));

vi.mock('../../lib/admin-api', () => ({
  AdminApiError: class AdminApiError extends Error {
    constructor(readonly status: number, message?: string) {
      super(message);
    }
  },
  fetchProvisionJobs: fetchProvisionJobsMock,
  fetchRangeInstances: fetchRangeInstancesMock,
  triggerRangeAction: triggerRangeActionMock,
}));

import { RangeInstancesScreen } from './range-instances-screen';

function createPendingPromise<T>() {
  let resolve: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });

  return {
    promise,
    resolve: resolve!,
  };
}

describe('RangeInstancesScreen list states', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    fetchProvisionJobsMock.mockReset();
    fetchRangeInstancesMock.mockReset();
    triggerRangeActionMock.mockReset();
    pushMock.mockReset();
    replaceMock.mockReset();
    searchParamsState.value = '';
    window.history.replaceState(null, '', '/admin/ranges');
  });

  afterEach(() => {
    cleanup();
    delete document.documentElement.dataset.platformTheme;
  });

  it('retains the active overview on a direct history visit and filters the live list from it', async () => {
    document.documentElement.dataset.platformTheme = 'cel';
    searchParamsState.value = 'view=history';
    window.history.replaceState(null, '', '/admin/ranges?view=history');
    const activeRows = createPendingPromise<Array<{ id: string; name: string; status: string }>>();
    fetchRangeInstancesMock.mockImplementation((_url, _token, { view }) => view === 'history'
      ? Promise.resolve([{ id: 'historical', name: '历史靶场', status: 'destroyed' }])
      : activeRows.promise);
    fetchProvisionJobsMock.mockResolvedValue([]);

    render(<RangeInstancesScreen />);
    const overview = screen.getByRole('group', { name: '按当前实例状态筛选' });
    expect(overview.textContent).toContain('运行中—');
    expect(await screen.findByText('历史靶场')).toBeTruthy();

    activeRows.resolve([
      { id: 'live', name: '运行靶场', status: 'running' },
      { id: 'starting', name: '创建靶场', status: 'creating' },
    ]);
    const running = await screen.findByRole('button', { name: /运行中\s*01/ });
    expect(screen.getByRole('group', { name: '按当前实例状态筛选' })).toBe(overview);
    fireEvent.click(running);
    expect(await screen.findByText('运行靶场')).toBeTruthy();
    expect(screen.queryByText('创建靶场')).toBeNull();
    expect(screen.getByRole('tab', { name: '实例列表' }).getAttribute('aria-selected')).toBe('true');
  });

  it('keeps range columns and a table-body empty state for no active instances', async () => {
    fetchRangeInstancesMock.mockResolvedValue([]);
    fetchProvisionJobsMock.mockResolvedValue([]);

    render(<RangeInstancesScreen apiBaseUrl="http://localhost:3001" />);

    expect(await screen.findByRole('columnheader', { name: '实例 / 批次' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: '实例列表' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByLabelText('筛选实例名')).toBeTruthy();
    expect(screen.getByText('还没有编排实例').closest('td')).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: '所属靶场' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: '状态' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: '公网 IP（DNAT IP）' })).toBeTruthy();
    expect(
      Array.from(screen.getByRole('table', { name: '编排实例列表' }).querySelectorAll('col')).at(-1)?.getAttribute('style') ?? '',
    ).toContain('width: 11rem');
  });

  it.each(['active', 'history'])('shows the explicit DNAT public IP in the %s list', async view => {
    searchParamsState.value = view === 'history' ? 'view=history' : '';
    fetchRangeInstancesMock.mockResolvedValue([{ id: 'range-ip', name: 'DNAT 靶场', status: view === 'history' ? 'destroyed' : 'running', dnatPublicIp: '39.1.2.3' }]);
    fetchProvisionJobsMock.mockResolvedValue([]);
    render(<RangeInstancesScreen apiBaseUrl="http://localhost:3001" />);
    const cell = (await screen.findByText('39.1.2.3')).closest('td');
    const headers = screen.getAllByRole('columnheader');
    const index = headers.findIndex(header => header.textContent === '公网 IP（DNAT IP）');
    expect(cell?.parentElement?.children[index]).toBe(cell);
  });

  it('reads the history view from the URL before the first fetch settles', async () => {
    const pendingInstances = createPendingPromise<never[]>();

    searchParamsState.value = 'view=history';
    fetchRangeInstancesMock.mockReturnValue(pendingInstances.promise);
    fetchProvisionJobsMock.mockReturnValue(createPendingPromise<never[]>().promise);

    render(<RangeInstancesScreen apiBaseUrl="http://localhost:3001" />);

    expect((await screen.findByRole('tab', { name: '实例历史' })).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('columnheader', { name: '结束时间' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: '状态' })).toBeTruthy();
    expect(
      Array.from(screen.getByRole('table', { name: '编排实例历史' }).querySelectorAll('col')).at(-1)?.getAttribute('style') ?? '',
    ).toContain('width: 11rem');
    expect(fetchRangeInstancesMock).toHaveBeenCalledWith(
      'http://localhost:3001',
      'dev-admin-token',
      { view: 'history' },
    );
  });

  it('keeps the history list toolbar and marks its detail action as an outline button', async () => {
    searchParamsState.value = 'view=history';
    fetchRangeInstancesMock.mockResolvedValue([
      {
        id: 'range-history',
        name: '已回收靶场',
        templateNameSnapshot: '企业攻防靶场',
        status: 'destroyed',
        createdAt: '2026-07-22T08:00:00.000Z',
      },
    ]);
    fetchProvisionJobsMock.mockResolvedValue([]);

    render(<RangeInstancesScreen apiBaseUrl="http://localhost:3001" />);

    expect((await screen.findByRole('tab', { name: '实例历史' })).getAttribute('aria-selected')).toBe('true');
    const detailAction = screen.getByRole('button', { name: '查看详情' });
    expect(detailAction.getAttribute('data-variant')).toBe('outline');
    expect(detailAction.closest('[data-slot="range-history-detail-action"]')).toBeTruthy();
  });

  it('writes the selected list view to the URL', async () => {
    fetchRangeInstancesMock.mockResolvedValue([]);
    fetchProvisionJobsMock.mockResolvedValue([]);
    searchParamsState.value = 'source=overview';
    window.history.replaceState(null, '', '/admin/ranges?source=overview');

    render(<RangeInstancesScreen apiBaseUrl="http://localhost:3001" />);

    await screen.findByText('还没有编排实例');
    const activeTab = screen.getByRole('tab', { name: '实例列表' });
    activeTab.focus();
    fireEvent.keyDown(activeTab, { key: 'ArrowRight' });

    await waitFor(() => {
      expect(window.location.pathname).toBe('/admin/ranges');
      expect(window.location.search).toBe('?source=overview&view=history');
    });

    const historyTab = screen.getByRole('tab', { name: '实例历史' });
    historyTab.focus();
    fireEvent.keyDown(historyTab, { key: 'ArrowLeft' });

    await waitFor(() => {
      expect(window.location.search).toBe('?source=overview');
    });
  });

  it('keeps list headers and toolbar visible when the first load fails', async () => {
    fetchRangeInstancesMock.mockRejectedValue(new Error('network unavailable'));
    fetchProvisionJobsMock.mockResolvedValue([]);

    render(<RangeInstancesScreen apiBaseUrl="http://localhost:3001" />);

    expect(await screen.findByText('无法加载编排实例')).toBeTruthy();
    expect(screen.getByText('靶场实例加载失败，请刷新页面后重试。').closest('td')).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: '实例 / 批次' })).toBeTruthy();
    expect(screen.getByLabelText('筛选实例名')).toBeTruthy();
    expect(screen.getByRole('button', { name: '重试加载' })).toBeTruthy();
  });

  it('shows an in-table skeleton immediately when retrying a failed initial load', async () => {
    const pendingRetry = createPendingPromise<never[]>();

    fetchRangeInstancesMock
      .mockRejectedValueOnce(new Error('network unavailable'))
      .mockReturnValueOnce(pendingRetry.promise);
    fetchProvisionJobsMock.mockResolvedValue([]);

    render(<RangeInstancesScreen apiBaseUrl="http://localhost:3001" />);

    await screen.findByText('无法加载编排实例');
    fireEvent.click(screen.getByRole('button', { name: '重试加载' }));

    expect(screen.getByRole('status', { name: '正在加载编排实例' })).toBeTruthy();
    expect(screen.queryByText('还没有编排实例')).toBeNull();
  });

  it('keeps active rows visible and marks the table busy while active data revalidates', async () => {
    const pendingActiveReload = createPendingPromise<never[]>();

    fetchRangeInstancesMock
      .mockResolvedValueOnce([
        {
          id: 'range-active',
          name: '蓝队靶场',
          templateNameSnapshot: '企业攻防靶场',
          status: 'running',
          createdAt: '2026-07-22T08:00:00.000Z',
        },
      ])
      .mockResolvedValueOnce([])
      .mockReturnValueOnce(pendingActiveReload.promise);
    fetchProvisionJobsMock.mockResolvedValue([]);

    render(<RangeInstancesScreen apiBaseUrl="http://localhost:3001" />);

    expect(await screen.findByText('蓝队靶场')).toBeTruthy();

    const activeTab = screen.getByRole('tab', { name: '实例列表' });
    activeTab.focus();
    fireEvent.keyDown(activeTab, { key: 'ArrowRight' });
    await screen.findByText('还没有历史实例');
    const historyTab = screen.getByRole('tab', { name: '实例历史' });
    historyTab.focus();
    fireEvent.keyDown(historyTab, { key: 'ArrowLeft' });

    await waitFor(() => {
      expect(screen.getByText('蓝队靶场')).toBeTruthy();
      expect(screen.getByRole('table', { name: '编排实例列表' }).getAttribute('aria-busy')).toBe('true');
    });
  });

  it('keeps rows and reports revalidation failures inside the table body', async () => {
    fetchRangeInstancesMock
      .mockResolvedValueOnce([
        {
          id: 'range-active',
          name: '蓝队靶场',
          templateNameSnapshot: '企业攻防靶场',
          status: 'running',
          createdAt: '2026-07-22T08:00:00.000Z',
        },
      ])
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('network unavailable'));
    fetchProvisionJobsMock.mockResolvedValue([]);

    render(<RangeInstancesScreen apiBaseUrl="http://localhost:3001" />);

    expect(await screen.findByText('蓝队靶场')).toBeTruthy();

    const activeTab = screen.getByRole('tab', { name: '实例列表' });
    activeTab.focus();
    fireEvent.keyDown(activeTab, { key: 'ArrowRight' });
    await screen.findByText('还没有历史实例');

    const historyTab = screen.getByRole('tab', { name: '实例历史' });
    historyTab.focus();
    fireEvent.keyDown(historyTab, { key: 'ArrowLeft' });

    const retainedError = await screen.findByRole('alert');
    expect(retainedError.closest('tr')).toBeTruthy();
    expect(retainedError.closest('td')?.getAttribute('colspan')).toBe('7');
    expect(screen.getByText('蓝队靶场')).toBeTruthy();
  });

  it('keeps the in-table retry affordance when search hides a retained snapshot', async () => {
    fetchRangeInstancesMock
      .mockResolvedValueOnce([
        {
          id: 'range-active',
          name: '蓝队靶场',
          templateNameSnapshot: '企业攻防靶场',
          status: 'running',
          createdAt: '2026-07-22T08:00:00.000Z',
        },
      ])
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('network unavailable'));
    fetchProvisionJobsMock.mockResolvedValue([]);

    render(<RangeInstancesScreen apiBaseUrl="http://localhost:3001" />);

    await screen.findByText('蓝队靶场');
    fireEvent.change(screen.getByLabelText('筛选实例名'), { target: { value: '未匹配' } });
    await screen.findByText('还没有编排实例');

    const activeTab = screen.getByRole('tab', { name: '实例列表' });
    activeTab.focus();
    fireEvent.keyDown(activeTab, { key: 'ArrowRight' });
    await screen.findByText('还没有历史实例');

    const historyTab = screen.getByRole('tab', { name: '实例历史' });
    historyTab.focus();
    fireEvent.keyDown(historyTab, { key: 'ArrowLeft' });

    const retainedError = await screen.findByRole('alert');
    expect(retainedError.closest('tr')).toBeTruthy();
    expect(retainedError.closest('td')?.getAttribute('colspan')).toBe('7');
    expect(screen.getByRole('button', { name: '重试加载' })).toBeTruthy();
    expect(screen.queryByText('还没有编排实例')).toBeNull();
  });

  it('preserves detail navigation and range lifecycle actions', async () => {
    fetchRangeInstancesMock.mockResolvedValue([
      {
        id: 'range-running',
        name: '待关闭靶场',
        templateNameSnapshot: '企业攻防靶场',
        status: 'running',
        createdAt: '2026-07-22T08:00:00.000Z',
      },
    ]);
    fetchProvisionJobsMock.mockResolvedValue([]);
    triggerRangeActionMock.mockResolvedValue({
      id: 'job-destroy',
      rangeInstanceId: 'range-running',
      jobType: 'destroy',
      status: 'pending',
    });

    render(<RangeInstancesScreen apiBaseUrl="http://localhost:3001" />);

    fireEvent.click(await screen.findByRole('button', { name: '查看详情' }));
    expect(pushMock).toHaveBeenCalledWith('/admin/ranges/range-running');

    fireEvent.keyDown(screen.getByRole('button', { name: '更多操作' }), { key: 'Enter' });
    fireEvent.click(screen.getByRole('menuitem', { name: '销毁实例' }));
    expect(triggerRangeActionMock).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: '确认销毁' }));
    await waitFor(() => {
      expect(triggerRangeActionMock).toHaveBeenCalledWith(
        'http://localhost:3001',
        'dev-admin-token',
        'range-running',
        'destroy',
        expect.any(String),
      );
    });
  });
});
