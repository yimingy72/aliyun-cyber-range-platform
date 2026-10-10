import { describe, expect, it, vi } from 'vitest';
import { PlatformApiClient } from '@aliyun-cyber-range/platform-api-client';
import { createToolRegistry } from '../src/server';

const account = { id: 'tencent/context', provider: 'tencent_cloud', displayName: 'Tencent test account', accountUid: '100001',
  regionId: 'ap-nanjing', zoneId: 'ap-nanjing-1', isActive: false, status: 'ready', imageImportBucket: '', bucketStatus: 'not_configured' };
const payload = { provider: 'tencent_cloud', regionId: account.regionId, zoneId: account.zoneId,
  accessKeyId: 'synthetic-Tencent-key', accessKeySecret: 'synthetic-Tencent-secret' };
const names = ['cloud_account_context_list', 'tencent_cloud_account_save', 'tencent_cloud_region_list',
  'tencent_cloud_image_list', 'cloud_account_instance_type_availability'];
const scopes = ['settings:read', 'settings:write', 'images:read'];

describe('Tencent settings tools', () => {
  it('exposes all five tools only to administrators with the required scopes and correct read/write hints', async () => {
    const registry = createToolRegistry({} as never);
    const admin = registry.listTools(scopes, 'admin').filter(tool => names.includes(tool.name));
    expect(admin.map(tool => tool.name)).toEqual(names);
    expect(registry.listTools(scopes, 'user').map(tool => tool.name)).not.toEqual(expect.arrayContaining(names));
    for (const name of names) {
      expect(registry.listTools(scopes, 'user').map(tool => tool.name)).not.toContain(name);
      await expect(registry.callTool(name, scopes, {}, 'user')).rejects.toThrow('Forbidden tool');
    }
    expect(registry.listTools(['settings:read'], 'admin').map(tool => tool.name)).not.toContain('tencent_cloud_image_list');
    expect(registry.listTools(['images:read'], 'admin').map(tool => tool.name)).not.toContain('tencent_cloud_image_list');
    expect(registry.listTools(['settings:read'], 'admin').map(tool => tool.name)).not.toContain('tencent_cloud_account_save');
    for (const tool of admin) expect(tool.annotations.readOnlyHint).toBe(tool.name !== 'tencent_cloud_account_save');
  });

  it('whitelists account list and saved output so credentials and nested private fields never leak', async () => {
    const privateAccount = Object.freeze({ ...account, accessKeyId: payload.accessKeyId, accessKeySecret: payload.accessKeySecret,
      encryptedAccessKeySecret: 'private-ciphertext', credentials: { password: 'private-password' } });
    const list = vi.fn(async () => [privateAccount, { ...privateAccount, provider: 'alibaba_cloud', id: 'Aliyun context' }]);
    const save = vi.fn(async () => privateAccount);
    const registry = createToolRegistry({ listCloudAccountContexts: list, saveTencentCloudAccount: save } as never);
    expect((await registry.callTool(names[0]!, scopes, { includeInactive: true }, 'admin')).structuredContent.result).toEqual([
      account, { ...account, provider: 'alibaba_cloud', id: 'Aliyun context' },
    ]);
    expect(list).toHaveBeenCalledWith(true);
    const result = await registry.callTool(names[1]!, scopes, { ...payload, idempotencyKey: 'stable-key', confirmationId: 'confirmed' }, 'admin');
    expect(result.structuredContent.result).toEqual(account);
    expect(save).toHaveBeenCalledWith(payload, { idempotencyKey: 'stable-key', confirmationId: 'confirmed' });
    for (const value of [payload.accessKeyId, payload.accessKeySecret, 'private-ciphertext', 'private-password']) expect(JSON.stringify(result)).not.toContain(value);
    expect(privateAccount.accessKeySecret).toBe(payload.accessKeySecret);
  });

  it.each([{ ...account, provider: 'alibaba_cloud' }])('rejects a wrong-cloud save response %j', async result => {
    const registry = createToolRegistry({ saveTencentCloudAccount: async () => result } as never);
    await expect(registry.callTool('tencent_cloud_account_save', scopes, payload, 'admin')).rejects.toThrow();
  });

  it('accepts the existing active context when rebinding without claiming a workspace switch', async () => {
    const registry = createToolRegistry({ saveTencentCloudAccount: async () => ({ ...account, isActive: true }) } as never);
    expect((await registry.callTool('tencent_cloud_account_save', scopes, payload, 'admin')).structuredContent.result).toMatchObject({ isActive: true });
  });

  it.each([
    { ...payload, provider: 'alibaba_cloud' }, { ...payload, accessKeySecret: '********' }, { ...payload, accessKeyId: '********' },
    { ...payload, regionId: '' }, { ...payload, unexpected: 'unsafe' },
  ])('refuses invalid save parameters before calling the API %j', async input => {
    const save = vi.fn();
    const registry = createToolRegistry({ saveTencentCloudAccount: save } as never);
    await expect(registry.callTool('tencent_cloud_account_save', scopes, input, 'admin')).rejects.toThrow('Invalid input');
    expect(save).not.toHaveBeenCalled();
  });

  it('keeps the exact confirmation challenge and then forwards confirmed metadata through the real client', async () => {
    const challenge = { code: 'CONFIRMATION_REQUIRED', confirmationId: 'platform-confirmation', idempotencyKey: 'stable-key',
      summary: '确认保存指定腾讯云账号' };
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(challenge), { status: 409 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ operationId: 'operation', result: { result: { ...account, accessKeySecret: payload.accessKeySecret } } }), { status: 200 }));
    const registry = createToolRegistry(new PlatformApiClient({ baseUrl: 'https://fixture.invalid', token: 'test-token', fetch }));
    expect(await registry.callTool('tencent_cloud_account_save', scopes, { ...payload, idempotencyKey: 'stable-key' }, 'admin'))
      .toMatchObject({ isError: true, structuredContent: { result: { error: challenge } } });
    const result = await registry.callTool('tencent_cloud_account_save', scopes,
      { ...payload, idempotencyKey: 'stable-key', confirmationId: challenge.confirmationId }, 'admin');
    expect(result.structuredContent.result).toEqual(account);
    expect(fetch.mock.calls[1]![1]).toMatchObject({ headers: { Authorization: 'Bearer test-token',
      'x-idempotency-key': 'stable-key', 'x-confirmation-id': challenge.confirmationId }, body: JSON.stringify(payload) });
    expect(JSON.stringify(result)).not.toContain(payload.accessKeySecret);
  });

  it('forwards exact region, image pagination and account-specific size queries without changing the Aliyun default', async () => {
    const regions = vi.fn(async () => ({ provider: 'tencent_cloud', regions: [] }));
    const images = vi.fn(async () => ({ provider: 'tencent_cloud', items: [] }));
    const sizes = vi.fn(async () => ({ exactAvailable: false }));
    const config = vi.fn();
    const registry = createToolRegistry({ discoverTencentCloudRegions: regions, listTencentCloudImages: images,
      getCloudAccountInstanceTypeAvailability: sizes, saveCloudConfig: config } as never);
    const regionInput = { regionIds: ['ap-nanjing', 'ap-shanghai'], accessKeyId: payload.accessKeyId, accessKeySecret: payload.accessKeySecret };
    await registry.callTool('tencent_cloud_region_list', scopes, regionInput, 'admin');
    expect(regions).toHaveBeenCalledWith(regionInput);
    const imageInput = { cloudAccountContextId: account.id, scope: 'public', offset: 40, limit: 20 };
    await registry.callTool('tencent_cloud_image_list', scopes, imageInput, 'admin');
    expect(images).toHaveBeenCalledWith(imageInput);
    await registry.callTool('cloud_account_instance_type_availability', scopes, { cloudAccountContextId: account.id, cpu: 2, memory: 4 }, 'admin');
    expect(sizes).toHaveBeenCalledWith(account.id, 2, 4);
    expect(config).not.toHaveBeenCalled();
  });

  it.each([
    ['tencent_cloud_region_list', { regionIds: ['ap-nanjing', 'ap-nanjing'], accessKeyId: 'key', accessKeySecret: 'secret' }],
    ['tencent_cloud_region_list', { regionIds: ['a-a', 'a-b', 'a-c', 'a-d'], accessKeyId: 'key', accessKeySecret: 'secret' }],
    ['tencent_cloud_image_list', { cloudAccountContextId: 'context', scope: 'public', offset: -1 }],
    ['tencent_cloud_image_list', { cloudAccountContextId: 'context', scope: 'public', limit: 101 }],
    ['cloud_account_instance_type_availability', { cloudAccountContextId: 'context', cpu: 0, memory: 4 }],
  ] as const)('validates bounded read parameters for %s', async (name, input) => {
    await expect(createToolRegistry({} as never).callTool(name, scopes, input, 'admin')).rejects.toThrow('Invalid input');
  });
});
