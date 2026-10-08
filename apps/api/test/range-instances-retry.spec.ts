import { RangeInstancesService } from '../src/admin/range-instances.service';
import { RangeTemplatesService } from '../src/admin/range-templates.service';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';

describe('RangeInstancesService retry flow', () => {
  it('moves failed creates into history while keeping destroy failures in the active list', async () => {
    const repository = createMemoryAdminRepository();
    const service = new RangeInstancesService(
      repository,
      new RangeTemplatesService(repository),
      {} as never,
      {
        serialize: async <T>(handler: () => Promise<T>) => handler(),
        getPool: () => [],
        allocate: () => null,
      } as never,
      {
        dispatch: () => undefined,
      } as never,
    );

    const [running, failedCreate, failedDestroy, destroyed] = await Promise.all([
      repository.createRangeInstance({ name: 'running-range', status: 'running' }),
      repository.createRangeInstance({ name: 'failed-create-range', status: 'create_failed' }),
      repository.createRangeInstance({ name: 'failed-destroy-range', status: 'destroy_failed' }),
      repository.createRangeInstance({ name: 'destroyed-range', status: 'destroyed' }),
    ]);

    await expect(service.list({ id: 'admin', role: 'admin' }, 'active')).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: running.id }),
        expect.objectContaining({ id: failedDestroy.id }),
      ]),
    );
    await expect(service.list({ id: 'admin', role: 'admin' }, 'active')).resolves.not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: failedCreate.id }),
        expect.objectContaining({ id: destroyed.id }),
      ]),
    );
    await expect(service.list({ id: 'admin', role: 'admin' }, 'history')).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: failedCreate.id, status: 'create_failed' }),
        expect.objectContaining({ id: destroyed.id, status: 'destroyed' }),
      ]),
    );
  });

  it('rejects starting a draft range without a future expiration time', async () => {
    const repository = createMemoryAdminRepository();
    const dispatched: string[] = [];
    const service = new RangeInstancesService(
      repository,
      new RangeTemplatesService(repository),
      {} as never,
      {
        serialize: async <T>(handler: () => Promise<T>) => handler(),
        getPool: () => [],
        allocate: () => null,
      } as never,
      {
        dispatch: (jobId: string) => dispatched.push(jobId),
      } as never,
    );
    const instance = await repository.createRangeInstance({
      name: 'unbounded-draft',
      templateId: 'missing-template',
      status: 'draft',
    });

    await expect(service.triggerCreate(instance.id, 'admin')).rejects.toThrow('到期时间');
    expect(dispatched).toEqual([]);
  });

  it('rejects retrying a failed range without a future expiration time', async () => {
    const repository = createMemoryAdminRepository();
    const dispatched: string[] = [];
    const service = new RangeInstancesService(
      repository,
      new RangeTemplatesService(repository),
      {} as never,
      {
        serialize: async <T>(handler: () => Promise<T>) => handler(),
        getPool: () => [],
        allocate: () => null,
      } as never,
      {
        dispatch: (jobId: string) => dispatched.push(jobId),
      } as never,
    );
    const instance = await repository.createRangeInstance({
      name: 'unbounded-retry',
      templateId: 'missing-template',
      status: 'create_failed',
    });

    await expect(service.triggerRetry(instance.id, 'admin')).rejects.toThrow('到期时间');
    expect(dispatched).toEqual([]);
  });

  it('rejects launching a range with an expiration time in the past', async () => {
    const repository = createMemoryAdminRepository();
    const dispatched: string[] = [];
    const service = new RangeInstancesService(
      repository,
      new RangeTemplatesService(repository),
      {} as never,
      {
        serialize: async <T>(handler: () => Promise<T>) => handler(),
        getPool: () => [],
        allocate: () => null,
      } as never,
      {
        dispatch: (jobId: string) => dispatched.push(jobId),
      } as never,
    );

    await expect(
      service.launch(
        {
          templateId: 'missing-template',
          name: 'expired-range',
          expiresAt: '2020-01-01T00:00:00.000Z',
        },
        { id: 'user-1', role: 'user' },
      ),
    ).rejects.toThrow('到期时间');
    expect(dispatched).toEqual([]);
  });

  it('blocks launching a legacy template that directly references an Alibaba Cloud image', async () => {
    const repository = createMemoryAdminRepository();
    const dispatched: string[] = [];
    const service = new RangeInstancesService(
      repository,
      new RangeTemplatesService(repository),
      {} as never,
      {
        serialize: async <T>(handler: () => Promise<T>) => handler(),
        getPool: () => [],
        allocate: () => null,
      } as never,
      {
        dispatch: (jobId: string) => dispatched.push(jobId),
      } as never,
    );
    const template = await repository.createRangeTemplate({
      name: 'Legacy image template',
      slug: 'legacy-image-template-service-spec',
      version: 'v1',
      createdBy: 'user-1',
      ownerUserId: 'user-1',
      modulePathOrRef: 'infra/opentofu/modules/alicloud-enterprise-range',
      topologySpec: {
        vpcCidr: '10.92.0.0/16',
        networkZones: [{ key: 'dmz', name: 'DMZ', purpose: 'public-entry', cidr: '10.92.10.0/24' }],
        hosts: [{ key: 'entry-host', name: '入口 ECS', zoneKey: 'dmz', role: 'entry', privateIp: '10.92.10.10' }],
        publicEntry: { hostKey: 'entry-host', protocols: [{ protocol: 'ssh', port: 22 }] },
      },
      topologyGraph: {
        schemaVersion: '2.0.0',
        nodes: [
          {
            id: 'entry-host',
            kind: 'ecs',
            label: '入口 ECS',
            imageId: 'ubuntu_22_04_x64_20G_alibase_20260615.vhd',
            imageStrategy: { mode: 'fixed', imageId: 'ubuntu_22_04_x64_20G_alibase_20260615.vhd' },
          },
        ],
        edges: [],
      },
    });

    await expect(
      service.launch(
        {
          templateId: template.id,
          name: 'legacy-range',
          expiresAt: '2030-07-22T00:00:00.000Z',
        },
        { id: 'user-1', role: 'user' },
      ),
    ).rejects.toThrow('入口 ECS 请选择镜像');
    expect(dispatched).toEqual([]);
  });

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

    await repository.upsertImageSnapshots({
      provider: 'alibaba_cloud',
      accountUid: null,
      regionId: 'cn-hangzhou',
      scope: 'custom',
      snapshots: [
        {
          imageId: 'm-retry-image',
          sourceImageName: 'Retry image',
          status: 'Available',
          isAvailable: true,
          lastSyncedAt: new Date('2026-07-21T00:00:00.000Z'),
        },
      ],
    });
    const [imageSnapshot] = await repository.listImageSnapshots({
      provider: 'alibaba_cloud',
      accountUid: null,
      regionId: 'cn-hangzhou',
      scope: 'custom',
      imageId: 'm-retry-image',
    });
    const imageAsset = await repository.collectPlatformImageAsset({
      snapshotId: imageSnapshot!.id,
      displayName: 'Retry image',
      visibility: 'platform',
    });
    const service = new RangeInstancesService(
      repository,
      new RangeTemplatesService(repository),
      {} as never,
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
      topologyGraph: {
        schemaVersion: '2.0.0',
        nodes: ['dmz-entry', 'office-client', 'server-app'].map((id) => ({
          id,
          kind: 'ecs',
          label: id,
          platformImageAssetId: imageAsset.id,
          image: imageAsset.displayName,
          imageName: imageAsset.displayName,
          imageId: imageAsset.imageId,
          imageStrategy: { mode: 'fixed', imageId: imageAsset.imageId },
        })),
        edges: [],
      },
    });
    await repository.publishRangeTemplateToPlatform(template.id, template.revision);

    const instance = await repository.createRangeInstance({
      name: '重试实例',
      templateId: template.id,
      status: 'create_failed',
      allocatedCidr: '10.90.0.0/16',
      errorSummary: 'OpenTofu plan failed',
      expiresAt: '2030-07-22T00:00:00.000Z',
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

    await repository.updateRangeInstance(instance.id, {
      status: 'create_failed',
      errorSummary: 'OpenTofu apply partially created cloud resources',
    });

    await expect(service.triggerDestroy(instance.id, 'admin')).rejects.toThrow('active operation');
    await repository.updateProvisionJob(retryJob.id, { status: 'failed', finishedAt: new Date() });
    const destroyJob = await service.triggerDestroy(instance.id, 'admin');

    expect(destroyJob).toEqual(
      expect.objectContaining({
        rangeInstanceId: instance.id,
        jobType: 'destroy',
        status: 'pending',
      }),
    );
    await expect(repository.getRangeInstanceById(instance.id)).resolves.toEqual(
      expect.objectContaining({
        id: instance.id,
        status: 'pending_destroy',
        lastJobId: destroyJob.id,
      }),
    );
    expect(dispatched).toEqual([retryJob.id, destroyJob.id]);
  });
});
