import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SingleInstanceNetworkBootstrapService, singleNetworkWorkspaceKey } from '../src/provisioning/single-instance-network-bootstrap';
import { CidrPoolService } from '../src/provisioning/cidr-pool.service';

const account = { provider: 'tencent_cloud' as const, accountUid: '100000000001', cloudAccountContextId: 'context-a', accessKeyId: 'fake', accessKeySecret: 'fake', defaultRegion: 'ap-shanghai', defaultZoneId: 'ap-shanghai-2' };
const input = { provider: account.provider, cloudAccountUid: account.accountUid, cloudAccountContextId: account.cloudAccountContextId, regionId: account.defaultRegion, zoneId: account.defaultZoneId, runtimeConfig: account };
let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(),'tencent-network-')); });
afterEach(async () => { await fs.rm(root,{ recursive: true, force: true }); jest.restoreAllMocks(); });
function fixture() {
  const pool = new CidrPoolService(); jest.spyOn(pool,'getPool').mockReturnValue(['10.80.0.0/16']);
  const service = new SingleInstanceNetworkBootstrapService(pool) as any;
  service.projectRootDir = '/app'; service.workspacesRootDir = root; service.env = {};
  const dir = path.join(root,singleNetworkWorkspaceKey(account.accountUid,account.defaultRegion,account.defaultZoneId,account.provider,account.cloudAccountContextId));
  const addresses = ['module.network.tencentcloud_vpc.shared','module.network.tencentcloud_subnet.shared','module.network.tencentcloud_security_group.shared','module.network.tencentcloud_security_group_rule_set.shared'];
  const runner = { init: jest.fn().mockResolvedValue({}), plan: jest.fn().mockResolvedValue({}),
    showPlan: jest.fn().mockResolvedValue({ planned_values: { root_module: { resources: addresses.map(address => ({ mode: 'managed', address })) } }, resource_changes: addresses.map(address => ({ mode: 'managed', address, change: { actions: ['create'] } })) }),
    apply: jest.fn(async () => {
      const vars = JSON.parse(await fs.readFile(path.join(dir,'terraform.tfvars.json'),'utf8'));
      const tags = { CloudProvider: 'tencent_cloud', CloudAccountUid: account.accountUid, CloudAccountContextId: account.cloudAccountContextId, CreationIntentId: vars.creation_intent_id, PlatformManaged: 'true' };
      await fs.writeFile(path.join(dir,'terraform.tfstate'),JSON.stringify({ version: 4, lineage: 'tencent-network', serial: 1, resources: addresses.map((address,index) => ({ module: 'module.network', mode: 'managed', type: address.split('.')[2], name: 'shared', instances: [{ attributes: { id: ['vpc-fixture','subnet-fixture','sg-fixture','sgr-fixture'][index], tags, security_group_id: 'sg-fixture' } }] })) }));
      return {};
    }),
    output: jest.fn().mockResolvedValue({ vpc_id: { value: 'vpc-fixture' }, vswitch_ids: { value: ['subnet-fixture'] }, security_group_id: { value: 'sg-fixture' } }),
    destroy: jest.fn(async () => { await fs.writeFile(path.join(dir,'terraform.tfstate'),JSON.stringify({ version: 4, lineage: 'tencent-network', serial: 2, resources: [] })); return {}; }) };
  service.runner = runner; return { service, runner, dir };
}
it('builds a provider/context-bound Tencent subnet and destroys only its persisted module state', async () => {
  const test = fixture(); const profile = await test.service.bootstrapDefaultProfile(input);
  expect(profile).toMatchObject({ provider: 'tencent_cloud', vswitchIds: ['subnet-fixture'], vswitchCidrs: ['10.80.1.0/24'], managedByPlatform: true });
  expect(test.runner.init.mock.calls[0][0].env).toMatchObject({ TENCENTCLOUD_REGION: 'ap-shanghai', TENCENTCLOUD_SECRET_ID: 'fake' });
  expect(await fs.readFile(path.join(test.dir,'versions.tf'),'utf8')).toContain('1.83.34-range.1');
  await expect(test.service.destroyDefaultProfile({ ...profile, cloudAccountContextId: 'other' },account)).rejects.toThrow('bound');
  expect(test.runner.destroy).not.toHaveBeenCalled();
  await test.service.destroyDefaultProfile(profile,account);
  expect(test.runner.destroy).toHaveBeenCalledTimes(1);
  await expect(fs.stat(test.dir)).rejects.toThrow();
});
it('retains unknown Tencent network intent and never applies another network', async () => {
  const test = fixture(); test.runner.apply.mockRejectedValue(new Error('response lost'));
  await expect(test.service.bootstrapDefaultProfile(input)).rejects.toThrow('response lost');
  const recovery = await test.service.readRecoveryProfile(input);
  expect(recovery).toMatchObject({ provider: 'tencent_cloud', status: 'destroying', cloudAccountContextId: 'context-a', vpcId: '', vswitchIds: [] });
  await expect(test.service.bootstrapDefaultProfile(input)).rejects.toThrow('recover it before creating');
  expect(test.runner.apply).toHaveBeenCalledTimes(1);
  expect(test.runner.destroy).not.toHaveBeenCalled();
});
it('separates Tencent contexts and providers even when numeric account IDs match', () => {
  const first = singleNetworkWorkspaceKey(account.accountUid,account.defaultRegion,account.defaultZoneId,account.provider,'context-a');
  expect(singleNetworkWorkspaceKey(account.accountUid,account.defaultRegion,account.defaultZoneId,account.provider,'context-b')).not.toBe(first);
  expect(singleNetworkWorkspaceKey(account.accountUid,account.defaultRegion,account.defaultZoneId)).not.toBe(first);
});
