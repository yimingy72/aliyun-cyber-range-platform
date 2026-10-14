import { PackedImagesService } from '../src/admin/packed-images.service';
import { RangeInstanceNodeActionsService } from '../src/admin/range-instance-node-actions.service';
import { CloudAccountContextsService, type CloudAccountContextCredentials } from '../src/admin/cloud-account-contexts.service';
import { SystemConfigService } from '../src/admin/system-config.service';
import { encryptPackedImageAssetConfig, readPackedImageAssetConfig } from '../src/admin/packed-image-asset-config';
import { decryptPlatformImageDefaultPassword, encryptPlatformImageDefaultPassword } from '../src/admin/platform-image-password';
import { buildBillingTags } from '../src/admin/billing-tagging';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';

const context: CloudAccountContextCredentials = { id: 'ctx-owned', provider: 'alibaba_cloud', accountUid: '123456', regionId: 'cn-hangzhou', zoneId: 'cn-hangzhou-h',
  accessKeyId: 'synthetic-ak', accessKeySecret: 'synthetic-sk', imageImportBucket: '', status: 'ready' };
const source = { cloudAccountContextId: context.id, cloudAccountUid: context.accountUid, regionId: context.regionId, ownerUserId: 'owner',
  sourceRangeInstanceId: 'range-source', sourceHostKey: 'host', sourceInstanceId: 'i-source' };
const payload = { displayName: 'original display', defaultHostName: 'original-host', defaultPassword: 'Synthetic-Password-123!', description: 'original description' };
const identity = { ...source, id: 'artifact-source', cloudProvider: context.provider, cloudWorkspaceId: 'legacy-unbound', sourceDiskIds: ['d-source'] };

