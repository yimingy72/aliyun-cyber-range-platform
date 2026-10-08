import { SingleInstanceBatchExecutionService } from '../src/admin/single-instance-batch-execution.service';
import { ProvisioningWorkerService } from '../src/provisioning/provisioning-worker.service';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';
import { FAILED_CREATE_CLEANUP_PROOF_STEP } from '../src/admin/failed-create-cleanup-evidence';
const snapshot={provider:'alibaba_cloud',defaultRegion:'cn-beijing',defaultZoneId:'cn-beijing-h',accessKeyId:'audit-fake',accessKeySecret:'audit-fake-secret',imageImportBucket:'',accountUid:'audit-uid',accountUidResolved:true};
async function nativeSetup() {
  const repo=createMemoryAdminRepository();
  await repo.upsertSingleInstanceNetworkProfile({provider:'alibaba_cloud',regionId:'cn-beijing',zoneId:'cn-beijing-h',vpcId:'audit-vpc',vpcCidr:'10.10.0.0/16',vswitchIds:['audit-vswitch'],vswitchCidrs:['10.10.1.0/24'],securityGroupId:'audit-sg',securityGroupName:'Audit'});
  const instance=await repo.createRangeInstance({name:'Audit failure',status:'pending_create',instanceMode:'single',singleInstanceConfig:{cpu:2,memory:4,imageId:'audit-image',systemDiskSize:40,hostKey:'ecs',quantityIndex:1},runtimeCredentials:{ecs:{password:'Audit-Test-Password-Only!'}}} as any);
  const job=await repo.createProvisionJob({rangeInstanceId:instance.id,jobType:'create',triggeredBy:'admin'});
  await repo.updateRangeInstance(instance.id,{lastJobId:job.id});
  const sys={getInstanceTypeAvailabilityInContext:jest.fn().mockResolvedValue({exactAvailable:true,matches:[{instanceTypeId:'ecs.e-c1m2.large'}],warning:null}),getSnapshot:jest.fn().mockResolvedValue(snapshot),getAccountContext:jest.fn().mockResolvedValue(snapshot)};
  const batch=new SingleInstanceBatchExecutionService(repo,sys as any);
  (batch as any).performAliyunRpcRequest=jest.fn().mockRejectedValue(new Error('Injected RunInstances uncertain failure'));
  return {repo,instance,job,sys,batch};
}
describe('native cleanup and request boundaries',()=>{
  it('marks native cloud cleanup failure destroy_failed on the normal path',async()=>{
    const {repo,instance,job,batch}=await nativeSetup();
    (batch as any).findSingleInstanceIdsByRangeInstanceTag=jest.fn().mockRejectedValue(new Error('Injected tag lookup denied'));
    await batch.executeCreateBatch([{instance,job:(await repo.claimProvisionJob(job.id,new Date()))!}]);
    expect((await repo.getRangeInstanceById(instance.id))?.status).toBe('destroy_failed');
  });
  it('marks native cloud cleanup success create_failed and clears resource state',async()=>{
    const {repo,instance,job,batch}=await nativeSetup();
    (batch as any).findSingleInstanceIdsByRangeInstanceTag=jest.fn().mockResolvedValue([]);
    await batch.executeCreateBatch([{instance,job:(await repo.claimProvisionJob(job.id,new Date()))!}]);
    expect(await repo.getRangeInstanceById(instance.id)).toMatchObject({status:'create_failed',resourceSummary:null,accessEntry:null});
  });
  it('preserves destroy_failed when the outer worker catch handles a transient job persistence failure',async()=>{
    const {repo,instance,job,sys,batch}=await nativeSetup();
    (batch as any).findSingleInstanceIdsByRangeInstanceTag=jest.fn().mockRejectedValue(new Error('Injected tag lookup denied'));
    const original=repo.commitSingleInstanceClaim.bind(repo);let injected=false;
    repo.commitSingleInstanceClaim=async(job,patch,jobPatch)=>{if(!injected&&jobPatch?.status==='failed'&&String(jobPatch.errorSummary).includes('Automatic cleanup failed')){injected=true;throw new Error('Injected transient job persistence failure');}return original(job,patch,jobPatch);};
    const worker=new ProvisioningWorkerService(repo,{create:jest.fn(),destroy:jest.fn()} as any,sys as any,batch,{reconcile:jest.fn()} as any);
    await worker.process(job.id);
    expect((batch as any).performAliyunRpcRequest).toHaveBeenCalled();
    expect(injected).toBe(true);expect(await repo.getRangeInstanceById(instance.id)).toMatchObject({status:'destroy_failed'});
    expect((await repo.getProvisionJobById(job.id))?.status).toBe('failed');
  });
});


