import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  exportBillingUserItemsCsvMock,
  exportBillingUsersCsvMock,
  exportPlatformBillingCsvMock,
  fetchAdminUsersMock,
  fetchBillingSummaryMock,
  fetchBillingUserGroupsMock,
  fetchBillingUsersMock,
  fetchPlatformBillingGroupsMock,
  replaceMock,
  routerMock,
  triggerBillingSyncMock,
} = vi.hoisted(() => ({
  exportBillingUserItemsCsvMock: vi.fn(),
  exportBillingUsersCsvMock: vi.fn(),
  exportPlatformBillingCsvMock: vi.fn(),
  fetchAdminUsersMock: vi.fn(),
  fetchBillingSummaryMock: vi.fn(),
  fetchBillingUserGroupsMock: vi.fn(),
  fetchBillingUsersMock: vi.fn(),
  fetchPlatformBillingGroupsMock: vi.fn(),
  replaceMock: vi.fn(),
  routerMock: {} as { replace: typeof replaceMock },
  triggerBillingSyncMock: vi.fn(),
}));

routerMock.replace = replaceMock;

function toBillingPage<T>(payload: T[] | { items: T[]; page: number; pageSize: 20 | 50 | 100; total: number }) {
  return Array.isArray(payload) ? { items: payload, page: 1, pageSize: 20 as const, total: payload.length } : payload;
}

vi.mock('next/navigation', () => ({
  useRouter: () => routerMock,
}));

vi.mock('../../lib/admin-api', async () => {
  const actual = await vi.importActual<typeof import('../../lib/admin-api')>('../../lib/admin-api');

  return {
    ...actual,
    exportBillingUserItemsCsv: exportBillingUserItemsCsvMock,
    exportBillingUsersCsv: exportBillingUsersCsvMock,
    exportPlatformBillingCsv: exportPlatformBillingCsvMock,
    fetchAdminUsers: fetchAdminUsersMock,
    fetchBillingSummary: fetchBillingSummaryMock,
    fetchBillingUserGroups: async (...args: unknown[]) => toBillingPage(await fetchBillingUserGroupsMock(...args)),
    fetchBillingUsers: async (...args: unknown[]) => toBillingPage(await fetchBillingUsersMock(...args)),
    fetchPlatformBillingGroups: async (...args: unknown[]) => toBillingPage(await fetchPlatformBillingGroupsMock(...args)),
    triggerBillingSync: triggerBillingSyncMock,
  };
});

import { AdminApiError } from '../../lib/admin-api';
import { AdminScreenCacheProvider } from '../../lib/admin-screen-cache';
import * as adminSessionModule from './use-admin-session';
import { BillingScreen } from './billing-screen';

const adminSession = {
  token: 'dev-admin-token',
  profile: { id: 'admin', username: 'admin', role: 'admin' as const },
  isAdmin: true,
  isReady: true,
  login: vi.fn(),
  logout: vi.fn(),
};

const userGroups = [
  {
    id: 'job-range',
    kind: 'range_launch',
    title: '开启编排实例',
    completedAt: '2026-07-16T02:03:42.000Z',
    billingPeriodStart: '2026-07-16',
    billingPeriodEnd: '2026-07-16',
    ownerUserId: 'user-1',
    ownerUsername: 'alice',
    instance: { id: 'range-1', name: 'web-lab', batchId: null },
    resourceCount: 2,
    pretaxAmount: 8.4,
    currency: 'CNY',
    items: [
      {
        id: 'item-1',
        syncBatchId: 'sync-1',
        sourceFingerprint: 'item-1',
        billCycle: '2026-07',
        billingDate: '2026-07-16T00:00:00.000Z',
        productCode: 'ecs',
        productDetail: '云服务器ECS-按量付费',
        billItem: '云服务器配置',
        cloudResourceId: 'i-range',
        cloudResourceType: 'ecs',
        pretaxAmount: 8.4,
        currency: 'CNY',
        billingScope: 'user' as const,
        ownerUserId: 'user-1',
        matchedLedgerId: 'ledger-1',
      },
    ],
  },
];

