import { Prisma } from '@aliyun-cyber-range/database/generated/client';

import { Inject, Injectable } from '@nestjs/common';
import { BillingDecimal } from './billing-amount';

import {
  ADMIN_REPOSITORY,
  AdminRepository,
  type BillingAnomalyRecord,
  type BillingLedgerResourceRecord,
  type BillingLineItemRecord,
  type ProvisionJobRecord,
  type ProvisionJobStatus,
} from './admin.repository';
import { billingDayText, resolveBillingWindow } from './billing-window';
import { getCurrentCloudWorkspaceScope } from '../auth/cloud-workspace-scope';
import { billRegionConflict, billRegionId, isAlibabaBillingPayload, isPlatformCreatedLedger, loadPlatformBillingProof, pendingPlatformBillingEvidence, type PlatformBillingProof, isTencentBillingPayload, tencentBillRegionId, classifyTencentBillLine, pendingTencentBillingEvidence, tencentCosBillLifetimeMatches } from './billing-platform-scope';

type BillingWindowInput = Partial<{
  startAt: string | Date;
  endAt: string | Date;
  page: number;
  pageSize: number;
}>;

type BillingGroupInput = BillingWindowInput & {
  userId?: string;
};

type BillingLaunchGroup = {
  id: string;
  kind: 'range_launch' | 'single_launch' | 'unmatched';
  title: '开启单实例' | '开启编排实例' | '未关联平台启动的费用';
  provisionJobStatus: ProvisionJobStatus | null;
  sourceProvisionJobId: string | null;
  completedAt: string | null;
  billingPeriodStart: string;
  billingPeriodEnd: string;
  ownerUserId: string | null;
  ownerUsername: string | null;
  instance: { id: string; name: string; batchId: string | null } | null;
  resourceCount: number;
  pretaxAmount: number;
  currency: string;
  items: BillingLineItemRecord[];
};

type BillingLaunchGroupBuilder = Omit<BillingLaunchGroup, 'resourceCount'> & {
  resourceKeys: Set<string>;
};

type PaginatedResult<T> = {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
};

function toIsoDate(value: Date) {
  return value.toISOString().slice(0, 10);
}

function sumPretax(items: Array<{ pretaxAmount: number }>) {
  return items.reduce((total, item) => total.plus(item.pretaxAmount), new BillingDecimal(0)).toNumber();
}

function currencyAmounts(items: Array<{ currency: string; pretaxAmount: number }>) {
  const grouped = new Map<string, Array<{ pretaxAmount: number }>>();
  for (const item of items) {
    const lines = grouped.get(item.currency) ?? [];
    lines.push(item);
    grouped.set(item.currency, lines);
  }
  return [...grouped].sort(([a], [b]) => a.localeCompare(b)).map(([currency, lines]) => ({ currency, pretaxAmount: sumPretax(lines) }));
}

function moneySummary(items: Array<{ currency: string; pretaxAmount: number }>) {
  const amounts = currencyAmounts(items);
  return { currency: amounts.length > 1 ? null : amounts[0]?.currency ?? 'CNY', pretaxAmount: amounts.length > 1 ? null : amounts[0]?.pretaxAmount ?? 0, amounts };
}

function platformBillingItems(items: BillingLineItemRecord[], proof: PlatformBillingProof) {
  const ledgers = new Map(proof.ledgers.map(ledger => [ledger.id, ledger]));
  return items.flatMap(item => {
    const ledger = item.matchedLedgerId ? ledgers.get(item.matchedLedgerId) : null;
    if (!ledger || !isPlatformCreatedLedger(ledger, proof)
      || (item.cloudWorkspaceId ?? 'legacy-unbound') !== (ledger.cloudWorkspaceId ?? 'legacy-unbound')
      || (item.cloudProvider ?? 'alibaba_cloud') !== ledger.cloudProvider
      || (ledger.cloudProvider === 'alibaba_cloud' ? !isAlibabaBillingPayload(item.rawPayload) : !verifiedTencentItem(item, ledger))
      || item.cloudResourceId !== ledger.cloudResourceId || item.cloudResourceType !== ledger.cloudResourceType
      || item.cloudAccountUid && item.cloudAccountUid !== ledger.cloudAccountUid
      || item.rawPayload.OwnerID != null && String(item.rawPayload.OwnerID) !== ledger.cloudAccountUid
      || ledger.cloudProvider === 'alibaba_cloud' && (billRegionConflict(item.rawPayload) || billRegionId(item.rawPayload) && billRegionId(item.rawPayload) !== ledger.regionId)
      || toIsoDate(item.billingDate) < billingDayText(ledger.billingStartAt)) return [];
    // Historical catalog collection could overwrite attribution; use the verified creation ledger.
    return [{ ...item, cloudAccountUid: ledger.cloudAccountUid, billingScope: ledger.billingScope, ownerUserId: ledger.ownerUserId }];
  });
}

