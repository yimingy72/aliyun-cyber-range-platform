import { describe, it, expect } from 'vitest';
import { billingTools } from '../src/tools/billing';
import { billingSummaryOutputSchema, billingUserSummarySchema } from '../src/tools/output-schemas';
import type { PlatformApiClientLike } from '@aliyun-cyber-range/platform-api-client';

describe('billing currency and export contracts', () => {
  it('accepts mixed-currency totals without inventing a numeric combined amount', () => {
    expect(billingSummaryOutputSchema.safeParse({ result: { startAt: '2026-10-01', endAt: '2026-10-01', totalPretaxAmount: null, platformPretaxAmount: null, currency: null, currencyTotals: [{ currency: 'CNY', totalPretaxAmount: 1, platformPretaxAmount: 1 }, { currency: 'USD', totalPretaxAmount: 2, platformPretaxAmount: 0 }], anomalyCount: 0, resourceTypeTotals: [], dailyTotals: [] } }).success).toBe(true);
    expect(billingUserSummarySchema.safeParse({ userId: 'test-user', username: 'test-user', pretaxAmount: null, currency: null, amounts: [{ currency: 'CNY', pretaxAmount: 1 }, { currency: 'USD', pretaxAmount: 2 }], itemCount: 2, launchCount: 1 }).success).toBe(true);
  });

  it('counts logical CSV records with quoted newlines', async () => {
    const tool = billingTools.find(item => item.name === 'billing_export_users_csv')!;
    const csv = 'userId,username,currency,pretaxAmount\nu-1,"First\nSecond",CNY,1\nu-2,"A, B",USD,2\n';
    const result = await tool.call({ scopes: new Set(['billing:read']), client: { exportBillingUsersCsv: async () => csv } as unknown as PlatformApiClientLike }, {});
    expect(result).toMatchObject({ rowCount: 2, csv });
  });
});
