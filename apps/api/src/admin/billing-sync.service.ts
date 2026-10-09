import { createHash } from 'node:crypto';

import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';

import {
  ADMIN_REPOSITORY,
  AdminRepository,
  type BillingLedgerResourceRecord,
  type CreateBillingLineItemInput,
  type CreateBillingAnomalyInput,
} from './admin.repository';
import { BillingBssClient } from './billing-bss-client';
import { classifyBillLine } from './billing-classifier';
import { buildBillingTags, parsePlatformBillingTags } from './billing-tagging';
import { SystemConfigService } from './system-config.service';
import { billingDayText, resolveBillingWindow } from './billing-window';

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
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return dates;
}

const RELEASE_BILLING_GRACE_DAYS = 1;

function isLedgerActiveForBillingDate(ledger: BillingLedgerResourceRecord, billingDate: string, correction = false) {
  const billingDateText = billingDate;
  const startAtText = billingDayText(ledger.billingStartAt);

  if (billingDateText < startAtText) {
    return false;
  }

  if (ledger.releasedAt && !correction) {
    const releaseDeadline = new Date(`${billingDayText(ledger.releasedAt)}T00:00:00.000Z`);
    releaseDeadline.setUTCDate(releaseDeadline.getUTCDate() + RELEASE_BILLING_GRACE_DAYS);

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
  if ((typeof value !== 'number' && typeof value !== 'string') || value === '' || !Number.isFinite(Number(value))) {
    throw new Error(`BSS returned an invalid ${key}; previous bills were retained`);
  }
  return Number(value);
}

function stableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stableJson(item)]));
  return value;
}

function explicitRegionId(line: RawBillLine, tags: Record<string, string> = {}) {
  const values = [readString(line, 'RegionId'), readString(line, 'Region'), tags.PlatformRegionId ?? ''];
  return values.map(value => value.trim()).find(value => /^(cn|ap|eu|us|me|af|sa)-[a-z0-9-]+$/.test(value)) ?? null;
}

