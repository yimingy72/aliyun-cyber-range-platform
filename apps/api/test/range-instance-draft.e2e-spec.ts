import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  compileTemplateTopology,
  type ScenarioGraphDraft,
  type TemplateAuthoringMetadata,
} from '@aliyun-cyber-range/scenario-runtime';
import request from 'supertest';

import { hashPassword } from '../src/admin/admin-user-auth';
import { ADMIN_REPOSITORY, type AdminRepository } from '../src/admin/admin.repository';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap/configure-app';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';
import { loginAsRepositoryUser, overrideTestOidc } from './support/test-oidc';

let repositoryForLogin: AdminRepository;

async function loginAs(_app: INestApplication, username = 'admin', _password = 'change-me') {
  return loginAsRepositoryUser(repositoryForLogin, username);
}

describe('Range instance draft API', () => {
  let app: INestApplication;
  let repository: AdminRepository;
  let instanceId: string;
  let userToken: string;

  const draftUser = {
    id: 'draft-user-1',
    username: 'draft-user',
    password: 'DraftUser123!',
  };
  const draftMetadata: TemplateAuthoringMetadata = {
    name: 'Draft Template',
    slug: 'draft-template',
    version: 'v1',
    cloudProvider: 'alibaba_cloud',
    iacType: 'opentofu',
    modulePathOrRef: 'infra/opentofu/modules/alicloud-enterprise-range',
    primaryVpcCidr: '10.77.0.0/16',
  };
  const validGraph: ScenarioGraphDraft & {
    viewport: { x: number; y: number; zoom: number };
  } = {
    schemaVersion: '2.0.0',
    viewport: { x: 24, y: 48, zoom: 1 },
    nodes: [
      {
        id: 'router-main',
        kind: 'router',
        label: '主 VPC',
        routeRole: 'vpc',
        egressType: 'none',
        bindEip: false,
      },
      {
        id: 'switch-dmz',
        kind: 'switch',
        label: 'DMZ',
        zoneKey: 'dmz',
        cidr: '10.77.10.0/24',
        purpose: 'public-entry',
        aclRules: [],
        nat: {
          snatEnabled: false,
          dnatMappings: [
            {
              key: 'entry-ssh',
              targetHostId: 'ecs-entry',
              externalPort: 22,
              internalPort: 22,
              protocol: 'tcp',
            },
          ],
        },
      },
      {
        id: 'ecs-entry',
        kind: 'ecs',
        label: '入口 ECS',
        zoneKey: 'dmz',
        role: 'entry',
        privateIp: '10.77.10.10',
        exposePublic: false,
        image: 'img-entry',
        imageId: 'img-entry',
        platformImageAssetId: 'asset-entry',
        dnatMappings: [],
        networkInterfaces: [],
        portGroups: [],
        initScript: '',
        imageStrategy: { mode: 'fixed', imageId: 'img-entry' },
        instanceTypeStrategy: { mode: 'auto' },
        nics: [
          {
            id: 'nic-entry',
            switchId: 'switch-dmz',
            privateIp: '10.77.10.10',
            secondaryIps: [],
            securityGroupRules: [],
          },
        ],
      },
    ],
    edges: [
      {
        id: 'router-to-switch',
        fromNodeId: 'router-main',
        toNodeId: 'switch-dmz',
        relationType: 'manual',
      },
      {
        id: 'switch-to-entry',
        fromNodeId: 'switch-dmz',
        toNodeId: 'ecs-entry',
        relationType: 'manual',
      },
    ],
  };
  let validDraftPayload = (() => {
    const compiled = compileTemplateTopology(validGraph, draftMetadata);

    return {
      draftTopologyGraph: {
        ...compiled.topologyGraph,
        viewport: validGraph.viewport,
      },
      draftTopologySpec: compiled.topologySpec,
      draftScenarioTemplateSpec: compiled.scenarioTemplateSpec,
      draftCompiledProvisionSpec: compiled.compiledProvisionSpec,
    };
  })();

  beforeAll(async () => {
    process.env.ADMIN_USERNAME = 'admin';
    process.env.ADMIN_PASSWORD = 'change-me';
    process.env.ADMIN_TOKEN = 'dev-admin-token';

    const moduleRef = await overrideTestOidc(Test.createTestingModule({
      imports: [AppModule],
    }))
      .overrideProvider(ADMIN_REPOSITORY)
      .useValue(createMemoryAdminRepository())
      .compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();

    repository = app.get(ADMIN_REPOSITORY);
    await repository.upsertImageSnapshots({ provider: 'alibaba_cloud', accountUid: null, regionId: 'cn-hangzhou', scope: 'public',
      snapshots: [{ imageId: 'img-entry', sourceImageName: 'Draft fixture image', status: 'Available', isAvailable: true, lastSyncedAt: new Date() }],
    });
    const [fixtureSnapshot] = await repository.listImageSnapshots({ imageId: 'img-entry' });
    const fixtureAsset = await repository.collectPlatformImageAsset({ snapshotId: fixtureSnapshot!.id, displayName: 'Draft fixture image', ownerUserId: 'admin', visibility: 'platform' });
    const fixtureHost: any = validGraph.nodes.find(node => node.kind === 'ecs');
    fixtureHost.platformImageAssetId = fixtureAsset.id;
    const compiledFixture = JSON.parse(JSON.stringify(compileTemplateTopology(validGraph, draftMetadata)));
    validDraftPayload = {
      draftTopologyGraph: { ...compiledFixture.topologyGraph, viewport: validGraph.viewport },
      draftTopologySpec: compiledFixture.topologySpec, draftScenarioTemplateSpec: compiledFixture.scenarioTemplateSpec,
      draftCompiledProvisionSpec: compiledFixture.compiledProvisionSpec,
    };


    repositoryForLogin = repository;

    await repository.createPlatformUser({
      id: draftUser.id,
      username: draftUser.username,
      passwordHash: hashPassword(draftUser.password),
      role: 'user',
      status: 'active',
    });

    const template = await repository.createRangeTemplate({
      name: 'Draft Template',
      createdBy: draftUser.id,
      ownerUserId: draftUser.id,
      slug: 'draft-template',
      visibility: 'private',
      version: 'v1',
      modulePathOrRef: 'infra/opentofu/modules/alicloud-enterprise-range',
      topologySpec: {
        vpcCidr: '10.77.0.0/16',
        networkZones: [
          { key: 'dmz', name: 'DMZ', purpose: 'public-entry', cidr: '10.77.10.0/24', isPublicEntry: true },
        ],
        hosts: [
          { key: 'checker', name: 'checker', zoneKey: 'dmz', role: 'entry', privateIp: '10.77.10.10', exposePublic: true },
        ],
        publicEntry: {
          hostKey: 'checker',
          protocols: [{ protocol: 'ssh', port: 22 }],
        },
      },
    });

    const instance = await repository.createRangeInstance({
      name: 'draft-range',
      createdBy: draftUser.id,
      ownerUserId: draftUser.id,
      templateId: template.id,
      status: 'running',
      runtimeTopologyGraph: {
        schemaVersion: '1',
        nodes: [{ id: 'host-checker', kind: 'ecs', data: { label: 'checker' } }],
        edges: [],
      },
      runtimeScenarioTemplateSpec: {
        metadata: {
          name: draftMetadata.name,
          slug: draftMetadata.slug,
          version: draftMetadata.version,
          cloudProvider: draftMetadata.cloudProvider,
          iacType: draftMetadata.iacType,
        },
        topology: { vpcCidr: draftMetadata.primaryVpcCidr },
      },
      runtimeCompiledProvisionSpec: {
        topology: { vpcCidr: '10.77.0.0/16' },
      },
    });

    instanceId = instance.id;
    userToken = await loginAs(app, draftUser.username, draftUser.password);
  });

  afterAll(async () => {
    await app.close();
  });

  it('saves only server-compiled artifacts for a valid running instance', async () => {
    const response = await request(app.getHttpServer())
      .patch(`/admin/ranges/${instanceId}/draft`)
      .set('authorization', `Bearer ${userToken}`)
      .send({ ...validDraftPayload, expectedDraftRevision: 0 })
      .expect(200);

    expect(response.body.status).toBe('running');
    expect(response.body.draftTopologyGraph.viewport).toEqual({ x: 24, y: 48, zoom: 1 });
    expect(response.body.draftTopologySpec.publicEntry.hostKey).toBe('ecs-entry');
    expect(response.body.draftCompiledProvisionSpec.topology.entryHostKey).toBe('ecs-entry');
    expect(response.body.draftRevision).toBe(1);
    expect(response.body.draftUpdatedBy).toBe(draftUser.id);

    const persisted = await repository.getRangeInstanceById(instanceId);

    expect(persisted?.draftUpdatedBy).toBe(draftUser.id);
    expect(persisted?.draftTopologySpec).toEqual(validDraftPayload.draftTopologySpec);
    expect(persisted?.draftRevision).toBe(1);
  });

  it('rejects artifacts that do not match the graph-derived DNAT entry host', async () => {
    await request(app.getHttpServer())
      .patch(`/admin/ranges/${instanceId}/draft`)
      .set('authorization', `Bearer ${userToken}`)
      .send({
        ...validDraftPayload,
        expectedDraftRevision: 1,
        draftCompiledProvisionSpec: {
          ...validDraftPayload.draftCompiledProvisionSpec,
          topology: {
            ...((validDraftPayload.draftCompiledProvisionSpec.topology as Record<string, unknown>) ?? {}),
            entryHostKey: 'ecs-not-entry',
          },
        },
      })
      .expect(400);

    const persisted = await repository.getRangeInstanceById(instanceId);
    expect(persisted?.draftRevision).toBe(1);
    expect(persisted?.draftCompiledProvisionSpec).toEqual(validDraftPayload.draftCompiledProvisionSpec);
  });

  it('rejects a stale draft revision without overwriting the newer draft', async () => {
    await request(app.getHttpServer())
      .patch(`/admin/ranges/${instanceId}/draft`)
      .set('authorization', `Bearer ${userToken}`)
      .send({ ...validDraftPayload, expectedDraftRevision: 1 })
      .expect(200);

    await request(app.getHttpServer())
      .patch(`/admin/ranges/${instanceId}/draft`)
      .set('authorization', `Bearer ${userToken}`)
      .send({ ...validDraftPayload, expectedDraftRevision: 1 })
      .expect(409);

    const persisted = await repository.getRangeInstanceById(instanceId);
    expect(persisted?.draftRevision).toBe(2);
  });

  it('discards the saved draft and clears every draft artifact', async () => {
    const response = await request(app.getHttpServer())
      .delete(`/admin/ranges/${instanceId}/draft`)
      .set('authorization', `Bearer ${userToken}`)
      .expect(200);

    expect(response.body.draftTopologyGraph).toBeNull();
    expect(response.body.draftTopologySpec).toBeNull();
    expect(response.body.draftScenarioTemplateSpec).toBeNull();
    expect(response.body.draftCompiledProvisionSpec).toBeNull();
    expect(response.body.draftUpdatedBy).toBeNull();
    expect(response.body.draftRevision).toBe(3);
  });

  it('keeps a destroyed instance draft immutable', async () => {
    const historicalInstance = await repository.createRangeInstance({
      name: 'historical-draft-range',
      createdBy: draftUser.id,
      ownerUserId: draftUser.id,
      templateId: 'historical-template',
      status: 'destroyed',
      draftTopologyGraph: validDraftPayload.draftTopologyGraph,
      draftTopologySpec: validDraftPayload.draftTopologySpec,
      draftScenarioTemplateSpec: validDraftPayload.draftScenarioTemplateSpec,
      draftCompiledProvisionSpec: validDraftPayload.draftCompiledProvisionSpec,
      draftRevision: 1,
    });

    await request(app.getHttpServer())
      .patch(`/admin/ranges/${historicalInstance.id}/draft`)
      .set('authorization', `Bearer ${userToken}`)
      .send({ ...validDraftPayload, expectedDraftRevision: 1 })
      .expect(409);

    await request(app.getHttpServer())
      .delete(`/admin/ranges/${historicalInstance.id}/draft`)
      .set('authorization', `Bearer ${userToken}`)
      .expect(409);

    await expect(repository.getRangeInstanceById(historicalInstance.id)).resolves.toEqual(
      expect.objectContaining({
        status: 'destroyed',
        draftTopologyGraph: validDraftPayload.draftTopologyGraph,
        draftRevision: 1,
      }),
    );
  });

  it('rejects client-sent draftUpdatedBy on draft save requests', async () => {
    await request(app.getHttpServer())
      .patch(`/admin/ranges/${instanceId}/draft`)
      .set('authorization', `Bearer ${userToken}`)
      .send({
        ...validDraftPayload,
        expectedDraftRevision: 3,
        draftUpdatedBy: 'malicious-client',
      })
      .expect(400)
      .expect(({ body }) => {
        expect(body.message).toEqual(expect.arrayContaining(['property draftUpdatedBy should not exist']));
      });
  });
});
