import { describe, expect, it, vi } from 'vitest';
import { PlatformApiClient, PlatformApiError } from '../src/client';

const account = { id: 'Tencent/context', provider: 'tencent_cloud', isActive: false };
const input = { provider: 'tencent_cloud' as const, regionId: 'ap-nanjing', zoneId: 'ap-nanjing-1',
  accessKeyId: 'synthetic-key', accessKeySecret: 'synthetic-secret' };

function fixture(results: unknown[] = []) {
  const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(results.shift() ?? {}), { status: 200 }));
  const client = new PlatformApiClient({ baseUrl: 'https://fixture.invalid/', token: 'test-token', fetch });
  return { client, fetch };
}

describe('Tencent cloud API client routing', () => {
  it('lists active contexts by default and includes inactive only by explicit request', async () => {
    const { client, fetch } = fixture([[account], [account]]);
    expect(await client.listCloudAccountContexts()).toEqual([account]);
    await client.listCloudAccountContexts(true);
    expect(fetch.mock.calls[0]).toMatchObject(['https://fixture.invalid/admin/cloud-contexts', { method: 'GET',
      headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' } }]);
    expect(fetch.mock.calls[1]?.[0]).toBe('https://fixture.invalid/admin/cloud-contexts?includeInactive=true');
  });

  it.each([{ operationId: 'operation', result: account },
    { operationId: 'operation', result: { result: account } },
    { operationId: 'operation', status: 'succeeded', result: { result: account } }])('unwraps the confirmed and replayed save %j with exact headers and body', async result => {
    const { client, fetch } = fixture([result]);
    expect(await client.saveTencentCloudAccount(input, { idempotencyKey: 'stable-key', confirmationId: 'confirmed' })).toEqual(account);
    expect(fetch.mock.calls[0]).toMatchObject(['https://fixture.invalid/admin/cloud-contexts', { method: 'POST',
      body: JSON.stringify(input), headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json',
        'x-idempotency-key': 'stable-key', 'x-confirmation-id': 'confirmed' } }]);
    expect(JSON.parse(fetch.mock.calls[0]?.[1]?.body as string)).not.toHaveProperty('confirmationId');
  });

  it('sends discovery credentials in a POST body and encodes account IDs with the exact image pagination and size query', async () => {
    const { client, fetch } = fixture();
    const regions = { regionIds: ['ap-nanjing', 'ap-shanghai'], accessKeyId: input.accessKeyId, accessKeySecret: input.accessKeySecret };
    await client.discoverTencentCloudRegions(regions);
    const id = 'Tencent/账号?&%';
    await client.listTencentCloudImages({ cloudAccountContextId: id, scope: 'public', offset: 0, limit: 100 });
    await client.listTencentCloudImages({ cloudAccountContextId: id, scope: 'custom' });
    await client.getCloudAccountInstanceTypeAvailability(id, 2, 4);
    expect(fetch.mock.calls[0]).toMatchObject(['https://fixture.invalid/admin/tencent-cloud/regions/query', { method: 'POST', body: JSON.stringify(regions) }]);
    expect(fetch.mock.calls[1]?.[0]).toBe(`https://fixture.invalid/admin/tencent-cloud/contexts/${encodeURIComponent(id)}/images?scope=public&offset=0&limit=100`);
    expect(fetch.mock.calls[2]?.[0]).toBe(`https://fixture.invalid/admin/tencent-cloud/contexts/${encodeURIComponent(id)}/images?scope=custom`);
    expect(fetch.mock.calls[3]?.[0]).toBe(`https://fixture.invalid/admin/cloud-contexts/${encodeURIComponent(id)}/instance-type-availability?cpu=2&memory=4`);
    for (const call of fetch.mock.calls) {
      expect(call[0]).not.toContain(input.accessKeyId);
      expect(call[0]).not.toContain(input.accessKeySecret);
    }
  });

  it('preserves confirmation failure details instead of treating a challenge as a saved account', async () => {
    const challenge = { code: 'CONFIRMATION_REQUIRED', confirmationId: 'confirmed', idempotencyKey: 'stable-key' };
    const client = new PlatformApiClient({ baseUrl: 'https://fixture.invalid', token: 'token',
      fetch: vi.fn(async () => new Response(JSON.stringify(challenge), { status: 409 })) });
    const error = await client.saveTencentCloudAccount(input).catch(value => value);
    expect(error).toBeInstanceOf(PlatformApiError);
    expect(error.status).toBe(409);
    expect(error.details).toEqual(challenge);
  });
});
