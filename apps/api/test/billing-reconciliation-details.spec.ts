import { BillingService } from '../src/admin/billing.service';
import * as platformProof from '../src/admin/billing-platform-scope';
import { runInCloudWorkspace, runInSystemCloudWorkspaceScope } from '../src/auth/cloud-workspace-scope';

const scope = { cloudWorkspaceId:'workspace-a',provider:'tencent_cloud' as const,accountUid:'100001',actorUserId:'owner-a',isPlatformManager:false };
const window = { startAt:'2026-09-30',endAt:'2026-09-30' };
function fixture() {
  const ledgers = Array.from({length:9},(_,index) => ({ id:`ledger-${index}`,cloudWorkspaceId:scope.cloudWorkspaceId,
    cloudProvider:scope.provider,cloudAccountUid:scope.accountUid,regionId:'ap-shanghai',cloudResourceId:`ins-owned${index}`,cloudResourceType:'ecs',
    rangeInstanceId:'range-a',sourceProvisionJobId:'old-create',ownerUserId:'owner-a',billingStartAt:new Date('2026-09-01'),releasedAt:new Date('2026-09-30'),
    tagsSnapshot:{secret:'fixture-secret-must-not-return'},createdAt:new Date('2026-09-01'),updatedAt:new Date('2026-09-30') }));
  const proof = { ledgers,createdLedgerIds:new Set<string>(),unverifiedSourceLedgerIds:new Set(ledgers.map(row=>row.id)),imageImports:[],packedImages:[],cosBuckets:[] };
  jest.spyOn(platformProof,'loadPlatformBillingProof').mockResolvedValue(proof as never);
  const repository = { listBillingLineItems:jest.fn().mockResolvedValue([]),listBillingAnomalies:jest.fn().mockResolvedValue([]),
    getProvisionJobById:jest.fn().mockResolvedValue({id:'old-create',cloudWorkspaceId:scope.cloudWorkspaceId,rangeInstanceId:'range-a',jobType:'create',status:'failed'}),
    listProvisionJobStepLogs:jest.fn().mockResolvedValue([]),updateBillingLedgerResource:jest.fn(),createBillingLedgerResource:jest.fn() };
  return { ledgers,proof,repository,service:new BillingService(repository as never) };
}
afterEach(()=>jest.restoreAllMocks());
it('retains the aggregate and exposes every selected-workspace fee identity without raw tags or writes',async()=>{
  const s=fixture();
  const result=await runInCloudWorkspace(scope,()=>s.service.getSummary(window));
  expect(result).toMatchObject({totalPretaxAmount:0,billingStatus:'provisional',reconciliationIssues:[{resourceType:'unknown',resourceCount:9}]});
  expect(result.reconciliationIssues[0].resources).toHaveLength(9);
  expect(result.reconciliationIssues[0].resources[0]).toEqual({resourceKey:'ledger:ledger-0',ledgerId:'ledger-0',cloudWorkspaceId:'workspace-a',
    cloudProvider:'tencent_cloud',cloudResourceId:'ins-owned0',cloudResourceType:'ecs',rangeInstanceId:'range-a',sourceProvisionJobId:'old-create',
    ownerUserId:'owner-a',cloudAccountUid:'100001',regionId:'ap-shanghai',billingStartAt:'2026-09-01T00:00:00.000Z',releasedAt:'2026-09-30T00:00:00.000Z',
    proofFailureReason:'SOURCE_JOB_CREATION_INVENTORY_MISSING'});
  expect(s.repository.getProvisionJobById).toHaveBeenCalledTimes(1);expect(s.repository.listProvisionJobStepLogs).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(result)).not.toContain('fixture-secret');
  expect(s.repository.updateBillingLedgerResource).not.toHaveBeenCalled();expect(s.repository.createBillingLedgerResource).not.toHaveBeenCalled();
});
it.each(['missing-resource','conflicting-proof','wrong-job-type','missing-uid','snapshot'])('returns safe provenance reasons for %s',async reason=>{
  const s=fixture();
  s.repository.listProvisionJobStepLogs.mockResolvedValue([{jobId:'old-create',cloudWorkspaceId:scope.cloudWorkspaceId,status:'succeeded',stepName:'platform_billing_creation_inventory',
    message:JSON.stringify({resources:reason==='missing-resource'?[]:[{cloudResourceId:'ins-owned0',cloudResourceType:'ecs'}],accessKeySecret:'receipt-secret-must-not-return'})}] as never);
  if(reason==='wrong-job-type')s.repository.getProvisionJobById.mockResolvedValue({id:'old-create',cloudWorkspaceId:scope.cloudWorkspaceId,rangeInstanceId:'range-a',jobType:'destroy'} as never);
  if(reason==='missing-uid')s.ledgers[0].cloudAccountUid=null as never;
  if(reason==='snapshot')s.ledgers[0].cloudResourceType='snapshot';
  const result=await runInCloudWorkspace(scope,()=>s.service.getSummary(window));
  const expected={ 'missing-resource':'SOURCE_RESOURCE_NOT_IN_CREATION_INVENTORY','conflicting-proof':'SOURCE_CREATION_PROOF_CONFLICT','wrong-job-type':'SOURCE_JOB_NOT_CREATION','missing-uid':'ACCOUNT_UID_MISSING','snapshot':'IMAGE_OR_STORAGE_SOURCE_PROOF_INCOMPLETE' };
  expect(result.reconciliationIssues[0].resources[0].proofFailureReason).toBe(expected[reason as keyof typeof expected]);
  expect(JSON.stringify(result)).not.toContain('receipt-secret');
});
it('never exposes other workspace identities or system-wide resource details',async()=>{
  const s=fixture();const foreign={...s.ledgers[0],id:'foreign-ledger',cloudWorkspaceId:'workspace-b',cloudResourceId:'ins-private-foreign'};
  s.proof.ledgers.push(foreign);s.proof.unverifiedSourceLedgerIds.add(foreign.id);
  const selected=await runInCloudWorkspace(scope,()=>s.service.getSummary(window));
  expect(selected.reconciliationIssues[0].resources).toHaveLength(9);
  expect(JSON.stringify(selected)).not.toContain('ins-private-foreign');expect(JSON.stringify(selected)).not.toContain('foreign-ledger');
  const system=await runInSystemCloudWorkspaceScope(()=>s.service.getSummary(window));
  expect(system.reconciliationIssues).toEqual([]);
});
it('filters both pending counts and business IDs by actor while managers may inspect the selected workspace',async()=>{
  const s=fixture();const other={...s.ledgers[0],id:'ledger-user-b',ownerUserId:'owner-b',cloudResourceId:'ins-owned-by-b'};
  s.proof.ledgers.push(other);s.proof.unverifiedSourceLedgerIds.add(other.id);
  const alice=await runInCloudWorkspace(scope,()=>s.service.getSummary(window));
  expect(alice.reconciliationIssues[0].resourceCount).toBe(9);expect(JSON.stringify(alice)).not.toContain('ins-owned-by-b');
  const bob=await runInCloudWorkspace({...scope,actorUserId:'owner-b'},()=>s.service.getSummary(window));
  expect(bob.reconciliationIssues[0].resourceCount).toBe(1);expect(bob.reconciliationIssues[0].resources).toHaveLength(1);
  expect(bob.reconciliationIssues[0].resources[0].cloudResourceId).toBe('ins-owned-by-b');expect(JSON.stringify(bob)).not.toContain('ins-owned0');
  const manager=await runInCloudWorkspace({...scope,isPlatformManager:true},()=>s.service.getSummary(window));
  expect(manager.reconciliationIssues[0].resources).toHaveLength(10);
  const anonymous=await runInCloudWorkspace({...scope,actorUserId:undefined},()=>s.service.getSummary(window));
  expect(anonymous.reconciliationIssues).toEqual([]);
  const missingWorkspace=await s.service.getSummary(window);
  expect(missingWorkspace.reconciliationIssues[0].resources).toEqual([]);
});
