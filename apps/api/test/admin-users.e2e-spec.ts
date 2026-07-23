import { randomUUID } from 'node:crypto';

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { KeycloakAdminService } from '../src/admin/keycloak-admin.service';
import { configureApp } from '../src/bootstrap/configure-app';
import { PrismaService } from '../src/database/prisma.service';
import { loginAsPrismaUser, overrideTestOidc } from './support/test-oidc';

const DATABASE_URL = 'postgresql://postgres:postgres@localhost:5432/cyber_range?schema=public';

describe('Admin users', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let keycloakSequence = 0;

  beforeAll(async () => {
    process.env.DATABASE_URL = DATABASE_URL;
    process.env.ADMIN_USERNAME = 'admin';
    process.env.ADMIN_PASSWORD = 'change-me';
    process.env.ADMIN_TOKEN = 'dev-admin-token';

    const moduleRef = await overrideTestOidc(Test.createTestingModule({
      imports: [AppModule],
    }))
      .overrideProvider(KeycloakAdminService)
      .useValue({
        createUser: jest.fn(async () => `kc-subject-${++keycloakSequence}`),
        updateUserRole: jest.fn(async () => undefined),
        updateUserStatus: jest.fn(async () => undefined),
        resetUserPassword: jest.fn(async () => undefined),
      })
      .compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();

    prisma = app.get(PrismaService);
    await prisma.$connect();
  });

  beforeEach(async () => {
    keycloakSequence = 0;

    await prisma.platformUser.deleteMany({
      where: {
        id: {
          not: 'admin',
        },
      },
    });

    await prisma.platformUser.updateMany({
      where: {
        id: 'admin',
      },
      data: {
        username: 'admin',
        role: 'admin',
        status: 'active',
        oidcIssuer: null,
        oidcSubject: null,
      },
    });
  });

  afterAll(async () => {
    await prisma.platformUser.deleteMany({
      where: {
        id: {
          not: 'admin',
        },
      },
    });

    await prisma.platformUser.updateMany({
      where: {
        id: 'admin',
      },
      data: {
        username: 'admin',
        role: 'admin',
        status: 'active',
        oidcIssuer: null,
        oidcSubject: null,
      },
    });

    await app.close();
  });

  it('lets an admin create and disable a regular user, and blocks that user from using the API afterward', async () => {
    const adminToken = await login('admin', 'change-me');
    const username = `user-${randomUUID()}`;
    const password = 'Password123!';

    const createResponse = await request(app.getHttpServer())
      .post('/admin/users')
      .set('authorization', `Bearer ${adminToken}`)
      .send({
        username,
        password,
        role: 'user',
      })
      .expect(201);

    expect(createResponse.body).toEqual({
      id: expect.any(String),
      username,
      role: 'user',
      status: 'active',
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });

    const createdUserId = createResponse.body.id as string;

    const listResponse = await request(app.getHttpServer())
      .get('/admin/users')
      .set('authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(listResponse.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: createdUserId,
          username,
          role: 'user',
          status: 'active',
        }),
      ]),
    );

    const userToken = await login(username, password);

    await request(app.getHttpServer())
      .get('/admin/scenarios')
      .set('authorization', `Bearer ${userToken}`)
      .expect(200);

    await request(app.getHttpServer())
      .get('/admin/users')
      .set('authorization', `Bearer ${userToken}`)
      .expect(403);

    const disableResponse = await request(app.getHttpServer())
      .patch(`/admin/users/${createdUserId}/status`)
      .set('authorization', `Bearer ${adminToken}`)
      .send({
        status: 'disabled',
      })
      .expect(200);

    expect(disableResponse.body).toEqual({
      id: createdUserId,
      username,
      role: 'user',
      status: 'disabled',
      isCurrentUser: false,
      createdAt: createResponse.body.createdAt,
      updatedAt: expect.any(String),
    });

    await request(app.getHttpServer())
      .get('/admin/scenarios')
      .set('authorization', `Bearer ${userToken}`)
      .expect(401);
  });

  it('does not let the last active admin be disabled', async () => {
    const adminToken = await login('admin', 'change-me');

    await request(app.getHttpServer())
      .patch('/admin/users/admin/status')
      .set('authorization', `Bearer ${adminToken}`)
      .send({
        status: 'disabled',
      })
      .expect(409)
      .expect({
        statusCode: 409,
        message: 'Cannot disable the last active admin',
        error: 'Conflict',
      });
  });

  it('does not let the last active admin be demoted to a regular user', async () => {
    const adminToken = await login('admin', 'change-me');

    await request(app.getHttpServer())
      .patch('/admin/users/admin/role')
      .set('authorization', `Bearer ${adminToken}`)
      .send({
        role: 'user',
      })
      .expect(409)
      .expect({
        statusCode: 409,
        message: 'Cannot demote the last active admin',
        error: 'Conflict',
      });
  });

  it('keeps the seeded admin user disabled once another admin disables it', async () => {
    const adminToken = await login('admin', 'change-me');
    const secondAdmin = await createUser(adminToken, {
      username: `admin-${randomUUID()}`,
      password: 'SecondAdmin123!',
      role: 'admin',
    });
    const secondAdminToken = await login(secondAdmin.username, 'SecondAdmin123!');

    await request(app.getHttpServer())
      .patch('/admin/users/admin/status')
      .set('authorization', `Bearer ${secondAdminToken}`)
      .send({
        status: 'disabled',
      })
      .expect(200);

    const persistedAdmin = await prisma.platformUser.findUnique({
      where: {
        id: 'admin',
      },
    });

    expect(persistedAdmin).toEqual(
      expect.objectContaining({
        id: 'admin',
        status: 'disabled',
        role: 'admin',
      }),
    );

    const disabledAdminToken = await login('admin', 'change-me');

    await request(app.getHttpServer())
      .get('/admin/scenarios')
      .set('authorization', `Bearer ${disabledAdminToken}`)
      .expect(401);
  });

  it('keeps the seeded admin user demoted once another admin changes its role', async () => {
    const adminToken = await login('admin', 'change-me');
    const secondAdmin = await createUser(adminToken, {
      username: `admin-${randomUUID()}`,
      password: 'SecondAdmin123!',
      role: 'admin',
    });
    const secondAdminToken = await login(secondAdmin.username, 'SecondAdmin123!');

    await request(app.getHttpServer())
      .patch('/admin/users/admin/role')
      .set('authorization', `Bearer ${secondAdminToken}`)
      .send({
        role: 'user',
      })
      .expect(200);

    const persistedAdmin = await prisma.platformUser.findUnique({
      where: {
        id: 'admin',
      },
    });

    expect(persistedAdmin).toEqual(
      expect.objectContaining({
        id: 'admin',
        role: 'user',
        status: 'active',
      }),
    );

    const demotedAdminToken = await login('admin', 'change-me');

    await request(app.getHttpServer())
      .get('/admin/scenarios')
      .set('authorization', `Bearer ${demotedAdminToken}`)
      .expect(200);

    await request(app.getHttpServer())
      .get('/admin/users')
      .set('authorization', `Bearer ${demotedAdminToken}`)
      .expect(403);
  });

  it('keeps OIDC access valid after an admin password reset', async () => {
    const adminToken = await login('admin', 'change-me');
    const adminUser = await createUser(adminToken, {
      username: `admin-${randomUUID()}`,
      password: 'ResetOld123!',
      role: 'admin',
    });
    const issuedToken = await login(adminUser.username, 'ResetOld123!');

    await request(app.getHttpServer())
      .post(`/admin/users/${adminUser.id}/reset-password`)
      .set('authorization', `Bearer ${issuedToken}`)
      .send({
        password: 'ResetNew123!',
      })
      .expect(201);

    await request(app.getHttpServer())
      .get('/admin/users')
      .set('authorization', `Bearer ${issuedToken}`)
      .expect(200);

    const refreshedToken = await login(adminUser.username, 'ResetNew123!');

    await request(app.getHttpServer())
      .get('/admin/users')
      .set('authorization', `Bearer ${refreshedToken}`)
      .expect(200);
  });

  async function login(username: string, password: string) {
    void password;
    return loginAsPrismaUser(app, username);
  }

  async function createUser(
    token: string,
    input: {
      username: string;
      password: string;
      role: 'admin' | 'user';
    },
  ) {
    const response = await request(app.getHttpServer())
      .post('/admin/users')
      .set('authorization', `Bearer ${token}`)
      .send(input)
      .expect(201);

    return response.body as {
      id: string;
      username: string;
      role: 'admin' | 'user';
      status: 'active' | 'disabled';
      createdAt: string;
      updatedAt: string;
    };
  }
});
