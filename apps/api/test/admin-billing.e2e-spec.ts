import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { ADMIN_REPOSITORY, type AdminRepository } from '../src/admin/admin.repository';
import { BillingBssClient } from '../src/admin/billing-bss-client';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap/configure-app';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';
import { loginAsRepositoryUser, overrideTestOidc } from './support/test-oidc';

describe('Admin billing', () => {
  let app: INestApplication;
  let repository: AdminRepository;

  beforeAll(async () => {
    process.env.ADMIN_USERNAME = 'admin';
    process.env.ADMIN_PASSWORD = 'change-me';
    process.env.ADMIN_TOKEN = 'dev-admin-token';

    repository = createMemoryAdminRepository();

    await repository.createPlatformUser({
      id: 'admin',
      username: 'admin',
      passwordHash: 'unused',
      role: 'admin',
      status: 'active',
    });

    await repository.createPlatformUser({
      id: 'user-1',
      username: 'alice',
      passwordHash: 'unused',
      role: 'user',
      status: 'active',
    });

    const ledger = await repository.createBillingLedgerResource({
      regionId: 'cn-hangzhou',
      cloudResourceId: 'i-test-1',
      cloudResourceType: 'ecs',
      billingScope: 'user',
      ownerUserId: 'user-1',
      rangeInstanceId: 'range-1',
      billingStartAt: new Date('2026-07-16T00:00:00.000Z'),
      tagsSnapshot: { CreatedBy: 'cyber-range-platform' },
    });

    await repository.upsertBillingLineItems([
      {
        syncBatchId: 'sync-1',
        sourceFingerprint: 'line-1',
        billCycle: '2026-07',
        billingDate: '2026-07-16',
        productCode: 'ecs',
        productDetail: '云服务器ECS-按量付费',
        billItem: '云服务器配置',
        cloudResourceId: 'i-test-1',
        cloudResourceType: 'ecs',
        pretaxAmount: 1.25,
        currency: 'CNY',
        billingScope: 'user',
        ownerUserId: 'user-1',
        matchedLedgerId: ledger.id,
        rawPayload: {},
      },
      {
        syncBatchId: 'sync-1',
        sourceFingerprint: 'line-2',
        billCycle: '2026-07',
        billingDate: '2026-07-16',
        productCode: 'eip',
        productDetail: '弹性公网IP',
        billItem: '公网IP保有费',
        cloudResourceId: 'eip-1',
        cloudResourceType: 'eip',
        pretaxAmount: 0.5,
        currency: 'CNY',
        billingScope: 'platform',
        matchedLedgerId: null,
        rawPayload: {},
      },
    ]);

    await repository.createBillingAnomaly({
      syncBatchId: 'sync-1',
      sourceFingerprint: 'anomaly-1',
      billCycle: '2026-07',
      billingDate: '2026-07-16',
      cloudResourceId: 'cn-hangzhou',
      cloudResourceType: 'snapshot_region',
      pretaxAmount: 0.88,
      currency: 'CNY',
      reason: 'missing aggregation rule',
      rawPayload: {},
    });

    const moduleRef = await overrideTestOidc(Test.createTestingModule({
      imports: [AppModule],
    }))
      .overrideProvider(ADMIN_REPOSITORY)
      .useValue(repository)
      .overrideProvider(BillingBssClient)
      .useValue({
        listDailyBillingItems: jest.fn(async () => [
          {
            ProductCode: 'ecs',
            ProductDetail: '云服务器ECS-按量付费',
            BillingItem: '云服务器配置',
            InstanceID: 'i-test-1',
            PretaxAmount: 1.25,
            Currency: 'CNY',
          },
        ]),
      })
      .compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it('lets admins read billing summary, users, items, and anomalies', async () => {
    const adminToken = await loginAsRepositoryUser(repository, 'admin');

    await request(app.getHttpServer())
      .get('/admin/billing/summary?startAt=2026-07-16&endAt=2026-07-16')
      .set('authorization', `Bearer ${adminToken}`)
      .expect(200)
      .expect({
        startAt: '2026-07-16',
        endAt: '2026-07-16',
        totalPretaxAmount: 1.75,
        platformPretaxAmount: 0.5,
        anomalyCount: 1,
        resourceTypeTotals: [
          { resourceType: 'ecs', pretaxAmount: 1.25 },
          { resourceType: 'eip', pretaxAmount: 0.5 },
        ],
        dailyTotals: [{ billingDate: '2026-07-16', pretaxAmount: 1.75 }],
      });

    await request(app.getHttpServer())
      .get('/admin/billing/users?startAt=2026-07-16&endAt=2026-07-16')
      .set('authorization', `Bearer ${adminToken}`)
      .expect(200)
      .expect([
        {
          userId: 'user-1',
          username: 'alice',
          pretaxAmount: 1.25,
          itemCount: 1,
        },
      ]);

    const itemsResponse = await request(app.getHttpServer())
      .get('/admin/billing/users/user-1/items?startAt=2026-07-16&endAt=2026-07-16')
      .set('authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(itemsResponse.body).toEqual([
      expect.objectContaining({
        cloudResourceId: 'i-test-1',
        cloudResourceType: 'ecs',
        billItem: '云服务器配置',
        pretaxAmount: 1.25,
      }),
    ]);

    const platformItemsResponse = await request(app.getHttpServer())
      .get('/admin/billing/platform/items?startAt=2026-07-16&endAt=2026-07-16')
      .set('authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(platformItemsResponse.body).toEqual([
      expect.objectContaining({
        cloudResourceId: 'eip-1',
        cloudResourceType: 'eip',
        billItem: '公网IP保有费',
        pretaxAmount: 0.5,
      }),
    ]);

    const anomaliesResponse = await request(app.getHttpServer())
      .get('/admin/billing/anomalies?startAt=2026-07-16&endAt=2026-07-16')
      .set('authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(anomaliesResponse.body).toEqual([
      expect.objectContaining({
        cloudResourceId: 'cn-hangzhou',
        cloudResourceType: 'snapshot_region',
        pretaxAmount: 0.88,
        reason: 'missing aggregation rule',
      }),
    ]);

    await request(app.getHttpServer())
      .post('/admin/billing/sync')
      .set('authorization', `Bearer ${adminToken}`)
      .send({
        startAt: '2026-07-16',
        endAt: '2026-07-16',
      })
      .expect(201)
      .expect({
        syncedDays: 1,
        importedLineItems: 1,
        anomalyCount: 0,
        deferredCount: 0,
      });

    const exportResponse = await request(app.getHttpServer())
      .get('/admin/billing/export/users.csv?startAt=2026-07-16&endAt=2026-07-16')
      .set('authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(exportResponse.text).toContain('userId,username,pretaxAmount,itemCount');
    expect(exportResponse.text).toContain('user-1,alice');
  });

  it('blocks regular users from billing routes', async () => {
    const userToken = await loginAsRepositoryUser(repository, 'alice');

    await request(app.getHttpServer())
      .get('/admin/billing/summary')
      .set('authorization', `Bearer ${userToken}`)
      .expect(403);
  });
});
