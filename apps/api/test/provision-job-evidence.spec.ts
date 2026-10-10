import { ProvisionJobsController } from '../src/admin/provision-jobs.controller';
import { ProvisionJobsService } from '../src/admin/provision-jobs.service';
import { buildProvisionJobEvidence } from '../src/admin/provision-job-evidence';

const now = new Date('2026-10-10T00:00:00Z');
const job: any = { id: 'job-1', cloudWorkspaceId: 'workspace-1', rangeInstanceId: 'range-1', jobType: 'destroy', status: 'succeeded', createdAt: now, startedAt: now, finishedAt: now,
  retryCount: 0, errorSummary: 'raw secret', topologySnapshot: { command: 'secret script', runtimeCredentials: { host: { password: 'private password' } } } };
const context = { provider: 'alibaba_cloud', cloudAccountContextId: 'context-1', cloudAccountUid: '1234', regionId: 'cn-hangzhou', zoneId: 'cn-hangzhou-h', accessKeySecret: 'private key' };
const inventory = { version: 1, rangeInstanceId: 'range-1', executionContext: context, resources: { hostIds: { win: 'i-win' }, systemDiskIds: { win: 'd-system' },
  secondaryNetworkInterfaceIds: { 'win:nic-2': 'eni-secondary' }, vpcId: 'vpc-owned', securityGroupIds: { win: 'sg-owned' },
  workspaceDir: '/private/state', userData: 'private script' }, password: 'private password' };
const step = (stepName: string, message: string | null = null): any => ({ id: 'step-1', jobId: 'job-1', cloudWorkspaceId: 'workspace-1', stepName, status: 'succeeded',
  message, stdoutExcerpt: 'private stdout', stderrExcerpt: 'private stderr', startedAt: now, finishedAt: now, createdAt: now });
const ledger: any = { cloudWorkspaceId: 'workspace-1', rangeInstanceId: 'range-1', cloudProvider: 'alibaba_cloud', cloudAccountUid: '1234', regionId: 'cn-hangzhou',
  cloudResourceId: 'i-win', cloudResourceType: 'ecs', sourceProvisionJobId: 'job-create', billingStartAt: now, releasedAt: now, tagsSnapshot: { password: 'private password' } };

function repository() {
  return { getProvisionJobById: jest.fn(async () => job), getRangeInstanceById: jest.fn(async () => ({ id: 'range-1', ownerUserId: 'alice', createdBy: 'alice' })),
    listProvisionJobStepLogs: jest.fn(async () => [step('range_resource_inventory', JSON.stringify(inventory)), step('verify_destroy', 'private message')]),
    listProvisionJobs: jest.fn(async () => [job]), listBillingLedgerResources: jest.fn(async () => [ledger]) };
}

describe('controlled provisioning evidence', () => {
  it('projects resource identities and fixed descriptions while dropping raw text, snapshots and secrets', async () => {
    const repo = repository(); const result = await new ProvisionJobsService(repo as any).getById('job-1', { id: 'alice', role: 'user' } as any, true);
    expect(result).toMatchObject({ id: 'job-1', evidence: { coverage: 'platform_recorded_job_evidence', invalidInventoryCount: 0,
      inventories: [{ executionContext: { provider: 'alibaba_cloud', cloudAccountUid: '1234' }, resources: { hostIds: { win: 'i-win' }, secondaryNetworkInterfaceIds: { 'win:nic-2': 'eni-secondary' } } }],
      steps: [{ stepName: 'range_resource_inventory' }, { stepName: 'verify_destroy', status: 'succeeded', description: 'Platform cloud absence verification' }],
      relatedJobs: [{ id: 'job-1' }], billingResources: [{ cloudResourceId: 'i-win', sourceProvisionJobId: 'job-create', releasedAt: now }] } });
    const text = JSON.stringify(result);
    for (const forbidden of ['private', 'secret', 'topologySnapshot', 'stdoutExcerpt', 'stderrExcerpt', 'workspaceDir', 'userData', 'password']) expect(text).not.toContain(forbidden);
    expect(repo.listBillingLedgerResources).toHaveBeenCalledWith({ rangeInstanceId: 'range-1' });
  });
  it('preserves the default response and does not load evidence unless requested', async () => {
    const repo = repository(); const result = await new ProvisionJobsService(repo as any).getById('job-1', { id: 'admin', role: 'admin' } as any);
    expect(result).toHaveProperty('topologySnapshot.command'); expect(result).not.toHaveProperty('evidence');
    expect(repo.listProvisionJobStepLogs).not.toHaveBeenCalled(); expect(repo.listBillingLedgerResources).not.toHaveBeenCalled();
  });
  it('checks ownership before reading any evidence', async () => {
    const repo = repository(); await expect(new ProvisionJobsService(repo as any).getById('job-1', { id: 'other', role: 'user' } as any, true)).rejects.toThrow('denied');
    expect(repo.listProvisionJobStepLogs).not.toHaveBeenCalled(); expect(repo.listProvisionJobs).not.toHaveBeenCalled(); expect(repo.listBillingLedgerResources).not.toHaveBeenCalled();
  });
  it('filters foreign jobs, steps and ledgers even if a repository returns a wider collection', () => {
    const evidence = buildProvisionJobEvidence(job, [step('verify_destroy'), { ...step('verify_destroy'), cloudWorkspaceId: 'foreign' }, { ...step('verify_destroy'), jobId: 'foreign' }],
      [job, { ...job, id: 'wrong-range', rangeInstanceId: 'foreign' }, { ...job, id: 'wrong-workspace', cloudWorkspaceId: 'foreign' }],
      [ledger, { ...ledger, cloudWorkspaceId: 'foreign' }, { ...ledger, rangeInstanceId: 'foreign' }]);
    expect(evidence.steps).toHaveLength(1); expect(evidence.relatedJobs).toHaveLength(1); expect(evidence.billingResources).toHaveLength(1);
  });
  it.each(['not-json', JSON.stringify({ ...inventory, rangeInstanceId: 'foreign' }), JSON.stringify({ ...inventory, executionContext: { ...context, provider: 'unknown' } }),
    JSON.stringify({ ...inventory, resources: { hostIds: { win: 'invalid id\nprivate token' } } })])('rejects incomplete or untrusted inventory without disclosing its text', message => {
    const evidence = buildProvisionJobEvidence(job, [step('range_resource_inventory', message)], [], []);
    expect(evidence.inventories).toEqual([]); expect(evidence.invalidInventoryCount).toBe(1); expect(JSON.stringify(evidence)).not.toContain('private');
  });
  it('does not interpret a raw log as a phase or independent cloud receipt', () => {
    const evidence = buildProvisionJobEvidence(job, [step('untrusted phase', 'verified all cloud resources')], [], []);
    expect(evidence.steps).toEqual([]); expect(evidence).not.toHaveProperty('allKnownAbsent'); expect(evidence).not.toHaveProperty('requestId');
  });
  it('accepts only boolean query strings', () => {
    const service: any = { getById: jest.fn() }; const controller = new ProvisionJobsController(service); const req: any = { adminUser: { id: 'alice' } };
    controller.getById(req, 'job-1', 'true'); expect(service.getById).toHaveBeenLastCalledWith('job-1', req.adminUser, true);
    controller.getById(req, 'job-1', 'false'); expect(service.getById).toHaveBeenLastCalledWith('job-1', req.adminUser, false);
    expect(() => controller.getById(req, 'job-1', 'yes')).toThrow('must be');
  });
});
