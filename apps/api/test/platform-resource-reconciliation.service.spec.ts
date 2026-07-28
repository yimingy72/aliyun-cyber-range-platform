import {
  type AliyunEcsResourceClient,
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
