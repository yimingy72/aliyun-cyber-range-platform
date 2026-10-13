import { describe, expect, it, vi } from 'vitest';
import { createToolRegistry } from '../src/server';
import { PlatformApiClient } from '@aliyun-cyber-range/platform-api-client';
const digest = 'a'.repeat(64), scopes = ['settings:write', 'ranges:destroy', 'instances:destroy'];
describe('resource alert MCP contract', () => {
  it('excludes non-admin tools and rejects insufficient destruction scopes and arbitrary cloud IDs', async () => {
    const registry = createToolRegistry({} as never);
    expect(registry.listTools(['settings:read', ...scopes], 'user').filter(tool => tool.name.startsWith('resource_'))).toHaveLength(0);
    await expect(registry.callTool('resource_alert_reclaim', ['settings:write'], { alertId: 'a', planDigest: digest, idempotencyKey: 'k' }, 'admin')).rejects.toThrow('Forbidden');
    await expect(registry.callTool('resource_alert_reclaim', scopes, { alertId: 'a', planDigest: digest, idempotencyKey: 'k', resourceIds: ['i-outsider'] }, 'admin')).rejects.toThrow('Invalid input');
    expect(registry.listTools(scopes, 'admin').find(tool => tool.name === 'resource_alert_reclaim')?.annotations).toMatchObject({ destructiveHint: true, idempotentHint: true });
  });
  it('strips secrets and raw evidence from alerts', async () => {
    const row = { id: 'a', cloudWorkspaceId: 'space-a', provider: 'alibaba_cloud', accountUid: '111', regionId: 'cn-hangzhou',
      type: 'ecs', resourceId: 'i-real', rangeInstanceId: null, rangeName: null, status: 'unverified', reason: 'candidate', firstSeenAt: '2026-10-13T00:00:00Z', lastSeenAt: '2026-10-13T00:00:00Z',
      evidenceSummary: { recordedInventory: false, sourceJobIds: [], accountVerified: true }, remainingResources: [], errorSummary: null, jobId: null,
      accessKeySecret: 'SECRET', rawState: { password: 'STATE' }, initScript: 'SCRIPT' };
    const result = await createToolRegistry({ listResourceAlerts: async () => [row] } as never).callTool('resource_alert_list', ['settings:read'], {}, 'admin');
    for (const value of ['SECRET', 'STATE', 'SCRIPT']) expect(JSON.stringify(result)).not.toContain(value);
  });
  it('freezes workspace and digest through confirmation and returns the same business result on replay', async () => {
    const business = { alertId: 'a', status: 'reclaiming', jobId: 'job-a' };
    const challenge = { code: 'CONFIRMATION_REQUIRED', confirmationId: 'confirmed', idempotencyKey: 'same-key' };
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(challenge), { status: 409 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ operationId: 'op', ...business })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ operationId: 'op', status: 'dispatched', result: business })));
    const registry = createToolRegistry(new PlatformApiClient({ baseUrl: 'https://fixture.invalid', token: 'actor', cloudWorkspaceId: 'space-a', fetch }));
    const input = { alertId: 'a', planDigest: digest, idempotencyKey: 'same-key' };
    expect(await registry.callTool('resource_alert_reclaim', scopes, input, 'admin')).toMatchObject({ isError: true });
    for (let attempt = 0; attempt < 2; attempt++) expect(await registry.callTool('resource_alert_reclaim', scopes, { ...input, confirmationId: 'confirmed' }, 'admin')).toMatchObject({ structuredContent: { result: business } });
    for (const [, init] of fetch.mock.calls) expect(init).toMatchObject({ headers: { 'x-cloud-workspace-id': 'space-a', 'x-idempotency-key': 'same-key' }, body: JSON.stringify({ planDigest: digest }) });
  });
});
