import { RangeInstancesService } from '../src/admin/range-instances.service';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';

describe('RangeInstancesService retry flow', () => {
  it('creates a retry job and resets a failed create instance back to pending_create', async () => {
    const repository = createMemoryAdminRepository();
    const cidrPoolService = {
      serialize: async <T>(handler: () => Promise<T>) => handler(),
      getPool: () => [],
      allocate: () => null,
    };
    const dispatched: string[] = [];
    const provisioningWorkerService = {
      dispatch: (jobId: string) => {
        dispatched.push(jobId);
      },
    };

    const service = new RangeInstancesService(
      repository,
      {
        update: async () => {
          throw new Error('not used in retry test');
        },
      } as never,
      cidrPoolService as never,
      provisioningWorkerService as never,
    );

    const template = await repository.createRangeTemplate({
      name: 'Retry Template',
      slug: 'retry-template-service-spec',
      version: 'v1',
      modulePathOrRef: 'infra/opentofu/modules/alicloud-enterprise-range',
      topologySpec: {
        vpcCidr: '10.90.0.0/16',
        networkZones: [
          { key: 'dmz', name: 'DMZ', purpose: 'public-entry', cidr: '10.90.10.0/24', isPublicEntry: true },
          { key: 'office', name: 'Office', purpose: 'user-workstations', cidr: '10.90.20.0/24' },
          { key: 'server', name: 'Server', purpose: 'application-servers', cidr: '10.90.30.0/24' },
        ],
        hosts: [
          { key: 'dmz-entry', name: 'DMZ Entry', zoneKey: 'dmz', role: 'entry', privateIp: '10.90.10.10', exposePublic: true },
          { key: 'office-client', name: 'Office Client', zoneKey: 'office', role: 'workstation', privateIp: '10.90.20.10' },
          { key: 'server-app', name: 'Server App', zoneKey: 'server', role: 'app', privateIp: '10.90.30.10' },
        ],
        publicEntry: { hostKey: 'dmz-entry', protocols: [{ protocol: 'ssh', port: 22 }] },
      },
    });
    await repository.publishRangeTemplate(template.id);

    const instance = await repository.createRangeInstance({
      name: '重试实例',
      templateId: template.id,
      status: 'create_failed',
      allocatedCidr: '10.90.0.0/16',
      errorSummary: 'OpenTofu plan failed',
    });
    const failedJob = await repository.createProvisionJob({
      rangeInstanceId: instance.id,
      jobType: 'create',
      triggeredBy: 'admin',
    });
    await repository.updateProvisionJob(failedJob.id, {
      status: 'failed',
      retryCount: 0,
      errorSummary: 'OpenTofu plan failed',
    });
    await repository.updateRangeInstance(instance.id, {
      lastJobId: failedJob.id,
    });

    const retryJob = await service.triggerRetry(instance.id, 'admin');

    expect(retryJob).toEqual(
      expect.objectContaining({
        rangeInstanceId: instance.id,
        jobType: 'retry',
        status: 'pending',
        retryCount: 1,
      }),
    );

    await expect(repository.getRangeInstanceById(instance.id)).resolves.toEqual(
      expect.objectContaining({
        id: instance.id,
        status: 'pending_create',
        errorSummary: null,
        lastJobId: retryJob.id,
      }),
    );
    expect(dispatched).toEqual([retryJob.id]);
  });
});
