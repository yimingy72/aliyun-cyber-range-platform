import { ProvisioningWorkerService } from '../src/provisioning/provisioning-worker.service';
import type { RangeProvisioner } from '../src/provisioning/provisioning.types';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';

describe('ProvisioningWorkerService concurrency', () => {
  it('claims a pending job only once when the same job is processed concurrently', async () => {
    const repository = createMemoryAdminRepository();
    const competition = await repository.createCompetition({
      name: 'Concurrency Drill',
    });
    const team = await repository.createTeam({
      competitionId: competition.id,
      name: 'Blue Team',
    });
    const template = await repository.createRangeTemplate({
      name: 'Enterprise Template',
      slug: 'enterprise-template-concurrency',
      version: 'v1',
      modulePathOrRef: 'infra/opentofu/modules/alicloud-enterprise-range',
      topologySpec: {
        vpcCidr: '10.77.0.0/16',
        networkZones: [
          {
            key: 'dmz',
            name: 'DMZ',
            purpose: 'public-entry',
            cidr: '10.77.10.0/24',
            isPublicEntry: true,
          },
          {
            key: 'office',
            name: 'Office',
            purpose: 'user-workstations',
            cidr: '10.77.20.0/24',
          },
          {
            key: 'server',
            name: 'Server',
            purpose: 'application-servers',
            cidr: '10.77.30.0/24',
          },
        ],
        hosts: [
          {
            key: 'dmz-entry',
            name: 'DMZ Entry',
            zoneKey: 'dmz',
            role: 'entry',
            privateIp: '10.77.10.10',
            exposePublic: true,
          },
          {
            key: 'office-client',
            name: 'Office Client',
            zoneKey: 'office',
            role: 'workstation',
            privateIp: '10.77.20.10',
          },
          {
            key: 'server-app',
            name: 'Server App',
            zoneKey: 'server',
            role: 'app',
            privateIp: '10.77.30.10',
          },
        ],
        publicEntry: {
          hostKey: 'dmz-entry',
          protocols: [{ protocol: 'ssh', port: 22 }],
        },
      },
    });
    const instance = await repository.createRangeInstance({
      competitionId: competition.id,
      teamId: team.id,
      templateId: template.id,
      status: 'pending_create',
      allocatedCidr: '10.77.0.0/16',
    });
    const job = await repository.createProvisionJob({
      rangeInstanceId: instance.id,
      jobType: 'create',
      triggeredBy: 'admin',
    });

    await repository.updateRangeInstance(instance.id, {
      lastJobId: job.id,
    });

    const provisioner: RangeProvisioner = {
      create: jest.fn().mockResolvedValue({
        accessEntry: {
          hostRole: 'dmz',
          publicIp: '47.77.0.10',
          privateIp: '10.77.10.10',
          ssh: 'ssh root@47.77.0.10',
        },
        resourceSummary: {
          mode: 'opentofu',
          vpcId: 'vpc-claim-once',
          topologySpec: {
            vpcCidr: '10.77.0.0/16',
            publicEntryHostKey: 'dmz-entry',
            networkZoneKeys: ['dmz', 'office', 'server'],
            hostKeys: ['dmz-entry', 'office-client', 'server-app'],
          },
        },
      }),
      destroy: jest.fn(),
    };

    const worker = new ProvisioningWorkerService(repository, provisioner);

    await Promise.all([worker.process(job.id), worker.process(job.id)]);

    expect(provisioner.create).toHaveBeenCalledTimes(1);
    await expect(repository.getProvisionJobById(job.id)).resolves.toEqual(
      expect.objectContaining({
        id: job.id,
        status: 'succeeded',
      }),
    );
    await expect(repository.getRangeInstanceById(instance.id)).resolves.toEqual(
      expect.objectContaining({
        id: instance.id,
        status: 'running',
      }),
    );
  });
});
