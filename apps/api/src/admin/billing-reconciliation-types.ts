import { createHash } from 'node:crypto';
import type { BillingLedgerResourceRecord, CreateBillingLineItemInput, CreateBillingAnomalyInput } from './admin.repository';
export type BillingMode = 'legacy' | 'shadow' | 'resource';
export type BillingTaskPlan = {
    cloudProvider: 'alibaba_cloud' | 'tencent_cloud';
    cloudAccountUid: string;
    cloudAccountContextId: string;
    regionId: string;
    billingDate: string;
    groupKey: string;
    kind: 'direct' | 'split' | 'snapshot_source' | 'parent_group' | 'discovery' | 'planner';
    instanceId?: string | null;
    splitItemId?: string | null;
    productCode?: string | null;
    targetLedgerIds: string[];
    queryPlan?: Record<string, unknown>;
};
export type BillingQueryEvidence = {
    requestIds: string[];
    pageCount: number;
    rowCount: number;
    complete: boolean;
    datasets?: Array<{ action: string; accountUid: string; billingDate: string; instanceId?: string; splitItemId?: string; productCode?: string; tagFilter?: { key: 'RangeInstanceId'; value: string };
        complete: boolean; rows: Array<Record<string, unknown>> }>;
};
export type ScopedBillingGroup = {
    groupKey: string;
    productCode: string;
    instanceId: string;
    items: CreateBillingLineItemInput[];
    anomalies: CreateBillingAnomalyInput[];
};
export type ScopedBillingResult = {
    groups: ScopedBillingGroup[];
    coveredLedgerIds: string[];
    rowCount: number;
    coveredCategories?: Record<string, string[]>;
    verifiedLedgerIds?: string[];
    issue?: {
        code: string;
        message: string;
    };
    evidence?: Record<string, unknown>;
};
export const billingKey = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const financialGroupKey = (provider: string, uid: string, date: string, product: string, instance: string) => billingKey([provider, uid, date, product, instance]);
export const billingDateText = (value: Date) => value.toISOString().slice(0, 10);
export function billingDates(start: string, end: string) {
    const dates: string[] = [];
    for (let at = Date.parse(start + 'T00:00:00Z'); at <= Date.parse(end + 'T00:00:00Z'); at += 86400000)
        dates.push(new Date(at).toISOString().slice(0, 10));
    return dates;
}
export const independentBillResource = (row: BillingLedgerResourceRecord) => !['image', 'snat_entry', 'dnat_entry', 'unknown', 'snapshot_region'].includes(row.cloudResourceType);
export const RECONCILIATION_RULE_VERSION = 1;
export const BILLING_REASONS: Record<string, string> = {
    NO_BILL_RETURNED: '本次完整查询暂未返回对应明细，金额仍待核实。',
    EIP_BILL_NOT_RETURNED: '普通账单及按 EIP ID 查询的分账均未返回明细，金额仍待核实。',
    SNAPSHOT_BILL_NOT_RETURNED: '按快照 ID 和原源主机查询均未返回对应费用明细，金额仍待核实。',
    EIP_CONFIGURATION_BILL_NOT_RETURNED: '公网流量或带宽费用已核对，EIP 配置费明细仍未返回。',
    EIP_NETWORK_BILL_NOT_RETURNED: 'EIP 配置费已核对，公网流量或带宽费用明细仍未返回。',
    NOT_YET_DUE: '该账日尚未结束，等待官方出账后核对。',
    SOURCE_UNVERIFIED: '资源创建来源或原云账号尚未核实。',
    ALLOCATION_PENDING: '官方汇总或分账尚不能完整归属到该资源。',
    SPLIT_UNAVAILABLE: '分账账单暂不可用，请核对是否开通及账号权限。',
    QUERY_FAILED: '账单查询未完成，保留上次已核验金额。',
    QUERY_FILTER_UNVERIFIED: '官方返回的账单标签与指定原编排不符，已停止补查并保留原金额。',
    ACCOUNT_CHANGED: '原计费账号或地域已变化，未改写账单。',
    HISTORY_UNAVAILABLE: '历史证据超出可查询范围，保留待核对记录。',
    PARENT_COVERAGE: '费用已由准确关联的主机收费组件或源计费组覆盖，不重复计费。',
    SHADOW_VERIFIED: '已完成核对，等待采用本次结果。',
    QUERY_PERMISSION_DENIED: '官方账单查询权限不足，请核对原云账号的费用读取权限。',
    BILLING_AMOUNT_PRECISION: '官方金额精度超出当前支持范围，已保存明细并保留原金额。',
    SNAPSHOT_BASELINE_MISSING: '缺少打包提交时的完整快照基线，不能认领源 ECS 汇总金额。',
    SNAPSHOT_BASELINE_INVALID: '原打包基线与当前账号、源盘或产物身份不符，不能认领源 ECS 汇总金额。',
    SNAPSHOT_POLICY_BASELINE_UNVERIFIED: '提交时存在自动快照策略，尚不能证明源 ECS 的全部快照费用归属。',
    SNAPSHOT_BASELINE_NOT_MATURE: '原打包基线不足以核验该账日结束前的完整快照范围。',
    SNAPSHOT_HISTORY_UNAVAILABLE: '源 ECS 的完整历史审计暂不可获取，保留快照费用待核对。',
};
