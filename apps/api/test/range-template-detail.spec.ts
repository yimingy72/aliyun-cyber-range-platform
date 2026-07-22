import { RangeTemplatesService } from '../src/admin/range-templates.service';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';

async function createPrivateImageAsset(
  repository: ReturnType<typeof createMemoryAdminRepository>,
  ownerUserId: string,
) {
  await repository.upsertImageSnapshots({
    provider: 'alibaba_cloud',
    accountUid: null,
    regionId: 'cn-hangzhou',
    scope: 'custom',
    snapshots: [
      {
        imageId: 'm-owner-image',
        sourceImageName: 'Owner Image',
        status: 'Available',
        isAvailable: true,
        lastSyncedAt: new Date('2026-07-21T00:00:00.000Z'),
      },
    ],
  });
  const [snapshot] = await repository.listImageSnapshots({
    provider: 'alibaba_cloud',
    accountUid: null,
    regionId: 'cn-hangzhou',
    scope: 'custom',
    imageId: 'm-owner-image',
  });

  return repository.collectPlatformImageAsset({
    snapshotId: snapshot!.id,
    displayName: '我的渗透靶机',
    ownerUserId,
    visibility: 'private',
  });
}

function createCompleteTopology(imageAsset: { id: string; imageId: string; displayName: string }) {
  const topologySpec = {
    vpcCidr: '10.0.0.0/16',
    networkZones: [
      {
        key: 'core',
        name: 'Core',
        purpose: 'business-zone',
        cidr: '10.0.0.0/24',
        isPublicEntry: true,
      },
    ],
    hosts: [
      {
        key: 'ecs-1',
        name: 'ECS 1',
        zoneKey: 'core',
        role: 'entry',
        privateIp: '10.0.0.10',
        exposePublic: true,
      },
    ],
    publicEntry: {
      hostKey: 'ecs-1',
      protocols: [{ protocol: 'ssh', port: 22 }],
    },
  };
  const imageSelection = {
    platformImageAssetId: imageAsset.id,
    imageId: imageAsset.imageId,
    imageStrategy: { mode: 'fixed', imageId: imageAsset.imageId },
  };
  const host = {
    key: 'ecs-1',
    name: 'ECS 1',
    zoneKey: 'core',
    role: 'entry',
    primaryPrivateIp: '10.0.0.10',
    ...imageSelection,
  };
  const networkZone = topologySpec.networkZones[0];

  return {
    topologySpec,
    topologyGraph: {
      schemaVersion: '2.0.0',
      nodes: [
        {
          id: 'switch-1',
          kind: 'switch',
          label: 'Core',
          zoneKey: 'core',
          cidr: '10.0.0.0/24',
        },
        {
          id: 'ecs-1',
          kind: 'ecs',
          label: 'ECS 1',
          image: imageAsset.displayName,
          imageName: imageAsset.displayName,
          ...imageSelection,
        },
      ],
      edges: [{ id: 'edge-1', fromNodeId: 'switch-1', toNodeId: 'ecs-1' }],
    },
    scenarioTemplateSpec: {
      schemaVersion: '1.0.0',
      topology: { vpcCidr: '10.0.0.0/16', entryHostKey: 'ecs-1' },
      networkZones: [networkZone],
      hosts: [host],
    },
    compiledProvisionSpec: {
      schemaVersion: '1.0.0',
      topology: { vpcCidr: '10.0.0.0/16', entryHostKey: 'ecs-1' },
      networkZones: [networkZone],
      hosts: [host],
      natGateways: [],
      eips: [],
      snatEntries: [],
      dnatEntries: [],
    },
    compiledSpec: {
      schemaVersion: '1.0.0',
      resources: [
        {
          id: 'switch-1',
          type: 'switch',
          provider: 'alibaba_cloud',
          config: { zoneKey: 'core', cidr: '10.0.0.0/24' },
        },
        {
          id: 'ecs-1',
          type: 'host',
          provider: 'alibaba_cloud',
          config: {
            zoneKey: 'core',
            role: 'entry',
            privateIp: '10.0.0.10',
            exposePublic: true,
            ...imageSelection,
          },
        },
      ],
      topology: {
        vpcCidr: '10.0.0.0/16',
        publicEntryHostKey: 'ecs-1',
        networkZoneKeys: ['core'],
        hostKeys: ['ecs-1'],
      },
    },
  };
}

