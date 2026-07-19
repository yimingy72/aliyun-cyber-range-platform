import type { RangeTemplateCompiledSpec, RangeTemplateTopologySpec } from './admin-types';
import type { EcsTemplateNode, SwitchTemplateNode, TemplateNode } from './scenario-graph';

type CompileTopologyGraphInput = {
  topologySpec?: RangeTemplateTopologySpec | null;
  nodes: TemplateNode[];
};

type GraphNode = Extract<TemplateNode, { kind: 'router' | 'switch' | 'ecs' }>;

function assertNever(value: never, message: string): never {
  throw new Error(message);
}

export function compileTopologyGraph(input: CompileTopologyGraphInput): RangeTemplateCompiledSpec {
  const graphNodes: GraphNode[] = input.nodes.map((node) => {
    const kind = (node as { kind?: unknown }).kind;

    if (kind !== 'router' && kind !== 'switch' && kind !== 'ecs') {
      throw new Error(`Unsupported template node kind: ${String(kind)}`);
    }

    return node as GraphNode;
  });

  return {
    schemaVersion: '1.0.0',
    resources: [
      ...graphNodes.map((node) => ({
        id: node.id,
        type: node.kind === 'ecs' ? 'host' : node.kind,
        provider: 'alibaba_cloud' as const,
        config: compileNodeConfig(node, graphNodes),
      })),
      ...buildDerivedNatResources(graphNodes),
    ],
    ...(input.topologySpec
      ? {
          topology: {
            vpcCidr: input.topologySpec.vpcCidr,
            publicEntryHostKey: input.topologySpec.publicEntry.hostKey,
            networkZoneKeys: input.topologySpec.networkZones.map((zone) => zone.key),
            hostKeys: input.topologySpec.hosts.map((host) => host.key),
          },
        }
      : {}),
  };
}

function resolveHostPlacement(node: EcsTemplateNode, graphNodes: GraphNode[]) {
  const switchById = new Map(
    graphNodes
      .filter((graphNode): graphNode is SwitchTemplateNode => graphNode.kind === 'switch')
      .map((switchNode) => [switchNode.id, switchNode]),
  );
  const primaryNic = node.nics?.[0];
  const resolvedSwitch = primaryNic?.switchId ? switchById.get(primaryNic.switchId) ?? null : null;

  return {
    zoneKey: resolvedSwitch?.zoneKey ?? primaryNic?.zoneKey ?? node.zoneKey,
    privateIp: primaryNic?.privateIp?.trim() ? primaryNic.privateIp : node.privateIp,
  };
}

function compileNodeConfig(node: GraphNode, graphNodes: GraphNode[]): Record<string, unknown> {
  switch (node.kind) {
    case 'ecs': {
      const placement = resolveHostPlacement(node, graphNodes);

      return {
        label: node.label,
        zoneKey: placement.zoneKey,
        role: node.role,
        privateIp: placement.privateIp,
        exposePublic: node.exposePublic,
        image: node.image,
        instanceName: node.instanceName,
        hostName: node.hostName,
        imageName: node.imageName,
        imageId: node.imageId,
        cpu: node.cpu,
        memory: node.memory,
        instanceType: node.instanceType,
        description: node.description,
        bootPriority: node.bootPriority,
        bootWaitSeconds: node.bootWaitSeconds,
        dnatMappings: node.dnatMappings,
        networkInterfaces: node.networkInterfaces,
        portGroups: node.portGroups,
        nics: node.nics,
        initScript: node.initScript,
        imageStrategy: node.imageStrategy,
        instanceTypeStrategy: node.instanceTypeStrategy,
      };
    }
    case 'switch':
      return {
        label: node.label,
        zoneKey: node.zoneKey,
        cidr: node.cidr,
        purpose: node.purpose,
        description: node.description,
        aclRules: node.aclRules,
        nat: node.nat,
      };
    case 'router':
      return {
        label: node.label,
        description: node.description,
      };
    default:
      return assertNever(node, `Unsupported template node kind: ${String((node as { kind?: unknown }).kind)}`);
  }
}

function buildDerivedNatResources(nodes: GraphNode[]) {
  const natEnabledSwitches = nodes.filter((node): node is SwitchTemplateNode => {
    if (node.kind !== 'switch') {
      return false;
    }

    return Boolean(node.nat?.snatEnabled) || (node.nat?.dnatMappings?.length ?? 0) > 0;
  });

  const snatEnabled = natEnabledSwitches.some((node) => Boolean(node.nat?.snatEnabled));
  const dnatEnabled = natEnabledSwitches.some((node) => (node.nat?.dnatMappings?.length ?? 0) > 0);
  const sharedNatSwitch = natEnabledSwitches[0];
  const sharedNatGatewayKey = 'nat-shared';
  const sharedSnatEipKey = 'eip-snat-shared';
  const sharedDnatEipKey = 'eip-dnat-shared';

  const natInfrastructureResources = sharedNatSwitch
    ? [
        {
      id: sharedNatGatewayKey,
      type: 'nat_gateway' as const,
      provider: 'alibaba_cloud' as const,
      config: {
        label: '共享 NAT',
        zoneKey: sharedNatSwitch.zoneKey,
        snatEnabled,
      },
        },
        ...(snatEnabled
          ? [
              {
                id: sharedSnatEipKey,
                type: 'eip' as const,
                provider: 'alibaba_cloud' as const,
                config: {
                  label: '共享 SNAT EIP',
                  bindTargetType: 'nat_gateway' as const,
                  bindTargetKey: sharedNatGatewayKey,
                  bandwidthMbps: 30,
                },
              },
            ]
          : []),
        ...(dnatEnabled
          ? [
              {
                id: sharedDnatEipKey,
                type: 'eip' as const,
                provider: 'alibaba_cloud' as const,
                config: {
                  label: '共享 DNAT EIP',
                  bindTargetType: 'nat_gateway' as const,
                  bindTargetKey: sharedNatGatewayKey,
                  bandwidthMbps: 30,
                },
              },
            ]
          : []),
      ]
    : [];

  const snatResources = nodes.flatMap((node) => {
    if (node.kind !== 'switch' || !node.nat?.snatEnabled) {
      return [];
    }

    return [
      {
        id: `${node.id}-snat-1`,
        type: 'snat_entry' as const,
        provider: 'alibaba_cloud' as const,
        config: {
          label: `${node.label} SNAT`,
          natGatewayKey: sharedNatGatewayKey,
          sourceZoneKey: node.zoneKey,
          eipKey: sharedSnatEipKey,
        },
      },
    ];
  });

  const dnatResources = nodes.flatMap((node) => {
    if (node.kind !== 'switch') {
      return [];
    }

    return (node.nat?.dnatMappings ?? []).map((mapping, index) => ({
      id: `${mapping.targetHostId}-dnat-${index + 1}`,
      type: 'dnat_entry' as const,
      provider: 'alibaba_cloud' as const,
      config: {
        label: mapping.key,
        natGatewayKey: sharedNatGatewayKey,
        eipKey: sharedDnatEipKey,
        backendHostKey: mapping.targetHostId,
        externalPort: mapping.externalPort,
        internalPort: mapping.internalPort,
        protocol: mapping.protocol,
      },
    }));
  });

  return [...natInfrastructureResources, ...snatResources, ...dnatResources];
}
