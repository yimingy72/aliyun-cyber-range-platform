import type { RangeInstanceRecord, ProvisionJobRecord } from "../src/admin/admin.repository";
import {
  AliyunEcsResourceClient,
  type AliyunEcsInstanceResource,
  PlatformResourceReconciliationService,
} from '../src/provisioning/platform-resource-reconciliation.service';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';

describe('PlatformResourceReconciliationService', () => {
  it('does not rewrite an active range or tag its disks from a background cloud observation', async () => {
    const repository = createMemoryAdminRepository();
    const instance = await repository.createRangeInstance({
      name: 'recoverable-range',
      status: 'creating',
      instanceMode: 'range',
    });
    const ecsClient = {
      getDefaultCredentials: jest.fn().mockResolvedValue({
        accessKeyId: 'test-ak',
        accessKeySecret: 'test-sk',
        regionId: 'cn-hangzhou',
      }),
      listPlatformManagedInstances: jest.fn().mockResolvedValue([
        {
          instanceId: 'i-recoverable-01',
          diskIds: ['d-recoverable-01'],
          tags: {
            CreatedBy: 'cyber-range-platform',
            PlatformManaged: 'true',
            RangeInstanceId: instance.id,
            PlatformHostKey: 'entry',
          },
        },
      ]),
      tagResources: jest.fn().mockResolvedValue(undefined),
    };
    const service = new PlatformResourceReconciliationService(
      repository,
      ecsClient as unknown as AliyunEcsResourceClient,
    );

    await expect(service.reconcile(new Date('2026-07-28T00:00:00.000Z'))).resolves.toEqual({
      recovered: 0,
      drifts: 0,
      skipped: false,
    });
    expect(await repository.getRangeInstanceById(instance.id)).toMatchObject({ status: 'creating', resourceSummary: null });
    expect(ecsClient.tagResources).not.toHaveBeenCalled();

  });

  it('records terminal legacy resources without an account binding as drift without assigning user bills or changing state', async () => {
    const repository = createMemoryAdminRepository();
    const instance = await repository.createRangeInstance({ name: 'legacy', instanceMode: 'range', status: 'destroy_failed', ownerUserId: 'alice', errorSummary: 'cleanup denied' });
    const job = await repository.createProvisionJob({ rangeInstanceId: instance.id, jobType: 'destroy', triggeredBy: 'alice' });
    await repository.updateProvisionJob(job.id, { status: 'failed' }); await repository.updateRangeInstance(instance.id, { lastJobId: job.id });
    const client = { getDefaultCredentials: jest.fn(async () => ({ accessKeyId: 'fixture', accessKeySecret: 'fixture', regionId: 'cn-hangzhou', accountUid: 'uid-other', cloudAccountContextId: 'context-other', accountUidResolved: true })),
      listPlatformManagedInstances: jest.fn(async () => [{ instanceId: 'i-unknown', diskIds: ['d-unknown'], tags: { CreatedBy: 'cyber-range-platform', PlatformManaged: 'true', RangeInstanceId: instance.id, PlatformHostKey: 'entry', PlatformUserId: 'alice' } }]), tagResources: jest.fn() };
    const service = new PlatformResourceReconciliationService(repository, client as any);
    expect(await service.reconcile()).toEqual({ recovered: 0, drifts: 1, skipped: false });
    expect(await repository.getRangeInstanceById(instance.id)).toMatchObject({ status: 'destroy_failed', resourceSummary: null, errorSummary: 'cleanup denied' });
    expect(await repository.listBillingLedgerResources()).toEqual([]); expect(client.tagResources).not.toHaveBeenCalled();
  });

  it('persists critical drift instead of deleting a cloud ECS without a platform record', async () => {
    const repository = createMemoryAdminRepository();
    const upsertDrift = jest.spyOn(repository, 'upsertCloudResourceDrift');
    const ecsClient = {
      getDefaultCredentials: jest.fn().mockResolvedValue({
        accessKeyId: 'test-ak',
        accessKeySecret: 'test-sk',
        regionId: 'cn-hangzhou',
      }),
      listPlatformManagedInstances: jest.fn().mockResolvedValue([
        {
          instanceId: 'i-orphaned-01',
          diskIds: ['d-orphaned-01'],
          tags: {
            CreatedBy: 'cyber-range-platform',
            PlatformManaged: 'true',
            RangeInstanceId: 'missing-range-instance',
            PlatformHostKey: 'entry',
          },
        },
      ]),
      tagResources: jest.fn(),
    };
    const service = new PlatformResourceReconciliationService(
      repository,
      ecsClient as unknown as AliyunEcsResourceClient,
    );

    await expect(service.reconcile(new Date('2026-07-28T00:00:00.000Z'))).resolves.toEqual({
      recovered: 0,
      drifts: 1,
      skipped: false,
    });
    expect(upsertDrift).toHaveBeenCalledWith(
      expect.objectContaining({
        regionId: 'cn-hangzhou',
        cloudResourceType: 'ecs',
        cloudResourceId: 'i-orphaned-01',
        rangeInstanceId: 'missing-range-instance',
        severity: 'critical',
      }),
    );
    expect(ecsClient.tagResources).not.toHaveBeenCalled();
  });
});

