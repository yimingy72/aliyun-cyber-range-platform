import { expect, it, vi } from 'vitest';
import { createToolRegistry } from '../src/server';
it('requires both scopes and forwards only a saved revision and a stable creation key', async () => {
 const save = vi.fn().mockResolvedValue({ id: 'copy', templateId: 'copy', visibility: 'private' });
 const registry = createToolRegistry({ saveRangeInstanceAsTemplate: save } as any); const name = 'range_instance_save_as_template';
 const input = { rangeInstanceId: 'range', name: 'Copy', expectedDraftRevision: 3, idempotencyKey: 'copy-key' };
 await expect(registry.callTool(name, ['ranges:read'], input)).rejects.toThrow('Forbidden');
 await expect(registry.callTool(name, ['templates:write'], input)).rejects.toThrow('Forbidden');
 for (const invalid of [{ ...input, expectedDraftRevision: 0 }, { ...input, idempotencyKey: undefined }, { ...input, cloudProvider: 'tencent_cloud' }, { ...input, topologyGraph: {} }, { ...input, visibility: 'platform' }]) await expect(registry.callTool(name, ['ranges:read', 'templates:write'], invalid)).rejects.toThrow('Invalid input');
 await expect(registry.callTool(name, ['ranges:read', 'templates:write'], input)).resolves.toMatchObject({ structuredContent: { result: { templateId: 'copy' } } });
 expect(save).toHaveBeenCalledExactlyOnceWith('range', { name: 'Copy', expectedDraftRevision: 3 }, { idempotencyKey: 'copy-key' });
});
