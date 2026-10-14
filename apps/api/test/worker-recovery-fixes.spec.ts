import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProvisioningWorkerService } from '../src/provisioning/provisioning-worker.service';
import { OpenTofuRangeProvisioner } from '../src/provisioning/open-tofu-range-provisioner';
import { PrismaAdminRepository } from '../src/database/prisma-admin.repository';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';
import * as scheduling from '../src/provisioning/aliyun-zone-instance-scheduler';
import { APPLY_PENDING_FILE } from '../src/provisioning/opentofu-state-evidence';

const account = { provider: 'alibaba_cloud' as const, cloudAccountContextId: 'context-source', accountUid: 'uid-source',
  accountUidResolved: true, defaultRegion: 'cn-hangzhou', defaultZoneId: 'cn-hangzhou-h',
  accessKeyId: 'fixture-key', accessKeySecret: 'fixture-secret', imageImportBucket: '' };
const binding = { provider: account.provider, cloudAccountContextId: account.cloudAccountContextId,
  cloudAccountUid: account.accountUid, regionId: account.defaultRegion, zoneId: account.defaultZoneId };
const topology = { vpcCidr: '10.0.0.0/16', networkZones: [{ key: 'dmz', name: 'DMZ', purpose: 'entry', cidr: '10.0.1.0/24' }],
  hosts: [{ key: 'entry', name: 'Entry', zoneKey: 'dmz', role: 'entry', privateIp: '10.0.1.10' }],
  publicEntry: { hostKey: 'entry', protocols: [{ protocol: 'ssh', port: 22 }] } };

