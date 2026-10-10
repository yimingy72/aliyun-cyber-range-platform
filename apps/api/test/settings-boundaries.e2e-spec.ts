import { PrismaService } from '../src/database/prisma.service';
import { CloudAccountContextsService } from '../src/admin/cloud-account-contexts.service';
import { SystemConfigService } from '../src/admin/system-config.service';
import { runInCloudWorkspace } from '../src/auth/cloud-workspace-scope';

const url = process.env.SETTINGS_SWITCH_TEST_DATABASE_URL;
const isolated = url ? describe : describe.skip;
isolated('Cloud config boundary persistence (isolated PostgreSQL)', () => {
  let prisma: PrismaService; let cloud: CloudAccountContextsService; let system: SystemConfigService;
  const environment = { ...process.env };
  const scope = { cloudWorkspaceId: 'boundary-space', provider: 'alibaba_cloud' as const, accountUid: 'synthetic-old-account', isPlatformManager: true, actorUserId: 'fixture-manager' };
  beforeAll(() => { prisma = new PrismaService({ datasources: { db: { url: url! } } }); cloud = new CloudAccountContextsService(prisma); system = new SystemConfigService(prisma, cloud); });
  beforeEach(async () => {
    process.env.CLOUD_CREDENTIALS_ENCRYPTION_KEY = '12'.repeat(32);
    await prisma.$executeRaw`TRUNCATE TABLE "CloudAccountContext", "SystemCloudConfig", "RangeInstance", "ProvisionJob", "BillingLedgerResource", "ImageImportJob" CASCADE`;
    await prisma.cloudWorkspace.upsert({ where: { id: scope.cloudWorkspaceId }, create: { id: scope.cloudWorkspaceId, provider: scope.provider, accountUid: scope.accountUid, displayName: 'Synthetic workspace' }, update: { activeCloudAccountContextId: null } });
    await prisma.cloudAccountContext.create({ data: { id: 'boundary-old', cloudWorkspaceId: scope.cloudWorkspaceId, provider: 'alibaba_cloud', displayName: 'Synthetic context', accountUid: 'synthetic-old-account', regionId: 'cn-beijing', zoneId: 'cn-beijing-h', accessKeyId: 'synthetic-key', accessKeySecret: 'synthetic-secret', imageImportBucket: '', status: 'ready', isActive: true } });
    await prisma.cloudWorkspace.update({ where: { id: scope.cloudWorkspaceId }, data: { activeCloudAccountContextId: 'boundary-old' } });
  });
  afterEach(() => { jest.restoreAllMocks(); process.env = { ...environment }; });
  afterAll(async () => prisma.$disconnect());
  it('does not persist a region-only update that would retain a zone from another region', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch');
    await expect(runInCloudWorkspace(scope, () => system.updateSnapshot({ defaultRegion: 'cn-hangzhou' }))).rejects.toThrow(/地域|可用区/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await prisma.cloudAccountContext.findMany({ where: { isActive: true } })).toEqual([expect.objectContaining({ regionId: 'cn-beijing', zoneId: 'cn-beijing-h' })]);
    expect(await prisma.cloudAccountContext.count()).toBe(1);
  });
  it('persists an unavailable NoSuchBucket result and prevents upload credentials from being issued', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({ AccountId: scope.accountUid }), { status: 200 })).mockResolvedValueOnce(new Response(null, { status: 404, headers: { 'x-oss-err': Buffer.from('<Error><Code>NoSuchBucket</Code><Message>synthetic-private-text</Message></Error>').toString('base64') } }));
    await runInCloudWorkspace(scope, () => system.updateSnapshot({ defaultRegion: 'cn-hangzhou', defaultZoneId: 'cn-hangzhou-h', accessKeyId: 'synthetic-new-key', accessKeySecret: 'synthetic-new-secret', imageImportBucket: 'synthetic-import-bucket' }));
    const workspace = await prisma.cloudWorkspace.findUniqueOrThrow({ where: { id: scope.cloudWorkspaceId } });
    const active = await prisma.cloudAccountContext.findUniqueOrThrow({ where: { id: workspace.activeCloudAccountContextId! } });
    expect(active).toMatchObject({ regionId: 'cn-hangzhou', bucketStatus: 'unavailable', lastVerifiedAt: null });
    expect(active.lastError).not.toContain('synthetic-private-text');
    await expect(cloud.getCredentials(active.id, { requireImageImportBucket: true })).rejects.toThrow('Bucket 不可用');
  });
});
