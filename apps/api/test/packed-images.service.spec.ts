import { PackedImagesService } from '../src/admin/packed-images.service';
import { type CloudAccountContextCredentials, CloudAccountContextsService } from '../src/admin/cloud-account-contexts.service';
import { type SessionUserProfile } from '../src/admin/admin-user-auth';
import { buildBillingTags } from '../src/admin/billing-tagging';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';

const context: CloudAccountContextCredentials = { id: 'ctx-owned', provider: 'alibaba_cloud', accountUid: '123456', regionId: 'cn-hangzhou', zoneId: 'cn-hangzhou-h', accessKeyId: 'mock-ak', accessKeySecret: 'mock-sk', imageImportBucket: '', status: 'ready' };
const owner = { id: 'owner', role: 'user' } as SessionUserProfile;

describe('Owned packed-image lifecycle', () => {
  let repository: ReturnType<typeof createMemoryAdminRepository>;
  let service: PackedImagesService;
  let artifactId: string;
  let sourceId: string;
  let assetId: string;
  let image: any;
  let snapshots: Map<string, any>;
  let calls: URLSearchParams[];
  let failSnapshot: string | null;
  let contradictorySnapshot: string | null;
  let sharedSnapshot: string | null;
  let credentials: jest.Mock;

  beforeEach(async () => {
    repository = createMemoryAdminRepository();
    credentials = jest.fn().mockResolvedValue(context);
    service = new PackedImagesService(repository, { getCredentials: credentials } as unknown as CloudAccountContextsService);
    calls = []; failSnapshot = null; contradictorySnapshot = null; sharedSnapshot = null; snapshots = new Map(); image = null;
    jest.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const p = new URL(String(input)).searchParams; calls.push(p);
      const action = p.get('Action');
      let body: any = { RequestId: 'mock-request' };
      if (action === 'DescribeDisks') body = { ...body, TotalCount: 2, Disks: { Disk: [{ DiskId: 'd-system' }, { DiskId: 'd-data' }] } };
      if (action === 'DescribeImages') {
        expect(p.get('Status')).toBe('ALL');
        const sid = p.get('SnapshotId');
        const items = sid ? (image && image.DiskDeviceMappings.DiskDeviceMapping.some((i: any) => i.SnapshotId === sid) ? [image] : []) : (image ? [image] : []);
        if (sid && sid === sharedSnapshot) items.push({ ImageId: 'm-shared-external', Status: 'Available' });
        body = { ...body, TotalCount: items.length, Images: { Image: items } };
      }
      if (action === 'DescribeSnapshots') {
        const sid = JSON.parse(p.get('SnapshotIds')!)[0];
        const items = snapshots.has(sid) ? [snapshots.get(sid)] : [];
        body = { ...body, TotalCount: items.length, Snapshots: { Snapshot: sid === contradictorySnapshot ? [] : items } };
      }
      if (action === 'TagResources') {
        expect(p.get('ResourceType')).toBe('snapshot');
        const snapshot = snapshots.get(p.get('ResourceId.1')!);
        snapshot.Tags = { Tag: [] };
        for (let n = 1; p.has(`Tag.${n}.Key`); n++) snapshot.Tags.Tag.push({ TagKey: p.get(`Tag.${n}.Key`), TagValue: p.get(`Tag.${n}.Value`) });
      }
      if (action === 'DeleteImage') { expect(p.get('Force')).toBe('false'); image = null; }
      if (action === 'DeleteSnapshot') {
        expect(p.get('Force')).toBe('false');
        const sid = p.get('SnapshotId')!;
        if (sid === failSnapshot) return new Response(JSON.stringify({ Code: 'Mock.DeleteFailure' }), { status: 200 });
        snapshots.delete(sid);
      }
      return new Response(JSON.stringify(body), { status: 200 });
    });
    const artifact = await service.begin({ cloudAccountContextId: context.id, cloudAccountUid: context.accountUid, regionId: context.regionId, ownerUserId: owner.id, sourceRangeInstanceId: 'range-new', sourceHostKey: 'ecs-new', sourceInstanceId: 'i-new' }, context);
    artifactId = artifact.id;
    const tags = buildBillingTags({ billingScope: 'user', ownerUserId: owner.id, platformPackedImageArtifactId: artifact.id, billingStartAt: artifact.createdAt });
    image = { ImageId: 'm-owned-new', ImageName: 'new-packed-image', Status: 'Creating', Tags: { Tag: Object.entries(tags).map(([TagKey, TagValue]) => ({ TagKey, TagValue })) }, DiskDeviceMappings: { DiskDeviceMapping: [{ SnapshotId: 's-system' }, { SnapshotId: 's-data' }] } };
    for (const [sid, disk] of [['s-system', 'd-system'], ['s-data', 'd-data']]) snapshots.set(sid, { SnapshotId: sid, SourceDiskId: disk, RegionId: context.regionId, CreationTime: artifact.createdAt.toISOString(), Usage: 'image', Tags: { Tag: [] } });
    await repository.upsertImageSnapshots({ provider: context.provider, accountUid: context.accountUid, regionId: context.regionId, scope: 'custom', snapshots: [{ imageId: image.ImageId, sourceImageName: image.ImageName, status: 'Creating', isAvailable: false, lastSyncedAt: new Date() }] });
    sourceId = (await repository.listImageSnapshots({ imageId: image.ImageId }))[0].id;
    assetId = (await repository.collectPlatformImageAsset({ snapshotId: sourceId, displayName: 'packed', ownerUserId: owner.id, visibility: 'private' })).id;
    await repository.setPlatformImageAssetEnabled(assetId, false);
    await service.updateClaimed(artifact.id, artifact.submissionToken, { imageId: image.ImageId, sourceSnapshotId: sourceId, platformImageAssetId: assetId, status: 'creating' });
    await service.endSubmission(artifact.id, artifact.submissionToken);
    await service.upsertLedger((await repository.getPackedImageArtifact(artifact.id))!, image.ImageId, 'image');
  });
  afterEach(() => jest.restoreAllMocks());
  const deletes = () => calls.filter(p => p.get('Action')?.startsWith('Delete')).map(p => p.get('Action'));
  async function ready() { image.Status = 'Available'; await service.refresh(artifactId); expect({ artifact: await repository.getPackedImageArtifact(artifactId), actions: calls.map(p => p.get('Action')) }).toEqual(expect.objectContaining({ artifact: expect.objectContaining({ status: 'available' }) })); }

  it('waits for every source disk, then advances availability and persists exact snapshot billing ownership', async () => {
    image.DiskDeviceMappings.DiskDeviceMapping = [{ SnapshotId: 's-system' }];
    await service.refresh(artifactId);
    expect((await repository.getPackedImageArtifact(artifactId))!.backingSnapshotIds).toEqual([]);
    expect((await repository.getPlatformImageAssetById(assetId))!.enabled).toBe(false);
    image.DiskDeviceMappings.DiskDeviceMapping.push({ SnapshotId: 's-data' });
    await ready();
    expect((await repository.getPlatformImageAssetById(assetId))!.enabled).toBe(true);
    expect((await repository.getImageSnapshotById(sourceId))!.isAvailable).toBe(true);
    const ledger = await repository.listBillingLedgerResources();
    expect(ledger.filter(row => row.cloudResourceType === 'snapshot')).toHaveLength(2);
    expect(ledger.every(row => row.ownerUserId === owner.id && row.cloudAccountUid === context.accountUid)).toBe(true);
  });
  it('inherits the exact source ECS batch and provisioning job while retaining snapshot billing after source release', async () => {
    const sourceLedger = await repository.createBillingLedgerResource({ cloudAccountUid: context.accountUid, regionId: context.regionId, cloudResourceId: 'i-new', cloudResourceType: 'ecs', billingScope: 'user', ownerUserId: owner.id, rangeInstanceId: 'range-new', singleInstanceBatchId: 'batch-owned', sourceProvisionJobId: 'job-successful-source', billingStartAt: new Date(), tagsSnapshot: {} });
    await ready();
    const packedLedger = (await repository.listBillingLedgerResources()).filter(row => ['image', 'snapshot'].includes(row.cloudResourceType));
    expect(packedLedger).toHaveLength(3);
    expect(packedLedger.every(row => row.singleInstanceBatchId === 'batch-owned' && row.sourceProvisionJobId === 'job-successful-source')).toBe(true);
    await repository.updateBillingLedgerResource(sourceLedger.id, { releasedAt: new Date() });
    expect((await repository.listBillingLedgerResources()).filter(row => row.cloudResourceType === 'snapshot').every(row => row.releasedAt === null)).toBe(true);
    expect(await service.cleanup(sourceId, owner)).toMatchObject({ removed: true });
  });

  it('recollects only the catalog link without changing existing billing ownership, source or release evidence', async () => {
    await ready();
    const releasedAt = new Date('2026-09-01');
    for (const ledger of await repository.listBillingLedgerResources()) {
      await repository.updateBillingLedgerResource(ledger.id, { releasedAt, sourceProvisionJobId: 'original-job' });
    }
    await repository.deletePlatformImageAsset(assetId);
    const before = structuredClone(await repository.listBillingLedgerResources());
    const createLedger = jest.spyOn(repository, 'createBillingLedgerResource');
    const requests = calls.length;

    const asset = await service.restoreAsset(artifactId, sourceId, 'recollected');

    expect(asset.ownerUserId).toBe(owner.id);
    expect(calls).toHaveLength(requests);
    expect(createLedger).not.toHaveBeenCalled();
    const after = await repository.listBillingLedgerResources();
    expect(after.map(ledger => ({ ...ledger, updatedAt: undefined }))).toEqual(before.map(ledger => ({ ...ledger, platformImageAssetId: asset.id, updatedAt: undefined })));
  });

  it('fully reclaims only the exact owned image and snapshots with Force=false, preserving its audit record', async () => {
    await ready();
    const result: any = await service.cleanup(sourceId, owner);
    expect(result).toMatchObject({ removed: true, status: 'deleted', snapshotIds: ['s-system', 's-data'], deletedSnapshotIds: ['s-system', 's-data'] });
    expect(deletes()).toEqual(['DeleteImage', 'DeleteSnapshot', 'DeleteSnapshot']);
    expect(await repository.getPlatformImageAssetById(assetId)).toBeNull();
    expect((await repository.getImageSnapshotById(sourceId))!.isAvailable).toBe(false);
    expect((await repository.listBillingLedgerResources()).every(row => row.releasedAt)).toBe(true);
    const count = calls.length;
    expect(await service.cleanup(sourceId, owner)).toEqual(result);
    expect(calls.length).toBe(count);
  });
  it('keeps exact cleanup materials and progress after a snapshot failure, then retries without the cloud image', async () => {
    await ready(); failSnapshot = 's-data';
    await expect(service.cleanup(sourceId, owner)).rejects.toThrow('云资源清理未确认');
    const artifact = (await repository.getPackedImageArtifact(artifactId))!;
    expect(artifact).toMatchObject({ status: 'deleting', backingSnapshotIds: ['s-system', 's-data'], deletedSnapshotIds: ['s-system'] });
    expect(artifact.cloudImageDeletedAt).not.toBeNull();
    expect((await repository.getPlatformImageAssetById(assetId))!.enabled).toBe(false);
    failSnapshot = null;
    expect(await service.cleanup(sourceId, owner)).toMatchObject({ removed: true });
    expect(deletes().filter(action => action === 'DeleteImage')).toHaveLength(1);
  });
  it.each(['foreign owner', 'foreign disk', 'foreign region', 'copied snapshot', 'shared image'])('refuses %s snapshot before deleting any cloud resource', async reason => {
    await ready();
    const snapshot = snapshots.get('s-data');
    if (reason === 'foreign owner') snapshot.Tags.Tag.find((tag: any) => tag.TagKey === 'PlatformUserId').TagValue = 'other-owner';
    if (reason === 'foreign disk') snapshot.SourceDiskId = 'd-external';
    if (reason === 'foreign region') snapshot.RegionId = 'cn-beijing';
    if (reason === 'copied snapshot') snapshot.SourceSnapshotId = 's-external';
    if (reason === 'shared image') sharedSnapshot = 's-data';
    await expect(service.cleanup(sourceId, owner)).rejects.toThrow();
    expect(deletes()).toEqual([]);
  });
  it('refuses incomplete Available backing mappings and never enables the asset', async () => {
    image.Status = 'Available'; image.DiskDeviceMappings.DiskDeviceMapping[1] = {};
    await service.refresh(artifactId);
    expect((await repository.getPackedImageArtifact(artifactId))!.status).toBe('creating');
    expect((await repository.getPlatformImageAssetById(assetId))!.enabled).toBe(false);
    expect((await repository.getImageSnapshotById(sourceId))!.isAvailable).toBe(false);
    await expect(service.cleanup(sourceId, owner)).rejects.toThrow();
    expect(deletes()).toEqual([]);
  });
  it('rejects contradictory empty snapshot responses instead of treating retained snapshots as deleted', async () => {
    await ready(); failSnapshot = 's-data';
    await expect(service.cleanup(sourceId, owner)).rejects.toThrow();
    failSnapshot = null; contradictorySnapshot = 's-data';
    await expect(service.cleanup(sourceId, owner)).rejects.toThrow();
    expect((await repository.getPackedImageArtifact(artifactId))!.deletedSnapshotIds).toEqual(['s-system']);
    expect((await repository.listBillingLedgerResources()).find(row => row.cloudResourceId === 's-data')!.releasedAt).toBeNull();
  });
  it('repairs ledger release on retry when cloud deletion succeeded but the local ledger write failed', async () => {
    await ready();
    const original = repository.updateBillingLedgerResource.bind(repository);
    let rejectedRelease = false;
    const update = jest.spyOn(repository, 'updateBillingLedgerResource').mockImplementation(async (id, input) => {
      if (input.releasedAt && !rejectedRelease) { rejectedRelease = true; throw new Error('mock DB unavailable'); }
      return original(id, input);
    });
    await expect(service.cleanup(sourceId, owner)).rejects.toThrow();
    expect((await repository.getPackedImageArtifact(artifactId))!.cloudImageDeletedAt).not.toBeNull();
    update.mockImplementation(original);
    expect(await service.cleanup(sourceId, owner)).toMatchObject({ removed: true });
    expect((await repository.listBillingLedgerResources()).every(row => row.releasedAt)).toBe(true);
  });
  it('serializes API cleanup and worker polling across repository claims', async () => {
    await ready();
    await repository.claimPackedImageArtifact(artifactId, 'other-worker', new Date(Date.now() + 60_000));
    const count = calls.length;
    await expect(service.cleanup(sourceId, owner)).rejects.toThrow('正在验证或清理');
    await service.refresh(artifactId);
    expect(calls.length).toBe(count);
    await repository.releasePackedImageArtifactClaim(artifactId, 'wrong-token');
    await expect(service.cleanup(sourceId, owner)).rejects.toThrow();
    await repository.releasePackedImageArtifactClaim(artifactId, 'other-worker');
    expect(await service.cleanup(sourceId, owner)).toMatchObject({ removed: true });
  });
  it('rejects account changes, other owners, and unknown old images', async () => {
    await ready();
    credentials.mockResolvedValue({ ...context, accountUid: 'other-account' });
    await expect(service.cleanup(sourceId, owner)).rejects.toThrow('云账号或地域');
    await expect(service.cleanup(sourceId, { id: 'other-owner', role: 'user' } as SessionUserProfile)).rejects.toThrow('不属于');
    await expect(service.cleanup('old-image-without-manifest', { id: 'admin', role: 'admin' } as SessionUserProfile)).rejects.toThrow('旧镜像');
    expect(deletes()).toEqual([]);
  });
  it('blocks another pack of the same source while the original outcome is unresolved', async () => {
    await expect(service.begin({ cloudAccountContextId: context.id, cloudAccountUid: context.accountUid, regionId: context.regionId, ownerUserId: owner.id, sourceRangeInstanceId: 'range-new', sourceHostKey: 'ecs-new', sourceInstanceId: 'i-new' }, context)).rejects.toThrow('尚未确认');
    expect(await repository.listPackedImageArtifacts()).toHaveLength(1);
  });
  it('retains the complete snapshot binding and every billable ledger when snapshot tagging fails', async () => {
    const originalFetch = (globalThis.fetch as jest.Mock).getMockImplementation()!;
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (new URL(String(input)).searchParams.get('Action') === 'TagResources') return new Response(JSON.stringify({ Code: 'Forbidden' }), { status: 403 });
      return originalFetch(input, init);
    });
    await service.refresh(artifactId);
    expect(await repository.getPackedImageArtifact(artifactId)).toMatchObject({ status: 'creating', backingSnapshotIds: ['s-system', 's-data'] });
    expect((await repository.listBillingLedgerResources()).find(row => row.cloudResourceId === 's-system')).toMatchObject({ cloudAccountUid: context.accountUid, ownerUserId: owner.id, releasedAt: null });
    expect((await repository.listBillingLedgerResources()).find(row => row.cloudResourceId === 's-data')).toMatchObject({ cloudAccountUid: context.accountUid, ownerUserId: owner.id, releasedAt: null });
    expect(deletes()).toEqual([]);
  });
});
