import { describe, expect, it, vi } from 'vitest';
import { PlatformApiClient } from '@aliyun-cyber-range/platform-api-client';
import { createToolRegistry } from '../src/server';

const scopes = ['billing:read', 'billing:sync', 'settings:write'];
const value = { ledgerId: 'ledger-owned', bucketName: 'platform-owned-bucket', cloudWorkspaceId: 'space-owned', cloudAccountUid: '123456', regionId: 'cn-hangzhou',
  effectiveStartAt: '2026-09-30T16:00:00.000Z', effectiveEndAt: null, declaredAt: '2026-10-12T12:00:00.000Z', declaredByUserId: 'admin',
  bucketCreatedAt: '2026-09-01T00:00:00.000Z', verifiedAt: '2026-10-12T12:00:00.000Z', officialRequestId: 'request-owned', status: 'active' };
const input = { bucketName: value.bucketName, effectiveStartAt: value.effectiveStartAt, dedicated: true };
describe('dedicated Alibaba OSS billing tool contract', () => {
  it('preserves unsupported-provider API errors on repeated Tencent calls without treating them as confirmation challenges', async () => {
    const error = { code: 'CLOUD_PROVIDER_UNSUPPORTED', provider: 'tencent_cloud', feature: 'ossBillingBinding', message: 'Use Tencent COS import instead.' };
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json(error, { status: 400 }));
    const registry = createToolRegistry(new PlatformApiClient({ baseUrl: 'https://fixture.invalid', token: 'fixture-token', cloudWorkspaceId: 'tencent-space', fetch }));
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(await registry.callTool('billing_oss_bucket_create', scopes, { dedicated: true, idempotencyKey: 'same-key' }, 'admin'))
        .toMatchObject({ isError: true, structuredContent: { result: { error } } });
    }
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ headers: expect.objectContaining({ 'x-cloud-workspace-id': 'tencent-space' }) });
  });
  it('requires admin role and both settings write and billing sync for fee-scope writes', async () => {
    const registry = createToolRegistry({} as never);
    for (const name of ['billing_oss_bucket_bind', 'billing_oss_bucket_create', 'billing_oss_bucket_binding_end']) {
      for (const permissions of [['billing:sync'], ['settings:write']]) expect(registry.listTools(permissions, 'admin').map(tool => tool.name)).not.toContain(name);
      expect(registry.listTools(scopes, 'user').map(tool => tool.name)).not.toContain(name);
      await expect(registry.callTool(name, scopes, input, 'user')).rejects.toThrow('Forbidden tool');
    }
    expect(registry.listTools(['billing:read'], 'admin').find(tool => tool.name === 'billing_oss_bucket_binding_list')?.annotations.readOnlyHint).toBe(true);
  });
  it('creates one persistent dedicated bucket through the confirmed SDK operation without caller-selected names or retroactive dates', async () => {
    const create = vi.fn(async () => value), registry = createToolRegistry({ createDedicatedOssBucket: create } as never);
    for (const extra of [{ bucketName: 'existing-external-bucket' }, { effectiveStartAt: '2026-09-01' }, { dedicated: false }]) {
      await expect(registry.callTool('billing_oss_bucket_create', scopes, { dedicated: true, ...extra }, 'admin')).rejects.toThrow('Invalid input');
    }
    await registry.callTool('billing_oss_bucket_create', scopes, { dedicated: true, confirmationId: 'create-confirmation', idempotencyKey: 'create-key' }, 'admin');
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({ dedicated: true }, { confirmationId: 'create-confirmation', idempotencyKey: 'create-key' });
  });
  it.each([{ ...input, dedicated: false }, { ...input, effectiveStartAt: 'now' }, { ...input, bucketName: 'other.example.invalid/path' },
    { ...input, accessKeySecret: 'not-accepted' }])('rejects invalid or undeclared scope before API use', async invalid => {
    const bind = vi.fn();
    await expect(createToolRegistry({ bindOssBilling: bind } as never).callTool('billing_oss_bucket_bind', scopes, invalid, 'admin')).rejects.toThrow('Invalid input');
    expect(bind).not.toHaveBeenCalled();
  });
  it('forwards workspace and exact confirmation through the SDK and strips private output fields', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ code: 'CONFIRMATION_REQUIRED', confirmationId: 'confirmation-owned', idempotencyKey: 'stable-key' }, { status: 409 }))
      .mockResolvedValueOnce(Response.json({ ...value, accessKeySecret: 'private-secret' }));
    const registry = createToolRegistry(new PlatformApiClient({ baseUrl: 'https://fixture.invalid', token: 'fixture-token', cloudWorkspaceId: value.cloudWorkspaceId, fetch }));
    expect(await registry.callTool('billing_oss_bucket_bind', scopes, { ...input, idempotencyKey: 'stable-key' }, 'admin')).toMatchObject({ isError: true });
    expect((await registry.callTool('billing_oss_bucket_bind', scopes, { ...input, idempotencyKey: 'stable-key', confirmationId: 'confirmation-owned' }, 'admin')).structuredContent.result).toEqual(value);
    expect(fetch.mock.calls[1]).toEqual(['https://fixture.invalid/admin/billing/oss-binding', expect.objectContaining({ body: JSON.stringify(input),
      headers: expect.objectContaining({ 'x-cloud-workspace-id': value.cloudWorkspaceId, 'x-confirmation-id': 'confirmation-owned', 'x-idempotency-key': 'stable-key' }) })]);
  });
  it('lists and ends only the exact declaration without accepting client-controlled termination time', async () => {
    const list = vi.fn(async () => [value]), end = vi.fn(async () => ({ ...value, status: 'ended', effectiveEndAt: '2026-10-12T12:01:00.000Z' }));
    const registry = createToolRegistry({ listOssBillingBindings: list, endOssBillingBinding: end } as never);
    expect((await registry.callTool('billing_oss_bucket_binding_list', scopes, {}, 'admin')).structuredContent.result).toEqual([value]);
    await expect(registry.callTool('billing_oss_bucket_binding_end', scopes, { ledgerId: value.ledgerId, endedAt: '2026-10-01' }, 'admin')).rejects.toThrow('Invalid input');
    await registry.callTool('billing_oss_bucket_binding_end', scopes, { ledgerId: value.ledgerId, confirmationId: 'end-confirmation', idempotencyKey: 'end-key' }, 'admin');
    expect(end).toHaveBeenCalledWith(value.ledgerId, { confirmationId: 'end-confirmation', idempotencyKey: 'end-key' });
  });
});
