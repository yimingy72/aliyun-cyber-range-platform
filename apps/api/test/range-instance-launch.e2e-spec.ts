import { createMemoryAdminRepository } from './support/create-memory-admin-repository';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { hashPassword } from '../src/admin/admin-user-auth';
import { ADMIN_REPOSITORY, type AdminRepository } from '../src/admin/admin.repository';
import { generateAliyunEcsPassword } from '../src/admin/ecs-password-generator';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap/configure-app';
import { SystemConfigService } from '../src/admin/system-config.service';
import { loginAsRepositoryUser, overrideTestOidc } from './support/test-oidc';

let repositoryForLogin: AdminRepository;

function countPasswordCharacterClasses(value: string) {
  return [/[A-Z]/.test(value), /[a-z]/.test(value), /[0-9]/.test(value), /[^A-Za-z0-9\s]/.test(value)].filter(
    Boolean,
  ).length;
}

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

async function loginAs(_app: INestApplication, username = 'admin', _password = 'change-me') {
  return loginAsRepositoryUser(repositoryForLogin, username);
}

describe('Range instance runtime snapshot persistence', () => {
  async function createTemplate(repository: ReturnType<typeof createMemoryAdminRepository>) {
    return repository.createRangeTemplate({
      name: 'Runtime Snapshot Template',
      slug: 'runtime-snapshot-template',
      version: 'v1',
      modulePathOrRef: 'infra/opentofu/modules/alicloud-enterprise-range',
      topologySpec: {
        vpcCidr: '10.99.0.0/16',
        networkZones: [
          { key: 'dmz', name: 'DMZ', purpose: 'public-entry', cidr: '10.99.10.0/24', isPublicEntry: true },
        ],
        hosts: [
          { key: 'checker', name: 'checker', zoneKey: 'dmz', role: 'entry', privateIp: '10.99.10.10', exposePublic: true },
        ],
        publicEntry: {
          hostKey: 'checker',
          protocols: [{ protocol: 'ssh', port: 22 }],
        },
      },
    });
  }

  it('persists runtime and draft snapshots on a created range instance', async () => {
    const repository = createMemoryAdminRepository();

    const template = await createTemplate(repository);

    const created = await repository.createRangeInstance({
      name: '靶场实例 A',
      createdBy: 'admin',
      templateId: template.id,
      expiresAt: '2026-07-08T18:00:00.000Z',
      runtimeTopologyGraph: { schemaVersion: '1', nodes: [], edges: [] },
      runtimeScenarioTemplateSpec: { metadata: { name: '靶场实例 A' } },
      runtimeCompiledProvisionSpec: { topology: { vpcCidr: '10.0.0.0/16' } },
    });

    expect(created.createdBy).toBe('admin');
    expect(created.runtimeTopologyGraph).toEqual(
      expect.objectContaining({ schemaVersion: '1' }),
    );
    expect(created.runtimeScenarioTemplateSpec).toEqual(
      expect.objectContaining({ metadata: expect.objectContaining({ name: '靶场实例 A' }) }),
    );
    expect(created.runtimeCompiledProvisionSpec).toEqual(
      expect.objectContaining({ topology: expect.objectContaining({ vpcCidr: '10.0.0.0/16' }) }),
    );
    expect(created.draftTopologyGraph).toBeNull();
    expect(created.draftScenarioTemplateSpec).toBeNull();
    expect(created.draftCompiledProvisionSpec).toBeNull();
    expect(created.draftUpdatedBy).toBeNull();
    expect(created.draftUpdatedAt).toBeNull();
  });

  it('reads back runtimeCredentials provided to createRangeInstance', async () => {
    const repository = createMemoryAdminRepository();
    const template = await createTemplate(repository);

    const created = await repository.createRangeInstance({
      name: '靶场实例 B',
      templateId: template.id,
      runtimeCredentials: {
        checker: {
          username: 'root',
          password: 'CreateSecret123!',
        },
      },
    });

    const reloaded = await repository.getRangeInstanceById(created.id);

    expect(reloaded?.runtimeCredentials).toEqual({
      checker: {
        username: 'root',
        password: 'CreateSecret123!',
      },
    });
  });

  it('reads back runtimeCredentials written via updateRangeInstance', async () => {
    const repository = createMemoryAdminRepository();
    const template = await createTemplate(repository);

    const created = await repository.createRangeInstance({
      name: '靶场实例 C',
      templateId: template.id,
    });

    await repository.updateRangeInstance(created.id, {
      runtimeCredentials: {
        checker: {
          username: 'admin',
          password: 'UpdateSecret123!',
        },
      },
    });

    const reloaded = await repository.getRangeInstanceById(created.id);

    expect(reloaded?.runtimeCredentials).toEqual({
      checker: {
        username: 'admin',
        password: 'UpdateSecret123!',
      },
    });
  });

  it('clears runtimeCredentials when updateRangeInstance sets it to null', async () => {
    const repository = createMemoryAdminRepository();
    const template = await createTemplate(repository);

    const created = await repository.createRangeInstance({
      name: '靶场实例 D',
      templateId: template.id,
      runtimeCredentials: {
        checker: {
          username: 'operator',
          password: 'ClearSecret123!',
        },
      },
    });

    await repository.updateRangeInstance(created.id, {
      runtimeCredentials: null,
    });

    const reloaded = await repository.getRangeInstanceById(created.id);

    expect(reloaded?.runtimeCredentials).toBeNull();
  });
});

