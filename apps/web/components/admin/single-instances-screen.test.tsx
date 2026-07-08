import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  fetchSingleInstancesMock,
  fetchProvisionJobsMock,
  fetchPlatformImagesMock,
  launchSingleInstancesMock,
  deleteRangeInstanceMock,
  triggerSingleInstanceActionMock,
} = vi.hoisted(() => ({
  fetchSingleInstancesMock: vi.fn(),
  fetchProvisionJobsMock: vi.fn(),
  fetchPlatformImagesMock: vi.fn(),
  launchSingleInstancesMock: vi.fn(),
  deleteRangeInstanceMock: vi.fn(),
  triggerSingleInstanceActionMock: vi.fn(),
}));

const { replaceMock } = vi.hoisted(() => ({
  replaceMock: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    replace: replaceMock,
  }),
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
  fetchSingleInstances: fetchSingleInstancesMock,
  fetchProvisionJobs: fetchProvisionJobsMock,
  fetchPlatformImages: fetchPlatformImagesMock,
  launchSingleInstances: launchSingleInstancesMock,
  deleteRangeInstance: deleteRangeInstanceMock,
  triggerSingleInstanceAction: triggerSingleInstanceActionMock,
}));

import { SingleInstancesScreen } from './single-instances-screen';

function formatExpectedDateTime(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
    .format(new Date(value))
    .replace(/\//g, '-');
}

describe('SingleInstancesScreen', () => {
  beforeEach(() => {
    fetchSingleInstancesMock.mockReset();
    fetchProvisionJobsMock.mockReset();
    fetchPlatformImagesMock.mockReset();
    launchSingleInstancesMock.mockReset();
    deleteRangeInstanceMock.mockReset();
    triggerSingleInstanceActionMock.mockReset();
    replaceMock.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders list/history, opens create dialog, and submits the launch payload', async () => {
    fetchSingleInstancesMock.mockResolvedValue([
      {
        id: 'single-1',
        name: 'web-lab-01',
        createdBy: 'admin',
        instanceMode: 'single',
        status: 'running',
        createdAt: '2026-07-08T09:00:00.000Z',
        expiresAt: '2026-07-10T12:00:00.000Z',
        accessEntry: { publicIp: '47.1.2.3' },
        singleInstanceConfig: {
          imageDisplayName: 'Ubuntu 24.04 LTS',
          cpu: 2,
          memory: 2,
        },
      },
    ]);

    fetchProvisionJobsMock.mockResolvedValue([]);
    fetchPlatformImagesMock.mockResolvedValue({
      items: [{ id: 'platform-image-1', imageId: 'm-123', displayName: 'Ubuntu 24.04 LTS', enabled: true }],
    });
    launchSingleInstancesMock.mockResolvedValue({
      instances: [{ id: 'single-1', name: 'web-lab-01', createdBy: 'admin', instanceMode: 'single', status: 'pending_create' }],
    });

    render(<SingleInstancesScreen apiBaseUrl="http://localhost:3001" />);

    expect(await screen.findByRole('heading', { name: '实例管理' })).toBeTruthy();
    expect(screen.getByText('公网 IP')).toBeTruthy();
    expect(screen.getByRole('button', { name: '创建实例' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '创建实例' }));
    fireEvent.change(screen.getByLabelText('实例名'), { target: { value: 'web-lab' } });
    fireEvent.change(screen.getByLabelText('CPU'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('内存'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('启动实例数量'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('到期时间'), { target: { value: '2026-07-10T12:00' } });
    fireEvent.click(screen.getByRole('button', { name: '确认创建' }));

    await waitFor(() =>
      expect(launchSingleInstancesMock).toHaveBeenCalledWith(
        'http://localhost:3001',
        'dev-admin-token',
        expect.objectContaining({
          name: 'web-lab',
          cpu: 2,
          memory: 2,
          quantity: 2,
          triggeredBy: 'admin',
        }),
      ),
    );
  });

  it('only offers backend-valid row actions and derives history times from lifecycle jobs', async () => {
    fetchSingleInstancesMock.mockResolvedValue([
      {
        id: 'single-running',
        name: 'running-lab',
        createdBy: 'admin',
        instanceMode: 'single',
        status: 'running',
        createdAt: '2026-07-08T09:00:00.000Z',
        accessEntry: { publicIp: '47.1.2.3' },
        singleInstanceConfig: {
          imageDisplayName: 'Ubuntu 24.04 LTS',
          cpu: 2,
          memory: 2,
        },
      },
      {
        id: 'single-create-failed',
        name: 'failed-lab',
        createdBy: 'admin',
        instanceMode: 'single',
        status: 'create_failed',
        createdAt: '2026-07-08T10:00:00.000Z',
        singleInstanceConfig: {
          imageDisplayName: 'Ubuntu 24.04 LTS',
          cpu: 2,
          memory: 2,
        },
      },
      {
        id: 'single-destroyed',
        name: 'history-lab',
        createdBy: 'admin',
        instanceMode: 'single',
        status: 'destroyed',
        createdAt: '2026-07-08T08:00:00.000Z',
        accessEntry: { publicIp: '47.9.9.9' },
        singleInstanceConfig: {
          imageDisplayName: 'Ubuntu 24.04 LTS',
          cpu: 4,
          memory: 8,
        },
      },
      {
        id: 'single-destroy-failed',
        name: 'destroy-failed-lab',
        createdBy: 'admin',
        instanceMode: 'single',
        status: 'destroy_failed',
        createdAt: '2026-07-08T11:00:00.000Z',
        singleInstanceConfig: {
          imageDisplayName: 'Ubuntu 24.04 LTS',
          cpu: 2,
          memory: 4,
        },
      },
    ]);

    fetchProvisionJobsMock.mockResolvedValue([
      {
        id: 'job-create-running',
        rangeInstanceId: 'single-running',
        jobType: 'create',
        status: 'succeeded',
        triggeredBy: 'admin',
        startedAt: '2026-07-08T09:05:00.000Z',
        finishedAt: '2026-07-08T09:08:00.000Z',
      },
      {
        id: 'job-create-history',
        rangeInstanceId: 'single-destroyed',
        jobType: 'create',
        status: 'succeeded',
        triggeredBy: 'admin',
        startedAt: '2026-07-08T08:15:00.000Z',
        finishedAt: '2026-07-08T08:20:00.000Z',
      },
      {
        id: 'job-destroy-history',
        rangeInstanceId: 'single-destroyed',
        jobType: 'destroy',
        status: 'succeeded',
        triggeredBy: 'admin',
        startedAt: '2026-07-08T10:40:00.000Z',
        finishedAt: '2026-07-08T10:50:00.000Z',
      },
    ]);
    fetchPlatformImagesMock.mockResolvedValue({
      items: [{ id: 'platform-image-1', imageId: 'm-123', displayName: 'Ubuntu 24.04 LTS', enabled: true }],
    });

    render(<SingleInstancesScreen apiBaseUrl="http://localhost:3001" />);

    expect(await screen.findByText('running-lab')).toBeTruthy();

    fireEvent.click(screen.getAllByRole('button', { name: '更多操作' })[0]);
    expect(screen.getByRole('button', { name: '销毁实例' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '重启实例' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '重试创建' })).toBeNull();
    expect(screen.queryByRole('button', { name: '重试销毁' })).toBeNull();

    const createFailedRow = screen.getByText('failed-lab').closest('article');
    fireEvent.click(within(createFailedRow!).getByRole('button', { name: '更多操作' }));
    expect(screen.getByRole('button', { name: '重试创建' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '删除记录' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '销毁实例' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '删除记录' }));
    await waitFor(() =>
      expect(deleteRangeInstanceMock).toHaveBeenCalledWith(
        'http://localhost:3001',
        'dev-admin-token',
        'single-create-failed',
      ),
    );

    const destroyFailedRow = screen.getByText('destroy-failed-lab').closest('article');
    fireEvent.click(within(destroyFailedRow!).getByRole('button', { name: '更多操作' }));
    expect(screen.getByRole('button', { name: '重试销毁' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '销毁实例' })).toBeNull();
    expect(screen.queryByRole('button', { name: '删除记录' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '实例历史' }));

    expect(await screen.findByText('history-lab')).toBeTruthy();
    expect(screen.getByText(formatExpectedDateTime('2026-07-08T08:15:00.000Z'))).toBeTruthy();
    expect(screen.getByText(formatExpectedDateTime('2026-07-08T10:50:00.000Z'))).toBeTruthy();
    expect(screen.getByText('2 小时 35 分钟')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '更多操作' })).toBeNull();
  });
});