async function rangeFixture() {
  const repository = createMemoryAdminRepository();
  const template = await repository.createRangeTemplate({ name: 'Recovery fixture', slug: 'recovery-fixture', version: 'v1',
    modulePathOrRef: 'infra/opentofu/modules/alicloud-enterprise-range', topologySpec: topology });
  const instance = await repository.createRangeInstance({ name: 'Recovery', instanceMode: 'range', ownerUserId: 'alice',
    templateId: template.id, templateModulePathSnapshot: template.modulePathOrRef, status: 'pending_create', allocatedCidr: topology.vpcCidr,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
  const job = await repository.createProvisionJob({ rangeInstanceId: instance.id, jobType: 'create', triggeredBy: 'alice' });
  await repository.updateRangeInstance(instance.id, { lastJobId: job.id });
  const summary = { mode: 'opentofu' as const, hostIds: { entry: 'i-owned' }, systemDiskIds: { entry: 'd-owned' } };
  let cloudPresent = true;
  const provisioner = { mode: 'opentofu', create: jest.fn(), inspectResources: jest.fn(async () => summary),
    destroy: jest.fn(async (input: any) => { input.signal?.throwIfAborted(); cloudPresent = false; }) };
  const worker = new ProvisioningWorkerService(repository, provisioner as any,
    { getExecutionAccountContext: async () => ({ ...account }) } as any) as any;
  jest.spyOn(worker, 'performAliyunRpcRequest').mockImplementation(async (input: any) => {
    if (input.action === 'DescribeDisks' && input.parameters.InstanceId && cloudPresent) return {
      RequestId: 'disk-receipt', TotalCount: 1, PageNumber: 1, PageSize: 100,
      Disks: { Disk: [{ DiskId: 'd-owned', InstanceId: 'i-owned', Type: 'system', DeleteWithInstance: true }] } };
    const collection = input.action === 'DescribeInstances' ? 'Instances' : 'Disks';
    const item = input.action === 'DescribeInstances' ? 'Instance' : 'Disk';
    return { RequestId: 'absence-receipt', TotalCount: 0, PageNumber: 1, PageSize: 100, [collection]: { [item]: [] } };
  });
  return { repository, instance, job, worker, provisioner };
}

afterEach(() => { jest.restoreAllMocks(); delete process.env.PROVISIONING_WORKER_INTERRUPTED_JOB_STALE_AFTER_MS; });

it('compensates a settled apply after one failed heartbeat without reusing its cancelled signal', async () => {
  process.env.PROVISIONING_WORKER_INTERRUPTED_JOB_STALE_AFTER_MS = '30';
  const f = await rangeFixture();
  const heartbeat = jest.spyOn(f.repository, 'heartbeatRangeProvisionJob');
  f.provisioner.create.mockImplementationOnce(async input => {
    await input.onApplyStart();
    heartbeat.mockRejectedValueOnce(new Error('one lost database connection'));
    await new Promise<void>(resolve => input.signal.addEventListener('abort', () => resolve(), { once: true }));
    throw input.signal.reason;
  });
  await f.worker.process(f.job.id);
  expect(f.provisioner.destroy).toHaveBeenCalledTimes(1);
  expect(f.provisioner.destroy.mock.calls[0][0].signal).not.toBe(f.provisioner.create.mock.calls[0][0].signal);
  expect(await f.repository.getRangeInstanceById(f.instance.id)).toMatchObject({ status: 'create_failed',
    resourceSummary: { creationAttempted: false, executionContext: binding } });
  expect((await f.repository.listBillingLedgerResources()).every(row => row.releasedAt)).toBe(true);
});

it('never compensates an apply after another worker takes its claim', async () => {
  const f = await rangeFixture();
  f.provisioner.create.mockImplementationOnce(async input => {
    await input.onApplyStart();
    await f.repository.requeueInterruptedProvisionJobs(new Date(Date.now() + 300_000));
    await f.repository.claimRangeProvisionJob(f.job.id, new Date(Date.now() + 300_001));
    throw new Error('old apply exited');
  });
  await f.worker.process(f.job.id);
  expect(f.provisioner.destroy).not.toHaveBeenCalled();
  expect(f.provisioner.inspectResources).not.toHaveBeenCalled();
  expect(await f.repository.getProvisionJobById(f.job.id)).toMatchObject({ status: 'running', retryCount: 1 });
});

it.each(['running', 'pending', 'succeeded'] as const)('does not return a later %s claim from the update/read gap', async status => {
  const startedAt = new Date(1_000), later = new Date(301_000);
  const prisma = { provisionJob: { updateMany: jest.fn(async () => ({ count: 1 })),
    findUnique: jest.fn(async () => ({ id: 'job', status, startedAt: later })) } };
  expect(await new PrismaAdminRepository(prisma as any).claimProvisionJob('job', startedAt)).toBeNull();
});

describe('immutable Alibaba apply birth evidence', () => {
  function fixture() {
    const submittedAt = '2026-10-10T12:00:01Z';
    const source = { id: 'source', rangeInstanceId: 'range', cloudWorkspaceId: 'workspace', jobType: 'update',
      topologySnapshot: { operation: 'update' }, retryCount: 1, startedAt: new Date('2026-10-10T12:05:00Z') };
    const instance = { id: 'range', cloudWorkspaceId: 'workspace', cloudProvider: account.provider, ownerUserId: 'alice', resourceSummary: {
      mode: 'opentofu', vpcId: 'vpc-owned', executionContext: binding, hostIds: { entry: 'i-owned' },
      systemDiskIds: { entry: 'd-owned' }, diskInventoryHostIds: { entry: 'i-owned' },
      diskOwnershipProofs: { 'd-owned': { instanceId: 'i-owned', method: 'persisted' } } } };
    const log = { jobId: source.id, stepName: 'tofu_apply', startedAt: new Date('2026-10-10T12:00:00Z'), message: null };
    const repository = { getProvisionJobById: jest.fn(async () => source), listProvisionJobStepLogs: jest.fn(async () => [log]),
      listBillingLedgerResources: jest.fn(async () => ['ecs', 'disk'].map((type, index) => ({
        cloudResourceType: type, cloudResourceId: index ? 'd-owned' : 'i-owned', cloudProvider: account.provider,
        cloudAccountUid: account.accountUid, regionId: account.defaultRegion, ownerUserId: 'alice', rangeInstanceId: 'range' }))) };
    const worker = new ProvisioningWorkerService(repository as any, {} as any, {} as any, {} as any, {} as any, {} as any) as any;
    jest.spyOn(worker, 'ownsProvisionJobClaim').mockResolvedValue(true);
    const residual = jest.spyOn(worker, 'findResidualCloudResources').mockResolvedValue([]);
    jest.spyOn(worker, 'performAliyunRpcRequest').mockResolvedValue({ RequestId: 'receipt', TotalCount: 0,
      PageNumber: 1, PageSize: 50, EipAddresses: { EipAddress: [] } });
    return { worker, repository, source, instance, log, residual,
      intent: { sourceProvisionJobId: source.id, submittedAt, hostKeys: ['entry'], eipNames: [] } };
  }
  it('uses the original persisted apply after the original job is requeued and reclaimed', async () => {
    const f = fixture();
    await expect(f.worker.verifyAlibabaUnknownApplyAbsent(f.instance, {}, account, f.intent)).resolves.toBeUndefined();
    expect(f.residual).toHaveBeenCalledTimes(2);
  });
  it.each(['missing', 'foreign', 'dry-run', 'later', 'foreign-workspace', 'clock-skew'] as const)('refuses %s evidence', async scenario => {
    const f = fixture();
    if (scenario === 'missing') f.repository.listProvisionJobStepLogs.mockResolvedValue([]);
    if (scenario === 'foreign') f.log.jobId = 'another-job';
    if (scenario === 'dry-run') f.log.message = 'Dry-run apply' as any;
    if (scenario === 'later') f.log.startedAt = new Date('2026-10-10T12:06:00Z');
    if (scenario === 'foreign-workspace') f.source.cloudWorkspaceId = 'other';
    if (scenario === 'clock-skew') { f.source.startedAt = new Date('2026-10-10T11:00:00Z'); f.repository.listProvisionJobStepLogs.mockResolvedValue([]); }
    await expect(f.worker.verifyAlibabaUnknownApplyAbsent(f.instance, {}, account, f.intent)).rejects.toThrow('Alibaba unknown apply');
    expect(f.residual).not.toHaveBeenCalled();
  });
});

it('freezes the selected zone before the first apply and refuses changing it afterwards', async () => {
  const f = await rangeFixture();
  const claimed = await f.repository.claimRangeProvisionJob(f.job.id, new Date());
  const current = await f.repository.getRangeInstanceById(f.instance.id);
  const context = await f.worker.resolveRangeAccountContext(current, claimed);
  await f.worker.freezeRangeExecutionZone(claimed, context, 'cn-hangzhou-i');
  expect(context.defaultZoneId).toBe('cn-hangzhou-i');
  expect((await f.repository.getRangeInstanceById(f.instance.id))?.resourceSummary?.executionContext)
    .toEqual({ ...binding, zoneId: 'cn-hangzhou-i' });
  await f.worker.recordRangeApplyStart(current, claimed, context);
  await expect(f.worker.freezeRangeExecutionZone(claimed, context, account.defaultZoneId)).rejects.toThrow('cannot change');
  await expect(f.worker.freezeRangeExecutionZone(claimed, context, 'cn-beijing-a')).rejects.toThrow('original region');
  expect((await f.worker.resolveRangeAccountContext(await f.repository.getRangeInstanceById(f.instance.id), claimed)).defaultZoneId)
    .toBe('cn-hangzhou-i');
});

it('publishes the actual fallback zone before writing the executable workspace', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'range-zone-recovery-'));
  try {
    jest.spyOn(scheduling, 'selectZoneAndHostInstanceTypes').mockResolvedValue({ selectedZoneId: 'cn-hangzhou-i',
      attemptedZones: [], hostInstanceTypes: { entry: 'ecs.e-c1m1.large' } } as any);
    const provisioner = new OpenTofuRangeProvisioner({ projectRootDir: '/app', workspacesRootDir: root,
      enableZoneScheduling: true, env: {}, availableImageIdResolver: async () => 'm-fixture' }) as any;
    jest.spyOn(provisioner, 'buildRunnerEnv').mockResolvedValue({});
    const onExecutionZoneSelected = jest.fn(async zone => {
      expect(zone).toBe('cn-hangzhou-i');
      await expect(fs.stat(path.join(root, 'range-zone', 'range.auto.tfvars.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    });
    const prepared = await provisioner.prepareWorkspace({ rangeInstanceId: 'range-zone', allocatedCidr: topology.vpcCidr,
      templateModulePath: 'infra/opentofu/modules/alicloud-enterprise-range', topologySpec: topology,
      runtimeConfig: account, runtimeCredentials: { entry: { username: 'root', password: 'Fixture123!' } }, onExecutionZoneSelected },
    { preserveWorkspaceState: false, requireRuntimePasswords: true });
    expect(onExecutionZoneSelected).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await fs.readFile(prepared.varsFilePath, 'utf8')).zone_id).toBe('cn-hangzhou-i');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

describe('historical fallback zone recovery from original native state', () => {
  let root: string;
  afterEach(async () => { if (root) await fs.rm(root, { recursive: true, force: true }); });
  async function fixture() {
    const f = await rangeFixture();
    await f.repository.updateProvisionJob(f.job.id, { status: 'failed', startedAt: new Date('2026-10-10T12:05:00Z'), retryCount: 1 });
    await f.repository.createProvisionJobStepLog({ jobId: f.job.id, stepName: 'tofu_apply', status: 'failed',
      startedAt: new Date('2026-10-10T12:00:00Z') });
    await f.repository.updateRangeInstance(f.instance.id, { status: 'destroy_failed', resourceSummary: {
      mode: 'opentofu', executionContext: binding, creationAttempted: true, vpcId: 'vpc-owned',
      hostIds: { entry: 'i-owned' }, systemDiskIds: { entry: 'd-owned' } } });
    const destroy = await f.repository.createProvisionJob({ rangeInstanceId: f.instance.id, jobType: 'destroy', triggeredBy: 'alice' });
    await f.repository.updateRangeInstance(f.instance.id, { status: 'pending_destroy', lastJobId: destroy.id });
    const claimed = await f.repository.claimRangeProvisionJob(destroy.id, new Date());
    if (!claimed) throw new Error('Fixture destroy claim was not acquired');
    const instance = (await f.repository.getRangeInstanceById(f.instance.id))!;
    const context = await f.worker.resolveRangeAccountContext(instance, claimed);
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'historical-range-zone-'));
    const dir = path.join(root, instance.id); await fs.mkdir(dir);
    const tags = { CloudProvider: account.provider, CloudAccountUid: account.accountUid, CloudAccountContextId: account.cloudAccountContextId,
      CreatedBy: 'cyber-range-platform', PlatformManaged: 'true', PlatformScope: 'user', PlatformUserId: 'alice',
      RangeInstanceId: instance.id, range_instance_id: instance.id, PlatformCreateJobId: f.job.id };
    const state = { version: 4, lineage: 'original-zone-lineage', serial: 7, resources: [
      { mode: 'managed', module: 'module.range', type: 'alicloud_vpc', name: 'main', instances: [{ attributes: { id: 'vpc-owned', tags } }] },
      { mode: 'managed', module: 'module.range', type: 'alicloud_instance', name: 'hosts', instances: [{ index_key: 'entry',
        attributes: { id: 'i-owned', system_disk_id: 'd-owned', availability_zone: 'cn-hangzhou-i', tags } }] },
    ] };
    await fs.writeFile(path.join(dir, 'terraform.tfstate'), JSON.stringify(state));
    const pending = { version: 1, addresses: ['module.range.alicloud_vpc.main', 'module.range.alicloud_instance.hosts["entry"]', 'module.range.alicloud_forward_entry.entries["missing"]'],
      createAddresses: [], priorLineage: state.lineage, priorSerial: 5, priorIds: {}, submittedAt: '2026-10-10T12:00:01Z', sourceProvisionJobId: f.job.id };
    await fs.writeFile(path.join(dir, APPLY_PENDING_FILE), JSON.stringify(pending));
    await fs.writeFile(path.join(dir, 'range.auto.tfvars.json'), JSON.stringify({ resource_name_prefix: `range-${instance.id.slice(0, 9)}`,
      zone_id: 'cn-hangzhou-i', hosts: [{ key: 'entry' }], eips: [], tags }));
    for (const name of ['main.tf', 'variables.tf', 'outputs.tf', 'versions.tf']) await fs.writeFile(path.join(dir, name), '');
    const runner = { init: jest.fn().mockResolvedValue({}), destroy: jest.fn(async () => {
      await fs.writeFile(path.join(dir, 'terraform.tfstate'), JSON.stringify({ ...state, serial: 8, resources: [] }));
      return {};
    }) };
    const provisioner = new OpenTofuRangeProvisioner({ workspacesRootDir: root, env: {}, runner: runner as any }) as any;
    jest.spyOn(provisioner, 'buildRunnerEnv').mockResolvedValue({});
    f.worker.rangeProvisioner = provisioner;
    jest.spyOn(f.worker, 'findResidualCloudResources').mockResolvedValue([]);
    const rpc = f.worker.performAliyunRpcRequest.getMockImplementation();
    f.worker.performAliyunRpcRequest.mockImplementation(async (input: any) => input.action === 'DescribeEipAddresses'
      ? { RequestId: 'eip-absence', TotalCount: 0, PageNumber: 1, PageSize: 50, EipAddresses: { EipAddress: [] } }
      : rpc(input));
    return { ...f, instance, context, claimed, dir, state, pending, runner };
  }
  it('recovers the actual zone and completes cleanup of an interrupted/reclaimed generation', async () => {
    const f = await fixture();
    await f.worker.processRangeDestroyJob(f.claimed, f.instance, f.context, f.worker.createStepReporter(f.claimed.id));
    expect(f.runner.destroy).toHaveBeenCalledTimes(1);
    expect(await f.repository.getRangeInstanceById(f.instance.id)).toMatchObject({ status: 'destroyed',
      resourceSummary: { executionContext: { ...binding, zoneId: 'cn-hangzhou-i' } } });
    expect(await f.repository.getProvisionJobById(f.claimed.id)).toMatchObject({ status: 'succeeded' });
    await expect(fs.stat(path.join(f.dir, APPLY_PENDING_FILE))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it.each(['foreign-context', 'foreign-region', 'wrong-zone', 'wrong-generation', 'wrong-source'] as const)
    ('refuses %s state before changing the frozen zone or deleting resources', async scenario => {
      const f = await fixture();
      if (scenario === 'foreign-context') f.state.resources[1].instances[0].attributes.tags.CloudAccountContextId = 'other';
      if (scenario === 'wrong-zone') (f.state.resources[1].instances[0].attributes as any).availability_zone = 'cn-hangzhou-j';
      if (scenario === 'wrong-generation') f.pending.priorLineage = 'other-lineage';
      if (scenario === 'wrong-source') f.pending.sourceProvisionJobId = 'other-job';
      if (scenario === 'foreign-region') {
        const varsFile = path.join(f.dir, 'range.auto.tfvars.json');
        const variables = JSON.parse(await fs.readFile(varsFile, 'utf8')); variables.zone_id = 'cn-beijing-a';
        await fs.writeFile(varsFile, JSON.stringify(variables));
      }
      await fs.writeFile(path.join(f.dir, 'terraform.tfstate'), JSON.stringify(f.state));
      await fs.writeFile(path.join(f.dir, APPLY_PENDING_FILE), JSON.stringify(f.pending));
      await expect(f.worker.processRangeDestroyJob(f.claimed, f.instance, f.context, f.worker.createStepReporter(f.claimed.id))).rejects.toThrow();
      expect(f.runner.destroy).not.toHaveBeenCalled();
      expect((await f.repository.getRangeInstanceById(f.instance.id))?.resourceSummary?.executionContext).toEqual(binding);
    });
});
