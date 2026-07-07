import { describe, expect, it } from 'vitest';

import { buildScenarioTemplateSpecFromTopologyGraph } from '@aliyun-cyber-range/scenario-runtime';

describe('buildScenarioTemplateSpecFromTopologyGraph', () => {
  it('builds switch ACL, switch NAT, host multi-NIC, and NIC security rules into scenario template spec', () => {
    const template = buildScenarioTemplateSpecFromTopologyGraph({
      metadata: {
        name: '综合靶场',
        slug: 'enterprise-range',
        version: 'v1',
        cloudProvider: 'alibaba_cloud',
        iacType: 'opentofu',
      },
      topologyGraph: {
        schemaVersion: '2.0.0',
        edges: [],
        nodes: [
          {
            id: 'router-main',
            kind: 'router',
            label: '主路由器',
            description: '根 VPC',
          },
          {
            id: 'switch-dmz',
            kind: 'switch',
            label: 'DMZ 交换机',
            zoneKey: 'dmz',
            cidr: '10.88.10.0/24',
            purpose: 'dmz',
            description: '公网入口区',
            aclRules: [
              {
                key: 'acl-dmz-inbound',
                direction: 'inbound',
                protocol: 'tcp',
                portRange: '22/22',
                sourceCidr: '0.0.0.0/0',
                destinationCidr: '10.88.10.0/24',
                policy: 'allow',
                priority: 10,
                description: '允许 SSH 入口',
              },
            ],
            nat: {
              snatEnabled: true,
              dnatMappings: [
                {
                  key: 'dnat-web',
                  targetHostId: 'ecs-web',
                  externalPort: 8080,
                  internalPort: 80,
                  protocol: 'tcp',
                  description: '公网映射到 Web',
                },
              ],
            },
          },
          {
            id: 'switch-server',
            kind: 'switch',
            label: 'Server 交换机',
            zoneKey: 'server',
            cidr: '10.88.20.0/24',
            purpose: 'server',
            description: '服务器区',
            aclRules: [],
            nat: {
              snatEnabled: false,
              dnatMappings: [],
            },
          },
          {
            id: 'ecs-web',
            kind: 'ecs',
            label: 'Web 主机',
            instanceName: 'web-01',
            hostName: 'web-01',
            role: 'entry',
            imageName: 'ubuntu-22.04',
            imageId: 'img-web',
            cpu: 2,
            memory: 2,
            description: 'Web 服务',
            bootPriority: 1,
            bootWaitSeconds: 10,
            nics: [
              {
                id: 'nic-web-dmz',
                switchId: 'switch-dmz',
                privateIp: '10.88.10.10',
                secondaryIps: ['10.88.10.11'],
                securityGroupRules: [
                  {
                    key: 'sg-web-ssh',
                    direction: 'ingress',
                    protocol: 'tcp',
                    portRange: '22/22',
                    sourceCidr: '0.0.0.0/0',
                    policy: 'accept',
                    priority: 10,
                    description: 'SSH',
                  },
                ],
              },
              {
                id: 'nic-web-server',
                switchId: 'switch-server',
                privateIp: '10.88.20.10',
                secondaryIps: [],
                securityGroupRules: [],
              },
            ],
            initScript: '#!/bin/bash\necho ready',
            imageStrategy: {
              mode: 'fixed',
              imageId: 'img-web',
            },
            instanceTypeStrategy: {
              mode: 'auto',
            },
          },
        ] as any,
      },
      defaults: {
        vpcCidr: '10.88.0.0/16',
        defaultRegion: 'cn-hangzhou',
        defaultZoneId: 'cn-hangzhou-h',
      },
    });

    expect(template.topology).toEqual({
      vpcCidr: '10.88.0.0/16',
      entryHostKey: 'ecs-web',
      defaultRegion: 'cn-hangzhou',
      defaultZoneId: 'cn-hangzhou-h',
    });

    expect(template.networkZones).toEqual([
      expect.objectContaining({
        key: 'dmz',
        cidr: '10.88.10.0/24',
        isPublicEntry: true,
        routeRole: 'entry',
        snat: expect.objectContaining({
          enabled: true,
          natGatewayKey: 'nat-switch-dmz',
          eipKey: 'eip-switch-dmz',
        }),
      }),
      expect.objectContaining({
        key: 'server',
        cidr: '10.88.20.0/24',
        snat: expect.objectContaining({
          enabled: false,
        }),
      }),
    ]);

    expect(template.hosts).toEqual([
      expect.objectContaining({
        key: 'ecs-web',
        name: 'web-01',
        zoneKey: 'dmz',
        primaryPrivateIp: '10.88.10.10',
        image: 'img-web',
        networkInterfaces: [
          expect.objectContaining({
            deviceIndex: 0,
            zoneKey: 'dmz',
            privateIp: '10.88.10.10',
          }),
          expect.objectContaining({
            deviceIndex: 1,
            zoneKey: 'server',
            privateIp: '10.88.20.10',
          }),
        ],
        dnat: expect.objectContaining({
          enabled: true,
          natGatewayKey: 'nat-switch-dmz',
          eipKey: 'eip-switch-dmz',
          mappings: [
            expect.objectContaining({
              name: 'dnat-web',
              externalPort: 8080,
              internalPort: 80,
              protocol: 'tcp',
            }),
          ],
        }),
      }),
    ]);

    expect(template.runtimePreferences.instanceTypePolicies).toEqual([
      expect.objectContaining({
        key: 'ecs-web-instance-type-policy',
        mode: 'fixed',
        instanceType: 'ecs.e-c1m1.large',
      }),
    ]);

    expect(template.nat.natGateways).toEqual([
      {
        key: 'nat-switch-dmz',
        name: 'DMZ 交换机 NAT',
        zoneKey: 'dmz',
      },
    ]);
    expect(template.nat.eips).toEqual([
      {
        key: 'eip-switch-dmz',
        name: 'DMZ 交换机 EIP',
        bindTargetType: 'nat_gateway',
        bindTargetKey: 'nat-switch-dmz',
        bandwidthMbps: 30,
      },
    ]);

    expect(template.access.aclRules).toEqual([
      expect.objectContaining({
        key: 'acl-dmz-inbound',
        zoneKey: 'dmz',
        direction: 'inbound',
        protocol: 'tcp',
        portRange: '22/22',
        sourceCidr: '0.0.0.0/0',
        policy: 'allow',
        priority: 10,
      }),
    ]);
    expect(template.access.securityGroupRules).toEqual([
      expect.objectContaining({
        key: 'sg-web-ssh',
        targetHostKey: 'ecs-web',
        direction: 'ingress',
        protocol: 'tcp',
        portRange: '22/22',
        sourceCidr: '0.0.0.0/0',
        policy: 'accept',
        priority: 10,
      }),
    ]);
  });

  it('prefers a persisted top-level instanceType over the cpu-memory fixed catalog mapping', () => {
    const template = buildScenarioTemplateSpecFromTopologyGraph({
      metadata: {
        name: '综合靶场',
        slug: 'enterprise-range',
        version: 'v1',
        cloudProvider: 'alibaba_cloud',
        iacType: 'opentofu',
      },
      topologyGraph: {
        schemaVersion: '2.0.0',
        edges: [],
        nodes: [
          {
            id: 'switch-core',
            kind: 'switch',
            label: '核心交换机',
            zoneKey: 'core',
            cidr: '10.10.0.0/24',
            purpose: 'core',
            description: '',
            aclRules: [],
            nat: {
              snatEnabled: false,
              dnatMappings: [],
            },
          },
          {
            id: 'ecs-persisted',
            kind: 'ecs',
            label: 'Persisted ECS',
            instanceName: 'persisted-01',
            hostName: 'persisted-01',
            zoneKey: 'core',
            role: 'entry',
            privateIp: '10.10.0.10',
            exposePublic: true,
            image: 'ubuntu_22_04_x64_20G_alibase',
            imageName: 'ubuntu_22_04_x64_20G_alibase',
            imageId: 'ubuntu_22_04_x64_20G_alibase',
            cpu: 2,
            memory: 2,
            instanceType: ' ecs.persisted.custom ',
            description: '',
            bootPriority: 1,
            bootWaitSeconds: 0,
            dnatMappings: [],
            networkInterfaces: [{ zoneKey: 'core', privateIp: '10.10.0.10' }],
            portGroups: [],
            nics: [
              {
                id: 'ecs-persisted-nic-1',
                switchId: 'switch-core',
                privateIp: '10.10.0.10',
                secondaryIps: [],
                securityGroupRules: [],
              },
            ],
            initScript: '',
            imageStrategy: {
              mode: 'fixed',
              imageId: 'ubuntu_22_04_x64_20G_alibase',
            },
            instanceTypeStrategy: {
              mode: 'auto',
              preferredInstanceTypes: [],
            },
          },
        ] as any,
      },
    });

    expect(template.runtimePreferences.instanceTypePolicies).toEqual([
      expect.objectContaining({
        key: 'ecs-persisted-instance-type-policy',
        mode: 'fixed',
        instanceType: 'ecs.persisted.custom',
      }),
    ]);
  });

  it('maps 2C2G, 4C8G, and 8C16G hosts to economy-first fixed instance policies', () => {
    const template = buildScenarioTemplateSpecFromTopologyGraph({
      metadata: {
        name: '综合靶场',
        slug: 'enterprise-range',
        version: 'v1',
        cloudProvider: 'alibaba_cloud',
        iacType: 'opentofu',
      },
      topologyGraph: {
        schemaVersion: '2.0.0',
        edges: [],
        nodes: [
          {
            id: 'switch-core',
            kind: 'switch',
            label: '核心交换机',
            zoneKey: 'core',
            cidr: '10.10.0.0/24',
            purpose: 'core',
            description: '',
            aclRules: [],
            nat: {
              snatEnabled: false,
              dnatMappings: [],
            },
          },
          {
            id: 'ecs-small',
            kind: 'ecs',
            label: 'Small ECS',
            instanceName: 'small-01',
            hostName: 'small-01',
            zoneKey: 'core',
            role: 'host',
            privateIp: '10.10.0.10',
            exposePublic: false,
            image: 'ubuntu_22_04_x64_20G_alibase',
            imageName: 'ubuntu_22_04_x64_20G_alibase',
            imageId: 'ubuntu_22_04_x64_20G_alibase',
            cpu: 2,
            memory: 2,
            description: '',
            bootPriority: 1,
            bootWaitSeconds: 0,
            dnatMappings: [],
            networkInterfaces: [{ zoneKey: 'core', privateIp: '10.10.0.10' }],
            portGroups: [],
            nics: [
              {
                id: 'ecs-small-nic-1',
                switchId: 'switch-core',
                privateIp: '10.10.0.10',
                secondaryIps: [],
                securityGroupRules: [],
              },
            ],
            initScript: '',
            imageStrategy: {
              mode: 'fixed',
              imageId: 'ubuntu_22_04_x64_20G_alibase',
            },
            instanceTypeStrategy: {
              mode: 'auto',
              preferredInstanceTypes: [],
            },
          },
          {
            id: 'ecs-mid',
            kind: 'ecs',
            label: 'Mid ECS',
            instanceName: 'mid-01',
            hostName: 'mid-01',
            zoneKey: 'core',
            role: 'host',
            privateIp: '10.10.0.11',
            exposePublic: false,
            image: 'ubuntu_22_04_x64_20G_alibase',
            imageName: 'ubuntu_22_04_x64_20G_alibase',
            imageId: 'ubuntu_22_04_x64_20G_alibase',
            cpu: 4,
            memory: 8,
            description: '',
            bootPriority: 1,
            bootWaitSeconds: 0,
            dnatMappings: [],
            networkInterfaces: [{ zoneKey: 'core', privateIp: '10.10.0.11' }],
            portGroups: [],
            nics: [
              {
                id: 'ecs-mid-nic-1',
                switchId: 'switch-core',
                privateIp: '10.10.0.11',
                secondaryIps: [],
                securityGroupRules: [],
              },
            ],
            initScript: '',
            imageStrategy: {
              mode: 'fixed',
              imageId: 'ubuntu_22_04_x64_20G_alibase',
            },
            instanceTypeStrategy: {
              mode: 'auto',
              preferredInstanceTypes: [],
            },
          },
          {
            id: 'ecs-large',
            kind: 'ecs',
            label: 'Large ECS',
            instanceName: 'large-01',
            hostName: 'large-01',
            zoneKey: 'core',
            role: 'host',
            privateIp: '10.10.0.12',
            exposePublic: false,
            image: 'ubuntu_22_04_x64_20G_alibase',
            imageName: 'ubuntu_22_04_x64_20G_alibase',
            imageId: 'ubuntu_22_04_x64_20G_alibase',
            cpu: 8,
            memory: 16,
            description: '',
            bootPriority: 1,
            bootWaitSeconds: 0,
            dnatMappings: [],
            networkInterfaces: [{ zoneKey: 'core', privateIp: '10.10.0.12' }],
            portGroups: [],
            nics: [
              {
                id: 'ecs-large-nic-1',
                switchId: 'switch-core',
                privateIp: '10.10.0.12',
                secondaryIps: [],
                securityGroupRules: [],
              },
            ],
            initScript: '',
            imageStrategy: {
              mode: 'fixed',
              imageId: 'ubuntu_22_04_x64_20G_alibase',
            },
            instanceTypeStrategy: {
              mode: 'auto',
              preferredInstanceTypes: [],
            },
          },
        ] as any,
      },
    });

    expect(template.runtimePreferences.instanceTypePolicies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'ecs-small-instance-type-policy',
          mode: 'fixed',
          instanceType: 'ecs.e-c1m1.large',
        }),
        expect.objectContaining({
          key: 'ecs-mid-instance-type-policy',
          mode: 'fixed',
          instanceType: 'ecs.e-c1m2.xlarge',
        }),
        expect.objectContaining({
          key: 'ecs-large-instance-type-policy',
          mode: 'fixed',
          instanceType: 'ecs.e-c1m2.2xlarge',
        }),
      ]),
    );
  });
});