describe('OpenTofu member reconciliation isolation', () => {
  async function fixture(count = 1) {
    const repository = createMemoryAdminRepository();
    const credentials = { accessKeyId: 'fixture-ak', accessKeySecret: 'fixture-sk', regionId: 'cn-hangzhou',
      accountUid: 'account-a', cloudAccountContextId: 'context-a', accountUidResolved: true };
    const instances: RangeInstanceRecord[] = [];
    const jobs: ProvisionJobRecord[] = [];
    const cloud: AliyunEcsInstanceResource[] = [];
    for (let index = 0; index < count; index++) {
      const instance = await repository.createRangeInstance({ name: `tofu-${index}`, instanceMode: 'single', status: 'running',
        ownerUserId: 'alice', singleInstanceBatchId: 'batch-a',
        singleInstanceConfig: { executionBackend: 'opentofu', cloudAccountUid: 'account-a', cloudAccountContextId: 'context-a',
          regionId: 'cn-hangzhou', hostKey: 'ecs' } as never,
        resourceSummary:{mode:'opentofu',hostIds:{ecs:`i-${index}`},systemDiskIds:{ecs:`d-${index}`},diskInventoryHostIds:{ecs:`i-${index}`}} });
      const job = await repository.createProvisionJob({ rangeInstanceId: instance.id, jobType: 'create', triggeredBy: 'alice' });
      await repository.updateProvisionJob(job.id, { status: 'succeeded' });
      await repository.updateRangeInstance(instance.id, { lastJobId: job.id });
      instances.push(instance); jobs.push(job);
      cloud.push({ instanceId: `i-${index}`, diskIds: [`d-${index}`], tags: {
        CreatedBy: 'cyber-range-platform', PlatformManaged: 'true', ExecutionBackend: 'opentofu',
        CloudAccountUid: 'account-a', CloudAccountContextId: 'context-a', RangeInstanceId: instance.id,
        SingleInstanceBatchId: 'batch-a', PlatformUserId: 'alice', PlatformScope: 'user',
        PlatformResourceType: 'ecs', PlatformHostKey: 'ecs', PlatformCreateJobId: job.id,
      } });
    }
    const client = { getDefaultCredentials: jest.fn(async () => credentials), listPlatformManagedInstances: jest.fn(async () => cloud), verifyRecordedDisks:jest.fn(async()=>true), tagResources: jest.fn() };
    const service = new PlatformResourceReconciliationService(repository, client as unknown as AliyunEcsResourceClient);
    return { repository, credentials, instances, jobs, cloud, client, service };
  }

  it('skips all 50 early-ready members while any of their current operations are pending or running', async () => {
    const test = await fixture(50);
    for (const [index, instance] of test.instances.entries()) {
      const job = await test.repository.createProvisionJob({ rangeInstanceId: instance.id, triggeredBy: 'alice',
        status: index % 2 ? 'pending' : 'running', jobType: ['create', 'retry', 'destroy', 'refresh_status'][index % 4] as never });
      await test.repository.updateRangeInstance(instance.id, { lastJobId: job.id });
    }
    const update = jest.spyOn(test.repository, 'updateRangeInstance');
    await expect(test.service.reconcile()).resolves.toEqual({ recovered: 0, drifts: 0, skipped: false });
    expect(update).not.toHaveBeenCalled();
    expect(test.client.tagResources).not.toHaveBeenCalled();
    expect(await test.repository.listBillingLedgerResources()).toEqual([]);
  });

  it('reconciles a completed member from its persisted disk inventory, preserving OpenTofu mode and exact account and original billing time', async () => {
    const test = await fixture();
    const instance = test.instances[0];
    const oldStart = new Date('2026-10-01T00:00:00Z');
    const prior = await test.repository.createBillingLedgerResource({ regionId: 'cn-hangzhou', cloudResourceId: 'i-0', cloudResourceType: 'ecs',
      cloudAccountUid: null, billingScope: 'user', ownerUserId: 'alice', rangeInstanceId: instance.id,
      singleInstanceBatchId: 'batch-a', sourceProvisionJobId: test.jobs[0].id, billingStartAt: oldStart });
    await test.service.reconcile(new Date('2026-10-09T00:00:00Z'));
    const current = await test.repository.getRangeInstanceById(instance.id);
    expect(current?.resourceSummary).toMatchObject({ mode: 'opentofu', hostIds: { ecs: 'i-0' }, systemDiskIds: { ecs: 'd-0' } });
    const rows = await test.repository.listBillingLedgerResources();
    expect(rows).toHaveLength(2);
    expect(rows.find(row => row.id === prior.id)).toMatchObject({ cloudAccountUid: 'account-a', billingStartAt: oldStart, sourceProvisionJobId: test.jobs[0].id });
    expect(rows.find(row => row.cloudResourceId === 'd-0')).toMatchObject({ cloudAccountUid: 'account-a', billingStartAt: instance.createdAt,
      ownerUserId: 'alice', singleInstanceBatchId: 'batch-a', rangeInstanceId: instance.id });
    expect(test.client.tagResources).not.toHaveBeenCalled();
  });

  it.each(['account', 'context', 'region', 'unresolved', 'owner', 'batch', 'host', 'source-job', 'tag-account', 'tag-context', 'tag-mode', 'tag-scope'])('does not adopt a resource with mismatched %s', async kind => {
    const test = await fixture();
    if (kind === 'account') test.credentials.accountUid = 'account-other';
    if (kind === 'context') test.credentials.cloudAccountContextId = 'context-other';
    if (kind === 'region') test.credentials.regionId = 'cn-beijing';
    if (kind === 'unresolved') test.credentials.accountUidResolved = false;
    if (kind === 'owner') test.cloud[0].tags.PlatformUserId = 'bob';
    if (kind === 'batch') test.cloud[0].tags.SingleInstanceBatchId = 'other';
    if (kind === 'host') test.cloud[0].tags.PlatformHostKey = 'other';
    if (kind === 'source-job') test.cloud[0].tags.PlatformCreateJobId = 'missing';
    if (kind === 'tag-account') test.cloud[0].tags.CloudAccountUid = 'other';
    if (kind === 'tag-context') test.cloud[0].tags.CloudAccountContextId = 'other';
    if (kind === 'tag-mode') test.cloud[0].tags.ExecutionBackend = 'ecs-native';
    if (kind === 'tag-scope') test.cloud[0].tags.PlatformScope = 'platform';
    const update = jest.spyOn(test.repository, 'updateRangeInstance');
    const drift = jest.spyOn(test.repository, 'upsertCloudResourceDrift');
    await test.service.reconcile();
    expect(update).not.toHaveBeenCalled();
    expect(test.client.tagResources).not.toHaveBeenCalled();
    expect(await test.repository.listBillingLedgerResources()).toEqual([]);
    expect(drift).toHaveBeenCalledWith(expect.objectContaining({ severity: 'critical', cloudResourceId: 'i-0' }));
  });

  it.each(['pending_destroy', 'destroying', 'destroyed', 'destroy_failed', 'create_failed'])('does not revive a %s member from a stale pre-destroy cloud snapshot', async status => {
    const test = await fixture();
    test.client.listPlatformManagedInstances.mockImplementationOnce(async () => {
      await test.repository.withSingleInstanceControlLock(async () => {
        const destroy = await test.repository.createProvisionJob({ rangeInstanceId: test.instances[0].id, jobType: 'destroy', triggeredBy: 'alice' });
        await test.repository.updateRangeInstance(test.instances[0].id, { status: status as never, lastJobId: destroy.id, resourceSummary: null });
      });
      return test.cloud;
    });
    await test.service.reconcile();
    expect(await test.repository.getRangeInstanceById(test.instances[0].id)).toMatchObject({ status, resourceSummary: null });
    expect(await test.repository.listBillingLedgerResources()).toEqual([]);
    expect(test.client.tagResources).not.toHaveBeenCalled();
  });

  it('finishes the short database reconciliation before a newly queued destroy takes its control lock', async () => {
    const test = await fixture();
    let enter!: () => void, resume!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const resumeRead = new Promise<void>(resolve => { resume = resolve; });
    const list = test.repository.listBillingLedgerResources.bind(test.repository);
    jest.spyOn(test.repository, 'listBillingLedgerResources').mockImplementationOnce(async filter => { enter(); await resumeRead; return list(filter); });
    const reconcile = test.service.reconcile();
    await entered;
    let destroyEntered = false;
    const destroy = test.repository.withSingleInstanceControlLock(async () => {
      destroyEntered = true;
      await test.repository.updateRangeInstance(test.instances[0].id, { status: 'destroyed', resourceSummary: null });
    });
    await Promise.resolve();
    expect(destroyEntered).toBe(false);
    resume();
    await Promise.all([reconcile, destroy]);
    expect(await test.repository.getRangeInstanceById(test.instances[0].id)).toMatchObject({ status: 'destroyed', resourceSummary: null });
    expect(test.client.tagResources).not.toHaveBeenCalled();
  });

  it.each(['create_failed', 'destroy_failed', 'destroyed'])('records only a proven surviving ECS for %s without adopting unrecorded attached disks', async status => {
    const test = await fixture();
    const instance = test.instances[0];
    await test.repository.updateProvisionJob(test.jobs[0].id, { status: 'failed' });
    await test.repository.updateRangeInstance(instance.id, { status: status as never, resourceSummary: null, errorSummary: 'cleanup requires retry' });
    test.cloud[0].diskIds.push('d-attached');
    const update = jest.spyOn(test.repository, 'updateRangeInstance');
    const drift = jest.spyOn(test.repository, 'upsertCloudResourceDrift');
    await expect(test.service.reconcile()).resolves.toEqual({ recovered: 0, drifts: 1, skipped: false });
    expect(update).not.toHaveBeenCalled();
    expect(test.client.tagResources).not.toHaveBeenCalled();
    expect(await test.repository.getRangeInstanceById(instance.id)).toMatchObject({ status, resourceSummary: null, errorSummary: 'cleanup requires retry' });
    expect((await test.repository.listBillingLedgerResources()).map(row => row.cloudResourceId).sort()).toEqual(['i-0']);
    expect((await test.repository.listBillingLedgerResources()).every(row => row.cloudAccountUid === 'account-a'
      && row.sourceProvisionJobId === test.jobs[0].id && row.ownerUserId === 'alice' && row.releasedAt === null)).toBe(true);
    expect(drift).toHaveBeenCalledWith(expect.objectContaining({ severity: 'critical', rangeInstanceId: instance.id }));
  });

  it.each(['missing disk','foreign disk'])('reports %s without replacing disk ownership or closing its ledger', async reason => {
    const test = await fixture(); test.client.verifyRecordedDisks.mockResolvedValue(false);
    expect(await test.service.reconcile()).toEqual({recovered:0,drifts:1,skipped:false});
    expect(await test.repository.getRangeInstanceById(test.instances[0].id)).toMatchObject({resourceSummary:{systemDiskIds:{ecs:'d-0'}}});
    expect(await test.repository.listBillingLedgerResources()).toEqual([]); expect(test.client.tagResources).not.toHaveBeenCalled();
  });

  it('does not reopen released billing from a stale cloud snapshot after destruction completes during the read', async () => {
    const test = await fixture();
    test.client.listPlatformManagedInstances.mockImplementationOnce(async () => {
      await test.repository.updateRangeInstance(test.instances[0].id, { status: 'destroyed', resourceSummary: null });
      const instance = await test.repository.getRangeInstanceById(test.instances[0].id);
      // Millisecond timestamps may otherwise match on a fast in-memory repository.
      jest.spyOn(test.repository, 'getRangeInstanceById').mockResolvedValue({ ...instance!, updatedAt: new Date(Date.now() + 1_000) });
      return test.cloud;
    });
    await test.service.reconcile();
    expect(await test.repository.listBillingLedgerResources()).toEqual([]);
    expect(test.client.tagResources).not.toHaveBeenCalled();
  });
});


