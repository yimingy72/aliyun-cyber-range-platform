import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { ADMIN_REPOSITORY, type AdminRepository } from '../src/admin/admin.repository';
import { SystemConfigService } from '../src/admin/system-config.service';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap/configure-app';
import { toAccountScopeKey } from '../src/admin/image-account-scope';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';

function createSystemConfigServiceStub() {
  return {
    getAccountContext: jest.fn().mockResolvedValue({
      provider: 'alibaba_cloud',
      accountUid: '1234567890',
      accountUidResolved: true,
      defaultRegion: 'cn-hangzhou',
      defaultZoneId: 'cn-hangzhou-h',
      accessKeyId: 'test-ak',
      accessKeySecret: 'test-sk',
    }),
  };
}

function createJsonResponse(payload: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(payload),
  } as unknown as Response;
}

async function createApp(repository: AdminRepository) {
  process.env.ADMIN_USERNAME = 'admin';
  process.env.ADMIN_PASSWORD = 'change-me';
  process.env.ADMIN_TOKEN = 'dev-admin-token';

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(ADMIN_REPOSITORY)
    .useValue(repository)
    .overrideProvider(SystemConfigService)
    .useValue(createSystemConfigServiceStub())
    .compile();

  const app = moduleRef.createNestApplication();
  configureApp(app);
  await app.init();

  return app;
}

