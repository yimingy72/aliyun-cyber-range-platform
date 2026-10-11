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
  const repository = { getProvisionJobById: jest.fn().mockResolvedValue(source), listBillingLedgerResources: jest.fn().mockResolvedValue(ledger),
    getRangeInstanceById: jest.fn().mockResolvedValue(null) };
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

function concurrentRangesFixture() {
  const f = fixture();
  const other: any = { ...structuredClone(instance), id: 'range-b', ownerUserId: 'owner-b', status: 'running', resourceSummary: {
    mode: 'opentofu', executionContext: { ...instance.resourceSummary.executionContext, zoneId: 'cn-hangzhou-k' },
    vpcId: 'vpc-other', eipAllocationIds: { shared: 'eip-other' }, hostIds: { 'host-b': 'i-other' },
  } };
  const birth: any = { ...source, id: 'birth-b', rangeInstanceId: other.id };
  const update: any = { ...birth, id: 'update-b', jobType: 'update', topologySnapshot: { operation: 'update' } };
  const ownedLedger: any = { ...ledger[0], id: 'other-ledger', cloudWorkspaceId: instance.cloudWorkspaceId,
    rangeInstanceId: other.id, cloudResourceType: 'eip', cloudResourceId: 'eip-other', ownerUserId: other.ownerUserId,
    billingScope: 'user', sourceProvisionJobId: birth.id };
  const values: Record<string, string> = { CreatedBy: 'cyber-range-platform', PlatformManaged: 'true', CloudProvider: account.provider,
    CloudAccountUid: account.accountUid, CloudAccountContextId: account.cloudAccountContextId, PlatformResourceType: 'eip',
    PlatformScope: 'user', PlatformUserId: other.ownerUserId, RangeInstanceId: other.id, range_instance_id: other.id,
    PlatformCreateJobId: update.id };
  const row = { AllocationId: 'eip-other', Name: '共享-SNAT-EIP', RegionId: account.defaultRegion,
    Tags: { Tag: Object.entries(values).map(([Key, Value]) => ({ Key, Value })) } };
  f.repository.getRangeInstanceById.mockImplementation(async id => id === other.id ? other : null);
  f.repository.listBillingLedgerResources.mockImplementation(async filter => filter.rangeInstanceId === other.id ? [ownedLedger] : ledger);
  f.repository.getProvisionJobById.mockImplementation(async id => id === birth.id ? birth : id === update.id ? update : source);
  f.rpc.mockResolvedValue({ RequestId: 'receipt-other', TotalCount: 1, PageNumber: 1, PageSize: 50, EipAddresses: { EipAddress: [row] } });
  return { ...f, other, birth, update, ownedLedger, row, submitted: { ...intent, eipNames: [row.Name] } };
}

it('excludes an independently recorded namesake in another user range, including a different zone and later update tags', async () => {
  const f = concurrentRangesFixture();
  const unchanged = structuredClone({ other: f.other, ledger: f.ownedLedger, birth: f.birth, update: f.update });
  await f.worker.verifyAlibabaUnknownApplyAbsent(instance, { id: 'destroy-job' }, account, f.submitted);
  expect(f.rpc).toHaveBeenCalledTimes(2);
  f.rpc.mock.calls.forEach(([request]) => expect(request).toMatchObject({ action: 'DescribeEipAddresses' }));
  expect({ other: f.other, ledger: f.ownedLedger, birth: f.birth, update: f.update }).toEqual(unchanged);
});

