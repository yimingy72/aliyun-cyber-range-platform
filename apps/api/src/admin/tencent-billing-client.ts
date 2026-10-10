import { Prisma } from '@aliyun-cyber-range/database/generated/client';
import { Injectable } from '@nestjs/common';

import { requestTencentCloud } from './tencent-cloud-client';

export type TencentBillingContext = {
  provider: string;
  accountUid: string | null;
  accountUidResolved: boolean;
  accessKeyId: string;
  accessKeySecret: string;
};

export type TencentBillingItem = {
  cloudProvider: 'tencent_cloud';
  cloudAccountUid: string;
  billingMonth: string;
  billingDate: string;
  billingRegionId: string;
  cloudResourceId: string;
  sourceId: string;
  discountedAmount: string;
  currency: 'CNY';
  rawPayload: Record<string, unknown>;
};

type BillDetailResponse = {
  DetailSet?: unknown;
  Total?: number | null;
  Context?: string | null;
};

const BillingDecimal = Prisma.Decimal.clone({ precision: 80 });

function currencyShape(value: unknown) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value !== 'string') return typeof value;
  if (!value) return 'empty_string';
  if (!value.trim()) return 'blank_string';
  if (/^[A-Z]{3}$/.test(value)) return 'iso_like_non_cny';
  if (value.toUpperCase() === 'CNY') return 'cny_noncanonical';
  if (/^[A-Za-z]{3}$/.test(value)) return 'iso_like_noncanonical';
  return 'non_iso_string';
}

function assertDomesticCurrency(row: Record<string, unknown>, location: 'component' | 'row') {
  // The domestic model omits Currency; empty/nullish metadata retains its documented yuan basis.
  // https://github.com/TencentCloud/tencentcloud-sdk-nodejs/blob/master/src/services/billing/v20180709/billing_models.ts
  if ('Currency' in row && row.Currency != null && row.Currency !== 'CNY' && row.Currency !== '') {
    // Only fixed type/format categories enter logs; never interpolate the currency value, amount or response.
    throw new Error(`DescribeBillDetail returned an unsupported ${location} currency (shape=${currencyShape(row.Currency)}; expected=CNY; source=domestic); previous bills were retained`);
  }
}

function requiredText(row: Record<string, unknown>, key: string) {
  const value = row[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`DescribeBillDetail returned invalid ${key}`);
  return value;
}

function billingDate(row: Record<string, unknown>, key: string, month: string) {
  const value = requiredText(row, key);
  const day = value.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2} 00:00:00$/.test(value) || !Number.isFinite(Date.parse(day))
    || new Date(day).toISOString().slice(0, 10) !== day || day.slice(0, 7) !== month) {
    throw new Error(`DescribeBillDetail returned a different or invalid ${key}`);
  }
  return day;
}

function normalizeItem(value: unknown, month: string, accountUid: string): TencentBillingItem {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('DescribeBillDetail returned an invalid bill row');
  const row = value as Record<string, unknown>;
  if (row.OwnerUin !== accountUid || row.PayerUin !== accountUid) throw new Error('DescribeBillDetail returned a different resource or payer account');
  const monthDay = billingDate(row, 'BillMonth', month);
  if (!monthDay.endsWith('-01')) throw new Error('DescribeBillDetail returned an invalid billing month');
  const day = billingDate(row, 'BillDay', month);
  const regionId = requiredText(row, 'RegionId');
  if (!/^\d+$/.test(regionId)) throw new Error('DescribeBillDetail returned an invalid billing region');
  if (!Array.isArray(row.ComponentSet) || !row.ComponentSet.length) throw new Error('DescribeBillDetail returned no bill components');
  let amount = new BillingDecimal(0);
  for (const value of row.ComponentSet) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('DescribeBillDetail returned an invalid bill component');
    const component = value as Record<string, unknown>;
    assertDomesticCurrency(component, 'component');
    const cost = requiredText(component, 'RealCost');
    if (!/^-?\d+(?:\.\d+)?$/.test(cost) || cost.replace(/[.-]/g, '').length > 40) throw new Error('DescribeBillDetail returned an invalid component RealCost');
    amount = amount.plus(cost);
  }
  assertDomesticCurrency(row, 'row');
  return {
    cloudProvider: 'tencent_cloud', cloudAccountUid: accountUid, billingMonth: month, billingDate: day,
    billingRegionId: regionId, cloudResourceId: requiredText(row, 'ResourceId'), sourceId: requiredText(row, 'Id'),
    discountedAmount: amount.toFixed(), currency: 'CNY',
    rawPayload: { ...row, __platformCloudProvider: 'tencent_cloud', __platformBillingSource: 'DescribeBillDetail' },
  };
}

@Injectable()
export class TencentBillingClient {
  // Domestic official expense bills use RealCost in yuan, including signed refunds; payment fields are not added.
  // https://cloud.tencent.com/document/product/555/44144
  async listMonthlyBillingItems(input: { month: string }, context: TencentBillingContext): Promise<TencentBillingItem[]> {
    context = { ...context };
    if (context.provider !== 'tencent_cloud') throw new Error('Tencent billing requires a Tencent cloud account');
    if (!context.accountUidResolved || !context.accountUid || !/^\d+$/.test(context.accountUid)) {
      throw new Error('Tencent billing requires a verified account UIN');
    }
    if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(input.month)) throw new Error('Invalid Tencent billing month');
    const limit = 300;
    const items: TencentBillingItem[] = [];
    const seenIds = new Set<string>();
    let offset = 0;
    let cachedTotal: number | null = null;
    let queryContext: string | null = null;
    while (true) {
      const response: BillDetailResponse = await requestTencentCloud<BillDetailResponse>({
        service: 'billing', version: '2018-07-09', action: 'DescribeBillDetail',
        accessKeyId: context.accessKeyId, accessKeySecret: context.accessKeySecret,
        parameters: { Month: input.month, PayerUin: context.accountUid, Offset: offset, Limit: limit, NeedRecordNum: 1,
          ...(queryContext ? { Context: queryContext } : {}) },
      });
      if (!Number.isSafeInteger(response.Total) || response.Total! < 0
        || cachedTotal !== null && response.Total !== cachedTotal) throw new Error('DescribeBillDetail returned an invalid or changing row count');
      cachedTotal = response.Total!;
      if (!Array.isArray(response.DetailSet) || response.DetailSet.length > limit) throw new Error('DescribeBillDetail returned an invalid item list');
      if (response.Context != null && typeof response.Context !== 'string') throw new Error('DescribeBillDetail returned an invalid query context');
      const page = response.DetailSet.map(row => normalizeItem(row, input.month, context.accountUid!));
      for (const item of page) {
        if (seenIds.has(item.sourceId)) throw new Error('DescribeBillDetail repeated a bill record; partial results were discarded');
        seenIds.add(item.sourceId);
      }
      items.push(...page);
      // Total is cached for 24 hours and can undercount; a short page, not Total, ends the query.
      if (page.length < limit) break;
      offset += limit;
      if (!Number.isSafeInteger(offset)) throw new Error('DescribeBillDetail pagination overflow');
      queryContext = response.Context || null;
    }
    if (items.length < cachedTotal!) throw new Error('DescribeBillDetail returned an incomplete bill; partial results were discarded');
    return items;
  }
}
