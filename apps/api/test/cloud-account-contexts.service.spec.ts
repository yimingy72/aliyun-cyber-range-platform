import { CloudAccountContextsService } from '../src/admin/cloud-account-contexts.service';
import { PrismaService } from '../src/database/prisma.service';

const context = { id: 'context-test', displayName: 'Test account', provider: 'alibaba_cloud' as const, accountUid: 'test-account', regionId: 'cn-hangzhou', zoneId: 'cn-hangzhou-h', accessKeyId: 'test-access-key', accessKeySecret: 'test-access-secret', imageImportBucket: '', isActive: true, status: 'ready' as const, bucketStatus: 'unconfigured', lastError: null, lastVerifiedAt: null, createdAt: new Date(), updatedAt: new Date() };
const input = { defaultRegion: context.regionId, defaultZoneId: context.zoneId, accessKeyId: context.accessKeyId, accessKeySecret: context.accessKeySecret, imageImportBucket: '' };
function response(payload: unknown, status = 200) { return new Response(JSON.stringify(payload), { status }); }
function fixture(initial: typeof context | null = null) {
  let row = initial;
  const db: any = {
    cloudAccountContext: {
      findUnique: jest.fn(async () => row),
      findMany: jest.fn(async ({ where }: any) => row && (!where?.isActive || row.isActive) ? [row] : []),
      upsert: jest.fn(async ({ create, update }: any) => { row = row ? { ...row, ...update } : { ...context, ...create };return row; }),
      updateMany: jest.fn(async () => { if (row) row = { ...row, isActive: false }; }),
      update: jest.fn(async ({ data }: any) => { row = { ...row!, ...data };return row; }),
    },
    rangeInstance: { findMany: jest.fn().mockResolvedValue([]) },
    provisionJob: { count: jest.fn().mockResolvedValue(0) },
    billingLedgerResource: { count: jest.fn().mockResolvedValue(0) },
    imageImportJob: { count: jest.fn().mockResolvedValue(0) },
    systemCloudConfig: { upsert: jest.fn().mockResolvedValue({}) },
    provisionJobStepLog: { create: jest.fn() },
    $executeRaw: jest.fn(),
  };
  db.$transaction = jest.fn(async (callback: (tx: unknown) => unknown) => callback(db));
  return { db, service: new CloudAccountContextsService(db as PrismaService) };
}

describe('CloudAccountContextsService', () => {
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; });
  it('returns only the ready active context to ordinary users without credentials', async () => {
    const { db, service } = fixture(context);const rows = await service.list();
    expect(db.cloudAccountContext.findMany).toHaveBeenCalledWith({ where: { isActive: true, status: 'ready' }, orderBy: [{ updatedAt: 'desc' }] });
    expect(rows[0]).not.toHaveProperty('accessKeyId');expect(rows[0]).not.toHaveProperty('accessKeySecret');
  });
  it('accepts a missing import-prefix object without requiring Bucket ownership', async () => {
    const { db, service } = fixture();global.fetch = jest.fn().mockResolvedValueOnce(response({ AccountId: 'test-account' })).mockResolvedValueOnce(new Response(null, { status: 404, headers: { 'x-oss-err': Buffer.from('<Error><Code>NoSuchKey</Code></Error>').toString('base64') } }));
    expect(await service.saveFromCloudConfig({ ...input, imageImportBucket: 'training-image-imports' })).toMatchObject({ isActive: true, bucketStatus: 'ready', imageImportBucket: 'training-image-imports' });
    expect(db.cloudAccountContext.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ isActive: false }) }));
    expect((global.fetch as jest.Mock).mock.calls[1][1]).toMatchObject({ method: 'HEAD' });
    expect(db.systemCloudConfig.upsert).toHaveBeenCalled();
  });
  it('keeps the cloud account ready when image import Bucket is not configured', async () => {
    const { service } = fixture();global.fetch = jest.fn().mockResolvedValue(response({ AccountId: 'test-account' }));
    expect(await service.saveFromCloudConfig(input)).toMatchObject({ status: 'ready', bucketStatus: 'unconfigured' });expect(global.fetch).toHaveBeenCalledTimes(1);
  });
  it('keeps the cloud account ready but closes uploads when the supplied Bucket is unavailable', async () => {
    const { service } = fixture();global.fetch = jest.fn().mockResolvedValueOnce(response({ AccountId: 'test-account' })).mockResolvedValueOnce(response({}, 403));
    expect(await service.saveFromCloudConfig({ ...input, imageImportBucket: 'training-image-imports' })).toMatchObject({ status: 'ready', bucketStatus: 'unavailable' });
  });
  it('keeps the cloud account ready when the import Bucket verification request fails', async () => {
    const { service } = fixture();global.fetch = jest.fn().mockResolvedValueOnce(response({ AccountId: 'test-account' })).mockRejectedValueOnce(new Error('test unavailable'));
    expect(await service.saveFromCloudConfig({ ...input, imageImportBucket: 'training-image-imports' })).toMatchObject({ status: 'ready', bucketStatus: 'unavailable' });
  });
  it('rejects an invalid custom Bucket name before any cloud request', async () => {
    const { service } = fixture();global.fetch = jest.fn();
    await expect(service.saveFromCloudConfig({ ...input, imageImportBucket: 'Invalid_Bucket' })).rejects.toThrow('存储桶名格式无效');expect(global.fetch).not.toHaveBeenCalled();
  });
  it('does not change the Bucket while its context has uncleared image import jobs', async () => {
    const { db, service } = fixture({ ...context, imageImportBucket: 'old-bucket' });db.imageImportJob.count.mockResolvedValue(1);
    global.fetch = jest.fn().mockResolvedValue(response({ AccountId: 'test-account' }));
    await expect(service.saveFromCloudConfig({ ...input, imageImportBucket: 'next-bucket' })).rejects.toThrow('暂不能更换或清空');expect(db.cloudAccountContext.upsert).not.toHaveBeenCalled();
  });
  it('rejects image import credentials without a usable Bucket', async () => {
    const { service } = fixture(context);
    await expect(service.getCredentials(context.id, { requireImageImportBucket: true })).rejects.toThrow('未配置镜像导入');
  });
  it('resolves the actual account ID through STS without including the Secret in the URL', async () => {
    const { service } = fixture();global.fetch = jest.fn().mockResolvedValue(response({ AccountId: 'test-account' }));
    await expect((service as any).resolveAccountUid('test-access-key', 'test-access-secret')).resolves.toBe('test-account');
    expect(String((global.fetch as jest.Mock).mock.calls[0][0])).not.toContain('test-access-secret');
  });
  it('blocks switching while live instances or provision jobs remain', async () => {
    const { db, service } = fixture({ ...context, isActive: false });db.provisionJob.count.mockResolvedValue(1);
    await expect(service.activate(context.id)).rejects.toThrow('执行中的资源任务');expect(db.$transaction).not.toHaveBeenCalled();
  });
  it('blocks switching while the active account has unreleased billable resources', async () => {
    const { db, service } = fixture({ ...context, isActive: false });db.cloudAccountContext.findMany.mockImplementation(async ({ select }: any) => select ? [context] : [context]);db.billingLedgerResource.count.mockResolvedValue(1);
    await expect(service.activate(context.id)).rejects.toThrow('未释放的计费资源');expect(db.$transaction).not.toHaveBeenCalled();
  });
  it('reports an unavailable cloud account without blaming its import Bucket', async () => {
    const { service } = fixture({ ...context, isActive: false, status: 'degraded' as never });
    await expect(service.activate(context.id)).rejects.toThrow('当前阿里云账号不可用');
  });
});


