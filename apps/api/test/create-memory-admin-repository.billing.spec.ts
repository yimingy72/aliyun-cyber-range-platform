import { createMemoryAdminRepository } from './support/create-memory-admin-repository';

describe('createMemoryAdminRepository billing extensions', () => {
  it('stores ledger resources, normalized bill lines, and anomalies', async () => {
    const repository = createMemoryAdminRepository() as any;

    const ledger = await repository.createBillingLedgerResource({
      cloudProvider: 'alibaba_cloud',
      cloudAccountUid: '1672470067548805',
      regionId: 'cn-hangzhou',
      cloudResourceId: 'i-test-1',
      cloudResourceType: 'ecs',
      billingScope: 'user',
      ownerUserId: 'user-1',
      rangeInstanceId: 'range-1',
      billingStartAt: new Date('2026-07-16T00:00:00.000Z'),
      tagsSnapshot: { CreatedBy: 'cyber-range-platform' },
    });

    await repository.upsertBillingLineItems([
      {
        syncBatchId: 'sync-1',
        sourceFingerprint: 'sync-1:2026-07-16:ecs:i-test-1:云服务器配置',
        billCycle: '2026-07',
        billingDate: '2026-07-16',
        productCode: 'ecs',
        productDetail: '云服务器ECS-按量付费',
        billItem: '云服务器配置',
        cloudResourceId: 'i-test-1',
        cloudResourceType: 'ecs',
        pretaxAmount: 0.12,
        currency: 'CNY',
        billingScope: 'user',
        ownerUserId: 'user-1',
        matchedLedgerId: ledger.id,
        rawPayload: { InstanceID: 'i-test-1' },
      },
    ]);

    await repository.createBillingAnomaly({
      syncBatchId: 'sync-1',
      sourceFingerprint: 'sync-1:2026-07-16:snapshot:cn-hangzhou:快照链容量',
      billCycle: '2026-07',
      billingDate: '2026-07-16',
      cloudResourceId: 'cn-hangzhou',
      cloudResourceType: 'snapshot_region',
      pretaxAmount: 0.88,
      currency: 'CNY',
      reason: 'missing aggregation rule',
      rawPayload: { ProductCode: 'snapshot' },
    });

    expect(await repository.listBillingLedgerResources()).toHaveLength(1);
    expect(await repository.listBillingLineItems({ startAt: '2026-07-16', endAt: '2026-07-16' })).toHaveLength(1);
    expect(await repository.listBillingAnomalies({ startAt: '2026-07-16', endAt: '2026-07-16' })).toHaveLength(1);
  });
});
