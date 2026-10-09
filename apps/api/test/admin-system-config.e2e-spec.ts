import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { OidcPrincipalResolver } from '../src/admin/oidc-principal-resolver';
import { CloudAccountContextsService } from '../src/admin/cloud-account-contexts.service';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap/configure-app';
import { PrismaService } from '../src/database/prisma.service';
import { createTestAccessToken, overrideTestOidc } from './support/test-oidc';

const MASKED_SECRET = '********';
const SYSTEM_CONFIG_ROW_ID = 'default';
const TEST_ADMIN_AUTHORIZATION = `Bearer ${createTestAccessToken('admin-oidc')}`;

type PersistedSystemCloudConfigRow = {
  id: string;
  provider: string;
  defaultRegion: string;
  defaultZoneId: string;
  accessKeyId: string;
  accessKeySecret: string;
  createdAt: Date;
  updatedAt: Date;
};

function seedAdminEnv() {
  process.env.ADMIN_USERNAME = 'admin';
  process.env.ADMIN_PASSWORD = 'change-me';
  process.env.ADMIN_TOKEN = 'dev-admin-token';
}

function seedAliyunEnv() {
  process.env.ALICLOUD_REGION = 'cn-hangzhou';
  process.env.ALICLOUD_ZONE_ID = 'cn-hangzhou-h';
  process.env.ALICLOUD_ACCESS_KEY = 'test-ak';
  process.env.ALICLOUD_SECRET_KEY = 'test-sk';
}

function clearAliyunEnv() {
  delete process.env.ALICLOUD_REGION;
  delete process.env.ALICLOUD_ZONE_ID;
  delete process.env.ALICLOUD_ACCESS_KEY;
  delete process.env.ALICLOUD_SECRET_KEY;
}

function createFakePrismaService() {
  let row: PersistedSystemCloudConfigRow | null = null;

  return {
    cloudAccountContext: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
    systemCloudConfig: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
        if (!row || row.id !== where.id) {
          return null;
        }

        return { ...row };
      }),
      upsert: jest.fn(
        async ({
          where,
          create,
          update,
        }: {
          where: { id: string };
          create: Omit<PersistedSystemCloudConfigRow, 'createdAt' | 'updatedAt'>;
          update: Partial<PersistedSystemCloudConfigRow>;
        }) => {
          if (row && row.id === where.id) {
            row = {
              ...row,
              ...update,
              updatedAt: new Date(),
            };
          } else {
            row = {
              ...create,
              createdAt: new Date(),
              updatedAt: new Date(),
            };
          }

          return { ...row };
        },
      ),
    },
  };
}

function createJsonResponse(payload: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(payload),
  } as unknown as Response;
}

async function createApp(
  prismaOverride?: ReturnType<typeof createFakePrismaService>,
  cloudAccountContextsOverride: Pick<CloudAccountContextsService, 'saveFromCloudConfig'> = {
    saveFromCloudConfig: jest.fn().mockResolvedValue({ status: 'ready' }),
  },
) {
  const moduleBuilder = overrideTestOidc(Test.createTestingModule({
    imports: [AppModule],
  }));

  if (prismaOverride) {
    moduleBuilder.overrideProvider(PrismaService).useValue(prismaOverride);
  }

  moduleBuilder.overrideProvider(CloudAccountContextsService).useValue({
    saveFromCloudConfig: async (snapshot: Record<string, string>) => {
      const result = await cloudAccountContextsOverride.saveFromCloudConfig(snapshot as never);
      const { imageImportBucket: _bucket, ...config } = snapshot;
      await prismaOverride!.systemCloudConfig.upsert({ where: { id: SYSTEM_CONFIG_ROW_ID }, update: config, create: { id: SYSTEM_CONFIG_ROW_ID, ...config } } as never);
      return result;
    },
  });

  moduleBuilder.overrideProvider(OidcPrincipalResolver).useValue({
    resolve: jest.fn().mockResolvedValue({ id: 'admin', username: 'admin', role: 'admin', status: 'active', isPlatformManager: true, cloudWorkspaceId: null }),
  });

  const moduleRef = await moduleBuilder.compile();
  const app = moduleRef.createNestApplication();
  configureApp(app);
  await app.init();

  return app;
}

