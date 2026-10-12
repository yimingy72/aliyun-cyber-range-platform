import type { BillingGroupInput, BillingWindowInput, BindOssBillingInput } from '@aliyun-cyber-range/platform-api-client';
import * as z from 'zod/v4';

import {
  billingAnomaliesInputSchema,
  billingExportPlatformCsvInputSchema,
  billingExportUserCsvInputSchema,
  billingExportUsersCsvInputSchema,
  billingPlatformGroupsInputSchema,
  billingPlatformItemsInputSchema,
  billingSummaryInputSchema,
  billingSyncInputSchema,
  billingUserGroupsInputSchema,
  billingUserItemsInputSchema,
  billingUserSummaryInputSchema,
  billingUsersInputSchema,
  operationSchema,
} from './input-schemas';
import {
  billingAnomalyListOutputSchema,
  billingGroupListOutputSchema,
  billingLineItemListOutputSchema,
  billingSummaryOutputSchema,
  billingSyncOutputSchema,
  billingUserListOutputSchema,
  csvExportOutputSchema,
  resultOutputSchema,
  billingUserSummarySchema,
} from './output-schemas';
import type { ToolDefinition } from './tool-context';

function toCsvExport(fileName: string, csv: string) {
  let quoted = false;
  let hasContent = false;
  let rows = 0;
  for (const char of csv) {
    if (char === '"') quoted = !quoted;
    if (char === '\n' && !quoted) {
      if (hasContent) rows++;
      hasContent = false;
    } else if (char !== '\r') {
      hasContent = true;
    }
  }
  if (hasContent) rows++;

  return {
    fileName,
    rowCount: Math.max(rows - 1, 0),
    csv,
  };
}

const ossBindingSchema = z.object({ ledgerId: z.string(), bucketName: z.string(), cloudWorkspaceId: z.string(), cloudAccountUid: z.string(), regionId: z.string(),
  effectiveStartAt: z.iso.datetime({ offset: true }), effectiveEndAt: z.iso.datetime({ offset: true }).nullable(), declaredAt: z.iso.datetime({ offset: true }),
  declaredByUserId: z.string(), bucketCreatedAt: z.iso.datetime({ offset: true }), verifiedAt: z.iso.datetime({ offset: true }), officialRequestId: z.string(),
  status: z.enum(['active', 'ended']) });
const operation = (args: Record<string, unknown>) => ({ idempotencyKey: args.idempotencyKey as string | undefined, confirmationId: args.confirmationId as string | undefined });

