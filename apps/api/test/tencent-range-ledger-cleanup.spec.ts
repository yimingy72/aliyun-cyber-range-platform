import { ProvisioningWorkerService } from '../src/provisioning/provisioning-worker.service';
import * as resources from '../src/admin/tencent-cloud-resources';

const account = { provider: 'tencent_cloud', accountUid: '100000000001', accountUidResolved: true, cloudAccountContextId: 'context-a', defaultRegion: 'ap-shanghai', defaultZoneId: 'ap-shanghai-2', accessKeyId: 'fake', accessKeySecret: 'fake' };
const instance = { id: 'range-a', cloudProvider: 'tencent_cloud', ownerUserId: 'owner-a', resourceSummary: { mode: 'opentofu', executionContext: { provider: 'tencent_cloud', cloudAccountContextId: account.cloudAccountContextId, cloudAccountUid: account.accountUid, regionId: account.defaultRegion, zoneId: account.defaultZoneId } } };
function fixture(rows: any[]) {
  const repository = { listBillingLedgerResources: jest.fn().mockResolvedValue(rows), updateBillingLedgerResource: jest.fn() };
  const worker = new ProvisioningWorkerService(repository as any, {} as any, {} as any, {} as any, {} as any, {} as any) as any;
  return { repository, worker };
}
function row(type = 'eip', id = 'eip-retained') {
  return { id: 'ledger-a', rangeInstanceId: instance.id, cloudProvider: 'tencent_cloud', cloudAccountUid: account.accountUid, regionId: account.defaultRegion, ownerUserId: instance.ownerUserId, cloudResourceType: type, cloudResourceId: id, releasedAt: null };
}
afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });
it.each([['ecs','ins-retained'],['disk','disk-retained'],['eip','eip-retained'],['nat_gateway','nat-retained']])('verifies a retained %s charge even when its ID is missing from the range summary', async (type,id) => {
  jest.useFakeTimers();
  const { worker, repository } = fixture([row(type,id)]);
  const query = jest.spyOn(resources,'describeTencentResourceInventory').mockResolvedValue([{ id } as any]);
  const checking = worker.verifyDestroyCompletion(instance,account);
  const rejected = expect(checking).rejects.toThrow('Residual cloud resources');
  await jest.runAllTimersAsync(); await rejected;
  expect(query.mock.calls[0][2]).toEqual({ ids: [id] });
  expect(repository.updateBillingLedgerResource).not.toHaveBeenCalled();
});
it('permits completion only after all retained fee IDs are independently absent', async () => {
  const { worker } = fixture([row('ecs','ins-retained'),row('disk','disk-retained'),row('eip','eip-retained'),row('nat_gateway','nat-retained')]);
  const query = jest.spyOn(resources,'describeTencentResourceInventory').mockResolvedValue([]);
  await worker.verifyDestroyCompletion(instance,account);
  expect(query.mock.calls.map(call => call[1]).sort()).toEqual(['disk','ecs','eip','nat']);
});
it.each(['account','owner','provider','region','unsupported'])('fails closed for %s ledger evidence before any cloud query', async mismatch => {
  const retained = row();
  if (mismatch === 'account') retained.cloudAccountUid = 'other';
  if (mismatch === 'owner') retained.ownerUserId = 'other';
  if (mismatch === 'provider') retained.cloudProvider = 'alibaba_cloud';
  if (mismatch === 'region') retained.regionId = 'ap-guangzhou';
  if (mismatch === 'unsupported') retained.cloudResourceType = 'oss_bucket';
  const { worker } = fixture([retained]);
  const query = jest.spyOn(resources,'describeTencentResourceInventory');
  await expect(worker.verifyDestroyCompletion(instance,account)).rejects.toThrow('Tencent cleanup');
  expect(query).not.toHaveBeenCalled();
});
