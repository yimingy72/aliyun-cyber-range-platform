import { ProvisioningWorkerService } from '../src/provisioning/provisioning-worker.service';
import type { RangeProvisioner } from '../src/provisioning/provisioning.types';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';

function createSystemConfigServiceStub() {
  return {
    getSnapshot: jest.fn().mockResolvedValue({
      provider: 'alibaba_cloud',
      defaultRegion: 'cn-hangzhou',
      defaultZoneId: 'cn-hangzhou-h',
      accessKeyId: 'test-ak',
      accessKeySecret: 'test-sk',
    }),
  };
}

describe('ProvisioningWorkerService concurrency', () => {
  it('claims a pending job only once when the same job is processed concurrently', async () => {
    const repository = createMemoryAdminRepository();
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
    await repository.publishRangeTemplate(template.id);

    const instance = await repository.createRangeInstance({
      name: '并发实例 A',
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

    const worker = new ProvisioningWorkerService(repository, provisioner, createSystemConfigServiceStub() as any);

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

  it('prefers published compiled topologySpec over the legacy published topologySpec during provisioning', async () => {
    const repository = createMemoryAdminRepository();
    const template = await repository.createRangeTemplate({
      name: 'Compiled Template',
      slug: 'compiled-template-concurrency',
      version: 'v1',
      modulePathOrRef: 'infra/opentofu/modules/alicloud-enterprise-range',
      topologySpec: {
        vpcCidr: '10.88.0.0/16',
        networkZones: [
          {
            key: 'dmz',
            name: 'DMZ',
            purpose: 'public-entry',
            cidr: '10.88.10.0/24',
            isPublicEntry: true,
          },
        ],
        hosts: [
          {
            key: 'legacy-entry',
            name: 'Legacy Entry',
            zoneKey: 'dmz',
            role: 'entry',
            privateIp: '10.88.10.10',
            exposePublic: true,
          },
        ],
        publicEntry: {
          hostKey: 'legacy-entry',
          protocols: [{ protocol: 'ssh', port: 22 }],
        },
      },
      compiledSpec: {
        schemaVersion: '1.0.0',
        resources: [],
        topologySpec: {
          vpcCidr: '10.99.0.0/16',
          networkZones: [
            {
              key: 'dmz',
              name: 'DMZ',
              purpose: 'public-entry',
              cidr: '10.99.10.0/24',
              isPublicEntry: true,
            },
          ],
          hosts: [
            {
              key: 'compiled-entry',
              name: 'Compiled Entry',
              zoneKey: 'dmz',
              role: 'entry',
              privateIp: '10.99.10.10',
              exposePublic: true,
            },
          ],
          publicEntry: {
            hostKey: 'compiled-entry',
            protocols: [{ protocol: 'ssh', port: 22 }],
          },
        },
      } as Record<string, unknown>,
    });
    await repository.publishRangeTemplate(template.id);

    const instance = await repository.createRangeInstance({
      name: '并发实例 B',
      templateId: template.id,
      status: 'pending_create',
      allocatedCidr: '10.99.0.0/16',
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
          publicIp: '47.99.0.10',
          privateIp: '10.99.10.10',
          ssh: 'ssh root@47.99.0.10',
        },
        resourceSummary: {
          mode: 'opentofu',
          vpcId: 'vpc-compiled-priority',
          topologySpec: {
            vpcCidr: '10.99.0.0/16',
            publicEntryHostKey: 'compiled-entry',
            networkZoneKeys: ['dmz'],
            hostKeys: ['compiled-entry'],
          },
        },
      }),
      destroy: jest.fn(),
    };

    const worker = new ProvisioningWorkerService(repository, provisioner, createSystemConfigServiceStub() as any);

    await worker.process(job.id);

    expect(provisioner.create).toHaveBeenCalledWith(
      expect.objectContaining({
        topologySpec: expect.objectContaining({
          vpcCidr: '10.99.0.0/16',
          publicEntry: expect.objectContaining({ hostKey: 'compiled-entry' }),
        }),
      }),
    );
  });

  it('passes published compiled resources into provisioning alongside the published topologySpec', async () => {
    const repository = createMemoryAdminRepository();
    const template = await repository.createRangeTemplate({
      name: 'Compiled Resources Template',
      slug: 'compiled-resources-template',
      version: 'v1',
      modulePathOrRef: 'infra/opentofu/modules/alicloud-enterprise-range',
      topologySpec: {
        vpcCidr: '10.66.0.0/16',
        networkZones: [
          {
            key: 'dmz',
            name: 'DMZ',
            purpose: 'public-entry',
            cidr: '10.66.10.0/24',
            isPublicEntry: true,
          },
          {
            key: 'office',
            name: 'Office',
            purpose: 'user-workstations',
            cidr: '10.66.20.0/24',
          },
          {
            key: 'server',
            name: 'Server',
            purpose: 'application-servers',
            cidr: '10.66.30.0/24',
          },
        ],
        hosts: [
          {
            key: 'host-dmz-entry',
            name: 'DMZ 入口',
            zoneKey: 'dmz',
            role: 'entry',
            privateIp: '10.66.10.10',
            exposePublic: true,
          },
          {
            key: 'host-office-client',
            name: '办公网主机',
            zoneKey: 'office',
            role: 'workstation',
            privateIp: '10.66.20.10',
          },
          {
            key: 'host-server-app',
            name: '服务器主机',
            zoneKey: 'server',
            role: 'app',
            privateIp: '10.66.30.10',
          },
        ],
        publicEntry: {
          hostKey: 'host-dmz-entry',
          protocols: [{ protocol: 'ssh', port: 22 }],
        },
      },
      compiledSpec: {
        schemaVersion: '1.0.0',
        topology: {
          vpcCidr: '10.66.0.0/16',
          publicEntryHostKey: 'host-dmz-entry',
          networkZoneKeys: ['dmz', 'office', 'server'],
          hostKeys: ['host-dmz-entry', 'host-office-client', 'host-server-app'],
        },
        resources: [
          {
            id: 'switch-dmz',
            type: 'switch',
            provider: 'alibaba_cloud',
            config: {
              label: 'DMZ 子网',
              zoneKey: 'dmz',
              cidr: '10.66.10.0/24',
              purpose: 'public-entry',
            },
          },
          {
            id: 'switch-office',
            type: 'switch',
            provider: 'alibaba_cloud',
            config: {
              label: '办公网子网',
              zoneKey: 'office',
              cidr: '10.66.20.0/24',
              purpose: 'user-workstations',
            },
          },
          {
            id: 'switch-server',
            type: 'switch',
            provider: 'alibaba_cloud',
            config: {
              label: '服务器区子网',
              zoneKey: 'server',
              cidr: '10.66.30.0/24',
              purpose: 'application-servers',
            },
          },
          {
            id: 'host-dmz-entry',
            type: 'host',
            provider: 'alibaba_cloud',
            config: {
              label: 'DMZ 入口',
              zoneKey: 'dmz',
              role: 'entry',
              privateIp: '10.66.10.10',
              exposePublic: true,
            },
          },
          {
            id: 'host-office-client',
            type: 'host',
            provider: 'alibaba_cloud',
            config: {
              label: '办公网主机',
              zoneKey: 'office',
              role: 'workstation',
              privateIp: '10.66.20.10',
            },
          },
          {
            id: 'host-server-app',
            type: 'host',
            provider: 'alibaba_cloud',
            config: {
              label: '服务器主机',
              zoneKey: 'server',
              role: 'app',
              privateIp: '10.66.30.10',
            },
          },
        ],
      } as Record<string, unknown>,
    });
    await repository.publishRangeTemplate(template.id);

    const instance = await repository.createRangeInstance({
      name: '并发实例 C',
      templateId: template.id,
      status: 'pending_create',
      allocatedCidr: '10.66.0.0/16',
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
          publicIp: '47.66.0.10',
          privateIp: '10.66.10.10',
          ssh: 'ssh root@47.66.0.10',
        },
        resourceSummary: {
          mode: 'opentofu',
          vpcId: 'vpc-compiled-resources',
          topologySpec: {
            vpcCidr: '10.66.0.0/16',
            publicEntryHostKey: 'host-dmz-entry',
            networkZoneKeys: ['dmz', 'office', 'server'],
            hostKeys: ['host-dmz-entry', 'host-office-client', 'host-server-app'],
          },
        },
      }),
      destroy: jest.fn(),
    };

    const worker = new ProvisioningWorkerService(repository, provisioner, createSystemConfigServiceStub() as any);

    await worker.process(job.id);

    expect(provisioner.create).toHaveBeenCalledWith(
      expect.objectContaining({
        topologySpec: expect.objectContaining({
          vpcCidr: '10.66.0.0/16',
          publicEntry: expect.objectContaining({ hostKey: 'host-dmz-entry' }),
        }),
        compiledSpec: expect.objectContaining({
          topology: expect.objectContaining({ vpcCidr: '10.66.0.0/16' }),
          resources: expect.arrayContaining([
            expect.objectContaining({ id: 'host-dmz-entry', type: 'host' }),
            expect.objectContaining({ id: 'switch-dmz', type: 'switch' }),
          ]),
        }),
      }),
    );
  });

  it('passes published compiledProvisionSpec into provisioning and does not require legacy compiledSpec', async () => {
    const repository = createMemoryAdminRepository();
    const template = await repository.createRangeTemplate({
      name: 'Compiled Provision Template',
      slug: 'compiled-provision-template',
      version: 'v1',
      modulePathOrRef: 'infra/opentofu/modules/alicloud-enterprise-range',
      topologySpec: {
        vpcCidr: '10.55.0.0/16',
        networkZones: [{ key: 'dmz', name: 'DMZ', purpose: 'public-entry', cidr: '10.55.10.0/24', isPublicEntry: true }],
        hosts: [{ key: 'legacy-entry', name: 'Legacy Entry', zoneKey: 'dmz', role: 'entry', privateIp: '10.55.10.10', exposePublic: true }],
        publicEntry: { hostKey: 'legacy-entry', protocols: [{ protocol: 'ssh', port: 22 }] },
      },
      compiledProvisionSpec: {
        schemaVersion: '1.0.0',
        identity: {
          templateSlug: 'compiled-provision-template',
          templateVersion: 'v1',
          cloudProvider: 'alibaba_cloud',
          iacType: 'opentofu',
        },
        topology: { vpcCidr: '10.56.0.0/16', entryHostKey: 'compiled-entry' },
        networkZones: [
          { key: 'dmz', name: 'DMZ', cidr: '10.56.10.0/24', purpose: 'public-entry', isPublicEntry: true, routeRole: 'entry' },
          { key: 'office', name: 'Office', cidr: '10.56.20.0/24', purpose: 'user-workstations', isPublicEntry: false, routeRole: 'internal' },
          { key: 'server', name: 'Server', cidr: '10.56.30.0/24', purpose: 'application-servers', isPublicEntry: false, routeRole: 'internal' },
        ],
        hosts: [
          { key: 'compiled-entry', name: 'Compiled Entry', role: 'entry', zoneKey: 'dmz', primaryPrivateIp: '10.56.10.10', exposePublic: true, networkInterfaces: [{ deviceIndex: 0, zoneKey: 'dmz', privateIp: '10.56.10.10' }] },
          { key: 'office-client', name: 'Office Client', role: 'workstation', zoneKey: 'office', primaryPrivateIp: '10.56.20.10', exposePublic: false, networkInterfaces: [{ deviceIndex: 0, zoneKey: 'office', privateIp: '10.56.20.10' }] },
          { key: 'server-app', name: 'Server App', role: 'app', zoneKey: 'server', primaryPrivateIp: '10.56.30.10', exposePublic: false, networkInterfaces: [{ deviceIndex: 0, zoneKey: 'server', privateIp: '10.56.30.10' }] },
        ],
        natGateways: [],
        eips: [],
        snatEntries: [],
        dnatEntries: [],
        securityGroupRules: [],
        aclRules: [],
        bootstrapScripts: [],
        runtimeSelections: { imagePolicies: {}, instanceTypePolicies: {} },
      } as Record<string, unknown>,
      compiledSpec: null as unknown as Record<string, unknown>,
    });
    await repository.publishRangeTemplate(template.id);

    const instance = await repository.createRangeInstance({
      name: '并发实例 D',
      templateId: template.id,
      status: 'pending_create',
      allocatedCidr: '10.56.0.0/16',
    });
    const job = await repository.createProvisionJob({ rangeInstanceId: instance.id, jobType: 'create', triggeredBy: 'admin' });
    await repository.updateRangeInstance(instance.id, { lastJobId: job.id });

    const provisioner: RangeProvisioner = {
      create: jest.fn().mockResolvedValue({
        accessEntry: { hostRole: 'dmz', publicIp: '47.56.0.10', privateIp: '10.56.10.10', ssh: 'ssh root@47.56.0.10' },
        resourceSummary: { mode: 'opentofu', vpcId: 'vpc-cps', topologySpec: { vpcCidr: '10.56.0.0/16', publicEntryHostKey: 'compiled-entry', networkZoneKeys: ['dmz', 'office', 'server'], hostKeys: ['compiled-entry', 'office-client', 'server-app'] } },
      }),
      destroy: jest.fn(),
    };

    const worker = new ProvisioningWorkerService(repository, provisioner, createSystemConfigServiceStub() as any);
    await worker.process(job.id);

    expect(provisioner.create).toHaveBeenCalledWith(
      expect.objectContaining({
        compiledProvisionSpec: expect.objectContaining({
          topology: expect.objectContaining({ vpcCidr: '10.56.0.0/16', entryHostKey: 'compiled-entry' }),
        }),
      }),
    );
  });
});
