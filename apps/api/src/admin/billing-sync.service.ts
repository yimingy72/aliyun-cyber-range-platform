import { Prisma } from '@aliyun-cyber-range/database/generated/client';
import { createHash } from 'node:crypto';
import { isIPv4 } from 'node:net';

import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';

import {
  ADMIN_REPOSITORY,
  AdminRepository,
  type BillingLedgerResourceRecord,
  type CreateBillingLineItemInput,
  type CreateBillingAnomalyInput,
  type BillingLineItemRecord,
} from './admin.repository';
import { assertAlibabaBillingContext, BillingBssClient, type SplitBillingProduct } from './billing-bss-client';
import { BillingDecimal, isSupportedBillingAmount } from './billing-amount';
import { billingExpenseScope } from './billing-expense-scope';
import { billRegionId, billRegionConflict, classifyPlatformBillLine, isAlibabaBillingPayload, isPlatformCreatedLedger, loadPlatformBillingProof, type PlatformBillingProof, ledgerBillingDateMatches, pendingPlatformBillingEvidence } from './billing-platform-scope';
import { TencentBillingClient, type TencentBillingContext } from './tencent-billing-client';
import { classifyTencentBillLine, isTencentBillingPayload, pendingTencentBillingEvidence, tencentBillRegionId, tencentCosBillLifetimeMatches } from './billing-platform-scope';
import { SystemConfigService, type SystemCloudAccountContext } from './system-config.service';
import { currentBillingRows, currentBillingSyncBatchId, currentPlatformBillingProof, readPlatformBillingStartedAt } from './billing-current-scope';
import { billingDayText, resolveBillingWindow } from './billing-window';
import { getCurrentCloudWorkspaceId, getCurrentCloudWorkspaceScope, runInSystemCloudWorkspaceScope } from '../auth/cloud-workspace-scope';
import { listExecutionCloudWorkspaces, runInExecutionCloudWorkspace } from '../auth/background-cloud-workspace';
import { repairAlibabaLedgerOrigins } from './billing-ledger-origin-repair';
import { aliyunSnapshotHistoryStartAt, aliyunPackSnapshotBaselineIssue, collectAliyunSnapshotHistory, readAliyunSnapshotEcsScope, verifyAliyunSnapshotEcsBillEvidence, type AliyunSnapshotHistory } from './aliyun-snapshot-ecs-evidence';
import { readAliyunOssDedicatedBilling, aliyunOssBindingCoversBillingDay, refreshAliyunOssBindingVerification } from './billing-oss-binding-proof';
import { BILLING_REASONS, billingKey, financialGroupKey, type ScopedBillingResult } from './billing-reconciliation-types';

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
  const amount = new BillingDecimal(value);
  if (!isSupportedBillingAmount(amount)) {
    throw new Error(`BSS ${key} exceeds ledger precision; previous bills were retained`);
  }
  return amount.toNumber();
}

function readCurrency(line: RawBillLine) {
  const value = readString(line, 'Currency');
  if (!/^[A-Z]{3}$/.test(value)) throw new Error('BSS returned an invalid Currency; previous bills were retained');
  return value;
}

function stableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stableJson(item)]));
  return value;
}

