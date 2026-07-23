import { ConflictException, ForbiddenException } from '@nestjs/common';

import type {
  AdminRepository,
  CreateRangeTemplateInput,
  RangeTemplateRecord,
  RangeTemplateTopologySpec,
  SaveRangeTemplateTopologyInput,
} from '../src/admin/admin.repository';
import { RangeTemplatesService } from '../src/admin/range-templates.service';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';

const owner = {
  id: 'owner-1',
  role: 'user' as const,
};

const topologySpec: RangeTemplateTopologySpec = {
  vpcCidr: '10.90.0.0/16',
  networkZones: [
    {
      key: 'zone-1',
      name: 'Zone 1',
      purpose: 'business',
      cidr: '10.90.1.0/24',
      isPublicEntry: true,
    },
  ],
  hosts: [
    {
      key: 'ecs-1',
      name: 'ECS 1',
      zoneKey: 'zone-1',
      role: 'entry',
      privateIp: '10.90.1.10',
      exposePublic: true,
    },
  ],
  publicEntry: {
    hostKey: 'ecs-1',
    protocols: [{ protocol: 'ssh', port: 22 }],
  },
};

const topologyPayload: Omit<SaveRangeTemplateTopologyInput, 'expectedRevision'> = {
  topologySpec,
  topologyGraph: {
    schemaVersion: '2.0.0',
    nodes: [
      {
        id: 'switch-1',
        kind: 'switch',
        label: 'Switch 1',
        zoneKey: 'zone-1',
        cidr: '10.90.1.0/24',
      },
      {
        id: 'ecs-1',
        kind: 'ecs',
        label: 'ECS 1',
        platformImageAssetId: 'asset-1',
        imageId: 'image-1',
        imageStrategy: { mode: 'fixed', imageId: 'image-1' },
      },
    ],
    edges: [{ id: 'edge-1', fromNodeId: 'switch-1', toNodeId: 'ecs-1' }],
  },
  scenarioTemplateSpec: {
    schemaVersion: '1.0.0',
    topology: {
      vpcCidr: '10.90.0.0/16',
      entryHostKey: 'ecs-1',
    },
    networkZones: [
      {
        key: 'zone-1',
        name: 'Zone 1',
        purpose: 'business',
        cidr: '10.90.1.0/24',
        isPublicEntry: true,
      },
    ],
    hosts: [
      {
        key: 'ecs-1',
        name: 'ECS 1',
        zoneKey: 'zone-1',
        role: 'entry',
        primaryPrivateIp: '10.90.1.10',
        platformImageAssetId: 'asset-1',
        imageId: 'image-1',
        imageStrategy: { mode: 'fixed', imageId: 'image-1' },
      },
    ],
  },
  compiledProvisionSpec: {
    schemaVersion: '1.0.0',
    topology: {
      vpcCidr: '10.90.0.0/16',
      entryHostKey: 'ecs-1',
    },
    networkZones: [
      {
        key: 'zone-1',
        name: 'Zone 1',
        purpose: 'business',
        cidr: '10.90.1.0/24',
        isPublicEntry: true,
      },
    ],
    hosts: [
      {
        key: 'ecs-1',
        name: 'ECS 1',
        zoneKey: 'zone-1',
        role: 'entry',
        primaryPrivateIp: '10.90.1.10',
        platformImageAssetId: 'asset-1',
        imageId: 'image-1',
        imageStrategy: { mode: 'fixed', imageId: 'image-1' },
      },
    ],
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
        config: {
          zoneKey: 'zone-1',
          cidr: '10.90.1.0/24',
        },
      },
      {
        id: 'ecs-1',
        type: 'host',
        provider: 'alibaba_cloud',
        config: {
          zoneKey: 'zone-1',
          role: 'entry',
          privateIp: '10.90.1.10',
          exposePublic: true,
          platformImageAssetId: 'asset-1',
          imageId: 'image-1',
          imageStrategy: { mode: 'fixed', imageId: 'image-1' },
        },
      },
    ],
    topology: {
      vpcCidr: '10.90.0.0/16',
      publicEntryHostKey: 'ecs-1',
      networkZoneKeys: ['zone-1'],
      hostKeys: ['ecs-1'],
    },
  },
};

