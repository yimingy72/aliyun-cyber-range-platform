import type { ToolDefinition } from './tool-context';
import { cloudConfigGetInputSchema, cloudConfigUpdateInputSchema } from './input-schemas';
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

export const settingsTools: ToolDefinition[] = [
  {
    name: 'cloud_config_get',
    title: '查询云基础配置',
    description: '对应基础配置页的当前云配置。返回默认地域、可用区和配置状态；任何密钥字段均为脱敏状态，不能回写或复用。',
    requiredScopes: ['settings:read'],
    readOnlyHint: true,
    inputSchema: cloudConfigGetInputSchema,
    outputSchema: resultOutputSchema(
      z.object({
        provider: z.literal('alibaba_cloud').describe('当前云厂商。'),
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
    requiredScopes: ['settings:write'],
    inputSchema: cloudConfigUpdateInputSchema,
    outputSchema: resultOutputSchema(
      z.object({
        provider: z.literal('alibaba_cloud').describe('当前云厂商。'),
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
