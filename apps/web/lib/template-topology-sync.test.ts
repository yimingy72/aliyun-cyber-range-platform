import { describe, expect, it } from 'vitest';

import { createEnterpriseRangeSkeleton } from './template-topology-skeleton';
import { syncTopologySpecFromNodes } from './template-topology-sync';

describe('syncTopologySpecFromNodes', () => {
  it('derives the public entry exclusively from a single switch DNAT target', () => {
    const skeleton = createEnterpriseRangeSkeleton();
    const topologySpec = syncTopologySpecFromNodes({
      nodes: skeleton.map((node) => {
        if (node.kind === 'switch') {
          return {
            ...node,
            nat: {
              ...node.nat,
              dnatMappings: [
                {
                  key: 'dnat-entry',
                  targetHostId: 'ecs-core-1',
                  externalPort: 80,
                  internalPort: 80,
                  protocol: 'tcp',
                },
              ],
            },
          };
        }

        if (node.kind === 'ecs') {
          return {
            ...node,
            role: 'host',
            exposePublic: false,
          };
        }

        return node;
      }) as any,
    });

    expect(topologySpec.publicEntry).toEqual({
      hostKey: 'ecs-core-1',
      protocols: [
        { protocol: 'ssh', port: 22 },
        { protocol: 'http', port: 80 },
      ],
    });
    expect(topologySpec.hosts).toEqual([
      expect.objectContaining({
        key: 'ecs-core-1',
        role: 'host',
        exposePublic: true,
      }),
    ]);
    expect(topologySpec.executionPolicies).toEqual(
      expect.objectContaining({
        allowSshIngress: true,
        allowHttpIngress: true,
      }),
    );
  });

  it('keeps a private management host without inferring public exposure from legacy flags', () => {
    const skeleton = createEnterpriseRangeSkeleton();
    const topologySpec = syncTopologySpecFromNodes({
      nodes: skeleton.map((node) =>
        node.kind === 'switch'
          ? {
              ...node,
              nat: {
                ...node.nat,
                dnatMappings: [],
              },
            }
          : node,
      ) as any,
    });

    expect(topologySpec.publicEntry).toEqual({
      hostKey: 'ecs-core-1',
      protocols: [{ protocol: 'ssh', port: 22 }, { protocol: 'http', port: 80 }],
    });
    expect(topologySpec.hosts).toEqual([
      expect.objectContaining({
        key: 'ecs-core-1',
        exposePublic: false,
      }),
    ]);
    expect(topologySpec.executionPolicies).toEqual(
      expect.objectContaining({
        allowSshIngress: false,
        allowHttpIngress: false,
      }),
    );
  });

  it('builds a phase-one topologySpec from the router + switch + ecs skeleton nodes', () => {
    const skeleton = createEnterpriseRangeSkeleton();
    const topologySpec = syncTopologySpecFromNodes({ nodes: skeleton as any });

    expect(topologySpec.vpcCidr).toBe('10.0.0.0/16');
    expect(skeleton).toEqual([
      expect.objectContaining({
        kind: 'router',
        description: expect.any(String),
      }),
      expect.objectContaining({
        kind: 'switch',
        description: expect.any(String),
        aclRules: expect.any(Array),
        nat: expect.objectContaining({
          snatEnabled: false,
          dnatMappings: [
            expect.objectContaining({
              targetHostId: 'ecs-core-1',
            }),
          ],
        }),
      }),
      expect.objectContaining({
        kind: 'ecs',
        instanceName: expect.any(String),
        hostName: expect.any(String),
        cpu: 2,
        memory: 4,
        nics: [
          expect.objectContaining({
            switchId: 'switch-core',
            privateIp: '10.0.0.10',
            secondaryIps: [],
            securityGroupRules: [],
          }),
        ],
      }),
    ]);
    expect(topologySpec.networkZones).toEqual([
      {
        key: 'core',
        name: 'Core',
        purpose: 'business-zone',
        cidr: '10.0.0.0/24',
        isPublicEntry: true,
      },
    ]);
    expect(topologySpec.hosts).toEqual([
      {
        key: 'ecs-core-1',
        name: '业务 ECS',
        hostName: 'core-entry',
        zoneKey: 'core',
        role: 'host',
        privateIp: '10.0.0.10',
        exposePublic: true,
      },
    ]);
    expect(topologySpec.publicEntry).toEqual({
      hostKey: 'ecs-core-1',
      protocols: [
        { protocol: 'ssh', port: 22 },
        { protocol: 'http', port: 80 },
      ],
    });
  });

  it('resolves host zone and primary ip from nic.switchId instead of legacy host zone fields', () => {
    const topologySpec = syncTopologySpecFromNodes({
      nodes: [
        {
          id: 'router-main',
          kind: 'router',
          label: '主路由器',
          description: '根 VPC',
        },
        {
          id: 'switch-app',
          kind: 'switch',
          label: '应用交换机',
          zoneKey: 'app',
          cidr: '10.77.20.0/24',
          purpose: 'application',
          description: '应用区',
          aclRules: [],
          nat: {
            snatEnabled: true,
            dnatMappings: [
              {
                key: 'dnat-app',
                targetHostId: 'ecs-app-1',
                externalPort: 80,
                internalPort: 80,
                protocol: 'tcp',
              },
            ],
          },
        },
        {
          id: 'ecs-app-1',
          kind: 'ecs',
          label: '应用主机',
          zoneKey: 'legacy-zone',
          role: 'host',
          privateIp: '10.255.255.10',
          exposePublic: false,
          image: 'aliyun_linux_3_x64_20G_alibase',
          instanceName: 'app-01',
          hostName: 'app-01',
          imageName: 'aliyun_linux_3_x64_20G_alibase',
          imageId: 'aliyun_linux_3_x64_20G_alibase',
          cpu: 2,
          memory: 4,
          description: '应用主机',
          bootPriority: 1,
          bootWaitSeconds: 0,
          dnatMappings: [],
          networkInterfaces: [
            {
              zoneKey: 'legacy-zone',
              privateIp: '10.255.255.10',
            },
          ],
          portGroups: [],
          nics: [
            {
              id: 'nic-app-1',
              switchId: 'switch-app',
              privateIp: '10.77.20.10',
              secondaryIps: ['10.77.20.11'],
              securityGroupRules: [],
            },
          ],
          initScript: '',
          imageStrategy: {
            mode: 'fixed',
            imageId: 'aliyun_linux_3_x64_20G_alibase',
          },
          instanceTypeStrategy: {
            mode: 'auto',
            preferredInstanceTypes: [],
          },
        },
      ] as any,
    });

    expect(topologySpec.hosts).toEqual([
      {
        key: 'ecs-app-1',
        name: '应用主机',
        hostName: 'app-01',
        zoneKey: 'app',
        role: 'host',
        privateIp: '10.77.20.10',
        exposePublic: true,
      },
    ]);
    expect(topologySpec.publicEntry.hostKey).toBe('ecs-app-1');
    expect(topologySpec.executionPolicies).toEqual(
      expect.objectContaining({
        allowSshIngress: true,
        allowHttpIngress: true,
        enableSnatOnDemand: true,
      }),
    );
  });

  it('omits an empty hostName from topologySpec so cloud host naming can be omitted later', () => {
    const topologySpec = syncTopologySpecFromNodes({
      nodes: [
        {
          id: 'switch-core',
          kind: 'switch',
          label: '核心交换机',
          zoneKey: 'core',
          cidr: '10.0.0.0/24',
        isPublicEntry: true,
          purpose: 'business-zone',
          description: '',
          aclRules: [],
          nat: {
            snatEnabled: false,
            dnatMappings: [],
          },
        },
        {
          id: 'ecs-1',
          kind: 'ecs',
          label: '业务 ECS',
          zoneKey: 'core',
          role: 'entry',
          privateIp: '10.0.0.10',
          exposePublic: true,
          image: 'aliyun_linux_3_x64_20G_alibase',
          instanceName: '业务 ECS',
          hostName: '',
          imageName: 'aliyun_linux_3_x64_20G_alibase',
          imageId: 'aliyun_linux_3_x64_20G_alibase',
          cpu: 2,
          memory: 4,
          description: '',
          bootPriority: 1,
          bootWaitSeconds: 0,
          dnatMappings: [],
          networkInterfaces: [{ zoneKey: 'core', privateIp: '10.0.0.10' }],
          portGroups: [],
          nics: [
            {
              id: 'ecs-1-nic-1',
              switchId: 'switch-core',
              privateIp: '10.0.0.10',
              secondaryIps: [],
              securityGroupRules: [],
            },
          ],
          initScript: '',
          imageStrategy: {
            mode: 'fixed',
            imageId: 'aliyun_linux_3_x64_20G_alibase',
          },
          instanceTypeStrategy: {
            mode: 'auto',
            preferredInstanceTypes: [],
          },
        },
      ] as any,
    });

    expect(topologySpec.hosts).toEqual([
      expect.not.objectContaining({
        hostName: expect.anything(),
      }),
    ]);
  });
});

it('keeps all DNAT targets public while selecting only the first for the legacy access summary', () => {
  const nodes = createEnterpriseRangeSkeleton();
  const host = nodes.find((node) => node.kind === 'ecs')!;
  if (host.kind !== 'ecs') throw new Error('missing host');
  nodes.push({ ...structuredClone(host), id: 'other', label: 'Other', privateIp: '10.0.0.20' });
  const switchNode = nodes.find((node) => node.kind === 'switch')!;
  if (switchNode.kind !== 'switch') throw new Error('missing switch');
  switchNode.nat!.dnatMappings.push({ key: 'other-http', targetHostId: 'other', externalPort: 8080, internalPort: 80, protocol: 'tcp' });
  const result = syncTopologySpecFromNodes({ nodes });
  expect(result.publicEntry.hostKey).toBe('ecs-core-1');
  expect(result.hosts.map((node) => node.exposePublic)).toEqual([true, true]);
});
