import { describe, expect, it, vi } from 'vitest';
import { PlatformApiClient } from '../src/client';

describe('controlled DNS reapply SDK', () => {
 it('uses the existing node action endpoint with a bounded extended timeout', async () => {
  const timeout = vi.spyOn(AbortSignal, 'timeout');
  const fetch = vi.fn(async (url: string, options?: RequestInit) => {
   expect(url).toBe('https://platform.example/admin/ranges/range%2F1/nodes/host%2F1/actions/apply-dns');
   expect(options?.method).toBe('POST'); expect(options?.body).toBe('{}'); expect(options?.signal).toBeInstanceOf(AbortSignal);
   return new Response(JSON.stringify({ action: 'apply-dns', status: 'verified' }));
  });
  const client = new PlatformApiClient({ baseUrl: 'https://platform.example', token: 'fixture-token', fetch: fetch as typeof globalThis.fetch });
  try { await expect(client.runRangeInstanceNodeAction('range/1', 'host/1', 'apply-dns')).resolves.toMatchObject({ status: 'verified' }); expect(timeout).toHaveBeenCalledWith(240_000); } finally { timeout.mockRestore(); }
 });
});
