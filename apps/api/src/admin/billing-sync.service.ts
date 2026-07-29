import { Inject, Injectable, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';

import {
  ADMIN_REPOSITORY,
  AdminRepository,
  type BillingLedgerResourceRecord,
} from './admin.repository';
import { BillingBssClient } from './billing-bss-client';
import { classifyBillLine } from './billing-classifier';
import { buildBillingTags, parsePlatformBillingTags } from './billing-tagging';
import { SystemConfigService } from './system-config.service';

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
    @Optional() private readonly systemConfigService?: SystemConfigService,
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
      const requestedStartAt = parseDate(input.startAt);
      const endAt = parseDate(input.endAt);
      const latestBillingDate = await this.adminRepository.getLatestBillingLineItemDate();
      const startAt = latestBillingDate ?? requestedStartAt;

      if (startAt > endAt) {
        return {
          syncedDays: 0,
          importedLineItems: 0,
          anomalyCount: 0,
          deferredCount: 0,
        };
      }

      const dates = enumerateDates(startAt, endAt);
      const ledgerResources = await this.adminRepository.listBillingLedgerResources();
      const cloudConfig = this.systemConfigService
        ? await this.systemConfigService.getSnapshot()
        : { defaultRegion: '', imageImportBucket: '' };
      await this.reconcilePlatformImageBillingLedgers(ledgerResources);
      let importedLineItems = 0;
      let anomalyCount = 0;

      for (const billingDate of dates) {
        const syncBatchId = `billing-sync:${billingDate}`;
        const items = await this.billingBssClient.listDailyBillingItems({ billingDate });

        await this.adminRepository.deleteBillingLineItemsBySyncBatchId(syncBatchId);
        await this.adminRepository.deleteBillingAnomaliesBySyncBatchId(syncBatchId);

        for (const line of items) {
          const classification = classifyBillLine(line);

          if (classification.kind === 'direct') {
            const matchedLedger =
              this.findActiveLedgerResource(
                ledgerResources,
                classification.cloudResourceId,
                classification.cloudResourceType,
                billingDate,
              ) ??
              (await this.findTaggedLedgerResource({
                line,
                classification,
                billingDate,
                defaultRegionId: cloudConfig.defaultRegion,
                ledgerResources,
              }));

            if (matchedLedger) {
              await this.upsertMatchedBillLine({
                syncBatchId,
                billingDate,
                line,
                ledger: matchedLedger,
                cloudResourceId: classification.cloudResourceId,
                cloudResourceType: classification.cloudResourceType,
              });
              importedLineItems += 1;
              continue;
            }
          }

          const ossBucket = this.resolveConfiguredOssBucket(line, cloudConfig.imageImportBucket);

          if (ossBucket) {
            const matchedLedger = await this.ensureOssBucketLedger({
              bucket: ossBucket,
              billingDate,
              regionId: cloudConfig.defaultRegion,
              ledgerResources,
            });

            await this.upsertMatchedBillLine({
              syncBatchId,
              billingDate,
              line,
              ledger: matchedLedger,
              cloudResourceId: ossBucket,
              cloudResourceType: 'oss_bucket',
            });
            importedLineItems += 1;
            continue;
          }

          if (
            classification.kind !== 'aggregated' &&
            !this.isPlatformScopedAnomaly(ledgerResources, classification, billingDate)
          ) {
            continue;
          }

          await this.adminRepository.createBillingAnomaly({
            syncBatchId,
            sourceFingerprint: this.buildSourceFingerprint(
              syncBatchId,
              classification.cloudResourceType,
              classification.cloudResourceId,
              readString(line, 'BillingItem'),
              readString(line, 'InstanceID'),
            ),
            billCycle: billingDate.slice(0, 7),
            billingDate,
            cloudResourceId: classification.cloudResourceId,
            cloudResourceType: classification.cloudResourceType,
            pretaxAmount: readNumber(line, 'PretaxAmount'),
            currency: readString(line, 'Currency') || 'CNY',
            reason: this.resolveAnomalyReason(classification, cloudConfig.imageImportBucket),
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

  private async upsertMatchedBillLine(input: {
    syncBatchId: string;
    billingDate: string;
    line: RawBillLine;
    ledger: BillingLedgerResourceRecord;
    cloudResourceId: string;
    cloudResourceType: BillingLedgerResourceRecord['cloudResourceType'];
  }) {
    await this.adminRepository.upsertBillingLineItems([
      {
        syncBatchId: input.syncBatchId,
        sourceFingerprint: this.buildSourceFingerprint(
          input.syncBatchId,
          input.cloudResourceType,
          input.cloudResourceId,
          readString(input.line, 'BillingItem'),
          readString(input.line, 'InstanceID'),
        ),
        billCycle: input.billingDate.slice(0, 7),
        billingDate: input.billingDate,
        productCode: readString(input.line, 'ProductCode'),
        productDetail: readString(input.line, 'ProductDetail') || null,
        billItem: readString(input.line, 'BillingItem'),
        cloudResourceId: input.cloudResourceId,
        cloudResourceType: input.cloudResourceType,
        pretaxAmount: readNumber(input.line, 'PretaxAmount'),
        currency: readString(input.line, 'Currency') || 'CNY',
        billingScope: input.ledger.billingScope,
        ownerUserId: input.ledger.ownerUserId,
        matchedLedgerId: input.ledger.id,
        rawPayload: input.line,
      },
    ]);
  }

  private async findTaggedLedgerResource(input: {
    line: RawBillLine;
    classification: ReturnType<typeof classifyBillLine>;
    billingDate: string;
    defaultRegionId: string;
    ledgerResources: BillingLedgerResourceRecord[];
  }) {
    if (input.classification.kind !== 'direct') {
      return null;
    }

    const tagged = parsePlatformBillingTags(input.line.Tag);

    if (!tagged || !input.classification.cloudResourceId) {
      return null;
    }

    const existing = this.findLedgerResource(
      input.ledgerResources,
      input.classification.cloudResourceId,
      input.classification.cloudResourceType,
    );

    if (existing) {
      return isLedgerActiveForBillingDate(existing, input.billingDate) ? existing : null;
    }

    const ledger = await this.adminRepository.createBillingLedgerResource({
      cloudProvider: 'alibaba_cloud',
      regionId: input.defaultRegionId,
      cloudResourceId: input.classification.cloudResourceId,
      cloudResourceType: input.classification.cloudResourceType,
      billingScope: tagged.billingScope,
      ownerUserId: tagged.ownerUserId,
      rangeInstanceId: tagged.rangeInstanceId,
      singleInstanceBatchId: tagged.singleInstanceBatchId,
      platformImageAssetId: tagged.platformImageAssetId,
      billingStartAt: parseDate(tagged.billingStartAt ?? input.billingDate),
      tagsSnapshot: tagged.tags,
    });
    input.ledgerResources.push(ledger);

    return ledger;
  }

  private async reconcilePlatformImageBillingLedgers(ledgerResources: BillingLedgerResourceRecord[]) {
    const assets = await this.adminRepository.listPlatformImageAssets();

    for (const asset of assets) {
      if (asset.ownerUserId || !asset.imageId.trim()) {
        continue;
      }

      const tagsSnapshot = buildBillingTags({
        billingScope: 'platform',
        platformImageAssetId: asset.id,
        billingStartAt: asset.createdAt,
      });

      for (const cloudResourceType of ['image', 'snapshot'] as const) {
        const existing = ledgerResources.find(
          (item) =>
            item.regionId === asset.regionId &&
            item.cloudResourceId === asset.imageId &&
            item.cloudResourceType === cloudResourceType,
        );

        if (existing) {
          if (
            existing.billingScope === 'platform' &&
            existing.ownerUserId === null &&
            existing.platformImageAssetId === asset.id &&
            existing.releasedAt === null
          ) {
            continue;
          }

          const updated = await this.adminRepository.updateBillingLedgerResource(existing.id, {
            billingScope: 'platform',
            ownerUserId: null,
            rangeInstanceId: null,
            singleInstanceBatchId: null,
            platformImageAssetId: asset.id,
            releasedAt: null,
            tagsSnapshot,
          });
          const index = ledgerResources.findIndex((item) => item.id === updated.id);

          if (index >= 0) {
            ledgerResources[index] = updated;
          }
          continue;
        }

        const created = await this.adminRepository.createBillingLedgerResource({
          cloudProvider: asset.provider,
          cloudAccountUid: asset.accountUid,
          regionId: asset.regionId,
          cloudResourceId: asset.imageId,
          cloudResourceType,
          billingScope: 'platform',
          ownerUserId: null,
          platformImageAssetId: asset.id,
          billingStartAt: asset.createdAt,
          tagsSnapshot,
        });
        ledgerResources.push(created);
      }
    }
  }

  private resolveConfiguredOssBucket(line: RawBillLine, configuredBucket: string) {
    const bucket = configuredBucket.trim();

    if (!bucket || readString(line, 'ProductCode').trim().toLowerCase() !== 'oss') {
      return null;
    }

    const matchesBucket = (value: string) => value === bucket || value.startsWith(`${bucket};`);
    const identifiers = ['InstanceID', 'InstanceName', 'NickName', 'ResourceId', 'ResourceName'];

    return identifiers.some((key) => matchesBucket(readString(line, key))) ? bucket : null;
  }

  private async ensureOssBucketLedger(input: {
    bucket: string;
    billingDate: string;
    regionId: string;
    ledgerResources: BillingLedgerResourceRecord[];
  }) {
    const existing = this.findLedgerResource(input.ledgerResources, input.bucket, 'oss_bucket');
    const tagsSnapshot = buildBillingTags({
      billingScope: 'platform',
      billingStartAt: input.billingDate,
    });

    if (existing) {
      const ledger = await this.adminRepository.updateBillingLedgerResource(existing.id, {
        billingScope: 'platform',
        ownerUserId: null,
        releasedAt: null,
        tagsSnapshot,
      });
      const index = input.ledgerResources.findIndex((item) => item.id === ledger.id);

      if (index >= 0) {
        input.ledgerResources[index] = ledger;
      }

      return ledger;
    }

    const ledger = await this.adminRepository.createBillingLedgerResource({
      cloudProvider: 'alibaba_cloud',
      regionId: input.regionId,
      cloudResourceId: input.bucket,
      cloudResourceType: 'oss_bucket',
      billingScope: 'platform',
      ownerUserId: null,
      billingStartAt: parseDate(input.billingDate),
      tagsSnapshot,
    });
    input.ledgerResources.push(ledger);

    return ledger;
  }

  private buildSourceFingerprint(
    syncBatchId: string,
    resourceType: string,
    resourceId: string,
    billItem: string,
    sourceInstanceId = '',
  ) {
    return `${syncBatchId}:${resourceType}:${resourceId}:${billItem}:${sourceInstanceId}`;
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
    classification: ReturnType<typeof classifyBillLine>,
    configuredOssBucket: string,
  ) {
    if (classification.kind === 'aggregated') {
      if (classification.cloudResourceType === 'snapshot_region') {
        return '该账单是地域级快照链容量，BSS 未提供具体快照资源 ID 或平台标记，因此不计入平台费用。';
      }

      const bucket = configuredOssBucket.trim();

      if (bucket) {
        return `该 OSS 账单未提供已配置平台 Bucket“${bucket}”的精确标识，因此不计入平台费用。`;
      }

      return '该 OSS 账单未提供平台 Bucket 的精确标识，因此不计入平台费用。';
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
