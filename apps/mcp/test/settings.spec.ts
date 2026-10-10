import { describe, expect, it, vi } from 'vitest';
import { PlatformApiClient } from '@aliyun-cyber-range/platform-api-client';
import { createToolRegistry } from '../src/server';

const raw = Object.freeze({ provider: 'alibaba_cloud', defaultRegion: 'cn-hangzhou', defaultZoneId: 'cn-hangzhou-h', accessKeyId: 'synthetic-access-key', accessKeySecret: 'synthetic-access-secret' });
describe('Settings tool sensitive output', () => {
  it('masks both keys on read without modifying the downstream snapshot', async () => {
    const registry = createToolRegistry({ fetchCloudConfig: vi.fn(async () => raw) } as never);
    const result = await registry.callTool('cloud_config_get', ['settings:read'], {});
    expect(result.structuredContent.result).toEqual({ ...raw, accessKeyId: '********', accessKeySecret: '********' });
    expect(JSON.stringify(result)).not.toContain(raw.accessKeyId); expect(JSON.stringify(result)).not.toContain(raw.accessKeySecret); expect(raw.accessKeyId).toBe('synthetic-access-key');
  });
  it.each([
    { operationId: 'op', result: { result: raw } },
    { operationId: 'op', status: 'succeeded', result: { result: raw }, errorCode: null },
  ])('masks first confirmed save and idempotent replay after the real client unwraps them', async (response) => {
    const client = new PlatformApiClient({ baseUrl: 'https://synthetic.invalid', token: 'synthetic-token', fetch: vi.fn(async () => new Response(JSON.stringify(response), { status: 200 })) });
    const registry = createToolRegistry(client);
    const result = await registry.callTool('cloud_config_update', ['settings:write'], { defaultRegion: 'cn-hangzhou', defaultZoneId: 'cn-hangzhou-h', confirmationId: 'confirm', idempotencyKey: 'key' }, 'admin');
    expect(result.structuredContent.result).toEqual({ ...raw, accessKeyId: '********', accessKeySecret: '********' });
    expect(JSON.stringify(result)).not.toContain(raw.accessKeyId); expect(JSON.stringify(result)).not.toContain(raw.accessKeySecret);
  });
  it('keeps unconfigured keys empty and rejects reusing masked keys', async () => {
    const registry = createToolRegistry({ fetchCloudConfig: vi.fn(async () => ({ ...raw, accessKeyId: '', accessKeySecret: '' })) } as never);
    expect((await registry.callTool('cloud_config_get', ['settings:read'], {})).structuredContent.result).toMatchObject({ accessKeyId: '', accessKeySecret: '' });
    for (const field of ['accessKeyId', 'accessKeySecret']) await expect(registry.callTool('cloud_config_update', ['settings:write'], { [field]: '********' }, 'admin')).rejects.toThrow('Masked access keys cannot be reused');
  });
});