function createTemplate(overrides: Record<string, unknown> = {}) {
  const draft = {
    id: 'draft-1',
    templateId: 'template-1',
    version: 'v1',
    status: 'draft',
    modulePathOrRef: 'infra/opentofu/modules/alicloud-enterprise-range',
    topologySpec,
    topologyGraph: topologyPayload.topologyGraph,
    scenarioTemplateSpec: topologyPayload.scenarioTemplateSpec,
    compiledProvisionSpec: topologyPayload.compiledProvisionSpec,
    compiledSpec: topologyPayload.compiledSpec,
    variableSchema: {},
    outputSchema: {},
    defaultNetworkPolicy: null,
    createdAt: new Date('2026-07-22T00:00:00.000Z'),
    updatedAt: new Date('2026-07-22T00:00:00.000Z'),
  };

  return {
    id: 'template-1',
    name: 'Template 1',
    createdBy: owner.id,
    ownerUserId: owner.id,
    description: null,
    slug: 'template-1',
    version: 'v1',
    cloudProvider: 'alibaba_cloud',
    iacType: 'opentofu',
    modulePathOrRef: 'infra/opentofu/modules/alicloud-enterprise-range',
    topologySpec,
    topologyGraph: topologyPayload.topologyGraph,
    scenarioTemplateSpec: topologyPayload.scenarioTemplateSpec,
    compiledProvisionSpec: topologyPayload.compiledProvisionSpec,
    compiledSpec: topologyPayload.compiledSpec,
    variableSchema: {},
    outputSchema: {},
    defaultNetworkPolicy: null,
    visibility: 'private',
    revision: 3,
    currentDraftVersionId: draft.id,
    currentPublishedVersionId: null,
    currentDraftVersion: draft,
    currentPublishedVersion: null,
    versions: [draft],
    createdAt: new Date('2026-07-22T00:00:00.000Z'),
    updatedAt: new Date('2026-07-22T00:00:00.000Z'),
    ...overrides,
  } as unknown as RangeTemplateRecord & { revision: number };
}

function createRepository(template: ReturnType<typeof createTemplate>) {
  return {
    listRangeTemplates: jest.fn().mockResolvedValue([template]),
    getRangeTemplateById: jest.fn().mockResolvedValue(template),
    createRangeTemplate: jest.fn().mockResolvedValue(template),
    getPlatformImageAssetById: jest.fn().mockResolvedValue({
      id: 'asset-1',
      imageId: 'image-1',
      enabled: true,
      visibility: 'private',
      ownerUserId: owner.id,
    }),
    saveRangeTemplateTopology: jest.fn().mockResolvedValue(
      createTemplate({
        revision: 4,
      }),
    ),
    publishRangeTemplateToPlatform: jest.fn().mockResolvedValue(
      createTemplate({
        revision: 4,
        visibility: 'platform',
        currentPublishedVersionId: 'published-1',
      }),
    ),
    updateRangeTemplateMetadata: jest.fn().mockResolvedValue(template),
    unshareRangeTemplate: jest.fn().mockResolvedValue(
      createTemplate({
        revision: 4,
        visibility: 'private',
        currentPublishedVersionId: 'published-1',
      }),
    ),
    getPlatformUserById: jest.fn().mockResolvedValue(null),
  } as unknown as AdminRepository & {
    createRangeTemplate: jest.Mock;
    saveRangeTemplateTopology: jest.Mock;
    publishRangeTemplateToPlatform: jest.Mock;
    updateRangeTemplateMetadata: jest.Mock;
    unshareRangeTemplate: jest.Mock;
  };
}

