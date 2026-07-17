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
          cloudResourceId: 'i-dmz',
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
});
