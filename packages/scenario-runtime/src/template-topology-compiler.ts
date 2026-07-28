import {
  buildScenarioTemplateSpecFromTopologyGraph,
} from './topology-graph-to-scenario-template';
import { compileScenarioTemplateSpec } from './scenario-template-compiler';
import {
  isAlibabaCloudPortRange,
  normalizeAlibabaCloudPortRange,
} from './alibaba-cloud-port-range';
import type {
  EcsTemplateNode,
  ScenarioGraphDraft,
  ScenarioGraphEdge,
  SwitchTemplateNode,
  TemplateNode,
} from './scenario-graph';
import type { ScenarioTemplateMetadata } from './scenario-template-spec';
import { validateAliyunEcsPassword } from './password-policy';

export type TemplateAuthoringMetadata = ScenarioTemplateMetadata & {
  modulePathOrRef: string;
  primaryVpcCidr?: string;
  secondaryVpcCidrs?: string[];
  /** @deprecated Use primaryVpcCidr. */
  vpcCidr?: string;
  defaultRegion?: string;
  defaultZoneId?: string;
  publicEntryProtocols?: Array<{ protocol: string; port: number }>;
};

export type TemplateGraphChangeset = Array<
  | { op: 'add-node'; node: TemplateNode }
  | { op: 'update-node'; nodeId: string; patch: Partial<TemplateNode> }
  | { op: 'remove-node'; nodeId: string }
  | { op: 'add-edge'; edge: ScenarioGraphEdge }
  | { op: 'remove-edge'; edgeId: string }
>;

export type CompiledTemplatePayload = {
  topologyGraph: ScenarioGraphDraft;
  topologySpec: Record<string, unknown>;
  scenarioTemplateSpec: Record<string, unknown>;
  compiledProvisionSpec: Record<string, unknown>;
  compiledSpec: Record<string, unknown>;
};

type CompiledTopologySpec = {
  vpcCidr: string;
  networkZones: Array<{ key: string }>;
  hosts: Array<{ key: string }>;
  publicEntry: { hostKey: string };
};

type GraphNode = Extract<TemplateNode, { kind: 'router' | 'switch' | 'ecs' }>;

const DEFAULT_PUBLIC_ENTRY_PROTOCOLS = [
  { protocol: 'ssh', port: 22 },
  { protocol: 'http', port: 80 },
];
export const DEFAULT_ALIBABA_CLOUD_PRIMARY_VPC_CIDR = '10.0.0.0/16';
export const DEFAULT_ALIBABA_CLOUD_SECONDARY_VPC_CIDRS = [
  '172.16.0.0/16',
  '192.168.0.0/16',
];

export function compileTemplateTopology(
  topologyGraph: ScenarioGraphDraft,
  metadata: TemplateAuthoringMetadata,
): CompiledTemplatePayload {
  const graph = normalizeTopologyGraph(topologyGraph);
  validateGraph(graph, metadata);
  const primaryVpcCidr =
    metadata.primaryVpcCidr ??
    metadata.vpcCidr ??
    DEFAULT_ALIBABA_CLOUD_PRIMARY_VPC_CIDR;
  const secondaryVpcCidrs =
    metadata.secondaryVpcCidrs ??
    DEFAULT_ALIBABA_CLOUD_SECONDARY_VPC_CIDRS;
  const scenarioTemplateSpec = buildScenarioTemplateSpecFromTopologyGraph({
    topologyGraph: graph,
    metadata: {
      name: metadata.name,
      slug: metadata.slug,
      version: metadata.version,
      cloudProvider: metadata.cloudProvider,
      iacType: metadata.iacType,
      description: metadata.description,
    },
    defaults: {
      vpcCidr: primaryVpcCidr,
      defaultRegion: metadata.defaultRegion,
      defaultZoneId: metadata.defaultZoneId,
    },
  });
  scenarioTemplateSpec.topology.secondaryVpcCidrs = secondaryVpcCidrs;
  const entryHost = scenarioTemplateSpec.hosts.find((host) => host.key === scenarioTemplateSpec.topology.entryHostKey);
  if (!entryHost) {
    throw new Error('拓扑缺少公网入口 ECS 节点');
  }

  const topologySpec = {
    vpcCidr: scenarioTemplateSpec.topology.vpcCidr,
    networkZones: scenarioTemplateSpec.networkZones.map((zone) => ({
      key: zone.key,
      name: zone.name,
      purpose: zone.purpose,
      cidr: zone.cidr,
      isPublicEntry: zone.isPublicEntry,
    })),
    hosts: scenarioTemplateSpec.hosts.map((host) => ({
      key: host.key,
      name: host.name,
      zoneKey: host.zoneKey,
      role: host.role,
      privateIp: host.primaryPrivateIp,
      exposePublic: host.exposePublic,
    })),
    publicEntry: {
      hostKey: entryHost.key,
      protocols: metadata.publicEntryProtocols ?? DEFAULT_PUBLIC_ENTRY_PROTOCOLS,
    },
    executionPolicies: {
      allowSshIngress: true,
      allowHttpIngress: true,
      enableSnatOnDemand: scenarioTemplateSpec.networkZones.some((zone) => zone.snat?.enabled),
    },
  };

  return {
    topologyGraph: graph,
    topologySpec,
    scenarioTemplateSpec,
    compiledProvisionSpec: compileScenarioTemplateSpec(scenarioTemplateSpec),
    compiledSpec: compileTopologyGraph(graph.nodes, topologySpec),
  };
}