describe('Packed image submission and restart recovery', () => {
  let repository: ReturnType<typeof createMemoryAdminRepository>;
  let credentials: jest.Mock;
  let service: PackedImagesService;
  let nodes: RangeInstanceNodeActionsService;
  let rangeId: string;
  let cloudImage: any;
  let calls: string[];
  let loseCreateResponse: boolean;
  const originalCloudKey = process.env.CLOUD_CREDENTIALS_ENCRYPTION_KEY;
  const originalImageKey = process.env.PLATFORM_IMAGE_SECRET_KEY;

  beforeEach(async () => {
    process.env.CLOUD_CREDENTIALS_ENCRYPTION_KEY = '12'.repeat(32);
    process.env.PLATFORM_IMAGE_SECRET_KEY = 'synthetic-image-key';
    repository = createMemoryAdminRepository();
    calls = []; cloudImage = null; loseCreateResponse = false;
    credentials = jest.fn().mockResolvedValue(context);
    service = new PackedImagesService(repository, { getCredentials: credentials } as unknown as CloudAccountContextsService);
    const account = { provider: context.provider, accountUid: context.accountUid, cloudAccountContextId: context.id, accountUidResolved: true,
      defaultRegion: context.regionId, defaultZoneId: context.zoneId, accessKeyId: context.accessKeyId, accessKeySecret: context.accessKeySecret, imageImportBucket: '' };
    nodes = new RangeInstanceNodeActionsService(repository, { getAccountContextById: async () => account } as unknown as SystemConfigService, service);
    rangeId = (await repository.createRangeInstance({ name: 'source', createdBy: 'owner', ownerUserId: 'owner', status: 'running', resourceSummary: {
      mode: 'opentofu', hostIds: { host: 'i-source' }, executionContext: { cloudAccountContextId: context.id, cloudAccountUid: context.accountUid, regionId: context.regionId },
    } as never })).id;
    jest.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const query = new URL(String(input)).searchParams;
      const action = query.get('Action')!; calls.push(action);
      let body: any = { RequestId: 'synthetic-request' };
      if (action === 'DescribeDisks') body = { ...body, TotalCount: 1, Disks: { Disk: [{ DiskId: 'd-source' }] } };
      if (action === 'DescribeAutoSnapshotPolicyEx') body = { ...body, TotalCount: 0, AutoSnapshotPolicies: { AutoSnapshotPolicy: [] } };
      if (action === 'CreateImage') {
        const artifact = (await repository.listPackedImageArtifacts())[0];
        expect(artifact.assetConfigCiphertext).toBeTruthy();
        expect(artifact.assetConfigCiphertext).not.toContain(payload.defaultPassword);
        cloudImage = { ImageId: 'm-packed', ImageName: 'cloud display changed', Status: 'Available',
          Tags: { Tag: Object.entries(buildBillingTags({ billingScope: 'user', ownerUserId: artifact.ownerUserId, platformPackedImageArtifactId: artifact.id,
            billingStartAt: artifact.createdAt })).map(([TagKey, TagValue]) => ({ TagKey, TagValue })) },
          DiskDeviceMappings: { DiskDeviceMapping: [{ SnapshotId: 's-packed' }] } };
        if (loseCreateResponse) throw new Error('synthetic connection lost after submission');
        body = { ...body, ImageId: cloudImage.ImageId };
      }
      if (action === 'DescribeImages') body = { ...body, TotalCount: cloudImage ? 1 : 0, Images: { Image: cloudImage ? [cloudImage] : [] } };
      if (action === 'DescribeSnapshots') {
        const artifact = (await repository.listPackedImageArtifacts())[0];
        const rows = query.has('SnapshotIds') ? [{ SnapshotId: 's-packed', SourceDiskId: 'd-source', RegionId: context.regionId,
          CreationTime: artifact.createdAt.toISOString(), Usage: 'image', Tags: { Tag: [] } }] : [];
        body = { ...body, TotalCount: rows.length, Snapshots: { Snapshot: rows } };
      }
      return new Response(JSON.stringify(body), { status: 200 });
    });
  });
  afterEach(() => {
    jest.restoreAllMocks();
    if (originalCloudKey === undefined) delete process.env.CLOUD_CREDENTIALS_ENCRYPTION_KEY; else process.env.CLOUD_CREDENTIALS_ENCRYPTION_KEY = originalCloudKey;
    if (originalImageKey === undefined) delete process.env.PLATFORM_IMAGE_SECRET_KEY; else process.env.PLATFORM_IMAGE_SECRET_KEY = originalImageKey;
  });

  it('holds the submission lease at the exact INSERT boundary before a worker can claim or poll', async () => {
    const insert = repository.createPackedImageArtifact.bind(repository);
    jest.spyOn(repository, 'createPackedImageArtifact').mockImplementation(async input => {
      const artifact = await insert(input);
      expect(await repository.claimPackedImageArtifact(artifact.id, 'racing-worker', new Date(Date.now() + 60_000))).toBe(false);
      await service.refresh(artifact.id);
      expect(credentials).not.toHaveBeenCalled();
      return artifact;
    });
    const artifact = await service.begin({ ...source, sourceRangeInstanceId: rangeId }, context);
    expect(await repository.renewPackedImageArtifactClaim(artifact.id, artifact.submissionToken, new Date(Date.now() + 60_000))).toBe(true);
    await service.endSubmission(artifact.id, artifact.submissionToken);
    expect(await repository.claimPackedImageArtifact(artifact.id, 'after-submission', new Date(Date.now() + 60_000))).toBe(true);
  });

  it('restores exactly one private asset after imageId persistence, using original defaults despite source and AK changes', async () => {
    const claim = repository.withPackedImageArtifactClaim.bind(repository);
    let crash = true;
    jest.spyOn(repository, 'withPackedImageArtifactClaim').mockImplementation(async (id, token, work) => {
      const row = await repository.getPackedImageArtifact(id);
      if (crash && row?.imageId && !row.sourceSnapshotId) { crash = false; throw new Error('synthetic exit before asset transaction'); }
      return claim(id, token, work);
    });
    await expect(nodes.run(rangeId, 'host', 'pack-image', payload, { id: 'owner', role: 'user' })).rejects.toThrow('打包结果未完整确认');
    const artifact = (await repository.listPackedImageArtifacts())[0];
    expect(artifact).toMatchObject({ imageId: 'm-packed', status: 'creating', platformImageAssetId: null, sourceSnapshotId: null });
    expect(await repository.listPlatformImageAssets()).toHaveLength(0);
    await repository.updateRangeInstance(rangeId, { name: 'source changed since submission' });
    credentials.mockResolvedValue({ ...context, accessKeyId: 'rotated-ak', accessKeySecret: 'rotated-sk' });
    const restarted = new PackedImagesService(repository, { getCredentials: credentials } as unknown as CloudAccountContextsService);
    await Promise.all([restarted.refresh(artifact.id), restarted.refresh(artifact.id)]);
    await restarted.refreshPending();
    const [asset] = await repository.listPlatformImageAssets();
    expect(await repository.listPlatformImageAssets()).toHaveLength(1);
    expect(asset).toMatchObject({ displayName: payload.displayName, defaultHostName: payload.defaultHostName, description: payload.description,
      ownerUserId: 'owner', visibility: 'private', imageId: 'm-packed', enabled: true });
    expect(decryptPlatformImageDefaultPassword(asset.defaultPassword)).toBe(payload.defaultPassword);
    expect(await repository.getPackedImageArtifact(artifact.id)).toMatchObject({ status: 'available', platformImageAssetId: asset.id, sourceSnapshotId: asset.sourceSnapshotId });
    const ledger = await repository.listBillingLedgerResources();
    expect(ledger).toHaveLength(2);
    expect(ledger.every(row => row.platformImageAssetId === asset.id && row.ownerUserId === 'owner' && row.cloudAccountUid === context.accountUid)).toBe(true);
    expect(calls.filter(action => action === 'CreateImage')).toHaveLength(1);
    expect(calls.some(action => action.startsWith('Delete'))).toBe(false);
  });

  it('adopts an unknown submission only by its original tags and never resubmits CreateImage', async () => {
    loseCreateResponse = true;
    await expect(nodes.run(rangeId, 'host', 'pack-image', payload, { id: 'owner', role: 'user' })).rejects.toThrow('打包结果未完整确认');
    const artifact = (await repository.listPackedImageArtifacts())[0];
    expect(artifact.imageId).toBeNull();
    await expect(service.begin({ ...source, sourceRangeInstanceId: rangeId }, context)).rejects.toThrow('尚未确认');
    await new PackedImagesService(repository, { getCredentials: credentials } as unknown as CloudAccountContextsService).refresh(artifact.id);
    expect(await repository.getPackedImageArtifact(artifact.id)).toMatchObject({ imageId: 'm-packed', status: 'available' });
    expect(calls.filter(action => action === 'CreateImage')).toHaveLength(1);
  });

  it('keeps legacy assets without original defaults private and disabled across Creating and Available polls', async () => {
    const artifact = await service.begin({ ...source, sourceRangeInstanceId: rangeId }, context);
    const tags = buildBillingTags({ billingScope: 'user', ownerUserId: 'owner', platformPackedImageArtifactId: artifact.id, billingStartAt: artifact.createdAt });
    cloudImage = { ImageId: 'm-legacy', ImageName: 'legacy name', Status: 'Creating', Tags: { Tag: Object.entries(tags).map(([TagKey, TagValue]) => ({ TagKey, TagValue })) },
      DiskDeviceMappings: { DiskDeviceMapping: [{ SnapshotId: 's-packed' }] } };
    await service.endSubmission(artifact.id, artifact.submissionToken);
    await service.refresh(artifact.id);
    cloudImage.Status = 'Available';
    await service.refresh(artifact.id);
    expect(await repository.listPlatformImageAssets()).toHaveLength(1);
    expect((await repository.listPlatformImageAssets())[0]).toMatchObject({ displayName: 'legacy name', ownerUserId: 'owner', visibility: 'private',
      enabled: false, defaultPassword: null, defaultHostName: null, description: null });
    expect(await repository.getPackedImageArtifact(artifact.id)).toMatchObject({ status: 'available', errorMessage: expect.stringContaining('默认密码留空') });
    expect(calls).not.toContain('CreateImage');
  });

  it('does not expose submission leases or encrypted configuration in the node action response', async () => {
    const result = await nodes.run(rangeId, 'host', 'pack-image', payload, { id: 'owner', role: 'user' });
    expect(JSON.stringify(result)).not.toMatch(/assetConfigCiphertext|submissionToken|leaseToken|leaseExpiresAt/);
    expect(result).toMatchObject({ status: 'accepted', defaultHostName: payload.defaultHostName, defaultPassword: payload.defaultPassword });
  });

  it('refuses to take over an existing asset owned by another user', async () => {
    await nodes.run(rangeId, 'host', 'pack-image', payload, { id: 'owner', role: 'user' });
    const [artifact] = await repository.listPackedImageArtifacts();
    const [asset] = await repository.listPlatformImageAssets();
    await repository.collectPlatformImageAsset({ snapshotId: asset.sourceSnapshotId!, displayName: 'foreign asset', ownerUserId: 'foreign', visibility: 'private' });
    const collect = jest.spyOn(repository, 'collectPlatformImageAsset');
    await service.refresh(artifact.id);
    expect(collect).not.toHaveBeenCalled();
    expect(await repository.getPackedImageArtifact(artifact.id)).toMatchObject({ status: 'creating', ownerUserId: 'owner' });
    expect(await repository.getPlatformImageAssetById(asset.id)).toMatchObject({ displayName: 'foreign asset', ownerUserId: 'foreign' });
  });

  it('fails before creating a cloud image or durable artifact when the configuration key is missing', async () => {
    delete process.env.CLOUD_CREDENTIALS_ENCRYPTION_KEY;
    await expect(nodes.run(rangeId, 'host', 'pack-image', payload, { id: 'owner', role: 'user' })).rejects.toThrow('ENCRYPTION_KEY');
    expect(await repository.listPackedImageArtifacts()).toHaveLength(0);
    expect(calls).not.toContain('CreateImage');
  });

  it('authenticates every frozen identity field and ciphertext, independent of current credentials', () => {
    const config = { ...payload, defaultPassword: encryptPlatformImageDefaultPassword(payload.defaultPassword) };
    const ciphertext = encryptPackedImageAssetConfig(identity, config);
    expect(ciphertext).not.toContain(payload.defaultPassword);
    expect(readPackedImageAssetConfig(identity, ciphertext)).toEqual(config);
    for (const key of ['id', 'cloudProvider', 'cloudWorkspaceId', 'cloudAccountContextId', 'cloudAccountUid', 'regionId', 'ownerUserId', 'sourceRangeInstanceId', 'sourceHostKey', 'sourceInstanceId']) {
      expect(() => readPackedImageAssetConfig({ ...identity, [key]: 'foreign' }, ciphertext)).toThrow('无法验证或解密');
    }
    expect(() => readPackedImageAssetConfig({ ...identity, sourceDiskIds: ['d-foreign'] }, ciphertext)).toThrow('无法验证或解密');
    const parts = ciphertext.split('.');
    parts[2] = (parts[2][0] === 'A' ? 'B' : 'A') + parts[2].slice(1);
    expect(() => readPackedImageAssetConfig(identity, parts.join('.'))).toThrow('无法验证或解密');
    process.env.CLOUD_CREDENTIALS_ENCRYPTION_KEY = '34'.repeat(32);
    expect(() => readPackedImageAssetConfig(identity, ciphertext)).toThrow('无法验证或解密');
    expect(readPackedImageAssetConfig(identity, null)).toBeNull();
  });
});
