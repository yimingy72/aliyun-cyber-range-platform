import type { BillingLedgerResourceType } from './admin.repository';

type RawBillLine = Partial<{
  ProductCode: string;
  BillingItem: string;
  InstanceID: string;
}>;

type DirectClassification = {
  kind: 'direct';
  cloudResourceId: string;
  cloudResourceType: BillingLedgerResourceType;
};

type AggregatedClassification = {
  kind: 'aggregated';
  cloudResourceId: string;
  cloudResourceType: BillingLedgerResourceType;
};

type PlatformClassification = {
  kind: 'platform';
  cloudResourceId: string;
  cloudResourceType: BillingLedgerResourceType;
};

type UnknownClassification = {
  kind: 'unknown';
  cloudResourceId: string;
  cloudResourceType: BillingLedgerResourceType;
  reason: string;
};

export type BillLineClassification =
  | DirectClassification
  | AggregatedClassification
  | PlatformClassification
  | UnknownClassification;

function normalizeText(value: string | undefined) {
  return value?.trim() ?? '';
}

export function classifyBillLine(line: RawBillLine): BillLineClassification {
  const productCode = normalizeText(line.ProductCode).toLowerCase();
  const billingItem = normalizeText(line.BillingItem);
  const instanceId = normalizeText(line.InstanceID);

  if (productCode === 'ecs') {
    return {
      kind: 'direct',
      cloudResourceId: instanceId,
      cloudResourceType: billingItem === '系统盘' ? 'disk' : 'ecs',
    };
  }

  if (productCode === 'eip') {
    return {
      kind: 'direct',
      cloudResourceId: instanceId,
      cloudResourceType: 'eip',
    };
  }

  if (productCode === 'nat_gw') {
    return {
      kind: 'direct',
      cloudResourceId: instanceId,
      cloudResourceType: 'nat_gateway',
    };
  }

  if (productCode === 'snapshot' && billingItem === '快照链容量') {
    return {
      kind: 'platform',
      cloudResourceId: instanceId,
      cloudResourceType: 'snapshot_region',
    };
  }

  if (productCode === 'oss') {
    return {
      kind: 'platform',
      cloudResourceId: instanceId,
      cloudResourceType: 'unknown',
    };
  }

  return {
    kind: 'unknown',
    cloudResourceId: instanceId,
    cloudResourceType: 'unknown',
    reason: `暂不支持的账单项：${productCode || 'unknown'} / ${billingItem || 'unknown'}`,
  };
}
