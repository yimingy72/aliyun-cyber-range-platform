import type { RangeResourceSummary } from '../src/admin/admin.repository';
import { BillingService } from '../src/admin/billing.service';
import { loadPlatformBillingProof } from '../src/admin/billing-platform-scope';
import { runInCloudWorkspace } from '../src/auth/cloud-workspace-scope';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';
import { createTencentBillingProof, signedTencentBillingResponse, tencentBill, tencentBillingContext, tencentBillingSync,
  TENCENT_BILLING_DAY as DAY, TENCENT_BILLING_WINDOW as WINDOW } from './support/create-tencent-billing-fixture';

const scope = { cloudWorkspaceId: 'tencent-billing-fixture', provider: 'tencent_cloud' as const, accountUid: '100001', isPlatformManager: true };
let fetchMock: jest.SpyInstance;
beforeEach(() => { fetchMock = jest.spyOn(global, 'fetch'); });
afterEach(() => { fetchMock.mockRestore(); });

describe('Tencent signed official billing pipeline', () => {
  it.each([
    { label: 'foreign row', change: { Currency: 'USD' } },
    { label: 'foreign component', change: { ComponentSet: [{ RealCost: '100', Currency: 'USD' }] } },
    { label: 'noncanonical CNY component', change: { ComponentSet: [{ RealCost: '100', Currency: 'cny' }] } },
    { label: 'blank row', change: { Currency: ' ' } },
    { label: 'wrong component type', change: { ComponentSet: [{ RealCost: '100', Currency: 123 }] } },
  ])('imports the observed domestic empty currency without payment inflation and retains old lines for $label', async ({ change }) => {
    const repository = createMemoryAdminRepository();
    await runInCloudWorkspace(scope, async () => {
      await createTencentBillingProof(repository);
      const bill = tencentBill();
      fetchMock.mockImplementation(async () => signedTencentBillingResponse([{ ...bill, Currency: '', ComponentSet: bill.ComponentSet.map(component => ({ ...component, Currency: '' })) }]));
      expect(await tencentBillingSync(repository).syncRange(WINDOW)).toMatchObject({ importedLineItems: 2 });
      const before = await repository.listBillingLineItems();
      expect(before.every(item => item.currency === 'CNY')).toBe(true);
      expect((await new BillingService(repository).getSummary(WINDOW)).totalPretaxAmount).toBe(0.300000003);
      fetchMock.mockImplementation(async () => signedTencentBillingResponse([tencentBill(change)]));
      await expect(tencentBillingSync(repository).syncRange(WINDOW)).rejects.toThrow(/unsupported (row|component) currency/);
      expect(await repository.listBillingLineItems()).toEqual(before);
      expect((await new BillingService(repository).getSummary(WINDOW)).totalPretaxAmount).toBe(0.300000003);
    });
  });

  it('persists component yuan amounts once, retains signed refunds and allocates only exact platform resources', async () => {
    const repository = createMemoryAdminRepository();
    await runInCloudWorkspace(scope, async () => {
      const { ledgers } = await createTencentBillingProof(repository);
      fetchMock.mockImplementation(async () => signedTencentBillingResponse([tencentBill(), tencentBill({ Id: 'refund', ActionType: 'postpay_refund_h',
        ComponentSet: [{ ComponentCode: 'v_cvm_cpu', RealCost: '-0.000000001', CashPayAmount: '-10' }] }),
        tencentBill({ Id: 'disk', ResourceId: 'disk-data', BusinessCode: 'p_cbs', ProductCode: 'sp_cbs', ComponentSet: [{ RealCost: '0.4' }] }),
        tencentBill({ Id: 'eip', ResourceId: 'eip-owned', BusinessCode: 'p_eip', ComponentSet: [{ RealCost: '0.5' }] }),
        tencentBill({ Id: 'nat', ResourceId: 'nat-owned', BusinessCode: 'p_nat', ComponentSet: [{ RealCost: '0.6' }] }),
        tencentBill({ Id: 'external', ResourceId: 'ins-external', ComponentSet: [{ RealCost: '999' }] }),
        tencentBill({ Id: 'cos-aggregate', ResourceId: '100001;4;cos', BusinessCode: 'p_cos', ComponentSet: [{ RealCost: '888' }] })]));
      expect(await tencentBillingSync(repository).syncRange(WINDOW)).toMatchObject({ syncedDays: 1, importedLineItems: 6, anomalyCount: 0 });
      const summary = await new BillingService(repository).getSummary(WINDOW);
      expect(summary).toMatchObject({ totalPretaxAmount: 1.800000002, resourcesWithoutBillCount: 1, anomalyCount: 0 });
      const items = await repository.listBillingLineItems();
      expect(items.every(item => item.cloudProvider === 'tencent_cloud' && item.matchedLedgerId && ledgers.some(ledger => ledger.id === item.matchedLedgerId))).toBe(true);
      expect(items.some(item => item.pretaxAmount === -0.000000001)).toBe(true);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://billing.tencentcloudapi.com/');
      expect(init.headers.Authorization).toMatch(/^TC3-HMAC-SHA256 Credential=fixture-key\//);
      await tencentBillingSync(repository).syncRange(WINDOW);
      expect(await repository.listBillingLineItems()).toHaveLength(6);
    });
  });

  it.each([{ RegionId: '9999' }, { RegionId: '8' }, { BusinessCode: 'p_other' }])('keeps exact-source conflicts out of totals with reconciliation notice %j', async overrides => {
    const repository = createMemoryAdminRepository();
    await runInCloudWorkspace(scope, async () => {
      await createTencentBillingProof(repository);
      fetchMock.mockImplementation(async () => signedTencentBillingResponse([tencentBill(overrides)]));
      await tencentBillingSync(repository).syncRange(WINDOW);
      expect(await repository.listBillingLineItems()).toEqual([]);
      expect(await new BillingService(repository).getSummary(WINDOW)).toMatchObject({ totalPretaxAmount: 0, anomalyCount: 0,
        resourcesWithoutBillCount: 5, reconciliationIssues: [expect.objectContaining({ resourceType: 'unknown' })] });
    });
  });

  it.each(['context', 'inventory', 'source-job'])('requires the frozen provider/account context, exact inventory and source job: %s', async missing => {
    const repository = createMemoryAdminRepository();
    await runInCloudWorkspace(scope, async () => {
      const summary = { mode: 'opentofu', executionContext: { cloudAccountContextId: 'ctx', cloudAccountUid: '100001', regionId: 'ap-shanghai', zoneId: 'ap-shanghai-1',
        ...(missing === 'context' ? {} : { provider: 'tencent_cloud' }) }, hostIds: missing === 'inventory' ? {} : { host: 'ins-owned' } } as RangeResourceSummary;
      const proof = await createTencentBillingProof(repository, { summary });
      if (missing === 'source-job') await repository.updateBillingLedgerResource(proof.ledgers[0].id, { sourceProvisionJobId: null });
      expect((await loadPlatformBillingProof(repository)).createdLedgerIds.has(proof.ledgers[0].id)).toBe(false);
      fetchMock.mockImplementation(async () => signedTencentBillingResponse([tencentBill()]));
      await tencentBillingSync(repository).syncRange(WINDOW);
      expect((await new BillingService(repository).getSummary(WINDOW)).totalPretaxAmount).toBe(0);
    });
  });

  it('retains the previous day if a later monthly page fails or changes account; future days never erase data', async () => {
    const repository = createMemoryAdminRepository();
    await runInCloudWorkspace(scope, async () => {
      await createTencentBillingProof(repository);
      fetchMock.mockImplementation(async () => signedTencentBillingResponse([tencentBill()]));
      await tencentBillingSync(repository).syncRange(WINDOW);
      const before = await repository.listBillingLineItems();
      fetchMock.mockReset().mockImplementationOnce(async () => signedTencentBillingResponse(Array.from({ length: 300 }, (_, index) => tencentBill({ Id: `record-${index}` })), { Total: 301, Context: 'opaque-fixture' }))
        .mockImplementationOnce(async () => signedTencentBillingResponse([tencentBill({ Id: 'last', OwnerUin: '200002' })], { Total: 301 }));
      await expect(tencentBillingSync(repository).syncRange(WINDOW)).rejects.toThrow('different resource or payer account');
      expect(await repository.listBillingLineItems()).toEqual(before);
      const calls = fetchMock.mock.calls.length;
      expect(await tencentBillingSync(repository).syncRange({ startAt: '2099-01-01', endAt: '2099-01-02' })).toMatchObject({ syncedDays: 0, deferredDates: ['2099-01-01', '2099-01-02'] });
      expect(fetchMock).toHaveBeenCalledTimes(calls);
    });
  });

  it.each(['0.0000000001', '100000000000', '99999999999.123456789'])('retains prior bills when a component exceeds the persisted/display precision: %s', async cost => {
    const repository = createMemoryAdminRepository();
    await runInCloudWorkspace(scope, async () => {
      await createTencentBillingProof(repository);
      fetchMock.mockImplementation(async () => signedTencentBillingResponse([tencentBill()]));
      await tencentBillingSync(repository).syncRange(WINDOW);
      const before = await repository.listBillingLineItems();
      fetchMock.mockImplementation(async () => signedTencentBillingResponse([tencentBill({ ComponentSet: [{ RealCost: cost }] })]));
      await expect(tencentBillingSync(repository).syncRange(WINDOW)).rejects.toThrow('precision');
      expect(await repository.listBillingLineItems()).toEqual(before);
    });
  });

  it('reads one monthly revision for multiple bill days and retains late official refunds after release', async () => {
    const repository = createMemoryAdminRepository();
    await runInCloudWorkspace(scope, async () => {
      const { ledgers } = await createTencentBillingProof(repository);
      await repository.updateBillingLedgerResource(ledgers[0].id, { releasedAt: new Date('2026-09-10') });
      fetchMock.mockImplementation(async () => signedTencentBillingResponse([tencentBill({ ActionType: 'postpay_refund_h', ComponentSet: [{ RealCost: '-1' }] })]));
      await tencentBillingSync(repository).syncRange({ startAt: '2026-09-29', endAt: DAY });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(await repository.listBillingLineItems()).toEqual([expect.objectContaining({ pretaxAmount: -1,
        rawPayload: expect.objectContaining({ __platformPostReleaseCharge: true }) })]);
      expect((await new BillingService(repository).getSummary(WINDOW)).totalPretaxAmount).toBe(-1);
    });
  });

  it('keeps its workspace synchronization lock until the full monthly query and day persistence finish', async () => {
    const repository = createMemoryAdminRepository();
    await runInCloudWorkspace(scope, async () => {
      await createTencentBillingProof(repository);
      let markStarted!: () => void;
      let release!: (response: Response) => void;
      const started = new Promise<void>(resolve => { markStarted = resolve; });
      fetchMock.mockImplementation(() => { markStarted(); return new Promise<Response>(resolve => { release = resolve; }); });
      const service = tencentBillingSync(repository);
      const first = service.syncRange(WINDOW);
      await started;
      expect(await service.syncRange(WINDOW)).toMatchObject({ syncedDays: 0, syncInProgress: true });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      release(signedTencentBillingResponse([tencentBill()]));
      expect(await first).toMatchObject({ syncedDays: 1, importedLineItems: 2 });
      fetchMock.mockImplementation(async () => signedTencentBillingResponse([tencentBill()]));
      expect(await service.syncRange(WINDOW)).toMatchObject({ syncedDays: 1 });
    });
  });

  it('rejects workspace/account mismatch before any signed request', async () => {
    const repository = createMemoryAdminRepository();
    await runInCloudWorkspace(scope, async () => {
      await expect(tencentBillingSync(repository, { ...tencentBillingContext, accountUid: '200002' }).syncRange(WINDOW)).rejects.toThrow('does not match');
      expect(fetchMock).not.toHaveBeenCalled();
      await expect(repository.replaceBillingDay({ cloudAccountUid: '100001', billingDate: DAY, lineItems: [], anomalies: [] })).rejects.toThrow('provider');
    });
  });
});
