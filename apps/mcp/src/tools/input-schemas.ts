import * as z from 'zod/v4';

import { topologyGraphSchema } from './template-schemas';

export const identifier = z.string().trim().min(1).describe('由对应查询工具返回的平台唯一标识。');
export const isoDateTime = z.iso.datetime({ offset: true }).describe('带时区的 ISO-8601 时间，例如 2026-07-23T08:00:00.000Z。');
export const isoDate = z.iso.date().describe('ISO-8601 日期，格式为 YYYY-MM-DD。');
export const operationSchema = z.object({
  idempotencyKey: identifier.optional().describe('仅在服务端要求时传入；相同写请求需复用同一幂等键。'),
  confirmationId: identifier.optional().describe('仅当平台返回 CONFIRMATION_REQUIRED 后传入对应确认 ID。'),
});

const viewSchema = z.enum(['active', 'history']).optional();
const singleInstanceActionFields = {
  singleInstanceId: identifier,
  displayName: z.string().trim().min(1).optional(),
  defaultHostName: z.string().trim().min(1).optional(),
  defaultPassword: z.string().min(1).optional().describe('Sensitive. Only provide when explicitly requested.'),
  description: z.string().optional(),
};

export const imageListInputSchema = z.object({
  view: z.enum(['platform', 'mine']).optional().describe('platform 查询平台可用镜像；mine 查询当前用户可管理的镜像。'),
});
export const imageTagListInputSchema = z.object({}).strict();
export const imageTagCreateInputSchema = operationSchema.extend({
  name: z.string().trim().min(1).max(32).describe('全局镜像标签名称，最多32字符；仅管理员可创建。'),
}).strict();
export const imageTagsSetInputSchema = operationSchema.extend({
  platformImageAssetId: identifier.describe('当前调用者可管理的准确镜像资产ID。'),
  tagIds: z.array(identifier).refine(ids => new Set(ids).size === ids.length, 'tagIds不得重复').describe('完整的目标标签ID集合；空数组清空该资产的全部关联。'),
}).strict();
export const imageCollectInputSchema = operationSchema.extend({
  snapshotId: identifier.describe('镜像目录返回的快照 ID。'),
  displayName: identifier.describe('收录后显示给平台用户的镜像名称。'),
});
export const imageRenameInputSchema = operationSchema.extend({
  platformImageAssetId: identifier.describe('平台镜像资产 ID。'),
  displayName: identifier.describe('新的非空显示名称。'),
});
export const imageAssetOperationInputSchema = operationSchema.extend({
  platformImageAssetId: identifier.describe('平台镜像资产 ID。'),
});
export const imageCatalogListInputSchema = z.object({
  scope: z.enum(['public', 'custom']).describe('public 为公共镜像目录；custom 为当前云账号的自定义镜像目录。'),
});
export const imageCatalogSyncInputSchema = z.object({
  scope: z.enum(['public', 'custom']).describe('要同步的镜像目录范围。'),
});
export const imageCatalogCustomDeleteInputSchema = operationSchema.extend({
  snapshotId: identifier.describe('自定义镜像目录中要永久删除的快照 ID。'),
  deleteOwnedSnapshots: z.boolean().optional().describe('仅对当前平台新打包且有完整owner/UID/地域证明的镜像，显式回收其确切backing snapshots；旧镜像或未知来源会拒绝。'),
});
export const imageImportJobListInputSchema = z.object({});
export const imageImportJobRetryInputSchema = z.object({
  imageImportJobId: identifier.describe('状态为 failed 的镜像导入任务 ID。'),
});

const billingWindowFields = {
  startAt: isoDate.optional().describe('统计起始日期；与 endAt 必须同时提供。省略两者时使用平台默认窗口。'),
  endAt: isoDate.optional().describe('统计结束日期；与 startAt 必须同时提供。省略两者时使用平台默认窗口。'),
};

const billingWindowSchema = z.object(billingWindowFields).refine(
  (input) => (input.startAt === undefined) === (input.endAt === undefined),
  'startAt 和 endAt 必须同时提供或同时省略',
);

