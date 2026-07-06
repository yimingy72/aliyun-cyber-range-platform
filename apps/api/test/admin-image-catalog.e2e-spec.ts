import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { ADMIN_REPOSITORY, type AdminRepository } from '../src/admin/admin.repository';
import { signAliyunRpcQuery } from '../src/admin/image-catalog-rpc-signer';
import { PrismaAdminRepository } from '../src/database/prisma-admin.repository';
import { toAccountScopeKey } from '../src/admin/image-account-scope';
import { SystemConfigService } from '../src/admin/system-config.service';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap/configure-app';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';

type PersistedSystemCloudConfigRow = {
  id: string;
  provider: string;
  defaultRegion: string;
  defaultZoneId: string;
  accessKeyId: string;
  accessKeySecret: string;
  createdAt: Date;
  updatedAt: Date;
};

function createFakePrismaService(row?: PersistedSystemCloudConfigRow | null) {
  let persistedRow = row ?? null;

  return {
    systemCloudConfig: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
        if (!persistedRow || persistedRow.id !== where.id) {
          return null;
        }

        return { ...persistedRow };
      }),
      upsert: jest.fn(
        async ({
          where,
          create,
          update,
        }: {
          where: { id: string };
          create: Omit<PersistedSystemCloudConfigRow, 'createdAt' | 'updatedAt'>;
          update: Partial<PersistedSystemCloudConfigRow>;
        }) => {
          if (persistedRow && persistedRow.id === where.id) {
            persistedRow = {
              ...persistedRow,
              ...update,
              updatedAt: new Date(),
            };
          } else {
            persistedRow = {
              ...create,
              createdAt: new Date(),
              updatedAt: new Date(),
            };
          }

          return { ...persistedRow };
        },
      ),
    },
  };
}

function createSystemConfigServiceStub() {
  return {
    getSnapshot: jest.fn().mockResolvedValue({
      provider: 'alibaba_cloud',
      defaultRegion: 'cn-hangzhou',
      defaultZoneId: 'cn-hangzhou-h',
      accessKeyId: 'test-ak',
      accessKeySecret: 'test-sk',
    }),
    getAccountContext: jest.fn().mockResolvedValue({
      provider: 'alibaba_cloud',
      accountUid: null,
      accountUidResolved: false,
      defaultRegion: 'cn-hangzhou',
      defaultZoneId: 'cn-hangzhou-h',
      accessKeyId: 'test-ak',
      accessKeySecret: 'test-sk',
    }),
  };
}

function createPrismaRepositoryMock() {
  return {
    cloudImageSnapshot: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      upsert: jest.fn(),
      deleteMany: jest.fn(),
    },
    imageCatalogItem: {
      findMany: jest.fn(),
      upsert: jest.fn(),
    },
  };
}

