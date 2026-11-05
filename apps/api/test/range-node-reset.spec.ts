import { ConflictException, ForbiddenException } from '@nestjs/common';
import { RangeNodeResetService } from '../src/admin/range-node-reset.service';
import { RangeNodeResetCloudClient, NodeResetCloudError } from '../src/admin/range-node-reset-cloud.client';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';
import { runInCloudWorkspace } from '../src/auth/cloud-workspace-scope';
import { RangesController } from '../src/admin/ranges.controller';
import { OperationControlService } from '../src/operations/operation-control.service';
import { assertDelegatedApiScopes } from '../src/auth/delegated-api-scopes';
import { ProvisioningWorkerService } from '../src/provisioning/provisioning-worker.service';

const scope={cloudWorkspaceId:'space-reset',provider:'alibaba_cloud' as const,accountUid:'1000001'};
const actor={id:'user-a',role:'user' as const};
const context={provider:'alibaba_cloud' as const,cloudAccountContextId:'ctx-reset',cloudAccountUid:scope.accountUid,regionId:'cn-beijing',zoneId:'cn-beijing-h'};
const account={provider:'alibaba_cloud' as const,cloudAccountContextId:context.cloudAccountContextId,accountUid:scope.accountUid,accountUidResolved:true,
  defaultRegion:context.regionId,defaultZoneId:context.zoneId,accessKeyId:'fixture-key',accessKeySecret:'fixture-secret',imageImportBucket:''};