describe('ECS password generator', () => {
  it('falls back to the minimum length when length is NaN', () => {
    const password = generateAliyunEcsPassword(Number.NaN);

    expect(password.length).toBeGreaterThanOrEqual(8);
    expect(password.length).toBeLessThanOrEqual(30);
    expect(password).not.toMatch(/\s/);
    expect(countPasswordCharacterClasses(password)).toBeGreaterThanOrEqual(3);
  });

  it('normalizes fractional lengths before clamping', () => {
    const password = generateAliyunEcsPassword(7.8);

    expect(password).toHaveLength(8);
    expect(password).not.toMatch(/\s/);
    expect(countPasswordCharacterClasses(password)).toBeGreaterThanOrEqual(3);
  });
});

describe('Range instance launch API', () => {
  let app: INestApplication;
  let repository: AdminRepository;
  let templateId: string;
  let userToken: string;

  const launchUser = {
    id: 'range-user-1',
    username: 'range-user',
    password: 'RangeUser123!',
  };

  beforeAll(async () => {
    process.env.ADMIN_USERNAME = 'admin';
    process.env.ADMIN_PASSWORD = 'change-me';
    process.env.ADMIN_TOKEN = 'dev-admin-token';

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

    await repository.createPlatformUser({
      id: launchUser.id,
      username: launchUser.username,
      passwordHash: hashPassword(launchUser.password),
      role: 'user',
      status: 'active',
    });
    await repository.upsertImageSnapshots({
      provider: 'alibaba_cloud',
      accountUid: null,
      regionId: 'cn-hangzhou',
      scope: 'custom',
      snapshots: [
        {
          imageId: 'm-range-launch-image',
          sourceImageName: 'Range launch image',
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
      imageId: 'm-range-launch-image',
    });
    const imageAsset = await repository.collectPlatformImageAsset({
      snapshotId: imageSnapshot!.id,
      displayName: 'Range launch image',
      ownerUserId: launchUser.id,
      visibility: 'private',
    });

    const template = await repository.createRangeTemplate({
      name: 'Launchable Template',
      createdBy: launchUser.id,
      ownerUserId: launchUser.id,
      slug: 'launchable-template',
      visibility: 'private',
      version: 'v1',
      modulePathOrRef: 'infra/opentofu/modules/alicloud-enterprise-range',
      topologySpec: {
        vpcCidr: '10.90.0.0/16',
        networkZones: [
          { key: 'dmz', name: 'DMZ', purpose: 'public-entry', cidr: '10.90.10.0/24', isPublicEntry: true },
        ],
        hosts: [
          { key: 'entry-host', name: 'entry-host', zoneKey: 'dmz', role: 'entry', privateIp: '10.90.10.10', exposePublic: true },
          { key: 'db-host', name: 'db-host', zoneKey: 'dmz', role: 'target', privateIp: '10.90.10.20' },
        ],
        publicEntry: {
          hostKey: 'entry-host',
          protocols: [{ protocol: 'ssh', port: 22 }],
        },
      },
      topologyGraph: {
        schemaVersion: '1',
        nodes: [
          {
            id: 'entry-host',
            kind: 'ecs',
            data: {
              label: 'entry-host',
              platformImageAssetId: imageAsset.id,
              image: imageAsset.displayName,
              imageName: imageAsset.displayName,
              imageId: imageAsset.imageId,
              imageStrategy: { mode: 'fixed', imageId: imageAsset.imageId },
            },
          },
          {
            id: 'db-host',
            kind: 'ecs',
            data: {
              label: 'db-host',
              platformImageAssetId: imageAsset.id,
              image: imageAsset.displayName,
              imageName: imageAsset.displayName,
              imageId: imageAsset.imageId,
              imageStrategy: { mode: 'fixed', imageId: imageAsset.imageId },
            },
          },
        ],
        edges: [],
      },
      scenarioTemplateSpec: {
        metadata: { name: 'Launchable Template' },
        hosts: [
          {
            key: 'entry-host',
            accountPreset: {
              password: '  TemplateSecret123!  ',
            },
          },
          {
            key: 'db-host',
            accountPreset: {
              password: '',
            },
          },
        ],
      },
      compiledProvisionSpec: {
        topology: { vpcCidr: '10.90.0.0/16' },
      },
    });

    templateId = template.id;
    userToken = await loginAs(app, launchUser.username, launchUser.password);
  });

  afterAll(async () => {
    await app.close();
  });

  it('launches a range instance atomically with snapshots and a pending create job', async () => {
    const response = await request(app.getHttpServer())
      .post('/admin/ranges/launch')
      .set('authorization', `Bearer ${userToken}`)
      .send({
        templateId,
        name: '攻防实例-一号',
        expiresAt: '2026-07-09T12:00:00.000Z',
      })
      .expect(201);

    expect(response.body).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        name: '攻防实例-一号',
        status: 'pending_create',
        createdBy: launchUser.username,
        ownerUserId: launchUser.id,
        expiresAt: '2026-07-09T12:00:00.000Z',
        lastJobId: expect.any(String),
        runtimeTopologyGraph: expect.objectContaining({
          schemaVersion: '1',
        }),
        runtimeScenarioTemplateSpec: expect.objectContaining({
          metadata: expect.objectContaining({
            name: 'Launchable Template',
          }),
        }),
        runtimeCompiledProvisionSpec: expect.objectContaining({
          topology: expect.objectContaining({
            vpcCidr: '10.90.0.0/16',
          }),
        }),
      }),
    );
  });

  it('reuses custom host passwords and generates per-host runtime passwords during launch', async () => {
    const launchResponse = await request(app.getHttpServer())
      .post('/admin/ranges/launch')
      .set('authorization', `Bearer ${userToken}`)
      .send({
        templateId,
        name: '攻防实例-二号',
        expiresAt: '2026-07-10T12:00:00.000Z',
      })
      .expect(201);

    expect(launchResponse.body.runtimeCredentials).toEqual(
      expect.objectContaining({
        'entry-host': {
          username: 'root',
          password: 'TemplateSecret123!',
        },
        'db-host': {
          username: 'root',
          password: expect.any(String),
        },
      }),
    );

    expect(launchResponse.body.runtimeCredentials['db-host'].password).not.toEqual('TemplateSecret123!');
    expect(launchResponse.body.runtimeCredentials['db-host'].password).not.toEqual('');
    expect(launchResponse.body.runtimeCredentials['db-host'].password.length).toBeGreaterThanOrEqual(8);
    expect(launchResponse.body.runtimeCredentials['db-host'].password.length).toBeLessThanOrEqual(30);
    expect(launchResponse.body.runtimeCredentials['db-host'].password).not.toMatch(/\s/);
    expect(countPasswordCharacterClasses(launchResponse.body.runtimeCredentials['db-host'].password)).toBeGreaterThanOrEqual(3);

    const detailResponse = await request(app.getHttpServer())
      .get(`/admin/ranges/${launchResponse.body.id}`)
      .set('authorization', `Bearer ${userToken}`)
      .expect(200);

    expect(detailResponse.body).toEqual(
      expect.objectContaining({
        id: launchResponse.body.id,
        runtimeCredentials: launchResponse.body.runtimeCredentials,
      }),
    );
  });

  it('rejects launching a legacy template whose ECS directly references an Alibaba Cloud image', async () => {
    const legacyTemplate = await repository.createRangeTemplate({
      name: 'Legacy Image Template',
      createdBy: launchUser.id,
      ownerUserId: launchUser.id,
      slug: 'legacy-image-template',
      visibility: 'private',
      version: 'v1',
      modulePathOrRef: 'infra/opentofu/modules/alicloud-enterprise-range',
      topologySpec: {
        vpcCidr: '10.91.0.0/16',
        networkZones: [
          { key: 'dmz', name: 'DMZ', purpose: 'public-entry', cidr: '10.91.10.0/24', isPublicEntry: true },
        ],
        hosts: [
          { key: 'entry-host', name: 'entry-host', zoneKey: 'dmz', role: 'entry', privateIp: '10.91.10.10', exposePublic: true },
        ],
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

    const response = await request(app.getHttpServer())
      .post('/admin/ranges/launch')
      .set('authorization', `Bearer ${userToken}`)
      .send({
        templateId: legacyTemplate.id,
        name: '旧模板实例',
        expiresAt: '2026-07-12T12:00:00.000Z',
      })
      .expect(400);

    expect(response.body.message).toBe('入口 ECS 请选择镜像');
  });

  it('rejects client-sent triggeredBy on range launch requests', async () => {
    await request(app.getHttpServer())
      .post('/admin/ranges/launch')
      .set('authorization', `Bearer ${userToken}`)
      .send({
        templateId,
        name: '攻防实例-三号',
        expiresAt: '2026-07-11T12:00:00.000Z',
        triggeredBy: 'malicious-client',
      })
      .expect(400)
      .expect(({ body }) => {
        expect(body.message).toEqual(expect.arrayContaining(['property triggeredBy should not exist']));
      });
  });
});
