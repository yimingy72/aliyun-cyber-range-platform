import { BillingBssClient } from '../src/admin/billing-bss-client';
import { BillingSyncService } from '../src/admin/billing-sync.service';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';

describe('BillingSyncService', () => {
  it('attributes OSS and snapshot storage costs to the platform while retaining instance costs for the owner', async () => {
    const repository = createMemoryAdminRepository();

    const ledger = await repository.createBillingLedgerResource({
      regionId: 'cn-hangzhou',
      cloudResourceId: 'i-test-1',
      cloudResourceType: 'ecs',
      billingScope: 'user',
      ownerUserId: 'user-1',
      billingStartAt: new Date('2026-07-16T00:00:00.000Z'),
      tagsSnapshot: {},
    });
    const service = new BillingSyncService(
      repository,
      {
        listDailyBillingItems: jest.fn(async () => [
          {
            ProductCode: 'ecs',
            ProductDetail: '云服务器ECS-按量付费',
            BillingItem: '云服务器配置',
            InstanceID: 'i-test-1',
            PretaxAmount: 1.25,
            Currency: 'CNY',
          },
          {
            ProductCode: 'snapshot',
            ProductDetail: '云服务器ECS-快照',
            BillingItem: '快照链容量',
            InstanceID: 'cn-hangzhou',
            PretaxAmount: 0.88,
            Currency: 'CNY',
          },
          {
            ProductCode: 'oss',
            ProductDetail: '对象存储OSS',
            BillingItem: '外网流出流量',
            InstanceID: 'cn-hangzhou;standard-zrs',
            PretaxAmount: 0.42,
            Currency: 'CNY',
          },
        ]),
      } as unknown as BillingBssClient,
    );

    await expect(
      service.syncRange({
        startAt: '2026-07-16',
        endAt: '2026-07-16',
      }),
    ).resolves.toEqual({
      syncedDays: 1,
      importedLineItems: 3,
      anomalyCount: 0,
      deferredCount: 0,
    });

    await expect(
      repository.listBillingLineItems({
        startAt: '2026-07-16',
        endAt: '2026-07-16',
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          cloudResourceId: 'i-test-1',
          cloudResourceType: 'ecs',
          billingScope: 'user',
          ownerUserId: 'user-1',
          matchedLedgerId: ledger.id,
        }),
        expect.objectContaining({
          cloudResourceId: 'cn-hangzhou',
          cloudResourceType: 'snapshot_region',
          billingScope: 'platform',
          ownerUserId: null,
          matchedLedgerId: null,
        }),
        expect.objectContaining({
          cloudResourceId: 'cn-hangzhou;standard-zrs',
          cloudResourceType: 'unknown',
          billingScope: 'platform',
          ownerUserId: null,
          matchedLedgerId: null,
        }),
      ]),
    );

    await expect(
      repository.listBillingAnomalies({
        startAt: '2026-07-16',
        endAt: '2026-07-16',
      }),
    ).resolves.toEqual([]);
  });

  it('ignores direct bill lines that are outside the platform ledger scope', async () => {
    const repository = createMemoryAdminRepository();

    await repository.createBillingLedgerResource({
      regionId: 'cn-hangzhou',
      cloudResourceId: 'i-test-1',
      cloudResourceType: 'ecs',
      billingScope: 'user',
      ownerUserId: 'user-1',
      billingStartAt: new Date('2026-07-17T00:00:00.000Z'),
      tagsSnapshot: {},
    });

    const service = new BillingSyncService(
      repository,
      {
        listDailyBillingItems: jest.fn(async () => [
          {
            ProductCode: 'ecs',
            ProductDetail: '云服务器ECS-按量付费',
            BillingItem: '云服务器配置',
            InstanceID: 'i-test-1',
            PretaxAmount: 1.25,
            Currency: 'CNY',
          },
        ]),
      } as unknown as BillingBssClient,
    );

    await expect(
      service.syncRange({
        startAt: '2026-07-16',
        endAt: '2026-07-16',
      }),
    ).resolves.toEqual({
      syncedDays: 1,
      importedLineItems: 0,
      anomalyCount: 0,
      deferredCount: 0,
    });

    await expect(
      repository.listBillingAnomalies({
        startAt: '2026-07-16',
        endAt: '2026-07-16',
      }),
    ).resolves.toEqual([]);
  });

  it('ignores direct bill lines that do not match any platform ledger resource', async () => {
    const repository = createMemoryAdminRepository();

    const service = new BillingSyncService(
      repository,
      {
        listDailyBillingItems: jest.fn(async () => [
          {
            ProductCode: 'ecs',
            ProductDetail: '云服务器ECS-按量付费',
            BillingItem: '云服务器配置',
            InstanceID: 'i-shared-account-1',
            PretaxAmount: 1.25,
            Currency: 'CNY',
          },
          {
            ProductCode: 'ecs',
            ProductDetail: '云服务器ECS-按量付费',
            BillingItem: '系统盘',
            InstanceID: 'i-shared-account-1',
            PretaxAmount: 0.38,
            Currency: 'CNY',
          },
        ]),
      } as unknown as BillingBssClient,
    );

    await expect(
      service.syncRange({
        startAt: '2026-07-16',
        endAt: '2026-07-16',
      }),
    ).resolves.toEqual({
      syncedDays: 1,
      importedLineItems: 0,
      anomalyCount: 0,
      deferredCount: 0,
    });

    await expect(
      repository.listBillingLineItems({
        startAt: '2026-07-16',
        endAt: '2026-07-16',
      }),
    ).resolves.toEqual([]);

    await expect(
      repository.listBillingAnomalies({
        startAt: '2026-07-16',
        endAt: '2026-07-16',
      }),
    ).resolves.toEqual([]);
  });

  it('clears stale anomalies for a sync batch when the refreshed lines are now out of scope', async () => {
    const repository = createMemoryAdminRepository();

    await repository.createBillingAnomaly({
      syncBatchId: 'billing-sync:2026-07-16',
      sourceFingerprint: 'billing-sync:2026-07-16:ecs:i-shared-account-1:云服务器配置',
      billCycle: '2026-07',
      billingDate: '2026-07-16',
      cloudResourceId: 'i-shared-account-1',
      cloudResourceType: 'ecs',
      pretaxAmount: 1.25,
      currency: 'CNY',
      reason: 'No billing ledger resource matched ecs:i-shared-account-1',
      rawPayload: {},
    });

    const service = new BillingSyncService(
      repository,
      {
        listDailyBillingItems: jest.fn(async () => [
          {
            ProductCode: 'ecs',
            ProductDetail: '云服务器ECS-按量付费',
            BillingItem: '云服务器配置',
            InstanceID: 'i-shared-account-1',
            PretaxAmount: 1.25,
            Currency: 'CNY',
          },
        ]),
      } as unknown as BillingBssClient,
    );

    await expect(
      service.syncRange({
        startAt: '2026-07-16',
        endAt: '2026-07-16',
      }),
    ).resolves.toEqual({
      syncedDays: 1,
      importedLineItems: 0,
      anomalyCount: 0,
      deferredCount: 0,
    });

    await expect(
      repository.listBillingAnomalies({
        startAt: '2026-07-16',
        endAt: '2026-07-16',
      }),
    ).resolves.toEqual([]);
  });

  it('imports next-day daily bills for resources released the previous day', async () => {
    const repository = createMemoryAdminRepository();

    const ecsLedger = await repository.createBillingLedgerResource({
      regionId: 'cn-hangzhou',
      cloudResourceId: 'i-short-lived-1',
      cloudResourceType: 'ecs',
      billingScope: 'user',
      ownerUserId: 'user-1',
      billingStartAt: new Date('2026-07-16T08:14:21.000Z'),
      releasedAt: new Date('2026-07-16T08:15:33.000Z'),
      tagsSnapshot: {
        CreatedBy: 'cyber-range-platform',
        PlatformScope: 'user',
        PlatformUserId: 'user-1',
        BillingStartAt: '2026-07-16',
      },
    });
    const diskLedger = await repository.createBillingLedgerResource({
      regionId: 'cn-hangzhou',
      cloudResourceId: 'i-short-lived-1',
      cloudResourceType: 'disk',
      billingScope: 'user',
      ownerUserId: 'user-1',
      billingStartAt: new Date('2026-07-16T08:14:21.000Z'),
      releasedAt: new Date('2026-07-16T08:15:33.000Z'),
      tagsSnapshot: {
        CreatedBy: 'cyber-range-platform',
        PlatformScope: 'user',
        PlatformUserId: 'user-1',
        BillingStartAt: '2026-07-16',
      },
    });

    const service = new BillingSyncService(
      repository,
      {
        listDailyBillingItems: jest.fn(async () => [
          {
            ProductCode: 'ecs',
            ProductDetail: '云服务器ECS-按量付费',
            BillingItem: '云服务器配置',
            InstanceID: 'i-short-lived-1',
            PretaxAmount: 0.01,
            Currency: 'CNY',
            Tag: 'key:CreatedBy value:cyber-range-platform; key:PlatformUserId value:user-1; key:BillingStartAt value:2026-07-16',
          },
          {
            ProductCode: 'ecs',
            ProductDetail: '云服务器ECS-按量付费',
            BillingItem: '系统盘',
            InstanceID: 'i-short-lived-1',
            PretaxAmount: 0.02,
            Currency: 'CNY',
            Tag: 'key:CreatedBy value:cyber-range-platform; key:PlatformUserId value:user-1; key:BillingStartAt value:2026-07-16',
          },
        ]),
      } as unknown as BillingBssClient,
    );

    await expect(
      service.syncRange({
        startAt: '2026-07-17',
        endAt: '2026-07-17',
      }),
    ).resolves.toEqual({
      syncedDays: 1,
      importedLineItems: 2,
      anomalyCount: 0,
      deferredCount: 0,
    });

    await expect(
      repository.listBillingLineItems({
        startAt: '2026-07-17',
        endAt: '2026-07-17',
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          cloudResourceId: 'i-short-lived-1',
          cloudResourceType: 'ecs',
          matchedLedgerId: ecsLedger.id,
        }),
        expect.objectContaining({
          cloudResourceId: 'i-short-lived-1',
          cloudResourceType: 'disk',
          matchedLedgerId: diskLedger.id,
        }),
      ]),
    );
  });
});
