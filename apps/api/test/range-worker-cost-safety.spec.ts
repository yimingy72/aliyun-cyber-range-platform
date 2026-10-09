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
  let cloudPresent = true;
  const provisioner = { mode: 'opentofu' as const,
    create: jest.fn(async (input: RangeProvisionCreateInput) => { await input.onApplyStart?.(); return output; }),
    inspectResources: jest.fn(async (_input: RangeProvisionDestroyInput): Promise<RangeResourceSummary | null> => resources),
    destroy: jest.fn(async (_input: RangeProvisionDestroyInput) => { cloudPresent = false; }),
  };
  const worker = new ProvisioningWorkerService(repository, provisioner, system as any);
  const query = jest.spyOn(worker as any, 'performAliyunRpcRequest').mockImplementation(async (input: any) => {
    const collections: Record<string, [string,string]> = { DescribeInstances: ['Instances','Instance'], DescribeDisks: ['Disks','Disk'], DescribeEipAddresses: ['EipAddresses','EipAddress'] };
    if (input.action === 'DescribeDisks' && input.parameters.InstanceId && cloudPresent) return {
      RequestId:'disk-inventory', TotalCount:1, PageNumber:1, PageSize:100, Disks:{Disk:[{DiskId:'d-owned',InstanceId:'i-owned',Type:'system',DeleteWithInstance:true}]} };
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
    expect(f.query.mock.calls.map(([input]: any[]) => input.action).sort()).toEqual(['DescribeDisks', 'DescribeDisks', 'DescribeEipAddresses', 'DescribeInstances']);
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
    const f = await fixture('destroy'); const query = f.query.getMockImplementation()!;
    f.query.mockImplementation(async (input:any) => input.action === 'DescribeDisks' && input.parameters.InstanceId ? query(input) : {});
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

  it('records inherited full-image data disks as disk charges in addition to the system disk', async () => {
    const f = await fixture(); const base = f.query.getMockImplementation()!;
    f.query.mockImplementation(async (input:any) => {
      const body:any = await base(input);
      if (input.action === 'DescribeDisks' && input.parameters.InstanceId) {
        body.Disks.Disk.push({DiskId:'d-image-data',InstanceId:'i-owned',Type:'data',DeleteWithInstance:true,
          Tags:{Tag:Object.entries({CreatedBy:'cyber-range-platform',RangeInstanceId:f.instance.id,PlatformScope:'user',PlatformUserId:'alice',
            CloudAccountUid:account.accountUid,CloudAccountContextId:account.cloudAccountContextId,PlatformResourceType:'ecs'}).map(([TagKey,TagValue])=>({TagKey,TagValue}))}});
        body.TotalCount++;
      }
      return body;
    });
    await f.worker.process(f.job.id);
    expect(await f.repository.getRangeInstanceById(f.instance.id)).toMatchObject({status:'running',resourceSummary:{dataDiskIds:{'entry:d-image-data':'d-image-data'}}});
    expect(await f.repository.listBillingLedgerResources()).toEqual(expect.arrayContaining([expect.objectContaining({cloudResourceId:'d-image-data',cloudResourceType:'disk',ownerUserId:'alice',releasedAt:null})]));
  });

  it('checks external disk deletion safety before an update can remove a topology node', async () => {
    const f = await fixture('destroy'); const base = f.query.getMockImplementation()!;
    f.query.mockImplementation(async (input:any) => {
      const body:any = await base(input);
      if (input.action === 'DescribeDisks' && input.parameters.InstanceId) { body.Disks.Disk.push({DiskId:'d-external',InstanceId:'i-owned',Type:'data',DeleteWithInstance:true}); body.TotalCount++; }
      return body;
    });
    const claimed = await f.repository.claimProvisionJob(f.job.id,new Date());
    const snapshot = { draftRevision:1,templateModulePath:'fixture/range',topologyGraph:{nodes:[],edges:[]},
      topologySpec:{vpcCidr:'10.0.0.0/16',networkZones:[],hosts:[],publicEntry:{}}, scenarioTemplateSpec:{metadata:{},topology:{},networkZones:[],hosts:[]},
      compiledProvisionSpec:{topology:{},networkZones:[],hosts:[]}, compiledSpec:{resources:[],topology:{}} };
    await expect((f.worker as any).processRangeInstanceUpdateJob({ instance:f.instance,job:{...claimed,topologySnapshot:snapshot},
      runtimeConfig:account,accountContext:account,reportStep:async()=>{},onApplyStart:()=>{} })).rejects.toThrow('unverified');
    expect(f.provisioner.create).not.toHaveBeenCalled();
    expect(await f.repository.getRangeInstanceById(f.instance.id)).toMatchObject({resourceSummary:{unverifiedDiskIds:{'entry:d-external':'d-external'}}});
    expect((await f.repository.listBillingLedgerResources()).some(row=>row.cloudResourceId==='d-external')).toBe(false);
  });

  it.each([true,false])('verifies removed host disks before closing their billing after update: retained=%s', async retained => {
    const f = await fixture('destroy'); const base = f.query.getMockImplementation()!;
    f.query.mockImplementation(async (input:any) => {
      const body:any = await base(input);
      if (input.action === 'DescribeDisks' && input.parameters.InstanceId) {
        body.Disks.Disk.push({DiskId:'d-data',InstanceId:'i-owned',Type:'data',DeleteWithInstance:false,
          Tags:{Tag:Object.entries({CreatedBy:'cyber-range-platform',RangeInstanceId:f.instance.id,PlatformScope:'user',PlatformUserId:'alice',
            CloudAccountUid:account.accountUid,CloudAccountContextId:account.cloudAccountContextId}).map(([TagKey,TagValue])=>({TagKey,TagValue}))}}); body.TotalCount++;
      } else if (retained && input.action === 'DescribeDisks' && JSON.parse(input.parameters.DiskIds).includes('d-data')) {
        body.Disks.Disk = [{DiskId:'d-data'}]; body.TotalCount = 1;
      }
      return body;
    });
    f.provisioner.create.mockImplementation(async () => { await f.provisioner.destroy({} as any); return {...output,resourceSummary:{mode:'opentofu',hostIds:{},systemDiskIds:{},eipAllocationIds:resources.eipAllocationIds}}; });
    const claimed=await f.repository.claimProvisionJob(f.job.id,new Date());
    const snapshot={draftRevision:1,templateModulePath:'fixture/range',topologyGraph:{nodes:[],edges:[]},
      topologySpec:{vpcCidr:'10.0.0.0/16',networkZones:[],hosts:[],publicEntry:{}},scenarioTemplateSpec:{metadata:{},topology:{},networkZones:[],hosts:[]},
      compiledProvisionSpec:{topology:{},networkZones:[],hosts:[]},compiledSpec:{resources:[],topology:{}}};
    jest.spyOn(f.repository,'completeRangeInstanceDraftApply').mockImplementation(async (id, patch) => f.repository.updateRangeInstance(id,{resourceSummary:patch.resourceSummary}));
    const operation = (f.worker as any).processRangeInstanceUpdateJob({instance:f.instance,job:{...claimed,topologySnapshot:snapshot},
      runtimeConfig:account,accountContext:account,reportStep:async()=>{},onApplyStart:()=>{}});
    if (retained) {
      await expect(operation).rejects.toThrow('Replaced range resources remain');
      expect(await f.repository.getRangeInstanceById(f.instance.id)).toMatchObject({resourceSummary:{hostIds:{},retiredResources:{hostIds:{'i-owned':'i-owned'},systemDiskIds:{'d-owned':'d-owned'},dataDiskIds:{'d-data':'d-data'}}}});
    } else {
      await expect(operation).resolves.toBeUndefined();
      expect(await f.repository.getRangeInstanceById(f.instance.id)).toMatchObject({resourceSummary:{hostIds:{},retiredResources:null}});
    }
    const ledger=await f.repository.listBillingLedgerResources();
    expect(ledger.filter(row=>['i-owned','d-owned','d-data'].includes(row.cloudResourceId)).every(row=>Boolean(row.releasedAt)!==retained)).toBe(true);
    expect(ledger.find(row=>row.cloudResourceId==='eip-owned')?.releasedAt).toBeNull();
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
