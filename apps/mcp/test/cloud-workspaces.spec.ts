import { describe, expect, it, vi } from 'vitest';
import { PlatformApiClient } from '@aliyun-cyber-range/platform-api-client';
import { createToolRegistry } from '../src/server';

const account = { cloudWorkspaceId: 'space-a', id: 'context-a', provider: 'alibaba_cloud', displayName: '训练地域', accountUid: '111', regionId: 'cn-hangzhou', zoneId: 'cn-hangzhou-h', isActive: false, status: 'ready', imageImportBucket: '', bucketStatus: 'unconfigured' };
const space = { id: 'space-a', provider: 'alibaba_cloud', accountUid: '111', displayName: '训练账号', isReadOnly: false, activeCloudAccountContextId: account.id, contexts: [account], capabilities: { provisioning: true, imageImport: false, billingSync: true } };
const payload = { provider: 'alibaba_cloud', cloudWorkspaceId: 'space-a', regionId: account.regionId, zoneId: account.zoneId, accessKeyId: 'fixture-key', accessKeySecret: 'fixture-secret' };
describe('cloud workspace MCP contract', () => {
  it('separates read, selection, and manager binding scopes and marks selection as an idempotent write', async () => {
    const registry = createToolRegistry({} as never);
    const read = registry.listTools(['settings:read'], 'user');
    expect(read.map(tool => tool.name)).toEqual(expect.arrayContaining(['cloud_workspace_list', 'cloud_workspace_switch']));
    expect(read.map(tool => tool.name)).not.toContain('cloud_account_bind');
    expect(read.find(tool => tool.name === 'cloud_workspace_switch')!.annotations).toMatchObject({ readOnlyHint: false, idempotentHint: true, destructiveHint: false });
    await expect(registry.callTool('cloud_account_bind', ['settings:write'], payload, 'user')).rejects.toThrow('Forbidden tool');
    await expect(registry.callTool('cloud_workspace_switch', ['images:read'], { cloudWorkspaceId: 'space-a' })).rejects.toThrow('Forbidden tool');
    await expect(registry.callTool('cloud_workspace_switch', ['settings:read'], { cloudWorkspaceId: 'space-a', confirmationId: 'unneeded' })).rejects.toThrow('Invalid input');
  });
  it('strips nested credentials from workspace and binding output and forwards the exact edit target', async () => {
    const secretContext = { ...account, accessKeyId: payload.accessKeyId, accessKeySecret: payload.accessKeySecret, credentials: { secret: 'nested-secret' } };
    const save = vi.fn(async () => secretContext);
    const select = vi.fn(async () => ({ ...space, contexts: [secretContext], apiToken: 'private-token' }));
    const registry = createToolRegistry({ listCloudWorkspaces: async () => [{ ...space, contexts: [secretContext] }], saveCloudAccountBinding: save, switchCloudWorkspace: select } as never);
    const listed = await registry.callTool('cloud_workspace_list', ['settings:read'], {});
    const switched = await registry.callTool('cloud_workspace_switch', ['settings:read'], { cloudWorkspaceId: 'space-a' });
    expect(select).toHaveBeenCalledWith('space-a');
    const bound = await registry.callTool('cloud_account_bind', ['settings:write'], { ...payload, idempotencyKey: 'same-key', confirmationId: 'confirmed' }, 'admin');
    expect(save).toHaveBeenCalledWith(payload, { idempotencyKey: 'same-key', confirmationId: 'confirmed' });
    for (const result of [listed, switched, bound]) for (const value of ['fixture-key', 'fixture-secret', 'nested-secret', 'private-token']) expect(JSON.stringify(result)).not.toContain(value);
  });
  it('keeps the scope and challenge frozen across binding confirmation and replay', async () => {
    const challenge = { code: 'CONFIRMATION_REQUIRED', confirmationId: 'confirmation-a', idempotencyKey: 'same-key' };
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(challenge), { status: 409 })).mockResolvedValueOnce(new Response(JSON.stringify({ operationId: 'operation-a', result: { result: account } })));
    const registry = createToolRegistry(new PlatformApiClient({ baseUrl: 'https://fixture.invalid', token: 'actor-a', cloudWorkspaceId: 'space-a', fetch }));
    expect(await registry.callTool('cloud_account_bind', ['settings:write'], { ...payload, idempotencyKey: 'same-key' }, 'admin')).toMatchObject({ isError: true, structuredContent: { result: { error: challenge } } });
    expect(await registry.callTool('cloud_account_bind', ['settings:write'], { ...payload, idempotencyKey: 'same-key', confirmationId: challenge.confirmationId }, 'admin')).toMatchObject({ structuredContent: { result: account } });
    expect(fetch.mock.calls[1]![1]).toMatchObject({ headers: { Authorization: 'Bearer actor-a', 'x-cloud-workspace-id': 'space-a', 'x-idempotency-key': 'same-key', 'x-confirmation-id': 'confirmation-a' }, body: JSON.stringify(payload) });
  });
});