const inSpace=<T>(work:()=>Promise<T>)=>runInCloudWorkspace(scope,work);
async function fixture(power:'Running'|'Stopped'='Running') {
  const repository=createMemoryAdminRepository();
  const summary={mode:'opentofu' as const,executionContext:context,hostIds:{host:'i-original'},systemDiskIds:{host:'d-system'},
    diskInventoryHostIds:{host:'i-original'},diskOwnershipProofs:{'d-system':{instanceId:'i-original',method:'persisted' as const,deleteWithInstance:true}},
    vpcId:'vpc-original',subnetIds:{lan:'vsw-original'},securityGroupIds:{host:'sg-original'}};
  let instance=await repository.createRangeInstance({name:'reset-test',status:'running',cloudProvider:'alibaba_cloud',instanceMode:'range',ownerUserId:actor.id,
    expiresAt:new Date(Date.now()+3600_000).toISOString(),runtimeTopologyGraph:{nodes:[{id:'host',kind:'ecs',label:'Test Node',imageId:'m-original'},
      {id:'peer',kind:'ecs',label:'Untouched Node',imageId:'m-original'}]},resourceSummary:summary,
    runtimeCredentials:{host:{username:'root',password:'SyntheticPassword9!'}}});
  const source=await repository.createProvisionJob({rangeInstanceId:instance.id,jobType:'create',triggeredBy:actor.id});
  await repository.updateProvisionJob(source.id,{status:'succeeded',startedAt:new Date(Date.now()-60_000),finishedAt:new Date()});
  await repository.createProvisionJobStepLog({jobId:source.id,stepName:'range_resource_creation_receipt',status:'succeeded',message:JSON.stringify({
    version:1,rangeInstanceId:instance.id,cloudWorkspaceId:scope.cloudWorkspaceId,sourceJobId:source.id,ownerUserId:actor.id,cloudProvider:'alibaba_cloud',
    executionContext:context,resources:[{type:'ecs',providerResourceType:'alicloud_instance',address:'module.range.alicloud_instance.hosts["host"]',id:'i-original',logicalKey:'host',action:'create'}]})});
  await repository.createProvisionJobStepLog({jobId:source.id,stepName:'range_resource_inventory',status:'succeeded',message:JSON.stringify({
    version:1,rangeInstanceId:instance.id,executionContext:context,resources:summary})});
  instance=await repository.updateRangeInstance(instance.id,{lastJobId:source.id});
  for(const [type,id] of [['ecs','i-original'],['disk','d-system']] as const) await repository.createBillingLedgerResource({
    cloudProvider:'alibaba_cloud',cloudAccountUid:scope.accountUid,regionId:context.regionId,cloudResourceId:id,cloudResourceType:type,
    billingScope:'user',ownerUserId:actor.id,rangeInstanceId:instance.id,singleInstanceBatchId:null,sourceProvisionJobId:source.id,billingStartAt:new Date(Date.now()-60_000)});
  const tags={CreatedBy:'cyber-range-platform',RangeInstanceId:instance.id,CloudAccountUid:scope.accountUid,CloudAccountContextId:context.cloudAccountContextId,
    PlatformManaged:'true',PlatformHostKey:'host',PlatformResourceType:'ecs',ExecutionBackend:'opentofu',CloudProvider:'alibaba_cloud',
    PlatformCreateJobId:source.id,PlatformUserId:actor.id};
  const host:any={InstanceId:'i-original',ImageId:'m-original',RegionId:context.regionId,Status:power,
    AutoReleaseTime:new Date(Date.now()+3900_000).toISOString(),Tags:{Tag:Object.entries(tags).map(([TagKey,TagValue])=>({TagKey,TagValue}))},
    VpcAttributes:{VpcId:'vpc-original',VSwitchId:'vsw-original',PrivateIpAddress:{IpAddress:['10.0.10.10']}},
    PublicIpAddress:{IpAddress:[]},SecurityGroupIds:{SecurityGroupId:['sg-original']},NetworkInterfaces:{NetworkInterface:[{NetworkInterfaceId:'eni-original'}]}};
  const system:any={DiskId:'d-system',ImageId:'m-original',Type:'system',InstanceId:'i-original',Status:'In_use',DeleteWithInstance:true,MultiAttach:'Disabled'};
  const data:any={DiskId:'d-data-kept',Type:'data',InstanceId:'i-original',Status:'In_use'};
  const cloud={verifyAccount:jest.fn(async()=>undefined),host:jest.fn(async(_a:any,id:string)=>{if(id!=='i-original')throw new Error('Wrong host');return structuredClone(host);}),
    disks:jest.fn(async()=>structuredClone([system,data])),disk:jest.fn(async()=>structuredClone(system)),image:jest.fn(async()=>({ImageId:'m-original',Status:'Available'})),
    stop:jest.fn(async()=>{host.Status='Stopped';return{requestId:'stop-receipt'};}),
    start:jest.fn(async()=>{host.Status='Running';return{requestId:'start-receipt'};}),reinitialize:jest.fn(async()=>({requestId:'reset-receipt'}))};
  const config={getExecutionAccountContext:jest.fn(async()=>({...account}))};
  const dns={verify:jest.fn(async()=>({status:'verified'}))};
  const service=new RangeNodeResetService(repository,config as any,cloud as unknown as RangeNodeResetCloudClient,dns as any);
  const accepted=async()=>{
    const preview=await service.preview(instance.id,'host',actor);
    const result=await service.enqueue(instance.id,'host',{planDigest:preview.planDigest,confirmedNodeName:preview.nodeName},actor);
    const job=await repository.claimRangeProvisionJob(result.jobId,new Date());if(!job)throw new Error('No claim');
    return job;
  };
  return {repository,instance,source,host,system,data,cloud,config,dns,service,accepted};
}

