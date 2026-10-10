import { syncRangeInstanceBillingLedger, releaseRangeInstanceBillingLedger } from '../src/admin/billing-ledger-sync';
import { loadPlatformBillingProof } from '../src/admin/billing-platform-scope';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';
import { BillingService } from '../src/admin/billing.service';
import { tencentBillingSync, tencentBill, signedTencentBillingResponse, TENCENT_BILLING_WINDOW } from './support/create-tencent-billing-fixture';

const context={provider:'tencent_cloud' as const,cloudAccountContextId:'fixture-context',cloudAccountUid:'100001',regionId:'ap-shanghai',zoneId:'ap-shanghai-1'};
const summary=(suffix:string)=>({mode:'opentofu' as const,executionContext:context,hostIds:{host:`ins-${suffix}`},systemDiskIds:{host:`disk-${suffix}`},
  eipAllocationIds:{entry:`eip-${suffix}`},natGatewayIds:{edge:`nat-${suffix}`}});
afterEach(()=>jest.restoreAllMocks());
describe('Tencent original resource source jobs',()=>{
  it.each(['succeeded','failed'] as const)('retains update-created compute/disks/network after repeated sync and destroy (%s)',async status=>{
    const repository=createMemoryAdminRepository();
    let instance=await repository.createRangeInstance({name:'source-jobs',cloudProvider:'tencent_cloud',ownerUserId:'owner',status:'running',resourceSummary:summary('old')});
    const create=await repository.createProvisionJob({rangeInstanceId:instance.id,jobType:'create',triggeredBy:'owner'});
    await repository.updateProvisionJob(create.id,{status:'succeeded'});
    const sync=async(jobId:string,resourceSummary:ReturnType<typeof summary>)=>syncRangeInstanceBillingLedger({repository,instance,resourceSummary,regionId:context.regionId,
      cloudAccountUid:context.cloudAccountUid,sourceProvisionJobId:jobId,billingStartAt:new Date('2026-09-01')});
    await sync(create.id,summary('old'));
    const update=await repository.createProvisionJob({rangeInstanceId:instance.id,jobType:'update',triggeredBy:'owner'});
    await sync(update.id,summary('new')); await sync(update.id,summary('new'));
    await repository.updateProvisionJob(update.id,{status});
    const later=await repository.createProvisionJob({rangeInstanceId:instance.id,jobType:'update',triggeredBy:'owner'});
    await sync(later.id,summary('new'));
    const destroy=await repository.createProvisionJob({rangeInstanceId:instance.id,jobType:'destroy',triggeredBy:'owner'});
    await sync(destroy.id,summary('new'));
    const rows=await repository.listBillingLedgerResources();
    expect(rows.filter(row=>row.cloudResourceId.endsWith('-new')).map(row=>row.sourceProvisionJobId)).toEqual(Array(4).fill(update.id));
    expect(rows.filter(row=>row.cloudResourceId.endsWith('-old')).map(row=>row.sourceProvisionJobId)).toEqual(Array(4).fill(create.id));
    await releaseRangeInstanceBillingLedger(repository,instance.id,new Date('2026-09-30T12:00:00Z'));
    instance=await repository.updateRangeInstance(instance.id,{status:'destroyed',resourceSummary:null});
    const proof=await loadPlatformBillingProof(repository);
    expect(proof.createdLedgerIds.size).toBe(8);
    jest.spyOn(globalThis,'fetch').mockResolvedValue(signedTencentBillingResponse([tencentBill({BusinessCode:'p_nat',ResourceId:'nat-new',
      ComponentSet:[{ComponentCode:'v_nat_gateway',RealCost:'0.25'}]})]));
    await tencentBillingSync(repository).syncRange(TENCENT_BILLING_WINDOW);
    expect((await new BillingService(repository).getSummary(TENCENT_BILLING_WINDOW)).totalPretaxAmount).toBe(0.25);
  });
  it('does not guess a new source for an existing unknown row during cleanup',async()=>{
    const repository=createMemoryAdminRepository();const instance=await repository.createRangeInstance({name:'unknown-source',cloudProvider:'tencent_cloud',ownerUserId:'owner'});
    const row=await repository.createBillingLedgerResource({cloudProvider:'tencent_cloud',cloudAccountUid:context.cloudAccountUid,regionId:context.regionId,
      cloudResourceId:'nat-unknown',cloudResourceType:'nat_gateway',billingScope:'user',ownerUserId:'owner',rangeInstanceId:instance.id,sourceProvisionJobId:null,billingStartAt:new Date('2026-09-01')});
    const destroy=await repository.createProvisionJob({rangeInstanceId:instance.id,jobType:'destroy',triggeredBy:'owner'});
    await syncRangeInstanceBillingLedger({repository,instance,resourceSummary:{...summary('unused'),hostIds:{},systemDiskIds:{},eipAllocationIds:{},natGatewayIds:{edge:'nat-unknown'}},
      regionId:context.regionId,cloudAccountUid:context.cloudAccountUid,sourceProvisionJobId:destroy.id,billingStartAt:new Date('2026-09-01')});
    expect((await repository.listBillingLedgerResources()).find(value=>value.id===row.id)!.sourceProvisionJobId).toBeNull();
  });
});
