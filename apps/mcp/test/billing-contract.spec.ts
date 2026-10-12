import { describe, it, expect, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { PlatformApiClient, type BillingReconciliationResource, type BillingSummary } from '@aliyun-cyber-range/platform-api-client';
import { billingTools } from '../src/tools/billing';
import { billingReconciliationResourceSchema, billingSummaryOutputSchema, billingUserSummarySchema } from '../src/tools/output-schemas';
import type { PlatformApiClientLike } from '@aliyun-cyber-range/platform-api-client';
import { createHttpApp } from '../src/http-app';

const pendingResource: BillingReconciliationResource = {
  resourceKey: 'ledger:ledger-original', ledgerId: 'ledger-original', cloudWorkspaceId: 'workspace-ali', cloudProvider: 'alibaba_cloud',
  cloudResourceId: 'd-original', cloudResourceType: 'disk', rangeInstanceId: 'range-original', sourceProvisionJobId: 'job-original',
  ownerUserId: 'owner-original', cloudAccountUid: '100001', regionId: 'cn-hangzhou', billingStartAt: '2026-10-10T14:10:34.771Z',
  releasedAt: '2026-10-10T14:18:58.928Z', proofFailureReason: 'SOURCE_PROOF_UNVERIFIED',
};

const pendingSummary: BillingSummary = {
  startAt: '2026-10-10', endAt: '2026-10-10', billingScope: 'platform_resources', billingStatus: 'provisional',
  platformBillingStartedAt: '2026-10-01T00:00:00.000Z',
  totalPretaxAmount: 0, platformPretaxAmount: 0, anomalyCount: 0, resourcesWithoutBillCount: 1, unallocatedCurrencyTotals: [],
  reconciliationIssues: [{ resourceType: 'unknown', resourceCount: 1, reason: 'Source evidence needs verification', resources: [pendingResource] }],
  resourceTypeTotals: [], dailyTotals: [],
};

describe('billing currency and export contracts', () => {
  it('preserves pending resource identities and release times through SDK and MCP HTTP output validation', async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(pendingSummary)));
    const platformClient = new PlatformApiClient({ baseUrl: 'https://fixture.invalid', token: 'fixture-token', cloudWorkspaceId: 'workspace-ali', fetch: fetch as typeof globalThis.fetch });
    const server = createHttpApp({ host: '127.0.0.1', port: 0, platformApiBaseUrl: 'https://fixture.invalid' }, {
      authenticateRequest: async () => ({ token: 'fixture-inbound', clientId: 'fixture', scopes: ['billing:read'], extra: { role: 'admin' } }), client: platformClient,
    });
    const client = new Client({ name: 'billing-output-contract', version: '1.0.0' });
    try {
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const address = server.address(); if (!address || typeof address === 'string') throw new Error('Expected fixture server port');
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`)));
      await client.listTools();
      await expect(client.callTool({ name: 'billing_summary_get', arguments: { startAt: '2026-10-10', endAt: '2026-10-10' } }))
        .resolves.toMatchObject({ structuredContent: { result: pendingSummary } });
      expect(fetch).toHaveBeenCalledWith('https://fixture.invalid/admin/billing/summary?startAt=2026-10-10&endAt=2026-10-10', expect.objectContaining({
        headers: expect.objectContaining({ 'x-cloud-workspace-id': 'workspace-ali' }),
      }));
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      await client.close();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it('accepts both providers and incomplete historical source fields without allowing credentials or raw payloads', () => {
    expect(billingSummaryOutputSchema.parse({ result: pendingSummary })).toEqual({ result: pendingSummary });
    expect(billingReconciliationResourceSchema.parse({ ...pendingResource, cloudProvider: 'tencent_cloud', cloudResourceId: 'disk-original',
      regionId: 'ap-nanjing', proofFailureReason: 'SOURCE_JOB_CREATION_INVENTORY_MISSING' })).toMatchObject({ cloudProvider: 'tencent_cloud' });
    expect(billingReconciliationResourceSchema.parse({ ...pendingResource, resourceKey: 'image-source:artifact-original', ledgerId: null,
      cloudResourceId: null, cloudResourceType: 'image', rangeInstanceId: null, sourceProvisionJobId: null, ownerUserId: null, cloudAccountUid: null,
      regionId: '', releasedAt: null, proofFailureReason: 'SOURCE_SNAPSHOT_INVENTORY_OR_BILL_PROOF_INCOMPLETE' })).toMatchObject({ ledgerId: null });
    for (const extra of [{ password: 'secret' }, { rawPayload: {} }, { credentials: {} }]) {
      expect(billingReconciliationResourceSchema.safeParse({ ...pendingResource, ...extra }).success).toBe(false);
    }
    expect(billingReconciliationResourceSchema.safeParse({ ...pendingResource, cloudProvider: 'external' }).success).toBe(false);
    expect(billingReconciliationResourceSchema.safeParse({ ...pendingResource, releasedAt: 'unknown' }).success).toBe(false);
    expect(billingReconciliationResourceSchema.safeParse({ ...pendingResource, proofFailureReason: 'INVENTED' }).success).toBe(false);
  });

  it('preserves historical disk mapping issues separately from resources missing independent bill details', () => {
    const result = { ...pendingSummary, resourcesWithoutBillCount: 3, reconciliationIssues: [{ resourceType: 'disk', resourceCount: 54,
      reason: 'Host system-disk components exist, but historical disk mappings remain unverified',
      resources: [{ ...pendingResource, proofFailureReason: 'SYSTEM_DISK_MAPPING_UNVERIFIED' }] }] };
    expect(billingSummaryOutputSchema.parse({ result })).toEqual({ result });
  });

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

  it('preserves platform scope and reconciliation issues without combining unallocated costs with matched totals', () => {
    const result = { startAt: '2026-10-01', endAt: '2026-10-01', totalPretaxAmount: 10, platformPretaxAmount: 2,
      billingScope: 'platform_resources', reconciliationIssues: [{ resourceType: 'snapshot', resourceCount: 1, reason: 'Awaiting split bill' }, { resourceType: 'unknown', resourceCount: 2, reason: 'Original account missing' }],
      anomalyCount: 2, resourceTypeTotals: [], dailyTotals: [], billingStatus: 'provisional', resourcesWithoutBillCount: 5,
      unallocatedCurrencyTotals: [{ currency: 'CNY', pretaxAmount: 3 }, { currency: 'USD', pretaxAmount: -1 }] };
    expect(billingSummaryOutputSchema.parse({ result })).toEqual({ result });
    expect(billingSummaryOutputSchema.safeParse({ result: { ...result, resourcesWithoutBillCount: -1 } }).success).toBe(false);
    expect(billingSummaryOutputSchema.safeParse({ result: { ...result, reconciliationIssues: [{ resourceType: 'oss', resourceCount: -1, reason: 'Invalid count' }] } }).success).toBe(false);
    expect(billingSummaryOutputSchema.safeParse({ result: { ...result, billingScope: 'cloud_account' } }).success).toBe(false);
    const { billingScope: _scope, reconciliationIssues: _issues, billingStatus: _status, unallocatedCurrencyTotals: _amounts, resourcesWithoutBillCount: _count, ...legacy } = result;
    expect(billingSummaryOutputSchema.parse({ result: legacy })).toEqual({ result: legacy });
  });
});
