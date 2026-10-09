import { Prisma } from '@aliyun-cyber-range/database/generated/client';
import { createHash } from 'node:crypto';

import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';

import {
  ADMIN_REPOSITORY,
  AdminRepository,
  type BillingLedgerResourceRecord,
  type CreateBillingLineItemInput,
  type CreateBillingAnomalyInput,
  type BillingLineItemRecord,
} from './admin.repository';
import { assertAlibabaBillingContext, BillingBssClient } from './billing-bss-client';
import { billRegionId, billRegionConflict, classifyPlatformBillLine, isAlibabaBillingPayload, isPlatformCreatedLedger, loadPlatformBillingProof, type PlatformBillingProof, ledgerBillingDateMatches, pendingPlatformBillingEvidence } from './billing-platform-scope';
import { SystemConfigService } from './system-config.service';
import { billingDayText, resolveBillingWindow } from './billing-window';

type RawBillLine = Record<string, unknown>;

function toIsoDate(value: Date) {
  return value.toISOString().slice(0, 10);
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
      const cloudConfig = { ...await this.systemConfigService.getAccountContext() };
      assertAlibabaBillingContext(cloudConfig);
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
      let proof = await loadPlatformBillingProof(this.adminRepository);
      if (await this.repairImageLedgerOrigins(proof, cloudAccountUid)) proof = await loadPlatformBillingProof(this.adminRepository);
      let importedLineItems = 0;
      let anomalyCount = 0;

      for (const billingDate of dates) {
        const syncBatchId = `billing-sync:alibaba_cloud:${cloudAccountUid}:${billingDate}`;
        const items = await this.billingBssClient.listDailyBillingItems({ billingDate }, cloudConfig);
        for (const line of items) {
          if (!isAlibabaBillingPayload(line)) throw new Error('BSS returned a bill for a different cloud provider; previous bills were retained');
          readNumber(line, 'PretaxAmount');
          if (!/^[A-Z]{3}$/.test(readString(line, 'Currency'))) throw new Error('BSS returned an invalid currency; previous bills were retained');
          if (line.OwnerID !== undefined && String(line.OwnerID) !== cloudAccountUid) throw new Error('BSS returned a bill for a different resource account');
          if (line.BillingDate !== undefined && readString(line, 'BillingDate') !== billingDate) throw new Error('BSS returned a bill for a different billing date; previous bills were retained');
        }
        const previous: BillingLineItemRecord[] = (await this.adminRepository.listBillingLineItems({ cloudAccountUid, startAt: billingDate, endAt: billingDate }))
          .filter(line => proof.ledgers.some(ledger => ledger.id === line.matchedLedgerId && isPlatformCreatedLedger(ledger, proof)
            && ledger.cloudProvider === 'alibaba_cloud' && isAlibabaBillingPayload(line.rawPayload)
            && ledger.cloudAccountUid === cloudAccountUid && ledger.cloudResourceId === line.cloudResourceId && ledger.cloudResourceType === line.cloudResourceType));
        const resolved = await this.resolveSplitItems(items, billingDate, cloudAccountUid, cloudConfig, proof, previous);
        const dayItems = new Map<string, CreateBillingLineItemInput>();
        const dayAnomalies = new Map<string, CreateBillingAnomalyInput>();

        for (const line of resolved.items) {
          const classification = classifyPlatformBillLine(line);
          // A deferred product is one coherent previous revision, never a mixture of old splits and new direct charges.
          if (resolved.retainedProducts.has(readString(line, 'ProductCode')) && classification.kind === 'direct') continue;

          if (classification.kind === 'direct' && !billRegionConflict(line)) {
            const matchedLedger =
              this.findActiveLedgerResource(
                proof,
                classification.cloudResourceId,
                classification.cloudResourceType,
                billingDate,
                cloudAccountUid,
                billRegionId(line),
              );

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

          const evidence = pendingPlatformBillingEvidence({ line, cloudAccountUid, billingDate, proof });
          if (!evidence) continue;

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
            reason: evidence.kind === 'aggregate_pending'
              ? '该账单覆盖的平台资源费用尚待资源级分账；源账单总额可能包含外部资源，不计入平台费用或平台待归属金额。'
              : evidence.kind === 'source_pending' ? '资源 ID 与平台记录相同，但地域或来源存在冲突；该金额不计入平台费用或平台待归属金额。'
              : '已找到平台创建资源，但账单类型尚未核对一致，待核实后入账。',
            rawPayload: { ...line, __platformCloudProvider: 'alibaba_cloud', __platformBillingScope: evidence },
          };
          dayAnomalies.set(anomaly.sourceFingerprint, anomaly);
        }
        if (resolved.retainedProducts.size) {
          for (const line of previous) {
            const ledger = proof.ledgers.find(item => item.id === line.matchedLedgerId && isPlatformCreatedLedger(item, proof));
            if (resolved.retainedProducts.has(line.productCode)
              && ledger?.cloudAccountUid === cloudAccountUid && ledger.cloudResourceId === line.cloudResourceId && ledger.cloudResourceType === line.cloudResourceType) {
              dayItems.set(line.sourceFingerprint, { ...line, billingDate, cloudAccountUid, ownerUserId: ledger.ownerUserId, billingScope: ledger.billingScope,
                rawPayload: { ...line.rawPayload, __platformCloudProvider: 'alibaba_cloud', __platformBillingSyncDeferred: true } });
            }
          }
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
      rawPayload: { ...input.line, __platformCloudProvider: 'alibaba_cloud', ...(!ledgerBillingDateMatches(input.ledger, input.billingDate)
        ? { __platformPostReleaseCharge: true } : {}) },
    };
  }

  private async resolveSplitItems(items: RawBillLine[], billingDate: string, cloudAccountUid: string,
    context: Awaited<ReturnType<SystemConfigService['getAccountContext']>>, proof: PlatformBillingProof, previous: BillingLineItemRecord[]) {
    let resolved = items;
    const retainedProducts = new Set<string>();
    for (const productCode of ['snapshot', 'oss'] as const) {
      const original = items.filter(line => readString(line, 'ProductCode') === productCode);
      const previousProduct = previous.filter(line => line.productCode === productCode);
      if (!original.length && previousProduct.length) {
        retainedProducts.add(productCode);
        continue;
      }
      if (!original.some(line => classifyPlatformBillLine(line).kind === 'aggregated'
        && pendingPlatformBillingEvidence({ line, cloudAccountUid, billingDate, proof }))
        && !previousProduct.some(line => line.rawPayload.__platformBillingSource === 'DescribeSplitItemBill')) continue;
      try {
        const split = await this.billingBssClient.listDailySplitBillingItems({ billingDate, productCode }, context);
        // Mixed direct and aggregate source bills require an exact group join; keep their evidence until one is available.
        if (original.some(line => classifyPlatformBillLine(line).kind !== 'aggregated') || !this.splitTotalsMatch(original, split)) {
          throw new Error('Resource split bills do not reconcile with their source bill');
        }
        resolved = [...resolved.filter(line => readString(line, 'ProductCode') !== productCode),
          ...split.map(line => ({ ...line, __platformBillingSource: 'DescribeSplitItemBill' }))];
      } catch {
        // Split billing can be disabled or settle later; preserve proven earlier allocations and expose coverage work.
        if (previousProduct.length) retainedProducts.add(productCode);
      }
    }
    return { items: resolved, retainedProducts };
  }

  private splitTotalsMatch(original: RawBillLine[], split: RawBillLine[]) {
    if (!split.length) return false;
    const group = (lines: RawBillLine[]) => {
      const totals = new Map<string, Prisma.Decimal>();
      for (const line of lines) {
        const currency = readString(line, 'Currency');
        if (!/^[A-Z]{3}$/.test(currency)) return null;
        const key = JSON.stringify([readString(line, 'ProductCode'), currency, billRegionId(line), readString(line, 'InstanceID'), readString(line, 'CommodityCode'),
          readString(line, 'BillingItemCode') || readString(line, 'BillingItem'), readString(line, 'Item')]);
        totals.set(key, (totals.get(key) ?? new Prisma.Decimal(0)).plus(readNumber(line, 'PretaxAmount')));
      }
      return totals;
    };
    const sourceTotals = group(original);
    const splitTotals = group(split);
    return Boolean(sourceTotals && splitTotals && sourceTotals.size === splitTotals.size
      && [...sourceTotals].every(([key, value]) => splitTotals.has(key) && value.toDecimalPlaces(9).equals(splitTotals.get(key)!.toDecimalPlaces(9))));
  }

  private async repairImageLedgerOrigins(proof: PlatformBillingProof, cloudAccountUid: string) {
    let changed = false;
    for (const ledger of proof.ledgers.filter(item => item.cloudProvider === 'alibaba_cloud' && item.cloudAccountUid === cloudAccountUid && (item.cloudResourceType === 'image' || item.cloudResourceType === 'snapshot'))) {
      const packed = proof.packedImages.filter(artifact => artifact.cloudAccountUid === ledger.cloudAccountUid && artifact.regionId === ledger.regionId
        && (ledger.cloudResourceType === 'image' ? artifact.imageId === ledger.cloudResourceId : artifact.backingSnapshotIds.includes(ledger.cloudResourceId)));
      const imported = proof.imageImports.filter(job => job.cloudAccountUid === ledger.cloudAccountUid && job.regionId === ledger.regionId
        && (ledger.cloudResourceType === 'image' ? job.imageId === ledger.cloudResourceId : job.backingSnapshotIds.includes(ledger.cloudResourceId)));
      if (packed.length + imported.length !== 1) continue;
      const artifact = packed[0];
      const job = imported[0];
      const scope = artifact ? 'user' as const : 'platform' as const;
      const ownerUserId = artifact?.ownerUserId ?? null;
      const rangeInstanceId = artifact?.sourceRangeInstanceId ?? null;
      const startAt = artifact?.createdAt ?? job.uploadCompletedAt ?? job.createdAt;
      const tagsSnapshot = { ...ledger.tagsSnapshot, ...(artifact ? { PlatformPackedImageArtifactId: artifact.id } : { PlatformImageImportJobId: job.id }) };
      if (ledger.billingScope === scope && ledger.ownerUserId === ownerUserId && ledger.rangeInstanceId === rangeInstanceId
        && ledger.billingStartAt.getTime() === startAt.getTime() && JSON.stringify(tagsSnapshot) === JSON.stringify(ledger.tagsSnapshot)) continue;
      // Legacy catalog collection overwrote origins; restore only from an exact persisted creation artifact.
      await this.adminRepository.updateBillingLedgerResource(ledger.id, { billingScope: scope, ownerUserId, rangeInstanceId,
        billingStartAt: startAt, tagsSnapshot });
      changed = true;
    }
    return changed;
  }

  private buildSourceFingerprint(syncBatchId: string, line: RawBillLine) {
    // BSS has no row ID; the complete row preserves charge/refund, commodity, pricing and currency dimensions.
    return `${syncBatchId}:${createHash('sha256').update(JSON.stringify(stableJson(line))).digest('hex')}`;
  }

  private findActiveLedgerResource(
    proof: PlatformBillingProof,
    cloudResourceId: string,
    cloudResourceType: BillingLedgerResourceRecord['cloudResourceType'],
    billingDate: string,
    cloudAccountUid: string,
    regionId: string | null,
  ) {
    const matches = proof.ledgers.filter(item => isPlatformCreatedLedger(item, proof)
      && item.cloudProvider === 'alibaba_cloud'
      && item.cloudAccountUid === cloudAccountUid && item.cloudResourceId === cloudResourceId
      && item.cloudResourceType === cloudResourceType && (!regionId || item.regionId === regionId));
    // Without an explicit region a colliding physical ID is ambiguous, not permission to take the first row.
    if (matches.length !== 1) return null;
    return billingDate >= billingDayText(matches[0].billingStartAt) ? matches[0] : null;
  }
}
