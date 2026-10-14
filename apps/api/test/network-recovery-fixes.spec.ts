import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SingleInstanceNetworkService } from '../src/admin/single-instance-network.service';
import { SingleInstanceNetworkBootstrapService, singleNetworkWorkspaceKey } from '../src/provisioning/single-instance-network-bootstrap';
import { CidrPoolService } from '../src/provisioning/cidr-pool.service';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';

const account = { provider: 'alibaba_cloud' as const, cloudAccountContextId: 'context-source', accountUid: 'uid-source',
  accountUidResolved: true, defaultRegion: 'cn-hangzhou', defaultZoneId: 'cn-hangzhou-h',
  accessKeyId: 'fixture-key', accessKeySecret: 'fixture-secret', imageImportBucket: '' };
const admin = { id: 'fixture-admin', role: 'admin' } as any;
const tags = { CloudAccountUid: account.accountUid, CloudAccountContextId: account.cloudAccountContextId, PlatformManaged: 'true' };
const resources = [
  { module: 'module.network', mode: 'managed', type: 'alicloud_vpc', name: 'default', instances: [{ attributes: { id: 'vpc-owned', tags } }] },
  { module: 'module.network', mode: 'managed', type: 'alicloud_vswitch', name: 'default', instances: [0, 1, 2].map(index => ({ index_key: index, attributes: { id: `vsw-owned-${index}`, tags } })) },
  { module: 'module.network', mode: 'managed', type: 'alicloud_security_group', name: 'default', instances: [{ attributes: { id: 'sg-owned', tags } }] },
];
const addresses = ['module.network.alicloud_vpc.default', ...[0, 1, 2].map(index => `module.network.alicloud_vswitch.default[${index}]`), 'module.network.alicloud_security_group.default'];

