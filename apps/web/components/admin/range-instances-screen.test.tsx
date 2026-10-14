import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readRangeRecoveryIntent } from '../../lib/range-recovery-intent';
const listSessionState = vi.hoisted(() => ({ profile: { id: 'admin', username: 'admin', role: 'admin' as 'admin' | 'user' } }));

const {
  fetchRangeInstanceDetailMock,
  createRangeInstanceMock,
  fetchAdminBootstrapMock,
  triggerRangeActionMock,
} = vi.hoisted(() => ({
  fetchRangeInstanceDetailMock: vi.fn().mockResolvedValue({ id: 'range-1', status: 'running' }),
  createRangeInstanceMock: vi.fn(),
  fetchAdminBootstrapMock: vi.fn(),
  triggerRangeActionMock: vi.fn(),
}));

const { pushMock, replaceMock, routerMock, searchParamsState } = vi.hoisted(() => {
  const pushMock = vi.fn();
  const replaceMock = vi.fn();

  return {
    pushMock,
    replaceMock,
    routerMock: { push: pushMock, replace: replaceMock },
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
    profile: listSessionState.profile,
    isReady: true,
    login: vi.fn(),
    logout: vi.fn(),
  }),
}));

vi.mock('../../lib/admin-api', () => ({
  AdminApiError: class AdminApiError extends Error {
    status = 500;
  },
  fetchRangeInstanceDetail: fetchRangeInstanceDetailMock,
  createRangeInstance: createRangeInstanceMock,
  fetchProvisionJobs: async () => {
    const snapshot = await fetchAdminBootstrapMock();
    return snapshot.provisionJobs;
  },
  fetchRangeInstances: async (
    _apiBaseUrl: string,
    _token: string,
    options: { view: 'active' | 'history' },
  ) => {
    const snapshot = await fetchAdminBootstrapMock();
    const templateNames = new Map(snapshot.rangeTemplates.map((template: { id: string; name: string }) => [template.id, template.name]));

    return snapshot.rangeInstances
      .filter((instance: { status: string }) =>
        options.view === 'history'
          ? ['destroyed', 'create_failed'].includes(instance.status)
          : !['destroyed', 'create_failed'].includes(instance.status),
      )
      .map((instance: { templateId?: string | null; templateNameSnapshot?: string | null }) => ({
        ...instance,
        templateNameSnapshot:
          instance.templateNameSnapshot ??
          (instance.templateId ? templateNames.get(instance.templateId) : null),
      }));
  },
  triggerRangeAction: triggerRangeActionMock,
}));

import { RangeInstancesScreen } from './range-instances-screen';
import { AdminScreenCacheProvider } from '../../lib/admin-screen-cache';

