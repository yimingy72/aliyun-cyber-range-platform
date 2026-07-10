import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { hashPassword } from '../src/admin/admin-user-auth';
import { ADMIN_REPOSITORY, type AdminRepository } from '../src/admin/admin.repository';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap/configure-app';
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

async function loginAs(app: INestApplication, username = 'admin', password = 'change-me') {
  const response = await request(app.getHttpServer())
    .post('/admin/session')
    .send({ username, password })
    .expect(200);

  return response.body.token as string;
}

describe('Admin resource visibility', () => {
  let app: INestApplication;
  let repository: AdminRepository;

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

    expect(response.body).toEqual([
      expect.objectContaining({
        id: bobInstance.id,
        name: 'bob-range-instance',
        ownerUserId: bob.id,
      }),
    ]);
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
});
