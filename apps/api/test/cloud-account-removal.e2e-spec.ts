import { CloudWorkspacesService } from '../src/admin/cloud-workspaces.service';
import { CloudAccountContextsService } from '../src/admin/cloud-account-contexts.service';
import { SystemConfigService } from '../src/admin/system-config.service';
import { PrismaService } from '../src/database/prisma.service';
import { runInCloudWorkspace, runInSystemCloudWorkspaceScope } from '../src/auth/cloud-workspace-scope';

const url = process.env.WORKSPACE_TEST_DATABASE_URL;
const isolated = url ? describe : describe.skip;
const manager = { id: 'removal-manager', username: 'admin', role: 'admin' as const, isPlatformManager: true, cloudWorkspaceId: null };
const scope = { cloudWorkspaceId: 'removal-a', provider: 'alibaba_cloud' as const, accountUid: '111', isPlatformManager: true, actorUserId: manager.id };
const target = 'removal-b';

isolated('cloud account removal (isolated PostgreSQL)', () => {
  let db: PrismaService;
  let spaces: CloudWorkspacesService;
  const previousKey = process.env.CLOUD_CREDENTIALS_ENCRYPTION_KEY;
  beforeAll(() => {
    process.env.CLOUD_CREDENTIALS_ENCRYPTION_KEY = 'ab'.repeat(32);
    db = new PrismaService({ datasources: { db: { url: url! } } }); spaces = new CloudWorkspacesService(db);
  });
  afterAll(async () => { await db.$disconnect(); if (previousKey === undefined) delete process.env.CLOUD_CREDENTIALS_ENCRYPTION_KEY; else process.env.CLOUD_CREDENTIALS_ENCRYPTION_KEY = previousKey; });
  beforeEach(async () => runInSystemCloudWorkspaceScope(async () => {
    await db.$executeRawUnsafe('TRUNCATE TABLE "CloudWorkspace" CASCADE');
    await db.systemCloudConfig.deleteMany();
    await db.cloudWorkspace.createMany({ data: [
      { id: scope.cloudWorkspaceId, provider: scope.provider, accountUid: scope.accountUid, displayName: 'Account A', activeCloudAccountContextId: 'removal-context-a' },
      { id: target, provider: 'tencent_cloud', accountUid: '222', displayName: 'Account B', activeCloudAccountContextId: 'removal-context-b' },
      { id: 'legacy-unbound', provider: 'alibaba_cloud', displayName: 'History', isReadOnly: true },
    ] });
    await db.cloudAccountContext.createMany({ data: [
      { id: 'removal-context-a', cloudWorkspaceId: scope.cloudWorkspaceId, provider: 'alibaba_cloud', accountUid: '111', displayName: 'Ali', regionId: 'cn-hangzhou', zoneId: 'cn-hangzhou-h', accessKeyId: 'fixture-a-key', accessKeySecret: 'fixture-a-secret', imageImportBucket: '', status: 'ready', isActive: true },
      { id: 'removal-context-b', cloudWorkspaceId: target, provider: 'tencent_cloud', accountUid: '222', displayName: 'TC', regionId: 'ap-nanjing', zoneId: 'ap-nanjing-1', accessKeyId: 'fixture-b-key', accessKeySecret: 'fixture-b-secret', imageImportBucket: '', status: 'ready' },
    ] });
    await db.platformUser.createMany({ data: [
      { ...manager, loginUsername: manager.id, passwordHash: 'fixture-hash', selectedCloudWorkspaceId: scope.cloudWorkspaceId },
      { id: 'removal-other-manager', username: 'other', loginUsername: 'other', isPlatformManager: true, passwordHash: 'fixture-hash', selectedCloudWorkspaceId: target },
      { id: 'removal-member', username: 'member', loginUsername: 'member', cloudWorkspaceId: target, passwordHash: 'fixture-hash' },
    ] });
    await db.rangeTemplate.create({ data: { id: 'removal-template', cloudWorkspaceId: target, name: 'Saved template', slug: 'saved', version: '1', cloudProvider: 'tencent_cloud', modulePathOrRef: 'fixture', variableSchema: {}, outputSchema: {} } });
    await db.rangeInstance.create({ data: { id: 'removal-history', cloudWorkspaceId: target, name: 'Closed instance', cloudProvider: 'tencent_cloud', status: 'destroyed' } });
    await db.billingLedgerResource.create({ data: { id: 'removal-ledger', cloudWorkspaceId: target, cloudProvider: 'tencent_cloud', cloudAccountUid: '222', cloudResourceId: 'fixture-closed-id', cloudResourceType: 'ecs', regionId: 'ap-nanjing', billingScope: 'platform', billingStartAt: new Date(), releasedAt: new Date() } });
    await db.billingLineItem.create({ data: { id: 'removal-bill', cloudWorkspaceId: target, cloudProvider: 'tencent_cloud', cloudAccountUid: '222', syncBatchId: 'fixture-sync', sourceFingerprint: 'fixture-bill', billCycle: '2026-10', billingDate: new Date(), productCode: 'cvm', billItem: 'compute', cloudResourceId: 'fixture-closed-id', cloudResourceType: 'ecs', pretaxAmount: '0.12', currency: 'CNY', billingScope: 'platform' } });
  }));
  const remove = () => runInCloudWorkspace(scope, () => spaces.remove(manager, target));
  const assertKeysRetained = async () => expect(await db.cloudAccountContext.findUniqueOrThrow({ where: { id: 'removal-context-b' } })).toMatchObject({ accessKeyId: 'fixture-b-key', accessKeySecret: 'fixture-b-secret', status: 'ready' });

  it('unbinds without any cloud request, retains business/billing/users, and clears stale selections and matching legacy credentials', async () => {
    const cloud = jest.spyOn(globalThis, 'fetch');
    try {
      await db.systemCloudConfig.create({ data: { id: 'default', provider: 'tencent_cloud', defaultRegion: 'ap-nanjing', defaultZoneId: 'ap-nanjing-1', accessKeyId: 'fixture-b-key', accessKeySecret: 'fixture-b-secret' } });
      expect(await remove()).toMatchObject({ id: target, retainedData: true }); expect(cloud).not.toHaveBeenCalled();
      expect(await db.cloudAccountContext.findUniqueOrThrow({ where: { id: 'removal-context-b' } })).toMatchObject({ accessKeyId: '', accessKeySecret: '', status: 'disabled', isActive: false });
      expect(await db.cloudAccountContext.findUniqueOrThrow({ where: { id: 'removal-context-a' } })).toMatchObject({ accessKeyId: 'fixture-a-key', status: 'ready' });
      expect(await db.systemCloudConfig.findUniqueOrThrow({ where: { id: 'default' } })).toMatchObject({ accessKeyId: '', accessKeySecret: '' });
      expect(await db.platformUser.findUniqueOrThrow({ where: { id: 'removal-other-manager' } })).toMatchObject({ selectedCloudWorkspaceId: null });
      expect(await db.platformUser.findUniqueOrThrow({ where: { id: 'removal-member' } })).toMatchObject({ cloudWorkspaceId: target });
      expect(await db.rangeTemplate.count({ where: { cloudWorkspaceId: target } })).toBe(1);
      expect(await db.rangeInstance.count({ where: { cloudWorkspaceId: target } })).toBe(1);
      expect(await db.billingLineItem.count({ where: { cloudWorkspaceId: target } })).toBe(1);
      expect(await db.billingLedgerResource.count({ where: { cloudWorkspaceId: target } })).toBe(1);
      expect((await spaces.list(manager)).map(item => item.id)).not.toContain(target);
      await expect(spaces.resolve(manager, target)).rejects.toThrow('绑定已删除');
      await expect(spaces.resolve({ ...manager, isPlatformManager: false, cloudWorkspaceId: target }, undefined)).rejects.toThrow('绑定已删除');
      const accounts = new CloudAccountContextsService(db);
      await expect(accounts.getCredentials('removal-context-b')).rejects.toThrow('绑定已删除');
      await expect(new SystemConfigService(db, accounts).runInWorkspace(target, async () => 1)).rejects.toThrow('绑定已删除');
    } finally { cloud.mockRestore(); }
  });
  it.each(['pending_create', 'creating', 'running', 'create_failed', 'pending_destroy', 'destroying', 'destroy_failed'] as const)('blocks unresolved instance state %s', async status => {
    await db.rangeInstance.update({ where: { id: 'removal-history' }, data: { status } });
    await expect(remove()).rejects.toThrow('未回收资源'); await assertKeysRetained();
  });
  it('blocks a supposedly destroyed instance with retained inventory', async () => {
    await db.rangeInstance.update({ where: { id: 'removal-history' }, data: { resourceSummary: { inventory: { nativeId: 'fixture' } } } });
    await expect(remove()).rejects.toThrow('未回收资源');
  });
  it.each(['pending', 'running'] as const)('blocks a %s job even for a destroyed instance', async status => {
    await db.provisionJob.create({ data: { cloudWorkspaceId: target, rangeInstanceId: 'removal-history', jobType: 'refresh_status', triggeredBy: manager.id, status } });
    await expect(remove()).rejects.toThrow('未回收资源');
  });
  it('blocks a released instance with unreleased billable snapshots', async () => {
    await db.billingLedgerResource.update({ where: { id: 'removal-ledger' }, data: { releasedAt: null, cloudResourceType: 'snapshot' } });
    await expect(remove()).rejects.toThrow('未回收资源'); await assertKeysRetained();
  });
  it('blocks pending and unknown image artifacts even when no billed resource ID is known yet', async () => {
    await db.packedImageArtifact.create({ data: { cloudWorkspaceId: target, cloudProvider: 'tencent_cloud', cloudAccountContextId: 'removal-context-b', cloudAccountUid: '222', regionId: 'ap-nanjing', ownerUserId: 'removal-member', sourceRangeInstanceId: 'removal-history', sourceHostKey: 'host', sourceInstanceId: 'fixture-closed-id', sourceDiskIds: [] } });
    await expect(remove()).rejects.toThrow('未回收资源');
    await db.packedImageArtifact.updateMany({ data: { status: 'unexpected-new-state' } });
    await expect(remove()).rejects.toThrow('未回收资源');
  });
  it('blocks a managed network profile which may have non-billable leaked infrastructure', async () => {
    await db.singleInstanceNetworkProfile.create({ data: { cloudWorkspaceId: target, provider: 'tencent_cloud', cloudAccountUid: '222', cloudAccountContextId: 'removal-context-b', regionId: 'ap-nanjing', zoneId: 'ap-nanjing-1', managedByPlatform: true, vpcId: 'vpc-fixture', vpcCidr: '10.1.0.0/16', vswitchIds: [], vswitchCidrs: [], securityGroupId: 'sg-fixture', securityGroupName: 'fixture' } });
    await expect(remove()).rejects.toThrow('未回收资源');
  });
  it('blocks a managed bucket with an incomplete deletion proof', async () => {
    await db.cloudImageImportBucket.create({ data: { cloudWorkspaceId: target, cloudProvider: 'tencent_cloud', cloudAccountContextId: 'removal-context-b', cloudAccountUid: '222', appId: 'fixture-app', regionId: 'ap-nanjing', bucketName: 'fixture-bucket', creationNonce: 'fixture-nonce', creatorUserId: 'removal-member', ownershipMarkerKey: 'fixture-marker', status: 'deleted' } });
    await expect(remove()).rejects.toThrow('未回收资源');
  });
  it('blocks terminal imports with unclean temporary objects', async () => {
    await db.imageImportJob.create({ data: { cloudWorkspaceId: target, cloudProvider: 'tencent_cloud', cloudAccountContextId: 'removal-context-b', cloudAccountUid: '222', regionId: 'ap-nanjing', ownerUserId: 'removal-member', displayName: 'Failed import', osType: 'windows', architecture: 'x86_64', bootMode: 'BIOS', imageFormat: 'QCOW2', systemDiskSize: 50, sourceFileName: 'fixture.qcow2', sourceContentType: 'application/octet-stream', sourceSizeBytes: '100', objectKey: 'fixture-object', uploadExpiresAt: new Date(), status: 'failed' } });
    await expect(remove()).rejects.toThrow('未回收资源');
    await db.imageImportJob.updateMany({ where: { cloudWorkspaceId: target }, data: { temporaryObjectDeletedAt: new Date(), snapshotCleanupCompletedAt: new Date(), submissionRejected: true } });
    await expect(remove()).resolves.toMatchObject({ id: target, retainedData: true });
  });
  it.each([false, true])('blocks incomplete failed import cloud proof (image known: %s)', async imageKnown => {
    await db.imageImportJob.create({ data: { cloudWorkspaceId: target, cloudProvider: 'tencent_cloud', cloudAccountContextId: 'removal-context-b', cloudAccountUid: '222', regionId: 'ap-nanjing', ownerUserId: 'removal-member', displayName: 'Unknown failed import', osType: 'windows', architecture: 'x86_64', bootMode: 'BIOS', imageFormat: 'QCOW2', systemDiskSize: 50, sourceFileName: 'fixture.qcow2', sourceContentType: 'application/octet-stream', sourceSizeBytes: '100', objectKey: 'unknown-fixture-object', uploadExpiresAt: new Date(), status: 'failed', temporaryObjectDeletedAt: new Date(),
      imageId: imageKnown ? 'unknown-image' : null, cloudImageDeletedAt: imageKnown ? new Date() : null, backingSnapshotIds: [], submissionRejected: false } });
    await expect(remove()).rejects.toThrow('未回收资源'); await assertKeysRetained();
  });
  it('rejects current explicit request scope and selected preference independently', async () => {
    await expect(runInCloudWorkspace({ ...scope, cloudWorkspaceId: target, provider: 'tencent_cloud', accountUid: '222' }, () => spaces.remove(manager, target))).rejects.toThrow('先切换');
    await db.platformUser.update({ where: { id: manager.id }, data: { selectedCloudWorkspaceId: target } });
    await expect(remove()).rejects.toThrow('先切换');
  });
  it('denies non-manager, readonly history, and nonexistent IDs', async () => {
    await expect(spaces.remove({ ...manager, isPlatformManager: false }, target)).rejects.toThrow('仅平台超管');
    await expect(spaces.remove(manager, 'legacy-unbound')).rejects.toThrow('历史工作空间');
    await expect(spaces.remove(manager, 'missing')).rejects.toThrow('不存在');
  });
  it('prevents stale resource admissions after unbinding and allows late official bills to retain ownership', async () => {
    await remove();
    await expect(db.rangeInstance.create({ data: { cloudWorkspaceId: target, cloudProvider: 'tencent_cloud', name: 'Stale launch' } })).rejects.toThrow('binding was deleted');
    await expect(db.provisionJob.create({ data: { cloudWorkspaceId: target, rangeInstanceId: 'removal-history', jobType: 'create', triggeredBy: manager.id } })).rejects.toThrow('binding was deleted');
    await expect(db.rangeInstance.update({ where: { id: 'removal-history' }, data: { status: 'pending_create' } })).rejects.toThrow('binding was deleted');
    await db.billingLineItem.create({ data: { cloudWorkspaceId: target, cloudProvider: 'tencent_cloud', cloudAccountUid: '222', syncBatchId: 'late', sourceFingerprint: 'late-official', billCycle: '2026-10', billingDate: new Date(), productCode: 'cvm', billItem: 'compute', cloudResourceId: 'fixture-closed-id', cloudResourceType: 'ecs', pretaxAmount: '0.01', currency: 'CNY', billingScope: 'platform', matchedLedgerId: 'removal-ledger' } });
    expect(await db.billingLineItem.count({ where: { cloudWorkspaceId: target } })).toBe(2);
  });
  it('fails closed while resource admission holds a transaction, then retains the admitted resource', async () => {
    let admitted!: () => void; const admission = new Promise<void>(resolve => { admitted = resolve; });
    let release!: () => void; const hold = new Promise<void>(resolve => { release = resolve; });
    const transaction = db.$transaction(async tx => {
      await tx.rangeInstance.create({ data: { id: 'in-flight', cloudWorkspaceId: target, cloudProvider: 'tencent_cloud', name: 'Admission', status: 'pending_create' } });
      admitted(); await hold;
    }, { timeout: 10_000 });
    await admission;
    try { await expect(remove()).rejects.toThrow('正在变化'); }
    finally { release(); await transaction; }
    await expect(remove()).rejects.toThrow('未回收资源'); await assertKeysRetained();
  });
  it('rebinds the same provider/UID/region into the original namespace and context identity', async () => {
    await remove();
    const cloud = jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({ Response: { RequestId: 'identity', AccountId: '222' } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ Response: { RequestId: 'zones', TotalCount: 1, ZoneSet: [{ Zone: 'ap-nanjing-1', ZoneState: 'AVAILABLE' }] } })));
    try {
      const restored = await new CloudAccountContextsService(db).saveAccountBinding({ provider: 'tencent_cloud', regionId: 'ap-nanjing', zoneId: 'ap-nanjing-1', accessKeyId: 'fixture-new-id', accessKeySecret: 'fixture-new-secret' });
      expect(restored).toMatchObject({ id: 'removal-context-b', cloudWorkspaceId: target });
      expect((await spaces.switch(manager, target)).id).toBe(target);
      expect(await db.rangeTemplate.count({ where: { cloudWorkspaceId: target } })).toBe(1);
      expect(await db.billingLineItem.count({ where: { cloudWorkspaceId: target } })).toBe(1);
      expect(await db.cloudWorkspace.findUniqueOrThrow({ where: { id: target } })).toMatchObject({ archivedAt: null });
    } finally { cloud.mockRestore(); }
  });
  it.each([true, false])('rolls back stale binding after deletion (explicit edit: %s)', async explicitEdit => {
    const accounts = new CloudAccountContextsService(db);
    const original = (accounts as any).resolveBindingWorkspace.bind(accounts);
    const resolved = jest.spyOn(accounts as any, 'resolveBindingWorkspace');
    let paused!: () => void; const pause = new Promise<void>(resolve => { paused = resolve; });
    let resume!: () => void; const gate = new Promise<void>(resolve => { resume = resolve; });
    resolved.mockImplementation(async (...args: unknown[]) => {
      const workspace = await original(...args); paused(); await gate; return workspace;
    });
    const cloud = jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({ Response: { RequestId: 'identity', AccountId: '222' } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ Response: { RequestId: 'zones', TotalCount: 1, ZoneSet: [{ Zone: 'ap-nanjing-1', ZoneState: 'AVAILABLE' }] } })));
    const save = accounts.saveAccountBinding({ ...(explicitEdit ? { cloudWorkspaceId: target } : {}), provider: 'tencent_cloud', regionId: 'ap-nanjing', zoneId: 'ap-nanjing-1', accessKeyId: 'stale-edit-id', accessKeySecret: 'stale-edit-secret' }).catch(error => error);
    try {
      await pause; await remove(); resume();
      expect(await save).toMatchObject({ message: expect.stringContaining('绑定已删除或变化') });
      expect(await db.cloudWorkspace.findUniqueOrThrow({ where: { id: target } })).toMatchObject({ archivedAt: expect.any(Date), activeCloudAccountContextId: null });
      expect(await db.cloudAccountContext.findUniqueOrThrow({ where: { id: 'removal-context-b' } })).toMatchObject({ accessKeyId: '', accessKeySecret: '', status: 'disabled' });
    } finally { resume(); cloud.mockRestore(); resolved.mockRestore(); }
  });
});
