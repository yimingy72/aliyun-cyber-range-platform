import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { hashPassword } from '../src/admin/admin-user-auth';
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

async function loginAs(app: INestApplication, username = 'admin', password = 'change-me') {
  const response = await request(app.getHttpServer())
    .post('/admin/session')
    .send({ username, password })
    .expect(200);

  return response.body.token as string;
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

  it('GET /admin/platform-images distinguishes view=platform and view=mine for the current user', async () => {
    repository = createMemoryAdminRepository();

    await repository.reconcileImageSnapshots({
      provider: 'alibaba_cloud',
      accountUid: '1234567890',
      regionId: 'cn-hangzhou',
      scope: 'custom',
      snapshots: [
        {
          imageId: 'm-platform-image',
          sourceImageName: 'Ubuntu Platform',
          status: 'Available',
          isAvailable: true,
          lastSyncedAt: new Date('2026-07-06T00:00:00.000Z'),
        },
        {
          imageId: 'm-private-image',
          sourceImageName: 'Ubuntu Private',
          status: 'Available',
          isAvailable: true,
          lastSyncedAt: new Date('2026-07-06T00:00:01.000Z'),
        },
      ],
    });

    const snapshots = await repository.listImageSnapshots({
      provider: 'alibaba_cloud',
      accountUid: '1234567890',
      regionId: 'cn-hangzhou',
      scope: 'custom',
    });
    const platformSnapshot = snapshots.find((item) => item.imageId === 'm-platform-image');
    const privateSnapshot = snapshots.find((item) => item.imageId === 'm-private-image');

    expect(platformSnapshot).toBeDefined();
    expect(privateSnapshot).toBeDefined();

    await repository.collectPlatformImageAsset({
      snapshotId: platformSnapshot!.id,
      displayName: 'Ubuntu Platform',
      visibility: 'platform',
    });

    await repository.collectPlatformImageAsset({
      snapshotId: privateSnapshot!.id,
      displayName: 'Ubuntu Private',
      ownerUserId: 'admin',
      visibility: 'private',
    });

    app = await createApp(repository);
    const adminToken = await loginAs(app);

    const platformResponse = await request(app.getHttpServer())
      .get('/admin/platform-images?view=platform')
      .set('authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(platformResponse.body).toEqual({
      items: [
        expect.objectContaining({
          provider: 'alibaba_cloud',
          accountUid: '1234567890',
          accountScopeKey: toAccountScopeKey('1234567890'),
          regionId: 'cn-hangzhou',
          sourceScope: 'custom',
          sourceSnapshotId: platformSnapshot!.id,
          imageId: 'm-platform-image',
          displayName: 'Ubuntu Platform',
          visibility: 'platform',
          ownerUserId: null,
          enabled: true,
        }),
      ],
    });

    const mineResponse = await request(app.getHttpServer())
      .get('/admin/platform-images?view=mine')
      .set('authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(mineResponse.body).toEqual({
      items: [
        expect.objectContaining({
          provider: 'alibaba_cloud',
          accountUid: '1234567890',
          accountScopeKey: toAccountScopeKey('1234567890'),
          regionId: 'cn-hangzhou',
          sourceScope: 'custom',
          sourceSnapshotId: privateSnapshot!.id,
          imageId: 'm-private-image',
          displayName: 'Ubuntu Private',
          visibility: 'private',
          ownerUserId: 'admin',
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
    const adminToken = await loginAs(app);

    const collectResponse = await request(app.getHttpServer())
      .post('/admin/platform-images')
      .set('authorization', `Bearer ${adminToken}`)
      .send({
        snapshotId: snapshot.id,
        displayName: 'Custom Base Image',
      })
      .expect(201);

    expect(collectResponse.body).toEqual(
      expect.objectContaining({
        sourceSnapshotId: snapshot.id,
        displayName: 'Custom Base Image',
        visibility: 'platform',
        ownerUserId: null,
        enabled: true,
      }),
    );

    const assetId = collectResponse.body.id as string;

    await request(app.getHttpServer())
      .patch(`/admin/platform-images/${assetId}`)
      .set('authorization', `Bearer ${adminToken}`)
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
      .set('authorization', `Bearer ${adminToken}`)
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
      .set('authorization', `Bearer ${adminToken}`)
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
      .set('authorization', `Bearer ${adminToken}`)
      .expect(204)
      .expect('');

    const listResponse = await request(app.getHttpServer())
      .get('/admin/platform-images')
      .set('authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(listResponse.body).toEqual({ items: [] });
  });

  it('allows an owner to publish their own private image asset', async () => {
    repository = createMemoryAdminRepository();

    await repository.createPlatformUser({
      id: 'image-owner-1',
      username: 'image-owner',
      passwordHash: hashPassword('owner-password'),
      role: 'user',
      status: 'active',
    });

    await repository.reconcileImageSnapshots({
      provider: 'alibaba_cloud',
      accountUid: '1234567890',
      regionId: 'cn-hangzhou',
      scope: 'custom',
      snapshots: [
        {
          imageId: 'm-owner-private-image',
          sourceImageName: 'Owner Private Image',
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

    const asset = await repository.collectPlatformImageAsset({
      snapshotId: snapshot.id,
      displayName: 'Owner Private Image',
      ownerUserId: 'image-owner-1',
      visibility: 'private',
    });

    app = await createApp(repository);
    const ownerToken = await loginAs(app, 'image-owner', 'owner-password');

    await request(app.getHttpServer())
      .post(`/admin/platform-images/${asset.id}/publish`)
      .set('authorization', `Bearer ${ownerToken}`)
      .expect(200)
      .expect(({ body }) => {
        expect(body).toEqual(
          expect.objectContaining({
            id: asset.id,
            displayName: 'Owner Private Image',
            ownerUserId: 'image-owner-1',
            visibility: 'platform',
          }),
        );
      });

    const platformResponse = await request(app.getHttpServer())
      .get('/admin/platform-images?view=platform')
      .set('authorization', `Bearer ${ownerToken}`)
      .expect(200);

    expect(platformResponse.body).toEqual({
      items: [
        expect.objectContaining({
          id: asset.id,
          ownerUserId: 'image-owner-1',
          visibility: 'platform',
        }),
      ],
    });
  });

  it('allows an owner to unpublish their own platform image asset back to private', async () => {
    repository = createMemoryAdminRepository();

    await repository.createPlatformUser({
      id: 'image-owner-2',
      username: 'image-owner-two',
      passwordHash: hashPassword('owner-password'),
      role: 'user',
      status: 'active',
    });

    await repository.reconcileImageSnapshots({
      provider: 'alibaba_cloud',
      accountUid: '1234567890',
      regionId: 'cn-hangzhou',
      scope: 'custom',
      snapshots: [
        {
          imageId: 'm-owner-platform-image',
          sourceImageName: 'Owner Platform Image',
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

    const asset = await repository.collectPlatformImageAsset({
      snapshotId: snapshot.id,
      displayName: 'Owner Platform Image',
      ownerUserId: 'image-owner-2',
      visibility: 'platform',
    });

    app = await createApp(repository);
    const ownerToken = await loginAs(app, 'image-owner-two', 'owner-password');

    await request(app.getHttpServer())
      .post(`/admin/platform-images/${asset.id}/unpublish`)
      .set('authorization', `Bearer ${ownerToken}`)
      .expect(200)
      .expect(({ body }) => {
        expect(body).toEqual(
          expect.objectContaining({
            id: asset.id,
            ownerUserId: 'image-owner-2',
            visibility: 'private',
          }),
        );
      });

    const platformResponse = await request(app.getHttpServer())
      .get('/admin/platform-images?view=platform')
      .set('authorization', `Bearer ${ownerToken}`)
      .expect(200);

    expect(platformResponse.body).toEqual({ items: [] });
  });

  it('prevents a non-owner user from publishing or unpublishing another user image asset', async () => {
    repository = createMemoryAdminRepository();

    await repository.createPlatformUser({
      id: 'image-owner-3',
      username: 'image-owner-three',
      passwordHash: hashPassword('owner-password'),
      role: 'user',
      status: 'active',
    });
    await repository.createPlatformUser({
      id: 'image-viewer-1',
      username: 'image-viewer',
      passwordHash: hashPassword('viewer-password'),
      role: 'user',
      status: 'active',
    });

    await repository.reconcileImageSnapshots({
      provider: 'alibaba_cloud',
      accountUid: '1234567890',
      regionId: 'cn-hangzhou',
      scope: 'custom',
      snapshots: [
        {
          imageId: 'm-other-private-image',
          sourceImageName: 'Other Private Image',
          status: 'Available',
          isAvailable: true,
          lastSyncedAt: new Date('2026-07-06T00:00:00.000Z'),
        },
        {
          imageId: 'm-other-platform-image',
          sourceImageName: 'Other Platform Image',
          status: 'Available',
          isAvailable: true,
          lastSyncedAt: new Date('2026-07-06T00:00:01.000Z'),
        },
      ],
    });

    const snapshots = await repository.listImageSnapshots({
      provider: 'alibaba_cloud',
      accountUid: '1234567890',
      regionId: 'cn-hangzhou',
      scope: 'custom',
    });
    const privateSnapshot = snapshots.find((item) => item.imageId === 'm-other-private-image');
    const platformSnapshot = snapshots.find((item) => item.imageId === 'm-other-platform-image');

    expect(privateSnapshot).toBeDefined();
    expect(platformSnapshot).toBeDefined();

    const privateAsset = await repository.collectPlatformImageAsset({
      snapshotId: privateSnapshot!.id,
      displayName: 'Other Private Image',
      ownerUserId: 'image-owner-3',
      visibility: 'private',
    });
    const platformAsset = await repository.collectPlatformImageAsset({
      snapshotId: platformSnapshot!.id,
      displayName: 'Other Platform Image',
      ownerUserId: 'image-owner-3',
      visibility: 'platform',
    });

    app = await createApp(repository);
    const viewerToken = await loginAs(app, 'image-viewer', 'viewer-password');

    await request(app.getHttpServer())
      .post(`/admin/platform-images/${privateAsset.id}/publish`)
      .set('authorization', `Bearer ${viewerToken}`)
      .expect(404);

    await request(app.getHttpServer())
      .post(`/admin/platform-images/${platformAsset.id}/unpublish`)
      .set('authorization', `Bearer ${viewerToken}`)
      .expect(404);

    const assets = await repository.listPlatformImageAssets({
      accountScopeKey: toAccountScopeKey('1234567890'),
      regionId: 'cn-hangzhou',
      ownerUserId: 'image-owner-3',
    });

    expect(assets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: privateAsset.id,
          visibility: 'private',
        }),
        expect.objectContaining({
          id: platformAsset.id,
          visibility: 'platform',
        }),
      ]),
    );
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
    const adminToken = await loginAs(app);

    await request(app.getHttpServer())
      .post('/admin/platform-images')
      .set('authorization', `Bearer ${adminToken}`)
      .send({
        snapshotId: snapshot.id,
        displayName: 'Should Not Collect',
      })
      .expect(404);

    const listResponse = await request(app.getHttpServer())
      .get('/admin/platform-images')
      .set('authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(listResponse.body).toEqual({ items: [] });
  });

  it('rejects platform image collection for non-admin sessions', async () => {
    repository = createMemoryAdminRepository();

    await repository.createPlatformUser({
      id: 'platform-user-1',
      username: 'platform-user',
      passwordHash: hashPassword('user-password'),
      role: 'user',
      status: 'active',
    });

    await repository.reconcileImageSnapshots({
      provider: 'alibaba_cloud',
      accountUid: '1234567890',
      regionId: 'cn-hangzhou',
      scope: 'custom',
      snapshots: [
        {
          imageId: 'm-non-admin-source',
          sourceImageName: 'Non Admin Source',
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
    const userToken = await loginAs(app, 'platform-user', 'user-password');

    await request(app.getHttpServer())
      .post('/admin/platform-images')
      .set('authorization', `Bearer ${userToken}`)
      .send({
        snapshotId: snapshot.id,
        displayName: 'Should Not Collect',
      })
      .expect(403);

    expect(
      await repository.listPlatformImageAssets({
        accountScopeKey: toAccountScopeKey('1234567890'),
        regionId: 'cn-hangzhou',
      }),
    ).toEqual([]);
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
      visibility: 'platform',
    });

    app = await createApp(repository);
    const adminToken = await loginAs(app);

    await request(app.getHttpServer())
      .patch(`/admin/platform-images/${asset.id}`)
      .set('authorization', `Bearer ${adminToken}`)
      .send({ displayName: 'Renamed Foreign Asset' })
      .expect(404);

    await request(app.getHttpServer())
      .post(`/admin/platform-images/${asset.id}/disable`)
      .set('authorization', `Bearer ${adminToken}`)
      .expect(404);

    await request(app.getHttpServer())
      .post(`/admin/platform-images/${asset.id}/enable`)
      .set('authorization', `Bearer ${adminToken}`)
      .expect(404);

    await request(app.getHttpServer())
      .delete(`/admin/platform-images/${asset.id}`)
      .set('authorization', `Bearer ${adminToken}`)
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
      visibility: 'platform',
    });

    app = await createApp(repository);
    const adminToken = await loginAs(app);

    await request(app.getHttpServer())
      .delete(`/admin/image-catalog/custom/${snapshot.id}`)
      .set('authorization', `Bearer ${adminToken}`)
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
