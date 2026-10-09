import { ProvisioningWorkerService } from '../src/provisioning/provisioning-worker.service';
import { type RangeProvisionCreateInput, type RangeProvisionDestroyInput } from '../src/provisioning/provisioning.types';
import { type RangeResourceSummary } from '../src/admin/admin.repository';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';
import { FAILED_CREATE_CLEANUP_PROOF_STEP } from '../src/admin/failed-create-cleanup-evidence';

const account = { provider: 'alibaba_cloud' as const, accessKeyId: 'fixture-source-key', accessKeySecret: 'fixture-source-secret',
  defaultRegion: 'cn-hangzhou', defaultZoneId: 'cn-hangzhou-h', imageImportBucket: '', cloudAccountContextId: 'context-source', accountUid: 'uid-source', accountUidResolved: true };
const binding = { cloudAccountContextId: account.cloudAccountContextId, cloudAccountUid: account.accountUid, regionId: account.defaultRegion, zoneId: account.defaultZoneId };
const resources: RangeResourceSummary = { mode: 'opentofu', hostIds: { entry: 'i-owned' }, systemDiskIds: { entry: 'd-owned' }, eipAllocationIds: { entry: 'eip-owned' } };
const output = { accessEntry: { hostRole: 'entry', publicIp: '192.0.2.1', privateIp: '10.0.1.10', ssh: null }, resourceSummary: resources };
async function fixture(kind: 'create' | 'destroy' = 'create') {
  const repository = createMemoryAdminRepository();
  const template = await repository.createRangeTemplate({ name: 'Cost guard fixture', slug: 'cost-guard', version: 'v1', modulePathOrRef: 'fixture/range', topologySpec: {
    vpcCidr: '10.0.0.0/16', networkZones: [{ key: 'dmz', name: 'DMZ', purpose: 'entry', cidr: '10.0.1.0/24' }],
    hosts: [{ key: 'entry', name: 'Entry', zoneKey: 'dmz', role: 'entry', privateIp: '10.0.1.10' }], publicEntry: { hostKey: 'entry', protocols: [{ protocol: 'ssh', port: 22 }] },
  } });
  const instance = await repository.createRangeInstance({ name: 'Guard fixture', instanceMode: 'range', ownerUserId: 'alice', templateId: template.id,
    status: kind === 'create' ? 'pending_create' : 'pending_destroy', allocatedCidr: '10.0.0.0/16',
    ...(kind === 'destroy' ? { resourceSummary: { ...resources, executionContext: binding, creationAttempted: true } } : {}) });
  const job = await repository.createProvisionJob({ rangeInstanceId: instance.id, jobType: kind, triggeredBy: 'alice' });
  await repository.updateRangeInstance(instance.id, { lastJobId: job.id });
  const system = { getAccountContext: jest.fn(async () => account), getAccountContextById: jest.fn(async () => account), getSnapshot: jest.fn(async () => ({ ...account, accountUid: 'wrong-snapshot-uid', accessKeyId: 'wrong-key' })) };
  const provisioner = { mode: 'opentofu' as const,
    create: jest.fn(async (input: RangeProvisionCreateInput) => { await input.onApplyStart?.(); return output; }),
    inspectResources: jest.fn(async (_input: RangeProvisionDestroyInput): Promise<RangeResourceSummary | null> => resources),
    destroy: jest.fn(async (_input: RangeProvisionDestroyInput) => {}),
  };
  const worker = new ProvisioningWorkerService(repository, provisioner, system as any);
  const query = jest.spyOn(worker as any, 'performAliyunRpcRequest').mockImplementation(async (input: any) => {
    const collections: Record<string, [string,string]> = { DescribeInstances: ['Instances','Instance'], DescribeDisks: ['Disks','Disk'], DescribeEipAddresses: ['EipAddresses','EipAddress'] };
    const [collection,item] = collections[input.action] ?? [];
    if (!collection) throw new Error(`Unexpected verification query ${input.action}`);
    return { RequestId: 'fixture-request', TotalCount: 0, PageSize: 100, PageNumber: 1, [collection]: { [item]: [] } };
  });
  return { repository, instance, job, system, provisioner, worker, query };
}