function compileTopologyGraph(nodes: TemplateNode[], topologySpec: CompiledTopologySpec) {
  const graphNodes: GraphNode[] = nodes.map((node) => {
    if (node.kind !== 'router' && node.kind !== 'switch' && node.kind !== 'ecs') {
      throw new Error(`Unsupported template node kind: ${String((node as { kind?: unknown }).kind)}`);
    }

    return node;
  });

  return {
    schemaVersion: '1.0.0',
    resources: [
      ...graphNodes.map((node) => ({
        id: node.id,
        type: node.kind === 'ecs' ? 'host' : node.kind,
        provider: 'alibaba_cloud',
        config: compileNodeConfig(node, graphNodes),
      })),
      ...buildDerivedNatResources(graphNodes),
    ],
    topology: {
      vpcCidr: topologySpec.vpcCidr,
      publicEntryHostKey: topologySpec.publicEntry.hostKey,
      networkZoneKeys: topologySpec.networkZones.map((zone) => zone.key),
      hostKeys: topologySpec.hosts.map((host) => host.key),
    },
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
        platformImageAssetId: node.platformImageAssetId,
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
  }
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

function buildDerivedNatResources(nodes: GraphNode[]) {
  const natEnabledSwitches = nodes.filter(
    (node): node is SwitchTemplateNode =>
      node.kind === 'switch' && (Boolean(node.nat?.snatEnabled) || (node.nat?.dnatMappings?.length ?? 0) > 0),
  );
  const snatEnabled = natEnabledSwitches.some((node) => Boolean(node.nat?.snatEnabled));
  const dnatEnabled = natEnabledSwitches.some((node) => (node.nat?.dnatMappings?.length ?? 0) > 0);
  const sharedNatSwitch = natEnabledSwitches[0];
  const natGatewayKey = 'nat-shared';
  const snatEipKey = 'eip-snat-shared';
  const dnatEipKey = 'eip-dnat-shared';

  const infrastructure = !sharedNatSwitch
    ? []
    : [
        {
          id: natGatewayKey,
          type: 'nat_gateway',
          provider: 'alibaba_cloud',
          config: { label: '共享 NAT', zoneKey: sharedNatSwitch.zoneKey, snatEnabled },
        },
        ...(snatEnabled
          ? [{
              id: snatEipKey,
              type: 'eip',
              provider: 'alibaba_cloud',
              config: { label: '共享 SNAT EIP', bindTargetType: 'nat_gateway', bindTargetKey: natGatewayKey, bandwidthMbps: 30 },
            }]
          : []),
        ...(dnatEnabled
          ? [{
              id: dnatEipKey,
              type: 'eip',
              provider: 'alibaba_cloud',
              config: { label: '共享 DNAT EIP', bindTargetType: 'nat_gateway', bindTargetKey: natGatewayKey, bandwidthMbps: 30 },
            }]
          : []),
      ];

  return [
    ...infrastructure,
    ...nodes.flatMap((node) =>
      node.kind === 'switch' && node.nat?.snatEnabled
        ? [{
            id: `${node.id}-snat-1`,
            type: 'snat_entry',
            provider: 'alibaba_cloud',
            config: { label: `${node.label} SNAT`, natGatewayKey, sourceZoneKey: node.zoneKey, eipKey: snatEipKey },
          }]
        : [],
    ),
    ...nodes.flatMap((node) =>
      node.kind === 'switch'
        ? (node.nat?.dnatMappings ?? []).map((mapping, index) => ({
            id: `${mapping.targetHostId}-dnat-${index + 1}`,
            type: 'dnat_entry',
            provider: 'alibaba_cloud',
            config: {
              label: mapping.key,
              natGatewayKey,
              eipKey: dnatEipKey,
              backendHostKey: mapping.targetHostId,
              externalPort: mapping.externalPort,
              internalPort: mapping.internalPort,
              protocol: mapping.protocol,
            },
          }))
        : [],
    ),
  ];
}

export function applyTemplateChangeset(topologyGraph: ScenarioGraphDraft, changes: TemplateGraphChangeset): ScenarioGraphDraft {
  const graph = cloneGraph(topologyGraph);

  for (const change of changes) {
    switch (change.op) {
      case 'add-node':
        if (graph.nodes.some((node) => node.id === change.node.id)) {
          throw new Error(`节点 ID 已存在：${change.node.id}`);
        }
        graph.nodes.push(structuredClone(change.node));
        break;
      case 'update-node': {
        const index = graph.nodes.findIndex((node) => node.id === change.nodeId);
        if (index < 0) {
          throw new Error(`节点不存在：${change.nodeId}`);
        }
        if (change.patch.id && change.patch.id !== change.nodeId) {
          throw new Error('不支持通过 update-node 修改节点 ID');
        }
        if (change.patch.kind && change.patch.kind !== graph.nodes[index].kind) {
          throw new Error('不支持通过 update-node 修改节点类型');
        }
        graph.nodes[index] = { ...graph.nodes[index], ...structuredClone(change.patch), id: change.nodeId } as TemplateNode;
        break;
      }
      case 'remove-node':
        {
          const deletedNode = graph.nodes.find((node) => node.id === change.nodeId);
          if (!deletedNode) {
            throw new Error(`节点不存在：${change.nodeId}`);
          }
          graph.nodes = cleanupNodeReferencesAfterDeletion(graph.nodes, deletedNode);
          graph.edges = graph.edges.filter((edge) => edge.fromNodeId !== change.nodeId && edge.toNodeId !== change.nodeId);
          break;
        }
      case 'add-edge':
        if (graph.edges.some((edge) => edge.id === change.edge.id)) {
          throw new Error(`连线 ID 已存在：${change.edge.id}`);
        }
        graph.edges.push(structuredClone(change.edge));
        break;
      case 'remove-edge': {
        const deletedEdge = graph.edges.find((edge) => edge.id === change.edgeId);
        if (!deletedEdge) {
          throw new Error(`连线不存在：${change.edgeId}`);
        }
        graph.edges = graph.edges.filter((edge) => edge.id !== change.edgeId);
        graph.nodes = cleanupEdgeReferencesAfterDeletion(graph.nodes, deletedEdge);
        break;
      }
    }
  }

  return graph;
}

export function metadataFromTemplate(template: Record<string, unknown>): TemplateAuthoringMetadata {
  const required = ['name', 'slug', 'version', 'modulePathOrRef'] as const;
  for (const key of required) {
    if (typeof template[key] !== 'string' || !template[key].trim()) {
      throw new Error(`模板缺少可编辑元数据：${key}`);
    }
  }

  const topologySpec = readRecord(template.topologySpec);
  const publicEntry = readRecord(topologySpec?.publicEntry);
  const scenarioTemplateSpec = readRecord(template.scenarioTemplateSpec);
  const scenarioTopology = readRecord(scenarioTemplateSpec?.topology);
  const publicEntryProtocols = readPublicEntryProtocols(publicEntry?.protocols);

  return {
    name: String(template.name),
    slug: String(template.slug),
    version: String(template.version),
    modulePathOrRef: String(template.modulePathOrRef),
    cloudProvider: template.cloudProvider === 'alibaba_cloud' ? 'alibaba_cloud' : 'alibaba_cloud',
    iacType: template.iacType === 'terraform' ? 'terraform' : 'opentofu',
    ...(typeof template.description === 'string' ? { description: template.description } : {}),
    ...(typeof topologySpec?.vpcCidr === 'string' ? { primaryVpcCidr: topologySpec.vpcCidr } : {}),
    ...(Array.isArray(scenarioTopology?.secondaryVpcCidrs)
      ? {
          secondaryVpcCidrs: scenarioTopology.secondaryVpcCidrs.filter(
            (cidr): cidr is string => typeof cidr === 'string',
          ),
        }
      : {}),
    ...(typeof scenarioTopology?.defaultRegion === 'string' ? { defaultRegion: scenarioTopology.defaultRegion } : {}),
    ...(typeof scenarioTopology?.defaultZoneId === 'string' ? { defaultZoneId: scenarioTopology.defaultZoneId } : {}),
    ...(publicEntryProtocols ? { publicEntryProtocols } : {}),
  };
}

export function graphFromTemplate(template: Record<string, unknown>): ScenarioGraphDraft {
  const rawGraph = template.topologyGraph;
  if (!rawGraph || typeof rawGraph !== 'object' || !Array.isArray((rawGraph as { nodes?: unknown }).nodes) || !Array.isArray((rawGraph as { edges?: unknown }).edges)) {
    throw new Error('模板没有可编辑的 topologyGraph 草稿');
  }

  return cloneGraph(rawGraph as ScenarioGraphDraft);
}

function validateGraph(graph: ScenarioGraphDraft, metadata: TemplateAuthoringMetadata) {
  if (!metadata.modulePathOrRef.trim()) {
    throw new Error('modulePathOrRef 不能为空');
  }
  if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    throw new Error('topologyGraph 必须包含 nodes 和 edges 数组');
  }
  const primaryVpcCidr =
    metadata.primaryVpcCidr ??
    metadata.vpcCidr ??
    DEFAULT_ALIBABA_CLOUD_PRIMARY_VPC_CIDR;
  const secondaryVpcCidrs =
    metadata.secondaryVpcCidrs ??
    DEFAULT_ALIBABA_CLOUD_SECONDARY_VPC_CIDRS;

  if (!Array.isArray(secondaryVpcCidrs)) {
    throw new Error('secondaryVpcCidrs 必须是 IPv4 CIDR 数组');
  }

  const parsedVpcCidrs = [primaryVpcCidr, ...secondaryVpcCidrs].map((cidr) => {
    if (!isCidr(cidr)) {
      throw new Error('primaryVpcCidr 和 secondaryVpcCidrs 必须是 IPv4 CIDR');
    }

    return { cidr, parsed: parseCidr(cidr)! };
  });

  for (let index = 0; index < parsedVpcCidrs.length; index += 1) {
    for (let comparisonIndex = index + 1; comparisonIndex < parsedVpcCidrs.length; comparisonIndex += 1) {
      if (cidrsOverlap(parsedVpcCidrs[index]!.cidr, parsedVpcCidrs[comparisonIndex]!.cidr)) {
        throw new Error(`VPC CIDR 不能重叠：${parsedVpcCidrs[index]!.cidr} 与 ${parsedVpcCidrs[comparisonIndex]!.cidr}`);
      }
    }
  }
  const nodeIds = new Set<string>();
  const routers = graph.nodes.filter((node): node is RouterNode => node.kind === 'router');
  const switches = graph.nodes.filter((node): node is SwitchNode => node.kind === 'switch');
  const hosts = graph.nodes.filter((node): node is EcsNode => node.kind === 'ecs');
  if (routers.length !== 1) {
    throw new Error('拓扑必须且只能包含一个 Router 节点');
  }
  const router = routers[0]!;
  if (switches.length === 0 || hosts.length === 0) {
    throw new Error('拓扑至少需要一个交换机和一个 ECS 节点');
  }

  const switchById = new Map(switches.map((node) => [node.id, node]));
  const hostById = new Map(hosts.map((node) => [node.id, node]));
  const switchZoneKeys = new Set<string>();
  const nicIds = new Set<string>();
  const ipUsage = new Map<string, string>();

  for (const node of graph.nodes) {
    const nodeKind = (node as { kind?: unknown }).kind;
    if (nodeKind !== 'router' && nodeKind !== 'switch' && nodeKind !== 'ecs') {
      throw new Error(`不支持的节点类型：${String(nodeKind)}`);
    }
    if (!node.id || nodeIds.has(node.id)) {
      throw new Error(`节点 ID 无效或重复：${node.id || '(empty)'}`);
    }
    nodeIds.add(node.id);
    if (!node.label?.trim()) {
      throw new Error(`节点缺少 label：${node.id}`);
    }
    if (node.kind === 'switch') {
      if (!node.zoneKey?.trim()) {
        throw new Error(`交换机缺少 zoneKey：${node.id}`);
      }
      if (switchZoneKeys.has(node.zoneKey)) {
        throw new Error(`交换机 zoneKey 重复：${node.zoneKey}`);
      }
      switchZoneKeys.add(node.zoneKey);
      if (!isCidr(node.cidr)) {
        throw new Error(`交换机 CIDR 无效：${node.id}`);
      }
      if (!parsedVpcCidrs.some(({ parsed }) => isCidrWithin(node.cidr, parsed))) {
        throw new Error(`交换机 CIDR 不在主 VPC 或附加 VPC 网段内：${node.id}`);
      }
      for (const rule of node.aclRules ?? []) {
        if (!isAlibabaCloudPortRange(rule.portRange, rule.protocol)) {
          throw new Error(`ACL 端口范围无效：${node.id}/${rule.key}`);
        }
      }
    }
    if (node.kind === 'ecs') {
      if (!isIpv4(node.privateIp)) {
        throw new Error(`ECS 私网 IP 无效：${node.id}`);
      }
      if (!node.image?.trim()) {
        throw new Error(`ECS 缺少镜像：${node.id}`);
      }
      if (typeof node.customPassword === 'string' && node.customPassword.length > 0) {
        const passwordValidation = validateAliyunEcsPassword(node.customPassword);
        if (!passwordValidation.valid) {
          throw new Error(`ECS 自定义密码不合法：${node.id}${passwordValidation.message ? `（${passwordValidation.message}）` : ''}`);
        }
      }
      const nics = node.nics ?? [];
      if (nics.length === 0) {
        throw new Error(`ECS 必须至少配置一个 NIC：${node.id}`);
      }
      if (node.privateIp !== nics[0]!.privateIp) {
        throw new Error(`ECS 主私网 IP 必须与第一张 NIC 一致：${node.id}`);
      }
      for (const [nicIndex, nic] of nics.entries()) {
        if (!nic.id?.trim() || nicIds.has(nic.id)) {
          throw new Error(`NIC ID 无效或重复：${nic.id || '(empty)'}`);
        }
        nicIds.add(nic.id);
        const linkedSwitch = switchById.get(nic.switchId);
        if (!linkedSwitch) {
          throw new Error(`NIC 引用了不存在的交换机：${nic.switchId}`);
        }
        if (!isIpv4(nic.privateIp)) {
          throw new Error(`NIC 私网 IP 无效：${nic.id}`);
        }
        for (const rule of nic.securityGroupRules ?? []) {
          if (!isAlibabaCloudPortRange(rule.portRange, rule.protocol)) {
            throw new Error(`安全组端口范围无效：${node.id}/${rule.key}`);
          }
        }
        if (!isIpv4InCidr(nic.privateIp, linkedSwitch.cidr)) {
          throw new Error(`ECS ${node.id} 的 NIC 私网 IP 不在 ${linkedSwitch.cidr} 网段内`);
        }
        if (!isUsableHostIp(nic.privateIp, linkedSwitch.cidr)) {
          throw new Error(`ECS ${node.id} 的 NIC 私网 IP 不能使用网段地址或广播地址`);
        }
        if (nicIndex === 0 && node.zoneKey !== linkedSwitch.zoneKey) {
          throw new Error(`ECS 主 NIC 所在交换机与 ECS zoneKey 不一致：${node.id}`);
        }
        registerIpUsage(ipUsage, linkedSwitch.id, nic.privateIp, `ECS ${node.id} 的 NIC`);
        for (const secondaryIp of nic.secondaryIps ?? []) {
          if (!isIpv4(secondaryIp) || !isIpv4InCidr(secondaryIp, linkedSwitch.cidr)) {
            throw new Error(`ECS ${node.id} 的辅助 IP 不在 ${linkedSwitch.cidr} 网段内`);
          }
          if (!isUsableHostIp(secondaryIp, linkedSwitch.cidr)) {
            throw new Error(`ECS ${node.id} 的辅助 IP 不能使用网段地址或广播地址`);
          }
          registerIpUsage(ipUsage, linkedSwitch.id, secondaryIp, `ECS ${node.id} 的辅助 IP`);
        }
      }
      for (const portGroup of node.portGroups ?? []) {
        if (!isAlibabaCloudPortRange(portGroup.portRange, portGroup.protocol)) {
          throw new Error(`端口组端口范围无效：${node.id}/${portGroup.name}`);
        }
      }
    }
  }

  for (let index = 0; index < switches.length; index += 1) {
    for (let comparisonIndex = index + 1; comparisonIndex < switches.length; comparisonIndex += 1) {
      if (cidrsOverlap(switches[index]!.cidr, switches[comparisonIndex]!.cidr)) {
        throw new Error(`交换机 CIDR 不能重叠：${switches[index]!.id} 与 ${switches[comparisonIndex]!.id}`);
      }
    }
  }

  const entryHosts = hosts.filter((host) => host.exposePublic || host.role === 'entry');
  if (entryHosts.length === 0) {
    throw new Error('必须指定一个公网入口 ECS');
  }
  if (entryHosts.length > 1) {
    throw new Error('只能指定一个公网入口 ECS');
  }
  const entryHost = entryHosts[0]!;
  if (!entryHost.exposePublic) {
    throw new Error(`公网入口 ECS 必须设置 exposePublic=true：${entryHost.id}`);
  }

  const dnatExternalPorts = new Map<string, string>();
  let entryDnatCount = 0;
  for (const switchNode of switches) {
    for (const mapping of switchNode.nat?.dnatMappings ?? []) {
      const targetHost = hostById.get(mapping.targetHostId);
      if (!targetHost) {
        throw new Error(`DNAT 引用了不存在的 ECS：${mapping.targetHostId}`);
      }
      if (!isPort(mapping.externalPort) || !isPort(mapping.internalPort)) {
        throw new Error(`DNAT 端口无效：${mapping.key}`);
      }
      if (mapping.protocol !== 'tcp' && mapping.protocol !== 'udp') {
        throw new Error(`DNAT 协议无效：${mapping.key}`);
      }
      const externalPortKey = `${mapping.protocol}:${mapping.externalPort}`;
      const existingMappingKey = dnatExternalPorts.get(externalPortKey);
      if (existingMappingKey) {
        throw new Error(`DNAT 公网协议和端口重复：${externalPortKey}（${existingMappingKey}、${mapping.key}）`);
      }
      dnatExternalPorts.set(externalPortKey, mapping.key);
      if (!(targetHost.nics ?? []).some((nic) => nic.switchId === switchNode.id)) {
        throw new Error(`DNAT 目标 ECS 未连接到交换机：${mapping.key}`);
      }
      if (!targetHost.exposePublic) {
        throw new Error(`DNAT 目标必须是公网入口 ECS：${mapping.key}`);
      }
      if (targetHost.id !== entryHost.id) {
        throw new Error(`DNAT 目标必须是唯一公网入口 ECS：${mapping.key}`);
      }
      entryDnatCount += 1;
    }
  }
  if (entryDnatCount === 0) {
    throw new Error(`公网入口 ECS 必须至少配置一条 DNAT：${entryHost.id}`);
  }

  const edgeIds = new Set<string>();
  const pairs = new Set<string>();
  for (const edge of graph.edges) {
    const source = graph.nodes.find((node) => node.id === edge.fromNodeId);
    const target = graph.nodes.find((node) => node.id === edge.toNodeId);
    if (!source || !target) {
      throw new Error(`连线引用了不存在的节点：${edge.id}`);
    }
    const allowed = (source.kind === 'router' && target.kind === 'switch') || (source.kind === 'switch' && target.kind === 'ecs');
    if (!edge.id?.trim() || edgeIds.has(edge.id)) {
      throw new Error(`连线 ID 无效或重复：${edge.id || '(empty)'}`);
    }
    edgeIds.add(edge.id);
    if (edge.relationType !== 'manual' || !allowed) {
      throw new Error(`连线类型不合法：${edge.id}`);
    }
    const pair = `${edge.fromNodeId}:${edge.toNodeId}`;
    if (pairs.has(pair)) {
      throw new Error(`存在重复连线：${pair}`);
    }
    pairs.add(pair);
    if (source.kind === 'switch' && target.kind === 'ecs' && !(target.nics ?? []).some((nic) => nic.switchId === source.id)) {
      throw new Error(`交换机到 ECS 连线未由目标 ECS 的 NIC 绑定支撑：${edge.id}`);
    }
  }
  for (const host of hosts) {
    for (const nic of host.nics ?? []) {
      if (!pairs.has(`${nic.switchId}:${host.id}`)) {
        throw new Error(`ECS NIC 缺少对应的交换机连线：${host.id}/${nic.id}`);
      }
    }
  }
  for (const switchNode of switches) {
    if (!pairs.has(`${router.id}:${switchNode.id}`)) {
      throw new Error(`交换机缺少 Router 连线：${switchNode.id}`);
    }
  }
  const protocols = metadata.publicEntryProtocols ?? DEFAULT_PUBLIC_ENTRY_PROTOCOLS;
  if (protocols.length === 0) {
    throw new Error('publicEntryProtocols 至少需要一个入口协议');
  }
  for (const protocol of protocols) {
    if (typeof protocol.protocol !== 'string' || !protocol.protocol.trim() || !isPort(protocol.port)) {
      throw new Error('publicEntryProtocols 必须包含有效 protocol 和端口');
    }
  }
}

