import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProvisioningWorkerService } from '../src/provisioning/provisioning-worker.service';
import { OpenTofuRangeProvisioner } from '../src/provisioning/open-tofu-range-provisioner';
import { APPLY_PENDING_FILE } from '../src/provisioning/opentofu-state-evidence';

const account = { provider: 'alibaba_cloud', accountUid: '100000000001', accountUidResolved: true,
  cloudAccountContextId: 'context-a', defaultRegion: 'cn-hangzhou', defaultZoneId: 'cn-hangzhou-i', accessKeyId: 'fixture', accessKeySecret: 'fixture' };
const intent = { sourceProvisionJobId: 'source-job', submittedAt: '2026-10-10T12:00:01Z', hostKeys: ['host-a'], eipNames: ['Range-EIP'] };
const source = { id: 'source-job', rangeInstanceId: 'range-a', cloudWorkspaceId: 'workspace-a', jobType: 'create', startedAt: new Date('2026-10-10T12:00:00Z') };
const instance: any = { id: 'range-a', cloudWorkspaceId: 'workspace-a', cloudProvider: 'alibaba_cloud', ownerUserId: 'owner-a', resourceSummary: {
  mode: 'opentofu', vpcId: 'vpc-owned', executionContext: { provider: account.provider, cloudAccountContextId: account.cloudAccountContextId,
    cloudAccountUid: account.accountUid, regionId: account.defaultRegion, zoneId: account.defaultZoneId },
  hostIds: { 'host-a': 'i-owned' }, systemDiskIds: { 'host-a': 'd-owned' }, diskInventoryHostIds: { 'host-a': 'i-owned' },
  diskOwnershipProofs: { 'd-owned': { instanceId: 'i-owned', method: 'persisted' } }, unverifiedDiskIds: {},
} };
const ledger = ['ecs','disk'].map((type,index) => ({ id: 'ledger-' + index, rangeInstanceId: instance.id, cloudProvider: account.provider,
  cloudAccountUid: account.accountUid, regionId: account.defaultRegion, ownerUserId: instance.ownerUserId,
  cloudResourceType: type, cloudResourceId: index ? 'd-owned' : 'i-owned', releasedAt: null }));
