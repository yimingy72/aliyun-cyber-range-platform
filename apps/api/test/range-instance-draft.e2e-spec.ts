import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { hashPassword } from '../src/admin/admin-user-auth';
import { ADMIN_REPOSITORY, type AdminRepository } from '../src/admin/admin.repository';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap/configure-app';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';

async function loginAs(app: INestApplication, username = 'admin', password = 'change-me') {
  const response = await request(app.getHttpServer())
    .post('/admin/session')
    .send({ username, password })
    .expect(200);

  return response.body.token as string;
}

describe('Range instance draft API', () => {
  let app: INestApplication;
  let repository: AdminRepository;
  let instanceId: string;
  let userToken: string;

  const draftUser = {
    id: 'draft-user-1',
    username: 'draft-user',
    password: 'DraftUser123!',
  };

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

    await repository.createPlatformUser({
      id: draftUser.id,
      username: draftUser.username,
      passwordHash: hashPassword(draftUser.password),
      role: 'user',
      status: 'active',
    });

    const template = await repository.createRangeTemplate({
      name: 'Draft Template',
      createdBy: draftUser.id,
      ownerUserId: draftUser.id,
      slug: 'draft-template',
      visibility: 'private',
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
      createdBy: draftUser.id,
      ownerUserId: draftUser.id,
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
    userToken = await loginAs(app, draftUser.username, draftUser.password);
  });

  afterAll(async () => {
    await app.close();
  });

  it('saves an instance draft without changing runtime status', async () => {
    const response = await request(app.getHttpServer())
      .patch(`/admin/ranges/${instanceId}/draft`)
      .set('authorization', `Bearer ${userToken}`)
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
      })
      .expect(200);

    expect(response.body.status).toBe('running');
    expect(response.body.draftScenarioTemplateSpec.hosts[0].name).toBe('checker-updated');
    expect(response.body.draftUpdatedBy).toBe(draftUser.id);

    const persisted = await repository.getRangeInstanceById(instanceId);

    expect(persisted?.draftUpdatedBy).toBe(draftUser.id);
  });

  it('discards the saved draft and clears draft fields', async () => {
    const response = await request(app.getHttpServer())
      .delete(`/admin/ranges/${instanceId}/draft`)
      .set('authorization', `Bearer ${userToken}`)
      .expect(200);

    expect(response.body.draftTopologyGraph).toBeNull();
    expect(response.body.draftScenarioTemplateSpec).toBeNull();
    expect(response.body.draftCompiledProvisionSpec).toBeNull();
    expect(response.body.draftUpdatedBy).toBeNull();
  });
});
