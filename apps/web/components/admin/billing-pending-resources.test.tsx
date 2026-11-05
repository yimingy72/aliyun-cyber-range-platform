import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { BillingReconciliationResource } from '@aliyun-cyber-range/platform-api-client';
import { BillingPendingResources } from './billing-pending-resources';

const resource: BillingReconciliationResource = {
  resourceKey: 'ledger:pending', ledgerId: 'pending', cloudWorkspaceId: 'workspace', cloudProvider: 'alibaba_cloud',
  cloudResourceId: 'i-pending', cloudResourceType: 'ecs', rangeInstanceId: 'range-pending', sourceProvisionJobId: 'create-pending',
  ownerUserId: 'alice-id', cloudAccountUid: 'account-id', regionId: 'cn-beijing', billingStartAt: '2026-10-10T01:00:00.000Z',
  releasedAt: '2026-10-10T02:00:00.000Z', proofFailureReason: 'BILL_DETAILS_PENDING',
};
const users = new Map([['alice-id', 'alice']]);
afterEach(cleanup);

describe('BillingPendingResources', () => {
  it('shows exact resource provenance and lifecycle with unknown amounts rather than zero fees', () => {
    render(<BillingPendingResources label="待补齐资源清单" resourceCount={1} resources={[resource]} userNameById={users} />);
    const table = screen.getByRole('table', { name: '待补齐资源清单' });
    for (const text of ['i-pending', 'alice', 'range-pending', 'create-pending', '2026-10-10', '金额待补齐']) expect(table.textContent).toContain(text);
    expect(table.textContent).not.toContain('¥');
    expect(table.textContent).not.toContain('0.00');
    expect(screen.getByText(/不按零计算/)).toBeTruthy();
  });

  it('distinguishes unavailable, incomplete and confirmed empty lists', () => {
    const view = render(<BillingPendingResources label="清单" resourceCount={2} userNameById={users} />);
    expect(screen.getByRole('status').textContent).toContain('尚未提供资源清单');
    view.rerender(<BillingPendingResources label="清单" resourceCount={2} resources={[resource]} userNameById={users} />);
    expect(screen.getByRole('status').textContent).toContain('当前仅返回 1 条');
    expect(screen.queryByText('当前账期没有待补齐资源。')).toBeNull();
    view.rerender(<BillingPendingResources label="清单" resourceCount={0} resources={[]} userNameById={users} />);
    expect(screen.getByText('当前账期没有待补齐资源。')).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('paginates all resources and keeps a missing release timestamp unverified', () => {
    const rows = Array.from({ length: 21 }, (_, index) => ({ ...resource, resourceKey: `ledger:${index}`, cloudResourceId: `i-pending-${index}`, releasedAt: null }));
    render(<BillingPendingResources label="清单" resourceCount={21} resources={rows} userNameById={users} />);
    expect(screen.getByRole('table').textContent).not.toContain('i-pending-20');
    expect(screen.getAllByText('释放：未记录释放')).toHaveLength(20);
    const pagination = screen.getByLabelText('清单分页');
    fireEvent.click(within(pagination).getByRole('link', { name: '下一页' }));
    expect(screen.getByRole('table').textContent).toContain('i-pending-20');
    expect(screen.getByRole('table').textContent).not.toContain('i-pending-19');
    expect(within(pagination).getByRole('link', { name: '下一页' }).getAttribute('aria-disabled')).toBe('true');
  });

  it('clamps a shortened list without rebounding to the old page when resources grow again', () => {
    const rows = Array.from({ length: 60 }, (_, index) => ({ ...resource, resourceKey: `ledger:${index}`, cloudResourceId: `i-pending-${index}` }));
    const view = render(<BillingPendingResources label="清单" resourceCount={60} resources={rows} userNameById={users} />);
    fireEvent.click(screen.getByRole('link', { name: '第 3 页' }));
    view.rerender(<BillingPendingResources label="清单" resourceCount={21} resources={rows.slice(0, 21)} userNameById={users} />);
    expect(screen.getByRole('link', { name: '第 2 页' }).getAttribute('aria-current')).toBe('page');
    view.rerender(<BillingPendingResources label="清单" resourceCount={60} resources={rows} userNameById={users} />);
    expect(screen.getByRole('link', { name: '第 2 页' }).getAttribute('aria-current')).toBe('page');
  });
});
