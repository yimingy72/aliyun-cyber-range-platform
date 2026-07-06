import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  createRangeInstanceMock,
  deleteRangeInstanceMock,
  fetchAdminBootstrapMock,
  fetchRangeInstanceDetailMock,
  fetchProvisionJobDetailMock,
  triggerRangeActionMock,
} = vi.hoisted(() => ({
  createRangeInstanceMock: vi.fn(),
  deleteRangeInstanceMock: vi.fn(),
  fetchAdminBootstrapMock: vi.fn(),
  fetchRangeInstanceDetailMock: vi.fn(),
  fetchProvisionJobDetailMock: vi.fn(),
  triggerRangeActionMock: vi.fn(),
}));

const { pushMock, replaceMock, searchParamsState } = vi.hoisted(() => ({
  pushMock: vi.fn(),
  replaceMock: vi.fn(),
  searchParamsState: { value: '' },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: pushMock,
    replace: replaceMock,
  }),
  useSearchParams: () => new URLSearchParams(searchParamsState.value),
}));

vi.mock('./use-admin-session', () => ({
  useAdminSession: () => ({
    token: 'dev-admin-token',
    isReady: true,
    login: vi.fn(),
    logout: vi.fn(),
  }),
}));

vi.mock('../../lib/admin-api', () => ({
  createRangeInstance: createRangeInstanceMock,
  deleteRangeInstance: deleteRangeInstanceMock,
  fetchAdminBootstrap: fetchAdminBootstrapMock,
  fetchRangeInstanceDetail: fetchRangeInstanceDetailMock,
  fetchProvisionJobDetail: fetchProvisionJobDetailMock,
  triggerRangeAction: triggerRangeActionMock,
}));

import { RangeInstancesScreen } from './range-instances-screen';

