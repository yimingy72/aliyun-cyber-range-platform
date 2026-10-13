import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRangeResourceReceiptObserver, RangeCreationReceiptPersistenceError, validRangeResourceCreatedEvent } from '../src/provisioning/range-resource-creation-receipts';
import { OpenTofuRangeProvisioner } from '../src/provisioning/open-tofu-range-provisioner';
import { ProvisioningWorkerService } from '../src/provisioning/provisioning-worker.service';

const address = 'module.range.alicloud_instance.hosts["new"]';
const event = { address, resourceType: 'alicloud_instance', action: 'create' as const, resourceId: 'i-new' };
const created = { address, providerResourceType:'alicloud_instance',type:'ecs' as const,id:'i-new',logicalKey:'new' };
const plan = { resource_changes: [{ address, type:'alicloud_instance',mode:'managed',change:{actions:['create']} }] };
const gate = () => { let resolve!:()=>void; const promise = new Promise<void>(done=>{resolve=done;}); return {promise,resolve}; };

it('does not turn state observations into birth evidence without a creation completion event', async()=>{
  const sink=jest.fn();const observer=createRangeResourceReceiptObserver({plan,priorState:{lineage:'old',serial:1,instances:[{address,type:'alicloud_instance',tainted:false,attributes:{id:'i-old'}}]},provider:'alibaba_cloud',onCreated:sink});
  await observer.drain();expect(sink).not.toHaveBeenCalled();
});
it('forwards only the approved completion identity and drops unrelated diagnostics and secrets', async()=>{
  const sink=jest.fn(async()=>undefined);const observer=createRangeResourceReceiptObserver({plan,priorState:null,provider:'alibaba_cloud',onCreated:sink});
  observer.onResourceApplied({...event,stdout:'private-state',password:'never-expose-this'} as any);await observer.drain();
  expect(sink).toHaveBeenCalledWith(created);expect(JSON.stringify(sink.mock.calls)).not.toContain('private-state');expect(JSON.stringify(sink.mock.calls)).not.toContain('never-expose');
});
it.each([
  {...event,action:'update'}, {...event,action:'delete'}, {...event,address:'module.foreign.alicloud_instance.hosts["new"]'},
  {...event,resourceType:'tencentcloud_instance'}, {...event,resourceId:'raw-state-or-password!'},
])('ignores a non-birth, foreign or malformed callback %j', async value=>{
  const sink=jest.fn();const observer=createRangeResourceReceiptObserver({plan,priorState:null,provider:'alibaba_cloud',onCreated:sink});
  observer.onResourceApplied(value as any);await observer.drain();expect(sink).not.toHaveBeenCalled();
});
it('does not treat malformed plan action text as an approved create action', async()=>{
  const sink=jest.fn();const observer=createRangeResourceReceiptObserver({plan:{resource_changes:[{address,type:'alicloud_instance',mode:'managed',change:{actions:'create'}}]},priorState:null,provider:'alibaba_cloud',onCreated:sink});
  observer.onResourceApplied(event);await observer.drain();expect(sink).not.toHaveBeenCalled();
});
it('does not grant birth to a physical ID already in before-state or to a rule-set parent ID', async()=>{
  const sink=jest.fn();const observer=createRangeResourceReceiptObserver({plan,priorState:{lineage:'old',serial:1,instances:[{address:'module.range.alicloud_instance.hosts["old"]',type:'alicloud_instance',tainted:false,attributes:{id:'i-new'}}]},provider:'alibaba_cloud',onCreated:sink});
  observer.onResourceApplied(event);await observer.drain();expect(sink).not.toHaveBeenCalled();
  const rule='module.range.tencentcloud_security_group_rule_set.nics["old-0"]';
  const relation=createRangeResourceReceiptObserver({plan:{resource_changes:[{address:rule,type:'tencentcloud_security_group_rule_set',mode:'managed',change:{actions:['create']}}]},priorState:null,provider:'tencent_cloud',onCreated:sink});
  relation.onResourceApplied({address:rule,resourceType:'tencentcloud_security_group_rule_set',resourceId:'sg-parent',action:'create'});await relation.drain();expect(sink).not.toHaveBeenCalled();
});
it('deduplicates repeated completions but rejects conflicting physical IDs', async()=>{
  const sink=jest.fn(async()=>undefined);const observer=createRangeResourceReceiptObserver({plan,priorState:null,provider:'alibaba_cloud',onCreated:sink});
  observer.onResourceApplied(event);observer.onResourceApplied(event);await observer.drain();expect(sink).toHaveBeenCalledTimes(1);
  observer.onResourceApplied({...event,resourceId:'i-conflicting'});await expect(observer.drain()).rejects.toBeInstanceOf(RangeCreationReceiptPersistenceError);expect(sink).toHaveBeenCalledTimes(1);
});
it('drains asynchronous writes and reports database failure without exposing its private error', async()=>{
  const pause=gate();const sink=jest.fn(async()=>{await pause.promise;throw new Error('secret-database-diagnostic');});
  const observer=createRangeResourceReceiptObserver({plan,priorState:null,provider:'alibaba_cloud',onCreated:sink});observer.onResourceApplied(event);
  let done=false;const drained=observer.drain().catch(error=>{done=true;return error;});await Promise.resolve();expect(done).toBe(false);pause.resolve();
  const error=await drained;expect(error).toBeInstanceOf(RangeCreationReceiptPersistenceError);expect(error.message).not.toContain('secret-database');
});
it.each([
  {address:'module.range.tencentcloud_instance.hosts["new"]',providerResourceType:'tencentcloud_instance',type:'ecs',id:'ins-new'},
  {address:'module.range.tencentcloud_nat_gateway_snat.zones["main"]',providerResourceType:'tencentcloud_nat_gateway_snat',type:'snat_entry',id:'nat-owned#subnet-owned'},
  {address:'module.range.tencentcloud_dnat.entry["rdp"]',providerResourceType:'tencentcloud_dnat',type:'dnat_entry',id:'TCP://vpc-owned:nat-owned@203.0.113.4:3389'},
])('accepts an exact Tencent native or supported relation identity %j', value=>{
  expect(validRangeResourceCreatedEvent(value as any,'tencent_cloud')).toBe(true);expect(validRangeResourceCreatedEvent(value as any,'alibaba_cloud')).toBe(false);
});

