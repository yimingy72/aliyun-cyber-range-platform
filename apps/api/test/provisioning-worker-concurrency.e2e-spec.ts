import type { ProvisionJobRecord, RangeInstanceRecord } from '../src/admin/admin.repository';
import { ProvisioningWorkerService } from '../src/provisioning/provisioning-worker.service';
import type { RangeProvisioner } from '../src/provisioning/provisioning.types';
import { SingleInstanceBatchExecutionService } from '../src/admin/single-instance-batch-execution.service';
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
  it('preserves the OpenTofu state directory when retrying a failed range create', async () => {
    const repository = createMemoryAdminRepository();
    const template = await repository.createRangeTemplate({
      name: 'Retry state template',
      slug: 'retry-state-template',
      version: 'v1',
      modulePathOrRef: 'infra/opentofu/modules/alicloud-enterprise-range',
      topologySpec: {
        vpcCidr: '10.91.0.0/16',
        networkZones: [{ key: 'dmz', name: 'DMZ', purpose: 'public-entry', cidr: '10.91.10.0/24' }],
        hosts: [{ key: 'entry', name: 'Entry', zoneKey: 'dmz', role: 'entry', privateIp: '10.91.10.10' }],
        publicEntry: { hostKey: 'entry', protocols: [{ protocol: 'ssh', port: 22 }] },
      },
    });
    const instance = await repository.createRangeInstance({
      name: 'retry-state-range',
      templateId: template.id,
      status: 'pending_create',
      allocatedCidr: '10.91.0.0/16',
    });
    const job = await repository.createProvisionJob({
      rangeInstanceId: instance.id,
      jobType: 'retry',
      triggeredBy: 'admin',
      retryCount: 1,
    });
    await repository.updateRangeInstance(instance.id, { lastJobId: job.id });

    const create = jest.fn().mockResolvedValue({
      accessEntry: {
        hostRole: 'entry',
        publicIp: null,
        privateIp: '10.91.10.10',
        ssh: null,
      },
      resourceSummary: { mode: 'opentofu', hostIds: { entry: 'i-retry-state' } },
    });
    const worker = new ProvisioningWorkerService(
      repository,
      { create, destroy: jest.fn() } as unknown as RangeProvisioner,
      createSystemConfigServiceStub() as any,
    );

    await worker.process(job.id);

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        rangeInstanceId: instance.id,
        preserveWorkspaceState: true,
      }),
    );
  });

  it('destroys partially created range resources when a create job fails', async () => {
    const repository = createMemoryAdminRepository();
    const template = await repository.createRangeTemplate({
      name: 'Failed create cleanup template',
      slug: 'failed-create-cleanup-template',
      version: 'v1',
      modulePathOrRef: 'infra/opentofu/modules/alicloud-enterprise-range',
      topologySpec: {
        vpcCidr: '10.92.0.0/16',
        networkZones: [{ key: 'dmz', name: 'DMZ', purpose: 'public-entry', cidr: '10.92.10.0/24' }],
        hosts: [{ key: 'entry', name: 'Entry', zoneKey: 'dmz', role: 'entry', privateIp: '10.92.10.10' }],
        publicEntry: { hostKey: 'entry', protocols: [{ protocol: 'ssh', port: 22 }] },
      },
    });
    const instance = await repository.createRangeInstance({
      name: 'failed-create-cleanup-range',
      templateId: template.id,
      status: 'pending_create',
      allocatedCidr: '10.92.0.0/16',
    });
    const job = await repository.createProvisionJob({
      rangeInstanceId: instance.id,
      jobType: 'create',
      triggeredBy: 'admin',
    });
    await repository.updateRangeInstance(instance.id, { lastJobId: job.id });

    const create = jest.fn().mockRejectedValue(new Error('OpenTofu apply partially created resources.'));
    const destroy = jest.fn().mockResolvedValue(undefined);
    const worker = new ProvisioningWorkerService(
      repository,
      { create, destroy } as unknown as RangeProvisioner,
      createSystemConfigServiceStub() as any,
    );

    await worker.process(job.id);

    expect(destroy).toHaveBeenCalledWith(
      expect.objectContaining({
        rangeInstanceId: instance.id,
        templateModulePath: template.modulePathOrRef,
        allocatedCidr: instance.allocatedCidr,
      }),
    );
    await expect(repository.getRangeInstanceById(instance.id)).resolves.toEqual(
      expect.objectContaining({
        status: 'create_failed',
        errorSummary: 'OpenTofu apply partially created resources.',
      }),
    );
  });

  it('limits single-instance batch execution concurrency to three', async () => {
    const repository = createMemoryAdminRepository();
    const executor = new SingleInstanceBatchExecutionService(
      repository,
      createSystemConfigServiceStub() as any,
    );
    let inFlight = 0;
    let maxInFlight = 0;

    await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        executor.runWithSlot(async () => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 25 + index));
          inFlight -= 1;
        }),
      ),
    );

    expect(maxInFlight).toBe(3);
  });

  it('normalizes numeric-prefixed platform names before submitting single instances to Aliyun', async () => {
    const repository = createMemoryAdminRepository();
    const requestBodies: string[] = [];
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const body = typeof init?.body === 'string' ? init.body : '';
      requestBodies.push(body);
      return new Response(
        JSON.stringify({
          InstanceIdSets: {
            InstanceIdSet: ['i-numeric-name-01'],
          },
        }),
        { status: 200 },
      );
    });

    try {
      const profile = await repository.upsertSingleInstanceNetworkProfile({
        provider: 'alibaba_cloud',
        regionId: 'cn-hangzhou',
        zoneId: 'cn-hangzhou-h',
        vpcId: 'vpc-numeric-name',
        vpcCidr: '10.200.0.0/16',
        vswitchIds: ['vsw-numeric-name'],
        vswitchCidrs: ['10.200.1.0/24'],
        securityGroupId: 'sg-numeric-name',
        securityGroupName: 'default-open-all',
      });
      const batch = await repository.createSingleInstanceBatch({
        name: '4层网络靶场-test',
        platformImageAssetId: 'platform-image-1',
        imageId: 'm-123',
        imageDisplayName: 'Ubuntu 24.04',
        cpu: 2,
        memory: 2,
        systemDiskSize: 40,
        quantity: 1,
        createdBy: 'admin',
        expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1_000),
      });
      const instance = await repository.createRangeInstance({
        name: '4层网络靶场-test-01',
        createdBy: 'admin',
        instanceMode: 'single',
        singleInstanceBatchId: batch.id,
        status: 'pending_create',
        expiresAt: batch.expiresAt?.toISOString(),
        runtimeCredentials: {
          'single-ecs-1': {
            username: 'root',
            password: 'Aa123456!',
          },
        },
        singleInstanceConfig: {
          baseName: batch.name,
          quantityIndex: 1,
          hostKey: 'single-ecs-1',
          hostName: 'numeric-name-host-01',
          platformImageAssetId: batch.platformImageAssetId,
          imageId: batch.imageId,
          imageDisplayName: batch.imageDisplayName,
          cpu: batch.cpu,
          memory: batch.memory,
          systemDiskSize: batch.systemDiskSize,
          assignedVswitchId: profile.vswitchIds[0],
        },
      });
      const job = await repository.createProvisionJob({
        rangeInstanceId: instance.id,
        jobType: 'create',
        triggeredBy: 'admin',
      });
      const executor = new SingleInstanceBatchExecutionService(
        repository,
        createSystemConfigServiceStub() as any,
      );

      await executor.executeCreateBatch([{ instance, job }]);

      expect(requestBodies).toHaveLength(1);
      expect(new URLSearchParams(requestBodies[0]).get('InstanceName')).toBe('cr-4层网络靶场-test-01');
      await expect(repository.getRangeInstanceById(instance.id)).resolves.toEqual(
        expect.objectContaining({
          name: '4层网络靶场-test-01',
          status: 'creating',
        }),
      );
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('deletes tagged ECS resources when a single-instance create request fails', async () => {
    const repository = createMemoryAdminRepository();
    const requestedUrls: string[] = [];
    const requestBodies: string[] = [];
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      const body = typeof init?.body === 'string' ? init.body : '';
      requestedUrls.push(url);
      requestBodies.push(body);

      if (body.includes('Action=RunInstances')) {
        return new Response(JSON.stringify({ Code: 'InternalError' }), { status: 500 });
      }

      if (url.includes('Action=DescribeInstances')) {
        return new Response(
          JSON.stringify({
            Instances: {
              Instance: [
                {
                  InstanceId: 'i-single-create-uncertain',
                },
              ],
            },
          }),
          { status: 200 },
        );
      }

      if (body.includes('Action=DeleteInstances')) {
        return new Response(JSON.stringify({ RequestId: 'delete-ok' }), { status: 200 });
      }

      throw new Error(`Unexpected Aliyun request: ${url} ${body}`);
    });

    try {
      const profile = await repository.upsertSingleInstanceNetworkProfile({
        provider: 'alibaba_cloud',
        regionId: 'cn-hangzhou',
        zoneId: 'cn-hangzhou-h',
        vpcId: 'vpc-single-cleanup',
        vpcCidr: '10.200.0.0/16',
        vswitchIds: ['vsw-single-cleanup'],
        vswitchCidrs: ['10.200.1.0/24'],
        securityGroupId: 'sg-single-cleanup',
        securityGroupName: 'default-open-all',
      });
      const batch = await repository.createSingleInstanceBatch({
        name: 'single-cleanup',
        platformImageAssetId: 'platform-image-1',
        imageId: 'm-123',
        imageDisplayName: 'Ubuntu 24.04',
        cpu: 2,
        memory: 2,
        systemDiskSize: 40,
        quantity: 1,
        createdBy: 'admin',
        expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1_000),
      });
      const instance = await repository.createRangeInstance({
        name: 'single-cleanup',
        createdBy: 'admin',
        instanceMode: 'single',
        singleInstanceBatchId: batch.id,
        status: 'pending_create',
        expiresAt: batch.expiresAt?.toISOString(),
        runtimeCredentials: {
          'single-ecs-1': {
            username: 'root',
            password: 'Aa123456!',
          },
        },
        singleInstanceConfig: {
          baseName: batch.name,
          quantityIndex: 1,
          hostKey: 'single-ecs-1',
          hostName: 'single-cleanup-host',
          platformImageAssetId: batch.platformImageAssetId,
          imageId: batch.imageId,
          imageDisplayName: batch.imageDisplayName,
          cpu: batch.cpu,
          memory: batch.memory,
          systemDiskSize: batch.systemDiskSize,
          assignedVswitchId: profile.vswitchIds[0],
        },
      });
      const job = await repository.createProvisionJob({
        rangeInstanceId: instance.id,
        jobType: 'create',
        triggeredBy: 'admin',
      });
      const executor = new SingleInstanceBatchExecutionService(
        repository,
        createSystemConfigServiceStub() as any,
      );

      await executor.executeCreateBatch([{ instance, job }]);

      const describeUrl = requestedUrls.find((url) => url.includes('Action=DescribeInstances'));
      expect(describeUrl).toBeDefined();
      const describeRequest = new URL(describeUrl!);
      expect(describeRequest.searchParams.get('Tag.1.Key')).toBe('RangeInstanceId');
      expect(describeRequest.searchParams.get('Tag.1.Value')).toBe(instance.id);
      expect(requestBodies).toEqual(
        expect.arrayContaining([
          expect.stringContaining('Action=DeleteInstances'),
          expect.stringContaining('InstanceId.1=i-single-create-uncertain'),
        ]),
      );
      await expect(repository.getRangeInstanceById(instance.id)).resolves.toEqual(
        expect.objectContaining({
          status: 'create_failed',
        }),
      );
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('includes the claimed single-instance destroy job even when that instance has not persisted lastJobId yet', async () => {
    const repository = createMemoryAdminRepository();
    const batch = await repository.createSingleInstanceBatch({
      name: 'fallback-batch',
      platformImageAssetId: 'platform-image-1',
      imageId: 'm-123',
      imageDisplayName: 'Ubuntu 24.04',
      cpu: 2,
      memory: 2,
      systemDiskSize: 40,
      quantity: 2,
      createdBy: 'admin',
      expiresAt: new Date('2026-07-10T12:00:00.000Z'),
    });

    const first = await repository.createRangeInstance({
      name: 'fallback-01',
      createdBy: 'admin',
      instanceMode: 'single',
      status: 'running',
      singleInstanceBatchId: batch.id,
      singleInstanceConfig: {
        baseName: 'fallback',
        quantityIndex: 1,
        hostKey: 'single-ecs-1',
        hostName: 'fallback-01',
        platformImageAssetId: 'platform-image-1',
        imageId: 'm-123',
        imageDisplayName: 'Ubuntu 24.04',
        cpu: 2,
        memory: 2,
        systemDiskSize: 40,
      },
      resourceSummary: {
        mode: 'ecs-native',
        hostIds: {
          'single-ecs-1': 'i-fallback-01',
        },
      },
    });
    const firstJob = await repository.createProvisionJob({
      rangeInstanceId: first.id,
      jobType: 'destroy',
      triggeredBy: 'admin',
    });

    const second = await repository.createRangeInstance({
      name: 'fallback-02',
      createdBy: 'admin',
      instanceMode: 'single',
      status: 'pending_destroy',
      singleInstanceBatchId: batch.id,
      singleInstanceConfig: {
        baseName: 'fallback',
        quantityIndex: 2,
        hostKey: 'single-ecs-2',
        hostName: 'fallback-02',
        platformImageAssetId: 'platform-image-1',
        imageId: 'm-123',
        imageDisplayName: 'Ubuntu 24.04',
        cpu: 2,
        memory: 2,
        systemDiskSize: 40,
      },
      resourceSummary: {
        mode: 'ecs-native',
        hostIds: {
          'single-ecs-2': 'i-fallback-02',
        },
      },
    });
    const secondJob = await repository.createProvisionJob({
      rangeInstanceId: second.id,
      jobType: 'destroy',
      triggeredBy: 'admin',
    });

    await repository.updateRangeInstance(second.id, {
      lastJobId: secondJob.id,
    });

    const executeDestroyBatch = jest.fn().mockResolvedValue(undefined);
    const worker = new ProvisioningWorkerService(
      repository,
      {
        create: jest.fn(),
        destroy: jest.fn(),
      } as any,
      createSystemConfigServiceStub() as any,
      {
        executeCreateBatch: jest.fn(),
        executeDestroyBatch,
      } as any,
    );

    await worker.process(firstJob.id);

    expect(executeDestroyBatch).toHaveBeenCalledTimes(1);
    expect(executeDestroyBatch.mock.calls[0][0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          instance: expect.objectContaining({ id: first.id }),
          job: expect.objectContaining({ id: firstJob.id }),
        }),
        expect.objectContaining({
          instance: expect.objectContaining({ id: second.id }),
          job: expect.objectContaining({ id: secondJob.id }),
        }),
      ]),
    );
  });

  it('schedules a refresh_status job when single-instance create succeeds without a public ip', async () => {
    const repository = createMemoryAdminRepository();
    const batch = await repository.createSingleInstanceBatch({
      name: 'refresh-batch',
      platformImageAssetId: 'platform-image-1',
      imageId: 'm-123',
      imageDisplayName: 'Ubuntu 24.04',
      cpu: 2,
      memory: 2,
      systemDiskSize: 40,
      quantity: 1,
      createdBy: 'admin',
      expiresAt: new Date('2026-07-10T12:00:00.000Z'),
    });

    const instance = await repository.createRangeInstance({
      name: 'refresh-01',
      createdBy: 'admin',
      instanceMode: 'single',
      status: 'pending_create',
      singleInstanceBatchId: batch.id,
      singleInstanceConfig: {
        baseName: 'refresh',
        quantityIndex: 1,
        hostKey: 'single-ecs-1',
        hostName: 'refresh-01',
        platformImageAssetId: 'platform-image-1',
        imageId: 'm-123',
        imageDisplayName: 'Ubuntu 24.04',
        cpu: 2,
        memory: 2,
        systemDiskSize: 40,
      },
      resourceSummary: {
        mode: 'ecs-native',
        hostIds: {
          'single-ecs-1': 'i-refresh-01',
        },
      },
    });
    const createJob = await repository.createProvisionJob({
      rangeInstanceId: instance.id,
      jobType: 'create',
      triggeredBy: 'admin',
    });

    await repository.updateRangeInstance(instance.id, {
      lastJobId: createJob.id,
    });

    const worker = new ProvisioningWorkerService(
      repository,
      {
        create: jest.fn(),
        destroy: jest.fn(),
      } as any,
      createSystemConfigServiceStub() as any,
      {
        executeCreateBatch: jest.fn().mockImplementation(async (items: Array<{ instance: RangeInstanceRecord; job: ProvisionJobRecord }>) => {
          const [item] = items;

          await repository.updateRangeInstance(item.instance.id, {
            status: 'running',
            accessEntry: {
              hostRole: 'single-ecs-1',
              publicIp: null,
              privateIp: '10.66.10.10',
              ssh: null,
            },
            resourceSummary: {
              mode: 'ecs-native',
              hostIds: {
                'single-ecs-1': 'i-refresh-01',
              },
            },
          });
          await repository.updateProvisionJob(item.job.id, {
            status: 'succeeded',
            finishedAt: new Date(),
            errorSummary: null,
          });
        }),
        executeDestroyBatch: jest.fn(),
        refreshSingleInstanceAccessEntry: jest.fn(),
      } as any,
    );
    const dispatchSpy = jest.spyOn(worker, 'dispatch').mockImplementation(() => {});

    try {
      await worker.process(createJob.id);
      const refreshJobs = (await repository.listProvisionJobs()).filter((job) => job.jobType === 'refresh_status');

      expect(refreshJobs).toHaveLength(1);
      expect(refreshJobs[0]).toEqual(
        expect.objectContaining({
          rangeInstanceId: instance.id,
          status: 'pending',
        }),
      );
      expect(dispatchSpy).toHaveBeenCalledWith(refreshJobs[0].id);
    } finally {
      dispatchSpy.mockRestore();
    }
  });

  it('processes a refresh_status job and backfills the single-instance public ip', async () => {
    const repository = createMemoryAdminRepository();
    const batch = await repository.createSingleInstanceBatch({
      name: 'refresh-process-batch',
      platformImageAssetId: 'platform-image-1',
      imageId: 'm-123',
      imageDisplayName: 'Ubuntu 24.04',
      cpu: 2,
      memory: 2,
      systemDiskSize: 40,
      quantity: 1,
      createdBy: 'admin',
      expiresAt: new Date('2026-07-10T12:00:00.000Z'),
    });

    const instance = await repository.createRangeInstance({
      name: 'refresh-process-01',
      createdBy: 'admin',
      instanceMode: 'single',
      status: 'running',
      singleInstanceBatchId: batch.id,
      singleInstanceConfig: {
        baseName: 'refresh-process',
        quantityIndex: 1,
        hostKey: 'single-ecs-1',
        hostName: 'refresh-process-01',
        platformImageAssetId: 'platform-image-1',
        imageId: 'm-123',
        imageDisplayName: 'Ubuntu 24.04',
        cpu: 2,
        memory: 2,
        systemDiskSize: 40,
      },
      accessEntry: {
        hostRole: 'single-ecs-1',
        publicIp: null,
        privateIp: '10.77.10.10',
        ssh: null,
      },
      resourceSummary: {
        mode: 'ecs-native',
        hostIds: {
          'single-ecs-1': 'i-refresh-process-01',
        },
      },
    });
    const refreshJob = await repository.createProvisionJob({
      rangeInstanceId: instance.id,
      jobType: 'refresh_status',
      triggeredBy: 'admin',
    });

    const refreshSingleInstanceAccessEntry = jest.fn().mockImplementation(async (item: {
      instance: RangeInstanceRecord;
      job: ProvisionJobRecord;
    }) => {
      await repository.updateRangeInstance(item.instance.id, {
        accessEntry: {
          hostRole: 'single-ecs-1',
          publicIp: '47.99.0.10',
          privateIp: '10.77.10.10',
          ssh: 'ssh root@47.99.0.10',
        },
      });
      await repository.updateProvisionJob(item.job.id, {
        status: 'succeeded',
        finishedAt: new Date(),
        errorSummary: null,
      });
    });
    const worker = new ProvisioningWorkerService(
      repository,
      {
        create: jest.fn(),
        destroy: jest.fn(),
      } as any,
      createSystemConfigServiceStub() as any,
      {
        executeCreateBatch: jest.fn(),
        executeDestroyBatch: jest.fn(),
        refreshSingleInstanceAccessEntry,
      } as any,
    );

    await worker.process(refreshJob.id);

    expect(refreshSingleInstanceAccessEntry).toHaveBeenCalledTimes(1);
    await expect(repository.getRangeInstanceById(instance.id)).resolves.toEqual(
      expect.objectContaining({
        id: instance.id,
        accessEntry: expect.objectContaining({
          publicIp: '47.99.0.10',
          ssh: 'ssh root@47.99.0.10',
        }),
      }),
    );
    await expect(repository.getProvisionJobById(refreshJob.id)).resolves.toEqual(
      expect.objectContaining({
        id: refreshJob.id,
        status: 'succeeded',
        errorSummary: null,
      }),
    );
  });

  it('marks a failed destroy retry back to destroy_failed instead of create_failed', async () => {
    const repository = createMemoryAdminRepository();
    const template = await repository.createRangeTemplate({
      name: 'Destroy Retry Failure Template',
      slug: 'destroy-retry-failure-template',
      version: 'v1',
      modulePathOrRef: 'infra/opentofu/modules/alicloud-enterprise-range',
      topologySpec: {
        vpcCidr: '10.80.0.0/16',
        networkZones: [
          {
            key: 'dmz',
            name: 'DMZ',
            purpose: 'public-entry',
            cidr: '10.80.10.0/24',
            isPublicEntry: true,
          },
        ],
        hosts: [
          {
            key: 'ecs-1',
            name: 'ECS 1',
            zoneKey: 'dmz',
            role: 'entry',
            privateIp: '10.80.10.10',
            exposePublic: true,
          },
        ],
        publicEntry: {
          hostKey: 'ecs-1',
          protocols: [{ protocol: 'ssh', port: 22 }],
        },
      },
    });
    await repository.publishRangeTemplateToPlatform(template.id, template.revision);

    const instance = await repository.createRangeInstance({
      name: '并发实例 Destroy Retry',
      templateId: template.id,
      status: 'pending_destroy',
      allocatedCidr: '10.80.0.0/16',
      resourceSummary: {
        mode: 'opentofu',
        workspaceDir: '/tmp/destroy-retry-workspace',
      },
    });
    const job = await repository.createProvisionJob({
      rangeInstanceId: instance.id,
      jobType: 'retry',
      triggeredBy: 'admin',
      retryCount: 1,
    });

    await repository.updateRangeInstance(instance.id, {
      lastJobId: job.id,
    });

    const provisioner: RangeProvisioner = {
      create: jest.fn(),
      destroy: jest.fn().mockRejectedValue(new Error('simulated destroy failure')),
    };

    const worker = new ProvisioningWorkerService(repository, provisioner, createSystemConfigServiceStub() as any);

    await worker.process(job.id);

    await expect(repository.getRangeInstanceById(instance.id)).resolves.toEqual(
      expect.objectContaining({
        id: instance.id,
        status: 'destroy_failed',
        errorSummary: 'simulated destroy failure',
      }),
    );
  });

  it('marks a destroy job as destroy_failed when post-destroy cloud verification still finds resources', async () => {
    const repository = createMemoryAdminRepository();
    const template = await repository.createRangeTemplate({
      name: 'Destroy Verification Template',
      slug: 'destroy-verification-template',
      version: 'v1',
      modulePathOrRef: 'infra/opentofu/modules/alicloud-enterprise-range',
      topologySpec: {
        vpcCidr: '10.81.0.0/16',
        networkZones: [
          {
            key: 'dmz',
            name: 'DMZ',
            purpose: 'public-entry',
            cidr: '10.81.10.0/24',
            isPublicEntry: true,
          },
        ],
        hosts: [
          {
            key: 'ecs-1',
            name: 'ECS 1',
            zoneKey: 'dmz',
            role: 'entry',
            privateIp: '10.81.10.10',
            exposePublic: true,
          },
        ],
        publicEntry: {
          hostKey: 'ecs-1',
          protocols: [{ protocol: 'ssh', port: 22 }],
        },
      },
    });
    await repository.publishRangeTemplateToPlatform(template.id, template.revision);

    const instance = await repository.createRangeInstance({
      name: '并发实例 Destroy Verify',
      templateId: template.id,
      status: 'running',
      allocatedCidr: '10.81.0.0/16',
      resourceSummary: {
        mode: 'opentofu',
        vpcId: 'vpc-residual',
        hostIds: {
          'ecs-1': 'i-residual',
        },
        subnetIds: {
          dmz: 'vsw-residual',
        },
      },
    });
    const job = await repository.createProvisionJob({
      rangeInstanceId: instance.id,
      jobType: 'destroy',
      triggeredBy: 'admin',
    });

    await repository.updateRangeInstance(instance.id, {
      status: 'pending_destroy',
      lastJobId: job.id,
    });

    const provisioner: RangeProvisioner = {
      create: jest.fn(),
      destroy: jest.fn().mockResolvedValue(undefined),
    };

    const worker = new ProvisioningWorkerService(repository, provisioner, createSystemConfigServiceStub() as any);
    const verifySpy = jest
      .spyOn(worker as any, 'verifyDestroyCompletion')
      .mockRejectedValue(new Error('Residual cloud resources still exist after destroy.'));

    await worker.process(job.id);

    expect(provisioner.destroy).toHaveBeenCalledTimes(1);
    expect(verifySpy).toHaveBeenCalledTimes(1);
    await expect(repository.getProvisionJobById(job.id)).resolves.toEqual(
      expect.objectContaining({
        id: job.id,
        status: 'failed',
        errorSummary: 'Residual cloud resources still exist after destroy.',
      }),
    );
    await expect(repository.getRangeInstanceById(instance.id)).resolves.toEqual(
      expect.objectContaining({
        id: instance.id,
        status: 'destroy_failed',
        errorSummary: 'Residual cloud resources still exist after destroy.',
      }),
    );
  });

  it('treats a missing VPC as sufficient evidence that linked vswitches are already gone during destroy verification', async () => {
    const repository = createMemoryAdminRepository();
    const template = await repository.createRangeTemplate({
      name: 'Destroy Verification Missing VPC Template',
      slug: 'destroy-verification-missing-vpc-template',
      version: 'v1',
      modulePathOrRef: 'infra/opentofu/modules/alicloud-enterprise-range',
      topologySpec: {
        vpcCidr: '10.82.0.0/16',
        networkZones: [
          {
            key: 'dmz',
            name: 'DMZ',
            purpose: 'public-entry',
            cidr: '10.82.10.0/24',
            isPublicEntry: true,
          },
        ],
        hosts: [
          {
            key: 'ecs-1',
            name: 'ECS 1',
            zoneKey: 'dmz',
            role: 'entry',
            privateIp: '10.82.10.10',
            exposePublic: true,
          },
        ],
        publicEntry: {
          hostKey: 'ecs-1',
          protocols: [{ protocol: 'ssh', port: 22 }],
        },
      },
    });
    await repository.publishRangeTemplateToPlatform(template.id, template.revision);

    const instance = await repository.createRangeInstance({
      name: '并发实例 Destroy Missing VPC',
      templateId: template.id,
      status: 'running',
      allocatedCidr: '10.82.0.0/16',
      resourceSummary: {
        mode: 'opentofu',
        vpcId: 'vpc-gone',
        hostIds: {
          'ecs-1': 'i-gone',
        },
        subnetIds: {
          dmz: 'vsw-gone',
        },
      },
    });
    const job = await repository.createProvisionJob({
      rangeInstanceId: instance.id,
      jobType: 'destroy',
      triggeredBy: 'admin',
    });

    await repository.updateRangeInstance(instance.id, {
      status: 'pending_destroy',
      lastJobId: job.id,
    });

    const provisioner: RangeProvisioner = {
      create: jest.fn(),
      destroy: jest.fn().mockResolvedValue(undefined),
    };

    const worker = new ProvisioningWorkerService(repository, provisioner, createSystemConfigServiceStub() as any);
    const checkVpcExistsSpy = jest.spyOn(worker as any, 'checkVpcExists').mockResolvedValue(false);
    const checkVSwitchExistsSpy = jest.spyOn(worker as any, 'checkVSwitchExists').mockResolvedValue(true);
    jest.spyOn(worker as any, 'findExistingInstanceIds').mockResolvedValue([]);
    jest.spyOn(worker as any, 'checkNetworkInterfaceExists').mockResolvedValue(false);
    jest.spyOn(worker as any, 'checkNatGatewayExists').mockResolvedValue(false);
    jest.spyOn(worker as any, 'checkEipExists').mockResolvedValue(false);

    await worker.process(job.id);

    expect(provisioner.destroy).toHaveBeenCalledTimes(1);
    expect(checkVpcExistsSpy).toHaveBeenCalledTimes(1);
    expect(checkVSwitchExistsSpy).not.toHaveBeenCalled();
    await expect(repository.getProvisionJobById(job.id)).resolves.toEqual(
      expect.objectContaining({
        id: job.id,
        status: 'succeeded',
        errorSummary: null,
      }),
    );
    await expect(repository.getRangeInstanceById(instance.id)).resolves.toEqual(
      expect.objectContaining({
        id: instance.id,
        status: 'destroyed',
        errorSummary: null,
        accessEntry: null,
        resourceSummary: null,
      }),
    );
  });

  it('passes runtimeCredentials into create provisioning input', async () => {
    const repository = createMemoryAdminRepository();
    const template = await repository.createRangeTemplate({
      name: 'Runtime Credentials Create Template',
      slug: 'runtime-credentials-create-template',
      version: 'v1',
      modulePathOrRef: 'infra/opentofu/modules/alicloud-enterprise-range',
      topologySpec: {
        vpcCidr: '10.78.0.0/16',
        networkZones: [
          {
            key: 'dmz',
            name: 'DMZ',
            purpose: 'public-entry',
            cidr: '10.78.10.0/24',
            isPublicEntry: true,
          },
        ],
        hosts: [
          {
            key: 'ecs-1',
            name: 'ECS 1',
            zoneKey: 'dmz',
            role: 'entry',
            privateIp: '10.78.10.10',
            exposePublic: true,
          },
        ],
        publicEntry: {
          hostKey: 'ecs-1',
          protocols: [{ protocol: 'ssh', port: 22 }],
        },
      },
    });
    await repository.publishRangeTemplateToPlatform(template.id, template.revision);

    const instance = await repository.createRangeInstance({
      name: '并发实例 Runtime Create',
      templateId: template.id,
      status: 'pending_create',
      allocatedCidr: '10.78.0.0/16',
      runtimeCredentials: {
        'ecs-1': {
          username: 'root',
          password: 'PasswordOne123!',
        },
      },
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
          publicIp: '47.78.0.10',
          privateIp: '10.78.10.10',
          ssh: 'ssh root@47.78.0.10',
        },
        resourceSummary: {
          mode: 'opentofu',
          vpcId: 'vpc-runtime-credentials-create',
        },
      }),
      destroy: jest.fn(),
    };

    const worker = new ProvisioningWorkerService(repository, provisioner, createSystemConfigServiceStub() as any);

    await worker.process(job.id);

    expect(provisioner.create).toHaveBeenCalledWith(
      expect.objectContaining({
        billingTags: expect.objectContaining({
          CreatedBy: 'cyber-range-platform',
          PlatformScope: 'platform',
          RangeInstanceId: instance.id,
          BillingStartAt: expect.any(String),
        }),
        runtimeCredentials: {
          'ecs-1': {
            username: 'root',
            password: 'PasswordOne123!',
          },
        },
      }),
    );
  });

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
    await repository.publishRangeTemplateToPlatform(template.id, template.revision);

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
    await repository.publishRangeTemplateToPlatform(template.id, template.revision);

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
    await repository.publishRangeTemplateToPlatform(template.id, template.revision);

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
    await repository.publishRangeTemplateToPlatform(template.id, template.revision);

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

  it('passes runtimeCredentials into update provisioning input', async () => {
    const repository = createMemoryAdminRepository();
    const template = await repository.createRangeTemplate({
      name: 'Runtime Credentials Update Template',
      slug: 'runtime-credentials-update-template',
      version: 'v1',
      modulePathOrRef: 'infra/opentofu/modules/alicloud-enterprise-range',
      topologySpec: {
        vpcCidr: '10.79.0.0/16',
        networkZones: [
          {
            key: 'dmz',
            name: 'DMZ',
            purpose: 'public-entry',
            cidr: '10.79.10.0/24',
            isPublicEntry: true,
          },
        ],
        hosts: [
          {
            key: 'ecs-1',
            name: 'ECS 1',
            zoneKey: 'dmz',
            role: 'entry',
            privateIp: '10.79.10.10',
            exposePublic: true,
          },
        ],
        publicEntry: {
          hostKey: 'ecs-1',
          protocols: [{ protocol: 'ssh', port: 22 }],
        },
      },
      compiledProvisionSpec: {
        schemaVersion: '1.0.0',
        topology: { vpcCidr: '10.79.0.0/16', entryHostKey: 'ecs-1' },
        networkZones: [
          { key: 'dmz', name: 'DMZ', cidr: '10.79.10.0/24', purpose: 'public-entry', isPublicEntry: true },
        ],
        hosts: [
          {
            key: 'ecs-1',
            name: 'ECS 1',
            role: 'entry',
            zoneKey: 'dmz',
            primaryPrivateIp: '10.79.10.10',
            exposePublic: true,
            networkInterfaces: [{ deviceIndex: 0, zoneKey: 'dmz', privateIp: '10.79.10.10' }],
          },
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
    });
    await repository.publishRangeTemplateToPlatform(template.id, template.revision);

    const instance = await repository.createRangeInstance({
      name: '并发实例 Runtime Update',
      templateId: template.id,
      status: 'running',
      allocatedCidr: '10.79.0.0/16',
      runtimeCredentials: {
        'ecs-1': {
          username: 'root',
          password: 'PasswordUpdate123!',
        },
      },
      draftCompiledProvisionSpec: {
        schemaVersion: '1.0.0',
        topology: { vpcCidr: '10.79.0.0/16', entryHostKey: 'ecs-1' },
        networkZones: [
          { key: 'dmz', name: 'DMZ', cidr: '10.79.10.0/24', purpose: 'public-entry', isPublicEntry: true },
        ],
        hosts: [
          {
            key: 'ecs-1',
            name: 'ECS 1',
            role: 'entry',
            zoneKey: 'dmz',
            primaryPrivateIp: '10.79.10.10',
            exposePublic: true,
            networkInterfaces: [{ deviceIndex: 0, zoneKey: 'dmz', privateIp: '10.79.10.10' }],
          },
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
    });
    const job = await repository.createProvisionJob({
      rangeInstanceId: instance.id,
      jobType: 'update',
      triggeredBy: 'admin',
    });

    await repository.updateRangeInstance(instance.id, {
      lastJobId: job.id,
    });

    const provisioner: RangeProvisioner = {
      create: jest.fn().mockResolvedValue({
        accessEntry: {
          hostRole: 'dmz',
          publicIp: '47.79.0.10',
          privateIp: '10.79.10.10',
          ssh: 'ssh root@47.79.0.10',
        },
        resourceSummary: {
          mode: 'opentofu',
          vpcId: 'vpc-runtime-credentials-update',
        },
      }),
      destroy: jest.fn(),
    };

    const worker = new ProvisioningWorkerService(repository, provisioner, createSystemConfigServiceStub() as any);

    await worker.process(job.id);

    expect(provisioner.create).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeCredentials: {
          'ecs-1': {
            username: 'root',
            password: 'PasswordUpdate123!',
          },
        },
      }),
    );
  });

  it('provisions single-instance create jobs without requiring a template id', async () => {
    const repository = createMemoryAdminRepository();
    const profile = await repository.upsertSingleInstanceNetworkProfile({
      provider: 'alibaba_cloud',
      regionId: 'cn-hangzhou',
      zoneId: 'cn-hangzhou-h',
      vpcId: 'vpc-single-default',
      vpcCidr: '10.200.0.0/16',
      vswitchIds: ['vsw-single-1', 'vsw-single-2', 'vsw-single-3'],
      vswitchCidrs: ['10.200.1.0/24', '10.200.2.0/24', '10.200.3.0/24'],
      securityGroupId: 'sg-single-default',
      securityGroupName: 'default-open-all',
    });
    const instance = await repository.createRangeInstance({
      name: 'single-web-lab',
      instanceMode: 'single',
      status: 'pending_create',
      runtimeScenarioTemplateSpec: {
        topology: {
          defaultRegion: 'cn-hangzhou',
          defaultZoneId: 'cn-hangzhou-h',
        },
      },
      runtimeCredentials: {
        'single-ecs-1': {
          username: 'root',
          password: 'Aa123456!',
        },
      },
      singleInstanceConfig: {
        baseName: 'single-web-lab',
        quantityIndex: 1,
        hostKey: 'single-ecs-1',
        hostName: 'single-web-lab-01',
        platformImageAssetId: 'platform-image-1',
        imageId: 'm-123',
        imageDisplayName: 'Ubuntu 24.04',
        cpu: 2,
        memory: 2,
        systemDiskSize: 40,
        assignedVswitchId: 'vsw-single-1',
      },
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
      create: jest.fn(),
      destroy: jest.fn(),
    };
    const batchExecutionService = {
      executeCreateBatch: jest.fn(async (items: Array<{ instance: RangeInstanceRecord; job: ProvisionJobRecord }>) => {
        for (const item of items) {
          await repository.updateRangeInstance(item.instance.id, {
            status: 'running',
            errorSummary: null,
            accessEntry: {
              hostRole: 'single-ecs-1',
              publicIp: '47.100.10.10',
              privateIp: '10.200.1.10',
              ssh: 'ssh root@47.100.10.10',
            },
            resourceSummary: {
              mode: 'ecs-native',
              vpcId: 'vpc-single-default',
              hostIds: {
                'single-ecs-1': 'i-single-001',
              },
            },
          });
          await repository.updateProvisionJob(item.job.id, {
            status: 'succeeded',
            finishedAt: new Date(),
            errorSummary: null,
          });
        }
      }),
      executeDestroyBatch: jest.fn(),
    };

    const worker = new ProvisioningWorkerService(
      repository,
      provisioner,
      createSystemConfigServiceStub() as any,
      batchExecutionService as any,
    );

    await worker.process(job.id);

    expect(batchExecutionService.executeCreateBatch).toHaveBeenCalledWith([
      expect.objectContaining({
        instance: expect.objectContaining({
          id: instance.id,
          instanceMode: 'single',
          singleInstanceConfig: expect.objectContaining({
            hostKey: 'single-ecs-1',
            assignedVswitchId: 'vsw-single-1',
          }),
        }),
        job: expect.objectContaining({
          id: job.id,
        }),
      }),
    ]);
    await expect(repository.getRangeInstanceById(instance.id)).resolves.toEqual(
      expect.objectContaining({
        id: instance.id,
        status: 'running',
        errorSummary: null,
        accessEntry: expect.objectContaining({
          publicIp: '47.100.10.10',
        }),
        resourceSummary: expect.objectContaining({
          vpcId: 'vpc-single-default',
        }),
      }),
    );
  });

  it('uses the single instance launch-time region and zone when destroying after system defaults change', async () => {
    const repository = createMemoryAdminRepository();
    const launchProfile = await repository.upsertSingleInstanceNetworkProfile({
      provider: 'alibaba_cloud',
      regionId: 'cn-hangzhou',
      zoneId: 'cn-hangzhou-h',
      vpcId: 'vpc-launch',
      vpcCidr: '10.210.0.0/16',
      vswitchIds: ['vsw-launch-1', 'vsw-launch-2', 'vsw-launch-3'],
      vswitchCidrs: ['10.210.1.0/24', '10.210.2.0/24', '10.210.3.0/24'],
      securityGroupId: 'sg-launch',
      securityGroupName: 'default-open-all',
    });
    const instance = await repository.createRangeInstance({
      name: 'single-destroy-launch-identity',
      instanceMode: 'single',
      status: 'running',
      runtimeScenarioTemplateSpec: {
        topology: {
          defaultRegion: 'cn-hangzhou',
          defaultZoneId: 'cn-hangzhou-h',
        },
      },
      singleInstanceConfig: {
        baseName: 'single-destroy-launch-identity',
        quantityIndex: 1,
        hostKey: 'single-ecs-1',
        hostName: 'single-destroy-launch-identity',
        platformImageAssetId: 'platform-image-1',
        imageId: 'm-123',
        imageDisplayName: 'Ubuntu 24.04',
        cpu: 2,
        memory: 2,
        systemDiskSize: 40,
        assignedVswitchId: 'vsw-launch-1',
      },
      resourceSummary: {
        mode: 'opentofu',
        vpcId: 'vpc-launch',
        hostIds: {
          'single-ecs-1': 'i-single-001',
        },
      },
    });
    const job = await repository.createProvisionJob({
      rangeInstanceId: instance.id,
      jobType: 'destroy',
      triggeredBy: 'admin',
    });

    await repository.updateRangeInstance(instance.id, {
      status: 'pending_destroy',
      lastJobId: job.id,
    });

    const provisioner: RangeProvisioner = {
      create: jest.fn(),
      destroy: jest.fn(),
    };
    const changedDefaultsSystemConfig = {
      getSnapshot: jest.fn().mockResolvedValue({
        provider: 'alibaba_cloud',
        defaultRegion: 'cn-shanghai',
        defaultZoneId: 'cn-shanghai-b',
        accessKeyId: 'test-ak',
        accessKeySecret: 'test-sk',
      }),
    };
    const batchExecutionService = {
      executeCreateBatch: jest.fn(),
      executeDestroyBatch: jest.fn(async (items: Array<{ instance: RangeInstanceRecord; job: ProvisionJobRecord }>) => {
        expect(items).toEqual([
          expect.objectContaining({
            instance: expect.objectContaining({
              id: instance.id,
              singleInstanceConfig: expect.objectContaining({
                assignedVswitchId: 'vsw-launch-1',
              }),
            }),
            job: expect.objectContaining({
              id: job.id,
            }),
          }),
        ]);

        for (const item of items) {
          await repository.updateRangeInstance(item.instance.id, {
            status: 'destroyed',
            errorSummary: null,
          });
          await repository.updateProvisionJob(item.job.id, {
            status: 'succeeded',
            finishedAt: new Date(),
            errorSummary: null,
          });
        }
      }),
    };
    const worker = new ProvisioningWorkerService(
      repository,
      provisioner,
      changedDefaultsSystemConfig as any,
      batchExecutionService as any,
    );

    await worker.process(job.id);

    expect(batchExecutionService.executeDestroyBatch).toHaveBeenCalledTimes(1);
    await expect(repository.getRangeInstanceById(instance.id)).resolves.toEqual(
      expect.objectContaining({
        id: instance.id,
        status: 'destroyed',
        errorSummary: null,
      }),
    );
  });
});
