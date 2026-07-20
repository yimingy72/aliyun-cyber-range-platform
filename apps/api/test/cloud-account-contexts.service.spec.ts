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
  const originalAllowedOrigins = process.env.IMAGE_IMPORT_ALLOWED_ORIGINS;
  const originalCredentialSecret = process.env.CLOUD_ACCOUNT_CREDENTIALS_SECRET_KEY;

  beforeEach(() => {
    process.env.CLOUD_ACCOUNT_CREDENTIALS_SECRET_KEY = 'unit-test-cloud-account-credential-key';
  });

  afterEach(() => {
    global.fetch = originalFetch;

    if (originalAllowedOrigins === undefined) {
      delete process.env.IMAGE_IMPORT_ALLOWED_ORIGINS;
    } else {
      process.env.IMAGE_IMPORT_ALLOWED_ORIGINS = originalAllowedOrigins;
    }

    if (originalCredentialSecret === undefined) {
      delete process.env.CLOUD_ACCOUNT_CREDENTIALS_SECRET_KEY;
    } else {
      process.env.CLOUD_ACCOUNT_CREDENTIALS_SECRET_KEY = originalCredentialSecret;
    }
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

  it('uses only configured web origins when applying import Bucket CORS', async () => {
    process.env.IMAGE_IMPORT_ALLOWED_ORIGINS = 'https://range.example.com,http://localhost:3000';
    global.fetch = jest.fn().mockResolvedValue(createResponse({}, 200));
    const service = new CloudAccountContextsService({} as PrismaService);
    const ensurePrivateImportBucket = (service as unknown as {
      ensurePrivateImportBucket(input: {
        bucket: string;
        regionId: string;
        accessKeyId: string;
        accessKeySecret: string;
      }): Promise<void>;
    }).ensurePrivateImportBucket;

    await ensurePrivateImportBucket.call(service, {
      bucket: 'cyber-range-image-test',
      regionId: 'cn-hangzhou',
      accessKeyId: 'test-access-key',
      accessKeySecret: 'test-access-secret',
    });

    const corsRequest = (global.fetch as jest.Mock).mock.calls[1];
    expect(String(corsRequest[0])).toContain('?cors');
    expect(corsRequest[1]).toEqual(
      expect.objectContaining({
        method: 'PUT',
        body: expect.stringContaining('<AllowedOrigin>https://range.example.com</AllowedOrigin>'),
      }),
    );
    expect(corsRequest[1].body).toContain('<AllowedOrigin>http://localhost:3000</AllowedOrigin>');
    expect(corsRequest[1].body).not.toContain('<AllowedOrigin>*</AllowedOrigin>');
  });

  it('merges its upload CORS rule into an existing Bucket configuration without replacing other rules', async () => {
    process.env.IMAGE_IMPORT_ALLOWED_ORIGINS = 'https://range.example.com';
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(createResponse({ Code: 'BucketAlreadyExists' }, 409))
      .mockResolvedValueOnce(
        createResponse(
          '<CORSConfiguration><CORSRule><AllowedOrigin>https://existing.example.com</AllowedOrigin><AllowedMethod>GET</AllowedMethod></CORSRule></CORSConfiguration>',
          200,
        ),
      )
      .mockResolvedValueOnce(createResponse({}, 200));
    const service = new CloudAccountContextsService({} as PrismaService);
    const ensurePrivateImportBucket = (service as unknown as {
      ensurePrivateImportBucket(input: {
        bucket: string;
        regionId: string;
        accessKeyId: string;
        accessKeySecret: string;
      }): Promise<void>;
    }).ensurePrivateImportBucket;

    await ensurePrivateImportBucket.call(service, {
      bucket: 'cyber-range-image-test',
      regionId: 'cn-hangzhou',
      accessKeyId: 'test-access-key',
      accessKeySecret: 'test-access-secret',
    });

    const corsUpdate = (global.fetch as jest.Mock).mock.calls[2];
    expect(String(corsUpdate[0])).toContain('?cors');
    expect(corsUpdate[1]).toEqual(
      expect.objectContaining({
        method: 'PUT',
        body: expect.stringContaining('<AllowedOrigin>https://existing.example.com</AllowedOrigin>'),
      }),
    );
    expect(corsUpdate[1].body).toContain('<AllowedOrigin>https://range.example.com</AllowedOrigin>');
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

  it('encrypts persisted credentials and decrypts them only for cloud API calls', async () => {
    let stored: Record<string, unknown> | null = null;
    const create = jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
      stored = {
        id: 'context-created',
        ...data,
        lastError: null,
        lastVerifiedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      return stored;
    });
    const update = jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
      stored = { ...stored!, ...data };
      return stored;
    });
    const findUnique = jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
      'id' in where ? stored : null,
    );
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(createResponse({ AccountId: '1234567890' }))
      .mockResolvedValueOnce(createResponse({}, 200))
      .mockResolvedValueOnce(createResponse({}, 200));
    const service = new CloudAccountContextsService({
      cloudAccountContext: {
        findUnique,
        count: jest.fn().mockResolvedValue(0),
        create,
        update,
      },
    } as unknown as PrismaService);

    await service.create({
      displayName: 'Training Account',
      regionId: 'cn-hangzhou',
      zoneId: 'cn-hangzhou-h',
      accessKeyId: 'test-access-key',
      accessKeySecret: 'test-access-secret',
    });

    const persisted = create.mock.calls[0][0].data as { accessKeyId: string; accessKeySecret: string };
    expect(persisted.accessKeyId).toMatch(/^enc:cloud:v1:/);
    expect(persisted.accessKeySecret).toMatch(/^enc:cloud:v1:/);
    expect(persisted.accessKeyId).not.toContain('test-access-key');
    expect(persisted.accessKeySecret).not.toContain('test-access-secret');
    await expect(service.getCredentials('context-created')).resolves.toMatchObject({
      accessKeyId: 'test-access-key',
      accessKeySecret: 'test-access-secret',
    });
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
});
