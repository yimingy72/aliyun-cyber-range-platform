import type { ToolDefinition } from './tool-context';
import {
  imageCatalogCustomDeleteInputSchema,
  imageCatalogListInputSchema,
  imageCatalogSyncInputSchema,
  imageAssetOperationInputSchema,
  imageCollectInputSchema,
  imageImportJobListInputSchema,
  imageImportJobRetryInputSchema,
  imageListInputSchema,
  imageTagListInputSchema,
  imageTagCreateInputSchema,
  imageTagsSetInputSchema,
  imageRenameInputSchema,
} from './input-schemas';
import {
  imageCatalogOutputSchema,
  imageTagOutputSchema,
  imageTagListOutputSchema,
  customImageCleanupOutputSchema,
  imageImportJobListOutputSchema,
  imageImportJobSchema,
  removedOutputSchema,
  resourceListOutputSchema,
  resourceOutputSchema,
  resultOutputSchema,
} from './output-schemas';

const operation = (args: { idempotencyKey?: string; confirmationId?: string }) => ({
  idempotencyKey: args.idempotencyKey,
  confirmationId: args.confirmationId,
});

export const imageTools: ToolDefinition[] = [
  {
    name: 'platform_image_tag_list', title: '查询镜像标签字典',
    description: '查询现有全局镜像标签定义（id、name），用于选择资产关联标签。当前字典只提供查询和创建能力。',
    requiredScopes: ['images:read'], readOnlyHint: true,
    inputSchema: imageTagListInputSchema, outputSchema: imageTagListOutputSchema,
    call(context) { return context.client.listPlatformImageTags(); },
  },
  {
    name: 'platform_image_tag_create', title: '创建镜像标签定义',
    description: '仅管理员创建全局镜像标签定义，不自动关联资产。名称唯一，当前没有全局标签重命名或删除能力；调用前明确该持久字典变更并取得用户确认。',
    requiredScopes: ['images:write'], adminOnly: true, annotations: { destructiveHint: false, idempotentHint: false },
    inputSchema: imageTagCreateInputSchema, outputSchema: imageTagOutputSchema,
    call(context, args) {
      const input = args as { name: string; idempotencyKey?: string; confirmationId?: string };
      return context.client.createPlatformImageTag(input.name, operation(input));
    },
  },
  {
    name: 'platform_image_tags_set', title: '替换镜像标签关联',
    description: 'owner或管理员按完整tagIds集合替换准确镜像资产的全部标签关联；[]清空关联。普通用户不能修改他人资产，公开可见不等于可修改。保留全局标签定义，不操作云标签/资源；调用前取得用户确认。',
    requiredScopes: ['images:write'], annotations: { destructiveHint: false, idempotentHint: true },
    inputSchema: imageTagsSetInputSchema, outputSchema: resourceOutputSchema,
    call(context, args) {
      const input = args as { platformImageAssetId: string; tagIds: string[]; idempotencyKey?: string; confirmationId?: string };
      return context.client.setPlatformImageTags(input.platformImageAssetId, input.tagIds, operation(input));
    },
  },
  {
    name: 'platform_image_list',
    title: '查询平台镜像',
    description: '对应镜像中心的“平台镜像/我的镜像”列表。返回当前调用者可见的平台镜像资产；创建独立实例或转换拓扑前，用返回的资产 ID 与 imageId 精确定位镜像。',
    requiredScopes: ['images:read'],
    readOnlyHint: true,
    inputSchema: imageListInputSchema,
    outputSchema: resourceListOutputSchema,
    call(context, args) {
      return context.client.listPlatformImages((args as { view?: 'platform' | 'mine' }).view ?? 'platform');
    },
  },
  {
    name: 'platform_image_collect',
    title: '收录镜像为平台资产',
    description: '对应镜像中心的“收录”。仅管理员将已同步的云镜像快照纳入平台镜像资产；会创建可管理资产，调用前必须取得用户确认。',
    requiredScopes: ['images:write'], adminOnly: true,
    inputSchema: imageCollectInputSchema,
    outputSchema: resourceOutputSchema,
    call(context, args) {
      const input = args as { snapshotId: string; displayName: string; idempotencyKey?: string; confirmationId?: string };
      return context.client.collectPlatformImage({ snapshotId: input.snapshotId, displayName: input.displayName }, operation(input));
    },
  },
  {
    name: 'platform_image_rename',
    title: '重命名平台镜像',
    description: '对应镜像中心的“重命名”。只修改指定平台镜像资产的显示名称，不改变云镜像内容；调用前必须取得用户确认。',
    requiredScopes: ['images:write'],
    inputSchema: imageRenameInputSchema,
    outputSchema: resourceOutputSchema,
    call(context, args) {
      const input = args as { platformImageAssetId: string; displayName: string; idempotencyKey?: string; confirmationId?: string };
      return context.client.renamePlatformImage(input.platformImageAssetId, input.displayName, operation(input));
    },
  },
  {
    name: 'platform_image_enable',
    title: '启用平台镜像',
    description: '对应镜像中心的“启用”。允许该平台镜像用于后续创建，不影响已有实例；调用前必须取得用户确认。',
    requiredScopes: ['images:write'],
    inputSchema: imageAssetOperationInputSchema,
    outputSchema: resourceOutputSchema,
    call(context, args) {
      const input = args as { platformImageAssetId: string; idempotencyKey?: string; confirmationId?: string };
      return context.client.enablePlatformImage(input.platformImageAssetId, operation(input));
    },
  },
  {
    name: 'platform_image_disable',
    title: '停用平台镜像',
    description: '对应镜像中心的“停用”。阻止该镜像用于后续创建，不会销毁已有实例；调用前必须取得用户确认。',
    requiredScopes: ['images:write'],
    inputSchema: imageAssetOperationInputSchema,
    outputSchema: resourceOutputSchema,
    call(context, args) {
      const input = args as { platformImageAssetId: string; idempotencyKey?: string; confirmationId?: string };
      return context.client.disablePlatformImage(input.platformImageAssetId, operation(input));
    },
  },
  {
    name: 'platform_image_publish',
    title: '发布平台镜像',
    description: '对应镜像中心的“发布到平台”。仅管理员将有owner的镜像设为平台可见，供其他用户使用；调用前必须取得用户确认。',
    requiredScopes: ['images:write'], adminOnly: true,
    inputSchema: imageAssetOperationInputSchema,
    outputSchema: resourceOutputSchema,
    call(context, args) {
      const input = args as { platformImageAssetId: string; idempotencyKey?: string; confirmationId?: string };
      return context.client.publishPlatformImage(input.platformImageAssetId, operation(input));
    },
  },
  {
    name: 'platform_image_unpublish',
    title: '取消发布平台镜像',
    description: '对应镜像中心的“取消发布”。仅管理员将有owner的镜像恢复为私有可见性；调用前必须取得用户确认。',
    requiredScopes: ['images:write'], adminOnly: true,
    inputSchema: imageAssetOperationInputSchema,
    outputSchema: resourceOutputSchema,
    call(context, args) {
      const input = args as { platformImageAssetId: string; idempotencyKey?: string; confirmationId?: string };
      return context.client.unpublishPlatformImage(input.platformImageAssetId, operation(input));
    },
  },
  {
    name: 'platform_image_remove',
    title: '删除平台镜像',
    description: '对应镜像中心的“删除平台镜像资产”。平台会拒绝仍被已发布拓扑引用或仍在导入中的镜像；该操作不可恢复，调用前必须取得用户确认。',
    requiredScopes: ['images:write'],
    annotations: { destructiveHint: true, idempotentHint: false },
    inputSchema: imageAssetOperationInputSchema,
    outputSchema: removedOutputSchema('platformImageAssetId'),
    async call(context, args) {
      const input = args as { platformImageAssetId: string; idempotencyKey?: string; confirmationId?: string };
      const id = input.platformImageAssetId;
      await context.client.removePlatformImage(id, operation(input));
      return { removed: true, platformImageAssetId: id };
    },
  },
  {
    name: 'image_catalog_list',
    title: '查询云镜像目录',
    description: '对应镜像中心的公共镜像或自定义镜像目录。返回云镜像快照及已收录条目；自定义目录只返回当前云账号范围内的镜像。',
    requiredScopes: ['images:read'],
    readOnlyHint: true,
    inputSchema: imageCatalogListInputSchema,
    outputSchema: imageCatalogOutputSchema,
    call(context, args) {
      return context.client.listImageCatalog((args as { scope: 'public' | 'custom' }).scope);
    },
  },
  {
    name: 'image_catalog_sync',
    title: '同步云镜像目录',
    description: '对应镜像中心的“同步镜像”。从阿里云刷新公共或自定义镜像目录缓存，不上传、不创建或删除云镜像。',
    requiredScopes: ['images:read'],
    annotations: { idempotentHint: true },
    inputSchema: imageCatalogSyncInputSchema,
    outputSchema: imageCatalogOutputSchema,
    call(context, args) {
      return context.client.syncImageCatalog((args as { scope: 'public' | 'custom' }).scope);
    },
  },
  {
    name: 'image_catalog_custom_delete',
    title: '删除自定义云镜像',
    description: '永久删除指定云自定义镜像。显式deleteOwnedSnapshots=true时，仅对平台新打包且有完整来源证明的镜像回收确切快照，拒绝共享/外部快照，不强制删除。云终态确认后removed=true；失败保留材料用相同目标重试。调用前必须取得用户确认。',
    requiredScopes: ['images:write'],
    annotations: { destructiveHint: true, idempotentHint: false },
    inputSchema: imageCatalogCustomDeleteInputSchema,
    outputSchema: customImageCleanupOutputSchema,
    async call(context, args) {
      const input = args as { snapshotId: string; deleteOwnedSnapshots?: boolean; idempotencyKey?: string; confirmationId?: string };
      return context.client.removeCustomImageSnapshot(input.snapshotId, { deleteOwnedSnapshots: input.deleteOwnedSnapshots }, operation(input));
    },
  },
  {
    name: 'image_import_job_list',
    title: '查询镜像导入任务',
    description: '对应镜像中心“我的镜像”中的导入任务状态。返回当前调用者可见的本地文件镜像导入记录，不返回预签名上传地址。',
    requiredScopes: ['images:read'],
    readOnlyHint: true,
    inputSchema: imageImportJobListInputSchema,
    outputSchema: imageImportJobListOutputSchema,
    call(context) {
      return context.client.listImageImportJobs();
    },
  },
  {
    name: 'image_import_job_retry',
    title: '重试镜像导入任务',
    description: '对应镜像中心导入失败后的“重试”。仅对失败导入任务重新提交云端镜像导入，可能创建云镜像资源；调用前必须取得用户确认。',
    requiredScopes: ['images:write'],
    annotations: { destructiveHint: false, idempotentHint: false },
    inputSchema: imageImportJobRetryInputSchema,
    outputSchema: resultOutputSchema(imageImportJobSchema),
    call(context, args) {
      return context.client.retryImageImport((args as { imageImportJobId: string }).imageImportJobId);
    },
  },
];
