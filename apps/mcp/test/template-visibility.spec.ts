import { expect, it, vi } from 'vitest';
import { PlatformApiError } from '@aliyun-cyber-range/platform-api-client';
import { createToolRegistry } from '../src/server';

it('rejects the retired all view and preserves server authorization for the published view', async () => {
  const listRangeTemplates = vi.fn().mockResolvedValue([{ id: 'published-topology', customPassword: 'secret' }]);
  const registry = createToolRegistry({ listRangeTemplates } as never);
  const input = { view: 'platform' };
  await expect(registry.callTool('range_template_list', ['templates:read'], { view: 'all' })).rejects.toThrow('Invalid input');
  await expect(registry.callTool('range_template_list', [], input)).rejects.toThrow('Forbidden');
  const result = await registry.callTool('range_template_list', ['templates:read'], input);
  expect(result).toMatchObject({ structuredContent: { result: [{ id: 'published-topology' }] } });
  expect(JSON.stringify(result)).not.toContain('secret');
  expect(listRangeTemplates).toHaveBeenCalledExactlyOnceWith('platform');
  listRangeTemplates.mockRejectedValue(new PlatformApiError(403, 'Workspace access denied'));
  await expect(registry.callTool('range_template_list', ['templates:read'], input)).resolves.toMatchObject({ isError: true });
  expect(listRangeTemplates).toHaveBeenCalledTimes(2);
  expect(listRangeTemplates).toHaveBeenLastCalledWith('platform');
});