function verifiedTencentItem(item: BillingLineItemRecord, ledger: BillingLedgerResourceRecord) {
  const raw = item.rawPayload;
  const index = raw.__platformBillingComponentIndex;
  const component = Array.isArray(raw.ComponentSet) && Number.isSafeInteger(index) ? raw.ComponentSet[index as number] as Record<string, unknown> | undefined : null;
  const classification = classifyTencentBillLine(raw);
  return isTencentBillingPayload(raw) && raw.OwnerUin === ledger.cloudAccountUid && raw.PayerUin === ledger.cloudAccountUid
    && raw.ResourceId === ledger.cloudResourceId && tencentBillRegionId(raw) === ledger.regionId
    && raw.BillDay === `${toIsoDate(item.billingDate)} 00:00:00` && raw.BillMonth === `${item.billCycle}-01 00:00:00`
    && classification.kind === 'direct' && classification.cloudResourceType === ledger.cloudResourceType && tencentCosBillLifetimeMatches(ledger, raw, toIsoDate(item.billingDate))
    && typeof component?.RealCost === 'string' && /^-?\d+(?:\.\d+)?$/.test(component.RealCost)
    && new Prisma.Decimal(component.RealCost).equals(item.pretaxAmount) && item.currency === 'CNY';
}

function pendingEvidence(item: BillingAnomalyRecord | BillingLineItemRecord, proof: PlatformBillingProof) {
  if (!item.cloudAccountUid) return null;
  if (item.cloudProvider === 'tencent_cloud') return pendingTencentBillingEvidence({ cloudAccountUid: item.cloudAccountUid, billingDate: toIsoDate(item.billingDate), proof, line: item.rawPayload });
  return pendingPlatformBillingEvidence({ cloudAccountUid: item.cloudAccountUid, billingDate: toIsoDate(item.billingDate), proof,
    line: { ...item.rawPayload,
      InstanceID: item.rawPayload.InstanceID ?? item.cloudResourceId,
      ProductCode: item.rawPayload.ProductCode ?? (item.cloudResourceType === 'snapshot_region' ? 'snapshot' : item.cloudResourceType === 'oss_bucket' ? 'oss' : item.cloudResourceType),
    } });
}

function isLaunchProvisionJob(job: ProvisionJobRecord | null | undefined): job is ProvisionJobRecord {
  return job?.jobType === 'create' || job?.jobType === 'retry';
}

function paginate<T>(items: T[], input: BillingWindowInput): PaginatedResult<T> {
  const pageSize = input.pageSize === 50 || input.pageSize === 100 ? input.pageSize : 20;
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const requestedPage = Number.isFinite(input.page) ? Math.trunc(input.page!) : 1;
  const page = Math.min(Math.max(requestedPage, 1), totalPages);
  const startIndex = (page - 1) * pageSize;

  return {
    items: items.slice(startIndex, startIndex + pageSize),
    page,
    pageSize,
    total: items.length,
  };
}