describe('Admin system config', () => {
  const originalEnv = { ...process.env };
  const originalFetch = global.fetch;

  afterEach(async () => {
    process.env = originalEnv;
    global.fetch = originalFetch;
  });

  it('returns only the cloud configuration fields used by the new admin UI', async () => {
    seedAdminEnv();
    seedAliyunEnv();
    const app = await createApp(createFakePrismaService());

    const response = await request(app.getHttpServer())
      .get('/admin/system-config')
      .set('authorization', TEST_ADMIN_AUTHORIZATION)
      .expect(200);

    expect(response.body).toEqual({
      provider: 'alibaba_cloud',
      defaultRegion: 'cn-hangzhou',
      defaultZoneId: 'cn-hangzhou-h',
      accessKeyId: MASKED_SECRET,
      accessKeySecret: MASKED_SECRET,
      imageImportBucket: '',
    });

    await app.close();
  });

  it('persists only the cloud configuration fields used by the new admin UI', async () => {
    seedAdminEnv();
    seedAliyunEnv();
    const saveFromCloudConfig = jest.fn().mockResolvedValue({ status: 'ready' });
    const app = await createApp(createFakePrismaService(), { saveFromCloudConfig });

    const response = await request(app.getHttpServer())
      .patch('/admin/system-config')
      .set('authorization', TEST_ADMIN_AUTHORIZATION)
      .send({
        provider: 'alibaba_cloud',
        defaultRegion: 'cn-beijing',
        defaultZoneId: 'cn-beijing-k',
        accessKeyId: 'LTAI-updated',
        accessKeySecret: 'updated-secret',
        imageImportBucket: '',
      })
      .expect(200);

    expect(response.body).toEqual({
      provider: 'alibaba_cloud',
      defaultRegion: 'cn-beijing',
      defaultZoneId: 'cn-beijing-k',
      accessKeyId: MASKED_SECRET,
      accessKeySecret: MASKED_SECRET,
      imageImportBucket: '',
    });
    expect(saveFromCloudConfig).toHaveBeenCalledWith({
      provider: 'alibaba_cloud',
      defaultRegion: 'cn-beijing',
      defaultZoneId: 'cn-beijing-k',
      accessKeyId: 'LTAI-updated',
      accessKeySecret: 'updated-secret',
      imageImportBucket: '',
    });

    const snapshot = await request(app.getHttpServer())
      .get('/admin/system-config')
      .set('authorization', TEST_ADMIN_AUTHORIZATION)
      .expect(200);

    expect(snapshot.body).toEqual({ ...response.body, accessKeyId: MASKED_SECRET });

    await app.close();
  });

  it('persists cloud config across app reload boundaries', async () => {
    seedAdminEnv();
    clearAliyunEnv();
    const prismaOverride = createFakePrismaService();

    const firstApp = await createApp(prismaOverride);

    await request(firstApp.getHttpServer())
      .patch('/admin/system-config')
      .set('authorization', TEST_ADMIN_AUTHORIZATION)
      .send({
        provider: 'alibaba_cloud',
        defaultRegion: 'cn-shanghai',
        defaultZoneId: 'cn-shanghai-b',
        accessKeyId: 'reload-ak',
        accessKeySecret: 'reload-secret',
        imageImportBucket: '',
      })
      .expect(200);

    await firstApp.close();

    clearAliyunEnv();

    const secondApp = await createApp(prismaOverride);

    const response = await request(secondApp.getHttpServer())
      .get('/admin/system-config')
      .set('authorization', TEST_ADMIN_AUTHORIZATION)
      .expect(200);

    expect(response.body).toEqual({
      provider: 'alibaba_cloud',
      defaultRegion: 'cn-shanghai',
      defaultZoneId: 'cn-shanghai-b',
      accessKeyId: MASKED_SECRET,
      accessKeySecret: MASKED_SECRET,
      imageImportBucket: '',
    });

    await secondApp.close();

    expect(prismaOverride.systemCloudConfig.findUnique).toHaveBeenCalledWith({
      where: { id: SYSTEM_CONFIG_ROW_ID },
    });
  });

  it('returns only available instance types supported by the single-instance executor', async () => {
    seedAdminEnv();
    seedAliyunEnv();
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(
        createJsonResponse({
          AvailableZones: {
            AvailableZone: [
              {
                RegionId: 'cn-hangzhou',
                ZoneId: 'cn-hangzhou-h',
                AvailableResources: {
                  AvailableResource: [
                    {
                      Type: 'InstanceType',
                      SupportedResources: {
                        SupportedResource: [
                          { Status: 'Available', Value: 'ecs.e-c1m2.large' },
                          { Status: 'Available', Value: 'ecs.c7.large' },
                          { Status: 'Available', Value: 'ecs.g7.large' },
                          { Status: 'SoldOut', Value: 'ecs.c8y.small' },
                        ],
                      },
                    },
                  ],
                },
              },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(
        createJsonResponse({
          TotalCount: 4,
          PageNumber: 1,
          PageSize: 100,
          InstanceTypes: {
            InstanceType: [
              {
                InstanceTypeId: 'ecs.e-c1m2.large',
                CpuCoreCount: 2,
                MemorySize: 4,
                InstanceTypeFamily: 'ecs.e',
                Generation: 'ecs-1',
                CpuArchitecture: 'X86',
              },
              {
                InstanceTypeId: 'ecs.c7.large',
                CpuCoreCount: 2,
                MemorySize: 4,
                InstanceTypeFamily: 'ecs.c7',
                Generation: 'ecs-7',
                CpuArchitecture: 'X86',
              },
              {
                InstanceTypeId: 'ecs.g7.large',
                CpuCoreCount: 2,
                MemorySize: 4,
                InstanceTypeFamily: 'ecs.g7',
                Generation: 'ecs-7',
                CpuArchitecture: 'X86',
              },
              {
                InstanceTypeId: 'ecs.c8y.small',
                CpuCoreCount: 1,
                MemorySize: 2,
                InstanceTypeFamily: 'ecs.c8y',
                Generation: 'ecs-8',
                CpuArchitecture: 'ARM',
              },
            ],
          },
        }),
      );
    global.fetch = fetchMock as typeof global.fetch;
    const app = await createApp(createFakePrismaService());

    const response = await request(app.getHttpServer())
      .get('/admin/system-config/instance-type-availability?cpu=2&memory=4')
      .set('authorization', TEST_ADMIN_AUTHORIZATION)
      .expect(200);

    expect(response.body).toEqual({
      cpu: 2,
      memory: 4,
      regionId: 'cn-hangzhou',
      zoneId: 'cn-hangzhou-h',
      exactAvailable: true,
      matches: [
        {
          instanceTypeId: 'ecs.e-c1m2.large',
          cpu: 2,
          memoryGiB: 4,
          family: 'ecs.e',
          generation: 'ecs-1',
          architecture: 'X86',
        },
      ],
      warning: null,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('Action=DescribeAvailableResource');
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('Action=DescribeInstanceTypes');

    await app.close();
  });

  it('returns the platform catalog warning for an unsupported 1C2G request', async () => {
    seedAdminEnv();
    seedAliyunEnv();
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(
        createJsonResponse({
          AvailableZones: {
            AvailableZone: [
              {
                RegionId: 'cn-hangzhou',
                ZoneId: 'cn-hangzhou-h',
                AvailableResources: {
                  AvailableResource: [
                    {
                      Type: 'InstanceType',
                      SupportedResources: {
                        SupportedResource: [
                          { Status: 'Available', Value: 'ecs.c8y.small' },
                          { Status: 'Available', Value: 'ecs.c7.large' },
                        ],
                      },
                    },
                  ],
                },
              },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(
        createJsonResponse({
          TotalCount: 2,
          PageNumber: 1,
          PageSize: 100,
          InstanceTypes: {
            InstanceType: [
              {
                InstanceTypeId: 'ecs.c8y.small',
                CpuCoreCount: 1,
                MemorySize: 2,
                InstanceTypeFamily: 'ecs.c8y',
                Generation: 'ecs-8',
                CpuArchitecture: 'ARM',
              },
              {
                InstanceTypeId: 'ecs.c7.large',
                CpuCoreCount: 2,
                MemorySize: 4,
                InstanceTypeFamily: 'ecs.c7',
                Generation: 'ecs-7',
                CpuArchitecture: 'X86',
              },
            ],
          },
        }),
      );
    global.fetch = fetchMock as typeof global.fetch;
    const app = await createApp(createFakePrismaService());

    const response = await request(app.getHttpServer())
      .get('/admin/system-config/instance-type-availability?cpu=1&memory=2')
      .set('authorization', TEST_ADMIN_AUTHORIZATION)
      .expect(200);

    expect(response.body).toEqual({
      cpu: 1,
      memory: 2,
      regionId: 'cn-hangzhou',
      zoneId: 'cn-hangzhou-h',
      exactAvailable: false,
      matches: [],
      warning: '平台单实例执行器不支持 1C2G 规格。',
    });

    await app.close();
  });

  it('rejects invalid instance type availability query params', async () => {
    seedAdminEnv();
    seedAliyunEnv();
    const fetchMock = jest.fn();
    global.fetch = fetchMock as typeof global.fetch;
    const app = await createApp(createFakePrismaService());

    const response = await request(app.getHttpServer())
      .get('/admin/system-config/instance-type-availability?cpu=0&memory=abc')
      .set('authorization', TEST_ADMIN_AUTHORIZATION)
      .expect(400);

    expect(response.body.message).toBe('cpu 和 memory 必须是大于 0 的整数');
    expect(fetchMock).not.toHaveBeenCalled();

    await app.close();
  });
});