type SwitchNode = Extract<TemplateNode, { kind: 'switch' }>;
type EcsNode = Extract<TemplateNode, { kind: 'ecs' }>;
type RouterNode = Extract<TemplateNode, { kind: 'router' }>;

function normalizeTopologyGraph(topologyGraph: ScenarioGraphDraft): ScenarioGraphDraft {
  const graph = cloneGraph(topologyGraph);

  return {
    ...graph,
    nodes: graph.nodes.map((node) => {
      if (node.kind === 'router') {
        return {
          ...node,
          routeRole: node.routeRole ?? 'vpc',
          egressType: node.egressType ?? 'none',
          bindEip: node.bindEip ?? false,
        } as RouterNode;
      }
      if (node.kind === 'switch') {
        return {
          ...node,
          aclRules: (node.aclRules ?? []).map((rule) => ({
            ...rule,
            portRange: normalizeAlibabaCloudPortRange(rule.portRange, rule.protocol),
          })),
          nat: {
            snatEnabled: node.nat?.snatEnabled ?? false,
            dnatMappings: node.nat?.dnatMappings ?? [],
          },
        } as SwitchNode;
      }

      const imageStrategy = node.imageStrategy ?? { mode: 'fixed' as const, imageId: node.image };
      const primaryPrivateIp = node.nics?.[0]?.privateIp?.trim() || node.privateIp;
      return {
        ...node,
        privateIp: primaryPrivateIp,
        initScript: node.initScript ?? '',
        dnatMappings: node.dnatMappings ?? [],
        networkInterfaces: node.networkInterfaces ?? [],
        portGroups: (node.portGroups ?? []).map((portGroup) => ({
          ...portGroup,
          portRange: normalizeAlibabaCloudPortRange(portGroup.portRange, portGroup.protocol),
        })),
        imageStrategy:
          imageStrategy.mode === 'fixed' && !imageStrategy.imageId
            ? { ...imageStrategy, imageId: node.image }
            : imageStrategy,
        instanceTypeStrategy: node.instanceTypeStrategy ?? { mode: 'auto' as const },
        nics: (node.nics ?? []).map((nic) => ({
          ...nic,
          secondaryIps: nic.secondaryIps ?? [],
          securityGroupRules: (nic.securityGroupRules ?? []).map((rule) => ({
            ...rule,
            portRange: normalizeAlibabaCloudPortRange(rule.portRange, rule.protocol),
          })),
        })),
      } as EcsNode;
    }),
  };
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function readPublicEntryProtocols(value: unknown): Array<{ protocol: string; port: number }> | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.map((protocol) => {
    const record = readRecord(protocol);
    return {
      protocol: typeof record?.protocol === 'string' ? record.protocol : '',
      port: typeof record?.port === 'number' ? record.port : Number.NaN,
    };
  });
}

