import { BillingService } from '../src/admin/billing.service';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';

describe('BillingService', () => {
  it('builds summary and user totals from normalized bill items', async () => {
    const repository = createMemoryAdminRepository();
    const service = new BillingService(repository);

    await repository.createPlatformUser({
      id: 'user-1',
      username: 'alice',
      passwordHash: 'hash',
      role: 'user',
    });

    const ledger = await repository.createBillingLedgerResource({
      regionId: 'cn-hangzhou',
      cloudResourceId: 'i-test-1',
      cloudResourceType: 'ecs',
      billingScope: 'user',
      ownerUserId: 'user-1',
      billingStartAt: new Date('2026-07-16T00:00:00.000Z'),
      tagsSnapshot: {},
    });

    await repository.upsertBillingLineItems([
      {
        syncBatchId: 'sync-1',
        sourceFingerprint: 'a',
        billCycle: '2026-07',
        billingDate: '2026-07-16',
        productCode: 'ecs',
        productDetail: '云服务器ECS-按量付费',
        billItem: '云服务器配置',
        cloudResourceId: 'i-test-1',
        cloudResourceType: 'ecs',
        pretaxAmount: 1.25,
        currency: 'CNY',
        billingScope: 'user',
        ownerUserId: 'user-1',
        matchedLedgerId: ledger.id,
        rawPayload: {},
      },
      {
        syncBatchId: 'sync-1',
        sourceFingerprint: 'b',
        billCycle: '2026-07',
        billingDate: '2026-07-16',
        productCode: 'eip',
        productDetail: '弹性公网IP',
        billItem: '公网IP保有费',
        cloudResourceId: 'eip-1',
        cloudResourceType: 'eip',
        pretaxAmount: 0.5,
        currency: 'CNY',
        billingScope: 'platform',
        ownerUserId: null,
        matchedLedgerId: null,
        rawPayload: {},
      },
    ]);

    await repository.createBillingAnomaly({
      syncBatchId: 'sync-1',
      sourceFingerprint: 'c',
      billCycle: '2026-07',
      billingDate: '2026-07-16',
      cloudResourceId: 'cn-hangzhou',
      cloudResourceType: 'snapshot_region',
      pretaxAmount: 0.88,
      currency: 'CNY',
      reason: 'missing aggregation rule',
      rawPayload: {},
    });

    await expect(service.getSummary({ startAt: '2026-07-16', endAt: '2026-07-16' })).resolves.toEqual({
      startAt: '2026-07-16',
      endAt: '2026-07-16',
      totalPretaxAmount: 1.75,
      platformPretaxAmount: 0.5,
      anomalyCount: 1,
      resourceTypeTotals: [
        { resourceType: 'ecs', pretaxAmount: 1.25 },
        { resourceType: 'eip', pretaxAmount: 0.5 },
      ],
      dailyTotals: [{ billingDate: '2026-07-16', pretaxAmount: 1.75 }],
    });

    await expect(service.listUsers({ startAt: '2026-07-16', endAt: '2026-07-16' })).resolves.toEqual([
      {
        userId: 'user-1',
        username: 'alice',
        pretaxAmount: 1.25,
        itemCount: 1,
      },
    ]);

    await expect(service.listPlatformItems({ startAt: '2026-07-16', endAt: '2026-07-16' })).resolves.toEqual([
      expect.objectContaining({
        cloudResourceId: 'eip-1',
        cloudResourceType: 'eip',
        billItem: '公网IP保有费',
        pretaxAmount: 0.5,
      }),
    ]);
  });
});
