import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminScreenCacheProvider, useAdminScreenCache } from '../../lib/admin-screen-cache';

const singleSessionState = vi.hoisted(() => ({ profile: { id: 'fixture-user', username: 'fixture', role: 'user' as 'user' | 'admin' } }));

const {
  fetchSingleInstancesMock,
  fetchProvisionJobsMock,
  fetchPlatformImagesMock,
  fetchInstanceTypeAvailabilityMock,
  launchSingleInstancesMock,
  destroySingleInstanceBatchMock,
  triggerSingleInstanceActionMock,
} = vi.hoisted(() => ({
  fetchSingleInstancesMock: vi.fn(),
  fetchProvisionJobsMock: vi.fn(),
  fetchPlatformImagesMock: vi.fn(),
  fetchInstanceTypeAvailabilityMock: vi.fn(),
  launchSingleInstancesMock: vi.fn(),
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

const workspaceState = vi.hoisted(() => ({ value: null as null | { workspace: { provider: string; isReadOnly: boolean; capabilities: { provisioning: boolean } } } }));
vi.mock('./cloud-workspace-provider', () => ({ useCloudWorkspace: () => workspaceState.value, cloudProviderLabel: (provider: string) => provider === 'tencent_cloud' ? '腾讯云' : '阿里云' }));

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
    profile: singleSessionState.profile,
    isAdmin: singleSessionState.profile.role === 'admin',
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
  destroySingleInstanceBatch: destroySingleInstanceBatchMock,
  triggerSingleInstanceAction: triggerSingleInstanceActionMock,
}));

import { AdminApiError } from '../../lib/admin-api';
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

async function openCreateDialog() {
  const button = await waitFor(() => {
    const button = screen.getByRole('button', { name: '创建实例' });
    expect(button.hasAttribute('disabled')).toBe(false);
    return button;
  });
  fireEvent.click(button);
  return screen.findByRole('dialog', { name: '创建实例' });
}

