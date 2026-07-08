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
    expect(response.body.instances).toHaveLength(2);
    expect(response.body.instances[0]).toMatchObject({
      createdBy: 'admin',
      instanceMode: 'single',
      name: 'web-lab-01',
    });
    expect(response.body.instances[1]).toMatchObject({
      name: 'web-lab-02',
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
