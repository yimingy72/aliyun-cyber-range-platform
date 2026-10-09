import { PrismaService } from '../src/database/prisma.service';
import { CloudAccountContextsService } from '../src/admin/cloud-account-contexts.service';

const url = process.env.SETTINGS_SWITCH_TEST_DATABASE_URL;
const isolated = url ? describe : describe.skip;
const input = { provider: 'tencent_cloud' as const, regionId: 'ap-shanghai', zoneId: 'ap-shanghai-2', accessKeyId: 'synthetic-tencent-key', accessKeySecret: 'synthetic-tencent-secret' };
isolated('Tencent account persistence (isolated PostgreSQL)', () => {
  let prisma: PrismaService;
  let service: CloudAccountContextsService;
  const priorKey = process.env.CLOUD_CREDENTIALS_ENCRYPTION_KEY;
  beforeAll(() => {
    prisma = new PrismaService({ datasources: { db: { url: url! } } });
    service = new CloudAccountContextsService(prisma);
  });
  beforeEach(async () => {
    process.env.CLOUD_CREDENTIALS_ENCRYPTION_KEY = '12'.repeat(32);
    await prisma.$executeRaw`TRUNCATE TABLE "CloudAccountContext", "SystemCloudConfig", "RangeInstance", "ProvisionJob", "BillingLedgerResource", "ImageImportJob" CASCADE`;
    await prisma.cloudAccountContext.create({ data: { id: 'synthetic-active-alibaba', provider: 'alibaba_cloud', displayName: 'Synthetic Alibaba context', accountUid: 'synthetic-alibaba-uid', regionId: 'cn-beijing', zoneId: 'cn-beijing-h', accessKeyId: 'synthetic-alibaba-key', accessKeySecret: 'synthetic-alibaba-secret', imageImportBucket: '', status: 'ready', isActive: true } });
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, request) => {
      const action = (request?.headers as Record<string, string>)['X-TC-Action'];
      const data = action === 'GetCallerIdentity' ? { AccountId: '100001', UserId: '200001' }
        : { TotalCount: 1, ZoneSet: [{ Zone: input.zoneId, ZoneState: 'AVAILABLE' }] };
      return new Response(JSON.stringify({ Response: { RequestId: 'synthetic-request', ...data } }));
    });
  });
  afterEach(() => { jest.restoreAllMocks(); });
  afterAll(async () => {
    await prisma.$disconnect();
    if (priorKey === undefined) delete process.env.CLOUD_CREDENTIALS_ENCRYPTION_KEY;
    else process.env.CLOUD_CREDENTIALS_ENCRYPTION_KEY = priorKey;
  });
  it('persists the Tencent enum and encrypted secret while preserving the active Alibaba account', async () => {
    const saved = await service.saveTencentCloudContext(input);
    const raw = await prisma.cloudAccountContext.findUniqueOrThrow({ where: { id: saved.id } });
    expect(raw).toMatchObject({ provider: 'tencent_cloud', accountUid: '100001', isActive: false, imageImportBucket: '' });
    expect(raw.accessKeySecret).toMatch(/^cloud-credential:v1:/); expect(raw.accessKeySecret).not.toContain(input.accessKeySecret);
    await expect(service.getCredentials(raw.id)).resolves.toMatchObject({ provider: 'tencent_cloud', accessKeySecret: input.accessKeySecret });
    expect(await prisma.cloudAccountContext.findMany({ where: { isActive: true } })).toEqual([expect.objectContaining({ id: 'synthetic-active-alibaba', accessKeySecret: 'synthetic-alibaba-secret' })]);
    expect(await prisma.systemCloudConfig.count()).toBe(0);
    expect((await service.list({ includeInactive: true })).every((row) => !Object.hasOwn(row, 'accessKeySecret') && !Object.hasOwn(row, 'accessKeyId'))).toBe(true);
  });
  it('coalesces simultaneous verified saves by provider, root account and region', async () => {
    const results = await Promise.all([service.saveTencentCloudContext(input), service.saveTencentCloudContext(input)]);
    expect(results[0].id).toBe(results[1].id);
    expect(await prisma.cloudAccountContext.count({ where: { provider: 'tencent_cloud' } })).toBe(1);
    await expect(service.getCredentials(results[0].id)).resolves.toMatchObject({ accessKeySecret: input.accessKeySecret });
    await expect(service.activate(results[0].id)).rejects.toThrow('仅支持将阿里云');
    expect(await prisma.cloudAccountContext.count({ where: { isActive: true, provider: 'alibaba_cloud' } })).toBe(1);
  });
});