describe('Admin image catalog persistence boundary', () => {
  it('normalizes blank accountUid values to the unscoped sentinel', () => {
    expect(toAccountScopeKey('')).toBe('__unscoped__');
    expect(toAccountScopeKey('   ')).toBe('__unscoped__');
    expect(toAccountScopeKey(null)).toBe('__unscoped__');
  });

  it('stores and lists public and custom image snapshots in the memory repository', async () => {
    const repository = createMemoryAdminRepository();
    const publicSyncedAt = new Date('2026-07-03T00:00:00.000Z');
    const publicResyncedAt = new Date('2026-07-03T00:30:00.000Z');
    const customSyncedAt = new Date('2026-07-03T01:00:00.000Z');

    await repository.reconcileImageSnapshots({
      provider: 'alibaba_cloud',
      accountUid: null,
      regionId: 'cn-hangzhou',
      scope: 'public',
      snapshots: [
        {
          imageId: 'aliyun-linux-3',
          sourceImageName: 'Alibaba Cloud Linux 3',
          osType: 'linux',
          platform: 'Alibaba Cloud Linux',
          architecture: 'x86_64',
          status: 'Available',
          isAvailable: true,
          lastSyncedAt: publicSyncedAt,
        },
      ],
    });

    await repository.reconcileImageSnapshots({
      provider: 'alibaba_cloud',
      accountUid: null,
      regionId: 'cn-hangzhou',
      scope: 'public',
      snapshots: [
        {
          imageId: 'aliyun-linux-3',
          sourceImageName: 'Alibaba Cloud Linux 3 Updated',
          osType: 'linux',
          platform: 'Alibaba Cloud Linux',
          architecture: 'x86_64',
          status: 'Deprecated',
          isAvailable: false,
          lastSyncedAt: publicResyncedAt,
        },
      ],
    });

    await repository.upsertImageSnapshots({
      provider: 'alibaba_cloud',
      accountUid: '1234567890123456',
      regionId: 'cn-hangzhou',
      scope: 'custom',
      snapshots: [
        {
          imageId: 'm-custom-001',
          sourceImageName: 'Blue Team Golden Image',
          osType: 'linux',
          platform: 'Ubuntu 22.04',
          architecture: 'x86_64',
          status: 'Creating',
          isAvailable: false,
          lastSyncedAt: customSyncedAt,
        },
      ],
    });

    await expect(
      repository.listImageSnapshots({
        provider: 'alibaba_cloud',
        regionId: 'cn-hangzhou',
        scope: 'public',
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        provider: 'alibaba_cloud',
        accountUid: null,
        regionId: 'cn-hangzhou',
        scope: 'public',
        imageId: 'aliyun-linux-3',
        sourceImageName: 'Alibaba Cloud Linux 3 Updated',
        status: 'Deprecated',
        isAvailable: false,
        lastSyncedAt: publicResyncedAt,
      }),
    ]);

    await expect(
      repository.listImageSnapshots({
        provider: 'alibaba_cloud',
        accountUid: '1234567890123456',
        regionId: 'cn-hangzhou',
        scope: 'custom',
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        provider: 'alibaba_cloud',
        accountUid: '1234567890123456',
        regionId: 'cn-hangzhou',
        scope: 'custom',
        imageId: 'm-custom-001',
        sourceImageName: 'Blue Team Golden Image',
        status: 'Creating',
        isAvailable: false,
        lastSyncedAt: customSyncedAt,
      }),
    ]);
  });

  it('collects an image snapshot into the platform catalog', async () => {
    const repository = createMemoryAdminRepository();

    const item = await repository.collectImageCatalogItem({
      displayName: 'Blue Team Ubuntu 22.04',
      provider: 'alibaba_cloud',
      scope: 'custom',
      accountUid: '1234567890123456',
      regionId: 'cn-hangzhou',
      imageId: 'm-custom-001',
      sourceSnapshotId: 'snapshot-row-1',
    });

    const recollectedItem = await repository.collectImageCatalogItem({
      displayName: 'Blue Team Ubuntu 22.04 Refreshed',
      provider: 'alibaba_cloud',
      scope: 'custom',
      accountUid: '1234567890123456',
      regionId: 'cn-hangzhou',
      imageId: 'm-custom-001',
      sourceSnapshotId: 'snapshot-row-2',
    });

    expect(recollectedItem.id).toBe(item.id);

    await expect(
      repository.listImageCatalogItems({
        provider: 'alibaba_cloud',
        scope: 'custom',
        accountUid: '1234567890123456',
        regionId: 'cn-hangzhou',
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: item.id,
        displayName: 'Blue Team Ubuntu 22.04 Refreshed',
        provider: 'alibaba_cloud',
        scope: 'custom',
        accountUid: '1234567890123456',
        regionId: 'cn-hangzhou',
        imageId: 'm-custom-001',
        sourceSnapshotId: 'snapshot-row-2',
        enabled: true,
      }),
    ]);
  });

  it('collects a platform image asset once per provider account scope region and image', async () => {
    const repository = createMemoryAdminRepository();

    await repository.reconcileImageSnapshots({
      provider: 'alibaba_cloud',
      accountUid: '1234567890',
      regionId: 'cn-hangzhou',
      scope: 'public',
      snapshots: [
        {
          imageId: 'ubuntu_24_04_x64_20G_alibase_20250618.vhd',
          sourceImageName: 'Ubuntu 24.04',
          status: 'Available',
          isAvailable: true,
          lastSyncedAt: new Date('2026-07-06T00:00:00.000Z'),
        },
      ],
    });

    const [publicSnapshot] = await repository.listImageSnapshots({
      provider: 'alibaba_cloud',
      accountUid: '1234567890',
      regionId: 'cn-hangzhou',
      scope: 'public',
    });

    const platformAssetRepository = repository as typeof repository & {
      collectPlatformImageAsset: (input: {
        snapshotId: string;
        displayName: string;
      }) => Promise<{ id: string }>;
      listPlatformImageAssets: (filter: {
        accountScopeKey: string;
        regionId: string;
      }) => Promise<
        Array<{
          imageId: string;
          displayName: string;
          enabled: boolean;
          sourceScope: string;
        }>
      >;
    };

    const firstAsset = await platformAssetRepository.collectPlatformImageAsset({
      snapshotId: publicSnapshot.id,
      displayName: 'Ubuntu 24.04',
    });
    const secondAsset = await platformAssetRepository.collectPlatformImageAsset({
      snapshotId: publicSnapshot.id,
      displayName: 'Ubuntu 24.04',
    });

    expect(secondAsset.id).toBe(firstAsset.id);

    const assets = await platformAssetRepository.listPlatformImageAssets({
      accountScopeKey: 'aliyun::1234567890',
      regionId: 'cn-hangzhou',
    });

    expect(assets).toHaveLength(1);
    expect(assets[0]).toEqual(
      expect.objectContaining({
        imageId: publicSnapshot.imageId,
        displayName: 'Ubuntu 24.04',
        enabled: true,
        sourceScope: 'public',
      }),
    );
  });

  it('returns snapshot config while leaving account identity unresolved', async () => {
    const service = new SystemConfigService(
      createFakePrismaService({
        id: 'default',
        provider: 'alibaba_cloud',
        defaultRegion: 'cn-shanghai',
        defaultZoneId: 'cn-shanghai-b',
        accessKeyId: 'test-ak',
        accessKeySecret: 'test-sk',
        createdAt: new Date('2026-07-03T00:00:00.000Z'),
        updatedAt: new Date('2026-07-03T00:00:00.000Z'),
      }) as never,
    );

    await expect(service.getAccountContext()).resolves.toEqual({
      provider: 'alibaba_cloud',
      accountUid: null,
      accountUidResolved: false,
      defaultRegion: 'cn-shanghai',
      defaultZoneId: 'cn-shanghai-b',
      accessKeyId: 'test-ak',
      accessKeySecret: 'test-sk',
    });
  });

  it('uses the unscoped sentinel in Prisma snapshot upserts when accountUid is unresolved', async () => {
    const prisma = createPrismaRepositoryMock();
    prisma.cloudImageSnapshot.upsert.mockResolvedValue({});
    const repository = new PrismaAdminRepository(prisma as never);

    await repository.reconcileImageSnapshots({
      provider: 'alibaba_cloud',
      accountUid: null,
      regionId: 'cn-hangzhou',
      scope: 'public',
      snapshots: [
        {
          imageId: 'aliyun-linux-3',
          sourceImageName: 'Alibaba Cloud Linux 3',
          lastSyncedAt: new Date('2026-07-03T00:00:00.000Z'),
        },
      ],
    });

    expect(prisma.cloudImageSnapshot.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          provider_accountScopeKey_regionId_scope_imageId: {
            provider: 'alibaba_cloud',
            accountScopeKey: '__unscoped__',
            regionId: 'cn-hangzhou',
            scope: 'public',
            imageId: 'aliyun-linux-3',
          },
        },
        create: expect.objectContaining({
          provider: 'alibaba_cloud',
          accountUid: null,
          accountScopeKey: '__unscoped__',
          regionId: 'cn-hangzhou',
          scope: 'public',
          imageId: 'aliyun-linux-3',
        }),
        update: expect.objectContaining({
          accountUid: null,
        }),
      }),
    );
  });

  it('uses the unscoped sentinel in Prisma catalog upserts when accountUid is unresolved', async () => {
    const prisma = createPrismaRepositoryMock();
    prisma.imageCatalogItem.upsert.mockResolvedValue({
      id: 'catalog-1',
      displayName: 'Alibaba Cloud Linux 3',
      imageId: 'aliyun-linux-3',
      provider: 'alibaba_cloud',
      scope: 'public',
      accountUid: null,
      regionId: 'cn-hangzhou',
      enabled: true,
      sourceSnapshotId: 'snapshot-1',
      createdAt: new Date('2026-07-03T00:00:00.000Z'),
      updatedAt: new Date('2026-07-03T00:00:00.000Z'),
    });
    const repository = new PrismaAdminRepository(prisma as never);

    await repository.collectImageCatalogItem({
      displayName: 'Alibaba Cloud Linux 3',
      provider: 'alibaba_cloud',
      scope: 'public',
      accountUid: null,
      regionId: 'cn-hangzhou',
      imageId: 'aliyun-linux-3',
      sourceSnapshotId: 'snapshot-1',
    });

    expect(prisma.imageCatalogItem.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          provider_accountScopeKey_regionId_scope_imageId: {
            provider: 'alibaba_cloud',
            accountScopeKey: '__unscoped__',
            regionId: 'cn-hangzhou',
            scope: 'public',
            imageId: 'aliyun-linux-3',
          },
        },
        create: expect.objectContaining({
          provider: 'alibaba_cloud',
          accountUid: null,
          accountScopeKey: '__unscoped__',
          regionId: 'cn-hangzhou',
          scope: 'public',
          imageId: 'aliyun-linux-3',
          sourceSnapshotId: 'snapshot-1',
        }),
        update: expect.objectContaining({
          accountUid: null,
          sourceSnapshotId: 'snapshot-1',
        }),
      }),
    );
  });

  it('uses the unscoped sentinel in Prisma snapshot reconciliation when accountUid is unresolved', async () => {
    const prisma = createPrismaRepositoryMock();
    prisma.cloudImageSnapshot.upsert.mockResolvedValue({});
    prisma.cloudImageSnapshot.deleteMany.mockResolvedValue({ count: 0 });
    const repository = new PrismaAdminRepository(prisma as never);

    await repository.reconcileImageSnapshots({
      provider: 'alibaba_cloud',
      accountUid: null,
      regionId: 'cn-hangzhou',
      scope: 'public',
      snapshots: [
        {
          imageId: 'aliyun-linux-3',
          sourceImageName: 'Alibaba Cloud Linux 3',
          lastSyncedAt: new Date('2026-07-03T00:00:00.000Z'),
        },
      ],
    });

    expect(prisma.cloudImageSnapshot.deleteMany).toHaveBeenCalledWith({
      where: {
        provider: 'alibaba_cloud',
        accountScopeKey: '__unscoped__',
        regionId: 'cn-hangzhou',
        scope: 'public',
        imageId: {
          notIn: ['aliyun-linux-3'],
        },
      },
    });
  });

  it('reconciles stale image snapshots out of the memory repository scope', async () => {
    const repository = createMemoryAdminRepository();
    const firstSyncedAt = new Date('2026-07-03T00:00:00.000Z');
    const secondSyncedAt = new Date('2026-07-03T00:30:00.000Z');

    await repository.reconcileImageSnapshots({
      provider: 'alibaba_cloud',
      accountUid: null,
      regionId: 'cn-hangzhou',
      scope: 'public',
      snapshots: [
        {
          imageId: 'stale-image',
          sourceImageName: 'Stale Image',
          lastSyncedAt: firstSyncedAt,
        },
        {
          imageId: 'keep-image',
          sourceImageName: 'Keep Image',
          lastSyncedAt: firstSyncedAt,
        },
      ],
    });

    await repository.reconcileImageSnapshots({
      provider: 'alibaba_cloud',
      accountUid: null,
      regionId: 'cn-hangzhou',
      scope: 'public',
      snapshots: [
        {
          imageId: 'keep-image',
          sourceImageName: 'Keep Image Refreshed',
          lastSyncedAt: secondSyncedAt,
        },
      ],
    });

    await expect(
      repository.listImageSnapshots({
        provider: 'alibaba_cloud',
        accountUid: null,
        regionId: 'cn-hangzhou',
        scope: 'public',
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        imageId: 'keep-image',
        sourceImageName: 'Keep Image Refreshed',
        lastSyncedAt: secondSyncedAt,
      }),
    ]);
  });

  it('matches the official Alibaba Cloud RPC signature example vector', () => {
    const query = signAliyunRpcQuery(
      {
        Action: 'DescribeDedicatedHosts',
        AccessKeyId: 'testid',
        Format: 'JSON',
        RegionId: 'cn-beijing',
        SignatureMethod: 'HMAC-SHA1',
        SignatureNonce: 'edb2b34af0af9a6d14deaf7c1a5315eb',
        SignatureVersion: '1.0',
        Timestamp: '2023-03-13T08:34:30Z',
        Version: '2014-05-26',
      },
      'testsecret',
    );

    expect(query).toContain('Signature=9NaGiOspFP5UPcwX8Iwt2YJXXuk%3D');
  });
});

