import { afterEach, describe, expect, it, vi } from 'vitest';
import { submitInstancePower, previewInstancePower, cancelInstancePowerSchedule } from './instance-power-api';
import type { InstancePowerPreview } from './admin-types';
const selection = vi.hoisted(() => ({ workspace: 'original-space' }));
vi.mock('./cloud-workspace-selection', () => ({ readCloudWorkspaceSelection: () => selection.workspace }));
const preview: InstancePowerPreview = { target: { kind: 'single', id: 'instance/one' }, action: 'economical_stop', scheduledAt: null, planDigest: 'a'.repeat(64),
  plans: [{ instanceId: 'instance/one', instanceName: 'Temp', hosts: [{ instanceId: 'i-original', nodeId: 'host', name: 'Host', originalStatus: 'Running', originalStoppedMode: null }], expiresAt: null }], skipped: [], warnings: ['原到期不变'], replacingSchedule: false };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const challenge = (overrides = {}) => json({ code: 'CONFIRMATION_REQUIRED', confirmationId: 'confirm', idempotencyKey: 'power-key',
  summary: { action: 'economical_stop', scheduledAt: null, instances: [{ id: 'instance/one', hostCount: 1 }], ...overrides } }, 409);
afterEach(() => { vi.unstubAllGlobals(); selection.workspace = 'original-space'; });
describe('power confirmation transport', () => {
  it('retains exact target, payload, key and workspace on confirmation', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(challenge()).mockResolvedValueOnce(json({ status: 'accepted' })); vi.stubGlobal('fetch', fetcher);
    await submitInstancePower('http://api', 'token', preview, { idempotencyKey: 'power-key' });
    expect(fetcher.mock.calls[0][0]).toBe('http://api/admin/instance-power/single/instance%2Fone');
    expect(fetcher.mock.calls[1][1].body).toBe(fetcher.mock.calls[0][1].body);
    expect(fetcher.mock.calls[1][1].headers).toMatchObject({ 'x-cloud-workspace-id': 'original-space', 'x-idempotency-key': 'power-key', 'x-confirmation-id': 'confirm' });
  });
  it.each([{ action: 'resume' }, { scheduledAt: '2028-01-01T00:00:00.000Z' }, { instances: [{ id: 'foreign', hostCount: 1 }] }])('refuses a changed challenge %j', async mismatch => {
    const fetcher = vi.fn(async () => challenge(mismatch)); vi.stubGlobal('fetch', fetcher);
    await expect(submitInstancePower('', 'token', preview, { idempotencyKey: 'power-key' })).rejects.toThrow('不符'); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('does not auto-resubmit an unknown response', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(challenge()).mockRejectedValueOnce(new TypeError('network lost')); vi.stubGlobal('fetch', fetcher);
    await expect(submitInstancePower('', 'token', preview, { idempotencyKey: 'power-key' })).rejects.toThrow('network lost'); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('stops confirmation replay if the selected workspace changes', async () => {
    const fetcher = vi.fn(async () => { selection.workspace = 'different-space'; return challenge(); }); vi.stubGlobal('fetch', fetcher);
    await expect(submitInstancePower('', 'token', preview, { idempotencyKey: 'power-key' })).rejects.toThrow('空间已切换'); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('previews a timezone-qualified appointment and cancels exact schedule versions', async () => {
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => json(preview)); vi.stubGlobal('fetch', fetcher);
    await previewInstancePower('', 'token', preview.target, 'economical_stop', '2028-01-01T01:30:00.000Z');
    expect(new URL('http://api' + fetcher.mock.calls[0][0]).searchParams.get('scheduledAt')).toBe('2028-01-01T01:30:00.000Z');
    const schedules = [{ instanceId: 'instance/one', scheduleId: 'schedule', revision: 2 }];
    await cancelInstancePowerSchedule('', 'token', preview.target, schedules, { idempotencyKey: 'cancel' });
    expect(JSON.parse(fetcher.mock.calls[1][1]!.body as string)).toEqual({ schedules });
  });
});
