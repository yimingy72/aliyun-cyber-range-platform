import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyRangeInstanceDraft, previewRangeInstanceDraft, saveRangeInstanceAsTemplate } from './admin-api';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe('runtime topology requests', () => {
  it('binds preview/apply to the saved revision and uses the returned preview token', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);
    await previewRangeInstanceDraft('http://localhost:3001', 'token', 'range/1', 7);
    await applyRangeInstanceDraft('http://localhost:3001', 'token', 'range/1', 7, 'opaque-preview-token');
    expect(fetchMock.mock.calls[0]).toEqual(['http://localhost:3001/admin/ranges/range%2F1/preview', expect.objectContaining({ method: 'POST', body: '{"expectedDraftRevision":7}' })]);
    expect(fetchMock.mock.calls[1]).toEqual(['http://localhost:3001/admin/ranges/range%2F1/apply', expect.objectContaining({ method: 'POST', body: '{"expectedDraftRevision":7,"previewToken":"opaque-preview-token"}' })]);
  });
  it('sends the stable idempotency key for a new private topology without syncing the original', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);
    await saveRangeInstanceAsTemplate('http://localhost:3001', 'token', 'range/1', { name: '副本', expectedDraftRevision: 7 }, 'same-request-key');
    expect(fetchMock.mock.calls[0]).toEqual(['http://localhost:3001/admin/ranges/range%2F1/templates', expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ 'x-idempotency-key': 'same-request-key' }), body: '{"name":"副本","expectedDraftRevision":7}' })]);
  });
});
