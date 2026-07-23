import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';

import {
  ADMIN_REPOSITORY,
  AdminRepository,
  type BillingLedgerResourceRecord,
} from './admin.repository';
import { BillingBssClient } from './billing-bss-client';
import { classifyBillLine } from './billing-classifier';

type RawBillLine = Record<string, unknown>;

function toIsoDate(value: Date) {
  return value.toISOString().slice(0, 10);
}

function parseDate(value: string | Date) {
  return value instanceof Date ? new Date(value) : new Date(value);
}

function enumerateDates(startAt: Date, endAt: Date) {
  const dates: string[] = [];
  const cursor = new Date(startAt);

  while (cursor <= endAt) {
    dates.push(toIsoDate(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }

  return dates;
}

const RELEASE_BILLING_GRACE_DAYS = 1;

function isLedgerActiveForBillingDate(ledger: BillingLedgerResourceRecord, billingDate: string) {
  const billingDateText = billingDate;
  const startAtText = toIsoDate(ledger.billingStartAt);

  if (billingDateText < startAtText) {
    return false;
  }

  if (ledger.releasedAt) {
    const releaseDeadline = new Date(ledger.releasedAt);
    releaseDeadline.setDate(releaseDeadline.getDate() + RELEASE_BILLING_GRACE_DAYS);

    // ponytail: keep a one-day grace window because Aliyun daily bills for short-lived resources can settle on the next calendar day.
    if (billingDateText > toIsoDate(releaseDeadline)) {
      return false;
    }
  }

  return true;
}

function readString(line: RawBillLine, key: string) {
  const value = line[key];
  return typeof value === 'string' ? value : '';
}

function readNumber(line: RawBillLine, key: string) {
  const value = line[key];
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

@Injectable()
export class BillingSyncService implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;
  private isRunning = false;

  constructor(
    @Inject(ADMIN_REPOSITORY) private readonly adminRepository: AdminRepository,
    private readonly billingBssClient: BillingBssClient,
  ) {}

  onModuleInit() {
    const intervalMs = Number(process.env.BILLING_SYNC_INTERVAL_MS ?? '');

    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      return;
    }

    this.timer = setInterval(() => {
      void this.syncRecentDays(7);
    }, intervalMs);
  }

  onModuleDestroy() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async syncRecentDays(days: number) {
    const endAt = new Date();
    const startAt = new Date(endAt);
    startAt.setDate(startAt.getDate() - (days - 1));

    return this.syncRange({
      startAt: toIsoDate(startAt),
      endAt: toIsoDate(endAt),
    });
  }

  async syncRange(input: { startAt: string | Date; endAt: string | Date }) {
    if (this.isRunning) {
      return {
        syncedDays: 0,
        importedLineItems: 0,
        anomalyCount: 0,
        deferredCount: 0,
      };
    }

    this.isRunning = true;

    try {
      const startAt = parseDate(input.startAt);
      const endAt = parseDate(input.endAt);
      const dates = enumerateDates(startAt, endAt);
      const ledgerResources = await this.adminRepository.listBillingLedgerResources();
      let importedLineItems = 0;
      let anomalyCount = 0;

      for (const billingDate of dates) {
        const syncBatchId = `billing-sync:${billingDate}`;
        const items = await this.billingBssClient.listDailyBillingItems({ billingDate });

        await this.adminRepository.deleteBillingLineItemsBySyncBatchId(syncBatchId);
        await this.adminRepository.deleteBillingAnomaliesBySyncBatchId(syncBatchId);

        for (const line of items) {
          const classification = classifyBillLine(line);

          if (classification.kind === 'platform') {
            await this.adminRepository.upsertBillingLineItems([
              {
                syncBatchId,
                sourceFingerprint: this.buildSourceFingerprint(
                  syncBatchId,
                  classification.cloudResourceType,
                  classification.cloudResourceId,
                  readString(line, 'BillingItem'),
                ),
                billCycle: billingDate.slice(0, 7),
                billingDate,
                productCode: readString(line, 'ProductCode'),
                productDetail: readString(line, 'ProductDetail') || null,
                billItem: readString(line, 'BillingItem'),
                cloudResourceId: classification.cloudResourceId,
                cloudResourceType: classification.cloudResourceType,
                pretaxAmount: readNumber(line, 'PretaxAmount'),
                currency: readString(line, 'Currency') || 'CNY',
                billingScope: 'platform',
                ownerUserId: null,
                matchedLedgerId: null,
                rawPayload: line,
              },
            ]);
            importedLineItems += 1;
            continue;
          }

          if (classification.kind === 'direct') {
            const matchedLedger = this.findActiveLedgerResource(
              ledgerResources,
              classification.cloudResourceId,
              classification.cloudResourceType,
              billingDate,
            );

            if (matchedLedger) {
              await this.adminRepository.upsertBillingLineItems([
                {
                  syncBatchId,
                  sourceFingerprint: this.buildSourceFingerprint(syncBatchId, classification.cloudResourceType, classification.cloudResourceId, readString(line, 'BillingItem')),
                  billCycle: billingDate.slice(0, 7),
                  billingDate,
                  productCode: readString(line, 'ProductCode'),
                  productDetail: readString(line, 'ProductDetail') || null,
                  billItem: readString(line, 'BillingItem'),
                  cloudResourceId: classification.cloudResourceId,
                  cloudResourceType: classification.cloudResourceType,
                  pretaxAmount: readNumber(line, 'PretaxAmount'),
                  currency: readString(line, 'Currency') || 'CNY',
                  billingScope: matchedLedger.billingScope,
                  ownerUserId: matchedLedger.ownerUserId,
                  matchedLedgerId: matchedLedger.id,
                  rawPayload: line,
                },
              ]);
              importedLineItems += 1;
              continue;
            }
          }

          if (!this.isPlatformScopedAnomaly(ledgerResources, classification, billingDate)) {
            continue;
          }

          await this.adminRepository.createBillingAnomaly({
            syncBatchId,
            sourceFingerprint: this.buildSourceFingerprint(syncBatchId, classification.cloudResourceType, classification.cloudResourceId, readString(line, 'BillingItem')),
            billCycle: billingDate.slice(0, 7),
            billingDate,
            cloudResourceId: classification.cloudResourceId,
            cloudResourceType: classification.cloudResourceType,
            pretaxAmount: readNumber(line, 'PretaxAmount'),
            currency: readString(line, 'Currency') || 'CNY',
            reason: this.resolveAnomalyReason(classification),
            rawPayload: line,
          });
          anomalyCount += 1;
        }
      }

      return {
        syncedDays: dates.length,
        importedLineItems,
        anomalyCount,
        deferredCount: 0,
      };
    } finally {
      this.isRunning = false;
    }
  }

  private buildSourceFingerprint(syncBatchId: string, resourceType: string, resourceId: string, billItem: string) {
    return `${syncBatchId}:${resourceType}:${resourceId}:${billItem}`;
  }

  private isPlatformScopedAnomaly(
    ledgerResources: BillingLedgerResourceRecord[],
    classification: ReturnType<typeof classifyBillLine>,
    billingDate: string,
  ) {
    if (!classification.cloudResourceId) {
      return false;
    }

    return ledgerResources.some(
      (item) =>
        item.cloudResourceId === classification.cloudResourceId &&
        isLedgerActiveForBillingDate(item, billingDate),
    );
  }

  private resolveAnomalyReason(
    classification:
      | ReturnType<typeof classifyBillLine>,
  ) {
    if (classification.kind === 'aggregated') {
      return `该账单已识别为平台范围内的聚合费用，但当前缺少归属规则：${classification.cloudResourceType}`;
    }

    if (classification.kind === 'unknown') {
      return classification.reason;
    }

    return `已识别到平台账单，但未匹配到本地台账：${classification.cloudResourceType}:${classification.cloudResourceId}`;
  }

  private findLedgerResource(
    ledgerResources: BillingLedgerResourceRecord[],
    cloudResourceId: string,
    cloudResourceType: BillingLedgerResourceRecord['cloudResourceType'],
  ) {
    return ledgerResources.find(
      (item) => item.cloudResourceId === cloudResourceId && item.cloudResourceType === cloudResourceType,
    );
  }

  private findActiveLedgerResource(
    ledgerResources: BillingLedgerResourceRecord[],
    cloudResourceId: string,
    cloudResourceType: BillingLedgerResourceRecord['cloudResourceType'],
    billingDate: string,
  ) {
    const matchedLedger = this.findLedgerResource(ledgerResources, cloudResourceId, cloudResourceType);

    if (!matchedLedger) {
      return null;
    }

    return isLedgerActiveForBillingDate(matchedLedger, billingDate) ? matchedLedger : null;
  }
}
