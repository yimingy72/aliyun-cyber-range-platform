import type { AdminRepository, CreateBillingLedgerResourceInput } from '../../src/admin/admin.repository';

export async function createProvenBillingLedger(repository: AdminRepository, input: CreateBillingLedgerResourceInput) {
  const instance = await repository.createRangeInstance({ name: `source-${input.cloudResourceId}`,
    ownerUserId: input.ownerUserId, resourceSummary: { mode: 'opentofu', executionContext: { cloudAccountUid: input.cloudAccountUid!, regionId: input.regionId, zoneId: `${input.regionId}-h`, cloudAccountContextId: 'test-context' } } });
  const job = await repository.createProvisionJob({ rangeInstanceId: instance.id, jobType: 'create', triggeredBy: input.ownerUserId ?? 'admin' });
  const ledger = await repository.createBillingLedgerResource({ ...input, sourceProvisionJobId: job.id, rangeInstanceId: instance.id });
  return { instance, job, ledger };
}
