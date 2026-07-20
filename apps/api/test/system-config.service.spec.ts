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

  it('prevents legacy cloud config writes from silently diverging from the active account context', async () => {
    const upsert = jest.fn();
    const service = new SystemConfigService({
      cloudAccountContext: {
        findFirst: jest.fn().mockResolvedValue({ id: 'context-1', isActive: true, status: 'ready' }),
      },
      systemCloudConfig: {
        findUnique: jest.fn(),
        upsert,
      },
    } as never);

    await expect(service.updateSnapshot({ defaultRegion: 'cn-beijing' })).rejects.toThrow(
      '当前正在使用云账号上下文',
    );
    expect(upsert).not.toHaveBeenCalled();
  });

});
