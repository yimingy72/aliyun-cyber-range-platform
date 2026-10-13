import { readProvenSingleInstanceIds } from '../src/admin/single-instance-resource-origin';
import type { AdminRepository, RangeInstanceRecord } from '../src/admin/admin.repository';

function fixture() {
  const context = { provider: 'alibaba_cloud', cloudAccountContextId: 'ctx-a', cloudAccountUid: 'uid-a', regionId: 'cn-hangzhou', zoneId: 'cn-hangzhou-h' };
  const instance = { id: 'member-a', instanceMode: 'single', cloudProvider: 'alibaba_cloud', cloudWorkspaceId: 'workspace-a',
    ownerUserId: 'alice', singleInstanceBatchId: 'batch-a', singleInstanceConfig: { executionBackend: 'opentofu', opentofuCreateJobId: 'create-a', ...context } } as unknown as RangeInstanceRecord;
  const job = { id: 'create-a', rangeInstanceId: instance.id, cloudWorkspaceId: 'workspace-a', jobType: 'create', status: 'failed', startedAt: new Date() };
  const rows: any[] = [], logs: any[] = [];
  const repository = { getProvisionJobById: jest.fn(async () => job), listBillingLedgerResources: jest.fn(async () => rows), listProvisionJobStepLogs: jest.fn(async () => logs) } as unknown as AdminRepository;
  const ledger = { cloudProvider: 'alibaba_cloud', cloudAccountUid: 'uid-a', regionId: 'cn-hangzhou', cloudWorkspaceId: 'workspace-a', rangeInstanceId: instance.id,
    singleInstanceBatchId: 'batch-a', ownerUserId: 'alice', sourceProvisionJobId: 'create-a', cloudResourceType: 'ecs', cloudResourceId: 'i-owned' };
  const receipt = { version: 1, cloudProvider: 'alibaba_cloud', cloudWorkspaceId: 'workspace-a', rangeInstanceId: instance.id,
    sourceJobId: 'create-a', ownerUserId: 'alice', executionContext: context, resources: { hostIds: { entry: 'i-owned' } } };
  return { instance, repository, rows, logs, ledger, receipt, job };
}

describe('independent single-instance creation origin', () => {
  it('does not turn a submitted job or copied candidate tags into exact physical origin', async () => {
    const f = fixture();
    expect(await readProvenSingleInstanceIds(f.repository, f.instance)).toEqual(new Set());
  });
  it('keeps failed creation and released ledger origins available for residual recovery', async () => {
    const f = fixture(); f.rows.push({ ...f.ledger, releasedAt: new Date() });
    expect(await readProvenSingleInstanceIds(f.repository, f.instance)).toEqual(new Set(['i-owned']));
  });
  it.each(['cloudAccountUid', 'regionId', 'ownerUserId', 'singleInstanceBatchId', 'sourceProvisionJobId', 'cloudWorkspaceId'])('rejects a ledger from another %s', async field => {
    const f = fixture(); f.rows.push({ ...f.ledger, [field]: 'foreign' });
    expect(await readProvenSingleInstanceIds(f.repository, f.instance)).toEqual(new Set());
  });
  it('accepts a durable provider completion receipt without retaining scripts or state files', async () => {
    const f = fixture(); f.logs.push({ jobId: f.job.id, cloudWorkspaceId: 'workspace-a', stepName: 'single_instance_creation_receipt', status: 'succeeded', message: JSON.stringify(f.receipt) });
    expect(await readProvenSingleInstanceIds(f.repository, f.instance)).toEqual(new Set(['i-owned']));
    f.receipt.executionContext.cloudAccountUid = 'foreign'; f.logs[0].message = JSON.stringify(f.receipt);
    expect(await readProvenSingleInstanceIds(f.repository, f.instance)).toEqual(new Set());
  });
  it('rejects a source job from a changed workspace before reading inventory', async () => {
    const f = fixture(); f.job.cloudWorkspaceId = 'workspace-b';
    await expect(readProvenSingleInstanceIds(f.repository, f.instance)).rejects.toThrow('workspace');
    expect(f.repository.listBillingLedgerResources).not.toHaveBeenCalled();
  });
});
