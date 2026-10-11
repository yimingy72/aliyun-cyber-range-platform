import { expect, it, vi } from 'vitest';
import { PlatformApiClient } from '../src/client';

it('passes the explicit all-template view without dropping the selected workspace', async () => {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    expect(url).toBe('https://platform.example/admin/scenarios?view=all');
    expect(init?.headers).toMatchObject({ 'x-cloud-workspace-id': 'workspace-a' });
    return new Response(JSON.stringify([{ id: 'other-owner-draft', canManage: true }]));
  });
  const client = new PlatformApiClient({ baseUrl: 'https://platform.example', token: 'fixture', cloudWorkspaceId: 'workspace-a', fetch: fetchMock as typeof fetch });
  await expect(client.listRangeTemplates('all')).resolves.toEqual([{ id: 'other-owner-draft', canManage: true }]);
});
