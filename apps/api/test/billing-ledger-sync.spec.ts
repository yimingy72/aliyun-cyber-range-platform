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

  it('records every owned full-image disk once and excludes unverified external disks', async () => {
    const repository = createMemoryAdminRepository();
    const instance = await repository.createRangeInstance({ name: 'full-image', ownerUserId: 'alice', status: 'running' });
    await syncRangeInstanceBillingLedger({ repository, instance, regionId: 'cn-hangzhou', cloudAccountUid: 'uid-alice',
      resourceSummary: { mode: 'opentofu', hostIds: { host: 'i-full-image' }, systemDiskIds: { host: 'd-system' },
        dataDiskIds: { 'host:1': 'd-data', 'host:2': 'd-data' }, unverifiedDiskIds: { 'host:3': 'd-external' } },
      sourceProvisionJobId: 'job-full-image', billingStartAt: new Date() });
    const rows = await repository.listBillingLedgerResources();
    expect(rows.map(row => row.cloudResourceId).sort()).toEqual(['d-data','d-system','i-full-image']);
    expect(rows.filter(row => row.cloudResourceType === 'disk')).toHaveLength(2);
    expect(rows.every(row => row.ownerUserId === 'alice' && row.cloudAccountUid === 'uid-alice')).toBe(true);
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

describe('billing ledger ownership and scoped reads', () => {
  const start = new Date('2026-10-09T00:00:00Z');
  async function fixture() {
    const repository = createMemoryAdminRepository();
    const instance = await repository.createRangeInstance({ name: 'scoped-billing', ownerUserId: 'alice', status: 'running' });
    const input = { repository, instance, regionId: 'cn-hangzhou', cloudAccountUid: 'account-a',
      resourceSummary: { mode: 'opentofu' as const, hostIds: { app: 'i-a' }, systemDiskIds: { app: 'd-a' } }, billingStartAt: start };
    return { repository, instance, input };
  }

  it('reads only the requested instance history for create and release, retaining packed images and unrelated resources', async () => {
    const { repository, instance, input } = await fixture();
    const list = jest.spyOn(repository, 'listBillingLedgerResources');
    const unrelated = await repository.createBillingLedgerResource({ regionId: 'cn-hangzhou', cloudAccountUid: 'account-b', cloudResourceId: 'i-other', cloudResourceType: 'ecs', billingScope: 'user', ownerUserId: 'bob', rangeInstanceId: 'other', billingStartAt: start });
    const image = await repository.createBillingLedgerResource({ regionId: 'cn-hangzhou', cloudAccountUid: 'account-a', cloudResourceId: 'm-packed', cloudResourceType: 'image', billingScope: 'user', ownerUserId: 'alice', rangeInstanceId: instance.id, billingStartAt: start });
    await syncRangeInstanceBillingLedger(input);
    const ended = new Date('2026-10-09T01:00:00Z');
    await releaseRangeInstanceBillingLedger(repository, instance.id, ended);
    expect(list.mock.calls).toEqual([[{ rangeInstanceId: instance.id }], [{ rangeInstanceId: instance.id }]]);
    const rows = await repository.listBillingLedgerResources();
    expect(rows.filter(row => ['i-a', 'd-a'].includes(row.cloudResourceId)).every(row => row.releasedAt?.getTime() === ended.getTime())).toBe(true);
    expect(rows.find(row => row.id === unrelated.id)).toEqual(unrelated);
    expect(rows.find(row => row.id === image.id)).toEqual(image);
  });

  it.each([
    { cloudAccountUid: 'account-b' }, { ownerUserId: 'bob' }, { rangeInstanceId: 'other' }, { singleInstanceBatchId: 'other-batch' },
  ])('refuses to transfer existing resource billing history with %j', async conflict => {
    const { repository, instance, input } = await fixture();
    const original = await repository.createBillingLedgerResource({ regionId: input.regionId, cloudAccountUid: 'account-a', cloudResourceId: 'i-a', cloudResourceType: 'ecs', billingScope: 'user', ownerUserId: 'alice', rangeInstanceId: instance.id, billingStartAt: start, ...conflict });
    await expect(syncRangeInstanceBillingLedger(input)).rejects.toThrow('ownership conflicts');
    expect(await repository.listBillingLedgerResources()).toEqual([original]);
  });

  it('rechecks ownership if another writer creates the resource between lookup and insertion', async () => {
    const { repository, instance, input } = await fixture();
    const create = repository.createBillingLedgerResource.bind(repository);
    const conflict = { code: 'P2002' };
    jest.spyOn(repository, 'createBillingLedgerResource').mockImplementationOnce(async value => {
      await create({ ...value, ownerUserId: 'bob', rangeInstanceId: 'other' });
      throw conflict;
    });
    await expect(syncRangeInstanceBillingLedger(input)).rejects.toThrow('ownership conflicts');
    expect((await repository.listBillingLedgerResources())[0]).toMatchObject({ ownerUserId: 'bob', rangeInstanceId: 'other' });
    expect(instance.ownerUserId).toBe('alice');
  });

  it('recovers a same-owner duplicate insert without resetting its first billing time or successful source job', async () => {
    const { repository, instance, input } = await fixture();
    const source = await repository.createProvisionJob({ rangeInstanceId: instance.id, jobType: 'create', triggeredBy: 'alice' });
    await repository.updateProvisionJob(source.id, { status: 'succeeded' });
    const create = repository.createBillingLedgerResource.bind(repository);
    jest.spyOn(repository, 'createBillingLedgerResource').mockImplementationOnce(async value => {
      await create({ ...value, billingStartAt: start, sourceProvisionJobId: source.id });
      throw { code: 'P2002' };
    });
    await syncRangeInstanceBillingLedger({ ...input, billingStartAt: new Date('2026-10-09T01:00:00Z'), sourceProvisionJobId: 'retry' });
    const rows = await repository.listBillingLedgerResources({ rangeInstanceId: instance.id });
    expect(rows).toHaveLength(2);
    expect(rows.find(row => row.cloudResourceId === 'i-a')).toMatchObject({ billingStartAt: start, sourceProvisionJobId: source.id });
  });

  it('does not swallow non-unique persistence failures', async () => {
    const { repository, input } = await fixture();
    jest.spyOn(repository, 'createBillingLedgerResource').mockRejectedValue(new Error('write unavailable'));
    await expect(syncRangeInstanceBillingLedger(input)).rejects.toThrow('write unavailable');
  });
});

describe('verified billing account backfill', () => {
  it.each([null, 'account-b'])('does not assign verified account-a to unproven or conflicting UID %s', async cloudAccountUid => {
    const repository = createMemoryAdminRepository();
    const instance = await repository.createRangeInstance({ name: 'backfill', ownerUserId: 'alice', status: 'running' });
    const original = await repository.createBillingLedgerResource({ regionId: 'cn-hangzhou', cloudResourceId: 'i-history', cloudResourceType: 'ecs',
      cloudAccountUid, billingScope: 'user', ownerUserId: cloudAccountUid ? 'alice' : null, rangeInstanceId: instance.id, billingStartAt: new Date('2026-10-01') });
    await expect(syncRangeInstanceBillingLedger({ repository, instance, regionId: 'cn-hangzhou', cloudAccountUid: 'account-a',
      resourceSummary: { mode: 'opentofu', hostIds: { ecs: 'i-history' } }, billingStartAt: new Date('2026-10-09') })).rejects.toThrow();
    expect(await repository.listBillingLedgerResources()).toEqual([original]);
  });
});
