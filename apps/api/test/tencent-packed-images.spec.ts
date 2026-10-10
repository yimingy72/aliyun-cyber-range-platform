import { PackedImagesService } from '../src/admin/packed-images.service';
import { TencentCloudRequestError } from '../src/admin/tencent-cloud-client';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';
import { requestTencentCloud } from '../src/admin/tencent-cloud-client';
import type { CloudAccountContextCredentials } from '../src/admin/cloud-account-contexts.service';
jest.mock('../src/admin/tencent-cloud-client', () => ({ ...jest.requireActual('../src/admin/tencent-cloud-client'), requestTencentCloud: jest.fn() }));
const rpc = requestTencentCloud as jest.Mock;
const context: CloudAccountContextCredentials = { id: 'context-fixture', provider: 'tencent_cloud', accountUid: '123456', regionId: 'ap-guangzhou', zoneId: 'ap-guangzhou-3', accessKeyId: 'synthetic-id', accessKeySecret: 'synthetic-secret', imageImportBucket: '', status: 'ready' };
const response = (set: string, rows: any[], total = rows.length) => ({ RequestId: 'fixture-request', TotalCount: total, [set]: rows });
beforeEach(() => rpc.mockReset());
describe('Tencent packing submission fences', () => {
  async function fixture(priorSnapshotIds: string[] = []) {
    const repository = createMemoryAdminRepository();
    const range = await repository.createRangeInstance({ cloudProvider: 'tencent_cloud', name: 'fixture', instanceMode: 'range', ownerUserId: 'owner', createdBy: 'owner', status: 'running',
      resourceSummary: { mode: 'opentofu', executionContext: { cloudAccountContextId: context.id, cloudAccountUid: context.accountUid, regionId: context.regionId, zoneId: context.zoneId }, hostIds: { host: 'ins-owned' }, systemDiskIds: { host: 'disk-system' }, dataDiskIds: { host: 'disk-data' } } });
    const service = new PackedImagesService(repository, { getCredentials: async () => context } as never);
    const disks = [{ DiskId: 'disk-system', DiskUsage: 'SYSTEM_DISK', InstanceId: 'ins-owned', Tags: [] }, { DiskId: 'disk-data', DiskUsage: 'DATA_DISK', InstanceId: 'ins-owned', Tags: [] }];
    const cloudTags = { CreatedBy: 'cyber-range-platform', PlatformManaged: 'true', ExecutionBackend: 'opentofu', RangeInstanceId: range.id, PlatformScope: 'user', PlatformUserId: 'owner', PlatformHostKey: 'host', PlatformResourceType: 'ecs', CloudAccountUid: context.accountUid, CloudAccountContextId: context.id };
    rpc.mockImplementation(async call => call.action === 'DescribeInstances' ? response('InstanceSet', [{ InstanceId: 'ins-owned', InstanceState: 'RUNNING', Tags: Object.entries(cloudTags).map(([Key,Value]) => ({Key,Value})) }]) : call.action === 'DescribeDisks' ? response('DiskSet', disks)
      : call.action === 'DescribeSnapshots' ? response('SnapshotSet', priorSnapshotIds.map(SnapshotId => ({ SnapshotId, DiskId: call.parameters!.Filters[0].Values[0] })))
      : call.action === 'CreateImage' ? { RequestId: 'fixture', ImageId: 'img-owned' } : response('ImageSet', []));
    const artifact = await service.begin({ cloudAccountContextId: context.id, cloudAccountUid: context.accountUid, regionId: context.regionId, ownerUserId: 'owner', sourceRangeInstanceId: range.id, sourceInstanceId: 'ins-owned', sourceHostKey: 'host' }, context);
    return { repository, service, artifact };
  }
  it('submits all data disks with atomic tags and no implicit power-off', async () => {
    const f = await fixture(); await f.service.submitTencentImage(f.artifact, context, { name: 'fixture' });
    expect((await f.repository.getPackedImageArtifact(f.artifact.id))!.sourceSnapshotBaseline).toMatchObject({ id: f.artifact.id, sourceDiskIds: ['disk-system','disk-data'], preCreateSnapshotIds: [], sourceDisks: expect.arrayContaining([
      expect.objectContaining({ sourceDiskId: 'disk-system', evidence: [expect.objectContaining({ action: 'DescribeSnapshots', requestIds: ['fixture-request'] })] })]) });
    expect(rpc.mock.calls.find(([call]) => call.action === 'CreateImage')![0].parameters).toMatchObject({ InstanceId: 'ins-owned', DataDiskIds: ['disk-data'], ForcePoweroff: 'false',
      TagSpecification: [{ ResourceType: 'image', Tags: expect.arrayContaining([{ Key: 'PlatformPackedImageArtifactId', Value: f.artifact.id }, { Key: 'CloudAccountContextId', Value: context.id }]) }] });
    await expect(f.service.submitTencentImage(f.artifact, context, { name: 'fixture' })).rejects.toThrow('禁止再次');
  });
  it('keeps unknown submission evidence and never issues a second CreateImage', async () => {
    const f = await fixture(); rpc.mockImplementation(async call => call.action === 'DescribeDisks' ? response('DiskSet', [{ DiskId: 'disk-system', DiskUsage: 'SYSTEM_DISK', InstanceId: 'ins-owned', Tags: [] }, { DiskId: 'disk-data', DiskUsage: 'DATA_DISK', InstanceId: 'ins-owned', Tags: [] }]) : Promise.reject(new Error('unknown-submit')));
    await expect(f.service.submitTencentImage(f.artifact, context, { name: 'fixture' })).rejects.toThrow('unknown-submit');
    expect((await f.repository.getPackedImageArtifact(f.artifact.id))?.status).toBe('creating');
    await expect(f.service.submitTencentImage(f.artifact, context, { name: 'fixture' })).rejects.toThrow('禁止再次');
    expect(rpc.mock.calls.filter(([call]) => call.action === 'CreateImage')).toHaveLength(1);
  });
  it('preserves an official safe rejection code and CreateImage phase without retrying or marking unknown creation absent', async () => {
    const f = await fixture(); const original = rpc.getMockImplementation()!;
    rpc.mockImplementation(async call => call.action === 'CreateImage' ? Promise.reject(new TencentCloudRequestError('InvalidParameterValue')) : original(call));
    await expect(f.service.submitTencentImage(f.artifact, context, { name: 'fixture' })).rejects.toMatchObject({ phase: 'create_image', cloudErrorCode: 'InvalidParameterValue' });
    expect((await f.repository.getPackedImageArtifact(f.artifact.id))?.status).toBe('creating');
    await expect(f.service.submitTencentImage(f.artifact, context, { name: 'fixture' })).rejects.toThrow('禁止再次');
    expect(rpc.mock.calls.filter(([call]) => call.action === 'CreateImage')).toHaveLength(1);
  });
  it('never adds a baseline to an existing legacy pending artifact or submits it', async () => {
    const f = await fixture();
    const legacy = await f.repository.createPackedImageArtifact({ cloudProvider: 'tencent_cloud', cloudAccountContextId: context.id, cloudAccountUid: context.accountUid, regionId: context.regionId,
      ownerUserId: 'owner', sourceRangeInstanceId: f.artifact.sourceRangeInstanceId, sourceHostKey: 'host', sourceInstanceId: 'ins-owned', sourceDiskIds: ['disk-system','disk-data'] });
    await f.repository.claimPackedImageArtifact(legacy.id, 'legacy-fixture', new Date(Date.now()+60_000));
    await expect(f.service.submitTencentImage({ ...legacy, submissionToken: 'legacy-fixture' }, context, { name: 'legacy' })).rejects.toThrow('不可补基线');
    expect((await f.repository.getPackedImageArtifact(legacy.id))!.sourceSnapshotBaseline).toBeNull();
    expect(rpc.mock.calls.filter(([call]) => call.action === 'CreateImage')).toHaveLength(0);
  });
  it('rejects a previously present snapshot despite matching own image tags and no sharing', async () => {
    const f = await fixture(['snap-old']); await f.service.submitTencentImage(f.artifact, context, { name: 'fixture' });
    const tags = rpc.mock.calls.find(([call]) => call.action === 'CreateImage')![0].parameters.TagSpecification[0].Tags;
    rpc.mockImplementation(async call => call.action === 'DescribeImages' ? response('ImageSet', [{ ImageId: 'img-owned', ImageState: 'NORMAL', ImageType: 'PRIVATE_IMAGE', Tags: tags, SnapshotSet: [{ SnapshotId: 'snap-old' },{ SnapshotId: 'snap-data' }] }])
      : response('SnapshotSet', [{ SnapshotId: call.parameters!.SnapshotIds[0], DiskId: call.parameters!.SnapshotIds[0] === 'snap-old' ? 'disk-system' : 'disk-data', CreateTime: '2026-10-10 09:00:00', CopyFromRemote: false, SnapshotType: 'PRIVATE_SNAPSHOT', SnapshotState: 'NORMAL', ShareReference: 0, Images: [{ ImageId: 'img-owned' }], Tags: [] }]));
    await f.service.endSubmission(f.artifact.id, f.artifact.submissionToken); await f.service.refresh(f.artifact.id);
    expect((await f.repository.getPackedImageArtifact(f.artifact.id))!.status).toBe('creating');
    expect(rpc.mock.calls.filter(([call]) => call.action === 'TagResources' || call.action === 'DeleteSnapshots')).toHaveLength(0);
    expect((await f.repository.listBillingLedgerResources()).filter(row => row.cloudResourceType === 'snapshot')).toHaveLength(0);
  });
  it('uses the pre-create baseline and own-image binding with provider naive time, then confirms complete cleanup', async () => {
    const f = await fixture();
    await f.service.submitTencentImage(f.artifact, context, { name: 'fixture' });
    const submit = rpc.mock.calls.find(([call]) => call.action === 'CreateImage')![0];
    let cloudImage: any = { ImageId: 'img-owned', ImageName: 'fixture', ImageState: 'NORMAL', ImageType: 'PRIVATE_IMAGE', ImageSize: 40,
      Tags: submit.parameters.TagSpecification[0].Tags, SnapshotSet: [{ SnapshotId: 'snap-system' }, { SnapshotId: 'snap-data' }] };
    const snapshotTags = new Map<string, any[]>([['snap-system', []], ['snap-data', []]]);
    rpc.mockImplementation(async call => {
      if (call.action === 'DescribeImages') return response('ImageSet', cloudImage ? [cloudImage] : []);
      if (call.action === 'DescribeSnapshots') { const id = call.parameters.SnapshotIds[0]; return response('SnapshotSet', snapshotTags.has(id) ? [{ SnapshotId: id,
        DiskId: id === 'snap-system' ? 'disk-system' : 'disk-data', CreateTime: '2026-10-10 09:02:20', CopyFromRemote: false, SnapshotType: 'PRIVATE_SNAPSHOT', SnapshotState: 'NORMAL',
        ShareReference: 0, Images: cloudImage ? [{ ImageId: cloudImage.ImageId }] : [], Tags: snapshotTags.get(id) }] : []); }
      if (call.action === 'TagResources') { const id = call.parameters.ResourceList[0].split('/').pop();
        const stored = await f.repository.getPackedImageArtifact(f.artifact.id);
        expect(stored!.backingSnapshotIds.sort()).toEqual(['snap-data','snap-system']);
        expect((await f.repository.listBillingLedgerResources()).filter(row => row.cloudProvider === 'tencent_cloud' && row.cloudResourceType === 'snapshot')).toHaveLength(2);
        const updates = call.parameters.Tags.map(({TagKey,TagValue}:any) => ({Key:TagKey,Value:TagValue}));
        const prior = snapshotTags.get(id)!;
        snapshotTags.set(id, [...prior.filter(tag => !updates.some((value:any) => value.Key===tag.Key)), ...updates]); return { RequestId: 'fixture', FailedResources: [] }; }
      if (call.action === 'DeleteImages') { expect(call.parameters.DeleteBindedSnap).toBe(false); cloudImage=null; return {RequestId:'fixture'}; }
      if (call.action === 'DeleteSnapshots') { expect(call.parameters.DeleteBindImages).toBe(false); snapshotTags.delete(call.parameters.SnapshotIds[0]); return {RequestId:'fixture'}; }
      throw new Error('Unexpected synthetic image action');
    });
    await f.service.endSubmission(f.artifact.id, f.artifact.submissionToken);
    await f.service.refresh(f.artifact.id);
    const restored = (await f.repository.getPackedImageArtifact(f.artifact.id))!;
    expect(restored).toMatchObject({ cloudProvider: 'tencent_cloud', status: 'available', imageId: 'img-owned' });
    expect((await f.repository.listBillingLedgerResources()).map(row=>row.cloudResourceId).sort()).toEqual(['img-owned','snap-data','snap-system']);
    expect(await f.service.cleanup(restored.sourceSnapshotId!, {id:'owner',role:'user'} as never)).toMatchObject({removed:true,status:'deleted'});
    expect((await f.repository.listBillingLedgerResources()).every(row=>row.releasedAt)).toBe(true);
  });

});
