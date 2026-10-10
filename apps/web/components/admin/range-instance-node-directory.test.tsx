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
});
