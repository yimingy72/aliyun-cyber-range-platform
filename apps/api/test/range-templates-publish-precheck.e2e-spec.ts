import { completeTemplatePayload } from './support/complete-template-payload';
import { BadRequestException } from '@nestjs/common';
import { compileTemplateTopology, type ScenarioGraphDraft } from '@aliyun-cyber-range/scenario-runtime/compiled';

import type { AdminRepository, RangeTemplateCompiledSpec, RangeTemplateRecord, RangeTemplateVersionRecord } from '../src/admin/admin.repository';
import { RangeTemplatesService } from '../src/admin/range-templates.service';
import { runInCloudWorkspace } from '../src/auth/cloud-workspace-scope';

function createDraftVersion(
  overrides: Partial<RangeTemplateVersionRecord> = {},
): RangeTemplateVersionRecord {
  return {
    id: 'draft-1',
    templateId: 'template-1',
    version: 'v1',
    status: 'draft',
    modulePathOrRef: 'infra/opentofu/modules/alicloud-enterprise-range',
    topologySpec: {
      vpcCidr: '10.70.0.0/16',
      networkZones: [
        {
          key: 'dmz',
          name: 'DMZ',
          purpose: 'public-entry',
          cidr: '10.70.10.0/24',
          isPublicEntry: true,
        },
        {
          key: 'office',
          name: 'Office',
          purpose: 'user-workstations',
          cidr: '10.70.20.0/24',
        },
      ],
      hosts: [
        {
          key: 'dmz-entry',
          name: 'DMZ Entry',
          zoneKey: 'dmz',
          role: 'entry',
          privateIp: '10.70.10.10',
          exposePublic: true,
        },
        {
          key: 'office-client',
          name: 'Office Client',
          zoneKey: 'office',
          role: 'workstation',
          privateIp: '10.70.20.10',
        },
      ],
      publicEntry: {
        hostKey: 'dmz-entry',
        protocols: [{ protocol: 'ssh', port: 22 }],
      },
    },
    topologyGraph: null,
    scenarioTemplateSpec: null,
    compiledProvisionSpec: null,
    compiledSpec: {
      schemaVersion: '1.0.0',
      resources: [
        {
          id: 'switch-dmz',
          type: 'switch',
          provider: 'alibaba_cloud',
          config: {
            label: 'DMZ',
            zoneKey: 'dmz',
            cidr: '10.70.10.0/24',
            purpose: 'public-entry',
          },
        },
        {
          id: 'switch-office',
          type: 'switch',
          provider: 'alibaba_cloud',
          config: {
            label: 'Office',
            zoneKey: 'office',
            cidr: '10.70.20.0/24',
            purpose: 'user-workstations',
          },
        },
        {
          id: 'dmz-entry',
          type: 'host',
          provider: 'alibaba_cloud',
          config: {
            label: 'DMZ Entry',
            zoneKey: 'dmz',
            role: 'entry',
            privateIp: '10.70.10.10',
            exposePublic: true,
          },
        },
        {
          id: 'office-client',
          type: 'host',
          provider: 'alibaba_cloud',
          config: {
            label: 'Office Client',
            zoneKey: 'office',
            role: 'workstation',
            privateIp: '10.70.20.10',
            exposePublic: false,
          },
        },
      ],
      topology: {
        vpcCidr: '10.70.0.0/16',
        publicEntryHostKey: 'dmz-entry',
        networkZoneKeys: ['dmz', 'office'],
        hostKeys: ['dmz-entry', 'office-client'],
      },
    },
    variableSchema: {},
    outputSchema: {},
    defaultNetworkPolicy: null,
    createdAt: new Date('2026-06-25T00:00:00Z'),
    updatedAt: new Date('2026-06-25T00:00:00Z'),
    ...overrides,
  };
}

