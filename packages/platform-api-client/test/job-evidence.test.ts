import { describe, expect, it, vi } from 'vitest';
import { PlatformApiClient } from '../src/client';

describe('getProvisionJob evidence option', () => {
  it('serializes the exact monthly diagnostic target list without any write request', async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ billingWrites: 0 })));
    const client = new PlatformApiClient({ baseUrl: 'https://platform.example', token: 'fixture-token', fetch: fetch as typeof globalThis.fetch });
    await expect(client.diagnoseBillingMonth({ billingCycle: '2026-10', ledgerIds: ['ledger-1', 'ledger-2'] })).resolves.toEqual({ billingWrites: 0 });
    expect(fetch.mock.calls[0][0]).toBe('https://platform.example/admin/billing/diagnostics/monthly?billingCycle=2026-10&ledgerIds=ledger-1%2Cledger-2');
    expect(fetch.mock.calls[0][1]?.method ?? 'GET').toBe('GET');
  });
  it('keeps the default URL unchanged and serializes only explicit flags', async () => {
    const urls: string[] = []; const fetch = vi.fn(async (url: string) => { urls.push(url); return new Response(JSON.stringify({ id: 'job/1' })); });
    const client = new PlatformApiClient({ baseUrl: 'https://platform.example', token: 'fixture-token', fetch: fetch as typeof globalThis.fetch });
    await client.getProvisionJob('job/1'); await client.getProvisionJob('job/1', {});
    await client.getProvisionJob('job/1', { includeEvidence: true }); await client.getProvisionJob('job/1', { includeEvidence: false });
    expect(urls).toEqual(['https://platform.example/admin/provision-jobs/job%2F1', 'https://platform.example/admin/provision-jobs/job%2F1',
      'https://platform.example/admin/provision-jobs/job%2F1?includeEvidence=true', 'https://platform.example/admin/provision-jobs/job%2F1?includeEvidence=false']);
  });
  it('encodes selected native cloud resource IDs without changing the job identity', async () => {
    const fetch = vi.fn(async (_url: string) => new Response(JSON.stringify({ id: 'job/1' })));
    const client = new PlatformApiClient({ baseUrl: 'https://platform.example', token: 'fixture-token', fetch: fetch as typeof globalThis.fetch });
    await client.getProvisionJob('job/1', { includeCloudEvents: true, cloudResourceIds: ['i-owned', 'd-owned'] });
    expect(fetch.mock.calls[0][0]).toBe('https://platform.example/admin/provision-jobs/job%2F1?includeCloudEvents=true&cloudResourceIds=i-owned%2Cd-owned');
  });
});
