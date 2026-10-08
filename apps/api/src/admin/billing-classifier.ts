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

type UnknownClassification = {
  kind: 'unknown';
  cloudResourceId: string;
  cloudResourceType: BillingLedgerResourceType;
  reason: string;
};

export type BillLineClassification =
  | DirectClassification
  | AggregatedClassification
  | UnknownClassification;

function normalizeText(value: string | undefined) {
  return value?.trim() ?? '';
}

function isSnapshotResourceId(value: string) {
  return /^s-[a-z0-9-]+$/i.test(value);
}

export function classifyBillLine(line: RawBillLine): BillLineClassification {
  const productCode = normalizeText(line.ProductCode).toLowerCase();
  const billingItem = normalizeText(line.BillingItem);
  const instanceId = normalizeText(line.InstanceID);

  if (productCode === 'ecs') {
    return {
      kind: 'direct',
      cloudResourceId: instanceId,
      cloudResourceType: /^d-/.test(instanceId) ? 'disk' : 'ecs',
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

  if (productCode === 'image') {
    return {
      kind: 'direct',
      cloudResourceId: instanceId,
      cloudResourceType: 'image',
    };
  }

  if (productCode === 'snapshot') {
    if (isSnapshotResourceId(instanceId)) {
      return {
        kind: 'direct',
        cloudResourceId: instanceId,
        cloudResourceType: 'snapshot',
      };
    }

    return {
      kind: 'aggregated',
      cloudResourceId: instanceId,
      cloudResourceType: 'snapshot_region',
    };
  }

  if (productCode === 'oss') {
    return {
      kind: 'aggregated',
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
