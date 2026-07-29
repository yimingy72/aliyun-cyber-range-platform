import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AdminAuthGuard } from '../src/admin/admin-auth.guard';
import { ADMIN_REPOSITORY, type AdminRepository } from '../src/admin/admin.repository';
import { SystemConfigService } from '../src/admin/system-config.service';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap/configure-app';
import { ProvisioningWorkerService } from '../src/provisioning/provisioning-worker.service';
import {
  RANGE_PROVISIONER,
  type RangeProvisioner,
} from '../src/provisioning/provisioning.types';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';

let platformImageAssetId = '';
const platformImageId = 'm-admin-resources-image';

function createTemplatePayload(input: {
  name: string;
  description?: string;
  hostName?: string;
  vpcCidr?: string;
}) {
  const hostName = input.hostName ?? 'entry';
  const vpcCidr = input.vpcCidr ?? '10.70.0.0/16';
  const vpcPrefix = vpcCidr.split('.').slice(0, 2).join('.');
  const zoneCidr = `${vpcPrefix}.10.0/24`;
  const privateIp = `${vpcPrefix}.10.10`;
  const imageSelection = {
    platformImageAssetId,
    imageId: platformImageId,
    imageStrategy: { mode: 'fixed', imageId: platformImageId },
  };
  const networkZone = {
    key: 'dmz',
    name: 'DMZ',
    purpose: 'public-entry',
    cidr: zoneCidr,
    isPublicEntry: true,
  };
  const scenarioHost = {
    key: 'entry',
    name: hostName,
    zoneKey: 'dmz',
    role: 'entry',
    primaryPrivateIp: privateIp,
    exposePublic: true,
    ...imageSelection,
  };

  return {
    name: input.name,
    description: input.description,
    topologySpec: {
      vpcCidr,
      networkZones: [networkZone],
      hosts: [
        {
          key: 'entry',
          name: hostName,
          zoneKey: 'dmz',
          role: 'entry',
          privateIp,
          exposePublic: true,
        },
      ],
      publicEntry: {
        hostKey: 'entry',
        protocols: [{ protocol: 'ssh', port: 22 }],
      },
    },
    topologyGraph: {
      schemaVersion: '2.0.0',
      nodes: [
        {
          id: 'switch-dmz',
          kind: 'switch',
          label: 'DMZ',
          zoneKey: 'dmz',
          cidr: zoneCidr,
        },
        {
          id: 'entry',
          kind: 'ecs',
          label: hostName,
          ...imageSelection,
        },
      ],
      edges: [{ id: 'edge-entry', fromNodeId: 'switch-dmz', toNodeId: 'entry' }],
    },
    scenarioTemplateSpec: {
      schemaVersion: '1.0.0',
      topology: {
        vpcCidr,
        entryHostKey: 'entry',
      },
      networkZones: [networkZone],
      hosts: [scenarioHost],
      nat: { natGateways: [], eips: [] },
      access: { portGroups: [] },
      bootstrap: { scripts: [] },
      runtimePreferences: { imagePolicies: [], instanceTypePolicies: [] },
    },
    compiledProvisionSpec: {
      schemaVersion: '1.0.0',
      topology: {
        vpcCidr,
        entryHostKey: 'entry',
      },
      networkZones: [networkZone],
      hosts: [
        {
          ...scenarioHost,
          networkInterfaces: [{ deviceIndex: 0, zoneKey: 'dmz', privateIp }],
        },
      ],
      natGateways: [],
      eips: [],
      snatEntries: [],
      dnatEntries: [],
      securityGroupRules: [],
      aclRules: [],
      bootstrapScripts: [],
      runtimeSelections: { imagePolicies: {}, instanceTypePolicies: {} },
    },
    compiledSpec: {
      schemaVersion: '1.0.0',
      resources: [
        {
          id: 'switch-dmz',
          type: 'switch',
          provider: 'alibaba_cloud',
          config: {
            label: 'DMZ',
            zoneKey: 'dmz',
            cidr: zoneCidr,
            purpose: 'public-entry',
          },
        },
        {
          id: 'entry',
          type: 'host',
          provider: 'alibaba_cloud',
          config: {
            label: hostName,
            zoneKey: 'dmz',
            role: 'entry',
            privateIp,
            exposePublic: true,
            ...imageSelection,
          },
        },
      ],
      topology: {
        vpcCidr,
        publicEntryHostKey: 'entry',
        networkZoneKeys: ['dmz'],
        hostKeys: ['entry'],
      },
    },
    variableSchema: {},
    outputSchema: {},
  };
}