function cleanupNodeReferencesAfterDeletion(nodes: TemplateNode[], deletedNode: TemplateNode) {
  return nodes
    .filter((node) => node.id !== deletedNode.id)
    .map((node) => {
      if (deletedNode.kind === 'switch' && node.kind === 'ecs') {
        return { ...node, nics: (node.nics ?? []).filter((nic) => nic.switchId !== deletedNode.id) } as TemplateNode;
      }
      if (deletedNode.kind === 'ecs' && node.kind === 'switch') {
        return {
          ...node,
          nat: {
            snatEnabled: node.nat?.snatEnabled ?? false,
            dnatMappings: (node.nat?.dnatMappings ?? []).filter((mapping) => mapping.targetHostId !== deletedNode.id),
          },
        } as TemplateNode;
      }
      return node;
    });
}

function cleanupEdgeReferencesAfterDeletion(nodes: TemplateNode[], deletedEdge: ScenarioGraphEdge) {
  const source = nodes.find((node) => node.id === deletedEdge.fromNodeId);
  const target = nodes.find((node) => node.id === deletedEdge.toNodeId);

  if (source?.kind !== 'switch' || target?.kind !== 'ecs') {
    return nodes;
  }

  return nodes.map((node) =>
    node.id === target.id && node.kind === 'ecs'
      ? { ...node, nics: (node.nics ?? []).filter((nic) => nic.switchId !== source.id) } as TemplateNode
      : node,
  );
}