function escapeCsvCell(value: string | number | null | undefined) {
  const text = value == null ? '' : String(value);
  // Prefix only string metadata; real numeric charges and refunds remain numbers.
  const safeText = typeof value === 'string' && /^[\s\u0000-\u001f]*[=+@-]/.test(text) ? `'${text}` : text;
  const escaped = safeText.replaceAll('"', '""');
  return /[",\r\n]/.test(escaped) ? `"${escaped}"` : escaped;
}

function toCsv(rows: Array<Array<string | number | null | undefined>>) {
  return `${rows.map((row) => row.map(escapeCsvCell).join(',')).join('\n')}\n`;
}

@Injectable()
export class BillingService {
  constructor(@Inject(ADMIN_REPOSITORY) private readonly adminRepository: AdminRepository) {}

  private async readPlatformItems(input: BillingWindowInput) {
    const window = resolveBillingWindow(input);
    const [items, proof] = await Promise.all([
      this.adminRepository.listBillingLineItems({ startAt: window.startAt, endAt: window.endAt }),
      loadPlatformBillingProof(this.adminRepository),
    ]);
    return platformBillingItems(items, this.readableProof(proof));
  }

  async getSummary(input: BillingWindowInput) {
    const window = resolveBillingWindow(input);
    const [lineItems, anomalies, fullProof] = await Promise.all([
      this.adminRepository.listBillingLineItems({
        startAt: window.startAt,
        endAt: window.endAt,
      }),
      this.adminRepository.listBillingAnomalies({
        startAt: window.startAt,
        endAt: window.endAt,
      }),
      loadPlatformBillingProof(this.adminRepository),
    ]);
    const proof = this.readableProof(fullProof);

    const trackedLineItems = platformBillingItems(lineItems, proof);
    const ledgerResources = proof.ledgers.filter(ledger => isPlatformCreatedLedger(ledger, proof));
    const resourceTypeTotals = this.groupByResourceType(trackedLineItems);
    const dailyTotals = this.groupByBillingDate(trackedLineItems);
    const money = moneySummary(trackedLineItems);
    const trackedFingerprints = new Set(trackedLineItems.map(item => item.sourceFingerprint));
    const pending = [...new Map([...lineItems, ...anomalies].filter(item => !trackedFingerprints.has(item.sourceFingerprint))
      .map(item => [item.sourceFingerprint, item])).values()].map(item => ({ item, evidence: pendingEvidence(item, proof) }));
    const unallocatedItems = pending.filter(row => row.evidence?.kind === 'resource_pending').map(row => row.item);
    const pendingResources = new Map<'snapshot' | 'oss' | 'unknown', Set<string>>();
    const deferredProducts = new Set<string>();
    for (const item of trackedLineItems) {
      if (item.rawPayload.__platformBillingSyncDeferred !== true || !['snapshot', 'oss'].includes(item.productCode)) continue;
      const type = item.productCode as 'snapshot' | 'oss';
      deferredProducts.add(type);
      const ids = pendingResources.get(type) ?? new Set<string>();
      ids.add(`ledger:${item.matchedLedgerId}`);
      pendingResources.set(type, ids);
    }
    for (const { item, evidence } of pending) {
      if (!evidence || evidence.kind === 'resource_pending') continue;
      const type = evidence.kind === 'source_pending' ? 'unknown'
        : item.rawPayload.ProductCode === 'snapshot' || item.cloudResourceType === 'snapshot_region' ? 'snapshot' : 'oss';
      const ids = pendingResources.get(type) ?? new Set<string>();
      for (const id of evidence.ledgerIds) ids.add(`ledger:${id}`);
      for (const id of evidence.imageImportJobIds) ids.add(`import:${id}`);
      pendingResources.set(type, ids);
    }
    const referencedLedgerIds = new Set(lineItems.flatMap(item => item.matchedLedgerId ? [item.matchedLedgerId] : []));
    const unverified = proof.ledgers.filter(ledger => proof.unverifiedSourceLedgerIds.has(ledger.id)
      && (referencedLedgerIds.has(ledger.id) || billingDayText(ledger.billingStartAt) <= window.endAtText
        && (!ledger.releasedAt || billingDayText(ledger.releasedAt) >= window.startAtText)));
    if (unverified.length) {
      const ids = pendingResources.get('unknown') ?? new Set<string>();
      for (const ledger of unverified) ids.add(`ledger:${ledger.id}`);
      pendingResources.set('unknown', ids);
    }
    // Old image jobs may predate snapshot inventory; missing IDs must remain visible without inventing a charge.
    for (const source of [...proof.imageImports, ...proof.packedImages]) {
      if (!source.imageId || billingDayText(source.createdAt) > window.endAtText
        || ('snapshotCleanupCompletedAt' in source && source.snapshotCleanupCompletedAt
          && billingDayText(source.snapshotCleanupCompletedAt) < window.startAtText)) continue;
      const missingInventory = !source.backingSnapshotIds.length || source.backingSnapshotIds.some(id => !ledgerResources.some(ledger =>
        ledger.cloudResourceType === 'snapshot' && ledger.cloudResourceId === id
        && ledger.cloudAccountUid === source.cloudAccountUid && ledger.regionId === source.regionId));
      if (!missingInventory) continue;
      const type = source.cloudAccountUid && source.regionId ? 'snapshot' : 'unknown';
      const ids = pendingResources.get(type) ?? new Set<string>();
      ids.add(`image-source:${source.id}`);
      pendingResources.set(type, ids);
    }
    const reasons = {
      snapshot: '平台镜像或快照仍需补齐资源清单及费用明细；源 ECS 汇总可能包含其它快照，未将整组金额计入平台。',
      oss: '平台导入对象仍需可核验的费用明细；配置或使用 Bucket 不代表整桶由平台独占，未将整桶金额计入平台。',
      unknown: '已找到平台创建记录，但历史云账号或归属证明尚未核实；记录继续保留，不按零费用处理。',
    };
    const reconciliationIssues = await Promise.all([...pendingResources].map(async ([resourceType, ids]) => ({ resourceType, resourceCount: ids.size,
      reason: deferredProducts.has(resourceType)
        ? `本次分账未核实，暂保留上次已核验金额，等待完整账单后更新。${reasons[resourceType]}` : reasons[resourceType],
      resources: await this.reconciliationResourceDetails(ids, proof, deferredProducts.has(resourceType)),
    })));
    const billedResourceIds = new Set(trackedLineItems.map(item => item.matchedLedgerId));
    const resourcesWithoutBillCount = ledgerResources.filter(item => !['snat_entry', 'dnat_entry', 'unknown', 'snapshot_region'].includes(item.cloudResourceType)
      && billingDayText(item.billingStartAt) <= window.endAtText
      && (!item.releasedAt || billingDayText(item.releasedAt) >= window.startAtText)
      && !billedResourceIds.has(item.id)).length;

    return {
      startAt: window.startAtText,
      endAt: window.endAtText,
      billingScope: 'platform_resources' as const,
      currency: money.currency,
      totalPretaxAmount: money.pretaxAmount,
      platformPretaxAmount: money.currency ? sumPretax(trackedLineItems.filter(item => item.billingScope === 'platform')) : null,
      currencyTotals: money.amounts.map(amount => ({ currency: amount.currency, totalPretaxAmount: amount.pretaxAmount, platformPretaxAmount: sumPretax(trackedLineItems.filter(item => item.currency === amount.currency && item.billingScope === 'platform')) })),
      anomalyCount: unallocatedItems.length,
      billingStatus: 'provisional' as const,
      unallocatedCurrencyTotals: currencyAmounts(unallocatedItems),
      resourcesWithoutBillCount,
      reconciliationIssues,
      resourceTypeTotals,
      dailyTotals,
    };
  }

  async listUsers(input: BillingWindowInput) {
    return paginate(await this.listUserSummaries(input), input);
  }

  private readableProof(proof: PlatformBillingProof): PlatformBillingProof {
    const scope = getCurrentCloudWorkspaceScope();
    if (!scope && process.env.NODE_ENV === 'test') return proof;
    const visible = (record: { cloudWorkspaceId?: string; ownerUserId?: string | null }) => scope && !('system' in scope)
      && record.cloudWorkspaceId === scope.cloudWorkspaceId && (scope.isPlatformManager === true || Boolean(scope.actorUserId) && record.ownerUserId === scope.actorUserId);
    const ledgers = proof.ledgers.filter(visible), ids = new Set(ledgers.map(row => row.id));
    return { ...proof, ledgers, imageImports: proof.imageImports.filter(visible), packedImages: proof.packedImages.filter(visible),
      cosBuckets: scope && !('system' in scope) && scope.isPlatformManager === true ? proof.cosBuckets.filter(row => row.cloudWorkspaceId === scope.cloudWorkspaceId) : [],
      createdLedgerIds: new Set([...proof.createdLedgerIds].filter(id => ids.has(id))),
      unverifiedSourceLedgerIds: new Set([...proof.unverifiedSourceLedgerIds].filter(id => ids.has(id))) };
  }

  private async reconciliationResourceDetails(keys: Set<string>, proof: PlatformBillingProof, deferred: boolean) {
    const scope = getCurrentCloudWorkspaceScope();
    const inWorkspace = (record: { cloudWorkspaceId?: string }) => scope && !('system' in scope)
      ? record.cloudWorkspaceId === scope.cloudWorkspaceId : false;
    const jobs = new Map<string, Promise<ProvisionJobRecord | null>>();
    const logs = new Map<string, ReturnType<AdminRepository['listProvisionJobStepLogs']>>();
    return (await Promise.all([...keys].sort().map(async resourceKey => {
      const ledger = proof.ledgers.find(row => resourceKey === `ledger:${row.id}` && inWorkspace(row));
      if (ledger) {
        let proofFailureReason = deferred ? 'BILL_SYNC_DEFERRED' : 'BILL_DETAILS_PENDING';
        if (!proof.createdLedgerIds.has(ledger.id)) {
          const storageSource = ['image', 'snapshot', 'oss_bucket'].includes(ledger.cloudResourceType);
          proofFailureReason = !ledger.cloudAccountUid ? 'ACCOUNT_UID_MISSING' : storageSource ? 'IMAGE_OR_STORAGE_SOURCE_PROOF_INCOMPLETE' : !ledger.rangeInstanceId ? 'SOURCE_RANGE_MISSING'
            : !ledger.sourceProvisionJobId ? 'SOURCE_JOB_MISSING' : 'SOURCE_PROOF_UNVERIFIED';
          if (!storageSource && ledger.sourceProvisionJobId && ledger.cloudAccountUid && ledger.rangeInstanceId) {
            const id = ledger.sourceProvisionJobId;
            if (!jobs.has(id)) jobs.set(id, this.adminRepository.getProvisionJobById(id));
            const job = await jobs.get(id)!;
            if (!job) proofFailureReason = 'SOURCE_JOB_NOT_FOUND';
            else if (!inWorkspace(job)) proofFailureReason = 'SOURCE_JOB_WORKSPACE_MISMATCH';
            else if (job.rangeInstanceId !== ledger.rangeInstanceId) proofFailureReason = 'SOURCE_JOB_RANGE_MISMATCH';
            else if (!['create', 'retry', 'update'].includes(job.jobType)) proofFailureReason = 'SOURCE_JOB_NOT_CREATION';
            else if (ledger.cloudProvider === 'tencent_cloud') {
              if (!logs.has(id)) logs.set(id, this.adminRepository.listProvisionJobStepLogs(id));
              const inventories = (await logs.get(id)!).filter(log => log.jobId === id && inWorkspace(log)
                && log.status === 'succeeded' && log.stepName === 'platform_billing_creation_inventory').flatMap(log => {
                try { const value = JSON.parse(log.message ?? 'null'); return value && typeof value === 'object' && !Array.isArray(value) ? [value] : []; } catch { return []; }
              });
              proofFailureReason = !inventories.length ? 'SOURCE_JOB_CREATION_INVENTORY_MISSING'
                : inventories.some(inventory => Array.isArray(inventory.resources) && inventory.resources.some((resource: Record<string, unknown>) =>
                  resource?.cloudResourceId === ledger.cloudResourceId && resource.cloudResourceType === ledger.cloudResourceType))
                  ? 'SOURCE_CREATION_PROOF_CONFLICT' : 'SOURCE_RESOURCE_NOT_IN_CREATION_INVENTORY';
            }
          }
        }
        return { resourceKey, ledgerId: ledger.id, cloudWorkspaceId: ledger.cloudWorkspaceId ?? null, cloudProvider: ledger.cloudProvider,
          cloudResourceId: ledger.cloudResourceId, cloudResourceType: ledger.cloudResourceType, rangeInstanceId: ledger.rangeInstanceId,
          sourceProvisionJobId: ledger.sourceProvisionJobId, ownerUserId: ledger.ownerUserId, cloudAccountUid: ledger.cloudAccountUid,
          regionId: ledger.regionId, billingStartAt: ledger.billingStartAt.toISOString(), releasedAt: ledger.releasedAt?.toISOString() ?? null, proofFailureReason };
      }
      const source = [...proof.imageImports, ...proof.packedImages].find(row => inWorkspace(row)
        && (resourceKey === `import:${row.id}` || resourceKey === `image-source:${row.id}`));
      if (!source) return null;
      return { resourceKey, ledgerId: null, cloudWorkspaceId: source.cloudWorkspaceId ?? null, cloudProvider: source.cloudProvider ?? 'alibaba_cloud',
        cloudResourceId: source.imageId, cloudResourceType: 'image', rangeInstanceId: 'sourceRangeInstanceId' in source ? source.sourceRangeInstanceId : null,
        sourceProvisionJobId: null, ownerUserId: source.ownerUserId ?? null, cloudAccountUid: source.cloudAccountUid, regionId: source.regionId,
        billingStartAt: source.createdAt.toISOString(), releasedAt: null, proofFailureReason: 'SOURCE_SNAPSHOT_INVENTORY_OR_BILL_PROOF_INCOMPLETE' };
    }))).filter(row => row !== null);
  }

  private async listUserSummaries(input: BillingWindowInput) {
    const window = resolveBillingWindow(input);
    const [platformUsers, fetchedLineItems] = await Promise.all([
      this.adminRepository.listPlatformUsers(),
      this.readPlatformItems(input),
    ]);
    const lineItems = fetchedLineItems.filter(item => item.billingScope === 'user');

    const groups = await this.groupBillingLineItems(lineItems);
    const launchJobsByUserId = new Map<string, Set<string>>();

    for (const group of groups) {
      if (group.provisionJobStatus === 'succeeded' && group.ownerUserId && group.sourceProvisionJobId) {
        const jobs = launchJobsByUserId.get(group.ownerUserId) ?? new Set<string>();
        jobs.add(group.sourceProvisionJobId);
        launchJobsByUserId.set(group.ownerUserId, jobs);
      }
    }

    const usersById = new Map(
      platformUsers.map((user) => [
        user.id,
        {
          userId: user.id,
          username: user.username,
          pretaxAmount: 0,
          itemCount: 0,
          launchCount: 0,
        },
      ]),
    );

    for (const item of lineItems) {
      if (!item.ownerUserId) {
        continue;
      }

      const user =
        usersById.get(item.ownerUserId) ??
        {
          userId: item.ownerUserId,
          username: item.ownerUserId,
          pretaxAmount: 0,
          itemCount: 0,
          launchCount: 0,
        };
      user.pretaxAmount += item.pretaxAmount;
      user.itemCount += 1;
      user.launchCount = launchJobsByUserId.get(item.ownerUserId)?.size ?? 0;
      usersById.set(item.ownerUserId, user);
    }

    return [...usersById.values()].map(user => ({ ...user, ...moneySummary(lineItems.filter(item => item.ownerUserId === user.userId)) }))
      .sort((left, right) => (left.currency ?? '').localeCompare(right.currency ?? '') || (right.pretaxAmount ?? 0) - (left.pretaxAmount ?? 0) || left.username.localeCompare(right.username));
  }

  async getUserSummary(userId: string, input: BillingWindowInput) {
    const window = resolveBillingWindow(input);
    const items = (await this.readPlatformItems(input)).filter(item => item.billingScope === 'user' && item.ownerUserId === userId);
    const user = await this.adminRepository.getPlatformUserById(userId);
    const launchCount = new Set((await this.groupBillingLineItems(items)).filter(group => group.kind !== 'unmatched' && group.provisionJobStatus === 'succeeded').map(group => group.sourceProvisionJobId)).size;

    return {
      userId,
      username: user?.username ?? userId,
      ...moneySummary(items),
      itemCount: items.length,
      launchCount,
    };
  }

  async listUserGroups(input: BillingGroupInput) {
    const window = resolveBillingWindow(input);
    const items = (await this.readPlatformItems(input)).filter(item => item.billingScope === 'user' && (!input.userId || item.ownerUserId === input.userId));

    const groups = await this.attachOwnerUsernames(await this.groupBillingLineItems(items));
    return paginate(groups, input);
  }

  async listPlatformGroups(input: BillingWindowInput) {
    const window = resolveBillingWindow(input);
    const items = (await this.readPlatformItems(input)).filter(item => item.billingScope === 'platform');

    const groups = await this.attachOwnerUsernames(await this.groupBillingLineItems(items));
    return paginate(groups, input);
  }

  async listUserItems(userId: string, input: BillingWindowInput) {
    const window = resolveBillingWindow(input);

    const items = (await this.readPlatformItems(input)).filter(item => item.billingScope === 'user' && item.ownerUserId === userId);

    return items
      .slice()
      .sort((left, right) => right.billingDate.getTime() - left.billingDate.getTime());
  }

  async listPlatformItems(input: BillingWindowInput) {
    const window = resolveBillingWindow(input);

    const items = (await this.readPlatformItems(input)).filter(item => item.billingScope === 'platform');

    return items
      .slice()
      .sort((left, right) => {
        const dateDelta = right.billingDate.getTime() - left.billingDate.getTime();
        return dateDelta !== 0 ? dateDelta : right.pretaxAmount - left.pretaxAmount;
      });
  }

  async listAnomalies(input: BillingWindowInput) {
    const window = resolveBillingWindow(input);

    const [anomalies, proof] = await Promise.all([
      this.adminRepository.listBillingAnomalies({ startAt: window.startAt, endAt: window.endAt }),
      loadPlatformBillingProof(this.adminRepository),
    ]);

    const readable = this.readableProof(proof);
    return anomalies
      .filter(item => pendingEvidence(item, readable)?.kind === 'resource_pending')
      .slice()
      .sort((left, right) => right.billingDate.getTime() - left.billingDate.getTime());
  }

  async exportPlatformCsv(input: BillingWindowInput) {
    const summary = await this.getSummary(input);

    return toCsv([
      ['startAt', summary.startAt],
      ['endAt', summary.endAt],
      ['billingScope', summary.billingScope],
      ['totalPretaxAmount', summary.totalPretaxAmount],
      ['platformPretaxAmount', summary.platformPretaxAmount],
      ['currency', summary.currency ?? 'MULTIPLE'],
      ['anomalyCount', summary.anomalyCount],
      ['billingStatus', summary.billingStatus],
      ['resourcesWithoutBillCount', summary.resourcesWithoutBillCount],
      [],
      ['unallocatedCurrency', 'unallocatedPretaxAmount'],
      ...summary.unallocatedCurrencyTotals.map(item => [item.currency, item.pretaxAmount]),
      [],
      ['reconciliationResourceType', 'resourceCount', 'reason'],
      ...summary.reconciliationIssues.map(item => [item.resourceType, item.resourceCount, item.reason]),
      [],
      ['currency', 'totalPretaxAmount', 'platformPretaxAmount'],
      ...summary.currencyTotals.map(item => [item.currency, item.totalPretaxAmount, item.platformPretaxAmount]),
      [],
      ['resourceType', 'currency', 'pretaxAmount'],
      ...summary.resourceTypeTotals.map((item) => [item.resourceType, item.currency, item.pretaxAmount]),
      [],
      ['billingDate', 'currency', 'pretaxAmount'],
      ...summary.dailyTotals.map((item) => [item.billingDate, item.currency, item.pretaxAmount]),
    ]);
  }

  async exportUsersCsv(input: BillingWindowInput) {
    const users = await this.listUserSummaries(input);

    return toCsv([
      ['userId', 'username', 'currency', 'pretaxAmount', 'itemCount'],
      ...users.flatMap(user => (user.amounts.length ? user.amounts : [{ currency: user.currency ?? 'CNY', pretaxAmount: 0 }]).map(amount => [user.userId, user.username, amount.currency, amount.pretaxAmount, user.itemCount])),
    ]);
  }

  async exportUserItemsCsv(userId: string, input: BillingWindowInput) {
    const items = await this.listUserItems(userId, input);

    return toCsv([
      ['billingDate', 'billCycle', 'productCode', 'billItem', 'cloudResourceType', 'cloudResourceId', 'pretaxAmount', 'currency'],
      ...items.map((item) => [
        toIsoDate(item.billingDate),
        item.billCycle,
        item.productCode,
        item.billItem,
        item.cloudResourceType,
        item.cloudResourceId,
        item.pretaxAmount,
        item.currency,
      ]),
    ]);
  }

  private groupByResourceType(lineItems: BillingLineItemRecord[]) {
    const types = [...new Set(lineItems.map(item => item.cloudResourceType))];
    return types.flatMap(resourceType => currencyAmounts(lineItems.filter(item => item.cloudResourceType === resourceType)).map(amount => ({ resourceType, ...amount })))
      .sort((a, b) => a.currency.localeCompare(b.currency) || b.pretaxAmount - a.pretaxAmount);
  }

  private groupByBillingDate(lineItems: BillingLineItemRecord[]) {
    const dates = [...new Set(lineItems.map(item => toIsoDate(item.billingDate)))].sort();
    return dates.flatMap(billingDate => currencyAmounts(lineItems.filter(item => toIsoDate(item.billingDate) === billingDate)).map(amount => ({ billingDate, ...amount })));
  }

  private async attachOwnerUsernames(groups: BillingLaunchGroup[]) {
    const ownerUserIds = [...new Set(groups.flatMap((group) => (group.ownerUserId ? [group.ownerUserId] : [])))];
    const users = await Promise.all(ownerUserIds.map((userId) => this.adminRepository.getPlatformUserById(userId)));
    const usernameById = new Map(
      users.flatMap((user) => (user ? [[user.id, user.username] as const] : [])),
    );

    return groups.map((group) => ({
      ...group,
      ownerUsername: group.ownerUserId ? usernameById.get(group.ownerUserId) ?? null : null,
    }));
  }

  private async groupBillingLineItems(lineItems: BillingLineItemRecord[]): Promise<BillingLaunchGroup[]> {
    const [ledgerResources, instances, jobs] = await Promise.all([
      this.adminRepository.listBillingLedgerResources(),
      this.adminRepository.listRangeInstances(),
      this.adminRepository.listProvisionJobs(),
    ]);
    const ledgerById = new Map(ledgerResources.map((ledger) => [ledger.id, ledger]));
    const instanceById = new Map(instances.map((instance) => [instance.id, instance]));
    const jobById = new Map(jobs.map((job) => [job.id, job]));
    const launchJobsByInstanceId = new Map<string, ProvisionJobRecord[]>();

    for (const job of jobs) {
      if (!isLaunchProvisionJob(job)) {
        continue;
      }

      const instanceJobs = launchJobsByInstanceId.get(job.rangeInstanceId) ?? [];
      instanceJobs.push(job);
      launchJobsByInstanceId.set(job.rangeInstanceId, instanceJobs);
    }

    for (const instanceJobs of launchJobsByInstanceId.values()) {
      instanceJobs.sort((left, right) => {
        const leftTime = (left.finishedAt ?? left.startedAt ?? left.createdAt).getTime();
        const rightTime = (right.finishedAt ?? right.startedAt ?? right.createdAt).getTime();
        return rightTime - leftTime || right.id.localeCompare(left.id);
      });
    }

    const groups = new Map<string, BillingLaunchGroupBuilder>();
    const unmatchedItems: BillingLineItemRecord[] = [];

    for (const item of lineItems) {
      const ledger = item.matchedLedgerId ? ledgerById.get(item.matchedLedgerId) ?? null : null;
      const instance = ledger?.rangeInstanceId ? instanceById.get(ledger.rangeInstanceId) : null;
      const job = this.resolveLaunchProvisionJob(ledger, jobById, launchJobsByInstanceId);

      if (!ledger || !job || !instance) {
        unmatchedItems.push(item);
        continue;
      }

      const kind = instance.instanceMode === 'single' ? 'single_launch' : 'range_launch';
      const completedAt = job.finishedAt?.toISOString() ?? null;
      const billingDate = toIsoDate(item.billingDate);
      const groupKey = `${job.id}:${item.currency}`;
      const existing = groups.get(groupKey);

      if (existing) {
        existing.items.push(item);
        existing.pretaxAmount = sumPretax(existing.items);
        existing.resourceKeys.add(`${item.cloudResourceType}:${item.cloudResourceId}`);
        existing.billingPeriodStart = existing.billingPeriodStart < billingDate ? existing.billingPeriodStart : billingDate;
        existing.billingPeriodEnd = existing.billingPeriodEnd > billingDate ? existing.billingPeriodEnd : billingDate;
        continue;
      }

      groups.set(groupKey, {
        id: job.id,
        kind,
        title: kind === 'single_launch' ? '开启单实例' : '开启编排实例',
        sourceProvisionJobId: job.id,
        provisionJobStatus: job.status,
        completedAt,
        billingPeriodStart: billingDate,
        billingPeriodEnd: billingDate,
        ownerUserId: ledger.ownerUserId ?? null,
        ownerUsername: null,
        instance: {
          id: instance.id,
          name: instance.name,
          batchId: instance.singleInstanceBatchId ?? null,
        },
        resourceKeys: new Set([`${item.cloudResourceType}:${item.cloudResourceId}`]),
        pretaxAmount: item.pretaxAmount,
        currency: item.currency,
        items: [item],
      });
    }

    for (const amount of currencyAmounts(unmatchedItems)) {
      const items = unmatchedItems.filter(item => item.currency === amount.currency);
      const billingDates = items.map(item => toIsoDate(item.billingDate)).sort();
      groups.set(`unmatched:${amount.currency}`, {
        id: 'unmatched', kind: 'unmatched', title: '未关联平台启动的费用', sourceProvisionJobId: null,
        provisionJobStatus: null, completedAt: null,
        billingPeriodStart: billingDates[0]!, billingPeriodEnd: billingDates[billingDates.length - 1]!,
        ownerUserId: null, ownerUsername: null, instance: null,
        resourceKeys: new Set(items.map(item => `${item.cloudResourceType}:${item.cloudResourceId}`)),
        pretaxAmount: amount.pretaxAmount, currency: amount.currency, items,
      });
    }

    return [...groups.values()]
      .map(({ resourceKeys, ...group }) => ({
        ...group,
        id: [...groups.values()].filter(candidate => candidate.id === group.id).length > 1 ? `${group.id}:${group.currency}` : group.id,
        resourceCount: resourceKeys.size,
      }))
      .sort((left, right) => {
        if (left.completedAt && right.completedAt) {
          return right.completedAt.localeCompare(left.completedAt);
        }

        if (left.completedAt) {
          return -1;
        }

        if (right.completedAt) {
          return 1;
        }

        return right.billingPeriodEnd.localeCompare(left.billingPeriodEnd);
      });
  }

  private resolveLaunchProvisionJob(
    ledger: BillingLedgerResourceRecord | null,
    jobById: Map<string, ProvisionJobRecord>,
    launchJobsByInstanceId: Map<string, ProvisionJobRecord[]>,
  ) {
    if (!ledger) {
      return null;
    }

    const sourceJob = ledger.sourceProvisionJobId ? jobById.get(ledger.sourceProvisionJobId) : null;

    if (isLaunchProvisionJob(sourceJob)) {
      return sourceJob;
    }

    const candidates = ledger.rangeInstanceId ? launchJobsByInstanceId.get(ledger.rangeInstanceId) ?? [] : [];

    // Older ledgers did not persist the originating job. Prefer the latest
    // successful launch, but retain failed launch attribution when none exists.
    return candidates.find((job) => job.status === 'succeeded') ?? candidates[0] ?? null;
  }
}
