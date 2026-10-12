import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AdminRepository, ProvisionJobRecord, ProvisionJobStepLogRecord, RangeInstanceRecord } from '../src/admin/admin.repository';
import { SingleInstanceBatchExecutionService } from '../src/admin/single-instance-batch-execution.service';
import { SingleInstanceOpenTofuExecutionService, SingleInstanceOpenTofuLeaseLostError } from '../src/admin/single-instance-opentofu-execution.service';
import * as tencentRpc from '../src/admin/tencent-cloud-client';
import { SystemConfigService } from '../src/admin/system-config.service';
import * as deadlines from '../src/provisioning/cloud-release-deadlines';

describe('single-instance OpenTofu batch execution', () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'single-tofu-test-'));
    jest.spyOn(deadlines, 'verifyCloudReleaseDeadlines').mockImplementation(async input => Object.fromEntries(
      Object.entries(input.deadlines).map(([key, record]) => [key, { ...record, status: 'unverified' as const, reason: 'native_timer_check_failed' }])));
  });
  afterEach(async () => { jest.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });

  function fixture(count = 2, tencent = false) {
    const instances: RangeInstanceRecord[] = [];
    const jobs = new Map<string, ProvisionJobRecord>();
    const stepLogs: ProvisionJobStepLogRecord[] = [];
    const ledger: any[] = [];
    const account = { provider: 'alibaba_cloud', accountUid: 'uid-a', cloudAccountContextId: 'ctx-a', accountUidResolved: true,
      defaultRegion: 'cn-hangzhou', defaultZoneId: 'cn-hangzhou-h', accessKeyId: 'test-access-key', accessKeySecret: 'test-secret-key' };
    for (let index = 1; index <= count; index++) {
      const job = { id: `job-${index}`, rangeInstanceId: `member-${index}`, jobType: 'create', status: 'running', startedAt: new Date(), createdAt: new Date() } as ProvisionJobRecord;
      jobs.set(job.id, job);
      instances.push({ id: job.rangeInstanceId, name: `instance-${index}`, ownerUserId: 'alice', instanceMode: 'single', status: 'creating', cloudProvider: 'alibaba_cloud',
        singleInstanceBatchId: 'batch-a', lastJobId: job.id, createdAt: new Date(), expiresAt: new Date(Date.now()+3600_000), resourceSummary: null,
        runtimeTopologyGraph: { nodes: [{ id: `host-${index}`, data: { privateIp: 'static-placeholder' } }] },
        runtimeCredentials: { [`host-${index}`]: { username: 'root', password: `test-Passw0rd-${index}!` } },
        singleInstanceConfig: { executionBackend: 'opentofu', cloudAccountContextId: 'ctx-a', cloudAccountUid: 'uid-a', regionId: 'cn-hangzhou', zoneId: 'cn-hangzhou-h',
          networkProfileId: 'profile-a', assignedVswitchId: 'vsw-a', hostKey: `host-${index}`, hostName: `instance-${index}`, resolvedInstanceType: 'ecs.e-c1m1.large',
          imageId: 'm-test', systemDiskSize: 40, autoReleaseTime: null } } as unknown as RangeInstanceRecord);
    }
    const repository = {
      getSingleInstanceBatchWithInstancesById: jest.fn(async () => ({ batch: { id: 'batch-a', ownerUserId: 'alice' }, instances })),
      getSingleInstanceNetworkProfileById: jest.fn(async () => ({ id: 'profile-a', provider: 'alibaba_cloud', status: 'ready', cloudAccountUid: 'uid-a', cloudAccountContextId: 'ctx-a', regionId: 'cn-hangzhou', zoneId: 'cn-hangzhou-h', securityGroupId: 'sg-a', vswitchIds: ['vsw-a'] })),
      getRangeInstanceById: jest.fn(async (id: string) => instances.find(instance => instance.id === id) ?? null),
      getProvisionJobById: jest.fn(async (id: string) => jobs.get(id) ?? null),
      listProvisionJobStepLogs: jest.fn(async (jobId: string) => stepLogs.filter(log => log.jobId === jobId)),
      createProvisionJobStepLog: jest.fn(async (input: Omit<ProvisionJobStepLogRecord, 'id' | 'createdAt' | 'updatedAt'>) => {
        const now = new Date(), log = { id: `step-${stepLogs.length + 1}`, createdAt: now, updatedAt: now, ...input };
        stepLogs.push(log); return log;
      }),
      heartbeatProvisionJob: jest.fn(async (id: string) => jobs.get(id)?.status === 'running'),
      commitSingleInstanceClaim: jest.fn(async (job: ProvisionJobRecord, patch: object, jobPatch?: object) => {
        const instance = instances.find(value => value.id === job.rangeInstanceId)!;
        if (instance.lastJobId !== job.id || jobs.get(job.id)?.status !== 'running') return false;
        Object.assign(instance, patch); if (jobPatch) Object.assign(jobs.get(job.id)!, jobPatch); return true;
      }),
      listBillingLedgerResources: jest.fn(async () => ledger),
      findBillingLedgerResource: jest.fn(async (query: any) => ledger.find(value => value.cloudResourceId === query.cloudResourceId && value.cloudResourceType === query.cloudResourceType) ?? null),
      createBillingLedgerResource: jest.fn(async (input: any) => { const row = { id: `ledger-${ledger.length}`, releasedAt: null, ...input }; ledger.push(row); return row; }),
      updateBillingLedgerResource: jest.fn(async (id: string, patch: object) => { const row = ledger.find(value => value.id === id); Object.assign(row, patch); return row; }),
      repairBillingLedgerOrigin: jest.fn(async ({ expected, sourceProvisionJobId }: any) => {
        const row = ledger.find(value => value.id === expected.id && value.sourceProvisionJobId === null);
        if (!row) return false;
        row.sourceProvisionJobId = sourceProvisionJobId; return true;
      }),
    };
    if (tencent) {
      jest.spyOn(tencentRpc,'requestTencentCloud').mockResolvedValue({ RequestId: 'fixture-image-request', TotalCount: 1, ImageSet: [{ ImageId: 'img-fixture', ImageState: 'NORMAL', ImageType: 'PRIVATE_IMAGE', Architecture: 'x86_64', ImageSize: 20, SnapshotSet: [] }] } as any);
      Object.assign(account, { provider: 'tencent_cloud', accountUid: '100000000001', defaultRegion: 'ap-shanghai', defaultZoneId: 'ap-shanghai-2' });
      repository.getSingleInstanceNetworkProfileById.mockImplementation(async () => ({ id: 'profile-a', provider: 'tencent_cloud', status: 'ready', cloudAccountUid: account.accountUid, cloudAccountContextId: account.cloudAccountContextId, regionId: account.defaultRegion, zoneId: account.defaultZoneId, securityGroupId: 'sg-fixture', vswitchIds: ['subnet-fixture'], vpcId: 'vpc-fixture' }) as any);
      for (const instance of instances) {
        instance.cloudProvider = 'tencent_cloud'; instance.expiresAt = new Date(Date.now()+3600_000);
        Object.assign(instance.singleInstanceConfig!, { cloudAccountUid: account.accountUid, regionId: account.defaultRegion, zoneId: account.defaultZoneId, resolvedInstanceType: 'S5.MEDIUM4', imageId: 'img-fixture', assignedVswitchId: 'subnet-fixture', autoReleaseTime: instance.expiresAt.toISOString().replace(/\.\d{3}Z$/, 'Z') });
      }
    }
    const cloud = new Map<string, any>();
    const native = {
      resolveInstanceAccount: jest.fn(async () => account),
      captureInstanceDisks: jest.fn(async (_item: unknown, _account: unknown, summary: any) => summary),
      assertInstanceDisksAbsent: jest.fn(async () => {}),
      readOpenTofuInstances: jest.fn(async (_account: unknown, ids: string[]) => ids.flatMap(id => cloud.has(id) ? [cloud.get(id)] : [])),
      readOpenTofuInstancesByTag: jest.fn(async (instance: RangeInstanceRecord) => [...cloud.values()].filter(value => value.tags.RangeInstanceId === instance.id)),
      deleteOwnedUntrackedOpenTofuInstances: jest.fn(async (_item: unknown, ids: string[], assertLease: () => Promise<void>) => { await assertLease(); ids.forEach(id => cloud.delete(id)); }),
      executeDestroyBatch: jest.fn(),
      executeCreateBatch: jest.fn(() => { throw new Error('native cloud creation must never be used'); }),
    };
    const controller = new AbortController();
    const lease = { batchId: 'batch-a', signal: controller.signal, assertCurrent: jest.fn(async () => {}) };
    let workspace = '';
    let lastPlan: any;
    let onApply: ((options: any) => Promise<void>) | undefined;
    let customPlan: (() => any) | undefined;
    let applyCalls = 0;
    const stateMembers = new Map<string, any>();
    async function saveState() {
      await fs.writeFile(path.join(workspace, 'terraform.tfstate'), JSON.stringify({ version: 4, lineage: 'test-lineage', serial: applyCalls,
        resources: stateMembers.size ? [{ module: 'module.single_batch', mode: 'managed', type: tencent ? 'tencentcloud_instance' : 'alicloud_instance', name: 'members', instances: [...stateMembers].map(([index_key, value]) => ({ index_key, ...value })) }] : [] }));
    }
    async function createMember(id: string, options: { tainted?: boolean; status?: string; disk?: boolean; nativeId?: string; diskId?: string } = {}) {
      const input = JSON.parse(await fs.readFile(path.join(workspace, 'terraform.tfvars.json'), 'utf8'));
      const definition = input.members[id];
      const cloudId = options.nativeId ?? (tencent ? `ins-${id.replace(/-/g,'')}` : `i-${id}`);
      stateMembers.set(id, { ...(options.tainted ? { status: 'tainted' } : {}), attributes: { id: cloudId, ...(tencent ? { client_token: definition.client_token, action_timer_terminate_at: definition.action_timer_terminate_at, instance_status: (options.status ?? 'Running').toUpperCase() } : { status: options.status ?? 'Running' }), system_disk_id: options.disk === false ? '' : options.diskId ?? (tencent ? `disk-${id.replace(/-/g,'')}` : `d-${id}`), tags: definition.tags,
        private_ip: '172.16.1.20', public_ip: '203.0.113.1' } });
      cloud.set(cloudId, { instanceId: cloudId, privateIp: '172.16.1.20', publicIp: '203.0.113.1', status: options.status ?? 'Running', tags: definition.tags });
      await saveState();
    }
    const runner = {
      init: jest.fn(async (options: any) => { workspace = options.workspaceDir; return result(); }),
      plan: jest.fn(async (options: any) => { lastPlan = options; return result(); }),
      showPlan: jest.fn(async () => customPlan ? customPlan() : { format_version: '1.2', resource_changes: lastPlan.targets.map((address: string) => ({ address, type: tencent ? 'tencentcloud_instance' : 'alicloud_instance', change: { actions: [lastPlan.destroy ? 'delete' : 'create'] } })) }),
      apply: jest.fn(async (options: any) => {
        applyCalls++;
        if (onApply) await onApply(options);
        else for (const address of lastPlan.targets) {
          const id = JSON.parse(address.slice(address.indexOf('[') + 1, -1));
          if (lastPlan.destroy) { cloud.delete(stateMembers.get(id)?.attributes.id); stateMembers.delete(id); await saveState(); }
          else await createMember(id);
        }
        return result();
      }),
      output: jest.fn(),
    };
    const service = new SingleInstanceOpenTofuExecutionService(repository as unknown as AdminRepository, {} as SystemConfigService, native as unknown as SingleInstanceBatchExecutionService,
      { projectRootDir: '/app', workspacesRootDir: root, env: { TENCENTCLOUD_PROVIDER_ZIP_PATH: '', TENCENTCLOUD_PROVIDER_UNPACKED_MIRROR_ROOT: '', RANGE_PROVISIONER_MODE: 'opentofu', ALICLOUD_PROVIDER_ZIP_PATH: '', OPENTOFU_PROVIDER_UNPACKED_MIRROR_ROOT: '' }, runner });
    const items = instances.map(instance => ({ instance, job: jobs.get(instance.lastJobId!)! }));
    function queueDestroy(index: number) {
      const instance = instances[index];
      const job = { id: `destroy-${index}`, rangeInstanceId: instance.id, jobType: 'destroy', status: 'running', startedAt: new Date(), createdAt: new Date() } as ProvisionJobRecord;
      jobs.set(job.id, job); instance.lastJobId = job.id; instance.status = 'destroying'; return { instance, job };
    }
    return { service, repository, native, runner, lease, controller, instances, items, jobs, stepLogs, ledger, cloud, stateMembers, account, createMember, saveState, queueDestroy,
      get workspace() { return workspace; }, set onApply(value: ((options: any) => Promise<void>) | undefined) { onApply = value; }, set customPlan(value: (() => any) | undefined) { customPlan = value; }, get lastPlan() { return lastPlan; } };
  }

  function progressEvent(id: string) {
    return { address: `module.single_batch.alicloud_instance.members[${JSON.stringify(id)}]`, resourceType: 'alicloud_instance', action: 'create', resourceId: `i-${id}` };
  }
  async function waitFor(check: () => boolean) {
    for (let attempt = 0; attempt < 100; attempt++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
    throw new Error('progress did not become observable');
  }

  it('creates and destroys a Tencent member with persistent token, atomic cloud termination and frozen provider workspace', async () => {
    const test = fixture(1,true);
    await test.service.executeCreateBatch(test.items,test.lease);
    expect(test.jobs.get('job-1')?.status).toBe('succeeded');
    const vars = JSON.parse(await fs.readFile(path.join(test.workspace,'terraform.tfvars.json'),'utf8'));
    expect(vars).toMatchObject({ region: 'ap-shanghai', zone_id: 'ap-shanghai-2', vpc_id: 'vpc-fixture' });
    expect(vars.members['member-1'].client_token).toMatch(/^[0-9a-f]{32}$/);
    expect(vars.members['member-1'].tags).toMatchObject({ PlatformCreateJobId: 'job-1', CreationIntentId: vars.members['member-1'].client_token, PlatformScope: 'user', CloudProvider: 'tencent_cloud' });
    expect(vars.members['member-1'].action_timer_terminate_at).toBe(test.instances[0].singleInstanceConfig!.autoReleaseTime);
    expect(test.instances[0].resourceSummary).toMatchObject({ modulePath: 'infra/opentofu/modules/tencentcloud-single-instance-batch', executionContext: { provider: 'tencent_cloud', cloudAccountUid: '100000000001', regionId: 'ap-shanghai', zoneId: 'ap-shanghai-2' } });
    const inventory = test.stepLogs.find(log => log.jobId === 'job-1' && log.stepName === 'platform_billing_creation_inventory');
    expect(inventory?.status).toBe('succeeded');
    expect(JSON.parse(inventory!.message!)).toMatchObject({ cloudProvider: 'tencent_cloud', rangeInstanceId: 'member-1', sourceJobId: 'job-1', ownerUserId: 'alice',
      executionContext: { provider: 'tencent_cloud', cloudAccountContextId: 'ctx-a', cloudAccountUid: '100000000001', regionId: 'ap-shanghai', zoneId: 'ap-shanghai-2' },
      resources: expect.arrayContaining([{ cloudResourceId: 'ins-member1', cloudResourceType: 'ecs' }]) });
    expect(test.runner.init.mock.calls[0][0].env).toMatchObject({ TENCENTCLOUD_SECRET_ID: 'test-access-key', TENCENTCLOUD_REGION: 'ap-shanghai' });
    expect(test.runner.init.mock.calls[0][0].env).not.toHaveProperty('ALICLOUD_ACCESS_KEY');
    await test.service.executeDestroyBatch([test.queueDestroy(0)],test.lease);
    expect(test.instances[0].status).toBe('destroyed');
    expect(test.stepLogs).toContainEqual(inventory);
    expect(test.native.executeCreateBatch).not.toHaveBeenCalled();
  });

  it('completes Tencent creation from detached database snapshots and retains released creation inventory after destruction', async () => {
    const test = fixture(2, true);
    const detached = test.items.map(item => ({ ...item, instance: structuredClone(item.instance) }));
    expect(detached[0].instance.singleInstanceConfig!.opentofuCreateJobId).toBeUndefined();
    await test.service.executeCreateBatch(detached, test.lease);
    expect(test.jobs.get('job-1')?.status).toBe('succeeded');
    expect(test.jobs.get('job-2')?.status).toBe('succeeded');
    expect(test.instances.every(instance => instance.status === 'running')).toBe(true);
    expect(detached[0].instance.singleInstanceConfig!.opentofuCreateJobId).toBe('job-1');
    expect(test.stateMembers.get('member-1').attributes).toMatchObject({ instance_status: 'RUNNING', system_disk_id: 'disk-member1' });
    const inventory = test.stepLogs.filter(log => log.stepName === 'platform_billing_creation_inventory');
    expect(inventory).toHaveLength(2);
    const ledgerIds = test.ledger.map(row => row.id);
    expect(test.ledger).toHaveLength(4);
    const destroying = [test.queueDestroy(0), test.queueDestroy(1)].map(item => ({ ...item, instance: structuredClone(item.instance) }));
    await test.service.executeDestroyBatch(destroying, test.lease);
    expect(test.instances.every(instance => instance.status === 'destroyed' && instance.resourceSummary === null)).toBe(true);
    expect(test.cloud.size).toBe(0);
    expect(test.ledger.map(row => row.id)).toEqual(ledgerIds);
    expect(test.ledger.every(row => row.releasedAt)).toBe(true);
    expect(test.stepLogs).toEqual(expect.arrayContaining(inventory));
    expect(test.native.executeCreateBatch).not.toHaveBeenCalled();
  });

  it('retains exact Alibaba disk-to-host creation inventory after destruction clears active state', async () => {
    const test = fixture(2);
    const detached = test.items.map(item => ({ ...item, instance: structuredClone(item.instance) }));
    await test.service.executeCreateBatch(detached, test.lease);
    expect(test.jobs.get('job-1')).toMatchObject({ status: 'succeeded', errorSummary: null });
    expect(test.instances[0].resourceSummary?.executionContext).toEqual({ provider: 'alibaba_cloud', cloudAccountContextId: 'ctx-a', cloudAccountUid: 'uid-a', regionId: 'cn-hangzhou', zoneId: 'cn-hangzhou-h' });
    expect(test.ledger).toEqual(expect.arrayContaining([expect.objectContaining({ cloudAccountUid: 'uid-a', sourceProvisionJobId: 'job-1' })]));
    const inventory = test.stepLogs.filter(log => log.stepName === 'range_resource_inventory');
    expect(inventory).toHaveLength(2);
    for (const [index, log] of inventory.entries()) {
      const member = `member-${index + 1}`, host = `host-${index + 1}`;
      expect(JSON.parse(log.message!)).toEqual({ version: 1, cloudProvider: 'alibaba_cloud', cloudWorkspaceId: 'legacy-unbound',
        rangeInstanceId: member, sourceJobId: `job-${index + 1}`, ownerUserId: 'alice', singleInstanceBatchId: 'batch-a',
        executionContext: { provider: 'alibaba_cloud', cloudAccountContextId: 'ctx-a', cloudAccountUid: 'uid-a', regionId: 'cn-hangzhou', zoneId: 'cn-hangzhou-h' },
        resources: { hostIds: { [host]: `i-${member}` }, systemDiskIds: { [host]: `d-${member}` }, dataDiskIds: {}, diskOwnershipProofs: {} } });
      expect(log.stdoutExcerpt).toBeNull(); expect(log.stderrExcerpt).toBeNull();
      expect(log.message).not.toContain('test-Passw0rd'); expect(log.message).not.toContain('test-secret-key');
    }
    await test.service.executeDestroyBatch([test.queueDestroy(0), test.queueDestroy(1)], test.lease);
    expect(test.instances.every(instance => instance.status === 'destroyed' && instance.resourceSummary === null)).toBe(true);
    expect(test.stepLogs.filter(log => log.stepName === 'range_resource_inventory')).toEqual(inventory);
    expect(test.ledger.every(row => row.releasedAt)).toBe(true);
  });

  it('backfills legacy null ledger sources from a failed birth job when retry reuses the existing OpenTofu member', async () => {
    const test = fixture(1);
    await test.service.executeCreateBatch(test.items, test.lease);
    test.jobs.get('job-1')!.status = 'failed';
    test.ledger.forEach(row => { row.sourceProvisionJobId = null; });
    const retry = test.queueDestroy(0); retry.job.jobType = 'retry'; retry.instance.status = 'creating';
    test.customPlan = () => ({ format_version: '1.2', resource_changes: [{ address: 'module.single_batch.alicloud_instance.members["member-1"]',
      type: 'alicloud_instance', change: { actions: ['no-op'] } }] });
    test.onApply = async () => {};
    const originalId = test.instances[0].resourceSummary!.hostIds!['host-1'];
    await test.service.executeCreateBatch([retry], test.lease);
    expect(retry.job.status).toBe('succeeded');
    expect(test.instances[0].resourceSummary!.hostIds!['host-1']).toBe(originalId);
    expect(test.cloud.size).toBe(1);
    expect(test.cloud.get(originalId).tags.PlatformCreateJobId).toBe('job-1');
    expect(test.ledger).toHaveLength(2);
    expect(test.ledger.every(row => row.sourceProvisionJobId === 'job-1')).toBe(true);
    expect(test.jobs.get('job-1')!.status).toBe('failed');
  });

  it('never repeats a Tencent apply when its accepted creation outcome is unknown', async () => {
    const test = fixture(1,true);
    test.onApply = async () => { throw new Error('response lost'); };
    await test.service.executeCreateBatch(test.items,test.lease);
    expect(test.instances[0].status).toBe('destroy_failed');
    const first = await fs.readFile(path.join(test.workspace,'.single-batch-apply-started'),'utf8');
    test.instances[0].status = 'creating'; test.jobs.get('job-1')!.status = 'running';
    await test.service.executeCreateBatch(test.items,test.lease);
    expect(test.runner.apply).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(path.join(test.workspace,'.single-batch-apply-started'),'utf8')).toBe(first);
    expect(test.ledger).toHaveLength(0);
  });

  it.each([true,false])('recovers an untracked Tencent system disk only with CBS attachment and creation-window proof (%s)', async diskOwned => {
    const test = fixture(1,true);
    jest.spyOn(tencentRpc,'requestTencentCloud').mockImplementation(async input => input.action === 'DescribeImages' ? { RequestId: 'fixture-image-request', TotalCount: 1, ImageSet: [{ ImageId: 'img-fixture', ImageState: 'NORMAL', ImageType: 'PRIVATE_IMAGE', Architecture: 'x86_64', ImageSize: 20, SnapshotSet: [] }] } as any : { RequestId: 'fixture-disk-request', TotalCount: 1, DiskSet: [{ DiskId: 'disk-fixture', InstanceId: diskOwned ? 'ins-member1' : 'ins-foreign', DiskUsage: 'SYSTEM_DISK', Shareable: false, DiskChargeType: 'POSTPAID_BY_HOUR', DeleteWithInstance: true, CreateTime: new Date().toISOString() }] } as any);
    test.onApply = async options => {
      await test.createMember('member-1');
      options.onResourceApplied?.({ address: 'module.single_batch.tencentcloud_instance.members["member-1"]', resourceType: 'tencentcloud_instance', action: 'create', resourceId: 'ins-member1' });
      test.cloud.get('ins-member1').systemDiskId = 'disk-fixture';
      await fs.rm(path.join(test.workspace,'terraform.tfstate'));
      throw new Error('response accepted but state lost');
    };
    await test.service.executeCreateBatch(test.items,test.lease);
    expect(test.runner.apply).toHaveBeenCalledTimes(1);
    if (diskOwned) {
      expect(test.native.deleteOwnedUntrackedOpenTofuInstances).toHaveBeenCalledTimes(1);
      expect(test.instances[0].status).toBe('create_failed');
      expect(test.ledger.some(row => row.cloudResourceId === 'disk-fixture' && row.releasedAt)).toBe(true);
    } else {
      expect(test.native.deleteOwnedUntrackedOpenTofuInstances).not.toHaveBeenCalled();
      expect(test.instances[0].status).toBe('destroy_failed');
      await expect(fs.stat(path.join(test.workspace,'.single-batch-apply-started'))).resolves.toBeDefined();
    }
  });

  it('rejects a frozen Tencent disk smaller than fresh official image size before applying', async () => {
    const test = fixture(1,true);
    jest.spyOn(tencentRpc,'requestTencentCloud').mockResolvedValue({ RequestId: 'fixture-image-size', TotalCount: 1, ImageSet: [{ ImageId: 'img-fixture', ImageState: 'NORMAL', ImageType: 'PUBLIC_IMAGE', Architecture: 'x86_64', ImageSize: 50, SnapshotSet: [] }] } as any);
    await test.service.executeCreateBatch(test.items,test.lease);
    expect(test.runner.apply).not.toHaveBeenCalled();
    expect(test.instances[0].status).toBe('create_failed');
    expect(test.native.executeCreateBatch).not.toHaveBeenCalled();
  });

  it('rejects expired Tencent cloud termination and foreign provider state before applying', async () => {
    const test = fixture(1,true);
    test.instances[0].singleInstanceConfig!.autoReleaseTime = new Date(Date.now()+60_000).toISOString();
    test.instances[0].singleInstanceConfig!.cloudReleaseDeadline = { ...deadlines.createHostCloudReleaseDeadline({ provider: 'tencent_cloud',
      platformExpiresAt: test.instances[0].expiresAt!.toISOString(), creationPhaseStartedAt: new Date().toISOString(), sourceProvisionJobId: 'job-1' }),
      cloudReleaseAt: test.instances[0].singleInstanceConfig!.autoReleaseTime! };
    await test.service.executeCreateBatch(test.items,test.lease);
    expect(test.runner.apply).not.toHaveBeenCalled();
    expect(test.native.executeCreateBatch).not.toHaveBeenCalled();
  });

  it('keeps data-disk billing active when ECS deletion succeeds but a disk remains', async () => {
    const test = fixture(1);
    test.native.captureInstanceDisks.mockImplementation(async (_item, _account, summary) => ({ ...summary, dataDiskIds: { 'host-1:d-data': 'd-data' } }));
    await test.service.executeCreateBatch(test.items, test.lease);
    expect(test.ledger).toEqual(expect.arrayContaining([expect.objectContaining({ cloudResourceId: 'd-data', cloudResourceType: 'disk', releasedAt: null })]));
    test.native.assertInstanceDisksAbsent.mockRejectedValue(new Error('ECS disks remain after instance deletion: d-data'));
    await test.service.executeDestroyBatch([test.queueDestroy(0)], test.lease);
    expect(test.cloud.size).toBe(0); expect(test.instances[0].status).toBe('destroy_failed');
    expect(test.instances[0].resourceSummary?.dataDiskIds).toEqual({ 'host-1:d-data': 'd-data' });
    expect(test.ledger.every(row => row.releasedAt === null)).toBe(true);
  });

  it('publishes 50 verified members in one cloud read before apply returns without finalizing their jobs or reading partial state', async () => {
    const test = fixture(50);
    test.onApply = async options => {
      for (const instance of test.instances) await test.createMember(instance.id);
      for (const instance of test.instances) options.onResourceApplied(progressEvent(instance.id));
      const state = await fs.readFile(path.join(test.workspace, 'terraform.tfstate'));
      await fs.writeFile(path.join(test.workspace, 'terraform.tfstate'), '{partial-write');
      await waitFor(() => test.instances.every(instance => instance.status === 'running'));
      expect(test.native.readOpenTofuInstances).toHaveBeenCalledTimes(1);
      expect(test.native.readOpenTofuInstances.mock.calls[0][1]).toHaveLength(50);
      expect([...test.jobs.values()].every(job => job.status === 'running')).toBe(true);
      expect(test.ledger).toHaveLength(0);
      expect(test.instances.every(instance => !instance.resourceSummary?.systemDiskIds)).toBe(true);
      expect(test.instances.every(instance => instance.accessEntry?.publicIp === '203.0.113.1')).toBe(true);
      await expect(fs.stat(path.join(test.workspace, '.single-batch-apply-started'))).resolves.toBeDefined();
      await fs.writeFile(path.join(test.workspace, 'terraform.tfstate'), state);
    };
    await test.service.executeCreateBatch(test.items, test.lease);
    expect([...test.jobs.values()].every(job => job.status === 'succeeded')).toBe(true);
    expect(test.ledger).toHaveLength(100);
  });

  it.each(['owner', 'account', 'job', 'batch', 'ip', 'status', 'foreign-event', 'duplicate-event'])('does not publish unverified progress for %s', async mismatch => {
    const test = fixture(1);
    test.onApply = async options => {
      await test.createMember('member-1');
      const detail = test.cloud.get('i-member-1');
      const original = structuredClone(detail);
      if (mismatch === 'owner') detail.tags.PlatformUserId = 'bob';
      if (mismatch === 'account') detail.tags.CloudAccountUid = 'other';
      if (mismatch === 'job') detail.tags.PlatformCreateJobId = 'different-job';
      if (mismatch === 'batch') detail.tags.SingleInstanceBatchId = 'other';
      if (mismatch === 'ip') detail.publicIp = null;
      if (mismatch === 'status') detail.status = 'Pending';
      options.onResourceApplied(progressEvent(mismatch === 'foreign-event' ? 'unknown-member' : 'member-1'));
      if (mismatch === 'duplicate-event') options.onResourceApplied({ ...progressEvent('member-1'), resourceId: 'i-other' });
      await new Promise(resolve => setTimeout(resolve, 300));
      expect(test.instances[0].status).toBe('creating');
      expect(test.instances[0].resourceSummary?.hostIds).toBeUndefined();
      expect(test.instances[0].resourceSummary?.cloudReleaseDeadlines?.['host-1'].status).toBe('unverified');
      expect(test.jobs.get('job-1')?.status).toBe('running');
      expect(test.ledger).toHaveLength(0);
      test.cloud.set('i-member-1', original);
    };
    await test.service.executeCreateBatch(test.items, test.lease);
    expect(test.instances[0].status).toBe('running');
  });

  it('keeps legacy retries without a frozen operation creating until final state verification', async () => {
    const test = fixture(1); test.items[0].job.jobType = 'retry';
    test.onApply = async options => {
      await test.createMember('member-1'); options.onResourceApplied(progressEvent('member-1'));
      await new Promise(resolve => setTimeout(resolve, 300));
      expect(test.instances[0].status).toBe('creating');
      expect(test.native.readOpenTofuInstances).not.toHaveBeenCalled();
    };
    await test.service.executeCreateBatch(test.items, test.lease);
    expect(test.instances[0].status).toBe('running'); expect(test.jobs.get('job-1')?.status).toBe('succeeded');
  });

  it('keeps progress observer errors private and lets final state verification decide success', async () => {
    const test = fixture(1);
    test.native.readOpenTofuInstances.mockRejectedValueOnce(new Error('test-secret-key test-Passw0rd-1!'));
    test.onApply = async options => {
      await test.createMember('member-1'); options.onResourceApplied(progressEvent('member-1'));
      await new Promise(resolve => setTimeout(resolve, 300));
      expect(test.instances[0].status).toBe('creating');
      expect(test.instances[0].errorSummary).toBeUndefined();
    };
    await test.service.executeCreateBatch(test.items, test.lease);
    expect(test.instances[0].status).toBe('running'); expect(test.instances[0].errorSummary).toBeNull();
  });

  it.each(['abort', 'superseded', 'lease'])('fences in-flight progress writes after %s', async kind => {
    const test = fixture(1);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    test.native.readOpenTofuInstances.mockImplementationOnce(async () => { await gate; return [...test.cloud.values()]; });
    test.onApply = async options => {
      expect(test.instances[0].singleInstanceConfig?.opentofuCreateJobId).toBe('job-1');
      test.repository.commitSingleInstanceClaim.mockClear();
      await test.createMember('member-1'); options.onResourceApplied(progressEvent('member-1'));
      await waitFor(() => test.native.readOpenTofuInstances.mock.calls.length === 1);
      if (kind === 'abort') test.controller.abort();
      if (kind === 'superseded') test.instances[0].lastJobId = 'replacement-job';
      if (kind === 'lease') test.lease.assertCurrent.mockRejectedValue(new Error('lease gone'));
      release();
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(test.repository.commitSingleInstanceClaim).not.toHaveBeenCalled();
      expect(test.instances[0].status).toBe('creating');
    };
    if (kind === 'superseded') await test.service.executeCreateBatch(test.items, test.lease);
    else await expect(test.service.executeCreateBatch(test.items, test.lease)).rejects.toBeInstanceOf(SingleInstanceOpenTofuLeaseLostError);
    expect(test.repository.commitSingleInstanceClaim).not.toHaveBeenCalled();
  });

  it('retains verified IDs and recovery markers without billing success when state persistence fails after early readiness', async () => {
    const test = fixture(1);
    test.onApply = async options => {
      await test.createMember('member-1'); options.onResourceApplied(progressEvent('member-1'));
      await waitFor(() => test.instances[0].status === 'running');
      await fs.rename(path.join(test.workspace, 'terraform.tfstate'), path.join(test.workspace, 'errored.tfstate'));
      throw new Error('state persistence failed');
    };
    await test.service.executeCreateBatch(test.items, test.lease);
    expect(test.instances[0].status).toBe('destroy_failed');
    expect(test.instances[0].resourceSummary?.hostIds).toEqual({ 'host-1': 'i-member-1' });
    expect(test.jobs.get('job-1')?.status).toBe('failed');
    expect(test.ledger).toHaveLength(0);
    expect(test.native.deleteOwnedUntrackedOpenTofuInstances).not.toHaveBeenCalled();
    expect(test.cloud.size).toBe(1);
    await expect(fs.stat(path.join(test.workspace, '.single-batch-apply-started'))).resolves.toBeDefined();
    await expect(fs.stat(path.join(test.workspace, 'errored.tfstate'))).resolves.toBeDefined();
  });

  it('preserves an early-ready member after a later member apply failure', async () => {
    const test = fixture();
    test.onApply = async options => {
      await test.createMember('member-1'); options.onResourceApplied(progressEvent('member-1'));
      await waitFor(() => test.instances[0].status === 'running');
      expect(test.jobs.get('job-1')?.status).toBe('running');
      test.onApply = undefined;
      throw new Error('second member failed');
    };
    await test.service.executeCreateBatch(test.items, test.lease);
    expect(test.instances.map(instance => instance.status)).toEqual(['running', 'destroy_failed']);
    expect([...test.cloud.keys()]).toEqual(['i-member-1']);
    expect(test.jobs.get('job-1')?.status).toBe('succeeded');
    expect(test.ledger).toHaveLength(2);
  });

  it('creates all claimed members with one init/plan/apply and freezes only actual cloud IPs', async () => {
    const test = fixture();
    await test.service.executeCreateBatch(test.items, test.lease);
    expect(test.runner.init).toHaveBeenCalledTimes(1); expect(test.runner.init.mock.calls[0][0].upgrade).toBe(true); expect(test.runner.plan).toHaveBeenCalledTimes(1); expect(test.runner.apply).toHaveBeenCalledTimes(1);
    expect(test.native.executeCreateBatch).not.toHaveBeenCalled(); expect(test.instances.map(instance => instance.status)).toEqual(['running', 'running']);
    expect(test.ledger).toHaveLength(4); expect(test.ledger.every(row => row.cloudAccountUid === 'uid-a' && row.ownerUserId === 'alice' && row.singleInstanceBatchId === 'batch-a')).toBe(true);
    expect((test.instances[0].runtimeTopologyGraph?.nodes as any[])[0].data.privateIp).toBe('172.16.1.20');
    expect(test.runner.init.mock.calls[0][0].env.ALICLOUD_SECRET_KEY).toBe('test-secret-key');
    await expect(fs.stat(path.join(test.workspace, '.single-batch-apply-started'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(path.join(test.workspace, 'versions.tf'), 'utf8')).toContain('version = \"= 1.282.0-range.1\"');
    // Parse the actual generated root wrapper, not just the static child module.
    const execute = promisify(execFile);
    await execute(process.env.OPENTOFU_BINARY ?? 'tofu', ['fmt', '-write=false', test.workspace]);
    if (process.env.SINGLE_TOFU_OFFLINE_VALIDATION === '1') {
      const cliConfig = path.join(test.workspace, 'offline-validation.tfrc');
      const mirrorRoot = process.env.SINGLE_TOFU_PROVIDER_MIRROR_PATH ?? '/app/.local/provider-mirror';
      await fs.writeFile(cliConfig, `provider_installation {
  filesystem_mirror { path = ${JSON.stringify(mirrorRoot)} }
}
`);
      const env = { ...process.env, TF_CLI_CONFIG_FILE: cliConfig };
      await execute(process.env.OPENTOFU_BINARY ?? 'tofu', ['init', '-backend=false', '-input=false', '-no-color'], { cwd: test.workspace, env });
      await execute(process.env.OPENTOFU_BINARY ?? 'tofu', ['validate', '-no-color'], { cwd: test.workspace, env });
    }
  });

  it('freezes unclaimed pending siblings without creating them', async () => {
    const test = fixture();
    await test.service.executeCreateBatch([test.items[0]], test.lease);
    expect(test.lastPlan.targets).toEqual(['module.single_batch.alicloud_instance.members["member-1"]']);
    expect(test.cloud.size).toBe(1); expect(test.instances[1].status).toBe('creating');
    const manifest = JSON.parse(await fs.readFile(path.join(test.workspace, 'single-batch-manifest.json'), 'utf8'));
    expect(Object.keys(manifest.members)).toEqual(['member-1', 'member-2']);
  });

  it('destroys one member through a targeted graph and preserves sibling state, cloud and billing', async () => {
    const test = fixture(); await test.service.executeCreateBatch(test.items, test.lease);
    const sibling = JSON.stringify(test.stateMembers.get('member-2'));
    await test.service.executeDestroyBatch([test.queueDestroy(0)], test.lease);
    expect(test.instances.map(instance => instance.status)).toEqual(['destroyed', 'running']);
    expect(JSON.stringify(test.stateMembers.get('member-2'))).toBe(sibling); expect([...test.cloud.keys()]).toEqual(['i-member-2']);
    expect(test.ledger.filter(row => row.rangeInstanceId === 'member-1').every(row => row.releasedAt instanceof Date)).toBe(true);
    expect(test.ledger.filter(row => row.rangeInstanceId === 'member-2').every(row => row.releasedAt === null)).toBe(true);
    expect(test.native.executeDestroyBatch).not.toHaveBeenCalled();
  });

  it('destroys the whole batch with one additional apply', async () => {
    const test = fixture(); await test.service.executeCreateBatch(test.items, test.lease);
    await test.service.executeDestroyBatch([test.queueDestroy(0), test.queueDestroy(1)], test.lease);
    expect(test.runner.apply).toHaveBeenCalledTimes(2); expect(test.stateMembers.size).toBe(0); expect(test.cloud.size).toBe(0);
    expect(test.instances.every(instance => instance.status === 'destroyed')).toBe(true);
  });

  it('preserves healthy newly created members while cleaning only tainted partial members', async () => {
    const test = fixture();
    test.onApply = async () => { await test.createMember('member-1'); await test.createMember('member-2', { tainted: true }); test.onApply = undefined; throw new Error('provider partial failure'); };
    await test.service.executeCreateBatch(test.items, test.lease);
    expect(test.instances.map(instance => instance.status)).toEqual(['running', 'create_failed']);
    expect([...test.cloud.keys()]).toEqual(['i-member-1']);
    expect(test.runner.plan.mock.calls[1][0].targets).toEqual(['module.single_batch.alicloud_instance.members["member-2"]']);
    expect(test.jobs.get('job-1')?.status).toBe('succeeded'); expect(test.instances[1].resourceSummary).toBeNull();
  });

  it('retains state IDs, marker and billing when failed-member cleanup itself fails', async () => {
    const test = fixture(1);
    test.onApply = async () => { await test.createMember('member-1', { tainted: true }); throw new Error('cleanup failed'); };
    await test.service.executeCreateBatch(test.items, test.lease);
    expect(test.instances[0].status).toBe('destroy_failed'); expect(test.instances[0].resourceSummary?.hostIds).toEqual({ 'host-1': 'i-member-1' });
    expect(test.stateMembers.size).toBe(1); await expect(fs.stat(path.join(test.workspace, '.single-batch-apply-started'))).resolves.toBeDefined();
    expect(test.repository.updateBillingLedgerResource.mock.calls.every(([,patch]) => !(patch as any).releasedAt)).toBe(true);
  });

  it('attributes a fresh explicit retry to its new creation job only after prior cleanup is proven', async () => {
    const test = fixture(1);
    test.onApply = async () => {
      await test.createMember('member-1', { tainted: true }); test.onApply = undefined; throw new Error('first creation failed');
    };
    await test.service.executeCreateBatch(test.items, test.lease);
    expect(test.instances[0].status).toBe('create_failed'); expect(test.cloud.size).toBe(0);
    const retry = test.queueDestroy(0); retry.job.jobType = 'retry'; retry.instance.status = 'creating';
    test.onApply = async () => { await test.createMember('member-1', { nativeId: 'i-retrymember1', diskId: 'd-retrymember1' }); test.onApply = undefined; };
    await test.service.executeCreateBatch([retry], test.lease);
    expect(test.instances[0].status).toBe('running');
    expect(test.cloud.get('i-retrymember1').tags.PlatformCreateJobId).toBe(retry.job.id);
    expect(test.instances[0].singleInstanceConfig?.opentofuCreateJobId).toBe(retry.job.id);
    expect(test.ledger.filter(row => ['i-retrymember1', 'd-retrymember1'].includes(row.cloudResourceId))).toHaveLength(2);
    expect(test.ledger.filter(row => ['i-member-1', 'd-member-1'].includes(row.cloudResourceId))).toHaveLength(2);
    expect(test.ledger.filter(row => ['i-retrymember1', 'd-retrymember1'].includes(row.cloudResourceId)).every(row => row.sourceProvisionJobId === retry.job.id && !row.releasedAt)).toBe(true);
    expect(test.ledger.filter(row => ['i-member-1', 'd-member-1'].includes(row.cloudResourceId)).every(row => row.sourceProvisionJobId === 'job-1' && row.releasedAt)).toBe(true);
  });

  it('rejects a plan that touches a healthy sibling and never applies that plan', async () => {
    const test = fixture();
    test.customPlan = () => ({ format_version: '1.2', resource_changes: [{ address: 'module.single_batch.alicloud_instance.members["member-2"]', type: 'alicloud_instance', change: { actions: ['delete'] } }] });
    await test.service.executeCreateBatch([test.items[0]], test.lease);
    expect(test.runner.apply).not.toHaveBeenCalled(); expect(test.cloud.size).toBe(0);
  });

  it('rejects malformed plan JSON before apply', async () => {
    const test = fixture(1); test.customPlan = () => ({});
    await test.service.executeCreateBatch(test.items, test.lease);
    expect(test.runner.apply).not.toHaveBeenCalled();
  });

  it('refuses delayed expired launches before any CLI creation and proves cleanup absence', async () => {
    const test = fixture(1); test.instances[0].expiresAt = new Date(Date.now() - 1);
    await test.service.executeCreateBatch(test.items, test.lease);
    expect(test.runner.init).not.toHaveBeenCalled(); expect(test.runner.apply).not.toHaveBeenCalled();
    expect(test.instances[0].status).toBe('create_failed'); expect(test.native.readOpenTofuInstancesByTag).toHaveBeenCalled();
  });

  it('refuses creation when the launch expires while init and plan are running', async () => {
    const test = fixture(1);
    test.instances[0].expiresAt = new Date(Date.now() + 60_000);
    const inspect = test.runner.showPlan.getMockImplementation()!;
    test.runner.showPlan.mockImplementation(async () => {
      const result = await inspect(); test.instances[0].expiresAt = new Date(Date.now() - 1); return result;
    });
    await test.service.executeCreateBatch(test.items, test.lease);
    expect(test.runner.apply).not.toHaveBeenCalled();
    expect(test.instances[0].status).toBe('create_failed');
    expect(test.cloud.size).toBe(0);
  });

  it('stops on lost lease after partial apply without cleanup, commits or error leakage', async () => {
    const test = fixture(1);
    test.onApply = async () => { test.repository.commitSingleInstanceClaim.mockClear(); await test.createMember('member-1'); test.controller.abort(); throw new Error('interrupted'); };
    await expect(test.service.executeCreateBatch(test.items, test.lease)).rejects.toBeInstanceOf(SingleInstanceOpenTofuLeaseLostError);
    expect(test.cloud.size).toBe(1); expect(test.native.deleteOwnedUntrackedOpenTofuInstances).not.toHaveBeenCalled();
    expect(test.repository.commitSingleInstanceClaim).not.toHaveBeenCalled();
    await expect(fs.stat(path.join(test.workspace, '.single-batch-apply-started'))).resolves.toBeDefined();
  });

  it('cleans proven untracked resources through explicit emergency-api and masks every batch password and account key', async () => {
    const test = fixture();
    test.onApply = async options => {
      await test.createMember('member-1'); await test.createMember('member-2');
      options.onResourceApplied?.(progressEvent('member-1')); options.onResourceApplied?.(progressEvent('member-2'));
      await fs.rm(path.join(test.workspace, 'terraform.tfstate')); test.stateMembers.clear();
      throw new Error(`failure test-Passw0rd-1! test-Passw0rd-2! test-access-key test-secret-key`);
    };
    await test.service.executeCreateBatch(test.items, test.lease);
    expect(test.native.deleteOwnedUntrackedOpenTofuInstances).toHaveBeenCalledTimes(2); expect(test.cloud.size).toBe(0);
    for (const instance of test.instances) { expect(instance.errorSummary).toContain('emergency-api'); expect(instance.errorSummary).not.toMatch(/test-Passw0rd|test-access-key|test-secret-key/); }
  });

  it('does not declare missing-state cleanup when a known ID remains but tag search misses it', async () => {
    const test = fixture(1); await test.service.executeCreateBatch(test.items, test.lease);
    await fs.rm(path.join(test.workspace, 'terraform.tfstate')); test.stateMembers.clear();
    test.native.readOpenTofuInstancesByTag.mockResolvedValue([]);
    test.native.deleteOwnedUntrackedOpenTofuInstances.mockImplementation(async () => { throw new Error('deletion rejected'); });
    await test.service.executeDestroyBatch([test.queueDestroy(0)], test.lease);
    expect(test.instances[0].status).toBe('destroy_failed'); expect(test.instances[0].resourceSummary?.hostIds).toEqual({ 'host-1': 'i-member-1' });
    expect(test.ledger.every(row => row.releasedAt === null)).toBe(true);
  });

  it('cleans an untracked target without touching a healthy sibling in the same durable state', async () => {
    const test = fixture(); await test.service.executeCreateBatch(test.items, test.lease);
    test.stateMembers.delete('member-2'); await test.saveState();
    await test.service.executeDestroyBatch([test.queueDestroy(1)], test.lease);
    expect(test.runner.apply).toHaveBeenCalledTimes(1); expect(test.native.deleteOwnedUntrackedOpenTofuInstances).toHaveBeenCalledTimes(1);
    expect([...test.cloud.keys()]).toEqual(['i-member-1']); expect(test.instances.map(instance => instance.status)).toEqual(['running', 'destroyed']);
  });

  it('does not blind-reapply an untracked create retry when healthy sibling state still exists', async () => {
    const test = fixture(); await test.service.executeCreateBatch(test.items, test.lease);
    test.stateMembers.delete('member-2'); await test.saveState();
    const retry = test.queueDestroy(1); retry.job.jobType = 'retry'; retry.instance.status = 'creating';
    await test.service.executeCreateBatch([retry], test.lease);
    expect(test.runner.apply).toHaveBeenCalledTimes(1); expect([...test.cloud.keys()]).toEqual(['i-member-1']);
    expect(test.instances.map(instance => instance.status)).toEqual(['running', 'create_failed']);
  });

  it('retains original recovery IDs when a failed cleanup subplan follows partial apply', async () => {
    const test = fixture(3);
    test.onApply = async () => {
      await test.createMember('member-1'); await test.createMember('member-2', { tainted: true }); await test.createMember('member-3');
      test.stateMembers.delete('member-3'); await test.saveState(); test.onApply = undefined; throw new Error('partial state');
    };
    test.native.deleteOwnedUntrackedOpenTofuInstances.mockImplementation(async () => { throw new Error('emergency cleanup failed'); });
    await test.service.executeCreateBatch(test.items, test.lease);
    const manifest = JSON.parse(await fs.readFile(path.join(test.workspace, 'single-batch-manifest.json'), 'utf8'));
    expect(manifest.pending.recoveryIds).toEqual(['member-1', 'member-2', 'member-3']);
    expect(test.instances.map(instance => instance.status)).toEqual(['running', 'create_failed', 'destroy_failed']);
    expect(test.instances[2].resourceSummary?.hostIds).toBeUndefined();
  });

  it('refuses unknown or cross-owner cloud resources without emergency deletion', async () => {
    const test = fixture(1);
    test.onApply = async () => { await test.createMember('member-1'); test.cloud.get('i-member-1').tags.PlatformUserId = 'bob'; await fs.rm(path.join(test.workspace, 'terraform.tfstate')); test.stateMembers.clear(); throw new Error('state lost'); };
    await test.service.executeCreateBatch(test.items, test.lease);
    expect(test.native.deleteOwnedUntrackedOpenTofuInstances).not.toHaveBeenCalled(); expect(test.instances[0].status).toBe('destroy_failed'); expect(test.cloud.size).toBe(1);
  });
  it.each([false, true])('never adopts copied Alibaba tags as creation evidence when original state is missing: known original=%s', async knownOriginal => {
    const test = fixture(1);
    if (knownOriginal) await test.service.executeCreateBatch(test.items, test.lease);
    const run = async () => {
      await test.createMember('member-1', { nativeId: 'i-forged' });
      await fs.rm(path.join(test.workspace, 'terraform.tfstate')); test.stateMembers.clear();
      throw new Error('unknown creation result');
    };
    if (knownOriginal) {
      await run().catch(() => {});
      await test.service.executeDestroyBatch([test.queueDestroy(0)], test.lease);
    } else {
      test.onApply = run;
      await test.service.executeCreateBatch(test.items, test.lease);
    }
    expect(test.instances[0].status).toBe('destroy_failed');
    expect(test.native.deleteOwnedUntrackedOpenTofuInstances).not.toHaveBeenCalled();
    expect(test.cloud.has('i-forged')).toBe(true);
    expect(test.ledger.some(row => row.cloudResourceId === 'i-forged')).toBe(false);
    const manifest = JSON.parse(await fs.readFile(path.join(test.workspace, 'single-batch-manifest.json'), 'utf8'));
    expect(Object.values(manifest.pending?.knownIds ?? {}).flat()).not.toContain('i-forged');
  });

  it.each(['owner', 'uid', 'region', 'profile'])('rejects mixed frozen %s membership before CLI or cloud mutation', async field => {
    const test = fixture(); const member = test.instances[1];
    if (field === 'owner') member.ownerUserId = 'bob';
    else if (field === 'uid') member.singleInstanceConfig!.cloudAccountUid = 'uid-b';
    else if (field === 'region') member.singleInstanceConfig!.regionId = 'cn-beijing';
    else member.singleInstanceConfig!.networkProfileId = 'profile-b';
    await test.service.executeCreateBatch(test.items, test.lease);
    expect(test.runner.init).not.toHaveBeenCalled(); expect(test.runner.apply).not.toHaveBeenCalled(); expect(test.native.deleteOwnedUntrackedOpenTofuInstances).not.toHaveBeenCalled();
  });

  it('rejects mismatched job/member pairs without committing results to another member', async () => {
    const test = fixture(); test.items[0].job.rangeInstanceId = 'member-2';
    await test.service.executeCreateBatch([test.items[0]], test.lease);
    expect(test.runner.init).not.toHaveBeenCalled(); expect(test.repository.commitSingleInstanceClaim).not.toHaveBeenCalled();
  });

  it('does not overwrite foreign state or adopt a state without its manifest', async () => {
    const test = fixture(1); await test.service.executeCreateBatch(test.items, test.lease);
    const before = await fs.readFile(path.join(test.workspace, 'terraform.tfstate'), 'utf8');
    await fs.rm(path.join(test.workspace, 'single-batch-manifest.json')); const item = test.queueDestroy(0);
    await test.service.executeDestroyBatch([item], test.lease);
    expect(await fs.readFile(path.join(test.workspace, 'terraform.tfstate'), 'utf8')).toBe(before);
    expect(test.runner.apply).toHaveBeenCalledTimes(1); expect(test.instances[0].status).toBe('destroy_failed');
  });

  it('keeps an interrupted no-state apply pending without inventing deletion authority from tags', async () => {
    const test = fixture(1);
    test.onApply = async () => { await test.createMember('member-1'); await fs.rm(path.join(test.workspace, 'terraform.tfstate')); test.stateMembers.clear(); test.controller.abort(); };
    await expect(test.service.executeCreateBatch(test.items, test.lease)).rejects.toBeInstanceOf(SingleInstanceOpenTofuLeaseLostError);
    const retry = test.queueDestroy(0); retry.job.jobType = 'retry'; retry.instance.status = 'creating';
    await test.service.executeCreateBatch([retry], { ...test.lease, signal: new AbortController().signal });
    expect(test.runner.apply).toHaveBeenCalledTimes(1); expect(test.cloud.size).toBe(1); expect(retry.instance.status).toBe('destroy_failed');
    expect(test.native.deleteOwnedUntrackedOpenTofuInstances).not.toHaveBeenCalled();
    await expect(fs.stat(path.join(test.workspace, '.single-batch-apply-started'))).resolves.toBeDefined();
  });

  it('retains an unknown create outcome across empty queries, worker restart and explicit retry', async () => {
    const test = fixture(1);
    test.onApply = async () => {
      await test.createMember('member-1');
      await fs.rm(path.join(test.workspace, 'terraform.tfstate'));
      test.stateMembers.clear();
      throw new Error('accepted create response and state lost');
    };
    test.native.readOpenTofuInstancesByTag.mockResolvedValue([]);
    await test.service.executeCreateBatch(test.items, test.lease);
    expect(test.instances[0].status).toBe('destroy_failed');
    expect(test.cloud.size).toBe(1);
    await expect(fs.stat(path.join(test.workspace, '.single-batch-apply-started'))).resolves.toBeDefined();
    const retry = test.queueDestroy(0); retry.job.jobType = 'retry'; retry.instance.status = 'creating';
    await test.service.executeCreateBatch([retry], test.lease);
    expect(test.runner.apply).toHaveBeenCalledTimes(1);
    expect(retry.instance.status).toBe('destroy_failed');
    test.native.readOpenTofuInstancesByTag.mockImplementation(async () => [...test.cloud.values()]);
    await test.service.executeDestroyBatch([test.queueDestroy(0)], test.lease);
    expect(test.instances[0].status).toBe('destroy_failed');
    expect(test.cloud.size).toBe(1);
    expect(test.native.deleteOwnedUntrackedOpenTofuInstances).not.toHaveBeenCalled();
    expect(test.runner.apply).toHaveBeenCalledTimes(1);
  });

  it('uses the database create intent to block a second apply after the entire workspace is lost', async () => {
    const test = fixture(1);
    test.onApply = async options => {
      expect(test.instances[0].singleInstanceConfig?.opentofuCreateJobId).toBe('job-1');
      await test.createMember('member-1'); options.onResourceApplied?.(progressEvent('member-1')); test.stateMembers.clear();
      await fs.rm(test.workspace, { recursive: true }); throw new Error('all local state and markers lost');
    };
    test.native.readOpenTofuInstancesByTag.mockResolvedValue([]);
    await test.service.executeCreateBatch(test.items, test.lease);
    expect(test.instances[0].status).toBe('destroy_failed');
    const retry = test.queueDestroy(0); retry.job.jobType = 'retry'; retry.instance.status = 'creating';
    await test.service.executeCreateBatch([retry], test.lease);
    expect(test.runner.apply).toHaveBeenCalledTimes(1);
    expect(test.instances[0].status).toBe('destroy_failed');
    expect(test.instances[0].singleInstanceConfig?.opentofuCreateJobId).toBe('job-1');
    test.native.readOpenTofuInstancesByTag.mockImplementation(async () => [...test.cloud.values()]);
    await test.service.executeDestroyBatch([test.queueDestroy(0)], test.lease);
    expect(test.cloud.size).toBe(0);
    expect(test.instances[0].status).toBe('destroyed');
    expect(test.instances[0].singleInstanceConfig?.opentofuCreateJobId).toBeNull();
    expect(test.ledger[0].sourceProvisionJobId).toBe('job-1');
  });

  it('never starts apply when its durable database create intent cannot be saved', async () => {
    const test = fixture(1); const commit = test.repository.commitSingleInstanceClaim.getMockImplementation()!;
    test.repository.commitSingleInstanceClaim.mockImplementation(async (...args) => {
      if ((args[1] as any).singleInstanceConfig?.opentofuCreateJobId) throw new Error('database unavailable');
      return commit(...args);
    });
    await test.service.executeCreateBatch(test.items, test.lease);
    expect(test.runner.apply).not.toHaveBeenCalled();
    expect(test.instances[0].status).toBe('destroy_failed');
    expect(test.cloud.size).toBe(0);
  });

  it('keeps deletion retryable when releasing the billing ledger fails after cloud deletion', async () => {
    const test = fixture(1); await test.service.executeCreateBatch(test.items, test.lease);
    const updateLedger = test.repository.updateBillingLedgerResource.getMockImplementation()!;
    let failRelease = true;
    test.repository.updateBillingLedgerResource.mockImplementation(async (id, patch) => {
      if ((patch as any).releasedAt && failRelease) { failRelease = false; throw new Error('billing database unavailable'); }
      return updateLedger(id, patch);
    });
    await test.service.executeDestroyBatch([test.queueDestroy(0)], test.lease);
    expect(test.cloud.size).toBe(0);
    expect(test.instances[0].status).toBe('destroy_failed');
    expect(test.instances[0].resourceSummary?.hostIds).toEqual({ 'host-1': 'i-member-1' });
    await test.service.executeDestroyBatch([test.queueDestroy(0)], test.lease);
    expect(test.instances[0].status).toBe('destroyed');
    expect(test.ledger.every(row => row.releasedAt instanceof Date)).toBe(true);
  });

  it('retains unknown creation IDs when cleanup first switches the marker to a destroy subplan', async () => {
    const test = fixture();
    test.onApply = async () => {
      await test.createMember('member-1', { tainted: true });
      await test.createMember('member-2'); test.stateMembers.delete('member-2'); await test.saveState();
      test.onApply = undefined; throw new Error('second member response lost');
    };
    test.native.readOpenTofuInstancesByTag.mockResolvedValue([]);
    await test.service.executeCreateBatch(test.items, test.lease);
    expect(test.instances.map(instance => instance.status)).toEqual(['create_failed', 'destroy_failed']);
    const marker = JSON.parse(await fs.readFile(path.join(test.workspace, '.single-batch-apply-started'), 'utf8'));
    expect(marker.kind).toBe('destroy'); expect(marker.createIds).toEqual(['member-1', 'member-2']);
    const retry = test.queueDestroy(1); retry.job.jobType = 'retry'; retry.instance.status = 'creating';
    await test.service.executeCreateBatch([retry], test.lease);
    expect(test.runner.apply).toHaveBeenCalledTimes(2);
    expect(test.instances[1].status).toBe('destroy_failed');
    expect([...test.cloud.keys()]).toEqual(['i-member-2']);
  });

  it('keeps recovery material for a superseded unclaimed sibling left by an interrupted apply', async () => {
    const test = fixture();
    test.onApply = async () => { await test.createMember('member-1'); await test.createMember('member-2'); await fs.rm(path.join(test.workspace, 'terraform.tfstate')); test.stateMembers.clear(); test.controller.abort(); };
    await expect(test.service.executeCreateBatch(test.items, test.lease)).rejects.toBeInstanceOf(SingleInstanceOpenTofuLeaseLostError);
    const retry = test.queueDestroy(0); retry.job.jobType = 'retry'; retry.instance.status = 'creating';
    await test.service.executeCreateBatch([retry], { ...test.lease, signal: new AbortController().signal });
    expect(test.runner.apply).toHaveBeenCalledTimes(1); expect([...test.cloud.keys()]).toEqual(['i-member-1', 'i-member-2']);
    await expect(fs.stat(path.join(test.workspace, '.single-batch-apply-started'))).resolves.toBeDefined();
    const manifest = JSON.parse(await fs.readFile(path.join(test.workspace, 'single-batch-manifest.json'), 'utf8'));
    expect(manifest.pending.ids).toEqual(['member-1', 'member-2']);
  });

  it('rejects changed immutable definitions before touching the previous state', async () => {
    const test = fixture(1); await test.service.executeCreateBatch(test.items, test.lease);
    const before = await fs.readFile(path.join(test.workspace, 'terraform.tfstate'), 'utf8');
    const retry = test.queueDestroy(0); retry.job.jobType = 'retry'; retry.instance.status = 'creating'; retry.instance.singleInstanceConfig!.imageId = 'm-different';
    await test.service.executeCreateBatch([retry], test.lease);
    expect(test.runner.apply).toHaveBeenCalledTimes(1); expect(await fs.readFile(path.join(test.workspace, 'terraform.tfstate'), 'utf8')).toBe(before);
    expect(retry.instance.status).toBe('destroy_failed'); expect(test.cloud.size).toBe(1);
  });

  it('does not trust malformed state as an empty state or clear its resource summary', async () => {
    const test = fixture(1); await test.service.executeCreateBatch(test.items, test.lease);
    await fs.writeFile(path.join(test.workspace, 'terraform.tfstate'), '{"password":"test-Passw0rd-1!", broken');
    const destroy = test.queueDestroy(0); await test.service.executeDestroyBatch([destroy], test.lease);
    expect(test.runner.apply).toHaveBeenCalledTimes(1); expect(destroy.instance.status).toBe('destroy_failed');
    expect(destroy.instance.resourceSummary?.hostIds).toEqual({ 'host-1': 'i-member-1' }); expect(destroy.instance.errorSummary).not.toContain('test-Passw0rd');
    expect(test.ledger.every(row => row.releasedAt === null)).toBe(true);
  });

  it.each(['null', 'false', '[]'])('does not treat a recovery marker containing %s as a missing marker', async contents => {
    const test = fixture(1); await test.service.executeCreateBatch(test.items, test.lease);
    await fs.writeFile(path.join(test.workspace, '.single-batch-apply-started'), contents);
    await test.service.executeDestroyBatch([test.queueDestroy(0)], test.lease);
    expect(test.runner.apply).toHaveBeenCalledTimes(1);
    expect(test.instances[0].status).toBe('destroy_failed');
    expect(test.cloud.size).toBe(1);
    expect(await fs.readFile(path.join(test.workspace, '.single-batch-apply-started'), 'utf8')).toBe(contents);
  });

  it.each(['errored', 'backup-only'])('preserves %s durable state material and never replans from an incomplete main state', async kind => {
    const test = fixture(1); await test.service.executeCreateBatch(test.items, test.lease);
    const state = await fs.readFile(path.join(test.workspace, 'terraform.tfstate'), 'utf8');
    const recoveryFile = path.join(test.workspace, kind === 'errored' ? 'errored.tfstate' : 'terraform.tfstate.backup');
    await fs.writeFile(recoveryFile, state); if (kind === 'backup-only') await fs.rm(path.join(test.workspace, 'terraform.tfstate'));
    const item = test.queueDestroy(0); await test.service.executeDestroyBatch([item], test.lease);
    expect(test.runner.apply).toHaveBeenCalledTimes(1); expect(item.instance.status).toBe('destroy_failed');
    expect(await fs.readFile(recoveryFile, 'utf8')).toBe(state); expect(test.cloud.size).toBe(1); expect(test.ledger.every(row => row.releasedAt === null)).toBe(true);
  });

  it('does not use stale main state to claim absence after apply writes errored recovery state', async () => {
    const test = fixture(1);
    test.onApply = async () => { await test.createMember('member-1'); await fs.rename(path.join(test.workspace, 'terraform.tfstate'), path.join(test.workspace, 'errored.tfstate')); throw new Error('state persistence failed'); };
    test.native.readOpenTofuInstancesByTag.mockResolvedValue([]);
    await test.service.executeCreateBatch(test.items, test.lease);
    expect(test.instances[0].status).toBe('destroy_failed'); expect(test.cloud.size).toBe(1); expect(test.runner.apply).toHaveBeenCalledTimes(1);
    expect(test.native.deleteOwnedUntrackedOpenTofuInstances).not.toHaveBeenCalled();
    await expect(fs.stat(path.join(test.workspace, '.single-batch-apply-started'))).resolves.toBeDefined();
    await expect(fs.stat(path.join(test.workspace, 'errored.tfstate'))).resolves.toBeDefined();
  });

  it('keeps old native resources on their original destroy path', async () => {
    const test = fixture(1); delete test.instances[0].singleInstanceConfig!.executionBackend;
    await test.service.executeDestroyBatch(test.items, test.lease);
    expect(test.native.executeDestroyBatch).toHaveBeenCalledWith(test.items); expect(test.runner.init).not.toHaveBeenCalled();
  });

  it('uses dry-run simulation without native creation, provider installation or CLI execution', async () => {
    const test = fixture();
    const service = new SingleInstanceOpenTofuExecutionService(test.repository as unknown as AdminRepository, {} as SystemConfigService, test.native as unknown as SingleInstanceBatchExecutionService,
      { projectRootDir: '/app', workspacesRootDir: root, env: { RANGE_PROVISIONER_MODE: 'dry-run', ALICLOUD_PROVIDER_ZIP_PATH: '/nonexistent.zip' }, runner: test.runner });
    await service.executeCreateBatch(test.items, test.lease);
    expect(test.instances.every(instance => instance.resourceSummary?.mode === 'dry-run')).toBe(true);
    expect(test.runner.init).not.toHaveBeenCalled(); expect(test.native.executeCreateBatch).not.toHaveBeenCalled(); expect(test.cloud.size).toBe(0);
  });

  it.each(['create', 'destroy'])('does not use dry-run %s to release or mutate real batch state and billing', async operation => {
    const test = fixture(1); await test.service.executeCreateBatch(test.items, test.lease);
    const item = test.queueDestroy(0); if (operation === 'create') { item.job.jobType = 'retry'; item.instance.status = 'creating'; }
    const service = new SingleInstanceOpenTofuExecutionService(test.repository as unknown as AdminRepository, {} as SystemConfigService, test.native as unknown as SingleInstanceBatchExecutionService,
      { projectRootDir: '/app', workspacesRootDir: root, env: { RANGE_PROVISIONER_MODE: 'dry-run' }, runner: test.runner });
    if (operation === 'create') await service.executeCreateBatch([item], test.lease); else await service.executeDestroyBatch([item], test.lease);
    expect(test.runner.apply).toHaveBeenCalledTimes(1); expect(test.cloud.size).toBe(1); expect(test.stateMembers.size).toBe(1);
    expect(item.instance.status).toBe('destroy_failed'); expect(item.instance.resourceSummary?.mode).toBe('opentofu');
    expect(test.ledger.every(row => row.releasedAt === null)).toBe(true); expect(test.native.deleteOwnedUntrackedOpenTofuInstances).not.toHaveBeenCalled();
  });

  it('fences every emergency API retry after a lease loss', async () => {
    const test = fixture(1); const item = test.items[0];
    item.instance.singleInstanceConfig!.opentofuCreateJobId = item.job.id;
    item.instance.resourceSummary = { mode: 'opentofu', hostIds: { 'host-1': 'i-owned' }, executionContext: { provider: 'alibaba_cloud', cloudAccountContextId: 'ctx-a', cloudAccountUid: 'uid-a', regionId: 'cn-hangzhou', zoneId: 'cn-hangzhou-h' } };
    const native = new SingleInstanceBatchExecutionService(test.repository as unknown as AdminRepository,
      { getAccountContextById: async () => test.account } as unknown as SystemConfigService);
    let deleted = 0;
    const priorInterval = process.env.SINGLE_INSTANCE_DESTROY_RETRY_INTERVAL_MS;
    process.env.SINGLE_INSTANCE_DESTROY_RETRY_INTERVAL_MS = '0';
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const query = new URLSearchParams(init?.method === 'POST' ? String(init.body) : new URL(String(input)).search);
      if (query.get('Action') === 'DeleteInstances') { deleted++; test.controller.abort(); return new Response(JSON.stringify({ Code: 'IncorrectInstanceStatus.Initializing' }), { status: 400 }); }
      return new Response(JSON.stringify({ RequestId: 'test', TotalCount: 1, Instances: { Instance: [{ InstanceId: 'i-owned', Tags: { Tag: Object.entries({
        RangeInstanceId: item.instance.id, SingleInstanceBatchId: 'batch-a', PlatformUserId: 'alice', PlatformScope: 'user', CreatedBy: 'cyber-range-platform',
        CloudAccountUid: 'uid-a', CloudAccountContextId: 'ctx-a', ExecutionBackend: 'opentofu' }).map(([TagKey, TagValue]) => ({ TagKey, TagValue })) } }] } }), { status: 200 });
    });
    try {
      await expect(native.deleteOwnedUntrackedOpenTofuInstances(item, ['i-owned'], async () => { if (test.controller.signal.aborted) throw new Error('lease lost'); })).rejects.toThrow('lease lost');
      expect(deleted).toBe(1);
    } finally { fetchMock.mockRestore(); if (priorInterval === undefined) delete process.env.SINGLE_INSTANCE_DESTROY_RETRY_INTERVAL_MS; else process.env.SINGLE_INSTANCE_DESTROY_RETRY_INTERVAL_MS = priorInterval; }
  });

  it('rejects foreign UID tags in the actual emergency API helper before sending delete', async () => {
    const test = fixture(1); const item = test.items[0];
    const native = new SingleInstanceBatchExecutionService(test.repository as unknown as AdminRepository,
      { getAccountContextById: async () => test.account } as unknown as SystemConfigService);
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ RequestId: 'test', TotalCount: 1,
      Instances: { Instance: [{ InstanceId: 'i-foreign', Tags: { Tag: Object.entries({ RangeInstanceId: item.instance.id, SingleInstanceBatchId: 'batch-a',
        PlatformUserId: 'alice', PlatformScope: 'user', CreatedBy: 'cyber-range-platform', CloudAccountUid: 'uid-b', CloudAccountContextId: 'ctx-a', ExecutionBackend: 'opentofu' }).map(([TagKey, TagValue]) => ({ TagKey, TagValue })) } }] } }), { status: 200 }));
    try {
      await expect(native.deleteOwnedUntrackedOpenTofuInstances(item, ['i-foreign'], async () => {})).rejects.toThrow('ownership');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally { fetchMock.mockRestore(); }
  });
  it.each([false, true])('freezes a new host deadline after init and persists it before apply (Tencent=%s)', async tencent => {
    const test = fixture(1, tencent); let initFinishedAt = 0;
    const init = test.runner.init.getMockImplementation()!;
    test.runner.init.mockImplementation(async options => { const result = await init(options); initFinishedAt = Date.now(); return result; });
    test.onApply = async () => {
      const config = test.instances[0].singleInstanceConfig!;
      const record = config.cloudReleaseDeadline!;
      expect(Date.parse(record.creationPhaseStartedAt)).toBeGreaterThanOrEqual(initFinishedAt);
      expect(record.platformExpiresAt).toBe(test.instances[0].expiresAt!.toISOString());
      expect(config.autoReleaseTime).toBe(record.cloudReleaseAt);
      const manifest = JSON.parse(await fs.readFile(path.join(test.workspace, 'single-batch-manifest.json'), 'utf8'));
      expect(manifest.members['member-1'].cloudReleaseDeadline).toEqual(record);
      expect(manifest.members['member-1'].definition.auto_release_time).toBe(record.cloudReleaseAt);
      const vars = JSON.parse(await fs.readFile(path.join(test.workspace, 'terraform.tfvars.json'), 'utf8'));
      expect(vars.members['member-1'][tencent ? 'action_timer_terminate_at' : 'auto_release_time']).toBe(record.cloudReleaseAt);
      expect(test.stepLogs.some(log => log.stepName === 'host_cloud_release_deadlines')).toBe(true);
      await test.createMember('member-1');
    };
    await test.service.executeCreateBatch(test.items, test.lease);
    expect(test.instances[0].status).toBe('running'); expect(test.instances[0].resourceSummary?.cloudReleaseDeadlines?.['host-1'].status).toBe('unverified');
    if (tencent) expect(Date.parse(test.instances[0].singleInstanceConfig!.autoReleaseTime!)).toBe(Math.floor((test.instances[0].expiresAt!.getTime()+300000)/1000)*1000);
  });

  it('restores a manifest deadline after its pre-apply database commit was interrupted without calculating a new C', async () => {
    const test = fixture(1);
    test.repository.commitSingleInstanceClaim.mockResolvedValueOnce(false);
    await expect(test.service.executeCreateBatch(test.items, test.lease)).rejects.toBeInstanceOf(SingleInstanceOpenTofuLeaseLostError);
    expect(test.runner.apply).not.toHaveBeenCalled();
    const manifest = JSON.parse(await fs.readFile(path.join(test.workspace, 'single-batch-manifest.json'), 'utf8'));
    const original = manifest.members['member-1'].cloudReleaseDeadline;
    expect(original.cloudReleaseAt).toBeTruthy(); expect(test.instances[0].singleInstanceConfig!.cloudReleaseDeadline).toBeUndefined();
    await test.service.executeCreateBatch(test.items, test.lease);
    expect(test.instances[0].singleInstanceConfig!.cloudReleaseDeadline).toMatchObject({ creationPhaseStartedAt: original.creationPhaseStartedAt, cloudReleaseAt: original.cloudReleaseAt });
    expect(test.runner.apply).toHaveBeenCalledTimes(1); expect(test.cloud.size).toBe(1);
  });

  it.each([true, false, null])('reports fallback verified only with native readback and exact system disk deletion policy (%s)', async deleteWithInstance => {
    const test = fixture(1);
    (deadlines.verifyCloudReleaseDeadlines as jest.Mock).mockImplementation(async input => Object.fromEntries(
      Object.entries(input.deadlines).map(([key, value]) => [key, { ...(value as object), status: 'verified', verifiedAt: new Date().toISOString() }])));
    test.native.captureInstanceDisks.mockImplementation(async (_item, _account, summary) => ({ ...summary,
      diskOwnershipProofs: { 'd-member-1': { instanceId: 'i-member-1', method: 'persisted', deleteWithInstance } } }));
    await test.service.executeCreateBatch(test.items, test.lease);
    const record = test.instances[0].resourceSummary!.cloudReleaseDeadlines!['host-1'];
    expect(record.status).toBe(deleteWithInstance === true ? 'verified' : 'unverified');
    if (deleteWithInstance !== true) expect(record.reason).toBe('system_disk_release_unverified');
    expect(test.instances[0].status).toBe('running'); expect(test.runner.apply).toHaveBeenCalledTimes(1); expect(test.cloud.size).toBe(1);
    expect(test.native.deleteOwnedUntrackedOpenTofuInstances).not.toHaveBeenCalled();
  });

  it('checks fifty native deadlines as a batch and keeps each member source separate', async () => {
    const test = fixture(50);
    await test.service.executeCreateBatch(test.items, test.lease);
    expect(deadlines.verifyCloudReleaseDeadlines).toHaveBeenCalledTimes(1);
    const request = (deadlines.verifyCloudReleaseDeadlines as jest.Mock).mock.calls[0][0];
    expect(Object.keys(request.hostIds)).toHaveLength(50); expect(Object.keys(request.deadlines)).toHaveLength(50);
    expect(test.instances.every(instance => instance.status === 'running')).toBe(true);
    expect(new Set(test.instances.map(instance => instance.singleInstanceConfig!.cloudReleaseDeadline!.sourceProvisionJobId)).size).toBe(50);
    expect(test.runner.apply).toHaveBeenCalledTimes(1);
  });

  it('does not create a replacement when refresh proposes recreating a tracked host', async () => {
    const test = fixture(1); await test.service.executeCreateBatch(test.items, test.lease);
    const original = structuredClone(test.instances[0].singleInstanceConfig!.cloudReleaseDeadline!);
    const retry = test.queueDestroy(0); retry.job.jobType = 'retry'; retry.instance.status = 'creating';
    await test.service.executeCreateBatch([retry], test.lease);
    expect(test.runner.apply).toHaveBeenCalledTimes(1); expect(test.cloud.size).toBe(1);
    expect(test.instances[0].singleInstanceConfig!.cloudReleaseDeadline).toMatchObject({ creationPhaseStartedAt: original.creationPhaseStartedAt, cloudReleaseAt: original.cloudReleaseAt });
  });

  it('bases C on the host phase after initialization queue delay rather than intake', async () => {
    const started = Date.parse('2026-10-13T01:00:17Z');
    jest.useFakeTimers({now: started, doNotFake:['setTimeout','clearTimeout','setInterval','clearInterval','setImmediate','clearImmediate','nextTick','performance','queueMicrotask']});
    try {
      const test=fixture(1); test.instances[0].expiresAt=new Date(started+10*60000);
      const init=test.runner.init.getMockImplementation()!;
      test.runner.init.mockImplementation(async options=>{const result=await init(options);jest.setSystemTime(started+5*60000);return result;});
      await test.service.executeCreateBatch(test.items,test.lease);
      const record=test.instances[0].singleInstanceConfig!.cloudReleaseDeadline!;
      expect(record.creationPhaseStartedAt).toBe('2026-10-13T01:05:17.000Z');
      expect(record.cloudReleaseAt).toBe('2026-10-13T01:38:00Z');
      expect(record.platformExpiresAt).toBe('2026-10-13T01:10:17.000Z');
      expect(test.runner.apply).toHaveBeenCalledTimes(1);
    } finally {jest.useRealTimers();}
  });

  it('refuses a frozen deadline that becomes too close while planning and refuses to renew it on retry', async () => {
    const started = Date.parse('2026-10-13T01:00:00Z');
    jest.useFakeTimers({now: started, doNotFake:['setTimeout','clearTimeout','setInterval','clearInterval','setImmediate','clearImmediate','nextTick','performance','queueMicrotask']});
    try {
      const test=fixture(1); const plan=test.runner.plan.getMockImplementation()!;
      test.runner.plan.mockImplementation(async options=>{const result=await plan(options);jest.setSystemTime(started+36*60000);return result;});
      await test.service.executeCreateBatch(test.items,test.lease);
      const record=structuredClone(test.instances[0].singleInstanceConfig!.cloudReleaseDeadline!);
      expect(record.cloudReleaseAt).toBe('2026-10-13T02:05:00Z'); expect(test.runner.apply).not.toHaveBeenCalled();
      const retry=test.queueDestroy(0);retry.job.jobType='retry';retry.instance.status='creating';
      await test.service.executeCreateBatch([retry],test.lease);
      expect(test.instances[0].singleInstanceConfig!.cloudReleaseDeadline).toEqual(record);
      expect(test.runner.apply).not.toHaveBeenCalled(); expect(test.cloud.size).toBe(0);
    } finally {jest.useRealTimers();}
  });

  it('retains a legacy native timer without installing or cancelling it during a retry of an existing host', async () => {
    const test=fixture(1);await test.service.executeCreateBatch(test.items,test.lease);
    const absolute=test.instances[0].singleInstanceConfig!.autoReleaseTime;
    delete test.instances[0].singleInstanceConfig!.cloudReleaseDeadline;
    delete test.instances[0].resourceSummary!.cloudReleaseDeadlines;
    const manifestFile=path.join(test.workspace,'single-batch-manifest.json');
    const manifest=JSON.parse(await fs.readFile(manifestFile,'utf8'));delete manifest.members['member-1'].cloudReleaseDeadline;
    await fs.writeFile(manifestFile,JSON.stringify(manifest));
    const retry=test.queueDestroy(0);retry.job.jobType='retry';retry.instance.status='creating';
    await test.service.executeCreateBatch([retry],test.lease);
    expect(test.instances[0].singleInstanceConfig!.autoReleaseTime).toBe(absolute);
    expect(test.instances[0].singleInstanceConfig!.cloudReleaseDeadline).toBeUndefined();
    expect(test.runner.apply).toHaveBeenCalledTimes(1);expect(test.cloud.size).toBe(1);
  });

  it('does not reuse verified status or an old native ID when a cleaned member is explicitly retried', async () => {
    const test=fixture(1);
    (deadlines.verifyCloudReleaseDeadlines as jest.Mock).mockImplementation(async input=>Object.fromEntries(Object.entries(input.deadlines).map(([key,record])=>[key,{...(record as object),status:'verified',instanceId:input.hostIds[key],verifiedAt:new Date().toISOString()}])));
    test.native.captureInstanceDisks.mockImplementation(async(_item,_account,summary)=>({...summary,diskOwnershipProofs:{[Object.values(summary.systemDiskIds!)[0] as string]:{instanceId:Object.values(summary.hostIds!)[0],method:'persisted',deleteWithInstance:true}}}));
    await test.service.executeCreateBatch(test.items,test.lease);
    const original=structuredClone(test.instances[0].singleInstanceConfig!.cloudReleaseDeadline!);
    expect(original.status).toBe('verified');
    await test.service.executeDestroyBatch([test.queueDestroy(0)],test.lease);
    await fs.rm(test.workspace,{recursive:true,force:true});
    const retry=test.queueDestroy(0);retry.job.jobType='retry';retry.instance.status='creating';
    test.onApply=async()=>{
      const record=test.instances[0].singleInstanceConfig!.cloudReleaseDeadline!;
      expect(record.status).toBe('unverified');expect(record.instanceId).toBeUndefined();expect(record.verifiedAt).toBeUndefined();
      expect(record.cloudReleaseAt).toBe(original.cloudReleaseAt);expect(record.creationPhaseStartedAt).toBe(original.creationPhaseStartedAt);
      await test.createMember('member-1',{nativeId:'i-explicitretry',diskId:'d-explicitretry'});
    };
    await test.service.executeCreateBatch([retry],test.lease);
    expect(test.instances[0].status).toBe('running');expect(test.cloud.has('i-explicitretry')).toBe(true);
  });

});
function result() { return { command: 'tofu', args: [], exitCode: 0, stdout: '', stderr: '' }; }
