import { ProvisioningWorkerService } from '../src/provisioning/provisioning-worker.service';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';
import { runInCloudWorkspace } from '../src/auth/cloud-workspace-scope';

const account = { provider:'tencent_cloud' as const,accountUid:'100000000001',accountUidResolved:true,cloudAccountContextId:'context',defaultRegion:'ap-nanjing',defaultZoneId:'ap-nanjing-1',accessKeyId:'fixture',accessKeySecret:'fixture' };
const run = <T>(work: () => T) => runInCloudWorkspace({cloudWorkspaceId:'recovery-workspace',provider:account.provider,accountUid:account.accountUid},work);

it.each(['valid','missing','workspace','range','unstarted','destroy-source','unapproved-update'] as const)('checks original recovery job proof in the frozen platform workspace: %s', reason => run(async () => {
  const repository = createMemoryAdminRepository();
  const summary = {mode:'opentofu' as const,vpcId:'vpc-owned',executionContext:{provider:account.provider,cloudAccountContextId:account.cloudAccountContextId,cloudAccountUid:account.accountUid,regionId:account.defaultRegion,zoneId:account.defaultZoneId}};
  const instance = await repository.createRangeInstance({name:'recovery fixture',cloudProvider:account.provider,instanceMode:'range',status:'destroy_failed',resourceSummary:summary});
  const birth = await repository.createProvisionJob({rangeInstanceId:instance.id,jobType:'create',triggeredBy:'owner'});
  await repository.updateProvisionJob(birth.id,{status:'succeeded',startedAt:new Date(Date.now()-60_000)});
  const job = await repository.createProvisionJob({rangeInstanceId:instance.id,jobType:'destroy',triggeredBy:'owner'});
  await repository.updateRangeInstance(instance.id,{lastJobId:job.id});
  const claim = (await repository.claimRangeProvisionJob(job.id,new Date()))!;
  const readJob = repository.getProvisionJobById.bind(repository);
  jest.spyOn(repository,'getProvisionJobById').mockImplementation(async id => {
    const found = await readJob(id); if (id !== birth.id || !found || reason === 'valid') return found;
    if (reason === 'missing') return null;
    return {...found,...(reason === 'workspace' ? {cloudWorkspaceId:'foreign'} : reason === 'range' ? {rangeInstanceId:'foreign'}
      : reason === 'unstarted' ? {startedAt:null} : reason === 'destroy-source' ? {jobType:'destroy' as const} : {jobType:'update' as const,topologySnapshot:null})};
  });
  const recover = jest.fn(async (input: any) => { await input.assertRecoverySourceJob(birth.id); });
  const provider = {mode:'opentofu' as const,inspectResources:jest.fn(async()=>summary),recoverUntrackedResources:recover};
  const worker = new ProvisioningWorkerService(repository,provider as any,{} as any) as any;
  const operation = worker.captureRangeResources(claim,instance,{rangeInstanceId:instance.id,templateModulePath:'fixture',allocatedCidr:null,runtimeConfig:account,requirePersistedState:true},account);
  if (reason === 'valid') await expect(operation).resolves.toMatchObject({resourceSummary:summary});
  else await expect(operation).rejects.toThrow('original submitted platform job in its frozen workspace');
  expect(recover).toHaveBeenCalledTimes(1);
  expect(await repository.listBillingLedgerResources()).toHaveLength(0);
}));
