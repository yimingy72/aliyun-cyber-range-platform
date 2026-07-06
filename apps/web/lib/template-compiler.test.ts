import { describe, expect, it } from 'vitest';

import { compileTopologyGraph } from './template-compiler';
import type { RangeTemplateTopologySpec } from './admin-types';
import type { TemplateNode } from './scenario-graph';

describe('compileTopologyGraph', () => {
  it('compiles the router, switch, and ecs graph while deriving nat resources from switch.nat and keeping the newer node fields intact', () => {
    const nodes: TemplateNode[] = [
      {
        id: 'router-1',
        kind: 'router',
        label: '公网出口',
        description: '根 VPC 路由器',
        routeRole: 'core',
        egressType: 'internet',
        bindEip: false,
      },
      {
        id: 'switch-1',
        kind: 'switch',
        label: 'DMZ 子网',
        zoneKey: 'dmz-a',
        cidr: '10.0.1.0/24',
        purpose: 'dmz',
        description: '入口网段',
        aclRules: [
          {
            key: 'acl-ssh',
            direction: 'inbound',
            protocol: 'tcp',
            portRange: '22/22',
            sourceCidr: '0.0.0.0/0',
            destinationCidr: '10.0.1.0/24',
            policy: 'allow',
            priority: 10,
            description: 'SSH 入口',
          },
        ],
        nat: {
          snatEnabled: true,
          dnatMappings: [
            {
              key: 'dnat-web',
              targetHostId: 'host-1',
              externalPort: 8080,
              internalPort: 80,
              protocol: 'tcp',
              description: '公网入口 Web',
            },
          ],
        },
      },
      {
        id: 'host-1',
        kind: 'ecs',
        label: '边界主机',
        role: 'entry',
        zoneKey: 'legacy-dmz',
        privateIp: '10.255.255.10',
        exposePublic: true,
        image: 'aliyun_linux_3_x64_20G_alibase',
        instanceName: 'host-1',
        hostName: 'dmz-web-01',
        imageName: 'aliyun_linux_3_x64_20G_alibase',
        imageId: 'aliyun_linux_3_x64_20G_alibase',
        cpu: 2,
        memory: 4,
        description: '对外入口机',
        bootPriority: 1,
        bootWaitSeconds: 15,
        dnatMappings: [],
        networkInterfaces: [],
        portGroups: [
          {
            name: 'web',
            protocol: 'tcp',
            portRange: '80/80',
            sourceCidr: '0.0.0.0/0',
          },
        ],
        nics: [
          {
            id: 'nic-host-1',
            switchId: 'switch-1',
            privateIp: '10.0.1.10',
            secondaryIps: ['10.0.1.11'],
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
        ],
        initScript: '#!/bin/bash\necho ready',
        imageStrategy: {
          mode: 'fixed',
          imageId: 'aliyun_linux_3_x64_20G_alibase',
        },
        instanceTypeStrategy: {
          mode: 'prefer-list',
          preferredInstanceTypes: ['ecs.u1-c1m2.large'],
        },
      },
    ];

    const topologySpec: RangeTemplateTopologySpec = {
      vpcCidr: '10.70.0.0/16',
      networkZones: [
        {
          key: 'dmz-a',
          name: 'DMZ',
          purpose: 'dmz',
          cidr: '10.0.1.0/24',
          isPublicEntry: true,
        },
      ],
      hosts: [
        {
          key: 'host-1',
          name: '边界主机',
          zoneKey: 'dmz-a',
          role: 'entry',
          privateIp: '10.0.1.10',
          exposePublic: true,
        },
      ],
      publicEntry: {
        hostKey: 'host-1',
        protocols: [{ protocol: 'ssh', port: 22 }],
      },
    };

    expect(compileTopologyGraph({ nodes, topologySpec })).toEqual({
      schemaVersion: '1.0.0',
      resources: [
        {
          id: 'router-1',
          type: 'router',
          provider: 'alibaba_cloud',
          config: {
            label: '公网出口',
            description: '根 VPC 路由器',
          },
        },
        {
          id: 'switch-1',
          type: 'switch',
          provider: 'alibaba_cloud',
          config: {
            label: 'DMZ 子网',
            zoneKey: 'dmz-a',
            cidr: '10.0.1.0/24',
            purpose: 'dmz',
            description: '入口网段',
            aclRules: [
              {
                key: 'acl-ssh',
                direction: 'inbound',
                protocol: 'tcp',
                portRange: '22/22',
                sourceCidr: '0.0.0.0/0',
                destinationCidr: '10.0.1.0/24',
                policy: 'allow',
                priority: 10,
                description: 'SSH 入口',
              },
            ],
            nat: {
              snatEnabled: true,
              dnatMappings: [
                {
                  key: 'dnat-web',
                  targetHostId: 'host-1',
                  externalPort: 8080,
                  internalPort: 80,
                  protocol: 'tcp',
                  description: '公网入口 Web',
                },
              ],
            },
          },
        },
        {
          id: 'host-1',
          type: 'host',
          provider: 'alibaba_cloud',
          config: {
            label: '边界主机',
            zoneKey: 'dmz-a',
            role: 'entry',
            privateIp: '10.0.1.10',
            exposePublic: true,
            image: 'aliyun_linux_3_x64_20G_alibase',
            instanceName: 'host-1',
            hostName: 'dmz-web-01',
            imageName: 'aliyun_linux_3_x64_20G_alibase',
            imageId: 'aliyun_linux_3_x64_20G_alibase',
            cpu: 2,
            memory: 4,
            description: '对外入口机',
            bootPriority: 1,
            bootWaitSeconds: 15,
            dnatMappings: [],
            networkInterfaces: [],
            portGroups: [
              {
                name: 'web',
                protocol: 'tcp',
                portRange: '80/80',
                sourceCidr: '0.0.0.0/0',
              },
            ],
            nics: [
              {
                id: 'nic-host-1',
                switchId: 'switch-1',
                privateIp: '10.0.1.10',
                secondaryIps: ['10.0.1.11'],
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
            ],
            initScript: '#!/bin/bash\necho ready',
            imageStrategy: {
              mode: 'fixed',
              imageId: 'aliyun_linux_3_x64_20G_alibase',
            },
            instanceTypeStrategy: {
              mode: 'prefer-list',
              preferredInstanceTypes: ['ecs.u1-c1m2.large'],
            },
          },
        },
        {
          id: 'nat-switch-1',
          type: 'nat_gateway',
          provider: 'alibaba_cloud',
          config: {
            label: 'DMZ 子网 NAT',
            zoneKey: 'dmz-a',
            snatEnabled: true,
          },
        },
        {
          id: 'eip-switch-1',
          type: 'eip',
          provider: 'alibaba_cloud',
          config: {
            label: 'DMZ 子网 EIP',
            bindTargetType: 'nat_gateway',
            bindTargetKey: 'nat-switch-1',
            bandwidthMbps: 30,
          },
        },
        {
          id: 'switch-1-snat-1',
          type: 'snat_entry',
          provider: 'alibaba_cloud',
          config: {
            label: 'DMZ 子网 SNAT',
            natGatewayKey: 'nat-switch-1',
            sourceZoneKey: 'dmz-a',
            eipKey: 'eip-switch-1',
          },
        },
        {
          id: 'host-1-dnat-1',
          type: 'dnat_entry',
          provider: 'alibaba_cloud',
          config: {
            label: 'dnat-web',
            natGatewayKey: 'nat-switch-1',
            eipKey: 'eip-switch-1',
            backendHostKey: 'host-1',
            externalPort: 8080,
            internalPort: 80,
            protocol: 'tcp',
          },
        },
      ],
      topology: {
        vpcCidr: '10.70.0.0/16',
        publicEntryHostKey: 'host-1',
        networkZoneKeys: ['dmz-a'],
        hostKeys: ['host-1'],
      },
    });

    expect(Object.keys(compileTopologyGraph({ nodes, topologySpec }).resources[0]?.config ?? {}).sort()).toEqual([
      'description',
      'label',
    ]);
    expect(Object.keys(compileTopologyGraph({ nodes, topologySpec }).resources[1]?.config ?? {}).sort()).toEqual([
      'aclRules',
      'cidr',
      'description',
      'label',
      'nat',
      'purpose',
      'zoneKey',
    ]);
    expect(Object.keys(compileTopologyGraph({ nodes, topologySpec }).resources[2]?.config ?? {}).sort()).toEqual([
      'bootPriority',
      'bootWaitSeconds',
      'cpu',
      'description',
      'dnatMappings',
      'exposePublic',
      'hostName',
      'image',
      'imageId',
      'imageName',
      'imageStrategy',
      'initScript',
      'instanceName',
      'instanceType',
      'instanceTypeStrategy',
      'label',
      'memory',
      'networkInterfaces',
      'nics',
      'portGroups',
      'privateIp',
      'role',
      'zoneKey',
    ]);
    expect(Object.keys(compileTopologyGraph({ nodes, topologySpec }).resources[3]?.config ?? {}).sort()).toEqual([
      'label',
      'snatEnabled',
      'zoneKey',
    ]);
    expect(Object.keys(compileTopologyGraph({ nodes, topologySpec }).resources[4]?.config ?? {}).sort()).toEqual([
      'bandwidthMbps',
      'bindTargetKey',
      'bindTargetType',
      'label',
    ]);
    expect(Object.keys(compileTopologyGraph({ nodes, topologySpec }).resources[5]?.config ?? {}).sort()).toEqual([
      'eipKey',
      'label',
      'natGatewayKey',
      'sourceZoneKey',
    ]);

    expect(
      compileTopologyGraph({ nodes }).resources.find((resource) => resource.id === 'host-1')?.config,
    ).toEqual(
      expect.objectContaining({
        zoneKey: 'dmz-a',
        privateIp: '10.0.1.10',
      }),
    );
  });

  it('throws for removed legacy node kinds instead of compiling them as first-class graph nodes', () => {
    const invalidNode = {
      id: 'nat-legacy-1',
      kind: 'nat_gateway',
      label: '旧 NAT 节点',
    } as unknown as TemplateNode;

    expect(() => compileTopologyGraph({ nodes: [invalidNode], topologySpec: null })).toThrowError(
      'Unsupported template node kind: nat_gateway',
    );
  });
});
