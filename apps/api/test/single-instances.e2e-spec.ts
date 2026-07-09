import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { ADMIN_REPOSITORY, type AdminRepository } from '../src/admin/admin.repository';
import { SingleInstanceNetworkService } from '../src/admin/single-instance-network.service';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap/configure-app';
import { SystemConfigService } from '../src/admin/system-config.service';
import { CidrPoolService } from '../src/provisioning/cidr-pool.service';
import { SingleInstanceNetworkBootstrapService } from '../src/provisioning/single-instance-network-bootstrap';
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
    getAccountContext: jest.fn().mockResolvedValue({
      provider: 'alibaba_cloud',
      defaultRegion: 'cn-hangzhou',
      defaultZoneId: 'cn-hangzhou-h',
      accessKeyId: 'test-ak',
      accessKeySecret: 'test-sk',
      accountUid: null,
      accountUidResolved: false,
    }),
  };
}

describe('single instances', () => {
  let app: INestApplication;
  let repository: AdminRepository;
  let fetchMock: jest.SpiedFunction<typeof fetch>;
  let bootstrapServiceStub: {
    bootstrapDefaultProfile: jest.Mock;
  };

  beforeAll(async () => {
    process.env.ADMIN_USERNAME = 'admin';
    process.env.ADMIN_PASSWORD = 'change-me';
    process.env.ADMIN_TOKEN = 'dev-admin-token';
    fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response(JSON.stringify({ RequestId: 'ok' }), { status: 200 });
    });
    bootstrapServiceStub = {
      bootstrapDefaultProfile: jest.fn().mockResolvedValue({
        provider: 'alibaba_cloud',
        regionId: 'cn-hangzhou',
        zoneId: 'cn-hangzhou-h',
        vpcId: 'vpc-bootstrap-real',
        vpcCidr: '10.200.0.0/16',
        vswitchIds: ['vsw-bootstrap-1', 'vsw-bootstrap-2', 'vsw-bootstrap-3'],
        vswitchCidrs: ['10.200.1.0/24', '10.200.2.0/24', '10.200.3.0/24'],
        securityGroupId: 'sg-bootstrap-real',
        securityGroupName: 'default-open-all',
      }),
    };

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(ADMIN_REPOSITORY)
      .useValue(createMemoryAdminRepository())
      .overrideProvider(SystemConfigService)
      .useValue(createSystemConfigServiceStub())
      .overrideProvider(SingleInstanceNetworkBootstrapService)
      .useValue(bootstrapServiceStub)
      .compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();

    repository = app.get(ADMIN_REPOSITORY);

    await repository.upsertImageSnapshots({
      provider: 'alibaba_cloud',
      accountUid: null,
      regionId: 'cn-hangzhou',
      scope: 'custom',
      snapshots: [
        {
          imageId: 'm-platform-image-1',
          sourceImageName: 'Ubuntu 24.04',
          status: 'Available',
          isAvailable: true,
          lastSyncedAt: new Date('2026-07-08T00:00:00.000Z'),
        },
      ],
    });

    const snapshot = (
      await repository.listImageSnapshots({
        provider: 'alibaba_cloud',
        accountUid: null,
        regionId: 'cn-hangzhou',
        scope: 'custom',
        imageId: 'm-platform-image-1',
      })
    )[0];

    await repository.collectPlatformImageAsset({
      snapshotId: snapshot.id,
      displayName: 'Ubuntu 24.04',
    });

    const [asset] = await repository.listPlatformImageAssets({
      provider: 'alibaba_cloud',
      accountUid: null,
      regionId: 'cn-hangzhou',
      enabled: true,
    });

    expect(asset?.id).toBe('memory-2');
  });

  beforeEach(() => {
    fetchMock.mockImplementation(async () => {
      return new Response(JSON.stringify({ RequestId: 'ok' }), { status: 200 });
    });
  });

  afterAll(async () => {
    fetchMock.mockRestore();
    await app.close();
  });

  it('creates a single-instance record with mode single and generated names for quantity > 1', async () => {
    const response = await request(app.getHttpServer())
      .post('/admin/instances/launch')
      .set('Authorization', 'Bearer dev-admin-token')
      .send({
        name: 'web-lab',
        hostName: 'web-host',
        platformImageAssetId: 'memory-2',
        cpu: 2,
        memory: 2,
        systemDiskSize: 40,
        expiresAt: '2026-07-10T12:00:00.000Z',
        quantity: 2,
        password: '',
        remark: 'single instance',
        triggeredBy: 'admin',
      });

    expect(response.status).toBe(201);
    expect(response.body.batch).toEqual(
      expect.objectContaining({
        name: 'web-lab',
        quantity: 2,
        createdBy: 'admin',
      }),
    );
    expect(response.body.instances).toHaveLength(2);
    expect(response.body.instances[0]).toMatchObject({
      createdBy: 'admin',
      instanceMode: 'single',
      name: 'web-lab-01',
      singleInstanceBatchId: response.body.batch.id,
    });
    expect(response.body.instances[1]).toMatchObject({
      name: 'web-lab-02',
      singleInstanceBatchId: response.body.batch.id,
    });
    expect(bootstrapServiceStub.bootstrapDefaultProfile).toHaveBeenCalledTimes(1);

    const profile = await repository.getSingleInstanceNetworkProfile({
      provider: 'alibaba_cloud',
      regionId: 'cn-hangzhou',
      zoneId: 'cn-hangzhou-h',
    });

    expect(profile).toMatchObject({
      vpcId: 'vpc-bootstrap-real',
      securityGroupId: 'sg-bootstrap-real',
      vswitchIds: ['vsw-bootstrap-1', 'vsw-bootstrap-2', 'vsw-bootstrap-3'],
    });
  });

  it('offsets vSwitch round-robin by current active single-instance count', async () => {
    await repository.createRangeInstance({
      name: 'existing-running',
      createdBy: 'admin',
      instanceMode: 'single',
      status: 'running',
      singleInstanceConfig: {
        baseName: 'existing-running',
        quantityIndex: 1,
        hostKey: 'single-ecs-existing-1',
        hostName: 'existing-running',
        platformImageAssetId: 'memory-2',
        imageId: 'm-platform-image-1',
        imageDisplayName: 'Ubuntu 24.04',
        cpu: 2,
        memory: 2,
        systemDiskSize: 40,
        assignedVswitchId: 'vsw-bootstrap-1',
      },
    });
    await repository.createRangeInstance({
      name: 'existing-destroyed',
      createdBy: 'admin',
      instanceMode: 'single',
      status: 'destroyed',
      singleInstanceConfig: {
        baseName: 'existing-destroyed',
        quantityIndex: 1,
        hostKey: 'single-ecs-existing-2',
        hostName: 'existing-destroyed',
        platformImageAssetId: 'memory-2',
        imageId: 'm-platform-image-1',
        imageDisplayName: 'Ubuntu 24.04',
        cpu: 2,
        memory: 2,
        systemDiskSize: 40,
        assignedVswitchId: 'vsw-bootstrap-2',
      },
    });
    const activeCount = (await repository.listRangeInstances()).filter(
      (instance) => instance.instanceMode === 'single' && instance.status !== 'destroyed',
    ).length;
    const expectedVswitchIds = ['vsw-bootstrap-1', 'vsw-bootstrap-2', 'vsw-bootstrap-3'];

    const response = await request(app.getHttpServer())
      .post('/admin/instances/launch')
      .set('Authorization', 'Bearer dev-admin-token')
      .send({
        name: 'offset-lab',
        hostName: 'offset-host',
        platformImageAssetId: 'memory-2',
        cpu: 2,
        memory: 2,
        systemDiskSize: 40,
        expiresAt: '2026-07-10T12:00:00.000Z',
        quantity: 2,
        password: '',
        remark: 'round robin offset',
        triggeredBy: 'admin',
      });

    expect(response.status).toBe(201);
    expect(response.body.instances[0].singleInstanceConfig.assignedVswitchId).toBe(expectedVswitchIds[activeCount % 3]);
    expect(response.body.instances[1].singleInstanceConfig.assignedVswitchId).toBe(expectedVswitchIds[(activeCount + 1) % 3]);
  });

  it('returns grouped batch payloads and leaves legacy single rows standalone', async () => {
    const batch = await repository.createSingleInstanceBatch({
      name: 'web-lab-batch',
      platformImageAssetId: 'memory-2',
      imageId: 'm-platform-image-1',
      imageDisplayName: 'Ubuntu 24.04',
      cpu: 2,
      memory: 2,
      systemDiskSize: 40,
      quantity: 5,
      createdBy: 'admin',
      expiresAt: new Date('2026-07-10T12:00:00.000Z'),
      remark: 'grouped launch',
    });

    await repository.createRangeInstance({
      name: 'web-lab-01',
      createdBy: 'admin',
      instanceMode: 'single',
      status: 'running',
      singleInstanceBatchId: batch.id,
      singleInstanceConfig: {
        baseName: 'web-lab',
        quantityIndex: 1,
        hostKey: 'single-ecs-1',
        hostName: 'web-lab-01',
        platformImageAssetId: 'memory-2',
        imageId: 'm-platform-image-1',
        imageDisplayName: 'Ubuntu 24.04',
        cpu: 2,
        memory: 2,
        systemDiskSize: 40,
      },
    });

    await repository.createRangeInstance({
      name: 'legacy-single',
      createdBy: 'admin',
      instanceMode: 'single',
      status: 'running',
      singleInstanceConfig: {
        baseName: 'legacy-single',
        quantityIndex: 1,
        hostKey: 'single-ecs-legacy',
        hostName: 'legacy-single',
        platformImageAssetId: 'memory-2',
        imageId: 'm-platform-image-1',
        imageDisplayName: 'Ubuntu 24.04',
        cpu: 2,
        memory: 2,
        systemDiskSize: 40,
      },
    });

    const response = await request(app.getHttpServer())
      .get('/admin/instances')
      .set('Authorization', 'Bearer dev-admin-token')
      .expect(200);

    expect(response.body).toEqual(
      expect.objectContaining({
        batches: expect.arrayContaining([
          expect.objectContaining({
            batch: expect.objectContaining({
              id: batch.id,
              name: 'web-lab-batch',
              quantity: 5,
            }),
            instances: expect.arrayContaining([
              expect.objectContaining({ name: 'web-lab-01', singleInstanceBatchId: batch.id }),
            ]),
          }),
        ]),
        standaloneInstances: expect.arrayContaining([
          expect.objectContaining({ name: 'legacy-single' }),
        ]),
      }),
    );
  });

  it('bulk-destroys all active child instances in a batch', async () => {
    const batch = await repository.createSingleInstanceBatch({
      name: 'destroy-batch',
      platformImageAssetId: 'memory-2',
      imageId: 'm-platform-image-1',
      imageDisplayName: 'Ubuntu 24.04',
      cpu: 2,
      memory: 2,
      systemDiskSize: 40,
      quantity: 2,
      createdBy: 'admin',
      expiresAt: new Date('2026-07-10T12:00:00.000Z'),
    });

    await repository.createRangeInstance({
      name: 'destroy-child-01',
      createdBy: 'admin',
      instanceMode: 'single',
      status: 'running',
      singleInstanceBatchId: batch.id,
      singleInstanceConfig: {
        baseName: 'destroy-batch',
        quantityIndex: 1,
        hostKey: 'single-ecs-1',
        hostName: 'destroy-child-01',
        platformImageAssetId: 'memory-2',
        imageId: 'm-platform-image-1',
        imageDisplayName: 'Ubuntu 24.04',
        cpu: 2,
        memory: 2,
        systemDiskSize: 40,
      },
    });

    await repository.createRangeInstance({
      name: 'destroy-child-02',
      createdBy: 'admin',
      instanceMode: 'single',
      status: 'destroyed',
      singleInstanceBatchId: batch.id,
      singleInstanceConfig: {
        baseName: 'destroy-batch',
        quantityIndex: 2,
        hostKey: 'single-ecs-2',
        hostName: 'destroy-child-02',
        platformImageAssetId: 'memory-2',
        imageId: 'm-platform-image-1',
        imageDisplayName: 'Ubuntu 24.04',
        cpu: 2,
        memory: 2,
        systemDiskSize: 40,
      },
    });

    const response = await request(app.getHttpServer())
      .post(`/admin/instances/batches/${batch.id}/destroy-all`)
      .set('Authorization', 'Bearer dev-admin-token')
      .send({ triggeredBy: 'admin' });

    expect(response.status).toBe(201);
    expect(response.body).toEqual(
      expect.objectContaining({
        batchId: batch.id,
        jobCount: 1,
      }),
    );
  });

  it('executes launched batch create jobs through ECS-native APIs and marks child instances running', async () => {
    let runInstancesCallCount = 0;
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);

      if (url.includes('Action=RunInstances')) {
        runInstancesCallCount += 1;
        return new Response(
          JSON.stringify({
            InstanceIdSets: {
              InstanceIdSet: [runInstancesCallCount === 1 ? 'i-batch-01' : 'i-batch-02'],
            },
          }),
          { status: 200 },
        );
      }

      if (url.includes('Action=DescribeInstances') && url.includes('i-batch-01')) {
        return new Response(
          JSON.stringify({
            Instances: {
              Instance: [
                {
                  InstanceId: 'i-batch-01',
                  InstanceName: 'web-lab-01',
                  HostName: 'web-host-01',
                  Status: 'Running',
                  VpcAttributes: { PrivateIpAddress: { IpAddress: ['10.200.1.10'] } },
                  PublicIpAddress: { IpAddress: ['47.100.10.10'] },
                },
              ],
            },
          }),
          { status: 200 },
        );
      }

      if (url.includes('Action=DescribeInstances') && url.includes('i-batch-02')) {
        return new Response(
          JSON.stringify({
            Instances: {
              Instance: [
                {
                  InstanceId: 'i-batch-02',
                  InstanceName: 'web-lab-02',
                  HostName: 'web-host-02',
                  Status: 'Running',
                  VpcAttributes: { PrivateIpAddress: { IpAddress: ['10.200.2.10'] } },
                  PublicIpAddress: { IpAddress: ['47.100.10.11'] },
                },
              ],
            },
          }),
          { status: 200 },
        );
      }

      return new Response(JSON.stringify({ RequestId: 'ok' }), { status: 200 });
    });

    const response = await request(app.getHttpServer())
      .post('/admin/instances/launch')
      .set('Authorization', 'Bearer dev-admin-token')
      .send({
        name: 'web-lab',
        hostName: 'web-host',
        platformImageAssetId: 'memory-2',
        cpu: 2,
        memory: 2,
        systemDiskSize: 40,
        expiresAt: '2026-07-10T12:00:00.000Z',
        quantity: 2,
        password: '',
        remark: 'single instance',
        triggeredBy: 'admin',
      })
      .expect(201);

    await waitForAsync(async () => {
      const first = await repository.getRangeInstanceById(response.body.instances[0].id);
      const second = await repository.getRangeInstanceById(response.body.instances[1].id);

      expect(first?.status).toBe('running');
      expect(second?.status).toBe('running');
      expect(first?.accessEntry?.publicIp).toBe('47.100.10.10');
      expect(second?.accessEntry?.publicIp).toBe('47.100.10.11');
    });
  });

  it('executes batch destroy-all through ECS-native APIs and marks child instances destroyed', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);

      if (url.includes('Action=DeleteInstances')) {
        return new Response(JSON.stringify({ RequestId: 'delete-ok' }), { status: 200 });
      }

      return new Response(JSON.stringify({ RequestId: 'ok' }), { status: 200 });
    });

    const batch = await repository.createSingleInstanceBatch({
      name: 'destroy-native-batch',
      platformImageAssetId: 'memory-2',
      imageId: 'm-platform-image-1',
      imageDisplayName: 'Ubuntu 24.04',
      cpu: 2,
      memory: 2,
      systemDiskSize: 40,
      quantity: 2,
      createdBy: 'admin',
      expiresAt: new Date('2026-07-10T12:00:00.000Z'),
    });

    const first = await repository.createRangeInstance({
      name: 'destroy-native-01',
      createdBy: 'admin',
      instanceMode: 'single',
      status: 'running',
      singleInstanceBatchId: batch.id,
      singleInstanceConfig: {
        baseName: 'destroy-native',
        quantityIndex: 1,
        hostKey: 'single-ecs-1',
        hostName: 'destroy-native-01',
        platformImageAssetId: 'memory-2',
        imageId: 'm-platform-image-1',
        imageDisplayName: 'Ubuntu 24.04',
        cpu: 2,
        memory: 2,
        systemDiskSize: 40,
        assignedVswitchId: 'vsw-bootstrap-1',
      },
      resourceSummary: {
        mode: 'ecs-native',
        hostIds: {
          'single-ecs-1': 'i-destroy-01',
        },
      },
    });

    const second = await repository.createRangeInstance({
      name: 'destroy-native-02',
      createdBy: 'admin',
      instanceMode: 'single',
      status: 'running',
      singleInstanceBatchId: batch.id,
      singleInstanceConfig: {
        baseName: 'destroy-native',
        quantityIndex: 2,
        hostKey: 'single-ecs-2',
        hostName: 'destroy-native-02',
        platformImageAssetId: 'memory-2',
        imageId: 'm-platform-image-1',
        imageDisplayName: 'Ubuntu 24.04',
        cpu: 2,
        memory: 2,
        systemDiskSize: 40,
        assignedVswitchId: 'vsw-bootstrap-2',
      },
      resourceSummary: {
        mode: 'ecs-native',
        hostIds: {
          'single-ecs-2': 'i-destroy-02',
        },
      },
    });

    const response = await request(app.getHttpServer())
      .post(`/admin/instances/batches/${batch.id}/destroy-all`)
      .set('Authorization', 'Bearer dev-admin-token')
      .send({ triggeredBy: 'admin' })
      .expect(201);

    expect(response.body.jobCount).toBe(2);

    await waitForAsync(async () => {
      const refreshedFirst = await repository.getRangeInstanceById(first.id);
      const refreshedSecond = await repository.getRangeInstanceById(second.id);

      expect(refreshedFirst?.status).toBe('destroyed');
      expect(refreshedSecond?.status).toBe('destroyed');
    });
  });

  it('rejects stop for single-instance row actions', async () => {
    const instance = await repository.createRangeInstance({
      name: 'stop-guard',
      createdBy: 'admin',
      instanceMode: 'single',
      status: 'running',
      singleInstanceConfig: {
        baseName: 'stop-guard',
        quantityIndex: 1,
        hostKey: 'single-ecs-1',
        hostName: 'stop-guard',
        platformImageAssetId: 'memory-2',
        imageId: 'm-platform-image-1',
        imageDisplayName: 'Ubuntu 24.04',
        cpu: 2,
        memory: 2,
        systemDiskSize: 40,
      },
      resourceSummary: {
        mode: 'opentofu',
        hostIds: {
          'single-ecs-1': 'i-single-123',
        },
      },
    });

    const response = await request(app.getHttpServer())
      .post(`/admin/instances/${instance.id}/actions/stop`)
      .set('Authorization', 'Bearer dev-admin-token')
      .send({ triggeredBy: 'admin' });

    expect(response.status).toBe(404);
    expect(response.body.message).toBe('Unsupported single instance action');
  });

  it('serializes first-time default network bootstrap so concurrent callers reuse one profile', async () => {
    const repository = createMemoryAdminRepository();
    const cidrPoolService = new CidrPoolService();
    const snapshot = {
      provider: 'alibaba_cloud',
      defaultRegion: 'cn-hangzhou',
      defaultZoneId: 'cn-hangzhou-h',
      accessKeyId: 'test-ak',
      accessKeySecret: 'test-sk',
    };
    let resolveBootstrap!: (value: {
      provider: 'alibaba_cloud';
      regionId: string;
      zoneId: string;
      vpcId: string;
      vpcCidr: string;
      vswitchIds: string[];
      vswitchCidrs: string[];
      securityGroupId: string;
      securityGroupName: string;
    }) => void;
    const bootstrapServiceStub = {
      bootstrapDefaultProfile: jest.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveBootstrap = resolve;
          }),
      ),
    };
    const service = new SingleInstanceNetworkService(
      repository,
      {
        getSnapshot: jest.fn().mockResolvedValue(snapshot),
      } as any,
      bootstrapServiceStub as any,
      cidrPoolService,
    );

    const first = service.ensureDefaultProfile();
    const second = service.ensureDefaultProfile();

    await new Promise((resolve) => setImmediate(resolve));
    expect(bootstrapServiceStub.bootstrapDefaultProfile).toHaveBeenCalledTimes(1);

    resolveBootstrap({
      provider: 'alibaba_cloud',
      regionId: snapshot.defaultRegion,
      zoneId: snapshot.defaultZoneId,
      vpcId: 'vpc-serialized',
      vpcCidr: '10.220.0.0/16',
      vswitchIds: ['vsw-serialized-1', 'vsw-serialized-2', 'vsw-serialized-3'],
      vswitchCidrs: ['10.220.1.0/24', '10.220.2.0/24', '10.220.3.0/24'],
      securityGroupId: 'sg-serialized',
      securityGroupName: 'default-open-all',
    });

    await expect(first).resolves.toMatchObject({
      vpcId: 'vpc-serialized',
    });
    await expect(second).resolves.toMatchObject({
      vpcId: 'vpc-serialized',
    });
    expect(bootstrapServiceStub.bootstrapDefaultProfile).toHaveBeenCalledTimes(1);
  });
});

async function waitForAsync(assertion: () => Promise<void>, attempts = 20, delayMs = 25) {
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError;
}