const billingPageFields = {
  page: z.number().int().min(1).optional().describe('页码，省略时为第 1 页。'),
  pageSize: z.union([z.literal(20), z.literal(50), z.literal(100)]).optional().describe('每页条数，默认 20。'),
};

const billingListWindowSchema = billingWindowSchema.extend(billingPageFields);

export const billingSummaryInputSchema = billingWindowSchema.pick({ startAt: true, endAt: true });
export const billingUsersInputSchema = billingListWindowSchema;
export const billingUserSummaryInputSchema = billingWindowSchema.extend({
  userId: identifier.describe('要查看费用汇总的平台用户 ID。'),
});
export const billingUserGroupsInputSchema = billingListWindowSchema.extend({
  userId: identifier.optional().describe('可选。仅查看指定平台用户的启动费用分组。'),
});
export const billingPlatformGroupsInputSchema = billingListWindowSchema;
export const billingUserItemsInputSchema = billingWindowSchema.extend({
  userId: identifier.describe('要查看明细的平台用户 ID。'),
});
export const billingPlatformItemsInputSchema = billingWindowSchema;
export const billingAnomaliesInputSchema = billingWindowSchema;
export const billingSyncInputSchema = billingSummaryInputSchema;
export const billingExportPlatformCsvInputSchema = billingSummaryInputSchema;
export const billingExportUsersCsvInputSchema = billingSummaryInputSchema;
export const billingExportUserCsvInputSchema = billingSummaryInputSchema.extend({
  userId: identifier.describe('要导出费用明细的平台用户 ID。'),
});

export const rangeListInputSchema = z.object({ view: viewSchema });
export const rangeInstanceIdInputSchema = z.object({ rangeInstanceId: identifier });
export const rangeInstanceGetInputSchema = rangeInstanceIdInputSchema.extend({
  includeNetworkDiagnostics: z.boolean().optional().describe('仅在需要核验网络时设为 true；只读查询该实例绑定账号和地域中的 ECS、网卡、安全组、ACL、NAT 与路由白名单事实，不接受云资源 ID。'),
}).strict();
export const rangeNodePackImageValidateInputSchema = rangeInstanceIdInputSchema.extend({
  nodeId: identifier.describe('当前编排实例中的源 CVM 节点 ID，服务端核对原账号和 owner。'),
  displayName: z.string().trim().min(1).max(60).describe('拟打包镜像的准确名称；该核验不会创建镜像。'),
  description: z.string().max(256).optional(),
}).strict();
export const rangeLaunchInputSchema = operationSchema.extend({
  templateId: identifier,
  name: identifier,
  expiresAt: isoDateTime,
});
export const rangeDestroyInputSchema = operationSchema.extend({ rangeInstanceId: identifier });
export const rangeRetryInputSchema = operationSchema.extend({ rangeInstanceId: identifier });
export const rangeTopologyChangeInputSchema = operationSchema.extend({
  rangeInstanceId: identifier,
  topologyGraph: topologyGraphSchema.describe('完整的实例拓扑图。由实例编排转换 Skill 生成；MCP 会自行编译运行规格，不能传派生字段。'),
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
export const rangeNodeVerifyDnsInputSchema = operationSchema.extend({
  rangeInstanceId: identifier,
  nodeId: identifier.describe('编排实例详情中配置了自定义 DNS 的 ECS 节点 ID。'),
}).strict();
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
  defaultRegion: identifier.optional().describe('默认地域；跨地域变更时必须同时指定该地域的 defaultZoneId。'),
  defaultZoneId: identifier.optional(),
  accessKeyId: identifier.refine((value) => value !== '********', 'Masked access keys cannot be reused').optional(),
  accessKeySecret: z.string().min(1).refine((value) => value !== '********', 'Masked access keys cannot be reused').optional().describe('Sensitive. Never echo it in a summary.'),
}).refine(
  (input) => input.defaultRegion !== undefined || input.defaultZoneId !== undefined || input.accessKeyId !== undefined || input.accessKeySecret !== undefined,
  'at least one cloud configuration field is required',
);

export const provisionJobGetInputSchema = z.object({ provisionJobId: identifier });
