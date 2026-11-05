import { describe, expect, it, vi } from 'vitest';
import { PlatformApiClient } from '@aliyun-cyber-range/platform-api-client';
import { createToolRegistry } from '../src/server';

const payload = { billingCycle: '2026-10', coverage: 'official_monthly_diagnostic_only', complete: true, billingWrites: 0, resources: [], queries: [] };
describe('monthly billing diagnostic MCP contract', () => {
  it('uses the delegated read-only SDK route and retains the safe diagnostic result', async () => {
    const fetch = vi.fn(async (_url: string) => new Response(JSON.stringify(payload)));
    const registry = createToolRegistry(new PlatformApiClient({ baseUrl: 'https://platform.example', token: 'fixture', cloudWorkspaceId: 'workspace', fetch: fetch as typeof globalThis.fetch }));
    const tool = registry.listTools(['billing:read'], 'admin').find(tool => tool.name === 'billing_monthly_diagnose')!;
    expect(tool.annotations.readOnlyHint).toBe(true);
    expect(await registry.callTool(tool.name, ['billing:read'], { billingCycle: '2026-10', ledgerIds: ['ledger-1', 'ledger-2'] }, 'admin'))
      .toMatchObject({ structuredContent: { result: payload } });
    expect(fetch.mock.calls[0][0]).toBe('https://platform.example/admin/billing/diagnostics/monthly?billingCycle=2026-10&ledgerIds=ledger-1%2Cledger-2');
  });
  it('requires admin and billing read, and rejects ambiguous or oversized inputs before fetching', async () => {
    const diagnoseBillingMonth = vi.fn(async () => payload), registry = createToolRegistry({ diagnoseBillingMonth } as any);
    const input = { billingCycle: '2026-10', ledgerIds: ['ledger-1'] };
    expect(registry.listTools(['billing:read'], 'user').map(tool => tool.name)).not.toContain('billing_monthly_diagnose');
    await expect(registry.callTool('billing_monthly_diagnose', ['jobs:read'], input, 'admin')).rejects.toThrow('Forbidden');
    await expect(registry.callTool('billing_monthly_diagnose', ['billing:read'], input, 'user')).rejects.toThrow('Forbidden');
    for (const extra of [{ ledgerIds: [] }, { ledgerIds: ['ledger-1', 'ledger-1'] }, { ledgerIds: ['../foreign'] }, { billingCycle: '2026-13' },
      { ledgerIds: Array.from({ length: 101 }, (_, i) => 'ledger-' + i) }, { cloudAccountUid: 'other' }])
      await expect(registry.callTool('billing_monthly_diagnose', ['billing:read'], { ...input, ...extra }, 'admin')).rejects.toThrow('Invalid input');
    expect(diagnoseBillingMonth).not.toHaveBeenCalled();
  });
});
