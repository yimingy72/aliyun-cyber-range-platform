import { CloudAccountContextsService } from '../src/admin/cloud-account-contexts.service';
import { PrismaService } from '../src/database/prisma.service';

function createResponse(payload: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(payload),
    text: jest.fn().mockResolvedValue(typeof payload === 'string' ? payload : JSON.stringify(payload)),
  } as unknown as Response;
}

describe('CloudAccountContextsService', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('returns only the ready active context to ordinary users without credentials', async () => {
    const findMany = jest.fn().mockResolvedValue([
      {
        id: 'context-1',
        displayName: 'Training Account',
        provider: 'alibaba_cloud',
        accountUid: '1234567890',
        regionId: 'cn-hangzhou',
        zoneId: 'cn-hangzhou-h',
        accessKeyId: 'test-access-key',
        accessKeySecret: 'test-access-secret',
        imageImportBucket: 'cyber-range-image-test',
        isActive: true,
        status: 'ready',
        bucketStatus: 'ready',
        lastError: null,
        lastVerifiedAt: new Date('2026-07-20T00:00:00.000Z'),
        createdAt: new Date('2026-07-20T00:00:00.000Z'),
        updatedAt: new Date('2026-07-20T00:00:00.000Z'),
      },
    ]);
    const service = new CloudAccountContextsService({
      cloudAccountContext: { findMany },
    } as unknown as PrismaService);

    const contexts = await service.list();

    expect(findMany).toHaveBeenCalledWith({
      where: { isActive: true, status: 'ready' },
      orderBy: [{ updatedAt: 'desc' }],
    });
    expect(contexts).toEqual([
      expect.objectContaining({ id: 'context-1', accountUid: '1234567890', status: 'ready' }),
    ]);
    expect(contexts[0]).not.toHaveProperty('accessKeyId');
    expect(contexts[0]).not.toHaveProperty('accessKeySecret');
  });

  it('uses a supplied import Bucket without creating or reconfiguring it', async () => {
    const readyContext = {
      id: 'context-1',
      displayName: '阿里云 1234567890 · cn-hangzhou',
      provider: 'alibaba_cloud' as const,
      accountUid: '1234567890',
      regionId: 'cn-hangzhou',
      zoneId: 'cn-hangzhou-h',
      accessKeyId: 'test-access-key',
      accessKeySecret: 'test-access-secret',
      imageImportBucket: 'training-image-imports',
      isActive: true,
      status: 'ready' as const,
      bucketStatus: 'ready',
      lastError: null,
      lastVerifiedAt: new Date('2026-07-20T00:01:00.000Z'),
      createdAt: new Date('2026-07-20T00:00:00.000Z'),
      updatedAt: new Date('2026-07-20T00:00:00.000Z'),
    };
    const create = jest.fn().mockResolvedValue(readyContext);
    const update = jest.fn().mockResolvedValue(readyContext);
    const service = new CloudAccountContextsService({
      cloudAccountContext: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(readyContext),
        count: jest.fn().mockResolvedValue(0),
        create,
        update,
      },
    } as unknown as PrismaService);
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(createResponse({ AccountId: '1234567890' }))
      .mockResolvedValueOnce(createResponse({}, 200))
      .mockResolvedValueOnce(createResponse({}, 200))
      .mockResolvedValueOnce(createResponse('<CORSConfiguration></CORSConfiguration>', 200))
      .mockResolvedValueOnce(createResponse({}, 200));

    const cloudConfig = {
      defaultRegion: 'cn-hangzhou',
      defaultZoneId: 'cn-hangzhou-h',
      accessKeyId: 'test-access-key',
      accessKeySecret: 'test-access-secret',
      imageImportBucket: 'training-image-imports',
    };

    await expect(service.saveFromCloudConfig(cloudConfig)).resolves.toEqual(expect.objectContaining({
      id: 'context-1',
      isActive: true,
      status: 'ready',
      imageImportBucket: 'training-image-imports',
    }));

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        accountUid: '1234567890',
        regionId: 'cn-hangzhou',
        zoneId: 'cn-hangzhou-h',
        imageImportBucket: 'training-image-imports',
        isActive: true,
        status: 'ready',
        bucketStatus: 'ready',
      }),
    });
    expect(String((global.fetch as jest.Mock).mock.calls[0][0])).toContain('Action=GetCallerIdentity');
    expect((global.fetch as jest.Mock).mock.calls[1][1]).toEqual(expect.objectContaining({ method: 'HEAD' }));
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('keeps the cloud account ready when image import Bucket is not configured', async () => {
    const unconfiguredContext = {
      id: 'context-1',
      displayName: '阿里云 1234567890 · cn-hangzhou',
      provider: 'alibaba_cloud' as const,
      accountUid: '1234567890',
      regionId: 'cn-hangzhou',
      zoneId: 'cn-hangzhou-h',
      accessKeyId: 'test-access-key',
      accessKeySecret: 'test-access-secret',
      imageImportBucket: '',
      isActive: true,
      status: 'ready' as const,
      bucketStatus: 'unconfigured',
      lastError: null,
      lastVerifiedAt: null,
      createdAt: new Date('2026-07-20T00:00:00.000Z'),
      updatedAt: new Date('2026-07-20T00:00:00.000Z'),
    };
    const create = jest.fn().mockResolvedValue(unconfiguredContext);
    const service = new CloudAccountContextsService({
      cloudAccountContext: {
        findUnique: jest.fn().mockResolvedValue(null),
        count: jest.fn().mockResolvedValue(0),
        create,
      },
    } as unknown as PrismaService);
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(createResponse({ AccountId: '1234567890' }))
      .mockResolvedValueOnce(createResponse({}, 404));

    const cloudConfig = {
      defaultRegion: 'cn-hangzhou',
      defaultZoneId: 'cn-hangzhou-h',
      accessKeyId: 'test-access-key',
      accessKeySecret: 'test-access-secret',
      imageImportBucket: '',
    };

    await expect(service.saveFromCloudConfig(cloudConfig)).resolves.toEqual(expect.objectContaining({
      status: 'ready',
      imageImportBucket: '',
      bucketStatus: 'unconfigured',
    }));
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        imageImportBucket: '',
        status: 'ready',
        bucketStatus: 'unconfigured',
      }),
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps the cloud account ready but closes uploads when the supplied Bucket is unavailable', async () => {
    const unavailableContext = {
      id: 'context-1',
      displayName: '阿里云 1234567890 · cn-hangzhou',
      provider: 'alibaba_cloud' as const,
      accountUid: '1234567890',
      regionId: 'cn-hangzhou',
      zoneId: 'cn-hangzhou-h',
      accessKeyId: 'test-access-key',
      accessKeySecret: 'test-access-secret',
      imageImportBucket: 'missing-image-imports',
      isActive: true,
      status: 'ready' as const,
      bucketStatus: 'unavailable',
      lastError: '无法验证镜像导入 Bucket（HTTP 404）。',
      lastVerifiedAt: null,
      createdAt: new Date('2026-07-20T00:00:00.000Z'),
      updatedAt: new Date('2026-07-20T00:00:00.000Z'),
    };
    const create = jest.fn().mockResolvedValue(unavailableContext);
    const service = new CloudAccountContextsService({
      cloudAccountContext: {
        findUnique: jest.fn().mockResolvedValue(null),
        count: jest.fn().mockResolvedValue(0),
        create,
      },
    } as unknown as PrismaService);
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(createResponse({ AccountId: '1234567890' }))
      .mockResolvedValueOnce(createResponse({}, 404));

    const cloudConfig = {
      defaultRegion: 'cn-hangzhou',
      defaultZoneId: 'cn-hangzhou-h',
      accessKeyId: 'test-access-key',
      accessKeySecret: 'test-access-secret',
      imageImportBucket: 'missing-image-imports',
    };

    await expect(service.saveFromCloudConfig(cloudConfig)).resolves.toEqual(expect.objectContaining({
      status: 'ready',
      imageImportBucket: 'missing-image-imports',
      bucketStatus: 'unavailable',
      lastError: '无法验证镜像导入 Bucket（HTTP 404）。',
    }));
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: 'ready',
        bucketStatus: 'unavailable',
      }),
    });
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('keeps the cloud account ready when the import Bucket verification request fails', async () => {
    const unavailableContext = {
      id: 'context-1',
      displayName: '阿里云 1234567890 · cn-hangzhou',
      provider: 'alibaba_cloud' as const,
      accountUid: '1234567890',
      regionId: 'cn-hangzhou',
      zoneId: 'cn-hangzhou-h',
      accessKeyId: 'test-access-key',
      accessKeySecret: 'test-access-secret',
      imageImportBucket: 'training-image-imports',
      isActive: true,
      status: 'ready' as const,
      bucketStatus: 'unavailable',
      lastError: '无法连接 OSS 验证镜像导入 Bucket。',
      lastVerifiedAt: null,
      createdAt: new Date('2026-07-20T00:00:00.000Z'),
      updatedAt: new Date('2026-07-20T00:00:00.000Z'),
    };
    const create = jest.fn().mockResolvedValue(unavailableContext);
    const service = new CloudAccountContextsService({
      cloudAccountContext: {
        findUnique: jest.fn().mockResolvedValue(null),
        count: jest.fn().mockResolvedValue(0),
        create,
      },
    } as unknown as PrismaService);
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(createResponse({ AccountId: '1234567890' }))
      .mockRejectedValueOnce(new Error('network unavailable'));

    const cloudConfig = {
      defaultRegion: 'cn-hangzhou',
      defaultZoneId: 'cn-hangzhou-h',
      accessKeyId: 'test-access-key',
      accessKeySecret: 'test-access-secret',
      imageImportBucket: 'training-image-imports',
    };

    await expect(service.saveFromCloudConfig(cloudConfig)).resolves.toEqual(expect.objectContaining({
      status: 'ready',
      bucketStatus: 'unavailable',
      lastError: '无法连接 OSS 验证镜像导入 Bucket。',
    }));
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({ bucketStatus: 'unavailable' }),
    });
  });

  it('rejects an invalid custom Bucket name before any cloud request', async () => {
    const service = new CloudAccountContextsService({
      cloudAccountContext: {
        findUnique: jest.fn().mockResolvedValue(null),
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn().mockResolvedValue({
          id: 'context-1',
          displayName: '阿里云 1234567890 · cn-hangzhou',
          provider: 'alibaba_cloud',
          accountUid: '1234567890',
          regionId: 'cn-hangzhou',
          zoneId: 'cn-hangzhou-h',
          accessKeyId: 'test-access-key',
          accessKeySecret: 'test-access-secret',
          imageImportBucket: 'Invalid_Bucket',
          isActive: true,
          status: 'ready',
          bucketStatus: 'ready',
          lastError: null,
          lastVerifiedAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      },
    } as unknown as PrismaService);
    global.fetch = jest.fn().mockResolvedValue(createResponse({ AccountId: '1234567890' }));

    const cloudConfig = {
      defaultRegion: 'cn-hangzhou',
      defaultZoneId: 'cn-hangzhou-h',
      accessKeyId: 'test-access-key',
      accessKeySecret: 'test-access-secret',
      imageImportBucket: 'Invalid_Bucket',
    };

    await expect(service.saveFromCloudConfig(cloudConfig)).rejects.toThrow('自定义 OSS 存储桶名格式无效');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('does not change the import Bucket while the account still has uncleared image import jobs', async () => {
    const existingContext = {
      id: 'context-1',
      displayName: '阿里云 1234567890 · cn-hangzhou',
      provider: 'alibaba_cloud' as const,
      accountUid: '1234567890',
      regionId: 'cn-hangzhou',
      zoneId: 'cn-hangzhou-h',
      accessKeyId: 'test-access-key',
      accessKeySecret: 'test-access-secret',
      imageImportBucket: 'previous-image-imports',
      isActive: true,
      status: 'ready' as const,
      bucketStatus: 'ready',
      lastError: null,
      lastVerifiedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const countImageImportJobs = jest.fn().mockResolvedValue(1);
    const service = new CloudAccountContextsService({
      cloudAccountContext: {
        findUnique: jest.fn().mockResolvedValue(existingContext),
        update: jest.fn().mockResolvedValue({
          ...existingContext,
          imageImportBucket: 'next-image-imports',
        }),
      },
      imageImportJob: {
        count: countImageImportJobs,
      },
    } as unknown as PrismaService);
    global.fetch = jest.fn().mockResolvedValue(createResponse({ AccountId: '1234567890' }));

    const cloudConfig = {
      defaultRegion: 'cn-hangzhou',
      defaultZoneId: 'cn-hangzhou-h',
      accessKeyId: 'test-access-key',
      accessKeySecret: 'test-access-secret',
      imageImportBucket: 'next-image-imports',
    };

    await expect(service.saveFromCloudConfig(cloudConfig)).rejects.toThrow('暂不能更换或清空镜像导入 Bucket');
    expect(countImageImportJobs).toHaveBeenCalledWith({
      where: {
        cloudAccountContextId: 'context-1',
        temporaryObjectDeletedAt: null,
      },
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects image import credentials when the active account has no configured Bucket', async () => {
    const service = new CloudAccountContextsService({
      cloudAccountContext: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'context-1',
          displayName: 'Training Account',
          provider: 'alibaba_cloud',
          accountUid: '1234567890',
          regionId: 'cn-hangzhou',
          zoneId: 'cn-hangzhou-h',
          accessKeyId: 'test-access-key',
          accessKeySecret: 'test-access-secret',
          imageImportBucket: '',
          isActive: true,
          status: 'ready',
          bucketStatus: 'unconfigured',
          lastError: null,
          lastVerifiedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      },
    } as unknown as PrismaService);
    const imageImportOptions = {
      requireReady: true,
      requireActive: true,
      requireImageImportBucket: true,
    };

    await expect(service.getCredentials('context-1', imageImportOptions)).rejects.toThrow('未配置镜像导入 Bucket');
  });

  it('resolves the actual Alibaba Cloud account ID through STS before saving a context', async () => {
    global.fetch = jest.fn().mockResolvedValue(createResponse({ AccountId: '1234567890' }));
    const service = new CloudAccountContextsService({} as PrismaService);
    const resolveAccountUid = (service as unknown as {
      resolveAccountUid(accessKeyId: string, accessKeySecret: string): Promise<string>;
    }).resolveAccountUid;

    await expect(resolveAccountUid.call(service, 'test-access-key', 'test-access-secret')).resolves.toBe('1234567890');
    expect(String((global.fetch as jest.Mock).mock.calls[0][0])).toContain('Action=GetCallerIdentity');
    expect(String((global.fetch as jest.Mock).mock.calls[0][0])).not.toContain('test-access-secret');
  });

  it('blocks an account switch while live instances or provision jobs still exist', async () => {
    const service = new CloudAccountContextsService({
      cloudAccountContext: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'context-next',
          displayName: 'Next Account',
          provider: 'alibaba_cloud',
          accountUid: '9876543210',
          regionId: 'cn-shanghai',
          zoneId: 'cn-shanghai-g',
          accessKeyId: 'next-access-key',
          accessKeySecret: 'next-access-secret',
          imageImportBucket: 'cyber-range-image-next',
          isActive: false,
          status: 'ready',
          bucketStatus: 'ready',
          lastError: null,
          lastVerifiedAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      },
      rangeInstance: { count: jest.fn().mockResolvedValue(1) },
      provisionJob: { count: jest.fn().mockResolvedValue(0) },
    } as unknown as PrismaService);

    await expect(service.activate('context-next')).rejects.toThrow('当前仍存在未销毁实例或执行中的资源任务');
  });

  it('reports an unavailable cloud account without attributing the failure to its import Bucket', async () => {
    const service = new CloudAccountContextsService({
      cloudAccountContext: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'context-unavailable',
          displayName: 'Unavailable Account',
          provider: 'alibaba_cloud',
          accountUid: '9876543210',
          regionId: 'cn-shanghai',
          zoneId: 'cn-shanghai-g',
          accessKeyId: 'next-access-key',
          accessKeySecret: 'next-access-secret',
          imageImportBucket: '',
          isActive: false,
          status: 'degraded',
          bucketStatus: 'unconfigured',
          lastError: 'STS verification failed',
          lastVerifiedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      },
    } as unknown as PrismaService);

    await expect(service.activate('context-unavailable')).rejects.toThrow('当前阿里云账号不可用，无法切换');
  });
});
