import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  exportBillingUserItemsCsvMock,
  exportBillingUsersCsvMock,
  exportPlatformBillingCsvMock,
  fetchBillingSummaryMock,
  fetchPlatformBillingItemsMock,
  fetchBillingUsersMock,
  fetchBillingUserItemsMock,
  fetchBillingAnomaliesMock,
  replaceMock,
  routerMock,
  triggerBillingSyncMock,
} = vi.hoisted(() => ({
  exportBillingUserItemsCsvMock: vi.fn(),
  exportBillingUsersCsvMock: vi.fn(),
  exportPlatformBillingCsvMock: vi.fn(),
  fetchBillingSummaryMock: vi.fn(),
  fetchPlatformBillingItemsMock: vi.fn(),
  fetchBillingUsersMock: vi.fn(),
  fetchBillingUserItemsMock: vi.fn(),
  fetchBillingAnomaliesMock: vi.fn(),
  replaceMock: vi.fn(),
  routerMock: {} as { replace: typeof replaceMock },
  triggerBillingSyncMock: vi.fn(),
}));

routerMock.replace = replaceMock;

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
    fetchBillingSummary: fetchBillingSummaryMock,
    fetchPlatformBillingItems: fetchPlatformBillingItemsMock,
    fetchBillingUsers: fetchBillingUsersMock,
    fetchBillingUserItems: fetchBillingUserItemsMock,
    fetchBillingAnomalies: fetchBillingAnomaliesMock,
    triggerBillingSync: triggerBillingSyncMock,
  };
});

import { AdminApiError } from '../../lib/admin-api';
import * as adminSessionModule from './use-admin-session';
import { BillingScreen } from './billing-screen';

