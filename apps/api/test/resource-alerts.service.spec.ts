import { ResourceAlertsService } from '../src/admin/resource-alerts.service';
import { ResourcePatrolCloudClient } from '../src/admin/resource-patrol-cloud-client';
import { runInCloudWorkspace } from '../src/auth/cloud-workspace-scope';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';
import { createMemoryResourcePatrolRepository } from './support/create-memory-resource-patrol-repository';

const scope = { cloudWorkspaceId:'space-a',provider:'alibaba_cloud' as const,accountUid:'uid-a' };
const manager = { id:'admin',username:'admin',role:'admin' as const,isPlatformManager:true };
const context = { provider:'alibaba_cloud',cloudAccountUid:'uid-a',cloudAccountContextId:'ctx-a',regionId:'cn-hangzhou',zoneId:'cn-hangzhou-j' };
const cloudRow = (type: string,id: string,parentId: string|null = null) => ({type,id,parentId,tags:{CreatedBy:'cyber-range-platform'},systemDisk:type==='disk',attachedInstanceId:null,raw:{}});
async function fixture(provider: 'alibaba_cloud'|'tencent_cloud' = 'alibaba_cloud') {
  const workspaceScope={...scope,provider,accountUid:provider==='tencent_cloud'?'uid-t':'uid-a'};
  const frozenContext={...context,provider,cloudAccountUid:workspaceScope.accountUid,
    regionId:provider==='tencent_cloud'?'ap-nanjing':context.regionId,zoneId:provider==='tencent_cloud'?'ap-nanjing-1':context.zoneId};
  const repository = createMemoryAdminRepository();
  const store = createMemoryResourcePatrolRepository(repository,{ managerUserId:'admin',managerUsername:'admin',...workspaceScope,cloudAccountContextId:'ctx-a' });
  const account = { provider,cloudAccountContextId:'ctx-a',accountUid:workspaceScope.accountUid,accountUidResolved:true,
    defaultRegion:frozenContext.regionId,defaultZoneId:frozenContext.zoneId,accessKeyId:'fixture',accessKeySecret:'fixture',imageImportBucket:'' };
  const config = { runInWorkspace: async (id: string,work: () => Promise<any>) => runInCloudWorkspace({...workspaceScope,cloudWorkspaceId:id},work),
    getExecutionAccountContext: jest.fn(async () => account) };
  const cloud = {verifyAccount:jest.fn(async (_account: any) => undefined),inspect:jest.fn(async (_account: any,_known: any,_candidateIds?:any): Promise<any[]> => []),
    exact:jest.fn(async (_account:any,_ids:any,_parents?:any):Promise<any[]>=>[])};
  const service = new ResourceAlertsService(repository,config as any,store,cloud as unknown as ResourcePatrolCloudClient);
  const instance = await runInCloudWorkspace(workspaceScope,async () => {
    const row = await repository.createRangeInstance({name:'historical',status:'destroyed',instanceMode:'range',cloudProvider:provider});
    const source = await repository.createProvisionJob({rangeInstanceId:row.id,jobType:'create',triggeredBy:'admin'});
    await repository.updateProvisionJob(source.id,{status:'failed',startedAt:new Date('2026-10-13T00:00:00Z')});
    const summary = { mode:'opentofu',executionContext:frozenContext,hostIds:{node:'i-real'},systemDiskIds:{node:'d-real'},vpcId:'vpc-real',natGatewayIds:{main:'ngw-real'} };
    await repository.createProvisionJobStepLog({jobId:source.id,stepName:'range_resource_inventory',status:'succeeded',message:JSON.stringify({
      version:1,rangeInstanceId:row.id,executionContext:frozenContext,resources:summary})});
    return repository.updateRangeInstance(row.id,{lastJobId:source.id,resourceSummary:null});
  });
  return {repository,store,config,cloud,service,instance,workspaceScope,frozenContext};
}

