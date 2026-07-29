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
  title: '开启靶场实例' | '开启编排实例' | '未关联平台启动的费用';
  provisionJobStatus: ProvisionJobStatus | null;
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

function parseDate(value: string | Date) {
  return value instanceof Date ? new Date(value) : new Date(value);
}

function resolveBillingWindow(input: BillingWindowInput) {
  if (input.startAt && input.endAt) {
    const startAt = parseDate(input.startAt);
    const endAt = parseDate(input.endAt);

    return {
      startAt,
      endAt,
      startAtText: toIsoDate(startAt),
      endAtText: toIsoDate(endAt),
    };
  }

  const endAt = new Date();
  const startAt = new Date(endAt);
  startAt.setDate(startAt.getDate() - 29);

  return {
    startAt,
    endAt,
    startAtText: toIsoDate(startAt),
    endAtText: toIsoDate(endAt),
  };
}

function sumPretax(items: Array<{ pretaxAmount: number }>) {
  return items.reduce((total, item) => total + item.pretaxAmount, 0);
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
    const [lineItems, anomalies] = await Promise.all([
      this.adminRepository.listBillingLineItems({
        startAt: window.startAt,
        endAt: window.endAt,
      }),
      this.adminRepository.listBillingAnomalies({
        startAt: window.startAt,
        endAt: window.endAt,
      }),
    ]);

    const trackedLineItems = lineItems.filter(isTrackedBillingLineItem);
    const resourceTypeTotals = this.groupByResourceType(trackedLineItems);
    const dailyTotals = this.groupByBillingDate(trackedLineItems);

    return {
      startAt: window.startAtText,
      endAt: window.endAtText,
      totalPretaxAmount: sumPretax(trackedLineItems),
      platformPretaxAmount: sumPretax(trackedLineItems.filter((item) => item.billingScope === 'platform')),
      anomalyCount: anomalies.length,
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
    const launchCountsByUserId = new Map<string, number>();

    for (const group of groups) {
      if (group.kind !== 'unmatched' && group.provisionJobStatus === 'succeeded' && group.ownerUserId) {
        launchCountsByUserId.set(group.ownerUserId, (launchCountsByUserId.get(group.ownerUserId) ?? 0) + 1);
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
      user.launchCount = launchCountsByUserId.get(item.ownerUserId) ?? 0;
      usersById.set(item.ownerUserId, user);
    }

    return [...usersById.values()]
      .sort((left, right) => right.pretaxAmount - left.pretaxAmount || left.username.localeCompare(right.username));
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
    const launchCount = (await this.groupBillingLineItems(items)).filter(
      (group) => group.kind !== 'unmatched' && group.provisionJobStatus === 'succeeded',
    ).length;

    return {
      userId,
      username: user?.username ?? userId,
      pretaxAmount: sumPretax(items),
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
      ['anomalyCount', summary.anomalyCount],
      [],
      ['resourceType', 'pretaxAmount'],
      ...summary.resourceTypeTotals.map((item) => [item.resourceType, item.pretaxAmount]),
      [],
      ['billingDate', 'pretaxAmount'],
      ...summary.dailyTotals.map((item) => [item.billingDate, item.pretaxAmount]),
    ]);
  }

  async exportUsersCsv(input: BillingWindowInput) {
    const users = await this.listUserSummaries(input);

    return toCsv([
      ['userId', 'username', 'pretaxAmount', 'itemCount'],
      ...users.map((user) => [user.userId, user.username, user.pretaxAmount, user.itemCount]),
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
    const totals = new Map<string, number>();

    for (const item of lineItems) {
      totals.set(item.cloudResourceType, (totals.get(item.cloudResourceType) ?? 0) + item.pretaxAmount);
    }

    return [...totals.entries()]
      .map(([resourceType, pretaxAmount]) => ({
        resourceType,
        pretaxAmount,
      }))
      .sort((left, right) => right.pretaxAmount - left.pretaxAmount);
  }

  private groupByBillingDate(lineItems: BillingLineItemRecord[]) {
    const totals = new Map<string, number>();

    for (const item of lineItems) {
      const billingDate = toIsoDate(item.billingDate);
      totals.set(billingDate, (totals.get(billingDate) ?? 0) + item.pretaxAmount);
    }

    return [...totals.entries()]
      .map(([billingDate, pretaxAmount]) => ({
        billingDate,
        pretaxAmount,
      }))
      .sort((left, right) => left.billingDate.localeCompare(right.billingDate));
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
      const existing = groups.get(job.id);

      if (existing) {
        existing.items.push(item);
        existing.pretaxAmount += item.pretaxAmount;
        existing.resourceKeys.add(`${item.cloudResourceType}:${item.cloudResourceId}`);
        existing.billingPeriodStart = existing.billingPeriodStart < billingDate ? existing.billingPeriodStart : billingDate;
        existing.billingPeriodEnd = existing.billingPeriodEnd > billingDate ? existing.billingPeriodEnd : billingDate;
        continue;
      }

      groups.set(job.id, {
        id: job.id,
        kind,
        title: kind === 'single_launch' ? '开启编排实例' : '开启靶场实例',
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

    if (unmatchedItems.length > 0) {
      const billingDates = unmatchedItems.map((item) => toIsoDate(item.billingDate)).sort();
      groups.set('unmatched', {
        id: 'unmatched',
        kind: 'unmatched',
        title: '未关联平台启动的费用',
        provisionJobStatus: null,
        completedAt: null,
        billingPeriodStart: billingDates[0]!,
        billingPeriodEnd: billingDates[billingDates.length - 1]!,
        ownerUserId: null,
        ownerUsername: null,
        instance: null,
        resourceKeys: new Set(unmatchedItems.map((item) => `${item.cloudResourceType}:${item.cloudResourceId}`)),
        pretaxAmount: sumPretax(unmatchedItems),
        currency: unmatchedItems[0]!.currency,
        items: unmatchedItems,
      });
    }

    return [...groups.values()]
      .map(({ resourceKeys, ...group }) => ({
        ...group,
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