describe('BillingScreen', () => {
  beforeEach(() => {
    replaceMock.mockReset();
    exportBillingUserItemsCsvMock.mockReset();
    exportBillingUsersCsvMock.mockReset();
    exportPlatformBillingCsvMock.mockReset();
    fetchBillingSummaryMock.mockReset();
    fetchPlatformBillingItemsMock.mockReset();
    fetchBillingUsersMock.mockReset();
    fetchBillingUserItemsMock.mockReset();
    fetchBillingAnomaliesMock.mockReset();
    triggerBillingSyncMock.mockReset();
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

  it('loads summary first and fetches user items after selecting a user', async () => {
    vi.spyOn(adminSessionModule, 'useAdminSession').mockReturnValue({
      token: 'dev-admin-token',
      profile: { id: 'admin', username: 'admin', role: 'admin' },
      isAdmin: true,
      isReady: true,
      login: vi.fn(),
      logout: vi.fn(),
    });

    fetchBillingSummaryMock.mockResolvedValue({
      startAt: '2026-06-17',
      endAt: '2026-07-16',
      totalPretaxAmount: 3.5001128,
      platformPretaxAmount: 0.500000001,
      anomalyCount: 1,
      resourceTypeTotals: [
        { resourceType: 'ecs', pretaxAmount: 2.5001234 },
        { resourceType: 'eip', pretaxAmount: 1.0 },
      ],
      dailyTotals: [{ billingDate: '2026-07-16', pretaxAmount: 3.5001128 }],
    });
    fetchBillingUsersMock.mockResolvedValue([
      { userId: 'user-1', username: 'alice', pretaxAmount: 2.5001234, itemCount: 2 },
      { userId: 'user-2', username: 'bob', pretaxAmount: 0.5, itemCount: 1 },
    ]);
    fetchPlatformBillingItemsMock.mockResolvedValue([
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
        pretaxAmount: 0.500000001,
        currency: 'CNY',
        billingScope: 'platform',
        ownerUserId: null,
        matchedLedgerId: 'ledger-platform',
      },
    ]);
    fetchBillingAnomaliesMock.mockResolvedValue([
      {
        id: 'anomaly-1',
        syncBatchId: 'sync-1',
        sourceFingerprint: 'fp-1',
        billCycle: '2026-07',
        billingDate: '2026-07-16T00:00:00.000Z',
        cloudResourceId: 'cn-hangzhou',
        cloudResourceType: 'snapshot_region',
        pretaxAmount: 0.880000001,
        currency: 'CNY',
        reason: 'missing aggregation rule',
      },
    ]);
    fetchBillingUserItemsMock.mockResolvedValue([
      {
        id: 'item-1',
        syncBatchId: 'sync-1',
        sourceFingerprint: 'item-1',
        billCycle: '2026-07',
        billingDate: '2026-07-16T00:00:00.000Z',
        productCode: 'ecs',
        productDetail: '云服务器ECS-按量付费',
        billItem: '云服务器配置',
        cloudResourceId: 'i-test-1',
        cloudResourceType: 'ecs',
        pretaxAmount: 2.5001234,
        currency: 'CNY',
        billingScope: 'user',
        ownerUserId: 'user-1',
        matchedLedgerId: 'ledger-1',
      },
    ]);
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

    await screen.findByText('账单费用');
    await screen.findByText('平台总应付');
    await screen.findByText('¥ 3.5001128');
    expect(screen.getAllByText('¥ 0.500000001')).toHaveLength(2);
    await screen.findByText('alice');
    await screen.findByText('平台公共费用明细');
    await screen.findByText('公网IP保有费');
    await screen.findByText('missing aggregation rule');

    expect(fetchBillingSummaryMock).toHaveBeenCalled();
    expect(fetchPlatformBillingItemsMock).toHaveBeenCalled();
    expect(fetchBillingUsersMock).toHaveBeenCalled();
    expect(fetchBillingAnomaliesMock).toHaveBeenCalled();
    expect(fetchBillingUserItemsMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /alice/i }));

    await screen.findByText(/i-test-1/);

    fireEvent.click(screen.getByRole('button', { name: /bob/i }));

    await waitFor(() => {
      expect(fetchBillingUserItemsMock).toHaveBeenLastCalledWith(
        'http://localhost:3001',
        'dev-admin-token',
        'user-2',
        expect.objectContaining({
          startAt: expect.any(String),
          endAt: expect.any(String),
        }),
      );
    });

    fireEvent.click(screen.getByRole('button', { name: '立即同步' }));

    await waitFor(() => {
      expect(triggerBillingSyncMock).toHaveBeenCalledWith(
        'http://localhost:3001',
        'dev-admin-token',
        expect.objectContaining({
          startAt: expect.any(String),
          endAt: expect.any(String),
        }),
      );
      expect(screen.getByText('已同步 1 天，导入 3 条账单。')).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: '导出平台账单' }));
    fireEvent.click(screen.getByRole('button', { name: '导出用户汇总' }));
    fireEvent.click(screen.getByRole('button', { name: '导出当前用户' }));

    await waitFor(() => {
      expect(exportPlatformBillingCsvMock).toHaveBeenCalled();
      expect(exportBillingUsersCsvMock).toHaveBeenCalled();
      expect(exportBillingUserItemsCsvMock).toHaveBeenCalledWith(
        'http://localhost:3001',
        'dev-admin-token',
        'user-2',
        expect.objectContaining({
          startAt: expect.any(String),
          endAt: expect.any(String),
        }),
      );
    });
  });

  it('redirects regular users away without loading billing data', async () => {
    vi.spyOn(adminSessionModule, 'useAdminSession').mockReturnValue({
      token: 'user-token',
      profile: { id: 'user-1', username: 'alice', role: 'user' },
      isAdmin: false,
      isReady: true,
      login: vi.fn(),
      logout: vi.fn(),
    });

    render(<BillingScreen apiBaseUrl="http://localhost:3001" />);

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith('/admin/scenarios');
    });

    expect(fetchBillingSummaryMock).not.toHaveBeenCalled();
    expect(screen.getByText('当前账号无权访问账单费用。')).toBeTruthy();
  });

  it('redirects to login when billing summary returns 401', async () => {
    const logoutMock = vi.fn();

    vi.spyOn(adminSessionModule, 'useAdminSession').mockReturnValue({
      token: 'dev-admin-token',
      profile: { id: 'admin', username: 'admin', role: 'admin' },
      isAdmin: true,
      isReady: true,
      login: vi.fn(),
      logout: logoutMock,
    });
    fetchBillingSummaryMock.mockRejectedValue(new AdminApiError(401));
    fetchBillingUsersMock.mockResolvedValue([]);
    fetchBillingAnomaliesMock.mockResolvedValue([]);

    render(<BillingScreen apiBaseUrl="http://localhost:3001" />);

    await waitFor(() => {
      expect(logoutMock).toHaveBeenCalled();
      expect(replaceMock).toHaveBeenCalledWith('/admin/login');
    });
  });
});
