import { describe, expect, it } from 'vitest';

import type { TemplateAuthoringMetadata } from '@aliyun-cyber-range/scenario-runtime';

import type { ScenarioGraphDraft } from './scenario-graph';
import { buildTopologyDraftPayload } from './topology-draft-payload';

const validMetadata: TemplateAuthoringMetadata = {
  name: '入口靶场',
  slug: 'entry-range',
  version: 'v1',
  cloudProvider: 'alibaba_cloud',
  iacType: 'opentofu',
  modulePathOrRef: 'modules/enterprise-range',
  primaryVpcCidr: '10.77.0.0/16',
};

function createValidGraph(): ScenarioGraphDraft {
  return {
    schemaVersion: '2.0.0',
    nodes: [
      {
        id: 'router-main',
        kind: 'router',
        label: '主路由器',
        routeRole: 'vpc',
        egressType: 'none',
        bindEip: false,
      },
      {
        id: 'switch-dmz',
        kind: 'switch',
        label: 'DMZ 交换机',
        zoneKey: 'dmz',
        cidr: '10.77.10.0/24',
        purpose: 'dmz',
        aclRules: [],
        nat: {
          snatEnabled: false,
          dnatMappings: [
            {
              key: 'dnat-ssh',
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
        role: 'host',
        privateIp: '10.77.10.10',
        exposePublic: false,
        image: 'Ubuntu 24.04 LTS',
        platformImageAssetId: 'platform-image-ubuntu',
        instanceName: 'entry-01',
        hostName: 'entry-01',
        imageName: 'Ubuntu 24.04 LTS',
        imageId: 'ubuntu_24_04_x64_20G_alibase',
        cpu: 2,
        memory: 2,
        dnatMappings: [],
        networkInterfaces: [{ zoneKey: 'dmz', privateIp: '10.77.10.10' }],
        portGroups: [],
        nics: [
          {
            id: 'ecs-entry-nic-1',
            switchId: 'switch-dmz',
            privateIp: '10.77.10.10',
            secondaryIps: [],
            securityGroupRules: [],
          },
        ],
        initScript: '',
        imageStrategy: {
          mode: 'fixed',
          imageId: 'ubuntu_24_04_x64_20G_alibase',
        },
        instanceTypeStrategy: {
          mode: 'fixed',
          instanceType: 'ecs.e-c1m1.large',
        },
      },
    ],
    edges: [
      {
        id: 'edge-router-dmz',
        fromNodeId: 'router-main',
        toNodeId: 'switch-dmz',
        relationType: 'manual',
      },
      {
        id: 'edge-dmz-entry',
        fromNodeId: 'switch-dmz',
        toNodeId: 'ecs-entry',
        relationType: 'manual',
      },
    ],
  };
}

describe('buildTopologyDraftPayload', () => {
  it('derives all topology artifacts from one DNAT entry host', () => {
    const payload = buildTopologyDraftPayload({
      graph: createValidGraph(),
      metadata: validMetadata,
      viewport: { x: 48, y: -32, zoom: 0.9 },
    });

    expect(payload.topologyGraph.viewport).toEqual({ x: 48, y: -32, zoom: 0.9 });
    expect(payload.topologySpec.publicEntry.hostKey).toBe('ecs-entry');
    expect(payload.scenarioTemplateSpec.topology.entryHostKey).toBe('ecs-entry');
    expect(payload.compiledProvisionSpec.topology.entryHostKey).toBe('ecs-entry');
    expect(payload.compiledSpec.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'ecs-entry',
          config: expect.objectContaining({ exposePublic: true }),
        }),
      ]),
    );
  });

  it.each(['alibaba_cloud', 'tencent_cloud'] as const)('supports a pure private %s topology without NAT or public exposure', (provider) => {
    const graph = createValidGraph();
    const switchNode = graph.nodes.find((node) => node.kind === 'switch')!;
    if (switchNode.kind !== 'switch') throw new Error('missing switch');
    switchNode.nat = { snatEnabled: false, dnatMappings: [] };
    const payload = buildTopologyDraftPayload({ graph, metadata: { ...validMetadata, cloudProvider: provider }, viewport: null });
    expect(payload.scenarioTemplateSpec.topology.entryHostKey).toBe('ecs-entry');
    expect(payload.compiledProvisionSpec.hosts[0]!.exposePublic).toBe(false);
    expect(payload.compiledProvisionSpec.networkZones[0]!.isPublicEntry).toBe(false);
    expect(payload.compiledProvisionSpec.natGateways).toEqual([]);
    expect(payload.compiledProvisionSpec.eips).toEqual([]);
    expect(payload.compiledProvisionSpec.dnatEntries).toEqual([]);
    expect(payload.compiledSpec.resources.filter((resource) => ['nat_gateway','eip','dnat_entry','snat_entry'].includes(resource.type))).toEqual([]);
    expect(payload.compiledSpec.resources.find((resource) => resource.type === 'host')!.config.exposePublic).toBe(false);
  });

  it.each(['alibaba_cloud', 'tencent_cloud'] as const)('supports multiple %s DNAT targets with the mapped secondary NIC', (provider) => {
    const graph = createValidGraph();
    const switchNode = graph.nodes.find((node) => node.kind === 'switch')!;
    const original = graph.nodes.find((node) => node.kind === 'ecs')!;
    if (switchNode.kind !== 'switch' || original.kind !== 'ecs') throw new Error('missing topology');
    const other = { ...structuredClone(original), id: 'ecs-other', label: 'Other', privateIp: '10.77.20.10', zoneKey: 'private',
      nics: [{ id: 'other-primary', switchId: 'switch-private', privateIp: '10.77.20.10', secondaryIps: [], securityGroupRules: [] },
             { id: 'other-secondary', switchId: 'switch-dmz', privateIp: '10.77.10.20', secondaryIps: [], securityGroupRules: [] }] };
    graph.nodes.push(other, { ...structuredClone(switchNode), id: 'switch-private', label: 'Private', zoneKey: 'private', cidr: '10.77.20.0/24', nat: { snatEnabled: false, dnatMappings: [] } });
    graph.edges.push({ id: 'router-private', fromNodeId: 'router-main', toNodeId: 'switch-private', relationType: 'manual' },
      { id: 'private-other', fromNodeId: 'switch-private', toNodeId: 'ecs-other', relationType: 'manual' },
      { id: 'dmz-other', fromNodeId: 'switch-dmz', toNodeId: 'ecs-other', relationType: 'manual' });
    switchNode.nat!.snatEnabled = provider === 'tencent_cloud';
    switchNode.nat!.dnatMappings.push({ key: 'dnat-other', targetHostId: 'ecs-other', externalPort: 80, internalPort: 80, protocol: 'tcp' });
    const payload = buildTopologyDraftPayload({ graph, metadata: { ...validMetadata, cloudProvider: provider }, viewport: null });
    expect(payload.compiledProvisionSpec.hosts.map((host) => host.exposePublic)).toEqual([true, true]);
    expect(payload.compiledProvisionSpec.dnatEntries).toContainEqual(expect.objectContaining({ hostKey: 'ecs-other', backendPrivateIp: '10.77.10.20', backendZoneKey: 'dmz', externalPort: 80 }));
    expect(payload.compiledSpec.resources.find((resource) => resource.type === 'dnat_entry' && resource.config.backendHostKey === 'ecs-other')!.config).toMatchObject({ backendPrivateIp: '10.77.10.20', backendZoneKey: 'dmz' });
    expect(payload.compiledProvisionSpec.eips.filter((eip) => eip.key === 'eip-dnat-shared')).toHaveLength(1);
    expect(payload.compiledProvisionSpec.eips.filter((eip) => eip.key === 'eip-snat-shared')).toHaveLength(provider === 'tencent_cloud' ? 1 : 0);
  });

  it('rejects Windows host passwords starting with a forward slash without affecting Linux hosts', () => {
    const windowsGraph = createValidGraph();
    const windowsHost = windowsGraph.nodes.find((node) => node.kind === 'ecs')!;
    windowsHost.imageName = 'Windows Server 2022';
    windowsHost.customPassword = '/Abcd1234';

    expect(() => buildTopologyDraftPayload({ graph: windowsGraph, metadata: validMetadata, viewport: null }))
      .toThrow('Windows instance passwords must not start with a forward slash');

    const linuxGraph = createValidGraph();
    const linuxHost = linuxGraph.nodes.find((node) => node.kind === 'ecs')!;
    linuxHost.imageName = 'Ubuntu 24.04 LTS';
    linuxHost.customPassword = '/Abcd1234';

    expect(() => buildTopologyDraftPayload({ graph: linuxGraph, metadata: validMetadata, viewport: null })).not.toThrow();
  });

  it('prefers resolved image OS metadata over the image name for Windows password checks', () => {
    const linuxNamedGraph = createValidGraph();
    const linuxNamedHost = linuxNamedGraph.nodes.find((node) => node.kind === 'ecs')!;
    linuxNamedHost.imageName = 'Windows-compatible Ubuntu';
    linuxNamedHost.customPassword = '/Abcd1234';

    expect(() => buildTopologyDraftPayload({
      graph: linuxNamedGraph,
      metadata: validMetadata,
      viewport: null,
      imageOsHints: { 'platform-image-ubuntu': { osType: 'linux', platform: 'Ubuntu' } },
    })).not.toThrow();

    const renamedWindowsGraph = createValidGraph();
    const renamedWindowsHost = renamedWindowsGraph.nodes.find((node) => node.kind === 'ecs')!;
    renamedWindowsHost.imageName = 'Server 2022';
    renamedWindowsHost.customPassword = '/Abcd1234';

    expect(() => buildTopologyDraftPayload({
      graph: renamedWindowsGraph,
      metadata: validMetadata,
      viewport: null,
      imageOsHints: { 'platform-image-ubuntu': { osType: 'windows', platform: 'Windows Server 2022' } },
    })).toThrow('Windows instance passwords must not start with a forward slash');
  });

  it('rejects duplicate DNAT protocol and external port pairs', () => {
    const graph = createValidGraph();
    const switchNode = graph.nodes.find((node) => node.id === 'switch-dmz')!;

    if (switchNode.kind !== 'switch') {
      throw new Error('测试图缺少 DMZ 交换机');
    }

    switchNode.nat!.dnatMappings.push({
      key: 'dnat-ssh-duplicate',
      targetHostId: 'ecs-entry',
      externalPort: 22,
      internalPort: 2222,
      protocol: 'tcp',
    });

    expect(() =>
      buildTopologyDraftPayload({
        graph,
        metadata: validMetadata,
        viewport: null,
      }),
    ).toThrowError('DNAT 公网协议和端口重复：tcp:22（dnat-ssh、dnat-ssh-duplicate）');
  });

  it('rejects a DNAT target that is not connected to the mapping switch', () => {
    const graph = createValidGraph();
    const switchNode = graph.nodes.find((node) => node.id === 'switch-dmz')!;
    const ecsNode = graph.nodes.find((node) => node.id === 'ecs-entry')!;

    if (switchNode.kind !== 'switch' || ecsNode.kind !== 'ecs') {
      throw new Error('测试图缺少 DMZ 交换机或入口 ECS');
    }

    graph.nodes.push({
      id: 'switch-app',
      kind: 'switch',
      label: '应用交换机',
      zoneKey: 'app',
      cidr: '10.77.20.0/24',
      purpose: 'application',
      aclRules: [],
      nat: {
        snatEnabled: false,
        dnatMappings: [],
      },
    });
    graph.edges = [
      {
        id: 'edge-router-dmz',
        fromNodeId: 'router-main',
        toNodeId: 'switch-dmz',
        relationType: 'manual',
      },
      {
        id: 'edge-router-app',
        fromNodeId: 'router-main',
        toNodeId: 'switch-app',
        relationType: 'manual',
      },
      {
        id: 'edge-app-entry',
        fromNodeId: 'switch-app',
        toNodeId: 'ecs-entry',
        relationType: 'manual',
      },
    ];
    ecsNode.zoneKey = 'app';
    ecsNode.privateIp = '10.77.20.10';
    ecsNode.networkInterfaces = [{ zoneKey: 'app', privateIp: '10.77.20.10' }];
    ecsNode.nics = [
      {
        id: 'ecs-entry-nic-1',
        switchId: 'switch-app',
        privateIp: '10.77.20.10',
        secondaryIps: [],
        securityGroupRules: [],
      },
    ];

    expect(() =>
      buildTopologyDraftPayload({
        graph,
        metadata: validMetadata,
        viewport: null,
      }),
    ).toThrowError('DNAT 目标 ECS 未连接到交换机：dnat-ssh');
  });
});
