import { describe, expect, it, vi } from 'vitest';
import { PlatformApiError } from '@aliyun-cyber-range/platform-api-client';
import { createToolRegistry } from '../src/server';

describe('controlled DNS reapply MCP action', () => {
 it('accepts only platform node IDs and forwards exact two-stage confirmation metadata', async () => {
  const run = vi.fn().mockRejectedValueOnce(new PlatformApiError(409, 'confirm', { code: 'CONFIRMATION_REQUIRED', confirmationId: 'confirm-dns', idempotencyKey: 'apply-dns' }))
   .mockResolvedValue({ status: 'verified', action: 'apply-dns' });
  const registry = createToolRegistry({ runRangeInstanceNodeAction: run } as any);
  const tool = 'range_instance_node_apply_dns'; const input = { rangeInstanceId: 'range-1', nodeId: 'host-1' };
  expect(registry.listTools(['ranges:control']).find(item => item.name === tool)?.annotations?.destructiveHint).toBe(false);
  await expect(registry.callTool(tool, ['ranges:read'], input)).rejects.toThrow('Forbidden');
  for (const extra of [{ command: 'whoami' }, { dns: { servers: ['8.8.8.8'] } }, { instanceId: 'ins-other' }, { defaultPassword: 'private' }])
   await expect(registry.callTool(tool, ['ranges:control'], { ...input, ...extra })).rejects.toThrow('Invalid input');
  await expect(registry.callTool(tool, ['ranges:control'], input)).resolves.toMatchObject({ isError: true, structuredContent: { result: { error: { code: 'CONFIRMATION_REQUIRED' } } } });
  await expect(registry.callTool(tool, ['ranges:control'], { ...input, confirmationId: 'confirm-dns', idempotencyKey: 'apply-dns' })).resolves.toMatchObject({ structuredContent: { result: { action: 'apply-dns' } } });
  expect(run).toHaveBeenLastCalledWith('range-1', 'host-1', 'apply-dns', {}, { confirmationId: 'confirm-dns', idempotencyKey: 'apply-dns' }); expect(run).toHaveBeenCalledTimes(2);
 });
});
