import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { signAliyunRpcQuery } from './image-catalog-rpc-signer';
import { SystemConfigService, type SystemCloudAccountContext } from './system-config.service';

type RawBssItem = Record<string, unknown>;

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
  constructor(readonly code: string) {
    super(`DescribeSplitItemBill unavailable: ${code}; enable split bills and verify permissions; previous bills were retained`);
    this.name = 'BillingSplitBillUnavailableError';
  }
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
  constructor(private readonly systemConfigService: SystemConfigService) {}

  async listDailySplitBillingItems(input: { billingDate: string; productCode: 'snapshot' | 'oss' }, capturedContext?: SystemCloudAccountContext) {
    const { billingDate, productCode } = input;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(billingDate) || !Number.isFinite(Date.parse(billingDate))
      || new Date(billingDate).toISOString().slice(0, 10) !== billingDate
      || !['snapshot', 'oss'].includes(productCode)) throw new Error('Invalid split bill query');
    const context = { ...(capturedContext ?? await this.systemConfigService.getAccountContext()) };
    assertAlibabaBillingContext(context);
    if (!context.accountUid || !context.accountUidResolved) throw new Error('账单同步需要已验证的云账号。');
    const action = 'DescribeSplitItemBill';
    const billingCycle = billingDate.slice(0, 7);
    const items: RawBssItem[] = [];
    const seenTokens = new Set<string>();
    let nextToken: string | null = null;
    let expectedCount: number | null = null;
    do {
      const payload: DescribeInstanceBillResponse = await this.performRpcRequest<DescribeInstanceBillResponse>({
        accessKeyId: context.accessKeyId, accessKeySecret: context.accessKeySecret, action,
        parameters: { BillingCycle: billingCycle, BillingDate: billingDate, Granularity: 'DAILY',
          ProductCode: productCode, BillOwnerId: context.accountUid, MaxResults: '300', IsHideZeroCharge: 'true',
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
          || row.ProductCode !== productCode) throw new Error(`${action} returned a different billing date/product; previous bills were retained`);
        for (const key of ['OwnerID', 'SplitAccountID']) {
          if (row[key] != null && row[key] !== '' && row[key] !== context.accountUid) {
            throw new Error(`${action} returned a different resource account; previous bills were retained`);
          }
        }
      }
      items.push(...page);
      if (data.NextToken != null && typeof data.NextToken !== 'string') throw new Error(`${action} returned an invalid pagination token`);
      nextToken = data.NextToken || null;
      if (nextToken) {
        if (!page.length || seenTokens.has(nextToken) || items.length >= expectedCount) throw new Error(`${action} returned an incomplete or repeated pagination token`);
        seenTokens.add(nextToken);
      }
    } while (nextToken);
    if (items.length !== expectedCount) throw new Error(`${action} returned an incomplete bill; previous bills were retained`);
    return items;
  }

  async listDailyBillingItems(input: { billingDate: string }, capturedContext?: SystemCloudAccountContext) {
    const snapshot = { ...(capturedContext ?? await this.systemConfigService.getAccountContext()) };
    assertAlibabaBillingContext(snapshot);
    if (!snapshot.accountUid || !snapshot.accountUidResolved) throw new Error('账单同步需要已验证的云账号。');
    const billingCycle = input.billingDate.slice(0, 7);
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
          IsHideZeroCharge: 'true',
          MaxResults: '300',
          BillOwnerId: snapshot.accountUid,
          ...(nextToken ? { NextToken: nextToken } : {}),
        },
      });

      if (!payload.Data) throw new Error('DescribeInstanceBill returned no billing data');
      if (payload.Data.TotalCount !== undefined) {
        if (!Number.isSafeInteger(payload.Data.TotalCount) || payload.Data.TotalCount < 0
          || expectedCount !== null && payload.Data.TotalCount !== expectedCount) {
          throw new Error('DescribeInstanceBill returned an inconsistent row count; previous bills were retained');
        }
        expectedCount = payload.Data.TotalCount;
      }
      if (payload.Data.NextToken != null && typeof payload.Data.NextToken !== 'string') {
        throw new Error('DescribeInstanceBill returned an invalid pagination token');
      }
      items.push(...normalizeItems(payload.Data.Items ?? (payload.Data.TotalCount === 0 ? [] : undefined)));
      nextToken =
        payload.Data?.NextToken && typeof payload.Data.NextToken === 'string'
          ? payload.Data.NextToken
          : null;
      if (nextToken) {
        if (seenTokens.has(nextToken)) throw new Error('DescribeInstanceBill repeated a pagination token');
        seenTokens.add(nextToken);
      }
    } while (nextToken);

    if (expectedCount !== null && items.length !== expectedCount) {
      throw new Error('DescribeInstanceBill returned an incomplete bill; previous bills were retained');
    }

    return items;
  }

  private async performRpcRequest<ResponsePayload>(input: {
    accessKeyId: string;
    accessKeySecret: string;
    action: string;
    parameters?: Record<string, string>;
  }): Promise<ResponsePayload> {
    const endpoint = 'https://business.aliyuncs.com/';
    const query = signAliyunRpcQuery(
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

    const response = await fetch(`${endpoint}?${query}`, {
      method: 'GET',
      signal: AbortSignal.timeout(30_000),
      headers: {
        Accept: 'application/json',
      },
    });

    let payload: unknown = null;

    try {
      payload = await response.json();
    } catch {
      throw new Error(`${input.action} returned invalid JSON; previous bills were retained`);
    }

    if (!response.ok || !payload || typeof payload !== 'object'
      || (payload as DescribeInstanceBillResponse).Success !== true
      || (payload as DescribeInstanceBillResponse).Code !== 'Success') {
      const errorCode =
        payload &&
        typeof payload === 'object' &&
        'Code' in payload &&
        typeof (payload as { Code?: unknown }).Code === 'string'
          ? (payload as { Code: string }).Code
          : `HTTP_${response.status}`;
      if (input.action === 'DescribeSplitItemBill') throw new BillingSplitBillUnavailableError(errorCode);
      throw new Error(`${input.action} failed: ${errorCode}; previous bills were retained`);
    }

    return payload as ResponsePayload;
  }
}
