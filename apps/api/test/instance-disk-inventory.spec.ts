import { readAttachedDiskInventory, findExistingInventoryDiskIds, mergeDiskInventory, assertDiskInventorySafe } from '../src/admin/instance-disk-inventory';

const expectedTags = { CreatedBy: 'cyber-range-platform', RangeInstanceId: 'range-a', PlatformScope: 'user', PlatformUserId: 'alice', CloudAccountUid: 'uid-a', CloudAccountContextId: 'ctx-a' };
const tags = (patch = {}) => ({ Tag: Object.entries({ ...expectedTags, ...patch }).map(([TagKey, TagValue]) => ({ TagKey, TagValue })) });
const disk = (DiskId: string, Type: string, patch = {}) => ({ DiskId, InstanceId: 'i-owned', Type, DeleteWithInstance: true, Tags: tags(), ...patch });
const page = (rows: unknown[], patch = {}) => ({ RequestId: 'request', PageNumber: 1, PageSize: 100, TotalCount: rows.length, Disks: { Disk: rows }, ...patch });
const read = (rpc: any, patch = {}) => readAttachedDiskInventory({ rpc, instanceId: 'i-owned', expectedTags, ...patch });

describe('owned ECS disk inventory', () => {
  it('records full-image data disks even when atomically inherited resource tags say ecs', async () => {
    const rpc = jest.fn(async () => page([disk('d-system','system'), disk('d-data1','data', { Tags: tags({ PlatformResourceType: 'ecs' }) }), disk('d-data2','data')]));
    const result = await read(rpc);
    expect(result.systemDiskIds).toEqual(['d-system']); expect(result.dataDiskIds).toEqual(['d-data1','d-data2']);
    expect(result.unverifiedDisks).toEqual([]); expect(result.proofs['d-data1']).toEqual({ instanceId: 'i-owned', method: 'tags' });
    expect(rpc).toHaveBeenCalledWith('DescribeDisks', { InstanceId: 'i-owned', PageNumber: '1', PageSize: '100' });
  });
  it('accepts a persisted system disk without requiring mutable image metadata or tags', async () => {
    expect((await read(async () => page([disk('d-system','system', { Tags: undefined })]), { knownSystemDiskIds: ['d-system'] })).systemDiskIds).toEqual(['d-system']);
  });
  it.each([{}, { ImageId: 'm-shared', SourceSnapshotId: 's-shared', CreationTime: '2026-10-09T08:00:00Z', AttachedTime: '2026-10-09T08:00:00Z' }])('does not infer untagged disk ownership from attachment or source metadata %j', async patch => {
    const inventory = await read(async () => page([disk('d-foreign','data',{ Tags: undefined, ...patch })]));
    expect(inventory.dataDiskIds).toEqual([]); expect(inventory.unverifiedDisks.map(d => d.id)).toEqual(['d-foreign']);
    expect(() => assertDiskInventorySafe(inventory, true)).toThrow('unverified');
  });
  it('preserves an external retained disk without billing it or authorizing its deletion', async () => {
    const inventory = await read(async () => page([disk('d-external','data',{ Tags: undefined, DeleteWithInstance: false })]));
    expect(() => assertDiskInventorySafe(inventory, true)).not.toThrow();
    expect(() => assertDiskInventorySafe(inventory, false)).toThrow('unverified');
    expect(mergeDiskInventory({ mode: 'opentofu' }, 'host', inventory)).toMatchObject({ dataDiskIds: {}, unverifiedDiskIds: { 'host:d-external':'d-external' } });
  });
  it('refuses conflicting ownership even if the disk ID was persisted', async () => {
    const result = await read(async () => page([disk('d-system','system',{ Tags: tags({ PlatformUserId: 'bob' }) })]), { knownSystemDiskIds: ['d-system'] });
    expect(result.systemDiskIds).toEqual([]); expect(() => assertDiskInventorySafe(result, true)).toThrow();
  });
  it('enumerates beyond the provider default first ten disks with bounded complete pagination', async () => {
    const rows = Array.from({ length: 105 }, (_,i) => disk(`d-${i}`, 'data'));
    const rpc = jest.fn(async (_action, params) => page(params.PageNumber === '1' ? rows.slice(0,100) : rows.slice(100), { TotalCount:105, PageNumber: Number(params.PageNumber) }));
    expect((await read(rpc)).dataDiskIds).toHaveLength(105); expect(rpc).toHaveBeenCalledTimes(2);
  });
  it.each([
    {}, page([], { RequestId: undefined }), page([], { TotalCount: 1 }), page([], { PageNumber: 2 }),
    page([], { NextToken: 'unfinished' }), page([disk('d-1','data'), disk('d-1','data')]),
    page([disk('d-1','data', { InstanceId: 'i-foreign' })]), page([disk('d-1','invalid')]),
  ])('rejects incomplete or conflicting inventory %j', async body => { await expect(read(async () => body)).rejects.toThrow(); });
  it('verifies residual data disks by the exact recorded IDs and rejects other resources', async () => {
    const rpc = jest.fn(async () => page([{ DiskId:'d-data', Type:'data' }]));
    expect(await findExistingInventoryDiskIds(rpc, ['d-system','d-data'])).toEqual(['d-data']);
    expect(rpc).toHaveBeenCalledWith('DescribeDisks', { DiskIds: '["d-system","d-data"]', PageNumber:'1',PageSize:'100' });
    await expect(findExistingInventoryDiskIds(rpc, ['d-system'])).rejects.toThrow('unrequested');
  });
  it('limits independent instance queries to four in flight', async () => {
    let active = 0, max = 0;
    const rpc = async () => { max = Math.max(max, ++active); await new Promise(resolve => setTimeout(resolve, 2)); active--; return page([]); };
    await Promise.all(Array.from({length:20}, () => read(rpc))); expect(max).toBe(4);
  });
});