@Injectable()
export class BillingSyncService implements OnModuleInit, OnModuleDestroy {
  private readonly platformBillingStartedAt = readPlatformBillingStartedAt();
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
  async currentMode() {
    return typeof this.systemConfigService.getBillingReconciliationMode==='function'?this.systemConfigService.getBillingReconciliationMode():'legacy';
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
            async () => {
              const mode = typeof this.systemConfigService.getBillingReconciliationMode === 'function'
                ? await this.systemConfigService.getBillingReconciliationMode() : 'legacy';
              if (mode !== 'resource') await this.syncRecentDays(days);
            }, { provider: space.provider, accountUid: space.accountUid });
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
      const scopeStart = this.platformBillingStartedAt ? new Date(`${billingDayText(this.platformBillingStartedAt)}T00:00:00.000Z`) : window.startAt;
      const startAt = window.startAt > scopeStart ? window.startAt : scopeStart;
      const lastCompleteDay = new Date(resolveBillingWindow({}, 1).endAt.getTime() - 86_400_000);
      const endAt = window.endAt < lastCompleteDay ? window.endAt : lastCompleteDay;
      const deferredDates = window.endAt > endAt ? enumerateDates(new Date(Math.max(window.startAt.getTime(), endAt.getTime() + 86_400_000)), window.endAt) : [];
      if (startAt > endAt) return { syncedDays: 0, importedLineItems: 0, anomalyCount: 0,
        deferredCount: deferredDates.length, ...(deferredDates.length ? { deferredDates } : {}) };
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
      const dates = enumerateDates(startAt, endAt);
      let proof = await this.loadCurrentProof();
      if (cloudConfig.provider === 'tencent_cloud') return await this.syncTencentDates({ dates, deferredDates, cloudConfig, proof });
      if (await this.repairImageLedgerOrigins(proof, cloudAccountUid)) proof = await this.loadCurrentProof();
      let importedLineItems = 0;
      let anomalyCount = 0;

      for (const billingDate of dates) {
        const syncBatchId = currentBillingSyncBatchId(`billing-sync:alibaba_cloud:${cloudAccountUid}:${billingDate}`, this.platformBillingStartedAt);
        const items = await this.billingBssClient.listDailyBillingItems({ billingDate }, cloudConfig);
        for (const line of items) {
          if (!isAlibabaBillingPayload(line)) throw new Error('BSS returned a bill for a different cloud provider; previous bills were retained');
          if (!/^[A-Z]{3}$/.test(readString(line, 'Currency'))) throw new Error('BSS returned an invalid currency; previous bills were retained');
          if (line.OwnerID !== undefined && String(line.OwnerID) !== cloudAccountUid) throw new Error('BSS returned a bill for a different resource account');
          if (line.BillingDate !== undefined && readString(line, 'BillingDate') !== billingDate) throw new Error('BSS returned a bill for a different billing date; previous bills were retained');
        }
        if (await repairAlibabaLedgerOrigins(this.adminRepository, proof, items, cloudAccountUid, billingDate)) {
          proof = await this.loadCurrentProof();
        }
        const eipLedgers = proof.ledgers.filter(ledger => ledger.cloudProvider === 'alibaba_cloud'
          && ledger.cloudAccountUid === cloudAccountUid && ledger.cloudResourceType === 'eip'
          && isPlatformCreatedLedger(ledger,proof) && ledgerBillingDateMatches(ledger,billingDate));
        if (eipLedgers.length) {
          // Count official receipts without logging amounts, raw vendor rows or unrelated resource IDs.
          const safeCode = (value: unknown) => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,95}$/.test(value)
            && ![cloudConfig.accessKeyId,cloudConfig.accessKeySecret].some(secret => secret && value.includes(secret)) ? value : 'other';
          const productCounts = (rows: RawBillLine[]) => {
            const counts = new Map<string,number>();
            for (const row of rows) {
              const product = readString(row,'ProductCode');
              const code = safeCode(product);
              counts.set(code,(counts.get(code) ?? 0)+1);
            }
            return Object.fromEntries(counts);
          };
          const networkProducts = new Map<string,number>();
          for (const line of items.filter(line => /eip|cdt|cbwp|vpc|公网|数据传输/i.test(
            ['ProductCode','ProductName','ProductDetail','ProductType','PipCode','CommodityCode','BillingItemCode','BillingItem'].map(key => readString(line,key)).join(' ')))) {
            const id = readString(line,'InstanceID');
            const group = JSON.stringify({ ...Object.fromEntries(['ProductCode','ProductType','PipCode','CommodityCode','BillingItemCode'].map(key => [key,safeCode(line[key])])),
              instanceIdShape:isIPv4(id)?'ipv4':/^eip-/.test(id)?'eip':/^i-/.test(id)?'ecs':/^(cn|ap|eu|us|na|me|af|sa)-/.test(id)?'region':id?'other':'empty' });
            networkProducts.set(group,(networkProducts.get(group) ?? 0)+1);
          }
          this.logger.log(JSON.stringify({event:'billing_sync_eip_receipts',cloudWorkspaceId,billingDate,
            sourceLineCount:items.length,products:productCounts(items),networkProducts:[...networkProducts].map(([group,count]) => ({...JSON.parse(group),count})),resources:eipLedgers.map(ledger => ({
              resourceId:ledger.cloudResourceId,
              exactProducts:productCounts(items.filter(line => readString(line,'InstanceID') === ledger.cloudResourceId)),
              relatedLineCount:items.filter(line => readString(line,'InstanceID').includes(ledger.cloudResourceId)).length,
              matchedFields:['InstanceID','SplitItemID','ResourceId','ItemName','NickName','InstanceName','InstanceConfig','InternetIP','Tag']
                .filter(key => items.some(line => readString(line,key).includes(ledger.cloudResourceId))),
            }))}));
        }
        const previous: BillingLineItemRecord[] = currentBillingRows(await this.adminRepository.listBillingLineItems({ cloudProvider: 'alibaba_cloud', cloudAccountUid, startAt: billingDate, endAt: billingDate }), this.platformBillingStartedAt)
          .filter(line => Boolean(this.previousVerifiedLedger(line, proof, billingDate, cloudAccountUid)));
        const resolved = await this.resolveSplitItems(items, billingDate, cloudAccountUid, cloudConfig, proof, previous);
        const dayItems = new Map<string, CreateBillingLineItemInput>();
        const dayAnomalies = new Map<string, CreateBillingAnomalyInput>();

