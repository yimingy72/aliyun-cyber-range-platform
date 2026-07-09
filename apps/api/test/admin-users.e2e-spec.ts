import { randomUUID } from 'node:crypto';

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap/configure-app';
import { PrismaService } from '../src/database/prisma.service';

const DATABASE_URL = 'postgresql://postgres:postgres@localhost:5432/cyber_range?schema=public';

describe('Admin users', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    process.env.DATABASE_URL = DATABASE_URL;
    process.env.ADMIN_USERNAME = 'admin';
    process.env.ADMIN_PASSWORD = 'change-me';
    process.env.ADMIN_TOKEN = 'dev-admin-token';

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();

    prisma = app.get(PrismaService);
    await prisma.$connect();
  });

  beforeEach(async () => {
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

    await app.close();
  });

  it('lets an admin create and disable a regular user, and blocks that user from logging in afterward', async () => {
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

    const userLoginResponse = await request(app.getHttpServer())
      .post('/admin/session')
      .send({
        username,
        password,
      })
      .expect(200);

    expect(userLoginResponse.body).toEqual({
      token: expect.any(String),
      profile: {
        id: createdUserId,
        username,
        role: 'user',
      },
    });

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
      createdAt: createResponse.body.createdAt,
      updatedAt: expect.any(String),
    });

    await request(app.getHttpServer())
      .post('/admin/session')
      .send({
        username,
        password,
      })
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

  async function login(username: string, password: string) {
    const response = await request(app.getHttpServer())
      .post('/admin/session')
      .send({
        username,
        password,
      })
      .expect(200);

    return response.body.token as string;
  }
});