function createTemplateRecord(overrides: Partial<RangeTemplateRecord> = {}): RangeTemplateRecord {
  return {
    id: 'template-1',
    name: 'Enterprise Template',
    createdBy: 'admin',
    ownerUserId: null,
    description: null,
    slug: 'enterprise-template',
    version: 'v1',
    cloudProvider: 'alibaba_cloud',
    iacType: 'opentofu',
    modulePathOrRef: 'infra/opentofu/modules/alicloud-enterprise-range',
    topologySpec: null,
    topologyGraph: null,
    scenarioTemplateSpec: null,
    compiledProvisionSpec: null,
    compiledSpec: null,
    variableSchema: {},
    outputSchema: {},
    defaultNetworkPolicy: null,
    visibility: 'private',
    revision: 1,
    currentDraftVersionId: 'draft-1',
    currentPublishedVersionId: null,
    currentDraftVersion: createDraftVersion(),
    currentPublishedVersion: null,
    versions: [],
    createdAt: new Date('2026-06-25T00:00:00Z'),
    updatedAt: new Date('2026-06-25T00:00:00Z'),
    ...overrides,
  };
}

function createCompleteSavePayload(
  template: RangeTemplateRecord,
  topologyGraph: Record<string, unknown>,
) {
  return { ...completeTemplatePayload(template.currentDraftVersion!.topologySpec!), expectedRevision: template.revision };
}