describe('RangeTemplatesService state machine', () => {
  it('creates complete same-name templates with server-owned unique slugs and internal defaults', async () => {
    const template = createTemplate();
    const repository = createRepository(template);
    const service = new RangeTemplatesService(repository);
    const input = {
      name: '同名拓扑',
      description: '完整拓扑',
      ...topologyPayload,
    };

    const first = await (
      service as unknown as {
        create(
          input: Record<string, unknown>,
          currentUser: typeof owner,
        ): Promise<Record<string, unknown>>;
      }
    ).create(input, owner);
    await (
      service as unknown as {
        create(
          input: Record<string, unknown>,
          currentUser: typeof owner,
        ): Promise<Record<string, unknown>>;
      }
    ).create(input, owner);

    const [firstCreate, secondCreate] = repository.createRangeTemplate.mock.calls.map(
      ([value]) => value as Record<string, unknown>,
    );
    expect(firstCreate.slug).toEqual(expect.any(String));
    expect(secondCreate.slug).toEqual(expect.any(String));
    expect(firstCreate.slug).not.toBe(secondCreate.slug);
    expect(firstCreate).toEqual(
      expect.objectContaining({
        version: 'v1',
        modulePathOrRef: 'infra/opentofu/modules/alicloud-enterprise-range',
        visibility: 'private',
      }),
    );
    expect(first).not.toHaveProperty('version');
    expect(first).not.toHaveProperty('currentDraftVersion');
  });

  it('returns public list items without internal version fields', async () => {
    const template = createTemplate();
    const repository = createRepository(template);
    const service = new RangeTemplatesService(repository);

    const [result] = await service.list(owner, 'mine');

    expect(result).toEqual(
      expect.objectContaining({
        id: template.id,
        revision: 3,
        status: 'private',
        canManage: true,
      }),
    );
    expect(result).not.toHaveProperty('version');
    expect(result).not.toHaveProperty('currentDraftVersionId');
    expect(result).not.toHaveProperty('currentPublishedVersionId');
  });

  it('returns owner detail topology without internal version fields', async () => {
    const template = createTemplate();
    const repository = createRepository(template);
    const service = new RangeTemplatesService(repository);

    const result = await service.getById(template.id, owner);

    expect(result).toEqual(
      expect.objectContaining({
        id: template.id,
        revision: 3,
        status: 'private',
        canManage: true,
        topologyGraph: topologyPayload.topologyGraph,
      }),
    );
    expect(result).not.toHaveProperty('version');
    expect(result).not.toHaveProperty('currentDraftVersion');
    expect(result).not.toHaveProperty('currentPublishedVersion');
  });

  it('returns a cloned topology without internal version fields', async () => {
    const template = createTemplate();
    const clonedTemplate = createTemplate({
      id: 'template-clone',
      slug: 'template-1-copy-12345678',
      revision: 1,
    });
    const repository = createRepository(template);
    repository.createRangeTemplate.mockResolvedValueOnce(clonedTemplate);
    const service = new RangeTemplatesService(repository);

    const result = await service.clone(template.id, owner);

    expect(result).toEqual(
      expect.objectContaining({
        id: clonedTemplate.id,
        status: 'private',
        revision: 1,
      }),
    );
    expect(result).not.toHaveProperty('version');
    expect(result).not.toHaveProperty('currentDraftVersionId');
    expect(result).not.toHaveProperty('currentPublishedVersionId');
    expect(repository.createRangeTemplate).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: expect.stringMatching(/^template-1-copy-[0-9a-f]{8}$/),
        visibility: 'private',
      }),
    );
  });

  it('validates and saves the exact topology payload through one repository action', async () => {
    const template = createTemplate();
    const repository = createRepository(template);
    const service = new RangeTemplatesService(repository);

    const result = await (
      service as unknown as {
        validateAndSave(
          id: string,
          input: SaveRangeTemplateTopologyInput,
          currentUser: typeof owner,
        ): Promise<Record<string, unknown>>;
      }
    ).validateAndSave(
      template.id,
      {
        ...topologyPayload,
        expectedRevision: 3,
      },
      owner,
    );

    expect(repository.saveRangeTemplateTopology).toHaveBeenCalledTimes(1);
    expect(repository.saveRangeTemplateTopology).toHaveBeenCalledWith(
      template.id,
      expect.objectContaining({
        topologySpec: topologyPayload.topologySpec,
        topologyGraph: topologyPayload.topologyGraph,
        scenarioTemplateSpec: expect.objectContaining(topologyPayload.scenarioTemplateSpec),
        compiledProvisionSpec: expect.objectContaining(topologyPayload.compiledProvisionSpec),
        compiledSpec: topologyPayload.compiledSpec,
        expectedRevision: 3,
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        id: template.id,
        revision: 4,
        status: 'private',
      }),
    );
    expect(result).not.toHaveProperty('version');
    expect(result).not.toHaveProperty('currentDraftVersionId');
    expect(result).not.toHaveProperty('currentPublishedVersionId');
  });

  it('normalizes server-owned topology identity before saving', async () => {
    const template = createTemplate();
    const repository = createRepository(template);
    const service = new RangeTemplatesService(repository);

    await service.validateAndSave(
      template.id,
      {
        ...topologyPayload,
        scenarioTemplateSpec: {
          ...topologyPayload.scenarioTemplateSpec,
          metadata: {
            name: 'Client supplied name',
            slug: 'client-supplied-slug',
            version: 'v999',
          },
        },
        compiledProvisionSpec: {
          ...topologyPayload.compiledProvisionSpec,
          identity: {
            templateSlug: 'client-supplied-slug',
            templateVersion: 'v999',
          },
        },
        expectedRevision: template.revision,
      },
      owner,
    );

    expect(repository.saveRangeTemplateTopology).toHaveBeenCalledWith(
      template.id,
      expect.objectContaining({
        scenarioTemplateSpec: expect.objectContaining({
          metadata: expect.objectContaining({
            name: template.name,
            slug: template.slug,
            version: 'v1',
            cloudProvider: 'alibaba_cloud',
            iacType: 'opentofu',
          }),
        }),
        compiledProvisionSpec: expect.objectContaining({
          identity: expect.objectContaining({
            templateSlug: template.slug,
            templateVersion: 'v1',
            cloudProvider: 'alibaba_cloud',
            iacType: 'opentofu',
          }),
        }),
      }),
    );
  });

  it('returns 409 when the repository rejects a stale save revision', async () => {
    const template = createTemplate();
    const repository = createRepository(template);
    repository.saveRangeTemplateTopology.mockRejectedValueOnce(new Error('TEMPLATE_REVISION_CONFLICT'));
    const service = new RangeTemplatesService(repository);

    await expect(
      (
        service as unknown as {
          validateAndSave(
            id: string,
            input: SaveRangeTemplateTopologyInput,
            currentUser: typeof owner,
          ): Promise<Record<string, unknown>>;
        }
      ).validateAndSave(
        template.id,
        {
          ...topologyPayload,
          expectedRevision: 2,
        },
        owner,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects publishing when a referenced image is private to the owner', async () => {
    const template = createTemplate();
    const repository = createRepository(template);
    const service = new RangeTemplatesService(repository);

    await expect(
      (
        service as unknown as {
          publishToPlatform(
            id: string,
            expectedRevision: number,
            currentUser: typeof owner,
          ): Promise<Record<string, unknown>>;
        }
      ).publishToPlatform(template.id, 3, owner),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(repository.publishRangeTemplateToPlatform).not.toHaveBeenCalled();
  });

  it('returns management capability after publishing an owned template', async () => {
    const template = createTemplate();
    const repository = createRepository(template);
    (repository as unknown as { getPlatformImageAssetById: jest.Mock }).getPlatformImageAssetById.mockResolvedValue({
      id: 'asset-1',
      imageId: 'image-1',
      enabled: true,
      visibility: 'platform',
      ownerUserId: owner.id,
    });
    const service = new RangeTemplatesService(repository);

    const result = await (
      service as unknown as {
        publishToPlatform(
          id: string,
          expectedRevision: number,
          currentUser: typeof owner,
        ): Promise<Record<string, unknown>>;
      }
    ).publishToPlatform(template.id, 3, owner);

    expect(result).toEqual(
      expect.objectContaining({
        status: 'published',
        canManage: true,
      }),
    );
  });

  it('updates metadata through a revision-checked action without changing publication state', async () => {
    const template = createTemplate({
      visibility: 'platform',
      currentPublishedVersionId: 'published-1',
    });
    const repository = createRepository(template);
    repository.updateRangeTemplateMetadata.mockResolvedValueOnce(template);
    const service = new RangeTemplatesService(repository);

    const result = await (
      service as unknown as {
        updateMetadata(
          id: string,
          input: { name: string; description: string; expectedRevision: number },
          currentUser: typeof owner,
        ): Promise<Record<string, unknown>>;
      }
    ).updateMetadata(
      template.id,
      {
        name: 'Renamed template',
        description: 'Updated description',
        expectedRevision: 3,
      },
      owner,
    );

    expect(repository.updateRangeTemplateMetadata).toHaveBeenCalledWith(template.id, {
      name: 'Renamed template',
      description: 'Updated description',
      expectedRevision: 3,
    });
    expect(result.status).toBe('published');
  });

  it('returns a published template to private through a revision-checked action', async () => {
    const template = createTemplate({
      visibility: 'platform',
      currentPublishedVersionId: 'published-1',
    });
    const repository = createRepository(template);
    const service = new RangeTemplatesService(repository);

    const result = await (
      service as unknown as {
        returnToPrivate(
          id: string,
          expectedRevision: number,
          currentUser: typeof owner,
        ): Promise<Record<string, unknown>>;
      }
    ).returnToPrivate(template.id, 3, owner);

    expect(repository.unshareRangeTemplate).toHaveBeenCalledWith(template.id, 3);
    expect(result).toEqual(
      expect.objectContaining({
        revision: 4,
        status: 'private',
      }),
    );
  });
});

describe('range template repository optimistic concurrency', () => {
  const createInput: CreateRangeTemplateInput = {
    name: 'Template 1',
    createdBy: owner.id,
    ownerUserId: owner.id,
    slug: 'template-1',
    version: 'v1',
    cloudProvider: 'alibaba_cloud',
    iacType: 'opentofu',
    modulePathOrRef: 'infra/opentofu/modules/alicloud-enterprise-range',
    ...topologyPayload,
    variableSchema: {},
    outputSchema: {},
    visibility: 'private',
  };

  it('rejects a stale repeated publish even when the template is already published', async () => {
    const repository = createMemoryAdminRepository();
    const created = await repository.createRangeTemplate(createInput);
    const published = await repository.publishRangeTemplateToPlatform(created.id, created.revision);

    await expect(
      repository.publishRangeTemplateToPlatform(created.id, created.revision),
    ).rejects.toBeInstanceOf(Error);
    expect((await repository.getRangeTemplateById(created.id))?.revision).toBe(published.revision);
  });

  it('rejects a stale repeated return-to-private even when the template is already private', async () => {
    const repository = createMemoryAdminRepository();
    const created = await repository.createRangeTemplate(createInput);
    const published = await repository.publishRangeTemplateToPlatform(created.id, created.revision);
    const privateTemplate = await repository.unshareRangeTemplate(created.id, published.revision);

    await expect(
      repository.unshareRangeTemplate(created.id, published.revision),
    ).rejects.toBeInstanceOf(Error);
    expect((await repository.getRangeTemplateById(created.id))?.revision).toBe(privateTemplate.revision);
  });
});
