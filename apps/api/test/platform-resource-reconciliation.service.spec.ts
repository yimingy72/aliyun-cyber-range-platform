import type { RangeInstanceRecord, ProvisionJobRecord } from "../src/admin/admin.repository";
import {
  type AliyunEcsResourceClient,
  type AliyunEcsInstanceResource,
  PlatformResourceReconciliationService,
} from '../src/provisioning/platform-resource-reconciliation.service';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';

describe('PlatformResourceReconciliationService', () => {
  it('restores a missing host summary from a tagged ECS and tags its system disk', async () => {
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
      recovered: 1,
      drifts: 0,
      skipped: false,
    });
    await expect(repository.getRangeInstanceById(instance.id)).resolves.toEqual(
      expect.objectContaining({
        resourceSummary: expect.objectContaining({
          hostIds: { entry: 'i-recoverable-01' },
          systemDiskIds: { entry: 'd-recoverable-01' },
        }),
      }),
    );
    expect(ecsClient.tagResources).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceType: 'disk',
        resourceIds: ['d-recoverable-01'],
        tags: expect.objectContaining({
          PlatformManaged: 'true',
          PlatformResourceType: 'disk',
          PlatformHostKey: 'entry',
        }),
      }),
    );
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
          regionId: 'cn-hangzhou', hostKey: 'ecs' } as never });
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
    const client = { getDefaultCredentials: jest.fn(async () => credentials), listPlatformManagedInstances: jest.fn(async () => cloud), tagResources: jest.fn() };
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

  it('restores only a completed bound member, preserving OpenTofu mode and exact account and original billing time', async () => {
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
    await test.service.reconcile();
    expect(update).not.toHaveBeenCalled();
    expect(test.client.tagResources).not.toHaveBeenCalled();
    expect(await test.repository.listBillingLedgerResources()).toEqual([]);
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
});