describe('Cloud configuration region and Bucket validation', () => {
  afterEach(() => { jest.restoreAllMocks(); });
  it.each([
    ['cn-hangzhou', 'cn-beijing-h'], ['ap-southeast-1', 'ap-southeast-11a'], ['../invalid', '../invalid-a'],
  ])('rejects mismatched region %s and zone %s before cloud requests or persistence', async (defaultRegion, defaultZoneId) => {
    const { db, service } = fixture(); const fetchMock = jest.spyOn(globalThis, 'fetch');
    await expect(service.saveFromCloudConfig({ ...input, defaultRegion, defaultZoneId })).rejects.toThrow('默认可用区必须属于默认地域');
    expect(fetchMock).not.toHaveBeenCalled(); expect(db.cloudAccountContext.upsert).not.toHaveBeenCalled();
  });
  it.each([
    ['cn-hangzhou', 'cn-hangzhou-h'], ['ap-southeast-1', 'ap-southeast-1a'], ['cn-wuhan-lr', 'cn-wuhan-lr-a'],
  ])('keeps valid domestic and overseas region/zone conventions: %s %s', async (defaultRegion, defaultZoneId) => {
    const { service } = fixture(); jest.spyOn(globalThis, 'fetch').mockResolvedValue(response({ AccountId: 'test-account' }));
    await expect(service.saveFromCloudConfig({ ...input, defaultRegion, defaultZoneId })).resolves.toMatchObject({ regionId: defaultRegion, zoneId: defaultZoneId });
  });
  it.each([
    ['NoSuchBucket', '<Error><Code>NoSuchBucket</Code><Message>synthetic-private-message</Message></Error>'],
    ['UnknownError', '<Error><Code>UnknownError</Code></Error>'],
    ['DuplicateCode', '<Error><Code>NoSuchBucket</Code><Code>NoSuchKey</Code></Error>'],
    ['NoErrorRoot', '<Message><Code>NoSuchKey</Code></Message>'],
    ['MissingCode', '<Error><Message>NoSuchKey</Message></Error>'],
  ])('closes image uploads on ambiguous or missing Bucket HEAD errors: %s', async (_name, xml) => {
    const { service } = fixture(); const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response({ AccountId: 'test-account' })).mockResolvedValueOnce(new Response(null, { status: 404, headers: { 'x-oss-err': Buffer.from(xml).toString('base64') } }));
    const saved = await service.saveFromCloudConfig({ ...input, imageImportBucket: 'training-image-imports' });
    expect(saved).toMatchObject({ bucketStatus: 'unavailable', lastVerifiedAt: null }); expect(saved.lastError).not.toContain('synthetic-private-message');
    await expect(service.getCredentials(saved.id, { requireImageImportBucket: true })).rejects.toThrow('Bucket 不可用'); expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it.each([undefined, 'not!base64', Buffer.from('not XML').toString('base64')])('does not infer a valid Bucket from a plain or malformed 404 header', async (header) => {
    const { service } = fixture(); jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response({ AccountId: 'test-account' })).mockResolvedValueOnce(new Response(null, { status: 404, headers: header ? { 'x-oss-err': header } : {} }));
    await expect(service.saveFromCloudConfig({ ...input, imageImportBucket: 'training-image-imports' })).resolves.toMatchObject({ bucketStatus: 'unavailable' });
  });
});
