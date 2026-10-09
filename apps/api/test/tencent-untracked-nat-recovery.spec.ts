import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OpenTofuRangeProvisioner } from '../src/provisioning/open-tofu-range-provisioner';
import * as cloud from '../src/admin/tencent-cloud-resources';

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
