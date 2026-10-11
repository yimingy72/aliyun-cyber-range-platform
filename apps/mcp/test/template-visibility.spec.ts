import { expect, it, vi } from 'vitest';
import { PlatformApiError } from '@aliyun-cyber-range/platform-api-client';
import { createToolRegistry } from '../src/server';

it('exposes the all view and preserves server authorization without falling back to another view', async () => {
  const listRangeTemplates = vi.fn().mockResolvedValue([{ id: 'private-draft', customPassword: 'secret' }]);
  const registry = createToolRegistry({ listRangeTemplates } as never);
  const input = { view: 'all' };
  await expect(registry.callTool('range_template_list', [], input)).rejects.toThrow('Forbidden');
  const result = await registry.callTool('range_template_list', ['templates:read'], input);
  expect(result).toMatchObject({ structuredContent: { result: [{ id: 'private-draft' }] } });
  expect(JSON.stringify(result)).not.toContain('secret');
  expect(listRangeTemplates).toHaveBeenCalledExactlyOnceWith('all');
  listRangeTemplates.mockRejectedValue(new PlatformApiError(403, 'Only administrators can list all templates'));
  await expect(registry.callTool('range_template_list', ['templates:read'], input)).resolves.toMatchObject({ isError: true });
  expect(listRangeTemplates).toHaveBeenCalledTimes(2);
  expect(listRangeTemplates).toHaveBeenLastCalledWith('all');
});