describe('RangeTemplatesService getById', () => {
  it('rejects publishing a legacy ECS topology that directly references an Alibaba Cloud image', async () => {
    const repository = createMemoryAdminRepository();
    await repository.createPlatformUser({
      id: 'user-1',
      username: 'test',
      passwordHash: 'hash',
      role: 'user',
    });
    const template = await repository.createRangeTemplate({
      name: '旧版企业攻防靶场',
      slug: 'legacy-enterprise-range',
      version: 'v1.0.0',
      createdBy: 'user-1',
      ownerUserId: 'user-1',
      modulePathOrRef: 'infra/opentofu/modules/alicloud-enterprise-range',
      topologySpec: {
        vpcCidr: '10.0.0.0/16',
        networkZones: [{ key: 'core', name: 'Core', purpose: 'business-zone', cidr: '10.0.0.0/24' }],
        hosts: [{ key: 'ecs-1', name: 'ECS 1', zoneKey: 'core', role: 'host', privateIp: '10.0.0.10' }],
        publicEntry: { hostKey: 'ecs-1', protocols: [{ protocol: 'ssh', port: 22 }] },
      },
      topologyGraph: {
        schemaVersion: '2.0.0',
        nodes: [
          {
            id: 'ecs-1',
            kind: 'ecs',
            label: 'ECS 1',
            imageId: 'ubuntu_22_04_x64_20G_alibase_20260615.vhd',
            imageStrategy: { mode: 'fixed', imageId: 'ubuntu_22_04_x64_20G_alibase_20260615.vhd' },
          },
        ],
        edges: [],
      },
    });
    const service = new RangeTemplatesService(repository);

    await expect(
      service.publishToPlatform(template.id, template.revision, { id: 'user-1', role: 'user' }),
    ).rejects.toThrow('ECS 1 请选择镜像');
  });

  it('rejects an ECS that references a public image directly instead of a permitted image asset', async () => {
    const repository = createMemoryAdminRepository();
    await repository.createPlatformUser({
      id: 'user-1',
      username: 'test',
      passwordHash: 'hash',
      role: 'user',
    });

    const service = new RangeTemplatesService(repository);

    await expect(
      service.create(
        {
          name: '企业攻防靶场',
          topologySpec: {
            vpcCidr: '10.0.0.0/16',
            networkZones: [
              {
                key: 'core',
                name: 'Core',
                purpose: 'business-zone',
                cidr: '10.0.0.0/24',
              },
            ],
            hosts: [
              {
                key: 'ecs-1',
                name: 'ECS 1',
                zoneKey: 'core',
                role: 'host',
                privateIp: '10.0.0.10',
              },
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
                image: 'ubuntu_22_04_x64_20G_alibase_20260615.vhd',
                imageId: 'ubuntu_22_04_x64_20G_alibase_20260615.vhd',
              },
            ],
            edges: [],
          },
          scenarioTemplateSpec: {},
          compiledProvisionSpec: {},
          compiledSpec: {},
        },
        { id: 'user-1', role: 'user' },
      ),
    ).rejects.toThrow('ECS 1 请选择镜像');
  });

  it('rejects compiled ECS data that diverges from the selected image asset', async () => {
    const repository = createMemoryAdminRepository();
    await repository.createPlatformUser({
      id: 'user-1',
      username: 'test',
      passwordHash: 'hash',
      role: 'user',
    });
    const imageAsset = await createPrivateImageAsset(repository, 'user-1');
    const service = new RangeTemplatesService(repository);
    const topology = createCompleteTopology(imageAsset);

    await expect(
      service.create(
        {
          name: '企业攻防靶场',
          ...topology,
          compiledSpec: {
            ...topology.compiledSpec,
            resources: topology.compiledSpec.resources.map((resource) =>
              resource.id === 'ecs-1'
                ? {
                    ...resource,
                    config: {
                      ...resource.config,
                      imageId: 'm-unapproved-image',
                      imageStrategy: { mode: 'fixed', imageId: 'm-unapproved-image' },
                    },
                  }
                : resource,
            ),
          },
        },
        { id: 'user-1', role: 'user' },
      ),
    ).rejects.toThrow('ecs-1 的编译镜像配置与所选镜像不一致');
  });

  it('returns the owner-visible topology without internal draft or version fields', async () => {
    const repository = createMemoryAdminRepository();
    await repository.createPlatformUser({
      id: 'user-1',
      username: 'test',
      passwordHash: 'hash',
      role: 'user',
    });
    const imageAsset = await createPrivateImageAsset(repository, 'user-1');

    const service = new RangeTemplatesService(repository);
    const created = await service.create(
      {
        name: '企业攻防靶场',
        ...createCompleteTopology(imageAsset),
      },
      { id: 'user-1', role: 'user' },
    );

    const fetched = await service.getById(created.id, { id: 'user-1', role: 'user' });

    expect(fetched).toEqual(
      expect.objectContaining({
        id: created.id,
        createdBy: 'test',
        revision: 1,
        status: 'private',
        topologyGraph: expect.objectContaining({
          nodes: expect.arrayContaining([expect.objectContaining({ id: 'ecs-1' })]),
        }),
      }),
    );
    expect(fetched).not.toHaveProperty('version');
    expect(fetched).not.toHaveProperty('currentDraftVersion');
    expect(fetched).not.toHaveProperty('currentPublishedVersion');
  });
});
