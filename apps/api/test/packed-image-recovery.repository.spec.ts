import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { PrismaService } from '../src/database/prisma.service';
import { PrismaAdminRepository } from '../src/database/prisma-admin.repository';
import { PackedImagesService } from '../src/admin/packed-images.service';
import { CloudAccountContextsService } from '../src/admin/cloud-account-contexts.service';
import { buildBillingTags } from '../src/admin/billing-tagging';
import { encryptPackedImageAssetConfig } from '../src/admin/packed-image-asset-config';
import { encryptPlatformImageDefaultPassword, decryptPlatformImageDefaultPassword } from '../src/admin/platform-image-password';

const url = process.env.PACKED_IMAGE_TEST_DATABASE_URL;
if (url && (new URL(url).hostname !== 'packed-image-test-postgres' || new URL(url).pathname !== '/packed_image_test')) throw new Error('Packed recovery tests require isolated packed_image_test');
const describeDb = url ? describe : describe.skip;
const originalCloudKey = process.env.CLOUD_CREDENTIALS_ENCRYPTION_KEY;
const originalImageKey = process.env.PLATFORM_IMAGE_SECRET_KEY;

describeDb('Packed image migration and process restart in PostgreSQL', () => {
  let prisma: PrismaService;
  let repository: PrismaAdminRepository;
  const source = { id: 'packed-proof', cloudProvider: 'alibaba_cloud' as const, cloudWorkspaceId: 'legacy-unbound', cloudAccountContextId: 'ctx-frozen',
    cloudAccountUid: '100001', regionId: 'cn-hangzhou', ownerUserId: 'packed-owner', sourceRangeInstanceId: 'packed-range', sourceHostKey: 'host',
    sourceInstanceId: 'i-source', sourceDiskIds: ['d-source'] };
  const config = () => ({ displayName: 'original display', defaultHostName: 'original-host', defaultPassword: encryptPlatformImageDefaultPassword('Synthetic-Password-123!'), description: 'original description' });
  const baseline = (identity: typeof source | Record<string, unknown>) => ({ ...identity,
    kind: identity.cloudProvider === 'tencent_cloud' ? 'native_tencent_pack_snapshot_baseline_v1' : 'native_alibaba_pack_snapshot_baseline_v1' });

  beforeAll(async () => {
    process.env.CLOUD_CREDENTIALS_ENCRYPTION_KEY = '12'.repeat(32);
    process.env.PLATFORM_IMAGE_SECRET_KEY = 'synthetic-image-key';
    prisma = new PrismaService({ datasources: { db: { url } } });
    await prisma.$connect(); repository = new PrismaAdminRepository(prisma);
  });
  beforeEach(async () => {
    await prisma.packedImageArtifact.deleteMany(); await prisma.billingLedgerResource.deleteMany(); await prisma.platformImageAsset.deleteMany();
    await prisma.cloudImageSnapshot.deleteMany(); await prisma.rangeInstance.deleteMany(); await prisma.platformUser.deleteMany();
  });
  afterAll(async () => {
    await prisma?.$disconnect();
    if (originalCloudKey === undefined) delete process.env.CLOUD_CREDENTIALS_ENCRYPTION_KEY; else process.env.CLOUD_CREDENTIALS_ENCRYPTION_KEY = originalCloudKey;
    if (originalImageKey === undefined) delete process.env.PLATFORM_IMAGE_SECRET_KEY; else process.env.PLATFORM_IMAGE_SECRET_KEY = originalImageKey;
  });

  it.each(['alibaba_cloud', 'tencent_cloud'] as const)('accepts only %s matching kind and frozen identity, then protects baseline updates', async cloudProvider => {
    const identity = { ...source, cloudProvider };
    const proof = baseline(identity);
    const artifact = await repository.createPackedImageArtifact({ ...identity, sourceSnapshotBaseline: proof });
    expect(artifact.sourceSnapshotBaseline).toEqual(proof);
    await repository.updatePackedImageArtifact(artifact.id, { imageId: cloudProvider === 'tencent_cloud' ? 'img-frozen' : 'm-frozen', status: 'creating' });
    for (const data of [{ sourceSnapshotBaseline: { ...proof, observedAt: 'replaced' } }, { sourceSnapshotBaseline: null as never },
      { ownerUserId: 'foreign' }, { cloudAccountUid: 'foreign' }, { regionId: 'foreign' }, { cloudAccountContextId: 'foreign' },
      { sourceRangeInstanceId: 'foreign' }, { sourceHostKey: 'foreign' }, { sourceInstanceId: 'foreign' }, { sourceDiskIds: ['d-foreign'] }]) {
      // Prisma's JSON null has a separate sentinel; use SQL for a true NULL attempt below.
      if ('sourceSnapshotBaseline' in data && data.sourceSnapshotBaseline === null) continue;
      await expect(prisma.packedImageArtifact.update({ where: { id: artifact.id }, data })).rejects.toThrow();
    }
    await expect(prisma.$executeRaw`UPDATE "PackedImageArtifact" SET "sourceSnapshotBaseline" = NULL WHERE id = ${artifact.id}`).rejects.toThrow();
    expect((await repository.getPackedImageArtifact(artifact.id))?.sourceSnapshotBaseline).toEqual(proof);
    const otherKind = cloudProvider === 'tencent_cloud' ? 'native_alibaba_pack_snapshot_baseline_v1' : 'native_tencent_pack_snapshot_baseline_v1';
    await expect(repository.createPackedImageArtifact({ ...identity, id: 'wrong-kind', sourceSnapshotBaseline: { ...proof, id: 'wrong-kind', kind: otherKind } })).rejects.toThrow();
    const insertSource = { ...identity, id: 'wrong-identity' };
    for (const key of ['id', 'cloudProvider', 'cloudWorkspaceId', 'cloudAccountContextId', 'cloudAccountUid', 'regionId', 'ownerUserId', 'sourceRangeInstanceId', 'sourceHostKey', 'sourceInstanceId']) {
      await expect(repository.createPackedImageArtifact({ ...insertSource, sourceSnapshotBaseline: { ...baseline(insertSource), [key]: 'foreign' } })).rejects.toThrow();
    }
    await expect(repository.createPackedImageArtifact({ ...insertSource, sourceSnapshotBaseline: { ...baseline(insertSource), sourceDiskIds: ['d-foreign'] } })).rejects.toThrow();
    await expect(prisma.packedImageArtifact.create({ data: { ...insertSource, sourceSnapshotBaseline: baseline(insertSource), status: 'creating' } })).rejects.toThrow();
    await expect(prisma.packedImageArtifact.create({ data: { ...insertSource, sourceSnapshotBaseline: baseline(insertSource), imageId: 'm-already-submitted' } })).rejects.toThrow();
  });

  it('freezes encrypted configuration and its complete identity even without a historical snapshot baseline', async () => {
    const ciphertext = encryptPackedImageAssetConfig(source, config());
    const artifact = await repository.createPackedImageArtifact({ ...source, assetConfigCiphertext: ciphertext });
    await repository.updatePackedImageArtifact(artifact.id, { imageId: 'm-known', status: 'creating', lastPolledAt: new Date() });
    await expect(prisma.packedImageArtifact.update({ where: { id: artifact.id }, data: { assetConfigCiphertext: ciphertext + '-replacement' } })).rejects.toThrow();
    await expect(prisma.packedImageArtifact.update({ where: { id: artifact.id }, data: { assetConfigCiphertext: null } })).rejects.toThrow();
    for (const key of ['id', 'cloudWorkspaceId', 'cloudAccountContextId', 'cloudAccountUid', 'regionId', 'ownerUserId', 'sourceRangeInstanceId', 'sourceHostKey', 'sourceInstanceId']) {
      await expect(prisma.packedImageArtifact.update({ where: { id: artifact.id }, data: { [key]: 'foreign' } })).rejects.toThrow();
    }
    await expect(prisma.packedImageArtifact.update({ where: { id: artifact.id }, data: { cloudProvider: 'tencent_cloud' } })).rejects.toThrow();
    await expect(prisma.packedImageArtifact.update({ where: { id: artifact.id }, data: { sourceDiskIds: ['d-foreign'] } })).rejects.toThrow();
    const legacy = await repository.createPackedImageArtifact({ ...source, id: 'legacy-null' });
    await expect(prisma.packedImageArtifact.update({ where: { id: legacy.id }, data: { assetConfigCiphertext: ciphertext } })).rejects.toThrow();
    await expect(prisma.packedImageArtifact.update({ where: { id: legacy.id }, data: { sourceSnapshotBaseline: baseline({ ...source, id: legacy.id }) } })).rejects.toThrow();
    expect((await repository.getPackedImageArtifact(legacy.id))?.assetConfigCiphertext).toBeNull();
    await expect(prisma.packedImageArtifact.create({ data: { ...source, id: 'plaintext-config', assetConfigCiphertext: 'not-encrypted' } })).rejects.toThrow();
    await expect(prisma.packedImageArtifact.create({ data: { ...source, id: 'late-config', assetConfigCiphertext: ciphertext, status: 'creating' } })).rejects.toThrow();
    expect((await repository.getPackedImageArtifact(artifact.id))?.assetConfigCiphertext).toBe(ciphertext);
  });

  it('inserts the submission lease atomically and fences an expired submitter after a worker takes over', async () => {
    const expiresAt = new Date(Date.now() + 60_000);
    const artifact = await repository.createPackedImageArtifact({ ...source, leaseToken: 'api-submitter', leaseExpiresAt: expiresAt });
    expect(await prisma.packedImageArtifact.findUnique({ where: { id: artifact.id } })).toMatchObject({ leaseToken: 'api-submitter', leaseExpiresAt: expiresAt });
    const worker = new PrismaAdminRepository(prisma);
    expect(await worker.claimPackedImageArtifact(artifact.id, 'racing-worker', new Date(Date.now() + 60_000))).toBe(false);
    await repository.withPackedImageArtifactClaim(artifact.id, 'api-submitter', repo => repo.updatePackedImageArtifact(artifact.id, { imageId: 'm-known', status: 'creating' }));
    await prisma.packedImageArtifact.update({ where: { id: artifact.id }, data: { leaseExpiresAt: new Date(0) } });
    expect(await worker.claimPackedImageArtifact(artifact.id, 'recovery-worker', new Date(Date.now() + 60_000))).toBe(true);
    await expect(repository.withPackedImageArtifactClaim(artifact.id, 'api-submitter', repo => repo.updatePackedImageArtifact(artifact.id, { status: 'available' }))).rejects.toThrow();
    expect((await repository.getPackedImageArtifact(artifact.id))?.status).toBe('creating');
  });

  it('recovers one asset after a real API process exit following durable imageId without a second CreateImage', async () => {
    await repository.createPlatformUser({ id: source.ownerUserId, username: source.ownerUserId, passwordHash: 'synthetic', role: 'user' });
    const range = await repository.createRangeInstance({ name: 'process-restart-source', createdBy: source.ownerUserId, ownerUserId: source.ownerUserId,
      status: 'running', resourceSummary: { mode: 'opentofu', hostIds: { host: source.sourceInstanceId }, executionContext: {
        cloudAccountContextId: source.cloudAccountContextId, cloudAccountUid: source.cloudAccountUid, regionId: source.regionId,
      } } as never });
    const compiled = resolve(__dirname, '../dist/apps/api/src');
    const script = `
      const { PrismaService } = require(${JSON.stringify(compiled + '/database/prisma.service.js')});
      const { PrismaAdminRepository } = require(${JSON.stringify(compiled + '/database/prisma-admin.repository.js')});
      const { PackedImagesService } = require(${JSON.stringify(compiled + '/admin/packed-images.service.js')});
      const { RangeInstanceNodeActionsService } = require(${JSON.stringify(compiled + '/admin/range-instance-node-actions.service.js')});
      const prisma = new PrismaService(); const repo = new PrismaAdminRepository(prisma);
      const account = { provider: 'alibaba_cloud', cloudAccountContextId: 'ctx-frozen', accountUid: '100001', accountUidResolved: true,
        defaultRegion: 'cn-hangzhou', defaultZoneId: 'cn-hangzhou-h', accessKeyId: 'synthetic-ak', accessKeySecret: 'synthetic-sk', imageImportBucket: '' };
      global.fetch = async input => {
        const action = new URL(String(input)).searchParams.get('Action'); let body = { RequestId: 'synthetic-request' };
        if (action === 'DescribeDisks') body = { ...body, TotalCount: 1, Disks: { Disk: [{ DiskId: 'd-source' }] } };
        else if (action === 'DescribeAutoSnapshotPolicyEx') body = { ...body, TotalCount: 0, AutoSnapshotPolicies: { AutoSnapshotPolicy: [] } };
        else if (action === 'DescribeSnapshots') body = { ...body, TotalCount: 0, Snapshots: { Snapshot: [] } };
        else if (action === 'CreateImage') { process.stdout.write('CREATE_IMAGE\\n'); body.ImageId = 'm-process-packed'; }
        else throw new Error('Unexpected cloud action: ' + action);
        return new Response(JSON.stringify(body), { status: 200 });
      };
      const persist = repo.withPackedImageArtifactClaim.bind(repo);
      repo.withPackedImageArtifactClaim = async (id, token, work) => {
        const row = await repo.getPackedImageArtifact(id);
        if (row.imageId && !row.sourceSnapshotId) { process.stdout.write('EXIT_AFTER_IMAGE_ID\\n'); process.exit(73); }
        return persist(id, token, work);
      };
      const packed = new PackedImagesService(repo, {});
      const nodes = new RangeInstanceNodeActionsService(repo, { getAccountContextById: async () => account }, packed);
      nodes.run(${JSON.stringify(range.id)}, 'host', 'pack-image', { displayName: 'original display', defaultHostName: 'original-host',
        defaultPassword: 'Synthetic-Password-123!', description: 'original description' }, { id: 'packed-owner', role: 'user' })
        .then(() => process.exit(1)).catch(error => { process.stderr.write(error.message); process.exit(2); });
    `;
    const exited = spawnSync(process.execPath, ['-e', script], { env: { ...process.env, DATABASE_URL: url!, NODE_ENV: 'test' }, encoding: 'utf8', timeout: 25_000 });
    expect({ status: exited.status, stderr: exited.stderr, error: exited.error?.message }).toMatchObject({ status: 73, stderr: '' });
    expect(exited.stdout.match(/CREATE_IMAGE/g)).toHaveLength(1);
    const [artifact] = await repository.listPackedImageArtifacts();
    expect(artifact).toMatchObject({ imageId: 'm-process-packed', status: 'creating', sourceSnapshotId: null, platformImageAssetId: null });
    expect(await repository.listPlatformImageAssets()).toHaveLength(0);
    expect(artifact.sourceSnapshotBaseline).toMatchObject({ kind: 'native_alibaba_pack_snapshot_baseline_v1' });
    const row = await prisma.packedImageArtifact.findUniqueOrThrow({ where: { id: artifact.id } });
    expect(row.leaseToken).toBeTruthy(); expect(row.assetConfigCiphertext).toBeTruthy();
    expect(row.assetConfigCiphertext).not.toContain('Synthetic-Password-123!');
    await prisma.packedImageArtifact.update({ where: { id: artifact.id }, data: { leaseExpiresAt: new Date(0) } });
    const tags = buildBillingTags({ billingScope: 'user', ownerUserId: artifact.ownerUserId, platformPackedImageArtifactId: artifact.id, billingStartAt: artifact.createdAt });
    const cloudCalls: string[] = [];
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const action = new URL(String(input)).searchParams.get('Action')!; cloudCalls.push(action);
      let body: any = { RequestId: 'synthetic-request' };
      if (action === 'DescribeImages') body = { ...body, TotalCount: 1, Images: { Image: [{ ImageId: artifact.imageId, ImageName: 'changed cloud name', Status: 'Available',
        Tags: { Tag: Object.entries(tags).map(([TagKey, TagValue]) => ({ TagKey, TagValue })) }, DiskDeviceMappings: { DiskDeviceMapping: [{ SnapshotId: 's-process-packed' }] } }] } };
      else if (action === 'DescribeSnapshots') body = { ...body, TotalCount: 1, Snapshots: { Snapshot: [{ SnapshotId: 's-process-packed', SourceDiskId: 'd-source',
        RegionId: source.regionId, CreationTime: artifact.createdAt.toISOString(), Usage: 'image', Tags: { Tag: [] } }] } };
      else if (action !== 'TagResources') throw new Error('Recovery attempted an unexpected mutation: ' + action);
      return new Response(JSON.stringify(body), { status: 200 });
    });
    const restarted = new PrismaService({ datasources: { db: { url } } });
    try {
      const repo = new PrismaAdminRepository(restarted);
      const worker = new PackedImagesService(repo, { getCredentials: async () => ({ id: source.cloudAccountContextId, provider: source.cloudProvider, accountUid: source.cloudAccountUid,
        regionId: source.regionId, zoneId: 'cn-hangzhou-h', accessKeyId: 'rotated-ak', accessKeySecret: 'rotated-sk', imageImportBucket: '', status: 'ready' }) } as unknown as CloudAccountContextsService);
      const failedAssetWrite = jest.spyOn(PrismaAdminRepository.prototype, 'collectPlatformImageAsset').mockRejectedValueOnce(new Error('synthetic asset transaction failure'));
      await worker.refresh(artifact.id);
      failedAssetWrite.mockRestore();
      expect(await repo.getPackedImageArtifact(artifact.id)).toMatchObject({ status: 'creating', platformImageAssetId: null });
      expect(await repo.listImageSnapshots({ imageId: artifact.imageId! })).toHaveLength(0);
      expect(await repo.listPlatformImageAssets()).toHaveLength(0);
      await Promise.all([worker.refresh(artifact.id), worker.refresh(artifact.id)]);
      await worker.refreshPending();
      const assets = await repo.listPlatformImageAssets();
      expect(assets).toHaveLength(1);
      expect(assets[0]).toMatchObject({ displayName: 'original display', defaultHostName: 'original-host', description: 'original description', ownerUserId: source.ownerUserId,
        imageId: artifact.imageId, visibility: 'private', enabled: true });
      expect(decryptPlatformImageDefaultPassword(assets[0].defaultPassword)).toBe('Synthetic-Password-123!');
      expect(await repo.getPackedImageArtifact(artifact.id)).toMatchObject({ status: 'available', platformImageAssetId: assets[0].id });
      const ledger = await repo.listBillingLedgerResources(); expect(ledger).toHaveLength(2);
      expect(ledger.every(resource => resource.platformImageAssetId === assets[0].id && resource.ownerUserId === source.ownerUserId)).toBe(true);
      expect(cloudCalls).not.toContain('CreateImage'); expect(cloudCalls.some(action => action.startsWith('Delete'))).toBe(false);
    } finally { fetchMock.mockRestore(); await restarted.$disconnect(); }
  }, 40_000);
});
