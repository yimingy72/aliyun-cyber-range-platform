import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { ADMIN_REPOSITORY } from '../src/admin/admin.repository';
import { configureApp } from '../src/bootstrap/configure-app';
import { AppModule } from '../src/app.module';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';

describe('Admin resource validation', () => {
  let app: INestApplication;

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
  });

  afterAll(async () => {
    await app.close();
  });

  async function waitForRangeInstanceStatus(id: string, status: string) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const response = await request(app.getHttpServer())
        .get('/admin/range-instances')
        .set('authorization', 'Bearer dev-admin-token')
        .expect(200);

      const target = response.body.find((item: { id: string }) => item.id === id);

      if (target?.status === status) {
        return target;
      }

      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    throw new Error(`Range instance ${id} did not reach status ${status}`);
  }

  async function createProvisioningFixture() {
    const competition = await request(app.getHttpServer())
      .post('/admin/competitions')
      .set('authorization', 'Bearer dev-admin-token')
      .send({
        name: `Competition ${Date.now()}`,
      })
      .expect(201);

    const team = await request(app.getHttpServer())
      .post('/admin/teams')
      .set('authorization', 'Bearer dev-admin-token')
      .send({
        competitionId: competition.body.id,
        name: `Team ${Date.now()}`,
      })
      .expect(201);

    const template = await request(app.getHttpServer())
      .post('/admin/range-templates')
      .set('authorization', 'Bearer dev-admin-token')
      .send({
        name: 'Fixture Template',
        slug: `fixture-template-${Date.now()}`,
        version: 'v1',
        modulePathOrRef: 'infra/opentofu/modules/alicloud-enterprise-range',
        topologySpec: {
          vpcCidr: '10.70.0.0/16',
          networkZones: [
            {
              key: 'dmz',
              name: 'DMZ',
              purpose: 'public-entry',
              cidr: '10.70.10.0/24',
              isPublicEntry: true,
            },
          ],
          hosts: [
            {
              key: 'dmz-entry',
              name: 'DMZ Entry',
              zoneKey: 'dmz',
              role: 'entry',
              privateIp: '10.70.10.10',
              exposePublic: true,
            },
          ],
          publicEntry: {
            hostKey: 'dmz-entry',
            protocols: [{ protocol: 'ssh', port: 22 }],
          },
        },
      })
      .expect(201);

    const instance = await request(app.getHttpServer())
      .post('/admin/range-instances')
      .set('authorization', 'Bearer dev-admin-token')
      .send({
        competitionId: competition.body.id,
        teamId: team.body.id,
        templateId: template.body.id,
      })
      .expect(201);

    return {
      competitionId: competition.body.id,
      teamId: team.body.id,
      templateId: template.body.id,
      rangeInstanceId: instance.body.id,
    };
  }

  it('rejects competitions without a name', async () => {
    await request(app.getHttpServer())
      .post('/admin/competitions')
      .set('authorization', 'Bearer dev-admin-token')
      .send({
        description: 'missing name',
      })
      .expect(400);
  });

  it('rejects competitions with an invalid status', async () => {
    await request(app.getHttpServer())
      .post('/admin/competitions')
      .set('authorization', 'Bearer dev-admin-token')
      .send({
        name: 'Invalid competition',
        status: 'broken',
      })
      .expect(400);
  });

  it('rejects teams without a competition id', async () => {
    await request(app.getHttpServer())
      .post('/admin/teams')
      .set('authorization', 'Bearer dev-admin-token')
      .send({
        name: 'Nameless relation',
      })
      .expect(400);
  });

  it('rejects templates without a module path', async () => {
    await request(app.getHttpServer())
      .post('/admin/range-templates')
      .set('authorization', 'Bearer dev-admin-token')
      .send({
        name: 'Broken template',
        slug: 'broken-template',
        version: 'v1',
      })
      .expect(400);
  });

  it('rejects templates without a topology spec', async () => {
    await request(app.getHttpServer())
      .post('/admin/range-templates')
      .set('authorization', 'Bearer dev-admin-token')
      .send({
        name: 'Broken enterprise template',
        slug: 'broken-enterprise-template',
        version: 'v1',
        modulePathOrRef: 'infra/opentofu/modules/alicloud-enterprise-range',
      })
      .expect(400);
  });

  it('rejects templates when topology spec is missing vpc cidr', async () => {
    await request(app.getHttpServer())
      .post('/admin/range-templates')
      .set('authorization', 'Bearer dev-admin-token')
      .send({
        name: 'Broken topology template',
        slug: 'broken-topology-template',
        version: 'v1',
        modulePathOrRef: 'infra/opentofu/modules/alicloud-enterprise-range',
        topologySpec: {
          networkZones: [
            {
              key: 'dmz',
              name: 'DMZ',
              purpose: 'public-entry',
              cidr: '10.70.10.0/24',
              isPublicEntry: true,
            },
          ],
          hosts: [
            {
              key: 'dmz-entry',
              name: 'DMZ Entry',
              zoneKey: 'dmz',
              role: 'entry',
              privateIp: '10.70.10.10',
              exposePublic: true,
            },
          ],
          publicEntry: {
            hostKey: 'dmz-entry',
            protocols: [{ protocol: 'ssh', port: 22 }],
          },
        },
      })
      .expect(400);
  });

  it('rejects templates when a host references an unknown network zone', async () => {
    await request(app.getHttpServer())
      .post('/admin/range-templates')
      .set('authorization', 'Bearer dev-admin-token')
      .send({
        name: 'Broken host zone template',
        slug: 'broken-host-zone-template',
        version: 'v1',
        modulePathOrRef: 'infra/opentofu/modules/alicloud-enterprise-range',
        topologySpec: {
          vpcCidr: '10.70.0.0/16',
          networkZones: [
            {
              key: 'dmz',
              name: 'DMZ',
              purpose: 'public-entry',
              cidr: '10.70.10.0/24',
              isPublicEntry: true,
            },
          ],
          hosts: [
            {
              key: 'dmz-entry',
              name: 'DMZ Entry',
              zoneKey: 'missing-zone',
              role: 'entry',
              privateIp: '10.70.10.10',
              exposePublic: true,
            },
          ],
          publicEntry: {
            hostKey: 'dmz-entry',
            protocols: [{ protocol: 'ssh', port: 22 }],
          },
        },
      })
      .expect(400);
  });

  it('rejects templates when public entry host is missing from hosts', async () => {
    await request(app.getHttpServer())
      .post('/admin/range-templates')
      .set('authorization', 'Bearer dev-admin-token')
      .send({
        name: 'Broken public entry template',
        slug: 'broken-public-entry-template',
        version: 'v1',
        modulePathOrRef: 'infra/opentofu/modules/alicloud-enterprise-range',
        topologySpec: {
          vpcCidr: '10.70.0.0/16',
          networkZones: [
            {
              key: 'dmz',
              name: 'DMZ',
              purpose: 'public-entry',
              cidr: '10.70.10.0/24',
              isPublicEntry: true,
            },
          ],
          hosts: [
            {
              key: 'dmz-app',
              name: 'DMZ App',
              zoneKey: 'dmz',
              role: 'app',
              privateIp: '10.70.10.20',
            },
          ],
          publicEntry: {
            hostKey: 'dmz-entry',
            protocols: [{ protocol: 'ssh', port: 22 }],
          },
        },
      })
      .expect(400);
  });

  it('rejects destroying a draft range instance', async () => {
    const fixture = await createProvisioningFixture();

    await request(app.getHttpServer())
      .post(`/admin/range-instances/${fixture.rangeInstanceId}/destroy`)
      .set('authorization', 'Bearer dev-admin-token')
      .send({
        triggeredBy: 'admin',
      })
      .expect(409);
  });

  it('rejects starting a second create job for a running range instance', async () => {
    const fixture = await createProvisioningFixture();

    await request(app.getHttpServer())
      .post(`/admin/range-instances/${fixture.rangeInstanceId}/create`)
      .set('authorization', 'Bearer dev-admin-token')
      .send({
        triggeredBy: 'admin',
      })
      .expect(201);

    await waitForRangeInstanceStatus(fixture.rangeInstanceId, 'running');

    await request(app.getHttpServer())
      .post(`/admin/range-instances/${fixture.rangeInstanceId}/create`)
      .set('authorization', 'Bearer dev-admin-token')
      .send({
        triggeredBy: 'admin',
      })
      .expect(409);
  });
});
