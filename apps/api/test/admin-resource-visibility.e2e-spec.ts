import { completeTemplatePayload } from './support/complete-template-payload';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AdminAuthGuard } from '../src/admin/admin-auth.guard';
import { hashPassword } from '../src/admin/admin-user-auth';
import {
  ADMIN_REPOSITORY,
  type AdminRepository,
  type CreateRangeTemplateInput,
} from '../src/admin/admin.repository';
import { SystemConfigService } from '../src/admin/system-config.service';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap/configure-app';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';

let platformImageAssetId = '';
let repositoryTemplateCounter = 0;
const platformImageId = 'm-visibility-shared-image';

function createTemplatePayload(input: {
  name: string;
  scenarioName?: string;
  hostName?: string;
  vpcCidr?: string;
}) {
  const hostName = input.hostName ?? 'entry';
  const vpcCidr = input.vpcCidr ?? '10.66.0.0/16';
  const vpcPrefix = vpcCidr.split('.').slice(0, 2).join('.');
  const zoneCidr = `${vpcPrefix}.10.0/24`;
  const privateIp = `${vpcPrefix}.10.10`;
  const payload = completeTemplatePayload({
    vpcCidr,
    networkZones: [{ key: 'dmz', name: 'DMZ', purpose: 'public-entry', cidr: zoneCidr, isPublicEntry: true }],
    hosts: [{ key: 'entry', name: hostName, zoneKey: 'dmz', role: 'entry', privateIp, exposePublic: true }],
    publicEntry: { hostKey: 'entry', protocols: [{ protocol: 'ssh', port: 22 }] },
  }, { id: platformImageAssetId, imageId: platformImageId, displayName: 'Fixture image' });
  return {
    name: input.name,
    ...payload,
  };
}

function createSavePayload(
  input: Parameters<typeof createTemplatePayload>[0],
  expectedRevision: number,
) {
  const { name: _name, ...topology } = createTemplatePayload(input);
  return {
    ...topology,
    expectedRevision,
  };
}

