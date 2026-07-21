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

    await expect(service.publish(template.id, { id: 'user-1', role: 'user' })).rejects.toThrow('ECS 1 请选择镜像');
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
          slug: 'enterprise-range',
          version: 'v1.0.0',
          modulePathOrRef: 'infra/opentofu/modules/alicloud-enterprise-range',
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

    await expect(
      service.create(
        {
          name: '企业攻防靶场',
          slug: 'enterprise-range-compiled-image',
          version: 'v1.0.0',
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
                platformImageAssetId: imageAsset.id,
                image: imageAsset.displayName,
                imageName: imageAsset.displayName,
                imageId: imageAsset.imageId,
                imageStrategy: { mode: 'fixed', imageId: imageAsset.imageId },
              },
            ],
            edges: [],
          },
          compiledSpec: {
            schemaVersion: '1.0.0',
            resources: [
              {
                id: 'ecs-1',
                type: 'host',
                config: {
                  platformImageAssetId: imageAsset.id,
                  imageId: 'm-unapproved-image',
                  imageStrategy: { mode: 'fixed', imageId: 'm-unapproved-image' },
                },
              },
            ],
          },
        },
        { id: 'user-1', role: 'user' },
      ),
    ).rejects.toThrow('ecs-1 的编译镜像配置与所选镜像不一致');
  });

  it('returns the owner-visible draft topology instead of summary-only list fields', async () => {
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
        slug: 'enterprise-range',
        version: 'v1.0.0',
        modulePathOrRef: 'infra/opentofu/modules/alicloud-enterprise-range',
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
              platformImageAssetId: imageAsset.id,
              image: imageAsset.displayName,
              imageName: imageAsset.displayName,
              imageId: imageAsset.imageId,
              imageStrategy: { mode: 'fixed', imageId: imageAsset.imageId },
            },
          ],
          edges: [],
        },
      },
      { id: 'user-1', role: 'user' },
    );

    const fetched = await service.getById(created.id, { id: 'user-1', role: 'user' });

    expect(fetched).toEqual(
      expect.objectContaining({
        id: created.id,
        createdBy: 'test',
        currentDraftVersion: expect.objectContaining({
          topologyGraph: expect.objectContaining({
            nodes: [expect.objectContaining({ id: 'ecs-1' })],
          }),
        }),
      }),
    );
  });
});