@Injectable()
export class BillingSyncService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BillingSyncService.name);
  private timer: NodeJS.Timeout | null = null;
  private isRunning = false;

  constructor(
    @Inject(ADMIN_REPOSITORY) private readonly adminRepository: AdminRepository,
    private readonly billingBssClient: BillingBssClient,
    private readonly systemConfigService: SystemConfigService,
  ) {}

  onModuleInit() {
    const intervalMs = Number(process.env.BILLING_SYNC_INTERVAL_MS ?? '');

    if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0 || intervalMs > 2_147_483_647) {
      return;
    }

    this.timer = setInterval(() => {
      // Month-end settlement can revise bills older than the default seven-day manual window.
      const today = resolveBillingWindow({}, 1).endAt;
      const previousMonthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
      const days = Math.round((today.getTime() - previousMonthStart.getTime()) / 86_400_000);
      void this.syncRecentDays(days).catch(() => this.logger.error('账单定时同步失败，失败账期的数据已保留，稍后重试。'));
    }, intervalMs);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async syncRecentDays(days: number) {
    const today = resolveBillingWindow({}, days).endAt;
    const endAt = new Date(today.getTime() - 86_400_000);
    const startAt = new Date(endAt.getTime() - (days - 1) * 86_400_000);
    // Daily BSS results are revised after their first appearance; revisit the whole overlap window.
    return this.syncRange({ startAt, endAt });
  }

  async syncRange(input: { startAt: string | Date; endAt: string | Date }) {
    if (this.isRunning) {
      return {
        syncedDays: 0,
        importedLineItems: 0,
        anomalyCount: 0,
        deferredCount: 1,
        syncInProgress: true,
      };
    }

    this.isRunning = true;

    try {
      const window = resolveBillingWindow(input);
      const requestedStartAt = window.startAt;
      const lastCompleteDay = new Date(resolveBillingWindow({}, 1).endAt.getTime() - 86_400_000);
      const endAt = window.endAt < lastCompleteDay ? window.endAt : lastCompleteDay;
      const deferredDates = window.endAt > endAt ? enumerateDates(new Date(Math.max(window.startAt.getTime(), endAt.getTime() + 86_400_000)), window.endAt) : [];
      const cloudConfig = await this.systemConfigService.getAccountContext();
      const cloudAccountUid = cloudConfig.accountUid;
      if (!cloudAccountUid || !cloudConfig.accountUidResolved) throw new Error('账单同步需要已验证的云账号。');
      const startAt = requestedStartAt;

      if (startAt > endAt) {
        return {
          syncedDays: 0,
          importedLineItems: 0,
          anomalyCount: 0,
          deferredCount: deferredDates.length,
          ...(deferredDates.length ? { deferredDates } : {}),
        };
      }

      const dates = enumerateDates(startAt, endAt);
      const ledgerResources = await this.adminRepository.listBillingLedgerResources();
      let importedLineItems = 0;
      let anomalyCount = 0;

      for (const billingDate of dates) {
        const syncBatchId = `billing-sync:${cloudAccountUid}:${billingDate}`;
        const items = await this.billingBssClient.listDailyBillingItems({ billingDate }, cloudConfig);
        for (const line of items) {
          readNumber(line, 'PretaxAmount');
          if (!/^[A-Z]{3}$/.test(readString(line, 'Currency'))) throw new Error('BSS returned an invalid currency; previous bills were retained');
          if (line.OwnerID !== undefined && String(line.OwnerID) !== cloudAccountUid) throw new Error('BSS returned a bill for a different resource account');
          if (line.BillingDate !== undefined && readString(line, 'BillingDate') !== billingDate) throw new Error('BSS returned a bill for a different billing date; previous bills were retained');
        }
        await this.reconcilePlatformImageBillingLedgers(ledgerResources, cloudAccountUid);
        const dayItems = new Map<string, CreateBillingLineItemInput>();
        const dayAnomalies = new Map<string, CreateBillingAnomalyInput>();

        for (const line of items) {
          const classification = classifyBillLine(line);

          if (classification.kind === 'direct') {
            const matchedLedger =
              this.findActiveLedgerResource(
                ledgerResources,
                classification.cloudResourceId,
                classification.cloudResourceType,
                billingDate,
                cloudAccountUid,
                ['Refund', 'Adjustment'].includes(readString(line, 'Item')),
                explicitRegionId(line),
              ) ??
              (await this.findTaggedLedgerResource({
                line,
                classification,
                billingDate,
                cloudAccountUid,
                ledgerResources,
              }));

            if (matchedLedger) {
              const matched = this.buildMatchedBillLine({
                cloudAccountUid,
                syncBatchId,
                billingDate,
                line,
                ledger: matchedLedger,
                cloudResourceId: classification.cloudResourceId,
                cloudResourceType: classification.cloudResourceType,
              });
              dayItems.set(matched.sourceFingerprint, matched);
              continue;
            }
          }

          const ossBucket = this.resolveConfiguredOssBucket(line, cloudConfig.imageImportBucket);

          if (ossBucket) {
            const matchedLedger = await this.ensureOssBucketLedger({
              bucket: ossBucket,
              billingDate,
              regionId: cloudConfig.defaultRegion,
              cloudAccountUid,
              ledgerResources,
            });

            const matched = this.buildMatchedBillLine({
              cloudAccountUid,
              syncBatchId,
              billingDate,
              line,
              ledger: matchedLedger,
              cloudResourceId: ossBucket,
              cloudResourceType: 'oss_bucket',
            });
            dayItems.set(matched.sourceFingerprint, matched);
            continue;
          }

          if (
            classification.kind !== 'aggregated' &&
            !parsePlatformBillingTags(line.Tag) && !this.isPlatformScopedAnomaly(ledgerResources.filter(item => item.cloudAccountUid === cloudAccountUid || item.cloudAccountUid === null), classification, billingDate)
          ) {
            continue;
          }

          const anomaly: CreateBillingAnomalyInput = {
            cloudAccountUid,
            syncBatchId,
            sourceFingerprint: this.buildSourceFingerprint(syncBatchId, line),
            billCycle: billingDate.slice(0, 7),
            billingDate,
            cloudResourceId: classification.cloudResourceId,
            cloudResourceType: classification.cloudResourceType,
            pretaxAmount: readNumber(line, 'PretaxAmount'),
            currency: readString(line, 'Currency') || 'CNY',
            reason: this.resolveAnomalyReason(classification, cloudConfig.imageImportBucket),
            rawPayload: line,
          };
          dayAnomalies.set(anomaly.sourceFingerprint, anomaly);
        }
        await this.adminRepository.replaceBillingDay({ cloudAccountUid, billingDate, lineItems: [...dayItems.values()], anomalies: [...dayAnomalies.values()] });
        importedLineItems += dayItems.size;
        anomalyCount += dayAnomalies.size;
      }

      return {
        syncedDays: dates.length,
        importedLineItems,
        anomalyCount,
        deferredCount: deferredDates.length,
        ...(deferredDates.length ? { deferredDates } : {}),
      };
    } finally {
      this.isRunning = false;
    }
  }

  private buildMatchedBillLine(input: {
    cloudAccountUid: string;
    syncBatchId: string;
    billingDate: string;
    line: RawBillLine;
    ledger: BillingLedgerResourceRecord;
    cloudResourceId: string;
    cloudResourceType: BillingLedgerResourceRecord['cloudResourceType'];
  }) {
    return {
      cloudAccountUid: input.cloudAccountUid,
      syncBatchId: input.syncBatchId,
      sourceFingerprint: this.buildSourceFingerprint(input.syncBatchId, input.line),
      billCycle: input.billingDate.slice(0, 7),
      billingDate: input.billingDate,
      productCode: readString(input.line, 'ProductCode'),
      productDetail: readString(input.line, 'ProductDetail') || null,
      billItem: readString(input.line, 'BillingItem'),
      cloudResourceId: input.cloudResourceId,
      cloudResourceType: input.cloudResourceType,
      pretaxAmount: readNumber(input.line, 'PretaxAmount'),
      currency: readString(input.line, 'Currency'),
      billingScope: input.ledger.billingScope,
      ownerUserId: input.ledger.ownerUserId,
      matchedLedgerId: input.ledger.id,
      rawPayload: input.line,
    };
  }

  private async findTaggedLedgerResource(input: {
    line: RawBillLine;
    classification: ReturnType<typeof classifyBillLine>;
    billingDate: string;
    cloudAccountUid: string;
    ledgerResources: BillingLedgerResourceRecord[];
  }) {
    if (input.classification.kind !== 'direct') {
      return null;
    }

    const tagged = parsePlatformBillingTags(input.line.Tag);

    if (!tagged || !input.classification.cloudResourceId
      || tagged.tags.CloudAccountUid && tagged.tags.CloudAccountUid !== input.cloudAccountUid) {
      return null;
    }

    const existing = this.findLedgerResource(
      input.ledgerResources,
      input.classification.cloudResourceId,
      input.classification.cloudResourceType,
      input.cloudAccountUid,
    );

    if (existing) {
      const regionId = explicitRegionId(input.line, tagged.tags);
      if (regionId && existing.regionId !== regionId) return null;
      return isLedgerActiveForBillingDate(existing, input.billingDate, ['Refund', 'Adjustment'].includes(readString(input.line, 'Item'))) ? existing : null;
    }

    const regionId = explicitRegionId(input.line, tagged.tags);
    if (!regionId || (tagged.billingScope === 'user' && !tagged.ownerUserId)) return null;
    // The legacy unique key omits account UID. An unproven collision must not abort all other bills for this day.
    if (input.ledgerResources.some(item => item.regionId === regionId && item.cloudResourceId === input.classification.cloudResourceId
      && item.cloudResourceType === input.classification.cloudResourceType && item.cloudAccountUid !== input.cloudAccountUid)) return null;
    if (tagged.billingScope === 'user') {
      if (!(await this.adminRepository.getPlatformUserById(tagged.ownerUserId!))) return null;
      if (tagged.rangeInstanceId) {
        const instance = await this.adminRepository.getRangeInstanceById(tagged.rangeInstanceId);
        if (!instance || instance.ownerUserId !== tagged.ownerUserId
          || instance.singleInstanceConfig?.cloudAccountUid && instance.singleInstanceConfig.cloudAccountUid !== input.cloudAccountUid
          || (tagged.singleInstanceBatchId && instance.singleInstanceBatchId !== tagged.singleInstanceBatchId)) return null;
      }
    }
    const ledger = await this.createScopedLedger({
      cloudProvider: 'alibaba_cloud',
      cloudAccountUid: input.cloudAccountUid,
      regionId,
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

  private async reconcilePlatformImageBillingLedgers(ledgerResources: BillingLedgerResourceRecord[], cloudAccountUid: string) {
    const assets = await this.adminRepository.listPlatformImageAssets({ accountUid: cloudAccountUid });

    for (const asset of assets) {
      if (asset.ownerUserId || !asset.imageId.trim()) {
        continue;
      }

      const tagsSnapshot = buildBillingTags({
        billingScope: 'platform',
        platformImageAssetId: asset.id,
        billingStartAt: asset.createdAt,
      });

      for (const cloudResourceType of ['image'] as const) {
        const existing = ledgerResources.find(
          (item) =>
            (item.cloudAccountUid === asset.accountUid || item.cloudAccountUid === null) &&
            item.regionId === asset.regionId &&
            item.cloudResourceId === asset.imageId &&
            item.cloudResourceType === cloudResourceType,
        );

        if (existing) {
          if (
            existing.cloudAccountUid === cloudAccountUid &&
            existing.billingScope === 'platform' &&
            existing.ownerUserId === null &&
            existing.platformImageAssetId === asset.id &&
            existing.releasedAt === null
          ) {
            continue;
          }

          const updated = await this.adminRepository.updateBillingLedgerResource(existing.id, {
            cloudAccountUid,
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

        const created = await this.createScopedLedger({
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
    cloudAccountUid: string;
    ledgerResources: BillingLedgerResourceRecord[];
  }) {
    const existing = this.findLedgerResource(input.ledgerResources, input.bucket, 'oss_bucket', input.cloudAccountUid);
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

    const ledger = await this.createScopedLedger({
      cloudProvider: 'alibaba_cloud',
      cloudAccountUid: input.cloudAccountUid,
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

  private buildSourceFingerprint(syncBatchId: string, line: RawBillLine) {
    // BSS has no row ID; the complete row preserves charge/refund, commodity, pricing and currency dimensions.
    return `${syncBatchId}:${createHash('sha256').update(JSON.stringify(stableJson(line))).digest('hex')}`;
  }

  private async createScopedLedger(input: Parameters<AdminRepository['createBillingLedgerResource']>[0]) {
    try {
      return await this.adminRepository.createBillingLedgerResource(input);
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'P2002')) throw error;
      const existing = (await this.adminRepository.listBillingLedgerResources()).find(item => item.cloudAccountUid === input.cloudAccountUid && item.regionId === input.regionId && item.cloudResourceId === input.cloudResourceId && item.cloudResourceType === input.cloudResourceType);
      if (!existing) throw error;
      return existing;
    }
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
        item.cloudResourceId === classification.cloudResourceId && billingDate >= billingDayText(item.billingStartAt),
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

    return `已识别到平台账单，但台账或可核实的地域/用户归属缺失：${classification.cloudResourceType}:${classification.cloudResourceId}`;
  }

  private findLedgerResource(
    ledgerResources: BillingLedgerResourceRecord[],
    cloudResourceId: string,
    cloudResourceType: BillingLedgerResourceRecord['cloudResourceType'],
    cloudAccountUid: string,
  ) {
    return ledgerResources.find(
      (item) => item.cloudAccountUid === cloudAccountUid && item.cloudResourceId === cloudResourceId && item.cloudResourceType === cloudResourceType,
    );
  }

  private findActiveLedgerResource(
    ledgerResources: BillingLedgerResourceRecord[],
    cloudResourceId: string,
    cloudResourceType: BillingLedgerResourceRecord['cloudResourceType'],
    billingDate: string,
    cloudAccountUid: string,
    correction: boolean,
    regionId: string | null,
  ) {
    const matchedLedger = this.findLedgerResource(ledgerResources, cloudResourceId, cloudResourceType, cloudAccountUid);

    if (!matchedLedger || regionId && matchedLedger.regionId !== regionId) {
      return null;
    }

    return isLedgerActiveForBillingDate(matchedLedger, billingDate, correction) ? matchedLedger : null;
  }
}
