import { BillingLifecycleService } from '../src/admin/billing-lifecycle.service';
import { BillingService } from '../src/admin/billing.service';
import { BillingSyncService } from '../src/admin/billing-sync.service';
import { billingChargeItems, billingDocumentStatus } from '../src/admin/billing-read-model';
import { billingExpenseScope } from '../src/admin/billing-expense-scope';
import { runInCloudWorkspace } from '../src/auth/cloud-workspace-scope';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';
import { createProvenBillingLedger } from './support/create-billing-fixture';

const day='2026-10-14';
const scope={cloudWorkspaceId:'unified-billing',provider:'alibaba_cloud' as const,accountUid:'100001',actorUserId:'alice',isPlatformManager:true};
const inScope=<T>(run:()=>Promise<T>)=>runInCloudWorkspace(scope,run);
const context:any={provider:scope.provider,accountUid:scope.accountUid,accountUidResolved:true,cloudAccountContextId:'context',defaultRegion:'cn-beijing'};
async function fixture(){
  const repository=createMemoryAdminRepository();
  await repository.createPlatformUser({id:'alice',username:'Alice',role:'admin',passwordHash:'fixture'});
  const source=await createProvenBillingLedger(repository,{cloudAccountUid:scope.accountUid,cloudResourceId:'i-owned',cloudResourceType:'ecs',regionId:'cn-beijing',ownerUserId:'alice',billingScope:'user',billingStartAt:new Date(day)});
  const store:any={units:async()=>[],tasks:async()=>[],settings:async()=>({mode:'resource',generation:0})};
  const service=new BillingLifecycleService(repository,store);
  const bill=async(id:string,amount:number,ledger=source.ledger,extra={})=>repository.upsertBillingLineItems([{cloudAccountUid:scope.accountUid,syncBatchId:'fixture',sourceFingerprint:id,billCycle:'2026-10',billingDate:day,
    productCode:ledger.cloudResourceType==='snapshot'?'snapshot':'ecs',billItem:'云服务器配置',cloudResourceId:ledger.cloudResourceId,cloudResourceType:ledger.cloudResourceType,pretaxAmount:amount,currency:'CNY',billingScope:'user',ownerUserId:'alice',matchedLedgerId:ledger.id,
    rawPayload:{OwnerID:scope.accountUid,Region:'cn-beijing',InstanceID:ledger.cloudResourceId,BillingItem:'云服务器配置'},...extra}]);
  return {repository,source,store,service,bill};
}
describe('unified billing read model',()=>{
  beforeEach(()=>jest.useFakeTimers().setSystemTime(new Date(day)));
  afterEach(()=>{jest.useRealTimers();jest.restoreAllMocks();});
  it('assigns image/snapshot expenses to the platform without changing their immutable creator or the VM cost',async()=>inScope(async()=>{
    const f=await fixture();
    const artifact=await f.repository.createPackedImageArtifact({cloudAccountContextId:'context',cloudAccountUid:scope.accountUid,regionId:'cn-beijing',ownerUserId:'alice',sourceRangeInstanceId:f.source.instance.id,sourceHostKey:'host',sourceInstanceId:'i-owned',sourceDiskIds:['d-source']});
    await f.repository.updatePackedImageArtifact(artifact.id,{imageId:'m-owned',backingSnapshotIds:['s-owned']});
    const snapshot=await f.repository.createBillingLedgerResource({cloudAccountUid:scope.accountUid,regionId:'cn-beijing',cloudResourceId:'s-owned',cloudResourceType:'snapshot',billingScope:'user',ownerUserId:'alice',rangeInstanceId:f.source.instance.id,billingStartAt:new Date(day)});
    await f.bill('vm',2);await f.bill('snapshot',0.5,snapshot);
    const user=await f.service.list({startAt:day,endAt:day,view:'user'}),platform=await f.service.list({startAt:day,endAt:day,view:'platform'});
    expect(user.filteredAmounts).toEqual([{currency:'CNY',pretaxAmount:2}]);expect(platform.filteredAmounts).toEqual([{currency:'CNY',pretaxAmount:0.5}]);
    expect(platform.items[0]).toMatchObject({kind:'platform_image',ownerUserId:null,sourceInstanceId:f.source.instance.id});
    expect((await f.repository.listPackedImageArtifacts())[0].ownerUserId).toBe('alice');
    expect((await f.repository.listBillingLedgerResources()).find(row=>row.id===snapshot.id)).toMatchObject({ownerUserId:'alice',billingScope:'user'});
    await f.repository.updatePackedImageArtifact(artifact.id,{status:'deleted'});
    const retained=await f.service.list({startAt:day,endAt:day,view:'platform'},true);
    expect(retained.items[0]).toMatchObject({lifecycleStatus:'active',resourceCount:1,amounts:[{currency:'CNY',pretaxAmount:0.5}]});
    const legacy=new BillingService(f.repository);expect((await legacy.listPlatformItems({startAt:day,endAt:day}))[0]).toMatchObject({cloudResourceId:'s-owned',billingScope:'platform',ownerUserId:null});
    const sync=new BillingSyncService(f.repository,{} as any,{getAccountContext:async()=>context} as any);
    const prepared=await sync.prepareScopedRows({billingDate:day,context,items:[{OwnerID:scope.accountUid,Region:'cn-beijing',ProductCode:'snapshot',InstanceID:'s-owned',BillingDate:day,Currency:'CNY',PretaxAmount:0.5}]});
    expect(prepared.groups[0].items[0]).toMatchObject({billingScope:'platform',ownerUserId:null,pretaxAmount:0.5});
    expect(billingExpenseScope(f.source.ledger,'snapshot')).toEqual({billingScope:'platform',ownerUserId:null});
    expect(billingExpenseScope(f.source.ledger,'ecs')).toEqual({billingScope:'user',ownerUserId:'alice'});
    const hidden=await runInCloudWorkspace({...scope,isPlatformManager:false},()=>f.service.list({startAt:day,endAt:day,view:'platform'}));expect(hidden.total).toBe(0);
  }));
  it('reuses one display snapshot across views/details but explicit refresh and source verification remain fresh',async()=>inScope(async()=>{
    const f=await fixture();await f.bill('initial',2);
    const load=jest.spyOn(f.service,'load');
    const first=await f.service.list({startAt:day,endAt:day,view:'user'});
    await f.service.detail(first.items[0].id,{startAt:day,endAt:day});await f.service.list({startAt:day,endAt:day,view:'platform'});
    expect(load).toHaveBeenCalledTimes(1);
    const next=await createProvenBillingLedger(f.repository,{cloudAccountUid:scope.accountUid,cloudResourceId:'i-new',cloudResourceType:'ecs',regionId:'cn-beijing',ownerUserId:'alice',billingScope:'user',billingStartAt:new Date(day)});
    expect((await f.service.loadProof()).ledgers.some(row=>row.id===next.ledger.id)).toBe(true);
    expect((await f.service.list({startAt:day,endAt:day,view:'user'})).total).toBe(1);
    expect((await f.service.list({startAt:day,endAt:day,view:'user'},true)).total).toBe(2);
    expect(load).toHaveBeenCalledTimes(2);
    const bob=await runInCloudWorkspace({...scope,actorUserId:'bob',isPlatformManager:false},()=>f.service.list({startAt:day,endAt:day,view:'user'}));expect(bob.total).toBe(0);
    expect(load).toHaveBeenCalledTimes(3);
  }));
  it('shares one fresh load when list and open detail refresh at the same time',async()=>inScope(async()=>{
    const f=await fixture();await f.bill('booked',2);
    const load=jest.spyOn(f.service,'load');
    const window={startAt:day,endAt:day};
    const [list,detail]=await Promise.all([f.service.list(window,true),f.service.detail('instance:'+f.source.instance.id,window,true)]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(detail.entry.amounts).toEqual(list.items[0].amounts);
    expect(detail.charges.filter(row=>row.status==='issued')).toHaveLength(1);
  }));
  it('projects booked ECS specs and preserves exact component totals, without using accumulated usage as disk capacity',async()=>inScope(async()=>{
    const f=await fixture();
    const raw={OwnerID:scope.accountUid,Region:'cn-beijing',InstanceID:'i-owned',InstanceSpec:'ecs.e-c1m1.large',
      BillingItem:'云服务器配置',BillingItemCode:'InstanceType',InstanceConfig:'CPU:2核;内存:2GB;系统盘大小:40GiB;镜像平台:linux;unrelated:private',Usage:'120',UsageUnit:'GiB'};
    await f.bill('config',2,f.source.ledger,{rawPayload:raw});
    await f.bill('os',0,f.source.ledger,{rawPayload:{...raw,BillingItem:'ImageOS',BillingItemCode:'ImageOS'}});
    await f.bill('refund',-0.25,f.source.ledger,{rawPayload:{...raw,Item:'Refund'}});
    const win={startAt:day,endAt:day};
    const result=await f.service.detail('instance:'+f.source.instance.id,win);
    expect(result.resourceFees).toEqual([{resourceType:'ecs',resourceId:'i-owned',amounts:[{currency:'CNY',pretaxAmount:1.75}],
      specification:{cpu:2,memory:'2 GB',systemDisk:'40 GiB',os:'Linux',instanceType:'ecs.e-c1m1.large'}}]);
    expect(result.charges.map(row=>row.amounts[0].pretaxAmount).sort((a,b)=>a-b)).toEqual([-0.25,0,2]);
    expect(JSON.stringify(result.resourceFees)).not.toContain('private');
    await f.bill('changed',1,f.source.ledger,{rawPayload:{...raw,InstanceConfig:'CPU:4核;内存:4GB'}});
    expect((await f.service.detail('instance:'+f.source.instance.id,win,true)).resourceFees).toMatchObject([{configurationChanged:true}]);
  }));
  it('paginates authoritative batches as whole rows even when all batch names are identical',async()=>inScope(async()=>{
    const f=await fixture();
    for(let i=0;i<21;i++){
      const batch=await f.repository.createSingleInstanceBatch({name:'同名训练',platformImageAssetId:'asset',imageId:'m-fixture',imageDisplayName:'fixture',cpu:2,memory:4,systemDiskSize:40,quantity:2,ownerUserId:'alice'});
      for(let j=0;j<2;j++)await f.repository.createRangeInstance({name:`成员-${i}-${j}`,status:'running',instanceMode:'single',singleInstanceBatchId:batch.id,ownerUserId:'alice'});
    }
    const first=await f.service.list({startAt:day,endAt:day,view:'user',groupBy:'batch',pageSize:20,page:1});
    expect(first.total).toBe(22);expect(first.items.filter(row=>row.rowType==='batch').every(row=>row.members.length===2)).toBe(true);
    const second=await f.service.list({startAt:day,endAt:day,view:'user',groupBy:'batch',pageSize:20,page:2});
    const batches=[...first.items,...second.items].filter(row=>row.rowType==='batch');expect(new Set(batches.map(row=>row.id)).size).toBe(21);
    expect(batches.flatMap(row=>row.members)).toHaveLength(42);
    const issued=await f.service.list({startAt:day,endAt:day,view:'user',groupBy:'batch',billStatus:'issued'});expect(issued.total).toBe(0);
  }));
  it('keeps zero/refunds and exact usage while exposing missing network charges without inventing money',()=>{
    const base:any={currency:'CNY',cloudResourceId:'eip-owned',cloudResourceType:'eip',matchedLedgerId:'ledger',billingDate:new Date(day),productCode:'cdt',billItem:'公网流量',rawPayload:{BillingItem:'公网流量',BillingItemCode:'internet_traffic',Usage:'0.125',UsageUnit:'GB',Item:'PayAsYouGoBill'}};
    const rows=[{...base,sourceFingerprint:'zero',pretaxAmount:0},{...base,sourceFingerprint:'paid',pretaxAmount:0.0625}, {...base,sourceFingerprint:'refund',pretaxAmount:-0.01,rawPayload:{...base.rawPayload,Item:'Refund'}}];
    const charges=billingChargeItems(rows,[{ledgerId:'ledger',cloudResourceId:'eip-owned',cloudResourceType:'eip',state:'partial'}]);
    expect(charges.filter(row=>row.status==='issued')).toHaveLength(2);expect(charges[0]).toMatchObject({usage:'0.25',usageUnit:'GB',amounts:[{currency:'CNY',pretaxAmount:0.0625}]});
    expect(charges.find(row=>row.category==='eip_configuration')).toMatchObject({status:'unissued',amounts:[],usage:null});
    const usageZero=billingChargeItems([{...base,sourceFingerprint:'numeric-zero',pretaxAmount:0,rawPayload:{...base.rawPayload,Usage:0}}],[]);expect(usageZero[0].usage).toBe('0');
    expect(billingDocumentStatus({amounts:[{currency:'CNY',pretaxAmount:0}],reconciliationStatus:'current'})).toBe('issued');
    expect(billingDocumentStatus({amounts:[],reconciliationStatus:'source_pending'})).toBe('pending');
    expect(billingDocumentStatus({amounts:[],reconciliationStatus:'current',billingNotRequired:true})).toBe('not_applicable');
    expect(billingDocumentStatus({amounts:[{currency:'CNY',pretaxAmount:0}],reconciliationStatus:'current',billingNotRequired:true})).toBe('issued');
  });
});
