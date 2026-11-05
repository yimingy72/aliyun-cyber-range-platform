import { buildAcrMatchIndex, readAcrInventory } from '../src/admin/aliyun-acr-catalog';

const credentials = { accessKeyId: 'fixture-key', accessKeySecret: 'fixture-secret', defaultRegion: 'cn-beijing' };
const digest = 'a'.repeat(64);

it('walks every region, instance, repository and tag page and matches exact endpoints and digests', async () => {
  const tag = (n: number) => ({ Tag: 'v' + n, Digest: digest, Status: 'NORMAL', ImageUpdate: '1780000000000' });
  const query = jest.fn(async (region: string, action: string, args: Record<string, string> = {}) => {
    switch (action) {
      case 'ListInstanceRegion': return { Regions: [{ RegionId: 'cn-beijing' }, { RegionId: 'cn-shanghai' }] };
      case 'ListInstance': return region === 'cn-beijing' ? { TotalCount: 1, Instances: [{ InstanceId: 'cri-beijing', InstanceName: 'training', RegionId: region }] } : { TotalCount: 0, Instances: [] };
      case 'ListInstanceEndpoint': return { Endpoints: [
        { Domains: [{ Domain: 'training-registry.cn-beijing.cr.aliyuncs.com' }] },
        { Domains: [{ Domain: 'training-registry-vpc.cn-beijing.cr.aliyuncs.com' }] },
      ] };
      case 'ListRepository': return { TotalCount: '1', Repositories: [{ InstanceId: 'cri-beijing', RepoId: 'crr-lab', RepoNamespaceName: 'team', RepoName: 'lab' }] };
      case 'ListRepoTag': return { TotalCount: '101', PageNo: Number(args.PageNo),
        Images: args.PageNo === '1' ? Array.from({ length: 100 }, (_, index) => tag(index)) : [tag(100)] };
      default: throw new Error('Unexpected operation');
    }
  });
  const inventory = await readAcrInventory(credentials, query);
  expect(inventory).toMatchObject({ regionCount: 2, instanceCount: 1, repositoryCount: 1 });
  expect(inventory.items).toHaveLength(101);
  expect(query).toHaveBeenCalledWith('cn-shanghai', 'ListInstance', expect.any(Object));
  const match = buildAcrMatchIndex(inventory.items);
  expect(match('training-registry-vpc.cn-beijing.cr.aliyuncs.com/team/lab:v100')).toBe('matched');
  expect(match('training-registry.cn-beijing.cr.aliyuncs.com/team/lab@sha256:' + digest)).toBe('matched');
  expect(match('lab:v100')).toBe('candidate');
  expect(match('other.example.com/team/lab:v100')).toBe('unmatched');
  const ambiguous = buildAcrMatchIndex([...inventory.items, { ...inventory.items[0], id: 'cn-shanghai/cri-other/crr-other:v0' }]);
  expect(ambiguous('lab:v0')).toBe('ambiguous');
});

it('rejects a truncated page instead of publishing an empty ACR snapshot', async () => {
  await expect(readAcrInventory(credentials, async (_region, action) => action === 'ListInstanceRegion'
    ? { Regions: [{ RegionId: 'cn-beijing' }] }
    : { TotalCount: 1, Instances: [] })).rejects.toThrow('目录分页不完整');
});
