import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { ADMIN_REPOSITORY } from '../src/admin/admin.repository';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap/configure-app';
import { RANGE_PROVISIONER, type RangeProvisioner } from '../src/provisioning/provisioning.types';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';

describe('Admin provisioning failures', () => {
  let app: INestApplication;

  const failingProvisioner: RangeProvisioner = {
    async create(input) {
      await input.reportStep?.({
        stepName: 'tofu_plan',
        status: 'running',
        message: 'Fake plan started.',
      });
      await input.reportStep?.({
        stepName: 'tofu_plan',
        status: 'failed',
        message: 'Fake plan failed.',
        stderrExcerpt: 'simulated stderr from fake plan',
      });

      throw new Error('OpenTofu plan failed in fake provisioner');
    },
    async destroy() {
      return;
    },
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
      .overrideProvider(RANGE_PROVISIONER)
      .useValue(failingProvisioner)
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

  it('copies failed job errors onto the range instance detail and keeps failed step logs', async () => {
    const competition = await request(app.getHttpServer())
      .post('/admin/competitions')
      .set('authorization', 'Bearer dev-admin-token')
      .send({
        name: 'Failure Drill',
      })
      .expect(201);

    const team = await request(app.getHttpServer())
      .post('/admin/teams')
      .set('authorization', 'Bearer dev-admin-token')
      .send({
        competitionId: competition.body.id,
        name: 'Red Team',
      })
      .expect(201);

    const template = await request(app.getHttpServer())
      .post('/admin/range-templates')
      .set('authorization', 'Bearer dev-admin-token')
      .send({
        name: 'Failure Template',
        slug: `failure-template-${Date.now()}`,
        version: 'v1',
        modulePathOrRef: 'infra/opentofu/modules/alicloud-enterprise-range',
        topologySpec: {
          vpcCidr: '10.75.0.0/16',
          networkZones: [
            {
              key: 'dmz',
              name: 'DMZ',
              purpose: 'public-entry',
              cidr: '10.75.10.0/24',
              isPublicEntry: true,
            },
            {
              key: 'office',
              name: 'Office',
              purpose: 'user-workstations',
              cidr: '10.75.20.0/24',
            },
            {
              key: 'server',
              name: 'Server',
              purpose: 'application-servers',
              cidr: '10.75.30.0/24',
            },
          ],
          hosts: [
            {
              key: 'dmz-entry',
              name: 'DMZ Entry',
              zoneKey: 'dmz',
              role: 'entry',
              privateIp: '10.75.10.10',
              exposePublic: true,
            },
            {
              key: 'office-client',
              name: 'Office Client',
              zoneKey: 'office',
              role: 'workstation',
              privateIp: '10.75.20.10',
            },
            {
              key: 'server-app',
              name: 'Server App',
              zoneKey: 'server',
              role: 'app',
              privateIp: '10.75.30.10',
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

    const createJob = await request(app.getHttpServer())
      .post(`/admin/range-instances/${instance.body.id}/create`)
      .set('authorization', 'Bearer dev-admin-token')
      .send({
        triggeredBy: 'admin',
      })
      .expect(201);

    await waitForRangeInstanceStatus(instance.body.id, 'create_failed');

    const instanceDetail = await request(app.getHttpServer())
      .get(`/admin/range-instances/${instance.body.id}`)
      .set('authorization', 'Bearer dev-admin-token')
      .expect(200);

    expect(instanceDetail.body).toEqual(
      expect.objectContaining({
        id: instance.body.id,
        status: 'create_failed',
        lastJobId: createJob.body.id,
        errorSummary: 'OpenTofu plan failed in fake provisioner',
      }),
    );

    const jobDetail = await request(app.getHttpServer())
      .get(`/admin/provision-jobs/${createJob.body.id}`)
      .set('authorization', 'Bearer dev-admin-token')
      .expect(200);

    expect(jobDetail.body).toEqual(
      expect.objectContaining({
        id: createJob.body.id,
        status: 'failed',
        errorSummary: 'OpenTofu plan failed in fake provisioner',
      }),
    );

    const jobSteps = await request(app.getHttpServer())
      .get(`/admin/provision-jobs/${createJob.body.id}/steps`)
      .set('authorization', 'Bearer dev-admin-token')
      .expect(200);

    expect(jobSteps.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stepName: 'prepare',
          status: 'succeeded',
        }),
        expect.objectContaining({
          stepName: 'tofu_plan',
          status: 'failed',
          message: 'Fake plan failed.',
          stderrExcerpt: 'simulated stderr from fake plan',
        }),
      ]),
    );
  });
});