function cloneGraph(graph: ScenarioGraphDraft): ScenarioGraphDraft {
  return structuredClone({
    schemaVersion: graph.schemaVersion || '2.0.0',
    nodes: graph.nodes ?? [],
    edges: graph.edges ?? [],
  });
}

function isIpv4(value: string) {
  const parts = value.split('.');
  return parts.length === 4 && parts.every((part) => /^\d+$/.test(part) && Number(part) >= 0 && Number(part) <= 255);
}

function isCidr(value: string) {
  return parseCidr(value) !== null;
}

function parseCidr(value: string) {
  const [ip, prefixText, ...extra] = value.split('/');
  const ipNumber = parseIpv4(ip ?? '');
  const prefix = Number(prefixText);

  if (extra.length > 0 || ipNumber === null || !/^\d+$/.test(prefixText ?? '') || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    return null;
  }

  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const network = (ipNumber & mask) >>> 0;
  const addressCount = 2 ** (32 - prefix);

  return { network, broadcast: network + addressCount - 1 };
}

function parseIpv4(value: string) {
  if (!isIpv4(value)) {
    return null;
  }
  const [first, second, third, fourth] = value.split('.').map(Number);
  return (((first! << 24) >>> 0) + ((second! << 16) >>> 0) + ((third! << 8) >>> 0) + fourth!) >>> 0;
}

