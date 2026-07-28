import { BillingService } from '../src/admin/billing.service';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';

describe('BillingService', () => {
  it('includes platform users without billing items in the user list', async () => {
    const repository = createMemoryAdminRepository();
    const service = new BillingService(repository);

    await repository.createPlatformUser({
      id: 'user-2',
      username: 'new-user',
      passwordHash: 'hash',
      role: 'user',
    });

    await expect(service.listUsers({ startAt: '2026-07-16', endAt: '2026-07-16' })).resolves.toEqual([
      {
        userId: 'user-2',
        username: 'new-user',
        pretaxAmount: 0,
        itemCount: 0,
        launchCount: 0,
      },
    ]);
  });

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
    const platformLedger = await repository.createBillingLedgerResource({
      regionId: 'cn-hangzhou',
      cloudResourceId: 'eip-1',
      cloudResourceType: 'eip',
      billingScope: 'platform',
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
        matchedLedgerId: platformLedger.id,
        rawPayload: {},
      },
      {
        syncBatchId: 'sync-1',
        sourceFingerprint: 'unmatched-platform-charge',
        billCycle: '2026-07',
        billingDate: '2026-07-16',
        productCode: 'oss',
        productDetail: '对象存储OSS',
        billItem: '标准存储容量',
        cloudResourceId: 'cn-hangzhou;standard-zrs',
        cloudResourceType: 'unknown',
        pretaxAmount: 99,
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
        launchCount: 0,
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

  it('groups user billing by the successful range and single-instance launch that created each resource', async () => {
    const repository = createMemoryAdminRepository();
    const service = new BillingService(repository);

    await repository.createPlatformUser({
      id: 'user-1',
      username: 'alice',
      passwordHash: 'hash',
      role: 'user',
    });

    const rangeInstance = await repository.createRangeInstance({
      name: 'web-lab',
      ownerUserId: 'user-1',
      instanceMode: 'range',
      status: 'running',
    });
    const singleInstance = await repository.createRangeInstance({
      name: 'ubuntu-training',
      ownerUserId: 'user-1',
      instanceMode: 'single',
      status: 'running',
    });
    const rangeJob = await repository.createProvisionJob({
      rangeInstanceId: rangeInstance.id,
      jobType: 'create',
      triggeredBy: 'user-1',
    });
    const singleJob = await repository.createProvisionJob({
      rangeInstanceId: singleInstance.id,
      jobType: 'create',
      triggeredBy: 'user-1',
    });
    await repository.updateProvisionJob(rangeJob.id, {
      status: 'succeeded',
      finishedAt: new Date('2026-07-16T02:03:42.000Z'),
    });
    await repository.updateProvisionJob(singleJob.id, {
      status: 'succeeded',
      finishedAt: new Date('2026-07-16T07:16:07.000Z'),
    });

    const rangeLedger = await repository.createBillingLedgerResource({
      regionId: 'cn-hangzhou',
      cloudResourceId: 'i-range',
      cloudResourceType: 'ecs',
      billingScope: 'user',
      ownerUserId: 'user-1',
      rangeInstanceId: rangeInstance.id,
      sourceProvisionJobId: rangeJob.id,
      billingStartAt: new Date('2026-07-16T02:03:42.000Z'),
      tagsSnapshot: {},
    });
    const singleLedger = await repository.createBillingLedgerResource({
      regionId: 'cn-hangzhou',
      cloudResourceId: 'i-single',
      cloudResourceType: 'ecs',
      billingScope: 'user',
      ownerUserId: 'user-1',
      rangeInstanceId: singleInstance.id,
      sourceProvisionJobId: singleJob.id,
      billingStartAt: new Date('2026-07-16T07:16:07.000Z'),
      tagsSnapshot: {},
    });

    await repository.upsertBillingLineItems([
      {
        syncBatchId: 'sync-1',
        sourceFingerprint: 'range-ecs',
        billCycle: '2026-07',
        billingDate: '2026-07-16',
        productCode: 'ecs',
        billItem: '云服务器配置',
        cloudResourceId: 'i-range',
        cloudResourceType: 'ecs',
        pretaxAmount: 8.4,
        currency: 'CNY',
        billingScope: 'user',
        ownerUserId: 'user-1',
        matchedLedgerId: rangeLedger.id,
        rawPayload: {},
      },
      {
        syncBatchId: 'sync-1',
        sourceFingerprint: 'single-ecs',
        billCycle: '2026-07',
        billingDate: '2026-07-16',
        productCode: 'ecs',
        billItem: '云服务器配置',
        cloudResourceId: 'i-single',
        cloudResourceType: 'ecs',
        pretaxAmount: 9.2,
        currency: 'CNY',
        billingScope: 'user',
        ownerUserId: 'user-1',
        matchedLedgerId: singleLedger.id,
        rawPayload: {},
      },
      {
        syncBatchId: 'sync-1',
        sourceFingerprint: 'legacy',
        billCycle: '2026-07',
        billingDate: '2026-07-16',
        productCode: 'eip',
        billItem: '公网IP保有费',
        cloudResourceId: 'eip-legacy',
        cloudResourceType: 'eip',
        pretaxAmount: 0.5,
        currency: 'CNY',
        billingScope: 'user',
        ownerUserId: 'user-1',
        rawPayload: {},
      },
    ]);

    const groups = await Promise.resolve(
      (
        service as unknown as {
          listUserGroups?: (input: { startAt: string; endAt: string }) => Promise<unknown>;
        }
      ).listUserGroups?.({ startAt: '2026-07-16', endAt: '2026-07-16' }),
    );

    expect(groups).toEqual([
      expect.objectContaining({
        id: singleJob.id,
        kind: 'single_launch',
        title: '开启编排实例',
        completedAt: '2026-07-16T07:16:07.000Z',
        ownerUsername: 'alice',
        pretaxAmount: 9.2,
        resourceCount: 1,
      }),
      expect.objectContaining({
        id: rangeJob.id,
        kind: 'range_launch',
        title: '开启靶场实例',
        completedAt: '2026-07-16T02:03:42.000Z',
        ownerUsername: 'alice',
        pretaxAmount: 8.4,
        resourceCount: 1,
      }),
    ]);

    await expect(service.listUsers({ startAt: '2026-07-16', endAt: '2026-07-16' })).resolves.toEqual([
      {
        userId: 'user-1',
        username: 'alice',
        pretaxAmount: 17.6,
        itemCount: 2,
        launchCount: 2,
      },
    ]);
  });
});
