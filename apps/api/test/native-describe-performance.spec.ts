import { SingleInstanceBatchExecutionService } from '../src/admin/single-instance-batch-execution.service';

const account = { provider: 'alibaba_cloud', cloudAccountContextId: 'context-1', accountUid: 'account-1', accountUidResolved: true,
  defaultRegion: 'cn-hangzhou', defaultZoneId: 'cn-hangzhou-h', accessKeyId: 'synthetic-ak', accessKeySecret: 'synthetic-sk' };
function fixture() {
  const service: any = new SingleInstanceBatchExecutionService({} as any, {} as any);
  const rpc = jest.fn(async (input) => {
    const ids = JSON.parse(input.parameters.InstanceIds) as string[];
    return { TotalCount: ids.length, Instances: { Instance: ids.map((InstanceId) => ({ InstanceId, Status: 'Running', Tags: { Tag: [{ TagKey: 'PlatformUserId', TagValue: `owner-${InstanceId}` }] } })) } };
  });
  service.performAliyunRpcRequest = rpc;
  const describe = (ids: string[], context = account) => service.describeInstances({ accountContext: context, instanceIds: ids }) as Promise<Array<{ instanceId: string; tags: Record<string, string> }>>;
  return { service, rpc, describe };
}
describe('native DescribeInstances short-window coalescing', () => {
  it('reserves a released slot for the queued caller instead of allowing a new microtask to overbook it', async () => {
    const f = fixture();
    const releases: Array<() => void> = [];
    let active = 0, peak = 0;
    const order: number[] = [];
    const work = (index: number) => () => {
      active += 1; peak = Math.max(peak, active); order.push(index);
      return new Promise<void>(resolve => { releases[index] = () => { active -= 1; resolve(); }; });
    };
    const runs = [f.service.runWithSlot(work(0)), f.service.runWithSlot(work(1)), f.service.runWithSlot(work(2)), f.service.runWithSlot(work(3))];
    releases[0]();
    queueMicrotask(() => runs.push(f.service.runWithSlot(work(4))));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(peak).toBe(3);
    expect(order).toEqual([0, 1, 2, 3]);
    releases[1]();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(order).toEqual([0, 1, 2, 3, 4]);
    for (const index of [2, 3, 4]) releases[index]();
    await Promise.all(runs);
    expect(f.service.inFlight).toBe(0);
  });
  it('coalesces concurrent exact IDs and repeated callers while keeping results detached per caller', async () => {
    const f = fixture();
    const [a, b, same] = await Promise.all([f.describe(['i-a']), f.describe(['i-b']), f.describe(['i-a', 'i-a'])]);
    expect(f.rpc).toHaveBeenCalledTimes(1);
    expect(JSON.parse(f.rpc.mock.calls[0][0].parameters.InstanceIds)).toEqual(['i-a', 'i-b']);
    expect(a.map(row => row.instanceId)).toEqual(['i-a']);
    expect(b.map(row => row.instanceId)).toEqual(['i-b']);
    expect(same.map(row => row.instanceId)).toEqual(['i-a']);
    a[0].tags.PlatformUserId = 'changed';
    expect(same[0].tags.PlatformUserId).toBe('owner-i-a');
  });
  it.each(['cloudAccountContextId', 'accountUid', 'defaultRegion', 'defaultZoneId', 'accessKeyId', 'accessKeySecret'] as const)('never combines a different %s', async (field) => {
    const f = fixture();
    await Promise.all([f.describe(['i-a']), f.describe(['i-b'], { ...account, [field]: `${account[field]}-different` })]);
    expect(f.rpc).toHaveBeenCalledTimes(2);
    expect(f.rpc.mock.calls.map(([input]) => JSON.parse(input.parameters.InstanceIds))).toEqual([['i-a'], ['i-b']]);
  });
  it('caps every RPC at100 IDs and bounds chunk requests sequentially', async () => {
    const f = fixture();
    let active = 0, peak = 0;
    const base = f.rpc.getMockImplementation()!;
    f.rpc.mockImplementation(async (input) => { active += 1; peak = Math.max(peak, active); try { await new Promise(resolve => setTimeout(resolve, 1)); return await base(input); } finally { active -= 1; } });
    const results = await Promise.all(Array.from({ length: 205 }, (_, i) => f.describe([`i-${i}`])));
    expect(f.rpc).toHaveBeenCalledTimes(3);
    expect(f.rpc.mock.calls.map(([input]) => JSON.parse(input.parameters.InstanceIds).length)).toEqual([100, 100, 5]);
    expect(peak).toBe(1);
    expect(results.map(rows => rows[0].instanceId)).toEqual(Array.from({ length: 205 }, (_, i) => `i-${i}`));
  });
  it('fans out an RPC failure and permits a fresh successful retry without an error cache', async () => {
    const f = fixture();
    f.rpc.mockRejectedValueOnce(new Error('Synthetic cloud failure'));
    const failed = await Promise.allSettled([f.describe(['i-a']), f.describe(['i-b'])]);
    expect(failed.every(result => result.status === 'rejected')).toBe(true);
    expect(f.rpc).toHaveBeenCalledTimes(1);
    await expect(f.describe(['i-a'])).resolves.toEqual([expect.objectContaining({ instanceId: 'i-a' })]);
    expect(f.rpc).toHaveBeenCalledTimes(2);
  });
  it('does not return partial success when a later chunk fails and permits the next request to retry', async () => {
    const f = fixture();
    const base = f.rpc.getMockImplementation()!;
    f.rpc.mockImplementationOnce(base).mockRejectedValueOnce(new Error('Second chunk failed'));
    const results = await Promise.allSettled(Array.from({ length: 101 }, (_, i) => f.describe([`i-${i}`])));
    expect(results.every(result => result.status === 'rejected')).toBe(true);
    expect(f.rpc).toHaveBeenCalledTimes(2);
    await expect(f.describe(['i-0'])).resolves.toHaveLength(1);
    expect(f.rpc).toHaveBeenCalledTimes(3);
  });
  it('captures IDs and context before caller mutation during the short batching window', async () => {
    const f = fixture();
    const ids = ['i-a'];
    const mutable = { ...account };
    const request = f.describe(ids, mutable);
    ids.push('i-foreign');
    mutable.defaultRegion = 'cn-different';
    mutable.accessKeySecret = 'different-secret';
    await expect(request).resolves.toEqual([expect.objectContaining({ instanceId: 'i-a' })]);
    expect(JSON.parse(f.rpc.mock.calls[0][0].parameters.InstanceIds)).toEqual(['i-a']);
    expect(f.rpc.mock.calls[0][0].regionId).toBe(account.defaultRegion);
  });
  it('queries again after completion and never joins a previous in-flight verification', async () => {
    const f = fixture();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const base = f.rpc.getMockImplementation()!;
    f.rpc.mockImplementationOnce(async (input) => { await gate; return base(input); });
    const first = f.describe(['i-a']);
    while (f.rpc.mock.calls.length === 0) await new Promise(resolve => setTimeout(resolve, 1));
    await f.describe(['i-a']);
    expect(f.rpc).toHaveBeenCalledTimes(2);
    release();
    await first;
    await f.describe(['i-a']);
    expect(f.rpc).toHaveBeenCalledTimes(3);
  });
  it.each([
    {},
    { Instances: { Instance: null } },
    { Instances: { Instance: [{ InstanceId: 'i-foreign' }] }, TotalCount: 1 },
    { Instances: { Instance: [{}] } },
    { Instances: { Instance: [null] } },
    { Instances: { Instance: [{ InstanceId: 'i-a' }, { InstanceId: 'i-a' }] }, TotalCount: 2 },
    { Instances: { Instance: [] }, TotalCount: 1 },
  ])('rejects unproven/malformed/foreign identities instead of turning them into absence: %j', async (body) => {
    const f = fixture();
    f.rpc.mockResolvedValueOnce(body as any);
    await expect(f.describe(['i-a'])).rejects.toThrow('DescribeInstances response');
    await expect(f.describe(['i-a'])).resolves.toHaveLength(1);
  });
  it('does not combine an unverified or unbound cloud context', async () => {
    const f = fixture();
    await Promise.all([f.describe(['i-a'], { ...account, accountUidResolved: false }), f.describe(['i-b'], { ...account, accountUidResolved: false })]);
    expect(f.rpc).toHaveBeenCalledTimes(2);
    await expect(f.describe([])).resolves.toEqual([]);
    expect(f.rpc).toHaveBeenCalledTimes(2);
  });
});
