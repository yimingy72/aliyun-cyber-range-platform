import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { SingleInstanceNetworkBootstrapService, singleNetworkWorkspaceKey } from '../src/provisioning/single-instance-network-bootstrap';
const account = { accessKeyId: 'synthetic', accessKeySecret: 'synthetic', defaultRegion: 'cn-hangzhou', defaultZoneId: 'cn-hangzhou-h' };
const tags = { CloudAccountUid: 'test-account', PlatformManaged: 'true' };
const profile: any = { id: 'test', provider: 'alibaba_cloud', cloudAccountUid: 'test-account', cloudAccountContextId: 'test-context', managedByPlatform: true, regionId: account.defaultRegion, zoneId: account.defaultZoneId, vpcId: 'vpc-test', vswitchIds: ['vsw-test'], securityGroupId: 'sg-test' };
it('destroys only the requested bound network state, verifies it is empty, and preserves legacy/unrelated state', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'single-network-lifecycle-'));
  const service: any = new SingleInstanceNetworkBootstrapService({} as any);
  service.workspacesRootDir = root;
  profile.workspaceKey = singleNetworkWorkspaceKey(profile.cloudAccountUid, profile.regionId, profile.zoneId);
  const dir = path.join(root, profile.workspaceKey);
  await fs.mkdir(dir);
  await fs.writeFile(path.join(dir, 'terraform.tfvars.json'), '{}');
  await fs.writeFile(path.join(dir, 'versions.tf'), 'terraform {\n required_providers {\n  alicloud = { source = "aliyun/alicloud"\n version = "~> 1.253"\n }\n }\n}\n');
  const state = { version: 4, lineage: 'synthetic-state', serial: 1, resources: [['alicloud_vpc', profile.vpcId], ['alicloud_vswitch', profile.vswitchIds[0]], ['alicloud_security_group', profile.securityGroupId]].map(([type, id]) => ({ module: 'module.network', mode: 'managed', type, name: 'default', instances: [{ attributes: { id, tags } }] })) };
  await fs.writeFile(path.join(dir, 'terraform.tfstate'), JSON.stringify(state));
  service.runner = { init: jest.fn(async (options) => {
    expect(options.upgrade).toBe(true);
    expect(await fs.readFile(path.join(dir, 'versions.tf'), 'utf8')).toContain('version = "= 1.282.0-range.1"');
    expect(JSON.parse(await fs.readFile(path.join(dir, 'terraform.tfstate'), 'utf8'))).toEqual(state);
    return {};
  }), destroy: jest.fn(async () => { await fs.writeFile(path.join(dir, 'terraform.tfstate'), JSON.stringify({ version: 4, lineage: 'synthetic-state', serial: 2, resources: [], outputs: {} })); }) };
  await expect(service.destroyDefaultProfile({ ...profile, managedByPlatform: false }, account)).rejects.toThrow('bound');
  await expect(service.destroyDefaultProfile({ ...profile, vpcId: 'vpc-other' }, account)).rejects.toThrow('does not match');
  expect(service.runner.destroy).not.toHaveBeenCalled();
  await service.destroyDefaultProfile(profile, account);
  expect(service.runner.destroy).toHaveBeenCalledTimes(1);
  await expect(fs.stat(dir)).rejects.toThrow();
  await fs.rm(root, { recursive: true, force: true });
});

it.each(['.range-apply-started', 'errored.tfstate', 'terraform.tfstate.backup', 'terraform.tfstate'])(
  'registers unknown recovery instead of permitting a second network when only %s survives', async evidence => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'single-network-unknown-'));
    const service: any = new SingleInstanceNetworkBootstrapService({} as any);
    service.workspacesRootDir = root;
    const input = { provider: 'alibaba_cloud' as const, cloudAccountUid: 'test-account', cloudAccountContextId: 'test-context', regionId: account.defaultRegion, zoneId: account.defaultZoneId };
    const dir = path.join(root, singleNetworkWorkspaceKey(input.cloudAccountUid, input.regionId, input.zoneId));
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, evidence), 'incomplete');
    const recovered = await service.readRecoveryProfile(input);
    expect(recovered).toMatchObject({ status: 'destroying', vpcId: '', vswitchIds: [], cloudAccountUid: input.cloudAccountUid });
    service.runner = { init: jest.fn() };
    await expect(service.bootstrapDefaultProfile({ ...input, runtimeConfig: account })).rejects.toThrow('recover it before creating');
    expect(service.runner.init).not.toHaveBeenCalled();
    await expect(service.destroyDefaultProfile({ ...profile, ...recovered }, account)).rejects.toThrow('recovery is required');
    await expect(fs.stat(path.join(dir, evidence))).resolves.toBeDefined();
    await fs.rm(root, { recursive: true, force: true });
  },
);
