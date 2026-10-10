import { readTencentSingleRecordedResourceStatus } from '../src/admin/single-instance-recorded-resource-status';
import { SingleInstancesService } from '../src/admin/single-instances.service';
import { requestTencentCloud } from '../src/admin/tencent-cloud-client';
import { describeTencentKnownResourcesWithEvidence } from '../src/admin/tencent-cloud-resources';
jest.mock('../src/admin/tencent-cloud-client', () => ({ ...jest.requireActual('../src/admin/tencent-cloud-client'), requestTencentCloud: jest.fn() }));
const request = requestTencentCloud as jest.Mock;
const account = { provider: 'tencent_cloud', accountUid: 'synthetic-uid', accountUidResolved: true, cloudAccountContextId: 'context-original',
  defaultRegion: 'ap-shanghai', defaultZoneId: 'ap-shanghai-2', accessKeyId: 'synthetic-ak', accessKeySecret: 'synthetic-sk' };
const context = { provider: account.provider, cloudAccountContextId: account.cloudAccountContextId, cloudAccountUid: account.accountUid, regionId: account.defaultRegion, zoneId: account.defaultZoneId };
const instance = { id: 'single-owned', cloudWorkspaceId: 'workspace-original', ownerUserId: 'owner-a', createdBy: 'owner-a', instanceMode: 'single', cloudProvider: 'tencent_cloud', singleInstanceBatchId: 'batch-a',
  singleInstanceConfig: { ...context, executionBackend: 'opentofu' }, resourceSummary: { mode: 'opentofu', executionContext: context, hostIds: { ecs: 'ins-owned' }, systemDiskIds: { ecs: 'disk-owned' } } };
function ledger(type = 'disk', id = 'disk-owned') { return { id: `ledger-${id}`, cloudWorkspaceId: instance.cloudWorkspaceId, cloudProvider: account.provider, cloudAccountUid: account.accountUid,
  regionId: account.defaultRegion, cloudResourceType: type, cloudResourceId: id, billingScope: 'user', ownerUserId: instance.ownerUserId, rangeInstanceId: instance.id, singleInstanceBatchId: instance.singleInstanceBatchId,
  sourceProvisionJobId: 'original-job', releasedAt: new Date('2026-10-10T00:00:00Z'), tagsSnapshot: {} }; }
