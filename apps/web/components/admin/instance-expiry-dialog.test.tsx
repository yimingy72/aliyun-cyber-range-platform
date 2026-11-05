import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InstanceExpiryDialog } from './instance-expiry-dialog';
import { InstancePowerMenu } from './instance-power-menu';
import type { ExpiryPreview } from '@/lib/instance-expiry-api';
const api = vi.hoisted(() => ({ fetchInstanceExpiry: vi.fn(), previewInstanceExpiry: vi.fn(), submitInstanceExpiry: vi.fn(), verifyInstanceExpiry: vi.fn() }));
vi.mock('@/lib/instance-expiry-api', () => api);
vi.mock('@/components/ui/date-time-picker', () => ({ DateTimePicker: ({ value, onValueChange, ...props }: any) =>
  <input {...props} type="datetime-local" value={value} onChange={event => onValueChange(event.target.value)} /> }));
const future = () => new Date(Math.ceil((Date.now() + 2 * 3600_000) / 60_000) * 60_000).toISOString();
const local = (at: string) => new Date(Date.parse(at) + 8 * 3600_000).toISOString().slice(0, 16);
const props = { apiBaseUrl: '', token: 'token', scopeKey: 'scope', target: { kind: 'single' as const, id: 'row' }, name: 'Temporary', onClose: vi.fn(), onChanged: vi.fn() };
function ready() {
  const at = future(), old = new Date(Date.parse(at) - 3600_000).toISOString();
  const preview: ExpiryPreview = { target: props.target, expiresAt: at, planDigest: 'digest', plans: [
    { instanceId: 'row', instanceName: 'Temporary', expiresAt: old, requestedExpiresAt: at, cloudReleaseAt: at, hosts: [{ instanceId: 'i-original' }] }], warnings: ['延期须核验成功'], skipped: [] };
  api.fetchInstanceExpiry.mockResolvedValue({ instances: [{ id: 'row', name: 'Temporary', status: 'running', expiresAt: old }], jobs: [], warnings: [] });
  api.previewInstanceExpiry.mockResolvedValue(preview); api.submitInstanceExpiry.mockResolvedValue({ status: 'accepted' });
  return preview;
}
async function prepare(at: string) {
  await screen.findByText('当前平台回收时间');
  fireEvent.change(screen.getByLabelText('新回收时间（北京时间）'), { target: { value: local(at) } });
  fireEvent.click(screen.getByRole('button', { name: '预览修改' }));
  await screen.findByRole('button', { name: '确认修改' });
}
afterEach(() => { cleanup(); vi.resetAllMocks(); });
describe('expiry dialog', () => {
  it('previews a Beijing-time selection, then requires acknowledgement before submitting', async () => {
    const preview = ready(); render(<InstanceExpiryDialog {...props} />); await prepare(preview.expiresAt);
    expect(api.previewInstanceExpiry).toHaveBeenCalledWith('', 'token', props.target, preview.expiresAt);
    expect((screen.getByRole('button', { name: '确认修改' }) as HTMLButtonElement).disabled).toBe(true);
    expect(api.submitInstanceExpiry).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('checkbox', { name: '确认回收范围和时间' }));
    fireEvent.click(screen.getByRole('button', { name: '确认修改' }));
    await waitFor(() => expect(api.submitInstanceExpiry).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/修改任务已受理/)).toBeTruthy();
  });
  it('keeps original request identity when recovering an unknown submit response', async () => {
    const preview = ready(); api.submitInstanceExpiry.mockRejectedValueOnce(new Error('unknown'));
    render(<InstanceExpiryDialog {...props} />); await prepare(preview.expiresAt);
    fireEvent.click(screen.getByRole('checkbox', { name: '确认回收范围和时间' }));
    fireEvent.click(screen.getByRole('button', { name: '确认修改' }));
    await screen.findByText('unknown');
    const operation = api.submitInstanceExpiry.mock.calls[0][3];
    expect((screen.getByRole('button', { name: '返回修改' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '核对提交结果' }));
    await waitFor(() => expect(api.submitInstanceExpiry).toHaveBeenCalledTimes(2));
    expect(api.submitInstanceExpiry.mock.calls[1][3]).toBe(operation);
  });
  it('rejects past or too-close dates locally', async () => {
    ready(); render(<InstanceExpiryDialog {...props} />);
    await screen.findByText('当前平台回收时间');
    fireEvent.change(screen.getByLabelText('新回收时间（北京时间）'), { target: { value: '2020-01-01T01:00' } });
    fireEvent.click(screen.getByRole('button', { name: '预览修改' }));
    expect((await screen.findByRole('alert')).textContent).toContain('30 分钟'); expect(api.previewInstanceExpiry).not.toHaveBeenCalled();
  });
  it('does not leak an old preview into a new workspace', async () => {
    const preview = ready(); let resolve!: (value: ExpiryPreview) => void;
    api.previewInstanceExpiry.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const result = render(<InstanceExpiryDialog {...props} />); await screen.findByText('当前平台回收时间');
    fireEvent.change(screen.getByLabelText('新回收时间（北京时间）'), { target: { value: local(preview.expiresAt) } });
    fireEvent.click(screen.getByRole('button', { name: '预览修改' }));
    result.rerender(<InstanceExpiryDialog {...props} scopeKey="other" />);
    await act(async () => resolve(preview));
    expect(screen.queryByRole('button', { name: '确认修改' })).toBeNull();
  });
  it('shows batch scope and preserves per-instance failure detail', async () => {
    const preview = ready();
    api.fetchInstanceExpiry.mockResolvedValue({ instances: [{ id: 'row', name: 'Temporary', status: 'running', expiresAt: preview.plans[0].expiresAt }],
      jobs: [{ id: 'original-job', instanceId: 'row', status: 'failed', requestedExpiresAt: preview.expiresAt, error: 'Forbidden.RAM；请求 ID req-1' }], warnings: [] });
    render(<InstanceExpiryDialog {...props} target={{ kind: 'range_batch', id: 'batch' }} />);
    expect(await screen.findByRole('dialog', { name: '修改整批回收时间' })).toBeTruthy();
    expect(await screen.findByText('Forbidden.RAM；请求 ID req-1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '核验原任务', hidden: true }));
    await waitFor(() => expect(api.verifyInstanceExpiry).toHaveBeenCalledWith('', 'token', { kind: 'range_batch', id: 'batch' }, 'original-job'));
  });
  it('opens the new entry without performing a cloud write', async () => {
    ready(); render(<InstancePowerMenu {...props} label="更多" />);
    fireEvent.keyDown(screen.getByRole('button', { name: '更多操作' }), { key: 'Enter' });
    fireEvent.click(screen.getByRole('menuitem', { name: '修改回收时间' }));
    expect(await screen.findByRole('dialog', { name: '修改回收时间' })).toBeTruthy();
    expect(api.submitInstanceExpiry).not.toHaveBeenCalled(); expect(api.previewInstanceExpiry).not.toHaveBeenCalled();
  });
});
