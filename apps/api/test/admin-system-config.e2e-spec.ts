import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap/configure-app';

describe('Admin system config', () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.ADMIN_USERNAME = 'admin';
    process.env.ADMIN_PASSWORD = 'change-me';
    process.env.ADMIN_TOKEN = 'dev-admin-token';
    process.env.ALICLOUD_REGION = 'cn-hangzhou';
    process.env.ALICLOUD_ZONE_ID = 'cn-hangzhou-h';
    process.env.RANGE_PROVISIONER_MODE = 'dry-run';
    process.env.OPENTOFU_INSTANCE_TYPE = 'auto';
    process.env.OPENTOFU_INSTANCE_TYPE_PREFERENCES = 'ecs.t6-c1m2.large,ecs.c7.large';

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

  it('returns the current cloud configuration snapshot', async () => {
    const response = await request(app.getHttpServer())
      .get('/admin/system-config')
      .set('authorization', 'Bearer dev-admin-token')
      .expect(200);

    expect(response.body).toEqual({
      region: 'cn-hangzhou',
      zoneId: 'cn-hangzhou-h',
      provisionerMode: 'dry-run',
      instanceTypeStrategy: 'auto',
      instanceTypePreferences: ['ecs.t6-c1m2.large', 'ecs.c7.large'],
    });
  });
});
