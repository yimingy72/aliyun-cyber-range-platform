import type { CreateBillingLineItemInput } from '../src/admin/admin.repository';
import { BillingService } from '../src/admin/billing.service';
import { PrismaService } from '../src/database/prisma.service';
import { PrismaAdminRepository } from '../src/database/prisma-admin.repository';
import { runInCloudWorkspace, runInSystemCloudWorkspaceScope } from '../src/auth/cloud-workspace-scope';
import { createTencentBillingProof, signedTencentBillingResponse, tencentBill, tencentBillingSync,
  TENCENT_BILLING_DAY as DAY, TENCENT_BILLING_WINDOW as WINDOW } from './support/create-tencent-billing-fixture';

const url = process.env.TENCENT_BILLING_TEST_DATABASE_URL;
if (url && (new URL(url).hostname !== 'billing-test-postgres' || new URL(url).pathname !== '/billing_test')) throw new Error('Tencent billing requires its isolated billing_test PostgreSQL');
const describeDb = url ? describe : describe.skip;
const a = { cloudWorkspaceId: 'tencent-billing-pg-a', provider: 'alibaba_cloud' as const, accountUid: '100001' };
const b = { cloudWorkspaceId: 'tencent-billing-pg-b', provider: 'tencent_cloud' as const, accountUid: '100001' };
const c = { cloudWorkspaceId: 'tencent-billing-pg-c', provider: 'tencent_cloud' as const, accountUid: '200002' };

