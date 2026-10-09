import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { signAliyunRpcQuery } from './image-catalog-rpc-signer';
import { SystemConfigService, type SystemCloudAccountContext } from './system-config.service';

type RawBssItem = Record<string, unknown>;

type DescribeInstanceBillResponse = {
  Success?: boolean;
  Code?: string;
  Data?: {
    Items?: RawBssItem[];
    NextToken?: string;
    TotalCount?: number;
  };
};

function formatAliyunTimestamp(value: Date) {
  return value.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function normalizeItems(value: unknown) {
  if (!Array.isArray(value)) {
    throw new Error('DescribeInstanceBill returned an invalid item list');
  }
  if (value.some(item => !item || typeof item !== 'object' || Array.isArray(item))) {
    throw new Error('DescribeInstanceBill returned an invalid bill row');
  }
  return value as RawBssItem[];
}

@Injectable()
export class BillingBssClient {
  constructor(private readonly systemConfigService: SystemConfigService) {}

  async listDailyBillingItems(input: { billingDate: string }, capturedContext?: SystemCloudAccountContext) {
    const snapshot = capturedContext ?? await this.systemConfigService.getAccountContext();
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
      throw new Error('DescribeInstanceBill returned invalid JSON; previous bills were retained');
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
      throw new Error(`${input.action} failed: ${errorCode}; previous bills were retained`);
    }

    return payload as ResponsePayload;
  }
}
