import type { BillingScope } from './admin.repository';

type BuildBillingTagsInput = {
  billingScope: BillingScope;
  ownerUserId?: string | null;
  rangeInstanceId?: string | null;
  singleInstanceBatchId?: string | null;
  platformImageAssetId?: string | null;
  billingStartAt: string | Date;
};

function normalizeOptional(value: string | null | undefined) {
  const trimmed = value?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeBillingStartAt(value: string | Date) {
  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new Error('Invalid billingStartAt value');
  }

  return date.toISOString().slice(0, 10);
}

export function buildBillingTags(input: BuildBillingTagsInput) {
  const tags: Record<string, string> = {
    CreatedBy: 'cyber-range-platform',
    PlatformScope: input.billingScope,
    BillingStartAt: normalizeBillingStartAt(input.billingStartAt),
  };

  const ownerUserId = normalizeOptional(input.ownerUserId);
  const rangeInstanceId = normalizeOptional(input.rangeInstanceId);
  const singleInstanceBatchId = normalizeOptional(input.singleInstanceBatchId);
  const platformImageAssetId = normalizeOptional(input.platformImageAssetId);

  if (ownerUserId) {
    tags.PlatformUserId = ownerUserId;
  }

  if (rangeInstanceId) {
    tags.RangeInstanceId = rangeInstanceId;
  }

  if (singleInstanceBatchId) {
    tags.SingleInstanceBatchId = singleInstanceBatchId;
  }

  if (platformImageAssetId) {
    tags.PlatformImageAssetId = platformImageAssetId;
  }

  return tags;
}

export function buildAliyunTagParameters(tags: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(tags).flatMap(([key, value], index) => [
      [`Tag.${index + 1}.Key`, key],
      [`Tag.${index + 1}.Value`, value],
    ]),
  );
}

export type ParsedBillingTags = {
  billingScope: BillingScope;
  ownerUserId: string | null;
  rangeInstanceId: string | null;
  singleInstanceBatchId: string | null;
  platformImageAssetId: string | null;
  billingStartAt: string | null;
  tags: Record<string, string>;
};

function readTagValue(tags: Record<string, string>, key: string) {
  const value = tags[key]?.trim() ?? '';
  return value.length > 0 ? value : null;
}

export function parseAliyunBillingTags(value: unknown): Record<string, string> {
  if (typeof value !== 'string') {
    return {};
  }

  const tags: Record<string, string> = {};

  for (const match of value.matchAll(/(?:^|;)\s*key:([^;]+?)\s+value:([^;]*)/gi)) {
    const key = match[1]?.trim() ?? '';
    const tagValue = match[2]?.trim() ?? '';

    if (key && tagValue) {
      tags[key] = tagValue;
    }
  }

  return tags;
}

export function parsePlatformBillingTags(value: unknown): ParsedBillingTags | null {
  const tags = parseAliyunBillingTags(value);

  if (tags.CreatedBy !== 'cyber-range-platform') {
    return null;
  }

  const billingScope = readTagValue(tags, 'PlatformScope');

  if (billingScope !== 'user' && billingScope !== 'platform') {
    return null;
  }

  const billingStartAt = readTagValue(tags, 'BillingStartAt');
  const validBillingStartAt = billingStartAt && /^\d{4}-\d{2}-\d{2}$/.test(billingStartAt) ? billingStartAt : null;

  return {
    billingScope,
    ownerUserId: billingScope === 'user' ? readTagValue(tags, 'PlatformUserId') : null,
    rangeInstanceId: readTagValue(tags, 'RangeInstanceId'),
    singleInstanceBatchId: readTagValue(tags, 'SingleInstanceBatchId'),
    platformImageAssetId: readTagValue(tags, 'PlatformImageAssetId'),
    billingStartAt: validBillingStartAt,
    tags,
  };
}
