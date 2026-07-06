import { ProvisioningWorkerService } from '../src/provisioning/provisioning-worker.service';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';

describe('Range instance auto-expire worker scan', () => {
  it('queues a destroy job for expired running instances', async () => {
    const repository = createMemoryAdminRepository();
    const provisioner = {
      create: jest.fn(),
      destroy: jest.fn(),
    };
    const systemConfigService = {
      getSnapshot: jest.fn(),
    };
    const service = new ProvisioningWorkerService(
      repository,
      provisioner as never,
      systemConfigService as never,
    );

    const template = await repository.createRangeTemplate({
      name: 'Expire Template',
      slug: 'expire-template',
      version: 'v1',
      modulePathOrRef: 'infra/opentofu/modules/alicloud-enterprise-range',
      topologySpec: {
        vpcCidr: '10.44.0.0/16',
        networkZones: [
          { key: 'dmz', name: 'DMZ', purpose: 'public-entry', cidr: '10.44.10.0/24', isPublicEntry: true },
        ],
        hosts: [
          { key: 'checker', name: 'checker', zoneKey: 'dmz', role: 'entry', privateIp: '10.44.10.10', exposePublic: true },
        ],
        publicEntry: {
          hostKey: 'checker',
          protocols: [{ protocol: 'ssh', port: 22 }],
        },
      },
    });

    const instance = await repository.createRangeInstance({
      name: 'expired-range',
      createdBy: 'admin',
      templateId: template.id,
      status: 'running',
      expiresAt: '2026-07-06T00:00:00.000Z',
    });

    await service.processExpiredInstances(new Date('2026-07-06T00:01:00.000Z'));

    const jobs = await repository.listProvisionJobs();
    expect(
      jobs.some((job) => job.jobType === 'destroy' && job.triggeredBy === 'system:auto-expire'),
    ).toBe(true);

    await expect(repository.getRangeInstanceById(instance.id)).resolves.toEqual(
      expect.objectContaining({
        id: instance.id,
        status: 'pending_destroy',
      }),
    );
  });
});
