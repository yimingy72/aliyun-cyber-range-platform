import { PrismaService } from '../src/database/prisma.service';
import { PrismaAdminRepository } from '../src/database/prisma-admin.repository';
import { runInCloudWorkspace, runInSystemCloudWorkspaceScope } from '../src/auth/cloud-workspace-scope';

const url = process.env.WORKSPACE_TEST_DATABASE_URL;
const databaseDescribe = url ? describe : describe.skip;
const a = { cloudWorkspaceId: 'workspace-fixture-a', provider: 'alibaba_cloud' as const, accountUid: '100001' };
const b = { cloudWorkspaceId: 'workspace-fixture-b', provider: 'tencent_cloud' as const, accountUid: '100001' };

databaseDescribe('Prisma cloud workspace isolation', () => {
  const prisma = new PrismaService({ datasources: { db: { url } } });
  const repository = new PrismaAdminRepository(prisma);

  async function cleanup() {
    await runInSystemCloudWorkspaceScope(async () => {
      const where = { cloudWorkspaceId: { in: [a.cloudWorkspaceId, b.cloudWorkspaceId] } };
      await prisma.operationConfirmation.deleteMany({ where });
      await prisma.idempotentOperation.deleteMany({ where });
      await prisma.operationAuditEvent.deleteMany({ where });
      await prisma.platformImageAssetTag.deleteMany({ where });
      await prisma.platformImageTag.deleteMany({ where });
      await prisma.billingLineItem.deleteMany({ where });
      await prisma.billingAnomaly.deleteMany({ where });
      await prisma.billingLedgerResource.deleteMany({ where });
      await prisma.provisionJobStepLog.deleteMany({ where });
      await prisma.rangeInstance.updateMany({ where, data: { lastJobId: null } });
      await prisma.provisionJob.deleteMany({ where });
      await prisma.rangeInstance.deleteMany({ where });
      await prisma.singleInstanceBatch.deleteMany({ where });
      await prisma.rangeTemplate.updateMany({ where, data: { currentDraftVersionId: null, currentPublishedVersionId: null } });
      await prisma.rangeTemplateVersion.deleteMany({ where });
      await prisma.rangeTemplate.deleteMany({ where });
      await prisma.platformImageAsset.deleteMany({ where });
      await prisma.imageCatalogItem.deleteMany({ where });
      await prisma.cloudImageSnapshot.deleteMany({ where });
      await prisma.platformUser.deleteMany({ where: { OR: [where, { id: 'workspace-fixture-root' }] } });
      await prisma.cloudWorkspace.deleteMany({ where: { id: { in: [a.cloudWorkspaceId, b.cloudWorkspaceId] } } });
    });
  }

  beforeAll(async () => { await cleanup(); });
  beforeEach(async () => {
    await cleanup();
    await runInSystemCloudWorkspaceScope(async () => {
      await prisma.cloudWorkspace.createMany({ data: [a, b].map(({ cloudWorkspaceId, ...identity }) => ({ id: cloudWorkspaceId, ...identity, displayName: cloudWorkspaceId })) });
      await repository.createPlatformUser({ id: 'workspace-fixture-root', username: 'fixture-root', loginUsername: 'fixture-root', passwordHash: 'fixture-only', role: 'admin', isPlatformManager: true });
    });
    await runInCloudWorkspace(a, () => repository.createPlatformUser({ id: 'workspace-fixture-user-a', username: 'alice', loginUsername: 'alice-a', passwordHash: 'fixture-only', role: 'user' }));
    await runInCloudWorkspace(b, () => repository.createPlatformUser({ id: 'workspace-fixture-user-b', username: 'alice', loginUsername: 'alice-b', passwordHash: 'fixture-only', role: 'user' }));
  });
  afterAll(async () => { await cleanup(); await prisma.$disconnect(); });

  it('isolates user list, username, ID, mutations and passwords', async () => {
    await runInCloudWorkspace(a, async () => {
      expect((await repository.listPlatformUsers()).map(row => row.id)).toEqual(['workspace-fixture-user-a']);
      expect(await repository.getPlatformUserByUsername('alice')).toMatchObject({ id: 'workspace-fixture-user-a', loginUsername: 'alice-a' });
      expect(await repository.getPlatformUserById('workspace-fixture-user-b')).toBeNull();
      expect(await repository.getPlatformUserById('workspace-fixture-root')).toMatchObject({ isPlatformManager: true, cloudWorkspaceId: null });
      await expect(repository.updatePlatformUser('workspace-fixture-user-b', { passwordHash: 'wrong-workspace' })).rejects.toThrow();
      expect(await prisma.platformUser.updateMany({ where: { id: 'workspace-fixture-user-b' }, data: { status: 'disabled' } })).toEqual({ count: 0 });
    });
    expect(await runInCloudWorkspace(b, () => repository.getPlatformUserByUsername('alice'))).toMatchObject({ passwordHash: 'fixture-only', status: 'active' });
  });

  it('isolates same-name templates, draft versions, nested reads, ID updates and deletes', async () => {
    const create = () => repository.createRangeTemplate({ name: 'Same template', slug: 'same-template', version: '1', modulePathOrRef: './fixture', topologySpec: { vpcCidr: '10.0.0.0/16', networkZones: [], hosts: [], publicEntry: { hostKey: '', protocols: [] } } });
    const first = await runInCloudWorkspace(a, create);
    const second = await runInCloudWorkspace(b, create);
    expect(first.id).not.toBe(second.id);
    await runInCloudWorkspace(a, async () => {
      expect((await repository.listRangeTemplates()).map(row => row.id)).toEqual([first.id]);
      expect((await repository.getRangeTemplateById(first.id))?.versions).toHaveLength(1);
      expect(await repository.getRangeTemplateVersionById(second.currentDraftVersionId!)).toBeNull();
      expect(await repository.getRangeTemplateById(second.id)).toBeNull();
      expect(await prisma.rangeTemplate.deleteMany({ where: { id: second.id } })).toEqual({ count: 0 });
    });
    expect(await runInCloudWorkspace(b, () => repository.getRangeTemplateById(second.id))).toMatchObject({ cloudProvider: 'tencent_cloud' });
  });

  it('scopes public image collection and tag definitions even when physical IDs are identical', async () => {
    const collect = async (identity: typeof a | typeof b) => {
      await repository.upsertImageSnapshots({ provider: identity.provider, regionId: 'same-region', scope: 'public', accountUid: null, snapshots: [{ imageId: 'same-public-image', sourceImageName: 'fixture', lastSyncedAt: new Date() }] });
      const [snapshot] = await repository.listImageSnapshots({});
      const image = await repository.collectPlatformImageAsset({ snapshotId: snapshot.id, displayName: 'fixture', ownerUserId: 'workspace-fixture-root', visibility: 'platform' });
      const tag = await repository.createPlatformImageTag({ name: 'Linux', normalizedName: 'linux', createdByUserId: 'workspace-fixture-root' });
      await repository.replacePlatformImageAssetTags(image.id, [tag.id]);
      return { image, tag };
    };
    const first = await runInCloudWorkspace(a, () => collect(a));
    const second = await runInCloudWorkspace(b, () => collect(b));
    expect(first.image.id).not.toBe(second.image.id);
    await runInCloudWorkspace(a, async () => {
      expect((await repository.listPlatformImageAssets({})).map(row => row.id)).toEqual([first.image.id]);
      expect((await repository.getPlatformImageAssetById(first.image.id))?.tags.map(tag => tag.id)).toEqual([first.tag.id]);
      expect(await repository.getPlatformImageAssetById(second.image.id)).toBeNull();
      await expect(repository.replacePlatformImageAssetTags(first.image.id, [second.tag.id])).rejects.toThrow();
      expect((await repository.getPlatformImageAssetById(first.image.id))?.tags.map(tag => tag.id)).toEqual([first.tag.id]);
    });
  });

  it('rejects direct foreign workspace references and upsert attempts instead of mutating another account', async () => {
    const foreign = await runInCloudWorkspace(b, () => repository.createRangeInstance({ name: 'other-account' }));
    await runInCloudWorkspace(a, async () => {
      await expect(repository.createRangeInstance({ name: 'wrong-owner', ownerUserId: 'workspace-fixture-user-b' })).rejects.toThrow();
      await expect(prisma.rangeInstance.upsert({ where: { id: foreign.id }, create: { id: foreign.id, name: 'hijack' }, update: { status: 'destroyed' } })).rejects.toThrow();
      expect(await prisma.rangeInstance.deleteMany({ where: { id: foreign.id } })).toEqual({ count: 0 });
    });
    expect(await runInCloudWorkspace(b, () => repository.getRangeInstanceById(foreign.id))).toMatchObject({ name: 'other-account', status: 'draft' });
  });

  it('keeps bills and idempotency separate while transactions retain the selected workspace', async () => {
    const make = async (identity: typeof a | typeof b) => {
      const ledger = await repository.createBillingLedgerResource({ cloudProvider: identity.provider, cloudAccountUid: identity.accountUid, regionId: 'same-region', cloudResourceId: 'same-resource-id', cloudResourceType: 'ecs', billingScope: 'platform', billingStartAt: new Date() });
      await repository.replaceBillingDay({ cloudProvider: identity.provider, cloudAccountUid: identity.accountUid, billingDate: '2026-10-09', anomalies: [], lineItems: [{ cloudProvider: identity.provider, cloudAccountUid: identity.accountUid, syncBatchId: 'same-sync', sourceFingerprint: 'same-fingerprint', billCycle: '2026-10', billingDate: '2026-10-09', productCode: 'ecs', billItem: 'CPU', cloudResourceId: ledger.cloudResourceId, cloudResourceType: 'ecs', pretaxAmount: 1, currency: 'CNY', billingScope: 'platform', matchedLedgerId: ledger.id }] });
      return repository.createIdempotentOperation({ actorUserId: 'workspace-fixture-root', toolName: 'launch', idempotencyKey: 'same-key', argumentsHash: 'same-hash', operationId: `op-${identity.cloudWorkspaceId}` });
    };
    await runInCloudWorkspace(a, () => make(a));
    await runInCloudWorkspace(b, () => make(b));
    await runInCloudWorkspace(a, () => repository.replaceBillingDay({ cloudAccountUid: a.accountUid, billingDate: '2026-10-09', lineItems: [], anomalies: [] }));
    expect(await runInCloudWorkspace(a, () => repository.listBillingLineItems())).toEqual([]);
    expect(await runInCloudWorkspace(b, () => repository.listBillingLineItems())).toHaveLength(1);
    expect(await runInCloudWorkspace(a, () => repository.getIdempotentOperationByOperationId(`op-${b.cloudWorkspaceId}`))).toBeNull();
    await runInCloudWorkspace(a, async () => {
      await prisma.$transaction(async tx => {
        expect(await tx.platformUser.findUnique({ where: { id: 'workspace-fixture-user-b' } })).toBeNull();
        expect(await tx.platformUser.count()).toBe(1);
      });
    });
  });

  it('fails closed without production scope and keeps legacy history read-only', async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try { await expect(prisma.rangeInstance.findMany()).rejects.toThrow('scope is required'); }
    finally { process.env.NODE_ENV = previous; }
    await runInCloudWorkspace({ cloudWorkspaceId: 'legacy-unbound', provider: 'alibaba_cloud', accountUid: null, isReadOnly: true }, async () => {
      await expect(repository.createRangeInstance({ name: 'forbidden' })).rejects.toThrow('read-only');
      const audit = await repository.appendOperationAuditEvent({ operationId: 'fixture-legacy-audit', requestId: 'request', actorUserId: 'workspace-fixture-root', source: 'web', toolName: 'lookup', phase: 'requested' });
      expect(audit.cloudWorkspaceId).toBe('legacy-unbound');
      await runInSystemCloudWorkspaceScope(() => prisma.operationAuditEvent.delete({ where: { id: audit.id } }));
    });
  });
});
