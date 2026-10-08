import { CloudAccountContextsService } from '../src/admin/cloud-account-contexts.service';
import { SystemConfigService } from '../src/admin/system-config.service';

function createService() {
  return new SystemConfigService({
    cloudAccountContext: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
    systemCloudConfig: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn(),
    },
  } as never, {
    saveFromCloudConfig: jest.fn().mockResolvedValue({ status: 'ready' }),
  } as never);
}

function createJsonResponse(payload: unknown) {
  return {
    ok: true,
    status: 200,
    json: jest.fn().mockResolvedValue(payload),
  } as unknown as Response;
}

describe('SystemConfigService instance type availability', () => {
  const originalEnv = { ...process.env };
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env.ALICLOUD_REGION = 'cn-hangzhou';
    process.env.ALICLOUD_ZONE_ID = 'cn-hangzhou-h';
    process.env.ALICLOUD_ACCESS_KEY = 'test-ak';
    process.env.ALICLOUD_SECRET_KEY = 'test-sk';
  });

  afterEach(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
  });

  it('returns only saleable candidates that the single-instance executor can use', async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(
        createJsonResponse({
          AvailableZones: {
            AvailableZone: [
              {
                ZoneId: 'cn-hangzhou-h',
                AvailableResources: {
                  AvailableResource: [
                    {
                      Type: 'InstanceType',
                      SupportedResources: {
                        SupportedResource: [
                          { Status: 'Available', Value: 'ecs.e-c1m2.large' },
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
            ],
          },
        }),
      );
    global.fetch = fetchMock as typeof global.fetch;

    await expect(createService().getInstanceTypeAvailability({ cpu: 2, memory: 4 })).resolves.toEqual(
      expect.objectContaining({
        exactAvailable: true,
        matches: [expect.objectContaining({ instanceTypeId: 'ecs.e-c1m2.large' })],
      }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rejects CPU and memory pairs outside the single-instance candidate catalog without a cloud query', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as typeof global.fetch;

    await expect(createService().getInstanceTypeAvailability({ cpu: 3, memory: 6 })).resolves.toMatchObject({
      exactAvailable: false,
      matches: [],
      warning: '平台单实例执行器不支持 3C6G 规格。',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('passes the custom image import Bucket through cloud configuration saves', async () => {
    const upsert = jest.fn().mockResolvedValue({
      id: 'default',
      provider: 'alibaba_cloud',
      defaultRegion: 'cn-beijing',
      defaultZoneId: 'cn-beijing-k',
      accessKeyId: 'updated-ak',
      accessKeySecret: 'updated-secret',
    });
    const saveFromCloudConfig = jest.fn().mockResolvedValue({ status: 'ready' });
    const service = new SystemConfigService({
      cloudAccountContext: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'context-1',
          provider: 'alibaba_cloud',
          accountUid: '1234567890',
          regionId: 'cn-hangzhou',
          zoneId: 'cn-hangzhou-h',
          accessKeyId: 'current-ak',
          accessKeySecret: 'current-secret',
          imageImportBucket: 'current-image-imports',
          isActive: true,
          status: 'ready',
        }),
      },
      systemCloudConfig: {
        findUnique: jest.fn(),
        upsert,
      },
    } as never, {
      saveFromCloudConfig,
    } as never);

    const cloudConfig = {
      defaultRegion: 'cn-beijing',
      defaultZoneId: 'cn-beijing-k',
      accessKeyId: 'updated-ak',
      accessKeySecret: 'updated-secret',
      imageImportBucket: 'training-image-imports',
    };

    await expect(service.updateSnapshot(cloudConfig)).resolves.toEqual({
      provider: 'alibaba_cloud',
      defaultRegion: 'cn-beijing',
      defaultZoneId: 'cn-beijing-k',
      accessKeyId: 'updated-ak',
      accessKeySecret: 'updated-secret',
      imageImportBucket: 'training-image-imports',
    });
    expect(saveFromCloudConfig).toHaveBeenCalledWith({
      provider: 'alibaba_cloud',
      defaultRegion: 'cn-beijing',
      defaultZoneId: 'cn-beijing-k',
      accessKeyId: 'updated-ak',
      accessKeySecret: 'updated-secret',
      imageImportBucket: 'training-image-imports',
    });
    expect(upsert).not.toHaveBeenCalled();
  });

});


describe('SystemConfigService partial region updates', () => {
  it('rejects a region-only change that would carry forward an incompatible old zone', async () => {
    const contextService = new CloudAccountContextsService({} as never);
    const service = new SystemConfigService({} as never, contextService);
    jest.spyOn(service, 'getSnapshot').mockResolvedValue({ provider: 'alibaba_cloud', defaultRegion: 'cn-beijing', defaultZoneId: 'cn-beijing-h', accessKeyId: 'synthetic-key', accessKeySecret: 'synthetic-secret', imageImportBucket: '' });
    const fetchMock = jest.spyOn(globalThis, 'fetch');
    try { await expect(service.updateSnapshot({ defaultRegion: 'cn-hangzhou' })).rejects.toThrow('修改地域时请同时指定匹配的可用区'); expect(fetchMock).not.toHaveBeenCalled(); }
    finally { jest.restoreAllMocks(); }
  });
});