function createRepositoryTemplateInput(
  name: string,
  ownerUserId: string,
): CreateRangeTemplateInput {
  repositoryTemplateCounter += 1;

  return {
    ...createTemplatePayload({ name }),
    slug: `visibility-template-${repositoryTemplateCounter}`,
    version: 'v1',
    modulePathOrRef: 'infra/opentofu/modules/alicloud-enterprise-range',
    createdBy: ownerUserId,
    ownerUserId,
    visibility: 'private',
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
    process.env.NODE_ENV = 'test';
    process.env.ADMIN_USERNAME = 'admin';
    process.env.ADMIN_PASSWORD = 'change-me';
    process.env.ADMIN_TOKEN = 'dev-admin-token';
    process.env.OIDC_ISSUER = 'https://test-issuer.example/realms/cyber-range';
    process.env.OIDC_JWKS_URL = 'https://test-issuer.example/realms/cyber-range/certs';
    process.env.OIDC_TOKEN_ENDPOINT = 'https://test-issuer.example/realms/cyber-range/token';

    fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response(JSON.stringify({ RequestId: 'ok' }), { status: 200 });
    });

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(ADMIN_REPOSITORY)
      .useValue(createMemoryAdminRepository())
      .overrideGuard(AdminAuthGuard)
      .useValue({
        canActivate: (context: {
          switchToHttp(): {
            getRequest(): {
              headers: Record<string, string | undefined>;
              adminUser?: Record<string, unknown>;
              authContext?: Record<string, unknown>;
            };
          };
        }) => {
          const requestContext = context.switchToHttp().getRequest();
          const username = requestContext.headers.authorization?.replace(/^Bearer\s+/i, '') || 'admin';
          const authenticatedUser =
            username === alice.username
              ? { id: alice.id, username: alice.username, role: 'user' as const }
              : username === bob.username
                ? { id: bob.id, username: bob.username, role: 'user' as const }
                : { id: 'admin', username: 'admin', role: 'admin' as const };
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

    await repository.upsertImageSnapshots({
      provider: 'alibaba_cloud',
      accountUid: null,
      regionId: 'cn-hangzhou',
      scope: 'custom',
      snapshots: [
        {
          imageId: platformImageId,
          sourceImageName: 'Visibility Shared Image',
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
      displayName: 'Visibility Shared Image',
      ownerUserId: null,
      visibility: 'platform',
    });
    platformImageAssetId = asset.id;
  });

  afterAll(async () => {
    fetchMock?.mockRestore();
    await app?.close();
  });

  it('publishes and returns a topology to private with revision-checked idempotency', async () => {
    const created = await request(app.getHttpServer())
      .post('/admin/scenarios')
      .set('authorization', `Bearer ${alice.username}`)
      .send(createTemplatePayload({ name: 'Alice State Template' }))
      .expect(201);

    expect(created.body).toEqual(
      expect.objectContaining({
        createdBy: alice.username,
        ownerUserId: alice.id,
        visibility: 'private',
        status: 'private',
        revision: 1,
      }),
    );
    expect(created.body).not.toHaveProperty('version');
    expect(created.body).not.toHaveProperty('currentDraftVersionId');
    expect(created.body).not.toHaveProperty('currentPublishedVersionId');

    const published = await request(app.getHttpServer())
      .post(`/admin/scenarios/${created.body.id}/share`)
      .set('authorization', `Bearer ${alice.username}`)
      .send({ expectedRevision: created.body.revision })
      .expect(200);

    expect(published.body).toEqual(
      expect.objectContaining({
        status: 'published',
        visibility: 'platform',
        revision: 2,
      }),
    );
    expect(published.body).not.toHaveProperty('currentPublishedVersion');

    await request(app.getHttpServer())
      .post(`/admin/scenarios/${created.body.id}/share`)
      .set('authorization', `Bearer ${alice.username}`)
      .send({ expectedRevision: published.body.revision })
      .expect(200)
      .expect(({ body }) => {
        expect(body.revision).toBe(published.body.revision);
      });

    await request(app.getHttpServer())
      .post(`/admin/scenarios/${created.body.id}/share`)
      .set('authorization', `Bearer ${alice.username}`)
      .send({ expectedRevision: created.body.revision })
      .expect(409);

    const privateResponse = await request(app.getHttpServer())
      .post(`/admin/scenarios/${created.body.id}/unshare`)
      .set('authorization', `Bearer ${alice.username}`)
      .send({ expectedRevision: published.body.revision })
      .expect(200);

    expect(privateResponse.body).toEqual(
      expect.objectContaining({
        status: 'private',
        visibility: 'private',
        revision: 3,
      }),
    );

    await request(app.getHttpServer())
      .post(`/admin/scenarios/${created.body.id}/unshare`)
      .set('authorization', `Bearer ${alice.username}`)
      .send({ expectedRevision: privateResponse.body.revision })
      .expect(200)
      .expect(({ body }) => {
        expect(body.revision).toBe(privateResponse.body.revision);
      });

    await request(app.getHttpServer())
      .post(`/admin/scenarios/${created.body.id}/unshare`)
      .set('authorization', `Bearer ${alice.username}`)
      .send({ expectedRevision: published.body.revision })
      .expect(409);
  });

  it('returns a changed published topology to private and rejects a stale save', async () => {
    const created = await request(app.getHttpServer())
      .post('/admin/scenarios')
      .set('authorization', `Bearer ${alice.username}`)
      .send(createTemplatePayload({
        name: 'Alice Changed Template',
        scenarioName: 'Saved V1',
        hostName: 'entry-v1',
        vpcCidr: '10.91.0.0/16',
      }))
      .expect(201);
    const published = await request(app.getHttpServer())
      .post(`/admin/scenarios/${created.body.id}/share`)
      .set('authorization', `Bearer ${alice.username}`)
      .send({ expectedRevision: created.body.revision })
      .expect(200);
    const changedPayload = createSavePayload(
      {
        name: 'Alice Changed Template',
        scenarioName: 'Saved V2',
        hostName: 'entry-v2',
        vpcCidr: '10.92.0.0/16',
      },
      published.body.revision,
    );

    const saved = await request(app.getHttpServer())
      .post(`/admin/scenarios/${created.body.id}/validate-and-save`)
      .set('authorization', `Bearer ${alice.username}`)
      .send(changedPayload)
      .expect(200);

    expect(saved.body).toEqual(
      expect.objectContaining({
        id: created.body.id,
        status: 'private',
        visibility: 'private',
        revision: published.body.revision + 1,
        topologySpec: expect.objectContaining({
          vpcCidr: '10.92.0.0/16',
        }),
      }),
    );
    expect(saved.body).not.toHaveProperty('currentPublishedVersionId');

    await request(app.getHttpServer())
      .post(`/admin/scenarios/${created.body.id}/validate-and-save`)
      .set('authorization', `Bearer ${alice.username}`)
      .send(changedPayload)
      .expect(409);
  });

  it('shows other users only published topologies while keeping view=mine owner-scoped', async () => {
    const alicePrivate = await request(app.getHttpServer())
      .post('/admin/scenarios')
      .set('authorization', `Bearer ${alice.username}`)
      .send(createTemplatePayload({ name: 'Alice Private Catalog Template' }))
      .expect(201);
    const alicePublished = await request(app.getHttpServer())
      .post('/admin/scenarios')
      .set('authorization', `Bearer ${alice.username}`)
      .send(createTemplatePayload({ name: 'Alice Published Catalog Template' }))
      .expect(201);
    await request(app.getHttpServer())
      .post(`/admin/scenarios/${alicePublished.body.id}/share`)
      .set('authorization', `Bearer ${alice.username}`)
      .send({ expectedRevision: alicePublished.body.revision })
      .expect(200);
    const bobPrivate = await request(app.getHttpServer())
      .post('/admin/scenarios')
      .set('authorization', `Bearer ${bob.username}`)
      .send(createTemplatePayload({ name: 'Bob Private Catalog Template' }))
      .expect(201);

    const platformResponse = await request(app.getHttpServer())
      .get('/admin/scenarios?view=platform')
      .set('authorization', `Bearer ${bob.username}`)
      .expect(200);

    expect(platformResponse.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: alicePublished.body.id,
          status: 'published',
          ownerUserId: alice.id,
        }),
      ]),
    );
    expect(platformResponse.body).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: alicePrivate.body.id }),
        expect.objectContaining({ id: bobPrivate.body.id }),
      ]),
    );

    const mineResponse = await request(app.getHttpServer())
      .get('/admin/scenarios?view=mine')
      .set('authorization', `Bearer ${bob.username}`)
      .expect(200);

    expect(mineResponse.body).toEqual([
      expect.objectContaining({
        id: bobPrivate.body.id,
        status: 'private',
        ownerUserId: bob.id,
      }),
    ]);
  });

  it('keeps an existing instance pinned to the published snapshot after the owner saves changes', async () => {
    const created = await request(app.getHttpServer())
      .post('/admin/scenarios')
      .set('authorization', `Bearer ${alice.username}`)
      .send(createTemplatePayload({
        name: 'Alice Pinned Template',
        scenarioName: 'Published Snapshot',
        hostName: 'published-entry',
        vpcCidr: '10.82.0.0/16',
      }))
      .expect(201);
    const published = await request(app.getHttpServer())
      .post(`/admin/scenarios/${created.body.id}/share`)
      .set('authorization', `Bearer ${alice.username}`)
      .send({ expectedRevision: created.body.revision })
      .expect(200);
    const internalPublished = await repository.getRangeTemplateById(created.body.id);
    const publishedSnapshotId = internalPublished!.currentPublishedVersionId!;

    const instanceResponse = await request(app.getHttpServer())
      .post('/admin/ranges')
      .set('authorization', `Bearer ${bob.username}`)
      .send({
        name: 'bob-pinned-instance',
        templateId: created.body.id,
      })
      .expect(201);

    expect(instanceResponse.body.sourceTemplateVersionId).toBe(publishedSnapshotId);

    await request(app.getHttpServer())
      .post(`/admin/scenarios/${created.body.id}/validate-and-save`)
      .set('authorization', `Bearer ${alice.username}`)
      .send(createSavePayload(
        {
          name: 'Alice Pinned Template',
          scenarioName: 'Private Saved Change',
          hostName: 'private-entry',
          vpcCidr: '10.83.0.0/16',
        },
        published.body.revision,
      ))
      .expect(200)
      .expect(({ body }) => {
        expect(body.status).toBe('private');
      });

    await request(app.getHttpServer())
      .post(`/admin/scenarios/${created.body.id}/clone`)
      .set('authorization', `Bearer ${bob.username}`)
      .expect(403);
    await request(app.getHttpServer())
      .post('/admin/ranges')
      .set('authorization', `Bearer ${bob.username}`)
      .send({
        name: 'bob-cannot-create-from-private',
        templateId: created.body.id,
      })
      .expect(403);

    const persisted = await repository.getRangeInstanceById(instanceResponse.body.id);
    const pinnedSnapshot = await repository.getRangeTemplateVersionById(publishedSnapshotId);

    expect(persisted?.sourceTemplateVersionId).toBe(publishedSnapshotId);
    expect(pinnedSnapshot?.scenarioTemplateSpec).toEqual(
      expect.objectContaining({
        metadata: expect.objectContaining({
          name: 'Alice Pinned Template',
        }),
        topology: expect.objectContaining({
          vpcCidr: '10.82.0.0/16',
        }),
      }),
    );
    expect(pinnedSnapshot?.compiledProvisionSpec).toEqual(
      expect.objectContaining({
        topology: expect.objectContaining({
          vpcCidr: '10.82.0.0/16',
        }),
      }),
    );
  });

  it('shows regular users only their own range instances', async () => {
    const aliceTemplate = await repository.createRangeTemplate(
      createRepositoryTemplateInput('Alice Range Template', alice.id),
    );
    const bobTemplate = await repository.createRangeTemplate(
      createRepositoryTemplateInput('Bob Range Template', bob.id),
    );

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

    const response = await request(app.getHttpServer())
      .get('/admin/ranges')
      .set('authorization', `Bearer ${bob.username}`)
      .expect(200);

    expect(response.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: bobInstance.id,
          ownerUserId: bob.id,
        }),
      ]),
    );
    expect(response.body).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'alice-range-instance',
        }),
      ]),
    );
  });

  it('blocks non-owners from mutating another user private topology', async () => {
    const privateTemplate = await request(app.getHttpServer())
      .post('/admin/scenarios')
      .set('authorization', `Bearer ${alice.username}`)
      .send(createTemplatePayload({ name: 'Alice Locked Template' }))
      .expect(201);

    await request(app.getHttpServer())
      .patch(`/admin/scenarios/${privateTemplate.body.id}`)
      .set('authorization', `Bearer ${bob.username}`)
      .send({
        name: 'Bob Should Not Edit This',
        expectedRevision: privateTemplate.body.revision,
      })
      .expect(403);
    await request(app.getHttpServer())
      .post(`/admin/scenarios/${privateTemplate.body.id}/validate-and-save`)
      .set('authorization', `Bearer ${bob.username}`)
      .send(createSavePayload(
        { name: 'Alice Locked Template' },
        privateTemplate.body.revision,
      ))
      .expect(403);
    await request(app.getHttpServer())
      .post(`/admin/scenarios/${privateTemplate.body.id}/share`)
      .set('authorization', `Bearer ${bob.username}`)
      .send({ expectedRevision: privateTemplate.body.revision })
      .expect(403);
    await request(app.getHttpServer())
      .post(`/admin/scenarios/${privateTemplate.body.id}/unshare`)
      .set('authorization', `Bearer ${bob.username}`)
      .send({ expectedRevision: privateTemplate.body.revision })
      .expect(403);
    await request(app.getHttpServer())
      .delete(`/admin/scenarios/${privateTemplate.body.id}`)
      .set('authorization', `Bearer ${bob.username}`)
      .expect(403);
  });

  it('blocks non-owner users from executing node actions on another user range instance', async () => {
    const templateResponse = await request(app.getHttpServer())
      .post('/admin/scenarios')
      .set('authorization', `Bearer ${alice.username}`)
      .send(createTemplatePayload({ name: 'Alice Node Action Template' }))
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
      .set('authorization', `Bearer ${bob.username}`)
      .send({})
      .expect(403);
  });

  it('rejects malformed node-action metadata with 400 instead of 500', async () => {
    const template = await repository.createRangeTemplate(
      createRepositoryTemplateInput('Alice Action Validation Template', alice.id),
    );
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
      .set('authorization', `Bearer ${alice.username}`)
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
    const template = await repository.createRangeTemplate(
      createRepositoryTemplateInput('Bob Create Route Template', bob.id),
    );
    const instance = await repository.createRangeInstance({
      name: 'bob-instance-pending-create',
      createdBy: bob.id,
      ownerUserId: bob.id,
      templateId: template.id,
      instanceMode: 'range',
      status: 'draft',
    });

    await request(app.getHttpServer())
      .post(`/admin/ranges/${instance.id}/create`)
      .set('authorization', `Bearer ${bob.username}`)
      .send({ triggeredBy: 'malicious-client' })
      .expect(400)
      .expect(({ body }) => {
        expect(body.message).toEqual(
          expect.arrayContaining(['property triggeredBy should not exist']),
        );
      });
  });
});
