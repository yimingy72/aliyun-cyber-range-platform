import { describe, expect, it, vi } from 'vitest';
import { PlatformApiClient, PlatformApiError } from '../src/client';

describe('discard saved runtime draft', () => {
  it('sends the caller revision and workspace without operation metadata or a new graph', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ id: 'range/owned', draftRevision: 8, draftTopologyGraph: null })));
    const client = new PlatformApiClient({ baseUrl: 'https://fixture.invalid', token: 'actor-fixture', cloudWorkspaceId: 'space', fetch });
    await expect(client.discardRangeInstanceDraft('range/owned', 7)).resolves.toMatchObject({ draftRevision: 8 });
    expect(fetch).toHaveBeenCalledWith('https://fixture.invalid/admin/ranges/range%2Fowned/draft?expectedDraftRevision=7', expect.objectContaining({ method: 'DELETE', body: undefined, headers: { Authorization: 'Bearer actor-fixture', 'Content-Type': 'application/json', 'x-cloud-workspace-id': 'space' } }));
  });
  it('returns the original conflict without retrying and clearing another draft', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ statusCode: 409, message: 'draft changed' }), { status: 409 }));
    const client = new PlatformApiClient({ baseUrl: 'https://fixture.invalid', token: 'actor-fixture', fetch });
    await expect(client.discardRangeInstanceDraft('range', 7)).rejects.toBeInstanceOf(PlatformApiError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
