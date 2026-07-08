import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { ADMIN_REPOSITORY, type AdminRepository } from '../src/admin/admin.repository';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap/configure-app';
import { SystemConfigService } from '../src/admin/system-config.service';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';

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
      defaultRegion: 'cn-hangzhou',
      defaultZoneId: 'cn-hangzhou-h',
      accessKeyId: 'test-ak',
      accessKeySecret: 'test-sk',
      accountUid: null,
      accountUidResolved: false,
    }),
  };
}

describe('single instances', () => {
  let app: INestApplication;
  let repository: AdminRepository;
  let fetchMock: jest.SpiedFunction<typeof fetch>;

  beforeAll(async () => {
    process.env.ADMIN_USERNAME = 'admin';
    process.env.ADMIN_PASSWORD = 'change-me';
    process.env.ADMIN_TOKEN = 'dev-admin-token';
    fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response(JSON.stringify({ RequestId: 'ok' }), { status: 200 });
    });

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(ADMIN_REPOSITORY)
      .useValue(createMemoryAdminRepository())
      .overrideProvider(SystemConfigService)
      .useValue(createSystemConfigServiceStub())
      .compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();

    repository = app.get(ADMIN_REPOSITORY);

    await repository.upsertImageSnapshots({
      provider: 'alibaba_cloud',
      accountUid: null,
      regionId: 'cn-hangzhou',
      scope: 'custom',
      snapshots: [
        {
          imageId: 'm-platform-image-1',
          sourceImageName: 'Ubuntu 24.04',
          status: 'Available',
          isAvailable: true,
          lastSyncedAt: new Date('2026-07-08T00:00:00.000Z'),
        },
      ],
    });

    const snapshot = (
      await repository.listImageSnapshots({
        provider: 'alibaba_cloud',
        accountUid: null,
        regionId: 'cn-hangzhou',
        scope: 'custom',
        imageId: 'm-platform-image-1',
      })
    )[0];

    await repository.collectPlatformImageAsset({
      snapshotId: snapshot.id,
      displayName: 'Ubuntu 24.04',
    });

    const [asset] = await repository.listPlatformImageAssets({
      provider: 'alibaba_cloud',
      accountUid: null,
      regionId: 'cn-hangzhou',
      enabled: true,
    });

    expect(asset?.id).toBe('memory-2');
  });

  afterAll(async () => {
    fetchMock.mockRestore();
    await app.close();
  });

  it('creates a single-instance record with mode single and generated names for quantity > 1', async () => {
    const response = await request(app.getHttpServer())
      .post('/admin/instances/launch')
      .set('Authorization', 'Bearer dev-admin-token')
      .send({
        name: 'web-lab',
        hostName: 'web-host',
        platformImageAssetId: 'memory-2',
        cpu: 2,
        memory: 2,
        systemDiskSize: 40,
        expiresAt: '2026-07-10T12:00:00.000Z',
        quantity: 2,
        password: '',
        remark: 'single instance',
        triggeredBy: 'admin',
      });

    expect(response.status).toBe(201);
    expect(response.body.instances).toHaveLength(2);
    expect(response.body.instances[0]).toMatchObject({
      createdBy: 'admin',
      instanceMode: 'single',
      name: 'web-lab-01',
    });
    expect(response.body.instances[1]).toMatchObject({
      name: 'web-lab-02',
    });
  });

  it('rejects stop for single-instance row actions', async () => {
    const instance = await repository.createRangeInstance({
      name: 'stop-guard',
      createdBy: 'admin',
      instanceMode: 'single',
      status: 'running',
      singleInstanceConfig: {
        baseName: 'stop-guard',
        quantityIndex: 1,
        hostKey: 'single-ecs-1',
        hostName: 'stop-guard',
        platformImageAssetId: 'memory-2',
        imageId: 'm-platform-image-1',
        imageDisplayName: 'Ubuntu 24.04',
        cpu: 2,
        memory: 2,
        systemDiskSize: 40,
      },
      resourceSummary: {
        mode: 'opentofu',
        hostIds: {
          'single-ecs-1': 'i-single-123',
        },
      },
    });

    const response = await request(app.getHttpServer())
      .post(`/admin/instances/${instance.id}/actions/stop`)
      .set('Authorization', 'Bearer dev-admin-token')
      .send({ triggeredBy: 'admin' });

    expect(response.status).toBe(404);
    expect(response.body.message).toBe('Unsupported single instance action');
  });
});