export const billingTools: ToolDefinition[] = [
  {
    name: 'billing_oss_bucket_binding_list', title: '查询阿里云专用 OSS 桶费用归属',
    description: '返回当前空间的专用OSS桶声明、生效区间及官方身份核验证据。不含凭据；绑定不代表费用已出账。',
    requiredScopes: ['billing:read'], adminOnly: true, readOnlyHint: true,
    inputSchema: z.object({}).strict(), outputSchema: resultOutputSchema(z.array(ossBindingSchema)),
    async call(context) { return z.array(ossBindingSchema).parse(await context.client.listOssBillingBindings()); },
  },
  {
    name: 'billing_oss_bucket_bind', title: '登记阿里云平台专用 OSS 桶费用归属',
    description: '仅平台超管可声明当前配置桶专供平台使用，并指定固定生效时间。核对官方桶Owner、地域和出生信息，费用起点不能早于平台计费起点。只认完整生效账日的官方桶级分账，地域汇总和其他桶费用不计入；明细缺失保留待对账并由定时同步补齐。混用桶不可声明为专用。不会创建或删除云资源。',
    requiredScopes: ['billing:sync', 'settings:write'], adminOnly: true, annotations: { idempotentHint: true },
    inputSchema: operationSchema.extend({ bucketName: z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/), effectiveStartAt: z.iso.datetime({ offset: true }), dedicated: z.literal(true) }).strict(),
    outputSchema: resultOutputSchema(ossBindingSchema),
    async call(context, args) {
      const { idempotencyKey, confirmationId, ...payload } = args;
      return ossBindingSchema.parse(await context.client.bindOssBilling(payload as BindOssBillingInput, operation({ idempotencyKey, confirmationId })));
    },
  },
  {
    name: 'billing_oss_bucket_binding_end', title: '结束阿里云专用 OSS 桶费用归属',
    description: '仅平台超管可结束准确ledgerId的专用归属声明。结束时间由服务器确定，保留历史已核验费用与审计；不删除存储桶或对象。结束后不自动恢复或认领完整性未知的部分账日。',
    requiredScopes: ['billing:sync', 'settings:write'], adminOnly: true, annotations: { idempotentHint: true },
    inputSchema: operationSchema.extend({ ledgerId: z.string().trim().min(1).max(192) }).strict(), outputSchema: resultOutputSchema(ossBindingSchema),
    async call(context, args) { return ossBindingSchema.parse(await context.client.endOssBillingBinding(args.ledgerId as string, operation(args))); },
  },
  {
    name: 'billing_summary_get',
    title: '查询账单费用汇总',
    description: '对应账单费用页的概览。billingScope=platform_resources统计有平台创建来源证明的资源，以及超管明确声明且官方身份已核验的阿里云专用OSS桶。platformBillingStartedAt限定新资源出生和专用桶生效起点，旧资源迟到账不纳入；历史记录保留审计。源ECS快照分账须完整来源证明，金额记录一次并关联快照集合，不拆算每个快照。缺明细、缺证明或部分专用账日保留reconciliationIssues；官方完整分账和证明到齐后定时同步补账。多币种读取currencyTotals；unallocatedCurrencyTotals只含已证明平台费用，不能加账号/地域混合金额。resourcesWithoutBillCount不含SNAT/DNAT、阿里云镜像和已核实主机系统盘组件。disk历史映射未知不代表另有费用。billingStatus=provisional表示金额可能补账调整；缺字段表示未知，不能当作零。',
    requiredScopes: ['billing:read'], adminOnly: true,
    readOnlyHint: true,
    inputSchema: billingSummaryInputSchema,
    outputSchema: billingSummaryOutputSchema,
    call(context, args) {
      return context.client.getBillingSummary(args as BillingWindowInput);
    },
  },
  {
    name: 'billing_user_list',
    title: '查询用户费用汇总',
    description: '对应账单费用页的用户费用列表。先按币种、再按同币种费用降序返回指定页的用户、费用、账单条目数、启动次数和总数；多币种用户读取amounts。',
    requiredScopes: ['billing:read'], adminOnly: true,
    readOnlyHint: true,
    inputSchema: billingUsersInputSchema,
    outputSchema: billingUserListOutputSchema,
    call(context, args) {
      return context.client.listBillingUsers(args as BillingWindowInput);
    },
  },
  {
    name: 'billing_user_summary_get',
    title: '查询单个用户费用汇总',
    description: '返回指定平台用户在统计窗口内的费用、条目数和启动次数；用户 ID 必须先由用户费用列表或用户管理工具确认。',
    requiredScopes: ['billing:read'], adminOnly: true,
    readOnlyHint: true,
    inputSchema: billingUserSummaryInputSchema,
    outputSchema: resultOutputSchema(billingUserSummarySchema),
    call(context, args) {
      const input = args as BillingWindowInput & { userId: string };
      const { userId, ...window } = input;
      return context.client.getBillingUserSummary(userId, window);
    },
  },
  {
    name: 'billing_user_group_list',
    title: '查询用户启动费用分组',
    description: '对应账单费用页的用户启动费用分组。可按指定用户和统计窗口筛选，返回指定页、关联实例、账单明细和总数。',
    requiredScopes: ['billing:read'], adminOnly: true,
    readOnlyHint: true,
    inputSchema: billingUserGroupsInputSchema,
    outputSchema: billingGroupListOutputSchema,
    call(context, args) {
      return context.client.listBillingUserGroups(args as BillingGroupInput);
    },
  },
  {
    name: 'billing_platform_group_list',
    title: '查询平台费用分组',
    description: '对应账单费用页的平台费用分组。返回指定页的平台归属资源分组及总数。',
    requiredScopes: ['billing:read'], adminOnly: true,
    readOnlyHint: true,
    inputSchema: billingPlatformGroupsInputSchema,
    outputSchema: billingGroupListOutputSchema,
    call(context, args) {
      return context.client.listBillingPlatformGroups(args as BillingWindowInput);
    },
  },
  {
    name: 'billing_user_item_list',
    title: '查询用户费用明细',
    description: '对应账单费用页的用户账单条目。返回指定用户在统计窗口内的云资源、日期、金额和币种。',
    requiredScopes: ['billing:read'], adminOnly: true,
    readOnlyHint: true,
    inputSchema: billingUserItemsInputSchema,
    outputSchema: billingLineItemListOutputSchema,
    call(context, args) {
      const input = args as BillingWindowInput & { userId: string };
      const { userId, ...window } = input;
      return context.client.listBillingUserItems(userId, window);
    },
  },
  {
    name: 'billing_platform_item_list',
    title: '查询平台费用明细',
    description: '对应账单费用页的平台账单条目。返回平台归属资源在统计窗口内的费用明细。',
    requiredScopes: ['billing:read'], adminOnly: true,
    readOnlyHint: true,
    inputSchema: billingPlatformItemsInputSchema,
    outputSchema: billingLineItemListOutputSchema,
    call(context, args) {
      return context.client.listBillingPlatformItems(args as BillingWindowInput);
    },
  },
  {
    name: 'billing_anomaly_list',
    title: '查询账单异常',
    description: '返回已证明属于平台创建资源但未能完成分配的精确异常账单及原因，不返回外部资源或账号混合聚合金额。待细分或来源待核验的平台资源参见billing_summary_get的reconciliationIssues。',
    requiredScopes: ['billing:read'], adminOnly: true,
    readOnlyHint: true,
    inputSchema: billingAnomaliesInputSchema,
    outputSchema: billingAnomalyListOutputSchema,
    call(context, args) {
      return context.client.listBillingAnomalies(args as BillingWindowInput);
    },
  },
  {
    name: 'billing_sync',
    title: '同步账单数据',
    description: '对应账单费用页的“同步账单”。按当前已验证云账号UID和完整账期原子刷新BSS账单；省略日期重刷最近7个完整账日，显式日期精确刷新，可选择月初至月末核对整月费用。今天和未来日期延后并返回deferredDates。新资源即时无账单不能判定费用为零，调用前必须取得用户确认。',
    requiredScopes: ['billing:sync'], adminOnly: true,
    annotations: { idempotentHint: true },
    inputSchema: billingSyncInputSchema,
    outputSchema: billingSyncOutputSchema,
    call(context, args) {
      return context.client.syncBilling(args as Pick<BillingWindowInput, 'startAt' | 'endAt'>);
    },
  },
  {
    name: 'billing_export_platform_csv',
    title: '导出平台费用 CSV',
    description: '对应账单费用页的“导出平台费用”。生成统计窗口的平台费用汇总 CSV；调用前必须取得用户明确的导出授权。',
    requiredScopes: ['billing:read'], adminOnly: true,
    readOnlyHint: true,
    inputSchema: billingExportPlatformCsvInputSchema,
    outputSchema: csvExportOutputSchema,
    async call(context, args) {
      const csv = await context.client.exportPlatformBillingCsv(args as Pick<BillingWindowInput, 'startAt' | 'endAt'>);
      return toCsvExport('platform-billing.csv', csv);
    },
  },
  {
    name: 'billing_export_users_csv',
    title: '导出用户费用 CSV',
    description: '对应账单费用页的“导出用户费用”。生成统计窗口的用户费用汇总 CSV；调用前必须取得用户明确的导出授权。',
    requiredScopes: ['billing:read'], adminOnly: true,
    readOnlyHint: true,
    inputSchema: billingExportUsersCsvInputSchema,
    outputSchema: csvExportOutputSchema,
    async call(context, args) {
      const csv = await context.client.exportBillingUsersCsv(args as Pick<BillingWindowInput, 'startAt' | 'endAt'>);
      return toCsvExport('billing-users.csv', csv);
    },
  },
  {
    name: 'billing_export_user_csv',
    title: '导出单个用户费用 CSV',
    description: '对应账单费用页中用户明细的导出。生成指定用户在统计窗口内的费用条目 CSV；调用前必须取得用户明确的导出授权。',
    requiredScopes: ['billing:read'], adminOnly: true,
    readOnlyHint: true,
    inputSchema: billingExportUserCsvInputSchema,
    outputSchema: csvExportOutputSchema,
    async call(context, args) {
      const input = args as Pick<BillingWindowInput, 'startAt' | 'endAt'> & { userId: string };
      const { userId, ...window } = input;
      const csv = await context.client.exportBillingUserItemsCsv(userId, window);
      return toCsvExport(`billing-user-${userId}.csv`, csv);
    },
  },
];
