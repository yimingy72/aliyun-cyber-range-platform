import { expect, it, vi } from 'vitest';
import { PlatformApiClient } from '../src/client';
it('sends exact draft identity and stable key without compiled configuration or credentials', async () => {
 const fetch = vi.fn(async (url: string, options?: RequestInit) => { expect(url).toBe('https://platform.example/admin/ranges/range%2F1/templates'); expect(options?.method).toBe('POST'); expect(options?.body).toBe(JSON.stringify({ name: 'Copy', expectedDraftRevision: 7 })); expect(new Headers(options?.headers).get('x-idempotency-key')).toBe('stable-copy'); return new Response(JSON.stringify({ templateId: 'new-template', visibility: 'private' })); });
 const client = new PlatformApiClient({ baseUrl: 'https://platform.example', token: 'fixture', fetch: fetch as typeof globalThis.fetch });
 await expect(client.saveRangeInstanceAsTemplate('range/1', { name: 'Copy', expectedDraftRevision: 7 }, { idempotencyKey: 'stable-copy' })).resolves.toMatchObject({ templateId: 'new-template' });
});
