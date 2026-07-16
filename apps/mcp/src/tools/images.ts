import type { ToolDefinition } from './tool-context';

export const imageTools: ToolDefinition[] = [
  {
    name: 'platform_image_list',
    description: 'List platform or owned images.',
    requiredScopes: ['images:read'],
    readOnlyHint: true,
    call(context, args) {
      return context.client.listPlatformImages((args as { view?: 'platform' | 'mine' }).view ?? 'platform');
    },
  },
];
