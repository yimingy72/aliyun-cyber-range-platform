import type { AdminRepository, BillingLedgerResourceType, ProvisionJobStepLogRecord } from './admin.repository';
import { readPatrolInventories, patrolResourceIdentities, patrolResourceKey } from './resource-patrol-inventory';
import { buildProvisionJobEvidence } from './provision-job-evidence';
import { FAILED_CREATE_CLEANUP_PROOF_STEP, readFailedCreateCleanupProof } from './failed-create-cleanup-evidence';

// Repair billing records from saved creation evidence; never rediscover or operate cloud resources here.
export async function recoverBillingInventories(repository: AdminRepository,
  account: { cloudWorkspaceId: string; provider: string; accountUid: string }) {
  if (account.provider !== 'alibaba_cloud') return 0;
  const [instances, jobs, ledgers] = await Promise.all([
    repository.listRangeInstances(), repository.listProvisionJobs(), repository.listBillingLedgerResources(),
  ]);
  const cache = new Map<string, Promise<ProvisionJobStepLogRecord[]>>();
  const steps = (id: string) => {
    if (!cache.has(id)) cache.set(id, repository.listProvisionJobStepLogs(id));
    return cache.get(id)!;
  };
  const inventories = await readPatrolInventories({ listProvisionJobStepLogs: steps }, instances, jobs, account);
  let recovered = 0;
  for (const inventory of inventories) {
    const originalJobs = jobs.filter(job => job.rangeInstanceId === inventory.instance.id && job.cloudWorkspaceId === account.cloudWorkspaceId);
    for (const resource of inventory.resources) {
      const key = patrolResourceKey(resource);
      if (!['ecs','disk','eip','nat_gateway'].includes(resource.type) || !inventory.proven.has(key)) continue;
      const sourceId = inventory.birthSources.get(key), source = originalJobs.find(job => job.id === sourceId);
      if (!source?.startedAt) continue;
      const changedClaim = (await steps(source.id)).some(step => step.status === 'succeeded'
        && ['range_resource_creation_receipt','single_instance_creation_receipt','platform_billing_creation_inventory'].includes(step.stepName)
        && step.createdAt < source.startedAt!);
      const existing = ledgers.find(row => row.cloudProvider === account.provider && row.regionId === inventory.context.regionId
        && row.cloudResourceType === resource.type && row.cloudResourceId === resource.id);
      if (existing) {
        if (!changedClaim && existing.rangeInstanceId === inventory.instance.id && existing.ownerUserId === inventory.instance.ownerUserId
          && existing.singleInstanceBatchId === (inventory.instance.singleInstanceBatchId ?? null)
          && existing.billingScope === (inventory.instance.ownerUserId ? 'user' : 'platform')
          && (!existing.cloudAccountUid || existing.cloudAccountUid === account.accountUid)
          && (existing.sourceProvisionJobId === null || existing.sourceProvisionJobId === source.id)
          && (!existing.cloudAccountUid || !existing.sourceProvisionJobId || !existing.tagsSnapshot.CloudAccountContextId)) {
          if (await repository.repairBillingLedgerOrigin({ expected: existing, sourceProvisionJobId: source.id,
            cloudAccountUid: account.accountUid, cloudAccountContextId: inventory.context.cloudAccountContextId,
            auditMessage: JSON.stringify({ version: 1, evidence: 'saved_creation_receipt', ledgerId: existing.id, sourceProvisionJobId: source.id,
              cloudWorkspaceId: account.cloudWorkspaceId, cloudAccountUid: account.accountUid, cloudAccountContextId: inventory.context.cloudAccountContextId }) })) recovered++;
        }
        continue;
      }
      let releasedAt: Date | null = null;
      for (const job of originalJobs) {
        for (const step of await steps(job.id)) {
          if (step.jobId !== job.id || step.cloudWorkspaceId !== account.cloudWorkspaceId || step.status !== 'succeeded') continue;
          const at = step.finishedAt ?? step.startedAt ?? step.createdAt;
          if (at < source.startedAt) continue;
          if (step.stepName === FAILED_CREATE_CLEANUP_PROOF_STEP) {
            const proof = readFailedCreateCleanupProof(step.message);
            if (proof?.rangeInstanceId === inventory.instance.id && proof.provisionJobId === job.id && proof.claimStartedAt === job.startedAt?.toISOString()
              && proof.cloudAccountUid === account.accountUid && proof.cloudAccountContextId === inventory.context.cloudAccountContextId
              && proof.regionId === inventory.context.regionId) releasedAt = at;
          }
          if (step.stepName === 'verify_destroy' && job.status === 'succeeded'
            && (job.jobType === 'destroy' || job.jobType === 'retry' && job.topologySnapshot?.operation === 'destroy')) {
            const evidence = buildProvisionJobEvidence(job, await steps(job.id), originalJobs, []);
            if (evidence.inventories.some(value => value.executionContext.cloudAccountUid === account.accountUid
              && value.executionContext.cloudAccountContextId === inventory.context.cloudAccountContextId
              && value.executionContext.regionId === inventory.context.regionId
              && patrolResourceIdentities(value.resources).some(row => patrolResourceKey(row) === key))) releasedAt = at;
          }
        }
      }
      const saved = await repository.createBillingLedgerResource({ cloudProvider: 'alibaba_cloud', cloudAccountUid: account.accountUid,
        regionId: inventory.context.regionId, cloudResourceId: resource.id, cloudResourceType: resource.type as BillingLedgerResourceType,
        billingScope: inventory.instance.ownerUserId ? 'user' : 'platform', ownerUserId: inventory.instance.ownerUserId,
        rangeInstanceId: inventory.instance.id, singleInstanceBatchId: inventory.instance.singleInstanceBatchId ?? null,
        sourceProvisionJobId: changedClaim ? null : source.id, billingStartAt: changedClaim ? source.createdAt : source.startedAt, releasedAt,
        tagsSnapshot: { CloudAccountContextId: inventory.context.cloudAccountContextId, BillingRecoveredFromJobEvidence: true, OriginalCreationJobId: source.id } }).catch(async (error: unknown) => {
          if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') {
            const concurrent = await repository.findBillingLedgerResource({ cloudProvider: 'alibaba_cloud', regionId: inventory.context.regionId,
              cloudResourceId: resource.id, cloudResourceType: resource.type as BillingLedgerResourceType });
            if (concurrent?.cloudAccountUid === account.accountUid && concurrent.rangeInstanceId === inventory.instance.id
              && concurrent.ownerUserId === inventory.instance.ownerUserId) return null;
          }
          throw error;
        });
      if (!saved) continue;
      ledgers.push(saved);
      recovered++;
    }
  }
  return recovered;
}
