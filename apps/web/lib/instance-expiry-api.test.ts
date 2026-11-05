import { afterEach, describe, expect, it, vi } from 'vitest';
import { submitInstanceExpiry, type ExpiryPreview } from './instance-expiry-api';
const selected = vi.hoisted(() => ({ id: 'space' }));
vi.mock('./cloud-workspace-selection', () => ({ readCloudWorkspaceSelection: () => selected.id }));
const preview: ExpiryPreview = { target: { kind: 'range', id: 'range/1' }, expiresAt: '2027-01-01T00:00:00.000Z', planDigest: 'a'.repeat(64),
  plans: [{ instanceId: 'range/1', instanceName: 'Test', expiresAt: '2026-12-31T00:00:00.000Z', requestedExpiresAt: '2027-01-01T00:00:00.000Z', cloudReleaseAt: '2027-01-01T00:05:00Z', hosts: [{ instanceId: 'i-original' }] }], skipped: [], warnings: [] };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const challenge = (summary = {}) => json({ code: 'CONFIRMATION_REQUIRED', confirmationId: 'confirmation', idempotencyKey: 'original-key',
  summary: { target: preview.target, expiresAt: preview.expiresAt, planDigest: preview.planDigest,
    instances: [{ id: 'range/1', previousExpiresAt: preview.plans[0].expiresAt }], ...summary } }, 409);
afterEach(() => { vi.unstubAllGlobals(); selected.id = 'space'; });
describe('expiry request confirmation', () => {
  it('preserves the exact payload, workspace and key on confirmation', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(challenge()).mockResolvedValueOnce(json({ status: 'accepted' })); vi.stubGlobal('fetch', fetcher);
    await submitInstanceExpiry('', 'token', preview, { idempotencyKey: 'original-key' });
    expect(fetcher.mock.calls[0][0]).toBe('/admin/instance-expiry/range/range%2F1');
    expect(fetcher.mock.calls[1][1].body).toBe(fetcher.mock.calls[0][1].body);
    expect(fetcher.mock.calls[1][1].headers).toMatchObject({ 'x-cloud-workspace-id': 'space', 'x-idempotency-key': 'original-key', 'x-confirmation-id': 'confirmation' });
  });
  it.each([{ expiresAt: '2028-01-01T00:00:00Z' }, { planDigest: 'other' }, { target: { kind: 'single', id: 'range/1' } },
    { instances: [{ id: 'foreign', previousExpiresAt: preview.plans[0].expiresAt }] }])('does not accept a changed confirmation %j', async summary => {
    const fetcher = vi.fn(async () => challenge(summary)); vi.stubGlobal('fetch', fetcher);
    await expect(submitInstanceExpiry('', 'token', preview, { idempotencyKey: 'original-key' })).rejects.toThrow('不符');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('does not confirm after switching workspace', async () => {
    const fetcher = vi.fn(async () => { selected.id = 'other'; return challenge(); }); vi.stubGlobal('fetch', fetcher);
    await expect(submitInstanceExpiry('', 'token', preview, { idempotencyKey: 'original-key' })).rejects.toThrow('空间已切换');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('does not replay confirmation after the initiating dialog/session is gone', async () => {
    const abort = new AbortController();
    const fetcher = vi.fn(async () => { abort.abort(); return challenge(); }); vi.stubGlobal('fetch', fetcher);
    await expect(submitInstanceExpiry('', 'token', preview, { idempotencyKey: 'original-key' }, abort.signal)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('preserves the original request after an unknown response and never automatically sends it again', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(challenge()).mockRejectedValueOnce(new Error('network lost')); vi.stubGlobal('fetch', fetcher);
    const operation = { idempotencyKey: 'original-key' };
    await expect(submitInstanceExpiry('', 'token', preview, operation)).rejects.toThrow('network lost');
    expect(fetcher).toHaveBeenCalledTimes(2); expect(operation).toMatchObject({ confirmationId: 'confirmation' });
  });
});
