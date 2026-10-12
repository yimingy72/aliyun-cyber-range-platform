import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  routerMock: {} as { replace: (...args: unknown[]) => void },
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
  idToken: 'fixture-id-token',
  refreshToken: 'fixture-refresh-token',
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
    Reflect.deleteProperty(window.URL, 'createObjectURL');
    Reflect.deleteProperty(window.URL, 'revokeObjectURL');
    cleanup();
    vi.restoreAllMocks();
  });

  it('defaults to all-user launch details, filters by user, and switches the single detail panel to platform fees', async () => {
    vi.spyOn(adminSessionModule, 'useAdminSession').mockReturnValue(adminSession);
    fetchBillingSummaryMock.mockResolvedValue({ billingScope: 'platform_resources', reconciliationIssues: [],
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
    expect(screen.getByText(/1 个已出账开通任务/)).toBeTruthy();
    expect(fetchBillingUserGroupsMock).toHaveBeenCalledWith(
      'http://localhost:3001',
      'dev-admin-token',
      expect.objectContaining({ userId: undefined }),
    );
    expect(fetchBillingUsersMock).toHaveBeenCalledWith(
      'http://localhost:3001',
      'dev-admin-token',
      expect.objectContaining({ page: 1, pageSize: 20 }),
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
    fetchBillingSummaryMock.mockResolvedValue({ billingScope: 'platform_resources', reconciliationIssues: [],
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

  it('paginates every user summary and displays the total user count', async () => {
    vi.spyOn(adminSessionModule, 'useAdminSession').mockReturnValue(adminSession);
    fetchBillingSummaryMock.mockResolvedValue({ billingScope: 'platform_resources', reconciliationIssues: [], totalPretaxAmount: 101, platformPretaxAmount: 0 });
    fetchBillingUserGroupsMock.mockResolvedValue([]);
    fetchBillingUsersMock.mockImplementation(async (_api: string, _token: string, input: { page: number; pageSize: 20 | 50 | 100 }) => ({
      page: input.page, pageSize: input.pageSize, total: 101,
      items: Array.from({ length: Math.min(input.pageSize, 101 - (input.page - 1) * input.pageSize) }, (_, i) => ({ userId: `user-${(input.page - 1) * input.pageSize + i + 1}`, username: `billing-user-${(input.page - 1) * input.pageSize + i + 1}`, pretaxAmount: 1, itemCount: 1, launchCount: 1 })),
    }));
    render(<BillingScreen apiBaseUrl="http://localhost:3001" />);
    await screen.findByText('101 位用户');
    const aside = screen.getByRole('complementary', { name: '用户账单' });
    const jumpInput = within(aside).getByLabelText('跳转到页码') as HTMLInputElement;
    const visiblePageJumpValues: string[] = [];
    // Enter the next destination at the first page commit, before a passive effect can reset it.
    const observer = new MutationObserver(() => {
      if (within(aside).queryByText('billing-user-21')) {
        visiblePageJumpValues.push(jumpInput.value);
        observer.disconnect();
        fireEvent.change(jumpInput, { target: { value: '6' } });
      }
    });
    observer.observe(aside, { childList: true, subtree: true });
    expect(within(aside).queryByText('billing-user-21')).toBeNull();
    fireEvent.click(within(aside).getByRole('button', { name: '下一页' }));
    await within(aside).findByText('billing-user-21');
    observer.disconnect();
    expect(jumpInput.value).toBe('6');
    expect(visiblePageJumpValues).toEqual(['2']);
    fireEvent.click(within(aside).getByRole('button', { name: '跳转' }));
    await within(aside).findByText('billing-user-101');
    expect(fetchBillingUsersMock).toHaveBeenLastCalledWith('http://localhost:3001', 'dev-admin-token', expect.objectContaining({ page: 6, pageSize: 20 }));
  });

  it('keeps the latest user page and jump value when an older page request finishes later', async () => {
    vi.spyOn(adminSessionModule, 'useAdminSession').mockReturnValue(adminSession);
    fetchBillingSummaryMock.mockResolvedValue({ billingScope: 'platform_resources', reconciliationIssues: [], totalPretaxAmount: 101, platformPretaxAmount: 0 });
    fetchBillingUserGroupsMock.mockResolvedValue([]);
    const pageResult = (page: number) => ({
      page, pageSize: 20, total: 101,
      items: Array.from({ length: Math.min(20, 101 - (page - 1) * 20) }, (_, index) => ({
        userId: `user-${(page - 1) * 20 + index + 1}`, username: `billing-user-${(page - 1) * 20 + index + 1}`,
        pretaxAmount: 1, itemCount: 1, launchCount: 1,
      })),
    });
    let finishSecondPage!: (result: ReturnType<typeof pageResult>) => void;
    const secondPage = new Promise<ReturnType<typeof pageResult>>((resolve) => { finishSecondPage = resolve; });
    fetchBillingUsersMock.mockImplementation(async (_api: string, _token: string, input: { page: number }) =>
      input.page === 2 ? secondPage : pageResult(input.page));
    render(<BillingScreen apiBaseUrl="http://localhost:3001" />);
    await screen.findByText('101 位用户');
    const aside = screen.getByRole('complementary', { name: '用户账单' });
    const jumpInput = within(aside).getByLabelText('跳转到页码') as HTMLInputElement;
    fireEvent.click(within(aside).getByRole('button', { name: '下一页' }));
    await waitFor(() => expect(fetchBillingUsersMock).toHaveBeenLastCalledWith(
      'http://localhost:3001', 'dev-admin-token', expect.objectContaining({ page: 2 })));
    fireEvent.change(jumpInput, { target: { value: '6' } });
    fireEvent.click(within(aside).getByRole('button', { name: '跳转' }));
    await within(aside).findByText('billing-user-101');
    await act(async () => { finishSecondPage(pageResult(2)); });
    expect(jumpInput.value).toBe('6');
    expect(within(aside).queryByText('billing-user-21')).toBeNull();
    expect(within(aside).getByRole('button', { name: '第 6 页' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('renders totals and user amounts by their currencies without a mixed total', async () => {
    vi.spyOn(adminSessionModule, 'useAdminSession').mockReturnValue(adminSession);
    fetchBillingSummaryMock.mockResolvedValue({ billingScope: 'platform_resources', reconciliationIssues: [], totalPretaxAmount: null, platformPretaxAmount: null, currency: null, currencyTotals: [{ currency: 'CNY', totalPretaxAmount: 10, platformPretaxAmount: 0 }, { currency: 'USD', totalPretaxAmount: 20, platformPretaxAmount: 0 }] });
    fetchBillingUsersMock.mockResolvedValue([{ userId: 'user-1', username: 'alice', pretaxAmount: null, currency: null, amounts: [{ currency: 'CNY', pretaxAmount: 10 }, { currency: 'USD', pretaxAmount: 20 }], itemCount: 2, launchCount: 1 }]);
    fetchBillingUserGroupsMock.mockResolvedValue([]);
    render(<BillingScreen apiBaseUrl="http://localhost:3001" />);
    const overview = await screen.findByLabelText('账单概览');
    await waitFor(() => expect(overview.textContent).toContain('USD'));
    expect(overview.textContent).toContain('¥ 10.00');
    expect(overview.textContent).not.toContain('30.00');
    const aside = screen.getByRole('complementary', { name: '用户账单' });
    expect(aside.textContent).toContain('USD');
    expect(aside.textContent).not.toContain('¥ 20.00');
  });

  it('shows unallocated currencies and unmatched resources separately from attributed costs', async () => {
    vi.spyOn(adminSessionModule, 'useAdminSession').mockReturnValue(adminSession);
    fetchBillingSummaryMock.mockResolvedValue({ billingScope: 'platform_resources', reconciliationIssues: [], totalPretaxAmount: 10, platformPretaxAmount: 2, currency: 'CNY', anomalyCount: 2,
      billingStatus: 'provisional', unallocatedCurrencyTotals: [{ currency: 'CNY', pretaxAmount: 3 }, { currency: 'USD', pretaxAmount: 4 }], resourcesWithoutBillCount: 5 });
    fetchBillingUsersMock.mockResolvedValue([{ userId: 'user-1', username: 'alice', pretaxAmount: 8, itemCount: 1, launchCount: 1 }]);
    fetchBillingUserGroupsMock.mockResolvedValue([]);
    render(<BillingScreen apiBaseUrl="http://localhost:3001" />);
    await waitFor(() => expect(screen.getByText('平台待分配费用').parentElement?.textContent).toContain('USD'));
    expect(screen.getByText('平台已归属费用').parentElement?.textContent).toBe('平台已归属费用¥ 10.00');
    expect(screen.getByText('平台公共费用').parentElement?.textContent).toBe('平台公共费用¥ 2.00');
    expect(screen.getByText('平台待分配费用').parentElement?.textContent).toContain('¥ 3.00');
    expect(screen.getByText('资源费用明细待补齐').parentElement?.textContent).toContain('5 项');
    expect(screen.getByRole('complementary', { name: '用户账单' }).textContent).toContain('¥ 8.00');
    expect(screen.getByText(/明细待补齐不代表云端未出账或免费/).textContent).toContain('尚未计入用户或平台公共费用');
    expect(screen.getByText(/账单可能因延迟出账/)).toBeTruthy();
  });

  it('shows unknown coverage for incomplete scoped responses instead of inventing zero unallocated costs', async () => {
    vi.spyOn(adminSessionModule, 'useAdminSession').mockReturnValue(adminSession);
    fetchBillingSummaryMock.mockResolvedValue({ billingScope: 'platform_resources', reconciliationIssues: [], totalPretaxAmount: 8, platformPretaxAmount: 0, anomalyCount: 0 });
    fetchBillingUsersMock.mockResolvedValue([]);
    fetchBillingUserGroupsMock.mockResolvedValue([]);
    render(<BillingScreen apiBaseUrl="http://localhost:3001" />);
    await screen.findByText(/对账信息尚不完整/);
    expect(screen.getByText('平台待分配费用').parentElement?.textContent).toBe('平台待分配费用未知');
    expect(screen.getByText('资源费用明细待补齐').parentElement?.textContent).toBe('资源费用明细待补齐未知');
    expect(screen.queryByText('无未分配记录')).toBeNull();
  });

  it('does not relabel account-wide legacy totals or anomalies as platform spending', async () => {
    vi.spyOn(adminSessionModule, 'useAdminSession').mockReturnValue(adminSession);
    fetchBillingSummaryMock.mockResolvedValue({ totalPretaxAmount: 10, platformPretaxAmount: 2, anomalyCount: 24,
      billingStatus: 'provisional', unallocatedCurrencyTotals: [{ currency: 'CNY', pretaxAmount: 99 }], resourcesWithoutBillCount: 50 });
    fetchBillingUsersMock.mockResolvedValue([]);
    fetchBillingUserGroupsMock.mockResolvedValue([]);
    render(<BillingScreen apiBaseUrl="http://localhost:3001" />);
    await screen.findByText(/账单范围尚未确认/);
    expect(within(screen.getByLabelText('账单概览')).getAllByText('范围待确认')).toHaveLength(4);
    expect(screen.getByLabelText('账单概览').textContent).not.toContain('99');
    expect(screen.queryByText(/24 条/)).toBeNull();
  });

  it('shows known platform resource reconciliation issues without account aggregate spending', async () => {
    vi.spyOn(adminSessionModule, 'useAdminSession').mockReturnValue(adminSession);
    fetchBillingSummaryMock.mockResolvedValue({ billingScope: 'platform_resources', billingStatus: 'provisional',
      totalPretaxAmount: 10, platformPretaxAmount: 2, anomalyCount: 0, unallocatedCurrencyTotals: [], resourcesWithoutBillCount: 3,
      reconciliationIssues: [
        { resourceType: 'snapshot', resourceCount: 2, reason: '等待快照分账明细。' },
        { resourceType: 'oss', resourceCount: 1, reason: '共享存储桶仍需核实费用归属。' },
        { resourceType: 'unknown', resourceCount: 2, reason: '历史创建记录缺少原账号证明。' },
        { resourceType: 'disk', resourceCount: 54, reason: '同实例主机系统盘费用已出现，但准确盘映射待核验。' },
      ] });
    fetchBillingUsersMock.mockResolvedValue([]);
    fetchBillingUserGroupsMock.mockResolvedValue([]);
    render(<BillingScreen apiBaseUrl="http://localhost:3001" />);
    const issues = await screen.findByLabelText('平台资源对账提示');
    expect(issues.textContent).toContain('快照：2 项平台资源待核对。等待快照分账明细。');
    expect(issues.textContent).toContain('OSS：1 项平台资源待核对。共享存储桶仍需核实费用归属。');
    expect(issues.textContent).toContain('平台资源来源待核验：2 项。历史创建记录缺少原账号证明。');
    expect(issues.textContent).toContain('磁盘映射待核验：54 项。同实例主机系统盘费用已出现，但准确盘映射待核验。');
    expect(screen.getByText('资源费用明细待补齐').parentElement?.textContent).toContain('3 项');
    expect(issues.textContent).not.toContain('¥');
    expect(screen.getByText('平台待分配费用').parentElement?.textContent).toContain('无未分配记录');
  });

  it.each([
    { name: 'all 54 released historical records', active: false, incomplete: false, invalidDate: false, expectedCount: 0 },
    { name: 'a mixed group with a current unreleased disk', active: true, incomplete: false, invalidDate: false, expectedCount: 1 },
    { name: 'an incomplete resource list', active: false, incomplete: true, invalidDate: false, expectedCount: 54 },
    { name: 'an unverified release timestamp', active: false, incomplete: false, invalidDate: true, expectedCount: 1 },
    { name: 'a future release timestamp', active: false, incomplete: false, invalidDate: false, future: true, expectedCount: 1 },
    { name: 'a different source failure', active: false, incomplete: false, invalidDate: false, otherReason: true, expectedCount: 1 },
  ])('keeps verified fees and other coverage notices while filtering $name', async ({ active, incomplete, invalidDate, future, otherReason, expectedCount }) => {
    vi.spyOn(adminSessionModule, 'useAdminSession').mockReturnValue(adminSession);
    const resources = Array.from({ length: 54 }, (_, index) => ({
      resourceKey: `ledger:disk-${index}`, ledgerId: `disk-${index}`, cloudResourceId: `d-${index}`, cloudResourceType: 'disk',
      billingStartAt: '2026-10-09T06:00:00.000Z', releasedAt: active && index === 0 ? null
        : invalidDate && index === 0 ? 'unverified' : future && index === 0 ? '2099-10-09T07:00:00.000Z' : '2026-10-09T07:00:00.000Z',
      proofFailureReason: otherReason && index === 0 ? 'SOURCE_JOB_MISSING' : 'SYSTEM_DISK_MAPPING_UNVERIFIED',
    }));
    const summary = { billingScope: 'platform_resources', billingStatus: 'provisional', totalPretaxAmount: 9.154876222,
      platformPretaxAmount: 0, anomalyCount: 0, unallocatedCurrencyTotals: [], resourcesWithoutBillCount: 3,
      reconciliationIssues: [
        { resourceType: 'snapshot', resourceCount: 4, reason: '快照明细待补齐。' },
        { resourceType: 'unknown', resourceCount: 2, reason: '来源仍需核验。' },
        { resourceType: 'disk', resourceCount: 54, reason: '盘映射待核验。', resources: incomplete ? resources.slice(1) : resources },
      ] };
    const original = JSON.stringify(summary);
    fetchBillingSummaryMock.mockResolvedValue(summary);
    fetchBillingUsersMock.mockResolvedValue([]);
    fetchBillingUserGroupsMock.mockResolvedValue([]);
    render(<BillingScreen apiBaseUrl="http://localhost:3001" />);
    const issues = await screen.findByLabelText('平台资源对账提示');
    if (expectedCount) expect(issues.textContent).toContain(`磁盘映射待核验：${expectedCount} 项。`);
    else expect(issues.textContent).not.toContain('盘映射待核验');
    expect(issues.textContent).toContain('快照：4 项平台资源待核对。');
    expect(issues.textContent).toContain('平台资源来源待核验：2 项。');
    expect(screen.getByText('平台已归属费用').parentElement?.textContent).toContain('¥ 9.154876222');
    expect(screen.getByText('资源费用明细待补齐').parentElement?.textContent).toContain('3 项');
    expect(JSON.stringify(summary)).toBe(original);
  });

  it('distinguishes a reported empty coverage result from missing coverage', async () => {
    vi.spyOn(adminSessionModule, 'useAdminSession').mockReturnValue(adminSession);
    fetchBillingSummaryMock.mockResolvedValue({ billingScope: 'platform_resources', reconciliationIssues: [], totalPretaxAmount: 0, platformPretaxAmount: 0, anomalyCount: 0,
      billingStatus: 'provisional', unallocatedCurrencyTotals: [], resourcesWithoutBillCount: 0 });
    fetchBillingUsersMock.mockResolvedValue([]);
    fetchBillingUserGroupsMock.mockResolvedValue([]);
    render(<BillingScreen apiBaseUrl="http://localhost:3001" />);
    await screen.findByText('无未分配记录');
    expect(screen.getByText('资源费用明细待补齐').parentElement?.textContent).toBe('资源费用明细待补齐0 项');
    expect(screen.queryByText(/对账信息尚不完整/)).toBeNull();
    expect(screen.queryByLabelText('平台资源对账提示')).toBeNull();
    expect(screen.getByText(/明细待补齐不代表云端未出账或免费/)).toBeTruthy();
  });

  it('shows the fixed platform resource scope when historical charges are excluded', async () => {
    vi.spyOn(adminSessionModule, 'useAdminSession').mockReturnValue(adminSession);
    fetchBillingSummaryMock.mockResolvedValue({ billingScope: 'platform_resources', platformBillingStartedAt: '2026-10-12T10:00:00.000Z',
      reconciliationIssues: [], totalPretaxAmount: 0, platformPretaxAmount: 0, anomalyCount: 0,
      billingStatus: 'provisional', unallocatedCurrencyTotals: [], resourcesWithoutBillCount: 0 });
    fetchBillingUsersMock.mockResolvedValue([]);
    fetchBillingUserGroupsMock.mockResolvedValue([]);
    render(<BillingScreen apiBaseUrl="http://localhost:3001" />);
    const scope = await screen.findByLabelText('当前平台统计范围');
    expect(scope.textContent).toContain('2026-10-12');
    expect(scope.textContent).toContain('历史账单保留，不计入当前汇总');
    expect(screen.getByText('平台已归属费用').parentElement?.textContent).toContain('¥ 0.00');
    expect(screen.queryByLabelText('平台资源对账提示')).toBeNull();
  });

  it('does not display zero costs after the first overview request fails', async () => {
    vi.spyOn(adminSessionModule, 'useAdminSession').mockReturnValue(adminSession);
    fetchBillingSummaryMock.mockRejectedValue(new AdminApiError(503, 'fixture unavailable'));
    fetchBillingUsersMock.mockResolvedValue([]);
    fetchBillingUserGroupsMock.mockResolvedValue([]);
    render(<BillingScreen apiBaseUrl="http://localhost:3001" />);
    await screen.findByText('账单费用加载失败，请稍后重试。');
    expect(screen.getByLabelText('账单概览').textContent).not.toContain('0.00');
    expect(screen.getByText('平台已归属费用').parentElement?.textContent).toContain('未知');
  });

  it.each(['CNY', 'USD'])('keeps ten-decimal %s charges and refunds visible', async currency => {
    vi.spyOn(adminSessionModule, 'useAdminSession').mockReturnValue(adminSession);
    fetchBillingSummaryMock.mockResolvedValue({ billingScope: 'platform_resources', currency,
      reconciliationIssues: [], totalPretaxAmount: 0.1325781504, platformPretaxAmount: -0.1325781504 });
    fetchBillingUsersMock.mockResolvedValue([]);
    fetchBillingUserGroupsMock.mockResolvedValue([]);
    render(<BillingScreen apiBaseUrl="http://localhost:3001" />);
    await screen.findByText('当前账期没有费用明细');
    expect(screen.getByText('平台已归属费用').parentElement?.textContent).toContain('0.1325781504');
    expect(screen.getByText('平台公共费用').parentElement?.textContent).toMatch(/-.*0\.1325781504/);
  });

  it.each([true, false])('shows a safe billing precision explanation without clearing existing costs: %s', async knownError => {
    vi.spyOn(adminSessionModule, 'useAdminSession').mockReturnValue(adminSession);
    fetchBillingSummaryMock.mockResolvedValue({ billingScope: 'platform_resources', reconciliationIssues: [],
      totalPretaxAmount: 8.4, platformPretaxAmount: 0 });
    fetchBillingUsersMock.mockResolvedValue([]);
    fetchBillingUserGroupsMock.mockResolvedValue([]);
    const message = '云厂商账单金额超出平台可无损保存的精度，失败账期的原有数据已保留，请联系管理员检查。';
    triggerBillingSyncMock.mockRejectedValue(knownError
      ? new AdminApiError(502, message, { code: 'BILLING_AMOUNT_PRECISION' })
      : new AdminApiError(500, 'private upstream diagnostics'));
    render(<BillingScreen apiBaseUrl="http://localhost:3001" />);
    await screen.findByText('当前账期没有费用明细');
    fireEvent.click(screen.getByRole('button', { name: '立即同步' }));
    await screen.findByText(knownError ? message : '账单同步失败，请稍后重试。');
    expect(screen.getByText('¥ 8.40')).toBeTruthy();
    expect(screen.queryByText('private upstream diagnostics')).toBeNull();
    expect(screen.queryByText(/已同步 \d+ 天/)).toBeNull();
  });

  it('uses the selected entire calendar month when refreshing bills', async () => {
    vi.spyOn(adminSessionModule, 'useAdminSession').mockReturnValue(adminSession);
    fetchBillingSummaryMock.mockResolvedValue({ billingScope: 'platform_resources', reconciliationIssues: [], totalPretaxAmount: 0, platformPretaxAmount: 0, anomalyCount: 0 });
    fetchBillingUsersMock.mockResolvedValue([]);
    fetchBillingUserGroupsMock.mockResolvedValue([]);
    triggerBillingSyncMock.mockResolvedValue({ syncedDays: 30, importedLineItems: 3, anomalyCount: 0, deferredCount: 0 });
    render(<BillingScreen apiBaseUrl="http://localhost:3001" />);
    await screen.findByText('当前账期没有费用明细');
    fireEvent.change(screen.getByLabelText('开始账期'), { target: { value: '2026-09-01' } });
    fireEvent.change(screen.getByLabelText('结束账期'), { target: { value: '2026-09-30' } });
    fireEvent.click(screen.getByRole('button', { name: '立即同步' }));
    await waitFor(() => expect(triggerBillingSyncMock).toHaveBeenCalledWith('http://localhost:3001', 'dev-admin-token',
      { startAt: '2026-09-01', endAt: '2026-09-30' }));
    expect(screen.getByText(/整月对账可选择月初至月末后同步/)).toBeTruthy();
  });

  it('refreshes the currently selected billing period when an older period finishes syncing', async () => {
    vi.spyOn(adminSessionModule, 'useAdminSession').mockReturnValue(adminSession);
    fetchBillingSummaryMock.mockImplementation(async (_url, _token, range) => ({
      billingScope: 'platform_resources', reconciliationIssues: [], ...range,
      totalPretaxAmount: range.startAt === '2026-09-01' ? 27 : 8, platformPretaxAmount: 0,
      anomalyCount: 0, resourceTypeTotals: [], dailyTotals: [],
    }));
    fetchBillingUsersMock.mockResolvedValue([]);
    fetchBillingUserGroupsMock.mockResolvedValue([]);
    let finishSync: (result: unknown) => void = () => {};
    triggerBillingSyncMock.mockImplementation(() => new Promise(resolve => { finishSync = resolve; }));
    render(<BillingScreen apiBaseUrl="http://localhost:3001" />);
    await screen.findByText('当前账期没有费用明细');
    fireEvent.click(screen.getByRole('button', { name: '立即同步' }));
    fireEvent.change(screen.getByLabelText('开始账期'), { target: { value: '2026-09-01' } });
    fireEvent.change(screen.getByLabelText('结束账期'), { target: { value: '2026-09-30' } });
    await screen.findByText('¥ 27.00');
    fetchBillingSummaryMock.mockClear();
    await act(async () => finishSync({ syncedDays: 1, importedLineItems: 3 }));
    await screen.findByText('已同步 1 天，导入 3 条账单。');
    await waitFor(() => expect(fetchBillingSummaryMock).toHaveBeenCalled());
    expect(fetchBillingSummaryMock.mock.calls.every(call => call[2].startAt === '2026-09-01' && call[2].endAt === '2026-09-30')).toBe(true);
    expect(screen.getByText('¥ 27.00')).toBeTruthy();
  });

  it.each([503, 401])('handles CSV export failure %s with feedback or login redirect', async status => {
    vi.spyOn(adminSessionModule, 'useAdminSession').mockReturnValue(adminSession);
    adminSession.logout.mockClear();
    fetchBillingSummaryMock.mockResolvedValue({ billingScope: 'platform_resources', reconciliationIssues: [], totalPretaxAmount: 0, platformPretaxAmount: 0 });
    fetchBillingUsersMock.mockResolvedValue([]);
    fetchBillingUserGroupsMock.mockResolvedValue([]);
    exportPlatformBillingCsvMock.mockRejectedValue(new AdminApiError(status, 'fixture export error'));
    render(<BillingScreen apiBaseUrl="http://localhost:3001" />);
    await screen.findByText('当前账期没有费用明细');
    fireEvent.keyDown(screen.getByRole('button', { name: '导出账单' }), { key: 'ArrowDown' });
    fireEvent.click(screen.getByRole('menuitem', { name: '导出平台账单' }));
    if (status === 401) {
      await waitFor(() => expect(adminSession.logout).toHaveBeenCalled());
      expect(replaceMock).toHaveBeenCalledWith('/admin/login');
    } else {
      await screen.findByText('账单导出失败，请稍后重试。');
    }
  });

  it('restores cached billing data without skeletons or duplicate requests after returning', async () => {
    vi.spyOn(adminSessionModule, 'useAdminSession').mockReturnValue(adminSession);
    fetchBillingSummaryMock.mockResolvedValue({ billingScope: 'platform_resources', reconciliationIssues: [],
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
    fetchBillingSummaryMock.mockResolvedValue({ billingScope: 'platform_resources', reconciliationIssues: [],
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
    fetchBillingSummaryMock.mockResolvedValue({ billingScope: 'platform_resources', reconciliationIssues: [],
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
    fetchBillingSummaryMock.mockResolvedValue({ billingScope: 'platform_resources', reconciliationIssues: [],
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