        for (const line of resolved.items) {
          const classification = classifyPlatformBillLine(line);
          const snapshotScope = readAliyunSnapshotEcsScope(line, proof, billingDate, cloudAccountUid);
          if (snapshotScope && !resolved.retainedProducts.has('snapshot')) {
            const source = (proof.snapshotParentProof ?? proof).ledgers.find(ledger => ledger.id === snapshotScope.sourceLedgerId)!;
            const matched = this.buildMatchedBillLine({ cloudAccountUid, syncBatchId, billingDate, line, ledger: source,
              cloudResourceId: source.cloudResourceId, cloudResourceType: 'ecs' });
            dayItems.set(matched.sourceFingerprint, matched);
            continue;
          }
          // A deferred product is one coherent previous revision, never a mixture of old splits and new direct charges.
          if (resolved.retainedProducts.has(readString(line, 'ProductCode')) && classification.kind === 'direct') continue;

          if (classification.kind === 'direct' && !billRegionConflict(line)) {
            const matchedLedger = classification.cloudResourceType === 'oss_bucket' && ['Refund', 'Adjustment'].includes(readString(line, 'Item')) ? null :
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
            currency: readCurrency(line),
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
            const ledger = this.previousVerifiedLedger(line, proof, billingDate, cloudAccountUid);
            if (resolved.retainedProducts.has(line.productCode)
              && ledger?.cloudAccountUid === cloudAccountUid && ledger.cloudResourceId === line.cloudResourceId && ledger.cloudResourceType === line.cloudResourceType) {
              const fingerprint=line.syncBatchId===syncBatchId?line.sourceFingerprint:this.buildSourceFingerprint(syncBatchId,line.rawPayload);
              dayItems.set(fingerprint, { ...line,syncBatchId,sourceFingerprint:fingerprint, billingDate, cloudAccountUid, ...billingExpenseScope(ledger, line.productCode),
                rawPayload: { ...line.rawPayload, __platformCloudProvider: 'alibaba_cloud', __platformBillingSyncDeferred: true } });
            }
          }
        }
        await this.adminRepository.replaceBillingDay({ cloudProvider: 'alibaba_cloud', cloudAccountUid, billingDate, ...(this.platformBillingStartedAt ? { replacementSyncBatchId: syncBatchId } : {}), lineItems: [...dayItems.values()], anomalies: [...dayAnomalies.values()] });
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

