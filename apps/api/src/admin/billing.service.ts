import { Inject, Injectable } from '@nestjs/common';

import {
  ADMIN_REPOSITORY,
  AdminRepository,
  type BillingAnomalyRecord,
  type BillingLineItemRecord,
} from './admin.repository';

type BillingWindowInput = Partial<{
  startAt: string | Date;
  endAt: string | Date;
  limit: number;
}>;

type BillingGroupInput = BillingWindowInput & {
  userId?: string;
};

type BillingLaunchGroup = {
  id: string;
  kind: 'range_launch' | 'single_launch' | 'unmatched';
  title: '开启靶场实例' | '开启编排实例' | '未关联平台启动的费用';
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

function resolveListLimit(input: BillingWindowInput, fallback: number) {
  if (!Number.isFinite(input.limit) || !input.limit) {
    return fallback;
  }

  return Math.max(1, Math.min(Math.trunc(input.limit), 500));
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
    const window = resolveBillingWindow(input);
    const limit = resolveListLimit(input, 100);
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
      if (group.kind !== 'unmatched' && group.ownerUserId) {
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
      .sort((left, right) => right.pretaxAmount - left.pretaxAmount || left.username.localeCompare(right.username))
      .slice(0, limit);
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
    const launchCount = (await this.groupBillingLineItems(items)).filter((group) => group.kind !== 'unmatched').length;

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
    const limit = resolveListLimit(input, 100);
    const items = (await this.adminRepository.listBillingLineItems({
      startAt: window.startAt,
      endAt: window.endAt,
      billingScope: 'user',
      ...(input.userId ? { ownerUserId: input.userId } : {}),
    })).filter(isTrackedBillingLineItem);

    const groups = (await this.groupBillingLineItems(items)).slice(0, limit);
    return this.attachOwnerUsernames(groups);
  }

  async listPlatformGroups(input: BillingWindowInput) {
    const window = resolveBillingWindow(input);
    const limit = resolveListLimit(input, 100);
    const items = (await this.adminRepository.listBillingLineItems({
      startAt: window.startAt,
      endAt: window.endAt,
      billingScope: 'platform',
    })).filter(isTrackedBillingLineItem);

    const groups = (await this.groupBillingLineItems(items)).slice(0, limit);
    return this.attachOwnerUsernames(groups);
  }

  async listUserItems(userId: string, input: BillingWindowInput) {
    const window = resolveBillingWindow(input);
    const limit = resolveListLimit(input, 100);

    const items = (await this.adminRepository.listBillingLineItems({
      startAt: window.startAt,
      endAt: window.endAt,
      ownerUserId: userId,
      billingScope: 'user',
    })).filter(isTrackedBillingLineItem);

    return items
      .slice()
      .sort((left, right) => right.billingDate.getTime() - left.billingDate.getTime())
      .slice(0, limit);
  }

  async listPlatformItems(input: BillingWindowInput) {
    const window = resolveBillingWindow(input);
    const limit = resolveListLimit(input, 100);

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
      })
      .slice(0, limit);
  }

  async listAnomalies(input: BillingWindowInput) {
    const window = resolveBillingWindow(input);
    const limit = resolveListLimit(input, 50);

    const anomalies = await this.adminRepository.listBillingAnomalies({
      startAt: window.startAt,
      endAt: window.endAt,
    });

    return anomalies
      .slice()
      .sort((left, right) => right.billingDate.getTime() - left.billingDate.getTime())
      .slice(0, limit);
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
    const users = await this.listUsers(input);

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
    const groups = new Map<string, BillingLaunchGroupBuilder>();
    const unmatchedItems: BillingLineItemRecord[] = [];

    for (const item of lineItems) {
      const ledger = item.matchedLedgerId ? ledgerById.get(item.matchedLedgerId) : null;
      const job = ledger?.sourceProvisionJobId ? jobById.get(ledger.sourceProvisionJobId) : null;
      const instance = ledger?.rangeInstanceId ? instanceById.get(ledger.rangeInstanceId) : null;
      const isSuccessfulLaunch =
        Boolean(job?.finishedAt) &&
        job?.status === 'succeeded' &&
        (job.jobType === 'create' || job.jobType === 'retry') &&
        Boolean(instance);

      if (!ledger || !job || !instance || !isSuccessfulLaunch) {
        unmatchedItems.push(item);
        continue;
      }

      const kind = instance.instanceMode === 'single' ? 'single_launch' : 'range_launch';
      const completedAt = job.finishedAt!.toISOString();
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
}
