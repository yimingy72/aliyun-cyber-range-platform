import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchRangeRecoveryStatus, triggerRangeAction } from './admin-api';
import { writeAdminSession } from './admin-auth-storage';
import { setCloudWorkspaceSelection } from './cloud-workspace-selection';

describe('range recovery HTTP contract', () => {
  beforeEach(() => {
    writeAdminSession({ token: 'fixture-token', profile: { id: 'owner', username: 'owner', role: 'user' } });
    setCloudWorkspaceSelection('owner', 'workspace');
  });
  afterEach(() => { vi.unstubAllGlobals(); window.localStorage.clear(); window.sessionStorage.clear(); });
  it.each(['retry', 'destroy'] as const)('uses the same key for %s POST and read-only receipt GET', async trigger => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ state: 'unconfirmed' }) });
    vi.stubGlobal('fetch', fetchMock);
    await triggerRangeAction('https://fixture.invalid', 'fixture-token', 'range', trigger, 'original-key');
    await fetchRangeRecoveryStatus('https://fixture.invalid', 'fixture-token', 'range', trigger, 'original-key');
    expect(fetchMock.mock.calls[0][0]).toBe(`https://fixture.invalid/admin/ranges/range/${trigger}`);
    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
    expect(fetchMock.mock.calls[1][0]).toBe(`https://fixture.invalid/admin/ranges/range/recovery/${trigger}`);
    expect(fetchMock.mock.calls[1][1].method ?? 'GET').toBe('GET');
    for (const [, options] of fetchMock.mock.calls) expect(options.headers).toMatchObject({
      Authorization: 'Bearer fixture-token', 'x-cloud-workspace-id': 'workspace', 'x-idempotency-key': 'original-key',
    });
  });
  it.each([{ state: 'unconfirmed' }, { state: 'accepted', jobId: 'job' }, { state: 'rejected', errorCode: null }])('returns the exact receipt union %j', async receipt => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => receipt }));
    expect(await fetchRangeRecoveryStatus('https://fixture.invalid', 'fixture-token', 'range', 'retry', 'key')).toEqual(receipt);
  });
});
