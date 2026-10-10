import type { ToolDefinition } from './tool-context';
import { cloudConfigGetInputSchema, cloudConfigUpdateInputSchema, operationSchema } from './input-schemas';
import type { CloudAccountContext, SaveCloudAccountInput, SaveTencentCloudAccountInput, TencentCloudRegionsInput, TencentCloudImagesInput } from '@aliyun-cyber-range/platform-api-client';
import * as z from 'zod/v4';

import { resultOutputSchema } from './output-schemas';

const operation = (args: { idempotencyKey?: string; confirmationId?: string }) => ({
  idempotencyKey: args.idempotencyKey,
  confirmationId: args.confirmationId,
});

function maskCloudConfig(snapshot: Record<string, unknown>) {
  return {
    ...snapshot,
    accessKeyId: snapshot.accessKeyId ? '********' : '',
    accessKeySecret: snapshot.accessKeySecret ? '********' : '',
  };
}

const cloudContextSchema = z.object({
  cloudWorkspaceId: z.string().optional(),
  id: z.string(), provider: z.enum(['alibaba_cloud', 'tencent_cloud']), displayName: z.string(), accountUid: z.string(),
  regionId: z.string(), zoneId: z.string(), isActive: z.boolean(), status: z.enum(['provisioning', 'ready', 'degraded', 'disabled']),
  imageImportBucket: z.string(), bucketStatus: z.string(), lastVerifiedAt: z.string().nullable().optional(),
});
const tencentAccountSchema = cloudContextSchema.extend({ provider: z.literal('tencent_cloud') });
const sensitiveKey = z.string().trim().min(1).refine(value => value !== '********', 'Masked access keys cannot be reused').describe('敏感凭据，仅用于明确授权的云账号操作；不得回显。');
const cloudWorkspaceSchema = z.object({ id: z.string(), provider: z.enum(['alibaba_cloud', 'tencent_cloud']), accountUid: z.string().nullable(),
  displayName: z.string(), isReadOnly: z.boolean(), activeCloudAccountContextId: z.string().nullable(), contexts: z.array(cloudContextSchema),
  capabilities: z.object({ provisioning: z.boolean(), rangeProvisioning: z.boolean().optional(), imageImport: z.boolean(), billingSync: z.boolean() }) });
function safeCloudContext(value: CloudAccountContext) {
  return cloudContextSchema.parse(value);
}