describe('Aliyun ECS disk reconciliation query contract', () => {
  const credentials={accessKeyId:'fixture',accessKeySecret:'fixture',regionId:'cn-hangzhou',accountUid:'uid',cloudAccountContextId:'ctx',accountUidResolved:true};
  const instance={id:'range',ownerUserId:'alice',resourceSummary:{mode:'opentofu',hostIds:{host:'i-owned'},systemDiskIds:{host:'d-system'},
    dataDiskIds:{'host:data':'d-data'},diskInventoryHostIds:{host:'i-owned'},diskOwnershipProofs:{'d-data':{instanceId:'i-owned',method:'tags'}}}} as unknown as RangeInstanceRecord;
  it.each(['valid','missing','foreign'])('checks exact recorded system/data IDs using DescribeDisks: %s', async state => {
    const client=new AliyunEcsResourceClient({} as any);
    const query=jest.spyOn(client as any,'performRequest').mockImplementation(async (input:any)=>{
      expect(input.action).toBe('DescribeDisks'); expect(JSON.parse(input.parameters.DiskIds)).toEqual(['d-system','d-data']); expect(input.parameters.InstanceId).toBeUndefined();
      const rows=[{DiskId:'d-system',Type:'system',InstanceId:'i-owned'},...(state==='missing'?[]:[{DiskId:'d-data',Type:'data',InstanceId:'i-owned',Tags:{Tag:[{TagKey:'PlatformUserId',TagValue:state==='foreign'?'bob':'alice'}]}}])];
      return {RequestId:'disks',TotalCount:rows.length,PageNumber:1,PageSize:100,Disks:{Disk:rows}};
    });
    expect(await client.verifyRecordedDisks(credentials,instance,'i-owned')).toBe(state==='valid'); expect(query).toHaveBeenCalledTimes(1);
  });
  it('never reads cloud disks when the platform has no durable disk inventory', async()=>{
    const client=new AliyunEcsResourceClient({} as any); const query=jest.spyOn(client as any,'performRequest');
    expect(await client.verifyRecordedDisks(credentials,{...instance,resourceSummary:null},'i-owned')).toBe(false); expect(query).not.toHaveBeenCalled();
  });
  it('does not infer disk IDs from non-contract BlockDeviceMappings in DescribeInstances',async()=>{
    const client=new AliyunEcsResourceClient({} as any);
    jest.spyOn(client as any,'performRequest').mockResolvedValue({TotalCount:1,Instances:{Instance:[{InstanceId:'i-owned',BlockDeviceMappings:{BlockDeviceMapping:[{DiskId:'d-unproven'}]}}]}});
    expect((await client.describeInstances(credentials,['i-owned']))[0].diskIds).toEqual([]);
  });
});
