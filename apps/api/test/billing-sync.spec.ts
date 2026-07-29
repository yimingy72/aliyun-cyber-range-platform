import { BillingBssClient } from '../src/admin/billing-bss-client';
import { BillingSyncService } from '../src/admin/billing-sync.service';
import { SystemConfigService } from '../src/admin/system-config.service';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';

describe('BillingSyncService', () => {
  it('continues from the latest persisted billing date through the requested end date', async () => {
    const repository = createMemoryAdminRepository();
    const ledger = await repository.createBillingLedgerResource({
      regionId: 'cn-hangzhou',
      cloudResourceId: 'i-incremental-sync-1',
      cloudResourceType: 'ecs',
      billingScope: 'platform',
      billingStartAt: new Date('2026-07-01T00:00:00.000Z'),
      tagsSnapshot: {},
    });
    await repository.upsertBillingLineItems([
      {
        syncBatchId: 'billing-sync:2026-07-01',
        sourceFingerprint: 'billing-sync:2026-07-01:ecs:i-incremental-sync-1:云服务器配置',
        billCycle: '2026-07',
        billingDate: '2026-07-01',
        productCode: 'ecs',
        productDetail: '云服务器ECS-按量付费',
        billItem: '云服务器配置',
        cloudResourceId: 'i-incremental-sync-1',
        cloudResourceType: 'ecs',
        pretaxAmount: 1.25,
        currency: 'CNY',
        billingScope: 'platform',
        matchedLedgerId: ledger.id,
        rawPayload: {},
      },
    ]);
    const listDailyBillingItems = jest.fn(async () => []);
    const service = new BillingSyncService(
      repository,
      { listDailyBillingItems } as unknown as BillingBssClient,
    );

    await expect(
      service.syncRange({
        startAt: '2026-06-01',
        endAt: '2026-07-07',
      }),
    ).resolves.toEqual({
      syncedDays: 7,
      importedLineItems: 0,
      anomalyCount: 0,
      deferredCount: 0,
    });

    expect(listDailyBillingItems.mock.calls).toEqual([
      [{ billingDate: '2026-07-01' }],
      [{ billingDate: '2026-07-02' }],
      [{ billingDate: '2026-07-03' }],
      [{ billingDate: '2026-07-04' }],
      [{ billingDate: '2026-07-05' }],
      [{ billingDate: '2026-07-06' }],
      [{ billingDate: '2026-07-07' }],
    ]);
  });

  it('uses the full requested range before any bill is persisted', async () => {
    const repository = createMemoryAdminRepository();
    const listDailyBillingItems = jest.fn(async () => []);
    const service = new BillingSyncService(
      repository,
      { listDailyBillingItems } as unknown as BillingBssClient,
    );

    await expect(
      service.syncRange({
        startAt: '2026-07-01',
        endAt: '2026-07-03',
      }),
    ).resolves.toEqual({
      syncedDays: 3,
      importedLineItems: 0,
      anomalyCount: 0,
      deferredCount: 0,
    });

    expect(listDailyBillingItems.mock.calls).toEqual([
      [{ billingDate: '2026-07-01' }],
      [{ billingDate: '2026-07-02' }],
      [{ billingDate: '2026-07-03' }],
    ]);
  });

  it('does not query Aliyun when the stored billing date is later than the requested end date', async () => {
    const repository = createMemoryAdminRepository();
    const ledger = await repository.createBillingLedgerResource({
      regionId: 'cn-hangzhou',
      cloudResourceId: 'i-later-billing-date-1',
      cloudResourceType: 'ecs',
      billingScope: 'platform',
      billingStartAt: new Date('2026-07-07T00:00:00.000Z'),
      tagsSnapshot: {},
    });
    await repository.upsertBillingLineItems([
      {
        syncBatchId: 'billing-sync:2026-07-07',
        sourceFingerprint: 'billing-sync:2026-07-07:ecs:i-later-billing-date-1:云服务器配置',
        billCycle: '2026-07',
        billingDate: '2026-07-07',
        productCode: 'ecs',
        productDetail: '云服务器ECS-按量付费',
        billItem: '云服务器配置',
        cloudResourceId: 'i-later-billing-date-1',
        cloudResourceType: 'ecs',
        pretaxAmount: 1.25,
        currency: 'CNY',
        billingScope: 'platform',
        matchedLedgerId: ledger.id,
        rawPayload: {},
      },
    ]);
    const listDailyBillingItems = jest.fn(async () => []);
    const service = new BillingSyncService(
      repository,
      { listDailyBillingItems } as unknown as BillingBssClient,
    );

    await expect(
      service.syncRange({
        startAt: '2026-07-01',
        endAt: '2026-07-06',
      }),
    ).resolves.toEqual({
      syncedDays: 0,
      importedLineItems: 0,
      anomalyCount: 0,
      deferredCount: 0,
    });

    expect(listDailyBillingItems).not.toHaveBeenCalled();
  });

  it('keeps account-level OSS and snapshot aggregates out of platform costs', async () => {
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
      importedLineItems: 1,
      anomalyCount: 2,
      deferredCount: 0,
    });

    await expect(
      repository.listBillingLineItems({
        startAt: '2026-07-16',
        endAt: '2026-07-16',
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        cloudResourceId: 'i-test-1',
        cloudResourceType: 'ecs',
        billingScope: 'user',
        ownerUserId: 'user-1',
        matchedLedgerId: ledger.id,
      }),
    ]);

    await expect(
      repository.listBillingAnomalies({
        startAt: '2026-07-16',
        endAt: '2026-07-16',
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          cloudResourceId: 'cn-hangzhou',
          cloudResourceType: 'snapshot_region',
          pretaxAmount: 0.88,
          reason: expect.stringContaining('不计入平台费用'),
        }),
        expect.objectContaining({
          cloudResourceId: 'cn-hangzhou;standard-zrs',
          cloudResourceType: 'unknown',
          pretaxAmount: 0.42,
          reason: expect.stringContaining('不计入平台费用'),
        }),
      ]),
    );
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

  it('attributes explicitly tagged platform resources and only exact configured OSS bucket bills', async () => {
    const repository = createMemoryAdminRepository();
    const systemConfigService = {
      getSnapshot: jest.fn().mockResolvedValue({
        defaultRegion: 'cn-hangzhou',
        imageImportBucket: 'wzxy-shootingrange',
      }),
    } as unknown as SystemConfigService;
    const service = new BillingSyncService(
      repository,
      {
        listDailyBillingItems: jest.fn(async () => [
          {
            ProductCode: 'eip',
            BillingItem: '公网IP保有费',
            InstanceID: 'eip-platform-1',
            PretaxAmount: 0.12,
            Currency: 'CNY',
            Tag: 'key:CreatedBy value:cyber-range-platform; key:PlatformScope value:platform; key:BillingStartAt value:2026-07-16',
          },
          {
            ProductCode: 'snapshot',
            BillingItem: '快照链容量',
            InstanceID: 's-platform-1',
            PretaxAmount: 0.34,
            Currency: 'CNY',
            Tag: 'key:CreatedBy value:cyber-range-platform; key:PlatformScope value:platform; key:BillingStartAt value:2026-07-16; key:PlatformImageAssetId value:asset-1',
          },
          {
            ProductCode: 'oss',
            BillingItem: '外网流出流量',
            InstanceID: 'wzxy-shootingrange;standard',
            PretaxAmount: 0.56,
            Currency: 'CNY',
          },
          {
            ProductCode: 'oss',
            BillingItem: '外网流出流量',
            InstanceID: 'cn-hangzhou;standard',
            PretaxAmount: 9.99,
            Currency: 'CNY',
          },
        ]),
      } as unknown as BillingBssClient,
      systemConfigService,
    );

    await expect(
      service.syncRange({
        startAt: '2026-07-16',
        endAt: '2026-07-16',
      }),
    ).resolves.toEqual({
      syncedDays: 1,
      importedLineItems: 3,
      anomalyCount: 1,
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
          cloudResourceId: 'eip-platform-1',
          cloudResourceType: 'eip',
          billingScope: 'platform',
          matchedLedgerId: expect.any(String),
        }),
        expect.objectContaining({
          cloudResourceId: 's-platform-1',
          cloudResourceType: 'snapshot',
          billingScope: 'platform',
          matchedLedgerId: expect.any(String),
        }),
        expect.objectContaining({
          cloudResourceId: 'wzxy-shootingrange',
          cloudResourceType: 'oss_bucket',
          billingScope: 'platform',
          matchedLedgerId: expect.any(String),
        }),
      ]),
    );

    await expect(
      repository.listBillingAnomalies({
        startAt: '2026-07-16',
        endAt: '2026-07-16',
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        cloudResourceId: 'cn-hangzhou;standard',
        pretaxAmount: 9.99,
        reason: expect.stringContaining('wzxy-shootingrange'),
      }),
    ]);
  });

  it('backfills platform image ledgers before matching direct image bills', async () => {
    const repository = createMemoryAdminRepository();
    await repository.upsertImageSnapshots({
      provider: 'alibaba_cloud',
      accountUid: '1234567890',
      regionId: 'cn-hangzhou',
      scope: 'custom',
      snapshots: [
        {
          imageId: 'm-platform-image',
          sourceImageName: 'Platform image',
          status: 'Available',
          isAvailable: true,
          lastSyncedAt: new Date('2026-07-16T00:00:00.000Z'),
        },
      ],
    });
    const [snapshot] = await repository.listImageSnapshots({
      provider: 'alibaba_cloud',
      accountUid: '1234567890',
      regionId: 'cn-hangzhou',
      scope: 'custom',
      imageId: 'm-platform-image',
    });
    const asset = await repository.collectPlatformImageAsset({
      snapshotId: snapshot!.id,
      displayName: 'Platform image',
      ownerUserId: null,
      visibility: 'platform',
    });
    const billingDate = asset.createdAt.toISOString().slice(0, 10);
    const service = new BillingSyncService(
      repository,
      {
        listDailyBillingItems: jest.fn(async () => [
          {
            ProductCode: 'image',
            BillingItem: '镜像存储',
            InstanceID: 'm-platform-image',
            PretaxAmount: 0.78,
            Currency: 'CNY',
          },
        ]),
      } as unknown as BillingBssClient,
    );

    await expect(
      service.syncRange({
        startAt: billingDate,
        endAt: billingDate,
      }),
    ).resolves.toEqual({
      syncedDays: 1,
      importedLineItems: 1,
      anomalyCount: 0,
      deferredCount: 0,
    });

    await expect(
      repository.listBillingLineItems({
        startAt: billingDate,
        endAt: billingDate,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        cloudResourceId: 'm-platform-image',
        cloudResourceType: 'image',
        billingScope: 'platform',
        matchedLedgerId: expect.any(String),
      }),
    ]);

    await expect(
      repository.findBillingLedgerResource({
        regionId: 'cn-hangzhou',
        cloudResourceId: 'm-platform-image',
        cloudResourceType: 'image',
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        billingScope: 'platform',
        platformImageAssetId: asset.id,
      }),
    );
  });
});
