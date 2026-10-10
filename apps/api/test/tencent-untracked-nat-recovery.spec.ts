import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OpenTofuRangeProvisioner } from '../src/provisioning/open-tofu-range-provisioner';
import * as cloud from '../src/admin/tencent-cloud-resources';
import * as rpc from '../src/admin/tencent-cloud-client';
import { retiredResourceInventory } from '../src/provisioning/retired-resource-inventory';

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
    { mode: 'managed', module: 'module.range', type: 'tencentcloud_eip', name: 'range', instances: [{ index_key: 'snat', attributes: { id: 'eip-fixture', tags } }] },
  ] };
  await fs.writeFile(path.join(dir,'terraform.tfstate'),JSON.stringify(state));
  await fs.writeFile(path.join(dir,'tencent-range-identity.json'),JSON.stringify({ provider: account.provider, cloudAccountContextId: account.cloudAccountContextId, cloudAccountUid: account.accountUid, regionId: account.defaultRegion, zoneId: account.defaultZoneId, rangeInstanceId: 'range-a' }));
  await fs.writeFile(path.join(dir,'.range-apply-started'),JSON.stringify({ version: 1, addresses: [natAddress], createAddresses: [natAddress], priorIds: {}, priorLineage: null, submittedAt: new Date().toISOString(), sourceProvisionJobId: 'source-job' }));
  await fs.writeFile(path.join(dir,'range.auto.tfvars.json'),JSON.stringify({ resource_name_prefix: 'range-fixture', tags, eips: [{ key: 'snat', creation_intent_id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', bandwidth: 10 }], nat_gateways: [{ key: 'shared', creation_intent_id: intent }] }));
  const order: string[] = [];
  const runner = { init: jest.fn(async () => { order.push('init'); return {}; }), importResource: jest.fn(async (input: any) => {
    order.push('import'); state.serial++;
    state.resources.push({ mode: 'managed', module: 'module.range', type: 'tencentcloud_nat_gateway', name: 'shared', instances: [{ index_key: 'shared', attributes: { id: input.resourceId, tags: { ...tags, CreationIntentId: intent } } }] });
    await fs.writeFile(path.join(dir,'terraform.tfstate'),JSON.stringify(state)); return {};
  }), apply: jest.fn() };
  const provisioner = new OpenTofuRangeProvisioner({ projectRootDir:'/app', workspacesRootDir: root, runner: runner as any, env: { TENCENTCLOUD_PROVIDER_ZIP_PATH:'', TENCENTCLOUD_PROVIDER_UNPACKED_MIRROR_ROOT:'' } });
  const candidate: any = { id: 'nat-fixture', kind: 'nat', tags: { ...tags, CreationIntentId: intent }, name: `range-fixture-${intent.slice(0,16)}`, vpcId:'vpc-fixture', natProductVersion: 2, bandwidth: 5000, maxConcurrent: 2000000, publicIpAddresses:['203.0.113.1'] };
  const query = jest.spyOn(cloud,'describeTencentResourceInventory').mockImplementation(async (_account,kind) => kind === 'vpc' ? [{ id:'vpc-fixture',tags }] as any : kind === 'eip' ? [{id:'eip-fixture',tags,publicIp:'203.0.113.1'}] as any : [candidate]);
  const persist = jest.fn(async () => { order.push('persist'); });
  const assertCurrent = jest.fn(async () => {});
  const input = { rangeInstanceId:'range-a', templateModulePath:'infra/opentofu/modules/tencentcloud-enterprise-range', allocatedCidr:null, runtimeConfig: account };
  return { provisioner,runner,candidate,query,persist,assertCurrent,input,dir,order };
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
