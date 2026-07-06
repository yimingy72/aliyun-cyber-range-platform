import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { ADMIN_REPOSITORY, type AdminRepository } from '../src/admin/admin.repository';
import { SystemConfigService } from '../src/admin/system-config.service';
import { configureApp } from '../src/bootstrap/configure-app';
import { AppModule } from '../src/app.module';
import { ProvisioningWorkerService } from '../src/provisioning/provisioning-worker.service';
import { RANGE_PROVISIONER, type RangeProvisioner } from '../src/provisioning/provisioning.types';
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
  };
}

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
  let repository: AdminRepository;
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
      .overrideProvider(SystemConfigService)
      .useValue(createSystemConfigServiceStub())
      .compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();

    repository = app.get(ADMIN_REPOSITORY);
  });

  afterAll(async () => {
    await app.close();
  });

  it('creates and lists scenarios', async () => {
    const createResponse = await request(app.getHttpServer())
      .post('/admin/scenarios')
      .set('authorization', 'Bearer dev-admin-token')
      .send({
        name: 'Enterprise Practice Range',
        description: '用于企业网络渗透演练的默认靶场模板',
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
        description: '用于企业网络渗透演练的默认靶场模板',
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
      .get('/admin/scenarios')
      .set('authorization', 'Bearer dev-admin-token')
      .expect(200);

    expect(listResponse.body).toEqual([
      expect.objectContaining({
        description: '用于企业网络渗透演练的默认靶场模板',
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
      .post('/admin/scenarios')
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

  it('clones an existing scenario and keeps its description and topology blueprint', async () => {
    const cloneResponse = await request(app.getHttpServer())
      .post(`/admin/scenarios/${templateId}/clone`)
      .set('authorization', 'Bearer dev-admin-token')
      .expect(201);

    expect(cloneResponse.body).toEqual(
      expect.objectContaining({
        name: 'Enterprise Practice Range 副本',
        description: '用于企业网络渗透演练的默认靶场模板',
        slug: 'enterprise-practice-range-copy',
        topologySpec: expect.objectContaining({
          publicEntry: expect.objectContaining({
            hostKey: 'dmz-entry',
          }),
        }),
      }),
    );
  });

  it('rejects null topologyGraph on template creation', async () => {
    await request(app.getHttpServer())
      .post('/admin/scenarios')
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
      .get('/admin/scenarios')
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
      .post('/admin/scenarios')
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
      .get('/admin/scenarios')
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
      .post(`/admin/scenarios/${templateId}/publish`)
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

  it('cancels the current published version and removes publish availability', async () => {
    const createResponse = await request(app.getHttpServer())
      .post('/admin/scenarios')
      .set('authorization', 'Bearer dev-admin-token')
      .send({
        name: 'Unpublish Validation Range',
        slug: 'unpublish-validation-range',
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

    const unpublishTemplateId = createResponse.body.id as string;

    const publishResponse = await request(app.getHttpServer())
      .post(`/admin/scenarios/${unpublishTemplateId}/publish`)
      .set('authorization', 'Bearer dev-admin-token')
      .expect(200);

    const unpublishResponse = await request(app.getHttpServer())
      .post(`/admin/scenarios/${unpublishTemplateId}/unpublish`)
      .set('authorization', 'Bearer dev-admin-token')
      .expect(200);

    expect(unpublishResponse.body).toEqual(
      expect.objectContaining({
        id: unpublishTemplateId,
        currentPublishedVersionId: null,
        currentPublishedVersion: null,
        currentDraftVersionId: publishResponse.body.currentDraftVersionId,
        currentDraftVersion: expect.objectContaining({
          status: 'draft',
        }),
      }),
    );

    const latestTemplate = await request(app.getHttpServer())
      .get('/admin/scenarios')
      .set('authorization', 'Bearer dev-admin-token')
      .expect(200);

    expect(
      latestTemplate.body.find((template: { id: string }) => template.id === unpublishTemplateId),
    ).toEqual(
      expect.objectContaining({
        currentPublishedVersionId: null,
      }),
    );
  });

  it('updates templates', async () => {
    const templateResponse = await request(app.getHttpServer())
      .patch(`/admin/scenarios/${templateId}`)
      .set('authorization', 'Bearer dev-admin-token')
      .send({
        description: '更新后的综合靶场描述',
        version: 'v1.1.0',
        topologyGraph: {
          schemaVersion: '1.0.0',
          nodes: [
            {
              id: 'switch-dmz',
              kind: 'switch',
              label: 'DMZ 交换机',
              zoneKey: 'dmz',
              cidr: '10.70.10.0/24',
              purpose: 'public-entry',
              enableNat: false,
              snatEnabled: false,
              snatNatGatewayKey: '',
              snatEipKey: '',
            },
            {
              id: 'switch-office',
              kind: 'switch',
              label: 'Office 交换机',
              zoneKey: 'office',
              cidr: '10.70.20.0/24',
              purpose: 'user-workstations',
              enableNat: false,
              snatEnabled: false,
              snatNatGatewayKey: '',
              snatEipKey: '',
            },
            {
              id: 'switch-server',
              kind: 'switch',
              label: 'Server 交换机',
              zoneKey: 'server',
              cidr: '10.70.30.0/24',
              purpose: 'application-servers',
              enableNat: false,
              snatEnabled: false,
              snatNatGatewayKey: '',
              snatEipKey: '',
            },
            {
              id: 'host-1',
              kind: 'host',
              label: '边界主机',
              zoneKey: 'dmz',
              role: 'entry',
              privateIp: '10.70.10.10',
              exposePublic: true,
              image: 'aliyun_linux_3_x64_20G_alibase',
              dnatMappings: [],
              networkInterfaces: [{ zoneKey: 'dmz', privateIp: '10.70.10.10' }],
              portGroups: [],
              initScript: '',
              imageStrategy: { mode: 'fixed', imageId: 'aliyun_linux_3_x64_20G_alibase' },
              instanceTypeStrategy: { mode: 'auto', preferredInstanceTypes: [] },
            },
            {
              id: 'host-office',
              kind: 'host',
              label: '办公网主机',
              zoneKey: 'office',
              role: 'workstation',
              privateIp: '10.70.20.10',
              exposePublic: false,
              image: 'aliyun_linux_3_x64_20G_alibase',
              dnatMappings: [],
              networkInterfaces: [{ zoneKey: 'office', privateIp: '10.70.20.10' }],
              portGroups: [],
              initScript: '',
              imageStrategy: { mode: 'fixed', imageId: 'aliyun_linux_3_x64_20G_alibase' },
              instanceTypeStrategy: { mode: 'auto', preferredInstanceTypes: [] },
            },
            {
              id: 'host-2',
              kind: 'host',
              label: '数据库主机',
              zoneKey: 'server',
              role: 'db',
              privateIp: '10.70.30.20',
              exposePublic: false,
              image: 'aliyun_linux_3_x64_20G_alibase',
              dnatMappings: [],
              networkInterfaces: [{ zoneKey: 'server', privateIp: '10.70.30.20' }],
              portGroups: [],
              initScript: '',
              imageStrategy: { mode: 'fixed', imageId: 'aliyun_linux_3_x64_20G_alibase' },
              instanceTypeStrategy: { mode: 'auto', preferredInstanceTypes: [] },
            },
          ],
          edges: [],
        },
        compiledSpec: {
          schemaVersion: '1.0.0',
          topology: {
            vpcCidr: '10.70.0.0/16',
            publicEntryHostKey: 'host-1',
            networkZoneKeys: ['dmz', 'office', 'server'],
            hostKeys: ['host-1', 'host-office', 'host-2'],
          },
          resources: [
            {
              id: 'switch-dmz',
              type: 'switch',
              config: {
                zoneKey: 'dmz',
                cidr: '10.70.10.0/24',
              },
            },
            {
              id: 'switch-office',
              type: 'switch',
              config: {
                zoneKey: 'office',
                cidr: '10.70.20.0/24',
              },
            },
            {
              id: 'switch-server',
              type: 'switch',
              config: {
                zoneKey: 'server',
                cidr: '10.70.30.0/24',
              },
            },
            {
              id: 'host-1',
              type: 'host',
              config: {
                zoneKey: 'dmz',
                role: 'entry',
                privateIp: '10.70.10.10',
                exposePublic: true,
              },
            },
            {
              id: 'host-office',
              type: 'host',
              config: {
                zoneKey: 'office',
                role: 'workstation',
                privateIp: '10.70.20.10',
                exposePublic: false,
              },
            },
            {
              id: 'host-2',
              type: 'host',
              config: {
                zoneKey: 'server',
                role: 'db',
                privateIp: '10.70.30.20',
                exposePublic: false,
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
              key: 'host-1',
              name: 'DMZ Entry',
              zoneKey: 'dmz',
              role: 'entry',
              privateIp: '10.70.10.10',
              exposePublic: true,
            },
            {
              key: 'host-office',
              name: 'Office Client',
              zoneKey: 'office',
              role: 'workstation',
              privateIp: '10.70.20.10',
            },
            {
              key: 'host-2',
              name: 'Server DB',
              zoneKey: 'server',
              role: 'db',
              privateIp: '10.70.30.20',
            },
          ],
          publicEntry: {
            hostKey: 'host-1',
            protocols: [{ protocol: 'ssh', port: 22 }],
          },
        },
      })
      .expect(200);

    expect(templateResponse.body).toEqual(
      expect.objectContaining({
        id: templateId,
        description: '更新后的综合靶场描述',
        version: 'v1.1.0',
        currentPublishedVersionId: null,
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
              id: 'host-1',
              type: 'host',
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
                key: 'host-office',
                role: 'workstation',
              }),
              expect.objectContaining({
                key: 'host-2',
                role: 'db',
              }),
            ]),
          }),
        }),
        currentPublishedVersion: null,
      }),
    );
  });

  it('rejects invalid topologyGraph and compiledSpec on template update', async () => {
    const originalTemplateList = await request(app.getHttpServer())
      .get('/admin/scenarios')
      .set('authorization', 'Bearer dev-admin-token')
      .expect(200);

    const originalTemplate = originalTemplateList.body.find(
      (template: { id: string }) => template.id === templateId,
    );

    expect(originalTemplate).toBeDefined();

    await request(app.getHttpServer())
      .patch(`/admin/scenarios/${templateId}`)
      .set('authorization', 'Bearer dev-admin-token')
      .send({
        topologyGraph: [],
      })
      .expect(400)
      .expect(({ body }) => {
        expect(body.message).toContain('topologyGraph must be an object');
      });

    await request(app.getHttpServer())
      .patch(`/admin/scenarios/${templateId}`)
      .set('authorization', 'Bearer dev-admin-token')
      .send({
        compiledSpec: null,
      })
      .expect(400)
      .expect(({ body }) => {
        expect(body.message).toContain('compiledSpec must be an object');
      });

    const afterInvalidUpdateList = await request(app.getHttpServer())
      .get('/admin/scenarios')
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
      .post(`/admin/scenarios/${templateId}/publish`)
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
                key: 'host-2',
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
      .get('/admin/ranges')
      .set('authorization', 'Bearer dev-admin-token')
      .expect(200);

    expect(response.body).toEqual([]);
  });

  it('creates provision jobs that remain pending until a separate worker claims them', async () => {
    const isolatedRepository = createMemoryAdminRepository();
    const hangingProvisioner: RangeProvisioner = {
      create: jest.fn(async () => new Promise(() => undefined)),
      destroy: jest.fn(async () => new Promise(() => undefined)),
    };
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(ADMIN_REPOSITORY)
      .useValue(isolatedRepository)
      .overrideProvider(SystemConfigService)
      .useValue(createSystemConfigServiceStub())
      .overrideProvider(RANGE_PROVISIONER)
      .useValue(hangingProvisioner)
      .compile();

    const isolatedApp = moduleRef.createNestApplication();
    configureApp(isolatedApp);
    await isolatedApp.init();

    try {
      const templateResponse = await request(isolatedApp.getHttpServer())
        .post('/admin/scenarios')
        .set('authorization', 'Bearer dev-admin-token')
        .send({
          name: 'Queued Worker Range',
          description: '验证 API 只负责入队，不在同进程直接执行',
          slug: 'queued-worker-range',
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

      const instanceResponse = await request(isolatedApp.getHttpServer())
        .post('/admin/ranges')
        .set('authorization', 'Bearer dev-admin-token')
        .send({
          name: '等待队列实例',
          templateId: templateResponse.body.id,
        })
        .expect(201);

      const createJobResponse = await request(isolatedApp.getHttpServer())
        .post(`/admin/ranges/${instanceResponse.body.id}/create`)
        .set('authorization', 'Bearer dev-admin-token')
        .send({
          triggeredBy: 'admin',
        })
        .expect(201);

      await new Promise((resolve) => setTimeout(resolve, 20));

      const pendingInstanceResponse = await request(isolatedApp.getHttpServer())
        .get(`/admin/ranges/${instanceResponse.body.id}`)
        .set('authorization', 'Bearer dev-admin-token')
        .expect(200);

      const pendingJobResponse = await request(isolatedApp.getHttpServer())
        .get(`/admin/provision-jobs/${createJobResponse.body.id}`)
        .set('authorization', 'Bearer dev-admin-token')
        .expect(200);

      expect(pendingInstanceResponse.body).toEqual(
        expect.objectContaining({
          id: instanceResponse.body.id,
          status: 'pending_create',
        }),
      );
      expect(pendingJobResponse.body).toEqual(
        expect.objectContaining({
          id: createJobResponse.body.id,
          status: 'pending',
        }),
      );
    } finally {
      await isolatedApp.close();
    }
  });

  it('creates and provisions a range instance from the latest draft template version', async () => {
    const draftTemplateResponse = await request(app.getHttpServer())
      .post('/admin/scenarios')
      .set('authorization', 'Bearer dev-admin-token')
      .send({
        name: 'Draft Source Range',
        description: '直接基于草稿版本创建实例',
        slug: 'draft-source-range',
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

    const draftTemplateId = draftTemplateResponse.body.id as string;
    const draftVersionId = draftTemplateResponse.body.currentDraftVersionId as string;

    const draftInstanceResponse = await request(app.getHttpServer())
      .post('/admin/ranges')
      .set('authorization', 'Bearer dev-admin-token')
      .send({
        name: '草稿靶场 01',
        templateId: draftTemplateId,
      })
      .expect(201);

    expect(draftInstanceResponse.body).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        name: '草稿靶场 01',
        templateId: draftTemplateId,
        status: 'draft',
        sourceTemplateVersionId: draftVersionId,
      }),
    );

    const createJobResponse = await request(app.getHttpServer())
      .post(`/admin/ranges/${draftInstanceResponse.body.id}/create`)
      .set('authorization', 'Bearer dev-admin-token')
      .send({
        triggeredBy: 'admin',
      })
      .expect(201);

    expect(createJobResponse.body).toEqual(
      expect.objectContaining({
        rangeInstanceId: draftInstanceResponse.body.id,
        jobType: 'create',
        status: 'pending',
      }),
    );

    await app.get(ProvisioningWorkerService).process(createJobResponse.body.id);

    const runningInstanceResponse = await request(app.getHttpServer())
      .get(`/admin/ranges/${draftInstanceResponse.body.id}`)
      .set('authorization', 'Bearer dev-admin-token')
      .expect(200);
    const runningInstance = runningInstanceResponse.body;

    expect(runningInstance).toEqual(
      expect.objectContaining({
        id: draftInstanceResponse.body.id,
        sourceTemplateVersionId: draftVersionId,
        resourceSummary: expect.objectContaining({
          topologySpec: expect.objectContaining({
            vpcCidr: '10.70.0.0/16',
          }),
        }),
      }),
    );
  });

  it('creates a draft range instance for a team and template', async () => {
    const createResponse = await request(app.getHttpServer())
      .post('/admin/ranges')
      .set('authorization', 'Bearer dev-admin-token')
      .send({
        name: '蓝队靶场 01',
        templateId,
      })
      .expect(201);

    expect(createResponse.body).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        name: '蓝队靶场 01',
        templateId,
        status: 'draft',
        sourceTemplateVersionId: expect.any(String),
      }),
    );

    rangeInstanceId = createResponse.body.id;
  });

  it('returns range instance detail by id', async () => {
    const detailResponse = await request(app.getHttpServer())
      .get(`/admin/ranges/${rangeInstanceId}`)
      .set('authorization', 'Bearer dev-admin-token')
      .expect(200);

    expect(detailResponse.body).toEqual(
      expect.objectContaining({
        id: rangeInstanceId,
        name: '蓝队靶场 01',
        templateId,
        status: 'draft',
        sourceTemplateVersionId: expect.any(String),
        accessEntry: null,
        resourceSummary: null,
        lastJobId: null,
      }),
    );
  });

  it('provisions and destroys a range instance through create and destroy jobs', async () => {
    const createJobResponse = await request(app.getHttpServer())
      .post(`/admin/ranges/${rangeInstanceId}/create`)
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

    await app.get(ProvisioningWorkerService).process(createJobResponse.body.id);

    const runningInstanceResponse = await request(app.getHttpServer())
      .get(`/admin/ranges/${rangeInstanceId}`)
      .set('authorization', 'Bearer dev-admin-token')
      .expect(200);
    const runningInstance = runningInstanceResponse.body;

    expect(runningInstance).toEqual(
      expect.objectContaining({
        id: rangeInstanceId,
        name: '蓝队靶场 01',
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
            publicEntryHostKey: 'host-1',
            networkZoneKeys: expect.arrayContaining(['dmz', 'server']),
            hostKeys: expect.arrayContaining(['host-1', 'host-office', 'host-2']),
          }),
        }),
      }),
    );

    const runningDetailResponse = await request(app.getHttpServer())
      .get(`/admin/ranges/${rangeInstanceId}`)
      .set('authorization', 'Bearer dev-admin-token')
      .expect(200);

    expect(runningDetailResponse.body).toEqual(
      expect.objectContaining({
        id: rangeInstanceId,
        name: '蓝队靶场 01',
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
      .post(`/admin/ranges/${rangeInstanceId}/destroy`)
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

    await app.get(ProvisioningWorkerService).process(destroyJobResponse.body.id);

    const destroyedInstanceResponse = await request(app.getHttpServer())
      .get(`/admin/ranges/${rangeInstanceId}`)
      .set('authorization', 'Bearer dev-admin-token')
      .expect(200);
    const destroyedInstance = destroyedInstanceResponse.body;

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

  it('deletes templates', async () => {
    await request(app.getHttpServer())
      .delete(`/admin/scenarios/${templateId}`)
      .set('authorization', 'Bearer dev-admin-token')
      .expect(204);
  });

  it('deletes templates that are referenced only by destroyed instances', async () => {
    const templateResponse = await request(app.getHttpServer())
      .post('/admin/scenarios')
      .set('authorization', 'Bearer dev-admin-token')
      .send({
        name: '可删除历史模板',
        description: 'only destroyed instances remain',
        slug: 'deletable-history-template',
        version: 'v1',
        modulePathOrRef: 'infra/opentofu/modules/alicloud-enterprise-range',
        cloudProvider: 'alibaba_cloud',
        iacType: 'opentofu',
        topologySpec: {
          vpcCidr: '10.96.0.0/16',
          networkZones: [
            { key: 'dmz', name: 'DMZ', purpose: 'public-entry', cidr: '10.96.10.0/24', isPublicEntry: true },
          ],
          hosts: [
            { key: 'dmz-entry', name: 'DMZ Entry', zoneKey: 'dmz', role: 'entry', privateIp: '10.96.10.10', exposePublic: true },
          ],
          publicEntry: { hostKey: 'dmz-entry', protocols: [{ protocol: 'ssh', port: 22 }] },
        },
        topologyGraph: {},
        scenarioTemplateSpec: {},
        compiledProvisionSpec: {},
        compiledSpec: {},
        variableSchema: {},
        outputSchema: {},
      })
      .expect(201);

    const instanceResponse = await request(app.getHttpServer())
      .post('/admin/ranges')
      .set('authorization', 'Bearer dev-admin-token')
      .send({
        name: '历史实例',
        templateId: templateResponse.body.id,
      })
      .expect(201);

    await repository.updateRangeInstance(instanceResponse.body.id, {
      status: 'destroyed',
      lastJobId: null,
    });

    await request(app.getHttpServer())
      .delete(`/admin/scenarios/${templateResponse.body.id}`)
      .set('authorization', 'Bearer dev-admin-token')
      .expect(204);

    const instancesAfterDelete = await request(app.getHttpServer())
      .get('/admin/ranges')
      .set('authorization', 'Bearer dev-admin-token')
      .expect(200);

    const preservedInstance = instancesAfterDelete.body.find((instance: { id: string }) => instance.id === instanceResponse.body.id);
    expect(preservedInstance).toMatchObject({
      id: instanceResponse.body.id,
      status: 'destroyed',
      templateId: null,
      templateNameSnapshot: '可删除历史模板',
      templateSlugSnapshot: 'deletable-history-template',
      templateVersionSnapshot: 'v1',
    });
  });

  it('rejects deleting templates that are still referenced by non-destroyed instances', async () => {
    const templateResponse = await request(app.getHttpServer())
      .post('/admin/scenarios')
      .set('authorization', 'Bearer dev-admin-token')
      .send({
        name: '不可删除活动模板',
        description: 'still referenced by active instances',
        slug: 'undeletable-active-template',
        version: 'v1',
        modulePathOrRef: 'infra/opentofu/modules/alicloud-enterprise-range',
        cloudProvider: 'alibaba_cloud',
        iacType: 'opentofu',
        topologySpec: {
          vpcCidr: '10.97.0.0/16',
          networkZones: [
            { key: 'dmz', name: 'DMZ', purpose: 'public-entry', cidr: '10.97.10.0/24', isPublicEntry: true },
          ],
          hosts: [
            { key: 'dmz-entry', name: 'DMZ Entry', zoneKey: 'dmz', role: 'entry', privateIp: '10.97.10.10', exposePublic: true },
          ],
          publicEntry: { hostKey: 'dmz-entry', protocols: [{ protocol: 'ssh', port: 22 }] },
        },
        topologyGraph: {},
        scenarioTemplateSpec: {},
        compiledProvisionSpec: {},
        compiledSpec: {},
        variableSchema: {},
        outputSchema: {},
      })
      .expect(201);

    await request(app.getHttpServer())
      .post('/admin/ranges')
      .set('authorization', 'Bearer dev-admin-token')
      .send({
        name: '运行中实例',
        templateId: templateResponse.body.id,
      })
      .expect(201);

    await request(app.getHttpServer())
      .delete(`/admin/scenarios/${templateResponse.body.id}`)
      .set('authorization', 'Bearer dev-admin-token')
      .expect(409)
      .expect(({ body }) => {
        expect(body.message).toContain('Range template cannot be deleted while non-destroyed instances still reference it');
      });
  });

  it('deletes create_failed instances', async () => {
    const templateResponse = await request(app.getHttpServer())
      .post('/admin/scenarios')
      .set('authorization', 'Bearer dev-admin-token')
      .send({
        name: '失败实例模板',
        description: 'template for failed instance deletion',
        slug: 'failed-instance-template',
        version: 'v1',
        modulePathOrRef: 'infra/opentofu/modules/alicloud-enterprise-range',
        cloudProvider: 'alibaba_cloud',
        iacType: 'opentofu',
        topologySpec: fixtureTopologySpec,
        variableSchema: {},
        outputSchema: {},
      })
      .expect(201);

    const instanceResponse = await request(app.getHttpServer())
      .post('/admin/ranges')
      .set('authorization', 'Bearer dev-admin-token')
      .send({
        name: '失败实例',
        templateId: templateResponse.body.id,
      })
      .expect(201);

    await repository.updateRangeInstance(instanceResponse.body.id, {
      status: 'create_failed',
      errorSummary: 'mock create failed',
    });

    await request(app.getHttpServer())
      .delete(`/admin/ranges/${instanceResponse.body.id}`)
      .set('authorization', 'Bearer dev-admin-token')
      .expect(200);

    const instancesAfterDelete = await request(app.getHttpServer())
      .get('/admin/ranges')
      .set('authorization', 'Bearer dev-admin-token')
      .expect(200);

    expect(instancesAfterDelete.body.find((instance: { id: string }) => instance.id === instanceResponse.body.id)).toBeUndefined();
  });

  it('rejects deleting non-create_failed instances', async () => {
    const templateResponse = await request(app.getHttpServer())
      .post('/admin/scenarios')
      .set('authorization', 'Bearer dev-admin-token')
      .send({
        name: '活动实例模板',
        description: 'template for active instance deletion guard',
        slug: 'active-instance-template',
        version: 'v1',
        modulePathOrRef: 'infra/opentofu/modules/alicloud-enterprise-range',
        cloudProvider: 'alibaba_cloud',
        iacType: 'opentofu',
        topologySpec: fixtureTopologySpec,
        variableSchema: {},
        outputSchema: {},
      })
      .expect(201);

    const instanceResponse = await request(app.getHttpServer())
      .post('/admin/ranges')
      .set('authorization', 'Bearer dev-admin-token')
      .send({
        name: '运行中实例',
        templateId: templateResponse.body.id,
      })
      .expect(201);

    await repository.updateRangeInstance(instanceResponse.body.id, {
      status: 'running',
    });

    await request(app.getHttpServer())
      .delete(`/admin/ranges/${instanceResponse.body.id}`)
      .set('authorization', 'Bearer dev-admin-token')
      .expect(409)
      .expect(({ body }) => {
        expect(body.message).toContain('Only create_failed instances can be deleted');
      });
  });
});
