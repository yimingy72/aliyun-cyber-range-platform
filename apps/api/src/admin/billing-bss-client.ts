import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { signAliyunRpcQuery } from './image-catalog-rpc-signer';
import { SystemConfigService } from './system-config.service';

type RawBssItem = Record<string, unknown>;

type DescribeInstanceBillResponse = {
  Data?: {
    Items?: RawBssItem[];
    NextToken?: string;
  };
};

function formatAliyunTimestamp(value: Date) {
  return value.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function normalizeItems(value: unknown) {
  if (!Array.isArray(value)) {
    return [] as RawBssItem[];
  }

  return value.filter((item): item is RawBssItem => typeof item === 'object' && item !== null);
}

@Injectable()
export class BillingBssClient {
  constructor(private readonly systemConfigService: SystemConfigService) {}

  async listDailyBillingItems(input: { billingDate: string }) {
    const snapshot = await this.systemConfigService.getSnapshot();
    const billingCycle = input.billingDate.slice(0, 7);
    let nextToken: string | null = null;
    const items: RawBssItem[] = [];

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
          ...(nextToken ? { NextToken: nextToken } : {}),
        },
      });

      items.push(...normalizeItems(payload.Data?.Items));
      nextToken =
        payload.Data?.NextToken && typeof payload.Data.NextToken === 'string'
          ? payload.Data.NextToken
          : null;
    } while (nextToken);

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
      headers: {
        Accept: 'application/json',
      },
    });

    let payload: unknown = null;

    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (!response.ok) {
      const errorCode =
        payload &&
        typeof payload === 'object' &&
        'Code' in payload &&
        typeof (payload as { Code?: unknown }).Code === 'string'
          ? (payload as { Code: string }).Code
          : `HTTP_${response.status}`;
      const errorMessage =
        payload &&
        typeof payload === 'object' &&
        'Message' in payload &&
        typeof (payload as { Message?: unknown }).Message === 'string'
          ? (payload as { Message: string }).Message
          : `BSS RPC request failed with status ${response.status}`;

      throw new Error(`${input.action} failed: ${errorCode} - ${errorMessage}`);
    }

    return payload as ResponsePayload;
  }
}
