import { expect, it, vi } from 'vitest';
import { PlatformApiClient } from '../src/client';
it('uses the saved revision for preview and binds apply to its exact token', async () => {
 const fetch = vi.fn(async (url: string, options?: RequestInit) => {
  if (url.endsWith('/preview')) { expect(options?.body).toBe('{"expectedDraftRevision":2}'); return new Response('{"previewToken":"approved","kind":"expected-topology-diff"}'); }
  expect(url).toBe('https://platform.example/admin/ranges/range%2F1/apply'); expect(options?.body).toBe('{"expectedDraftRevision":2,"previewToken":"approved"}'); return new Response('{"jobId":"update"}');
 });
 const client = new PlatformApiClient({ baseUrl: 'https://platform.example', token: 'fixture', fetch: fetch as typeof globalThis.fetch });
 const result = await client.previewRangeInstanceDraft('range/1', 2); await expect(client.applyRangeInstanceDraft('range/1', 2, result.previewToken)).resolves.toMatchObject({ jobId: 'update' });
});
