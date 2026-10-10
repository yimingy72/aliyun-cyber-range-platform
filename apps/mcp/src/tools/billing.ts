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

export const billingTools: ToolDefinition[] = [
  {
    name: 'billing_summary_get',
    title: '查询账单费用汇总',
    description: '对应账单费用页的概览。billingScope=platform_resources表示仅统计有平台创建来源证明的资源。返回已归属费用，多币种总金额为null并读取currencyTotals。unallocatedCurrencyTotals仅含已证明属于平台但待分配的精确金额，禁止加入外部或账号混合聚合费用；resourcesWithoutBillCount仅统计平台创建资源尚未匹配账单的数量。reconciliationIssues指出已知平台快照/OSS资源的待核对项，unknown表示平台创建链已知但历史账号/归属来源待核验，均不含账号聚合金额。待出账不代表免费，billingStatus=provisional表示金额可能补账或调整；旧接口缺失scope或对账字段表示范围/覆盖未知，不能当作零或平台支出。',
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