describe('current-account residual patrol',() => {
  it('reads historical IDs after runtime state was cleared and never claims tag-only copies',async () => {
    const f = await fixture();
    f.cloud.inspect.mockResolvedValue([cloudRow('ecs','i-real'),cloudRow('eip','eip-forged')] as never[]);
    await f.service.scanCurrent();
    expect(f.cloud.inspect.mock.calls[0][1]).toEqual(expect.arrayContaining([{type:'ecs',id:'i-real'},{type:'vpc',id:'vpc-real'}]));
    expect(f.store.alerts.find(row => row.resourceId==='i-real')).toMatchObject({status:'pending',rangeInstanceId:f.instance.id});
    const forged = f.store.alerts.find(row => row.resourceId==='eip-forged')!;
    expect(forged.status).toBe('unverified');
    await runInCloudWorkspace(scope,async () => expect((await f.service.preview(manager,forged.id)).reclaimable).toBe(false));
    expect(await runInCloudWorkspace(scope,() => f.repository.getRangeInstanceById(f.instance.id))).toMatchObject({status:'destroyed',resourceSummary:null});
  });
  it('does not close existing alerts when cloud pagination or permissions fail',async () => {
    const f=await fixture(); f.cloud.inspect.mockResolvedValue([cloudRow('ecs','i-real')] as never[]); await f.service.scanCurrent();
    f.cloud.inspect.mockRejectedValue(new Error('incomplete pagination')); await f.service.scanCurrent();
    expect(f.store.alerts[0].status).toBe('pending'); expect(f.store.settingsValue.lastScanError).toBeTruthy();
    f.cloud.inspect.mockResolvedValue([]); await f.service.scanCurrent(); expect(f.store.alerts[0].status).toBe('resolved');
  });
  it('merges repeat discoveries and rejects non-manager and cross-workspace access',async () => {
    const f=await fixture(); f.cloud.inspect.mockResolvedValue([cloudRow('ecs','i-real')] as never[]); await f.service.scanCurrent(); await f.service.scanCurrent();
    expect(f.store.alerts).toHaveLength(1);
    await expect(f.service.getPatrol({...manager,isPlatformManager:false})).rejects.toThrow();
    await runInCloudWorkspace({...scope,cloudWorkspaceId:'space-b',accountUid:'uid-b'},async () => expect(f.service.preview(manager,f.store.alerts[0].id)).rejects.toThrow());
  });
  it('keeps inspections single-flight across services sharing the persistent lease',async () => {
    const f=await fixture(); let release!:()=>void; const gate=new Promise<void>(resolve=>{release=resolve;});
    f.cloud.inspect.mockImplementation(async()=>{await gate;return []});
    const first=f.service.scanCurrent(); await new Promise(resolve=>setImmediate(resolve));
    await expect(f.service.scanCurrent()).resolves.toMatchObject({skipped:true}); release(); await first;
    expect(f.cloud.inspect).toHaveBeenCalledTimes(1);
  });
  it('follows only the designated manager default and aborts after account switch',async () => {
    const f=await fixture(); f.cloud.inspect.mockImplementation(async()=>{f.store.targetValue.cloudWorkspaceId='space-b';return [cloudRow('ecs','i-real')] as never[];});
    await f.service.scanCurrent(); expect(f.store.alerts).toHaveLength(0); expect(f.store.settingsValue.lastScanError).toBeTruthy();
    expect(f.cloud.verifyAccount).toHaveBeenCalledTimes(1);
  });
  it('previews all remaining resources, rechecks changed plans and queues one frozen destroy',async () => {
    const f=await fixture(); f.cloud.inspect.mockResolvedValue([cloudRow('ecs','i-real'),cloudRow('nat_gateway','ngw-real','vpc-real')] as never[]); await f.service.scanCurrent();
    await runInCloudWorkspace(scope,async()=>{
      const alert=f.store.alerts[0]; const plan=await f.service.preview(manager,alert.id);
      expect(plan).toMatchObject({reclaimable:true,resources:[{type:'ecs',id:'i-real'},{type:'nat_gateway',id:'ngw-real'}]});
      f.cloud.inspect.mockResolvedValue([cloudRow('ecs','i-real')] as never[]);
      await expect(f.service.reclaim(manager,alert.id,{planDigest:plan.planDigest,idempotencyKey:'first'})).rejects.toThrow('清单已变化');
      f.cloud.inspect.mockResolvedValue([cloudRow('ecs','i-real'),cloudRow('nat_gateway','ngw-real','vpc-real')] as never[]);
      const one=await f.service.reclaim(manager,alert.id,{planDigest:plan.planDigest,idempotencyKey:'first'});
      const two=await f.service.reclaim(manager,alert.id,{planDigest:plan.planDigest,idempotencyKey:'different'});
      expect(one.jobId).toBe(two.jobId);
      expect((await f.repository.listProvisionJobs()).filter(job=>job.jobType==='destroy')).toHaveLength(1);
      expect(await f.repository.getRangeInstanceById(f.instance.id)).toMatchObject({status:'pending_destroy',resourceSummary:{executionContext:context}});
    });
  });
  it('blocks active instances and foreign dependants in an owned VPC',async () => {
    const f=await fixture(); f.cloud.inspect.mockResolvedValue([cloudRow('ecs','i-real')] as never[]); await f.service.scanCurrent();
    await runInCloudWorkspace(scope,async()=>{
      await f.repository.updateRangeInstance(f.instance.id,{status:'running'});
      expect((await f.service.preview(manager,f.store.alerts[0].id)).reclaimable).toBe(false);
      await f.repository.updateRangeInstance(f.instance.id,{status:'destroyed'});
      f.cloud.inspect.mockResolvedValue([cloudRow('ecs','i-real'),cloudRow('ecs','i-foreign','vpc-real')] as never[]);
      expect((await f.service.preview(manager,f.store.alerts[0].id)).reason).toContain('关联资源');
    });
  });
  it('keeps a failed cleanup and resolves it only after an independent complete absence check',async()=>{
    const f=await fixture();f.cloud.inspect.mockResolvedValue([cloudRow('ecs','i-real')] as never[]);await f.service.scanCurrent();
    await runInCloudWorkspace(scope,async()=>{
      const plan=await f.service.preview(manager,f.store.alerts[0].id);const result=await f.service.reclaim(manager,plan.alertId,{planDigest:plan.planDigest,idempotencyKey:'cleanup'});
      await f.repository.updateProvisionJob(result.jobId,{status:'failed'});await f.repository.updateRangeInstance(f.instance.id,{status:'destroy_failed'});
    });
    await f.service.scanCurrent();expect(f.store.alerts[0].status).toBe('failed');expect(f.store.alerts[0].remainingResources).toEqual([{type:'ecs',id:'i-real'}]);
    f.cloud.inspect.mockResolvedValue([]);await f.service.scanCurrent();expect(f.store.alerts[0].status).toBe('resolved');
  });
  it('does not classify a reusable shared network pool as an orphan',async()=>{
    const f=await fixture();
    await runInCloudWorkspace(scope,()=>f.repository.upsertSingleInstanceNetworkProfile({provider:'alibaba_cloud',cloudAccountUid:'uid-a',
      regionId:'cn-hangzhou',zoneId:'cn-hangzhou-j',vpcId:'vpc-pool',vpcCidr:'10.42.0.0/16',vswitchIds:['vsw-pool'],vswitchCidrs:['10.42.0.0/24'],
      securityGroupId:'sg-pool',securityGroupName:'pool'}));
    f.cloud.inspect.mockResolvedValue([cloudRow('vpc','vpc-pool'),cloudRow('vswitch','vsw-pool','vpc-pool')] as never[]);
    await f.service.scanCurrent();expect(f.store.alerts).toHaveLength(0);
  });
  it('rechecks lifecycle after a slow cloud read and preserves alerts while a job begins',async()=>{
    const f=await fixture();f.cloud.inspect.mockResolvedValue([cloudRow('ecs','i-real')] as never[]);await f.service.scanCurrent();
    f.cloud.inspect.mockImplementation(async()=>{
      await runInCloudWorkspace(scope,()=>f.repository.updateRangeInstance(f.instance.id,{status:'pending_destroy'}));return [];
    });
    await f.service.scanCurrent();expect(f.store.alerts[0].status).toBe('pending');
  });
  it('preserves proven failed-creation costs and reopens an incorrectly released ledger without adopting a tagged copy',async()=>{
    const f=await fixture();
    await runInCloudWorkspace(scope,async()=>{
      const row=await f.repository.createBillingLedgerResource({cloudProvider:'alibaba_cloud',cloudAccountUid:'uid-a',regionId:'cn-hangzhou',
        cloudResourceId:'i-real',cloudResourceType:'ecs',billingScope:'platform',ownerUserId:null,rangeInstanceId:f.instance.id,singleInstanceBatchId:null,
        sourceProvisionJobId:f.instance.lastJobId,billingStartAt:new Date('2026-10-13T00:00:00Z')});
      await f.repository.updateBillingLedgerResource(row.id,{releasedAt:new Date('2026-10-13T00:05:00Z')});
    });
    f.cloud.inspect.mockResolvedValue([cloudRow('ecs','i-real'),cloudRow('eip','eip-external')] as never[]);await f.service.scanCurrent();
    await runInCloudWorkspace(scope,async()=>{
      const ledgers=await f.repository.listBillingLedgerResources();expect(ledgers).toHaveLength(1);
      expect(ledgers[0]).toMatchObject({cloudResourceId:'i-real',releasedAt:null,sourceProvisionJobId:f.instance.lastJobId});
      const logs=await f.repository.listProvisionJobStepLogs(f.instance.lastJobId!);
      expect(logs.find(log=>log.stepName==='resource_patrol_billing_continues')?.message).toContain('previousReleasedAt');
    });
  });
  it('keeps Tencent source identity and deletion jobs separate from Alibaba account resources',async()=>{
    const f=await fixture('tencent_cloud');
    f.cloud.inspect.mockResolvedValue([cloudRow('ecs','i-real')] as never[]);await f.service.scanCurrent();
    expect(f.store.alerts[0]).toMatchObject({provider:'tencent_cloud',accountUid:'uid-t',regionId:'ap-nanjing'});
    await runInCloudWorkspace(f.workspaceScope,async()=>{
      const plan=await f.service.preview(manager,f.store.alerts[0].id);
      expect(plan.reclaimable).toBe(true);
      const reclaimed=await f.service.reclaim(manager,plan.alertId,{planDigest:plan.planDigest,idempotencyKey:'tencent'});
      expect((await f.repository.getRangeInstanceById(f.instance.id))?.resourceSummary?.executionContext).toEqual(f.frozenContext);
      expect(await f.repository.getProvisionJobById(reclaimed.jobId)).toMatchObject({jobType:'destroy',cloudWorkspaceId:f.workspaceScope.cloudWorkspaceId});
    });
    await runInCloudWorkspace(scope,()=>expect(f.service.preview(manager,f.store.alerts[0].id)).rejects.toThrow('身份'));
  });
  it('rejects an originally owned network interface now attached to a different cloud host',async()=>{
    const f=await fixture();
    await runInCloudWorkspace(scope,async()=>{
      await f.repository.createProvisionJobStepLog({jobId:f.instance.lastJobId!,stepName:'range_resource_inventory',status:'succeeded',message:JSON.stringify({
        version:1,rangeInstanceId:f.instance.id,executionContext:context,resources:{secondaryNetworkInterfaceIds:{aux:'eni-original'}}})});
    });
    f.cloud.inspect.mockResolvedValue([{...cloudRow('eni','eni-original','vpc-real'),attachedInstanceId:'i-external'}] as never[]);await f.service.scanCurrent();
    await runInCloudWorkspace(scope,async()=>expect((await f.service.preview(manager,f.store.alerts[0].id)).reason).toContain('其他云主机'));
  });
  it('checks previous candidates by exact ID even after tag removal without granting deletion permission',async()=>{
    const f=await fixture();f.cloud.inspect.mockResolvedValue([cloudRow('eip','eip-unproven')] as never[]);await f.service.scanCurrent();
    expect(f.store.alerts[0].status).toBe('unverified');
    f.cloud.inspect.mockResolvedValue([{...cloudRow('eip','eip-unproven'),tags:{}}] as never[]);await f.service.scanCurrent();
    expect(f.cloud.inspect.mock.calls.at(-1)?.[2]).toEqual([{type:'eip',id:'eip-unproven'}]);
    expect(f.store.alerts[0].status).toBe('unverified');
    f.cloud.inspect.mockResolvedValue([]);await f.service.scanCurrent();expect(f.store.alerts[0].status).toBe('resolved');
    expect(f.cloud.exact.mock.calls).toHaveLength(2);
    expect(f.cloud.exact.mock.calls.every(([account,ids])=>account.accountUid==='uid-a'&&account.defaultRegion==='cn-hangzhou'
      && JSON.stringify(ids)===JSON.stringify([{type:'eip',id:'eip-unproven'}]))).toBe(true);
    await runInCloudWorkspace(scope,()=>expect(f.repository.listBillingLedgerResources()).resolves.toEqual([]));
    await runInCloudWorkspace(scope,()=>expect(f.repository.listProvisionJobs()).resolves.toHaveLength(1));
  });
  it.each(['failed-read','reappeared','account-switch'] as const)('retains an unverified candidate when second exact absence check is %s',async situation=>{
    const f=await fixture();f.cloud.inspect.mockResolvedValue([cloudRow('eip','eip-unproven')] as never[]);await f.service.scanCurrent();
    f.cloud.inspect.mockResolvedValue([]);
    if(situation==='failed-read')f.cloud.exact.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('Forbidden'));
    if(situation==='reappeared')f.cloud.exact.mockResolvedValueOnce([]).mockResolvedValueOnce([cloudRow('eip','eip-unproven')] as never[]);
    if(situation==='account-switch')f.cloud.exact.mockImplementationOnce(async()=>{f.store.targetValue.cloudWorkspaceId='space-b';return [];});
    await f.service.scanCurrent();expect(f.store.alerts[0].status).toBe('unverified');
    if(situation!=='reappeared')expect(f.store.settingsValue.lastScanError).toBeTruthy();
    await runInCloudWorkspace(scope,()=>expect(f.repository.listBillingLedgerResources()).resolves.toEqual([]));
  });
  it('retains excluded legacy snapshot alerts instead of interpreting an unsupported exact lookup as absence',async()=>{
    const f=await fixture();f.cloud.inspect.mockResolvedValue([cloudRow('eip','eip-unproven')] as never[]);await f.service.scanCurrent();
    Object.assign(f.store.alerts[0],{type:'snapshot',resourceId:'s-old',status:'unverified'});
    f.cloud.inspect.mockResolvedValue([]);await f.service.scanCurrent();
    expect(f.store.alerts[0].status).toBe('unverified');expect(f.cloud.exact).not.toHaveBeenCalled();
    await runInCloudWorkspace(scope,()=>expect(f.repository.listBillingLedgerResources()).resolves.toEqual([]));
  });
  it('does not write old-account billing after the manager switches between alert recording and ledger reconciliation',async()=>{
    const f=await fixture();const record=f.store.observe.bind(f.store);
    jest.spyOn(f.store,'observe').mockImplementation(async input=>{await record(input);f.store.targetValue.cloudWorkspaceId='space-b';});
    f.cloud.inspect.mockResolvedValue([cloudRow('ecs','i-real')] as never[]);await f.service.scanCurrent();
    expect(f.store.settingsValue.lastScanError).toBeTruthy();
    await runInCloudWorkspace(scope,()=>expect(f.repository.listBillingLedgerResources()).resolves.toEqual([]));
  });
  it('records verified absence after the cloud read, never at the earlier scan scheduling time',async()=>{
    const f=await fixture();f.cloud.inspect.mockResolvedValue([cloudRow('ecs','i-real')] as never[]);await f.service.scanCurrent();
    const readCompletedAt=new Date();f.cloud.inspect.mockResolvedValue([]);
    await f.service.scanCurrent(new Date('2025-01-01T00:00:00Z'));
    await runInCloudWorkspace(scope,async()=>{
      const row=(await f.repository.listBillingLedgerResources())[0];expect(row.releasedAt!.getTime()).toBeGreaterThanOrEqual(readCompletedAt.getTime());
    });
  });
});