  private async loadCurrentProof() {
    return currentPlatformBillingProof(await loadPlatformBillingProof(this.adminRepository), this.platformBillingStartedAt);
  }

  async prepareScopedRows(input: { billingDate: string; context: SystemCloudAccountContext; items: RawBillLine[]; splitInstanceId?: string;
    splitProducts?: SplitBillingProduct[];
    getArchive?:(sourceId:string)=>Promise<AliyunSnapshotHistory|null> }) : Promise<ScopedBillingResult> {
    const { billingDate, context } = input, uid = context.accountUid;
    if (!uid || !context.accountUidResolved || context.provider !== 'alibaba_cloud') throw new Error('Unverified scoped billing account');
    const proof = await this.loadCurrentProof();
    const previous = currentBillingRows(await this.adminRepository.listBillingLineItems({ cloudProvider: 'alibaba_cloud', cloudAccountUid: uid,
      startAt: billingDate, endAt: billingDate }), this.platformBillingStartedAt).filter(row => this.previousVerifiedLedger(row, proof, billingDate, uid)
        && input.items.some(item => readString(item,'ProductCode') === row.productCode && readString(item,'InstanceID') === readString(row.rawPayload,'InstanceID')));
    const issues: string[] = [];
    const snapshotHistories:Record<string,AliyunSnapshotHistory>={};
    const parents=[...new Set(input.items.map(line=>readString(line,'InstanceID')))];
    if(parents.length>1&&!input.splitInstanceId)throw new Error('Scoped query returned ambiguous parent groups');
    const resolved = await this.resolveSplitItems(input.items, billingDate, uid, context, proof, previous,
      { instanceId: input.splitInstanceId??parents[0], splitProducts: input.splitProducts, diagnostic: code => issues.push(code),getArchive:input.getArchive,snapshotHistories });
    if (resolved.retainedProducts.size || issues.length) return { groups: [], coveredLedgerIds: [], rowCount: input.items.length,
      issue: { code: issues[0] ?? 'ALLOCATION_PENDING', message: BILLING_REASONS[issues[0] ?? 'ALLOCATION_PENDING'] ?? '资源级分账未完整核实，保留上次已核验金额。' } };
    const groups = new Map<string, ScopedBillingResult['groups'][number]>();
    const covered = new Set<string>();
    const coveredCategories: Record<string,string[]> = {};
    for (const line of resolved.items) {
      if (!isAlibabaBillingPayload(line) || line.OwnerID !== undefined && String(line.OwnerID) !== uid
        || line.BillingDate !== undefined && readString(line, 'BillingDate') !== billingDate) throw new Error('Scoped bill identity or date mismatch');
      const product = readString(line,'ProductCode'), parent = readString(line,'InstanceID');
      if (!product || !parent) throw new Error('Scoped bill has no financial group identity');
      const key = financialGroupKey('alibaba_cloud',uid,billingDate,product,parent);
      const group = groups.get(key) ?? { groupKey: key, productCode: product, instanceId: parent, items: [], anomalies: [] };
      const classification = classifyPlatformBillLine(line);
      const snapshotScope = readAliyunSnapshotEcsScope(line, proof, billingDate, uid);
      const source = snapshotScope ? (proof.snapshotParentProof ?? proof).ledgers.find(row => row.id === snapshotScope.sourceLedgerId) : null;
      const ledger = source ?? (classification.kind === 'direct' && !billRegionConflict(line)
        ? this.findActiveLedgerResource(proof,classification.cloudResourceId,classification.cloudResourceType,billingDate,uid,billRegionId(line)) : null);
      if (ledger) {
        const matched = this.buildMatchedBillLine({ cloudAccountUid:uid, syncBatchId:'billing-resource:'+key, billingDate, line,ledger,
          cloudResourceId:ledger.cloudResourceId,cloudResourceType:ledger.cloudResourceType });
        matched.sourceFingerprint = 'billing-resource:' + key + ':' + billingKey(stableJson(Object.fromEntries(Object.entries(line).filter(([name])=>!name.startsWith('__')))));
        group.items.push(matched);
        matched.syncBatchId = currentBillingSyncBatchId(matched.syncBatchId,this.platformBillingStartedAt);
        if (ledger.cloudResourceType === 'eip') {
          const label = ['BillingItemCode','BillingItem','CommodityCode'].map(name=>readString(line,name)).join(' ');
          const family = ['cdt','cbwp'].includes(product) || /traffic|flow|bandwidth|流量|带宽/i.test(label) ? 'network_usage'
            : /instance|rent|retain|保有|配置|占用/i.test(label) ? 'eip_configuration' : null;
          if (family) coveredCategories[ledger.id] = [...new Set([...(coveredCategories[ledger.id]??[]),family])];
        }
        if (snapshotScope) for (const id of snapshotScope.snapshotLedgerIds) covered.add(id);
        else covered.add(ledger.id);
      } else {
        const evidence = pendingPlatformBillingEvidence({line,cloudAccountUid:uid,billingDate,proof});
        if (evidence) return {groups:[],coveredLedgerIds:[],rowCount:input.items.length,
          issue:{code:evidence.kind==='source_pending'?'SOURCE_UNVERIFIED':'ALLOCATION_PENDING',message:'官方收费组尚不能完整归属，保留上次已核验金额。'}};
      }
      groups.set(key,group);
    }
    return {groups:[...groups.values()],coveredLedgerIds:[...covered],verifiedLedgerIds:[...new Set([...proof.createdLedgerIds,...(proof.snapshotParentProof?.createdLedgerIds??[])])],
      coveredCategories,rowCount:input.items.length,evidence:{snapshotHistories}};
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
        const syncBatchId = currentBillingSyncBatchId(`billing-sync:tencent_cloud:${getCurrentCloudWorkspaceId() ?? 'legacy-unbound'}:${accountUid}:${day}`, this.platformBillingStartedAt);
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
            const amount = new BillingDecimal(cost);
            if (!isSupportedBillingAmount(amount)) throw new Error('Tencent billing amount exceeds ledger precision; prior bills were retained');
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
              ...billingExpenseScope(ledger), matchedLedgerId: ledger.id });
            else anomalies.push({ ...base, reason: '已知平台创建资源的腾讯云账单产品、地域或来源尚待核实；未将该金额计入平台费用。' });
          }
        }
        await this.adminRepository.replaceBillingDay({ cloudProvider: 'tencent_cloud', cloudAccountUid: accountUid, billingDate: day, ...(this.platformBillingStartedAt ? { replacementSyncBatchId: syncBatchId } : {}), lineItems, anomalies });
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
      currency: readCurrency(input.line),
      ...billingExpenseScope(input.ledger, readString(input.line, 'ProductCode')),
      matchedLedgerId: input.ledger.id,
      rawPayload: { ...input.line, __platformCloudProvider: 'alibaba_cloud', ...(!ledgerBillingDateMatches(input.ledger, input.billingDate)
        ? { __platformPostReleaseCharge: true } : {}) },
    };
  }

  private previousVerifiedLedger(line: BillingLineItemRecord, proof: PlatformBillingProof, billingDate: string, cloudAccountUid: string) {
    const sourceFee = line.productCode === 'snapshot' && line.cloudResourceType === 'ecs'
      ? readAliyunSnapshotEcsScope(line.rawPayload, proof, billingDate, cloudAccountUid) : null;
    if (line.productCode === 'snapshot' && line.cloudResourceType === 'ecs' && !sourceFee) return undefined;
    const sourceProof = sourceFee ? proof.snapshotParentProof ?? proof : proof;
    return sourceProof.ledgers.find(ledger => ledger.id === line.matchedLedgerId && isPlatformCreatedLedger(ledger, sourceProof)
      && (!sourceFee || sourceFee.sourceLedgerId === ledger.id) && ledger.cloudProvider === 'alibaba_cloud' && isAlibabaBillingPayload(line.rawPayload)
      && ledger.cloudAccountUid === cloudAccountUid && ledger.cloudResourceId === line.cloudResourceId && ledger.cloudResourceType === line.cloudResourceType);
  }

  private async resolveSplitItems(items: RawBillLine[], billingDate: string, cloudAccountUid: string,
    context: Awaited<ReturnType<SystemConfigService['getExecutionAccountContext']>>, proof: PlatformBillingProof, previous: BillingLineItemRecord[],
    scope?: { instanceId?: string; splitProducts?: SplitBillingProduct[]; diagnostic: (code: string) => void;getArchive?:(sourceId:string)=>Promise<AliyunSnapshotHistory|null>;
      snapshotHistories?:Record<string,AliyunSnapshotHistory> }) {
    let resolved = items;
    const retainedProducts = new Set<string>();
    for (const productCode of [...new Set<SplitBillingProduct>(['snapshot', 'oss', 'cbwp', ...(scope?.splitProducts ?? [])])]) {
      const original = items.filter(line => readString(line, 'ProductCode') === productCode);
      const previousProduct = previous.filter(line => line.productCode === productCode);
      if (!original.length && previousProduct.length) {
        retainedProducts.add(productCode);
        continue;
      }
      if (!scope?.splitProducts?.includes(productCode) && !original.some(line => classifyPlatformBillLine(line).kind === 'aggregated'
        && pendingPlatformBillingEvidence({ line, cloudAccountUid, billingDate, proof }))
        && !previousProduct.some(line => line.rawPayload.__platformBillingSource === 'DescribeSplitItemBill')) continue;
      try {
        const split = await this.billingBssClient.listDailySplitBillingItems({ billingDate, productCode, ...(scope?.instanceId ? {instanceId:scope.instanceId}: {}) }, context);
        // Mixed direct and aggregate source bills require an exact group join; keep their evidence until one is available.
        const networkSplit = ['eip','cdt','cbwp'].includes(productCode) && scope?.splitProducts?.includes(productCode);
        if (!networkSplit && original.some(line => classifyPlatformBillLine(line).kind !== 'aggregated') || !this.splitTotalsMatch(original, split)) {
          throw new Error('Resource split bills do not reconcile with their source bill');
        }
        const scopedSplit: RawBillLine[] = [];
        const histories = new Map<string, Awaited<ReturnType<typeof collectAliyunSnapshotHistory>>>();
        const verifiedBuckets = new Set<string>();
        for (const raw of split) {
          const line = { ...raw, __platformBillingSource: 'DescribeSplitItemBill' };
          if (productCode === 'oss') {
            const classification = classifyPlatformBillLine(line);
            const bucket = proof.ledgers.find(ledger => isPlatformCreatedLedger(ledger, proof) && ledger.cloudProvider === 'alibaba_cloud'
              && ledger.cloudAccountUid === cloudAccountUid
              && ledger.cloudResourceType === 'oss_bucket' && ledger.cloudResourceId === classification.cloudResourceId);
            const binding = bucket && readAliyunOssDedicatedBilling(bucket);
            if (bucket && binding && aliyunOssBindingCoversBillingDay(binding, billingDate)) {
              if (billRegionConflict(line) || !billRegionId(line) || bucket.regionId !== billRegionId(line)) {
                throw new Error('Dedicated OSS split region is unverified; prior bills were retained');
              }
              if (!verifiedBuckets.has(bucket.id)) {
                const verification = await refreshAliyunOssBindingVerification(bucket, context);
                if (!verification.verified) throw new Error('Dedicated OSS bucket identity is unverified; prior bills were retained');
                verifiedBuckets.add(bucket.id);
              }
            }
          }
          if (productCode === 'snapshot' && /^i-[a-z0-9]+$/i.test(readString(line, 'SplitItemID'))) {
            const parent = proof.snapshotParentProof ?? proof;
            const source = parent.ledgers.find(ledger => isPlatformCreatedLedger(ledger, parent) && ledger.cloudProvider === 'alibaba_cloud'
              && ledger.cloudAccountUid === cloudAccountUid && ledger.regionId === billRegionId(line)
              && ledger.cloudResourceType === 'ecs' && ledger.cloudResourceId === readString(line, 'SplitItemID'));
            const start = source && aliyunSnapshotHistoryStartAt(source, proof);
            const sourceArtifacts = source ? parent.packedImages.filter(artifact => artifact.sourceInstanceId === source.cloudResourceId && artifact.cloudAccountUid === cloudAccountUid
                && artifact.regionId === source.regionId && (artifact.cloudWorkspaceId ?? 'legacy-unbound') === (source.cloudWorkspaceId ?? 'legacy-unbound')
                ) : [];
            const baselineReady = sourceArtifacts.some(artifact => aliyunPackSnapshotBaselineIssue(artifact, billingDate) === null);
            if (source && start && baselineReady) {
              if (!histories.has(source.id)) histories.set(source.id, await collectAliyunSnapshotHistory(context,
                { sourceLedger: source, sourceCreatedAt: start, billingDate },{archivedHistory:await scope?.getArchive?.(source.id)}));
              const history=histories.get(source.id);
              if(history&&scope?.snapshotHistories)scope.snapshotHistories[source.id]=history;
              if(!history)scope?.diagnostic('SNAPSHOT_HISTORY_UNAVAILABLE');
              const feeScope = verifyAliyunSnapshotEcsBillEvidence({ line, billingDate, cloudAccountUid, proof, history: histories.get(source.id) ?? null });
              if (feeScope) Object.assign(line, { __platformSnapshotEcsScope: feeScope });
            } else if(source)scope?.diagnostic(sourceArtifacts.length ? aliyunPackSnapshotBaselineIssue(sourceArtifacts[0], billingDate) ?? 'SNAPSHOT_HISTORY_UNAVAILABLE' : 'SNAPSHOT_BASELINE_MISSING');
          }
          scopedSplit.push(line);
        }
        if (previousProduct.some(previousLine => previousLine.rawPayload.__platformSnapshotEcsScope
          && !scopedSplit.some(line => readString(line, 'SplitItemID') === previousLine.cloudResourceId
            && readAliyunSnapshotEcsScope(line, proof, billingDate, cloudAccountUid)))) {
          throw new Error('Source ECS snapshot evidence is incomplete; previous verified revision was retained');
        }
        if (productCode === 'oss' && previousProduct.length && scopedSplit.some(line => ['Refund', 'Adjustment'].includes(readString(line, 'Item'))
          && proof.ledgers.some(ledger => readAliyunOssDedicatedBilling(ledger) && ledger.cloudAccountUid === cloudAccountUid
            && ledger.cloudResourceId === readString(line, 'SplitItemID')))) {
          throw new Error('OSS correction usage interval is unknown; prior verified revision was retained');
        }
        resolved = [...resolved.filter(line => readString(line, 'ProductCode') !== productCode), ...scopedSplit];
      } catch (error) {
        scope?.diagnostic(error instanceof Error && error.name === 'BillingSplitBillUnavailableError' ? 'SPLIT_UNAVAILABLE' : 'ALLOCATION_PENDING');
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
        totals.set(key, (totals.get(key) ?? new BillingDecimal(0)).plus(readNumber(line, 'PretaxAmount')));
      }
      return totals;
    };
    const sourceTotals = group(original);
    const splitTotals = group(split);
    return Boolean(sourceTotals && splitTotals && sourceTotals.size === splitTotals.size
      && [...sourceTotals].every(([key, value]) => splitTotals.has(key) && value.equals(splitTotals.get(key)!)));
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
      && item.cloudResourceType === cloudResourceType && (!regionId || item.regionId === regionId)
      && (item.cloudResourceType !== 'oss_bucket' || Boolean(regionId && readAliyunOssDedicatedBilling(item)
        && aliyunOssBindingCoversBillingDay(readAliyunOssDedicatedBilling(item)!, billingDate))));
    // Without an explicit region a colliding physical ID is ambiguous, not permission to take the first row.
    if (matches.length !== 1) return null;
    return billingDate >= billingDayText(matches[0].billingStartAt) ? matches[0] : null;
  }
}
