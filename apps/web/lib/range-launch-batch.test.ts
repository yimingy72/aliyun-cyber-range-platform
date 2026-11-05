import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearRangeLaunchBatch, readRangeLaunchBatch, saveRangeLaunchBatch, submitRangeLaunchBatch, type RangeLaunchBatchRequest } from './range-launch-batch';

const makeRequest = (quantity = 2): RangeLaunchBatchRequest => ({ fingerprint: 'fixture', key: 'fixture-key', payload: { templateId: 'template', name: '训练', expiresAt: '2100-01-01T00:00:00Z' }, expiresAtInput: '2100-01-01T08:00', quantity, accepted: [] });
beforeEach(() => window.sessionStorage.clear());
describe('range batch launch', () => {
  it.each([0, 100, 1.5, NaN])('rejects invalid quantity %s before any submission', async quantity => {
    const launch = vi.fn();
    await expect(submitRangeLaunchBatch(makeRequest(quantity), launch, () => true, vi.fn())).rejects.toThrow('1–99');
    expect(launch).not.toHaveBeenCalled();
  });
  it('preserves the original single-instance name and key', async () => {
    const request = makeRequest(1), launch = vi.fn().mockResolvedValue({ id: 'range' });
    await submitRangeLaunchBatch(request, launch, () => true, vi.fn());
    expect(launch).toHaveBeenCalledWith(request.payload, request.key);
  });
  it('accepts the documented upper bound with distinct numbered requests', async () => {
    const request = makeRequest(99), launch = vi.fn().mockResolvedValue({ id: 'range' });
    await submitRangeLaunchBatch(request, launch, () => true, vi.fn());
    expect(launch).toHaveBeenCalledTimes(99);
    expect(launch.mock.calls[98][0].name).toBe('训练-99');
    expect(new Set(launch.mock.calls.map(call => call[1])).size).toBe(99);
  });
  it('preserves partial receipts, replays only the unknown member and isolates browser scopes', async () => {
    const request = makeRequest(), launch = vi.fn().mockResolvedValueOnce({ id: 'one' }).mockRejectedValueOnce(new Error('lost'));
    saveRangeLaunchBatch('owner:workspace', request);
    const progress = () => saveRangeLaunchBatch('owner:workspace', request);
    await expect(submitRangeLaunchBatch(request, launch, () => true, progress)).rejects.toThrow('lost');
    const restored = readRangeLaunchBatch('owner:workspace')!;
    expect(restored.accepted).toEqual([{ id: 'one' }]);
    expect(readRangeLaunchBatch('other:workspace')).toBeNull();
    launch.mockResolvedValueOnce({ id: 'two' });
    await submitRangeLaunchBatch(restored, launch, () => true, vi.fn());
    expect(launch.mock.calls[2]).toEqual(launch.mock.calls[1]);
    clearRangeLaunchBatch('owner:workspace', 'another-key');
    expect(readRangeLaunchBatch('owner:workspace')).not.toBeNull();
    clearRangeLaunchBatch('owner:workspace', request.key);
    expect(readRangeLaunchBatch('owner:workspace')).toBeNull();
  });
  it('does not submit remaining members after the owner workspace changes', async () => {
    let current = true;
    const launch = vi.fn(async () => { current = false; return { id: 'one', status: 'pending_create' }; });
    await expect(submitRangeLaunchBatch(makeRequest(), launch, () => current, vi.fn())).rejects.toThrow('已停止');
    expect(launch).toHaveBeenCalledTimes(1);
  });
});