it.each([
  ['alicloud_snat_entry','snat_entry','stb-owned:snat-new'],
  ['alicloud_forward_entry','dnat_entry','ftb-owned:fwd-new'],
])('preserves the exact Alibaba NAT compound identity for %s creation', async (providerResourceType,type,id)=>{
  const address=`module.range.${providerResourceType}.entries["new-rule"]`;
  const sink=jest.fn(async()=>undefined);
  const observer=createRangeResourceReceiptObserver({plan:{resource_changes:[{address,type:providerResourceType,mode:'managed',change:{actions:['create']}}]},priorState:null,provider:'alibaba_cloud',onCreated:sink});
  observer.onResourceApplied({address,resourceType:providerResourceType,action:'create',resourceId:id});await observer.drain();
  expect(sink).toHaveBeenCalledWith({address,providerResourceType,type,id,logicalKey:'new-rule'});
});
it.each([
  ['alicloud_snat_entry','snat_entry','snat-new'],
  ['alicloud_snat_entry','snat_entry','stb-owned:fwd-new'],
  ['alicloud_forward_entry','dnat_entry','fwd-new'],
  ['alicloud_forward_entry','dnat_entry','ftb-owned:snat-new'],
])('rejects an incomplete or mismatched Alibaba NAT compound identity: %s %s %s', (providerResourceType,type,id)=>{
  expect(validRangeResourceCreatedEvent({address:`module.range.${providerResourceType}.entries["new-rule"]`,providerResourceType,type,id} as any,'alibaba_cloud')).toBe(false);
});

