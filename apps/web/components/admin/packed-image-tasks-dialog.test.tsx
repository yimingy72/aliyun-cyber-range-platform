import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PackedImageTask } from '@/lib/admin-types';

const api = vi.hoisted(() => ({ list: vi.fn(), verify: vi.fn() }));
vi.mock('@/lib/admin-api', () => ({ fetchPackedImageTasks: api.list, verifyPackedImageTask: api.verify }));
vi.mock('./cloud-workspace-provider', () => ({ useCloudWorkspace: () => null }));
import { PackedImageTasksDialog } from './packed-image-tasks-dialog';

const task: PackedImageTask = {
  id: 'original-task', status: 'creating', state: 'blocked', displayName: '临时打包镜像', sourceRangeInstanceId: 'temporary-instance',
  sourceHostKey: 'host', sourceInstanceId: 'i-temp', sourceName: '临时实例', instanceMode: 'single', cloudProvider: 'alibaba_cloud', regionId: 'cn-beijing',
  imageId: 'm-original', sourceSnapshotId: 'catalog-original', platformImageAssetId: 'asset-original', cloudImageStatus: 'Creating 50%',
  backingSnapshotIds: ['s-original'], deletedSnapshotIds: [], createdAt: '2026-10-21T00:00:00Z', updatedAt: '2026-10-21T00:01:00Z',
  lastPolledAt: '2026-10-21T00:01:00Z', completedAt: null, diagnostic: { phase: 'describe_image', cloudErrorCode: 'Forbidden.RAM', cloudRequestId: 'request-original' },
  message: '原任务核验受阻。', nextStep: '补齐权限后核验原任务，不要重新打包。', canVerify: true,
};
const props = { apiBaseUrl: 'http://localhost:3001', token: 'fixture-token', open: true, onOpenChange: vi.fn(), sourceRangeInstanceId: 'temporary-instance', initialTaskId: task.id };

beforeEach(() => {
  vi.clearAllMocks(); window.localStorage.clear(); api.list.mockResolvedValue([task]);
  api.verify.mockResolvedValue({ ...task, status: 'available', state: 'available', diagnostic: null, cloudImageStatus: 'Available', canVerify: false });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('Original packed-image task workflow', () => {
  it('shows exact failure evidence and reconciles the same task once, without another create', async () => {
    let finish!: (value: PackedImageTask) => void;
    api.verify.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    render(<PackedImageTasksDialog {...props} />);
    const button = await screen.findByRole('button', { name: '核验并恢复' });
    expect(api.list).toHaveBeenCalledWith(props.apiBaseUrl, props.token, 'temporary-instance');
    expect(screen.getByText('Forbidden.RAM')).toBeTruthy();
    fireEvent.click(screen.getByText('技术信息与快照'));
    expect(screen.getByText('request-original')).toBeTruthy();
    expect(screen.getByText('查询原云镜像未完成')).toBeTruthy();
    fireEvent.click(button); fireEvent.click(button);
    expect(api.verify).toHaveBeenCalledTimes(1);
    expect(api.verify).toHaveBeenCalledWith(props.apiBaseUrl, props.token, task.id);
    await act(async () => finish({ ...task, status: 'available', state: 'available', diagnostic: null, cloudImageStatus: 'Available', canVerify: false }));
    expect(await screen.findByText(/核验完成：已完成/)).toBeTruthy();
    expect(screen.queryByText('Forbidden.RAM')).toBeNull();
    expect(screen.queryByRole('button', { name: '核验并恢复' })).toBeNull();
  });

  it('keeps the original outcome unconfirmed and shows audit permission errors without offering retry-create', async () => {
    api.list.mockResolvedValue([{ ...task, imageId: null, state: 'unconfirmed', diagnostic: { phase: 'rejection_audit', cloudErrorCode: 'Forbidden.RAM', cloudRequestId: 'audit-request' } }]);
    render(<PackedImageTasksDialog {...props} />);
    expect(await screen.findByText('提交结果待确认')).toBeTruthy();
    expect(screen.getByText('查询原请求官方审计回执未完成')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /重新打包|重试创建/ })).toBeNull();
  });

  it.each(['rejected', 'deleted', 'deleting', 'needs_review'] as const)('does not offer reconciliation that could create or delete for %s', async state => {
    api.list.mockResolvedValue([{ ...task, state, status: state === 'rejected' ? 'failed' : state, canVerify: false }]);
    render(<PackedImageTasksDialog {...props} />);
    await screen.findByRole('region', { name: '镜像导出详情' });
    expect(screen.queryByRole('button', { name: '核验并恢复' })).toBeNull();
    expect(api.verify).not.toHaveBeenCalled();
  });

  it('retains previously read tasks when a list refresh fails', async () => {
    render(<PackedImageTasksDialog {...props} />);
    await screen.findByRole('button', { name: '核验并恢复' });
    api.list.mockRejectedValueOnce(new Error('fixture refresh failure'));
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('fixture refresh failure'));
    expect(screen.getByText('Forbidden.RAM')).toBeTruthy();
  });

  it('discards a late verification after the authenticated scope changes', async () => {
    let finish!: (value: PackedImageTask) => void;
    api.verify.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const view = render(<PackedImageTasksDialog {...props} />);
    fireEvent.click(await screen.findByRole('button', { name: '核验并恢复' }));
    api.list.mockResolvedValue([]);
    view.rerender(<PackedImageTasksDialog {...props} token="new-user-token" initialTaskId={null} />);
    await waitFor(() => expect(api.list).toHaveBeenCalledWith(props.apiBaseUrl, 'new-user-token', 'temporary-instance'));
    await act(async () => finish({ ...task, displayName: 'must-not-leak', state: 'available' }));
    expect(screen.queryByText('must-not-leak')).toBeNull();
    expect(screen.queryByText('Forbidden.RAM')).toBeNull();
  });

  it('keeps pagination clamped and searches by exact task or image identifiers', async () => {
    api.list.mockResolvedValue(Array.from({ length: 25 }, (_, index) => ({ ...task, id: `task-${index}`, displayName: `镜像-${index}` })));
    render(<PackedImageTasksDialog {...props} initialTaskId={null} />);
    await screen.findByText('镜像-0');
    fireEvent.change(screen.getByRole('textbox', { name: '搜索导出记录' }), { target: { value: 'task-24' } });
    expect(screen.getByText('镜像-24')).toBeTruthy();
    expect(screen.queryByText('镜像-0')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '查看详情 镜像-24' }));
    expect(screen.getByRole('region', { name: '镜像导出详情' })).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
    expect(api.verify).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '返回导出记录' }));
    expect(screen.getByRole('textbox', { name: '搜索导出记录' })).toHaveProperty('value', 'task-24');
    expect(screen.getByText('镜像-24')).toBeTruthy();
  });
});