describe('Admin image catalog API', () => {
  let fetchMock: jest.Mock;

  beforeAll(async () => {
    process.env.ADMIN_TOKEN = 'dev-admin-token';
    fetchMock = jest.fn();
    global.fetch = fetchMock as typeof global.fetch;
  });

  beforeEach(() => {
    fetchMock.mockReset();
  });

  async function createFixture() {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(ADMIN_REPOSITORY)
      .useValue(createMemoryAdminRepository())
      .overrideProvider(SystemConfigService)
      .useValue(createSystemConfigServiceStub())
      .compile();

    const app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();

    return {
      app,
      repository: app.get<AdminRepository>(ADMIN_REPOSITORY),
    };
  }

  it('returns current persisted public snapshot and catalog rows', async () => {
    const { app, repository } = await createFixture();
    const syncedAt = new Date('2026-07-03T02:00:00.000Z');

    await repository.reconcileImageSnapshots({
      provider: 'alibaba_cloud',
      accountUid: null,
      regionId: 'cn-hangzhou',
      scope: 'public',
      snapshots: [
        {
          imageId: 'aliyun-linux-3',
          sourceImageName: 'Alibaba Cloud Linux 3',
          osType: 'linux',
          platform: 'Alibaba Cloud Linux',
          architecture: 'x86_64',
          status: 'Available',
          isAvailable: true,
          lastSyncedAt: syncedAt,
        },
      ],
    });
    const snapshot = (
      await repository.listImageSnapshots({
        provider: 'alibaba_cloud',
        accountUid: null,
        regionId: 'cn-hangzhou',
        scope: 'public',
      })
    )[0];
    await repository.collectImageCatalogItem({
      displayName: 'Alibaba Cloud Linux 3',
      provider: 'alibaba_cloud',
      scope: 'public',
      accountUid: null,
      regionId: 'cn-hangzhou',
      imageId: 'aliyun-linux-3',
      sourceSnapshotId: snapshot.id,
    });

    const response = await request(app.getHttpServer())
      .get('/admin/image-catalog/public')
      .set('authorization', 'Bearer dev-admin-token')
      .expect(200);

    expect(response.body).toEqual({
      snapshots: [
        expect.objectContaining({
          provider: 'alibaba_cloud',
          accountUid: null,
          regionId: 'cn-hangzhou',
          scope: 'public',
          imageId: 'aliyun-linux-3',
          sourceImageName: 'Alibaba Cloud Linux 3',
          isAvailable: true,
        }),
      ],
      catalogItems: [
        expect.objectContaining({
          displayName: 'Alibaba Cloud Linux 3',
          provider: 'alibaba_cloud',
          scope: 'public',
          accountUid: null,
          regionId: 'cn-hangzhou',
          imageId: 'aliyun-linux-3',
          sourceSnapshotId: snapshot.id,
        }),
      ],
    });

    await app.close();
  });

  it('returns current persisted custom snapshot and catalog rows', async () => {
    const { app, repository } = await createFixture();
    const syncedAt = new Date('2026-07-03T03:00:00.000Z');

    await repository.upsertImageSnapshots({
      provider: 'alibaba_cloud',
      accountUid: null,
      regionId: 'cn-hangzhou',
      scope: 'custom',
      snapshots: [
        {
          imageId: 'm-custom-001',
          sourceImageName: 'Blue Team Golden Image',
          osType: 'linux',
          platform: 'Ubuntu 22.04',
          architecture: 'x86_64',
          status: 'Creating',
          isAvailable: false,
          lastSyncedAt: syncedAt,
        },
      ],
    });
    const snapshot = (
      await repository.listImageSnapshots({
        provider: 'alibaba_cloud',
        accountUid: null,
        regionId: 'cn-hangzhou',
        scope: 'custom',
      })
    )[0];
    await repository.collectImageCatalogItem({
      displayName: 'Blue Team Golden Image',
      provider: 'alibaba_cloud',
      scope: 'custom',
      accountUid: null,
      regionId: 'cn-hangzhou',
      imageId: 'm-custom-001',
      sourceSnapshotId: snapshot.id,
    });

    const response = await request(app.getHttpServer())
      .get('/admin/image-catalog/custom')
      .set('authorization', 'Bearer dev-admin-token')
      .expect(200);

    expect(response.body).toEqual({
      snapshots: [
        expect.objectContaining({
          provider: 'alibaba_cloud',
          accountUid: null,
          regionId: 'cn-hangzhou',
          scope: 'custom',
          imageId: 'm-custom-001',
          sourceImageName: 'Blue Team Golden Image',
          isAvailable: false,
        }),
      ],
      catalogItems: [
        expect.objectContaining({
          displayName: 'Blue Team Golden Image',
          provider: 'alibaba_cloud',
          scope: 'custom',
          accountUid: null,
          regionId: 'cn-hangzhou',
          imageId: 'm-custom-001',
          sourceSnapshotId: snapshot.id,
        }),
      ],
    });

    await app.close();
  });

  it('syncs public images from Aliyun and returns updated scope payload', async () => {
    const { app, repository } = await createFixture();
    await repository.upsertImageSnapshots({
      provider: 'alibaba_cloud',
      accountUid: null,
      regionId: 'cn-hangzhou',
      scope: 'public',
      snapshots: [
        {
          imageId: 'stale-public-image',
          sourceImageName: 'Stale Public Image',
          lastSyncedAt: new Date('2026-07-02T23:00:00.000Z'),
        },
      ],
    });

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          Images: {
            Image: [
              {
                ImageId: 'aliyun-linux-3',
                ImageName: 'Alibaba Cloud Linux 3',
                OSType: 'linux',
                Platform: 'Alibaba Cloud Linux',
                Architecture: 'x86_64',
                Status: 'Available',
              },
            ],
          },
          TotalCount: 101,
          PageNumber: 1,
          PageSize: 100,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          Images: {
            Image: [
              {
                ImageId: 'ubuntu_22_04_x64_20G_alibase_20260101.vhd',
                ImageName: 'Ubuntu 22.04 LTS 64 bit',
                OSType: 'linux',
                Platform: 'Ubuntu 22.04',
                Architecture: 'x86_64',
                Status: 'Deprecated',
              },
            ],
          },
          TotalCount: 101,
          PageNumber: 2,
          PageSize: 100,
        }),
      });

    const response = await request(app.getHttpServer())
      .post('/admin/image-catalog/public/sync')
      .set('authorization', 'Bearer dev-admin-token')
      .expect(201);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toEqual(expect.stringContaining('ImageOwnerAlias=system'));
    expect(fetchMock.mock.calls[1]?.[0]).toEqual(expect.stringContaining('PageNumber=2'));
    expect(new URL(fetchMock.mock.calls[0]?.[0] as string).searchParams.get('Timestamp')).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
    );
    expect(response.body).toEqual({
      snapshots: expect.arrayContaining([
        expect.objectContaining({
          imageId: 'aliyun-linux-3',
          scope: 'public',
          sourceImageName: 'Alibaba Cloud Linux 3',
          status: 'Available',
          isAvailable: true,
        }),
        expect.objectContaining({
          imageId: 'ubuntu_22_04_x64_20G_alibase_20260101.vhd',
          scope: 'public',
          sourceImageName: 'Ubuntu 22.04 LTS 64 bit',
          status: 'Deprecated',
          isAvailable: false,
        }),
      ]),
      catalogItems: [],
    });
    expect(response.body.snapshots).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          imageId: 'stale-public-image',
        }),
      ]),
    );
    await expect(
      repository.listImageSnapshots({
        provider: 'alibaba_cloud',
        accountUid: null,
        regionId: 'cn-hangzhou',
        scope: 'public',
      }),
    ).resolves.not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          imageId: 'stale-public-image',
        }),
      ]),
    );

    await app.close();
  });

  it('syncs custom images from Aliyun and returns updated scope payload', async () => {
    const { app } = await createFixture();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        Images: {
          Image: [
            {
              ImageId: 'm-custom-001',
              ImageName: 'Blue Team Ubuntu 22.04',
              OSType: 'linux',
              Platform: 'Ubuntu 22.04',
              Architecture: 'x86_64',
              Status: 'Available',
            },
          ],
        },
        TotalCount: 1,
        PageNumber: 1,
        PageSize: 100,
      }),
    });

    const response = await request(app.getHttpServer())
      .post('/admin/image-catalog/custom/sync')
      .set('authorization', 'Bearer dev-admin-token')
      .expect(201);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toEqual(expect.stringContaining('ImageOwnerAlias=self'));
    expect(response.body).toEqual({
      snapshots: [
        expect.objectContaining({
          imageId: 'm-custom-001',
          scope: 'custom',
          sourceImageName: 'Blue Team Ubuntu 22.04',
          status: 'Available',
          isAvailable: true,
        }),
      ],
      catalogItems: [],
    });

    await app.close();
  });

  it('collects a snapshot into the catalog and returns the catalog item', async () => {
    const { app, repository } = await createFixture();
    const syncedAt = new Date('2026-07-03T04:00:00.000Z');

    await repository.upsertImageSnapshots({
      provider: 'alibaba_cloud',
      accountUid: null,
      regionId: 'cn-hangzhou',
      scope: 'custom',
      snapshots: [
        {
          imageId: 'm-custom-collect-001',
          sourceImageName: 'Blue Team Ubuntu 24.04',
          osType: 'linux',
          platform: 'Ubuntu 24.04',
          architecture: 'x86_64',
          status: 'Available',
          isAvailable: true,
          lastSyncedAt: syncedAt,
        },
      ],
    });
    const snapshot = (
      await repository.listImageSnapshots({
        provider: 'alibaba_cloud',
        accountUid: null,
        regionId: 'cn-hangzhou',
        scope: 'custom',
        imageId: 'm-custom-collect-001',
      })
    )[0];

    const response = await request(app.getHttpServer())
      .post('/admin/image-catalog/collect')
      .set('authorization', 'Bearer dev-admin-token')
      .send({
        snapshotId: snapshot.id,
        displayName: 'Blue Team Ubuntu 24.04',
      })
      .expect(201);

    expect(response.body).toEqual(
      expect.objectContaining({
        displayName: 'Blue Team Ubuntu 24.04',
        provider: 'alibaba_cloud',
        scope: 'custom',
        accountUid: null,
        regionId: 'cn-hangzhou',
        imageId: 'm-custom-collect-001',
        sourceSnapshotId: snapshot.id,
        enabled: true,
      }),
    );

    await app.close();
  });

  it('returns 404 when collecting a missing snapshot', async () => {
    const { app } = await createFixture();
    await request(app.getHttpServer())
      .post('/admin/image-catalog/collect')
      .set('authorization', 'Bearer dev-admin-token')
      .send({
        snapshotId: 'missing-snapshot-id',
        displayName: 'Missing Image',
      })
      .expect(404);

    await app.close();
  });

  it('returns 400 when collect body is malformed', async () => {
    const { app } = await createFixture();

    await request(app.getHttpServer())
      .post('/admin/image-catalog/collect')
      .set('authorization', 'Bearer dev-admin-token')
      .send({
        snapshotId: '',
        displayName: '   ',
      })
      .expect(400);

    await app.close();
  });
});