describe('SingleInstancesScreen', () => {
  it('opens the create dialog only after delayed images enable the button', async () => {
    fetchSingleInstancesMock.mockResolvedValue([]);
    fetchProvisionJobsMock.mockResolvedValue([]);
    fetchInstanceTypeAvailabilityMock.mockResolvedValue({ cpu: 2, memory: 2, exactAvailable: true,
      matches: [{ instanceTypeId: 'ecs.c6.large', cpu: 2, memoryGiB: 2, architecture: 'x86' }] });
    let resolveImages!: (value: unknown) => void;
    fetchPlatformImagesMock.mockReturnValue(new Promise(resolve => { resolveImages = resolve; }));
    render(<SingleInstancesScreen />);

    const opening = openCreateDialog();
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByRole('button', { name: '创建实例' }).hasAttribute('disabled')).toBe(true);
    expect(screen.queryByRole('dialog', { name: '创建实例' })).toBeNull();

    await act(async () => {
      resolveImages({ items: [{ id: 'platform-image-1', imageId: 'm-123', displayName: 'Ubuntu', enabled: true }] });
    });
    await opening;
    expect(screen.getByLabelText('实例名')).toBeTruthy();
    expect(launchSingleInstancesMock).not.toHaveBeenCalled();
  });

  it('keeps a successful launch accepted when the following list refresh fails', async () => {
    fetchSingleInstancesMock.mockResolvedValue([]);
    fetchProvisionJobsMock.mockResolvedValue([]);
    fetchPlatformImagesMock.mockResolvedValue({ items: [{ id: 'platform-image-1', imageId: 'm-123', displayName: 'Ubuntu', enabled: true }] });
    fetchInstanceTypeAvailabilityMock.mockResolvedValue({ cpu: 2, memory: 2, exactAvailable: true,
      regionId: 'cn-hangzhou', zoneId: 'cn-hangzhou-h', warning: null,
      matches: [{ instanceTypeId: 'ecs.c6.large', cpu: 2, memoryGiB: 2, architecture: 'x86' }] });
    launchSingleInstancesMock.mockImplementation(async () => {
      fetchSingleInstancesMock.mockRejectedValue(new Error('503 read failure'));
      return { batch: { id: 'accepted-batch' }, instances: [] };
    });
    render(<SingleInstancesScreen apiBaseUrl="http://localhost:3001" />);
    await openCreateDialog();
    fireEvent.change(screen.getByLabelText('实例名'), { target: { value: 'accepted-once' } });
    fireEvent.change(screen.getByLabelText('镜像'), { target: { value: 'Ubuntu (m-123)' } });
    fireEvent.change(screen.getByLabelText('到期时间'), { target: { value: '2100-01-01T12:00' } });
    await waitFor(() => expect(fetchInstanceTypeAvailabilityMock).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: '确认创建' }));
    expect(await screen.findByText('创建任务已受理，实例列表刷新失败。请刷新列表，不要重复创建。')).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: '创建实例' })).toBeNull();
    expect(screen.queryByText('创建实例失败，请稍后重试。')).toBeNull();
    expect(launchSingleInstancesMock).toHaveBeenCalledTimes(1);
  });

  it('keeps batch parameters and the idempotency key when retrying a lost launch response', async () => {
    fetchSingleInstancesMock.mockResolvedValue([]);
    fetchProvisionJobsMock.mockResolvedValue([]);
    fetchPlatformImagesMock.mockResolvedValue({ items: [{ id: 'platform-image-1', imageId: 'm-123', displayName: 'Ubuntu', enabled: true }] });
    fetchInstanceTypeAvailabilityMock.mockResolvedValue({ cpu: 2, memory: 2, exactAvailable: true,
      regionId: 'cn-hangzhou', zoneId: 'cn-hangzhou-h', warning: null,
      matches: [{ instanceTypeId: 'ecs.c6.large', cpu: 2, memoryGiB: 2, architecture: 'x86' }] });
    launchSingleInstancesMock.mockRejectedValue(new TypeError('Network connection lost'));
    render(<SingleInstancesScreen apiBaseUrl="http://localhost:3001" />);
    await openCreateDialog();
    fireEvent.change(screen.getByLabelText('实例名'), { target: { value: 'batch-once' } });
    fireEvent.change(screen.getByLabelText('镜像'), { target: { value: 'Ubuntu (m-123)' } });
    fireEvent.change(screen.getByLabelText('到期时间'), { target: { value: '2100-01-01T12:00' } });
    await waitFor(() => expect(fetchInstanceTypeAvailabilityMock).toHaveBeenCalled());
    const form = screen.getByRole('button', { name: '确认创建' }).closest('[role=dialog]')!.querySelector('form')!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    await screen.findByText(/创建结果尚未确认/);
    expect(launchSingleInstancesMock).toHaveBeenCalledTimes(1);
    const firstRequest = launchSingleInstancesMock.mock.calls[0];
    expect(firstRequest[3]).toMatch(/^[0-9a-f-]{36}$/);
    fireEvent.click(screen.getByRole('button', { name: '查询原请求' }));
    await waitFor(() => expect(launchSingleInstancesMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole('button', { name: '查询原请求' }).hasAttribute('disabled')).toBe(false));
    expect(launchSingleInstancesMock.mock.calls[1]).toEqual(firstRequest);
    fireEvent.change(screen.getByLabelText('实例名'), { target: { value: 'another-intended-batch' } });
    fireEvent.click(screen.getByRole('button', { name: '确认创建' }));
    await waitFor(() => expect(launchSingleInstancesMock).toHaveBeenCalledTimes(3));
    expect(launchSingleInstancesMock.mock.calls[2][3]).not.toEqual(firstRequest[3]);
  });

  beforeEach(() => {
    singleSessionState.profile = { id: 'fixture-user', username: 'fixture', role: 'user' };
    workspaceState.value = null;
    fetchSingleInstancesMock.mockReset();
    fetchProvisionJobsMock.mockReset();
    fetchPlatformImagesMock.mockReset();
    fetchInstanceTypeAvailabilityMock.mockReset();
    launchSingleInstancesMock.mockReset();
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

  it('keeps launches disabled for an unready account even when that workspace has a usable image', async () => {
    workspaceState.value = { workspace: { provider: 'tencent_cloud', isReadOnly: false, capabilities: { provisioning: false } } };
    fetchSingleInstancesMock.mockResolvedValue([]); fetchProvisionJobsMock.mockResolvedValue([]);
    fetchPlatformImagesMock.mockResolvedValue({ items: [{ id: 'workspace-image', imageId: 'img-fixture', displayName: '可用腾讯镜像', enabled: true, sourceSnapshotAvailable: true }] });
    render(<SingleInstancesScreen />);
    await waitFor(() => expect(fetchPlatformImagesMock).toHaveBeenCalled());
    expect(screen.getByText('当前腾讯云账号未就绪，请先检查基础配置。')).toBeTruthy();
    expect((screen.getByRole('button', { name: '创建实例' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '创建实例' }));
    expect(launchSingleInstancesMock).not.toHaveBeenCalled();
  });

  it('uses Tencent image minimum disk and ten-minute expiry while retaining the existing launch flow', async () => {
    workspaceState.value = { workspace: { provider: 'tencent_cloud', isReadOnly: false, capabilities: { provisioning: true } } };
    fetchSingleInstancesMock.mockResolvedValue({ batches: [], standaloneInstances: [] });
    fetchProvisionJobsMock.mockResolvedValue([]);
    fetchPlatformImagesMock.mockResolvedValue({ items: [{ id: 'tencent-image', provider: 'tencent_cloud', accountScopeKey: '100001', regionId: 'ap-shanghai', sourceScope: 'public',
      imageId: 'img-tencent', displayName: 'Tencent Linux', enabled: true, tags: [], architecture: 'x86_64', minimumSystemDiskSize: 80 }] });
    fetchInstanceTypeAvailabilityMock.mockResolvedValue({ cpu: 2, memory: 2, regionId: 'ap-shanghai', zoneId: 'ap-shanghai-1', exactAvailable: true, matches: [{ instanceTypeId: 'S5.MEDIUM2', cpu: 2, memoryGiB: 2, family: 'S5', generation: 'S5', architecture: 'x86_64' }], warning: null });
    launchSingleInstancesMock.mockResolvedValue({ batch: { id: 'new-batch' }, instances: [] });
    render(<SingleInstancesScreen />);
    await openCreateDialog();
    expect((await screen.findByLabelText('磁盘大小') as HTMLInputElement).value).toBe('80');
    expect((screen.getByLabelText('磁盘大小') as HTMLInputElement).min).toBe('80');
    fireEvent.change(screen.getByLabelText('实例名'), { target: { value: 'Tencent instance' } });
    const soon = new Date(Date.now() + 5 * 60_000);
    const localText = (date: Date) => new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
    fireEvent.change(screen.getByLabelText('到期时间'), { target: { value: localText(soon) } });
    await waitFor(() => expect(fetchInstanceTypeAvailabilityMock).toHaveBeenCalled());
    fireEvent.submit(document.getElementById('single-instance-create-form')!);
    expect(await screen.findByText('腾讯云实例到期时间至少需要在 10 分钟后。')).toBeTruthy();
    expect(launchSingleInstancesMock).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('到期时间'), { target: { value: localText(new Date(Date.now() + 60 * 60_000)) } });
    fireEvent.submit(document.getElementById('single-instance-create-form')!);
    await waitFor(() => expect(launchSingleInstancesMock).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ platformImageAssetId: 'tencent-image', systemDiskSize: 80 }), expect.any(String)));
  });

  it.each([
    ['linux', 'abcdefgh', 'abcd1234'],
    ['windows', 'Abcd1234', 'Abcd12345678'],
  ])('validates Tencent %s passwords before launch without imposing Aliyun policy', async (osType, invalidPassword, validPassword) => {
    workspaceState.value = { workspace: { provider: 'tencent_cloud', isReadOnly: false, capabilities: { provisioning: true } } };
    fetchSingleInstancesMock.mockResolvedValue([]); fetchProvisionJobsMock.mockResolvedValue([]);
    fetchPlatformImagesMock.mockResolvedValue({ items: [{ id: 'tencent-image', provider: 'tencent_cloud', imageId: 'img-tencent', displayName: 'Tencent image', enabled: true, tags: [], osType, architecture: 'x86_64', minimumSystemDiskSize: 80 }] });
    fetchInstanceTypeAvailabilityMock.mockResolvedValue({ cpu: 2, memory: 2, exactAvailable: true, matches: [{ instanceTypeId: 'S5.MEDIUM2', cpu: 2, memoryGiB: 2, architecture: 'x86_64' }] });
    launchSingleInstancesMock.mockResolvedValue({ batch: { id: 'password-batch' }, instances: [] });
    render(<SingleInstancesScreen />);
    await openCreateDialog();
    fireEvent.change(screen.getByLabelText('实例名'), { target: { value: 'Tencent password test' } });
    fireEvent.change(screen.getByLabelText('到期时间'), { target: { value: '2100-01-01T12:00' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: invalidPassword } });
    await waitFor(() => expect(fetchInstanceTypeAvailabilityMock).toHaveBeenCalled());
    fireEvent.submit(document.getElementById('single-instance-create-form')!);
    expect(await screen.findByText(/密码不符合腾讯云 CVM 要求/)).toBeTruthy();
    expect(launchSingleInstancesMock).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: validPassword } });
    fireEvent.submit(document.getElementById('single-instance-create-form')!);
    await waitFor(() => expect(launchSingleInstancesMock).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ password: validPassword }), expect.any(String)));
  });

  it('queries the original Tencent batch after two minutes without renewing its expiration or key', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(new Date('2026-10-11T08:00:00Z').getTime());
    try {
      workspaceState.value = { workspace: { provider: 'tencent_cloud', isReadOnly: false, capabilities: { provisioning: true } } };
      fetchSingleInstancesMock.mockResolvedValue([]); fetchProvisionJobsMock.mockResolvedValue([]);
      fetchPlatformImagesMock.mockResolvedValue({ items: [{ id: 'tencent-image', provider: 'tencent_cloud', imageId: 'img-tencent', displayName: 'Tencent Linux', enabled: true, tags: [], architecture: 'x86_64', minimumSystemDiskSize: 80 }] });
      fetchInstanceTypeAvailabilityMock.mockResolvedValue({ cpu: 2, memory: 2, exactAvailable: true, matches: [{ instanceTypeId: 'S5.MEDIUM2', cpu: 2, memoryGiB: 2, architecture: 'x86_64' }] });
      launchSingleInstancesMock.mockRejectedValueOnce(new TypeError('Response lost')).mockResolvedValue({ batch: { id: 'original-batch' }, instances: [] });
      render(<SingleInstancesScreen />);
      await openCreateDialog();
      fireEvent.change(screen.getByLabelText('实例名'), { target: { value: 'original-intent' } });
      fireEvent.change(screen.getByLabelText('到期时间'), { target: { value: '2026-10-11T08:11' } });
      await waitFor(() => expect(fetchInstanceTypeAvailabilityMock).toHaveBeenCalled());
      expect((screen.getByRole('button', { name: '确认创建' }) as HTMLButtonElement).formNoValidate).toBe(false);
      fireEvent.click(screen.getByRole('button', { name: '确认创建' }));
      await screen.findByText(/创建结果尚未确认/);
      const original = launchSingleInstancesMock.mock.calls[0];
      now.mockReturnValue(new Date('2026-10-11T08:02:00Z').getTime());
      fireEvent.change(screen.getByLabelText('实例名'), { target: { value: 'different-intent' } });
      fireEvent.click(screen.getByRole('button', { name: '确认创建' }));
      await screen.findByText('腾讯云实例到期时间至少需要在 10 分钟后。');
      expect(launchSingleInstancesMock).toHaveBeenCalledTimes(1);
      fireEvent.change(screen.getByLabelText('实例名'), { target: { value: 'original-intent' } });
      const retry = screen.getByRole('button', { name: '查询原请求' }) as HTMLButtonElement;
      expect(retry.formNoValidate).toBe(true);
      fireEvent.click(retry);
      await waitFor(() => expect(screen.queryByRole('dialog', { name: '创建实例' })).toBeNull());
      expect(launchSingleInstancesMock.mock.calls[1]).toEqual(original);
    } finally { now.mockRestore(); }
  });

  it.each(['success', 'unauthorized'])('ignores a late batch launch %s after the workspace page unmounts', async outcome => {
    fetchSingleInstancesMock.mockResolvedValue([]); fetchProvisionJobsMock.mockResolvedValue([]);
    fetchPlatformImagesMock.mockResolvedValue({ items: [{ id: 'platform-image-1', imageId: 'm-123', displayName: 'Ubuntu', enabled: true }] });
    fetchInstanceTypeAvailabilityMock.mockResolvedValue({ cpu: 2, memory: 2, exactAvailable: true, matches: [{ instanceTypeId: 'ecs.c6.large', cpu: 2, memoryGiB: 2, architecture: 'x86' }] });
    let resolve!: (value: unknown) => void; let reject!: (error: unknown) => void;
    launchSingleInstancesMock.mockReturnValue(new Promise((done, fail) => { resolve = done; reject = fail; }));
    const mounted = render(<SingleInstancesScreen />);
    await openCreateDialog();
    fireEvent.change(screen.getByLabelText('实例名'), { target: { value: 'original-intent' } });
    fireEvent.change(screen.getByLabelText('到期时间'), { target: { value: '2100-01-01T12:00' } });
    await waitFor(() => expect(fetchInstanceTypeAvailabilityMock).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: '确认创建' }));
    await waitFor(() => expect(launchSingleInstancesMock).toHaveBeenCalledTimes(1));
    const reads = fetchSingleInstancesMock.mock.calls.length;
    mounted.unmount();
    await act(async () => { if (outcome === 'success') resolve({ batch: { id: 'old-batch' }, instances: [] }); else reject(new AdminApiError(401)); });
    expect(fetchSingleInstancesMock).toHaveBeenCalledTimes(reads);
    expect(replaceMock).not.toHaveBeenCalled();
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
    expect(await screen.findByText('root / ******')).toBeTruthy();

    await openCreateDialog();
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
        expect.any(String),
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
    fireEvent.keyDown(screen.getByRole('button', { name: '更多操作' }), { key: 'Enter' });
    expect(screen.getByRole('menuitem', { name: '重启实例' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: '打包为镜像' })).toBeNull();
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
    fireEvent.keyDown(screen.getByRole('button', { name: '更多操作' }), { key: 'Enter' });
    expect(screen.getByRole('menuitem', { name: '打包为镜像' })).toBeTruthy();
  });

  it.each([
    { quantity: 2, ips: [' 47.20.30.40 ', '47.20.30.41'], expectedIp: '47.20.30.40' },
    { quantity: 1, ips: ['47.20.30.42'], expectedIp: '47.20.30.42' },
    { quantity: 2, ips: ['', '47.20.30.43'], expectedIp: '暂无' },
  ])('shows only quantity and the first member IP for a history batch ($quantity, $expectedIp)', async ({ quantity, ips, expectedIp }) => {
    searchParamsState.value = 'view=history';
    fetchSingleInstancesMock.mockResolvedValue({
      batches: [{
        batch: {
          id: 'summary-batch', name: 'history-batch-summary', imageDisplayName: 'Ubuntu 24.04 LTS',
          imageId: 'm-summary', platformImageAssetId: 'summary-asset', cpu: 2, memory: 4,
          systemDiskSize: 40, quantity, createdBy: 'admin',
          createdAt: '2026-07-08T09:00:00.000Z', expiresAt: '2026-07-10T12:00:00.000Z',
        },
        instances: ips.map((ip, index) => ({
          id: `summary-member-${index + 1}`, name: `summary-member-${index + 1}`,
          createdBy: 'admin', instanceMode: 'single', status: 'destroyed',
          accessEntry: ip ? { publicIp: ip } : null,
          singleInstanceConfig: { hostKey: 'summary-host', imageDisplayName: 'Ubuntu 24.04 LTS', cpu: 2, memory: 4 },
        })),
      }],
      standaloneInstances: [],
    });
    fetchProvisionJobsMock.mockResolvedValue([]);
    fetchPlatformImagesMock.mockResolvedValue({ items: [] });
    render(<SingleInstancesScreen apiBaseUrl="http://localhost:3001" />);

    const batchRow = (await screen.findByText('history-batch-summary')).closest('tr')!;
    const cells = within(batchRow).getAllByRole('cell');
    expect(cells[2].textContent).toBe(`${quantity} 台`);
    expect(cells[3].textContent).toBe(expectedIp);
    expect(cells[4].textContent).toContain(`${quantity} 已关闭`);
    expect(within(batchRow).queryByText('批次实例')).toBeNull();

    fireEvent.click(within(batchRow).getByRole('button', { name: '展开批次 history-batch-summary' }));
    const firstMemberRow = (await screen.findByText('summary-member-1')).closest('tr')!;
    expect(within(firstMemberRow).getByText('2 核 / 4 G')).toBeTruthy();
    expect(within(firstMemberRow).getAllByRole('cell')[3].textContent).toBe(expectedIp);
    expect(cells[2].textContent).toBe(`${quantity} 台`);
  });

  it('portals batch child actions outside the clipped table', async () => {
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
    fireEvent.keyDown(moreActionsButton, { key: 'Enter' });
    const menu = await screen.findByRole('menu');
    expect(menu.closest('table')).toBeNull();
    expect(menu.closest('[data-slot="admin-data-table-frame"]')).toBeNull();
    expect(within(menu).getByRole('menuitem', { name: '重启实例' })).toBeTruthy();
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

    await openCreateDialog();
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
        id: 'job-create-failed',
        rangeInstanceId: 'single-create-failed',
        jobType: 'create',
        status: 'failed',
        triggeredBy: 'admin',
        startedAt: '2026-07-08T10:05:00.000Z',
        finishedAt: '2026-07-08T10:06:00.000Z',
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
    fireEvent.keyDown(screen.getAllByRole('button', { name: '更多操作' })[0], { key: 'Enter' });
    expect(
      screen.getAllByRole('menuitem').map((item) => item.textContent),
    ).toEqual(['重启实例', '打包为镜像']);
    expect(screen.getByRole('menuitem', { name: '重启实例' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: '重试创建' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: '重试关闭' })).toBeNull();
    expect(screen.queryByText('failed-lab')).toBeNull();

    const destroyFailedRow = screen.getByText('destroy-failed-lab').closest('tr');
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    fireEvent.keyDown(within(destroyFailedRow!).getByRole('button', { name: '更多操作' }), { key: 'Enter' });
    expect(screen.getByRole('menuitem', { name: '重试关闭' })).toBeTruthy();
    expect(within(destroyFailedRow!).queryByRole('button', { name: '关闭实例' })).toBeNull();
    expect(within(destroyFailedRow!).queryByRole('button', { name: '删除记录' })).toBeNull();

    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    fireEvent.mouseDown(screen.getByRole('tab', { name: '实例历史' }), { button: 0 });

    expect(await screen.findByText('history-lab')).toBeTruthy();
    expect(screen.getByText('failed-lab')).toBeTruthy();
    expect(screen.getByText('创建失败')).toBeTruthy();
    expect(screen.getByText('创建人')).toBeTruthy();
    expect(screen.getAllByText('admin').length).toBeGreaterThan(0);
    expect(screen.queryByText('操作')).toBeNull();
    expect(screen.getByText(formatExpectedDateTime('2026-07-08T08:15:00.000Z'))).toBeTruthy();
    expect(screen.getByText(formatExpectedDateTime('2026-07-08T10:50:00.000Z'))).toBeTruthy();
    expect(screen.getByText(formatExpectedDateTime('2026-07-08T10:06:00.000Z'))).toBeTruthy();
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

    await openCreateDialog();
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
    fireEvent.keyDown(await screen.findByRole('button', { name: '更多操作' }), { key: 'Enter' });
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: '关闭实例' }));
    expect(triggerSingleInstanceActionMock).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: '确认关闭' }));

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
    expect(destroySingleInstanceBatchMock).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: '确认全部关闭' }));

    await waitFor(() => {
      expect(destroySingleInstanceBatchMock).toHaveBeenCalledWith(
        'http://localhost:3001',
        'dev-admin-token',
        'batch-1',
      );
    });
  });

  it('does not start a destroy when the confirmation dialog is dismissed', async () => {
    fetchSingleInstancesMock.mockResolvedValue({
      batches: [
        {
          batch: {
            id: 'batch-1',
            name: 'confirm-lab',
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
              name: 'confirm-lab-01',
              createdBy: 'admin',
              instanceMode: 'single',
              status: 'running',
              singleInstanceConfig: { imageDisplayName: 'Ubuntu 24.04 LTS', cpu: 2, memory: 2 },
            },
          ],
        },
      ],
      standaloneInstances: [],
    });
    fetchProvisionJobsMock.mockResolvedValue([]);
    fetchPlatformImagesMock.mockResolvedValue({ items: [] });

    render(<SingleInstancesScreen apiBaseUrl="http://localhost:3001" />);

    expect(await screen.findByText('confirm-lab')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '展开批次 confirm-lab' }));
    fireEvent.click(screen.getAllByRole('button', { name: '关闭实例' })[0]);
    expect(triggerSingleInstanceActionMock).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: '取消' }));
    expect(screen.queryByRole('button', { name: '确认关闭' })).toBeNull();
    expect(triggerSingleInstanceActionMock).not.toHaveBeenCalled();
  });

  it('blocks weak passwords before submitting the launch request', async () => {
    fetchSingleInstancesMock.mockResolvedValue([]);
    fetchProvisionJobsMock.mockResolvedValue([]);
    fetchPlatformImagesMock.mockResolvedValue({ items: [{ id: 'platform-image-1', imageId: 'm-123', displayName: 'Ubuntu', enabled: true }] });
    fetchInstanceTypeAvailabilityMock.mockResolvedValue({ cpu: 2, memory: 2, exactAvailable: true,
      regionId: 'cn-hangzhou', zoneId: 'cn-hangzhou-h', warning: null,
      matches: [{ instanceTypeId: 'ecs.c6.large', cpu: 2, memoryGiB: 2, architecture: 'x86' }] });

    render(<SingleInstancesScreen apiBaseUrl="http://localhost:3001" />);
    await openCreateDialog();
    fireEvent.change(screen.getByLabelText('实例名'), { target: { value: 'weak-password-lab' } });
    fireEvent.change(screen.getByLabelText('镜像'), { target: { value: 'Ubuntu (m-123)' } });
    fireEvent.change(screen.getByLabelText('到期时间'), { target: { value: '2100-01-01T12:00' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'abcdefgh' } });
    await waitFor(() => expect(fetchInstanceTypeAvailabilityMock).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: '确认创建' }));

    expect(await screen.findByText(/密码不符合阿里云 ECS 要求/)).toBeTruthy();
    expect(launchSingleInstancesMock).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: '创建实例' })).toBeTruthy();
  });

  it('neutralizes spreadsheet formulas in exported batch credentials', async () => {
    const anchorClickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    fetchSingleInstancesMock.mockResolvedValue({
      batches: [
        {
          batch: {
            id: 'batch-1',
            name: '=cmd|render',
            imageDisplayName: 'Ubuntu 24.04 LTS',
            imageId: 'm-1',
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
              name: '+SUM(1)',
              createdBy: 'admin',
              instanceMode: 'single',
              status: 'running',
              accessEntry: { publicIp: '47.1.2.3' },
              runtimeCredentials: { 'single-ecs-1': { username: 'root', password: '=1+SUM(1)' } },
              singleInstanceConfig: { hostKey: 'single-ecs-1', imageDisplayName: 'Ubuntu 24.04 LTS', cpu: 2, memory: 2 },
            },
          ],
        },
      ],
      standaloneInstances: [],
    });
    fetchProvisionJobsMock.mockResolvedValue([]);
    fetchPlatformImagesMock.mockResolvedValue({ items: [] });

    render(<SingleInstancesScreen apiBaseUrl="http://localhost:3001" />);

    expect(await screen.findByText('=cmd|render')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '导出' }));

    await waitFor(() => expect(createObjectUrlMock).toHaveBeenCalledTimes(1));

    const blob = createObjectUrlMock.mock.calls[0]?.[0] as Blob;
    const text = new TextDecoder().decode(await readBlobAsBytes(blob));
    expect(text).toContain("'+SUM(1)");
    expect(text).toContain("'=1+SUM(1)");
    expect(text).not.toContain('\n+SUM(1),');

    anchorClickSpy.mockRestore();
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

  it.each([false, true])('keeps an accepted pack-image action when the following refresh fails: %s', async refreshFails => {
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
    fireEvent.keyDown(screen.getByRole('button', { name: '更多操作' }), { key: 'Enter' });
    fireEvent.click(screen.getByRole('menuitem', { name: '打包为镜像' }));

    const dialog = screen.getByRole('dialog', { name: '打包为镜像' });
    expect((within(dialog).getByLabelText('镜像名') as HTMLInputElement).value).toBe('running-lab-snapshot');
    expect((within(dialog).getByLabelText('默认主机名') as HTMLInputElement).value).toBe('running-host');

    fireEvent.change(within(dialog).getByLabelText('镜像名'), { target: { value: 'custom-pack-image' } });
    fireEvent.change(within(dialog).getByLabelText('默认主机名'), { target: { value: 'custom-host' } });
    fireEvent.change(within(dialog).getByLabelText('默认密码'), { target: { value: 'Secret123!' } });
    fireEvent.change(within(dialog).getByLabelText('镜像备注'), { target: { value: 'snapshot note' } });
    if (refreshFails) fetchSingleInstancesMock.mockRejectedValue(new Error('read failed after accepted pack'));
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
    await screen.findByText('镜像打包任务已提交，镜像可用后会出现在我的镜像：custom-pack-image');
    if (refreshFails) await screen.findByText('镜像打包任务已受理，实例列表刷新失败。请刷新列表，不要重复打包。');
    expect(screen.queryByText('镜像打包失败，请稍后重试。')).toBeNull();
    expect(screen.queryByRole('dialog', { name: '打包为镜像' })).toBeNull();
    expect(triggerSingleInstanceActionMock).toHaveBeenCalledTimes(1);
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
    fireEvent.click(screen.getByRole('button', { name: '关闭实例' }));
    const confirmButton = (await screen.findByRole('button', { name: '确认关闭' })) as HTMLButtonElement;
    fireEvent.click(confirmButton);
    fireEvent.click(confirmButton);

    expect(triggerSingleInstanceActionMock).toHaveBeenCalledTimes(1);
    await waitFor(() => expect((screen.getByRole('button', { name: '确认关闭' }) as HTMLButtonElement).disabled).toBe(true));
    expect((screen.getByRole('button', { name: '取消' }) as HTMLButtonElement).disabled).toBe(true);

    resolveAction?.({ jobId: 'job-destroy-reloaded' });
    await waitFor(() => expect(screen.queryByRole('button', { name: '确认关闭' })).toBeNull());
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
      (_url, _token, view) => view === 'mine' ? Promise.resolve({ items: [] }) :
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


describe('single instance user-flow regressions', () => {
  beforeEach(() => {
    singleSessionState.profile = { id: 'fixture-user', username: 'fixture', role: 'user' };
    fetchSingleInstancesMock.mockReset();
    fetchPlatformImagesMock.mockReset();
    fetchInstanceTypeAvailabilityMock.mockReset();
    triggerSingleInstanceActionMock.mockReset();
    fetchProvisionJobsMock.mockResolvedValue([]);
    searchParamsState.value = '';
    vi.stubGlobal('ResizeObserver', ResizeObserverMock);
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it('audit-ui: an old pack failure cannot navigate a new login to the login page', async () => {
    fetchSingleInstancesMock.mockResolvedValue([{ id: 'single-running', name: 'running-lab', instanceMode: 'single', status: 'running',
      createdAt: '2026-07-08T09:00:00Z', singleInstanceConfig: { hostName: 'fixture', imageDisplayName: 'Ubuntu', cpu: 2, memory: 2 } }]);
    fetchPlatformImagesMock.mockResolvedValue({ items: [] });
    let rejectPack!: (error: Error) => void;
    triggerSingleInstanceActionMock.mockReturnValue(new Promise((_resolve, reject) => { rejectPack = reject; }));
    const view = render(<SingleInstancesScreen />);
    await screen.findByText('running-lab');
    fireEvent.keyDown(screen.getByRole('button', { name: '更多操作' }), { key: 'Enter' });
    fireEvent.click(screen.getByRole('menuitem', { name: '打包为镜像' }));
    fireEvent.click(screen.getByRole('button', { name: '确认打包' }));
    await waitFor(() => expect(triggerSingleInstanceActionMock).toHaveBeenCalledTimes(1));
    replaceMock.mockClear();
    singleSessionState.profile = { id: 'another-user', username: 'another', role: 'user' };
    view.rerender(<SingleInstancesScreen />);
    await act(async () => rejectPack(new AdminApiError(401)));
    expect(replaceMock).not.toHaveBeenCalledWith('/admin/login');
    expect(screen.queryByText('镜像打包失败，请稍后重试。')).toBeNull();
  });

  it.each(['user', 'admin'] as const)('audit-ui: %s can preselect a private image with separate caches and deduplicated options', async role => {
    singleSessionState.profile.role = role;
    searchParamsState.value = 'create=1&platformImageAssetId=owned-image';
    const publicImage = { id: 'shared-image', imageId: 'm-shared', displayName: 'Shared', enabled: true, visibility: 'platform' };
    const privateImage = { id: 'owned-image', imageId: 'm-private', displayName: 'Owned private', enabled: true, visibility: 'private' };
    fetchSingleInstancesMock.mockResolvedValue([]);
    fetchPlatformImagesMock.mockImplementation(async (_url, _token, view) => ({ items: view === 'mine' ? [publicImage, privateImage] : [publicImage] }));
    fetchInstanceTypeAvailabilityMock.mockResolvedValue({ cpu: 2, memory: 2, exactAvailable: true, matches: [] });
    let cache: ReturnType<typeof useAdminScreenCache>;
    function Probe() { cache = useAdminScreenCache(); return null; }
    render(<AdminScreenCacheProvider><Probe /><SingleInstancesScreen /></AdminScreenCacheProvider>);
    await screen.findByRole('dialog', { name: '创建实例' });
    expect(screen.getByLabelText('镜像')).toHaveProperty('value', 'Owned private (m-private)');
    expect(fetchPlatformImagesMock).toHaveBeenCalledWith('http://localhost:3001', 'dev-admin-token', 'mine');
    expect(cache!.read<any>('http://localhost:3001', 'dev-admin-token', 'platform-images:platform')!.data.items).toEqual([publicImage]);
    expect(cache!.read<any>('http://localhost:3001', 'dev-admin-token', 'platform-images:mine')!.data.items).toEqual([publicImage, privateImage]);
    fireEvent.focus(screen.getByLabelText('镜像'));
    fireEvent.change(screen.getByLabelText('镜像'), { target: { value: '' } });
    await waitFor(() => expect(screen.getAllByRole('option', { name: /Shared/ })).toHaveLength(1));
    expect(screen.getAllByRole('option', { name: /Owned private/ })).toHaveLength(1);
  });

  it('audit-ui: packing invalidates an already fresh mine snapshot', async () => {
    fetchSingleInstancesMock.mockResolvedValue([{ id: 'single-running', name: 'running-lab', instanceMode: 'single', status: 'running',
      createdAt: '2026-07-08T09:00:00Z', singleInstanceConfig: { hostName: 'fixture', imageDisplayName: 'Ubuntu', cpu: 2, memory: 2 } }]);
    fetchPlatformImagesMock.mockResolvedValue({ items: [] });
    triggerSingleInstanceActionMock.mockResolvedValue({ status: 'accepted', action: 'pack-image', imageReady: false });
    let cache: ReturnType<typeof useAdminScreenCache>;
    function Probe() { cache = useAdminScreenCache(); return null; }
    render(<AdminScreenCacheProvider><Probe /><SingleInstancesScreen /></AdminScreenCacheProvider>);
    await screen.findByText('running-lab');
    await act(async () => { await cache!.load('http://localhost:3001', 'dev-admin-token', 'image-center:mine', async () => ({ assets: [], jobs: [] })); });
    expect(cache!.read('http://localhost:3001', 'dev-admin-token', 'image-center:mine')?.isFresh).toBe(true);
    fireEvent.keyDown(screen.getByRole('button', { name: '更多操作' }), { key: 'Enter' });
    fireEvent.click(screen.getByRole('menuitem', { name: '打包为镜像' }));
    fireEvent.click(screen.getByRole('button', { name: '确认打包' }));
    await waitFor(() => expect(triggerSingleInstanceActionMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(cache!.read('http://localhost:3001', 'dev-admin-token', 'image-center:mine')).toBeNull());
    expect(screen.queryByRole('dialog', { name: '打包为镜像' })).toBeNull();
  });
});
