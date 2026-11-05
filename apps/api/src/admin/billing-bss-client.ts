import { Injectable, Optional } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { PrismaService } from '../database/prisma.service';
import { requireCurrentCloudWorkspaceId } from '../auth/cloud-workspace-scope';
import type { BillingQueryEvidence } from './billing-reconciliation-types';
import { sanitizeAliyunErrorCode } from './aliyun-error-code';
import { BillingDecimal } from './billing-amount';

import { signAliyunRpcQuery } from './image-catalog-rpc-signer';
import { SystemConfigService, type SystemCloudAccountContext } from './system-config.service';

type RawBssItem = Record<string, unknown>;
export type SplitBillingProduct = 'snapshot' | 'oss' | 'eip' | 'cdt' | 'cbwp';

type DescribeInstanceBillResponse = {
  Success?: boolean;
  Code?: string;
  Data?: {
    AccountID?: string;
    BillingCycle?: string;
    Items?: RawBssItem[];
    NextToken?: string;
    TotalCount?: number;
  };
};

export class BillingSplitBillUnavailableError extends Error {
  constructor(readonly code: string,readonly requestId?:string) {
    super(`DescribeSplitItemBill unavailable: ${code}; enable split bills and verify permissions; previous bills were retained`);
    this.name = 'BillingSplitBillUnavailableError';
  }
}
export class BillingRpcError extends Error {
  constructor(readonly action:string,readonly code:string,readonly requestId?:string){super(`${action} failed: ${code}; previous bills were retained`);}
}

