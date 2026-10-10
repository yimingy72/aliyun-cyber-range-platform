import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OpenTofuRangeProvisioner } from '../src/provisioning/open-tofu-range-provisioner';
import * as cloud from '../src/admin/tencent-cloud-resources';
import * as rpc from '../src/admin/tencent-cloud-client';
import { retiredResourceInventory } from '../src/provisioning/retired-resource-inventory';
import { ProvisioningWorkerService } from '../src/provisioning/provisioning-worker.service';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';
import { runInCloudWorkspace } from '../src/auth/cloud-workspace-scope';
import { FAILED_CREATE_CLEANUP_PROOF_STEP } from '../src/admin/failed-create-cleanup-evidence';
import { syncRangeInstanceBillingLedger } from '../src/admin/billing-ledger-sync';

const account = { provider: 'tencent_cloud' as const, accountUid: '100000000001', accountUidResolved: true, cloudAccountContextId: 'context-a', defaultRegion: 'ap-shanghai', defaultZoneId: 'ap-shanghai-2', accessKeyId: 'fake', accessKeySecret: 'fake', imageImportBucket: '' };
const tags = { CloudProvider: 'tencent_cloud', PlatformManaged: 'true', CreatedBy: 'cyber-range-platform', PlatformScope: 'user', PlatformUserId: 'owner-a', CloudAccountUid: account.accountUid, CloudAccountContextId: account.cloudAccountContextId, RangeInstanceId: 'range-a', PlatformCreateJobId: 'source-job' };
const intent = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(),'tencent-nat-recover-')); });
afterEach(async () => { jest.restoreAllMocks(); await fs.rm(root,{recursive:true,force:true}); });
async function fixture() {
  const dir = path.join(root,'range-a'); await fs.mkdir(dir);
  const natAddress = 'module.range.tencentcloud_nat_gateway.shared["shared"]';
  const state: any = { version: 4, lineage: 'source-lineage', serial: 1, resources: [
    { mode: 'managed', module: 'module.range', type: 'tencentcloud_vpc', name: 'range', instances: [{ attributes: { id: 'vpc-fixture', tags } }] },
    { mode: 'managed', module: 'module.range', type: 'tencentcloud_eip', name: 'range', instances: [{ index_key: 'snat', attributes: { id: 'eip-fixture', client_token: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', name: 'range-fixture-bbbbbbbbbbbbbbbb', tags: { ...tags, CreationIntentId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' } } }] },
  ] };
  await fs.writeFile(path.join(dir,'terraform.tfstate'),JSON.stringify(state));
  await fs.writeFile(path.join(dir,'tencent-range-identity.json'),JSON.stringify({ provider: account.provider, cloudAccountContextId: account.cloudAccountContextId, cloudAccountUid: account.accountUid, regionId: account.defaultRegion, zoneId: account.defaultZoneId, rangeInstanceId: 'range-a' }));
  await fs.writeFile(path.join(dir,'.range-apply-started'),JSON.stringify({ version: 1, addresses: [natAddress], createAddresses: [natAddress], priorIds: {}, priorLineage: null, submittedAt: new Date().toISOString(), sourceProvisionJobId: 'source-job' }));
  await fs.writeFile(path.join(dir,'range.auto.tfvars.json'),JSON.stringify({ resource_name_prefix: 'range-fixture', range_instance_id: 'range-a', region: account.defaultRegion, zone_id: account.defaultZoneId,
    tags, eips: [{ key: 'snat', creation_intent_id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', bandwidth: 10 }], nat_gateways: [{ key: 'shared', creation_intent_id: intent }] }));
  const order: string[] = [];
  const runner = { init: jest.fn(async () => { order.push('init'); return {}; }), importResource: jest.fn(async (input: any) => {
    order.push('import'); state.serial++;
    state.resources.push({ mode: 'managed', module: 'module.range', type: 'tencentcloud_nat_gateway', name: 'shared', instances: [{ index_key: 'shared', attributes: { id: input.resourceId, tags: { ...tags, CreationIntentId: intent } } }] });
    await fs.writeFile(path.join(dir,'terraform.tfstate'),JSON.stringify(state)); return {};
  }), apply: jest.fn() };
  const provisioner = new OpenTofuRangeProvisioner({ projectRootDir:'/app', workspacesRootDir: root, runner: runner as any, env: { TENCENTCLOUD_PROVIDER_ZIP_PATH:'', TENCENTCLOUD_PROVIDER_UNPACKED_MIRROR_ROOT:'' } });
  const candidate: any = { id: 'nat-fixture', kind: 'nat', tags: { ...tags, CreationIntentId: intent }, name: `range-fixture-${intent.slice(0,16)}`, vpcId:'vpc-fixture', natProductVersion: 2, bandwidth: 5000, maxConcurrent: 2000000, publicIpAddresses:['203.0.113.1'] };
  const originalEip = {id:'eip-fixture',tags:{...tags,CreationIntentId:'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'},name:'range-fixture-bbbbbbbbbbbbbbbb',bandwidth:10,publicIp:'203.0.113.1'};
  const query = jest.spyOn(cloud,'describeTencentResourceInventory').mockImplementation(async (_account,kind) => kind === 'vpc' ? [{ id:'vpc-fixture',tags }] as any : kind === 'eip' ? [originalEip] as any : [candidate]);
  const persist = jest.fn(async () => { order.push('persist'); });
  const assertCurrent = jest.fn(async () => {});
  const assertRecoverySourceJob = jest.fn(async (id: string) => { if (!['source-job','update-job'].includes(id)) throw new Error('unproven source job'); });
  const input = { rangeInstanceId:'range-a', templateModulePath:'infra/opentofu/modules/tencentcloud-enterprise-range', allocatedCidr:null, runtimeConfig: account, assertRecoverySourceJob, assertRecoveryClaim: assertCurrent,
    knownResourceSummary: { mode:'opentofu' as const,vpcId:'vpc-fixture',eipAllocationIds:{snat:'eip-fixture'},executionContext:{provider:'tencent_cloud' as const,cloudAccountUid:account.accountUid,cloudAccountContextId:account.cloudAccountContextId,regionId:account.defaultRegion,zoneId:account.defaultZoneId} } };
  return { provisioner,runner,candidate,query,persist,assertCurrent,input,dir,order,originalEip };
}
it('discovers the exact atomically tagged submitted NAT and persists fee evidence before original-workspace import', async () => {
  const test = await fixture();
  await test.provisioner.recoverUntrackedResources(test.input,test.assertCurrent,test.persist);
  expect(test.order).toEqual(['persist','init','import']);
  expect(test.persist).toHaveBeenCalledWith(expect.objectContaining({ natGatewayIds: { shared:'nat-fixture' } }),'source-job');
  expect(test.runner.importResource).toHaveBeenCalledWith(expect.objectContaining({ address:'module.range.tencentcloud_nat_gateway.shared["shared"]',resourceId:'nat-fixture' }));
  expect(test.runner.apply).not.toHaveBeenCalled();
  expect(await fs.stat(path.join(test.dir,'.range-apply-started'))).toBeDefined();
});
it.each(['foreign-lineage','rewound-serial'])('blocks %s before any Tencent discovery, persistence or import',async scenario=>{
  const test=await fixture();const file=path.join(test.dir,'.range-apply-started');
  const pending=JSON.parse(await fs.readFile(file,'utf8'));
  Object.assign(pending,{priorLineage:scenario==='foreign-lineage'?'foreign':'source-lineage',priorSerial:scenario==='rewound-serial'?2:1});
  await fs.writeFile(file,JSON.stringify(pending));
  await expect(test.provisioner.recoverUntrackedResources(test.input,test.assertCurrent,test.persist)).rejects.toThrow('ancestor state');
  expect(test.query).not.toHaveBeenCalled();expect(test.persist).not.toHaveBeenCalled();expect(test.runner.importResource).not.toHaveBeenCalled();
  expect(JSON.parse(await fs.readFile(file,'utf8'))).toEqual(pending);
});
it('records the original partial-create billing source even when all submitted NAT and EIP identities already reached state', async () => {
  const test = await fixture();
  const statePath = path.join(test.dir, 'terraform.tfstate');
  const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  state.resources.push({ mode: 'managed', module: 'module.range', type: 'tencentcloud_nat_gateway', name: 'shared',
    instances: [{ index_key: 'shared', attributes: { id: 'nat-fixture', tags: { ...tags, CreationIntentId: intent } } }] });
  await fs.writeFile(statePath, JSON.stringify(state));
  await test.provisioner.recoverUntrackedResources(test.input, test.assertCurrent, test.persist);
  expect(test.persist).toHaveBeenCalledTimes(1);
  expect(test.persist).toHaveBeenCalledWith({ mode: 'opentofu' }, 'source-job');
  expect(test.input.assertRecoverySourceJob).toHaveBeenCalledWith('source-job');
  expect(test.order).toEqual(['persist']);
  expect(test.runner.importResource).not.toHaveBeenCalled();
  expect(test.runner.apply).not.toHaveBeenCalled();
});
async function updateFixture() {
  const test = await fixture();
  const pendingPath = path.join(test.dir,'.range-apply-started');
  const pending = JSON.parse(await fs.readFile(pendingPath,'utf8')); pending.sourceProvisionJobId = 'update-job';
  await fs.writeFile(pendingPath,JSON.stringify(pending));
  const varsPath = path.join(test.dir,'range.auto.tfvars.json');
  const variables = JSON.parse(await fs.readFile(varsPath,'utf8')); variables.tags.PlatformCreateJobId = 'update-job';
  await fs.writeFile(varsPath,JSON.stringify(variables));
  test.candidate.tags.PlatformCreateJobId = 'update-job';
  return test;
}
it.each([false,true])('recovers update NAT with separately proven old VPC and EIP birth jobs: vpcTagsUpdated=%s', async updated => {
  const test = await updateFixture();
  if (updated) test.query.mockImplementation(async (_account,kind) => kind === 'vpc' ? [{id:'vpc-fixture',tags:{...tags,PlatformCreateJobId:'update-job'}}] as any : kind === 'eip' ? [test.originalEip] as any : [test.candidate]);
  await test.provisioner.recoverUntrackedResources(test.input,test.assertCurrent,test.persist);
  expect(test.persist).toHaveBeenCalledWith(expect.objectContaining({natGatewayIds:{shared:'nat-fixture'}}),'update-job');
  expect(test.input.assertRecoverySourceJob).toHaveBeenCalledWith('source-job');
  expect(test.input.assertRecoverySourceJob).toHaveBeenCalledWith('update-job');
  expect(test.runner.importResource).toHaveBeenCalledTimes(1); expect(test.runner.apply).not.toHaveBeenCalled();
});
it('recovers a newly submitted EIP while a removed old EIP is still awaiting cleanup in partial state', async () => {
  const test = await updateFixture();
  const varsPath = path.join(test.dir,'range.auto.tfvars.json'), variables = JSON.parse(await fs.readFile(varsPath,'utf8'));
  variables.eips = [{key:'replacement',creation_intent_id:'c'.repeat(32),bandwidth:10}]; variables.nat_gateways = [];
  await fs.writeFile(varsPath,JSON.stringify(variables));
  const address = 'module.range.tencentcloud_eip.range["replacement"]';
  const pendingPath = path.join(test.dir,'.range-apply-started'), pending = JSON.parse(await fs.readFile(pendingPath,'utf8'));
  pending.addresses = [address]; pending.createAddresses = [address]; await fs.writeFile(pendingPath,JSON.stringify(pending));
  test.query.mockImplementation(async (_account,kind,query) => kind === 'vpc' ? [{id:'vpc-fixture',tags}] as any : kind === 'eip' && query.tags
    ? [{id:'eip-replacement',tags:{...tags,PlatformCreateJobId:'update-job',CreationIntentId:'c'.repeat(32)},name:'range-fixture-cccccccccccccccc',bandwidth:10,publicIp:'203.0.113.2'}] as any : []);
  test.runner.importResource.mockImplementation(async input => {
    const statePath = path.join(test.dir,'terraform.tfstate'), state = JSON.parse(await fs.readFile(statePath,'utf8')); state.serial++;
    state.resources.push({mode:'managed',module:'module.range',type:'tencentcloud_eip',name:'range',instances:[{index_key:'replacement',attributes:{id:input.resourceId}}]});
    await fs.writeFile(statePath,JSON.stringify(state)); return {};
  });
  await test.provisioner.recoverUntrackedResources(test.input,test.assertCurrent,test.persist);
  expect(test.persist).toHaveBeenCalledWith(expect.objectContaining({eipAllocationIds:{replacement:'eip-replacement'}}),'update-job');
  expect(test.query).not.toHaveBeenCalledWith(expect.anything(),'eip',{ids:['eip-fixture']});
  expect(test.runner.apply).not.toHaveBeenCalled();
});
it.each(['missing-proof','unproven-old-job','foreign-vpc-inventory','foreign-context','foreign-owner','changed-eip-intent','changed-eip-token','missing-eip-inventory','incomplete-eip-read'] as const)('rejects %s during partial runtime update recovery without import or fee adoption', async reason => {
  const test = await updateFixture();
  if (reason === 'missing-proof') delete (test.input as any).assertRecoverySourceJob;
  if (reason === 'unproven-old-job') test.input.assertRecoverySourceJob.mockImplementation(async id => { if(id==='source-job') throw new Error('foreign or unsubmitted source job'); });
  if (reason === 'foreign-vpc-inventory') test.input.knownResourceSummary.vpcId = 'vpc-foreign';
  if (reason === 'foreign-context') test.input.knownResourceSummary.executionContext.cloudAccountUid = 'foreign';
  if (reason === 'foreign-owner') test.originalEip.tags.PlatformUserId = 'foreign';
  if (reason === 'changed-eip-intent') test.originalEip.tags.CreationIntentId = 'c'.repeat(32);
  if (reason === 'changed-eip-token') {
    const statePath = path.join(test.dir,'terraform.tfstate'), state = JSON.parse(await fs.readFile(statePath,'utf8'));
    state.resources[1].instances[0].attributes.client_token = 'c'.repeat(32); await fs.writeFile(statePath,JSON.stringify(state));
  }
  if (reason === 'missing-eip-inventory') test.input.knownResourceSummary.eipAllocationIds = {} as any;
  if (reason === 'incomplete-eip-read') test.query.mockImplementation(async (_account,kind) => kind === 'vpc' ? [{id:'vpc-fixture',tags}] as any : kind === 'eip' ? [] : [test.candidate]);
  await expect(test.provisioner.recoverUntrackedResources(test.input,test.assertCurrent,test.persist)).rejects.toThrow();
  expect(test.persist).not.toHaveBeenCalled(); expect(test.runner.importResource).not.toHaveBeenCalled(); expect(test.runner.apply).not.toHaveBeenCalled();
});
it('persists owned route identities from partial state and retains replacements for later diagnostics', async () => {
  const test = await fixture();
  const state = JSON.parse(await fs.readFile(path.join(test.dir, 'terraform.tfstate'), 'utf8'));
  state.resources.push({ mode: 'managed', module: 'module.range', type: 'tencentcloud_route_table', name: 'zones', instances: [{ index_key: 'dmz', attributes: { id: 'rtb-fixture', tags } }] });
  await fs.writeFile(path.join(test.dir, 'terraform.tfstate'), JSON.stringify(state));
  const summary = await test.provisioner.inspectResources(test.input);
  expect(summary?.routeTableIds).toEqual({ dmz: 'rtb-fixture' });
  expect(retiredResourceInventory(summary, { mode: 'opentofu', routeTableIds: { dmz: 'rtb-new' } })?.routeTableIds).toEqual({ 'rtb-fixture': 'rtb-fixture' });
  state.resources[state.resources.length - 1].instances[0].attributes.tags = { ...tags, CloudAccountUid: 'different-owner' };
  await fs.writeFile(path.join(test.dir, 'terraform.tfstate'), JSON.stringify(state));
  await expect(test.provisioner.inspectResources(test.input)).rejects.toThrow('ownership');
});
it.each(['owner','intent','name','vpc','spec','duplicate','none'])('rejects unproven %s candidates without importing or creating', async mismatch => {
  const test = await fixture();
  if(mismatch==='owner') test.candidate.tags.PlatformUserId='foreign';
  if(mismatch==='intent') test.candidate.tags.CreationIntentId='foreign';
  if(mismatch==='name') test.candidate.name='foreign';
  if(mismatch==='vpc') test.candidate.vpcId='vpc-foreign';
  if(mismatch==='spec') test.candidate.natProductVersion=1;
  if(mismatch==='duplicate'||mismatch==='none') test.query.mockImplementation(async (_account,kind) => kind==='vpc' ? [{id:'vpc-fixture',tags}] as any : kind==='eip' ? [{id:'eip-fixture',tags,publicIp:'203.0.113.1'}] as any : mismatch==='none' ? [] : [test.candidate,test.candidate]);
  await expect(test.provisioner.recoverUntrackedResources(test.input,test.assertCurrent,test.persist)).rejects.toThrow('Tencent');
  expect(test.persist).not.toHaveBeenCalled(); expect(test.runner.importResource).not.toHaveBeenCalled(); expect(test.runner.apply).not.toHaveBeenCalled();
});
it.each(['persist','lease'])('blocks state import when the %s fence fails', async failure => {
  const test = await fixture();
  if(failure==='persist') test.persist.mockRejectedValue(new Error('inventory unavailable'));
  else test.assertCurrent.mockRejectedValue(new Error('claim lost'));
  await expect(test.provisioner.recoverUntrackedResources(test.input,test.assertCurrent,test.persist)).rejects.toThrow();
  expect(test.runner.importResource).not.toHaveBeenCalled(); expect(test.runner.apply).not.toHaveBeenCalled();
});
it('rejects default-disabled real NAT execution before cloud reads or resource creation', async () => {
  const test = await fixture();
  const rpc = jest.spyOn(cloud,'describeTencentResourceInventory');
  await expect((test.provisioner as any).buildTencentVariables(test.input,{ natGateways: [{ key:'shared' }] },account,{requireRuntimePasswords:true})).rejects.toThrow('NAT execution is disabled');
  expect(test.runner.apply).not.toHaveBeenCalled();
  expect(rpc).not.toHaveBeenCalled();
});

async function absentFixture() {
  const test = await fixture();
  await fs.writeFile(path.join(test.dir,'terraform.tfstate'),JSON.stringify({version:4,lineage:'source-lineage',serial:2,resources:[]}));
  for (const file of ['main.tf','variables.tf','outputs.tf','versions.tf']) await fs.writeFile(path.join(test.dir,file),'fixture');
  test.query.mockResolvedValue([]);
  jest.spyOn(rpc,'requestTencentCloud').mockImplementation(async input => ({RequestId:'fixture-network-request',TotalCount:0,
    [input.action === 'DescribeNetworkAcls' ? 'NetworkAclSet' : 'RouteTableSet']:[]} as any));
  const input = { ...test.input, billingTags:{PlatformScope:'user',PlatformUserId:'owner-a'}, knownResourceSummary:{mode:'opentofu' as const,
    executionContext:{provider:'tencent_cloud' as const,cloudAccountUid:account.accountUid,cloudAccountContextId:account.cloudAccountContextId,regionId:account.defaultRegion,zoneId:account.defaultZoneId},
    vpcId:'vpc-fixture',hostIds:{entry:'ins-known'},systemDiskIds:{entry:'disk-known'},subnetIds:{dmz:'subnet-known'},securityGroupIds:{entry:'sg-known'},
    networkAclIds:{dmz:'acl-known'},secondaryNetworkInterfaceIds:{entry:'eni-known'},natGatewayIds:{shared:'nat-known'},eipAllocationIds:{entry:'eip-fixture'},routeTableIds:{dmz:'rtb-known'} } };
  const destroy = jest.fn(async () => { await fs.writeFile(path.join(test.dir,'terraform.tfstate'),JSON.stringify({version:4,lineage:'source-lineage',serial:3,resources:[]})); return {}; });
  Object.assign(test.runner,{destroy});
  return {...test,input,destroy};
}

async function onePassFixture() {
  const test = await absentFixture();
  await fs.writeFile(path.join(test.dir, 'terraform.tfstate'), JSON.stringify({ version: 4, lineage: 'source-lineage', serial: 2, resources: [
    { mode: 'managed', module: 'module.range', type: 'tencentcloud_vpc', name: 'range', instances: [{ attributes: { id: 'vpc-fixture', tags } }] },
    { mode: 'managed', module: 'module.range', type: 'tencentcloud_instance', name: 'hosts', instances: [{ index_key: 'entry', attributes: {
      id: 'ins-known', system_disk_id: 'disk-known', client_token: 'c'.repeat(32), action_timer_terminate_at: '2026-10-10T19:00:00Z', tags: { ...tags, CreationIntentId: 'c'.repeat(32) },
    } }] },
    { mode: 'managed', module: 'module.range', type: 'tencentcloud_eip', name: 'range', instances: [{ index_key: 'snat', attributes: { id: 'eip-fixture', tags: { ...tags, CreationIntentId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' } } }] },
    { mode: 'managed', module: 'module.range', type: 'tencentcloud_nat_gateway', name: 'shared', instances: [{ index_key: 'shared', attributes: { id: 'nat-known', tags: { ...tags, CreationIntentId: intent } } }] },
  ] }));
  return test;
}

it('settles a partial apply in one destroy only after fresh complete cloud scans, retaining pre-destroy native identities', async () => {
  const test = await onePassFixture();
  Object.assign(test.input.knownResourceSummary, { hostIds: {}, systemDiskIds: {} });
  await test.provisioner.destroy(test.input);
  expect(test.destroy).toHaveBeenCalledTimes(1);
  expect(test.input.assertRecoverySourceJob).toHaveBeenCalledWith('source-job');
  expect(test.assertCurrent).toHaveBeenCalled();
  expect(test.query.mock.calls.filter(call => call[1] === 'disk' && call[2].ids)).toHaveLength(2);
  expect(test.query).toHaveBeenCalledWith(expect.anything(), 'disk', { ids: ['disk-known'] });
  await expect(fs.stat(path.join(test.dir, '.range-apply-started'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(test.runner.apply).not.toHaveBeenCalled(); expect(test.runner.importResource).not.toHaveBeenCalled();
});

it.each(['missing-claim', 'missing-source', 'lost-claim', 'wrong-source', 'foreign-owner', 'foreign-context', 'wrong-region', 'wrong-zone', 'mixed-provider', 'residual-disk', 'incomplete-route', 'changed-pending', 'changed-lineage', 'changed-serial'])('retains recovery evidence without creating when one-pass absence fails for %s', async reason => {
  const test = await onePassFixture();
  if (reason === 'missing-claim') delete (test.input as any).assertRecoveryClaim;
  if (reason === 'missing-source') delete (test.input as any).assertRecoverySourceJob;
  if (reason === 'lost-claim') test.assertCurrent.mockImplementation(async () => { if (test.destroy.mock.calls.length) throw new Error('claim lost'); });
  if (reason === 'wrong-source') test.input.assertRecoverySourceJob.mockRejectedValue(new Error('foreign source job'));
  if (reason === 'foreign-owner') test.input.billingTags.PlatformUserId = 'foreign';
  if (reason === 'foreign-context') test.input.knownResourceSummary.executionContext.cloudAccountUid = 'foreign';
  if (reason === 'wrong-region' || reason === 'wrong-zone') {
    const file = path.join(test.dir, 'range.auto.tfvars.json'); const variables = JSON.parse(await fs.readFile(file, 'utf8'));
    variables[reason === 'wrong-region' ? 'region' : 'zone_id'] = 'foreign'; await fs.writeFile(file, JSON.stringify(variables));
  }
  if (reason === 'mixed-provider') {
    const file = path.join(test.dir, 'terraform.tfstate'); const state = JSON.parse(await fs.readFile(file, 'utf8'));
    state.resources.push({ mode: 'managed', module: 'module.range', type: 'alicloud_eip_address', name: 'shadow', instances: [{ attributes: { id: 'eip-shadow', tags } }] });
    await fs.writeFile(file, JSON.stringify(state));
  }
  if (reason === 'residual-disk') test.query.mockImplementation(async (_account, kind, query) => kind === 'disk' && query.ids ? [{ id: 'disk-known' }] as any : []);
  if (reason === 'incomplete-route') jest.spyOn(rpc, 'requestTencentCloud').mockResolvedValue({ TotalCount: 0, RouteTableSet: [] } as any);
  if (reason === 'changed-pending') test.query.mockImplementation(async () => {
    const file = path.join(test.dir, '.range-apply-started'); const pending = JSON.parse(await fs.readFile(file, 'utf8'));
    pending.submittedAt = new Date(0).toISOString(); await fs.writeFile(file, JSON.stringify(pending)); return [];
  });
  if (reason === 'changed-lineage' || reason === 'changed-serial') test.query.mockImplementation(async () => {
    await fs.writeFile(path.join(test.dir, 'terraform.tfstate'), JSON.stringify({ version: 4, lineage: reason === 'changed-lineage' ? 'foreign' : 'source-lineage', serial: 4, resources: [] })); return [];
  });
  await expect(test.provisioner.destroy(test.input)).rejects.toThrow();
  await expect(fs.stat(path.join(test.dir, '.range-apply-started'))).resolves.toBeDefined();
  expect(test.destroy.mock.calls.length).toBeLessThanOrEqual(1);
  expect(test.runner.apply).not.toHaveBeenCalled(); expect(test.runner.importResource).not.toHaveBeenCalled();
});

it.each(['complete', 'residual', 'claim-lost', 'wrong-source', 'foreign-owner'])('automatically cleans a failed creation with real worker source and ledger fences in one destroy: %s', reason => runInCloudWorkspace({
  cloudWorkspaceId: 'one-pass-workspace', provider: account.provider, accountUid: account.accountUid,
}, async () => {
  const test = await onePassFixture();
  const repository = createMemoryAdminRepository();
  const instance = await repository.createRangeInstance({ name: 'partial create', cloudProvider: account.provider, instanceMode: 'range',
    ownerUserId: 'owner-a', status: 'creating', resourceSummary: { ...test.input.knownResourceSummary, creationAttempted: true } });
  const job = await repository.createProvisionJob({ rangeInstanceId: instance.id, jobType: 'create', triggeredBy: 'owner-a' });
  await repository.updateRangeInstance(instance.id, { lastJobId: job.id });
  const claim = (await repository.claimRangeProvisionJob(job.id, new Date()))!;
  await syncRangeInstanceBillingLedger({ repository, instance, regionId: account.defaultRegion, cloudAccountUid: account.accountUid,
    resourceSummary: test.input.knownResourceSummary, sourceProvisionJobId: job.id, billingStartAt: instance.createdAt });
  if (reason === 'wrong-source') {
    const read = repository.getProvisionJobById.bind(repository);
    jest.spyOn(repository, 'getProvisionJobById').mockImplementation(async id => {
      const found = await read(id); return id === job.id && found ? { ...found, rangeInstanceId: 'foreign' } : found;
    });
  }
  const dir = path.join(root, instance.id); await fs.rename(test.dir, dir);
  const replaceIds = (value: any): any => typeof value === 'string' ? value === 'range-a' ? instance.id : value === 'source-job' ? job.id : value
    : Array.isArray(value) ? value.map(replaceIds) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, replaceIds(child)])) : value;
  for (const file of ['terraform.tfstate', 'tencent-range-identity.json', 'range.auto.tfvars.json', '.range-apply-started']) {
    await fs.writeFile(path.join(dir, file), JSON.stringify(replaceIds(JSON.parse(await fs.readFile(path.join(dir, file), 'utf8')))));
  }
  let present = true;
  jest.spyOn(rpc, 'requestTencentCloud').mockImplementation(async input => input.action === 'DescribeDisks'
    ? { RequestId: 'fixture-disk-query', TotalCount: present ? 1 : 0, DiskSet: present ? [{ DiskId: 'disk-known', InstanceId: 'ins-known', DiskUsage: 'SYSTEM_DISK', Tags: [] }] : [] } as any
    : { RequestId: 'fixture-network-query', TotalCount: 0, [input.action === 'DescribeNetworkAcls' ? 'NetworkAclSet' : 'RouteTableSet']: [] } as any);
  test.destroy.mockImplementation(async () => { present = false; await fs.writeFile(path.join(dir, 'terraform.tfstate'), JSON.stringify({ version: 4, lineage: 'source-lineage', serial: 3, resources: [] })); return {}; });
  test.query.mockImplementation(async (_account, kind, query) => {
    if (present && kind === 'vpc') return [{ id: 'vpc-fixture', tags: { ...tags, RangeInstanceId: instance.id, PlatformCreateJobId: job.id } }] as any;
    if (present && kind === 'disk') return [{ id: 'disk-known', diskUsage: 'SYSTEM_DISK', tags: {}, shared: false }] as any;
    if (!present && reason === 'residual' && kind === 'eip' && query.ids) return [{ id: 'eip-fixture' }] as any;
    if (!present && reason === 'claim-lost') await repository.updateProvisionJob(job.id, { status: 'failed' });
    return [];
  });
  const worker = new ProvisioningWorkerService(repository, test.provisioner, {} as any) as any;
  const result = await worker.cleanupFailedRangeCreate({ instance, job: claim, cloudContext: { id: account.cloudAccountContextId, accountUid: account.accountUid, regionId: account.defaultRegion },
    cleanupInput: { rangeInstanceId: instance.id, templateModulePath: test.input.templateModulePath, allocatedCidr: null, runtimeConfig: account, requirePersistedState: true,
      billingTags: { PlatformScope: 'user', PlatformUserId: reason === 'foreign-owner' ? 'foreign' : 'owner-a' } }, reportStep: jest.fn(async () => {}) });
  const ledgers = await repository.listBillingLedgerResources();
  if (reason === 'complete') expect(result).toBeNull();
  expect(ledgers).toEqual(expect.arrayContaining([expect.objectContaining({ cloudResourceId: 'ins-known', sourceProvisionJobId: job.id }),
    expect.objectContaining({ cloudResourceId: 'disk-known', sourceProvisionJobId: job.id }), expect.objectContaining({ cloudResourceId: 'eip-fixture', sourceProvisionJobId: job.id }),
    expect.objectContaining({ cloudResourceId: 'nat-known', sourceProvisionJobId: job.id })]));
  expect(test.destroy).toHaveBeenCalledTimes(reason === 'wrong-source' || reason === 'foreign-owner' ? 0 : 1);
  if (reason === 'complete') {
    expect(result).toBeNull(); expect(ledgers.every(row => row.releasedAt)).toBe(true);
    expect((await repository.listProvisionJobStepLogs(job.id)).some(log => log.stepName === FAILED_CREATE_CLEANUP_PROOF_STEP && log.status === 'succeeded')).toBe(true);
    await expect(fs.stat(path.join(dir, '.range-apply-started'))).rejects.toMatchObject({ code: 'ENOENT' });
  } else {
    expect(result).toMatch(/remain|claim|ownership|frozen/); expect(ledgers.every(row => !row.releasedAt)).toBe(true);
    await expect(fs.stat(path.join(dir, '.range-apply-started'))).resolves.toBeDefined();
  }
  expect(test.runner.apply).not.toHaveBeenCalled(); expect(test.runner.importResource).not.toHaveBeenCalled();
}));
it('closes an already cleaned unknown apply only after both complete native scans and matching durable absence proof', async () => {
  const test = await absentFixture();
  await test.provisioner.recoverUntrackedResources(test.input,test.assertCurrent,test.persist);
  expect(test.runner.importResource).not.toHaveBeenCalled(); expect(test.runner.apply).not.toHaveBeenCalled();
  expect(new Set(test.query.mock.calls.map(call => call[1]))).toEqual(new Set(['ecs','disk','vpc','vswitch','security_group','network_acl','eni','nat','eip']));
  expect(test.query.mock.calls.filter(call => call[1] === 'disk')).toHaveLength(4);
  await test.provisioner.destroy(test.input);
  expect(test.destroy).toHaveBeenCalledTimes(1);
  await expect(fs.stat(path.join(test.dir,'.range-apply-started'))).rejects.toMatchObject({code:'ENOENT'});
});

it.each(['missing','foreign'])('does not substitute the current frozen identity for %s retired recovery evidence', async reason => {
  const test = await absentFixture();
  (test.input.knownResourceSummary as any).retiredResources = { mode:'opentofu',eipAllocationIds:{retired:'eip-retired'},
    ...(reason === 'foreign' ? {executionContext:{...test.input.knownResourceSummary.executionContext,cloudAccountContextId:'other-context'}} : {}) };
  await expect(test.provisioner.recoverUntrackedResources(test.input,test.assertCurrent,test.persist)).rejects.toThrow('conflicting frozen identities');
  await expect(fs.stat(path.join(test.dir,'.tencent-apply-absence-proved.json'))).rejects.toMatchObject({code:'ENOENT'});
  await expect(fs.stat(path.join(test.dir,'.range-apply-started'))).resolves.toBeDefined();
  expect(test.runner.apply).not.toHaveBeenCalled(); expect(test.runner.importResource).not.toHaveBeenCalled(); expect(test.persist).not.toHaveBeenCalled();
});

it.each(['none','known-acl','known-route','owned-tags','original-vpc','duplicate','changed-total','truncated','api-error'])('uses complete account network inventory after VPC deletion: %s', async reason => {
  const test=await absentFixture();
  const requests=jest.spyOn(rpc,'requestTencentCloud').mockImplementation(async input => {
    expect(input.parameters).not.toHaveProperty('Filters');
    expect(input.parameters).not.toHaveProperty('RouteTableIds');
    const acl=input.action === 'DescribeNetworkAcls'; const offset=Number((input.parameters as any).Offset);
    if (reason === 'api-error') throw new Error('ResourceNotFound');
    const rows=Array.from({length:offset === 0 ? 100 : 1},(_,index) => ({[acl?'NetworkAclId':'RouteTableId']:`${acl?'acl':'rtb'}-external${offset+index}`,VpcId:'vpc-external',TagSet:[]}));
    if (offset === 100) {
      if (reason === 'known-acl' && acl) rows[0].NetworkAclId='acl-known';
      if (reason === 'known-route' && !acl) rows[0].RouteTableId='rtb-known';
      if (reason === 'owned-tags') rows[0].TagSet=Object.entries(tags).map(([Key,Value])=>({Key,Value})) as any;
      if (reason === 'original-vpc') rows[0].VpcId='vpc-fixture';
      if (reason === 'duplicate') rows[0][acl?'NetworkAclId':'RouteTableId']=`${acl?'acl':'rtb'}-external0`;
      if (reason === 'truncated') rows.length=0;
    }
    return {RequestId:'fixture-page-request',TotalCount:reason === 'changed-total' && offset ? 102 : 101,[acl?'NetworkAclSet':'RouteTableSet']:rows} as any;
  });
  if (reason === 'none') {
    await test.provisioner.recoverUntrackedResources(test.input,test.assertCurrent,test.persist);
    expect(requests.mock.calls.filter(([input])=>input.action === 'DescribeRouteTables')).toHaveLength(4);
    await test.provisioner.destroy(test.input);
  } else {
    await expect(test.provisioner.recoverUntrackedResources(test.input,test.assertCurrent,test.persist)).rejects.toThrow();
    await expect(fs.stat(path.join(test.dir,'.range-apply-started'))).resolves.toBeDefined();
  }
  expect(test.runner.apply).not.toHaveBeenCalled();expect(test.runner.importResource).not.toHaveBeenCalled();
});
it.each(['known-paid','tagged-residual','changed-context','changed-pending','incomplete-route'])('retains unknown apply recovery for %s evidence', async reason => {
  const test = await absentFixture();
  if (reason === 'known-paid') test.query.mockImplementation(async (_account,kind,query) => kind === 'eip' && query.ids ? [{id:'eip-fixture'}] as any : []);
  if (reason === 'tagged-residual') test.query.mockImplementation(async (_account,kind,query) => kind === 'ecs' && query.tags ? [{id:'ins-unknown'}] as any : []);
  if (reason === 'changed-context') test.input.knownResourceSummary.executionContext.cloudAccountUid = 'foreign';
  if (reason === 'incomplete-route') jest.spyOn(rpc,'requestTencentCloud').mockResolvedValue({TotalCount:0,RouteTableSet:[]} as any);
  if (reason === 'changed-pending') {
    await test.provisioner.recoverUntrackedResources(test.input,test.assertCurrent,test.persist);
    const file=path.join(test.dir,'.range-apply-started');const pending=JSON.parse(await fs.readFile(file,'utf8'));pending.submittedAt=new Date(0).toISOString();await fs.writeFile(file,JSON.stringify(pending));
    await expect(test.provisioner.destroy(test.input)).rejects.toThrow('previous apply outcome is unknown');
  } else await expect(test.provisioner.recoverUntrackedResources(test.input,test.assertCurrent,test.persist)).rejects.toThrow();
  await expect(fs.stat(path.join(test.dir,'.range-apply-started'))).resolves.toBeDefined();
  expect(test.runner.apply).not.toHaveBeenCalled();expect(test.runner.importResource).not.toHaveBeenCalled();
});
