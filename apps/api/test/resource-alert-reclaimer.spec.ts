import { ResourceAlertReclaimer } from '../src/admin/resource-alert-reclaimer';
import { runInCloudWorkspace } from '../src/auth/cloud-workspace-scope';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';
import { createMemoryResourcePatrolRepository } from './support/create-memory-resource-patrol-repository';
import { patrolResourceIdentities,patrolResourceKey } from '../src/admin/resource-patrol-inventory';
import { ProvisioningWorkerService } from '../src/provisioning/provisioning-worker.service';

async function fixture(provider:'alibaba_cloud'|'tencent_cloud'='alibaba_cloud',single=false) {
  const scope={cloudWorkspaceId:'fixture-space',provider,accountUid:'fixture-uid'};
  return runInCloudWorkspace(scope,async()=>{
    const repo=createMemoryAdminRepository(),context={provider,cloudAccountUid:scope.accountUid,cloudAccountContextId:'original-context',
      regionId:provider==='alibaba_cloud'?'cn-hangzhou':'ap-nanjing',zoneId:provider==='alibaba_cloud'?'cn-hangzhou-j':'ap-nanjing-1'};
    const row=await repo.createRangeInstance({name:'missing entire terraform workspace',status:'destroyed',instanceMode:single?'single':'range',cloudProvider:provider,
      ...(single?{singleInstanceBatchId:'batch-original',singleInstanceConfig:{executionBackend:'opentofu',hostKey:'node',cloudAccountUid:scope.accountUid,
        cloudAccountContextId:context.cloudAccountContextId,regionId:context.regionId,zoneId:context.zoneId} as any}:{})});
    const source=await repo.createProvisionJob({rangeInstanceId:row.id,jobType:'create',triggeredBy:'admin'});
    await repo.updateProvisionJob(source.id,{status:'failed',startedAt:new Date()});
    const summary={mode:'opentofu' as const,executionContext:context,hostIds:{node:provider==='alibaba_cloud'?'i-owned':'ins-owned'},systemDiskIds:{node:provider==='alibaba_cloud'?'d-owned':'disk-owned'},
      ...(!single?{vpcId:'vpc-owned',subnetIds:{subnet:provider==='alibaba_cloud'?'vsw-owned':'subnet-owned'},securityGroupIds:{group:'sg-owned'},
        networkAclIds:{acl:'acl-owned'},secondaryNetworkInterfaceIds:{aux:'eni-owned'},natGatewayIds:{gateway:provider==='alibaba_cloud'?'ngw-owned':'nat-owned'},eipAllocationIds:{address:'eip-owned'}}:{})};
    if(!single) Object.assign(summary,{snatEntryIds:{snat:provider==='alibaba_cloud'?'stb-owned:snat-owned':'nat-owned#subnet-owned'},
      dnatEntryIds:{dnat:provider==='alibaba_cloud'?'ftb-owned:fwd-owned':'TCP://vpc-owned:nat-owned@203.0.113.1:3389'}});
    await repo.createProvisionJobStepLog({jobId:source.id,stepName:'range_resource_inventory',status:'succeeded',message:JSON.stringify({
      version:1,rangeInstanceId:row.id,executionContext:context,resources:summary})});
    const resources=patrolResourceIdentities(summary),creationProofs=Object.fromEntries(resources.map(resource=>[patrolResourceKey(resource),source.id]));
    const job=await repo.createProvisionJob({rangeInstanceId:row.id,jobType:'destroy',triggeredBy:'resource-alert:admin',topologySnapshot:{resourceAlertPlan:{
      version:1,mode:'confirmed_inventory',cloudWorkspaceId:scope.cloudWorkspaceId,alertId:'fixture-alert',provider,accountUid:scope.accountUid,
      regionId:context.regionId,ownerUserId:null,executionContext:context,resources,creationProofs,planDigest:'a'.repeat(64)}} as any});
    const claimed=await repo.updateProvisionJob(job.id,{status:'running',startedAt:new Date()});
    const instance=await repo.updateRangeInstance(row.id,{status:'destroying',lastJobId:job.id,resourceSummary:summary});
    const state=new Map<string,any>(),calls:Array<{action:string;parameters:any}>=[];
    for(const resource of resources) state.set(patrolResourceKey(resource),{...resource,tags:{CreatedBy:'cyber-range-platform'},
      parentId:['vswitch','security_group','network_acl','eni','ecs','nat_gateway'].includes(resource.type)&&!single?'vpc-owned':null,
      attachedInstanceId:resource.type==='eni'||resource.type==='disk'?summary.hostIds.node:resource.type==='eip'?Object.values(summary.natGatewayIds??{})[0]:null,
      systemDisk:resource.type==='disk',raw:resource.type==='disk'?provider==='tencent_cloud'?{diskUsage:'SYSTEM_DISK',deleteWithInstance:true}:{DeleteWithInstance:true}
        : resource.type==='ecs'&&provider==='tencent_cloud'?{detail:{systemDiskId:summary.systemDiskIds.node}}:resource.type==='network_acl'?{relatedSubnetIds:[]}:{} });
    for(const value of state.values()) if(['snat_entry','dnat_entry'].includes(value.type)) {
      value.parentId=provider==='alibaba_cloud'?'ngw-owned':'nat-owned';
      value.raw={NatGatewaySnatId:'snat-owned',IpProtocol:'TCP',PublicIpAddress:'203.0.113.1',PublicPort:3389,PrivateIpAddress:'10.0.0.10',PrivatePort:3389};
    }
    state.set('eni:eni-primary',{type:'eni',id:'eni-primary',isPrimary:true,attachedInstanceId:summary.hostIds.node,parentId:single?'vpc-pool':'vpc-owned',tags:{},raw:{}});
    const cloud={verifyAccount:jest.fn(async()=>undefined),inspect:jest.fn(async()=>[...state.values()]),
      exact:jest.fn(async(_account:any,ids:any[])=>ids.map(id=>state.get(patrolResourceKey(id))).filter(Boolean)),
      attachedDisks:jest.fn(async(_account:any,id:string)=>[...state.values()].filter(row=>row.type==='disk'&&row.attachedInstanceId===id)),
      attachedInterfaces:jest.fn(async(_account:any,id:string)=>[...state.values()].filter(row=>row.type==='eni'&&row.attachedInstanceId===id)),
      mutate:jest.fn(async(_account:any,_service:any,action:string,parameters:any)=>{
        calls.push({action,parameters});
        if(['DeleteSnatEntry','DeleteForwardEntry','DeleteNatGatewaySourceIpTranslationNatRule','DeleteNatGatewayDestinationIpPortTranslationNatRule'].includes(action)) {
          const type=action.includes('Source')||action.includes('Snat')?'snat_entry':'dnat_entry';
          for(const [key,value]of state)if(value.type===type)state.delete(key);return{requestId:'rule-receipt'};
        }
        const id=parameters.NetworkInterfaceId??parameters['InstanceId.1']??parameters.InstanceIds?.[0]??parameters.AllocationId??parameters.AddressIds?.[0]
          ??parameters.NatGatewayId??parameters.SecurityGroupId??parameters.NetworkAclId??parameters.VSwitchId??parameters.SubnetId??parameters.VpcId;
        if(action==='DetachNetworkInterface'||action==='UnassociateEipAddress'||action==='DisassociateAddress') {
          for(const value of state.values())if(value.id===id)value.attachedInstanceId=null;
        } else for(const [key,value]of state) {
          if(value.id===id||['TerminateInstances','DeleteInstances'].includes(action)&&value.attachedInstanceId===id) state.delete(key);
          if(action==='DeleteNatGateway'&&value.attachedInstanceId===id)value.attachedInstanceId=null;
        }
        return {requestId:'safe-receipt'};
      })};
    const alerts=createMemoryResourcePatrolRepository(repo,{...scope});
    alerts.alerts.push({id:'fixture-alert',cloudWorkspaceId:scope.cloudWorkspaceId,provider,accountUid:scope.accountUid,regionId:context.regionId,type:'ecs',
      resourceId:summary.hostIds.node,rangeInstanceId:instance.id,rangeName:instance.name,status:'reclaiming',reason:'fixture',firstSeenAt:new Date(),lastSeenAt:new Date(),
      evidenceSummary:{recordedInventory:true,sourceJobIds:[source.id],accountVerified:true},remainingResources:resources,errorSummary:null,jobId:job.id,evidence:{},updatedAt:new Date()});
    const account={provider,accountUid:scope.accountUid,cloudAccountContextId:context.cloudAccountContextId,defaultRegion:context.regionId,defaultZoneId:context.zoneId,
      accountUidResolved:true,accessKeyId:'fixture',accessKeySecret:'fixture',imageImportBucket:''};
    const config={getExecutionAccountContext:jest.fn(async()=>account),runInWorkspace:async(_id:string,work:any)=>runInCloudWorkspace(scope,work)};
    const service=new ResourceAlertReclaimer(repo,config as any,cloud as any,alerts);
    jest.spyOn(service as any,'pause').mockResolvedValue(undefined);
    const claim=jest.fn(async()=>{const current=await repo.getRangeInstanceById(instance.id);if(current?.lastJobId!==job.id)throw new Error('lost claim');});
    return {scope,repo,job:claimed,instance,source,summary,resources,state,calls,cloud,alerts,config,service,claim};
  });
}
describe('confirmed inventory native cleanup without Terraform state',()=>{
  it.each(['alibaba_cloud','tencent_cloud'] as const)('deletes exact resources in dependency order on %s without state, init or apply',async provider=>{
    const f=await fixture(provider);await runInCloudWorkspace(f.scope,()=>f.service.execute(f.job,f.instance,f.claim));
    expect(f.state.size).toBe(0);expect(f.alerts.alerts[0].status).toBe('resolved');
    const names=f.calls.map(call=>call.action);
    expect(names.indexOf('DetachNetworkInterface')).toBeLessThan(names.indexOf(provider==='alibaba_cloud'?'DeleteInstances':'TerminateInstances'));
    expect(names.indexOf('DeleteNatGateway')).toBeLessThan(names.indexOf('DeleteVpc'));
    expect(names.indexOf(provider==='alibaba_cloud'?'ReleaseEipAddress':'ReleaseAddresses'))[provider==='alibaba_cloud'?'toBeLessThan':'toBeGreaterThan'](names.indexOf('DeleteNatGateway'));
    expect(names.some(name=>/create|apply|init/i.test(name))).toBe(false);
  });
  it('rejects a forged creation receipt before any native deletion',async()=>{
    const f=await fixture();(f.job.topologySnapshot as any).resourceAlertPlan.creationProofs['ecs:i-owned']='foreign-job';
    await runInCloudWorkspace(f.scope,()=>expect(f.service.execute(f.job,f.instance,f.claim)).rejects.toThrow('creation inventory'));
    expect(f.calls).toHaveLength(0);
  });
  it('rejects foreign cloud dependants and active platform references without expanding the confirmed plan',async()=>{
    const f=await fixture();f.state.set('ecs:i-foreign',{type:'ecs',id:'i-foreign',parentId:'vpc-owned',tags:{},raw:{}});
    await runInCloudWorkspace(f.scope,()=>expect(f.service.execute(f.job,f.instance,f.claim)).rejects.toThrow('preserved'));expect(f.calls).toHaveLength(0);
    f.state.delete('ecs:i-foreign');
    await runInCloudWorkspace(f.scope,async()=>{
      await f.repo.createRangeInstance({name:'other live range',status:'running',resourceSummary:{mode:'opentofu',vpcId:'vpc-owned'}});
      await expect(f.service.execute(f.job,f.instance,f.claim)).rejects.toThrow('preserved');
    });expect(f.calls).toHaveLength(0);
  });
  it('refuses an unconfirmed attached data disk before deleting its source host',async()=>{
    const f=await fixture('alibaba_cloud',true);f.state.set('disk:d-foreign',{type:'disk',id:'d-foreign',attachedInstanceId:'i-owned',systemDisk:false,raw:{DeleteWithInstance:true}});
    await runInCloudWorkspace(f.scope,()=>expect(f.service.execute(f.job,f.instance,f.claim)).rejects.toThrow('preserved'));
    expect(f.calls).toHaveLength(0);
  });
  it('preserves accurate remaining resources on partial failure and closes only proven physically absent ledgers',async()=>{
    const f=await fixture();await runInCloudWorkspace(f.scope,async()=>{
      for(const [type,id]of [['ecs','i-owned'],['nat_gateway','ngw-owned']] as const)await f.repo.createBillingLedgerResource({cloudProvider:'alibaba_cloud',cloudAccountUid:f.scope.accountUid,
        regionId:'cn-hangzhou',cloudResourceId:id,cloudResourceType:type,billingScope:'platform',ownerUserId:null,rangeInstanceId:f.instance.id,
        sourceProvisionJobId:f.source.id,billingStartAt:new Date()});
      const mutate=f.cloud.mutate.getMockImplementation()!;f.cloud.mutate.mockImplementation(async(...args:any[])=>{if(args[2]==='DeleteNatGateway')throw new Error('timeout');return (mutate as any)(...args);});
      await expect(f.service.execute(f.job,f.instance,f.claim)).rejects.toThrow('preserved');
      const ledger=await f.repo.listBillingLedgerResources();expect(Number.isFinite(ledger.find(row=>row.cloudResourceType==='ecs')?.releasedAt?.getTime())).toBe(true);
      expect(ledger.find(row=>row.cloudResourceType==='nat_gateway')?.releasedAt).toBeNull();
    });expect(f.alerts.alerts[0]).toMatchObject({status:'failed',remainingResources:expect.arrayContaining([{type:'nat_gateway',id:'ngw-owned'}])});
  });
  it('continues cleanup when ECS and its system disk were already released by the cloud timer',async()=>{
    const f=await fixture('tencent_cloud');f.state.delete('ecs:ins-owned');f.state.delete('disk:disk-owned');f.state.delete('eni:eni-primary');
    const secondary=f.state.get('eni:eni-owned');secondary.attachedInstanceId=null;
    await runInCloudWorkspace(f.scope,()=>f.service.execute(f.job,f.instance,f.claim));
    expect(f.calls.some(call=>call.action==='TerminateInstances')).toBe(false);expect(f.state.size).toBe(0);
  });
  it('dispatches the dedicated native branch before ordinary range destroy can depend on missing state',async()=>{
    const f=await fixture();await runInCloudWorkspace(f.scope,async()=>{
      await f.repo.updateProvisionJob(f.job.id,{status:'pending',startedAt:null});await f.repo.updateRangeInstance(f.instance.id,{status:'pending_destroy'});
    });
    const tofu={mode:'opentofu',destroy:jest.fn(async()=>{throw new Error('state missing');})};
    const worker=new ProvisioningWorkerService(f.repo,tofu as any,f.config as any,undefined,undefined,undefined,undefined,undefined,f.service);
    await worker.process(f.job.id);
    await runInCloudWorkspace(f.scope,async()=>{expect(await f.repo.getProvisionJobById(f.job.id)).toMatchObject({status:'succeeded'});});
    expect(tofu.destroy).not.toHaveBeenCalled();expect(f.state.size).toBe(0);
  });
  it('never expands a confirmation to another proved but unconfirmed physical resource',async()=>{
    const f=await fixture();const plan=(f.job.topologySnapshot as any).resourceAlertPlan;
    plan.resources=plan.resources.filter((row:any)=>row.type!=='security_group');
    await runInCloudWorkspace(f.scope,()=>expect(f.service.execute(f.job,f.instance,f.claim)).rejects.toThrow('preserved'));
    expect(f.calls).toHaveLength(0);expect(f.state.has('security_group:sg-owned')).toBe(true);
  });
  it('reconciles a lost delete response without sending a second deletion or claiming an unverified success',async()=>{
    const f=await fixture('tencent_cloud',true),mutate=f.cloud.mutate.getMockImplementation()!;
    f.cloud.mutate.mockImplementation(async(...args:any[])=>{const result=await (mutate as any)(...args);if(args[2]==='TerminateInstances')throw new Error('response lost');return result;});
    await runInCloudWorkspace(f.scope,()=>f.service.execute(f.job,f.instance,f.claim));
    expect(f.calls.filter(call=>call.action==='TerminateInstances')).toHaveLength(1);expect(f.alerts.alerts[0].status).toBe('resolved');
  });
  it('accepts mandatory Tencent system-disk lifecycle only when native CVM and CBS identities agree',async()=>{
    const f=await fixture('tencent_cloud',true);f.state.get('disk:disk-owned').raw.deleteWithInstance=null;
    await runInCloudWorkspace(f.scope,()=>f.service.execute(f.job,f.instance,f.claim));
    expect(f.alerts.alerts[0].status).toBe('resolved');expect(f.calls.map(call=>call.action)).toEqual(['TerminateInstances']);
  });
  it.each(['alibaba_cloud','tencent_cloud'] as const)('keeps %s hosts and disks when deletion lifecycle is explicitly false',async provider=>{
    const f=await fixture(provider,true),diskId=provider==='alibaba_cloud'?'d-owned':'disk-owned';
    f.state.get(`disk:${diskId}`).raw=provider==='alibaba_cloud'?{DeleteWithInstance:false}:{diskUsage:'SYSTEM_DISK',deleteWithInstance:false};
    await runInCloudWorkspace(f.scope,()=>expect(f.service.execute(f.job,f.instance,f.claim)).rejects.toThrow('preserved'));
    expect(f.calls).toHaveLength(0);expect(f.alerts.alerts[0]).toMatchObject({status:'failed',remainingResources:expect.arrayContaining([{type:'disk',id:diskId}])});
    const logs=await runInCloudWorkspace(f.scope,()=>f.repo.listProvisionJobStepLogs(f.job.id));
    expect(logs.find(row=>row.stepName==='confirmed_inventory_remaining')?.message).toContain('system_disk_lifecycle_unverified');
  });
  it.each(['alibaba_cloud','tencent_cloud'] as const)('keeps an unverified %s disk lifecycle instead of guessing',async provider=>{
    const f=await fixture(provider,true),hostId=provider==='alibaba_cloud'?'i-owned':'ins-owned',diskId=provider==='alibaba_cloud'?'d-owned':'disk-owned';
    if(provider==='alibaba_cloud')f.state.get(`disk:${diskId}`).raw={};
    else f.state.get(`ecs:${hostId}`).raw.detail.systemDiskId='disk-other';
    await runInCloudWorkspace(f.scope,()=>expect(f.service.execute(f.job,f.instance,f.claim)).rejects.toThrow('preserved'));
    expect(f.calls).toHaveLength(0);expect(f.alerts.alerts[0].status).toBe('failed');
  });
  it.each(['alibaba_cloud','tencent_cloud'] as const)('never uses a data-disk deletion API for a %s residual system disk after host disappearance',async provider=>{
    const f=await fixture(provider,true),hostId=provider==='alibaba_cloud'?'i-owned':'ins-owned',diskId=provider==='alibaba_cloud'?'d-owned':'disk-owned';
    f.state.delete(`ecs:${hostId}`);f.state.delete('eni:eni-primary');f.state.get(`disk:${diskId}`).attachedInstanceId=null;
    await runInCloudWorkspace(f.scope,()=>expect(f.service.execute(f.job,f.instance,f.claim)).rejects.toThrow('preserved'));
    expect(f.calls).toHaveLength(0);expect(f.alerts.alerts[0]).toMatchObject({status:'failed',remainingResources:[{type:'disk',id:diskId}]});
    const logs=await runInCloudWorkspace(f.scope,()=>f.repo.listProvisionJobStepLogs(f.job.id));
    expect(logs.find(row=>row.stepName==='confirmed_inventory_remaining')?.message).toContain('system_disk_still_present');
  });
  it.each([true,false])('treats a missing delete RequestId as unknown and independently checks absence (gone=%s)',async gone=>{
    const f=await fixture('alibaba_cloud',true),mutate=f.cloud.mutate.getMockImplementation()!;
    f.cloud.mutate.mockImplementation(async(...args:any[])=>{if(gone)await(mutate as any)(...args);else f.calls.push({action:args[2],parameters:args[3]});return{} as any;});
    await runInCloudWorkspace(f.scope,async()=>{
      if(gone)await f.service.execute(f.job,f.instance,f.claim);else await expect(f.service.execute(f.job,f.instance,f.claim)).rejects.toThrow('preserved');
      const logs=await f.repo.listProvisionJobStepLogs(f.job.id);expect(logs.some(row=>row.stepName==='confirmed_inventory_delete_receipt')).toBe(false);
    });
    expect(f.calls.filter(call=>call.action==='DeleteInstances')).toHaveLength(1);expect(f.alerts.alerts[0].status).toBe(gone?'resolved':'failed');
  });
});