it.each(['tracked-id', 'ledger-only-id', 'current-range-tag', 'conflicting-alias', 'missing-range', 'foreign-workspace', 'foreign-account', 'foreign-region',
  'wrong-context-tag', 'wrong-owner-tag', 'wrong-type-tag', 'missing-ledger', 'released-ledger', 'wrong-ledger-owner', 'foreign-ledger-workspace',
  'wrong-birth-range', 'destroy-birth', 'wrong-tag-job', 'duplicate-range-tag'])('does not accept an unproven namesake: %s', async scenario => {
  const f = concurrentRangesFixture(); const value = structuredClone(instance);
  const tag = (key: string) => f.row.Tags.Tag.find(item => item.Key === key)!;
  if (scenario === 'tracked-id') value.resourceSummary.eipAllocationIds = { owned: f.row.AllocationId };
  if (scenario === 'tracked-id' || scenario === 'ledger-only-id') f.repository.listBillingLedgerResources.mockImplementation(async filter => filter.rangeInstanceId === instance.id
    ? [...ledger, { ...ledger[0], cloudResourceType: 'eip', cloudResourceId: f.row.AllocationId }] : [f.ownedLedger]);
  if (scenario === 'current-range-tag') tag('RangeInstanceId').Value = instance.id;
  if (scenario === 'conflicting-alias') tag('range_instance_id').Value = instance.id;
  if (scenario === 'missing-range') f.repository.getRangeInstanceById.mockResolvedValue(null);
  if (scenario === 'foreign-workspace') f.other.cloudWorkspaceId = 'workspace-foreign';
  if (scenario === 'foreign-account') f.other.resourceSummary.executionContext.cloudAccountUid = 'foreign';
  if (scenario === 'foreign-region') f.other.resourceSummary.executionContext.regionId = 'cn-beijing';
  if (scenario === 'wrong-context-tag') tag('CloudAccountContextId').Value = 'foreign';
  if (scenario === 'wrong-owner-tag') tag('PlatformUserId').Value = 'foreign';
  if (scenario === 'wrong-type-tag') tag('PlatformResourceType').Value = 'disk';
  if (scenario === 'missing-ledger') f.repository.listBillingLedgerResources.mockImplementation(async filter => filter.rangeInstanceId === instance.id ? ledger : []);
  if (scenario === 'released-ledger') f.ownedLedger.releasedAt = new Date();
  if (scenario === 'wrong-ledger-owner') f.ownedLedger.ownerUserId = 'foreign';
  if (scenario === 'foreign-ledger-workspace') f.ownedLedger.cloudWorkspaceId = 'workspace-foreign';
  if (scenario === 'wrong-birth-range') f.birth.rangeInstanceId = 'foreign';
  if (scenario === 'destroy-birth') f.birth.jobType = 'destroy';
  if (scenario === 'wrong-tag-job') f.update.cloudWorkspaceId = 'workspace-foreign';
  if (scenario === 'duplicate-range-tag') f.row.Tags.Tag.push({ Key: 'RangeInstanceId', Value: instance.id });
  await expect(f.worker.verifyAlibabaUnknownApplyAbsent(value, { id: 'destroy-job' }, account, f.submitted)).rejects.toThrow();
  expect(f.rpc).toHaveBeenCalledTimes(1);
  f.rpc.mock.calls.forEach(([request]) => expect(request).toMatchObject({ action: 'DescribeEipAddresses' }));
});

it('rechecks ownership on the second cloud receipt instead of trusting the first namesake proof', async () => {
  const f = concurrentRangesFixture();
  f.repository.getRangeInstanceById.mockResolvedValueOnce(f.other).mockResolvedValueOnce(null);
  await expect(f.worker.verifyAlibabaUnknownApplyAbsent(instance, { id: 'destroy-job' }, account, f.submitted)).rejects.toThrow('EIP candidate remains');
  expect(f.rpc).toHaveBeenCalledTimes(2);
});

