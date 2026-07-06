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
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const response = await request(app.getHttpServer())
        .get(`/admin/ranges/${id}`)
        .set('authorization', 'Bearer dev-admin-token')
        .expect(200);

      if (response.body?.status === status) {
        return response.body;
      }

      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    throw new Error(`Range instance ${id} did not reach status ${status}`);
  }

  async function createProvisioningFixture() {
    const repository = app.get(ADMIN_REPOSITORY);
    const template = await request(app.getHttpServer())
      .post('/admin/scenarios')
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
            {
              key: 'office',
              name: 'Office',
              purpose: 'user-workstations',
              cidr: '10.70.20.0/24',
            },
            {
              key: 'server',
              name: 'Server',
              purpose: 'application-servers',
              cidr: '10.70.30.0/24',
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
            {
              key: 'office-client',
              name: 'Office Client',
              zoneKey: 'office',
              role: 'workstation',
              privateIp: '10.70.20.10',
            },
            {
              key: 'server-app',
              name: 'Server App',
              zoneKey: 'server',
              role: 'app',
              privateIp: '10.70.30.10',
            },
          ],
          publicEntry: {
            hostKey: 'dmz-entry',
            protocols: [{ protocol: 'ssh', port: 22 }],
          },
        },
      })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/admin/scenarios/${template.body.id}/publish`)
      .set('authorization', 'Bearer dev-admin-token')
      .expect(200);

    const instance = await request(app.getHttpServer())
      .post('/admin/ranges')
      .set('authorization', 'Bearer dev-admin-token')
      .send({
        name: `Fixture Range ${Date.now()}`,
        templateId: template.body.id,
      })
      .expect(201);

    return {
      templateId: template.body.id,
      rangeInstanceId: instance.body.id,
    };
  }

  it('rejects templates without a module path', async () => {
    await request(app.getHttpServer())
      .post('/admin/scenarios')
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
      .post('/admin/scenarios')
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
      .post('/admin/scenarios')
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
      .post('/admin/scenarios')
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

  it('rejects publishing a template when compiled topology summary mismatches topology spec', async () => {
    const template = await request(app.getHttpServer())
      .post('/admin/scenarios')
      .set('authorization', 'Bearer dev-admin-token')
      .send({
        name: 'Broken compiled topology template',
        slug: 'broken-compiled-topology-template',
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
        compiledSpec: {
          schemaVersion: '1.0.0',
          resources: [],
          topology: {
            vpcCidr: '10.70.0.0/16',
            publicEntryHostKey: 'wrong-host',
            networkZoneKeys: ['dmz'],
            hostKeys: ['dmz-entry'],
          },
        },
      })
      .expect(201);

    const publishResponse = await request(app.getHttpServer())
      .post(`/admin/scenarios/${template.body.id}/publish`)
      .set('authorization', 'Bearer dev-admin-token')
      .expect(400);

    expect(String(publishResponse.body.message)).toContain('compiledSpec topology does not match topologySpec');
  });

  it('rejects templates when public entry host is missing from hosts', async () => {
    await request(app.getHttpServer())
      .post('/admin/scenarios')
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
      .post(`/admin/ranges/${fixture.rangeInstanceId}/destroy`)
      .set('authorization', 'Bearer dev-admin-token')
      .send({
        triggeredBy: 'admin',
      })
      .expect(409);
  });

  it('rejects starting a second create job for a running range instance', async () => {
    const fixture = await createProvisioningFixture();

    await request(app.getHttpServer())
      .post(`/admin/ranges/${fixture.rangeInstanceId}/create`)
      .set('authorization', 'Bearer dev-admin-token')
      .send({
        triggeredBy: 'admin',
      })
      .expect(201);

    await waitForRangeInstanceStatus(fixture.rangeInstanceId, 'running');

    await request(app.getHttpServer())
      .post(`/admin/ranges/${fixture.rangeInstanceId}/create`)
      .set('authorization', 'Bearer dev-admin-token')
      .send({
        triggeredBy: 'admin',
      })
      .expect(409);
  });

  it('rejects retrying a running range instance', async () => {
    const fixture = await createProvisioningFixture();

    await request(app.getHttpServer())
      .post(`/admin/ranges/${fixture.rangeInstanceId}/create`)
      .set('authorization', 'Bearer dev-admin-token')
      .send({
        triggeredBy: 'admin',
      })
      .expect(201);

    await waitForRangeInstanceStatus(fixture.rangeInstanceId, 'running');

    await request(app.getHttpServer())
      .post(`/admin/ranges/${fixture.rangeInstanceId}/retry`)
      .set('authorization', 'Bearer dev-admin-token')
      .send({
        triggeredBy: 'admin',
      })
      .expect(409);
  });
});
