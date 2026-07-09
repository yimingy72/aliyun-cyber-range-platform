import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { configureApp } from '../src/bootstrap/configure-app';
import { AppModule } from '../src/app.module';

describe('Admin session', () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.DATABASE_URL = 'postgresql://postgres:postgres@localhost:5432/cyber_range?schema=public';
    process.env.ADMIN_USERNAME = 'admin';
    process.env.ADMIN_PASSWORD = 'change-me';
    process.env.ADMIN_TOKEN = 'dev-admin-token';

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('creates an admin session for valid credentials', async () => {
    const response = await request(app.getHttpServer())
      .post('/admin/session')
      .send({
        username: 'admin',
        password: 'change-me',
      })
      .expect(200);

    expect(response.body).toEqual({
      token: expect.any(String),
      profile: {
        id: 'admin',
        username: 'admin',
        role: 'admin',
      },
    });
  });

  it('rejects invalid credentials', async () => {
    await request(app.getHttpServer())
      .post('/admin/session')
      .send({
        username: 'admin',
        password: 'wrong-password',
      })
      .expect(401);
  });
});
