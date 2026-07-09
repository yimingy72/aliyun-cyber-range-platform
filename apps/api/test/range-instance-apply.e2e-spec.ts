import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { ADMIN_REPOSITORY, type AdminRepository } from '../src/admin/admin.repository';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap/configure-app';
import { ProvisioningWorkerService } from '../src/provisioning/provisioning-worker.service';
import { RANGE_PROVISIONER, type RangeProvisioner } from '../src/provisioning/provisioning.types';
import { SystemConfigService } from '../src/admin/system-config.service';
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

describe('Range instance apply API', () => {
  let app: INestApplication;
  let repository: AdminRepository;
  let instanceId: string;

  beforeAll(async () => {
    process.env.ADMIN_USERNAME = 'admin';
    process.env.ADMIN_PASSWORD = 'change-me';
    process.env.ADMIN_TOKEN = 'dev-admin-token';

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(ADMIN_REPOSITORY)
      .useValue(createMemoryAdminRepository())
      .overrideProvider(SystemConfigService)
      .useValue(createSystemConfigServiceStub())
      .compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();

    repository = app.get(ADMIN_REPOSITORY);

    const template = await repository.createRangeTemplate({
      name: 'Apply Template',
      slug: 'apply-template',
      version: 'v1',
      modulePathOrRef: 'infra/opentofu/modules/alicloud-enterprise-range',
      topologySpec: {
        vpcCidr: '10.66.0.0/16',
        networkZones: [
          { key: 'dmz', name: 'DMZ', purpose: 'public-entry', cidr: '10.66.10.0/24', isPublicEntry: true },
        ],
        hosts: [
          { key: 'checker', name: 'checker', zoneKey: 'dmz', role: 'entry', privateIp: '10.66.10.10', exposePublic: true },
        ],
        publicEntry: {
          hostKey: 'checker',
          protocols: [{ protocol: 'ssh', port: 22 }],
        },
      },
    });

    const instance = await repository.createRangeInstance({
      name: 'apply-range',
      createdBy: 'admin',
      templateId: template.id,
      status: 'running',
      draftTopologyGraph: {
        schemaVersion: '1',
        nodes: [{ id: 'host-checker', kind: 'ecs', data: { label: 'checker-updated' } }],
        edges: [],
      },
      draftScenarioTemplateSpec: {
        metadata: { name: 'checker-updated' },
      },
      draftCompiledProvisionSpec: {
        topology: { vpcCidr: '10.66.0.0/16' },
      },
    });

    instanceId = instance.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('applies a saved draft through an update job only when the instance is running', async () => {
    const response = await request(app.getHttpServer())
      .post(`/admin/ranges/${instanceId}/apply`)
      .set('authorization', 'Bearer dev-admin-token')
      .send({ triggeredBy: 'admin' })
      .expect(201);

    expect(response.body.jobType).toBe('update');
  });

  it('rejects apply when the instance is not running', async () => {
    const stopped = await repository.createRangeInstance({
      name: 'stopped-range',
      createdBy: 'admin',
      templateId: 'template-stopped',
      status: 'destroyed',
      draftTopologyGraph: {
        schemaVersion: '1',
        nodes: [],
        edges: [],
      },
      draftScenarioTemplateSpec: { metadata: { name: 'stopped-range' } },
      draftCompiledProvisionSpec: { topology: { vpcCidr: '10.66.0.0/16' } },
    });

    await request(app.getHttpServer())
      .post(`/admin/ranges/${stopped.id}/apply`)
      .set('authorization', 'Bearer dev-admin-token')
      .send({ triggeredBy: 'admin' })
      .expect(409);
  });

  it('syncs the instance draft back into the source template draft without creating an update job', async () => {
    const template = await repository.createRangeTemplate({
      name: 'Sync Template',
      slug: `sync-template-${Date.now()}`,
      version: 'v1',
      modulePathOrRef: 'infra/opentofu/modules/alicloud-enterprise-range',
      topologySpec: {
        vpcCidr: '10.67.0.0/16',
        networkZones: [
          { key: 'zone-1', name: 'Zone 1', purpose: 'business-zone', cidr: '10.67.10.0/24', isPublicEntry: true },
        ],
        hosts: [
          { key: 'ecs-1', name: 'ECS 1', zoneKey: 'zone-1', role: 'host', privateIp: '10.67.10.10', exposePublic: true },
        ],
        publicEntry: {
          hostKey: 'ecs-1',
          protocols: [{ protocol: 'ssh', port: 22 }],
        },
      },
      topologyGraph: {
        schemaVersion: '2.0.0',
        nodes: [
          {
            id: 'ecs-1',
            kind: 'ecs',
            label: 'ECS 1',
            cpu: 2,
            memory: 2,
            instanceType: 'ecs.e-c1m1.large',
            instanceTypeStrategy: { mode: 'fixed', instanceType: 'ecs.e-c1m1.large' },
          },
        ],
        edges: [],
      },
      scenarioTemplateSpec: {
        metadata: {
          name: 'sync-template',
          slug: 'sync-template',
          version: 'v1',
          cloudProvider: 'alibaba_cloud',
          iacType: 'opentofu',
        },
        topology: {
          vpcCidr: '10.67.0.0/16',
          entryHostKey: 'ecs-1',
        },
        networkZones: [
          { key: 'zone-1', name: 'Zone 1', cidr: '10.67.10.0/24', purpose: 'business-zone', isPublicEntry: true },
        ],
        hosts: [
          {
            key: 'ecs-1',
            name: 'ECS 1',
            zoneKey: 'zone-1',
            role: 'host',
            image: 'ubuntu_22_04_x64_20G_alibase',
            primaryPrivateIp: '10.67.10.10',
            exposePublic: true,
            networkInterfaces: [{ zoneKey: 'zone-1', privateIp: '10.67.10.10', deviceIndex: 0 }],
            imagePolicyRef: 'ecs-1-image-policy',
            instanceTypePolicyRef: 'ecs-1-instance-type-policy',
          },
        ],
        nat: { natGateways: [], eips: [] },
        access: { portGroups: [], securityGroupRules: [], aclRules: [] },
        bootstrap: { scripts: [] },
        runtimePreferences: {
          imagePolicies: [{ key: 'ecs-1-image-policy', mode: 'fixed', imageId: 'ubuntu_22_04_x64_20G_alibase' }],
          instanceTypePolicies: [{ key: 'ecs-1-instance-type-policy', mode: 'fixed', instanceType: 'ecs.e-c1m1.large' }],
        },
      },
      compiledProvisionSpec: {
        topology: { vpcCidr: '10.67.0.0/16', entryHostKey: 'ecs-1' },
        networkZones: [{ key: 'zone-1', name: 'Zone 1', cidr: '10.67.10.0/24', purpose: 'business-zone', isPublicEntry: true }],
        hosts: [
          {
            key: 'ecs-1',
            name: 'ECS 1',
            zoneKey: 'zone-1',
            role: 'host',
            primaryPrivateIp: '10.67.10.10',
            exposePublic: true,
            networkInterfaces: [{ zoneKey: 'zone-1', privateIp: '10.67.10.10', deviceIndex: 0 }],
            imagePolicyKey: 'ecs-1-image-policy',
            instanceTypePolicyKey: 'ecs-1-instance-type-policy',
          },
        ],
        runtimeSelections: {
          imagePolicies: {
            'ecs-1-image-policy': { key: 'ecs-1-image-policy', mode: 'fixed', imageId: 'ubuntu_22_04_x64_20G_alibase' },
          },
          instanceTypePolicies: {
            'ecs-1-instance-type-policy': { key: 'ecs-1-instance-type-policy', mode: 'fixed', instanceType: 'ecs.e-c1m1.large' },
          },
        },
      },
      compiledSpec: {
        schemaVersion: '1.0.0',
        resources: [
          {
            id: 'ecs-1',
            type: 'host',
            provider: 'alibaba_cloud',
            config: {
              cpu: 2,
              memory: 2,
              instanceType: 'ecs.e-c1m1.large',
              instanceTypeStrategy: { mode: 'fixed', instanceType: 'ecs.e-c1m1.large' },
            },
          },
        ],
      },
    });

    const instance = await repository.createRangeInstance({
      name: 'sync-range',
      createdBy: 'admin',
      templateId: template.id,
      status: 'running',
      runtimeTopologyGraph: template.topologyGraph as Record<string, unknown>,
      runtimeScenarioTemplateSpec: template.scenarioTemplateSpec as Record<string, unknown>,
      runtimeCompiledProvisionSpec: template.compiledProvisionSpec as Record<string, unknown>,
      draftTopologyGraph: {
        schemaVersion: '2.0.0',
        nodes: [
          {
            id: 'ecs-1',
            kind: 'ecs',
            label: 'ECS 1',
            cpu: 2,
            memory: 4,
            instanceType: 'ecs.e-c1m2.large',
            instanceTypeStrategy: { mode: 'fixed', instanceType: 'ecs.e-c1m2.large' },
          },
        ],
        edges: [],
      },
      draftScenarioTemplateSpec: {
        metadata: {
          name: 'sync-template',
          slug: 'sync-template',
          version: 'v1',
          cloudProvider: 'alibaba_cloud',
          iacType: 'opentofu',
        },
        topology: { vpcCidr: '10.67.0.0/16', entryHostKey: 'ecs-1' },
        networkZones: [
          { key: 'zone-1', name: 'Zone 1', cidr: '10.67.10.0/24', purpose: 'business-zone', isPublicEntry: true },
        ],
        hosts: [
          {
            key: 'ecs-1',
            name: 'ECS 1',
            zoneKey: 'zone-1',
            role: 'host',
            image: 'ubuntu_22_04_x64_20G_alibase',
            primaryPrivateIp: '10.67.10.10',
            exposePublic: true,
            networkInterfaces: [{ zoneKey: 'zone-1', privateIp: '10.67.10.10', deviceIndex: 0 }],
            imagePolicyRef: 'ecs-1-image-policy',
            instanceTypePolicyRef: 'ecs-1-instance-type-policy',
          },
        ],
        nat: { natGateways: [], eips: [] },
        access: { portGroups: [], securityGroupRules: [], aclRules: [] },
        bootstrap: { scripts: [] },
        runtimePreferences: {
          imagePolicies: [{ key: 'ecs-1-image-policy', mode: 'fixed', imageId: 'ubuntu_22_04_x64_20G_alibase' }],
          instanceTypePolicies: [{ key: 'ecs-1-instance-type-policy', mode: 'fixed', instanceType: 'ecs.e-c1m2.large' }],
        },
      },
      draftCompiledProvisionSpec: {
        topology: { vpcCidr: '10.67.0.0/16', entryHostKey: 'ecs-1' },
        networkZones: [{ key: 'zone-1', name: 'Zone 1', cidr: '10.67.10.0/24', purpose: 'business-zone', isPublicEntry: true }],
        hosts: [
          {
            key: 'ecs-1',
            name: 'ECS 1',
            zoneKey: 'zone-1',
            role: 'host',
            primaryPrivateIp: '10.67.10.10',
            exposePublic: true,
            networkInterfaces: [{ zoneKey: 'zone-1', privateIp: '10.67.10.10', deviceIndex: 0 }],
            imagePolicyKey: 'ecs-1-image-policy',
            instanceTypePolicyKey: 'ecs-1-instance-type-policy',
          },
        ],
        runtimeSelections: {
          imagePolicies: {
            'ecs-1-image-policy': { key: 'ecs-1-image-policy', mode: 'fixed', imageId: 'ubuntu_22_04_x64_20G_alibase' },
          },
          instanceTypePolicies: {
            'ecs-1-instance-type-policy': { key: 'ecs-1-instance-type-policy', mode: 'fixed', instanceType: 'ecs.e-c1m2.large' },
          },
        },
      },
    });

    const response = await request(app.getHttpServer())
      .post(`/admin/ranges/${instance.id}/sync-template`)
      .set('authorization', 'Bearer dev-admin-token')
      .send({ triggeredBy: 'admin' })
      .expect(201);

    expect(response.body.id).toBe(template.id);

    const updatedTemplate = await repository.getRangeTemplateById(template.id);

    expect(updatedTemplate?.topologyGraph).toEqual(
      expect.objectContaining({
        nodes: expect.arrayContaining([
          expect.objectContaining({
            id: 'ecs-1',
            memory: 4,
            instanceType: 'ecs.e-c1m2.large',
          }),
        ]),
      }),
    );
    expect(updatedTemplate?.currentDraftVersion?.compiledSpec).toEqual(
      expect.objectContaining({
        resources: expect.arrayContaining([
          expect.objectContaining({
            id: 'ecs-1',
            config: expect.objectContaining({
              memory: 4,
              instanceType: 'ecs.e-c1m2.large',
            }),
          }),
        ]),
      }),
    );
  });
});

describe('ProvisioningWorkerService update flow', () => {
  it('persists runtime template snapshots after a create job succeeds', async () => {
    const repository = createMemoryAdminRepository();
    const provisioner: RangeProvisioner = {
      create: jest.fn().mockResolvedValue({
        accessEntry: {
          hostRole: 'entry',
          publicIp: '1.2.3.4',
          privateIp: '10.44.10.10',
          ssh: 'ssh root@1.2.3.4',
        },
        resourceSummary: {
          mode: 'opentofu',
          vpcId: 'vpc-create',
        },
      }),
      destroy: jest.fn().mockResolvedValue(undefined),
    };
    const service = new ProvisioningWorkerService(
      repository,
      provisioner,
      createSystemConfigServiceStub() as never,
    );

    const template = await repository.createRangeTemplate({
      name: 'Worker Create Template',
      slug: 'worker-create-template',
      version: 'v1',
      modulePathOrRef: 'infra/opentofu/modules/alicloud-enterprise-range',
      topologyGraph: {
        schemaVersion: '2.0.0',
        nodes: [{ id: 'ecs-1', kind: 'ecs', label: 'ECS 1', cpu: 2, memory: 2 }],
        edges: [],
      },
      scenarioTemplateSpec: {
        metadata: { name: 'worker-create-template' },
      },
      compiledProvisionSpec: {
        topology: {
          vpcCidr: '10.44.0.0/16',
          entryHostKey: 'ecs-1',
        },
        networkZones: [{ key: 'zone-1', name: 'ZONE 1', cidr: '10.44.10.0/24', purpose: 'business-zone' }],
        hosts: [{ key: 'ecs-1', name: 'ECS 1', zoneKey: 'zone-1', role: 'host', primaryPrivateIp: '10.44.10.10', exposePublic: true }],
      },
      topologySpec: {
        vpcCidr: '10.44.0.0/16',
        networkZones: [
          { key: 'zone-1', name: 'ZONE 1', purpose: 'business-zone', cidr: '10.44.10.0/24' },
        ],
        hosts: [
          { key: 'ecs-1', name: 'ECS 1', zoneKey: 'zone-1', role: 'host', privateIp: '10.44.10.10', exposePublic: true },
        ],
        publicEntry: {
          hostKey: 'ecs-1',
          protocols: [{ protocol: 'ssh', port: 22 }],
        },
      },
    });

    const instance = await repository.createRangeInstance({
      name: 'worker-create-range',
      createdBy: 'admin',
      templateId: template.id,
      sourceTemplateVersionId: template.currentDraftVersionId,
      status: 'pending_create',
    });

    const job = await repository.createProvisionJob({
      rangeInstanceId: instance.id,
      jobType: 'create',
      triggeredBy: 'admin',
    });

    await service.process(job.id);

    const updated = await repository.getRangeInstanceById(instance.id);

    expect(updated?.status).toBe('running');
    expect(updated?.runtimeTopologyGraph).toEqual(template.topologyGraph);
    expect(updated?.runtimeScenarioTemplateSpec).toEqual(template.scenarioTemplateSpec);
    expect(updated?.runtimeCompiledProvisionSpec).toEqual(template.compiledProvisionSpec);
  });

  it('promotes instance draft snapshots into runtime snapshots after an update job succeeds', async () => {
    const repository = createMemoryAdminRepository();
    const provisioner: RangeProvisioner = {
      create: jest.fn().mockResolvedValue({
        accessEntry: {
          hostRole: 'entry',
          publicIp: '1.2.3.4',
          privateIp: '10.66.10.10',
          ssh: 'ssh root@1.2.3.4',
        },
        resourceSummary: {
          mode: 'opentofu',
          vpcId: 'vpc-update',
        },
      }),
      destroy: jest.fn().mockResolvedValue(undefined),
    };
    const service = new ProvisioningWorkerService(
      repository,
      provisioner,
      createSystemConfigServiceStub() as never,
    );

    const template = await repository.createRangeTemplate({
      name: 'Worker Update Template',
      slug: 'worker-update-template',
      version: 'v1',
      modulePathOrRef: 'infra/opentofu/modules/alicloud-enterprise-range',
      topologySpec: {
        vpcCidr: '10.55.0.0/16',
        networkZones: [
          { key: 'dmz', name: 'DMZ', purpose: 'public-entry', cidr: '10.55.10.0/24', isPublicEntry: true },
        ],
        hosts: [
          { key: 'checker', name: 'checker', zoneKey: 'dmz', role: 'entry', privateIp: '10.55.10.10', exposePublic: true },
        ],
        publicEntry: {
          hostKey: 'checker',
          protocols: [{ protocol: 'ssh', port: 22 }],
        },
      },
      compiledProvisionSpec: {
        topology: {
          vpcCidr: '10.55.0.0/16',
          entryHostKey: 'checker',
        },
        networkZones: [{ key: 'dmz', name: 'DMZ', cidr: '10.55.10.0/24', purpose: 'public-entry', isPublicEntry: true }],
        hosts: [{ key: 'checker', name: 'checker', zoneKey: 'dmz', role: 'entry', primaryPrivateIp: '10.55.10.10', exposePublic: true }],
      },
    });

    const instance = await repository.createRangeInstance({
      name: 'worker-update-range',
      createdBy: 'admin',
      templateId: template.id,
      sourceTemplateVersionId: template.currentDraftVersionId,
      status: 'running',
      runtimeTopologyGraph: {
        schemaVersion: '1',
        nodes: [{ id: 'host-checker', kind: 'ecs', data: { label: 'checker' } }],
        edges: [],
      },
      runtimeScenarioTemplateSpec: { metadata: { name: 'checker' } },
      runtimeCompiledProvisionSpec: {
        topology: {
          vpcCidr: '10.55.0.0/16',
          entryHostKey: 'checker',
        },
        networkZones: [{ key: 'dmz', name: 'DMZ', cidr: '10.55.10.0/24', purpose: 'public-entry', isPublicEntry: true }],
        hosts: [{ key: 'checker', name: 'checker', zoneKey: 'dmz', role: 'entry', primaryPrivateIp: '10.55.10.10', exposePublic: true }],
      },
      draftTopologyGraph: {
        schemaVersion: '1',
        nodes: [{ id: 'host-checker', kind: 'ecs', data: { label: 'checker-updated' } }],
        edges: [],
      },
      draftScenarioTemplateSpec: { metadata: { name: 'checker-updated' } },
      draftCompiledProvisionSpec: {
        topology: {
          vpcCidr: '10.55.0.0/16',
          entryHostKey: 'checker',
        },
        networkZones: [{ key: 'dmz', name: 'DMZ', cidr: '10.55.10.0/24', purpose: 'public-entry', isPublicEntry: true }],
        hosts: [{ key: 'checker', name: 'checker-updated', zoneKey: 'dmz', role: 'entry', primaryPrivateIp: '10.55.10.10', exposePublic: true }],
      },
    });

    const job = await repository.createProvisionJob({
      rangeInstanceId: instance.id,
      jobType: 'update',
      triggeredBy: 'admin',
    });

    await service.process(job.id);

    const updated = await repository.getRangeInstanceById(instance.id);

    expect(provisioner.create).toHaveBeenCalledWith(
      expect.objectContaining({
        rangeInstanceId: instance.id,
        preserveWorkspaceState: true,
      }),
    );
    expect(updated?.runtimeTopologyGraph).toEqual(
      expect.objectContaining({
        nodes: expect.arrayContaining([
          expect.objectContaining({
            data: expect.objectContaining({ label: 'checker-updated' }),
          }),
        ]),
      }),
    );
    expect(updated?.draftTopologyGraph).toBeNull();
    expect(updated?.draftScenarioTemplateSpec).toBeNull();
    expect(updated?.draftCompiledProvisionSpec).toBeNull();
  });
});