function fixture() {
  const repository = { getProvisionJobById: jest.fn().mockResolvedValue(source), listBillingLedgerResources: jest.fn().mockResolvedValue(ledger) };
  const worker = new ProvisioningWorkerService(repository as any, {} as any, {} as any, {} as any, {} as any, {} as any) as any;
  const claim = jest.spyOn(worker,'ownsProvisionJobClaim').mockResolvedValue(true);
  const known = jest.spyOn(worker,'findResidualCloudResources').mockResolvedValue([]);
  const rpc = jest.spyOn(worker,'performAliyunRpcRequest').mockResolvedValue({ RequestId: 'receipt-1', TotalCount: 0, PageNumber: 1, PageSize: 50, EipAddresses: { EipAddress: [] } });
  return { worker, repository, claim, known, rpc };
}
afterEach(() => jest.restoreAllMocks());
it('uses two independent tracked-resource and complete regional EIP reads before accepting absence', async () => {
  const { worker, rpc, known } = fixture();
  await worker.verifyAlibabaUnknownApplyAbsent(instance, { id: 'destroy-job' }, account, intent);
  expect(known).toHaveBeenCalledTimes(2);
  expect(known).toHaveBeenCalledWith(instance.resourceSummary,account);
  expect(rpc).toHaveBeenCalledTimes(2);
  expect(rpc.mock.calls[0][0]).toMatchObject({ action: 'DescribeEipAddresses', parameters: { RegionId: 'cn-hangzhou', PageSize: '50', PageNumber: '1' } });
});
it.each(['foreign-account','foreign-source','missing-disk','invalid-time','missing-ledger'])('fails closed before cloud queries for %s', async scenario => {
  const f = fixture(); const value = structuredClone(instance); const submitted = { ...intent };
  if (scenario === 'foreign-account') value.resourceSummary.executionContext.cloudAccountUid = 'other';
  if (scenario === 'foreign-source') f.repository.getProvisionJobById.mockResolvedValue({ ...source, cloudWorkspaceId: 'other' });
  if (scenario === 'missing-disk') delete value.resourceSummary.diskInventoryHostIds['host-a'];
  if (scenario === 'invalid-time') submitted.submittedAt = 'invalid';
  if (scenario === 'missing-ledger') f.repository.listBillingLedgerResources.mockResolvedValue([]);
  await expect(f.worker.verifyAlibabaUnknownApplyAbsent(value, {}, account, submitted)).rejects.toThrow('Alibaba unknown apply');
  expect(f.known).not.toHaveBeenCalled(); expect(f.rpc).not.toHaveBeenCalled();
});
it.each(['named-untagged-eip','tagged-eip','incomplete-page','missing-receipt','remaining-disk','lost-claim'])('preserves recovery for %s', async scenario => {
  const f = fixture();
  if (scenario === 'named-untagged-eip' || scenario === 'tagged-eip') f.rpc.mockResolvedValue({ RequestId: 'receipt-1', TotalCount: 1, PageNumber: 1, PageSize: 50,
    EipAddresses: { EipAddress: [{ AllocationId: 'eip-hidden', Name: scenario === 'named-untagged-eip' ? 'Range-EIP' : 'Other',
      Tags: { Tag: scenario === 'tagged-eip' ? [{ Key: 'RangeInstanceId', Value: instance.id }] : [] } }] } });
  if (scenario === 'incomplete-page') f.rpc.mockResolvedValue({ RequestId: 'receipt-1', TotalCount: 1, PageNumber: 1, PageSize: 50, EipAddresses: { EipAddress: [] } });
  if (scenario === 'missing-receipt') f.rpc.mockResolvedValue({ TotalCount: 0, PageNumber: 1, PageSize: 50, EipAddresses: { EipAddress: [] } });
  if (scenario === 'remaining-disk') f.known.mockResolvedValue(['disk:d-owned']);
  if (scenario === 'lost-claim') f.claim.mockResolvedValue(false);
  await expect(f.worker.verifyAlibabaUnknownApplyAbsent(instance, {}, account, intent)).rejects.toThrow();
});