const platformGroups = [
  {
    id: 'unmatched',
    kind: 'unmatched',
    title: '未关联平台启动的费用',
    completedAt: null,
    billingPeriodStart: '2026-07-16',
    billingPeriodEnd: '2026-07-16',
    ownerUserId: null,
    instance: null,
    resourceCount: 1,
    pretaxAmount: 0.5,
    currency: 'CNY',
    items: [
      {
        id: 'platform-1',
        syncBatchId: 'sync-1',
        sourceFingerprint: 'platform-1',
        billCycle: '2026-07',
        billingDate: '2026-07-16T00:00:00.000Z',
        productCode: 'eip',
        productDetail: '弹性公网IP',
        billItem: '公网IP保有费',
        cloudResourceId: 'eip-1',
        cloudResourceType: 'eip',
        pretaxAmount: 0.5,
        currency: 'CNY',
        billingScope: 'platform' as const,
        ownerUserId: null,
        matchedLedgerId: null,
      },
    ],
  },
];

describe('BillingScreen', () => {
  beforeEach(() => {
    replaceMock.mockReset();
    exportBillingUserItemsCsvMock.mockReset();
    exportBillingUsersCsvMock.mockReset();
    exportPlatformBillingCsvMock.mockReset();
    fetchAdminUsersMock.mockReset();
    fetchBillingSummaryMock.mockReset();
    fetchBillingUserGroupsMock.mockReset();
    fetchBillingUsersMock.mockReset();
    fetchPlatformBillingGroupsMock.mockReset();
    triggerBillingSyncMock.mockReset();
    fetchAdminUsersMock.mockResolvedValue([
      { id: 'user-1', username: 'alice', role: 'user', status: 'active', createdAt: '', updatedAt: '' },
      { id: 'user-2', username: 'bob', role: 'user', status: 'active', createdAt: '', updatedAt: '' },
    ]);
    vi.stubGlobal('Blob', class BlobMock {
      constructor(_parts?: unknown[], _options?: Record<string, unknown>) {}
    });
    Object.defineProperty(window.URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: vi.fn(() => 'blob:test'),
    });
    Object.defineProperty(window.URL, 'revokeObjectURL', {
      configurable: true,
      writable: true,
      value: vi.fn(),
    });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  });

  afterEach(() => {
    delete (window.URL as typeof window.URL & { createObjectURL?: unknown }).createObjectURL;
    delete (window.URL as typeof window.URL & { revokeObjectURL?: unknown }).revokeObjectURL;
    cleanup();
    vi.restoreAllMocks();
  });

  it('defaults to all-user launch details, filters by user, and switches the single detail panel to platform fees', async () => {
    vi.spyOn(adminSessionModule, 'useAdminSession').mockReturnValue(adminSession);
    fetchBillingSummaryMock.mockResolvedValue({
      startAt: '2026-06-17',
      endAt: '2026-07-16',
      totalPretaxAmount: 8.9,
      platformPretaxAmount: 0.5,
      anomalyCount: 1,
      resourceTypeTotals: [],
      dailyTotals: [],
    });
    fetchBillingUsersMock.mockResolvedValue([
      { userId: 'user-1', username: 'alice', pretaxAmount: 8.4, itemCount: 1, launchCount: 1 },
      { userId: 'user-2', username: 'bob', pretaxAmount: 0.0, itemCount: 0, launchCount: 0 },
    ]);
    fetchBillingUserGroupsMock.mockResolvedValue([
      ...userGroups,
      {
        ...userGroups[0],
        id: 'job-single',
        kind: 'single_launch',
        title: '开启靶场实例',
        completedAt: '2026-07-16T03:04:05.000Z',
        instance: { id: 'single-1', name: 'single-lab', batchId: 'batch-single' },
      },
    ]);
    fetchPlatformBillingGroupsMock.mockResolvedValue(platformGroups);
    triggerBillingSyncMock.mockResolvedValue({
      syncedDays: 1,
      importedLineItems: 3,
      anomalyCount: 1,
      deferredCount: 0,
    });
    exportPlatformBillingCsvMock.mockResolvedValue('platform csv');
    exportBillingUsersCsvMock.mockResolvedValue('users csv');
    exportBillingUserItemsCsvMock.mockResolvedValue('user csv');

    render(<BillingScreen apiBaseUrl="http://localhost:3001" />);

    const heading = await screen.findByRole('heading', { level: 1, name: '账单费用' });
    expect(heading.closest('[data-slot="admin-page-header"]')).toBeTruthy();
    expect(heading.closest('.admin-workbench-surface')).toBeTruthy();
    expect(screen.getByRole('region', { name: '费用明细' })).toBeTruthy();
    await screen.findByText('用户明细');
    const rangeGroupButtons = await screen.findAllByRole('button', { name: /编排实例/ });
    expect(rangeGroupButtons).toHaveLength(1);
    expect(rangeGroupButtons[0]?.textContent).toContain('CNY');
    expect(screen.getByRole('button', { name: /单实例/ })).toBeTruthy();
    expect(screen.queryByText('开启编排实例')).toBeNull();
    expect(screen.getByText(/02:03:42/)).toBeTruthy();
    expect(screen.getByText('账期')).toBeTruthy();
    expect(screen.queryByText('待确认归属')).toBeNull();
    expect(screen.queryByText('已纳入平台账单范围')).toBeNull();
    expect(screen.queryByText('未分摊到具体用户')).toBeNull();
    expect(screen.queryByText('资源类型汇总')).toBeNull();
    expect(screen.getByText(/1 次成功开通/)).toBeTruthy();
    expect(fetchBillingUserGroupsMock).toHaveBeenCalledWith(
      'http://localhost:3001',
      'dev-admin-token',
      expect.objectContaining({ userId: undefined }),
    );
    expect(fetchBillingUsersMock).toHaveBeenCalledWith(
      'http://localhost:3001',
      'dev-admin-token',
      expect.objectContaining({ page: 1, pageSize: 100 }),
    );

    fireEvent.click(rangeGroupButtons[0]!);

    const billingDate = await screen.findByText('账期 2026-07-16');
    expect(billingDate.parentElement?.parentElement?.className).toContain('sm:pl-10');
    const billingDescription = screen.getByText('云服务器配置 · 云服务器ECS-按量付费');
    expect(billingDescription.getAttribute('data-slot')).toBe('billing-line-description');
    expect(billingDescription.closest('[data-slot="billing-line-resource"]')).toBeNull();
    expect(billingDescription.parentElement?.className).toContain(
      'sm:grid-cols-[8.5rem_minmax(0,1fr)_minmax(0,1fr)_22ch]',
    );
    expect(billingDescription.className).toContain('sm:col-start-3');

    fireEvent.keyDown(screen.getByRole('button', { name: '导出账单' }), { key: 'Enter' });
    await screen.findByRole('menuitem', { name: '导出平台账单' });
    await screen.findByRole('menuitem', { name: '导出用户汇总' });
    await screen.findByRole('menuitem', { name: '导出当前用户' });
    fireEvent.click(screen.getByRole('menuitem', { name: '导出平台账单' }));

    await waitFor(() => {
      expect(exportPlatformBillingCsvMock).toHaveBeenCalledWith(
        'http://localhost:3001',
        'dev-admin-token',
        expect.objectContaining({ startAt: expect.any(String), endAt: expect.any(String) }),
      );
    });

    const initialGroupRequestCount = fetchBillingUserGroupsMock.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: '立即同步' }));

    await waitFor(() => {
      expect(screen.getByText('已同步 1 天，导入 3 条账单。')).toBeTruthy();
      expect(fetchBillingUserGroupsMock.mock.calls.length).toBeGreaterThan(initialGroupRequestCount);
    });

    fireEvent.click(screen.getByRole('combobox', { name: '筛选用户' }));
    fireEvent.click(screen.getByRole('option', { name: 'alice' }));

    await waitFor(() => {
      expect(fetchBillingUserGroupsMock).toHaveBeenLastCalledWith(
        'http://localhost:3001',
        'dev-admin-token',
        expect.objectContaining({ userId: 'user-1' }),
      );
    });

    fireEvent.click(screen.getByRole('button', { name: '平台费用明细' }));

    await screen.findByText('未关联平台启动的费用');
    expect(fetchPlatformBillingGroupsMock).toHaveBeenCalled();
    expect(screen.getByRole('combobox', { name: '筛选用户' }).hasAttribute('disabled')).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: /alice/i }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '用户明细' }).getAttribute('aria-pressed')).toBe('true');
      expect(fetchBillingUserGroupsMock).toHaveBeenLastCalledWith(
        'http://localhost:3001',
        'dev-admin-token',
        expect.objectContaining({ userId: 'user-1' }),
      );
    });
  });

  it('keeps the fee detail workspace present while launch groups are loading', async () => {
    vi.spyOn(adminSessionModule, 'useAdminSession').mockReturnValue(adminSession);
    fetchBillingSummaryMock.mockResolvedValue({
      startAt: '2026-06-17',
      endAt: '2026-07-16',
      totalPretaxAmount: 8.9,
      platformPretaxAmount: 0.5,
      anomalyCount: 0,
      resourceTypeTotals: [],
      dailyTotals: [],
    });
    fetchBillingUsersMock.mockResolvedValue([]);
    fetchBillingUserGroupsMock.mockImplementation(() => new Promise(() => {}));

    render(<BillingScreen apiBaseUrl="http://localhost:3001" />);

    const detailWorkspace = await screen.findByRole('region', { name: '费用明细' });

    expect(detailWorkspace.getAttribute('aria-busy')).toBe('true');
    expect(screen.getByRole('status', { name: '正在加载费用明细' })).toBeTruthy();
  });

  it('restores cached billing data without skeletons or duplicate requests after returning', async () => {
    vi.spyOn(adminSessionModule, 'useAdminSession').mockReturnValue(adminSession);
    fetchBillingSummaryMock.mockResolvedValue({
      startAt: '2026-06-17',
      endAt: '2026-07-16',
      totalPretaxAmount: 8.9,
      platformPretaxAmount: 0.5,
      anomalyCount: 0,
      resourceTypeTotals: [],
      dailyTotals: [],
    });
    fetchBillingUsersMock.mockResolvedValue([
      { userId: 'user-1', username: 'alice', pretaxAmount: 8.4, itemCount: 1, launchCount: 1 },
    ]);
    fetchBillingUserGroupsMock.mockResolvedValue(userGroups);

    function CachedBillingScreen({ visible }: { visible: boolean }) {
      return (
        <AdminScreenCacheProvider>
          {visible ? <BillingScreen apiBaseUrl="http://localhost:3001" /> : null}
        </AdminScreenCacheProvider>
      );
    }

    const { rerender } = render(<CachedBillingScreen visible />);

    await screen.findByRole('button', { name: /编排实例/ });
    expect(fetchBillingSummaryMock).toHaveBeenCalledTimes(1);
    expect(fetchBillingUsersMock).toHaveBeenCalledTimes(1);
    expect(fetchAdminUsersMock).toHaveBeenCalledTimes(1);
    expect(fetchBillingUserGroupsMock).toHaveBeenCalledTimes(1);

    rerender(<CachedBillingScreen visible={false} />);
    rerender(<CachedBillingScreen visible />);

    expect(screen.getByRole('button', { name: /编排实例/ })).toBeTruthy();
    expect(screen.queryByRole('status', { name: '正在加载费用明细' })).toBeNull();
    expect(screen.queryByRole('status', { name: '正在加载用户账单' })).toBeNull();

    await waitFor(() => {
      expect(fetchBillingSummaryMock).toHaveBeenCalledTimes(1);
      expect(fetchBillingUsersMock).toHaveBeenCalledTimes(1);
      expect(fetchAdminUsersMock).toHaveBeenCalledTimes(1);
      expect(fetchBillingUserGroupsMock).toHaveBeenCalledTimes(1);
    });
  });

  it('renders empty launch groups within the fee detail workspace', async () => {
    vi.spyOn(adminSessionModule, 'useAdminSession').mockReturnValue(adminSession);
    fetchBillingSummaryMock.mockResolvedValue({
      startAt: '2026-06-17',
      endAt: '2026-07-16',
      totalPretaxAmount: 0,
      platformPretaxAmount: 0,
      anomalyCount: 0,
      resourceTypeTotals: [],
      dailyTotals: [],
    });
    fetchBillingUsersMock.mockResolvedValue([]);
    fetchBillingUserGroupsMock.mockResolvedValue([]);

    render(<BillingScreen apiBaseUrl="http://localhost:3001" />);

    const detailWorkspace = await screen.findByRole('region', { name: '费用明细' });

    expect(detailWorkspace.getAttribute('aria-busy')).toBeNull();
    expect(detailWorkspace.textContent).toContain('当前账期内暂无用户费用明细。');
    expect(screen.getByText('当前账期内暂无用户账单。')).toBeTruthy();
  });

  it('keeps a failed launch-group request inside the fee detail workspace with a retry action', async () => {
    vi.spyOn(adminSessionModule, 'useAdminSession').mockReturnValue(adminSession);
    fetchBillingSummaryMock.mockResolvedValue({
      startAt: '2026-06-17',
      endAt: '2026-07-16',
      totalPretaxAmount: 0,
      platformPretaxAmount: 0,
      anomalyCount: 0,
      resourceTypeTotals: [],
      dailyTotals: [],
    });
    fetchBillingUsersMock.mockResolvedValue([]);
    fetchBillingUserGroupsMock.mockRejectedValue(new Error('network failure'));

    render(<BillingScreen apiBaseUrl="http://localhost:3001" />);

    const detailWorkspace = await screen.findByRole('region', { name: '费用明细' });
    const error = await screen.findByRole('alert');

    expect(detailWorkspace.contains(error)).toBe(true);
    expect(error.textContent).toContain('费用明细加载失败，请稍后重试。');
    expect(screen.getByRole('button', { name: '重试加载' })).toBeTruthy();
  });

  it('does not leave the detail workspace busy when the active view is selected again', async () => {
    vi.spyOn(adminSessionModule, 'useAdminSession').mockReturnValue(adminSession);
    fetchBillingSummaryMock.mockResolvedValue({
      startAt: '2026-06-17',
      endAt: '2026-07-16',
      totalPretaxAmount: 8.4,
      platformPretaxAmount: 0,
      anomalyCount: 0,
      resourceTypeTotals: [],
      dailyTotals: [],
    });
    fetchBillingUsersMock.mockResolvedValue([
      { userId: 'user-1', username: 'alice', pretaxAmount: 8.4, itemCount: 1, launchCount: 1 },
    ]);
    fetchBillingUserGroupsMock.mockResolvedValue(userGroups);
    fetchPlatformBillingGroupsMock.mockResolvedValue(platformGroups);

    render(<BillingScreen apiBaseUrl="http://localhost:3001" />);

    await screen.findByText('编排实例');
    const detailWorkspace = screen.getByRole('region', { name: '费用明细' });

    fireEvent.click(screen.getByRole('button', { name: '用户明细' }));

    await waitFor(() => {
      expect(detailWorkspace.getAttribute('aria-busy')).toBeNull();
      expect(screen.queryByText('正在更新费用明细...')).toBeNull();
    });

    fireEvent.click(screen.getByRole('button', { name: '平台费用明细' }));
    await screen.findByText('未关联平台启动的费用');

    fireEvent.click(screen.getByRole('button', { name: '平台费用明细' }));

    await waitFor(() => {
      expect(detailWorkspace.getAttribute('aria-busy')).toBeNull();
      expect(screen.queryByText('正在更新费用明细...')).toBeNull();
    });

    const userBillingPanel = screen.getByLabelText('用户账单');
    fireEvent.click(within(userBillingPanel).getByRole('button', { name: /alice/i }));
    await screen.findByText('编排实例');

    fireEvent.click(within(userBillingPanel).getByRole('button', { name: /alice/i }));

    await waitFor(() => {
      expect(detailWorkspace.getAttribute('aria-busy')).toBeNull();
      expect(screen.queryByText('正在更新费用明细...')).toBeNull();
    });
  });

  it('redirects regular users away without loading billing data', async () => {
    vi.spyOn(adminSessionModule, 'useAdminSession').mockReturnValue({
      ...adminSession,
      token: 'user-token',
      profile: { id: 'user-1', username: 'alice', role: 'user' },
      isAdmin: false,
    });

    render(<BillingScreen apiBaseUrl="http://localhost:3001" />);

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith('/admin/scenarios');
    });

    expect(fetchBillingSummaryMock).not.toHaveBeenCalled();
    expect(screen.getByText('当前账号无权访问账单费用。')).toBeTruthy();
  });

  it('redirects to login when the billing summary returns 401', async () => {
    const logoutMock = vi.fn();

    vi.spyOn(adminSessionModule, 'useAdminSession').mockReturnValue({
      ...adminSession,
      logout: logoutMock,
    });
    fetchBillingSummaryMock.mockRejectedValue(new AdminApiError(401));
    fetchBillingUsersMock.mockResolvedValue([]);
    fetchBillingUserGroupsMock.mockResolvedValue([]);
    fetchPlatformBillingGroupsMock.mockResolvedValue([]);

    render(<BillingScreen apiBaseUrl="http://localhost:3001" />);

    await waitFor(() => {
      expect(logoutMock).toHaveBeenCalled();
      expect(replaceMock).toHaveBeenCalledWith('/admin/login');
    });
  });
});
