import { BadRequestException } from '@nestjs/common';

import type { AdminRepository, RangeTemplateRecord, RangeTemplateVersionRecord } from '../src/admin/admin.repository';
import { RangeTemplatesService } from '../src/admin/range-templates.service';

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

describe('RangeTemplatesService publish precheck', () => {
  function createRepository(template: RangeTemplateRecord) {
    return {
      getRangeTemplateById: jest.fn().mockResolvedValue(template),
      publishRangeTemplate: jest.fn().mockResolvedValue(template),
      unpublishRangeTemplate: jest.fn().mockResolvedValue(template),
    } as unknown as AdminRepository;
  }

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
    const result = service.publish(template.id);

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

  it('reuses the same backend precheck for explicit topology validation without publishing', async () => {
    const template = createTemplateRecord();
    const repository = createRepository(template);
    const service = new RangeTemplatesService(repository);

    await expect(service.validate(template.id)).resolves.toEqual({ valid: true });
    expect((repository as unknown as { publishRangeTemplate: jest.Mock }).publishRangeTemplate).not.toHaveBeenCalled();
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

    const repository = createRepository(template);
    const service = new RangeTemplatesService(repository);

    await expect(service.publish(template.id)).resolves.toEqual(template);
    expect(repository.publishRangeTemplate).toHaveBeenCalledWith(template.id);
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
    const result = service.publish(template.id);

    await expect(result).rejects.toThrow(BadRequestException);

    await result.catch((error: BadRequestException) => {
      expect(error.getResponse()).toEqual(
        expect.objectContaining({
          message: expect.arrayContaining([
            'Compiled switch resource cidr mismatch for zone dmz',
            'Compiled host resource zoneKey mismatch for host dmz-entry',
            'Compiled host resource role mismatch for host dmz-entry',
            'Compiled host resource privateIp mismatch for host dmz-entry',
            'Compiled public entry host must expose public access: dmz-entry',
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
    const result = service.publish(template.id);

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
    const result = service.publish(template.id);

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
