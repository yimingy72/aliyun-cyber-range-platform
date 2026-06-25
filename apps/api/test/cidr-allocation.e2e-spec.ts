import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { ADMIN_REPOSITORY } from '../src/admin/admin.repository';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap/configure-app';
import { RANGE_PROVISIONER, RangeProvisioner } from '../src/provisioning/provisioning.types';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';

describe('CIDR allocation', () => {
  let app: INestApplication;
  let competitionId: string;
  let teamId: string;
  let templateId: string;
  let rangeInstanceId: string;
  const envBackup = {
    ADMIN_USERNAME: process.env.ADMIN_USERNAME,
    ADMIN_PASSWORD: process.env.ADMIN_PASSWORD,
    ADMIN_TOKEN: process.env.ADMIN_TOKEN,
    RANGE_PROVISIONER_MODE: process.env.RANGE_PROVISIONER_MODE,
    RANGE_CIDR_POOL: process.env.RANGE_CIDR_POOL,
  };
  const provisionerSpy: RangeProvisioner & {
    create: jest.Mock;
    destroy: jest.Mock;
  } = {
    create: jest.fn().mockResolvedValue({
      accessEntry: {
        url: 'https://range.local/fake',
        ssh: 'ssh root@range.local',
      },
      resourceSummary: {
        mode: 'fake-provisioner',
      },
    }),
    destroy: jest.fn().mockResolvedValue(undefined),
  };

  beforeAll(async () => {
    process.env.ADMIN_USERNAME = 'admin';
    process.env.ADMIN_PASSWORD = 'change-me';
    process.env.ADMIN_TOKEN = 'dev-admin-token';
    process.env.RANGE_PROVISIONER_MODE = 'dry-run';

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(ADMIN_REPOSITORY)
      .useValue(createMemoryAdminRepository())
      .overrideProvider(RANGE_PROVISIONER)
      .useValue(provisionerSpy)
      .compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();

    const competitionResponse = await request(app.getHttpServer())
      .post('/admin/competitions')
      .set('authorization', 'Bearer dev-admin-token')
      .send({
        name: 'Alibaba Cloud Finals 2026',
        description: 'Final round cyber range event',
        status: 'scheduled',
      })
      .expect(201);

    competitionId = competitionResponse.body.id as string;

    const teamResponse = await request(app.getHttpServer())
      .post('/admin/teams')
      .set('authorization', 'Bearer dev-admin-token')
      .send({
        competitionId,
        name: 'Blue Team',
        contactName: 'Alice',
        contactEmailOrPhone: 'alice@example.com',
      })
      .expect(201);

    teamId = teamResponse.body.id as string;

    const templateResponse = await request(app.getHttpServer())
      .post('/admin/range-templates')
      .set('authorization', 'Bearer dev-admin-token')
      .send({
        name: 'Enterprise Practice Range',
        slug: 'enterprise-practice-range',
        version: 'v1',
        cloudProvider: 'alibaba_cloud',
        iacType: 'opentofu',
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
        variableSchema: {
          vpc_cidr: 'string',
        },
        outputSchema: {
          public_entry: 'object',
        },
      })
      .expect(201);

    templateId = templateResponse.body.id as string;

    await request(app.getHttpServer())
      .post(`/admin/range-templates/${templateId}/publish`)
      .set('authorization', 'Bearer dev-admin-token')
      .expect(200);

    const rangeInstanceResponse = await request(app.getHttpServer())
      .post('/admin/range-instances')
      .set('authorization', 'Bearer dev-admin-token')
      .send({
        competitionId,
        teamId,
        templateId,
      })
      .expect(201);

    rangeInstanceId = rangeInstanceResponse.body.id as string;
  });

  afterAll(async () => {
    process.env.ADMIN_USERNAME = envBackup.ADMIN_USERNAME;
    process.env.ADMIN_PASSWORD = envBackup.ADMIN_PASSWORD;
    process.env.ADMIN_TOKEN = envBackup.ADMIN_TOKEN;
    process.env.RANGE_PROVISIONER_MODE = envBackup.RANGE_PROVISIONER_MODE;
    process.env.RANGE_CIDR_POOL = envBackup.RANGE_CIDR_POOL;
    await app.close();
  });

  it('prefers the template vpc cidr over the optional cidr pool when creation starts', async () => {
    process.env.RANGE_CIDR_POOL = '10.80.0.0/16,10.81.0.0/16';

    const triggerResponse = await request(app.getHttpServer())
      .post(`/admin/range-instances/${rangeInstanceId}/create`)
      .set('authorization', 'Bearer dev-admin-token')
      .send({ triggeredBy: 'admin' })
      .expect(201);

    expect(triggerResponse.body).toEqual(
      expect.objectContaining({
        jobType: 'create',
      }),
    );

    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (provisionerSpy.create.mock.calls.length > 0) {
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(provisionerSpy.create).toHaveBeenCalledWith(
      expect.objectContaining({
        allocatedCidr: '10.70.0.0/16',
      }),
    );

    const instancesResponse = await request(app.getHttpServer())
      .get('/admin/range-instances')
      .set('authorization', 'Bearer dev-admin-token')
      .expect(200);

    expect(instancesResponse.body[0]).toEqual(
      expect.objectContaining({
        allocatedCidr: '10.70.0.0/16',
      }),
    );
  });

  it('does not require a cidr pool when the template already defines a fixed vpc cidr', async () => {
    process.env.RANGE_CIDR_POOL = '';

    const draftInstanceResponse = await request(app.getHttpServer())
      .post('/admin/range-instances')
      .set('authorization', 'Bearer dev-admin-token')
      .send({
        competitionId,
        teamId,
        templateId,
      })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/admin/range-instances/${draftInstanceResponse.body.id}/create`)
      .set('authorization', 'Bearer dev-admin-token')
      .send({ triggeredBy: 'admin' })
      .expect(201);

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const matchingCall = provisionerSpy.create.mock.calls.find(
        ([input]) => input.rangeInstanceId === draftInstanceResponse.body.id,
      );

      if (matchingCall) {
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(provisionerSpy.create).toHaveBeenCalledWith(
      expect.objectContaining({
        rangeInstanceId: draftInstanceResponse.body.id,
        allocatedCidr: '10.70.0.0/16',
      }),
    );

    const instanceDetailResponse = await request(app.getHttpServer())
      .get(`/admin/range-instances/${draftInstanceResponse.body.id}`)
      .set('authorization', 'Bearer dev-admin-token')
      .expect(200);

    expect(instanceDetailResponse.body).toEqual(
      expect.objectContaining({
        id: draftInstanceResponse.body.id,
        allocatedCidr: '10.70.0.0/16',
      }),
    );
  });
});