function fixture(rows = [ledger('ecs','ins-owned'), ledger()]) {
  const repository = { listBillingLedgerResources: jest.fn().mockResolvedValue(rows), getRangeInstanceById: jest.fn().mockResolvedValue(structuredClone(instance)),
    getProvisionJobById: jest.fn().mockResolvedValue({ id: 'original-job', cloudWorkspaceId: instance.cloudWorkspaceId, rangeInstanceId: instance.id, jobType: 'create' }),
    listProvisionJobStepLogs: jest.fn().mockResolvedValue([]), updateBillingLedgerResource: jest.fn() };
  const execution = { resolveInstanceAccount: jest.fn().mockResolvedValue(account), findCloudInstanceIdsByRangeInstanceId: jest.fn().mockResolvedValue({ regionId: account.defaultRegion, instanceIds: [], matchedInstances: [] }) };
  const config = { getAccountContext: jest.fn(), getExecutionAccountContext: jest.fn() };
  const service = new SingleInstancesService(repository as never, config as never, {} as never, execution as never, {} as never, {} as never);
  return { repository, execution, config, service };
}
const response = (set: string, rows: unknown[] = [], total = rows.length, requestId = 'synthetic-request') => ({ RequestId: requestId, TotalCount: total, [set]: rows });
beforeEach(() => { jest.clearAllMocks(); request.mockReset(); request.mockImplementation(async input => response(input.action === 'DescribeInstances' ? 'InstanceSet' : input.action === 'DescribeDisks' ? 'DiskSet' : input.action === 'DescribeAddresses' ? 'AddressSet' : 'NatGatewaySet')); });
it('reports exact CVM and CBS absence with zero-row cloud RequestIds even for released historical ledgers', async () => {
  const s = fixture(), result = await s.service.getCloudResourceStatus(instance.id, { id: 'owner-a', role: 'user' } as never);
  expect(result.exists).toBe(false);
  expect(result.recordedResourceStatus).toMatchObject({ provider: 'tencent_cloud', cloudAccountContextId: 'context-original', cloudAccountUid: 'synthetic-uid', allKnownAbsent: true,
    coverage: 'persisted_instance_compute_resource_ids', resources: [
      { cloudResourceType: 'ecs', cloudResourceId: 'ins-owned', exists: false, sources: ['inventory','ledger'], ledgerIds: ['ledger-ins-owned'] },
      { cloudResourceType: 'disk', cloudResourceId: 'disk-owned', exists: false, ledgerIds: ['ledger-disk-owned'] },
    ] });
  expect(result.recordedResourceStatus!.evidence.map(row => [row.action,row.requestIds])).toEqual([['DescribeInstances',['synthetic-request']],['DescribeDisks',['synthetic-request']]]);
  expect(request.mock.calls.map(([input]) => input.parameters)).toEqual([{ InstanceIds: ['ins-owned'], Offset: 0, Limit: 100 }, { DiskIds: ['disk-owned'], Offset: 0, Limit: 100 }]);
  expect(s.repository.updateBillingLedgerResource).not.toHaveBeenCalled(); expect(s.config.getExecutionAccountContext).not.toHaveBeenCalled();
  expect(JSON.stringify(result)).not.toMatch(/synthetic-ak|synthetic-sk/);
});
it('keeps a retained detached or recycled CBS disk present while the CVM tag query is empty', async () => {
  const s = fixture(); request.mockImplementation(async input => input.action === 'DescribeDisks' ? response('DiskSet', [{ DiskId: 'disk-owned', DiskState: 'TORECYCLE', InstanceId: null, Tags: [] }]) : response('InstanceSet'));
  const result = await s.service.getCloudResourceStatus(instance.id, { id: 'owner-a', role: 'user' } as never);
  expect(result.exists).toBe(false); expect(result.recordedResourceStatus!.allKnownAbsent).toBe(false);
  expect(result.recordedResourceStatus!.resources.find(row => row.cloudResourceType === 'disk')!.exists).toBe(true);
  expect(request.mock.calls.every(([input]) => !input.parameters.Filters && !input.parameters.InstanceId)).toBe(true);
});
it.each(['provider','account','context','region','zone'])('rejects a changed %s before any exact-ID cloud query', async mismatch => {
  const changed: any = { ...account };
  changed[{ provider: 'provider', account: 'accountUid', context: 'cloudAccountContextId', region: 'defaultRegion', zone: 'defaultZoneId' }[mismatch]!] = 'other';
  await expect(readTencentSingleRecordedResourceStatus(instance as never, changed, fixture().repository as never)).rejects.toThrow(); expect(request).not.toHaveBeenCalled();
});
it.each(['cloudWorkspaceId','cloudProvider','cloudAccountUid','regionId','rangeInstanceId','ownerUserId','singleInstanceBatchId','billingScope'])('rejects foreign ledger %s before any cloud query', async field => {
  const row: any = ledger(); row[field] = 'foreign';
  await expect(readTencentSingleRecordedResourceStatus(instance as never, account as never, fixture([row]).repository as never)).rejects.toThrow('frozen'); expect(request).not.toHaveBeenCalled();
});
it('rejects source identity overrides in the old ledger tag snapshot', async () => {
  const row: any = ledger(); row.tagsSnapshot.CloudAccountContextId = 'context-current-pointer';
  await expect(readTencentSingleRecordedResourceStatus(instance as never, account as never, fixture([row]).repository as never)).rejects.toThrow('frozen'); expect(request).not.toHaveBeenCalled();
});
it('uses original creation inventory to audit a historical disk no longer present in the current summary', async () => {
  const s = fixture([ledger('disk','disk-historical')]); s.repository.listProvisionJobStepLogs.mockResolvedValue([{ jobId: 'original-job', cloudWorkspaceId: instance.cloudWorkspaceId, stepName: 'platform_billing_creation_inventory', status: 'succeeded',
    message: JSON.stringify({ version: 1, cloudProvider: 'tencent_cloud', cloudWorkspaceId: instance.cloudWorkspaceId, rangeInstanceId: instance.id, sourceJobId: 'original-job', ownerUserId: instance.ownerUserId, executionContext: context,
      resources: [{ cloudResourceType: 'disk', cloudResourceId: 'disk-historical' }] }) }] as never);
  const result = await readTencentSingleRecordedResourceStatus(instance as never, account as never, s.repository as never);
  expect(result.resources.find(row => row.cloudResourceId === 'disk-historical')).toMatchObject({ exists: false, sources: ['ledger'] });
  expect(request.mock.calls.find(([input]) => input.action === 'DescribeDisks')![0].parameters.DiskIds).toEqual(['disk-owned','disk-historical']);
});
it('refuses a historical ledger without context-bound creation inventory', async () => {
  const s = fixture([ledger('disk','disk-historical')]);
  await expect(readTencentSingleRecordedResourceStatus(instance as never, account as never, s.repository as never)).rejects.toThrow('frozen'); expect(request).not.toHaveBeenCalled();
});
it('includes retired IDs only under the same original frozen context', async () => {
  const older: any = structuredClone(instance); older.resourceSummary.retiredResources = { mode: 'opentofu', executionContext: context, dataDiskIds: { old: 'disk-retired' } };
  const result = await readTencentSingleRecordedResourceStatus(older, account as never, fixture().repository as never);
  expect(result.resources.some(row => row.cloudResourceId === 'disk-retired')).toBe(true);
  older.resourceSummary.retiredResources.executionContext = { ...context, cloudAccountContextId: 'foreign' }; request.mockClear();
  await expect(readTencentSingleRecordedResourceStatus(older, account as never, fixture().repository as never)).rejects.toThrow('frozen'); expect(request).not.toHaveBeenCalled();
});
it('does not turn an empty manifest into absence or perform an account-wide disk list', async () => {
  const empty: any = structuredClone(instance); empty.resourceSummary = { mode: 'opentofu', executionContext: context };
  const result = await readTencentSingleRecordedResourceStatus(empty, account as never, fixture([]).repository as never);
  expect(result.allKnownAbsent).toBeNull(); expect(result.evidence).toEqual([]); expect(request).not.toHaveBeenCalled();
});
it('excludes unverified disks and marks unknown lifecycle coverage without adopting their costs', async () => {
  const unverified: any = structuredClone(instance); unverified.resourceSummary.unverifiedDiskIds = { external: 'disk-external' };
  const result = await readTencentSingleRecordedResourceStatus(unverified, account as never, fixture().repository as never);
  expect(result.allKnownAbsent).toBeNull(); expect(result.excludedUnverifiedDiskIds).toEqual(['disk-external']);
  expect(request.mock.calls.some(([input]) => input.parameters.DiskIds?.includes('disk-external'))).toBe(false);
});
it('does not claim image, snapshot or COS retention is cleaned by a compute status read', async () => {
  const result = await readTencentSingleRecordedResourceStatus(instance as never, account as never, fixture([ledger('snapshot','snap-retained')]).repository as never);
  expect(result.allKnownAbsent).toBeNull(); expect(result.unsupportedLedgerResourceTypes).toEqual(['snapshot']);
  expect(request.mock.calls.some(([input]) => input.action === 'DescribeSnapshots')).toBe(false);
});
it.each([
  response('DiskSet', [], 1), { RequestId: 'request', TotalCount: 0 }, response('DiskSet', [{ DiskId: 'disk-foreign' }]),
  response('DiskSet', [{ DiskId: 'disk-owned' },{ DiskId: 'disk-owned' }]),
])('never interprets malformed or incomplete CBS responses as absence %#', async value => {
  const s = fixture(); request.mockImplementation(async input => input.action === 'DescribeDisks' ? value : response('InstanceSet'));
  await expect(readTencentSingleRecordedResourceStatus(instance as never, account as never, s.repository as never)).rejects.toThrow('absence is unverified');
});
it('preserves successful empty-result evidence for every documented known-ID batch', async () => {
  const ids = Array.from({ length: 101 }, (_, i) => `disk-${i}`);
  const result = await describeTencentKnownResourcesWithEvidence(account as never, 'disk', ids);
  expect(result.resources).toEqual([]); expect(result.evidence).toHaveLength(2);
  expect(request.mock.calls.map(([input]) => input.parameters.DiskIds.length)).toEqual([100,1]);
});
it('preserves the Alpha response and rejects a foreign user before any credential or cloud query', async () => {
  const s = fixture(); s.repository.getRangeInstanceById.mockResolvedValue({ ...instance, cloudProvider: 'alibaba_cloud' } as never);
  const result = await s.service.getCloudResourceStatus(instance.id, { id: 'owner-a', role: 'user' } as never);
  expect(result).not.toHaveProperty('recordedResourceStatus'); expect(s.execution.resolveInstanceAccount).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
  s.execution.findCloudInstanceIdsByRangeInstanceId.mockClear();
  await expect(s.service.getCloudResourceStatus(instance.id, { id: 'foreign-user', role: 'user' } as never)).rejects.toThrow('access denied');
  expect(s.execution.findCloudInstanceIdsByRangeInstanceId).not.toHaveBeenCalled();
});
