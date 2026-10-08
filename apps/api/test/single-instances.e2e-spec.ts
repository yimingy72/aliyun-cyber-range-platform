import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { hashPassword } from '../src/admin/admin-user-auth';
import { ADMIN_REPOSITORY, type AdminRepository } from '../src/admin/admin.repository';
import { SingleInstanceNetworkService } from '../src/admin/single-instance-network.service';
import { SingleInstancesService } from '../src/admin/single-instances.service';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap/configure-app';
import { SystemConfigService } from '../src/admin/system-config.service';
import { CidrPoolService } from '../src/provisioning/cidr-pool.service';
import { SingleInstanceNetworkBootstrapService } from '../src/provisioning/single-instance-network-bootstrap';
import { ProvisioningWorkerService } from '../src/provisioning/provisioning-worker.service';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';
import { loginAsRepositoryUser, overrideTestOidc } from './support/test-oidc';

let repositoryForLogin: AdminRepository;
const futureExpiration = new Date(Date.now() + 48 * 60 * 60 * 1_000).toISOString();

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

async function loginAs(_app: INestApplication, username = 'admin', _password = 'change-me') {
  return loginAsRepositoryUser(repositoryForLogin, username);
}

describe('single instances', () => {
  let app: INestApplication;
  let repository: AdminRepository;
  let fetchMock: jest.SpiedFunction<typeof fetch>;
  let bootstrapServiceStub: {
    bootstrapDefaultProfile: jest.Mock;
  };
  let adminToken: string;

  beforeEach(async () => {
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

    const moduleRef = await overrideTestOidc(Test.createTestingModule({
      imports: [AppModule],
    }))
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
    repositoryForLogin = repository;

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
      visibility: 'platform',
    });

    const [asset] = await repository.listPlatformImageAssets({
      provider: 'alibaba_cloud',
      accountUid: null,
      regionId: 'cn-hangzhou',
      enabled: true,
    });

    expect(asset?.id).toBe('memory-2');
    adminToken = await loginAs(app);
  });

  afterEach(async () => {
    const worker = app.get(ProvisioningWorkerService) as unknown as { activeTasks: Set<Promise<void>> };
    while (worker.activeTasks.size > 0) {
      await Promise.allSettled([...worker.activeTasks]);
    }
    fetchMock.mockRestore();
    await app.close();
  });

  it('creates a single-instance record with mode single and generated names for quantity > 1', async () => {
    const response = await request(app.getHttpServer())
      .post('/admin/instances/launch')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'web-lab',
        hostName: 'web-host',
        platformImageAssetId: 'memory-2',
        cpu: 2,
        memory: 2,
        systemDiskSize: 40,
        expiresAt: futureExpiration,
        quantity: 2,
        password: '',
        remark: 'single instance',
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

  it('defaults an omitted single-instance expiry to eight hours from launch', async () => {
    const startedAt = Date.now();
    const response = await request(app.getHttpServer())
      .post('/admin/instances/launch')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'default-expiry-lab',
        platformImageAssetId: 'memory-2',
        cpu: 2,
        memory: 4,
        quantity: 1,
      })
      .expect(201);

    const instance = await repository.getRangeInstanceById(response.body.instances[0].id);
    const expectedExpiresAt = startedAt + 8 * 60 * 60 * 1_000;

    expect(instance?.expiresAt?.getTime()).toBeGreaterThanOrEqual(expectedExpiresAt);
    expect(instance?.expiresAt?.getTime()).toBeLessThan(expectedExpiresAt + 5_000);
  });

  it('includes effective launch parameters in the single-instance confirmation summary', async () => {
    const service = app.get(SingleInstancesService);

    await expect(
      service.prepareLaunchConfirmation(
        {
          name: 'confirmation-lab',
          platformImageAssetId: 'memory-2',
          cpu: 2,
          memory: 4,
          quantity: 1,
          expiresAt: futureExpiration,
        },
        'admin',
      ),
    ).resolves.toMatchObject({
      targetSnapshot: {
        cpu: 2,
        memory: 4,
        systemDiskSize: 40,
        expiresAt: futureExpiration,
      },
      summary: {
        cpu: 2,
        memory: 4,
        systemDiskSize: 40,
        expiresAt: futureExpiration,
        ingress: 'TCP 1-65535 from 0.0.0.0/0',
      },
    });
  });

  it('allows launching from a caller-owned private image asset', async () => {
    await repository.upsertImageSnapshots({
      provider: 'alibaba_cloud',
      accountUid: null,
      regionId: 'cn-hangzhou',
      scope: 'custom',
      snapshots: [
        {
          imageId: 'm-private-image-owner',
          sourceImageName: 'Ubuntu 24.04 Private',
          status: 'Available',
          isAvailable: true,
          lastSyncedAt: new Date('2026-07-08T00:00:01.000Z'),
        },
      ],
    });

    const snapshot = (
      await repository.listImageSnapshots({
        provider: 'alibaba_cloud',
        accountUid: null,
        regionId: 'cn-hangzhou',
        scope: 'custom',
        imageId: 'm-private-image-owner',
      })
    )[0];

    const privateAsset = await repository.collectPlatformImageAsset({
      snapshotId: snapshot.id,
      displayName: 'Ubuntu 24.04 Private',
      ownerUserId: 'admin',
      visibility: 'private',
    });

    const response = await request(app.getHttpServer())
      .post('/admin/instances/launch')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'private-owner-lab',
        hostName: 'private-owner-host',
        platformImageAssetId: privateAsset.id,
        cpu: 2,
        memory: 2,
        systemDiskSize: 40,
        expiresAt: futureExpiration,
        quantity: 1,
        password: '',
        remark: 'private owner launch',
      })
      .expect(201);

    expect(response.body.instances).toHaveLength(1);
    expect(response.body.instances[0]).toMatchObject({
      createdBy: 'admin',
      instanceMode: 'single',
      singleInstanceConfig: expect.objectContaining({
        platformImageAssetId: privateAsset.id,
        imageId: 'm-private-image-owner',
        imageDisplayName: 'Ubuntu 24.04 Private',
      }),
    });
  });

  it('rejects launching from a caller-owned private image asset while the source snapshot is still exporting', async () => {
    await repository.upsertImageSnapshots({
      provider: 'alibaba_cloud',
      accountUid: null,
      regionId: 'cn-hangzhou',
      scope: 'custom',
      snapshots: [
        {
          imageId: 'm-private-image-pending',
          sourceImageName: 'Ubuntu 24.04 Pending',
          status: 'Creating 65%',
          isAvailable: false,
          lastSyncedAt: new Date('2026-07-08T00:00:02.000Z'),
        },
      ],
    });

    const snapshot = (
      await repository.listImageSnapshots({
        provider: 'alibaba_cloud',
        accountUid: null,
        regionId: 'cn-hangzhou',
        scope: 'custom',
        imageId: 'm-private-image-pending',
      })
    )[0];

    const privateAsset = await repository.collectPlatformImageAsset({
      snapshotId: snapshot.id,
      displayName: 'Ubuntu 24.04 Pending',
      ownerUserId: 'admin',
      visibility: 'private',
    });

    await request(app.getHttpServer())
      .post('/admin/instances/launch')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'private-pending-lab',
        hostName: 'private-pending-host',
        platformImageAssetId: privateAsset.id,
        cpu: 2,
        memory: 2,
        systemDiskSize: 40,
        expiresAt: futureExpiration,
        quantity: 1,
        password: '',
        remark: 'private pending launch',
      })
      .expect(409);
  });

  it('does not submit HostName to aliyun when neither the request nor the image provides one', async () => {
    const runInstancesBodies: string[] = [];
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const body = typeof init?.body === 'string' ? init.body : '';

      if (body.includes('Action=RunInstances')) {
        runInstancesBodies.push(body);
        return new Response(
          JSON.stringify({
            InstanceIdSets: {
              InstanceIdSet: ['i-random-host-01'],
            },
          }),
          { status: 200 },
        );
      }

      if (url.includes('Action=DescribeInstances') && url.includes('i-random-host-01')) {
        return new Response(
          JSON.stringify({
            Instances: {
              Instance: [
                {
                  InstanceId: 'i-random-host-01',
                  BlockDeviceMappings: { BlockDeviceMapping: [{ DiskId: 'd-random-host-01' }] },
                  InstanceName: 'random-host-lab',
                  HostName: 'iZbp1randomhost',
                  Status: 'Running',
                  VpcAttributes: { PrivateIpAddress: { IpAddress: ['10.200.1.66'] } },
                  PublicIpAddress: { IpAddress: ['47.100.66.10'] },
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
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'random-host-lab',
        platformImageAssetId: 'memory-2',
        cpu: 2,
        memory: 2,
        systemDiskSize: 40,
        expiresAt: futureExpiration,
        quantity: 1,
        password: '',
        remark: 'no host name',
      })
      .expect(201);

    await waitForAsync(async () => {
      const instance = await repository.getRangeInstanceById(response.body.instances[0].id);
      expect(instance?.status).toBe('running');
      expect(instance?.accessEntry?.publicIp).toBe('47.100.66.10');
    });

    expect(runInstancesBodies).toHaveLength(1);
    expect(runInstancesBodies[0]).not.toContain('HostName=');
    expect(response.body.instances[0].singleInstanceConfig.hostName).toBeNull();
  });

  it('submits billing tags to aliyun when launching a single instance', async () => {
    const runInstancesBodies: string[] = [];
    const tagResourceBodies: string[] = [];
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const body = typeof init?.body === 'string' ? init.body : '';

      if (body.includes('Action=RunInstances')) {
        runInstancesBodies.push(body);
        return new Response(
          JSON.stringify({
            InstanceIdSets: {
              InstanceIdSet: ['i-billing-tags-01'],
            },
          }),
          { status: 200 },
        );
      }

      if (body.includes('Action=TagResources')) {
        tagResourceBodies.push(body);
        return new Response(JSON.stringify({ RequestId: 'tag-ok' }), { status: 200 });
      }

      if (url.includes('Action=DescribeInstances') && url.includes('i-billing-tags-01')) {
        return new Response(
          JSON.stringify({
            Instances: {
              Instance: [
                {
                  InstanceId: 'i-billing-tags-01',
                  InstanceName: 'billing-tags-lab',
                  HostName: 'billing-tags-lab',
                  Status: 'Running',
                  VpcAttributes: { PrivateIpAddress: { IpAddress: ['10.200.1.77'] } },
                  PublicIpAddress: { IpAddress: ['47.100.77.10'] },
                  BlockDeviceMappings: {
                    BlockDeviceMapping: [{ DiskId: 'd-billing-tags-01' }],
                  },
                },
              ],
            },
          }),
          { status: 200 },
        );
      }

      return new Response(JSON.stringify({ RequestId: 'ok' }), { status: 200 });
    });

    await request(app.getHttpServer())
      .post('/admin/instances/launch')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'billing-tags-lab',
        hostName: 'billing-tags-lab',
        platformImageAssetId: 'memory-2',
        cpu: 2,
        memory: 2,
        systemDiskSize: 40,
        expiresAt: futureExpiration,
        quantity: 1,
        password: '',
        remark: 'billing tag launch',
      })
      .expect(201);

    expect(runInstancesBodies).toHaveLength(1);
    expect(runInstancesBodies[0]).toContain('Tag.');
    expect(runInstancesBodies[0]).toContain('CreatedBy');
    expect(runInstancesBodies[0]).toContain('PlatformScope');
    expect(runInstancesBodies[0]).toContain('RangeInstanceId');
    expect(runInstancesBodies[0]).toContain('BillingStartAt');
    expect(tagResourceBodies).toEqual([
      expect.stringContaining('ResourceType=disk'),
    ]);
    expect(tagResourceBodies[0]).toContain('ResourceId.1=d-billing-tags-01');
    expect(tagResourceBodies[0]).toContain('PlatformResourceType');
    expect(tagResourceBodies[0]).toContain('PlatformManaged');
  });

  it('uses the image defaultHostName when launch request leaves hostName empty', async () => {
    await repository.upsertImageSnapshots({
      provider: 'alibaba_cloud',
      accountUid: null,
      regionId: 'cn-hangzhou',
      scope: 'custom',
      snapshots: [
        {
          imageId: 'm-private-image-default-host',
          sourceImageName: 'Ubuntu 24.04 Default Host',
          status: 'Available',
          isAvailable: true,
          lastSyncedAt: new Date('2026-07-08T00:00:03.000Z'),
        },
      ],
    });

    const snapshot = (
      await repository.listImageSnapshots({
        provider: 'alibaba_cloud',
        accountUid: null,
        regionId: 'cn-hangzhou',
        scope: 'custom',
        imageId: 'm-private-image-default-host',
      })
    )[0];

    const privateAsset = await repository.collectPlatformImageAsset({
      snapshotId: snapshot.id,
      displayName: 'Ubuntu 24.04 Default Host',
      ownerUserId: 'admin',
      visibility: 'private',
      defaultHostName: 'packed-default-host',
    });

    const runInstancesBodies: string[] = [];
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const body = typeof init?.body === 'string' ? init.body : '';

      if (body.includes('Action=RunInstances')) {
        runInstancesBodies.push(body);
        return new Response(
          JSON.stringify({
            InstanceIdSets: {
              InstanceIdSet: ['i-default-host-01'],
            },
          }),
          { status: 200 },
        );
      }

      if (url.includes('Action=DescribeInstances') && url.includes('i-default-host-01')) {
        return new Response(
          JSON.stringify({
            Instances: {
              Instance: [
                {
                  InstanceId: 'i-default-host-01',
                  BlockDeviceMappings: { BlockDeviceMapping: [{ DiskId: 'd-default-host-01' }] },
                  InstanceName: 'default-host-lab',
                  HostName: 'packed-default-host',
                  Status: 'Running',
                  VpcAttributes: { PrivateIpAddress: { IpAddress: ['10.200.1.88'] } },
                  PublicIpAddress: { IpAddress: ['47.100.88.10'] },
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
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'default-host-lab',
        platformImageAssetId: privateAsset.id,
        cpu: 2,
        memory: 2,
        systemDiskSize: 40,
        expiresAt: futureExpiration,
        quantity: 1,
        password: '',
        remark: 'image default host name',
      })
      .expect(201);

    await waitForAsync(async () => {
      const instance = await repository.getRangeInstanceById(response.body.instances[0].id);
      expect(instance?.status).toBe('running');
      expect(instance?.accessEntry?.publicIp).toBe('47.100.88.10');
    });

    expect(runInstancesBodies).toHaveLength(1);
    expect(runInstancesBodies[0]).toContain('HostName=packed-default-host');
    expect(response.body.instances[0].singleInstanceConfig.hostName).toBe('packed-default-host');
  });

  it("rejects launching from another admin's private image asset", async () => {
    await repository.createPlatformUser({
      id: 'other-admin',
      username: 'other-admin',
      passwordHash: hashPassword('other-password'),
      role: 'admin',
      status: 'active',
    });

    await repository.upsertImageSnapshots({
      provider: 'alibaba_cloud',
      accountUid: null,
      regionId: 'cn-hangzhou',
      scope: 'custom',
      snapshots: [
        {
          imageId: 'm-private-image-foreign',
          sourceImageName: 'Ubuntu 24.04 Foreign Private',
          status: 'Available',
          isAvailable: true,
          lastSyncedAt: new Date('2026-07-08T00:00:02.000Z'),
        },
      ],
    });

    const snapshot = (
      await repository.listImageSnapshots({
        provider: 'alibaba_cloud',
        accountUid: null,
        regionId: 'cn-hangzhou',
        scope: 'custom',
        imageId: 'm-private-image-foreign',
      })
    )[0];

    const privateAsset = await repository.collectPlatformImageAsset({
      snapshotId: snapshot.id,
      displayName: 'Ubuntu 24.04 Foreign Private',
      ownerUserId: 'admin',
      visibility: 'private',
    });

    const otherAdminToken = await loginAs(app, 'other-admin', 'other-password');

    await request(app.getHttpServer())
      .post('/admin/instances/launch')
      .set('Authorization', `Bearer ${otherAdminToken}`)
      .send({
        name: 'private-foreign-lab',
        hostName: 'private-foreign-host',
        platformImageAssetId: privateAsset.id,
        cpu: 2,
        memory: 2,
        systemDiskSize: 40,
        expiresAt: futureExpiration,
        quantity: 1,
        password: '',
        remark: 'private foreign launch',
      })
      .expect(404);
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
      (instance) =>
        instance.instanceMode === 'single' &&
        instance.status !== 'destroyed' &&
        instance.status !== 'create_failed',
    ).length;
    const expectedVswitchIds = ['vsw-bootstrap-1', 'vsw-bootstrap-2', 'vsw-bootstrap-3'];

    const response = await request(app.getHttpServer())
      .post('/admin/instances/launch')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'offset-lab',
        hostName: 'offset-host',
        platformImageAssetId: 'memory-2',
        cpu: 2,
        memory: 2,
        systemDiskSize: 40,
        expiresAt: futureExpiration,
        quantity: 2,
        password: '',
        remark: 'round robin offset',
      });

    expect(response.status).toBe(201);
    expect(response.body.instances[0].singleInstanceConfig.assignedVswitchId).toBe(expectedVswitchIds[activeCount % 3]);
    expect(response.body.instances[1].singleInstanceConfig.assignedVswitchId).toBe(expectedVswitchIds[(activeCount + 1) % 3]);
  });

  it('uses Administrator as the runtime username for windows single instances', async () => {
    await repository.upsertImageSnapshots({
      provider: 'alibaba_cloud',
      accountUid: null,
      regionId: 'cn-hangzhou',
      scope: 'custom',
      snapshots: [
        {
          imageId: 'm-windows-image-1',
          sourceImageName: 'Windows Server 2022',
          status: 'Available',
          isAvailable: true,
          lastSyncedAt: new Date('2026-07-08T00:00:03.000Z'),
        },
      ],
    });

    const snapshot = (
      await repository.listImageSnapshots({
        provider: 'alibaba_cloud',
        accountUid: null,
        regionId: 'cn-hangzhou',
        scope: 'custom',
        imageId: 'm-windows-image-1',
      })
    )[0];

    const windowsAsset = await repository.collectPlatformImageAsset({
      snapshotId: snapshot.id,
      displayName: 'Windows Server 2022',
      visibility: 'platform',
    });

    const response = await request(app.getHttpServer())
      .post('/admin/instances/launch')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'windows-lab',
        hostName: 'windows-host',
        platformImageAssetId: windowsAsset.id,
        cpu: 2,
        memory: 2,
        systemDiskSize: 40,
        expiresAt: futureExpiration,
        quantity: 1,
        password: '',
        remark: 'windows launch',
      })
      .expect(201);

    expect(response.body.instances[0].runtimeCredentials['single-ecs-1']).toMatchObject({
      username: 'Administrator',
    });
  });

  it('generates different passwords for batch single instances when password is omitted', async () => {
    const response = await request(app.getHttpServer())
      .post('/admin/instances/launch')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'batch-random-passwords',
        hostName: 'batch-random-host',
        platformImageAssetId: 'memory-2',
        cpu: 2,
        memory: 2,
        systemDiskSize: 40,
        expiresAt: futureExpiration,
        quantity: 2,
        password: '',
        remark: 'random passwords',
      })
      .expect(201);

    const firstPassword = response.body.instances[0].runtimeCredentials['single-ecs-1'].password;
    const secondPassword = response.body.instances[1].runtimeCredentials['single-ecs-2'].password;

    expect(typeof firstPassword).toBe('string');
    expect(typeof secondPassword).toBe('string');
    expect(firstPassword).not.toBe(secondPassword);
  });

  it('reuses the same password for batch single instances when password is provided', async () => {
    const response = await request(app.getHttpServer())
      .post('/admin/instances/launch')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'batch-shared-password',
        hostName: 'batch-shared-host',
        platformImageAssetId: 'memory-2',
        cpu: 2,
        memory: 2,
        systemDiskSize: 40,
        expiresAt: futureExpiration,
        quantity: 2,
        password: 'SharedPassword123!',
        remark: 'shared password',
      })
      .expect(201);

    expect(response.body.instances[0].runtimeCredentials['single-ecs-1'].password).toBe('SharedPassword123!');
    expect(response.body.instances[1].runtimeCredentials['single-ecs-2'].password).toBe('SharedPassword123!');
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
      expiresAt: new Date(futureExpiration),
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
    await repository.createRangeInstance({
      name: 'web-lab-failed',
      createdBy: 'admin',
      instanceMode: 'single',
      status: 'create_failed',
      singleInstanceBatchId: batch.id,
      singleInstanceConfig: {
        baseName: 'web-lab',
        quantityIndex: 2,
        hostKey: 'single-ecs-2',
        hostName: 'web-lab-failed',
        platformImageAssetId: 'memory-2',
        imageId: 'm-platform-image-1',
        imageDisplayName: 'Ubuntu 24.04',
        cpu: 2,
        memory: 2,
        systemDiskSize: 40,
      },
    });
    await repository.createRangeInstance({
      name: 'legacy-single-failed',
      createdBy: 'admin',
      instanceMode: 'single',
      status: 'create_failed',
      singleInstanceConfig: {
        baseName: 'legacy-single-failed',
        quantityIndex: 1,
        hostKey: 'single-ecs-legacy-failed',
        hostName: 'legacy-single-failed',
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
      .set('Authorization', `Bearer ${adminToken}`)
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
    expect(response.body.batches[0].instances).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'web-lab-failed' })]),
    );
    expect(response.body.standaloneInstances).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'legacy-single-failed' })]),
    );
    expect(response.body.batches[0].instances[0]).not.toHaveProperty('runtimeTopologyGraph');
    expect(response.body.batches[0].instances[0]).not.toHaveProperty('runtimeScenarioTemplateSpec');
    expect(response.body.batches[0].instances[0]).not.toHaveProperty('runtimeCompiledProvisionSpec');
    expect(response.body.batches[0].instances[0]).not.toHaveProperty('draftTopologyGraph');

    const historyResponse = await request(app.getHttpServer())
      .get('/admin/instances?view=history')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(historyResponse.body).toEqual(
      expect.objectContaining({
        batches: expect.arrayContaining([
          expect.objectContaining({
            batch: expect.objectContaining({ id: batch.id }),
            instances: [expect.objectContaining({ name: 'web-lab-failed', status: 'create_failed' })],
          }),
        ]),
        standaloneInstances: [expect.objectContaining({ name: 'legacy-single-failed', status: 'create_failed' })],
      }),
    );
  });

  it('allows regular users to load their own single instances and jobs while blocking other users resources', async () => {
    await repository.createPlatformUser({
      id: 'test-user',
      username: 'test',
      passwordHash: hashPassword('test-password'),
      role: 'user',
      status: 'active',
    });

    const userBatch = await repository.createSingleInstanceBatch({
      name: 'user-batch',
      platformImageAssetId: 'memory-2',
      imageId: 'm-platform-image-1',
      imageDisplayName: 'Ubuntu 24.04',
      cpu: 2,
      memory: 2,
      systemDiskSize: 40,
      quantity: 1,
      createdBy: 'test-user',
      ownerUserId: 'test-user',
      expiresAt: new Date(futureExpiration),
    });

    const userInstance = await repository.createRangeInstance({
      name: 'user-single-01',
      createdBy: 'test-user',
      ownerUserId: 'test-user',
      instanceMode: 'single',
      status: 'running',
      singleInstanceBatchId: userBatch.id,
      singleInstanceConfig: {
        baseName: 'user-single',
        quantityIndex: 1,
        hostKey: 'single-ecs-user-1',
        hostName: 'user-single-01',
        platformImageAssetId: 'memory-2',
        imageId: 'm-platform-image-1',
        imageDisplayName: 'Ubuntu 24.04',
        cpu: 2,
        memory: 2,
        systemDiskSize: 40,
      },
    });

    const adminInstance = await repository.createRangeInstance({
      name: 'admin-single-01',
      createdBy: 'admin',
      ownerUserId: 'admin',
      instanceMode: 'single',
      status: 'running',
      singleInstanceConfig: {
        baseName: 'admin-single',
        quantityIndex: 1,
        hostKey: 'single-ecs-admin-1',
        hostName: 'admin-single-01',
        platformImageAssetId: 'memory-2',
        imageId: 'm-platform-image-1',
        imageDisplayName: 'Ubuntu 24.04',
        cpu: 2,
        memory: 2,
        systemDiskSize: 40,
      },
    });

    const userJob = await repository.createProvisionJob({
      rangeInstanceId: userInstance.id,
      jobType: 'create',
      triggeredBy: 'test-user',
    });
    await repository.createProvisionJob({
      rangeInstanceId: adminInstance.id,
      jobType: 'create',
      triggeredBy: 'admin',
    });

    const userToken = await loginAs(app, 'test', 'test-password');

    const listResponse = await request(app.getHttpServer())
      .get('/admin/instances')
      .set('Authorization', `Bearer ${userToken}`)
      .expect(200);

    expect(listResponse.body).toEqual(
      expect.objectContaining({
        batches: expect.arrayContaining([
          expect.objectContaining({
            batch: expect.objectContaining({ id: userBatch.id, createdBy: 'test', ownerUserId: 'test-user' }),
            instances: expect.arrayContaining([expect.objectContaining({ id: userInstance.id, createdBy: 'test' })]),
          }),
        ]),
      }),
    );
    expect(JSON.stringify(listResponse.body)).toContain(userInstance.id);
    expect(JSON.stringify(listResponse.body)).not.toContain(adminInstance.id);

    const jobsResponse = await request(app.getHttpServer())
      .get('/admin/provision-jobs')
      .set('Authorization', `Bearer ${userToken}`)
      .expect(200);

    expect(jobsResponse.body).toEqual([expect.objectContaining({ id: userJob.id, rangeInstanceId: userInstance.id })]);

    await request(app.getHttpServer())
      .post(`/admin/instances/${adminInstance.id}/destroy`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({})
      .expect(403);
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
      expiresAt: new Date(futureExpiration),
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
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});

    expect(response.status).toBe(201);
    expect(response.body).toEqual(
      expect.objectContaining({
        batchId: batch.id,
        jobCount: 1,
      }),
    );
  });

  it('dispatches launched batch jobs only after every child instance has its pending job recorded', async () => {
    const worker = app.get(ProvisioningWorkerService);
    const order: string[] = [];
    const originalUpdateRangeInstance = repository.updateRangeInstance.bind(repository);
    const updateSpy = jest
      .spyOn(repository, 'updateRangeInstance')
      .mockImplementation(async (...args) => {
        order.push(`update:${args[0]}`);
        return originalUpdateRangeInstance(...args);
      });
    const dispatchSpy = jest.spyOn(worker, 'dispatch').mockImplementation((jobId: string) => {
      order.push(`dispatch:${jobId}`);
    });

    try {
      await request(app.getHttpServer())
        .post('/admin/instances/launch')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name: 'dispatch-order-lab',
          hostName: 'dispatch-order-host',
          platformImageAssetId: 'memory-2',
          cpu: 2,
          memory: 2,
          systemDiskSize: 40,
          expiresAt: futureExpiration,
          quantity: 2,
          password: '',
          remark: 'dispatch order',
        })
        .expect(201);
    } finally {
      updateSpy.mockRestore();
      dispatchSpy.mockRestore();
    }

    const firstDispatchIndex = order.findIndex((entry) => entry.startsWith('dispatch:'));
    expect(firstDispatchIndex).toBeGreaterThan(-1);
    expect(order.slice(0, firstDispatchIndex).filter((entry) => entry.startsWith('update:'))).toHaveLength(2);
  });

  it('dispatches batch destroy only after every child instance has been marked pending_destroy', async () => {
    const batch = await repository.createSingleInstanceBatch({
      name: 'destroy-order-batch',
      platformImageAssetId: 'memory-2',
      imageId: 'm-platform-image-1',
      imageDisplayName: 'Ubuntu 24.04',
      cpu: 2,
      memory: 2,
      systemDiskSize: 40,
      quantity: 2,
      createdBy: 'admin',
      expiresAt: new Date(futureExpiration),
    });

    await repository.createRangeInstance({
      name: 'destroy-order-01',
      createdBy: 'admin',
      instanceMode: 'single',
      status: 'running',
      singleInstanceBatchId: batch.id,
      singleInstanceConfig: {
        baseName: 'destroy-order',
        quantityIndex: 1,
        hostKey: 'single-ecs-1',
        hostName: 'destroy-order-01',
        platformImageAssetId: 'memory-2',
        imageId: 'm-platform-image-1',
        imageDisplayName: 'Ubuntu 24.04',
        cpu: 2,
        memory: 2,
        systemDiskSize: 40,
      },
      resourceSummary: {
        mode: 'ecs-native',
        hostIds: {
          'single-ecs-1': 'i-destroy-order-01',
        },
      },
    });

    await repository.createRangeInstance({
      name: 'destroy-order-02',
      createdBy: 'admin',
      instanceMode: 'single',
      status: 'running',
      singleInstanceBatchId: batch.id,
      singleInstanceConfig: {
        baseName: 'destroy-order',
        quantityIndex: 2,
        hostKey: 'single-ecs-2',
        hostName: 'destroy-order-02',
        platformImageAssetId: 'memory-2',
        imageId: 'm-platform-image-1',
        imageDisplayName: 'Ubuntu 24.04',
        cpu: 2,
        memory: 2,
        systemDiskSize: 40,
      },
      resourceSummary: {
        mode: 'ecs-native',
        hostIds: {
          'single-ecs-2': 'i-destroy-order-02',
        },
      },
    });

    const worker = app.get(ProvisioningWorkerService);
    const order: string[] = [];
    const originalUpdateRangeInstance = repository.updateRangeInstance.bind(repository);
    const updateSpy = jest
      .spyOn(repository, 'updateRangeInstance')
      .mockImplementation(async (...args) => {
        order.push(`update:${args[0]}`);
        return originalUpdateRangeInstance(...args);
      });
    const dispatchSpy = jest.spyOn(worker, 'dispatch').mockImplementation((jobId: string) => {
      order.push(`dispatch:${jobId}`);
    });

    try {
      await request(app.getHttpServer())
        .post(`/admin/instances/batches/${batch.id}/destroy-all`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({})
        .expect(201);
    } finally {
      updateSpy.mockRestore();
      dispatchSpy.mockRestore();
    }

    const firstDispatchIndex = order.findIndex((entry) => entry.startsWith('dispatch:'));
    expect(firstDispatchIndex).toBeGreaterThan(-1);
    expect(order.slice(0, firstDispatchIndex).filter((entry) => entry.startsWith('update:'))).toHaveLength(2);
  });

  it('still dispatches already-created launch jobs when a later batch row fails during setup', async () => {
    const worker = app.get(ProvisioningWorkerService);
    const originalUpdateRangeInstance = repository.updateRangeInstance.bind(repository);
    const dispatchSpy = jest.spyOn(worker, 'dispatch').mockImplementation(() => {});
    const updateSpy = jest
      .spyOn(repository, 'updateRangeInstance')
      .mockImplementation(async (...args) => {
        if (dispatchSpy.mock.calls.length === 0 && updateSpy.mock.calls.length === 2) {
          throw new Error('simulated launch setup failure');
        }

        return originalUpdateRangeInstance(...args);
      });

    try {
      await request(app.getHttpServer())
        .post('/admin/instances/launch')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name: 'dispatch-failure-lab',
          hostName: 'dispatch-failure-host',
          platformImageAssetId: 'memory-2',
          cpu: 2,
          memory: 2,
          systemDiskSize: 40,
          expiresAt: futureExpiration,
          quantity: 2,
          password: '',
          remark: 'dispatch failure fallback',
        })
        .expect(500);
      expect(dispatchSpy).toHaveBeenCalledTimes(2);
    } finally {
      updateSpy.mockRestore();
      dispatchSpy.mockRestore();
    }
  });

  it('still dispatches already-created destroy jobs when a later batch row fails during setup', async () => {
    const batch = await repository.createSingleInstanceBatch({
      name: 'destroy-dispatch-failure-batch',
      platformImageAssetId: 'memory-2',
      imageId: 'm-platform-image-1',
      imageDisplayName: 'Ubuntu 24.04',
      cpu: 2,
      memory: 2,
      systemDiskSize: 40,
      quantity: 2,
      createdBy: 'admin',
      expiresAt: new Date(futureExpiration),
    });

    await repository.createRangeInstance({
      name: 'destroy-dispatch-failure-01',
      createdBy: 'admin',
      instanceMode: 'single',
      status: 'running',
      singleInstanceBatchId: batch.id,
      singleInstanceConfig: {
        baseName: 'destroy-dispatch-failure',
        quantityIndex: 1,
        hostKey: 'single-ecs-1',
        hostName: 'destroy-dispatch-failure-01',
        platformImageAssetId: 'memory-2',
        imageId: 'm-platform-image-1',
        imageDisplayName: 'Ubuntu 24.04',
        cpu: 2,
        memory: 2,
        systemDiskSize: 40,
      },
      resourceSummary: {
        mode: 'ecs-native',
        hostIds: {
          'single-ecs-1': 'i-destroy-dispatch-failure-01',
        },
      },
    });

    await repository.createRangeInstance({
      name: 'destroy-dispatch-failure-02',
      createdBy: 'admin',
      instanceMode: 'single',
      status: 'running',
      singleInstanceBatchId: batch.id,
      singleInstanceConfig: {
        baseName: 'destroy-dispatch-failure',
        quantityIndex: 2,
        hostKey: 'single-ecs-2',
        hostName: 'destroy-dispatch-failure-02',
        platformImageAssetId: 'memory-2',
        imageId: 'm-platform-image-1',
        imageDisplayName: 'Ubuntu 24.04',
        cpu: 2,
        memory: 2,
        systemDiskSize: 40,
      },
      resourceSummary: {
        mode: 'ecs-native',
        hostIds: {
          'single-ecs-2': 'i-destroy-dispatch-failure-02',
        },
      },
    });

    const worker = app.get(ProvisioningWorkerService);
    const originalUpdateRangeInstance = repository.updateRangeInstance.bind(repository);
    const dispatchSpy = jest.spyOn(worker, 'dispatch').mockImplementation(() => {});
    const updateSpy = jest
      .spyOn(repository, 'updateRangeInstance')
      .mockImplementation(async (...args) => {
        if (dispatchSpy.mock.calls.length === 0 && updateSpy.mock.calls.length === 2) {
          throw new Error('simulated destroy setup failure');
        }

        return originalUpdateRangeInstance(...args);
      });

    try {
      await request(app.getHttpServer())
        .post(`/admin/instances/batches/${batch.id}/destroy-all`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({})
        .expect(500);
      expect(dispatchSpy).toHaveBeenCalledTimes(2);
    } finally {
      updateSpy.mockRestore();
      dispatchSpy.mockRestore();
    }
  });

  it('executes launched batch create jobs through ECS-native APIs and marks child instances running', async () => {
    let runInstancesCallCount = 0;
    const runInstancesBodies: string[] = [];
    const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1_000).toISOString();
    const encodedAutoReleaseTime = encodeURIComponent(expiresAt.replace(/\.\d{3}Z$/, 'Z'));
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const body = typeof init?.body === 'string' ? init.body : '';

      if (body.includes('Action=RunInstances')) {
        runInstancesCallCount += 1;
        runInstancesBodies.push(body);
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
                  BlockDeviceMappings: { BlockDeviceMapping: [{ DiskId: 'd-batch-01' }] },
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
                  BlockDeviceMappings: { BlockDeviceMapping: [{ DiskId: 'd-batch-02' }] },
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
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'web-lab',
        hostName: 'web-host',
        platformImageAssetId: 'memory-2',
        cpu: 2,
        memory: 2,
        systemDiskSize: 40,
        expiresAt,
        quantity: 2,
        password: '',
        remark: 'single instance',
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

    expect(runInstancesBodies).toEqual(
      expect.arrayContaining([
        expect.stringContaining('InstanceName=web-lab-01'),
        expect.stringContaining('InstanceName=web-lab-02'),
      ]),
    );
    expect(runInstancesBodies).toEqual(
      expect.arrayContaining([
        expect.stringContaining('HostName=web-host-01'),
        expect.stringContaining('HostName=web-host-02'),
      ]),
    );
    expect(runInstancesBodies).toEqual(
      expect.arrayContaining([
        expect.stringContaining(`ClientToken=${response.body.instances[0].id}`),
        expect.stringContaining(`ClientToken=${response.body.instances[1].id}`),
      ]),
    );
    expect(runInstancesBodies).toEqual(
      expect.arrayContaining([
        expect.stringContaining(`AutoReleaseTime=${encodedAutoReleaseTime}`),
      ]),
    );
  });

  it('waits for public ip readiness before persisting the created single-instance access entry', async () => {
    let describeCalls = 0;
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const body = typeof init?.body === 'string' ? init.body : '';

      if (body.includes('Action=RunInstances')) {
        return new Response(
          JSON.stringify({
            InstanceIdSets: {
              InstanceIdSet: ['i-public-ip-01'],
            },
          }),
          { status: 200 },
        );
      }

      if (url.includes('Action=DescribeInstances') && url.includes('i-public-ip-01')) {
        describeCalls += 1;
        return new Response(
          JSON.stringify({
            Instances: {
              Instance: [
                {
                  InstanceId: 'i-public-ip-01',
                  BlockDeviceMappings: { BlockDeviceMapping: [{ DiskId: 'd-public-ip-01' }] },
                  InstanceName: 'public-ip-lab',
                  HostName: 'public-ip-host',
                  Status: 'Running',
                  VpcAttributes: { PrivateIpAddress: { IpAddress: ['10.200.1.10'] } },
                  PublicIpAddress:
                    describeCalls >= 2 ? { IpAddress: ['47.100.20.10'] } : { IpAddress: [] },
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
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'public-ip-lab',
        hostName: 'public-ip-host',
        platformImageAssetId: 'memory-2',
        cpu: 2,
        memory: 2,
        systemDiskSize: 40,
        expiresAt: futureExpiration,
        quantity: 1,
        password: '',
        remark: 'public ip readiness',
      })
      .expect(201);

    await waitForAsync(
      async () => {
        const instance = await repository.getRangeInstanceById(response.body.instances[0].id);

        expect(instance?.status).toBe('running');
        expect(instance?.accessEntry?.publicIp).toBe('47.100.20.10');
      },
      160,
      25,
    );
    expect(describeCalls).toBeGreaterThanOrEqual(2);
  });

  it('skips aliyun auto-release when the requested destroy time is too close and falls back to platform expiry', async () => {
    const runInstancesBodies: string[] = [];
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const body = typeof init?.body === 'string' ? init.body : '';

      if (body.includes('Action=RunInstances')) {
        runInstancesBodies.push(body);
        return new Response(
          JSON.stringify({
            InstanceIdSets: {
              InstanceIdSet: ['i-short-expire-01'],
            },
          }),
          { status: 200 },
        );
      }

      if (url.includes('Action=DescribeInstances') && url.includes('i-short-expire-01')) {
        return new Response(
          JSON.stringify({
            Instances: {
              Instance: [
                {
                  InstanceId: 'i-short-expire-01',
                  BlockDeviceMappings: { BlockDeviceMapping: [{ DiskId: 'd-short-expire-01' }] },
                  InstanceName: 'short-expire-lab',
                  HostName: 'short-expire-host',
                  Status: 'Running',
                  VpcAttributes: { PrivateIpAddress: { IpAddress: ['10.200.1.30'] } },
                  PublicIpAddress: { IpAddress: ['47.100.20.30'] },
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
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'short-expire-lab',
        hostName: 'short-expire-host',
        platformImageAssetId: 'memory-2',
        cpu: 2,
        memory: 2,
        systemDiskSize: 40,
        expiresAt: new Date(Date.now() + 10 * 60 * 1_000).toISOString(),
        quantity: 1,
        password: '',
        remark: 'short expire fallback',
      })
      .expect(201);

    await waitForAsync(async () => {
      const instance = await repository.getRangeInstanceById(response.body.instances[0].id);
      expect(instance?.status).toBe('running');
      expect(runInstancesBodies).toHaveLength(1);
    });

    expect(runInstancesBodies[0]).not.toContain('AutoReleaseTime=');
    expect(runInstancesBodies[0]).toContain(`ClientToken=${response.body.instances[0].id}`);
  });

  it('executes batch destroy-all through ECS-native APIs and marks child instances destroyed', async () => {
    fetchMock.mockImplementation(async (_input, init) => {
      const body = typeof init?.body === 'string' ? init.body : '';

      if (body.includes('Action=DeleteInstances')) {
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
      expiresAt: new Date(futureExpiration),
    });

    const first = await repository.createRangeInstance({
      name: 'destroy-native-01',
      createdBy: 'admin',
      instanceMode: 'single',
      status: 'running',
      singleInstanceBatchId: batch.id,
      accessEntry: {
        hostRole: 'single-ecs-1',
        publicIp: '47.100.30.10',
        privateIp: '10.0.0.10',
        ssh: 'ssh root@47.100.30.10',
      },
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
      accessEntry: {
        hostRole: 'single-ecs-2',
        publicIp: '47.100.30.11',
        privateIp: '10.0.0.11',
        ssh: 'ssh root@47.100.30.11',
      },
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
      .set('Authorization', `Bearer ${adminToken}`)
      .send({})
      .expect(201);

    expect(response.body.jobCount).toBe(2);

    await waitForAsync(async () => {
      const refreshedFirst = await repository.getRangeInstanceById(first.id);
      const refreshedSecond = await repository.getRangeInstanceById(second.id);

      expect(refreshedFirst?.status).toBe('destroyed');
      expect(refreshedSecond?.status).toBe('destroyed');
      expect(refreshedFirst?.accessEntry?.publicIp).toBe('47.100.30.10');
      expect(refreshedSecond?.accessEntry?.publicIp).toBe('47.100.30.11');
    });
  });

  it('treats ecs instances already auto-released in aliyun as a successful destroy', async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const body = typeof init?.body === 'string' ? init.body : '';

      if (body.includes('Action=DeleteInstances')) {
        return new Response(
          JSON.stringify({
            RequestId: 'delete-gone',
            Code: 'InvalidInstanceId.NotFound',
            Message: 'The specified InstanceId does not exist.',
          }),
          { status: 404 },
        );
      }

      if (url.includes('Action=DescribeInstances') && url.includes('i-auto-release-01')) {
        return new Response(
          JSON.stringify({
            Instances: {
              Instance: [],
            },
          }),
          { status: 200 },
        );
      }

      return new Response(JSON.stringify({ RequestId: 'ok' }), { status: 200 });
    });

    const batch = await repository.createSingleInstanceBatch({
      name: 'auto-release-batch',
      platformImageAssetId: 'memory-2',
      imageId: 'm-platform-image-1',
      imageDisplayName: 'Ubuntu 24.04',
      cpu: 2,
      memory: 2,
      systemDiskSize: 40,
      quantity: 1,
      createdBy: 'admin',
      expiresAt: new Date(futureExpiration),
    });

    const instance = await repository.createRangeInstance({
      name: 'auto-release-01',
      createdBy: 'admin',
      instanceMode: 'single',
      status: 'running',
      singleInstanceBatchId: batch.id,
      accessEntry: {
        hostRole: 'single-ecs-1',
        publicIp: '47.100.40.10',
        privateIp: '10.0.0.40',
        ssh: 'ssh root@47.100.40.10',
      },
      singleInstanceConfig: {
        baseName: 'auto-release',
        quantityIndex: 1,
        hostKey: 'single-ecs-1',
        hostName: 'auto-release-01',
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
          'single-ecs-1': 'i-auto-release-01',
        },
      },
    });

    await request(app.getHttpServer())
      .post(`/admin/instances/batches/${batch.id}/destroy-all`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({})
      .expect(201);

    await waitForAsync(async () => {
      const refreshed = await repository.getRangeInstanceById(instance.id);
      expect(refreshed?.status).toBe('destroyed');
      expect(refreshed?.accessEntry?.publicIp).toBe('47.100.40.10');
    });
  });

  it('retries batch destroy-all while aliyun still reports the ecs instances as initializing', async () => {
    const previousRetryInterval = process.env.SINGLE_INSTANCE_DESTROY_RETRY_INTERVAL_MS;
    process.env.SINGLE_INSTANCE_DESTROY_RETRY_INTERVAL_MS = '1';
    let deleteCalls = 0;
    fetchMock.mockImplementation(async (_input, init) => {
      const body = typeof init?.body === 'string' ? init.body : '';

      if (body.includes('Action=DeleteInstances')) {
        deleteCalls += 1;

        if (deleteCalls < 3) {
          return new Response(
            JSON.stringify({
              RequestId: `retry-${deleteCalls}`,
              Code: 'IncorrectInstanceStatus.Initializing',
              Message: 'You cannot operate this action cause ecs is creating',
            }),
            { status: 403 },
          );
        }

        return new Response(JSON.stringify({ RequestId: 'delete-ok' }), { status: 200 });
      }

      return new Response(JSON.stringify({ RequestId: 'ok' }), { status: 200 });
    });

    const batch = await repository.createSingleInstanceBatch({
      name: 'destroy-retry-batch',
      platformImageAssetId: 'memory-2',
      imageId: 'm-platform-image-1',
      imageDisplayName: 'Ubuntu 24.04',
      cpu: 2,
      memory: 2,
      systemDiskSize: 40,
      quantity: 2,
      createdBy: 'admin',
      expiresAt: new Date(futureExpiration),
    });

    const first = await repository.createRangeInstance({
      name: 'destroy-retry-01',
      createdBy: 'admin',
      instanceMode: 'single',
      status: 'running',
      singleInstanceBatchId: batch.id,
      singleInstanceConfig: {
        baseName: 'destroy-retry',
        quantityIndex: 1,
        hostKey: 'single-ecs-1',
        hostName: 'destroy-retry-01',
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
          'single-ecs-1': 'i-destroy-retry-01',
        },
      },
    });

    const second = await repository.createRangeInstance({
      name: 'destroy-retry-02',
      createdBy: 'admin',
      instanceMode: 'single',
      status: 'running',
      singleInstanceBatchId: batch.id,
      singleInstanceConfig: {
        baseName: 'destroy-retry',
        quantityIndex: 2,
        hostKey: 'single-ecs-2',
        hostName: 'destroy-retry-02',
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
          'single-ecs-2': 'i-destroy-retry-02',
        },
      },
    });

    try {
      await request(app.getHttpServer())
        .post(`/admin/instances/batches/${batch.id}/destroy-all`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({})
        .expect(201);

      await waitForAsync(async () => {
        const refreshedFirst = await repository.getRangeInstanceById(first.id);
        const refreshedSecond = await repository.getRangeInstanceById(second.id);

        expect(refreshedFirst?.status).toBe('destroyed');
        expect(refreshedSecond?.status).toBe('destroyed');
      });
      expect(deleteCalls).toBe(3);
    } finally {
      if (previousRetryInterval === undefined) {
        delete process.env.SINGLE_INSTANCE_DESTROY_RETRY_INTERVAL_MS;
      } else {
        process.env.SINGLE_INSTANCE_DESTROY_RETRY_INTERVAL_MS = previousRetryInterval;
      }
    }
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
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});

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
