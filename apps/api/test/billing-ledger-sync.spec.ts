import {
  releaseRangeInstanceBillingLedger,
  syncRangeInstanceBillingLedger,
} from '../src/admin/billing-ledger-sync';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';

describe('billing-ledger-sync', () => {
  it('creates ledger rows for instance-owned compute and network resources', async () => {
    const repository = createMemoryAdminRepository();
    const instance = await repository.createRangeInstance({
      name: 'lab-1',
      ownerUserId: 'user-1',
      status: 'running',
    });

    await syncRangeInstanceBillingLedger({
      repository,
      instance,
      regionId: 'cn-hangzhou',
      cloudAccountUid: 'account-1',
      resourceSummary: {
        mode: 'opentofu',
        hostIds: {
          dmz: 'i-dmz',
        },
        systemDiskIds: {
          dmz: 'd-dmz',
        },
        eipAllocationIds: {
          entry: 'eip-1',
        },
        natGatewayIds: {
          edge: 'ngw-1',
        },
      },
      sourceProvisionJobId: 'job-1',
      billingStartAt: new Date('2026-07-16T00:00:00.000Z'),
    });

    await expect(repository.listBillingLedgerResources()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          cloudResourceId: 'i-dmz',
          cloudResourceType: 'ecs',
          billingScope: 'user',
          ownerUserId: 'user-1',
          rangeInstanceId: instance.id,
        }),
        expect.objectContaining({
          cloudResourceId: 'd-dmz',
          cloudResourceType: 'disk',
        }),
        expect.objectContaining({
          cloudResourceId: 'eip-1',
          cloudResourceType: 'eip',
        }),
        expect.objectContaining({
          cloudResourceId: 'ngw-1',
          cloudResourceType: 'nat_gateway',
        }),
      ]),
    );
  });

  it('marks an instance ledger as released on destroy', async () => {
    const repository = createMemoryAdminRepository();
    const instance = await repository.createRangeInstance({
      name: 'lab-2',
      ownerUserId: 'user-1',
      status: 'running',
    });

    await repository.createBillingLedgerResource({
      regionId: 'cn-hangzhou',
      cloudResourceId: 'i-test',
      cloudResourceType: 'ecs',
      billingScope: 'user',
      ownerUserId: 'user-1',
      rangeInstanceId: instance.id,
      billingStartAt: new Date('2026-07-16T00:00:00.000Z'),
      tagsSnapshot: {},
    });

    const releasedAt = new Date('2026-07-16T12:00:00.000Z');
    await releaseRangeInstanceBillingLedger(repository, instance.id, releasedAt);

    await expect(repository.listBillingLedgerResources()).resolves.toEqual([
      expect.objectContaining({
        rangeInstanceId: instance.id,
        releasedAt,
      }),
    ]);
  });

  it('preserves the first successful launch as the source for existing resources when an instance is updated', async () => {
    const repository = createMemoryAdminRepository();
    const instance = await repository.createRangeInstance({
      name: 'lab-3',
      ownerUserId: 'user-1',
      status: 'running',
    });
    const initialStartAt = new Date('2026-07-16T02:03:42.000Z');
    const updateStartAt = new Date('2026-07-16T12:00:00.000Z');
    const createJob = await repository.createProvisionJob({
      rangeInstanceId: instance.id,
      jobType: 'create',
      triggeredBy: 'user-1',
    });
    await repository.updateProvisionJob(createJob.id, {
      status: 'succeeded',
      finishedAt: initialStartAt,
    });
    const updateJob = await repository.createProvisionJob({
      rangeInstanceId: instance.id,
      jobType: 'update',
      triggeredBy: 'user-1',
    });

    await syncRangeInstanceBillingLedger({
      repository,
      instance,
      regionId: 'cn-hangzhou',
      resourceSummary: {
        mode: 'opentofu',
        hostIds: { dmz: 'i-existing' },
        systemDiskIds: { dmz: 'd-existing' },
      },
      sourceProvisionJobId: createJob.id,
      billingStartAt: initialStartAt,
    });

    await syncRangeInstanceBillingLedger({
      repository,
      instance,
      regionId: 'cn-hangzhou',
      resourceSummary: {
        mode: 'opentofu',
        hostIds: { dmz: 'i-existing' },
        systemDiskIds: { dmz: 'd-existing' },
        eipAllocationIds: { entry: 'eip-new' },
      },
      sourceProvisionJobId: updateJob.id,
      billingStartAt: updateStartAt,
    });

    await expect(repository.listBillingLedgerResources()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          cloudResourceId: 'i-existing',
          cloudResourceType: 'ecs',
          sourceProvisionJobId: createJob.id,
          billingStartAt: initialStartAt,
        }),
        expect.objectContaining({
          cloudResourceId: 'd-existing',
          cloudResourceType: 'disk',
          sourceProvisionJobId: createJob.id,
          billingStartAt: initialStartAt,
        }),
        expect.objectContaining({
          cloudResourceId: 'eip-new',
          cloudResourceType: 'eip',
          sourceProvisionJobId: createJob.id,
          billingStartAt: updateStartAt,
        }),
      ]),
    );
  });
  it('backfills a missing creation job for an existing resource ledger without replacing it later', async () => {
    const repository = createMemoryAdminRepository();
    const instance = await repository.createRangeInstance({
      name: 'billing-ledger-range',
      ownerUserId: 'user-1',
      instanceMode: 'range',
      status: 'running',
    });
    const existing = await repository.createBillingLedgerResource({
      regionId: 'cn-hangzhou',
      cloudResourceId: 'i-billing-ledger-range',
      cloudResourceType: 'ecs',
      billingScope: 'user',
      ownerUserId: 'user-1',
      rangeInstanceId: instance.id,
      billingStartAt: new Date('2026-07-29T00:00:00.000Z'),
      tagsSnapshot: {},
    });
    const createJob = await repository.createProvisionJob({
      rangeInstanceId: instance.id,
      jobType: 'create',
      triggeredBy: 'user-1',
    });
    await repository.updateProvisionJob(createJob.id, {
      status: 'succeeded',
      finishedAt: new Date('2026-07-29T00:00:00.000Z'),
    });
    const updateJob = await repository.createProvisionJob({
      rangeInstanceId: instance.id,
      jobType: 'update',
      triggeredBy: 'user-1',
    });

    await syncRangeInstanceBillingLedger({
      repository,
      instance,
      regionId: 'cn-hangzhou',
      resourceSummary: {
        mode: 'ecs-native',
        hostIds: {
          app: 'i-billing-ledger-range',
        },
      },
      sourceProvisionJobId: createJob.id,
      billingStartAt: new Date('2026-07-29T00:00:00.000Z'),
    });

    await expect(
      repository.findBillingLedgerResource({
        regionId: 'cn-hangzhou',
        cloudResourceId: 'i-billing-ledger-range',
        cloudResourceType: 'ecs',
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        id: existing.id,
        sourceProvisionJobId: createJob.id,
      }),
    );

    await syncRangeInstanceBillingLedger({
      repository,
      instance,
      regionId: 'cn-hangzhou',
      resourceSummary: {
        mode: 'ecs-native',
        hostIds: {
          app: 'i-billing-ledger-range',
        },
      },
      sourceProvisionJobId: updateJob.id,
      billingStartAt: new Date('2026-07-29T00:00:00.000Z'),
    });

    await expect(
      repository.findBillingLedgerResource({
        regionId: 'cn-hangzhou',
        cloudResourceId: 'i-billing-ledger-range',
        cloudResourceType: 'ecs',
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        id: existing.id,
        sourceProvisionJobId: createJob.id,
      }),
    );
  });

  it('replaces an unsuccessful creation job with the retry that recreates an existing resource', async () => {
    const repository = createMemoryAdminRepository();
    const instance = await repository.createRangeInstance({
      name: 'retry-billing-ledger-range',
      ownerUserId: 'user-1',
      instanceMode: 'range',
      status: 'running',
    });
    const failedJob = await repository.createProvisionJob({
      rangeInstanceId: instance.id,
      jobType: 'create',
      triggeredBy: 'user-1',
    });
    await repository.updateProvisionJob(failedJob.id, {
      status: 'failed',
      finishedAt: new Date('2026-07-29T00:00:00.000Z'),
    });
    const retryJob = await repository.createProvisionJob({
      rangeInstanceId: instance.id,
      jobType: 'retry',
      triggeredBy: 'user-1',
    });
    const existing = await repository.createBillingLedgerResource({
      regionId: 'cn-hangzhou',
      cloudResourceId: 'i-retry-billing-ledger-range',
      cloudResourceType: 'ecs',
      billingScope: 'user',
      ownerUserId: 'user-1',
      rangeInstanceId: instance.id,
      sourceProvisionJobId: failedJob.id,
      billingStartAt: new Date('2026-07-29T00:00:00.000Z'),
      tagsSnapshot: {},
    });

    await syncRangeInstanceBillingLedger({
      repository,
      instance,
      regionId: 'cn-hangzhou',
      resourceSummary: {
        mode: 'ecs-native',
        hostIds: {
          app: 'i-retry-billing-ledger-range',
        },
      },
      sourceProvisionJobId: retryJob.id,
      billingStartAt: new Date('2026-07-29T00:00:00.000Z'),
    });

    await expect(
      repository.findBillingLedgerResource({
        regionId: 'cn-hangzhou',
        cloudResourceId: 'i-retry-billing-ledger-range',
        cloudResourceType: 'ecs',
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        id: existing.id,
        sourceProvisionJobId: retryJob.id,
      }),
    );
  });
});
