import { ProvisioningWorkerService } from '../src/provisioning/provisioning-worker.service';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';

const account = { provider: 'alibaba_cloud', accessKeyId: 'test-key', accessKeySecret: 'test-secret', accountUidResolved: true,
  accountUid: 'uid-a', cloudAccountContextId: 'ctx-a', defaultRegion: 'cn-hangzhou', defaultZoneId: 'cn-hangzhou-h' };
const specs = [
  ['security_group', 'sg-owned', 'DescribeSecurityGroups', 'SecurityGroups', 'SecurityGroup', 'SecurityGroupId', {}],
  ['network_acl', 'nacl-owned', 'DescribeNetworkAcls', 'NetworkAcls', 'NetworkAcl', 'NetworkAclId', {}],
  ['snat_entry', 'stb-owned:snat-owned', 'DescribeSnatTableEntries', 'SnatTableEntries', 'SnatTableEntry', 'SnatEntryId', { SnatTableId: 'stb-owned' }],
  ['dnat_entry', 'ftb-owned:fwd-owned', 'DescribeForwardTableEntries', 'ForwardTableEntries', 'ForwardTableEntry', 'ForwardEntryId', { ForwardTableId: 'ftb-owned' }],
] as const;
function fixture() {
  const worker = new ProvisioningWorkerService(createMemoryAdminRepository(), { mode: 'dry-run', create: jest.fn(), destroy: jest.fn() }, {} as any);
  const rpc = jest.spyOn(worker as any, 'performAliyunRpcRequest');
  const check = (kind: string, id: string) => (worker as any).checkAliyunRecordedNetworkResource(kind, id, account, account.defaultRegion);
  return { worker, rpc, check };
}
afterEach(() => jest.restoreAllMocks());

describe('range exact network cleanup evidence', () => {
  it.each(specs)('queries exact %s IDs and retains a surviving resource independently of host status', async (kind, id, action, collection, item, field, parent) => {
    const f = fixture(), cloudId = id.split(':').at(-1)!;
    f.rpc.mockResolvedValue({ RequestId: 'receipt', TotalCount: '1', PageNumber: '1', PageSize: '50', [collection]: { [item]: [{ [field]: cloudId, ...parent, RegionId: account.defaultRegion }] } });
    expect(await f.check(kind, id)).toBe(true);
    expect(f.rpc).toHaveBeenCalledWith(expect.objectContaining({ action, parameters: { RegionId: account.defaultRegion, [field]: cloudId, ...parent, PageNumber: '1', PageSize: '50' } }));
    f.rpc.mockResolvedValue({ RequestId: 'receipt', TotalCount: 0, PageNumber: 1, PageSize: 50, [collection]: { [item]: [] } });
    expect(await f.check(kind, id)).toBe(false);
  });
  it.each(specs)('refuses incomplete or foreign %s evidence rather than declaring cleanup', async (kind, id, _action, collection, item, field) => {
    const f = fixture();
    for (const payload of [
      { RequestId: 'receipt', TotalCount: 1, PageNumber: 1, PageSize: 50, [collection]: { [item]: [] } },
      { RequestId: 'receipt', TotalCount: 1, PageNumber: 1, PageSize: 50, [collection]: { [item]: [{ [field]: 'foreign' }] } },
      { RequestId: 'receipt', TotalCount: 0, PageNumber: 1, PageSize: 50, NextToken: 'more', [collection]: { [item]: [] } },
      { Code: 'Forbidden', RequestId: 'receipt', TotalCount: 0, PageNumber: 1, PageSize: 50, [collection]: { [item]: [] } },
    ]) { f.rpc.mockResolvedValue(payload); await expect(f.check(kind, id)).rejects.toThrow(); }
  });
  it.each(['SnatTableId', 'ForwardTableId'])('accepts only an exact deleted %s receipt, never a generic error', async parent => {
    const f = fixture(); f.rpc.mockRestore();
    const kind = parent === 'SnatTableId' ? 'snat_entry' : 'dnat_entry', id = kind === 'snat_entry' ? 'stb-owned:snat-owned' : 'ftb-owned:fwd-owned';
    const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ Code: `Invalid${parent}.NotFound`, RequestId: 'receipt' }), { status: 404 }));
    expect(await f.check(kind, id)).toBe(false);
    fetch.mockResolvedValue(new Response(JSON.stringify({ Code: 'Forbidden', RequestId: 'receipt' }), { status: 403 }));
    await expect(f.check(kind, id)).rejects.toThrow();
    fetch.mockResolvedValue(new Response(JSON.stringify({ Code: `Invalid${parent}.NotFound` }), { status: 404 }));
    await expect(f.check(kind, id)).rejects.toThrow();
  });
});
