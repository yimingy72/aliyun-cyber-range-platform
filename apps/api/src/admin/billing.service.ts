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

    const resourceTypeTotals = this.groupByResourceType(lineItems);
    const dailyTotals = this.groupByBillingDate(lineItems);

    return {
      startAt: window.startAtText,
      endAt: window.endAtText,
      totalPretaxAmount: sumPretax(lineItems),
      platformPretaxAmount: sumPretax(lineItems.filter((item) => item.billingScope === 'platform')),
      anomalyCount: anomalies.length,
      resourceTypeTotals,
      dailyTotals,
    };
  }

  async listUsers(input: BillingWindowInput) {
    const window = resolveBillingWindow(input);
    const limit = resolveListLimit(input, 100);
    const lineItems = await this.adminRepository.listBillingLineItems({
      startAt: window.startAt,
      endAt: window.endAt,
      billingScope: 'user',
    });

    const totalsByUserId = new Map<string, { pretaxAmount: number; itemCount: number }>();

    for (const item of lineItems) {
      if (!item.ownerUserId) {
        continue;
      }

      const existing = totalsByUserId.get(item.ownerUserId) ?? { pretaxAmount: 0, itemCount: 0 };
      existing.pretaxAmount += item.pretaxAmount;
      existing.itemCount += 1;
      totalsByUserId.set(item.ownerUserId, existing);
    }

    const users = await Promise.all(
      [...totalsByUserId.entries()].map(async ([userId, totals]) => {
        const user = await this.adminRepository.getPlatformUserById(userId);

        return {
          userId,
          username: user?.username ?? userId,
          pretaxAmount: totals.pretaxAmount,
          itemCount: totals.itemCount,
        };
      }),
    );

    return users.sort((left, right) => right.pretaxAmount - left.pretaxAmount).slice(0, limit);
  }

  async getUserSummary(userId: string, input: BillingWindowInput) {
    const window = resolveBillingWindow(input);
    const items = await this.adminRepository.listBillingLineItems({
      startAt: window.startAt,
      endAt: window.endAt,
      ownerUserId: userId,
      billingScope: 'user',
    });
    const user = await this.adminRepository.getPlatformUserById(userId);

    return {
      userId,
      username: user?.username ?? userId,
      pretaxAmount: sumPretax(items),
      itemCount: items.length,
    };
  }

  async listUserItems(userId: string, input: BillingWindowInput) {
    const window = resolveBillingWindow(input);
    const limit = resolveListLimit(input, 100);

    const items = await this.adminRepository.listBillingLineItems({
      startAt: window.startAt,
      endAt: window.endAt,
      ownerUserId: userId,
      billingScope: 'user',
    });

    return items
      .slice()
      .sort((left, right) => right.billingDate.getTime() - left.billingDate.getTime())
      .slice(0, limit);
  }

  async listPlatformItems(input: BillingWindowInput) {
    const window = resolveBillingWindow(input);
    const limit = resolveListLimit(input, 100);

    const items = await this.adminRepository.listBillingLineItems({
      startAt: window.startAt,
      endAt: window.endAt,
      billingScope: 'platform',
    });

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
}
