import { ProvisioningWorkerService } from '../src/provisioning/provisioning-worker.service';

function fixture() {
  const startedAt = new Date(Date.now() - 60_000);
  const account: any = { provider: 'alibaba_cloud', accountUid: 'uid-a', accountUidResolved: true, cloudAccountContextId: 'ctx-a', defaultRegion: 'cn-beijing', defaultZoneId: 'cn-beijing-h', accessKeyId: 'fixture-key', accessKeySecret: 'fixture-secret' };
  const source: any = { id: 'create-a', rangeInstanceId: 'range-a', cloudWorkspaceId: 'workspace-a', jobType: 'create', status: 'failed', retryCount: 0, startedAt,
    topologySnapshot: { compiledProvisionSpec: { hosts: [{ key: 'dc01', imageId: 'm-dc01', dns: { servers: ['192.168.56.10'], nicIds: ['nic-a'] } }] } } };
  const instance: any = { id: 'range-a', cloudWorkspaceId: 'workspace-a', ownerUserId: 'owner-a', resourceSummary: { mode: 'opentofu', vpcId: 'vpc-a',
    executionContext: { provider: account.provider, cloudAccountUid: account.accountUid, cloudAccountContextId: account.cloudAccountContextId, regionId: account.defaultRegion, zoneId: account.defaultZoneId },
    hostIds: {}, systemDiskIds: {}, diskInventoryHostIds: {}, diskOwnershipProofs: {} } };
  const log: any = { jobId: source.id, cloudWorkspaceId: source.cloudWorkspaceId, stepName: 'tofu_apply', status: 'failed', stdoutExcerpt: 'SDKError: Code: ImageNotSupportCloudInit\n' };
  const repository: any = { getProvisionJobById: jest.fn(async () => source), listProvisionJobStepLogs: jest.fn(async () => [log]), listBillingLedgerResources: jest.fn(async () => []) };
  const worker: any = new ProvisioningWorkerService(repository, {} as any, {} as any);
  jest.spyOn(worker, 'ownsProvisionJobClaim').mockResolvedValue(true);
  const residual = jest.spyOn(worker, 'findResidualCloudResources').mockResolvedValue([]);
  const image: any = { ImageId: 'm-dc01', Status: 'Available', IsSupportCloudinit: false };
  const query = jest.spyOn(worker, 'performAliyunRpcRequest').mockImplementation(async (request: any) => request.action === 'DescribeImages'
    ? { RequestId: 'image-request', TotalCount: 1, PageNumber: 1, PageSize: 100, Images: { Image: [image] } }
    : { RequestId: 'eip-request', TotalCount: 0, PageNumber: 1, PageSize: 50, EipAddresses: { EipAddress: [] } });
  const run = () => worker.verifyAlibabaUnknownApplyAbsent(instance, { id: 'destroy-a' }, account,
    { sourceProvisionJobId: source.id, submittedAt: new Date(startedAt.getTime() + 1000).toISOString(), hostKeys: ['dc01'], eipNames: [] });
  return { run, source, instance, log, image, query, residual };
}
afterEach(() => jest.restoreAllMocks());

it('closes a rejected DNS userdata creation only after immutable image checks and repeated cloud absence checks', async () => {
  const f = fixture(); await expect(f.run()).resolves.toBeUndefined();
  expect(f.query).toHaveBeenCalledWith(expect.objectContaining({ action: 'DescribeImages', parameters: expect.objectContaining({ ImageId: 'm-dc01' }) }));
  expect(f.residual).toHaveBeenCalledTimes(2);
});
it.each(['supported', 'unknown', 'wrong-image', 'no-dns', 'foreign-log', 'unknown-error', 'partial-disk', 'update', 'running-source'])
('preserves uncertainty without source-bound rejection proof: %s', async mode => {
  const f = fixture();
  if (mode === 'supported') f.image.IsSupportCloudinit = true;
  if (mode === 'unknown') delete f.image.IsSupportCloudinit;
  if (mode === 'wrong-image') f.image.ImageId = 'm-other';
  if (mode === 'no-dns') delete f.source.topologySnapshot.compiledProvisionSpec.hosts[0].dns;
  if (mode === 'foreign-log') f.log.cloudWorkspaceId = 'foreign';
  if (mode === 'unknown-error') f.log.stdoutExcerpt = 'accepted response lost';
  if (mode === 'partial-disk') f.instance.resourceSummary.hostIds.dc01 = 'i-a';
  if (mode === 'update') f.source.jobType = 'update';
  if (mode === 'running-source') f.source.status = 'running';
  await expect(f.run()).rejects.toThrow(); expect(f.residual).not.toHaveBeenCalled();
});
