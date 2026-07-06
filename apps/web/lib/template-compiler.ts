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

  const natInfrastructureResources = natEnabledSwitches.flatMap((node) => [
    {
      id: `nat-${node.id}`,
      type: 'nat_gateway' as const,
      provider: 'alibaba_cloud' as const,
      config: {
        label: `${node.label} NAT`,
        zoneKey: node.zoneKey,
        snatEnabled: Boolean(node.nat?.snatEnabled),
      },
    },
    {
      id: `eip-${node.id}`,
      type: 'eip' as const,
      provider: 'alibaba_cloud' as const,
      config: {
        label: `${node.label} EIP`,
        bindTargetType: 'nat_gateway' as const,
        bindTargetKey: `nat-${node.id}`,
        bandwidthMbps: 30,
      },
    },
  ]);

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
          natGatewayKey: `nat-${node.id}`,
          sourceZoneKey: node.zoneKey,
          eipKey: `eip-${node.id}`,
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
        natGatewayKey: `nat-${node.id}`,
        eipKey: `eip-${node.id}`,
        backendHostKey: mapping.targetHostId,
        externalPort: mapping.externalPort,
        internalPort: mapping.internalPort,
        protocol: mapping.protocol,
      },
    }));
  });

  return [...natInfrastructureResources, ...snatResources, ...dnatResources];
}
