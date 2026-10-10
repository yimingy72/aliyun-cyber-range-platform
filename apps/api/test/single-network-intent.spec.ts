import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SingleInstanceNetworkService } from '../src/admin/single-instance-network.service';
import { SingleInstanceNetworkBootstrapService, singleNetworkWorkspaceKey } from '../src/provisioning/single-instance-network-bootstrap';
import { CidrPoolService } from '../src/provisioning/cidr-pool.service';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';

const account = { provider: 'alibaba_cloud' as const, accountUid: 'test-account', accountUidResolved: true, cloudAccountContextId: 'test-context', imageImportBucket: '', accessKeyId: 'never-expose-ak', accessKeySecret: 'never-expose-sk', defaultRegion: 'cn-hangzhou', defaultZoneId: 'cn-hangzhou-h' };
const admin = { id: 'creator', role: 'admin' } as any;
const workspaceKey = singleNetworkWorkspaceKey(account.accountUid, account.defaultRegion, account.defaultZoneId);
const tags = { CloudAccountUid: account.accountUid, PlatformManaged: 'true' };
const stateResources = [
  { module: 'module.network', mode: 'managed', type: 'alicloud_vpc', name: 'default', instances: [{ attributes: { id: 'vpc-fixture', tags } }] },
  { module: 'module.network', mode: 'managed', type: 'alicloud_vswitch', name: 'default', instances: [0, 1, 2].map(index => ({ index_key: index, attributes: { id: `vsw-fixture-${index}`, tags } })) },
  { module: 'module.network', mode: 'managed', type: 'alicloud_security_group', name: 'default', instances: [{ attributes: { id: 'sg-fixture', tags } }] },
];
const addresses = ['module.network.alicloud_vpc.default', ...[0, 1, 2].map(index => `module.network.alicloud_vswitch.default[${index}]`), 'module.network.alicloud_security_group.default'];

