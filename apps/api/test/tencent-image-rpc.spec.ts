import { describeTencentImages, describeTencentSnapshot, deleteTencentImage, deleteTencentSnapshot, tagTencentImageResources } from '../src/admin/tencent-image-rpc';
import { requestTencentCloud } from '../src/admin/tencent-cloud-client';
import type { CloudAccountContextCredentials } from '../src/admin/cloud-account-contexts.service';
jest.mock('../src/admin/tencent-cloud-client', () => ({ ...jest.requireActual('../src/admin/tencent-cloud-client'), requestTencentCloud: jest.fn() }));
const rpc = requestTencentCloud as jest.Mock;
const context: CloudAccountContextCredentials = { id: 'context-fixture', provider: 'tencent_cloud', accountUid: '123456', regionId: 'ap-guangzhou', zoneId: 'ap-guangzhou-3', accessKeyId: 'synthetic-id', accessKeySecret: 'synthetic-secret', imageImportBucket: '', status: 'ready' };
const image = (id: string, sid?: string) => ({ ImageId: id, ImageState: 'NORMAL', ImageType: 'PRIVATE_IMAGE', ImageName: 'fixture', Platform: 'Ubuntu', Architecture: 'x86_64', ImageSize: 40, SnapshotSet: sid ? [{ SnapshotId: sid, DiskUsage: 'SYSTEM_DISK' }] : [], Tags: [] });
const response = (set: string, rows: any[], total = rows.length) => ({ RequestId: 'fixture-request', TotalCount: total, [set]: rows });
const snapshot = (extra: Record<string, unknown> = {}) => ({ SnapshotId: 'snap-owned', DiskId: 'disk-system', CreateTime: new Date().toISOString(), SnapshotState: 'NORMAL', SnapshotType: 'PRIVATE_SNAPSHOT', CopyFromRemote: false, ShareReference: 0, Images: [], Tags: [], ...extra });
beforeEach(() => rpc.mockReset());
describe('Tencent image RPC normalization and complete recovery', () => {
  it('normalizes sizes and snapshot binding for the shared catalog contract', async () => {
    rpc.mockResolvedValue(response('ImageSet', [image('img-owned', 'snap-owned')]));
    const [value] = await describeTencentImages(context, { ImageId: 'img-owned' });
    expect(value).toMatchObject({ ImageId: 'img-owned', Status: 'Available', ImageSize: 40, OSType: 'linux', DiskDeviceMappings: { DiskDeviceMapping: [{ SnapshotId: 'snap-owned', DiskUsage: 'SYSTEM_DISK' }] }, Tags: { Tag: [] } });
  });
  it('reads the entire PRIVATE_IMAGE set before matching a snapshot and never invents SnapshotId Filters', async () => {
    rpc.mockResolvedValueOnce(response('ImageSet', [image('img-first')], 2)).mockResolvedValueOnce(response('ImageSet', [image('img-owned', 'snap-owned')], 2));
    expect((await describeTencentImages(context, { SnapshotId: 'snap-owned' })).map(row => row.ImageId)).toEqual(['img-owned']);
    expect(rpc.mock.calls[1][0].parameters).toEqual({ Offset: 1, Limit: 100, Filters: [{ Name: 'image-type', Values: ['PRIVATE_IMAGE'] }] });
  });
  it.each([response('ImageSet', [], 1), response('ImageSet', [image('img-first'), image('img-first')]), response('ImageSet', [{ ...image('img-first'), SnapshotSet: [{ SnapshotId: 'snap-owned' }, { SnapshotId: 'snap-owned' }] }])])('rejects missing or duplicate identities %#', async body => {
    rpc.mockResolvedValue(body); await expect(describeTencentImages(context)).rejects.toThrow();
  });
  it('tags at most ten QCS resources per call and checks partial failure', async () => {
    rpc.mockResolvedValue({ RequestId: 'fixture', FailedResources: [] });
    await tagTencentImageResources(context, 'snapshot', Array.from({ length: 11 }, (_, n) => `snap-owned${n}`), { CreatedBy: 'cyber-range-platform' });
    expect(rpc.mock.calls.map(([call]) => call.parameters.ResourceList.length)).toEqual([10, 1]);
    expect(rpc.mock.calls[0][0].parameters.ResourceList[0]).toBe('qcs::cbs:ap-guangzhou:uin/123456:snapshot/snap-owned0');
    rpc.mockResolvedValue({ RequestId: 'fixture', FailedResources: [{ Resource: 'snap-owned' }] });
    await expect(tagTencentImageResources(context, 'snapshot', ['snap-owned'], { CreatedBy: 'cyber-range-platform' })).rejects.toThrow('失败');
  });
  it('explicitly preserves snapshots on image deletion', async () => {
    rpc.mockResolvedValue({ RequestId: 'fixture' }); await deleteTencentImage(context, 'img-owned');
    expect(rpc.mock.calls[0][0].parameters).toEqual({ ImageIds: ['img-owned'], DeleteBindedSnap: false });
  });
  it.each([{ ShareReference: 1 }, { CopyFromRemote: true }, { SnapshotType: 'SHARED_SNAPSHOT' }, { Images: [{ ImageId: 'img-other' }] }])('refuses shared/copied/referenced snapshots %#', async extra => {
    rpc.mockResolvedValue(response('SnapshotSet', [snapshot(extra)]));
    await expect(deleteTencentSnapshot(context, 'snap-owned')).rejects.toThrow('拒绝');
    expect(rpc.mock.calls.some(([call]) => call.action === 'DeleteSnapshots')).toBe(false);
  });
  it('checks all image references before non-force snapshot deletion', async () => {
    rpc.mockImplementation(async call => call.action === 'DescribeSnapshots' ? response('SnapshotSet', [snapshot()]) : call.action === 'DescribeImages' ? response('ImageSet', []) : { RequestId: 'fixture' });
    await deleteTencentSnapshot(context, 'snap-owned');
    expect(rpc.mock.calls[2][0].parameters).toEqual({ SnapshotIds: ['snap-owned'], DeleteBindImages: false });
  });
  it('requires explicit fresh snapshot sharing fields instead of guessing defaults', async () => {
    rpc.mockResolvedValue(response('SnapshotSet', [{ SnapshotId: 'snap-owned' }]));
    await expect(describeTencentSnapshot(context, 'snap-owned')).rejects.toThrow('不完整');
  });
});