describe('range automatic cleanup proof', () => {
  async function setup() {
    const repository = createMemoryAdminRepository();
    const template = await repository.createRangeTemplate({
      name: 'Cleanup proof test', slug: 'cleanup-proof-test', version: 'v1',
      modulePathOrRef: 'infra/opentofu/modules/alicloud-enterprise-range',
      topologySpec: {
        vpcCidr: '10.99.0.0/16',
        networkZones: [{ key: 'dmz', name: 'DMZ', purpose: 'public-entry', cidr: '10.99.1.0/24' }],
        hosts: [{ key: 'entry', name: 'Entry', zoneKey: 'dmz', role: 'entry', privateIp: '10.99.1.10' }],
        publicEntry: { hostKey: 'entry', protocols: [{ protocol: 'ssh', port: 22 }] },
      },
    });
    const instance = await repository.createRangeInstance({ name: 'Cleanup proof range', templateId: template.id, status: 'pending_create', allocatedCidr: '10.99.0.0/16' });
    const job = await repository.createProvisionJob({ rangeInstanceId: instance.id, jobType: 'create', triggeredBy: 'admin' });
    await repository.updateRangeInstance(instance.id, { lastJobId: job.id });
    const provisioner = { create: jest.fn().mockRejectedValue(new Error('Injected create failure')), destroy: jest.fn().mockResolvedValue(undefined) };
    const system = { getSnapshot: jest.fn().mockResolvedValue(snapshot), getAccountContext: jest.fn().mockResolvedValue({ ...snapshot, cloudAccountContextId: 'context-source' }) };
    const worker = new ProvisioningWorkerService(repository, provisioner as any, system as any);
    return { repository, instance, job, provisioner, worker };
  }
  it('emits a claim and source-context proof only after successful cleanup', async () => {
    const { repository, instance, job, worker } = await setup();
    await worker.process(job.id);
    const finished = await repository.getProvisionJobById(job.id);
    const logs = await repository.listProvisionJobStepLogs(job.id);
    const marker = logs.find(step => step.stepName === FAILED_CREATE_CLEANUP_PROOF_STEP);
    expect(marker?.status).toBe('succeeded');
    expect(JSON.parse(marker!.message!)).toEqual({ version: 1, rangeInstanceId: instance.id, provisionJobId: job.id, claimStartedAt: finished!.startedAt!.toISOString(), cloudAccountContextId: 'context-source', cloudAccountUid: 'audit-uid', regionId: 'cn-beijing' });
    expect(JSON.stringify(marker)).not.toContain('audit-fake');
    expect((await repository.getRangeInstanceById(instance.id))?.status).toBe('create_failed');
  });
  it.each(['destroy', 'ledger'])('does not emit proof when %s cleanup fails', async stage => {
    const { repository, instance, job, provisioner, worker } = await setup();
    if (stage === 'destroy') provisioner.destroy.mockRejectedValue(new Error('Injected destroy failure'));
    else repository.listBillingLedgerResources = jest.fn().mockRejectedValue(new Error('Injected ledger persistence failure'));
    await worker.process(job.id);
    expect((await repository.listProvisionJobStepLogs(job.id)).some(step => step.stepName === FAILED_CREATE_CLEANUP_PROOF_STEP)).toBe(false);
    expect((await repository.getRangeInstanceById(instance.id))?.status).toBe('destroy_failed');
  });
});
