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

const { replaceMock, routerMock, searchParamsState } = vi.hoisted(() => {
  const replaceMock = vi.fn();

  return {
    replaceMock,
    routerMock: { replace: replaceMock },
    searchParamsState: { value: '' },
  };
});

const { openWindowMock } = vi.hoisted(() => ({
  openWindowMock: vi.fn(),
}));

const { writeTextMock } = vi.hoisted(() => ({
  writeTextMock: vi.fn(),
}));

const { createObjectUrlMock, revokeObjectUrlMock } = vi.hoisted(() => ({
  createObjectUrlMock: vi.fn(),
  revokeObjectUrlMock: vi.fn(),
}));

const { openedWindowState } = vi.hoisted(() => ({
  openedWindowState: {
    location: { href: '' },
    opener: 'not-null' as unknown,
    close: vi.fn(),
  },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => routerMock,
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

class ResizeObserverMock {
  disconnect() {}

  observe() {}

  unobserve() {}
}

vi.stubGlobal('ResizeObserver', ResizeObserverMock);

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

function readBlobAsBytes(blob: Blob) {
  return new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader();

    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.readAsArrayBuffer(blob);
  });
}

describe('SingleInstancesScreen', () => {
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
    openWindowMock.mockReset();
    writeTextMock.mockReset();
    createObjectUrlMock.mockReset();
    revokeObjectUrlMock.mockReset();
    openedWindowState.location.href = '';
    openedWindowState.opener = 'not-null' as unknown;
    openedWindowState.close.mockReset();
    vi.stubGlobal('open', openWindowMock);
    Object.defineProperty(URL, 'createObjectURL', {
      writable: true,
      value: createObjectUrlMock.mockReturnValue('blob:batch-export'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      writable: true,
      value: revokeObjectUrlMock,
    });
    Object.assign(navigator, {
      clipboard: {
        writeText: writeTextMock,
      },
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders list/history, opens create dialog, and submits the launch payload without triggeredBy', async () => {
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
        runtimeCredentials: {
          'single-ecs-1': {
            username: 'root',
            password: 'super-secret-password',
          },
        },
        singleInstanceConfig: {
          hostKey: 'single-ecs-1',
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
    const table = screen.getByRole('table', { name: '实例列表' });
    expect(within(table).getByRole('columnheader', { name: '公网 IP' })).toBeTruthy();
    expect(within(table).getByRole('columnheader', { name: '账号 / 密码' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '创建实例' })).toBeTruthy();
    expect(screen.getByText('root / ******')).toBeTruthy();

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
        }),
      ),
    );
    expect(launchSingleInstancesMock.mock.calls[0]?.[2]).not.toHaveProperty('systemDiskSize', 0);
    expect(launchSingleInstancesMock.mock.calls[0]?.[2]).not.toHaveProperty('systemDiskSize');
  });

  it('renders batch rows and expands child instances', async () => {
    fetchSingleInstancesMock.mockResolvedValue({
      batches: [
        {
          batch: {
            id: 'batch-1',
            name: 'web-lab-batch',
            imageDisplayName: 'Ubuntu 24.04 LTS',
            imageId: 'm-123',
            platformImageAssetId: 'platform-image-1',
            cpu: 2,
            memory: 2,
            systemDiskSize: 40,
            quantity: 5,
            createdBy: 'admin',
            createdAt: '2026-07-08T09:00:00.000Z',
            expiresAt: '2026-07-10T12:00:00.000Z',
          },
          instances: [
            {
              id: 'single-1',
              name: 'web-lab-01',
              createdBy: 'admin',
              instanceMode: 'single',
              status: 'running',
              accessEntry: { publicIp: '47.1.2.3' },
              runtimeCredentials: {
                'single-ecs-1': {
                  username: 'root',
                  password: 'super-secret-password',
                },
              },
              singleInstanceConfig: {
                hostKey: 'single-ecs-1',
                imageDisplayName: 'Ubuntu 24.04 LTS',
                cpu: 2,
                memory: 2,
              },
            },
          ],
        },
      ],
      standaloneInstances: [],
    });
    fetchProvisionJobsMock.mockResolvedValue([]);
    fetchPlatformImagesMock.mockResolvedValue({
      items: [{ id: 'platform-image-1', imageId: 'm-123', displayName: 'Ubuntu 24.04 LTS', enabled: true }],
    });

    render(<SingleInstancesScreen apiBaseUrl="http://localhost:3001" />);

    expect(await screen.findByText('web-lab-batch')).toBeTruthy();
    const table = screen.getByRole('table', { name: '实例列表' });
    expect(within(table).getByRole('columnheader', { name: '实例 / 批次' })).toBeTruthy();
    expect(within(table).queryByText('批次', { selector: 'span' })).toBeNull();
    expect(within(table).queryByText('web-lab-01')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '展开批次 web-lab-batch' }));
    expect(await screen.findByText('web-lab-01')).toBeTruthy();
    expect(screen.getByRole('button', { name: '关闭' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '关闭实例' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '打开 VNC' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '更多操作' }));
    expect(screen.getByRole('button', { name: '重启实例' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '打包为镜像' })).toBeNull();
  });

  it('keeps pack image available for a quantity-1 batch child row', async () => {
    fetchSingleInstancesMock.mockResolvedValue({
      batches: [
        {
          batch: {
            id: 'batch-1',
            name: 'single-child-batch',
            imageDisplayName: 'Ubuntu 24.04 LTS',
            imageId: 'm-123',
            platformImageAssetId: 'platform-image-1',
            cpu: 2,
            memory: 2,
            systemDiskSize: 40,
            quantity: 1,
            createdBy: 'admin',
            createdAt: '2026-07-08T09:00:00.000Z',
            expiresAt: '2026-07-10T12:00:00.000Z',
          },
          instances: [
            {
              id: 'single-1',
              name: 'single-child-01',
              createdBy: 'admin',
              instanceMode: 'single',
              status: 'running',
              accessEntry: { publicIp: '47.1.2.3' },
              runtimeCredentials: {
                'single-ecs-1': {
                  username: 'root',
                  password: 'super-secret-password',
                },
              },
              singleInstanceConfig: {
                hostKey: 'single-ecs-1',
                imageDisplayName: 'Ubuntu 24.04 LTS',
                cpu: 2,
                memory: 2,
              },
            },
          ],
        },
      ],
      standaloneInstances: [],
    });
    fetchProvisionJobsMock.mockResolvedValue([]);
    fetchPlatformImagesMock.mockResolvedValue({
      items: [{ id: 'platform-image-1', imageId: 'm-123', displayName: 'Ubuntu 24.04 LTS', enabled: true }],
    });

    render(<SingleInstancesScreen apiBaseUrl="http://localhost:3001" />);

    expect(await screen.findByText('single-child-batch')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '展开批次 single-child-batch' }));
    expect(await screen.findByText('single-child-01')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '更多操作' }));
    expect(screen.getByRole('button', { name: '打包为镜像' })).toBeTruthy();
  });

  it('opens the action menu upward when the trigger is near the viewport bottom', async () => {
    fetchSingleInstancesMock.mockResolvedValue({
      batches: [
        {
          batch: {
            id: 'batch-1',
            name: 'single-child-batch',
            imageDisplayName: 'Ubuntu 24.04 LTS',
            imageId: 'm-123',
            platformImageAssetId: 'platform-image-1',
            cpu: 2,
            memory: 2,
            systemDiskSize: 40,
            quantity: 1,
            createdBy: 'admin',
            createdAt: '2026-07-08T09:00:00.000Z',
            expiresAt: '2026-07-10T12:00:00.000Z',
          },
          instances: [
            {
              id: 'single-1',
              name: 'single-child-01',
              createdBy: 'admin',
              instanceMode: 'single',
              status: 'running',
              accessEntry: { publicIp: '47.1.2.3' },
              runtimeCredentials: {
                'single-ecs-1': {
                  username: 'root',
                  password: 'super-secret-password',
                },
              },
              singleInstanceConfig: {
                hostKey: 'single-ecs-1',
                imageDisplayName: 'Ubuntu 24.04 LTS',
                cpu: 2,
                memory: 2,
              },
            },
          ],
        },
      ],
      standaloneInstances: [],
    });
    fetchProvisionJobsMock.mockResolvedValue([]);
    fetchPlatformImagesMock.mockResolvedValue({
      items: [{ id: 'platform-image-1', imageId: 'm-123', displayName: 'Ubuntu 24.04 LTS', enabled: true }],
    });

    render(<SingleInstancesScreen apiBaseUrl="http://localhost:3001" />);

    fireEvent.click(await screen.findByRole('button', { name: '展开批次 single-child-batch' }));
    const moreActionsButton = await screen.findByRole('button', { name: '更多操作' });
    const originalInnerHeight = window.innerHeight;
    try {
      Object.defineProperty(window, 'innerHeight', {
        configurable: true,
        value: 800,
      });
      vi.spyOn(moreActionsButton, 'getBoundingClientRect').mockReturnValue({
        x: 0,
        y: 0,
        width: 80,
        height: 32,
        top: 740,
        right: 80,
        bottom: 772,
        left: 0,
        toJSON: () => ({}),
      } as DOMRect);

      fireEvent.click(moreActionsButton);

      expect(screen.getByRole('button', { name: '重启实例' }).closest('.template-workbench-action-menu')?.className).toContain(
        'is-upward',
      );
    } finally {
      Object.defineProperty(window, 'innerHeight', {
        configurable: true,
        value: originalInnerHeight,
      });
    }
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

    expect(screen.getByRole('button', { name: '关闭实例' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '打开 VNC' })).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: '更多操作' })[0]);
    expect(
      screen
        .getAllByRole('button')
        .filter((button) =>
          ['关闭实例', '重启实例', '打开 VNC', '打包为镜像'].includes(button.textContent ?? ''),
        )
        .map((button) => button.textContent),
    ).toEqual(['关闭实例', '打开 VNC', '重启实例', '打包为镜像']);
    expect(screen.getByRole('button', { name: '重启实例' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '重试创建' })).toBeNull();
    expect(screen.queryByRole('button', { name: '重试关闭' })).toBeNull();

    const createFailedRow = screen.getByText('failed-lab').closest('tr');
    fireEvent.click(within(createFailedRow!).getByRole('button', { name: '更多操作' }));
    expect(screen.getByRole('button', { name: '重试创建' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '删除记录' })).toBeTruthy();
    expect(within(createFailedRow!).queryByRole('button', { name: '关闭实例' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '删除记录' }));
    await waitFor(() =>
      expect(deleteRangeInstanceMock).toHaveBeenCalledWith(
        'http://localhost:3001',
        'dev-admin-token',
        'single-create-failed',
      ),
    );

    const destroyFailedRow = screen.getByText('destroy-failed-lab').closest('tr');
    fireEvent.click(within(destroyFailedRow!).getByRole('button', { name: '更多操作' }));
    expect(screen.getByRole('button', { name: '重试关闭' })).toBeTruthy();
    expect(within(destroyFailedRow!).queryByRole('button', { name: '关闭实例' })).toBeNull();
    expect(within(destroyFailedRow!).queryByRole('button', { name: '删除记录' })).toBeNull();

    fireEvent.mouseDown(screen.getByRole('tab', { name: '实例历史' }), { button: 0 });

    expect(await screen.findByText('history-lab')).toBeTruthy();
    expect(screen.getByText('创建人')).toBeTruthy();
    expect(screen.getAllByText('admin').length).toBeGreaterThan(0);
    expect(screen.queryByText('操作')).toBeNull();
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

    fireEvent.mouseDown(await screen.findByRole('tab', { name: '实例历史' }), { button: 0 });

    expect(await screen.findByText('history-lab')).toBeTruthy();
    expect(screen.getByText(formatExpectedDateTime('2026-07-08T08:25:00.000Z'))).toBeTruthy();
    expect(screen.getByText(formatExpectedDateTime('2026-07-08T10:50:00.000Z'))).toBeTruthy();
    expect(screen.getByText('2 小时 25 分钟')).toBeTruthy();
    expect(screen.queryByText(formatExpectedDateTime('2026-07-08T08:15:00.000Z'))).toBeNull();
    expect(screen.queryByText(formatExpectedDateTime('2026-07-08T10:45:00.000Z'))).toBeNull();
  });

  it('keeps the history view selected when the url query requests it', async () => {
    searchParamsState.value = 'view=history';
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
    fetchProvisionJobsMock.mockResolvedValue([]);
    fetchPlatformImagesMock.mockResolvedValue({
      items: [{ id: 'platform-image-1', imageId: 'm-123', displayName: 'Ubuntu 24.04 LTS', enabled: true }],
    });

    render(<SingleInstancesScreen apiBaseUrl="http://localhost:3001" />);

    expect(await screen.findByText('history-lab')).toBeTruthy();
    expect(screen.getByRole('tab', { name: '实例历史' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: '实例列表' }).getAttribute('aria-selected')).toBe('false');
  });

  it('filters active and history rows by instance name', async () => {
    fetchSingleInstancesMock.mockResolvedValue([
      {
        id: 'single-running',
        name: 'alpha-lab',
        createdBy: 'admin',
        instanceMode: 'single',
        status: 'running',
        createdAt: '2026-07-08T09:00:00.000Z',
        singleInstanceConfig: {
          imageDisplayName: 'Ubuntu 24.04 LTS',
          cpu: 2,
          memory: 2,
        },
      },
      {
        id: 'single-destroying',
        name: 'beta-lab',
        createdBy: 'admin',
        instanceMode: 'single',
        status: 'pending_destroy',
        createdAt: '2026-07-08T09:05:00.000Z',
        singleInstanceConfig: {
          imageDisplayName: 'Ubuntu 24.04 LTS',
          cpu: 2,
          memory: 4,
        },
      },
      {
        id: 'single-destroyed',
        name: 'archive-lab',
        createdBy: 'admin',
        instanceMode: 'single',
        status: 'destroyed',
        createdAt: '2026-07-08T08:00:00.000Z',
        singleInstanceConfig: {
          imageDisplayName: 'Ubuntu 24.04 LTS',
          cpu: 4,
          memory: 8,
        },
      },
    ]);
    fetchProvisionJobsMock.mockResolvedValue([]);
    fetchPlatformImagesMock.mockResolvedValue({
      items: [{ id: 'platform-image-1', imageId: 'm-123', displayName: 'Ubuntu 24.04 LTS', enabled: true }],
    });

    render(<SingleInstancesScreen apiBaseUrl="http://localhost:3001" />);

    expect(await screen.findByText('alpha-lab')).toBeTruthy();
    fireEvent.change(screen.getByRole('searchbox', { name: '筛选实例名' }), { target: { value: 'beta' } });
    expect(screen.queryByText('alpha-lab')).toBeNull();
    expect(screen.getByText('beta-lab')).toBeTruthy();

    fireEvent.mouseDown(screen.getByRole('tab', { name: '实例历史' }), { button: 0 });
    expect(screen.queryByText('archive-lab')).toBeNull();
    fireEvent.change(screen.getByRole('searchbox', { name: '筛选实例名' }), { target: { value: 'archive' } });
    expect(await screen.findByText('archive-lab')).toBeTruthy();
    expect(screen.queryByText('beta-lab')).toBeNull();
  });

  it('reloads current rows and jobs after create succeeds', async () => {
    let fetchPhase: 'initial' | 'reloaded' = 'initial';

    fetchSingleInstancesMock.mockImplementation(async () =>
      fetchPhase === 'initial'
        ? []
        : [
            {
              id: 'single-reloaded',
              name: 'web-lab',
              createdBy: 'admin',
              instanceMode: 'single',
              status: 'creating',
              createdAt: '2026-07-08T09:00:00.000Z',
              singleInstanceConfig: {
                imageDisplayName: 'Ubuntu 24.04 LTS',
                cpu: 2,
                memory: 2,
              },
            },
          ],
    );
    fetchProvisionJobsMock.mockImplementation(async () =>
      fetchPhase === 'initial'
        ? []
        : [
            {
              id: 'job-create-reloaded',
              rangeInstanceId: 'single-reloaded',
              jobType: 'create',
              status: 'running',
              triggeredBy: 'admin',
              startedAt: '2026-07-08T09:01:00.000Z',
            },
          ],
    );
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
    launchSingleInstancesMock.mockImplementation(async () => {
      fetchPhase = 'reloaded';
      return {
        instances: [{ id: 'single-pending', name: 'web-lab', createdBy: 'admin', instanceMode: 'single', status: 'pending_create' }],
      };
    });

    render(<SingleInstancesScreen apiBaseUrl="http://localhost:3001" />);

    fireEvent.click(await screen.findByRole('button', { name: '创建实例' }));
    fireEvent.change(screen.getByLabelText('实例名'), { target: { value: 'web-lab' } });
    fireEvent.change(screen.getByLabelText('镜像'), { target: { value: 'Ubuntu 24.04 LTS (m-123)' } });
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

    await waitFor(() => expect(launchSingleInstancesMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(fetchSingleInstancesMock.mock.calls.length).toBeGreaterThan(1));
    expect(fetchProvisionJobsMock.mock.calls.length).toBe(0);
    expect(await screen.findByText('创建中')).toBeTruthy();
    expect(screen.getByText('web-lab')).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: '创建实例' })).toBeNull();
  });

  it('keeps current rows during a successful row-action refresh and revises the completed table body without triggeredBy', async () => {
    let currentStatus = 'running';
    let resolveReload:
      | ((value: {
          id: string;
          name: string;
          createdBy: string;
          instanceMode: string;
          status: string;
          createdAt: string;
          accessEntry: { publicIp: string };
          singleInstanceConfig: {
            imageDisplayName: string;
            cpu: number;
            memory: number;
          };
        }[]) => void)
      | undefined;
    let shouldDelayReload = false;

    function currentRows() {
      return [
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
      ];
    }

    fetchSingleInstancesMock.mockImplementation(() => {
      if (!shouldDelayReload) {
        return Promise.resolve(currentRows());
      }

      return new Promise((resolve) => {
        resolveReload = resolve;
      });
    });
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
      shouldDelayReload = true;
      return { jobId: 'job-destroy-reloaded' };
    });

    render(<SingleInstancesScreen apiBaseUrl="http://localhost:3001" />);

    expect(await screen.findByText('running-lab')).toBeTruthy();
    const table = screen.getByRole('table', { name: '实例列表' });
    const initialTableBody = table.querySelector('tbody');
    fireEvent.click(await screen.findByRole('button', { name: '更多操作' }));
    fireEvent.click(screen.getByRole('button', { name: '关闭实例' }));

    await waitFor(() =>
      expect(triggerSingleInstanceActionMock).toHaveBeenCalledWith(
        'http://localhost:3001',
        'dev-admin-token',
        'single-running',
        'destroy',
        {},
      ),
    );

    await waitFor(() => {
      expect(resolveReload).toBeTypeOf('function');
      expect(within(table).getByText('running-lab')).toBeTruthy();
      expect(table.getAttribute('aria-busy')).toBe('true');
      expect(table.querySelector('tbody')).toBe(initialTableBody);
    });

    shouldDelayReload = false;
    resolveReload?.(currentRows());

    await waitFor(() => {
      expect(table.getAttribute('aria-busy')).toBeNull();
      expect(table.querySelector('tbody')).not.toBe(initialTableBody);
      expect(table.querySelector('tbody')?.className).toContain('admin-data-table-body-enter');
    });
  });

  it('submits batch destroy without client actor fields', async () => {
    fetchSingleInstancesMock.mockResolvedValue({
      batches: [
        {
          batch: {
            id: 'batch-1',
            name: 'web-lab-batch',
            imageDisplayName: 'Ubuntu 24.04 LTS',
            imageId: 'm-123',
            platformImageAssetId: 'platform-image-1',
            cpu: 2,
            memory: 2,
            systemDiskSize: 40,
            quantity: 2,
            createdBy: 'admin',
          },
          instances: [
            {
              id: 'single-1',
              name: 'web-lab-01',
              createdBy: 'admin',
              instanceMode: 'single',
              status: 'running',
              singleInstanceConfig: {
                hostKey: 'single-ecs-1',
                imageDisplayName: 'Ubuntu 24.04 LTS',
                cpu: 2,
                memory: 2,
              },
            },
          ],
        },
      ],
      standaloneInstances: [],
    });
    fetchProvisionJobsMock.mockResolvedValue([]);
    fetchPlatformImagesMock.mockResolvedValue({
      items: [{ id: 'platform-image-1', imageId: 'm-123', displayName: 'Ubuntu 24.04 LTS', enabled: true }],
    });
    destroySingleInstanceBatchMock.mockResolvedValue({ batchId: 'batch-1', jobCount: 2 });

    render(<SingleInstancesScreen apiBaseUrl="http://localhost:3001" />);

    expect(await screen.findByText('web-lab-batch')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '展开批次 web-lab-batch' }));
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));

    await waitFor(() => {
      expect(destroySingleInstanceBatchMock).toHaveBeenCalledWith(
        'http://localhost:3001',
        'dev-admin-token',
        'batch-1',
      );
    });
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
      vncUrl: 'https://g.alicdn.com/aliyun/ecs-console-vnc2/0.0.8/index.html?vncUrl=wss%3A%2F%2Fvnc.example.test&instanceId=i-instance-1&isWindows=false',
    });

    render(<SingleInstancesScreen apiBaseUrl="http://localhost:3001" />);

    expect(await screen.findByText('running-lab')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '打开 VNC' }));

    await waitFor(() =>
      expect(openWindowMock).toHaveBeenCalledWith(
        '',
        '_blank',
      ),
    );
    expect(openedWindowState.opener).toBeNull();
    await waitFor(() =>
      expect(openedWindowState.location.href).toBe(
        'https://g.alicdn.com/aliyun/ecs-console-vnc2/0.0.8/index.html?vncUrl=wss%3A%2F%2Fvnc.example.test&instanceId=i-instance-1&isWindows=false',
      ),
    );
  });

  it('exports batch instances as csv', async () => {
    const anchorClickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    fetchSingleInstancesMock.mockResolvedValue({
      batches: [
        {
          batch: {
            id: 'batch-1',
            name: 'windows-batch',
            imageDisplayName: 'Windows Server 2022',
            imageId: 'm-win-1',
            platformImageAssetId: 'platform-image-1',
            cpu: 2,
            memory: 4,
            systemDiskSize: 40,
            quantity: 2,
            createdBy: 'admin',
            createdAt: '2026-07-08T09:00:00.000Z',
            expiresAt: '2026-07-10T12:00:00.000Z',
          },
          instances: [
            {
              id: 'single-1',
              name: 'windows-lab-01',
              createdBy: 'admin',
              instanceMode: 'single',
              status: 'running',
              accessEntry: { publicIp: '47.1.2.3' },
              runtimeCredentials: {
                'single-ecs-1': {
                  username: 'root',
                  password: 'secret-1',
                },
              },
              singleInstanceConfig: {
                hostKey: 'single-ecs-1',
                imageDisplayName: 'Windows Server 2022',
                cpu: 2,
                memory: 4,
              },
            },
            {
              id: 'single-2',
              name: 'linux-lab-02',
              createdBy: 'admin',
              instanceMode: 'single',
              status: 'running',
              accessEntry: { publicIp: '47.1.2.4' },
              runtimeCredentials: {
                'single-ecs-1': {
                  username: 'root',
                  password: 'secret-2',
                },
              },
              singleInstanceConfig: {
                hostKey: 'single-ecs-1',
                imageDisplayName: 'Ubuntu 24.04 LTS',
                cpu: 2,
                memory: 4,
              },
            },
          ],
        },
      ],
      standaloneInstances: [],
    });
    fetchProvisionJobsMock.mockResolvedValue([]);
    fetchPlatformImagesMock.mockResolvedValue({
      items: [{ id: 'platform-image-1', imageId: 'm-win-1', displayName: 'Windows Server 2022', enabled: true }],
    });

    render(<SingleInstancesScreen apiBaseUrl="http://localhost:3001" />);

    expect(await screen.findByText('windows-batch')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '导出' }));

    await waitFor(() => expect(createObjectUrlMock).toHaveBeenCalledTimes(1));

    const blob = createObjectUrlMock.mock.calls[0]?.[0] as Blob;
    expect(blob).toBeInstanceOf(Blob);
    const csvBytes = await readBlobAsBytes(blob);
    expect([...csvBytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(new TextDecoder().decode(csvBytes)).toBe(
      '实例名,公网 IP,账号,密码\nwindows-lab-01,47.1.2.3,Administrator,secret-1\nlinux-lab-02,47.1.2.4,root,secret-2',
    );
    expect(anchorClickSpy).toHaveBeenCalledTimes(1);
    expect(revokeObjectUrlMock).toHaveBeenCalledWith('blob:batch-export');

    anchorClickSpy.mockRestore();
  });

  it('opens a pack image dialog before submitting pack-image actions', async () => {
    triggerSingleInstanceActionMock.mockResolvedValue({
      status: 'accepted',
      action: 'pack-image',
      imageReady: false,
    });
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
          hostName: 'running-host',
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

    render(<SingleInstancesScreen apiBaseUrl="http://localhost:3001" />);

    expect(await screen.findByText('running-lab')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '更多操作' }));
    fireEvent.click(screen.getByRole('button', { name: '打包为镜像' }));

    const dialog = screen.getByRole('dialog', { name: '打包为镜像' });
    expect((within(dialog).getByLabelText('镜像名') as HTMLInputElement).value).toBe('running-lab-snapshot');
    expect((within(dialog).getByLabelText('默认主机名') as HTMLInputElement).value).toBe('running-host');

    fireEvent.change(within(dialog).getByLabelText('镜像名'), { target: { value: 'custom-pack-image' } });
    fireEvent.change(within(dialog).getByLabelText('默认主机名'), { target: { value: 'custom-host' } });
    fireEvent.change(within(dialog).getByLabelText('默认密码'), { target: { value: 'Secret123!' } });
    fireEvent.change(within(dialog).getByLabelText('镜像备注'), { target: { value: 'snapshot note' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '确认打包' }));

    await waitFor(() =>
      expect(triggerSingleInstanceActionMock).toHaveBeenCalledWith(
        'http://localhost:3001',
        'dev-admin-token',
        'single-running',
        'pack-image',
        {
          displayName: 'custom-pack-image',
          defaultHostName: 'custom-host',
          defaultPassword: 'Secret123!',
          description: 'snapshot note',
        },
      ),
    );
  });

  it('shows masked credentials and copies only the password', async () => {
    fetchSingleInstancesMock.mockResolvedValue([
      {
        id: 'single-running',
        name: 'running-lab',
        createdBy: 'admin',
        instanceMode: 'single',
        status: 'running',
        createdAt: '2026-07-08T09:00:00.000Z',
        accessEntry: { publicIp: '47.1.2.3' },
        runtimeCredentials: {
          'single-ecs-1': {
            username: 'root',
            password: 'super-secret-password',
          },
        },
        singleInstanceConfig: {
          hostKey: 'single-ecs-1',
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
    writeTextMock.mockResolvedValue(undefined);

    render(<SingleInstancesScreen apiBaseUrl="http://localhost:3001" />);

    const table = await screen.findByRole('table', { name: '实例列表' });
    const credentialCell = within(table).getByRole('cell', { name: 'root / ******' });
    const credentialValue = within(credentialCell).getByText('root / ******');
    expect(credentialValue.className).toContain('truncate');
    expect(screen.queryByText('root / super-secret-password')).toBeNull();

    const tableCopyButton = within(credentialCell).getByRole('button', { name: '复制密码' });
    expect(tableCopyButton.getAttribute('title')).toBe('复制密码');
    fireEvent.click(tableCopyButton);

    await waitFor(() => {
      expect(tableCopyButton.className).toContain('bg-primary');
      expect(tableCopyButton.getAttribute('title')).toBe('已复制密码');
    });

    const row = (await screen.findByText('running-lab')).closest('tr');
    expect(row).toBeTruthy();
    expect(within(row!).getByText('root / ******')).toBeTruthy();
    expect(within(row!).queryByText('root / super-secret-password')).toBeNull();

    fireEvent.click(within(row!).getByRole('button', { name: '复制密码' }));

    await waitFor(() => expect(writeTextMock).toHaveBeenCalledWith('super-secret-password'));
    await waitFor(() =>
      expect(within(row!).getByRole('button', { name: '复制密码' }).getAttribute('title')).toBe('已复制密码'),
    );
  });


  it('renders Administrator for windows credentials even when legacy runtime username is root', async () => {
    fetchSingleInstancesMock.mockResolvedValue([
      {
        id: 'windows-running',
        name: 'windows-lab',
        createdBy: 'admin',
        instanceMode: 'single',
        status: 'running',
        createdAt: '2026-07-08T09:00:00.000Z',
        accessEntry: { publicIp: '47.1.2.3' },
        runtimeCredentials: {
          'single-ecs-1': {
            username: 'root',
            password: 'super-secret-password',
          },
        },
        singleInstanceConfig: {
          hostKey: 'single-ecs-1',
          imageDisplayName: 'Windows Server 2022',
          cpu: 2,
          memory: 4,
        },
      },
    ]);
    fetchProvisionJobsMock.mockResolvedValue([]);
    fetchPlatformImagesMock.mockResolvedValue({
      items: [{ id: 'platform-image-1', imageId: 'm-123', displayName: 'Windows Server 2022', enabled: true }],
    });

    render(<SingleInstancesScreen apiBaseUrl="http://localhost:3001" />);

    const row = (await screen.findByText('windows-lab')).closest('tr');
    expect(row).toBeTruthy();
    expect(within(row!).getByText('Administrator / ******')).toBeTruthy();
    expect(within(row!).queryByText('root / ******')).toBeNull();
    expect(within(row!).queryByText('Administrator / super-secret-password')).toBeNull();
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

  it('opens the create dialog with a preselected platform image from the query string', async () => {
    searchParamsState.value = 'create=1&platformImageAssetId=platform-image-2';
    fetchSingleInstancesMock.mockResolvedValue([]);
    fetchProvisionJobsMock.mockResolvedValue([]);
    fetchPlatformImagesMock.mockResolvedValue({
      items: [
        { id: 'platform-image-1', imageId: 'm-123', displayName: 'Ubuntu 24.04 LTS', enabled: true },
        {
          id: 'platform-image-2',
          imageId: 'm-456',
          displayName: 'Debian 12',
          enabled: true,
          defaultHostName: 'packed-default-host',
        },
      ],
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

    render(<SingleInstancesScreen apiBaseUrl="http://localhost:3001" />);

    expect(await screen.findByRole('dialog', { name: '创建实例' })).toBeTruthy();
    expect((screen.getByLabelText('镜像') as HTMLInputElement).value).toBe('Debian 12 (m-456)');
    expect((screen.getByLabelText('主机名') as HTMLInputElement).value).toBe('packed-default-host');
  });

  it('does not show the no-platform-image warning before platform images finish loading', async () => {
    let resolveImages!: (value: { items: Array<{ id: string; imageId: string; displayName: string; enabled: boolean }> }) => void;

    fetchSingleInstancesMock.mockResolvedValue([]);
    fetchProvisionJobsMock.mockResolvedValue([]);
    fetchPlatformImagesMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveImages = resolve;
        }),
    );

    render(<SingleInstancesScreen apiBaseUrl="http://localhost:3001" />);

    expect(await screen.findByRole('heading', { name: '实例管理' })).toBeTruthy();
    expect(screen.queryByText('请先前往镜像中心收录或启用至少一个平台镜像。')).toBeNull();

    resolveImages({
      items: [],
    });

    expect(await screen.findByText('请先前往镜像中心收录或启用至少一个平台镜像。')).toBeTruthy();
  });

  it('does not flash 暂无实例 before the first instance payload resolves', async () => {
    let resolveInstances!: (value: []) => void;

    fetchSingleInstancesMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveInstances = resolve;
        }),
    );
    fetchProvisionJobsMock.mockResolvedValue([]);
    fetchPlatformImagesMock.mockResolvedValue({
      items: [{ id: 'platform-image-1', imageId: 'm-123', displayName: 'Ubuntu 24.04 LTS', enabled: true }],
    });

    render(<SingleInstancesScreen apiBaseUrl="http://localhost:3001" />);

    expect(await screen.findByRole('heading', { name: '实例管理' })).toBeTruthy();
    expect(screen.getByRole('status', { name: '正在加载实例列表' })).toBeTruthy();
    expect(screen.getAllByTestId('table-loading-row')).toHaveLength(5);
    expect(screen.queryByText('暂无实例')).toBeNull();

    resolveInstances([]);

    expect(await screen.findByText('暂无实例')).toBeTruthy();
    expect(screen.queryByRole('status', { name: '正在加载实例列表' })).toBeNull();
  });
});
