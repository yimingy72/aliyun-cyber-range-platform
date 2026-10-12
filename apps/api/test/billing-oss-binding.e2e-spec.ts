import { runInCloudWorkspace, runInSystemCloudWorkspaceScope } from '../src/auth/cloud-workspace-scope';
import { PrismaAdminRepository } from '../src/database/prisma-admin.repository';
import { PrismaService } from '../src/database/prisma.service';

const url = process.env.OSS_BINDING_TEST_DATABASE_URL;
if (url) {
  const parsed = new URL(url);
  if (parsed.hostname !== 'oss-binding-test-postgres' || parsed.pathname !== '/oss_binding_test') {
    throw new Error('OSS binding CAS verification requires the isolated oss_binding_test database');
  }
}
const describeDb = url ? describe : describe.skip;
describeDb('OSS binding terminal CAS in isolated PostgreSQL', () => {
  const prisma = new PrismaService({ datasources: { db: { url } } });
  const repository = new PrismaAdminRepository(prisma);
  const scope = { cloudWorkspaceId: 'oss-binding-cas-space', provider: 'alibaba_cloud' as const, accountUid: '100001' };
  beforeAll(async () => {
    await prisma.$connect();
    await runInSystemCloudWorkspaceScope(() => prisma.cloudWorkspace.create({ data: { id: scope.cloudWorkspaceId,
      provider: scope.provider, accountUid: scope.accountUid, displayName: 'isolated OSS binding test' } }));
  });
  afterAll(async () => { await prisma.$disconnect(); });
  const fixture = (bucketName: string) => runInCloudWorkspace(scope, () => repository.createBillingLedgerResource({
    cloudProvider: scope.provider, cloudAccountUid: scope.accountUid, regionId: 'cn-hangzhou', cloudResourceId: bucketName,
    cloudResourceType: 'oss_bucket', billingScope: 'platform', billingStartAt: new Date('2026-09-30T16:00:00Z'),
    tagsSnapshot: { unrelated: { retained: true }, aliyunOssDedicatedBilling: { version: 1, dedicated: true,
      effectiveStartAt: '2026-09-30T16:00:00.000Z', effectiveEndAt: null, bucketName, officialRequestId: 'fixture-request' } },
  }));

  it('only one simultaneous close succeeds; another workspace and stale request cannot move the terminal time', async () => {
    const ledger = await fixture('test-race-bucket');
    const firstEnd = new Date(), secondEnd = new Date(firstEnd.getTime() + 1);
    const outcomes = await Promise.all([firstEnd, secondEnd].map(end => runInCloudWorkspace(scope, () => repository.endOssBillingBinding(ledger, end))));
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    const record = await runInCloudWorkspace(scope, async () => (await repository.listBillingLedgerResources()).find(row => row.id === ledger.id)!);
    const expectedEnd = (outcomes[0] ? firstEnd : secondEnd).toISOString();
    expect(record.tagsSnapshot).toEqual({ ...ledger.tagsSnapshot,
      aliyunOssDedicatedBilling: { ...(ledger.tagsSnapshot.aliyunOssDedicatedBilling as object), effectiveEndAt: expectedEnd } });
    expect(record.releasedAt).toBeNull();
    expect(await runInCloudWorkspace(scope, () => repository.endOssBillingBinding(ledger, new Date()))).toBe(false);
    expect(await runInCloudWorkspace({ ...scope, cloudWorkspaceId: 'foreign' }, () => repository.endOssBillingBinding(ledger, new Date()))).toBe(false);
    expect(await runInCloudWorkspace(scope, () => repository.findBillingLedgerResource({ cloudProvider: scope.provider,
      regionId: ledger.regionId, cloudResourceId: ledger.cloudResourceId, cloudResourceType: 'oss_bucket' }))).toEqual(record);
  });

  it('rejects stale evidence after another writer changed the proof and leaves all identity and lifecycle fields unchanged', async () => {
    const ledger = await fixture('test-evidence-bucket');
    const changed = await runInCloudWorkspace(scope, () => repository.updateBillingLedgerResource(ledger.id, {
      tagsSnapshot: { ...ledger.tagsSnapshot, unrelated: { retained: true, changed: true } },
    }));
    expect(await runInCloudWorkspace(scope, () => repository.endOssBillingBinding(ledger, new Date()))).toBe(false);
    const rows = await runInCloudWorkspace(scope, () => repository.listBillingLedgerResources());
    expect(rows.find(row => row.id === ledger.id)).toEqual(changed);
  });
});
