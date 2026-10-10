import { RangeInstancesService } from '../src/admin/range-instances.service';
import { rangePackedImageArtifactSummaries } from '../src/admin/packed-image-diagnostic';
import { readPackedImageSourceSnapshots } from '../src/admin/packed-image-source-observation';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';
import { tencentPackBaselineFixture } from './support/tencent-pack-baseline-fixture';
import { createTencentBillingProof } from './support/create-tencent-billing-fixture';
import { syncRangeInstanceBillingLedger } from '../src/admin/billing-ledger-sync';
import { PlatformApiClient } from '../../../packages/platform-api-client/src/client';

const account = { provider:'tencent_cloud',cloudAccountContextId:'fixture-context',accountUid:'100001',accountUidResolved:true,
  defaultRegion:'ap-shanghai',defaultZoneId:'ap-shanghai-1',accessKeyId:'synthetic-id',accessKeySecret:'synthetic-secret' };
async function fixture() {
  const repository = createMemoryAdminRepository();
  const source = await createTencentBillingProof(repository,{ownerUserId:'owner'});
  const summary = source.instance.resourceSummary!;
  // Use the production writer: it first emits an initial receipt with no attachments, then the completed inventory.
  for (const resourceSummary of [summary, { ...summary, diskOwnershipProofs: { 'disk-system': { instanceId: 'ins-owned', method: 'persisted' as const } } }]) {
    await syncRangeInstanceBillingLedger({ repository, instance: source.instance, regionId: 'ap-shanghai', cloudAccountUid: '100001',
      resourceSummary, sourceProvisionJobId: source.job.id, billingStartAt: source.instance.createdAt });
  }
  await repository.updateBillingLedgerResource(source.ledgers[0].id,{releasedAt:new Date()});
  const input = {id:'range-pack-artifact',cloudProvider:'tencent_cloud' as const,cloudAccountContextId:'fixture-context',cloudAccountUid:'100001',regionId:'ap-shanghai',ownerUserId:'owner',
    sourceRangeInstanceId:source.instance.id,sourceHostKey:'host',sourceInstanceId:'ins-owned',sourceDiskIds:['disk-system']};
  const artifact = await repository.createPackedImageArtifact({...input,sourceSnapshotBaseline:tencentPackBaselineFixture(input)});
  await repository.updatePackedImageArtifact(artifact.id,{status:'creating'});
  const instance = await repository.updateRangeInstance(source.instance.id,{instanceMode:'range',status:'destroyed',resourceSummary:null});
  const system = {getAccountContextById:jest.fn(async()=>account)};
  const service = new RangeInstancesService(repository,{} as never,system as never,{} as never,{} as never);
  jest.spyOn(service as any,'attachRecoverySummary').mockImplementation(async(value:unknown)=>value);
  jest.spyOn(service as any,'resolveNodeFacts').mockResolvedValue({nodeStatuses:null,nodeBillingTags:null});
  jest.spyOn(service as any,'resolveSourceTemplateRevision').mockResolvedValue(null);
  return {repository,source,instance,artifact,system,service};
}
afterEach(()=>jest.restoreAllMocks());
describe('destroyed Tencent range pack source observations',()=>{
  it('retains same-job historical proof and exposes empty source disk request receipts through the exact detail getter',async()=>{
    const f=await fixture();
    expect((await f.repository.listBillingLedgerResources()).find(row=>row.id===f.source.ledgers[0].id)!.tagsSnapshot).toEqual({});
    const fetch=jest.spyOn(globalThis,'fetch').mockImplementation(async(_url,options)=>{
      expect((options!.headers as Record<string,string>)['X-TC-Action']).toBe('DescribeSnapshots');
      expect(JSON.parse(options!.body as string).Filters).toEqual([{Name:'disk-id',Values:['disk-system']}]);
      return new Response(JSON.stringify({Response:{RequestId:'original-disk-receipt',TotalCount:0,SnapshotSet:[]}}));
    });
    const client=new PlatformApiClient({baseUrl:'https://platform.example',token:'synthetic-token',fetch:async(input,options)=>{
      expect(input).toBe(`https://platform.example/admin/ranges/${f.instance.id}`);expect(options?.method).toBe('GET');
      return new Response(JSON.stringify(await f.service.getById(f.instance.id,{id:'owner',role:'user'})));
    }});
    const view=await client.getRangeInstance(f.instance.id);
    expect(view.packedImageArtifacts).toEqual([expect.objectContaining({id:f.artifact.id,status:'creating',phase:'unknown'})]);
    expect(view.packSourceSnapshots).toEqual([expect.objectContaining({artifactId:f.artifact.id,status:'absent',ownership:'unconfirmed',sourceDisks:[expect.objectContaining({
      sourceDiskId:'disk-system',candidateSnapshots:[],evidence:[expect.objectContaining({action:'DescribeSnapshots',requestIds:['original-disk-receipt']})],
    })]})]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await f.repository.getPackedImageArtifact(f.artifact.id))!.status).toBe('creating');
  });
  it('denies foreign owner before any cloud observation',async()=>{
    const f=await fixture();const fetch=jest.spyOn(globalThis,'fetch');
    await expect(f.service.getById(f.instance.id,{id:'foreign',role:'user'})).rejects.toThrow('access denied');
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['cloudAccountContextId','cloudAccountUid','regionId','sourceInstanceId','sourceDiskIds','ownerUserId'])('rejects conflicting artifact %s even with a copied baseline',async field=>{
    const f=await fixture();const rows=await f.repository.listPackedImageArtifacts();
    jest.spyOn(f.repository,'listPackedImageArtifacts').mockResolvedValue(rows.map(row=>({...row,[field]:field==='sourceDiskIds'?['disk-foreign']:'foreign'})));
    expect(await rangePackedImageArtifactSummaries(f.instance,f.repository)).toEqual([]);
  });
  it('does not borrow another job inventory or turn a missing receipt into absence',async()=>{
    const f=await fixture();jest.spyOn(f.repository,'listProvisionJobStepLogs').mockImplementation(async()=>[{jobId:'foreign-job',status:'succeeded',stepName:'platform_billing_creation_inventory',message:'{}'}] as never);
    expect(await rangePackedImageArtifactSummaries(f.instance,f.repository)).toEqual([]);
    jest.restoreAllMocks();const summaries=await rangePackedImageArtifactSummaries(f.instance,f.repository);
    jest.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify({Response:{TotalCount:0,SnapshotSet:[]}})));
    expect(await readPackedImageSourceSnapshots(summaries,f.system as never)).toEqual([expect.objectContaining({status:'unverified',ownership:'unconfirmed'})]);
  });
  it.each(['missing','null','foreign-instance','foreign-method','foreign-disk'])('rejects an incomplete/conflicting persisted disk attachment (%s), even with empty ledger tags',async kind=>{
    const f=await fixture();const logs=await f.repository.listProvisionJobStepLogs(f.source.job.id);
    const complete=JSON.parse(logs[1].message!);
    if(kind==='missing') delete complete.diskAttachments;
    else if(kind==='null') complete.diskAttachments['disk-system'].instanceId=null;
    else if(kind==='foreign-instance') complete.diskAttachments['disk-system'].instanceId='ins-other-host';
    else if(kind==='foreign-method') complete.diskAttachments['disk-system'].method='tags';
    else complete.resources=complete.resources.filter((row:{cloudResourceId:string})=>row.cloudResourceId!=='disk-system');
    jest.spyOn(f.repository,'listProvisionJobStepLogs').mockResolvedValue([logs[0],{...logs[1],message:JSON.stringify(complete)}]);
    expect(await rangePackedImageArtifactSummaries(f.instance,f.repository)).toEqual([]);
  });
  it('rejects missing/foreign sourceJob and provider/UID/workspace context without repairing empty-tag ledgers',async()=>{
    const f=await fixture();const original=f.repository.listBillingLedgerResources.bind(f.repository);
    for(const [field,value] of [['sourceProvisionJobId',null],['sourceProvisionJobId','other-job'],['cloudProvider','alibaba_cloud'],['cloudAccountUid','foreign'],['cloudWorkspaceId','foreign']] as Array<[string,string|null]>){
      jest.spyOn(f.repository,'listBillingLedgerResources').mockImplementation(async()=> (await original()).map(row=>({...row,[field]:value})) as never);
      expect(await rangePackedImageArtifactSummaries(f.instance,f.repository)).toEqual([]);
    }
    expect((await original()).find(row=>row.id===f.source.ledgers[0].id)!.tagsSnapshot).toEqual({});
  });
  it('does not stitch the CVM from an initial receipt to disks from another incomplete receipt',async()=>{
    const f=await fixture();const logs=await f.repository.listProvisionJobStepLogs(f.source.job.id),complete=JSON.parse(logs[1].message!);
    complete.resources=complete.resources.filter((row:{cloudResourceType:string})=>row.cloudResourceType!=='ecs');
    jest.spyOn(f.repository,'listProvisionJobStepLogs').mockResolvedValue([logs[0],{...logs[1],message:JSON.stringify(complete)}]);
    expect(await rangePackedImageArtifactSummaries(f.instance,f.repository)).toEqual([]);
  });
});