describeDb('Tencent billing atomic persistence in isolated PostgreSQL', () => {
  const prisma = new PrismaService({ datasources: { db: { url: url ?? 'postgresql://fixture:fixture@billing-test-postgres:5432/billing_test' } } });
  const repository = new PrismaAdminRepository(prisma);
  let fetchMock: jest.SpyInstance;
  const line = (provider: 'alibaba_cloud' | 'tencent_cloud', amount: number, fingerprint = 'same-official-record', uid = '100001'): CreateBillingLineItemInput => ({
    cloudProvider: provider, cloudAccountUid: uid, syncBatchId: `sync:${provider}:${uid}`, sourceFingerprint: fingerprint,
    billCycle: '2026-09', billingDate: DAY, productCode: provider === 'tencent_cloud' ? 'p_cvm' : 'ecs', billItem: 'CPU',
    cloudResourceId: 'ins-owned', cloudResourceType: 'ecs', pretaxAmount: amount, currency: 'CNY', billingScope: 'platform',
  });
  async function cleanup() {
    await runInSystemCloudWorkspaceScope(async () => {
      const where = { cloudWorkspaceId: { in: [a.cloudWorkspaceId, b.cloudWorkspaceId, c.cloudWorkspaceId] } };
      await prisma.billingLineItem.deleteMany({ where }); await prisma.billingAnomaly.deleteMany({ where });
      await prisma.billingLedgerResource.deleteMany({ where }); await prisma.rangeInstance.updateMany({ where, data: { lastJobId: null } });
      await prisma.provisionJob.deleteMany({ where }); await prisma.rangeInstance.deleteMany({ where });
      await prisma.platformUser.deleteMany({ where }); await prisma.cloudWorkspace.deleteMany({ where: { id: { in: where.cloudWorkspaceId.in } } });
    });
  }
  beforeAll(async () => { await prisma.$connect(); });
  beforeEach(async () => {
    await cleanup();
    await runInSystemCloudWorkspaceScope(() => prisma.cloudWorkspace.createMany({ data: [a, b, c].map(scope => ({ id: scope.cloudWorkspaceId,
      provider: scope.provider, accountUid: scope.accountUid, displayName: scope.cloudWorkspaceId })) }));
    fetchMock = jest.spyOn(global, 'fetch');
  });
  afterEach(async () => { fetchMock.mockRestore(); await cleanup(); });
  afterAll(async () => { await prisma.$disconnect(); });

  it('matches official components and signed refunds to the source instance/user without payment double counting', async () => {
    await runInCloudWorkspace(b, async () => {
      await repository.createPlatformUser({ id: 'tencent-billing-owner', username: 'fixture-owner', loginUsername: 'fixture-owner', passwordHash: 'fixture-only', role: 'user' });
      const proof = await createTencentBillingProof(repository, { ownerUserId: 'tencent-billing-owner' });
      fetchMock.mockImplementation(async () => signedTencentBillingResponse([tencentBill(), tencentBill({ Id: 'refund', ActionType: 'postpay_refund_h',
        ComponentSet: [{ RealCost: '-0.000000001', CashPayAmount: '-100' }] })]));
      await tencentBillingSync(repository).syncRange(WINDOW);
      const rows = await repository.listBillingLineItems();
      expect(rows).toHaveLength(3);
      expect(rows.every(row => row.matchedLedgerId === proof.ledgers[0].id && row.ownerUserId === 'tencent-billing-owner')).toBe(true);
      expect(await new BillingService(repository).getUserSummary('tencent-billing-owner', WINDOW)).toMatchObject({ pretaxAmount: 0.300000002, currency: 'CNY' });
      const stored = await prisma.billingLineItem.findMany();
      expect(stored.map(row => row.pretaxAmount.toFixed())).toEqual(expect.arrayContaining(['0.100000001', '0.200000002', '-0.000000001']));
    });
  });

  it('isolates same UID/resource/fingerprint across providers and spaces, and keeps another Tencent UID untouched', async () => {
    await runInCloudWorkspace(a, () => repository.replaceBillingDay({ cloudProvider: a.provider, cloudAccountUid: a.accountUid, billingDate: DAY, lineItems: [line(a.provider, 10)], anomalies: [] }));
    await runInCloudWorkspace(b, () => repository.replaceBillingDay({ cloudProvider: b.provider, cloudAccountUid: b.accountUid, billingDate: DAY, lineItems: [line(b.provider, 20)], anomalies: [] }));
    await runInCloudWorkspace(c, () => repository.replaceBillingDay({ cloudProvider: c.provider, cloudAccountUid: c.accountUid, billingDate: DAY, lineItems: [line(c.provider, 30, 'same-official-record', c.accountUid)], anomalies: [] }));
    await runInCloudWorkspace(b, () => repository.replaceBillingDay({ cloudProvider: b.provider, cloudAccountUid: b.accountUid, billingDate: DAY, lineItems: [], anomalies: [] }));
    expect((await runInCloudWorkspace(a, () => repository.listBillingLineItems()))[0].pretaxAmount).toBe(10);
    expect(await runInCloudWorkspace(b, () => repository.listBillingLineItems())).toEqual([]);
    expect((await runInCloudWorkspace(c, () => repository.listBillingLineItems()))[0].pretaxAmount).toBe(30);
    await runInCloudWorkspace(b, async () => {
      await expect(repository.replaceBillingDay({ cloudProvider: 'alibaba_cloud', cloudAccountUid: b.accountUid, billingDate: DAY, lineItems: [], anomalies: [] })).rejects.toThrow('provider');
      await expect(repository.replaceBillingDay({ cloudProvider: b.provider, cloudAccountUid: b.accountUid, billingDate: DAY, lineItems: [line('alibaba_cloud', 1)], anomalies: [] })).rejects.toThrow('provider');
    });
  });

  it('rolls back failed Tencent revisions and serializes competing component sets', async () => {
    await runInCloudWorkspace(b, async () => {
      const initial = line('tencent_cloud', 1);
      await repository.replaceBillingDay({ cloudProvider: b.provider, cloudAccountUid: b.accountUid, billingDate: DAY, lineItems: [initial], anomalies: [] });
      await expect(repository.replaceBillingDay({ cloudProvider: b.provider, cloudAccountUid: b.accountUid, billingDate: DAY,
        lineItems: [{ ...line('tencent_cloud', 2), currency: null } as unknown as CreateBillingLineItemInput], anomalies: [] })).rejects.toThrow();
      expect((await repository.listBillingLineItems())[0].pretaxAmount).toBe(1);
      for (let attempt = 0; attempt < 3; attempt++) {
        await Promise.all([[10, 20], [11, 21]].map(amounts => repository.replaceBillingDay({ cloudProvider: b.provider, cloudAccountUid: b.accountUid, billingDate: DAY,
          lineItems: amounts.map((amount, index) => line('tencent_cloud', amount, `component-${index}`)), anomalies: [] })));
        const rows = await repository.listBillingLineItems();
        expect(rows).toHaveLength(2);
        expect([30, 32]).toContain(rows.reduce((sum, row) => sum + row.pretaxAmount, 0));
      }
    });
  });
});
