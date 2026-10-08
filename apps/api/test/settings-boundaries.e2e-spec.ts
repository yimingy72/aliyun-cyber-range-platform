import { PrismaService } from '../src/database/prisma.service';
import { CloudAccountContextsService } from '../src/admin/cloud-account-contexts.service';
import { SystemConfigService } from '../src/admin/system-config.service';

const url = process.env.SETTINGS_SWITCH_TEST_DATABASE_URL;
const isolated = url ? describe : describe.skip;
isolated('Cloud config boundary persistence (isolated PostgreSQL)', () => {
  let prisma: PrismaService; let cloud: CloudAccountContextsService; let system: SystemConfigService;
  const environment = { ...process.env };
  beforeAll(() => { prisma = new PrismaService({ datasources: { db: { url: url! } } }); cloud = new CloudAccountContextsService(prisma); system = new SystemConfigService(prisma, cloud); });
  beforeEach(async () => {
    await prisma.$executeRaw`TRUNCATE TABLE "CloudAccountContext", "SystemCloudConfig", "RangeInstance", "ProvisionJob", "BillingLedgerResource", "ImageImportJob" CASCADE`;
    await prisma.cloudAccountContext.create({ data: { id: 'boundary-old', provider: 'alibaba_cloud', displayName: 'Synthetic context', accountUid: 'synthetic-old-account', regionId: 'cn-beijing', zoneId: 'cn-beijing-h', accessKeyId: 'synthetic-key', accessKeySecret: 'synthetic-secret', imageImportBucket: '', status: 'ready', isActive: true } });
  });
  afterEach(() => { jest.restoreAllMocks(); process.env = { ...environment }; });
  afterAll(async () => prisma.$disconnect());
  it('does not persist a region-only update that would retain a zone from another region', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch');
    await expect(system.updateSnapshot({ defaultRegion: 'cn-hangzhou' })).rejects.toThrow('默认可用区必须属于默认地域');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await prisma.cloudAccountContext.findMany({ where: { isActive: true } })).toEqual([expect.objectContaining({ regionId: 'cn-beijing', zoneId: 'cn-beijing-h' })]);
    expect(await prisma.cloudAccountContext.count()).toBe(1);
  });
  it('persists an unavailable NoSuchBucket result and prevents upload credentials from being issued', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({ AccountId: 'synthetic-new-account' }), { status: 200 })).mockResolvedValueOnce(new Response(null, { status: 404, headers: { 'x-oss-err': Buffer.from('<Error><Code>NoSuchBucket</Code><Message>synthetic-private-text</Message></Error>').toString('base64') } }));
    await system.updateSnapshot({ defaultRegion: 'cn-hangzhou', defaultZoneId: 'cn-hangzhou-h', accessKeyId: 'synthetic-new-key', accessKeySecret: 'synthetic-new-secret', imageImportBucket: 'synthetic-import-bucket' });
    const active = await prisma.cloudAccountContext.findFirstOrThrow({ where: { isActive: true } });
    expect(active).toMatchObject({ regionId: 'cn-hangzhou', bucketStatus: 'unavailable', lastVerifiedAt: null });
    expect(active.lastError).not.toContain('synthetic-private-text');
    await expect(cloud.getCredentials(active.id, { requireImageImportBucket: true })).rejects.toThrow('Bucket 不可用');
  });
});
