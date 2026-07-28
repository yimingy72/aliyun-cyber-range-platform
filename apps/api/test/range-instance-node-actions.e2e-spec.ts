import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { ADMIN_REPOSITORY, type AdminRepository } from '../src/admin/admin.repository';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap/configure-app';
import { SystemConfigService } from '../src/admin/system-config.service';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';
import { loginAsRepositoryUser, overrideTestOidc } from './support/test-oidc';

let repositoryForLogin: AdminRepository;

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

describe('Range instance node actions API', () => {
  let app: INestApplication;
  let repository: AdminRepository;
  let instanceId: string;
  let singleInstanceId: string;
  let singlePlatformImageAssetId: string;
  let fetchMock: jest.SpiedFunction<typeof fetch>;
  let adminToken: string;

  beforeAll(async () => {
    process.env.ADMIN_USERNAME = 'admin';
    process.env.ADMIN_PASSWORD = 'change-me';
    process.env.ADMIN_TOKEN = 'dev-admin-token';
    process.env.PLATFORM_IMAGE_SECRET_KEY = 'node-action-test-image-secret';

    fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);

      if (url.includes('DescribeInstanceVncUrl')) {
        return new Response(JSON.stringify({ VncUrl: 'wss://vnc.example.test' }), { status: 200 });
      }

      if (url.includes('CreateImage')) {
        return new Response(JSON.stringify({ ImageId: 'm-image-123' }), { status: 200 });
      }

      if (url.includes('DescribeImages')) {
        return new Response(
          JSON.stringify({
            Images: {
              Image: {
                ImageId: 'm-image-123',
                DiskDeviceMappings: {
                  DiskDeviceMapping: [{ SnapshotId: 's-image-123' }],
                },
              },
            },
          }),
          { status: 200 },
        );
      }

      return new Response(JSON.stringify({ RequestId: 'ok' }), { status: 200 });
    });

    const moduleRef = await overrideTestOidc(Test.createTestingModule({
      imports: [AppModule],
    }))
      .overrideProvider(ADMIN_REPOSITORY)
      .useValue(createMemoryAdminRepository())
      .overrideProvider(SystemConfigService)
      .useValue(createSystemConfigServiceStub())
      .compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();

    repository = app.get(ADMIN_REPOSITORY);
    repositoryForLogin = repository;

    const template = await repository.createRangeTemplate({
      name: 'Node Action Template',
      slug: 'node-action-template',
      version: 'v1',
      modulePathOrRef: 'infra/opentofu/modules/alicloud-enterprise-range',
      topologySpec: {
        vpcCidr: '10.33.0.0/16',
        networkZones: [
          { key: 'dmz', name: 'DMZ', purpose: 'public-entry', cidr: '10.33.10.0/24', isPublicEntry: true },
        ],
        hosts: [
          { key: 'ecs-1', name: 'ecs-1', zoneKey: 'dmz', role: 'entry', privateIp: '10.33.10.10', exposePublic: true },
        ],
        publicEntry: {
          hostKey: 'ecs-1',
          protocols: [{ protocol: 'ssh', port: 22 }],
        },
      },
    });

    const instance = await repository.createRangeInstance({
      name: 'node-action-range',
      createdBy: 'admin',
      templateId: template.id,
      status: 'running',
      resourceSummary: {
        mode: 'opentofu',
        hostIds: {
          'ecs-1': 'i-instance-123',
        },
      },
    });

    instanceId = instance.id;

    await repository.upsertImageSnapshots({
      provider: 'alibaba_cloud',
      accountUid: null,
      regionId: 'cn-hangzhou',
      scope: 'custom',
      snapshots: [
        {
          imageId: 'm-image-123',
          sourceImageName: 'Ubuntu image',
          osType: 'linux',
          platform: 'Ubuntu',
          status: 'Available',
          isAvailable: true,
          lastSyncedAt: new Date('2026-07-08T08:00:00.000Z'),
        },
      ],
    });

    const singlePlatformImageAsset = await repository.collectPlatformImageAsset({
      snapshotId:
        (
          await repository.listImageSnapshots({
            provider: 'alibaba_cloud',
            accountUid: null,
            regionId: 'cn-hangzhou',
            scope: 'custom',
            imageId: 'm-image-123',
          })
        )[0].id,
      displayName: 'Ubuntu',
      visibility: 'platform',
    });

    singlePlatformImageAssetId = singlePlatformImageAsset.id;

    const singleInstance = await repository.createRangeInstance({
      name: 'node-action-single',
      createdBy: 'admin',
      instanceMode: 'single',
      status: 'running',
      singleInstanceConfig: {
        baseName: 'node-action-single',
        quantityIndex: 1,
        hostKey: 'single-ecs-1',
        hostName: 'single-ecs-1',
        platformImageAssetId: singlePlatformImageAssetId,
        imageId: 'm-image-123',
        imageDisplayName: 'Ubuntu',
        cpu: 2,
        memory: 2,
        systemDiskSize: 40,
      },
      resourceSummary: {
        mode: 'opentofu',
        hostIds: {
          'single-ecs-1': 'i-instance-single-123',
        },
      },
    });

    singleInstanceId = singleInstance.id;
    adminToken = await loginAs(app);
  });

  afterAll(async () => {
    fetchMock.mockRestore();
    await app.close();
  });

  it('reboots a host node through the node action route', async () => {
    const response = await request(app.getHttpServer())
      .post(`/admin/ranges/${instanceId}/nodes/ecs-1/actions/reboot`)
      .set('authorization', `Bearer ${adminToken}`)
      .send({ triggeredBy: 'admin' })
      .expect(201);

    expect(response.body.status).toBe('accepted');
  });

  it('opens a VNC URL for the selected host node', async () => {
    const response = await request(app.getHttpServer())
      .post(`/admin/ranges/${instanceId}/nodes/ecs-1/actions/open-vnc`)
      .set('authorization', `Bearer ${adminToken}`)
      .send({ triggeredBy: 'admin' })
      .expect(201);

    expect(response.body.vncUrl).toBe('wss://vnc.example.test');
    expect(response.body.webTerminalUrl).toContain('index.html?vncUrl=');
    expect(response.body.webTerminalUrl).toContain('instanceId=i-instance-123');
  });

  it('explains why node actions are unavailable for a dry-run range', async () => {
    fetchMock.mockClear();

    const dryRunInstance = await repository.createRangeInstance({
      name: 'dry-run-node-action-range',
      createdBy: 'admin',
      status: 'running',
      resourceSummary: {
        mode: 'dry-run',
      },
    });

    const response = await request(app.getHttpServer())
      .post(`/admin/ranges/${dryRunInstance.id}/nodes/ecs-1/actions/reboot`)
      .set('authorization', `Bearer ${adminToken}`)
      .send({})
      .expect(409);

    expect(response.body.message).toContain('dry-run 模式创建');
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining('RebootInstance'), expect.anything());
  });

  it('creates a custom image and platform asset from the selected host node', async () => {
    const response = await request(app.getHttpServer())
      .post(`/admin/ranges/${instanceId}/nodes/ecs-1/actions/pack-image`)
      .set('authorization', `Bearer ${adminToken}`)
      .send({
        displayName: 'checker-snapshot',
        defaultHostName: 'checker-host',
        defaultPassword: 'DefaultPass123!',
        description: 'snapshot note',
        triggeredBy: 'admin',
      })
      .expect(201);

    expect(response.body.imageId).toBe('m-image-123');
    expect(response.body.defaultHostName).toBe('checker-host');
    expect(response.body.defaultPassword).toBe('DefaultPass123!');
    expect(response.body.description).toBe('snapshot note');
    expect(response.body.imageReady).toBe(false);
    expect(response.body.platformImageAsset).toEqual(
      expect.objectContaining({
        imageId: 'm-image-123',
        displayName: 'checker-snapshot',
        defaultHostName: 'checker-host',
        defaultPassword: expect.stringMatching(/^enc:v1:/),
        description: 'snapshot note',
        ownerUserId: 'admin',
        visibility: 'private',
      }),
    );
    const snapshotTagRequest = fetchMock.mock.calls
      .map(([input]) => String(input))
      .find((url) => url.includes('Action=TagResources') && url.includes('ResourceType=snapshot'));
    expect(snapshotTagRequest).toContain('ResourceId.1=s-image-123');
    expect(snapshotTagRequest).toContain('PlatformManaged');
    expect(snapshotTagRequest).toContain('PlatformResourceType');
  });

  it('opens a VNC URL for a single instance row action', async () => {
    const response = await request(app.getHttpServer())
      .post(`/admin/instances/${singleInstanceId}/actions/open-vnc`)
      .set('authorization', `Bearer ${adminToken}`)
      .send({ triggeredBy: 'admin' })
      .expect(201);

    expect(response.body.vncUrl).toBe('wss://vnc.example.test');
    expect(response.body.webTerminalUrl).toContain('instanceId=i-instance-single-123');
    expect(response.body.webTerminalUrl).toContain('isWindows=false');
  });

  it('creates a custom image from a single instance row action preserving caller metadata', async () => {
    const createImageRequests: string[] = [];

    fetchMock.mockImplementation(async (input) => {
      const url = String(input);

      if (url.includes('CreateImage')) {
        createImageRequests.push(url);
        return new Response(JSON.stringify({ ImageId: 'm-image-single-456' }), { status: 200 });
      }

      return new Response(JSON.stringify({ RequestId: 'ok' }), { status: 200 });
    });

    const response = await request(app.getHttpServer())
      .post(`/admin/instances/${singleInstanceId}/actions/pack-image`)
      .set('authorization', `Bearer ${adminToken}`)
      .send({
        displayName: 'single-snapshot',
        defaultHostName: 'single-host',
        defaultPassword: 'SinglePass123!',
        description: 'single snapshot note',
        triggeredBy: 'admin',
      })
      .expect(201);

    expect(response.body.imageId).toBe('m-image-single-456');
    expect(response.body.defaultHostName).toBe('single-host');
    expect(response.body.defaultPassword).toBe('SinglePass123!');
    expect(response.body.description).toBe('single snapshot note');
    expect(response.body.imageReady).toBe(false);
    expect(response.body.platformImageAsset).toEqual(
      expect.objectContaining({
        imageId: 'm-image-single-456',
        displayName: 'single-snapshot',
        defaultHostName: 'single-host',
        defaultPassword: expect.stringMatching(/^enc:v1:/),
        description: 'single snapshot note',
        ownerUserId: 'admin',
        visibility: 'private',
      }),
    );
    await expect(repository.listBillingLedgerResources()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          cloudResourceId: 'm-image-single-456',
          cloudResourceType: 'image',
          platformImageAssetId: response.body.platformImageAsset.id,
        }),
        expect.objectContaining({
          cloudResourceId: 'm-image-single-456',
          cloudResourceType: 'snapshot',
          platformImageAssetId: response.body.platformImageAsset.id,
        }),
      ]),
    );
    expect(createImageRequests).toHaveLength(1);
    expect(createImageRequests[0]).toContain('CreatedBy');
    expect(createImageRequests[0]).toContain('PlatformScope');
    expect(createImageRequests[0]).toContain('RangeInstanceId');
    expect(createImageRequests[0]).toContain('BillingStartAt');
  });

  it('keeps a packed image and its billing ledger assigned to the instance owner when an admin performs the action', async () => {
    const owner = await repository.createPlatformUser({
      id: 'user-image-owner',
      username: 'image-owner',
      passwordHash: 'unused',
      role: 'user',
    });
    const ownerInstance = await repository.createRangeInstance({
      name: 'owner-node-action-single',
      createdBy: owner.id,
      ownerUserId: owner.id,
      instanceMode: 'single',
      status: 'running',
      singleInstanceConfig: {
        baseName: 'owner-node-action-single',
        quantityIndex: 1,
        hostKey: 'single-ecs-owner',
        hostName: 'single-ecs-owner',
        platformImageAssetId: singlePlatformImageAssetId,
        imageId: 'm-image-123',
        imageDisplayName: 'Ubuntu',
        cpu: 2,
        memory: 2,
        systemDiskSize: 40,
      },
      resourceSummary: {
        mode: 'opentofu',
        hostIds: {
          'single-ecs-owner': 'i-instance-owner-123',
        },
      },
    });

    fetchMock.mockImplementation(async (input) => {
      const url = String(input);

      if (url.includes('CreateImage')) {
        return new Response(JSON.stringify({ ImageId: 'm-image-owner-789' }), { status: 200 });
      }

      return new Response(JSON.stringify({ RequestId: 'ok' }), { status: 200 });
    });

    const response = await request(app.getHttpServer())
      .post(`/admin/instances/${ownerInstance.id}/actions/pack-image`)
      .set('authorization', `Bearer ${adminToken}`)
      .send({
        displayName: 'owner-snapshot',
        defaultPassword: 'OwnerPass123!',
      })
      .expect(201);

    expect(response.body.platformImageAsset).toEqual(
      expect.objectContaining({
        imageId: 'm-image-owner-789',
        ownerUserId: owner.id,
        visibility: 'private',
      }),
    );
    await expect(repository.listBillingLedgerResources()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          cloudResourceId: 'm-image-owner-789',
          cloudResourceType: 'image',
          ownerUserId: owner.id,
          billingScope: 'user',
          rangeInstanceId: ownerInstance.id,
        }),
        expect.objectContaining({
          cloudResourceId: 'm-image-owner-789',
          cloudResourceType: 'snapshot',
          ownerUserId: owner.id,
          billingScope: 'user',
          rangeInstanceId: ownerInstance.id,
        }),
      ]),
    );
  });

  it('keeps a range-node packed image assigned to the range owner when an admin performs the action', async () => {
    const owner = await repository.createPlatformUser({
      id: 'user-range-image-owner',
      username: 'range-image-owner',
      passwordHash: 'unused',
      role: 'user',
    });
    const ownerRange = await repository.createRangeInstance({
      name: 'owner-node-action-range',
      createdBy: owner.id,
      ownerUserId: owner.id,
      status: 'running',
      resourceSummary: {
        mode: 'opentofu',
        hostIds: {
          'ecs-owner': 'i-instance-range-owner-123',
        },
      },
    });

    fetchMock.mockImplementation(async (input) => {
      const url = String(input);

      if (url.includes('CreateImage')) {
        return new Response(JSON.stringify({ ImageId: 'm-image-range-owner-790' }), { status: 200 });
      }

      return new Response(JSON.stringify({ RequestId: 'ok' }), { status: 200 });
    });

    const response = await request(app.getHttpServer())
      .post(`/admin/ranges/${ownerRange.id}/nodes/ecs-owner/actions/pack-image`)
      .set('authorization', `Bearer ${adminToken}`)
      .send({
        displayName: 'range-owner-snapshot',
        defaultPassword: 'RangeOwnerPass123!',
      })
      .expect(201);

    expect(response.body.platformImageAsset).toEqual(
      expect.objectContaining({
        imageId: 'm-image-range-owner-790',
        ownerUserId: owner.id,
        visibility: 'private',
      }),
    );
    await expect(repository.listBillingLedgerResources()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          cloudResourceId: 'm-image-range-owner-790',
          cloudResourceType: 'image',
          ownerUserId: owner.id,
          billingScope: 'user',
          rangeInstanceId: ownerRange.id,
        }),
        expect.objectContaining({
          cloudResourceId: 'm-image-range-owner-790',
          cloudResourceType: 'snapshot',
          ownerUserId: owner.id,
          billingScope: 'user',
          rangeInstanceId: ownerRange.id,
        }),
      ]),
    );
  });

  it('rejects malformed metadata on a single instance row action with 400', async () => {
    await request(app.getHttpServer())
      .post(`/admin/instances/${singleInstanceId}/actions/pack-image`)
      .set('authorization', `Bearer ${adminToken}`)
      .send({
        displayName: {
          bad: true,
        },
      })
      .expect(400);
  });
});