function formatAliyunTimestamp(value: Date) {
  return value.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function normalizeItems(value: unknown, action = 'DescribeInstanceBill') {
  if (!Array.isArray(value)) {
    throw new Error(`${action} returned an invalid item list`);
  }
  if (value.some(item => !item || typeof item !== 'object' || Array.isArray(item))) {
    throw new Error(`${action} returned an invalid bill row`);
  }
  return value as RawBssItem[];
}

export function assertAlibabaBillingContext(context: { provider?: string }) {
  if (context.provider !== 'alibaba_cloud') {
    throw new Error('当前云厂商尚未接入平台账单同步；原有账单已保留。');
  }
}

@Injectable()
export class BillingBssClient {
  private readonly queryContext = new AsyncLocalStorage<{ evidence: BillingQueryEvidence; beforeRequest?: () => Promise<void> }>();
  constructor(private readonly systemConfigService: SystemConfigService, @Optional() private readonly prisma?: PrismaService) {}

  async captureQuery<T>(evidence: BillingQueryEvidence, work: () => Promise<T>, beforeRequest?: () => Promise<void>) {
    return this.queryContext.run({ evidence, beforeRequest }, async () => {
      const value = await work();
      evidence.complete = true;
      return value;
    });
  }

  async listInstanceLifecycle(instanceIds: string[], context: SystemCloudAccountContext) {
    assertAlibabaBillingContext(context);
    if (!context.accountUid || !context.accountUidResolved || !context.defaultRegion
      || !Array.isArray(instanceIds) || !instanceIds.length || instanceIds.length > 100 || new Set(instanceIds).size !== instanceIds.length
      || instanceIds.some(id => typeof id !== 'string' || !/^(i|d|eip|ngw)-[a-z0-9]+$/.test(id))) throw new Error('Invalid instance lifecycle identity');
    const payload = await this.performRpcRequest<{ Data?: { TotalCount?: number; PageNum?: number; PageSize?: number; InstanceList?: unknown } }>({
      action: 'QueryAvailableInstances', accessKeyId: context.accessKeyId, accessKeySecret: context.accessKeySecret,
      parameters: { InstanceIDs: instanceIds.join(','), PageNum: '1', PageSize: '100' },
    });
    const data = payload.Data;
    if (!data || !Number.isSafeInteger(data.TotalCount) || data.TotalCount! < 0 || data.TotalCount! > instanceIds.length
      || data.PageNum !== 1 || data.PageSize !== 100) throw new Error('Instance lifecycle pagination is unverified');
    const rows = normalizeItems(data.InstanceList ?? (data.TotalCount === 0 ? [] : undefined), 'QueryAvailableInstances');
    const evidence = this.queryContext.getStore()?.evidence;
    if (evidence) evidence.rowCount += rows.length;
    if (rows.length !== data.TotalCount || new Set(rows.map(row => row.InstanceID)).size !== rows.length
      || rows.some(row => typeof row.InstanceID !== 'string' || !instanceIds.includes(row.InstanceID)
        || String(row.OwnerId) !== context.accountUid || row.Region !== context.defaultRegion))
      throw new Error('Instance lifecycle resource/account/region is unverified');
    return rows;
  }

  async listMonthlyOverview(billingCycle: string, context: SystemCloudAccountContext) {
    assertAlibabaBillingContext(context);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(billingCycle) || !context.accountUid || !context.accountUidResolved)
      throw new Error('Invalid monthly overview identity');
    const payload = await this.performRpcRequest<{ Data?: { AccountID?: string; BillingCycle?: string; Items?: { Item?: unknown } } }>({
      action: 'QueryBillOverview', accessKeyId: context.accessKeyId, accessKeySecret: context.accessKeySecret,
      parameters: { BillingCycle: billingCycle, BillOwnerId: context.accountUid },
    });
    const data = payload.Data;
    if (!data || data.AccountID !== context.accountUid || data.BillingCycle !== billingCycle) throw new Error('Monthly overview account/cycle is unverified');
    const rows = normalizeItems(data.Items?.Item, 'QueryBillOverview');
    const evidence = this.queryContext.getStore()?.evidence;
    if (evidence) evidence.rowCount += rows.length;
    if (rows.length > 10_000 || rows.some(row => row.OwnerID != null && row.OwnerID !== '' && String(row.OwnerID) !== context.accountUid))
      throw new Error('Monthly overview resource owner is unverified');
    return rows;
  }

  async listMonthlyNetworkBills(billingCycle: string, productCode: 'eip' | 'cdt' | 'cbwp', context: SystemCloudAccountContext,
    action: 'QueryBill' | 'QuerySettleBill' | 'QueryAccountBill' = 'QueryBill') {
    assertAlibabaBillingContext(context);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(billingCycle) || !['eip', 'cdt', 'cbwp'].includes(productCode)
      || !['QueryBill', 'QuerySettleBill', 'QueryAccountBill'].includes(action)
      || !context.accountUid || !context.accountUidResolved) throw new Error('Invalid network settlement identity');
    const rows: RawBssItem[] = [], fingerprints = new Set<string>(), tokens = new Set<string>();
    let expected: number | null = null, nextToken = '';
    for (let page = 1; page <= 100; page++) {
      const payload: { Data?: { AccountID?: string; BillingCycle?: string; TotalCount?: number;
        PageNum?: number; PageSize?: number; MaxResults?: number; NextToken?: string; Items?: { Item?: unknown } } } = await this.performRpcRequest({
        action, accessKeyId: context.accessKeyId, accessKeySecret: context.accessKeySecret,
        parameters: { BillingCycle: billingCycle, ProductCode: productCode, BillOwnerId: context.accountUid,
          ...(action === 'QueryAccountBill' ? { Granularity: 'MONTHLY', IsGroupByProduct: 'true' } : { IsHideZeroCharge: 'false' }),
          ...(action === 'QuerySettleBill' ? { MaxResults: '300', ...(nextToken ? { NextToken: nextToken } : {}) } : { PageNum: String(page), PageSize: '300' }) },
      });
      const data = payload.Data;
      if (!data || data.AccountID !== context.accountUid || data.BillingCycle !== billingCycle
        || action !== 'QuerySettleBill' && (data.PageNum !== page || data.PageSize !== 300)
        || action === 'QuerySettleBill' && (data.MaxResults != null && data.MaxResults !== 300 || data.NextToken != null && typeof data.NextToken !== 'string')
        || !Number.isSafeInteger(data.TotalCount) || data.TotalCount! < 0 || data.TotalCount! > 30_000
        || expected !== null && expected !== data.TotalCount) throw new Error('Network settlement account/cycle/count is unverified');
      expected = data.TotalCount!;
      if (data.Items != null && (typeof data.Items !== 'object' || Array.isArray(data.Items))) throw new Error('Invalid network settlement item container');
      const items = normalizeItems(data.Items?.Item ?? (expected === 0 ? [] : undefined), action);
      if (items.length > 300) throw new Error('Invalid network settlement page');
      const evidence = this.queryContext.getStore()?.evidence;
      if (evidence) evidence.rowCount += items.length;
      for (const row of items) {
        if (String(row.OwnerID) !== context.accountUid || row.ProductCode !== productCode
          || action !== 'QueryAccountBill' && !['PayFinish', 'PayUnclear', 'PayUnsettle', 'NoSettle'].includes(String(row.Status)))
          throw new Error('Network settlement resource owner/product/status is unverified');
        const fingerprint = createHash('sha256').update(JSON.stringify(row)).digest('hex');
        if (fingerprints.has(fingerprint)) throw new Error('Repeated network settlement row');
        fingerprints.add(fingerprint);
      }
      rows.push(...items);
      if (action === 'QuerySettleBill') {
        nextToken = data.NextToken || '';
        if (!nextToken) { if (rows.length !== expected) throw new Error('Incomplete network settlement pagination'); return rows; }
        if (!items.length || rows.length >= expected! || tokens.has(nextToken)) throw new Error('Repeated network settlement pagination');
        tokens.add(nextToken); continue;
      }
      if (rows.length === expected) return rows;
      if (!items.length || rows.length > expected!) throw new Error('Incomplete network settlement pagination');
    }
    throw new Error('Incomplete network settlement pagination');
  }

  // Diagnostic inventory only: monthly totals are never substituted for daily financial records.
  async listMonthlyDiagnosticItems(billingCycle: string, action: 'DescribeInstanceBill' | 'DescribeSplitItemBill', context: SystemCloudAccountContext, productCode?: SplitBillingProduct, isBillingItem = true) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(billingCycle)
      || !['DescribeInstanceBill', 'DescribeSplitItemBill'].includes(action)
      || typeof isBillingItem !== 'boolean' || !isBillingItem && (action !== 'DescribeInstanceBill' || !productCode || !['eip', 'cdt', 'cbwp'].includes(productCode))
      || productCode !== undefined && !['eip', 'cdt', 'cbwp', 'snapshot', 'oss'].includes(productCode)) throw new Error('Invalid monthly diagnostic query');
    assertAlibabaBillingContext(context);
    if (!context.accountUid || !context.accountUidResolved) throw new Error('Monthly diagnostic account is unverified');
    const items: RawBssItem[] = [], tokens = new Set<string>(), fingerprints = new Set<string>();
    let nextToken: string | null = null, expected: number | null = null;
    do {
      const payload: DescribeInstanceBillResponse = await this.performRpcRequest<DescribeInstanceBillResponse>({ action, accessKeyId: context.accessKeyId, accessKeySecret: context.accessKeySecret,
        parameters: { BillingCycle: billingCycle, Granularity: 'MONTHLY', BillOwnerId: context.accountUid, MaxResults: '300', IsHideZeroCharge: 'false',
          ...(action === 'DescribeInstanceBill' ? { IsBillingItem: String(isBillingItem) } : {}), ...(productCode ? { ProductCode: productCode } : {}), ...(nextToken ? { NextToken: nextToken } : {}) } });
      const data = payload.Data;
      if (!data || data.AccountID !== context.accountUid || data.BillingCycle !== billingCycle
        || !Number.isSafeInteger(data.TotalCount) || data.TotalCount! < 0 || data.TotalCount! > 30_000
        || expected !== null && expected !== data.TotalCount) throw new Error('Monthly diagnostic account/cycle/count is unverified');
      expected = data.TotalCount!;
      const page = normalizeItems(data.Items ?? (expected === 0 ? [] : undefined), action);
      for (const row of page) {
        if (['OwnerID', 'SplitAccountID'].some(key => row[key] != null && row[key] !== '' && String(row[key]) !== context.accountUid)
          || ['BillingCycle', 'SplitBillingCycle'].some(key => row[key] != null && row[key] !== '' && row[key] !== billingCycle)
          || productCode !== undefined && row.ProductCode !== productCode)
          throw new Error('Monthly diagnostic row identity is unverified');
        const fingerprint = createHash('sha256').update(JSON.stringify(row)).digest('hex');
        if (fingerprints.has(fingerprint)) throw new Error('Monthly diagnostic returned repeated rows');
        fingerprints.add(fingerprint);
      }
      items.push(...page);
      if (data.NextToken != null && typeof data.NextToken !== 'string') throw new Error('Invalid monthly diagnostic pagination');
      nextToken = data.NextToken || null;
      if (items.length > expected! || nextToken && (!page.length || items.length >= expected! || tokens.has(nextToken)))
        throw new Error('Incomplete monthly diagnostic pagination');
      if (nextToken) tokens.add(nextToken);
    } while (nextToken);
    if (items.length !== expected) throw new Error('Incomplete monthly diagnostic inventory');
    return items;
  }

  private identity(value: string | undefined) {
    if (value !== undefined && (!value.trim() || value.length > 1024 || /[\x00-\x1f\x7f]/.test(value))) throw new Error('Invalid billing resource filter');
    return value;
  }

  private dataset(action: string, context: SystemCloudAccountContext, input: { billingDate: string; instanceId?: string; splitItemId?: string; productCode?: string; tagFilter?: { key: 'RangeInstanceId'; value: string } }) {
    const evidence = this.queryContext.getStore()?.evidence;
    if (!evidence) return undefined;
    const dataset = { action, accountUid: context.accountUid!, ...input, complete: false, rows: [] as RawBssItem[] };
    (evidence.datasets ??= []).push(dataset);
    return dataset;
  }

  private recordRows(dataset: NonNullable<BillingQueryEvidence['datasets']>[number] | undefined, rows: RawBssItem[], context: SystemCloudAccountContext) {
    if (!dataset) return;
    const keys = ['InstanceID','SplitItemID','ProductCode','ProductType','CommodityCode','BillingItemCode','BillingItem','Item','Currency',
      'PretaxAmount','PretaxGrossAmount','InvoiceDiscount','DeductedByCashCoupons','CashAmount','PaymentAmount','OutstandingAmount',
      'BillingDate','BillingCycle','SplitBillingDate','SplitBillingCycle','OwnerID','BillAccountID','SplitAccountID',
      'RegionId','Region','BillID','RecordID','SourceBillId','UsageStartTime','UsageEndTime','BeginTime','EndTime'];
    for (const row of rows) {
      if (['OwnerID','SplitAccountID'].some(key => row[key] != null && row[key] !== '' && String(row[key]) !== context.accountUid)) continue;
      dataset.rows.push(Object.fromEntries(keys.filter(key => Object.hasOwn(row, key)).map(key => {
        const value = row[key];
        return [key, typeof value === 'string' ? ([context.accessKeyId,context.accessKeySecret].some(secret => secret && value.includes(secret)) ? '[redacted]' : value.slice(0,4096))
          : value === null || typeof value === 'number' || typeof value === 'boolean' ? value : '[invalid]'];
      })));
    }
  }

  private async pace() {
    if (!this.prisma || process.env.NODE_ENV === 'test' && process.env.BILLING_TEST_PACING !== '1') return;
    const id = requireCurrentCloudWorkspaceId();
    const rows = await this.prisma.$queryRaw<Array<{ at: Date }>>`
      UPDATE "CloudWorkspace" SET "billingNextRequestAt" =
        GREATEST(COALESCE("billingNextRequestAt", CURRENT_TIMESTAMP), CURRENT_TIMESTAMP) + INTERVAL '1 second'
      WHERE id = ${id} RETURNING "billingNextRequestAt" - INTERVAL '1 second' AS at`;
    if (!rows.length) throw new Error('Billing request workspace disappeared');
    const delay = rows[0].at.getTime() - Date.now();
    if (delay > 60_000) throw new Error('Billing request budget busy; retry from the queue');
    if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
  }

  async listDailySplitBillingItems(input: { billingDate: string; productCode?: SplitBillingProduct; instanceId?: string; splitItemId?: string; tagFilter?: { key: 'RangeInstanceId'; value: string } }, capturedContext?: SystemCloudAccountContext) {
    const { billingDate, productCode } = input;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(billingDate) || !Number.isFinite(Date.parse(billingDate))
      || new Date(billingDate).toISOString().slice(0, 10) !== billingDate
      || productCode !== undefined && !['snapshot', 'oss', 'eip', 'cdt', 'cbwp'].includes(productCode)
      || input.tagFilter && (input.tagFilter.key !== 'RangeInstanceId' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.tagFilter.value))
      || productCode === undefined && !/^eip-[a-z0-9-]+$/i.test(input.splitItemId ?? '') && !input.tagFilter) throw new Error('Invalid split bill query');
    const context = { ...(capturedContext ?? await this.systemConfigService.getAccountContext()) };
    assertAlibabaBillingContext(context);
    if (!context.accountUid || !context.accountUidResolved) throw new Error('账单同步需要已验证的云账号。');
    const action = 'DescribeSplitItemBill';
    const dataset = this.dataset(action, context, input);
    const billingCycle = billingDate.slice(0, 7);
    const items: RawBssItem[] = [];
    const seenTokens = new Set<string>();
    let nextToken: string | null = null;
    let expectedCount: number | null = null;
    do {
      const payload: DescribeInstanceBillResponse = await this.performRpcRequest<DescribeInstanceBillResponse>({
        accessKeyId: context.accessKeyId, accessKeySecret: context.accessKeySecret, action,
        parameters: { BillingCycle: billingCycle, BillingDate: billingDate, Granularity: 'DAILY',
          ...(productCode ? { ProductCode: productCode } : {}), BillOwnerId: context.accountUid, MaxResults: '300', IsHideZeroCharge: 'false',
          ...(this.identity(input.instanceId) ? { InstanceID: input.instanceId! } : {}),
          ...(this.identity(input.splitItemId) ? { SplitItemID: input.splitItemId! } : {}),
          ...(input.tagFilter ? { 'TagFilter.1.TagKey': input.tagFilter.key, 'TagFilter.1.TagValues.1': input.tagFilter.value } : {}),
          ...(nextToken ? { NextToken: nextToken } : {}) },
      });
      const data = payload.Data;
      if (!data || data.AccountID !== context.accountUid || data.BillingCycle !== billingCycle) {
        throw new Error(`${action} returned a different or unverified billing account/cycle; previous bills were retained`);
      }
      if (!Number.isSafeInteger(data.TotalCount) || data.TotalCount! < 0
        || expectedCount !== null && data.TotalCount !== expectedCount) {
        throw new Error(`${action} returned an inconsistent row count; previous bills were retained`);
      }
      expectedCount = data.TotalCount!;
      const page = normalizeItems(data.Items ?? (expectedCount === 0 ? [] : undefined), action);
      for (const row of page) {
        // BillingDate is not supported in split responses; the documented split date is authoritative.
        if (row.SplitBillingDate !== billingDate || row.SplitBillingCycle != null && row.SplitBillingCycle !== billingCycle
          || typeof row.ProductCode !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(row.ProductCode)
          || productCode !== undefined && row.ProductCode !== productCode) throw new Error(`${action} returned a different billing date/product; previous bills were retained`);
        if (input.instanceId && row.InstanceID !== input.instanceId || input.splitItemId && row.SplitItemID !== input.splitItemId)
          throw new Error('Split bill returned a different resource than the requested filter');
        if (input.tagFilter) {
          const tags = typeof row.Tag === 'string' ? row.Tag.split(';').map(part => /^key:([^\s]+)\s+value:([^\s]+)$/.exec(part.trim())).filter(tag => tag?.[1] === input.tagFilter!.key) : [];
          if (tags.length !== 1 || tags[0]?.[2] !== input.tagFilter.value) throw new Error('BILLING_TAG_FILTER_UNVERIFIED');
        }
        for (const key of ['OwnerID', 'SplitAccountID']) {
          if (row[key] != null && row[key] !== '' && row[key] !== context.accountUid) {
            throw new Error(`${action} returned a different resource account; previous bills were retained`);
          }
        }
      }
      items.push(...page);
      this.recordRows(dataset, page, context);
      if (data.NextToken != null && typeof data.NextToken !== 'string') throw new Error(`${action} returned an invalid pagination token`);
      nextToken = data.NextToken || null;
      if (nextToken) {
        if (!page.length || seenTokens.has(nextToken) || items.length >= expectedCount) throw new Error(`${action} returned an incomplete or repeated pagination token`);
        seenTokens.add(nextToken);
      }
    } while (nextToken);
    if (items.length !== expectedCount) throw new Error(`${action} returned an incomplete bill; previous bills were retained`);
    if (dataset) dataset.complete = dataset.rows.length === items.length;
    return items;
  }

  async listDailyBillingItems(input: { billingDate: string; instanceId?: string; productCode?: string }, capturedContext?: SystemCloudAccountContext) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.billingDate) || !Number.isFinite(Date.parse(input.billingDate))
      || new Date(input.billingDate).toISOString().slice(0, 10) !== input.billingDate) throw new Error('Invalid daily bill query');
    const snapshot = { ...(capturedContext ?? await this.systemConfigService.getAccountContext()) };
    assertAlibabaBillingContext(snapshot);
    if (!snapshot.accountUid || !snapshot.accountUidResolved) throw new Error('账单同步需要已验证的云账号。');
    const billingCycle = input.billingDate.slice(0, 7);
    const dataset = this.dataset('DescribeInstanceBill', snapshot, input);
    let nextToken: string | null = null;
    const items: RawBssItem[] = [];
    const seenTokens = new Set<string>();
    let expectedCount: number | null = null;

    do {
      const payload: DescribeInstanceBillResponse = await this.performRpcRequest<DescribeInstanceBillResponse>({
        accessKeyId: snapshot.accessKeyId,
        accessKeySecret: snapshot.accessKeySecret,
        action: 'DescribeInstanceBill',
        parameters: {
          BillingCycle: billingCycle,
          BillingDate: input.billingDate,
          Granularity: 'DAILY',
          IsBillingItem: 'true',
          IsHideZeroCharge: 'false',
          MaxResults: '300',
          BillOwnerId: snapshot.accountUid,
          ...(this.identity(input.instanceId) ? { InstanceID: input.instanceId! } : {}),
          ...(this.identity(input.productCode) ? { ProductCode: input.productCode! } : {}),
          ...(nextToken ? { NextToken: nextToken } : {}),
        },
      });

      if (!payload.Data) throw new Error('DescribeInstanceBill returned no billing data');
      if (payload.Data.AccountID !== snapshot.accountUid || payload.Data.BillingCycle !== billingCycle) {
        throw new Error('DescribeInstanceBill returned a different or unverified billing account/cycle; previous bills were retained');
      }
      if (!Number.isSafeInteger(payload.Data.TotalCount) || payload.Data.TotalCount! < 0
        || expectedCount !== null && payload.Data.TotalCount !== expectedCount) {
        throw new Error('DescribeInstanceBill returned an inconsistent row count; previous bills were retained');
      }
      expectedCount = payload.Data.TotalCount!;
      if (payload.Data.NextToken != null && typeof payload.Data.NextToken !== 'string') {
        throw new Error('DescribeInstanceBill returned an invalid pagination token');
      }
      const page = normalizeItems(payload.Data.Items ?? (expectedCount === 0 ? [] : undefined));
      if (input.instanceId && page.some(row => row.InstanceID !== input.instanceId)
        || input.productCode && page.some(row => row.ProductCode !== input.productCode)) throw new Error('Bill returned a different resource or product than the requested filter');
      items.push(...page);
      this.recordRows(dataset, page, snapshot);
      nextToken =
        payload.Data?.NextToken && typeof payload.Data.NextToken === 'string'
          ? payload.Data.NextToken
          : null;
      if (nextToken) {
        if (!page.length || seenTokens.has(nextToken) || items.length >= expectedCount) {
          throw new Error('DescribeInstanceBill returned an incomplete or repeated pagination token');
        }
        seenTokens.add(nextToken);
      }
    } while (nextToken);

    if (items.length !== expectedCount) {
      throw new Error('DescribeInstanceBill returned an incomplete bill; previous bills were retained');
    }
    if (dataset) dataset.complete = dataset.rows.length === items.length;

    return items;
  }

  private async performRpcRequest<ResponsePayload>(input: {
    accessKeyId: string;
    accessKeySecret: string;
    action: string;
    parameters?: Record<string, string>;
  }): Promise<ResponsePayload> {
    const query = this.queryContext.getStore();
    await query?.beforeRequest?.();
    await this.pace();
    if (query) query.evidence.pageCount++;
    const endpoint = 'https://business.aliyuncs.com/';
    const signedQuery = signAliyunRpcQuery(
      {
        Action: input.action,
        AccessKeyId: input.accessKeyId,
        Format: 'JSON',
        RegionId: 'cn-hangzhou',
        SignatureMethod: 'HMAC-SHA1',
        SignatureNonce: randomUUID(),
        SignatureVersion: '1.0',
        Timestamp: formatAliyunTimestamp(new Date()),
        Version: '2017-12-14',
        ...(input.parameters ?? {}),
      },
      input.accessKeySecret,
    );

    const response = await fetch(`${endpoint}?${signedQuery}`, {
      method: 'GET',
      signal: AbortSignal.timeout(30_000),
      headers: {
        Accept: 'application/json',
      },
    });

    let payload: unknown = null;

    try {
      // Preserve monetary literals before JavaScript can round an unsupported decimal.
      const body = typeof response.text === 'function' ? await response.text() : JSON.stringify(await response.json());
      payload = JSON.parse(body, (key: string, value: unknown, context?: { source?: string }) => {
        if (typeof value === 'number' && /Amount$|^InvoiceDiscount$|^DeductedByCashCoupons$/.test(key) && context?.source
          && !new BillingDecimal(value).equals(new BillingDecimal(context.source))) return context.source;
        return value;
      });
    } catch {
      throw new Error(`${input.action} returned invalid JSON; previous bills were retained`);
    }
    if (query && payload && typeof payload === 'object') {
      const id = (payload as { RequestId?: unknown }).RequestId;
      if (typeof id === 'string' && /^[A-Za-z0-9-]{1,128}$/.test(id)
        && ![input.accessKeyId,input.accessKeySecret].some(secret => secret && id.includes(secret))) query.evidence.requestIds.push(id);
      const rows = (payload as DescribeInstanceBillResponse).Data?.Items;
      if (Array.isArray(rows)) query.evidence.rowCount += rows.length;
    }

    if (!response.ok || !payload || typeof payload !== 'object'
      || (payload as DescribeInstanceBillResponse).Success !== true
      || (payload as DescribeInstanceBillResponse).Code !== 'Success') {
      const rawErrorCode =
        payload &&
        typeof payload === 'object' &&
        'Code' in payload &&
        typeof (payload as { Code?: unknown }).Code === 'string'
          ? (payload as { Code: string }).Code
          : `HTTP_${response.status}`;
      const errorCode=sanitizeAliyunErrorCode(rawErrorCode,[input.accessKeyId,input.accessKeySecret])??'RESPONSE_UNVERIFIED';
      const nativeId=payload&&typeof payload==='object'?(payload as {RequestId?:unknown}).RequestId:undefined;
      const requestId=typeof nativeId==='string'&&/^[A-Za-z0-9-]{1,128}$/.test(nativeId)
        &&![input.accessKeyId,input.accessKeySecret].some(secret=>secret&&nativeId.includes(secret))?nativeId:undefined;
      if (input.action === 'DescribeSplitItemBill') throw new BillingSplitBillUnavailableError(errorCode,requestId);
      throw new BillingRpcError(input.action,errorCode,requestId);
    }

    return payload as ResponsePayload;
  }
}
