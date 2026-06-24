import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap/configure-app';

describe('Admin system config', () => {
  let app: INestApplication;
  const originalEnv = { ...process.env };

  beforeAll(async () => {
    process.env.ADMIN_USERNAME = 'admin';
    process.env.ADMIN_PASSWORD = 'change-me';
    process.env.ADMIN_TOKEN = 'dev-admin-token';
    process.env.ALICLOUD_REGION = 'cn-hangzhou';
    process.env.ALICLOUD_ZONE_ID = 'cn-hangzhou-h';
    process.env.RANGE_PROVISIONER_MODE = 'dry-run';
    process.env.OPENTOFU_INSTANCE_TYPE = 'auto';
    process.env.OPENTOFU_INSTANCE_TYPE_PREFERENCES = 'ecs.t6-c1m2.large,ecs.c7.large';
    process.env.OPENTOFU_IMAGE_ID = 'ubuntu_22_04_x64_20G_alibase_20260615.vhd';
    process.env.OPENTOFU_INSTANCE_PASSWORD = 'TempRangePassw0rd!';
    process.env.ALICLOUD_PROVIDER_ZIP_PATH = '/tmp/provider.zip';
    process.env.ALICLOUD_ACCESS_KEY = 'test-ak';
    process.env.ALICLOUD_SECRET_KEY = 'test-sk';

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    process.env = originalEnv;
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
      imageId: 'ubuntu_22_04_x64_20G_alibase_20260615.vhd',
      instancePasswordConfigured: true,
      providerZipPathConfigured: true,
      readyForPlan: true,
      checks: [
        expect.objectContaining({ key: 'access_key', configured: true, required: true }),
        expect.objectContaining({ key: 'secret_key', configured: true, required: true }),
        expect.objectContaining({ key: 'region', configured: true, required: true }),
        expect.objectContaining({ key: 'zone_id', configured: true, required: true }),
        expect.objectContaining({ key: 'image_id', configured: true, required: true }),
        expect.objectContaining({ key: 'instance_password', configured: true, required: true }),
        expect.objectContaining({ key: 'provider_zip_path', configured: true, required: false }),
      ],
    });
  });

  it('marks plan readiness as false when required OpenTofu inputs are missing', async () => {
    delete process.env.OPENTOFU_IMAGE_ID;
    delete process.env.OPENTOFU_INSTANCE_PASSWORD;
    delete process.env.ALICLOUD_PROVIDER_ZIP_PATH;

    const response = await request(app.getHttpServer())
      .get('/admin/system-config')
      .set('authorization', 'Bearer dev-admin-token')
      .expect(200);

    expect(response.body.readyForPlan).toBe(false);
    expect(response.body.imageId).toBe('unset');
    expect(response.body.instancePasswordConfigured).toBe(false);
    expect(response.body.providerZipPathConfigured).toBe(false);
    expect(response.body.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'image_id', configured: false, required: true }),
        expect.objectContaining({ key: 'instance_password', configured: false, required: true }),
        expect.objectContaining({ key: 'provider_zip_path', configured: false, required: false }),
      ]),
    );
  });
});