describe('range node system disk reset',()=>{
  it.each(['Running','Stopped'] as const)('resets only the proven system disk and restores %s without changing identities, expiry or billing',async power=>inSpace(async()=>{
    const f=await fixture(power),before=await f.repository.listBillingLedgerResources();
    const job=await f.accepted();await f.service.execute(job,async()=>undefined);
    expect(f.cloud.reinitialize).toHaveBeenCalledTimes(1);
    expect(f.cloud.reinitialize).toHaveBeenCalledWith(expect.objectContaining({accountUid:scope.accountUid}),'d-system','SyntheticPassword9!');
    expect(f.host.Status).toBe(power);
    expect(f.system.DiskId).toBe('d-system');expect(f.data.DiskId).toBe('d-data-kept');
    expect(await f.repository.listBillingLedgerResources()).toEqual(before);
    expect((await f.repository.getRangeInstanceById(f.instance.id))?.expiresAt).toEqual(f.instance.expiresAt);
    expect((await f.repository.listProvisionJobStepLogs(job.id)).find(step=>step.stepName==='node_reset_verified')).toMatchObject({status:'succeeded'});
    expect((await f.repository.listProvisionJobStepLogs(job.id)).some(step=>step.message?.includes('SyntheticPassword9!'))).toBe(false);
    expect(f.cloud.host.mock.calls.every(call=>call[1]==='i-original')).toBe(true);
  }));
  it('requires two-phase confirmation for browser requests and replays the same reset job',async()=>inSpace(async()=>{
    const f=await fixture(),controller=new RangesController({} as any,{} as any,new OperationControlService(f.repository),f.service);
    const preview=await f.service.preview(f.instance.id,'host',actor),input={planDigest:preview.planDigest,confirmedNodeName:preview.nodeName};
    const request:any={adminUser:actor,authContext:{user:actor,source:'web',oauthClientId:'platform-web'},headers:{'x-idempotency-key':'reset-one'}};
    let challenge:any;
    try{await controller.runNodeAction(request,f.instance.id,'host','reset',input);}catch(error){challenge=(error as ConflictException).getResponse();}
    expect(challenge).toMatchObject({code:'CONFIRMATION_REQUIRED',summary:{systemDiskDataWillBeLost:true,dataDisksReset:false}});
    expect(f.cloud.stop).not.toHaveBeenCalled();expect((await f.repository.listProvisionJobs()).filter(job=>job.jobType==='reset')).toHaveLength(0);
    request.headers['x-confirmation-id']=challenge.confirmationId;
    const first:any=await controller.runNodeAction(request,f.instance.id,'host','reset',input);
    const second:any=await controller.runNodeAction(request,f.instance.id,'host','reset',input);
    expect(first.jobId).toBeTruthy();expect(second.jobId).toBe(first.jobId);
    expect((await f.repository.listProvisionJobs()).filter(job=>job.jobType==='reset')).toHaveLength(1);
    expect(f.cloud.reinitialize).not.toHaveBeenCalled();
  }));
  it('rejects missing typed confirmation, scripts and changed preview facts before dispatch',async()=>inSpace(async()=>{
    const f=await fixture(),preview=await f.service.preview(f.instance.id,'host',actor);
    expect(()=>f.service.validateInput({planDigest:preview.planDigest,confirmedNodeName:'Test Node',script:'wipe'})).toThrow();
    await expect(f.service.enqueue(f.instance.id,'host',{planDigest:preview.planDigest,confirmedNodeName:'Wrong'},actor)).rejects.toThrow();
    f.host.Status='Stopped';
    await expect(f.service.enqueue(f.instance.id,'host',{planDigest:preview.planDigest,confirmedNodeName:'Test Node'},actor)).rejects.toThrow();
    expect(f.cloud.reinitialize).not.toHaveBeenCalled();
  }));
  it.each(['owner','account','disk-type','disk-image','missing-proof','host-tags','expiry'] as const)('rejects unsafe %s before any stop/reset',async mismatch=>inSpace(async()=>{
    const f=await fixture();
    if(mismatch==='owner') await expect(f.service.preview(f.instance.id,'host',{id:'other',role:'user'})).rejects.toBeInstanceOf(ForbiddenException);
    else {
      if(mismatch==='account') f.config.getExecutionAccountContext.mockResolvedValue({...account,accountUid:'different'});
      if(mismatch==='disk-type') f.system.Type='data';
      if(mismatch==='disk-image') f.system.ImageId='m-foreign';
      if(mismatch==='missing-proof') await f.repository.updateRangeInstance(f.instance.id,{resourceSummary:{...f.instance.resourceSummary!,diskOwnershipProofs:{}}});
      if(mismatch==='host-tags') f.host.Tags.Tag=f.host.Tags.Tag.filter((tag:any)=>tag.TagKey!=='PlatformCreateJobId');
      if(mismatch==='expiry') await f.repository.updateRangeInstance(f.instance.id,{expiresAt:new Date(Date.now()+30_000)});
      await expect(f.service.preview(f.instance.id,'host',actor)).rejects.toThrow();
    }
    expect(f.cloud.stop).not.toHaveBeenCalled();expect(f.cloud.reinitialize).not.toHaveBeenCalled();
  }));
  it('never resubmits a disk reset whose intent has no receipt after worker interruption',async()=>inSpace(async()=>{
    const f=await fixture(),job=await f.accepted();
    await f.repository.createProvisionJobStepLog({jobId:job.id,stepName:'node_reset_reinit_intent',status:'succeeded',message:'persisted'});
    await expect(f.service.execute(job,async()=>undefined)).rejects.toThrow('未知');
    expect(f.cloud.reinitialize).not.toHaveBeenCalled();expect(f.cloud.stop).not.toHaveBeenCalled();
  }));
  it('accepts proven retagging from a topology update without making that update the host birth source',async()=>inSpace(async()=>{
    const f=await fixture();
    const update=await f.repository.createProvisionJob({rangeInstanceId:f.instance.id,jobType:'update',triggeredBy:actor.id});
    await f.repository.updateProvisionJob(update.id,{status:'succeeded',startedAt:new Date(),finishedAt:new Date()});
    await f.repository.createProvisionJobStepLog({jobId:update.id,stepName:'range_resource_inventory',status:'succeeded',message:JSON.stringify({version:1,rangeInstanceId:f.instance.id,executionContext:context,resources:f.instance.resourceSummary})});
    f.host.Tags.Tag.find((tag:any)=>tag.TagKey==='PlatformCreateJobId').TagValue=update.id;
    const preview=await f.service.preview(f.instance.id,'host',actor);
    expect(preview.sourceJobId).toBe(f.source.id);expect(preview.tagJobId).toBe(update.id);
  }));
  it('resumes verification from a recorded reset receipt without a second reset',async()=>inSpace(async()=>{
    const f=await fixture(),job=await f.accepted();
    for(const stepName of ['node_reset_reinit_intent','node_reset_reinit_receipt']) await f.repository.createProvisionJobStepLog({jobId:job.id,stepName,status:'succeeded',message:'persisted'});
    f.host.Status='Stopped';await f.service.execute(job,async()=>undefined);
    expect(f.cloud.reinitialize).not.toHaveBeenCalled();expect(f.host.Status).toBe('Running');
  }));
  it('restores prior power on an identified cloud rejection and does not leak secrets',async()=>inSpace(async()=>{
    const f=await fixture(),job=await f.accepted();
    f.cloud.reinitialize.mockRejectedValue(new NodeResetCloudError('ReInitDisk','Forbidden.RAM','safe-request',true));
    await expect(f.service.execute(job,async()=>undefined)).rejects.toThrow('Forbidden.RAM');
    expect(f.host.Status).toBe('Running');
    expect((await f.repository.listProvisionJobStepLogs(job.id)).find(step=>step.stepName==='node_reset_reinit_rejected')).toMatchObject({status:'failed'});
  }));
  it('restores deployed DNS using only its own job exemption',async()=>inSpace(async()=>{
    const f=await fixture();
    await f.repository.updateRangeInstance(f.instance.id,{runtimeTopologyGraph:{nodes:[{id:'host',kind:'ecs',label:'Test Node',imageId:'m-original',dns:{servers:['10.0.10.10'],nicIds:['nic-1']}}]}});
    const job=await f.accepted();await f.service.execute(job,async()=>undefined);
    expect(f.dns.verify).toHaveBeenCalledWith(f.instance.id,'host',expect.any(Object),job.id,true);
  }));
  it('restores a stopped node after temporary DNS startup even when DNS verification fails',async()=>inSpace(async()=>{
    const f=await fixture('Stopped');
    await f.repository.updateRangeInstance(f.instance.id,{runtimeTopologyGraph:{nodes:[{id:'host',kind:'ecs',label:'Test Node',imageId:'m-original',dns:{servers:['10.0.10.10'],nicIds:['nic-1']}}]}});
    f.dns.verify.mockRejectedValue(new Error('guest unavailable'));
    const job=await f.accepted();await expect(f.service.execute(job,async()=>undefined)).rejects.toThrow('核验');
    expect(f.cloud.reinitialize).toHaveBeenCalledTimes(1);expect(f.host.Status).toBe('Stopped');
  }));
  it('rejects changed disk attachment immediately before the irreversible call',async()=>inSpace(async()=>{
    const f=await fixture(),job=await f.accepted();
    f.cloud.stop.mockImplementation(async()=>{f.host.Status='Stopped';f.system.InstanceId='i-foreign';return{requestId:'stop-receipt'};});
    await expect(f.service.execute(job,async()=>undefined)).rejects.toThrow('RESET_SYSTEM_DISK_CHANGED');
    expect(f.cloud.reinitialize).not.toHaveBeenCalled();
  }));
  it('isolates reset failure from range creation/destroy cleanup and billing release',async()=>inSpace(async()=>{
    const f=await fixture(),job=await f.accepted(),before=await f.repository.listBillingLedgerResources();
    const provisioner={create:jest.fn(),update:jest.fn(),destroy:jest.fn()};
    const reset={execute:jest.fn(async()=>{throw new ConflictException('测试重置失败；不允许自动重试。');})};
    const worker=new ProvisioningWorkerService(f.repository,provisioner as any,f.config as any,undefined,undefined,undefined,undefined,undefined,undefined,reset as any);
    await (worker as any).processClaimedJob(job);
    expect(await f.repository.getProvisionJobById(job.id)).toMatchObject({status:'failed'});
    expect(await f.repository.getRangeInstanceById(f.instance.id)).toMatchObject({status:'running',resourceSummary:f.instance.resourceSummary});
    expect(await f.repository.listBillingLedgerResources()).toEqual(before);
    expect(provisioner.create).not.toHaveBeenCalled();expect(provisioner.destroy).not.toHaveBeenCalled();
  }));
  it('allows only one concurrent reset enqueue and rejects stale compare-and-swap versions',async()=>inSpace(async()=>{
    const f=await fixture(),preview=await f.service.preview(f.instance.id,'host',actor),input={planDigest:preview.planDigest,confirmedNodeName:preview.nodeName};
    const results=await Promise.allSettled([f.service.enqueue(f.instance.id,'host',input,actor),f.service.enqueue(f.instance.id,'host',input,actor)]);
    expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);
    expect((await f.repository.listProvisionJobs()).filter(job=>job.jobType==='reset')).toHaveLength(1);
  }));
  it('keeps read-only delegated scopes from invoking reset',()=>{
    expect(()=>assertDelegatedApiScopes('GET','/admin/ranges/r/nodes/n/reset-preview',new Set(['ranges:read']))).not.toThrow();
    expect(()=>assertDelegatedApiScopes('POST','/admin/ranges/r/nodes/n/actions/reset',new Set(['ranges:read']))).toThrow();
  });
});

describe('reset cloud RPC boundary',()=>{
  const original=global.fetch;afterEach(()=>{global.fetch=original;});
  const response=(body:any,status=200)=>({ok:status===200,status,json:async()=>body}) as Response;
  it('uses complete token pagination and ignores meaningless legacy totals',async()=>{
    global.fetch=jest.fn(async(url:any)=>{
      const p=new URL(String(url)).searchParams;expect(p.get('MaxResults')).toBe('100');expect(p.has('PageNumber')).toBe(false);
      return response({RequestId:'safe-read',TotalCount:0,NextToken:'',Instances:{Instance:[{InstanceId:'i-original'}]}});
    });
    await expect(new RangeNodeResetCloudClient().host(account,'i-original')).resolves.toMatchObject({InstanceId:'i-original'});
  });
  it('does not reflect credentials/passwords in failed reset receipts',async()=>{
    global.fetch=jest.fn(async()=>response({Code:'SyntheticPassword9_',RequestId:'safe-request',Message:'private raw message'},400));
    const error=await new RangeNodeResetCloudClient().reinitialize(account,'d-system','SyntheticPassword9_').catch(value=>value);
    expect(error.message).not.toContain('SyntheticPassword9_');expect(error.message).not.toContain('private');
  });
});