describe('range worker durable cost safety', () => {
  it('uses one verified account for execution and billing and persists apply intent before cloud mutations', async () => {
    const f = await fixture();
    f.provisioner.create.mockImplementationOnce(async input => {
      await input.onApplyStart!();
      expect(await f.repository.getRangeInstanceById(f.instance.id)).toMatchObject({ resourceSummary: { executionContext: binding, creationAttempted: true } });
      expect(input.runtimeConfig).toMatchObject(account);
      return output;
    });
    await f.worker.process(f.job.id);
    expect(f.system.getSnapshot).not.toHaveBeenCalled();
    expect(await f.repository.getRangeInstanceById(f.instance.id)).toMatchObject({ status: 'running', resourceSummary: { executionContext: binding, creationAttempted: true, hostIds: resources.hostIds } });
    const ledgers = await f.repository.listBillingLedgerResources();
    expect(ledgers).toHaveLength(3);
    expect(ledgers.every(row => row.cloudAccountUid === account.accountUid && row.ownerUserId === 'alice' && row.sourceProvisionJobId === f.job.id)).toBe(true);
  });

  it('uses the original context after the active account switches', async () => {
    const f = await fixture('destroy');
    f.system.getAccountContext.mockResolvedValue({ ...account, cloudAccountContextId: 'context-other', accountUid: 'uid-other' });
    await f.worker.process(f.job.id);
    expect(f.system.getAccountContextById).toHaveBeenCalledWith('context-source');
    expect(f.system.getAccountContext).not.toHaveBeenCalled();
    expect(f.provisioner.destroy).toHaveBeenCalledWith(expect.objectContaining({ runtimeConfig: account, requirePersistedState: true, signal: expect.any(AbortSignal) }));
    expect(await f.repository.getRangeInstanceById(f.instance.id)).toMatchObject({ status: 'destroyed', resourceSummary: null });
    expect((await f.repository.listBillingLedgerResources()).every(row => row.releasedAt)).toBe(true);
    expect(f.query.mock.calls.map(([input]: any[]) => input.action).sort()).toEqual(['DescribeDisks', 'DescribeEipAddresses', 'DescribeInstances']);
    const inventoryLog = (await f.repository.listProvisionJobStepLogs(f.job.id)).find(log => log.stepName === 'range_resource_inventory')!;
    expect(JSON.parse(inventoryLog.message!)).toMatchObject({ executionContext: binding, resources: { hostIds: resources.hostIds, systemDiskIds: resources.systemDiskIds } });
    expect(inventoryLog.message).not.toContain(account.accessKeySecret);
  });

  it.each(['missing binding', 'changed identity'])('refuses cloud cleanup with %s instead of using the current account as absence proof', async reason => {
    const f = await fixture('destroy');
    if (reason === 'missing binding') await f.repository.updateRangeInstance(f.instance.id, { resourceSummary: resources });
    else f.system.getAccountContextById.mockResolvedValue({ ...account, accountUid: 'changed-uid' });
    await f.worker.process(f.job.id);
    expect(f.provisioner.destroy).not.toHaveBeenCalled(); expect(f.query).not.toHaveBeenCalled();
    expect(await f.repository.getRangeInstanceById(f.instance.id)).toMatchObject({ status: 'destroy_failed', resourceSummary: { hostIds: resources.hostIds } });
  });

  it('preserves known IDs and open ledgers when destroy CLI succeeds but independent evidence is malformed', async () => {
    const f = await fixture('destroy'); f.query.mockResolvedValue({});
    await f.worker.process(f.job.id);
    expect(f.provisioner.destroy).toHaveBeenCalledTimes(1);
    expect(await f.repository.getRangeInstanceById(f.instance.id)).toMatchObject({ status: 'destroy_failed', resourceSummary: { hostIds: resources.hostIds, executionContext: binding } });
    expect((await f.repository.listBillingLedgerResources()).every(row => !row.releasedAt)).toBe(true);
  });

  it('keeps the resource inventory if releasing billing fails after verified cloud deletion', async () => {
    const f = await fixture('destroy');
    const original = f.repository.updateBillingLedgerResource.bind(f.repository);
    f.repository.updateBillingLedgerResource = jest.fn(async (id, input) => { if (input.releasedAt) throw new Error('Injected release failure'); return original(id,input); });
    await f.worker.process(f.job.id);
    expect(await f.repository.getRangeInstanceById(f.instance.id)).toMatchObject({ status: 'destroy_failed', resourceSummary: { hostIds: resources.hostIds } });
    expect((await f.repository.listProvisionJobStepLogs(f.job.id)).some(log => log.stepName === FAILED_CREATE_CLEANUP_PROOF_STEP)).toBe(false);
  });

  it.each([true,false])('retains partial-create inventory and bills until independent deletion is proven: malformed=%s', async malformed => {
    const f = await fixture();
    f.provisioner.create.mockImplementationOnce(async input => { await input.onApplyStart!(); throw new Error('Injected apply interruption after partial allocation'); });
    if (malformed) f.query.mockResolvedValue({ Code: 'Forbidden', RequestId: 'denied' });
    await f.worker.process(f.job.id);
    expect(f.provisioner.inspectResources).toHaveBeenCalledWith(expect.objectContaining({ requirePersistedState: true }));
    const current = await f.repository.getRangeInstanceById(f.instance.id);
    expect(current?.status).toBe(malformed ? 'destroy_failed' : 'create_failed');
    if (malformed) expect(current?.resourceSummary).toMatchObject({ hostIds: resources.hostIds, creationAttempted: true, executionContext: binding });
    else expect(current?.resourceSummary).toBeNull();
    expect((await f.repository.listBillingLedgerResources()).every(row => Boolean(row.releasedAt) === !malformed)).toBe(true);
    expect((await f.repository.listProvisionJobStepLogs(f.job.id)).some(log => log.stepName === FAILED_CREATE_CLEANUP_PROOF_STEP)).toBe(!malformed);
  });

  it('requires persisted state when durable intent survives complete workspace loss and never silently creates again', async () => {
    const f = await fixture();
    await f.repository.updateRangeInstance(f.instance.id, { resourceSummary: { mode: 'opentofu', executionContext: binding, creationAttempted: true } });
    f.provisioner.create.mockImplementation(async input => { expect(input.requirePersistedState).toBe(true); throw new Error('Persisted state is missing'); });
    f.provisioner.inspectResources.mockRejectedValue(new Error('Persisted state is missing'));
    await f.worker.process(f.job.id); await f.worker.process(f.job.id);
    expect(f.provisioner.create).toHaveBeenCalledTimes(1); expect(f.provisioner.destroy).not.toHaveBeenCalled();
    expect(await f.repository.getRangeInstanceById(f.instance.id)).toMatchObject({ status: 'destroy_failed', resourceSummary: { creationAttempted: true, executionContext: binding } });
  });

  it('soft-aborts the running CLI after claim loss and never lets the stale worker clean or overwrite the newer claim', async () => {
    jest.useFakeTimers();
    try {
      const f = await fixture(); let started!: () => void; const start = new Promise<void>(resolve => { started = resolve; });
      f.provisioner.create.mockImplementation(async input => { await input.onApplyStart!(); started(); return await new Promise((_,reject) => input.signal!.addEventListener('abort', () => reject(input.signal!.reason), { once: true })); });
      const running = f.worker.process(f.job.id); await start;
      await f.repository.updateProvisionJob(f.job.id, { status: 'cancelled' });
      await f.repository.updateRangeInstance(f.instance.id, { lastJobId: 'newer-claim' });
      await jest.advanceTimersByTimeAsync(30_001); await running;
      expect(f.provisioner.destroy).not.toHaveBeenCalled();
      expect(await f.repository.getRangeInstanceById(f.instance.id)).toMatchObject({ lastJobId: 'newer-claim', resourceSummary: { creationAttempted: true } });
    } finally { jest.useRealTimers(); }
  });

  it('refuses a new apply after expiry without dropping the account binding', async () => {
    const f = await fixture();
    await f.repository.updateRangeInstance(f.instance.id, { expiresAt: new Date(Date.now()-1000) });
    f.provisioner.inspectResources.mockResolvedValue(null);
    let mutated = false;
    f.provisioner.create.mockImplementation(async input => { await input.onApplyStart!(); mutated = true; return output; });
    await f.worker.process(f.job.id);
    expect(mutated).toBe(false); expect((await f.repository.getProvisionJobById(f.job.id))?.status).toBe('failed');
  });
});