export const settingsTools: ToolDefinition[] = [
  {
    name: 'cloud_workspace_list', title: '查询云账号工作空间',
    description: '查询当前登录用户可选的云账号数据空间及配置状态，不返回凭据。厂商和主账号共同决定独立数据空间。',
    requiredScopes: ['settings:read'], readOnlyHint: true, inputSchema: z.object({}).strict(),
    outputSchema: resultOutputSchema(z.array(cloudWorkspaceSchema)),
    async call(context) { return z.array(cloudWorkspaceSchema).parse(await context.client.listCloudWorkspaces()); },
  },
  {
    name: 'cloud_workspace_switch', title: '切换云账号数据空间',
    description: '显式切换当前登录用户默认工作空间。后续未显式指定工作空间请求头的操作使用该空间，镜像、用户、靶场、实例和账单隔离；不会创建/销毁云资源或改变已受理任务的冻结账号。',
    requiredScopes: ['settings:write'], inputSchema: z.object({ cloudWorkspaceId: z.string().trim().min(1).max(192) }).strict(),
    outputSchema: resultOutputSchema(cloudWorkspaceSchema), annotations: { idempotentHint: true },
    async call(context, args) { return cloudWorkspaceSchema.parse(await context.client.switchCloudWorkspace(args.cloudWorkspaceId as string)); },
  },
  {
    name: 'cloud_account_bind', title: '绑定或更新云厂商账号',
    description: '由平台超管使用明确的厂商、账号凭据和地域绑定独立工作空间。保存不切换当前数据；编辑时传目标cloudWorkspaceId，凭据必须属于该账号。平台确认后才验证与保存。',
    requiredScopes: ['settings:write'], adminOnly: true,
    inputSchema: operationSchema.extend({ provider: z.enum(['alibaba_cloud', 'tencent_cloud']), cloudWorkspaceId: z.string().trim().min(1).max(192).optional(),
      displayName: z.string().trim().min(1).max(80).optional(), regionId: z.string().trim().min(1), zoneId: z.string().trim().min(1),
      accessKeyId: sensitiveKey, accessKeySecret: sensitiveKey, imageImportBucket: z.string().max(63).optional() }).strict(),
    outputSchema: resultOutputSchema(cloudContextSchema),
    async call(context, args) {
      const { idempotencyKey, confirmationId, ...payload } = args;
      return safeCloudContext(await context.client.saveCloudAccountBinding(payload as SaveCloudAccountInput,
        operation({ idempotencyKey: idempotencyKey as string | undefined, confirmationId: confirmationId as string | undefined })));
    },
  },
  {
    name: 'cloud_account_remove', title: '删除云账号绑定',
    description: '仅平台超管可删除非当前账号绑定。清除已保存凭据，保留数据与账单历史；重新绑定同厂商同主账号可恢复。未回收资源、失败实例及清理任务会阻止删除。不会调用云端资源删除。',
    requiredScopes: ['settings:write'], adminOnly: true, annotations: { destructiveHint: true, idempotentHint: true },
    inputSchema: operationSchema.extend({ cloudWorkspaceId: z.string().trim().min(1).max(192) }).strict(),
    outputSchema: resultOutputSchema(z.object({ id: z.string(), provider: z.enum(['alibaba_cloud', 'tencent_cloud']), accountUid: z.string(),
      displayName: z.string(), deletedAt: z.string(), retainedData: z.literal(true) })),
    async call(context, args) {
      const result = await context.client.deleteCloudWorkspace(args.cloudWorkspaceId as string,
        operation({ idempotencyKey: args.idempotencyKey as string | undefined, confirmationId: args.confirmationId as string | undefined }));
      return z.object({ id: z.string(), provider: z.enum(['alibaba_cloud', 'tencent_cloud']), accountUid: z.string(), displayName: z.string(),
        deletedAt: z.string(), retainedData: z.literal(true) }).parse(result);
    },
  },
  {
    name: 'cloud_account_context_list', title: '查询云账号',
    description: '查询已验证的云账号、厂商和地域，不返回凭据。includeInactive=true可查看未启用账号；具体能力由工作空间 capabilities 返回。',
    requiredScopes: ['settings:read'], adminOnly: true, readOnlyHint: true,
    inputSchema: z.object({ includeInactive: z.boolean().optional() }).strict(),
    outputSchema: resultOutputSchema(z.array(cloudContextSchema)),
    async call(context, args) { return (await context.client.listCloudAccountContexts(args.includeInactive === true)).map(safeCloudContext); },
  },
  {
    name: 'tencent_cloud_account_save', title: '验证并保存腾讯云账号',
    description: '按明确指定的地域、可用区和腾讯云凭据验证账号并加密保存。保存不切换当前工作空间；创建和费用同步能力以该空间 capabilities 为准，写入前需要平台确认。',
    requiredScopes: ['settings:write'], adminOnly: true,
    inputSchema: operationSchema.extend({ provider: z.literal('tencent_cloud'), regionId: z.string().trim().min(1), zoneId: z.string().trim().min(1), accessKeyId: sensitiveKey, accessKeySecret: sensitiveKey }).strict(),
    outputSchema: resultOutputSchema(tencentAccountSchema),
    async call(context, args) {
      const { idempotencyKey, confirmationId, ...payload } = args;
      return tencentAccountSchema.parse(await context.client.saveTencentCloudAccount(payload as SaveTencentCloudAccountInput, operation({ idempotencyKey: idempotencyKey as string | undefined, confirmationId: confirmationId as string | undefined })));
    },
  },
  {
    name: 'tencent_cloud_region_list', title: '查询腾讯云地域与可用区',
    description: '使用明确授权的腾讯云凭据只读查询最多三个指定地域的CVM可用区；不保存凭据、不创建资源。返回云端可用地域，可按用户指定顺序选择。',
    requiredScopes: ['settings:read'], adminOnly: true, readOnlyHint: true,
    inputSchema: z.object({ regionIds: z.array(z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/)).min(1).max(3).refine(ids => new Set(ids).size === ids.length, 'Region IDs must be unique'), accessKeyId: sensitiveKey, accessKeySecret: sensitiveKey }).strict(),
    outputSchema: resultOutputSchema(z.object({ provider: z.literal('tencent_cloud'), regions: z.array(z.object({ regionId: z.string(), displayName: z.string(), zones: z.array(z.object({ zoneId: z.string(), displayName: z.string() })) })) })),
    async call(context, args) { return context.client.discoverTencentCloudRegions(args as TencentCloudRegionsInput); },
  },
  {
    name: 'tencent_cloud_image_list', title: '查询腾讯云镜像目录',
    description: '只读查询指定已验证腾讯云账号和地域的公共/自定义镜像，按offset/limit分页，不收录镜像或认领其费用。',
    requiredScopes: ['settings:read', 'images:read'], adminOnly: true, readOnlyHint: true,
    inputSchema: z.object({ cloudAccountContextId: z.string().trim().min(1), scope: z.enum(['public', 'custom']), offset: z.number().int().min(0).max(100_000).optional(), limit: z.number().int().min(1).max(100).optional() }).strict(),
    outputSchema: resultOutputSchema(z.object({ provider: z.literal('tencent_cloud'), cloudAccountContextId: z.string(), accountUid: z.string(), regionId: z.string(), zoneId: z.string(), scope: z.enum(['public', 'custom']), offset: z.number().int(), limit: z.number().int(), totalCount: z.number().int(), items: z.array(z.object({ imageId: z.string(), displayName: z.string(), status: z.string(), platform: z.string().nullable(), architecture: z.string().nullable(), isAvailable: z.boolean() })) })),
    async call(context, args) { return context.client.listTencentCloudImages(args as TencentCloudImagesInput); },
  },
  {
    name: 'cloud_account_instance_type_availability', title: '查询云账号可售机型',
    description: '只读查询指定云账号已保存可用区中满足CPU、内存规格的按量付费机型；可售不代表已开放实例创建。',
    requiredScopes: ['settings:read'], adminOnly: true, readOnlyHint: true,
    inputSchema: z.object({ cloudAccountContextId: z.string().trim().min(1), cpu: z.number().int().min(1).max(1024), memory: z.number().int().min(1).max(4096) }).strict(),
    outputSchema: resultOutputSchema(z.object({
      cpu: z.number(), memory: z.number(), regionId: z.string(), zoneId: z.string(), exactAvailable: z.boolean(),
      matches: z.array(z.object({ instanceTypeId: z.string(), cpu: z.number(), memoryGiB: z.number(),
        family: z.string().nullable(), generation: z.string().nullable(), architecture: z.string().nullable() })),
      warning: z.string().nullable(),
    })),
    async call(context, args) { return context.client.getCloudAccountInstanceTypeAvailability(args.cloudAccountContextId as string, args.cpu as number, args.memory as number); },
  },
  {
    name: 'cloud_config_get',
    title: '查询云基础配置',
    description: '对应基础配置页的当前云配置。返回默认地域、可用区和配置状态；任何密钥字段均为脱敏状态，不能回写或复用。',
    requiredScopes: ['settings:read'],
    readOnlyHint: true,
    inputSchema: cloudConfigGetInputSchema,
    outputSchema: resultOutputSchema(
      z.object({
        provider: z.enum(['alibaba_cloud', 'tencent_cloud']).describe('当前数据空间的云厂商。'),
        defaultRegion: z.string().describe('默认地域。'),
        defaultZoneId: z.string().describe('默认可用区。'),
      }).passthrough(),
    ),
    async call(context) {
      return maskCloudConfig(await context.client.fetchCloudConfig());
    },
  },
  {
    name: 'cloud_config_update',
    title: '更新云基础配置',
    description: '对应基础配置页的配置保存。只更新明确传入的默认地域、可用区或云凭据字段，影响后续资源创建，调用前必须取得用户确认。',
    requiredScopes: ['settings:write'], adminOnly: true,
    inputSchema: cloudConfigUpdateInputSchema,
    outputSchema: resultOutputSchema(
      z.object({
        provider: z.enum(['alibaba_cloud', 'tencent_cloud']).describe('当前云厂商。'),
        defaultRegion: z.string().describe('更新后的默认地域。'),
        defaultZoneId: z.string().describe('更新后的默认可用区。'),
      }).passthrough(),
    ),
    async call(context, args) {
      const { idempotencyKey, confirmationId, ...payload } = args as Record<string, unknown> & {
        idempotencyKey?: string;
        confirmationId?: string;
      };
      return maskCloudConfig(await context.client.saveCloudConfig(payload, operation({ idempotencyKey, confirmationId })));
    },
  },
];
