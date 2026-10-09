import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminApiError, discoverTencentCloudRegions, fetchCloudAccountContexts, fetchTencentCloudImages, saveTencentCloudAccount } from './admin-api';

afterEach(() => vi.unstubAllGlobals());
const payload = { provider: 'tencent_cloud' as const, regionId: 'ap-nanjing', zoneId: 'ap-nanjing-1', accessKeyId: 'synthetic-key', accessKeySecret: 'synthetic-secret' };

describe('Tencent web API requests', () => {
  it('lists inactive accounts only by explicit request, preserving each provider in the response', async () => {
    const accounts = [{ id: 'Aliyun context', provider: 'alibaba_cloud' }, { id: 'Tencent context', provider: 'tencent_cloud' }];
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(accounts), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    expect(await fetchCloudAccountContexts('https://fixture.invalid', 'token')).toEqual(accounts);
    fetch.mockResolvedValue(new Response(JSON.stringify(accounts), { status: 200 }));
    await fetchCloudAccountContexts('https://fixture.invalid', 'token', true);
    expect(fetch.mock.calls[0]?.[0]).toBe('https://fixture.invalid/admin/cloud-contexts');
    expect(fetch.mock.calls[1]?.[0]).toBe('https://fixture.invalid/admin/cloud-contexts?includeInactive=true');
  });

  it('saves only explicit Tencent fields and posts discovery credentials without putting them into URLs', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ id: 'Tencent context', provider: 'tencent_cloud' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ provider: 'tencent_cloud', regions: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    expect(await saveTencentCloudAccount('https://fixture.invalid', 'token', payload)).toEqual({ id: 'Tencent context', provider: 'tencent_cloud' });
    const regions = { regionIds: ['ap-nanjing'], accessKeyId: payload.accessKeyId, accessKeySecret: payload.accessKeySecret };
    await discoverTencentCloudRegions('https://fixture.invalid', 'token', regions);
    expect(fetch.mock.calls[0]).toEqual(['https://fixture.invalid/admin/cloud-contexts', { method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }]);
    expect(fetch.mock.calls[1]).toEqual(['https://fixture.invalid/admin/tencent-cloud/regions/query', { method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' }, body: JSON.stringify(regions) }]);
    expect(fetch.mock.calls[0]?.[0]).not.toContain(payload.accessKeySecret);
    expect(fetch.mock.calls[1]?.[0]).not.toContain(payload.accessKeySecret);
  });

  it('encodes a selected account ID and sends exact zero-offset pagination, without choosing an account implicitly', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ provider: 'tencent_cloud', items: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ provider: 'tencent_cloud', items: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const id = 'Tencent/账号?&%';
    await fetchTencentCloudImages('https://fixture.invalid', 'token', { cloudAccountContextId: id, scope: 'custom', offset: 0, limit: 20 });
    await fetchTencentCloudImages('https://fixture.invalid', 'token', { cloudAccountContextId: id, scope: 'public' });
    expect(fetch.mock.calls[0]?.[0]).toBe(`https://fixture.invalid/admin/tencent-cloud/contexts/${encodeURIComponent(id)}/images?scope=custom&offset=0&limit=20`);
    expect(fetch.mock.calls[1]?.[0]).toBe(`https://fixture.invalid/admin/tencent-cloud/contexts/${encodeURIComponent(id)}/images?scope=public`);
  });

  it('preserves authentication and server refusal status for the settings UI', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: '腾讯云账号校验失败。' }), { status: 403 })));
    const error = await saveTencentCloudAccount('https://fixture.invalid', 'token', payload).catch(value => value);
    expect(error).toBeInstanceOf(AdminApiError);
    expect(error.status).toBe(403);
    expect(error.message).toBe('腾讯云账号校验失败。');
  });
});
