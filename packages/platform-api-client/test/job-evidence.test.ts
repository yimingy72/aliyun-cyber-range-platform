import { describe, expect, it, vi } from 'vitest';
import { PlatformApiClient } from '../src/client';

describe('getProvisionJob evidence option', () => {
  it('keeps the default URL unchanged and serializes only explicit flags', async () => {
    const urls: string[] = []; const fetch = vi.fn(async (url: string) => { urls.push(url); return new Response(JSON.stringify({ id: 'job/1' })); });
    const client = new PlatformApiClient({ baseUrl: 'https://platform.example', token: 'fixture-token', fetch: fetch as typeof globalThis.fetch });
    await client.getProvisionJob('job/1'); await client.getProvisionJob('job/1', {});
    await client.getProvisionJob('job/1', { includeEvidence: true }); await client.getProvisionJob('job/1', { includeEvidence: false });
    expect(urls).toEqual(['https://platform.example/admin/provision-jobs/job%2F1', 'https://platform.example/admin/provision-jobs/job%2F1',
      'https://platform.example/admin/provision-jobs/job%2F1?includeEvidence=true', 'https://platform.example/admin/provision-jobs/job%2F1?includeEvidence=false']);
  });
});
