import { loadPlatformBillingProof } from '../src/admin/billing-platform-scope';
import { syncRangeInstanceBillingLedger, releaseRangeInstanceBillingLedger } from '../src/admin/billing-ledger-sync';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';
import { BillingService } from '../src/admin/billing.service';
import { signedTencentBillingResponse, tencentBill, tencentBillingSync, TENCENT_BILLING_WINDOW } from './support/create-tencent-billing-fixture';
const context={provider:'tencent_cloud' as const,cloudAccountContextId:'frozen-context',cloudAccountUid:'100001',regionId:'ap-shanghai',zoneId:'ap-shanghai-1'};
const summary=(nat:string)=>({mode:'opentofu' as const,executionContext:context,natGatewayIds:{edge:nat},eipAllocationIds:{first:`eip-${nat}`,second:`eip-${nat}2`},
  snatEntryIds:{first:`${nat}#subnet-first`,second:`${nat}#subnet-second`},dnatEntryIds:{entry:`TCP://vpc-fixture:${nat}@192.0.2.1:18081`}});
async function fixture(){
  const repository=createMemoryAdminRepository();let instance=await repository.createRangeInstance({cloudProvider:'tencent_cloud',name:'history',ownerUserId:'owner',status:'running',resourceSummary:summary('nat-old')});
  const first=await repository.createProvisionJob({rangeInstanceId:instance.id,jobType:'create',triggeredBy:'owner'});
  const update=await repository.createProvisionJob({rangeInstanceId:instance.id,jobType:'update',triggeredBy:'owner'});
  const destroy=await repository.createProvisionJob({rangeInstanceId:instance.id,jobType:'destroy',triggeredBy:'owner'});
  const sync=async(jobId:string,resourceSummary:ReturnType<typeof summary>)=>syncRangeInstanceBillingLedger({repository,instance,resourceSummary,regionId:context.regionId,
    cloudAccountUid:context.cloudAccountUid,sourceProvisionJobId:jobId,billingStartAt:new Date('2026-09-01')});
  await sync(first.id,summary('nat-old'));await repository.updateProvisionJob(first.id,{status:'failed'});
  await sync(update.id,summary('nat-new'));await repository.updateProvisionJob(update.id,{status:'succeeded'});
  const rows=await repository.listBillingLedgerResources();
  for(const row of rows)await repository.updateBillingLedgerResource(row.id,{sourceProvisionJobId:row.cloudResourceId.includes('nat-new')?first.id:destroy.id});
  await releaseRangeInstanceBillingLedger(repository,instance.id,new Date('2026-09-30T12:00:00Z'));
  instance=await repository.updateRangeInstance(instance.id,{status:'destroyed',resourceSummary:null});
  return {repository,instance,first,update,destroy,rows,sync};
}
afterEach(()=>jest.restoreAllMocks());
describe('read-only original Tencent creation inventory recovery',()=>{
  it('recovers failed original and update-created NAT/EIP/SNAT/DNAT costs without changing historical wrong pointers',async()=>{
    const f=await fixture();const before=await f.repository.listBillingLedgerResources();
    const proof=await loadPlatformBillingProof(f.repository);expect(proof.createdLedgerIds.size).toBe(12);expect(proof.unverifiedSourceLedgerIds.size).toBe(0);
    expect(await f.repository.listBillingLedgerResources()).toEqual(before);
    jest.spyOn(globalThis,'fetch').mockResolvedValue(signedTencentBillingResponse([tencentBill({ResourceId:'nat-new',BusinessCode:'p_nat',ComponentSet:[{RealCost:'0.25'}]}),
      tencentBill({Id:'external',ResourceId:'nat-external',BusinessCode:'p_nat',ComponentSet:[{RealCost:'9'}]})]));
    await tencentBillingSync(f.repository).syncRange(TENCENT_BILLING_WINDOW);
    expect((await new BillingService(f.repository).getSummary(TENCENT_BILLING_WINDOW)).totalPretaxAmount).toBe(0.25);
  });
  it('excludes later inventories of old IDs by trusted first ledger/journal timestamps',async()=>{
    const f=await fixture();const logs=await f.repository.listProvisionJobStepLogs(f.update.id),prior=await f.repository.listProvisionJobStepLogs(f.first.id);
    const inventory=JSON.parse(prior[0].message!);inventory.sourceJobId=f.update.id;
    jest.spyOn(f.repository,'listProvisionJobStepLogs').mockImplementation(async id=> id===f.update.id ? [...logs,{...logs[0],createdAt:new Date(Math.max(...f.rows.map(row=>row.createdAt.getTime()))+1000),message:JSON.stringify(inventory)}] : id===f.first.id?prior:[]);
    expect((await loadPlatformBillingProof(f.repository)).createdLedgerIds.size).toBe(12);
  });
  it('keeps a valid existing source with a later same-job completed inventory',async()=>{
    const f=await fixture();for(const row of f.rows)await f.repository.updateBillingLedgerResource(row.id,{sourceProvisionJobId:row.cloudResourceId.includes('nat-new')?f.update.id:f.first.id});
    const prior=await f.repository.listProvisionJobStepLogs(f.first.id),logs=await f.repository.listProvisionJobStepLogs(f.update.id);
    jest.spyOn(f.repository,'listProvisionJobStepLogs').mockImplementation(async id=>(id===f.first.id?prior:id===f.update.id?logs:[])
      .flatMap(log=>[log,{...log,createdAt:new Date(Math.max(...f.rows.map(row=>row.createdAt.getTime()))+1000)}]));
    expect((await loadPlatformBillingProof(f.repository)).createdLedgerIds.size).toBe(12);
  });
  it('does not treat a later observer pointer as creator and recovers only the unique original receipt',async()=>{
    const f=await fixture();const later=await f.repository.createProvisionJob({rangeInstanceId:f.instance.id,jobType:'update',triggeredBy:'owner'});
    const oldLogs=await f.repository.listProvisionJobStepLogs(f.first.id),newLogs=await f.repository.listProvisionJobStepLogs(f.update.id);
    for(const row of f.rows)await f.repository.updateBillingLedgerResource(row.id,{sourceProvisionJobId:later.id});
    const observations=[...oldLogs,...newLogs].map(log=>{const inventory=JSON.parse(log.message!);inventory.sourceJobId=later.id;return {...log,jobId:later.id,
      createdAt:new Date(Math.max(...f.rows.map(row=>row.createdAt.getTime()))+1000),message:JSON.stringify(inventory)};});
    jest.spyOn(f.repository,'listProvisionJobStepLogs').mockImplementation(async id=>id===later.id?observations:id===f.first.id?oldLogs:id===f.update.id?newLogs:[]);
    expect((await loadPlatformBillingProof(f.repository)).createdLedgerIds.size).toBe(12);
    jest.spyOn(f.repository,'listProvisionJobStepLogs').mockImplementation(async id=>id===later.id?observations:[]);
    expect((await loadPlatformBillingProof(f.repository)).createdLedgerIds.size).toBe(0);
  });
  it('keeps NULL sources without an eligible original receipt unknown',async()=>{
    const f=await fixture();for(const row of f.rows)await f.repository.updateBillingLedgerResource(row.id,{sourceProvisionJobId:null});
    jest.spyOn(f.repository,'listProvisionJobStepLogs').mockResolvedValue([]);
    expect((await loadPlatformBillingProof(f.repository)).createdLedgerIds.size).toBe(0);
    expect((await f.repository.listBillingLedgerResources()).every(row=>row.sourceProvisionJobId===null)).toBe(true);
  });
  it.each(['ledger','journal'])('rejects untrusted string timestamps instead of parsing a %s clock',async target=>{
    const f=await fixture();
    if(target==='ledger'){
      const rows=await f.repository.listBillingLedgerResources();jest.spyOn(f.repository,'listBillingLedgerResources').mockResolvedValue(rows.map(row=>({...row,createdAt:row.createdAt.toISOString()})) as never);
    }else{
      const read=f.repository.listProvisionJobStepLogs.bind(f.repository);jest.spyOn(f.repository,'listProvisionJobStepLogs').mockImplementation(async id=>(await read(id)).map(log=>({...log,createdAt:log.createdAt.toISOString()})) as never);
    }
    expect((await loadPlatformBillingProof(f.repository)).createdLedgerIds.size).toBe(0);
  });
  it.each(['cloudAccountContextId','zoneId'])('rejects a nonempty foreign %s against a retained frozen binding',async field=>{
    const f=await fixture();await f.repository.updateRangeInstance(f.instance.id,{resourceSummary:{mode:'opentofu',executionContext:context}});
    const read=f.repository.listProvisionJobStepLogs.bind(f.repository);jest.spyOn(f.repository,'listProvisionJobStepLogs').mockImplementation(async id=>(await read(id)).map(log=>{
      const inventory=JSON.parse(log.message!);inventory.executionContext[field]='foreign-value';return {...log,message:JSON.stringify(inventory)};
    }));
    expect((await loadPlatformBillingProof(f.repository)).createdLedgerIds.size).toBe(0);
  });
  it('keeps multiple eligible original-job candidates unknown rather than selecting first/earliest',async()=>{
    const f=await fixture();const logs=await f.repository.listProvisionJobStepLogs(f.update.id),prior=await f.repository.listProvisionJobStepLogs(f.first.id);
    const inventory=JSON.parse(logs[0].message!);inventory.sourceJobId=f.first.id;
    const inserted={...prior[0],message:JSON.stringify(inventory),createdAt:new Date(0)};
    jest.spyOn(f.repository,'listProvisionJobStepLogs').mockImplementation(async id=>id===f.first.id?[...prior,inserted]:id===f.update.id?logs:[]);
    expect((await loadPlatformBillingProof(f.repository)).createdLedgerIds.size).toBe(12); // The stored first pointer has its own valid receipt and remains authoritative.
    for(const row of f.rows.filter(row=>row.cloudResourceId.includes('nat-new')))await f.repository.updateBillingLedgerResource(row.id,{sourceProvisionJobId:f.destroy.id});
    expect((await loadPlatformBillingProof(f.repository)).createdLedgerIds.size).toBe(6);
  });
  it.each(['cloudWorkspaceId','ownerUserId','provider','cloudAccountUid','cloudAccountContextId','regionId','zoneId','sourceJobId'])('rejects foreign or incomplete frozen proof %s',async field=>{
    const f=await fixture();const logs=await f.repository.listProvisionJobStepLogs(f.update.id);const inventory=JSON.parse(logs[0].message!);
    if(['provider','cloudAccountUid','regionId'].includes(field))inventory.executionContext[field]='foreign';
    else if(field==='cloudAccountContextId'||field==='zoneId')inventory.executionContext[field]='';else inventory[field]='foreign';
    jest.spyOn(f.repository,'listProvisionJobStepLogs').mockImplementation(async id=>id===f.update.id?[{...logs[0],message:JSON.stringify(inventory)}]:[]);
    const proof=await loadPlatformBillingProof(f.repository);expect(proof.createdLedgerIds.size).toBe(0);expect(proof.unverifiedSourceLedgerIds.size).toBe(12);
  });
});