describe('unresolved Alibaba apply marker lifecycle', () => {
  async function setup() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(),'alibaba-absence-'));
    const pending = { version: 1, addresses: ['module.range.alicloud_forward_entry.entries["missing"]'], createAddresses: ['module.range.alicloud_forward_entry.entries["missing"]'],
      priorLineage: 'original-lineage', priorIds: {}, submittedAt: intent.submittedAt, sourceProvisionJobId: intent.sourceProvisionJobId };
    await fs.writeFile(path.join(dir,APPLY_PENDING_FILE),JSON.stringify(pending));
    await fs.writeFile(path.join(dir,'terraform.tfstate'),JSON.stringify({ version: 4, lineage: 'original-lineage', serial: 7, resources: [] }));
    const vars = path.join(dir,'range.auto.tfvars.json');
    await fs.writeFile(vars,JSON.stringify({ resource_name_prefix: 'range-range-a', zone_id: account.defaultZoneId, hosts: [{ key: 'host-a' }], eips: [{ name: 'Range EIP' }],
      tags: { CloudProvider: account.provider, CreatedBy: 'cyber-range-platform', PlatformManaged: 'true', RangeInstanceId: instance.id, range_instance_id: instance.id,
        CloudAccountUid: account.accountUid, CloudAccountContextId: account.cloudAccountContextId, PlatformCreateJobId: intent.sourceProvisionJobId, PlatformScope: 'user', PlatformUserId: instance.ownerUserId } }));
    const runner = { init: jest.fn().mockResolvedValue({ stdout: '', stderr: '' }), destroy: jest.fn().mockResolvedValue({ stdout: '', stderr: '' }),
      validate: jest.fn(), plan: jest.fn(), apply: jest.fn(), output: jest.fn(), showPlan: jest.fn() };
    const provisioner = new OpenTofuRangeProvisioner({ runner, env: {} }) as any;
    jest.spyOn(provisioner,'prepareDestroyWorkspace').mockResolvedValue({ workspaceDir: dir, varsFilePath: vars, runnerEnv: {} });
    const input = { rangeInstanceId: instance.id, templateModulePath: 'infra/opentofu/modules/alicloud-enterprise-range', allocatedCidr: null,
      runtimeConfig: account, billingTags: { PlatformScope: 'user', PlatformUserId: instance.ownerUserId } };
    return { dir, vars, pending, runner, provisioner, input };
  }
  it('keeps the marker if independent proof is missing or fails; clears only after proof and verified empty state', async () => {
    const f = await setup();
    try {
      await expect(f.provisioner.destroy(f.input)).rejects.toThrow('outcome is unknown');
      expect(JSON.parse(await fs.readFile(path.join(f.dir,APPLY_PENDING_FILE),'utf8'))).toEqual(f.pending);
      const proof = jest.fn().mockRejectedValueOnce(new Error('tracked disk remains')).mockResolvedValueOnce(undefined);
      await expect(f.provisioner.destroy({ ...f.input, verifyUnresolvedApplyAbsence: proof })).rejects.toThrow('tracked disk remains');
      expect(await fs.stat(path.join(f.dir,APPLY_PENDING_FILE))).toBeTruthy();
      await f.provisioner.destroy({ ...f.input, verifyUnresolvedApplyAbsence: proof });
      expect(proof).toHaveBeenLastCalledWith(intent);
      await expect(fs.stat(path.join(f.dir,APPLY_PENDING_FILE))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await fs.rm(f.dir,{ recursive:true,force:true }); }
  });
  it('does not erase a different pending generation created during absence verification', async () => {
    const f = await setup();
    try {
      const proof = async () => fs.writeFile(path.join(f.dir,APPLY_PENDING_FILE),JSON.stringify({ ...f.pending, sourceProvisionJobId: 'later-job' }));
      await expect(f.provisioner.destroy({ ...f.input, verifyUnresolvedApplyAbsence: proof })).rejects.toThrow('generation changed');
      expect(JSON.parse(await fs.readFile(path.join(f.dir,APPLY_PENDING_FILE),'utf8')).sourceProvisionJobId).toBe('later-job');
    } finally { await fs.rm(f.dir,{ recursive:true,force:true }); }
  });
  it('accepts the actual Alibaba shortened prefix while still binding the full range ID tags', async () => {
    const f = await setup();
    try {
      const rangeId = 'cmv2hfnqo002hog2uwyo4kn8f';
      const variables = JSON.parse(await fs.readFile(f.vars,'utf8'));
      variables.resource_name_prefix = 'range-cmv2hfnqo';
      variables.tags.RangeInstanceId = rangeId;
      variables.tags.range_instance_id = rangeId;
      await fs.writeFile(f.vars,JSON.stringify(variables));
      const proof = jest.fn().mockResolvedValue(undefined);
      await f.provisioner.destroy({ ...f.input, rangeInstanceId: rangeId, verifyUnresolvedApplyAbsence: proof });
      expect(proof).toHaveBeenCalledWith(intent);
      await expect(fs.stat(path.join(f.dir,APPLY_PENDING_FILE))).rejects.toMatchObject({ code:'ENOENT' });
    } finally { await fs.rm(f.dir,{recursive:true,force:true}); }
  });
  it.each(['range-a','range-other','wrong-full-id-tag'])('rejects foreign or non-rendered Alibaba identity %s before independent proof', async mismatch => {
    const f = await setup();
    try {
      const variables = JSON.parse(await fs.readFile(f.vars,'utf8'));
      if (mismatch === 'wrong-full-id-tag') variables.tags.range_instance_id = 'range-other';
      else variables.resource_name_prefix = mismatch;
      await fs.writeFile(f.vars,JSON.stringify(variables));
      const proof = jest.fn().mockResolvedValue(undefined);
      await expect(f.provisioner.destroy({ ...f.input, verifyUnresolvedApplyAbsence: proof })).rejects.toThrow('intent differs');
      expect(proof).not.toHaveBeenCalled();
      expect(await fs.stat(path.join(f.dir,APPLY_PENDING_FILE))).toBeTruthy();
    } finally { await fs.rm(f.dir,{recursive:true,force:true}); }
  });
});
