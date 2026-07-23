import * as z from 'zod/v4';

import { topologyGraphSchema } from './template-schemas';

export const identifier = z.string().trim().min(1);
export const isoDateTime = z.iso.datetime({ offset: true });
export const operationSchema = z.object({
  idempotencyKey: identifier.optional().describe('Reuse only for an identical write request when the server requires it.'),
  confirmationId: identifier.optional().describe('Provide only after the platform returns CONFIRMATION_REQUIRED.'),
});

const viewSchema = z.enum(['active', 'history']).optional();
const singleInstanceActionFields = {
  singleInstanceId: identifier,
  displayName: z.string().trim().min(1).optional(),
  defaultHostName: z.string().trim().min(1).optional(),
  defaultPassword: z.string().min(1).optional().describe('Sensitive. Only provide when explicitly requested.'),
  description: z.string().optional(),
};

export const imageListInputSchema = z.object({ view: z.enum(['platform', 'mine']).optional() });
export const imageCollectInputSchema = operationSchema.extend({ snapshotId: identifier, displayName: identifier });
export const imageRenameInputSchema = operationSchema.extend({ platformImageAssetId: identifier, displayName: identifier });
export const imageAssetOperationInputSchema = operationSchema.extend({ platformImageAssetId: identifier });

export const rangeListInputSchema = z.object({ view: viewSchema });
export const rangeInstanceIdInputSchema = z.object({ rangeInstanceId: identifier });
export const rangeLaunchInputSchema = operationSchema.extend({
  templateId: identifier,
  name: identifier,
  expiresAt: isoDateTime,
});
export const rangeDestroyInputSchema = operationSchema.extend({ rangeInstanceId: identifier });
export const rangeRetryInputSchema = operationSchema.extend({ rangeInstanceId: identifier });
export const rangeDeleteFailedInputSchema = operationSchema.extend({ rangeInstanceId: identifier });
export const rangeTopologyChangeInputSchema = operationSchema.extend({
  rangeInstanceId: identifier,
  topologyGraph: topologyGraphSchema.describe('完整的实例拓扑图。由实例编排转换 Skill 生成；MCP 会自行编译运行规格，不能传派生字段。'),
  primaryVpcCidr: identifier.optional(),
  secondaryVpcCidrs: z.array(identifier).max(4).optional(),
  publicEntryProtocols: z.array(z.object({ protocol: identifier, port: z.number().int().min(1).max(65535) })).min(1).optional(),
});
const rangeNodeActionFields = {
  rangeInstanceId: identifier,
  nodeId: identifier.describe('编排实例详情中 ECS 节点的 ID。'),
  displayName: z.string().trim().min(1).optional(),
  defaultHostName: z.string().trim().min(1).optional(),
  defaultPassword: z.string().min(1).optional().describe('敏感字段，仅在用户明确指定打包镜像默认密码时提供。'),
  description: z.string().optional(),
};
export const rangeNodeActionInputSchema = operationSchema.extend(rangeNodeActionFields);
export const rangeNodeOpenVncInputSchema = z.object({
  rangeInstanceId: identifier,
  nodeId: identifier.describe('编排实例详情中 ECS 节点的 ID。'),
});

export const singleInstanceListInputSchema = z.object({ view: viewSchema });
export const singleInstanceIdInputSchema = z.object({ singleInstanceId: identifier });
export const singleInstanceLaunchInputSchema = operationSchema.extend({
  name: identifier,
  hostName: z.string().trim().min(1).optional(),
  platformImageAssetId: identifier,
  cpu: z.number().int().positive(),
  memory: z.number().int().positive(),
  systemDiskSize: z.number().int().min(20).optional(),
  expiresAt: isoDateTime,
  password: z.string().min(1).optional().describe('Sensitive. Only provide when explicitly requested.'),
  quantity: z.number().int().min(1).max(99),
  remark: z.string().optional(),
});
export const singleInstanceDestroyInputSchema = operationSchema.extend({ singleInstanceId: identifier });
export const singleInstanceBatchDestroyInputSchema = operationSchema.extend({ batchId: identifier });
export const singleInstanceRetryInputSchema = operationSchema.extend({ singleInstanceId: identifier });
export const singleInstanceRebootInputSchema = operationSchema.extend(singleInstanceActionFields);
export const singleInstanceOpenVncInputSchema = z.object(singleInstanceActionFields);
export const singleInstancePackImageInputSchema = operationSchema.extend(singleInstanceActionFields);
export const singleInstanceBatchExportCsvInputSchema = z.object({ batchId: identifier, view: viewSchema });

export const adminUserListInputSchema = z.object({});
export const adminUserCreateInputSchema = operationSchema.extend({
  username: identifier,
  password: z.string().min(1).describe('Sensitive. Never echo it in a summary.'),
  role: z.enum(['admin', 'user']),
});
export const adminUserRoleInputSchema = operationSchema.extend({ userId: identifier, role: z.enum(['admin', 'user']) });
export const adminUserStatusInputSchema = operationSchema.extend({ userId: identifier, status: z.enum(['active', 'disabled']) });
export const adminUserResetPasswordInputSchema = operationSchema.extend({
  userId: identifier,
  password: z.string().min(1).describe('Sensitive. Never echo it in a summary.'),
});

export const cloudConfigGetInputSchema = z.object({});
export const cloudConfigUpdateInputSchema = operationSchema.extend({
  defaultRegion: identifier.optional(),
  defaultZoneId: identifier.optional(),
  accessKeyId: identifier.optional(),
  accessKeySecret: z.string().min(1).optional().describe('Sensitive. Never echo it in a summary.'),
}).refine(
  (input) => input.defaultRegion !== undefined || input.defaultZoneId !== undefined || input.accessKeyId !== undefined || input.accessKeySecret !== undefined,
  'at least one cloud configuration field is required',
);

export const provisionJobGetInputSchema = z.object({ provisionJobId: identifier });
