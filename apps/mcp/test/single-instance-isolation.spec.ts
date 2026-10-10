import { describe, expect, it } from 'vitest';
import { createToolRegistry } from '../src/server';
const member = (id: string) => ({ id, name: id, singleInstanceConfig: { hostKey: 'ecs', imageDisplayName: 'Ubuntu' }, runtimeCredentials: { ecs: { username: 'root', password: 'synthetic-only' } } });
describe('single instance MCP isolation', () => {
  it('keeps recorded CBS absence RequestIds in the existing read-only status tool without accepting cloud IDs', async () => {
    const result = { singleInstanceId: 'single', regionId: 'ap-shanghai', exists: false, instanceIds: [], checkedAt: '2026-10-10T00:00:00Z', recordedResourceStatus: {
      provider: 'tencent_cloud', cloudAccountContextId: 'original-context', cloudAccountUid: 'synthetic-uid', regionId: 'ap-shanghai', checkedAt: '2026-10-10T00:00:00Z', coverage: 'persisted_instance_compute_resource_ids', allKnownAbsent: true,
      resources: [{ cloudResourceType: 'disk', cloudResourceId: 'disk-known', sources: ['ledger'], ledgerIds: ['ledger-known'], exists: false }],
      evidence: [{ provider: 'tencent_cloud', cloudAccountContextId: 'original-context', accountUid: 'synthetic-uid', regionId: 'ap-shanghai', action: 'DescribeDisks', requestIds: ['cloud-request-id'], observedAt: '2026-10-10T00:00:00Z' }], excludedUnverifiedDiskIds: [], unsupportedLedgerResourceTypes: [],
    } };
    const registry = createToolRegistry({ getSingleInstanceCloudResourceStatus: async () => result } as any);
    const output = await registry.callTool('single_instance_cloud_resource_status', ['instances:read'], { singleInstanceId: 'single' });
    expect(output.structuredContent.result).toEqual(result);
    const tool = registry.listTools(['instances:read']).find(entry => entry.name === 'single_instance_cloud_resource_status')!;
    expect(tool.annotations.readOnlyHint).toBe(true); expect(tool.outputSchema.safeParse(output.structuredContent).success).toBe(true);
    expect(tool.inputSchema.safeParse({ singleInstanceId: 'single', diskIds: ['disk-arbitrary'] }).success).toBe(false);
  });
  it('removes credentials from ordinary read tools, while explicit sensitive CSV merges active and history', async () => {
    const registry = createToolRegistry({ listSingleInstances: async (view: string) => ({ batches: [{ batch: { id: 'batch', name: 'batch' }, instances: [member(view)] }], standaloneInstances: [] }), getSingleInstance: async () => member('single') } as any);
    const scopes = ['instances:read'];
    for (const [name, args] of [['single_instance_list', {}], ['single_instance_get', { singleInstanceId: 'single' }]] as const) {
      const output = await registry.callTool(name, scopes, args);
      expect(JSON.stringify(output)).not.toContain('synthetic-only');
      expect(JSON.stringify(output)).not.toContain('runtimeCredentials');
    }
    await expect(registry.callTool('single_instance_get_access', scopes, { singleInstanceId: 'single' })).rejects.toThrow('Forbidden');
    const csv = await registry.callTool('single_instance_batch_export_csv', [...scopes, 'instances:credentials:read'], { batchId: 'batch' });
    expect(csv.structuredContent.result).toMatchObject({ rowCount: 2 });
  });
  it('requires settings write and destroy scopes for explicit network cleanup', async () => {
    const registry = createToolRegistry({ destroySingleInstanceNetwork: async (id: string) => ({ networkProfileId: id, status: 'destroyed' }) } as any);
    await expect(registry.callTool('single_instance_network_destroy', ['instances:destroy'], { networkProfileId: 'profile',cleanupRunId:'synthetic-run' })).rejects.toThrow('Forbidden');
    expect((await registry.callTool('single_instance_network_destroy', ['instances:destroy', 'settings:write'], { networkProfileId: 'profile',cleanupRunId:'synthetic-run' })).structuredContent.result).toMatchObject({ networkProfileId: 'profile', status: 'destroyed' });
  });
});
