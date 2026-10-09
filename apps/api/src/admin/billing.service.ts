import { Prisma } from '@aliyun-cyber-range/database/generated/client';

import { Inject, Injectable } from '@nestjs/common';

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
  return items.reduce((total, item) => total.plus(item.pretaxAmount), new Prisma.Decimal(0)).toDecimalPlaces(9).toNumber();
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

function isTrackedBillingLineItem(item: BillingLineItemRecord) {
  return Boolean(item.matchedLedgerId);
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
  const escaped = text.replaceAll('"', '""');
  return /[",\n]/.test(escaped) ? `"${escaped}"` : escaped;
}

function toCsv(rows: Array<Array<string | number | null | undefined>>) {
  return `${rows.map((row) => row.map(escapeCsvCell).join(',')).join('\n')}\n`;
}

@Injectable()
export class BillingService {
  constructor(@Inject(ADMIN_REPOSITORY) private readonly adminRepository: AdminRepository) {}

  async getSummary(input: BillingWindowInput) {
    const window = resolveBillingWindow(input);
    const [lineItems, anomalies, ledgerResources] = await Promise.all([
      this.adminRepository.listBillingLineItems({
        startAt: window.startAt,
        endAt: window.endAt,
      }),
      this.adminRepository.listBillingAnomalies({
        startAt: window.startAt,
        endAt: window.endAt,
      }),
      this.adminRepository.listBillingLedgerResources(),
    ]);

    const trackedLineItems = lineItems.filter(isTrackedBillingLineItem);
    const resourceTypeTotals = this.groupByResourceType(trackedLineItems);
    const dailyTotals = this.groupByBillingDate(trackedLineItems);
    const money = moneySummary(trackedLineItems);
    const unallocatedItems = new Map([...lineItems.filter(item => !isTrackedBillingLineItem(item)), ...anomalies]
      .map(item => [item.sourceFingerprint, item]));
    const billedResourceIds = new Set(trackedLineItems.map(item => item.matchedLedgerId));
    const resourcesWithoutBillCount = ledgerResources.filter(item => !['snat_entry', 'dnat_entry', 'unknown', 'snapshot_region'].includes(item.cloudResourceType)
      && billingDayText(item.billingStartAt) <= window.endAtText
      && (!item.releasedAt || billingDayText(item.releasedAt) >= window.startAtText)
      && !billedResourceIds.has(item.id)).length;

    return {
      startAt: window.startAtText,
      endAt: window.endAtText,
      currency: money.currency,
      totalPretaxAmount: money.pretaxAmount,
      platformPretaxAmount: money.currency ? sumPretax(trackedLineItems.filter(item => item.billingScope === 'platform')) : null,
      currencyTotals: money.amounts.map(amount => ({ currency: amount.currency, totalPretaxAmount: amount.pretaxAmount, platformPretaxAmount: sumPretax(trackedLineItems.filter(item => item.currency === amount.currency && item.billingScope === 'platform')) })),
      anomalyCount: anomalies.length,
      billingStatus: 'provisional' as const,
      unallocatedCurrencyTotals: currencyAmounts([...unallocatedItems.values()]),
      resourcesWithoutBillCount,
      resourceTypeTotals,
      dailyTotals,
    };
  }

  async listUsers(input: BillingWindowInput) {
    return paginate(await this.listUserSummaries(input), input);
  }

  private async listUserSummaries(input: BillingWindowInput) {
    const window = resolveBillingWindow(input);
    const [platformUsers, fetchedLineItems] = await Promise.all([
      this.adminRepository.listPlatformUsers(),
      this.adminRepository.listBillingLineItems({
        startAt: window.startAt,
        endAt: window.endAt,
        billingScope: 'user',
      }),
    ]);
    const lineItems = fetchedLineItems.filter(isTrackedBillingLineItem);

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
    const items = (await this.adminRepository.listBillingLineItems({
      startAt: window.startAt,
      endAt: window.endAt,
      ownerUserId: userId,
      billingScope: 'user',
    })).filter(isTrackedBillingLineItem);
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
    const items = (await this.adminRepository.listBillingLineItems({
      startAt: window.startAt,
      endAt: window.endAt,
      billingScope: 'user',
      ...(input.userId ? { ownerUserId: input.userId } : {}),
    })).filter(isTrackedBillingLineItem);

    const groups = await this.attachOwnerUsernames(await this.groupBillingLineItems(items));
    return paginate(groups, input);
  }

  async listPlatformGroups(input: BillingWindowInput) {
    const window = resolveBillingWindow(input);
    const items = (await this.adminRepository.listBillingLineItems({
      startAt: window.startAt,
      endAt: window.endAt,
      billingScope: 'platform',
    })).filter(isTrackedBillingLineItem);

    const groups = await this.attachOwnerUsernames(await this.groupBillingLineItems(items));
    return paginate(groups, input);
  }

  async listUserItems(userId: string, input: BillingWindowInput) {
    const window = resolveBillingWindow(input);

    const items = (await this.adminRepository.listBillingLineItems({
      startAt: window.startAt,
      endAt: window.endAt,
      ownerUserId: userId,
      billingScope: 'user',
    })).filter(isTrackedBillingLineItem);

    return items
      .slice()
      .sort((left, right) => right.billingDate.getTime() - left.billingDate.getTime());
  }

  async listPlatformItems(input: BillingWindowInput) {
    const window = resolveBillingWindow(input);

    const items = (await this.adminRepository.listBillingLineItems({
      startAt: window.startAt,
      endAt: window.endAt,
      billingScope: 'platform',
    })).filter(isTrackedBillingLineItem);

    return items
      .slice()
      .sort((left, right) => {
        const dateDelta = right.billingDate.getTime() - left.billingDate.getTime();
        return dateDelta !== 0 ? dateDelta : right.pretaxAmount - left.pretaxAmount;
      });
  }

  async listAnomalies(input: BillingWindowInput) {
    const window = resolveBillingWindow(input);

    const anomalies = await this.adminRepository.listBillingAnomalies({
      startAt: window.startAt,
      endAt: window.endAt,
    });

    return anomalies
      .slice()
      .sort((left, right) => right.billingDate.getTime() - left.billingDate.getTime());
  }

  async exportPlatformCsv(input: BillingWindowInput) {
    const summary = await this.getSummary(input);

    return toCsv([
      ['startAt', summary.startAt],
      ['endAt', summary.endAt],
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
