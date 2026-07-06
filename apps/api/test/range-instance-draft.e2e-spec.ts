import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { ADMIN_REPOSITORY, type AdminRepository } from '../src/admin/admin.repository';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap/configure-app';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';

describe('Range instance draft API', () => {
  let app: INestApplication;
  let repository: AdminRepository;
  let instanceId: string;

  beforeAll(async () => {
    process.env.ADMIN_USERNAME = 'admin';
    process.env.ADMIN_PASSWORD = 'change-me';
    process.env.ADMIN_TOKEN = 'dev-admin-token';

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(ADMIN_REPOSITORY)
      .useValue(createMemoryAdminRepository())
      .compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();

    repository = app.get(ADMIN_REPOSITORY);

    const template = await repository.createRangeTemplate({
      name: 'Draft Template',
      slug: 'draft-template',
      version: 'v1',
      modulePathOrRef: 'infra/opentofu/modules/alicloud-enterprise-range',
      topologySpec: {
        vpcCidr: '10.77.0.0/16',
        networkZones: [
          { key: 'dmz', name: 'DMZ', purpose: 'public-entry', cidr: '10.77.10.0/24', isPublicEntry: true },
        ],
        hosts: [
          { key: 'checker', name: 'checker', zoneKey: 'dmz', role: 'entry', privateIp: '10.77.10.10', exposePublic: true },
        ],
        publicEntry: {
          hostKey: 'checker',
          protocols: [{ protocol: 'ssh', port: 22 }],
        },
      },
    });

    const instance = await repository.createRangeInstance({
      name: 'draft-range',
      createdBy: 'admin',
      templateId: template.id,
      status: 'running',
      runtimeTopologyGraph: {
        schemaVersion: '1',
        nodes: [{ id: 'host-checker', kind: 'ecs', data: { label: 'checker' } }],
        edges: [],
      },
      runtimeScenarioTemplateSpec: {
        metadata: { name: 'checker' },
        hosts: [
          {
            key: 'host-checker',
            name: 'checker',
            zoneKey: 'switch-1',
            role: 'ecs',
            privateIp: '10.0.0.10',
          },
        ],
      },
      runtimeCompiledProvisionSpec: {
        topology: { vpcCidr: '10.77.0.0/16' },
      },
    });

    instanceId = instance.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('saves an instance draft without changing runtime status', async () => {
    const response = await request(app.getHttpServer())
      .patch(`/admin/ranges/${instanceId}/draft`)
      .set('authorization', 'Bearer dev-admin-token')
      .send({
        draftTopologyGraph: {
          schemaVersion: '1',
          nodes: [{ id: 'host-checker', kind: 'ecs', data: { label: 'checker-updated' } }],
          edges: [],
        },
        draftScenarioTemplateSpec: {
          metadata: { name: 'checker' },
          hosts: [
            {
              key: 'host-checker',
              name: 'checker-updated',
              zoneKey: 'switch-1',
              role: 'ecs',
              privateIp: '10.0.0.10',
            },
          ],
        },
        draftCompiledProvisionSpec: {
          topology: { vpcCidr: '10.77.0.0/16' },
        },
        draftUpdatedBy: 'admin',
      })
      .expect(200);

    expect(response.body.status).toBe('running');
    expect(response.body.draftScenarioTemplateSpec.hosts[0].name).toBe('checker-updated');
  });

  it('discards the saved draft and clears draft fields', async () => {
    const response = await request(app.getHttpServer())
      .delete(`/admin/ranges/${instanceId}/draft`)
      .set('authorization', 'Bearer dev-admin-token')
      .expect(200);

    expect(response.body.draftTopologyGraph).toBeNull();
    expect(response.body.draftScenarioTemplateSpec).toBeNull();
    expect(response.body.draftCompiledProvisionSpec).toBeNull();
    expect(response.body.draftUpdatedBy).toBeNull();
  });
});
