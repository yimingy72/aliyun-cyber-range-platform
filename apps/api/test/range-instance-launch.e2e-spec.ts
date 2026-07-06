import { createMemoryAdminRepository } from './support/create-memory-admin-repository';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { ADMIN_REPOSITORY, type AdminRepository } from '../src/admin/admin.repository';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap/configure-app';
import { SystemConfigService } from '../src/admin/system-config.service';

function createSystemConfigServiceStub() {
  return {
    getSnapshot: jest.fn().mockResolvedValue({
      provider: 'alibaba_cloud',
      defaultRegion: 'cn-hangzhou',
      defaultZoneId: 'cn-hangzhou-h',
      accessKeyId: 'test-ak',
      accessKeySecret: 'test-sk',
    }),
  };
}

describe('Range instance runtime snapshot persistence', () => {
  it('persists runtime and draft snapshots on a created range instance', async () => {
    const repository = createMemoryAdminRepository();

    const template = await repository.createRangeTemplate({
      name: 'Runtime Snapshot Template',
      slug: 'runtime-snapshot-template',
      version: 'v1',
      modulePathOrRef: 'infra/opentofu/modules/alicloud-enterprise-range',
      topologySpec: {
        vpcCidr: '10.99.0.0/16',
        networkZones: [
          { key: 'dmz', name: 'DMZ', purpose: 'public-entry', cidr: '10.99.10.0/24', isPublicEntry: true },
        ],
        hosts: [
          { key: 'checker', name: 'checker', zoneKey: 'dmz', role: 'entry', privateIp: '10.99.10.10', exposePublic: true },
        ],
        publicEntry: {
          hostKey: 'checker',
          protocols: [{ protocol: 'ssh', port: 22 }],
        },
      },
    });

    const created = await repository.createRangeInstance({
      name: '靶场实例 A',
      createdBy: 'admin',
      templateId: template.id,
      expiresAt: '2026-07-08T18:00:00.000Z',
      runtimeTopologyGraph: { schemaVersion: '1', nodes: [], edges: [] },
      runtimeScenarioTemplateSpec: { metadata: { name: '靶场实例 A' } },
      runtimeCompiledProvisionSpec: { topology: { vpcCidr: '10.0.0.0/16' } },
    });

    expect(created.createdBy).toBe('admin');
    expect(created.runtimeTopologyGraph).toEqual(
      expect.objectContaining({ schemaVersion: '1' }),
    );
    expect(created.runtimeScenarioTemplateSpec).toEqual(
      expect.objectContaining({ metadata: expect.objectContaining({ name: '靶场实例 A' }) }),
    );
    expect(created.runtimeCompiledProvisionSpec).toEqual(
      expect.objectContaining({ topology: expect.objectContaining({ vpcCidr: '10.0.0.0/16' }) }),
    );
    expect(created.draftTopologyGraph).toBeNull();
    expect(created.draftScenarioTemplateSpec).toBeNull();
    expect(created.draftCompiledProvisionSpec).toBeNull();
    expect(created.draftUpdatedBy).toBeNull();
    expect(created.draftUpdatedAt).toBeNull();
  });
});

describe('Range instance launch API', () => {
  let app: INestApplication;
  let repository: AdminRepository;
  let templateId: string;

  beforeAll(async () => {
    process.env.ADMIN_USERNAME = 'admin';
    process.env.ADMIN_PASSWORD = 'change-me';
    process.env.ADMIN_TOKEN = 'dev-admin-token';

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
      name: 'Launchable Template',
      slug: 'launchable-template',
      version: 'v1',
      modulePathOrRef: 'infra/opentofu/modules/alicloud-enterprise-range',
      topologySpec: {
        vpcCidr: '10.90.0.0/16',
        networkZones: [
          { key: 'dmz', name: 'DMZ', purpose: 'public-entry', cidr: '10.90.10.0/24', isPublicEntry: true },
        ],
        hosts: [
          { key: 'entry-host', name: 'entry-host', zoneKey: 'dmz', role: 'entry', privateIp: '10.90.10.10', exposePublic: true },
        ],
        publicEntry: {
          hostKey: 'entry-host',
          protocols: [{ protocol: 'ssh', port: 22 }],
        },
      },
      topologyGraph: {
        schemaVersion: '1',
        nodes: [{ id: 'entry-host', kind: 'ecs', data: { label: 'entry-host' } }],
        edges: [],
      },
      scenarioTemplateSpec: {
        metadata: { name: 'Launchable Template' },
      },
      compiledProvisionSpec: {
        topology: { vpcCidr: '10.90.0.0/16' },
      },
    });

    templateId = template.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('launches a range instance atomically with snapshots and a pending create job', async () => {
    const response = await request(app.getHttpServer())
      .post('/admin/ranges/launch')
      .set('authorization', 'Bearer dev-admin-token')
      .send({
        templateId,
        name: '攻防实例-一号',
        expiresAt: '2026-07-09T12:00:00.000Z',
        triggeredBy: 'admin',
      })
      .expect(201);

    expect(response.body).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        name: '攻防实例-一号',
        status: 'pending_create',
        createdBy: 'admin',
        expiresAt: '2026-07-09T12:00:00.000Z',
        lastJobId: expect.any(String),
        runtimeTopologyGraph: expect.objectContaining({
          schemaVersion: '1',
        }),
        runtimeScenarioTemplateSpec: expect.objectContaining({
          metadata: expect.objectContaining({
            name: 'Launchable Template',
          }),
        }),
        runtimeCompiledProvisionSpec: expect.objectContaining({
          topology: expect.objectContaining({
            vpcCidr: '10.90.0.0/16',
          }),
        }),
      }),
    );
  });
});
