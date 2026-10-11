import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { hashPassword } from '../src/admin/admin-user-auth';
import { ADMIN_REPOSITORY, type AdminRepository } from '../src/admin/admin.repository';
import { OidcAdminBootstrapService } from '../src/oidc-admin-bootstrap.service';
import { SystemConfigService } from '../src/admin/system-config.service';
import { OperationControlService } from '../src/operations/operation-control.service';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap/configure-app';
import { toAccountScopeKey } from '../src/admin/image-account-scope';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';
import { loginAsRepositoryUser, overrideTestOidc } from './support/test-oidc';

let repositoryForLogin: AdminRepository;

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

  repositoryForLogin = repository;

  const moduleRef = await overrideTestOidc(Test.createTestingModule({
    imports: [AppModule],
  }))
    .overrideProvider(ADMIN_REPOSITORY)
    .useValue(repository)
    .overrideProvider(SystemConfigService)
    .useValue(createSystemConfigServiceStub())
    .overrideProvider(OidcAdminBootstrapService)
    .useValue({ onModuleInit: jest.fn() })
    .compile();

  const app = moduleRef.createNestApplication();
  configureApp(app);
  await app.init();

  return app;
}

async function loginAs(_app: INestApplication, username = 'admin', _password = 'change-me') {
  return loginAsRepositoryUser(repositoryForLogin, username);
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

  it('preserves and disables source-linked assets when a cloud image disappears', async () => {
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
        sourceSnapshotId: snapshot.id,
        enabled: false,
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

  beforeEach(() => {
    global.fetch = jest.fn().mockImplementation(async input => {
      const params = new URL(String(input)).searchParams;
      if (params.get('Action') === 'DescribeImages') return createJsonResponse({ TotalCount: 1, Images: { Image: [{ ImageId: params.get('ImageId'), Status: 'Available' }] } });
      return createJsonResponse({ RequestId: 'ok' });
    });
  });

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
          createdBy: 'admin',
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
          createdBy: 'admin',
          visibility: 'private',
          ownerUserId: 'admin',
          enabled: true,
        }),
      ],
    });
  });

  it('GET /admin/platform-images?view=mine includes owned private assets even while the source snapshot is still exporting', async () => {
    repository = createMemoryAdminRepository();

    await repository.reconcileImageSnapshots({
      provider: 'alibaba_cloud',
      accountUid: '1234567890',
      regionId: 'cn-hangzhou',
      scope: 'custom',
      snapshots: [
        {
          imageId: 'm-private-pending-image',
          sourceImageName: 'Ubuntu Pending',
          status: 'Creating',
          isAvailable: false,
          lastSyncedAt: new Date('2026-07-06T00:00:00.000Z'),
        },
      ],
    });

    const [pendingSnapshot] = await repository.listImageSnapshots({
      provider: 'alibaba_cloud',
      accountUid: '1234567890',
      regionId: 'cn-hangzhou',
      scope: 'custom',
      imageId: 'm-private-pending-image',
    });

    expect(pendingSnapshot).toBeDefined();

    await repository.collectPlatformImageAsset({
      snapshotId: pendingSnapshot!.id,
      displayName: 'Ubuntu Pending',
      ownerUserId: 'admin',
      visibility: 'private',
    });

    app = await createApp(repository);
    const adminToken = await loginAs(app);

    const mineResponse = await request(app.getHttpServer())
      .get('/admin/platform-images?view=mine')
      .set('authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(mineResponse.body).toEqual({
      items: [
        expect.objectContaining({
          imageId: 'm-private-pending-image',
          displayName: 'Ubuntu Pending',
          ownerUserId: 'admin',
          visibility: 'private',
          enabled: true,
          sourceSnapshotStatus: 'Creating',
          sourceSnapshotAvailable: false,
        }),
      ],
    });
  });

  it('allows admins to create image tags and only owners or admins to assign existing tags', async () => {
    repository = createMemoryAdminRepository();

    await repository.createPlatformUser({
      id: 'tag-owner-1',
      username: 'tag-owner',
      passwordHash: hashPassword('owner-password'),
      role: 'user',
      status: 'active',
    });
    await repository.createPlatformUser({
      id: 'tag-viewer-1',
      username: 'tag-viewer',
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
          imageId: 'm-tagged-owner-image',
          sourceImageName: 'Taggable Owner Image',
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
      imageId: 'm-tagged-owner-image',
    });
    const asset = await repository.collectPlatformImageAsset({
      snapshotId: snapshot.id,
      displayName: 'Taggable Owner Image',
      ownerUserId: 'tag-owner-1',
      visibility: 'platform',
    });

    app = await createApp(repository);
    const adminToken = await loginAs(app);
    const ownerToken = await loginAs(app, 'tag-owner', 'owner-password');
    const viewerToken = await loginAs(app, 'tag-viewer', 'viewer-password');

    const tagResponse = await request(app.getHttpServer())
      .post('/admin/platform-image-tags')
      .set('authorization', `Bearer ${adminToken}`)
      .send({ name: 'Web' })
      .expect(201);

    await request(app.getHttpServer())
      .post('/admin/platform-image-tags')
      .set('authorization', `Bearer ${ownerToken}`)
      .send({ name: 'Owner-created tag' })
      .expect(403);

    const ownerUpdateResponse = await request(app.getHttpServer())
      .put(`/admin/platform-images/${asset.id}/tags`)
      .set('authorization', `Bearer ${ownerToken}`)
      .send({ tagIds: [tagResponse.body.id] })
      .expect(200);

    expect(ownerUpdateResponse.body.tags).toEqual([{ id: tagResponse.body.id, name: 'Web' }]);

    await request(app.getHttpServer())
      .put(`/admin/platform-images/${asset.id}/tags`)
      .set('authorization', `Bearer ${viewerToken}`)
      .send({ tagIds: [tagResponse.body.id] })
      .expect(404);

    await request(app.getHttpServer())
      .put(`/admin/platform-images/${asset.id}/tags`)
      .set('authorization', `Bearer ${ownerToken}`)
      .send({ tagIds: ['missing-tag'] })
      .expect(400);

    await request(app.getHttpServer())
      .get('/admin/platform-image-tags')
      .set('authorization', `Bearer ${ownerToken}`)
      .expect(200)
      .expect({ items: [{ id: tagResponse.body.id, name: 'Web' }] });
    // This legacy HTTP fixture has no workspace middleware; scoped audit persistence is tested separately.
    const audit = jest.spyOn(app.get(OperationControlService), 'audit').mockResolvedValue(undefined as never);
    await request(app.getHttpServer()).delete(`/admin/platform-image-tags/${tagResponse.body.id}`)
      .set('authorization', `Bearer ${ownerToken}`).expect(403);
    await request(app.getHttpServer()).delete(`/admin/platform-image-tags/${tagResponse.body.id}`)
      .set('authorization', `Bearer ${adminToken}`).expect(200)
      .expect({ removed: true, platformImageTagId: tagResponse.body.id });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ targetId: tagResponse.body.id, phase: 'succeeded' }));
    expect((await repository.getPlatformImageAssetById(asset.id))!.tags).toEqual([]);
    await request(app.getHttpServer()).delete(`/admin/platform-image-tags/${tagResponse.body.id}`)
      .set('authorization', `Bearer ${adminToken}`).expect(404);

  });

  it('GET /admin/image-catalog scopes return cached rows without calling Alibaba Cloud', async () => {
    repository = createMemoryAdminRepository();
    await repository.reconcileImageSnapshots({
      provider: 'alibaba_cloud',
      accountUid: '1234567890',
      regionId: 'cn-hangzhou',
      scope: 'custom',
      snapshots: [
        {
          imageId: 'm-cached-custom-image',
          sourceImageName: 'Cached Custom Image',
          status: 'Creating 40%',
          isAvailable: false,
          lastSyncedAt: new Date('2026-07-24T00:00:00.000Z'),
        },
      ],
    });
    await repository.reconcileImageSnapshots({
      provider: 'alibaba_cloud',
      accountUid: '1234567890',
      regionId: 'cn-hangzhou',
      scope: 'public',
      snapshots: [
        {
          imageId: 'm-cached-public-image',
          sourceImageName: 'Cached Public Image',
          status: 'Available',
          isAvailable: true,
          lastSyncedAt: new Date('2026-07-24T00:00:00.000Z'),
        },
      ],
    });
    global.fetch = jest.fn();

    app = await createApp(repository);
    const adminToken = await loginAs(app);

    const customResponse = await request(app.getHttpServer())
      .get('/admin/image-catalog/custom')
      .set('authorization', `Bearer ${adminToken}`)
      .expect(200);
    const publicResponse = await request(app.getHttpServer())
      .get('/admin/image-catalog/public')
      .set('authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(customResponse.body).toEqual({
      snapshots: [
        expect.objectContaining({
          imageId: 'm-cached-custom-image',
          sourceImageName: 'Cached Custom Image',
          status: 'Creating 40%',
          isAvailable: false,
        }),
      ],
      catalogItems: [],
    });
    expect(publicResponse.body).toEqual({
      snapshots: [
        expect.objectContaining({
          imageId: 'm-cached-public-image',
          sourceImageName: 'Cached Public Image',
          status: 'Available',
          isAvailable: true,
        }),
      ],
      catalogItems: [],
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('POST /admin/image-catalog/custom/sync refreshes latest image status and progress', async () => {
    repository = createMemoryAdminRepository();
    global.fetch = jest.fn().mockImplementation(async (input) => {
      const url = String(input);

      if (url.includes('Action=DescribeImages') && url.includes('ImageOwnerAlias=self')) {
        return createJsonResponse({
          Images: {
            Image: [
              {
                ImageId: 'm-private-progress-image',
                ImageName: 'Ubuntu Exporting',
                Status: 'Creating',
                Progress: '65%',
                OSType: 'linux',
                Platform: 'Ubuntu',
                Architecture: 'x86_64',
              },
            ],
          },
          TotalCount: 1,
          PageNumber: 1,
          PageSize: 100,
        });
      }

      return createJsonResponse({ RequestId: 'ok' });
    }) as typeof fetch;

    app = await createApp(repository);
    const adminToken = await loginAs(app);

    const response = await request(app.getHttpServer())
      .post('/admin/image-catalog/custom/sync')
      .set('authorization', `Bearer ${adminToken}`)
      .expect(201);

    expect(response.body).toEqual({
      snapshots: [
        expect.objectContaining({
          imageId: 'm-private-progress-image',
          sourceImageName: 'Ubuntu Exporting',
          status: 'Creating 65%',
          isAvailable: false,
        }),
      ],
      catalogItems: [],
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
    expect((await repository.getImageSnapshotById(snapshot.id))?.id).toBe(snapshot.id);
    expect((global.fetch as jest.Mock).mock.calls.map(([input]) => new URL(String(input)).searchParams.get('Action'))).not.toContain('DeleteImage');
  });

  it('requires admin privileges to publish a private image asset', async () => {
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
      .expect(403);

    const platformResponse = await request(app.getHttpServer())
      .get('/admin/platform-images?view=platform')
      .set('authorization', `Bearer ${ownerToken}`)
      .expect(200);

    expect(platformResponse.body).toEqual({
      items: [],
    });
  });

  it('requires admin privileges to unpublish a platform image asset back to private', async () => {
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
      .expect(403);

    const platformResponse = await request(app.getHttpServer())
      .get('/admin/platform-images?view=platform')
      .set('authorization', `Bearer ${ownerToken}`)
      .expect(200);

    expect(platformResponse.body).toEqual({
      items: [
        expect.objectContaining({
          id: asset.id,
          ownerUserId: 'image-owner-2',
          visibility: 'platform',
        }),
      ],
    });
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
      .expect(403);

    await request(app.getHttpServer())
      .post(`/admin/platform-images/${platformAsset.id}/unpublish`)
      .set('authorization', `Bearer ${viewerToken}`)
      .expect(403);

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

  it('allows an owner to remove their platform asset while keeping its cloud image', async () => {
    repository = createMemoryAdminRepository();
    global.fetch = jest.fn().mockResolvedValue(createJsonResponse({ RequestId: 'delete-ok' }));

    await repository.createPlatformUser({
      id: 'image-owner-delete-1',
      username: 'image-owner-delete',
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
          imageId: 'm-owner-delete-image',
          sourceImageName: 'Owner Delete Image',
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
      imageId: 'm-owner-delete-image',
    });

    const asset = await repository.collectPlatformImageAsset({
      snapshotId: snapshot.id,
      displayName: 'Owner Delete Image',
      ownerUserId: 'image-owner-delete-1',
      visibility: 'private',
    });

    app = await createApp(repository);
    const ownerToken = await loginAs(app, 'image-owner-delete', 'owner-password');

    await request(app.getHttpServer())
      .delete(`/admin/platform-images/${asset.id}`)
      .set('authorization', `Bearer ${ownerToken}`)
      .expect(204)
      .expect('');

    const [remainingSnapshot] = await repository.listImageSnapshots({
      provider: 'alibaba_cloud',
      accountUid: '1234567890',
      regionId: 'cn-hangzhou',
      scope: 'custom',
      imageId: 'm-owner-delete-image',
    });
    const remainingAssets = await repository.listPlatformImageAssets({
      accountScopeKey: toAccountScopeKey('1234567890'),
      regionId: 'cn-hangzhou',
      ownerUserId: 'image-owner-delete-1',
    });

    expect(remainingSnapshot?.id).toBe(snapshot.id);
    expect(remainingAssets).toEqual([]);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('prevents a non-owner user from deleting another user custom image asset', async () => {
    repository = createMemoryAdminRepository();

    await repository.createPlatformUser({
      id: 'image-owner-delete-2',
      username: 'image-owner-delete-two',
      passwordHash: hashPassword('owner-password'),
      role: 'user',
      status: 'active',
    });
    await repository.createPlatformUser({
      id: 'image-viewer-delete-1',
      username: 'image-viewer-delete',
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
          imageId: 'm-other-delete-image',
          sourceImageName: 'Other Delete Image',
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
      imageId: 'm-other-delete-image',
    });

    const asset = await repository.collectPlatformImageAsset({
      snapshotId: snapshot.id,
      displayName: 'Other Delete Image',
      ownerUserId: 'image-owner-delete-2',
      visibility: 'private',
    });

    app = await createApp(repository);
    const viewerToken = await loginAs(app, 'image-viewer-delete', 'viewer-password');

    await request(app.getHttpServer())
      .delete(`/admin/platform-images/${asset.id}`)
      .set('authorization', `Bearer ${viewerToken}`)
      .expect(404);

    const [remainingAsset] = await repository.listPlatformImageAssets({
      accountScopeKey: toAccountScopeKey('1234567890'),
      regionId: 'cn-hangzhou',
      ownerUserId: 'image-owner-delete-2',
    });

    expect(remainingAsset).toEqual(
      expect.objectContaining({
        id: asset.id,
        displayName: 'Other Delete Image',
      }),
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
    let cloudPresent = true;
    global.fetch = jest.fn().mockImplementation(async input => {
      const action = new URL(String(input)).searchParams.get('Action');
      if (action === 'DescribeImages') return createJsonResponse({ TotalCount: cloudPresent ? 1 : 0, Images: { Image: cloudPresent ? [{ ImageId: 'm-bp1deletecustom', Status: 'Available' }] : [] } });
      cloudPresent = false; return createJsonResponse({ RequestId: 'delete-ok' });
    });

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
    await repository.createBillingLedgerResource({
      cloudProvider: 'alibaba_cloud',
      cloudAccountUid: '1234567890',
      regionId: 'cn-hangzhou',
      cloudResourceId: snapshot.imageId,
      cloudResourceType: 'image',
      billingScope: 'platform',
      billingStartAt: new Date('2026-07-16T00:00:00.000Z'),
      tagsSnapshot: {},
    });
    await repository.createBillingLedgerResource({
      cloudProvider: 'alibaba_cloud',
      cloudAccountUid: '1234567890',
      regionId: 'cn-hangzhou',
      cloudResourceId: snapshot.imageId,
      cloudResourceType: 'snapshot',
      billingScope: 'platform',
      billingStartAt: new Date('2026-07-16T00:00:00.000Z'),
      tagsSnapshot: {},
    });

    app = await createApp(repository);
    const adminToken = await loginAs(app);

    await request(app.getHttpServer())
      .delete(`/admin/image-catalog/custom/${snapshot.id}`)
      .set('authorization', `Bearer ${adminToken}`)
      .expect(200)
      .expect(response => expect(response.body.removed).toBe(true));

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

    expect(remainingSnapshot?.status).toBe('Deleted');
    expect(remainingAssets).toEqual([]);
    const ledgerResources = await repository.listBillingLedgerResources();
    const imageLedger = ledgerResources.find((item) => item.cloudResourceType === 'image');
    const snapshotLedger = ledgerResources.find((item) => item.cloudResourceType === 'snapshot');

    expect(imageLedger?.cloudResourceId).toBe(snapshot.imageId);
    expect(imageLedger?.cloudResourceType).toBe('image');
    expect(imageLedger?.releasedAt).toBeTruthy();
    expect(new Date(imageLedger!.releasedAt as Date).getTime()).toBeGreaterThan(0);
    expect(snapshotLedger?.cloudResourceId).toBe(snapshot.imageId);
    expect(snapshotLedger?.cloudResourceType).toBe('snapshot');
    expect(snapshotLedger?.releasedAt).toBeNull();
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('Action=DeleteImage'),
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('DELETE /admin/platform-images/:id retains the cloud image and cached source', async () => {
    repository = createMemoryAdminRepository();
    global.fetch = jest.fn().mockResolvedValue(createJsonResponse({ RequestId: 'delete-ok' }));

    await repository.reconcileImageSnapshots({
      provider: 'alibaba_cloud',
      accountUid: '1234567890',
      regionId: 'cn-hangzhou',
      scope: 'custom',
      snapshots: [
        {
          imageId: 'm-remove-catalog-only',
          sourceImageName: 'Keep In Alibaba Cloud',
          status: 'Available',
          isAvailable: true,
          lastSyncedAt: new Date('2026-07-20T00:00:00.000Z'),
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
      displayName: 'My Private Image',
      ownerUserId: 'admin',
      visibility: 'private',
    });

    app = await createApp(repository);
    const adminToken = await loginAs(app);

    await request(app.getHttpServer())
      .delete(`/admin/platform-images/${asset.id}`)
      .set('authorization', `Bearer ${adminToken}`)
      .expect(204)
      .expect('');

    const remainingSnapshots = await repository.listImageSnapshots({
      provider: 'alibaba_cloud',
      accountUid: '1234567890',
      regionId: 'cn-hangzhou',
      scope: 'custom',
    });
    const remainingAsset = await repository.getPlatformImageAssetById(asset.id);

    expect(remainingSnapshots).toEqual([snapshot]);
    expect(remainingAsset).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it.each(['image-catalog/custom'])('keeps assets, snapshots, and billing ledgers when %s cloud deletion fails', async (route) => {
    repository = createMemoryAdminRepository();
    global.fetch = jest.fn().mockResolvedValue(createJsonResponse({ Code: 'InternalError' }, 503));
    await repository.reconcileImageSnapshots({
      provider: 'alibaba_cloud', accountUid: '1234567890', regionId: 'cn-hangzhou', scope: 'custom',
      snapshots: [{
        imageId: 'm-delete-failure', sourceImageName: 'Keep On Failure', status: 'Available',
        isAvailable: true, lastSyncedAt: new Date('2026-07-20T00:00:00.000Z'),
      }],
    });
    const [snapshot] = await repository.listImageSnapshots({
      provider: 'alibaba_cloud', accountUid: '1234567890', regionId: 'cn-hangzhou', scope: 'custom',
    });
    const asset = await repository.collectPlatformImageAsset({
      snapshotId: snapshot.id, displayName: 'Keep On Failure', ownerUserId: 'admin', visibility: 'private',
    });
    const imageLedger = await repository.createBillingLedgerResource({
      cloudProvider: 'alibaba_cloud', cloudAccountUid: '1234567890', regionId: 'cn-hangzhou',
      cloudResourceId: snapshot.imageId, cloudResourceType: 'image', billingScope: 'user', ownerUserId: 'admin',
      platformImageAssetId: asset.id, billingStartAt: new Date('2026-07-20T00:00:00.000Z'), tagsSnapshot: {},
    });
    const snapshotLedger = await repository.createBillingLedgerResource({
      cloudProvider: 'alibaba_cloud', cloudAccountUid: '1234567890', regionId: 'cn-hangzhou',
      cloudResourceId: 's-delete-failure', cloudResourceType: 'snapshot', billingScope: 'user', ownerUserId: 'admin',
      platformImageAssetId: asset.id, billingStartAt: new Date('2026-07-20T00:00:00.000Z'), tagsSnapshot: {},
    });
    app = await createApp(repository);
    const adminToken = await loginAs(app);
    await request(app.getHttpServer())
      .delete(`/admin/${route}/${route === 'platform-images' ? asset.id : snapshot.id}`)
      .set('authorization', `Bearer ${adminToken}`)
      .expect(502);

    expect(await repository.getImageSnapshotById(snapshot.id)).toEqual(expect.objectContaining({ imageId: snapshot.imageId }));
    expect(await repository.getPlatformImageAssetById(asset.id)).toEqual(expect.objectContaining({ id: asset.id }));
    expect(await repository.listBillingLedgerResources()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: imageLedger.id, releasedAt: null }),
      expect.objectContaining({ id: snapshotLedger.id, releasedAt: null }),
    ]));
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url] = (global.fetch as jest.Mock).mock.calls[0];
    expect(new URL(String(url)).searchParams.get('Action')).toBe('DescribeImages');
    expect(new URL(String(url)).searchParams.get('ImageId')).toBe(snapshot.imageId);
  });

  it('refuses to delete a cloud image that is still referenced by a live instance', async () => {
    repository = createMemoryAdminRepository();
    global.fetch = jest.fn();

    await repository.reconcileImageSnapshots({
      provider: 'alibaba_cloud',
      accountUid: '1234567890',
      regionId: 'cn-hangzhou',
      scope: 'custom',
      snapshots: [
        {
          imageId: 'm-referenced-image',
          sourceImageName: 'Referenced Image',
          status: 'Available',
          isAvailable: true,
          lastSyncedAt: new Date('2026-07-20T00:00:00.000Z'),
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
      displayName: 'Referenced Image Asset',
      ownerUserId: 'admin',
      visibility: 'private',
    });
    await repository.createRangeInstance({
      name: 'active-single-instance',
      instanceMode: 'single',
      status: 'running',
      singleInstanceConfig: {
        baseName: 'active-single-instance',
        quantityIndex: 1,
        hostKey: 'single-ecs',
        hostName: 'active-single-instance',
        platformImageAssetId: asset.id,
        imageId: snapshot.imageId,
        imageDisplayName: asset.displayName,
        cpu: 2,
        memory: 4,
        systemDiskSize: 40,
      },
    });

    app = await createApp(repository);
    const adminToken = await loginAs(app);

    const response = await request(app.getHttpServer())
      .delete(`/admin/image-catalog/custom/${snapshot.id}`)
      .set('authorization', `Bearer ${adminToken}`)
      .expect(400);

    expect(response.body.message).toContain('active-single-instance');
    expect(global.fetch).not.toHaveBeenCalled();
    expect(await repository.getImageSnapshotById(snapshot.id)).toEqual(expect.objectContaining({ imageId: snapshot.imageId }));
    expect(await repository.getPlatformImageAssetById(asset.id)).toEqual(expect.objectContaining({ id: asset.id }));
  });
});