describe('RangeTemplatesService publish precheck', () => {
  const ownerUser = {
    id: 'owner-user',
    username: 'owner-user',
    role: 'user' as const,
  };
  let assertTemplateEcsImageSelectionsSpy: jest.SpiedFunction<RangeTemplatesService['assertTemplateEcsImageSelections']>;

  function createRepository(template: RangeTemplateRecord) {
    return {
      getPlatformUserById: jest.fn().mockResolvedValue(null),
      getRangeTemplateById: jest.fn().mockResolvedValue(template),
      saveRangeTemplateTopology: jest.fn().mockResolvedValue(template),
      updateRangeTemplateMetadata: jest.fn().mockResolvedValue(template),
      publishRangeTemplateToPlatform: jest.fn().mockResolvedValue(template),
      unshareRangeTemplate: jest.fn().mockResolvedValue(template),
    } as unknown as AdminRepository;
  }

  beforeEach(() => {
    assertTemplateEcsImageSelectionsSpy = jest
      .spyOn(RangeTemplatesService.prototype, 'assertTemplateEcsImageSelections')
      .mockResolvedValue(undefined);
  });

  afterEach(() => {
    assertTemplateEcsImageSelectionsSpy.mockRestore();
  });

  it.each([
    ['alibaba_cloud', 'private'], ['tencent_cloud', 'private'],
    ['alibaba_cloud', 'snat'], ['tencent_cloud', 'snat'],
    ['alibaba_cloud', 'multiple-dnat'], ['tencent_cloud', 'multiple-dnat'],
  ] as const)('creates, saves and publishes a compiled %s %s topology', async (provider, mode) => {
    const source = createDraftVersion().topologySpec!;
    const graph = completeTemplatePayload(source).topologyGraph as unknown as ScenarioGraphDraft;
    for (const node of graph.nodes) {
      if (node.kind !== 'switch') continue;
      const host = source.hosts.find(candidate => candidate.zoneKey === node.zoneKey)!;
      node.nat = {
        snatEnabled: mode !== 'private',
        dnatMappings: mode === 'multiple-dnat' ? [{ key: `${host.key}-ssh`, targetHostId: host.key,
          protocol: 'tcp', externalPort: node.zoneKey === 'dmz' ? 2222 : 2223, internalPort: 22 }] : [],
      };
    }
    const modulePathOrRef = `infra/opentofu/modules/${provider === 'tencent_cloud' ? 'tencentcloud' : 'alicloud'}-enterprise-range`;
    const payload = JSON.parse(JSON.stringify(compileTemplateTopology(graph, {
      name: 'Enterprise Template', slug: 'enterprise-template', version: 'v1', cloudProvider: provider,
      iacType: 'opentofu', primaryVpcCidr: source.vpcCidr, secondaryVpcCidrs: [],
      modulePathOrRef,
    }))) as ReturnType<typeof completeTemplatePayload>;
    const template = createTemplateRecord({ cloudProvider: provider, modulePathOrRef, ...payload,
      currentDraftVersion: createDraftVersion({ modulePathOrRef, ...payload }) });
    const repository = { ...createRepository(template), createRangeTemplate: jest.fn().mockResolvedValue(template) };
    const service = new RangeTemplatesService(repository);

    await runInCloudWorkspace({ cloudWorkspaceId: `${provider}-workspace`, provider, accountUid: null }, async () => {
      await expect(service.create({ name: template.name, ...payload })).resolves.toMatchObject({ id: template.id });
      await expect(service.validateAndSave(template.id, { expectedRevision: template.revision, ...payload }))
        .resolves.toMatchObject({ id: template.id });
      await expect(service.publishToPlatform(template.id, template.revision)).resolves.toMatchObject({ id: template.id });
    });

    const saved = (repository.saveRangeTemplateTopology as jest.Mock).mock.calls[0][1];
    expect(saved.topologySpec.hosts.map((host: { exposePublic: boolean }) => host.exposePublic))
      .toEqual(mode === 'multiple-dnat' ? [true, true] : [false, false]);
    expect(saved.compiledProvisionSpec.dnatEntries).toHaveLength(mode === 'multiple-dnat' ? 2 : 0);
    if (mode === 'private') {
      expect(saved.compiledProvisionSpec.natGateways).toEqual([]);
      expect(saved.compiledProvisionSpec.eips).toEqual([]);
    }
    expect(repository.publishRangeTemplateToPlatform).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['dmz-entry', true, false], ['dmz-entry', false, true],
    ['office-client', true, false], ['office-client', false, true],
    ['dmz-entry', undefined, false], ['office-client', undefined, true],
  ] as const)('rejects %s public exposure changing from %s to %s in compiled resources', async (hostKey, declared, compiled) => {
    const draft = createDraftVersion();
    draft.topologySpec!.hosts.find(host => host.key === hostKey)!.exposePublic = declared;
    (draft.compiledSpec as RangeTemplateCompiledSpec).resources.find(resource => resource.id === hostKey)!.config.exposePublic = compiled;
    const template = createTemplateRecord({ currentDraftVersion: draft });
    const repository = createRepository(template);
    const result = new RangeTemplatesService(repository).publishToPlatform(template.id, template.revision);

    await expect(result).rejects.toThrow(BadRequestException);
    await result.catch((error: BadRequestException) => {
      expect(error.getResponse()).toMatchObject({ message: expect.arrayContaining([
        `Compiled host resource public access mismatch for host ${hostKey}`,
      ]) });
    });
    expect(repository.publishRangeTemplateToPlatform).not.toHaveBeenCalled();
  });

  it('rejects publish when compiled resources are missing declared topology nodes', async () => {
    const template = createTemplateRecord({
      currentDraftVersion: createDraftVersion({
        compiledSpec: {
          schemaVersion: '1.0.0',
          resources: [
            {
              id: 'switch-dmz',
              type: 'switch',
              provider: 'alibaba_cloud',
              config: {
                label: 'DMZ',
                zoneKey: 'dmz',
                cidr: '10.70.10.0/24',
                purpose: 'public-entry',
              },
            },
            {
              id: 'dmz-entry',
              type: 'host',
              provider: 'alibaba_cloud',
              config: {
                label: 'DMZ Entry',
                zoneKey: 'dmz',
                role: 'entry',
                privateIp: '10.70.10.10',
                exposePublic: true,
              },
            },
          ],
          topology: {
            vpcCidr: '10.70.0.0/16',
            publicEntryHostKey: 'dmz-entry',
            networkZoneKeys: ['dmz', 'office'],
            hostKeys: ['dmz-entry', 'office-client'],
          },
        },
      }),
    });

    const service = new RangeTemplatesService(createRepository(template));
    const result = service.publishToPlatform(template.id, template.revision);

    await expect(result).rejects.toThrow(BadRequestException);

    await result.catch((error: BadRequestException) => {
      expect(error.getResponse()).toEqual(
        expect.objectContaining({
          message: expect.arrayContaining([
            'Missing switch resource for network zone: office',
            'Missing host resource for topology host: office-client',
          ]),
        }),
      );
    });
  });

  it('rejects an invalid topology payload before the atomic save action', async () => {
    const template = createTemplateRecord({
      ownerUserId: ownerUser.id,
    });
    const repository = createRepository(template) as unknown as {
      saveRangeTemplateTopology: jest.Mock;
    };
    const service = new RangeTemplatesService(repository as unknown as AdminRepository);

    const invalidTopologySpec = {
      ...template.currentDraftVersion!.topologySpec!,
      networkZones: [
        template.currentDraftVersion!.topologySpec!.networkZones[0]!,
        {
          ...template.currentDraftVersion!.topologySpec!.networkZones[1]!,
          key: template.currentDraftVersion!.topologySpec!.networkZones[0]!.key,
        },
      ],
    };

    await expect(
      service.validateAndSave(
        template.id,
        {
          topologySpec: invalidTopologySpec,
          topologyGraph: {
            schemaVersion: '2.0.0',
            nodes: [],
            edges: [],
          },
          scenarioTemplateSpec: {},
          compiledProvisionSpec: {},
          compiledSpec: template.currentDraftVersion!.compiledSpec!,
          expectedRevision: template.revision,
        },
        ownerUser,
      ),
    ).rejects.toThrow('Duplicate network zone key');

    expect(repository.saveRangeTemplateTopology).not.toHaveBeenCalled();
  });

  it('rejects a switch CIDR outside the fixed VPC network ranges before the atomic save action', async () => {
    const template = createTemplateRecord({
      ownerUserId: ownerUser.id,
    });
    const repository = createRepository(template) as unknown as {
      saveRangeTemplateTopology: jest.Mock;
    };
    const service = new RangeTemplatesService(repository as unknown as AdminRepository);
    const invalidTopologySpec = {
      ...template.currentDraftVersion!.topologySpec!,
      networkZones: [
        {
          ...template.currentDraftVersion!.topologySpec!.networkZones[0]!,
          cidr: '10.10.20.0/24',
        },
        template.currentDraftVersion!.topologySpec!.networkZones[1]!,
      ],
    };

    await expect(
      service.validateAndSave(
        template.id,
        {
          topologySpec: invalidTopologySpec,
          topologyGraph: {
            schemaVersion: '2.0.0',
            nodes: [],
            edges: [],
          },
          scenarioTemplateSpec: {},
          compiledProvisionSpec: {},
          compiledSpec: template.currentDraftVersion!.compiledSpec!,
          expectedRevision: template.revision,
        },
        ownerUser,
      ),
    ).rejects.toThrow('10.10.20.0/24 不属于固定 VPC 网段');

    expect(repository.saveRangeTemplateTopology).not.toHaveBeenCalled();
  });

  it('rejects a host private IP outside its switch CIDR before the atomic save action', async () => {
    const template = createTemplateRecord({
      ownerUserId: ownerUser.id,
    });
    const repository = createRepository(template) as unknown as {
      saveRangeTemplateTopology: jest.Mock;
    };
    const service = new RangeTemplatesService(repository as unknown as AdminRepository);
    const invalidTopologySpec = {
      ...template.currentDraftVersion!.topologySpec!,
      hosts: [
        {
          ...template.currentDraftVersion!.topologySpec!.hosts[0]!,
          privateIp: '10.70.20.10',
        },
        template.currentDraftVersion!.topologySpec!.hosts[1]!,
      ],
    };

    await expect(
      service.validateAndSave(
        template.id,
        {
          topologySpec: invalidTopologySpec,
          topologyGraph: {
            schemaVersion: '2.0.0',
            nodes: [],
            edges: [],
          },
          scenarioTemplateSpec: {},
          compiledProvisionSpec: {},
          compiledSpec: template.currentDraftVersion!.compiledSpec!,
          expectedRevision: template.revision,
        },
        ownerUser,
      ),
    ).rejects.toThrow('Host dmz-entry private IP 10.70.20.10 不属于交换机网段 10.70.10.0/24');

    expect(repository.saveRangeTemplateTopology).not.toHaveBeenCalled();
  });

  it('publishes a private saved topology to the platform in one repository action', async () => {
    const template = createTemplateRecord({
      ownerUserId: ownerUser.id,
      visibility: 'private',
      currentPublishedVersionId: null,
      currentPublishedVersion: null,
    });
    const publishedTemplate = {
      ...template,
      visibility: 'platform' as const,
      revision: template.revision + 1,
      currentPublishedVersionId: template.currentDraftVersionId,
      currentPublishedVersion: template.currentDraftVersion,
    };
    const repository = {
      ...createRepository(template),
      publishRangeTemplateToPlatform: jest.fn().mockResolvedValue(publishedTemplate),
    } as unknown as {
      publishRangeTemplateToPlatform: jest.Mock;
    };
    const service = new RangeTemplatesService(repository as unknown as AdminRepository);

    await expect(
      service.publishToPlatform(template.id, template.revision, ownerUser),
    ).resolves.toEqual(expect.objectContaining({
      id: template.id,
      status: 'published',
      revision: template.revision + 1,
    }));
    expect(repository.publishRangeTemplateToPlatform).toHaveBeenCalledWith(template.id, template.revision);
  });

  it('reverts a published topology to private when saving new topology changes', async () => {
    const template = createTemplateRecord({
      ownerUserId: ownerUser.id,
      visibility: 'platform',
      currentPublishedVersionId: 'published-1',
      currentPublishedVersion: createDraftVersion({
        id: 'published-1',
        status: 'published',
      }),
    });
    const revertedTemplate = {
      ...template,
      visibility: 'private' as const,
      revision: template.revision + 1,
      currentPublishedVersionId: null,
      currentPublishedVersion: null,
    };
    const repository = {
      ...createRepository(template),
      saveRangeTemplateTopology: jest.fn().mockResolvedValue(revertedTemplate),
    } as unknown as AdminRepository & {
      saveRangeTemplateTopology: jest.Mock;
    };
    const service = new RangeTemplatesService(repository);
    const savePayload = createCompleteSavePayload(template, {
      schemaVersion: '2.0.0',
      nodes: [],
      edges: [],
    });

    await expect(
      service.validateAndSave(template.id, savePayload, ownerUser),
    ).resolves.toEqual(expect.objectContaining({
      id: template.id,
      status: 'private',
      revision: template.revision + 1,
    }));
    expect(repository.saveRangeTemplateTopology).toHaveBeenCalledWith(
      template.id,
      expect.objectContaining({
        ...savePayload,
        scenarioTemplateSpec: expect.objectContaining({
          ...savePayload.scenarioTemplateSpec,
          metadata: expect.objectContaining({
            name: template.name,
            slug: template.slug,
            version: template.version,
          }),
        }),
        compiledProvisionSpec: expect.objectContaining({
          ...savePayload.compiledProvisionSpec,
          identity: expect.objectContaining({
            templateSlug: template.slug,
            templateVersion: template.version,
          }),
        }),
      }),
    );
  });

  it('keeps the published state when only editing template metadata', async () => {
    const template = createTemplateRecord({
      ownerUserId: ownerUser.id,
      visibility: 'platform',
      currentPublishedVersionId: 'published-1',
      currentPublishedVersion: createDraftVersion({
        id: 'published-1',
        status: 'published',
      }),
    });
    const updatedTemplate = {
      ...template,
      name: 'Updated Template Name',
      revision: template.revision + 1,
    };
    const repository = {
      ...createRepository(template),
      updateRangeTemplateMetadata: jest.fn().mockResolvedValue(updatedTemplate),
    } as unknown as AdminRepository & {
      updateRangeTemplateMetadata: jest.Mock;
    };
    const service = new RangeTemplatesService(repository);

    await expect(
      service.updateMetadata(
        template.id,
        { name: 'Updated Template Name', expectedRevision: template.revision },
        ownerUser,
      ),
    ).resolves.toEqual(expect.objectContaining({
      name: 'Updated Template Name',
      status: 'published',
      revision: template.revision + 1,
    }));
    expect(repository.updateRangeTemplateMetadata).toHaveBeenCalledWith(template.id, {
      name: 'Updated Template Name',
      expectedRevision: template.revision,
    });
  });

  it('returns a published topology to private in one revision-checked action', async () => {
    const template = createTemplateRecord({
      ownerUserId: ownerUser.id,
      visibility: 'platform',
      currentPublishedVersionId: 'published-1',
    });
    const unsharedTemplate = {
      ...template,
      visibility: 'private' as const,
      revision: template.revision + 1,
    };
    const repository = {
      ...createRepository(template),
      unshareRangeTemplate: jest.fn().mockResolvedValue(unsharedTemplate),
    } as unknown as AdminRepository & {
      unshareRangeTemplate: jest.Mock;
    };
    const service = new RangeTemplatesService(repository);

    await expect(
      service.returnToPrivate(template.id, template.revision, ownerUser),
    ).resolves.toEqual(expect.objectContaining({
      status: 'private',
      revision: template.revision + 1,
    }));
    expect(repository.unshareRangeTemplate).toHaveBeenCalledWith(template.id, template.revision);
  });

  it('publishes successfully when draft only carries scenarioTemplateSpec and compiledProvisionSpec', async () => {
    const template = createTemplateRecord({
      currentDraftVersion: createDraftVersion({
        topologySpec: null,
        compiledSpec: null,
        scenarioTemplateSpec: {
          schemaVersion: '1.0.0',
          metadata: {
            name: 'Enterprise Template',
            slug: 'enterprise-template',
            version: 'v1',
            cloudProvider: 'alibaba_cloud',
            iacType: 'opentofu',
          },
          topology: {
            vpcCidr: '10.70.0.0/16',
            entryHostKey: 'dmz-entry',
          },
          networkZones: [
            {
              key: 'dmz',
              name: 'DMZ',
              cidr: '10.70.10.0/24',
              purpose: 'public-entry',
              isPublicEntry: true,
              routeRole: 'entry',
            },
          ],
          hosts: [
            {
              key: 'dmz-entry',
              name: 'DMZ Entry',
              role: 'entry',
              zoneKey: 'dmz',
              primaryPrivateIp: '10.70.10.10',
              exposePublic: true,
            },
          ],
          nat: { natGateways: [], eips: [] },
          access: { portGroups: [] },
          bootstrap: { scripts: [] },
          runtimePreferences: { imagePolicies: [], instanceTypePolicies: [] },
        },
        compiledProvisionSpec: {
          schemaVersion: '1.0.0',
          identity: {
            templateSlug: 'enterprise-template',
            templateVersion: 'v1',
            cloudProvider: 'alibaba_cloud',
            iacType: 'opentofu',
          },
          topology: {
            vpcCidr: '10.70.0.0/16',
            entryHostKey: 'dmz-entry',
          },
          networkZones: [
            {
              key: 'dmz',
              name: 'DMZ',
              cidr: '10.70.10.0/24',
              purpose: 'public-entry',
              isPublicEntry: true,
              routeRole: 'entry',
            },
          ],
          hosts: [
            {
              key: 'dmz-entry',
              name: 'DMZ Entry',
              role: 'entry',
              zoneKey: 'dmz',
              primaryPrivateIp: '10.70.10.10',
              exposePublic: true,
              networkInterfaces: [{ deviceIndex: 0, zoneKey: 'dmz', privateIp: '10.70.10.10' }],
            },
          ],
          natGateways: [],
          eips: [],
          snatEntries: [],
          dnatEntries: [],
          securityGroupRules: [],
          aclRules: [],
          bootstrapScripts: [],
          runtimeSelections: { imagePolicies: {}, instanceTypePolicies: {} },
        },
      }),
    });

    const publishedTemplate = {
      ...template,
      visibility: 'platform' as const,
      revision: template.revision + 1,
      currentPublishedVersionId: template.currentDraftVersionId,
      currentPublishedVersion: template.currentDraftVersion,
    };
    const repository = {
      ...createRepository(template),
      publishRangeTemplateToPlatform: jest.fn().mockResolvedValue(publishedTemplate),
    } as unknown as AdminRepository & {
      publishRangeTemplateToPlatform: jest.Mock;
    };
    const service = new RangeTemplatesService(repository);

    await expect(
      service.publishToPlatform(template.id, template.revision),
    ).resolves.toEqual(expect.objectContaining({
      status: 'published',
      revision: template.revision + 1,
    }));
    expect(repository.publishRangeTemplateToPlatform).toHaveBeenCalledWith(
      template.id,
      template.revision,
    );
  });

  it('rejects publish when compiled resources conflict with topology host and zone fields', async () => {
    const template = createTemplateRecord({
      currentDraftVersion: createDraftVersion({
        compiledSpec: {
          schemaVersion: '1.0.0',
          resources: [
            {
              id: 'switch-dmz',
              type: 'switch',
              provider: 'alibaba_cloud',
              config: {
                label: 'DMZ',
                zoneKey: 'dmz',
                cidr: '10.70.99.0/24',
                purpose: 'public-entry',
              },
            },
            {
              id: 'switch-office',
              type: 'switch',
              provider: 'alibaba_cloud',
              config: {
                label: 'Office',
                zoneKey: 'office',
                cidr: '10.70.20.0/24',
                purpose: 'user-workstations',
              },
            },
            {
              id: 'dmz-entry',
              type: 'host',
              provider: 'alibaba_cloud',
              config: {
                label: 'DMZ Entry',
                zoneKey: 'dmz-alt',
                role: 'jumpbox',
                privateIp: '10.70.10.99',
                exposePublic: false,
              },
            },
            {
              id: 'office-client',
              type: 'host',
              provider: 'alibaba_cloud',
              config: {
                label: 'Office Client',
                zoneKey: 'office',
                role: 'workstation',
                privateIp: '10.70.20.10',
                exposePublic: false,
              },
            },
          ],
          topology: {
            vpcCidr: '10.70.0.0/16',
            publicEntryHostKey: 'dmz-entry',
            networkZoneKeys: ['dmz', 'office'],
            hostKeys: ['dmz-entry', 'office-client'],
          },
        },
      }),
    });

    const service = new RangeTemplatesService(createRepository(template));
    const result = service.publishToPlatform(template.id, template.revision);

    await expect(result).rejects.toThrow(BadRequestException);

    await result.catch((error: BadRequestException) => {
      expect(error.getResponse()).toEqual(
        expect.objectContaining({
          message: expect.arrayContaining([
            'Compiled switch resource cidr mismatch for zone dmz',
            'Compiled host resource zoneKey mismatch for host dmz-entry',
            'Compiled host resource role mismatch for host dmz-entry',
            'Compiled host resource privateIp mismatch for host dmz-entry',
            'Compiled host resource public access mismatch for host dmz-entry',
          ]),
        }),
      );
    });
  });

  it('rejects publish when extended network resources reference unknown zones or targets', async () => {
    const template = createTemplateRecord({
      currentDraftVersion: createDraftVersion({
        compiledSpec: {
          schemaVersion: '1.0.0',
          resources: [
            {
              id: 'switch-dmz',
              type: 'switch',
              provider: 'alibaba_cloud',
              config: {
                label: 'DMZ',
                zoneKey: 'dmz',
                cidr: '10.70.10.0/24',
                purpose: 'public-entry',
              },
            },
            {
              id: 'switch-office',
              type: 'switch',
              provider: 'alibaba_cloud',
              config: {
                label: 'Office',
                zoneKey: 'office',
                cidr: '10.70.20.0/24',
                purpose: 'user-workstations',
              },
            },
            {
              id: 'dmz-entry',
              type: 'host',
              provider: 'alibaba_cloud',
              config: {
                label: 'DMZ Entry',
                zoneKey: 'dmz',
                role: 'entry',
                privateIp: '10.70.10.10',
                exposePublic: true,
              },
            },
            {
              id: 'office-client',
              type: 'host',
              provider: 'alibaba_cloud',
              config: {
                label: 'Office Client',
                zoneKey: 'office',
                role: 'workstation',
                privateIp: '10.70.20.10',
                exposePublic: false,
              },
            },
            {
              id: 'nat-office',
              type: 'nat_gateway',
              provider: 'alibaba_cloud',
              config: {
                label: 'Office NAT',
                zoneKey: 'ghost-zone',
                snatEnabled: true,
              },
            },
            {
              id: 'eip-office',
              type: 'eip',
              provider: 'alibaba_cloud',
              config: {
                label: 'Office EIP',
                bindTargetType: 'nat_gateway',
                bindTargetKey: 'nat-missing',
                bandwidthMbps: 20,
              },
            },
            {
              id: 'acl-office',
              type: 'acl',
              provider: 'alibaba_cloud',
              config: {
                label: 'Office ACL',
                zoneKey: 'ghost-zone',
                direction: 'inbound',
                policy: 'allow',
                protocol: 'tcp',
                portRange: '3389/3389',
                sourceCidr: '0.0.0.0/0',
                priority: 1,
              },
            },
            {
              id: 'sg-office',
              type: 'security_group_rule',
              provider: 'alibaba_cloud',
              config: {
                label: 'Office SSH',
                targetHostKey: 'ghost-host',
                direction: 'ingress',
                policy: 'accept',
                protocol: 'tcp',
                portRange: '22/22',
                sourceCidr: '0.0.0.0/0',
                priority: 1,
              },
            },
          ],
          topology: {
            vpcCidr: '10.70.0.0/16',
            publicEntryHostKey: 'dmz-entry',
            networkZoneKeys: ['dmz', 'office'],
            hostKeys: ['dmz-entry', 'office-client'],
          },
        },
      }),
    });

    const service = new RangeTemplatesService(createRepository(template));
    const result = service.publishToPlatform(template.id, template.revision);

    await expect(result).rejects.toThrow(BadRequestException);

    await result.catch((error: BadRequestException) => {
      expect(error.getResponse()).toEqual(
        expect.objectContaining({
          message: expect.arrayContaining([
            'Compiled nat gateway references unknown network zone: ghost-zone',
            'Compiled EIP references unknown nat gateway target: nat-missing',
            'Compiled ACL references unknown network zone: ghost-zone',
            'Compiled security group rule references unknown host target: ghost-host',
          ]),
        }),
      );
    });
  });

  it('rejects publish when snat and dnat resources reference unknown targets', async () => {
    const template = createTemplateRecord({
      currentDraftVersion: createDraftVersion({
        compiledSpec: {
          schemaVersion: '1.0.0',
          resources: [
            {
              id: 'switch-dmz',
              type: 'switch',
              provider: 'alibaba_cloud',
              config: {
                label: 'DMZ',
                zoneKey: 'dmz',
                cidr: '10.70.10.0/24',
                purpose: 'public-entry',
              },
            },
            {
              id: 'switch-office',
              type: 'switch',
              provider: 'alibaba_cloud',
              config: {
                label: 'Office',
                zoneKey: 'office',
                cidr: '10.70.20.0/24',
                purpose: 'user-workstations',
              },
            },
            {
              id: 'dmz-entry',
              type: 'host',
              provider: 'alibaba_cloud',
              config: {
                label: 'DMZ Entry',
                zoneKey: 'dmz',
                role: 'entry',
                privateIp: '10.70.10.10',
                exposePublic: true,
              },
            },
            {
              id: 'office-client',
              type: 'host',
              provider: 'alibaba_cloud',
              config: {
                label: 'Office Client',
                zoneKey: 'office',
                role: 'workstation',
                privateIp: '10.70.20.10',
                exposePublic: false,
              },
            },
            {
              id: 'snat-office',
              type: 'snat_entry',
              provider: 'alibaba_cloud',
              config: {
                label: 'Office SNAT',
                natGatewayKey: 'ghost-nat',
                sourceZoneKey: 'ghost-zone',
                eipKey: 'ghost-eip',
              },
            },
            {
              id: 'dnat-entry-web',
              type: 'dnat_entry',
              provider: 'alibaba_cloud',
              config: {
                label: 'Entry DNAT',
                natGatewayKey: 'ghost-nat',
                eipKey: 'ghost-eip',
                backendHostKey: 'ghost-host',
                externalPort: 8080,
                internalPort: 80,
                protocol: 'tcp',
              },
            },
          ],
          topology: {
            vpcCidr: '10.70.0.0/16',
            publicEntryHostKey: 'dmz-entry',
            networkZoneKeys: ['dmz', 'office'],
            hostKeys: ['dmz-entry', 'office-client'],
          },
        },
      }),
    });

    const service = new RangeTemplatesService(createRepository(template));
    const result = service.publishToPlatform(template.id, template.revision);

    await expect(result).rejects.toThrow(BadRequestException);

    await result.catch((error: BadRequestException) => {
      expect(error.getResponse()).toEqual(
        expect.objectContaining({
          message: expect.arrayContaining([
            'Compiled SNAT entry references unknown nat gateway target: ghost-nat',
            'Compiled SNAT entry references unknown source network zone: ghost-zone',
            'Compiled SNAT entry references unknown EIP target: ghost-eip',
            'Compiled DNAT entry references unknown nat gateway target: ghost-nat',
            'Compiled DNAT entry references unknown EIP target: ghost-eip',
            'Compiled DNAT entry references unknown backend host target: ghost-host',
          ]),
        }),
      );
    });
  });
});