it.each([false,true])('drains receipts before a successful or failed provider apply returns (provider failure=%s)', async fails=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'range-receipt-'));const pause=gate();const sink=jest.fn(async()=>pause.promise);
  const original=JSON.stringify({version:1,addresses:[address]});await fs.writeFile(path.join(root,'.range-apply-started'),original);
  const runner={apply:jest.fn(async(options:any)=>{options.onResourceApplied(event);if(fails)throw new Error('provider partial apply failed');return {stdout:'',stderr:''};})};
  const provisioner=new OpenTofuRangeProvisioner({runner:runner as any,env:{}}) as any;
  let returned=false;const result=provisioner.applyWithCreationReceipts({runtimeConfig:{provider:'alibaba_cloud'},onResourceCreated:sink},{workspaceDir:root,runnerEnv:{}},'saved-plan',plan,null)
    .then(()=>{returned=true;return null;},(error:any)=>{returned=true;return error;});
  try {await new Promise(resolve=>setTimeout(resolve,10));expect(returned).toBe(false);pause.resolve();const error=await result;expect(Boolean(error)).toBe(fails);expect(sink).toHaveBeenCalledWith(created);expect(await fs.readFile(path.join(root,'.range-apply-started'),'utf8')).toBe(original);}
  finally {pause.resolve();await fs.rm(root,{recursive:true,force:true});}
});
it('keeps the original apply marker and propagates receipt persistence failure even after provider success', async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'range-receipt-failed-'));await fs.writeFile(path.join(root,'.range-apply-started'),'original');
  const runner={apply:jest.fn(async(options:any)=>{options.onResourceApplied(event);return {stdout:'',stderr:''};})};
  const provisioner=new OpenTofuRangeProvisioner({runner:runner as any,env:{}}) as any;
  try {await expect(provisioner.applyWithCreationReceipts({runtimeConfig:{provider:'alibaba_cloud'},onResourceCreated:async()=>{throw new Error('private-db');}},{workspaceDir:root,runnerEnv:{}},'plan',plan,null)).rejects.toBeInstanceOf(RangeCreationReceiptPersistenceError);expect(await fs.readFile(path.join(root,'.range-apply-started'),'utf8')).toBe('original');expect(runner.apply).toHaveBeenCalledTimes(1);}
  finally {await fs.rm(root,{recursive:true,force:true});}
});

function workerFixture() {
  const context={provider:'alibaba_cloud' as const,accountUid:'12345',cloudAccountContextId:'ctx-a',defaultRegion:'cn-hangzhou',defaultZoneId:'cn-hangzhou-h',accessKeyId:'never-expose-key',accessKeySecret:'never-expose-secret'};
  const instance:any={id:'range-a',cloudWorkspaceId:'ws-a',instanceMode:'range',cloudProvider:'alibaba_cloud',ownerUserId:'alice',resourceSummary:{mode:'opentofu',executionContext:{provider:'alibaba_cloud',cloudAccountUid:context.accountUid,cloudAccountContextId:context.cloudAccountContextId,regionId:context.defaultRegion,zoneId:context.defaultZoneId}}};
  const job:any={id:'job-a',rangeInstanceId:instance.id,cloudWorkspaceId:'ws-a',jobType:'update',startedAt:new Date()};
  const repository={getRangeInstanceById:jest.fn(async()=>instance),heartbeatRangeProvisionJob:jest.fn(async()=>true),createProvisionJobStepLog:jest.fn(async(_input:any)=>({id:'step-a'}))};
  const worker=new ProvisioningWorkerService(repository as any,{mode:'opentofu'} as any,{} as any,{} as any,{} as any,{} as any) as any;
  return {context,instance,job,repository,worker};
}
it('writes only immutable exact birth facts bound to the original job, workspace and frozen account', async()=>{
  const f=workerFixture();await f.worker.persistRangeCreationReceipt(f.job,f.instance,f.context,created);
  const request=f.repository.createProvisionJobStepLog.mock.calls[0][0] as any;
  expect(request).toMatchObject({jobId:'job-a',cloudWorkspaceId:'ws-a',stepName:'range_resource_creation_receipt',status:'succeeded',stdoutExcerpt:null,stderrExcerpt:null});
  expect(JSON.parse(request.message)).toEqual({version:1,cloudProvider:'alibaba_cloud',cloudWorkspaceId:'ws-a',rangeInstanceId:'range-a',sourceJobId:'job-a',ownerUserId:'alice',executionContext:f.instance.resourceSummary.executionContext,resources:[created]});
  expect(request.message).not.toContain('never-expose');
});
it.each(['claim','account','workspace','provider','destroy-retry'])('does not append a birth receipt after %s changes', async mismatch=>{
  const f=workerFixture();
  if(mismatch==='claim')f.repository.heartbeatRangeProvisionJob.mockResolvedValue(false);
  if(mismatch==='account')f.instance.resourceSummary.executionContext.cloudAccountUid='foreign';
  if(mismatch==='workspace')f.instance.cloudWorkspaceId='ws-b';
  if(mismatch==='provider')f.instance.cloudProvider='tencent_cloud';
  if(mismatch==='destroy-retry'){f.job.jobType='retry';f.job.topologySnapshot={operation:'destroy'};}
  await expect(f.worker.persistRangeCreationReceipt(f.job,f.instance,f.context,created)).rejects.toThrow();expect(f.repository.createProvisionJobStepLog).not.toHaveBeenCalled();
});