describe('RangeInstancesScreen', () => {

  function recoveryListFixture() {
    return { rangeTemplates: [], rangeInstances: [{ id: 'range-1', name: '未知回收', status: 'running', createdAt: '2026-10-14T00:00:00Z' }], provisionJobs: [] };
  }

  it('recovery-intake: a lost list action persists its key and reload offers a detail continuation without writing', async () => {
    fetchAdminBootstrapMock.mockResolvedValue(recoveryListFixture());
    triggerRangeActionMock.mockRejectedValue(new Error('response lost'));
    const view = render(<RangeInstancesScreen />);
    fireEvent.click(await screen.findByRole('button', { name: '关闭' }));
    fireEvent.click(await screen.findByRole('button', { name: '确认关闭' }));
    await screen.findByText('恢复操作结果未确认，请进入实例详情继续确认原请求。');
    const scope = { apiBaseUrl: 'http://localhost:3001', userId: 'admin', workspaceId: '', rangeId: 'range-1' };
    const original = readRangeRecoveryIntent(scope)!;
    expect(triggerRangeActionMock).toHaveBeenCalledWith(scope.apiBaseUrl, 'dev-admin-token', scope.rangeId, 'destroy', original.key);
    view.unmount();
    render(<RangeInstancesScreen />);
    fireEvent.click(await screen.findByRole('button', { name: '继续确认恢复操作' }));
    expect(pushMock).toHaveBeenCalledWith('/admin/ranges/range-1');
    expect(readRangeRecoveryIntent(scope)).toEqual(original);
    expect(triggerRangeActionMock).toHaveBeenCalledTimes(1);
  });

  it.each(['user', 'unmount'] as const)('recovery-intake: a delayed list response after %s cannot change the current screen or discard the intent', async change => {
    fetchAdminBootstrapMock.mockResolvedValue(recoveryListFixture());
    let rejectAction!: (error: Error) => void;
    triggerRangeActionMock.mockReturnValue(new Promise((_resolve, reject) => { rejectAction = reject; }));
    const view = render(<RangeInstancesScreen />);
    fireEvent.click(await screen.findByRole('button', { name: '关闭' }));
    fireEvent.click(await screen.findByRole('button', { name: '确认关闭' }));
    await waitFor(() => expect(triggerRangeActionMock).toHaveBeenCalledTimes(1));
    const scope = { apiBaseUrl: 'http://localhost:3001', userId: 'admin', workspaceId: '', rangeId: 'range-1' };
    const original = readRangeRecoveryIntent(scope)!;
    if (change === 'unmount') view.unmount();
    else {
      listSessionState.profile = { id: 'other-user', username: 'other-user', role: 'user' };
      view.rerender(<RangeInstancesScreen />);
    }
    await act(async () => rejectAction(new Error('late old action failure')));
    expect(readRangeRecoveryIntent(scope)).toEqual(original);
    expect(screen.queryByText('恢复操作结果未确认，请进入实例详情继续确认原请求。')).toBeNull();
    expect(replaceMock).not.toHaveBeenCalled();
  });

  beforeEach(() => {
    window.sessionStorage.clear();
    listSessionState.profile = { id: 'admin', username: 'admin', role: 'admin' };
    fetchRangeInstanceDetailMock.mockReset();
    fetchRangeInstanceDetailMock.mockResolvedValue({ id: 'range-1', status: 'running' });
    createRangeInstanceMock.mockReset();
    fetchAdminBootstrapMock.mockReset();
    triggerRangeActionMock.mockReset();
    pushMock.mockReset();
    replaceMock.mockReset();
    searchParamsState.value = '';
  });

  afterEach(() => {
    cleanup();
  });

  it('renders one workbench list and switches between active instances and history', async () => {
    fetchAdminBootstrapMock.mockResolvedValue({
      competitions: [],
      teams: [],
      rangeTemplates: [
        { id: 'template-1', name: '企业攻防靶场', slug: 'enterprise-range', version: 'v1' },
      ],
      rangeInstances: [
        {
          id: 'range-1',
          name: '蓝队靶场 01',
          teamId: 'team-1',
          templateId: 'template-1',
          status: 'running',
          createdAt: '2026-06-29T09:00:00.000Z',
          lastJobId: 'job-1',
        },
        {
          id: 'range-2',
          name: '红队靶场 02',
          teamId: 'team-2',
          templateId: 'template-1',
          status: 'destroyed',
          createdAt: '2026-06-28T08:00:00.000Z',
          lastJobId: 'job-2',
        },
        {
          id: 'range-3',
          name: '失败靶场 03',
          teamId: 'team-3',
          templateId: 'template-1',
          status: 'create_failed',
          createdAt: '2026-06-27T08:00:00.000Z',
          lastJobId: 'job-3',
        },
      ],
      provisionJobs: [
        { id: 'job-1', rangeInstanceId: 'range-1', jobType: 'create', status: 'running', triggeredBy: 'admin', startedAt: '2026-06-29T09:00:00.000Z' },
        {
          id: 'job-2',
          rangeInstanceId: 'range-2',
          jobType: 'destroy',
          status: 'succeeded',
          triggeredBy: 'admin',
          startedAt: '2026-06-28T10:00:00.000Z',
          finishedAt: '2026-06-28T12:30:00.000Z',
        },
        {
          id: 'job-3',
          rangeInstanceId: 'range-3',
          jobType: 'create',
          status: 'failed',
          triggeredBy: 'admin',
          startedAt: '2026-06-27T08:00:00.000Z',
          finishedAt: '2026-06-27T08:04:00.000Z',
        },
      ],
    });

    render(<RangeInstancesScreen apiBaseUrl="http://localhost:3001" />);

    expect(await screen.findByRole('heading', { name: '编排实例' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: '实例列表' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: '实例历史' })).toBeTruthy();
    expect(screen.getByLabelText('筛选实例名')).toBeTruthy();
    expect(screen.queryByText('1 条记录')).toBeNull();
    expect(screen.queryByText('运行期管理')).toBeNull();
    expect(screen.queryByText('管理由靶场编排生成的运行实例，重点关注状态、创建时间和实例生命周期动作。')).toBeNull();
    expect(screen.getAllByText('实例名称').length).toBeGreaterThan(0);
    expect(screen.getByText('创建人')).toBeTruthy();
    expect(screen.getAllByText('所属靶场').length).toBeGreaterThan(0);
    expect(screen.getByText('状态')).toBeTruthy();
    expect(screen.getByText('创建时间')).toBeTruthy();
    expect(screen.getByText('操作')).toBeTruthy();
    expect(await screen.findByText('蓝队靶场 01')).toBeTruthy();
    expect(screen.getByText('admin')).toBeTruthy();
    expect(screen.queryByText('range-1')).toBeNull();
    expect(screen.getAllByText('企业攻防靶场').length).toBeGreaterThan(0);
    expect(screen.queryByText('红队靶场 02')).toBeNull();
    expect(screen.queryByText('失败靶场 03')).toBeNull();
    expect(screen.queryByText('已回收实例')).toBeNull();
    expect(screen.queryByText('开启时间')).toBeNull();
    expect(screen.queryByText('回收时间')).toBeNull();
    expect(screen.queryByText('运行时长')).toBeNull();
    expect(screen.queryByRole('heading', { name: '实例详情' })).toBeNull();
    expect(screen.getByRole('button', { name: '查看详情' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '关闭' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '创建实例' })).toBeTruthy();
    expect(screen.queryByText('筛选条件')).toBeNull();

    const activeTable = screen.getByRole('table', { name: '编排实例列表' });
    expect(activeTable.querySelectorAll('thead th')).toHaveLength(6);
    expect(screen.getByText('蓝队靶场 01').closest('tr')?.querySelectorAll('td')).toHaveLength(6);
    expect(activeTable.querySelector('tbody')?.className).toContain('admin-data-table-body-enter');

    fireEvent.change(screen.getByLabelText('筛选实例名'), { target: { value: '蓝队' } });
    expect(screen.getByText('蓝队靶场 01')).toBeTruthy();
    expect(screen.queryByText('红队靶场 02')).toBeNull();

    fireEvent.change(screen.getByLabelText('筛选实例名'), { target: { value: '' } });
    fireEvent.mouseDown(screen.getByRole('tab', { name: '实例历史' }), { button: 0 });

    expect(await screen.findByText('红队靶场 02')).toBeTruthy();
    expect(screen.getByText('失败靶场 03')).toBeTruthy();
    expect(screen.getByText('创建失败')).toBeTruthy();
    expect(screen.queryByText('已回收实例')).toBeNull();
    expect(screen.getByText('创建时间')).toBeTruthy();
    expect(screen.getByText('结束时间')).toBeTruthy();
    expect(screen.getByText('持续时长')).toBeTruthy();
    expect(screen.getByText('操作')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: '查看详情' })).toHaveLength(2);

    const historyTable = screen.getByRole('table', { name: '编排实例历史' });
    expect(historyTable.querySelectorAll('thead th')).toHaveLength(8);
    expect(Array.from(historyTable.querySelectorAll('thead th')).map((cell) => cell.textContent)).toContain('状态');
    expect(screen.getByText('红队靶场 02').closest('tr')?.querySelectorAll('td')).toHaveLength(8);
  });

  it('navigates to the standalone detail workbench when clicking 查看详情', async () => {
    fetchAdminBootstrapMock.mockResolvedValue({
      competitions: [],
      teams: [],
      rangeTemplates: [
        { id: 'template-1', name: '企业攻防靶场', slug: 'enterprise-range', version: 'v1' },
      ],
      rangeInstances: [
        {
          id: 'range-1',
          name: '蓝队靶场 01',
          teamId: 'team-1',
          templateId: 'template-1',
          status: 'running',
          createdAt: '2026-06-29T09:00:00.000Z',
          lastJobId: 'job-1',
        },
      ],
      provisionJobs: [
        { id: 'job-1', rangeInstanceId: 'range-1', jobType: 'create', status: 'running', triggeredBy: 'admin', startedAt: '2026-06-29T09:00:00.000Z' },
      ],
    });

    render(<RangeInstancesScreen apiBaseUrl="http://localhost:3001" />);

    fireEvent.click(await screen.findByRole('button', { name: '查看详情' }));

    expect(pushMock).toHaveBeenCalledWith('/admin/ranges/range-1');
  });

  it('navigates to the standalone detail workbench from instance history', async () => {
    fetchAdminBootstrapMock.mockResolvedValue({
      competitions: [],
      teams: [],
      rangeTemplates: [
        { id: 'template-1', name: '企业攻防靶场', slug: 'enterprise-range', version: 'v1' },
      ],
      rangeInstances: [
        {
          id: 'range-2',
          name: '红队靶场 02',
          teamId: 'team-2',
          templateId: 'template-1',
          status: 'destroyed',
          createdAt: '2026-06-28T08:00:00.000Z',
          lastJobId: 'job-2',
        },
      ],
      provisionJobs: [
        {
          id: 'job-2',
          rangeInstanceId: 'range-2',
          jobType: 'destroy',
          status: 'succeeded',
          triggeredBy: 'admin',
          startedAt: '2026-06-28T10:00:00.000Z',
          finishedAt: '2026-06-28T12:30:00.000Z',
        },
      ],
    });

    render(<RangeInstancesScreen apiBaseUrl="http://localhost:3001" />);

    fireEvent.mouseDown(await screen.findByRole('tab', { name: '实例历史' }), { button: 0 });
    fireEvent.click(await screen.findByRole('button', { name: '查看详情' }));

    expect(pushMock).toHaveBeenCalledWith('/admin/ranges/range-2');
  });

  it('allows switching to an empty tab even when the other instance list has data', async () => {
    fetchAdminBootstrapMock.mockResolvedValue({
      competitions: [],
      teams: [],
      rangeTemplates: [
        { id: 'template-1', name: '企业攻防靶场', slug: 'enterprise-range', version: 'v1' },
      ],
      rangeInstances: [
        {
          id: 'range-2',
          name: '红队靶场 02',
          teamId: 'team-2',
          templateId: 'template-1',
          status: 'destroyed',
          createdAt: '2026-06-28T08:00:00.000Z',
          lastJobId: 'job-2',
        },
      ],
      provisionJobs: [
        {
          id: 'job-2',
          rangeInstanceId: 'range-2',
          jobType: 'destroy',
          status: 'succeeded',
          triggeredBy: 'admin',
          startedAt: '2026-06-28T10:00:00.000Z',
          finishedAt: '2026-06-28T12:30:00.000Z',
        },
      ],
    });

    render(<RangeInstancesScreen apiBaseUrl="http://localhost:3001" />);

    expect(await screen.findByText('还没有编排实例')).toBeTruthy();
    fireEvent.mouseDown(screen.getByRole('tab', { name: '实例历史' }), { button: 0 });
    expect(await screen.findByText('红队靶场 02')).toBeTruthy();

    fireEvent.mouseDown(screen.getByRole('tab', { name: '实例列表' }), { button: 0 });

    expect(await screen.findByText('还没有编排实例')).toBeTruthy();
    expect(screen.getByText('实例会在靶场编排页生成后进入这里。')).toBeTruthy();
  });

  it('triggers a destroy lifecycle action from the list row without sending triggeredBy', async () => {
    fetchAdminBootstrapMock.mockResolvedValue({
      competitions: [],
      teams: [],
      rangeTemplates: [
        { id: 'template-1', name: '企业攻防靶场', slug: 'enterprise-range', version: 'v1' },
      ],
      rangeInstances: [
        {
          id: 'range-1',
          name: '蓝队靶场 01',
          teamId: 'team-1',
          templateId: 'template-1',
          status: 'running',
          createdAt: '2026-06-29T09:00:00.000Z',
          lastJobId: 'job-1',
        },
      ],
      provisionJobs: [
        { id: 'job-1', rangeInstanceId: 'range-1', jobType: 'create', status: 'running', triggeredBy: 'admin', startedAt: '2026-06-29T09:00:00.000Z' },
      ],
    });
    triggerRangeActionMock.mockResolvedValue({
      id: 'job-2',
      rangeInstanceId: 'range-1',
      jobType: 'destroy',
      status: 'pending',
      triggeredBy: 'admin',
    });

    render(<RangeInstancesScreen apiBaseUrl="http://localhost:3001" />);

    fireEvent.click(await screen.findByRole('button', { name: '关闭' }));
    expect(triggerRangeActionMock).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: '取消' }));
    expect(screen.queryByRole('button', { name: '确认关闭' })).toBeNull();
    expect(triggerRangeActionMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    fireEvent.click(await screen.findByRole('button', { name: '确认关闭' }));

    await waitFor(() => {
      expect(triggerRangeActionMock).toHaveBeenCalledWith(
        'http://localhost:3001',
        'dev-admin-token',
        'range-1',
        'destroy',
        expect.any(String),
      );
    });
  });

  it('keeps the page shell visible while instances are still loading', () => {
    fetchAdminBootstrapMock.mockImplementation(() => new Promise(() => undefined));

    render(<RangeInstancesScreen apiBaseUrl="http://localhost:3001" />);

    expect(screen.getByRole('heading', { name: '编排实例' })).toBeTruthy();
    expect(screen.queryByText('正在加载靶场实例...')).toBeNull();
  });

  it('keeps destroy_failed instances visible in the active list with a 销毁 action', async () => {
    fetchAdminBootstrapMock.mockResolvedValue({
      competitions: [],
      teams: [],
      rangeTemplates: [
        { id: 'template-1', name: '企业攻防靶场', slug: 'enterprise-range', version: 'v1' },
      ],
      rangeInstances: [
        {
          id: 'range-destroy-failed',
          name: '销毁失败实例',
          templateId: 'template-1',
          status: 'destroy_failed',
          createdAt: '2026-07-07T07:00:00.000Z',
          lastJobId: 'job-destroy-failed',
          errorSummary: 'Residual cloud resources still exist after destroy.',
        },
      ],
      provisionJobs: [
        {
          id: 'job-destroy-failed',
          rangeInstanceId: 'range-destroy-failed',
          jobType: 'destroy',
          status: 'failed',
          triggeredBy: 'admin',
          startedAt: '2026-07-07T07:00:00.000Z',
          finishedAt: '2026-07-07T07:10:00.000Z',
          errorSummary: 'Residual cloud resources still exist after destroy.',
        },
      ],
    });

    render(<RangeInstancesScreen apiBaseUrl="http://localhost:3001" />);

    expect(await screen.findByText('销毁失败实例')).toBeTruthy();
    expect(screen.getByText('销毁失败')).toBeTruthy();
    expect(screen.getByRole('button', { name: '销毁' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '删除' })).toBeNull();
  });

  it('prefetches scoped detail on intent and reuses the request when opening the row', async () => {
    fetchAdminBootstrapMock.mockResolvedValue({ rangeTemplates: [], provisionJobs: [], rangeInstances: [{ id: 'range-1', name: '待查看实例', status: 'running' }] });
    render(<AdminScreenCacheProvider><RangeInstancesScreen /></AdminScreenCacheProvider>);
    const button = await screen.findByRole('button', { name: '查看详情' });
    fireEvent.mouseEnter(button);
    fireEvent.focus(button);
    fireEvent.click(button);
    await waitFor(() => expect(fetchRangeInstanceDetailMock).toHaveBeenCalledOnce());
    expect(fetchRangeInstanceDetailMock).toHaveBeenCalledWith('http://localhost:3001', 'dev-admin-token', 'range-1');
    expect(pushMock).toHaveBeenCalledWith('/admin/ranges/range-1');
  });

});
