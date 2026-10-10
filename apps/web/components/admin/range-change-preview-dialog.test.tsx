import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { RangeChangePreviewDialog } from './range-change-preview-dialog';
import type { RangeInstanceChangePreview } from '../../lib/admin-types';
const empty: RangeInstanceChangePreview = { id: 'preview', rangeInstanceId: 'range', kind: 'expected-topology-diff', expectedDraftRevision: 1, previewToken: 'opaque', expiresAt: '2099-01-01', sourceDigest: 'digest', addedHosts: [], deletedHosts: [], ruleChanges: [], resourceChanges: [], allowDnatRemoval: false, allowSnatRemoval: false };
afterEach(cleanup);
it('disables application for a layout-only preview with no cloud changes', () => {
  render(<RangeChangePreviewDialog preview={empty} pending={false} onClose={vi.fn()} onConfirm={vi.fn()} />);
  const dialog = screen.getByRole('dialog', { name: '确认应用变更' });
  expect((within(dialog).getByRole('button', { name: '确认应用变更' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText('没有需要应用的配置变化。')).toBeTruthy();
});
it('shows network creation and explicit host/disk/NIC reclamation before confirmation', () => {
  const confirm = vi.fn();
  render(<RangeChangePreviewDialog preview={{ ...empty, addedNetworks: [{ nodeId: 'switch-2', name: '新交换机', zoneKey: 'zone-2', cidr: '10.0.20.0/24' }], deletedHosts: [{ id: 'host-1', nodeId: 'host-1', name: '旧主机', instanceId: 'i-owned', systemDiskId: 'd-owned', dataDiskIds: [], diskIds: ['d-owned'], networkInterfaceIds: ['eni-owned'] }] }} pending={false} onClose={vi.fn()} onConfirm={confirm} />);
  expect(screen.getByText('10.0.20.0/24')).toBeTruthy();
  expect(screen.getByText('i-owned')).toBeTruthy();
  expect(screen.getByText('关联磁盘：d-owned')).toBeTruthy();
  expect(confirm).not.toHaveBeenCalled();
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '确认应用变更' }));
  expect(confirm).toHaveBeenCalledOnce();
});
