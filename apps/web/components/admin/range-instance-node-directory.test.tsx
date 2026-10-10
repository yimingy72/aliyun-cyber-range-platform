// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RangeInstanceNodeDirectory, type RangeNodeDnsVerification } from './range-instance-node-directory';

beforeEach(() => vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const host = {
  id: 'member', label: '域成员', kind: 'ecs', statusLabel: '运行中', cloudStatus: 'Running',
  dns: { servers: ['10.0.50.10'], nicIds: ['member-nic-1'], domain: 'lab.example' },
};
const verification: RangeNodeDnsVerification = {
  status: 'verified', method: 'readback',
  expected: [{ nicId: 'member-nic-1', privateIp: '10.0.50.20', servers: ['10.0.50.10'] }],
  actual: [{ nicId: 'member-nic-1', privateIp: '10.0.50.20', servers: ['10.0.50.10'] }],
  resolutionStatus: 'verified',
};

describe('range node DNS verification', () => {
  it('offers verification only for configured running hosts and disables another submit while pending', () => {
    const onNodeAction = vi.fn();
    const { rerender } = render(<RangeInstanceNodeDirectory nodes={[host]} onNodeAction={onNodeAction} />);
    fireEvent.click(screen.getByRole('button', { name: '核验 DNS' }));
    expect(onNodeAction).toHaveBeenCalledWith('member', 'verify-dns');
    rerender(<RangeInstanceNodeDirectory nodes={[host]} onNodeAction={onNodeAction} pendingAction={{ nodeId: 'member', action: 'verify-dns' }} />);
    expect((screen.getByRole('button', { name: '核验中...' }) as HTMLButtonElement).disabled).toBe(true);
    rerender(<RangeInstanceNodeDirectory nodes={[{ ...host, cloudStatus: 'Stopped' }]} onNodeAction={onNodeAction} />);
    expect((screen.getByRole('button', { name: '核验 DNS' }) as HTMLButtonElement).disabled).toBe(true);
    rerender(<RangeInstanceNodeDirectory nodes={[{ ...host, dns: undefined }]} onNodeAction={onNodeAction} />);
    expect(screen.queryByRole('button', { name: '核验 DNS' })).toBeNull();
  });
  it('keeps cloud Running independent from missing DNS proof', () => {
    render(<RangeInstanceNodeDirectory nodes={[host]} allowActions={false} />);
    expect(screen.getByText('运行中')).toBeTruthy();
    expect(screen.getByText('DNS 未验证')).toBeTruthy();
    expect(screen.queryByText('DNS 已生效')).toBeNull();
  });
  it('shows verified DNS only when returned with guest proof', () => {
    render(<RangeInstanceNodeDirectory nodes={[{ ...host, dnsVerification: verification }]} allowActions={false} />);
    expect(screen.getByText('DNS 已生效').className).toContain('admin-pill-success');
  });
  it('shows failure without changing Running and explains that the host will not be recreated', async () => {
    render(<RangeInstanceNodeDirectory nodes={[{ ...host, dnsVerification: { ...verification, status: 'failed', resolutionStatus: 'failed' } }]} allowActions={false} />);
    const status = screen.getByText('DNS 验证失败');
    fireEvent.focus(status);
    await waitFor(() => expect(screen.getAllByText(/失败不会自动重建实例/).length).toBeGreaterThan(0));
    expect(screen.getByText('运行中')).toBeTruthy();
    expect(screen.getAllByText(/实际 · 10.0.50.20：10.0.50.10/).length).toBeGreaterThan(0);
  });
  it('does not add a DNS state to automatic DNS hosts', () => {
    render(<RangeInstanceNodeDirectory nodes={[{ ...host, dns: undefined }]} allowActions={false} />);
    expect(screen.queryByText(/DNS 未验证/)).toBeNull();
  });
  it('reports unselected NIC changes independently of verified selected DNS', async () => {
    render(<RangeInstanceNodeDirectory nodes={[{...host,dnsVerification:{...verification,preservationStatus:'changed'}}]} allowActions={false} />);
    fireEvent.focus(screen.getByText('DNS 已生效'));
    await waitFor(() => expect(screen.getAllByText(/未选网卡 DNS 已变化/).length).toBeGreaterThan(0));
    expect(screen.getByText('运行中')).toBeTruthy();
  });

});
