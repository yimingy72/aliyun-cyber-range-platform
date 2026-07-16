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
  {
    name: 'platform_image_collect',
    description: 'Collect a platform image from a snapshot.',
    requiredScopes: ['images:write'],
    call(context, args) {
      const input = args as { snapshotId: string; displayName: string };
      return context.client.collectPlatformImage({ snapshotId: input.snapshotId, displayName: input.displayName });
    },
  },
  {
    name: 'platform_image_rename',
    description: 'Rename a platform image asset.',
    requiredScopes: ['images:write'],
    call(context, args) {
      const input = args as { platformImageAssetId: string; displayName: string };
      return context.client.renamePlatformImage(input.platformImageAssetId, input.displayName);
    },
  },
  {
    name: 'platform_image_enable',
    description: 'Enable a platform image asset.',
    requiredScopes: ['images:write'],
    call(context, args) {
      return context.client.enablePlatformImage((args as { platformImageAssetId: string }).platformImageAssetId);
    },
  },
  {
    name: 'platform_image_disable',
    description: 'Disable a platform image asset.',
    requiredScopes: ['images:write'],
    call(context, args) {
      return context.client.disablePlatformImage((args as { platformImageAssetId: string }).platformImageAssetId);
    },
  },
  {
    name: 'platform_image_publish',
    description: 'Publish an owned image asset to platform visibility.',
    requiredScopes: ['images:write'],
    call(context, args) {
      return context.client.publishPlatformImage((args as { platformImageAssetId: string }).platformImageAssetId);
    },
  },
  {
    name: 'platform_image_unpublish',
    description: 'Unpublish an owned image asset back to private visibility.',
    requiredScopes: ['images:write'],
    call(context, args) {
      return context.client.unpublishPlatformImage((args as { platformImageAssetId: string }).platformImageAssetId);
    },
  },
  {
    name: 'platform_image_remove',
    description: 'Remove a platform image asset.',
    requiredScopes: ['images:write'],
    async call(context, args) {
      const id = (args as { platformImageAssetId: string }).platformImageAssetId;
      await context.client.removePlatformImage(id);
      return { removed: true, platformImageAssetId: id };
    },
  },
];
