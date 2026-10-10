import { afterEach, describe, expect, it, vi } from 'vitest';
import { runRangeInstanceNodeAction } from './admin-api';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe('DNS verification HTTP request', () => {
  it('uses the fixed node action with an empty body and allows three minutes for guest readback', async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    const fetchMock = vi.fn(async (_input: string, _init?: RequestInit) => new Response(JSON.stringify({ status: 'verified', action: 'verify-dns', dnsVerification: { status: 'verified' } })));
    vi.stubGlobal('fetch', fetchMock);
    await expect(runRangeInstanceNodeAction('http://localhost:3001', 'fixture-token', 'range/1', 'host/1', 'verify-dns', {})).resolves.toMatchObject({ dnsVerification: { status: 'verified' } });
    expect(timeout).toHaveBeenCalledWith(180_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]).toEqual(['http://localhost:3001/admin/ranges/range%2F1/nodes/host%2F1/actions/verify-dns', expect.objectContaining({ method: 'POST', body: '{}', signal: controller.signal })]);
  });
});
