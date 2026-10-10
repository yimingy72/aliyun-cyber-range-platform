import { expect, it, vi } from 'vitest';
import { createToolRegistry } from '../src/server';
import { PlatformApiError } from '@aliyun-cyber-range/platform-api-client';
it('previews saved state and applies the same token after confirmation without saving another graph', async () => {
 const preview = vi.fn().mockResolvedValue({ id: 'range', previewToken: 'preview', kind: 'expected-topology-diff' });
 const apply = vi.fn().mockRejectedValueOnce(new PlatformApiError(409, 'confirm', { code: 'CONFIRMATION_REQUIRED', confirmationId: 'confirm', idempotencyKey: 'idem' })).mockResolvedValue({ jobId: 'update-job' });
 const save = vi.fn(); const registry = createToolRegistry({ previewRangeInstanceDraft: preview, applyRangeInstanceDraft: apply, saveRangeInstanceDraft: save } as any);
 await expect(registry.callTool('range_instance_topology_preview', ['ranges:read'], { rangeInstanceId: 'range', expectedDraftRevision: 2 })).resolves.toMatchObject({ structuredContent: { result: { previewToken: 'preview' } } });
 const input = { rangeInstanceId: 'range', expectedDraftRevision: 2, previewToken: 'preview' };
 await expect(registry.callTool('range_instance_topology_apply', ['ranges:write', 'ranges:control'], input)).resolves.toMatchObject({ isError: true });
 await expect(registry.callTool('range_instance_topology_apply', ['ranges:write', 'ranges:control'], { ...input, idempotencyKey: 'idem', confirmationId: 'confirm' })).resolves.toMatchObject({ structuredContent: { result: { jobId: 'update-job' } } });
 expect(apply).toHaveBeenLastCalledWith('range', 2, 'preview', { idempotencyKey: 'idem', confirmationId: 'confirm' }); expect(save).not.toHaveBeenCalled();
 await expect(registry.callTool('range_instance_topology_apply', ['ranges:write', 'ranges:control'], { ...input, topologyGraph: {} })).rejects.toThrow('Invalid input');
});
