import { RangeInstancesService } from '../src/admin/range-instances.service';
import { rangePackedImageArtifactSummaries } from '../src/admin/packed-image-diagnostic';
import { readPackedImageSourceSnapshots } from '../src/admin/packed-image-source-observation';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';
import { tencentPackBaselineFixture } from './support/tencent-pack-baseline-fixture';
import { createTencentBillingProof } from './support/create-tencent-billing-fixture';

const account = { provider:'tencent_cloud',cloudAccountContextId:'fixture-context',accountUid:'100001',accountUidResolved:true,
  defaultRegion:'ap-shanghai',defaultZoneId:'ap-shanghai-1',accessKeyId:'synthetic-id',accessKeySecret:'synthetic-secret' };
async function fixture() {
  const repository = createMemoryAdminRepository();
  const source = await createTencentBillingProof(repository,{ownerUserId:'owner'});
  await repository.updateBillingLedgerResource(source.ledgers[0].id,{tagsSnapshot:{PlatformHostKey:'host'},releasedAt:new Date()});
  await repository.createProvisionJobStepLog({jobId:source.job.id,stepName:'platform_billing_creation_inventory',status:'succeeded',message:JSON.stringify({
    version:1,cloudProvider:'tencent_cloud',cloudWorkspaceId:'legacy-unbound',rangeInstanceId:source.instance.id,sourceJobId:source.job.id,ownerUserId:'owner',
    executionContext:source.instance.resourceSummary!.executionContext,resources:[{cloudResourceType:'ecs',cloudResourceId:'ins-owned'},{cloudResourceType:'disk',cloudResourceId:'disk-system'}],
  })});
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
    const fetch=jest.spyOn(globalThis,'fetch').mockImplementation(async(_url,options)=>{
      expect((options!.headers as Record<string,string>)['X-TC-Action']).toBe('DescribeSnapshots');
      expect(JSON.parse(options!.body as string).Filters).toEqual([{Name:'disk-id',Values:['disk-system']}]);
      return new Response(JSON.stringify({Response:{RequestId:'original-disk-receipt',TotalCount:0,SnapshotSet:[]}}));
    });
    const view=await f.service.getById(f.instance.id,{id:'owner',role:'user'});
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
});
