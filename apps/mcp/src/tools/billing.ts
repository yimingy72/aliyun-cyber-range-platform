import type { BillingGroupInput, BillingWindowInput } from '@aliyun-cyber-range/platform-api-client';

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
  const lines = csv.split(/\r?\n/).filter((line) => line.length > 0);

  return {
    fileName,
    rowCount: Math.max(lines.length - 1, 0),
    csv,
  };
}

export const billingTools: ToolDefinition[] = [
  {
    name: 'billing_summary_get',
    title: '查询账单费用汇总',
    description: '对应账单费用页的概览。返回统计窗口内的总费用、平台费用、异常数量、资源类型汇总和每日汇总。',
    requiredScopes: ['billing:read'],
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
    description: '对应账单费用页的用户费用列表。按费用从高到低返回用户、费用、账单条目数和启动次数。',
    requiredScopes: ['billing:read'],
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
    requiredScopes: ['billing:read'],
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
    description: '对应账单费用页的用户启动费用分组。可按指定用户和统计窗口筛选，返回关联实例及账单明细。',
    requiredScopes: ['billing:read'],
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
    description: '对应账单费用页的平台费用分组。返回平台归属资源按启动记录或未归属费用的分组。',
    requiredScopes: ['billing:read'],
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
    requiredScopes: ['billing:read'],
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
    requiredScopes: ['billing:read'],
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
    description: '对应账单费用页的异常列表。返回未能归属到用户或平台资源台账的账单条目及原因。',
    requiredScopes: ['billing:read'],
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
    description: '对应账单费用页的“同步账单”。从阿里云 BSS 拉取指定日期范围的账单并刷新平台归属结果；不创建或销毁云资源，调用前必须取得用户确认。',
    requiredScopes: ['billing:sync'],
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
    requiredScopes: ['billing:read'],
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
    requiredScopes: ['billing:read'],
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
    requiredScopes: ['billing:read'],
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