describe('Admin image catalog platform asset persistence baseline', () => {
  it('collects a platform image asset once per provider account scope region and image', async () => {
    const repository = createMemoryAdminRepository();
    const accountUid = '1234567890';

    await repository.reconcileImageSnapshots({
      provider: 'alibaba_cloud',
      accountUid,
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
      accountUid,
      regionId: 'cn-hangzhou',
      scope: 'public',
    });

    const firstAsset = await repository.collectPlatformImageAsset({
      snapshotId: publicSnapshot.id,
      displayName: 'Ubuntu 24.04',
    });

    const secondAsset = await repository.collectPlatformImageAsset({
      snapshotId: publicSnapshot.id,
      displayName: 'Ubuntu 24.04',
    });

    expect(secondAsset.id).toBe(firstAsset.id);

    const assets = await repository.listPlatformImageAssets({
      accountScopeKey: toAccountScopeKey(accountUid),
      regionId: 'cn-hangzhou',
    });

    expect(assets).toHaveLength(1);
    expect(assets[0]).toEqual(
      expect.objectContaining({
        id: firstAsset.id,
        imageId: publicSnapshot.imageId,
        displayName: 'Ubuntu 24.04',
        enabled: true,
        sourceScope: 'public',
      }),
    );

    await repository.updatePlatformImageAsset(firstAsset.id, {
      displayName: 'Ubuntu 24.04 LTS',
    });

    await repository.setPlatformImageAssetEnabled(firstAsset.id, false);

    const updatedAssets = await repository.listPlatformImageAssets({
      accountScopeKey: toAccountScopeKey(accountUid),
      regionId: 'cn-hangzhou',
    });

    expect(updatedAssets).toHaveLength(1);
    expect(updatedAssets[0]).toEqual(
      expect.objectContaining({
        id: firstAsset.id,
        displayName: 'Ubuntu 24.04 LTS',
        enabled: false,
      }),
    );

    await repository.deletePlatformImageAsset(firstAsset.id);

    const assetsAfterDeletion = await repository.listPlatformImageAssets({
      accountScopeKey: toAccountScopeKey(accountUid),
      regionId: 'cn-hangzhou',
    });

    expect(assetsAfterDeletion).toHaveLength(0);
  });

  it('nulls sourceSnapshotId when the source snapshot is reconciled away', async () => {
    const repository = createMemoryAdminRepository();
    const accountUid = '1234567890';

    await repository.reconcileImageSnapshots({
      provider: 'alibaba_cloud',
      accountUid,
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

    const [snapshot] = await repository.listImageSnapshots({
      provider: 'alibaba_cloud',
      accountUid,
      regionId: 'cn-hangzhou',
      scope: 'public',
    });

    const asset = await repository.collectPlatformImageAsset({
      snapshotId: snapshot.id,
      displayName: 'Ubuntu 24.04',
    });

    await repository.reconcileImageSnapshots({
      provider: 'alibaba_cloud',
      accountUid,
      regionId: 'cn-hangzhou',
      scope: 'public',
      snapshots: [],
    });

    const [remainingAsset] = await repository.listPlatformImageAssets({
      accountScopeKey: toAccountScopeKey(accountUid),
      regionId: 'cn-hangzhou',
    });

    expect(remainingAsset).toEqual(
      expect.objectContaining({
        id: asset.id,
        sourceSnapshotId: null,
      }),
    );
  });

  it('throws not-found errors for missing platform image asset ids', async () => {
    const repository = createMemoryAdminRepository();

    await expect(
      repository.updatePlatformImageAsset('missing-asset-id', {
        displayName: 'Ubuntu 24.04 LTS',
      }),
    ).rejects.toThrow(/not found/i);

    await expect(repository.setPlatformImageAssetEnabled('missing-asset-id', false)).rejects.toThrow(/not found/i);

    await expect(repository.deletePlatformImageAsset('missing-asset-id')).rejects.toThrow(/not found/i);
  });
});

describe('Admin image catalog APIs', () => {
  let app: INestApplication;
  let repository: AdminRepository;
  const originalFetch = global.fetch;

  afterEach(async () => {
    if (app) {
      await app.close();
    }

    global.fetch = originalFetch;
  });

  it('GET /admin/platform-images returns platform assets for the configured account and region', async () => {
    repository = createMemoryAdminRepository();

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

    const [snapshot] = await repository.listImageSnapshots({
      provider: 'alibaba_cloud',
      accountUid: '1234567890',
      regionId: 'cn-hangzhou',
      scope: 'public',
    });

    await repository.collectPlatformImageAsset({
      snapshotId: snapshot.id,
      displayName: 'Ubuntu 24.04 LTS',
    });

    await repository.collectPlatformImageAsset({
      snapshotId: snapshot.id,
      displayName: 'Ubuntu 24.04 LTS',
    });

    app = await createApp(repository);

    const response = await request(app.getHttpServer())
      .get('/admin/platform-images')
      .set('authorization', 'Bearer dev-admin-token')
      .expect(200);

    expect(response.body).toEqual({
      items: [
        expect.objectContaining({
          provider: 'alibaba_cloud',
          accountUid: '1234567890',
          accountScopeKey: toAccountScopeKey('1234567890'),
          regionId: 'cn-hangzhou',
          sourceScope: 'public',
          sourceSnapshotId: snapshot.id,
          imageId: 'ubuntu_24_04_x64_20G_alibase_20250618.vhd',
          displayName: 'Ubuntu 24.04 LTS',
          enabled: true,
        }),
      ],
    });
  });

  it('supports collect rename enable disable and delete for platform image assets', async () => {
    repository = createMemoryAdminRepository();

    await repository.reconcileImageSnapshots({
      provider: 'alibaba_cloud',
      accountUid: '1234567890',
      regionId: 'cn-hangzhou',
      scope: 'custom',
      snapshots: [
        {
          imageId: 'm-bp1platformasset',
          sourceImageName: 'Base Custom Image',
          status: 'Available',
          isAvailable: true,
          lastSyncedAt: new Date('2026-07-06T00:00:00.000Z'),
        },
      ],
    });

    const [snapshot] = await repository.listImageSnapshots({
      provider: 'alibaba_cloud',
      accountUid: '1234567890',
      regionId: 'cn-hangzhou',
      scope: 'custom',
    });

    app = await createApp(repository);

    const collectResponse = await request(app.getHttpServer())
      .post('/admin/platform-images')
      .set('authorization', 'Bearer dev-admin-token')
      .send({
        snapshotId: snapshot.id,
        displayName: 'Custom Base Image',
      })
      .expect(201);

    expect(collectResponse.body).toEqual(
      expect.objectContaining({
        sourceSnapshotId: snapshot.id,
        displayName: 'Custom Base Image',
        enabled: true,
      }),
    );

    const assetId = collectResponse.body.id as string;

    await request(app.getHttpServer())
      .patch(`/admin/platform-images/${assetId}`)
      .set('authorization', 'Bearer dev-admin-token')
      .send({ displayName: 'Custom Base Image Renamed' })
      .expect(200)
      .expect(({ body }) => {
        expect(body).toEqual(
          expect.objectContaining({
            id: assetId,
            displayName: 'Custom Base Image Renamed',
          }),
        );
      });

    await request(app.getHttpServer())
      .post(`/admin/platform-images/${assetId}/disable`)
      .set('authorization', 'Bearer dev-admin-token')
      .expect(201)
      .expect(({ body }) => {
        expect(body).toEqual(
          expect.objectContaining({
            id: assetId,
            enabled: false,
          }),
        );
      });

    await request(app.getHttpServer())
      .post(`/admin/platform-images/${assetId}/enable`)
      .set('authorization', 'Bearer dev-admin-token')
      .expect(201)
      .expect(({ body }) => {
        expect(body).toEqual(
          expect.objectContaining({
            id: assetId,
            enabled: true,
          }),
        );
      });

    await request(app.getHttpServer())
      .delete(`/admin/platform-images/${assetId}`)
      .set('authorization', 'Bearer dev-admin-token')
      .expect(204)
      .expect('');

    const listResponse = await request(app.getHttpServer())
      .get('/admin/platform-images')
      .set('authorization', 'Bearer dev-admin-token')
      .expect(200);

    expect(listResponse.body).toEqual({ items: [] });
  });

  it('rejects collecting a platform image asset from a snapshot outside the current account and region scope', async () => {
    repository = createMemoryAdminRepository();

    await repository.reconcileImageSnapshots({
      provider: 'alibaba_cloud',
      accountUid: 'foreign-account',
      regionId: 'cn-shanghai',
      scope: 'custom',
      snapshots: [
        {
          imageId: 'm-foreignsnapshot',
          sourceImageName: 'Foreign Snapshot',
          status: 'Available',
          isAvailable: true,
          lastSyncedAt: new Date('2026-07-06T00:00:00.000Z'),
        },
      ],
    });

    const [snapshot] = await repository.listImageSnapshots({
      provider: 'alibaba_cloud',
      accountUid: 'foreign-account',
      regionId: 'cn-shanghai',
      scope: 'custom',
    });

    app = await createApp(repository);

    await request(app.getHttpServer())
      .post('/admin/platform-images')
      .set('authorization', 'Bearer dev-admin-token')
      .send({
        snapshotId: snapshot.id,
        displayName: 'Should Not Collect',
      })
      .expect(404);

    const listResponse = await request(app.getHttpServer())
      .get('/admin/platform-images')
      .set('authorization', 'Bearer dev-admin-token')
      .expect(200);

    expect(listResponse.body).toEqual({ items: [] });
  });

  it('rejects platform asset mutations for assets outside the current account and region scope', async () => {
    repository = createMemoryAdminRepository();

    await repository.reconcileImageSnapshots({
      provider: 'alibaba_cloud',
      accountUid: 'foreign-account',
      regionId: 'cn-shanghai',
      scope: 'custom',
      snapshots: [
        {
          imageId: 'm-foreignasset',
          sourceImageName: 'Foreign Asset Source',
          status: 'Available',
          isAvailable: true,
          lastSyncedAt: new Date('2026-07-06T00:00:00.000Z'),
        },
      ],
    });

    const [snapshot] = await repository.listImageSnapshots({
      provider: 'alibaba_cloud',
      accountUid: 'foreign-account',
      regionId: 'cn-shanghai',
      scope: 'custom',
    });

    const asset = await repository.collectPlatformImageAsset({
      snapshotId: snapshot.id,
      displayName: 'Foreign Asset',
    });

    app = await createApp(repository);

    await request(app.getHttpServer())
      .patch(`/admin/platform-images/${asset.id}`)
      .set('authorization', 'Bearer dev-admin-token')
      .send({ displayName: 'Renamed Foreign Asset' })
      .expect(404);

    await request(app.getHttpServer())
      .post(`/admin/platform-images/${asset.id}/disable`)
      .set('authorization', 'Bearer dev-admin-token')
      .expect(404);

    await request(app.getHttpServer())
      .post(`/admin/platform-images/${asset.id}/enable`)
      .set('authorization', 'Bearer dev-admin-token')
      .expect(404);

    await request(app.getHttpServer())
      .delete(`/admin/platform-images/${asset.id}`)
      .set('authorization', 'Bearer dev-admin-token')
      .expect(404);

    const foreignAssets = await repository.listPlatformImageAssets({
      accountScopeKey: toAccountScopeKey('foreign-account'),
      regionId: 'cn-shanghai',
    });

    expect(foreignAssets).toEqual([
      expect.objectContaining({
        id: asset.id,
        displayName: 'Foreign Asset',
        enabled: true,
      }),
    ]);
  });

  it('DELETE /admin/image-catalog/custom/:snapshotId removes linked platform assets after cloud delete succeeds', async () => {
    repository = createMemoryAdminRepository();
    global.fetch = jest.fn().mockResolvedValue(createJsonResponse({ RequestId: 'delete-ok' }));

    await repository.reconcileImageSnapshots({
      provider: 'alibaba_cloud',
      accountUid: '1234567890',
      regionId: 'cn-hangzhou',
      scope: 'custom',
      snapshots: [
        {
          imageId: 'm-bp1deletecustom',
          sourceImageName: 'Delete Me',
          status: 'Available',
          isAvailable: true,
          lastSyncedAt: new Date('2026-07-06T00:00:00.000Z'),
        },
      ],
    });

    const [snapshot] = await repository.listImageSnapshots({
      provider: 'alibaba_cloud',
      accountUid: '1234567890',
      regionId: 'cn-hangzhou',
      scope: 'custom',
    });

    await repository.collectPlatformImageAsset({
      snapshotId: snapshot.id,
      displayName: 'Delete Me Asset',
    });

    app = await createApp(repository);

    await request(app.getHttpServer())
      .delete(`/admin/image-catalog/custom/${snapshot.id}`)
      .set('authorization', 'Bearer dev-admin-token')
      .expect(204)
      .expect('');

    const [remainingSnapshot] = await repository.listImageSnapshots({
      provider: 'alibaba_cloud',
      accountUid: '1234567890',
      regionId: 'cn-hangzhou',
      scope: 'custom',
    });
    const remainingAssets = await repository.listPlatformImageAssets({
      accountScopeKey: toAccountScopeKey('1234567890'),
      regionId: 'cn-hangzhou',
    });

    expect(remainingSnapshot).toBeUndefined();
    expect(remainingAssets).toEqual([]);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('Action=DeleteImage'),
      expect.objectContaining({ method: 'GET' }),
    );
  });
});
