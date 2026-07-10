import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { hashPassword } from '../src/admin/admin-user-auth';
import { ADMIN_REPOSITORY, type AdminRepository } from '../src/admin/admin.repository';
import { SystemConfigService } from '../src/admin/system-config.service';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap/configure-app';
import { ProvisioningWorkerService } from '../src/provisioning/provisioning-worker.service';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';

function createTemplatePayload(name: string, slug: string) {
  return {
    name,
    slug,
    version: 'v1',
    modulePathOrRef: 'infra/opentofu/modules/alicloud-enterprise-range',
    topologySpec: {
      vpcCidr: '10.66.0.0/16',
      networkZones: [{ key: 'dmz', name: 'DMZ', purpose: 'public-entry', cidr: '10.66.10.0/24', isPublicEntry: true }],
      hosts: [{ key: 'entry', name: 'entry', zoneKey: 'dmz', role: 'entry', privateIp: '10.66.10.10', exposePublic: true }],
      publicEntry: {
        hostKey: 'entry',
        protocols: [{ protocol: 'ssh', port: 22 }],
      },
    },
  };
}

function createConsumableTemplatePayload(input: {
  name: string;
  slug: string;
  version: string;
  scenarioName: string;
  hostName: string;
  vpcCidr: string;
}) {
  return {
    name: input.name,
    slug: input.slug,
    version: input.version,
    modulePathOrRef: 'infra/opentofu/modules/alicloud-enterprise-range',
    topologySpec: {
      vpcCidr: input.vpcCidr,
      networkZones: [{ key: 'dmz', name: 'DMZ', purpose: 'public-entry', cidr: '10.66.10.0/24', isPublicEntry: true }],
      hosts: [{ key: 'entry', name: input.hostName, zoneKey: 'dmz', role: 'entry', privateIp: '10.66.10.10', exposePublic: true }],
      publicEntry: {
        hostKey: 'entry',
        protocols: [{ protocol: 'ssh', port: 22 }],
      },
    },
    topologyGraph: {
      schemaVersion: '1',
      nodes: [{ id: 'entry', kind: 'ecs', data: { label: input.hostName } }],
      edges: [],
    },
    scenarioTemplateSpec: {
      schemaVersion: '1.0.0',
      metadata: {
        name: input.scenarioName,
        slug: input.slug,
        version: input.version,
        cloudProvider: 'alibaba_cloud',
        iacType: 'opentofu',
      },
      topology: {
        vpcCidr: input.vpcCidr,
        entryHostKey: 'entry',
      },
      networkZones: [
        {
          key: 'dmz',
          name: 'DMZ',
          cidr: '10.66.10.0/24',
          purpose: 'public-entry',
          isPublicEntry: true,
          routeRole: 'entry',
        },
      ],
      hosts: [
        {
          key: 'entry',
          name: input.hostName,
          role: 'entry',
          zoneKey: 'dmz',
          primaryPrivateIp: '10.66.10.10',
          exposePublic: true,
        },
      ],
      nat: { natGateways: [], eips: [] },
      access: { portGroups: [] },
      bootstrap: { scripts: [] },
      runtimePreferences: { imagePolicies: [], instanceTypePolicies: [] },
    },
    compiledProvisionSpec: {
      schemaVersion: '1.0.0',
      identity: {
        templateSlug: input.slug,
        templateVersion: input.version,
        cloudProvider: 'alibaba_cloud',
        iacType: 'opentofu',
      },
      topology: {
        vpcCidr: input.vpcCidr,
        entryHostKey: 'entry',
      },
      networkZones: [
        {
          key: 'dmz',
          name: 'DMZ',
          cidr: '10.66.10.0/24',
          purpose: 'public-entry',
          isPublicEntry: true,
          routeRole: 'entry',
        },
      ],
      hosts: [
        {
          key: 'entry',
          name: input.hostName,
          role: 'entry',
          zoneKey: 'dmz',
          primaryPrivateIp: '10.66.10.10',
          exposePublic: true,
          networkInterfaces: [{ deviceIndex: 0, zoneKey: 'dmz', privateIp: '10.66.10.10' }],
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
  };
}

async function loginAs(app: INestApplication, username = 'admin', password = 'change-me') {
  const response = await request(app.getHttpServer())
    .post('/admin/session')
    .send({ username, password })
    .expect(200);

  return response.body.token as string;
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

describe('Admin resource visibility', () => {
  let app: INestApplication;
  let repository: AdminRepository;
  let fetchMock: jest.SpiedFunction<typeof fetch>;

  const alice = {
    id: 'user-alice',
    username: 'alice',
    password: 'AlicePass123!',
  };

  const bob = {
    id: 'user-bob',
    username: 'bob',
    password: 'BobPass123!',
  };

  beforeAll(async () => {
    process.env.ADMIN_USERNAME = 'admin';
    process.env.ADMIN_PASSWORD = 'change-me';
    process.env.ADMIN_TOKEN = 'dev-admin-token';

    fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response(JSON.stringify({ RequestId: 'ok' }), { status: 200 });
    });

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

    await repository.createPlatformUser({
      id: alice.id,
      username: alice.username,
      passwordHash: hashPassword(alice.password),
      role: 'user',
      status: 'active',
    });

    await repository.createPlatformUser({
      id: bob.id,
      username: bob.username,
      passwordHash: hashPassword(bob.password),
      role: 'user',
      status: 'active',
    });
  });

  afterAll(async () => {
    fetchMock.mockRestore();
    await app.close();
  });

  it('lets a user create a private template and share it without publishing it', async () => {
    const aliceToken = await loginAs(app, alice.username, alice.password);

    const createResponse = await request(app.getHttpServer())
      .post('/admin/scenarios')
      .set('authorization', `Bearer ${aliceToken}`)
      .send(createTemplatePayload('Alice Private Template', 'alice-private-template'))
      .expect(201);

    expect(createResponse.body).toEqual(
      expect.objectContaining({
        createdBy: alice.id,
        ownerUserId: alice.id,
        visibility: 'private',
        currentPublishedVersionId: null,
      }),
    );

    const shareResponse = await request(app.getHttpServer())
      .post(`/admin/scenarios/${createResponse.body.id}/share`)
      .set('authorization', `Bearer ${aliceToken}`)
      .expect(200);

    expect(shareResponse.body).toEqual(
      expect.objectContaining({
        id: createResponse.body.id,
        ownerUserId: alice.id,
        visibility: 'platform',
        currentPublishedVersionId: null,
        currentDraftVersionId: createResponse.body.currentDraftVersionId,
      }),
    );
  });

  it('shows shared templates in view=platform and only owned templates in view=mine', async () => {
    const aliceToken = await loginAs(app, alice.username, alice.password);
    const bobToken = await loginAs(app, bob.username, bob.password);

    const aliceShared = await request(app.getHttpServer())
      .post('/admin/scenarios')
      .set('authorization', `Bearer ${aliceToken}`)
      .send(createTemplatePayload('Alice Shared Template', 'alice-shared-template'))
      .expect(201);

    await request(app.getHttpServer())
      .post(`/admin/scenarios/${aliceShared.body.id}/share`)
      .set('authorization', `Bearer ${aliceToken}`)
      .expect(200);

    await request(app.getHttpServer())
      .post('/admin/scenarios')
      .set('authorization', `Bearer ${bobToken}`)
      .send(createTemplatePayload('Bob Private Template', 'bob-private-template'))
      .expect(201);

    const platformResponse = await request(app.getHttpServer())
      .get('/admin/scenarios?view=platform')
      .set('authorization', `Bearer ${bobToken}`)
      .expect(200);

    expect(platformResponse.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: aliceShared.body.id,
          ownerUserId: alice.id,
          visibility: 'platform',
        }),
      ]),
    );
    expect(platformResponse.body).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          slug: 'bob-private-template',
        }),
      ]),
    );

    const mineResponse = await request(app.getHttpServer())
      .get('/admin/scenarios?view=mine')
      .set('authorization', `Bearer ${bobToken}`)
      .expect(200);

    expect(mineResponse.body).toEqual([
      expect.objectContaining({
        ownerUserId: bob.id,
        visibility: 'private',
        slug: 'bob-private-template',
      }),
    ]);
  });

  it('lets users see shared unpublished templates but blocks clone/create/launch consumption', async () => {
    const aliceToken = await loginAs(app, alice.username, alice.password);
    const bobToken = await loginAs(app, bob.username, bob.password);

    const sharedTemplate = await request(app.getHttpServer())
      .post('/admin/scenarios')
      .set('authorization', `Bearer ${aliceToken}`)
      .send(
        createConsumableTemplatePayload({
          name: 'Alice Shared Draft Only',
          slug: 'alice-shared-draft-only',
          version: 'v1',
          scenarioName: 'Alice Shared Draft Only',
          hostName: 'draft-only-entry',
          vpcCidr: '10.81.0.0/16',
        }),
      )
      .expect(201);

    await request(app.getHttpServer())
      .post(`/admin/scenarios/${sharedTemplate.body.id}/share`)
      .set('authorization', `Bearer ${aliceToken}`)
      .expect(200);

    const platformView = await request(app.getHttpServer())
      .get('/admin/scenarios?view=platform')
      .set('authorization', `Bearer ${bobToken}`)
      .expect(200);

    expect(platformView.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: sharedTemplate.body.id,
          visibility: 'platform',
          currentPublishedVersionId: null,
        }),
      ]),
    );

    await request(app.getHttpServer())
      .post(`/admin/scenarios/${sharedTemplate.body.id}/clone`)
      .set('authorization', `Bearer ${bobToken}`)
      .expect(409)
      .expect(({ body }) => {
        expect(body.message).toBe('Shared template must be published before other users can consume it');
      });

    await request(app.getHttpServer())
      .post('/admin/ranges')
      .set('authorization', `Bearer ${bobToken}`)
      .send({
        name: 'bob-shared-draft-create',
        templateId: sharedTemplate.body.id,
      })
      .expect(409)
      .expect(({ body }) => {
        expect(body.message).toBe('Shared template must be published before other users can consume it');
      });

    await request(app.getHttpServer())
      .post('/admin/ranges/launch')
      .set('authorization', `Bearer ${bobToken}`)
      .send({
        name: 'bob-shared-draft-launch',
        templateId: sharedTemplate.body.id,
        expiresAt: '2026-07-12T12:00:00.000Z',
      })
      .expect(409)
      .expect(({ body }) => {
        expect(body.message).toBe('Shared template must be published before other users can consume it');
      });

    await request(app.getHttpServer())
      .post(`/admin/scenarios/${sharedTemplate.body.id}/validate`)
      .set('authorization', `Bearer ${bobToken}`)
      .expect(409)
      .expect(({ body }) => {
        expect(body.message).toBe('Shared template must be published before other users can consume it');
      });
  });

  it('makes non-owners clone and launch the published snapshot instead of the owner draft', async () => {
    const aliceToken = await loginAs(app, alice.username, alice.password);
    const bobToken = await loginAs(app, bob.username, bob.password);

    const createResponse = await request(app.getHttpServer())
      .post('/admin/scenarios')
      .set('authorization', `Bearer ${aliceToken}`)
      .send(
        createConsumableTemplatePayload({
          name: 'Alice Shared Published',
          slug: 'alice-shared-published',
          version: 'v1',
          scenarioName: 'Published Scenario V1',
          hostName: 'published-entry-v1',
          vpcCidr: '10.82.0.0/16',
        }),
      )
      .expect(201);

    await request(app.getHttpServer())
      .post(`/admin/scenarios/${createResponse.body.id}/share`)
      .set('authorization', `Bearer ${aliceToken}`)
      .expect(200);

    const publishResponse = await request(app.getHttpServer())
      .post(`/admin/scenarios/${createResponse.body.id}/publish`)
      .set('authorization', `Bearer ${aliceToken}`)
      .expect(200);

    const publishedVersionId = publishResponse.body.currentPublishedVersionId as string;

    const updateResponse = await request(app.getHttpServer())
      .patch(`/admin/scenarios/${createResponse.body.id}`)
      .set('authorization', `Bearer ${aliceToken}`)
      .send({
        version: 'v2',
        scenarioTemplateSpec: {
          schemaVersion: '1.0.0',
          metadata: {
            name: 'Draft Scenario V2',
            slug: 'alice-shared-published',
            version: 'v2',
            cloudProvider: 'alibaba_cloud',
            iacType: 'opentofu',
          },
          topology: {
            vpcCidr: '10.83.0.0/16',
            entryHostKey: 'entry',
          },
          networkZones: [
            {
              key: 'dmz',
              name: 'DMZ',
              cidr: '10.66.10.0/24',
              purpose: 'public-entry',
              isPublicEntry: true,
              routeRole: 'entry',
            },
          ],
          hosts: [
            {
              key: 'entry',
              name: 'draft-entry-v2',
              role: 'entry',
              zoneKey: 'draft-only-zone',
              primaryPrivateIp: '10.66.10.10',
              exposePublic: true,
            },
          ],
          nat: { natGateways: [], eips: [] },
          access: { portGroups: [] },
          bootstrap: { scripts: [] },
          runtimePreferences: { imagePolicies: [], instanceTypePolicies: [] },
        },
      })
      .expect(200);

    expect(updateResponse.body.currentPublishedVersionId).toBe(publishedVersionId);
    expect(updateResponse.body.currentPublishedVersion.version).toBe('v1');
    expect(updateResponse.body.currentDraftVersion.version).toBe('v2');

    await request(app.getHttpServer())
      .post(`/admin/scenarios/${createResponse.body.id}/validate`)
      .set('authorization', `Bearer ${aliceToken}`)
      .expect(400)
      .expect(({ body }) => {
        expect(String(body.message)).toContain('draft-only-zone');
      });

    await request(app.getHttpServer())
      .post(`/admin/scenarios/${createResponse.body.id}/validate`)
      .set('authorization', `Bearer ${bobToken}`)
      .expect(200)
      .expect(({ body }) => {
        expect(body).toEqual({ valid: true });
      });

    const cloneResponse = await request(app.getHttpServer())
      .post(`/admin/scenarios/${createResponse.body.id}/clone`)
      .set('authorization', `Bearer ${bobToken}`)
      .expect(201);

    expect(cloneResponse.body).toEqual(
      expect.objectContaining({
        version: 'v1',
        scenarioTemplateSpec: expect.objectContaining({
          metadata: expect.objectContaining({
            name: 'Published Scenario V1',
            version: 'v1',
          }),
        }),
        compiledProvisionSpec: expect.objectContaining({
          topology: expect.objectContaining({
            vpcCidr: '10.82.0.0/16',
          }),
        }),
      }),
    );

    const createInstanceResponse = await request(app.getHttpServer())
      .post('/admin/ranges')
      .set('authorization', `Bearer ${bobToken}`)
      .send({
        name: 'bob-published-create',
        templateId: createResponse.body.id,
      })
      .expect(201);

    expect(createInstanceResponse.body).toEqual(
      expect.objectContaining({
        ownerUserId: bob.id,
        sourceTemplateVersionId: publishedVersionId,
      }),
    );

    const launchResponse = await request(app.getHttpServer())
      .post('/admin/ranges/launch')
      .set('authorization', `Bearer ${bobToken}`)
      .send({
        name: 'bob-published-launch',
        templateId: createResponse.body.id,
        expiresAt: '2026-07-13T12:00:00.000Z',
      })
      .expect(201);

    expect(launchResponse.body).toEqual(
      expect.objectContaining({
        ownerUserId: bob.id,
        sourceTemplateVersionId: publishedVersionId,
        runtimeScenarioTemplateSpec: expect.objectContaining({
          metadata: expect.objectContaining({
            name: 'Published Scenario V1',
            version: 'v1',
          }),
        }),
        runtimeCompiledProvisionSpec: expect.objectContaining({
          topology: expect.objectContaining({
            vpcCidr: '10.82.0.0/16',
          }),
        }),
      }),
    );
  });

  it('does not fall back to draft-only fields when a shared published snapshot lacks them', async () => {
    const aliceToken = await loginAs(app, alice.username, alice.password);
    const bobToken = await loginAs(app, bob.username, bob.password);
    const provisioningWorker = app.get(ProvisioningWorkerService);
    const draftOnlyGraph = {
      schemaVersion: '1',
      nodes: [{ id: 'entry', kind: 'ecs', data: { label: 'draft-only-entry-graph' } }],
      edges: [],
    };

    const { topologyGraph: _unusedGraph, ...publishableTemplate } = createConsumableTemplatePayload({
      name: 'Alice Shared No Graph Published',
      slug: 'alice-shared-no-graph-published',
      version: 'v1',
      scenarioName: 'Published Without Graph',
      hostName: 'published-no-graph-entry',
      vpcCidr: '10.84.0.0/16',
    });

    const createResponse = await request(app.getHttpServer())
      .post('/admin/scenarios')
      .set('authorization', `Bearer ${aliceToken}`)
      .send(publishableTemplate)
      .expect(201);

    await request(app.getHttpServer())
      .post(`/admin/scenarios/${createResponse.body.id}/share`)
      .set('authorization', `Bearer ${aliceToken}`)
      .expect(200);

    const publishResponse = await request(app.getHttpServer())
      .post(`/admin/scenarios/${createResponse.body.id}/publish`)
      .set('authorization', `Bearer ${aliceToken}`)
      .expect(200);

    const publishedVersionId = publishResponse.body.currentPublishedVersionId as string;

    const updateResponse = await request(app.getHttpServer())
      .patch(`/admin/scenarios/${createResponse.body.id}`)
      .set('authorization', `Bearer ${aliceToken}`)
      .send({
        version: 'v2',
        topologyGraph: draftOnlyGraph,
      })
      .expect(200);

    expect(updateResponse.body.currentPublishedVersionId).toBe(publishedVersionId);
    expect(updateResponse.body.currentPublishedVersion.topologyGraph).toBeUndefined();
    expect(updateResponse.body.currentDraftVersion.topologyGraph).toEqual(draftOnlyGraph);

    const cloneResponse = await request(app.getHttpServer())
      .post(`/admin/scenarios/${createResponse.body.id}/clone`)
      .set('authorization', `Bearer ${bobToken}`)
      .expect(201);

    expect(cloneResponse.body.currentPublishedVersionId).toBeNull();
    expect(cloneResponse.body.topologyGraph).toBeUndefined();
    expect(cloneResponse.body.scenarioTemplateSpec).toEqual(
      expect.objectContaining({
        metadata: expect.objectContaining({
          name: 'Published Without Graph',
          version: 'v1',
        }),
      }),
    );

    const createInstanceResponse = await request(app.getHttpServer())
      .post('/admin/ranges')
      .set('authorization', `Bearer ${bobToken}`)
      .send({
        name: 'bob-worker-published-create',
        templateId: createResponse.body.id,
      })
      .expect(201);

    expect(createInstanceResponse.body.sourceTemplateVersionId).toBe(publishedVersionId);

    const createJobResponse = await request(app.getHttpServer())
      .post(`/admin/ranges/${createInstanceResponse.body.id}/create`)
      .set('authorization', `Bearer ${bobToken}`)
      .send({})
      .expect(201);

    await provisioningWorker.process(createJobResponse.body.id as string);

    const persisted = await repository.getRangeInstanceById(createInstanceResponse.body.id);

    expect(persisted?.sourceTemplateVersionId).toBe(publishedVersionId);
    expect(persisted?.runtimeTopologyGraph).toBeNull();
    expect(persisted?.runtimeScenarioTemplateSpec).toEqual(
      expect.objectContaining({
        metadata: expect.objectContaining({
          name: 'Published Without Graph',
          version: 'v1',
        }),
      }),
    );
  });

  it('shows regular users only their own range instances', async () => {
    const aliceTemplate = await repository.createRangeTemplate({
      ...createTemplatePayload('Alice Range Template', 'alice-range-template'),
      createdBy: alice.id,
      ownerUserId: alice.id,
      visibility: 'private',
    });
    const bobTemplate = await repository.createRangeTemplate({
      ...createTemplatePayload('Bob Range Template', 'bob-range-template'),
      createdBy: bob.id,
      ownerUserId: bob.id,
      visibility: 'private',
    });

    await repository.createRangeInstance({
      name: 'alice-range-instance',
      createdBy: alice.id,
      ownerUserId: alice.id,
      templateId: aliceTemplate.id,
      instanceMode: 'range',
      status: 'running',
    });

    const bobInstance = await repository.createRangeInstance({
      name: 'bob-range-instance',
      createdBy: bob.id,
      ownerUserId: bob.id,
      templateId: bobTemplate.id,
      instanceMode: 'range',
      status: 'running',
    });

    const bobToken = await loginAs(app, bob.username, bob.password);

    const response = await request(app.getHttpServer())
      .get('/admin/ranges')
      .set('authorization', `Bearer ${bobToken}`)
      .expect(200);

    expect(response.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: bobInstance.id,
          name: 'bob-range-instance',
          ownerUserId: bob.id,
        }),
      ]),
    );
    expect(response.body).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'alice-range-instance',
          ownerUserId: alice.id,
        }),
      ]),
    );
  });

  it('blocks non-owner users from editing, sharing, or deleting another user private template', async () => {
    const aliceToken = await loginAs(app, alice.username, alice.password);
    const bobToken = await loginAs(app, bob.username, bob.password);

    const privateTemplate = await request(app.getHttpServer())
      .post('/admin/scenarios')
      .set('authorization', `Bearer ${aliceToken}`)
      .send(createTemplatePayload('Alice Locked Template', 'alice-locked-template'))
      .expect(201);

    await request(app.getHttpServer())
      .patch(`/admin/scenarios/${privateTemplate.body.id}`)
      .set('authorization', `Bearer ${bobToken}`)
      .send({ name: 'Bob Should Not Edit This' })
      .expect(403);

    await request(app.getHttpServer())
      .post(`/admin/scenarios/${privateTemplate.body.id}/share`)
      .set('authorization', `Bearer ${bobToken}`)
      .expect(403);

    await request(app.getHttpServer())
      .delete(`/admin/scenarios/${privateTemplate.body.id}`)
      .set('authorization', `Bearer ${bobToken}`)
      .expect(403);
  });

  it('blocks non-owner users from executing node actions on another user range instance', async () => {
    const aliceToken = await loginAs(app, alice.username, alice.password);
    const bobToken = await loginAs(app, bob.username, bob.password);

    const templateResponse = await request(app.getHttpServer())
      .post('/admin/scenarios')
      .set('authorization', `Bearer ${aliceToken}`)
      .send(createTemplatePayload('Alice Node Action Template', 'alice-node-action-template'))
      .expect(201);

    const instance = await repository.createRangeInstance({
      name: 'alice-node-action-range',
      createdBy: alice.id,
      ownerUserId: alice.id,
      templateId: templateResponse.body.id,
      instanceMode: 'range',
      status: 'running',
      resourceSummary: {
        mode: 'opentofu',
        hostIds: {
          entry: 'i-alice-node-1',
        },
      },
    });

    await request(app.getHttpServer())
      .post(`/admin/ranges/${instance.id}/nodes/entry/actions/reboot`)
      .set('authorization', `Bearer ${bobToken}`)
      .send({})
      .expect(403);
  });

  it('rejects malformed node-action metadata with 400 instead of 500', async () => {
    const aliceToken = await loginAs(app, alice.username, alice.password);

    const template = await repository.createRangeTemplate({
      ...createTemplatePayload('Alice Action Validation Template', 'alice-action-validation-template'),
      createdBy: alice.id,
      ownerUserId: alice.id,
      visibility: 'private',
    });

    const instance = await repository.createRangeInstance({
      name: 'alice-action-validation-range',
      createdBy: alice.id,
      ownerUserId: alice.id,
      templateId: template.id,
      instanceMode: 'range',
      status: 'running',
      resourceSummary: {
        mode: 'opentofu',
        hostIds: {
          entry: 'i-alice-pack-image',
        },
      },
    });

    await request(app.getHttpServer())
      .post(`/admin/ranges/${instance.id}/nodes/entry/actions/pack-image`)
      .set('authorization', `Bearer ${aliceToken}`)
      .send({
        displayName: {
          bad: true,
        },
      })
      .expect(400)
      .expect(({ body }) => {
        expect(String(body.message)).toContain('displayName must be a string');
      });
  });

  it('rejects client-sent triggeredBy on range provision job routes', async () => {
    const bobToken = await loginAs(app, bob.username, bob.password);

    const template = await repository.createRangeTemplate({
      ...createTemplatePayload('Bob Create Route Template', 'bob-create-route-template'),
      createdBy: bob.id,
      ownerUserId: bob.id,
      visibility: 'private',
    });

    const instance = await repository.createRangeInstance({
      name: 'bob-draft-instance',
      createdBy: bob.id,
      ownerUserId: bob.id,
      templateId: template.id,
      instanceMode: 'range',
      status: 'draft',
    });

    await request(app.getHttpServer())
      .post(`/admin/ranges/${instance.id}/create`)
      .set('authorization', `Bearer ${bobToken}`)
      .send({ triggeredBy: 'malicious-client' })
      .expect(400)
      .expect(({ body }) => {
        expect(body.message).toEqual(expect.arrayContaining(['property triggeredBy should not exist']));
      });
  });
});