describe('shared network durable apply intent', () => {
  let root: string;
  let dir: string;
  let repository: ReturnType<typeof createMemoryAdminRepository>;
  let bootstrap: SingleInstanceNetworkBootstrapService;
  let service: SingleInstanceNetworkService;
  let audit: jest.SpyInstance;
  let runner: any;
  let mode: 'success' | 'unknown' | 'complete_then_fail';
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'single-network-intent-'));
    dir = path.join(root, workspaceKey);
    repository = createMemoryAdminRepository();
    audit = jest.spyOn(repository, 'appendOperationAuditEvent');
    const cidr = new CidrPoolService();
    jest.spyOn(cidr, 'getPool').mockReturnValue(['10.80.0.0/16']);
    bootstrap = new SingleInstanceNetworkBootstrapService(cidr);
    (bootstrap as any).workspacesRootDir = root;
    (bootstrap as any).projectRootDir = '/app';
    mode = 'success';
    runner = {
      init: jest.fn().mockResolvedValue({}), plan: jest.fn().mockResolvedValue({}),
      showPlan: jest.fn().mockResolvedValue({ planned_values: { root_module: { resources: addresses.map(address => ({ mode: 'managed', address })) } }, resource_changes: addresses.map(address => ({ mode: 'managed', address, change: { actions: ['create'] } })) }),
      apply: jest.fn(async () => {
        const [pending] = await repository.listSingleInstanceNetworkProfiles();
        expect(pending).toMatchObject({ status: 'destroying', vpcId: '', cloudAccountUid: account.accountUid, cloudAccountContextId: account.cloudAccountContextId, workspaceKey, vpcCidr: '10.80.0.0/16' });
        expect(audit.mock.calls.some(([event]) => event.phase === 'dispatched' && event.targetId === pending.id)).toBe(true);
        if (mode === 'unknown') throw new Error('create response lost');
        await fs.writeFile(path.join(dir, 'terraform.tfstate'), JSON.stringify({ version: 4, serial: 1, lineage: 'fixture-network', resources: stateResources }));
        if (mode === 'complete_then_fail') throw new Error('command failed after complete state');
        return {};
      }),
      output: jest.fn().mockResolvedValue({ vpc_id: { value: 'vpc-fixture' }, vswitch_ids: { value: [0, 1, 2].map(index => `vsw-fixture-${index}`) }, security_group_id: { value: 'sg-fixture' } }),
      destroy: jest.fn(async () => {
        await fs.writeFile(path.join(dir, 'terraform.tfstate'), JSON.stringify({ version: 4, serial: 2, lineage: 'fixture-network', resources: [] }));
        return {};
      }),
    };
    (bootstrap as any).runner = runner;
    service = new SingleInstanceNetworkService(repository, {
      getExecutionAccountContext: async () => account, getAccountContext: async () => account, getAccountContextById: async () => account,
    } as any, bootstrap, cidr, { assertNetworkUnused: async () => undefined } as any);
  });
  afterEach(async () => { jest.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });

  it('persists the account-bound pending profile and audit before apply, then explicitly makes the same profile ready', async () => {
    const ready = await service.ensureDefaultProfile(account, admin.id);
    expect(ready.status).toBe('ready');
    expect(ready.vpcId).toBe('vpc-fixture');
    const phases = audit.mock.calls.map(([event]) => event.phase);
    expect(phases).toEqual(['dispatched', 'succeeded']);
    expect(new Set(audit.mock.calls.map(([event]) => event.operationId)).size).toBe(1);
    expect(audit.mock.calls.every(([event]) => event.actorUserId === admin.id && event.source === 'system' && event.targetId === ready.id)).toBe(true);
    expect(JSON.stringify(audit.mock.calls)).not.toMatch(/never-expose-(ak|sk)/);
  });

  it.each(['database', 'audit'])('does not start apply when %s intent persistence fails', async failure => {
    if (failure === 'database') jest.spyOn(repository, 'upsertSingleInstanceNetworkProfile').mockRejectedValueOnce(new Error('database unavailable'));
    else audit.mockRejectedValueOnce(new Error('audit unavailable'));
    await expect(service.ensureDefaultProfile(account, admin.id)).rejects.toThrow();
    expect(runner.apply).not.toHaveBeenCalled();
    expect(await repository.listSingleInstanceNetworkProfiles()).toEqual([]);
    await expect(fs.stat(dir)).rejects.toThrow();
    await expect(service.ensureDefaultProfile(account, admin.id)).resolves.toMatchObject({ status: 'ready' });
  });

  it('keeps intent evidence when both pre-apply persistence and cleanup verification lose database access', async () => {
    jest.spyOn(repository, 'upsertSingleInstanceNetworkProfile').mockRejectedValue(new Error('database unavailable'));
    const getProfile = repository.getSingleInstanceNetworkProfile.bind(repository);
    jest.spyOn(repository, 'getSingleInstanceNetworkProfile')
      .mockImplementationOnce(getProfile)
      .mockRejectedValue(new Error('database unavailable'));
    await expect(service.ensureDefaultProfile(account, admin.id)).rejects.toThrow('database unavailable');
    expect(runner.apply).not.toHaveBeenCalled();
    await expect(fs.stat(path.join(dir, '.range-apply-started'))).resolves.toBeDefined();
  });

  it('keeps blocking a second create after the entire workspace is lost', async () => {
    mode = 'unknown';
    await expect(service.ensureDefaultProfile(account, admin.id)).rejects.toThrow('cleanup is required');
    await fs.rm(dir, { recursive: true, force: true });
    await expect(service.ensureDefaultProfile(account, admin.id)).rejects.toThrow('cleanup is required');
    expect(runner.apply).toHaveBeenCalledTimes(1);
    expect((await repository.listSingleInstanceNetworkProfiles())[0]).toMatchObject({ status: 'destroying', cloudAccountUid: account.accountUid });
  });

  it('clears a verified failed bootstrap and can create again while retaining the old permanent resource audit', async () => {
    mode = 'complete_then_fail';
    await expect(service.ensureDefaultProfile(account, admin.id)).rejects.toThrow('command failed');
    expect(await repository.listSingleInstanceNetworkProfiles()).toEqual([]);
    await expect(fs.stat(dir)).rejects.toThrow();
    const cleaned = audit.mock.calls.find(([event]) => event.toolName === 'single_instance_network_bootstrap_cleanup' && event.phase === 'succeeded')![0];
    expect(cleaned.sanitizedInput).toMatchObject({ vpcId: 'vpc-fixture', securityGroupId: 'sg-fixture', cleanupVerified: true });
    mode = 'success';
    const next = await service.ensureDefaultProfile(account, admin.id);
    expect(next.status).toBe('ready');
    expect(next.id).not.toBe(cleaned.targetId);
    expect(audit.mock.calls.some(([event]) => event.targetId === cleaned.targetId && event.phase === 'succeeded')).toBe(true);
  });

  it('retains empty state and known cloud IDs if database deletion fails after verified compensation', async () => {
    mode = 'complete_then_fail';
    jest.spyOn(repository, 'deleteSingleInstanceNetworkProfile').mockRejectedValueOnce(new Error('database delete failed'));
    await expect(service.ensureDefaultProfile(account, admin.id)).rejects.toThrow('cleanup is required');
    const [pending] = await repository.listSingleInstanceNetworkProfiles();
    expect(pending).toMatchObject({ status: 'destroying', vpcId: 'vpc-fixture', securityGroupId: 'sg-fixture' });
    expect(JSON.parse(await fs.readFile(path.join(dir, 'terraform.tfstate'), 'utf8')).resources).toEqual([]);
    await service.registerCleanup(pending.id, 'fixture-recovery', new Date(Date.now() - 5000).toISOString(), [admin.id], admin);
    await service.destroy(pending.id, admin, 'fixture-recovery');
    expect(await repository.listSingleInstanceNetworkProfiles()).toEqual([]);
    await expect(fs.stat(dir)).rejects.toThrow();
    expect(audit.mock.calls.some(([event]) => event.toolName === 'single_instance_network_destroy' && event.phase === 'succeeded' && event.targetId === pending.id)).toBe(true);
  });

  it('logs resource IDs permanently on normal destroy before the profile and workspace disappear', async () => {
    const ready = await service.ensureDefaultProfile(account, admin.id);
    await service.registerCleanup(ready.id, 'fixture-cleanup', new Date(Date.now() - 5000).toISOString(), [admin.id], admin);
    await service.destroy(ready.id, admin, 'fixture-cleanup');
    expect(await repository.getSingleInstanceNetworkProfileById(ready.id)).toBeNull();
    await expect(fs.stat(dir)).rejects.toThrow();
    const events = audit.mock.calls.map(([event]) => event).filter(event => event.toolName === 'single_instance_network_destroy');
    expect(events.map(event => event.phase)).toEqual(['requested', 'succeeded']);
    expect(events[1].sanitizedInput).toMatchObject({ networkProfileId: ready.id, vpcId: 'vpc-fixture', workspaceKey, cleanupRunId: 'fixture-cleanup' });
  });
});
