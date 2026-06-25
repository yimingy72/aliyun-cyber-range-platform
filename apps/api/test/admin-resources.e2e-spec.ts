import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { ADMIN_REPOSITORY } from '../src/admin/admin.repository';
import { configureApp } from '../src/bootstrap/configure-app';
import { AppModule } from '../src/app.module';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';

describe('Admin resources', () => {
  const fixtureTopologySpec = {
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
      protocols: [
        { protocol: 'ssh', port: 22 },
        { protocol: 'http', port: 80 },
      ],
    },
  };

  let app: INestApplication;
  let competitionId: string;
  let teamId: string;
  let templateId: string;
  let rangeInstanceId: string;

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

  it('rejects unauthenticated competition access', async () => {
    await request(app.getHttpServer()).get('/admin/competitions').expect(401);
  });

  it('creates and lists competitions', async () => {
    const createResponse = await request(app.getHttpServer())
      .post('/admin/competitions')
      .set('authorization', 'Bearer dev-admin-token')
      .send({
        name: 'Alibaba Cloud Finals 2026',
        description: 'Final round cyber range event',
        status: 'scheduled',
      })
      .expect(201);

    expect(createResponse.body).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        name: 'Alibaba Cloud Finals 2026',
        description: 'Final round cyber range event',
        status: 'scheduled',
      }),
    );

    competitionId = createResponse.body.id;

    const listResponse = await request(app.getHttpServer())
      .get('/admin/competitions')
      .set('authorization', 'Bearer dev-admin-token')
      .expect(200);

    expect(listResponse.body).toEqual([
      expect.objectContaining({
        id: competitionId,
        name: 'Alibaba Cloud Finals 2026',
      }),
    ]);
  });

  it('creates and lists teams', async () => {
    const createResponse = await request(app.getHttpServer())
      .post('/admin/teams')
      .set('authorization', 'Bearer dev-admin-token')
      .send({
        competitionId,
        name: 'Blue Team',
        contactName: 'Alice',
        contactEmailOrPhone: 'alice@example.com',
      })
      .expect(201);

    expect(createResponse.body).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        competitionId,
        name: 'Blue Team',
      }),
    );

    teamId = createResponse.body.id;

    const listResponse = await request(app.getHttpServer())
      .get(`/admin/teams?competitionId=${competitionId}`)
      .set('authorization', 'Bearer dev-admin-token')
      .expect(200);

    expect(listResponse.body).toEqual([
      expect.objectContaining({
        competitionId,
        name: 'Blue Team',
      }),
    ]);
  });

  it('creates and lists templates', async () => {
    const createResponse = await request(app.getHttpServer())
      .post('/admin/range-templates')
      .set('authorization', 'Bearer dev-admin-token')
      .send({
        name: 'Enterprise Practice Range',
        slug: 'enterprise-practice-range',
        version: 'v1',
        cloudProvider: 'alibaba_cloud',
        iacType: 'opentofu',
        modulePathOrRef: 'infra/opentofu/modules/alicloud-enterprise-range',
        topologySpec: fixtureTopologySpec,
        variableSchema: {
          vpc_cidr: 'string',
        },
        outputSchema: {
          public_entry: 'object',
        },
      })
      .expect(201);

    expect(createResponse.body).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        name: 'Enterprise Practice Range',
        slug: 'enterprise-practice-range',
        currentDraftVersionId: expect.any(String),
        currentPublishedVersionId: null,
        currentDraftVersion: expect.objectContaining({
          id: expect.any(String),
          status: 'draft',
          version: 'v1',
          topologySpec: expect.objectContaining({
            networkZones: expect.arrayContaining([
              expect.objectContaining({
                key: 'dmz',
                isPublicEntry: true,
              }),
            ]),
            hosts: expect.arrayContaining([
              expect.objectContaining({
                key: 'dmz-entry',
                role: 'entry',
                exposePublic: true,
              }),
            ]),
            publicEntry: expect.objectContaining({
              hostKey: 'dmz-entry',
            }),
          }),
        }),
      }),
    );

    templateId = createResponse.body.id;

    const listResponse = await request(app.getHttpServer())
      .get('/admin/range-templates')
      .set('authorization', 'Bearer dev-admin-token')
      .expect(200);

    expect(listResponse.body).toEqual([
      expect.objectContaining({
        slug: 'enterprise-practice-range',
        currentDraftVersionId: expect.any(String),
        currentPublishedVersionId: null,
        currentDraftVersion: expect.objectContaining({
          status: 'draft',
          version: 'v1',
          topologySpec: expect.objectContaining({
            networkZones: expect.any(Array),
            hosts: expect.any(Array),
            publicEntry: expect.any(Object),
          }),
        }),
      }),
    ]);
  });

  it('accepts topologyGraph and compiledSpec alongside topologySpec', async () => {
    const response = await request(app.getHttpServer())
      .post('/admin/range-templates')
      .set('authorization', 'Bearer dev-admin-token')
      .send({
        name: 'Hybrid Template',
        slug: 'hybrid-template',
        version: 'v1',
        modulePathOrRef: 'infra/opentofu/modules/alicloud-enterprise-range',
        topologySpec: fixtureTopologySpec,
        topologyGraph: {
          schemaVersion: '1.0.0',
          nodes: [{ id: 'switch-dmz', kind: 'switch', data: { cidr: '10.70.10.0/24' } }],
          edges: [],
        },
        compiledSpec: {
          schemaVersion: '1.0.0',
          resources: [{ id: 'switch-dmz', type: 'switch', config: { cidr: '10.70.10.0/24' } }],
        },
      })
      .expect(201);

    expect(response.body).toEqual(
      expect.objectContaining({
        topologyGraph: expect.objectContaining({ schemaVersion: '1.0.0' }),
        compiledSpec: expect.objectContaining({ schemaVersion: '1.0.0' }),
        currentDraftVersion: expect.objectContaining({
          topologyGraph: expect.objectContaining({ schemaVersion: '1.0.0' }),
          compiledSpec: expect.objectContaining({ schemaVersion: '1.0.0' }),
        }),
      }),
    );
  });

  it('rejects null topologyGraph on template creation', async () => {
    await request(app.getHttpServer())
      .post('/admin/range-templates')
      .set('authorization', 'Bearer dev-admin-token')
      .send({
        name: 'Invalid Null Graph Template',
        slug: 'invalid-null-graph-template',
        version: 'v1',
        modulePathOrRef: 'infra/opentofu/modules/alicloud-enterprise-range',
        topologySpec: fixtureTopologySpec,
        topologyGraph: null,
      })
      .expect(400)
      .expect(({ body }) => {
        expect(body.message).toContain('topologyGraph must be an object');
      });

    const listResponse = await request(app.getHttpServer())
      .get('/admin/range-templates')
      .set('authorization', 'Bearer dev-admin-token')
      .expect(200);

    expect(listResponse.body).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          slug: 'invalid-null-graph-template',
        }),
      ]),
    );
  });

  it('rejects array compiledSpec on template creation', async () => {
    await request(app.getHttpServer())
      .post('/admin/range-templates')
      .set('authorization', 'Bearer dev-admin-token')
      .send({
        name: 'Invalid Array Compiled Template',
        slug: 'invalid-array-compiled-template',
        version: 'v1',
        modulePathOrRef: 'infra/opentofu/modules/alicloud-enterprise-range',
        topologySpec: fixtureTopologySpec,
        compiledSpec: [],
      })
      .expect(400)
      .expect(({ body }) => {
        expect(body.message).toContain('compiledSpec must be an object');
      });

    const listResponse = await request(app.getHttpServer())
      .get('/admin/range-templates')
      .set('authorization', 'Bearer dev-admin-token')
      .expect(200);

    expect(listResponse.body).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          slug: 'invalid-array-compiled-template',
        }),
      ]),
    );
  });

  it('publishes a template and keeps a fresh draft version for later edits', async () => {
    const publishResponse = await request(app.getHttpServer())
      .post(`/admin/range-templates/${templateId}/publish`)
      .set('authorization', 'Bearer dev-admin-token')
      .expect(200);

    expect(publishResponse.body).toEqual(
      expect.objectContaining({
        id: templateId,
        currentPublishedVersionId: expect.any(String),
        currentDraftVersionId: expect.any(String),
        currentPublishedVersion: expect.objectContaining({
          status: 'published',
          version: 'v1',
        }),
        currentDraftVersion: expect.objectContaining({
          status: 'draft',
          version: 'v1',
        }),
      }),
    );

    expect(publishResponse.body.currentDraftVersionId).not.toBe(publishResponse.body.currentPublishedVersionId);
  });

  it('updates competitions, teams, and templates', async () => {
    const competitionResponse = await request(app.getHttpServer())
      .patch(`/admin/competitions/${competitionId}`)
      .set('authorization', 'Bearer dev-admin-token')
      .send({
        description: 'Updated final round event',
        status: 'active',
      })
      .expect(200);

    expect(competitionResponse.body).toEqual(
      expect.objectContaining({
        id: competitionId,
        description: 'Updated final round event',
        status: 'active',
      }),
    );

    const teamResponse = await request(app.getHttpServer())
      .patch(`/admin/teams/${teamId}`)
      .set('authorization', 'Bearer dev-admin-token')
      .send({
        contactName: 'Alice Zhang',
      })
      .expect(200);

    expect(teamResponse.body).toEqual(
      expect.objectContaining({
        id: teamId,
        contactName: 'Alice Zhang',
      }),
    );

    const templateResponse = await request(app.getHttpServer())
      .patch(`/admin/range-templates/${templateId}`)
      .set('authorization', 'Bearer dev-admin-token')
      .send({
        version: 'v1.1.0',
        topologyGraph: {
          schemaVersion: '1.0.0',
          nodes: [
            {
              id: 'host-1',
              kind: 'host',
              label: '边界主机',
              zoneKey: 'dmz',
              role: 'entry',
              privateIp: '10.70.10.10',
              exposePublic: true,
            },
          ],
          edges: [],
        },
        compiledSpec: {
          schemaVersion: '1.0.0',
          resources: [
            {
              id: 'ecs-entry',
              type: 'alicloud_instance',
              config: {
                zoneKey: 'dmz',
                privateIp: '10.70.10.10',
              },
            },
          ],
        },
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
              key: 'server-db',
              name: 'Server DB',
              zoneKey: 'server',
              role: 'db',
              privateIp: '10.70.30.20',
            },
          ],
          publicEntry: {
            hostKey: 'dmz-entry',
            protocols: [{ protocol: 'ssh', port: 22 }],
          },
        },
      })
      .expect(200);

    expect(templateResponse.body).toEqual(
      expect.objectContaining({
        id: templateId,
        version: 'v1.1.0',
        topologyGraph: expect.objectContaining({
          nodes: expect.arrayContaining([
            expect.objectContaining({
              id: 'host-1',
              label: '边界主机',
            }),
          ]),
        }),
        compiledSpec: expect.objectContaining({
          resources: expect.arrayContaining([
            expect.objectContaining({
              id: 'ecs-entry',
              type: 'alicloud_instance',
            }),
          ]),
        }),
        currentDraftVersion: expect.objectContaining({
          version: 'v1.1.0',
          topologyGraph: expect.objectContaining({
            nodes: expect.arrayContaining([
              expect.objectContaining({
                id: 'host-1',
                label: '边界主机',
              }),
            ]),
          }),
          topologySpec: expect.objectContaining({
            hosts: expect.arrayContaining([
              expect.objectContaining({
                key: 'server-db',
                role: 'db',
              }),
            ]),
          }),
        }),
        currentPublishedVersion: expect.objectContaining({
          version: 'v1',
        }),
      }),
    );
  });

  it('rejects invalid topologyGraph and compiledSpec on template update', async () => {
    const originalTemplateList = await request(app.getHttpServer())
      .get('/admin/range-templates')
      .set('authorization', 'Bearer dev-admin-token')
      .expect(200);

    const originalTemplate = originalTemplateList.body.find(
      (template: { id: string }) => template.id === templateId,
    );

    expect(originalTemplate).toBeDefined();

    await request(app.getHttpServer())
      .patch(`/admin/range-templates/${templateId}`)
      .set('authorization', 'Bearer dev-admin-token')
      .send({
        topologyGraph: [],
      })
      .expect(400)
      .expect(({ body }) => {
        expect(body.message).toContain('topologyGraph must be an object');
      });

    await request(app.getHttpServer())
      .patch(`/admin/range-templates/${templateId}`)
      .set('authorization', 'Bearer dev-admin-token')
      .send({
        compiledSpec: null,
      })
      .expect(400)
      .expect(({ body }) => {
        expect(body.message).toContain('compiledSpec must be an object');
      });

    const afterInvalidUpdateList = await request(app.getHttpServer())
      .get('/admin/range-templates')
      .set('authorization', 'Bearer dev-admin-token')
      .expect(200);

    const afterInvalidUpdate = afterInvalidUpdateList.body.find(
      (template: { id: string }) => template.id === templateId,
    );

    expect(afterInvalidUpdate).toBeDefined();

    expect(afterInvalidUpdate.topologyGraph).toEqual(originalTemplate.topologyGraph);
    expect(afterInvalidUpdate.compiledSpec).toEqual(originalTemplate.compiledSpec);
    expect(afterInvalidUpdate.currentDraftVersion.topologyGraph).toEqual(
      originalTemplate.currentDraftVersion.topologyGraph,
    );
    expect(afterInvalidUpdate.currentDraftVersion.compiledSpec).toEqual(
      originalTemplate.currentDraftVersion.compiledSpec,
    );
  });

  it('publishes updated draft changes into a new published template version', async () => {
    const publishResponse = await request(app.getHttpServer())
      .post(`/admin/range-templates/${templateId}/publish`)
      .set('authorization', 'Bearer dev-admin-token')
      .expect(200);

    expect(publishResponse.body).toEqual(
      expect.objectContaining({
        id: templateId,
        version: 'v1.1.0',
        currentPublishedVersion: expect.objectContaining({
          version: 'v1.1.0',
          topologyGraph: expect.objectContaining({
            nodes: expect.arrayContaining([
              expect.objectContaining({
                id: 'host-1',
                label: '边界主机',
              }),
            ]),
          }),
          topologySpec: expect.objectContaining({
            hosts: expect.arrayContaining([
              expect.objectContaining({
                key: 'server-db',
                role: 'db',
              }),
            ]),
          }),
        }),
        currentDraftVersion: expect.objectContaining({
          topologyGraph: expect.objectContaining({
            nodes: expect.arrayContaining([
              expect.objectContaining({
                id: 'host-1',
                label: '边界主机',
              }),
            ]),
          }),
        }),
      }),
    );
  });

  it('lists empty range instances before provisioning starts', async () => {
    const response = await request(app.getHttpServer())
      .get('/admin/range-instances')
      .set('authorization', 'Bearer dev-admin-token')
      .expect(200);

    expect(response.body).toEqual([]);
  });

  it('creates a draft range instance for a team and template', async () => {
    const createResponse = await request(app.getHttpServer())
      .post('/admin/range-instances')
      .set('authorization', 'Bearer dev-admin-token')
      .send({
        competitionId,
        teamId,
        templateId,
      })
      .expect(201);

    expect(createResponse.body).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        competitionId,
        teamId,
        templateId,
        status: 'draft',
      }),
    );

    rangeInstanceId = createResponse.body.id;
  });

  it('returns range instance detail by id', async () => {
    const detailResponse = await request(app.getHttpServer())
      .get(`/admin/range-instances/${rangeInstanceId}`)
      .set('authorization', 'Bearer dev-admin-token')
      .expect(200);

    expect(detailResponse.body).toEqual(
      expect.objectContaining({
        id: rangeInstanceId,
        competitionId,
        teamId,
        templateId,
        status: 'draft',
        accessEntry: null,
        resourceSummary: null,
        lastJobId: null,
      }),
    );
  });

  it('provisions and destroys a range instance through create and destroy jobs', async () => {
    const createJobResponse = await request(app.getHttpServer())
      .post(`/admin/range-instances/${rangeInstanceId}/create`)
      .set('authorization', 'Bearer dev-admin-token')
      .send({
        triggeredBy: 'admin',
      })
      .expect(201);

    expect(createJobResponse.body).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        rangeInstanceId,
        jobType: 'create',
        status: 'pending',
      }),
    );

    const runningInstance = await waitForRangeInstanceStatus(rangeInstanceId, 'running');

    expect(runningInstance).toEqual(
      expect.objectContaining({
        id: rangeInstanceId,
        status: 'running',
        accessEntry: expect.objectContaining({
          hostRole: 'dmz',
          publicIp: null,
          privateIp: null,
          url: `https://range.local/${rangeInstanceId}`,
          ssh: `ssh root@${rangeInstanceId}.range.local`,
        }),
        resourceSummary: expect.objectContaining({
          mode: 'dry-run',
          modulePath: 'infra/opentofu/modules/alicloud-enterprise-range',
          topologySpec: expect.objectContaining({
            vpcCidr: '10.70.0.0/16',
            publicEntryHostKey: 'dmz-entry',
            networkZoneKeys: expect.arrayContaining(['dmz', 'server']),
            hostKeys: expect.arrayContaining(['dmz-entry', 'server-db']),
          }),
        }),
      }),
    );

    const runningDetailResponse = await request(app.getHttpServer())
      .get(`/admin/range-instances/${rangeInstanceId}`)
      .set('authorization', 'Bearer dev-admin-token')
      .expect(200);

    expect(runningDetailResponse.body).toEqual(
      expect.objectContaining({
        id: rangeInstanceId,
        status: 'running',
        lastJobId: createJobResponse.body.id,
        accessEntry: expect.objectContaining({
          hostRole: 'dmz',
          url: `https://range.local/${rangeInstanceId}`,
        }),
        resourceSummary: expect.objectContaining({
          mode: 'dry-run',
        }),
      }),
    );

    const jobsResponse = await request(app.getHttpServer())
      .get('/admin/provision-jobs')
      .set('authorization', 'Bearer dev-admin-token')
      .expect(200);

    const jobDetailResponse = await request(app.getHttpServer())
      .get(`/admin/provision-jobs/${createJobResponse.body.id}`)
      .set('authorization', 'Bearer dev-admin-token')
      .expect(200);

    expect(jobDetailResponse.body).toEqual(
      expect.objectContaining({
        id: createJobResponse.body.id,
        rangeInstanceId,
        jobType: 'create',
      }),
    );

    const jobStepsResponse = await request(app.getHttpServer())
      .get(`/admin/provision-jobs/${createJobResponse.body.id}/steps`)
      .set('authorization', 'Bearer dev-admin-token')
      .expect(200);

    expect(jobStepsResponse.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stepName: 'prepare',
          status: 'succeeded',
        }),
        expect.objectContaining({
          stepName: 'render_template',
          status: 'succeeded',
        }),
        expect.objectContaining({
          stepName: 'tofu_init',
          status: 'succeeded',
        }),
        expect.objectContaining({
          stepName: 'tofu_plan',
          status: 'succeeded',
        }),
        expect.objectContaining({
          stepName: 'tofu_apply',
          status: 'succeeded',
        }),
        expect.objectContaining({
          stepName: 'collect_outputs',
          status: 'succeeded',
        }),
        expect.objectContaining({
          stepName: 'persist_access_entry',
          status: 'succeeded',
        }),
      ]),
    );

    expect(jobsResponse.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rangeInstanceId,
          jobType: 'create',
          status: 'succeeded',
        }),
      ]),
    );

    const destroyJobResponse = await request(app.getHttpServer())
      .post(`/admin/range-instances/${rangeInstanceId}/destroy`)
      .set('authorization', 'Bearer dev-admin-token')
      .send({
        triggeredBy: 'admin',
      })
      .expect(201);

    expect(destroyJobResponse.body).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        rangeInstanceId,
        jobType: 'destroy',
        status: 'pending',
      }),
    );

    const destroyedInstance = await waitForRangeInstanceStatus(rangeInstanceId, 'destroyed');

    expect(destroyedInstance).toEqual(
      expect.objectContaining({
        id: rangeInstanceId,
        status: 'destroyed',
      }),
    );

    const destroyJobStepsResponse = await request(app.getHttpServer())
      .get(`/admin/provision-jobs/${destroyJobResponse.body.id}/steps`)
      .set('authorization', 'Bearer dev-admin-token')
      .expect(200);

    expect(destroyJobStepsResponse.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stepName: 'prepare',
          status: 'succeeded',
        }),
        expect.objectContaining({
          stepName: 'render_template',
          status: 'succeeded',
        }),
        expect.objectContaining({
          stepName: 'tofu_init',
          status: 'succeeded',
        }),
        expect.objectContaining({
          stepName: 'destroy',
          status: 'succeeded',
        }),
      ]),
    );
  });

  it('deletes teams, competitions, and templates', async () => {
    await request(app.getHttpServer())
      .delete(`/admin/teams/${teamId}`)
      .set('authorization', 'Bearer dev-admin-token')
      .expect(204);

    await request(app.getHttpServer())
      .delete(`/admin/competitions/${competitionId}`)
      .set('authorization', 'Bearer dev-admin-token')
      .expect(204);

    await request(app.getHttpServer())
      .delete(`/admin/range-templates/${templateId}`)
      .set('authorization', 'Bearer dev-admin-token')
      .expect(204);
  });
});
