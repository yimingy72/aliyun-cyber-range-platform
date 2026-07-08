import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  fetchSingleInstancesMock,
  fetchProvisionJobsMock,
  fetchPlatformImagesMock,
  fetchInstanceTypeAvailabilityMock,
  launchSingleInstancesMock,
  deleteRangeInstanceMock,
  triggerSingleInstanceActionMock,
} = vi.hoisted(() => ({
  fetchSingleInstancesMock: vi.fn(),
  fetchProvisionJobsMock: vi.fn(),
  fetchPlatformImagesMock: vi.fn(),
  fetchInstanceTypeAvailabilityMock: vi.fn(),
  launchSingleInstancesMock: vi.fn(),
  deleteRangeInstanceMock: vi.fn(),
  triggerSingleInstanceActionMock: vi.fn(),
}));

const { replaceMock } = vi.hoisted(() => ({
  replaceMock: vi.fn(),
}));

const { openWindowMock } = vi.hoisted(() => ({
  openWindowMock: vi.fn(),
}));

const { openedWindowState } = vi.hoisted(() => ({
  openedWindowState: {
    location: { href: '' },
    close: vi.fn(),
  },
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
  fetchInstanceTypeAvailability: fetchInstanceTypeAvailabilityMock,
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
    fetchInstanceTypeAvailabilityMock.mockReset();
    launchSingleInstancesMock.mockReset();
    deleteRangeInstanceMock.mockReset();
    triggerSingleInstanceActionMock.mockReset();
    replaceMock.mockReset();
    openWindowMock.mockReset();
    openedWindowState.location.href = '';
    openedWindowState.close.mockReset();
    vi.stubGlobal('open', openWindowMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders list/history, opens create dialog, and submits the launch payload when the spec is saleable', async () => {
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
    fetchInstanceTypeAvailabilityMock.mockResolvedValue({
      cpu: 2,
      memory: 2,
      regionId: 'cn-hangzhou',
      zoneId: 'cn-hangzhou-h',
      exactAvailable: true,
      matches: [{ instanceTypeId: 'ecs.c6.large', cpu: 2, memoryGiB: 2, family: 'c6', generation: '6', architecture: 'x86' }],
      warning: null,
    });
    launchSingleInstancesMock.mockResolvedValue({
      instances: [{ id: 'single-1', name: 'web-lab-01', createdBy: 'admin', instanceMode: 'single', status: 'pending_create' }],
    });

    render(<SingleInstancesScreen apiBaseUrl="http://localhost:3001" />);

    expect(await screen.findByRole('heading', { name: '实例管理' })).toBeTruthy();
    expect(screen.getByText('公网 IP')).toBeTruthy();
    expect(screen.getByRole('button', { name: '创建实例' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '创建实例' }));
    expect((screen.getByLabelText('密码') as HTMLInputElement).type).toBe('password');
    fireEvent.change(screen.getByLabelText('实例名'), { target: { value: 'web-lab' } });
    fireEvent.change(screen.getByLabelText('镜像'), { target: { value: 'Ubuntu 24.04 LTS (m-123)' } });
    fireEvent.change(screen.getByLabelText('CPU'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('内存'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('磁盘大小'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('启动实例数量'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('到期时间'), { target: { value: '2026-07-10T12:00' } });
    await waitFor(() =>
      expect(fetchInstanceTypeAvailabilityMock).toHaveBeenCalledWith(
        'http://localhost:3001',
        'dev-admin-token',
        2,
        2,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: '确认创建' }));

    await waitFor(() =>
      expect(launchSingleInstancesMock).toHaveBeenCalledWith(
        'http://localhost:3001',
        'dev-admin-token',
        expect.objectContaining({
          name: 'web-lab',
          platformImageAssetId: 'platform-image-1',
          cpu: 2,
          memory: 2,
          quantity: 2,
          triggeredBy: 'admin',
        }),
      ),
    );
    expect(launchSingleInstancesMock.mock.calls[0]?.[2]).not.toHaveProperty('systemDiskSize', 0);
    expect(launchSingleInstancesMock.mock.calls[0]?.[2]).not.toHaveProperty('systemDiskSize');
  });

  it('blocks create submit when the current cpu and memory pair is not exactly saleable', async () => {
    fetchSingleInstancesMock.mockResolvedValue([]);
    fetchProvisionJobsMock.mockResolvedValue([]);
    fetchPlatformImagesMock.mockResolvedValue({
      items: [{ id: 'platform-image-1', imageId: 'm-123', displayName: 'Ubuntu 24.04 LTS', enabled: true }],
    });
    fetchInstanceTypeAvailabilityMock.mockResolvedValue({
      cpu: 2,
      memory: 2,
      regionId: 'cn-hangzhou',
      zoneId: 'cn-hangzhou-h',
      exactAvailable: false,
      matches: [],
      warning: '默认可用区暂无 2 核 / 2 G 的精确可售规格',
    });

    render(<SingleInstancesScreen apiBaseUrl="http://localhost:3001" />);

    fireEvent.click(await screen.findByRole('button', { name: '创建实例' }));
    expect(await screen.findByText('默认可用区暂无 2 核 / 2 G 的精确可售规格')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('实例名'), { target: { value: 'blocked-lab' } });
    fireEvent.change(screen.getByLabelText('镜像'), { target: { value: 'Ubuntu 24.04 LTS (m-123)' } });
    fireEvent.change(screen.getByLabelText('到期时间'), { target: { value: '2026-07-10T12:00' } });
    fireEvent.click(screen.getByRole('button', { name: '确认创建' }));

    expect(await screen.findByText('当前规格未通过可售校验，请调整 CPU / 内存或稍后重试。')).toBeTruthy();
    expect(launchSingleInstancesMock).not.toHaveBeenCalled();
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
    fetchInstanceTypeAvailabilityMock.mockResolvedValue({
      cpu: 2,
      memory: 2,
      regionId: 'cn-hangzhou',
      zoneId: 'cn-hangzhou-h',
      exactAvailable: true,
      matches: [{ instanceTypeId: 'ecs.c6.large', cpu: 2, memoryGiB: 4, family: 'c6', generation: '6', architecture: 'x86' }],
      warning: null,
    });

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
    expect(screen.getByRole('button', { name: '关闭实例' })).toBeTruthy();
    expect(
      screen
        .getAllByRole('button')
        .filter((button) =>
          ['关闭实例', '重启实例', '打开 VNC', '打包为镜像'].includes(button.textContent ?? ''),
        )
        .map((button) => button.textContent),
    ).toEqual(['关闭实例', '重启实例', '打开 VNC', '打包为镜像']);
    expect(screen.getByRole('button', { name: '重启实例' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '重试创建' })).toBeNull();
    expect(screen.queryByRole('button', { name: '重试关闭' })).toBeNull();

    const createFailedRow = screen.getByText('failed-lab').closest('article');
    fireEvent.click(within(createFailedRow!).getByRole('button', { name: '更多操作' }));
    expect(screen.getByRole('button', { name: '重试创建' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '删除记录' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '关闭实例' })).toBeNull();

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
    expect(screen.getByRole('button', { name: '重试关闭' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '关闭实例' })).toBeNull();
    expect(screen.queryByRole('button', { name: '删除记录' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '实例历史' }));

    expect(await screen.findByText('history-lab')).toBeTruthy();
    expect(screen.getByText(formatExpectedDateTime('2026-07-08T08:15:00.000Z'))).toBeTruthy();
    expect(screen.getByText(formatExpectedDateTime('2026-07-08T10:50:00.000Z'))).toBeTruthy();
    expect(screen.getByText('2 小时 35 分钟')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '更多操作' })).toBeNull();
  });

  it('uses successful retry jobs as effective history lifecycle timestamps', async () => {
    fetchSingleInstancesMock.mockResolvedValue([
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
    ]);
    fetchProvisionJobsMock.mockResolvedValue([
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
        id: 'job-create-retry-history',
        rangeInstanceId: 'single-destroyed',
        jobType: 'retry',
        status: 'succeeded',
        triggeredBy: 'admin',
        startedAt: '2026-07-08T08:25:00.000Z',
        finishedAt: '2026-07-08T08:30:00.000Z',
      },
      {
        id: 'job-destroy-history',
        rangeInstanceId: 'single-destroyed',
        jobType: 'destroy',
        status: 'failed',
        triggeredBy: 'admin',
        startedAt: '2026-07-08T10:40:00.000Z',
        finishedAt: '2026-07-08T10:45:00.000Z',
      },
      {
        id: 'job-destroy-retry-history',
        rangeInstanceId: 'single-destroyed',
        jobType: 'retry',
        status: 'succeeded',
        triggeredBy: 'admin',
        startedAt: '2026-07-08T10:46:00.000Z',
        finishedAt: '2026-07-08T10:50:00.000Z',
      },
    ]);
    fetchPlatformImagesMock.mockResolvedValue({
      items: [{ id: 'platform-image-1', imageId: 'm-123', displayName: 'Ubuntu 24.04 LTS', enabled: true }],
    });

    render(<SingleInstancesScreen apiBaseUrl="http://localhost:3001" />);

    fireEvent.click(await screen.findByRole('button', { name: '实例历史' }));

    expect(await screen.findByText('history-lab')).toBeTruthy();
    expect(screen.getByText(formatExpectedDateTime('2026-07-08T08:25:00.000Z'))).toBeTruthy();
    expect(screen.getByText(formatExpectedDateTime('2026-07-08T10:50:00.000Z'))).toBeTruthy();
    expect(screen.getByText('2 小时 25 分钟')).toBeTruthy();
    expect(screen.queryByText(formatExpectedDateTime('2026-07-08T08:15:00.000Z'))).toBeNull();
    expect(screen.queryByText(formatExpectedDateTime('2026-07-08T10:45:00.000Z'))).toBeNull();
  });

  it('reloads current list and jobs after a successful row action', async () => {
    let currentStatus = 'running';

    fetchSingleInstancesMock.mockImplementation(async () => [
      {
        id: 'single-running',
        name: 'running-lab',
        createdBy: 'admin',
        instanceMode: 'single',
        status: currentStatus,
        createdAt: '2026-07-08T09:00:00.000Z',
        accessEntry: { publicIp: '47.1.2.3' },
        singleInstanceConfig: {
          imageDisplayName: 'Ubuntu 24.04 LTS',
          cpu: 2,
          memory: 2,
        },
      },
    ]);
    fetchProvisionJobsMock.mockImplementation(async () =>
      currentStatus === 'pending_destroy'
        ? [
            {
              id: 'job-destroy-reloaded',
              rangeInstanceId: 'single-running',
              jobType: 'destroy',
              status: 'running',
              triggeredBy: 'admin',
              startedAt: '2026-07-08T09:10:00.000Z',
            },
          ]
        : [],
    );
    fetchPlatformImagesMock.mockResolvedValue({
      items: [{ id: 'platform-image-1', imageId: 'm-123', displayName: 'Ubuntu 24.04 LTS', enabled: true }],
    });
    triggerSingleInstanceActionMock.mockImplementation(async () => {
      currentStatus = 'pending_destroy';
      return { jobId: 'job-destroy-reloaded' };
    });

    render(<SingleInstancesScreen apiBaseUrl="http://localhost:3001" />);

    expect(await screen.findByText('running-lab')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: '更多操作' }));
    fireEvent.click(screen.getByRole('button', { name: '关闭实例' }));

    await waitFor(() =>
      expect(triggerSingleInstanceActionMock).toHaveBeenCalledWith(
        'http://localhost:3001',
        'dev-admin-token',
        'single-running',
        'destroy',
        expect.objectContaining({ triggeredBy: 'admin' }),
      ),
    );
    await waitFor(() => expect(fetchSingleInstancesMock.mock.calls.length).toBeGreaterThan(1));
    expect(await screen.findByText('销毁中')).toBeTruthy();
  });

  it('opens returned vnc url for open-vnc actions', async () => {
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
    ]);
    fetchProvisionJobsMock.mockResolvedValue([]);
    fetchPlatformImagesMock.mockResolvedValue({
      items: [{ id: 'platform-image-1', imageId: 'm-123', displayName: 'Ubuntu 24.04 LTS', enabled: true }],
    });
    openWindowMock.mockReturnValue(openedWindowState as unknown as Window);
    triggerSingleInstanceActionMock.mockResolvedValue({
      vncUrl: 'https://console.example.test/vnc/session-1',
    });

    render(<SingleInstancesScreen apiBaseUrl="http://localhost:3001" />);

    expect(await screen.findByText('running-lab')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '更多操作' }));
    fireEvent.click(screen.getByRole('button', { name: '打开 VNC' }));

    await waitFor(() =>
      expect(openWindowMock).toHaveBeenCalledWith(
        '',
        '_blank',
        'noopener,noreferrer',
      ),
    );
    await waitFor(() =>
      expect(openedWindowState.location.href).toBe('https://console.example.test/vnc/session-1'),
    );
  });

  it('blocks duplicate row action clicks while a request is in flight', async () => {
    let resolveAction: ((value: { jobId: string }) => void) | null = null;

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
    ]);
    fetchProvisionJobsMock.mockResolvedValue([]);
    fetchPlatformImagesMock.mockResolvedValue({
      items: [{ id: 'platform-image-1', imageId: 'm-123', displayName: 'Ubuntu 24.04 LTS', enabled: true }],
    });
    triggerSingleInstanceActionMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveAction = resolve;
        }),
    );

    render(<SingleInstancesScreen apiBaseUrl="http://localhost:3001" />);

    expect(await screen.findByText('running-lab')).toBeTruthy();
    const actionTrigger = screen.getByRole('button', { name: '更多操作' }) as HTMLButtonElement;
    fireEvent.click(actionTrigger);

    const closeButton = screen.getByRole('button', { name: '关闭实例' }) as HTMLButtonElement;
    fireEvent.click(closeButton);
    fireEvent.click(closeButton);

    expect(triggerSingleInstanceActionMock).toHaveBeenCalledTimes(1);
    await waitFor(() => expect((screen.getByRole('button', { name: '更多操作' }) as HTMLButtonElement).disabled).toBe(true));

    resolveAction?.({ jobId: 'job-destroy-reloaded' });
    await waitFor(() => expect(fetchSingleInstancesMock.mock.calls.length).toBeGreaterThan(1));
  });

  it('guards create flow when there are no enabled platform images', async () => {
    fetchSingleInstancesMock.mockResolvedValue([]);
    fetchProvisionJobsMock.mockResolvedValue([]);
    fetchPlatformImagesMock.mockResolvedValue({
      items: [{ id: 'platform-image-disabled', imageId: 'm-disabled', displayName: 'Disabled image', enabled: false }],
    });

    render(<SingleInstancesScreen apiBaseUrl="http://localhost:3001" />);

    expect(await screen.findByRole('heading', { name: '实例管理' })).toBeTruthy();
    expect(screen.getByText('请先前往镜像中心收录或启用至少一个平台镜像。')).toBeTruthy();
    expect((screen.getByRole('button', { name: '创建实例' }) as HTMLButtonElement).disabled).toBe(true);
    expect(fetchInstanceTypeAvailabilityMock).not.toHaveBeenCalled();
  });
});