function isIpv4InCidr(ip: string, cidr: string) {
  const ipNumber = parseIpv4(ip);
  const parsedCidr = parseCidr(cidr);
  return ipNumber !== null && parsedCidr !== null && ipNumber >= parsedCidr.network && ipNumber <= parsedCidr.broadcast;
}

function isCidrWithin(cidr: string, containingCidr: { network: number; broadcast: number }) {
  const parsedCidr = parseCidr(cidr);
  return parsedCidr !== null && parsedCidr.network >= containingCidr.network && parsedCidr.broadcast <= containingCidr.broadcast;
}

function cidrsOverlap(left: string, right: string) {
  const leftRange = parseCidr(left);
  const rightRange = parseCidr(right);
  return leftRange !== null && rightRange !== null && leftRange.network <= rightRange.broadcast && rightRange.network <= leftRange.broadcast;
}

function isUsableHostIp(ip: string, cidr: string) {
  const parsedCidr = parseCidr(cidr);
  const ipNumber = parseIpv4(ip);

  if (!parsedCidr || ipNumber === null) {
    return false;
  }

  return parsedCidr.broadcast - parsedCidr.network <= 1 || (ipNumber !== parsedCidr.network && ipNumber !== parsedCidr.broadcast);
}

function registerIpUsage(ipUsage: Map<string, string>, switchId: string, ip: string, usage: string) {
  const key = `${switchId}:${ip}`;
  const existingUsage = ipUsage.get(key);
  if (existingUsage) {
    throw new Error(`交换机 ${switchId} 中存在重复 IP：${ip}（${existingUsage}、${usage}）`);
  }
  ipUsage.set(key, usage);
}

function isPort(value: number) {
  return Number.isInteger(value) && value >= 1 && value <= 65535;
}
