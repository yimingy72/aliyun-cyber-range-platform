import { describe, expect, it, vi } from 'vitest';
import { PlatformApiClient, PlatformApiError } from '../src/client';

describe('immutable workspace transport', () => {
  it('deletes the exact encoded binding while preserving caller scope and confirmation', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ id: 'space-b', retainedData: true })));
    const client = new PlatformApiClient({ baseUrl: 'https://fixture.invalid', token: 'actor-a', cloudWorkspaceId: 'space-a', fetch });
    expect(await client.deleteCloudWorkspace('space/b', { idempotencyKey: 'remove-once', confirmationId: 'confirmed-b' })).toMatchObject({ retainedData: true });
    expect(fetch).toHaveBeenCalledWith('https://fixture.invalid/admin/cloud-workspaces/space%2Fb', expect.objectContaining({ method: 'DELETE',
      headers: expect.objectContaining({ 'x-cloud-workspace-id': 'space-a', 'x-idempotency-key': 'remove-once', 'x-confirmation-id': 'confirmed-b' }) }));
  });
  it.each(['', ' ', 'x'.repeat(193)])('rejects an invalid explicit scope without falling back to another account', cloudWorkspaceId => {
    const fetch = vi.fn();
    expect(() => new PlatformApiClient({ baseUrl: 'https://fixture.invalid', token: 'fixture', cloudWorkspaceId, fetch })).toThrow('Invalid cloud workspace selection');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('freezes explicit scope across reads, writes, CSV exports and a user default switch', async () => {
    const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response('{}'));
    const options = { baseUrl: 'https://fixture.invalid', token: 'actor-a', cloudWorkspaceId: 'space-a', fetch };
    const client = new PlatformApiClient(options);
    options.cloudWorkspaceId = 'space-b';
    await client.listCloudWorkspaces(); await client.getCurrentCloudWorkspace(); await client.switchCloudWorkspace('space-b');
    await client.listPlatformImages(); await client.saveCloudAccountBinding({ provider: 'alibaba_cloud', cloudWorkspaceId: 'space-a', regionId: 'cn-hangzhou', zoneId: 'cn-hangzhou-h', accessKeyId: 'fixture-key', accessKeySecret: 'fixture-secret' }, { idempotencyKey: 'same-business-key', confirmationId: 'confirmed-a' });
    await client.exportPlatformBillingCsv();
    for (const [, init] of fetch.mock.calls) expect(init).toMatchObject({ headers: { Authorization: 'Bearer actor-a', 'x-cloud-workspace-id': 'space-a' } });
    expect(fetch.mock.calls[2]?.[0]).toBe('https://fixture.invalid/admin/cloud-workspaces/space-b/switch');
    expect(fetch.mock.calls[4]?.[1]).toMatchObject({ headers: { 'x-idempotency-key': 'same-business-key', 'x-confirmation-id': 'confirmed-a' } });
  });
  it('keeps identical idempotency keys scoped to each actor and workspace and preserves confirmation challenges', async () => {
    const calls: Array<{ headers: Record<string, string> }> = [];
    const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const headers = init!.headers as Record<string, string>; calls.push({ headers });
      return new Response(JSON.stringify({ code: 'CONFIRMATION_REQUIRED', confirmationId: `${headers.Authorization}:${headers['x-cloud-workspace-id']}` }), { status: 409 });
    });
    const payload = { provider: 'tencent_cloud' as const, regionId: 'ap-nanjing', zoneId: 'ap-nanjing-1', accessKeyId: 'fixture-key', accessKeySecret: 'fixture-secret' };
    const a = new PlatformApiClient({ baseUrl: 'https://fixture.invalid', token: 'actor-a', cloudWorkspaceId: 'space-a', fetch });
    const b = new PlatformApiClient({ baseUrl: 'https://fixture.invalid', token: 'actor-b', cloudWorkspaceId: 'space-b', fetch });
    const failures = await Promise.all([a.saveCloudAccountBinding(payload, { idempotencyKey: 'same-key' }).catch(error => error), b.saveCloudAccountBinding(payload, { idempotencyKey: 'same-key' }).catch(error => error)]);
    failures.forEach(error => expect(error).toBeInstanceOf(PlatformApiError));
    expect(failures[0].details.confirmationId).not.toBe(failures[1].details.confirmationId);
    expect(calls.map(call => call.headers['x-idempotency-key'])).toEqual(['same-key', 'same-key']);
    expect(calls.map(call => call.headers['x-cloud-workspace-id'])).toEqual(['space-a', 'space-b']);
  });
});