function createSavePayload(
  input: Parameters<typeof createTemplatePayload>[0],
  expectedRevision: number,
) {
  const {
    name: _name,
    description: _description,
    variableSchema: _variableSchema,
    outputSchema: _outputSchema,
    ...topology
  } = createTemplatePayload(input);

  return {
    ...topology,
    expectedRevision,
  };
}

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

describe('Admin resources', () => {
  let app: INestApplication;
  let repository: AdminRepository;
  const provisioner: RangeProvisioner & {
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
    process.env.NODE_ENV = 'test';
    process.env.ADMIN_USERNAME = 'admin';
    process.env.ADMIN_PASSWORD = 'change-me';
    process.env.ADMIN_TOKEN = 'dev-admin-token';
    process.env.OIDC_ISSUER = 'https://test-issuer.example/realms/cyber-range';
    process.env.OIDC_JWKS_URL = 'https://test-issuer.example/realms/cyber-range/certs';
    process.env.OIDC_TOKEN_ENDPOINT = 'https://test-issuer.example/realms/cyber-range/token';
    process.env.RANGE_PROVISIONER_MODE = 'dry-run';
    process.env.RANGE_CIDR_POOL = '10.200.0.0/16';

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(ADMIN_REPOSITORY)
      .useValue(createMemoryAdminRepository())
      .overrideProvider(RANGE_PROVISIONER)
      .useValue(provisioner)
      .overrideGuard(AdminAuthGuard)
      .useValue({
        canActivate: (context: {
          switchToHttp(): {
            getRequest(): Record<string, unknown>;
          };
        }) => {
          const authenticatedUser = {
            id: 'admin',
            username: 'admin',
            role: 'admin' as const,
          };
          const requestContext = context.switchToHttp().getRequest();
          requestContext.adminUser = authenticatedUser;
          requestContext.authContext = { user: authenticatedUser, source: 'web' };
          return true;
        },
      })
      .overrideProvider(SystemConfigService)
      .useValue(createSystemConfigServiceStub())
      .compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();

    repository = app.get(ADMIN_REPOSITORY);

    await repository.upsertImageSnapshots({
      provider: 'alibaba_cloud',
      accountUid: null,
      regionId: 'cn-hangzhou',
      scope: 'custom',
      snapshots: [
        {
          imageId: platformImageId,
          sourceImageName: 'Admin Resources Image',
          status: 'Available',
          isAvailable: true,
          lastSyncedAt: new Date('2026-07-22T00:00:00.000Z'),
        },
      ],
    });
    const [snapshot] = await repository.listImageSnapshots({
      provider: 'alibaba_cloud',
      accountUid: null,
      regionId: 'cn-hangzhou',
      scope: 'custom',
      imageId: platformImageId,
    });
    const asset = await repository.collectPlatformImageAsset({
      snapshotId: snapshot!.id,
      displayName: 'Admin Resources Image',
      ownerUserId: null,
      visibility: 'platform',
    });
    platformImageAssetId = asset.id;
  });

  afterAll(async () => {
    await app.close();
  });

  async function createTemplate(
    name: string,
    overrides: Partial<Parameters<typeof createTemplatePayload>[0]> = {},
  ) {
    return request(app.getHttpServer())
      .post('/admin/scenarios')
      .set('authorization', 'Bearer dev-admin-token')
      .send(createTemplatePayload({
        name,
        ...overrides,
      }))
      .expect(201);
  }

  it('creates, lists, and clones complete topologies without exposing internal versions', async () => {
    const created = await createTemplate('Enterprise Practice Range', {
      description: 'Default enterprise exercise topology',
    });

    expect(created.body).toEqual(
      expect.objectContaining({
        name: 'Enterprise Practice Range',
        status: 'private',
        revision: 1,
        topologyGraph: expect.objectContaining({
          nodes: expect.arrayContaining([expect.objectContaining({ id: 'entry' })]),
        }),
      }),
    );
    expect(created.body.slug).toMatch(/^enterprise-practice-range-[0-9a-f]{8}$/);
    expect(created.body).not.toHaveProperty('version');
    expect(created.body).not.toHaveProperty('currentDraftVersion');

    const listResponse = await request(app.getHttpServer())
      .get('/admin/scenarios?view=mine')
      .set('authorization', 'Bearer dev-admin-token')
      .expect(200);

    expect(listResponse.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: created.body.id,
          status: 'private',
          revision: 1,
        }),
      ]),
    );

    const cloneResponse = await request(app.getHttpServer())
      .post(`/admin/scenarios/${created.body.id}/clone`)
      .set('authorization', 'Bearer dev-admin-token')
      .expect(201);

    expect(cloneResponse.body).toEqual(
      expect.objectContaining({
        name: 'Enterprise Practice Range 副本',
        status: 'private',
        revision: 1,
        description: 'Default enterprise exercise topology',
      }),
    );
    expect(cloneResponse.body.slug).toMatch(
      new RegExp(`^${created.body.slug}-copy-[0-9a-f]{8}$`),
    );
    expect(cloneResponse.body).not.toHaveProperty('version');
    expect(cloneResponse.body).not.toHaveProperty('currentDraftVersionId');
  });

  it('rejects incomplete topology creation and client-owned identity fields', async () => {
    const complete = createTemplatePayload({ name: 'Invalid Template' });

    await request(app.getHttpServer())
      .post('/admin/scenarios')
      .set('authorization', 'Bearer dev-admin-token')
      .send({
        ...complete,
        topologyGraph: null,
      })
      .expect(400);

    await request(app.getHttpServer())
      .post('/admin/scenarios')
      .set('authorization', 'Bearer dev-admin-token')
      .send({
        ...complete,
        compiledSpec: [],
      })
      .expect(400);

    await request(app.getHttpServer())
      .post('/admin/scenarios')
      .set('authorization', 'Bearer dev-admin-token')
      .send({
        ...complete,
        slug: 'client-owned-slug',
        version: 'v999',
      })
      .expect(400)
      .expect(({ body }) => {
        expect(body.message).toEqual(
          expect.arrayContaining([
            'property slug should not exist',
            'property version should not exist',
          ]),
        );
      });
  });

  it('updates metadata separately and validates and saves topology with revision checks', async () => {
    const created = await createTemplate('Editable Template');

    const metadataResponse = await request(app.getHttpServer())
      .patch(`/admin/scenarios/${created.body.id}`)
      .set('authorization', 'Bearer dev-admin-token')
      .send({
        name: 'Renamed Template',
        description: 'Metadata only',
        expectedRevision: created.body.revision,
      })
      .expect(200);

    expect(metadataResponse.body).toEqual(
      expect.objectContaining({
        name: 'Renamed Template',
        description: 'Metadata only',
        status: 'private',
        revision: 2,
      }),
    );

    await request(app.getHttpServer())
      .patch(`/admin/scenarios/${created.body.id}`)
      .set('authorization', 'Bearer dev-admin-token')
      .send({
        topologyGraph: {},
        expectedRevision: metadataResponse.body.revision,
      })
      .expect(400);

    const savePayload = createSavePayload(
      {
        name: 'Renamed Template',
        hostName: 'entry-updated',
        vpcCidr: '10.71.0.0/16',
      },
      metadataResponse.body.revision,
    );
    const saved = await request(app.getHttpServer())
      .post(`/admin/scenarios/${created.body.id}/validate-and-save`)
      .set('authorization', 'Bearer dev-admin-token')
      .send(savePayload)
      .expect(200);

    expect(saved.body).toEqual(
      expect.objectContaining({
        status: 'private',
        revision: 3,
        topologySpec: expect.objectContaining({
          vpcCidr: '10.71.0.0/16',
        }),
      }),
    );

    await request(app.getHttpServer())
      .post(`/admin/scenarios/${created.body.id}/validate-and-save`)
      .set('authorization', 'Bearer dev-admin-token')
      .send(savePayload)
      .expect(409);

    const published = await request(app.getHttpServer())
      .post(`/admin/scenarios/${created.body.id}/share`)
      .set('authorization', 'Bearer dev-admin-token')
      .send({ expectedRevision: saved.body.revision })
      .expect(200);

    expect(published.body).toEqual(
      expect.objectContaining({
        status: 'published',
        revision: 4,
      }),
    );
    expect(published.body).not.toHaveProperty('currentPublishedVersionId');
  });

  it('creates a range instance, leaves its create job pending, and returns instance detail', async () => {
    const template = await createTemplate('Range Instance Template');
    const instanceResponse = await request(app.getHttpServer())
      .post('/admin/ranges')
      .set('authorization', 'Bearer dev-admin-token')
      .send({
        name: 'range-instance-01',
        templateId: template.body.id,
      })
      .expect(201);

    expect(instanceResponse.body).toEqual(
      expect.objectContaining({
        name: 'range-instance-01',
        status: 'draft',
        templateId: template.body.id,
        sourceTemplateVersionId: expect.any(String),
      }),
    );

    const detailResponse = await request(app.getHttpServer())
      .get(`/admin/ranges/${instanceResponse.body.id}`)
      .set('authorization', 'Bearer dev-admin-token')
      .expect(200);

    expect(detailResponse.body).toEqual(
      expect.objectContaining({
        id: instanceResponse.body.id,
        name: 'range-instance-01',
      }),
    );

    const createJob = await request(app.getHttpServer())
      .post(`/admin/ranges/${instanceResponse.body.id}/create`)
      .set('authorization', 'Bearer dev-admin-token')
      .send({})
      .expect(201);

    expect(createJob.body).toEqual(
      expect.objectContaining({
        jobType: 'create',
        status: 'pending',
        rangeInstanceId: instanceResponse.body.id,
      }),
    );
    expect((await repository.getProvisionJobById(createJob.body.id))?.status).toBe('pending');
    expect(provisioner.create).not.toHaveBeenCalled();
  });

  it('provisions and destroys a range instance through worker-owned jobs', async () => {
    const worker = app.get(ProvisioningWorkerService);
    const template = await createTemplate('Worker Lifecycle Template');
    const instance = await request(app.getHttpServer())
      .post('/admin/ranges')
      .set('authorization', 'Bearer dev-admin-token')
      .send({
        name: 'worker-lifecycle-instance',
        templateId: template.body.id,
      })
      .expect(201);
    const createJob = await request(app.getHttpServer())
      .post(`/admin/ranges/${instance.body.id}/create`)
      .set('authorization', 'Bearer dev-admin-token')
      .send({})
      .expect(201);

    await worker.process(createJob.body.id);

    expect(await repository.getRangeInstanceById(instance.body.id)).toEqual(
      expect.objectContaining({
        status: 'running',
        accessEntry: expect.objectContaining({
          url: 'https://range.local/fake',
        }),
      }),
    );
    expect(provisioner.create).toHaveBeenCalled();

    const destroyJob = await request(app.getHttpServer())
      .post(`/admin/ranges/${instance.body.id}/destroy`)
      .set('authorization', 'Bearer dev-admin-token')
      .send({})
      .expect(201);

    await worker.process(destroyJob.body.id);

    expect(await repository.getRangeInstanceById(instance.body.id)).toEqual(
      expect.objectContaining({
        status: 'destroyed',
      }),
    );
    expect(provisioner.destroy).toHaveBeenCalled();
  });

  it('deletes unused templates and templates referenced only by destroyed instances', async () => {
    const unused = await createTemplate('Unused Delete Template');

    await request(app.getHttpServer())
      .delete(`/admin/scenarios/${unused.body.id}`)
      .set('authorization', 'Bearer dev-admin-token')
      .expect(204);
    expect(await repository.getRangeTemplateById(unused.body.id)).toBeNull();

    const destroyedOnly = await createTemplate('Destroyed Reference Template');
    await repository.createRangeInstance({
      name: 'destroyed-reference',
      createdBy: 'admin',
      ownerUserId: 'admin',
      templateId: destroyedOnly.body.id,
      instanceMode: 'range',
      status: 'destroyed',
    });

    await request(app.getHttpServer())
      .delete(`/admin/scenarios/${destroyedOnly.body.id}`)
      .set('authorization', 'Bearer dev-admin-token')
      .expect(204);
    expect(await repository.getRangeTemplateById(destroyedOnly.body.id)).toBeNull();
  });

  it('rejects deleting a template referenced by a non-destroyed instance', async () => {
    const template = await createTemplate('Live Reference Template');
    await repository.createRangeInstance({
      name: 'live-reference',
      createdBy: 'admin',
      ownerUserId: 'admin',
      templateId: template.body.id,
      instanceMode: 'range',
      status: 'running',
    });

    await request(app.getHttpServer())
      .delete(`/admin/scenarios/${template.body.id}`)
      .set('authorization', 'Bearer dev-admin-token')
      .expect(409);
  });

  it('retains create_failed range instances in history and rejects deleting running instances', async () => {
    const template = await createTemplate('Instance Delete Template');
    const failed = await repository.createRangeInstance({
      name: 'failed-instance',
      createdBy: 'admin',
      ownerUserId: 'admin',
      templateId: template.body.id,
      instanceMode: 'range',
      status: 'create_failed',
    });
    const running = await repository.createRangeInstance({
      name: 'running-instance',
      createdBy: 'admin',
      ownerUserId: 'admin',
      templateId: template.body.id,
      instanceMode: 'range',
      status: 'running',
    });

    await request(app.getHttpServer())
      .delete(`/admin/ranges/${failed.id}`)
      .set('authorization', 'Bearer dev-admin-token')
      .expect(409);
    expect(await repository.getRangeInstanceById(failed.id)).not.toBeNull();

    await request(app.getHttpServer())
      .delete(`/admin/ranges/${running.id}`)
      .set('authorization', 'Bearer dev-admin-token')
      .expect(409);
  });
});