describe('unresolved Alibaba apply marker lifecycle', () => {
  async function setup(target = instance, sourceJob = source) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(),'alibaba-absence-'));
    const pending = { version: 1, addresses: ['module.range.alicloud_forward_entry.entries["missing"]'], createAddresses: ['module.range.alicloud_forward_entry.entries["missing"]'],
      priorLineage: 'original-lineage', priorIds: {}, submittedAt: intent.submittedAt, sourceProvisionJobId: sourceJob.id };
    await fs.writeFile(path.join(dir,APPLY_PENDING_FILE),JSON.stringify(pending));
    await fs.writeFile(path.join(dir,'terraform.tfstate'),JSON.stringify({ version: 4, lineage: 'original-lineage', serial: 7, resources: [] }));
    const vars = path.join(dir,'range.auto.tfvars.json');
    await fs.writeFile(vars,JSON.stringify({ resource_name_prefix: `range-${target.id.slice(0, 9)}`, zone_id: account.defaultZoneId, hosts: Object.keys(target.resourceSummary.hostIds).map(key => ({ key })), eips: [{ name: 'Range EIP' }],
      tags: { CloudProvider: account.provider, CreatedBy: 'cyber-range-platform', PlatformManaged: 'true', RangeInstanceId: target.id, range_instance_id: target.id,
        CloudAccountUid: account.accountUid, CloudAccountContextId: account.cloudAccountContextId, PlatformCreateJobId: sourceJob.id, PlatformScope: 'user', PlatformUserId: target.ownerUserId } }));
    const runner = { init: jest.fn().mockResolvedValue({ stdout: '', stderr: '' }), destroy: jest.fn().mockResolvedValue({ stdout: '', stderr: '' }),
      validate: jest.fn(), plan: jest.fn(), apply: jest.fn(), output: jest.fn(), showPlan: jest.fn() };
    const provisioner = new OpenTofuRangeProvisioner({ runner, env: {} }) as any;
    jest.spyOn(provisioner,'prepareDestroyWorkspace').mockResolvedValue({ workspaceDir: dir, varsFilePath: vars, runnerEnv: {} });
    const input = { rangeInstanceId: target.id, templateModulePath: 'infra/opentofu/modules/alicloud-enterprise-range', allocatedCidr: null,
      runtimeConfig: account, billingTags: { PlatformScope: 'user', PlatformUserId: target.ownerUserId } };
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
  it('finishes two concurrent cleanup attempts without modifying a third running range with the same EIP name', async () => {
    const otherCleanup = { ...structuredClone(instance), id: 'range-c', ownerUserId: 'owner-c' };
    otherCleanup.resourceSummary.hostIds = { 'host-c': 'i-cleanup-c' };
    otherCleanup.resourceSummary.systemDiskIds = { 'host-c': 'd-cleanup-c' };
    otherCleanup.resourceSummary.diskInventoryHostIds = { 'host-c': 'i-cleanup-c' };
    otherCleanup.resourceSummary.diskOwnershipProofs = { 'd-cleanup-c': { instanceId: 'i-cleanup-c', method: 'persisted' } };
    const sourceC = { ...source, id: 'source-c', rangeInstanceId: otherCleanup.id };
    const first = await setup(); const second = await setup(otherCleanup, sourceC);
    const f = concurrentRangesFixture();
    const ledgerC = ledger.map((entry, index) => ({ ...entry, id: `ledger-c-${index}`, rangeInstanceId: otherCleanup.id,
      ownerUserId: otherCleanup.ownerUserId, cloudResourceId: index ? 'd-cleanup-c' : 'i-cleanup-c' }));
    f.repository.listBillingLedgerResources.mockImplementation(async filter => filter.rangeInstanceId === f.other.id ? [f.ownedLedger]
      : filter.rangeInstanceId === otherCleanup.id ? ledgerC : ledger);
    f.repository.getProvisionJobById.mockImplementation(async id => id === f.birth.id ? f.birth : id === f.update.id ? f.update
      : id === sourceC.id ? sourceC : source);
    const third = structuredClone({ instance: f.other, ledger: f.ownedLedger, row: f.row });
    try {
      for (const current of [first, second]) {
        const vars = JSON.parse(await fs.readFile(current.vars, 'utf8'));
        vars.eips = [{ name: '共享 SNAT EIP' }];
        await fs.writeFile(current.vars, JSON.stringify(vars));
      }
      await Promise.all([first, second].map(current => current.provisioner.destroy({ ...current.input,
        verifyUnresolvedApplyAbsence: (submitted: typeof intent) => f.worker.verifyAlibabaUnknownApplyAbsent(current === first ? instance : otherCleanup,
          { id: current.dir }, account, submitted) })));
      for (const current of [first, second]) {
        await expect(fs.stat(path.join(current.dir, APPLY_PENDING_FILE))).rejects.toMatchObject({ code: 'ENOENT' });
        expect(current.runner.destroy).toHaveBeenCalledWith(expect.objectContaining({ workspaceDir: current.dir, varsFilePath: current.vars }));
      }
      expect(f.rpc).toHaveBeenCalledTimes(4);
      f.rpc.mock.calls.forEach(([request]) => expect(request).toMatchObject({ action: 'DescribeEipAddresses' }));
      expect({ instance: f.other, ledger: f.ownedLedger, row: f.row }).toEqual(third);
    } finally {
      await Promise.all([first, second].map(current => fs.rm(current.dir, { recursive: true, force: true })));
    }
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
  it.each(['foreign-lineage','rewound-serial'])('blocks %s before cloud destruction or clearing the pending marker',async scenario=>{
    const f=await setup();
    try {
      const pending={...f.pending,priorLineage:scenario==='foreign-lineage'?'foreign-ancestor':f.pending.priorLineage,priorSerial:scenario==='rewound-serial'?8:7};
      await fs.writeFile(path.join(f.dir,APPLY_PENDING_FILE),JSON.stringify(pending));
      const proof=jest.fn().mockResolvedValue(undefined);
      await expect(f.provisioner.destroy({...f.input,verifyUnresolvedApplyAbsence:proof})).rejects.toThrow('ancestor state');
      expect(f.runner.destroy).not.toHaveBeenCalled();expect(proof).not.toHaveBeenCalled();
      expect(JSON.parse(await fs.readFile(path.join(f.dir,APPLY_PENDING_FILE),'utf8'))).toEqual(pending);
    } finally {await fs.rm(f.dir,{recursive:true,force:true});}
  });
});