describe('shared network recovery after API exit', () => {
  let root: string;
  afterEach(async () => { jest.restoreAllMocks(); if (root) await fs.rm(root, { recursive: true, force: true }); });
  async function fixture() {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'network-recovery-fixes-'));
    const dir = path.join(root, singleNetworkWorkspaceKey(account.accountUid, account.defaultRegion, account.defaultZoneId));
    const repository = createMemoryAdminRepository();
    const cidr = new CidrPoolService();
    jest.spyOn(cidr, 'getPool').mockReturnValue(['10.80.0.0/16']);
    const bootstrap = new SingleInstanceNetworkBootstrapService(cidr) as any;
    bootstrap.workspacesRootDir = root;
    bootstrap.projectRootDir = '/app';
    const runner = {
      init: jest.fn().mockResolvedValue({}), plan: jest.fn().mockResolvedValue({}),
      showPlan: jest.fn().mockResolvedValue({ planned_values: { root_module: { resources: addresses.map(address => ({ mode: 'managed', address })) } },
        resource_changes: addresses.map(address => ({ mode: 'managed', address, change: { actions: ['create'] } })) }),
      apply: jest.fn(async () => fs.writeFile(path.join(dir, 'terraform.tfstate'), JSON.stringify({ version: 4, serial: 1, lineage: 'network-source', resources }))),
      output: jest.fn().mockResolvedValue({ vpc_id: { value: 'vpc-owned' }, security_group_id: { value: 'sg-owned' },
        vswitch_ids: { value: ['vsw-owned-0', 'vsw-owned-1', 'vsw-owned-2'] } }),
      destroy: jest.fn(async () => fs.writeFile(path.join(dir, 'terraform.tfstate'), JSON.stringify({ version: 4, serial: 2, lineage: 'network-source', resources: [] }))),
    };
    bootstrap.runner = runner;
    const identity = { provider: account.provider, cloudAccountUid: account.accountUid, cloudAccountContextId: account.cloudAccountContextId,
      regionId: account.defaultRegion, zoneId: account.defaultZoneId, createdByUserId: admin.id };
    // Run the real pre-apply persistence, then model process exit by never committing the returned ready profile.
    await bootstrap.bootstrapDefaultProfile({ ...identity, runtimeConfig: account, onApplyStart: async () => {
      const pending = await bootstrap.readRecoveryProfile(identity);
      await repository.upsertSingleInstanceNetworkProfile({ ...pending, ...identity, status: 'destroying' });
    } });
    const [pending] = await repository.listSingleInstanceNetworkProfiles();
    expect(pending).toMatchObject({ status: 'destroying', vpcId: '', securityGroupId: '', vswitchIds: [] });
    const config = { getExecutionAccountContext: async () => ({ ...account }) } as any;
    const execution = { assertNetworkUnused: jest.fn(async () => undefined) };
    const service = new SingleInstanceNetworkService(repository, config, bootstrap, cidr, execution as any);
    await service.registerCleanup(pending.id, 'recovery-run', new Date(Date.now() - 5000).toISOString(), [admin.id], admin);
    return { repository, bootstrap, runner, service, pending, dir, config, execution };
  }
  it('recovers exact state IDs before checking references and destroys the original network', async () => {
    const f = await fixture();
    await expect(f.service.destroy(f.pending.id, admin, 'recovery-run')).resolves.toMatchObject({
      status: 'destroyed', vpcId: 'vpc-owned', securityGroupId: 'sg-owned' });
    expect(f.execution.assertNetworkUnused).toHaveBeenCalledWith(expect.objectContaining({ vpcId: 'vpc-owned' }), account);
    expect(f.runner.apply).toHaveBeenCalledTimes(1);
    expect(f.runner.destroy).toHaveBeenCalledTimes(1);
    expect(await f.repository.listSingleInstanceNetworkProfiles()).toEqual([]);
  });
  it.each(['uid', 'context', 'provider', 'region', 'zone', 'state-owner', 'missing-proof', 'missing-state', 'conflicting-id'] as const)
    ('refuses %s recovery material before cloud deletion', async scenario => {
      const f = await fixture();
      const identityFile = path.join(f.dir, 'single-network-identity.json');
      const identity = JSON.parse(await fs.readFile(identityFile, 'utf8'));
      const fields: Record<string, string> = { uid: 'cloudAccountUid', context: 'cloudAccountContextId', provider: 'provider', region: 'regionId', zone: 'zoneId' };
      const field = fields[scenario];
      if (field) { identity[field] = 'foreign'; await fs.writeFile(identityFile, JSON.stringify(identity)); }
      if (scenario === 'state-owner') {
        const state = JSON.parse(await fs.readFile(path.join(f.dir, 'terraform.tfstate'), 'utf8'));
        state.resources[0].instances[0].attributes.tags.CloudAccountContextId = 'foreign';
        await fs.writeFile(path.join(f.dir, 'terraform.tfstate'), JSON.stringify(state));
      }
      if (scenario === 'missing-proof') await fs.unlink(path.join(f.dir, '.range-apply-complete.json'));
      if (scenario === 'missing-state') await fs.unlink(path.join(f.dir, 'terraform.tfstate'));
      if (scenario === 'conflicting-id') await f.repository.upsertSingleInstanceNetworkProfile({ ...f.pending, vpcId: 'vpc-foreign' });
      await expect(f.service.destroy(f.pending.id, admin, 'recovery-run')).rejects.toThrow();
      expect(f.runner.destroy).not.toHaveBeenCalled();
      expect(await f.repository.getSingleInstanceNetworkProfileById(f.pending.id)).not.toBeNull();
    });
  it('keeps an active reference protected even when its network IDs had not been persisted', async () => {
    const f = await fixture();
    await f.repository.createRangeInstance({ name: 'active', instanceMode: 'single', status: 'running', ownerUserId: admin.id,
      singleInstanceConfig: { networkProfileId: f.pending.id } as any });
    await expect(f.service.destroy(f.pending.id, admin, 'recovery-run')).rejects.toThrow('still referenced');
    expect(f.runner.destroy).not.toHaveBeenCalled();
    expect(await f.repository.getSingleInstanceNetworkProfileById(f.pending.id)).toMatchObject({ vpcId: 'vpc-owned' });
  });
});