describe('RangeInstancesScreen', () => {
  beforeEach(() => {
    createRangeInstanceMock.mockReset();
    deleteRangeInstanceMock.mockReset();
    fetchAdminBootstrapMock.mockReset();
    fetchRangeInstanceDetailMock.mockReset();
    fetchProvisionJobDetailMock.mockReset();
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
      ],
    });

    render(<RangeInstancesScreen apiBaseUrl="http://localhost:3001" />);

    expect(await screen.findByRole('heading', { name: '靶场实例' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '实例列表' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '实例历史' })).toBeTruthy();
    expect(screen.getByLabelText('筛选实例名')).toBeTruthy();
    expect(screen.queryByText('1 条记录')).toBeNull();
    expect(screen.queryByText('运行期管理')).toBeNull();
    expect(screen.queryByText('管理由靶场编排生成的运行实例，重点关注状态、创建时间和实例生命周期动作。')).toBeNull();
    expect(screen.getAllByText('实例名').length).toBeGreaterThan(0);
    expect(screen.getAllByText('靶场名').length).toBeGreaterThan(0);
    expect(screen.getByText('状态')).toBeTruthy();
    expect(screen.getByText('创建时间')).toBeTruthy();
    expect(screen.getByText('操作')).toBeTruthy();
    expect(screen.getByText('蓝队靶场 01')).toBeTruthy();
    expect(screen.queryByText('range-1')).toBeNull();
    expect(screen.getAllByText('企业攻防靶场').length).toBeGreaterThan(0);
    expect(screen.queryByText('红队靶场 02')).toBeNull();
    expect(screen.queryByText('已回收实例')).toBeNull();
    expect(screen.queryByText('开启时间')).toBeNull();
    expect(screen.queryByText('回收时间')).toBeNull();
    expect(screen.queryByText('运行时长')).toBeNull();
    expect(screen.queryByRole('heading', { name: '实例详情' })).toBeNull();
    expect(screen.getByRole('button', { name: '查看详情' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '关闭' })).toBeTruthy();
    expect(screen.queryByText('创建实例')).toBeNull();
    expect(screen.queryByText('筛选条件')).toBeNull();

    fireEvent.change(screen.getByLabelText('筛选实例名'), { target: { value: '蓝队' } });
    expect(screen.getByText('蓝队靶场 01')).toBeTruthy();
    expect(screen.queryByText('红队靶场 02')).toBeNull();

    fireEvent.change(screen.getByLabelText('筛选实例名'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: '实例历史' }));

    expect(screen.queryByText('蓝队靶场 01')).toBeNull();
    expect(screen.getByText('红队靶场 02')).toBeTruthy();
    expect(screen.queryByText('已回收实例')).toBeNull();
    expect(screen.getByText('开启时间')).toBeTruthy();
    expect(screen.getByText('回收时间')).toBeTruthy();
    expect(screen.getByText('运行时长')).toBeTruthy();
    expect(screen.queryByText('状态')).toBeNull();
    expect(screen.queryByText('操作')).toBeNull();
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

  it('triggers a destroy lifecycle action from the list row', async () => {
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

    await waitFor(() => {
      expect(triggerRangeActionMock).toHaveBeenCalledWith(
        'http://localhost:3001',
        'dev-admin-token',
        'range-1',
        'destroy',
        'admin',
      );
    });
  });

  it('shows delete for create_failed instances and removes the row after deletion', async () => {
    fetchAdminBootstrapMock.mockResolvedValue({
      competitions: [],
      teams: [],
      rangeTemplates: [
        { id: 'template-1', name: '企业攻防靶场', slug: 'enterprise-range', version: 'v1' },
      ],
      rangeInstances: [
        {
          id: 'range-failed',
          name: '失败靶场 01',
          templateId: 'template-1',
          status: 'create_failed',
          createdAt: '2026-06-29T09:00:00.000Z',
          lastJobId: 'job-failed',
        },
      ],
      provisionJobs: [
        { id: 'job-failed', rangeInstanceId: 'range-failed', jobType: 'create', status: 'failed', triggeredBy: 'admin', startedAt: '2026-06-29T09:00:00.000Z' },
      ],
    });
    deleteRangeInstanceMock.mockResolvedValue(undefined);

    render(<RangeInstancesScreen apiBaseUrl="http://localhost:3001" />);

    expect(await screen.findByText('失败靶场 01')).toBeTruthy();
    expect(screen.getByRole('button', { name: '删除' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '关闭' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '删除' }));

    await waitFor(() => {
      expect(deleteRangeInstanceMock).toHaveBeenCalledWith(
        'http://localhost:3001',
        'dev-admin-token',
        'range-failed',
      );
    });

    await waitFor(() => {
      expect(screen.queryByText('失败靶场 01')).toBeNull();
    });
  });

  it('keeps the page shell visible while instances are still loading', () => {
    fetchAdminBootstrapMock.mockImplementation(() => new Promise(() => undefined));

    render(<RangeInstancesScreen apiBaseUrl="http://localhost:3001" />);

    expect(screen.getByRole('heading', { name: '靶场实例' })).toBeTruthy();
    expect(screen.queryByText('正在加载靶场实例...')).toBeNull();
  });

  it('shows delete for create_failed instances, falls back to template snapshot, and removes the row after deletion', async () => {
    fetchAdminBootstrapMock.mockResolvedValue({
      competitions: [],
      teams: [],
      rangeTemplates: [],
      rangeInstances: [
        {
          id: 'range-failed',
          name: '失败实例 01',
          templateId: null,
          templateNameSnapshot: '已删除模板',
          status: 'create_failed',
          createdAt: '2026-06-29T09:00:00.000Z',
          lastJobId: 'job-failed',
          errorSummary: 'mock failed',
        },
      ],
      provisionJobs: [
        {
          id: 'job-failed',
          rangeInstanceId: 'range-failed',
          jobType: 'create',
          status: 'failed',
          triggeredBy: 'admin',
          startedAt: '2026-06-29T09:00:00.000Z',
        },
      ],
    });
    deleteRangeInstanceMock.mockResolvedValue(undefined);

    render(<RangeInstancesScreen apiBaseUrl="http://localhost:3001" />);

    await screen.findByText('失败实例 01');
    expect(screen.getByText('已删除模板')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '删除' }));

    await waitFor(() => {
      expect(deleteRangeInstanceMock).toHaveBeenCalledWith(
        'http://localhost:3001',
        'dev-admin-token',
        'range-failed',
      );
    });

    await waitFor(() => {
      expect(screen.queryByText('失败实例 01')).toBeNull();
    });
  });
});
