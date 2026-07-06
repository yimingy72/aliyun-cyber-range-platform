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

describe('Range instance node actions API', () => {
  let app: INestApplication;
  let repository: AdminRepository;
  let instanceId: string;
  let fetchMock: jest.SpiedFunction<typeof fetch>;

  beforeAll(async () => {
    process.env.ADMIN_USERNAME = 'admin';
    process.env.ADMIN_PASSWORD = 'change-me';
    process.env.ADMIN_TOKEN = 'dev-admin-token';

    fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);

      if (url.includes('DescribeInstanceVncUrl')) {
        return new Response(JSON.stringify({ VncUrl: 'wss://vnc.example.test' }), { status: 200 });
      }

      if (url.includes('CreateImage')) {
        return new Response(JSON.stringify({ ImageId: 'm-image-123' }), { status: 200 });
      }

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

    const template = await repository.createRangeTemplate({
      name: 'Node Action Template',
      slug: 'node-action-template',
      version: 'v1',
      modulePathOrRef: 'infra/opentofu/modules/alicloud-enterprise-range',
      topologySpec: {
        vpcCidr: '10.33.0.0/16',
        networkZones: [
          { key: 'dmz', name: 'DMZ', purpose: 'public-entry', cidr: '10.33.10.0/24', isPublicEntry: true },
        ],
        hosts: [
          { key: 'ecs-1', name: 'ecs-1', zoneKey: 'dmz', role: 'entry', privateIp: '10.33.10.10', exposePublic: true },
        ],
        publicEntry: {
          hostKey: 'ecs-1',
          protocols: [{ protocol: 'ssh', port: 22 }],
        },
      },
    });

    const instance = await repository.createRangeInstance({
      name: 'node-action-range',
      createdBy: 'admin',
      templateId: template.id,
      status: 'running',
      resourceSummary: {
        mode: 'opentofu',
        hostIds: {
          'ecs-1': 'i-instance-123',
        },
      },
    });

    instanceId = instance.id;
  });

  afterAll(async () => {
    fetchMock.mockRestore();
    await app.close();
  });

  it('reboots a host node through the node action route', async () => {
    const response = await request(app.getHttpServer())
      .post(`/admin/ranges/${instanceId}/nodes/ecs-1/actions/reboot`)
      .set('authorization', 'Bearer dev-admin-token')
      .send({ triggeredBy: 'admin' })
      .expect(201);

    expect(response.body.status).toBe('accepted');
  });

  it('opens a VNC URL for the selected host node', async () => {
    const response = await request(app.getHttpServer())
      .post(`/admin/ranges/${instanceId}/nodes/ecs-1/actions/open-vnc`)
      .set('authorization', 'Bearer dev-admin-token')
      .send({ triggeredBy: 'admin' })
      .expect(201);

    expect(response.body.vncUrl).toBe('wss://vnc.example.test');
  });

  it('creates a custom image and platform asset from the selected host node', async () => {
    const response = await request(app.getHttpServer())
      .post(`/admin/ranges/${instanceId}/nodes/ecs-1/actions/pack-image`)
      .set('authorization', 'Bearer dev-admin-token')
      .send({ displayName: 'checker-snapshot', triggeredBy: 'admin' })
      .expect(201);

    expect(response.body.imageId).toBe('m-image-123');
    expect(response.body.platformImageAsset).toEqual(
      expect.objectContaining({
        imageId: 'm-image-123',
        displayName: 'checker-snapshot',
      }),
    );
  });
});
