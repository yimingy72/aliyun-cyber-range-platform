import { Prisma } from '@aliyun-cyber-range/database/generated/client';
import { createHash } from 'node:crypto';

import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';

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
import { TencentBillingClient, type TencentBillingContext } from './tencent-billing-client';
import { classifyTencentBillLine, isTencentBillingPayload, pendingTencentBillingEvidence, tencentBillRegionId, tencentCosBillLifetimeMatches } from './billing-platform-scope';
import { SystemConfigService } from './system-config.service';
import { billingDayText, resolveBillingWindow } from './billing-window';
import { getCurrentCloudWorkspaceId, getCurrentCloudWorkspaceScope, runInSystemCloudWorkspaceScope } from '../auth/cloud-workspace-scope';
import { listExecutionCloudWorkspaces, runInExecutionCloudWorkspace } from '../auth/background-cloud-workspace';

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
  if ((typeof value !== 'number' && typeof value !== 'string')
    || !/^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(String(value))) {
    throw new Error(`BSS returned an invalid ${key}; previous bills were retained`);
  }
  const amount = new Prisma.Decimal(value);
  // The numeric API and Decimal(20, 9) storage must both preserve the official amount.
  if (!amount.isFinite() || amount.decimalPlaces() > 9 || amount.abs().gte('100000000000')
    || !new Prisma.Decimal(amount.toNumber()).equals(amount)) {
    throw new Error(`BSS ${key} exceeds ledger precision; previous bills were retained`);
  }
  return amount.toNumber();
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
  private readonly runningWorkspaces = new Set<string>();
  private scheduledRunning = false;

  constructor(
    @Inject(ADMIN_REPOSITORY) private readonly adminRepository: AdminRepository,
    private readonly billingBssClient: BillingBssClient,
    private readonly systemConfigService: SystemConfigService,
    @Optional() private readonly tencentBillingClient?: TencentBillingClient,
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
      void runInSystemCloudWorkspaceScope(() => this.syncScheduledWorkspaces(days))
        .catch(() => this.logger.error('账单定时同步失败，失败账期的数据已保留，稍后重试。'));
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

  private async syncScheduledWorkspaces(days: number) {
    if (this.scheduledRunning) return;
    this.scheduledRunning = true;
    try {
      const spaces = await listExecutionCloudWorkspaces(this.systemConfigService);
      if (!spaces) return this.syncRecentDays(days);
      let failed = false;
      for (const space of spaces) {
        try {
          await runInExecutionCloudWorkspace(this.systemConfigService, space.id,
            () => this.syncRecentDays(days), { provider: space.provider, accountUid: space.accountUid });
        } catch { failed = true; }
      }
      if (failed) throw new Error('A cloud workspace billing refresh failed; other workspaces were still processed');
    } finally { this.scheduledRunning = false; }
  }

  async syncRange(input: { startAt: string | Date; endAt: string | Date }) {
    const cloudWorkspaceId = getCurrentCloudWorkspaceId() ?? 'legacy-test';
    if (this.runningWorkspaces.has(cloudWorkspaceId)) {
      return {
        syncedDays: 0,
        importedLineItems: 0,
        anomalyCount: 0,
        deferredCount: 1,
        syncInProgress: true,
      };
    }

    this.runningWorkspaces.add(cloudWorkspaceId);

    try {
      const window = resolveBillingWindow(input);
      const requestedStartAt = window.startAt;
      const lastCompleteDay = new Date(resolveBillingWindow({}, 1).endAt.getTime() - 86_400_000);
      const endAt = window.endAt < lastCompleteDay ? window.endAt : lastCompleteDay;
      const deferredDates = window.endAt > endAt ? enumerateDates(new Date(Math.max(window.startAt.getTime(), endAt.getTime() + 86_400_000)), window.endAt) : [];
      const cloudConfig = { ...await (typeof this.systemConfigService.getExecutionAccountContext === 'function'
        ? this.systemConfigService.getExecutionAccountContext() : this.systemConfigService.getAccountContext()) };
      if (!['alibaba_cloud', 'tencent_cloud'].includes(cloudConfig.provider)) throw new Error('当前云厂商尚未接入平台账单同步；原有账单已保留。');
      if (cloudConfig.provider === 'alibaba_cloud') assertAlibabaBillingContext(cloudConfig);
      if (cloudConfig.provider === 'tencent_cloud' && !this.tencentBillingClient) throw new Error('腾讯云尚未接入账单客户端；原有账单已保留。');
      const scope = getCurrentCloudWorkspaceScope();
      if (scope && !('system' in scope) && (scope.provider !== cloudConfig.provider || scope.accountUid !== cloudConfig.accountUid)) {
        throw new Error('Billing synchronization account does not match its cloud workspace');
      }
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
      if (cloudConfig.provider === 'tencent_cloud') return await this.syncTencentDates({ dates, deferredDates, cloudConfig, proof });
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
        const previous: BillingLineItemRecord[] = (await this.adminRepository.listBillingLineItems({ cloudProvider: 'alibaba_cloud', cloudAccountUid, startAt: billingDate, endAt: billingDate }))
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
        await this.adminRepository.replaceBillingDay({ cloudProvider: 'alibaba_cloud', cloudAccountUid, billingDate, lineItems: [...dayItems.values()], anomalies: [...dayAnomalies.values()] });
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
      this.runningWorkspaces.delete(cloudWorkspaceId);
    }
  }

  private async syncTencentDates(input: { dates: string[]; deferredDates: string[]; cloudConfig: TencentBillingContext; proof: PlatformBillingProof }) {
    if (!this.tencentBillingClient) throw new Error('Tencent billing client is unavailable');
    const context = Object.freeze({ ...input.cloudConfig });
    const accountUid = context.accountUid;
    if (!accountUid || !context.accountUidResolved) throw new Error('Tencent billing requires a verified account UIN');
    let importedLineItems = 0;
    let anomalyCount = 0;
    for (const month of [...new Set(input.dates.map(day => day.slice(0, 7)))]) {
      // Read the complete monthly revision once; no day is replaced if a later page is incomplete or invalid.
      const items = await this.tencentBillingClient.listMonthlyBillingItems({ month }, context);
      for (const item of items) {
        if (item.cloudProvider !== 'tencent_cloud' || item.cloudAccountUid !== accountUid || item.billingMonth !== month
          || !isTencentBillingPayload(item.rawPayload) || item.rawPayload.OwnerUin !== accountUid || item.rawPayload.PayerUin !== accountUid
          || item.rawPayload.BillDay !== `${item.billingDate} 00:00:00` || item.rawPayload.BillMonth !== `${month}-01 00:00:00`
          || item.rawPayload.ResourceId !== item.cloudResourceId || item.rawPayload.Id !== item.sourceId
          || !Array.isArray(item.rawPayload.ComponentSet) || !item.rawPayload.ComponentSet.length) throw new Error('Tencent billing source does not match its verified account, date or resource');
      }
      for (const day of input.dates.filter(date => date.slice(0, 7) === month)) {
        const syncBatchId = `billing-sync:tencent_cloud:${getCurrentCloudWorkspaceId() ?? 'legacy-unbound'}:${accountUid}:${day}`;
        const lineItems: CreateBillingLineItemInput[] = [];
        const anomalies: CreateBillingAnomalyInput[] = [];
        for (const item of items.filter(row => row.billingDate === day)) {
          const classification = classifyTencentBillLine(item.rawPayload);
          const region = tencentBillRegionId(item.rawPayload);
          const candidates = input.proof.ledgers.filter(ledger => isPlatformCreatedLedger(ledger, input.proof)
            && ledger.cloudProvider === 'tencent_cloud' && ledger.cloudAccountUid === accountUid
            && ledger.cloudResourceId === item.cloudResourceId && ledger.cloudResourceType === classification.cloudResourceType
            && ledger.regionId === region && day >= billingDayText(ledger.billingStartAt) && tencentCosBillLifetimeMatches(ledger, item.rawPayload, day));
          const ledger = classification.kind === 'direct' && candidates.length === 1 ? candidates[0] : null;
          const evidence = ledger ? null : pendingTencentBillingEvidence({ line: item.rawPayload, cloudAccountUid: accountUid, billingDate: day, proof: input.proof });
          // External resources and account/region aggregate rows have no exact platform creation proof.
          if (!ledger && !evidence) continue;
          const components = item.rawPayload.ComponentSet as Record<string, unknown>[];
          for (const [index, component] of components.entries()) {
            const cost = component?.RealCost;
            if (typeof cost !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(cost)) throw new Error('Tencent billing returned an invalid component amount; prior bills were retained');
            const amount = new Prisma.Decimal(cost);
            if (!amount.isFinite() || amount.decimalPlaces() > 9 || amount.abs().gte('100000000000') || !new Prisma.Decimal(amount.toNumber()).equals(amount)) throw new Error('Tencent billing amount exceeds ledger precision; prior bills were retained');
            const rawPayload = { ...item.rawPayload, __platformBillingComponentIndex: index,
              __platformBillingAmountBasis: 'ComponentSet.RealCost:CNY:yuan',
              ...(ledger?.releasedAt && day > billingDayText(ledger.releasedAt) ? { __platformPostReleaseCharge: true } : {}),
              ...(evidence ? { __platformBillingScope: evidence } : {}) };
            const base = { cloudProvider: 'tencent_cloud' as const, cloudAccountUid: accountUid, syncBatchId,
              sourceFingerprint: createHash('sha256').update(`${syncBatchId}:${item.sourceId}:${index}`).digest('hex'),
              billCycle: month, billingDate: day, cloudResourceId: item.cloudResourceId,
              cloudResourceType: classification.cloudResourceType, pretaxAmount: amount.toNumber(), currency: item.currency, rawPayload };
            if (ledger) lineItems.push({ ...base, productCode: String(item.rawPayload.BusinessCode),
              productDetail: readString(item.rawPayload, 'ProductCode') || null,
              billItem: [readString(item.rawPayload, 'ActionType'), String(component.ComponentCode ?? component.ItemCode ?? index)].filter(Boolean).join(' / '),
              billingScope: ledger.billingScope, ownerUserId: ledger.ownerUserId, matchedLedgerId: ledger.id });
            else anomalies.push({ ...base, reason: '已知平台创建资源的腾讯云账单产品、地域或来源尚待核实；未将该金额计入平台费用。' });
          }
        }
        await this.adminRepository.replaceBillingDay({ cloudProvider: 'tencent_cloud', cloudAccountUid: accountUid, billingDate: day, lineItems, anomalies });
        importedLineItems += lineItems.length;
        anomalyCount += anomalies.filter(item => (item.rawPayload?.__platformBillingScope as { kind?: string })?.kind === 'resource_pending').length;
      }
    }
    return { syncedDays: input.dates.length, importedLineItems, anomalyCount, deferredCount: input.deferredDates.length,
      ...(input.deferredDates.length ? { deferredDates: input.deferredDates } : {}) };
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
    context: Awaited<ReturnType<SystemConfigService['getExecutionAccountContext']>>, proof: PlatformBillingProof, previous: BillingLineItemRecord[]) {
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
      const packed = proof.packedImages.filter(artifact => (artifact.cloudProvider ?? 'alibaba_cloud') === 'alibaba_cloud' && artifact.cloudAccountUid === ledger.cloudAccountUid && artifact.regionId === ledger.regionId
        && (ledger.cloudResourceType === 'image' ? artifact.imageId === ledger.cloudResourceId : artifact.backingSnapshotIds.includes(ledger.cloudResourceId)));
      const imported = proof.imageImports.filter(job => (job.cloudProvider ?? 'alibaba_cloud') === 'alibaba_cloud' && job.cloudAccountUid === ledger.cloudAccountUid && job.regionId === ledger.regionId
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
