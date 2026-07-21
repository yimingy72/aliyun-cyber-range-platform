import {
  buildScenarioTemplateSpecFromTopologyGraph,
  compileScenarioTemplateSpec,
  type ScenarioGraphDraft,
  type ScenarioGraphEdge,
  type ScenarioTemplateMetadata,
  type TemplateNode,
  validateAliyunEcsPassword,
} from '@aliyun-cyber-range/scenario-runtime';

export type TemplateAuthoringMetadata = ScenarioTemplateMetadata & {
  modulePathOrRef: string;
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
};

const DEFAULT_PUBLIC_ENTRY_PROTOCOLS = [
  { protocol: 'ssh', port: 22 },
  { protocol: 'http', port: 80 },
];

export function compileTemplateTopology(
  topologyGraph: ScenarioGraphDraft,
  metadata: TemplateAuthoringMetadata,
): CompiledTemplatePayload {
  const graph = normalizeTopologyGraph(topologyGraph);
  validateGraph(graph, metadata);
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
      vpcCidr: metadata.vpcCidr,
      defaultRegion: metadata.defaultRegion,
      defaultZoneId: metadata.defaultZoneId,
    },
  });
  const entryHost = scenarioTemplateSpec.hosts.find((host) => host.key === scenarioTemplateSpec.topology.entryHostKey);
  if (!entryHost) {
    throw new Error('拓扑缺少公网入口 ECS 节点');
  }

  return {
    topologyGraph: graph,
    topologySpec: {
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
    },
    scenarioTemplateSpec,
    compiledProvisionSpec: compileScenarioTemplateSpec(scenarioTemplateSpec),
  };
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
    ...(typeof topologySpec?.vpcCidr === 'string' ? { vpcCidr: topologySpec.vpcCidr } : {}),
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
  const vpcCidr = metadata.vpcCidr ?? '10.0.0.0/16';
  if (!isCidr(vpcCidr)) {
    throw new Error('vpcCidr 必须是 IPv4 CIDR');
  }
  const parsedVpcCidr = parseCidr(vpcCidr)!;
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
      if (!isCidr(node.cidr)) {
        throw new Error(`交换机 CIDR 无效：${node.id}`);
      }
      if (!isCidrWithin(node.cidr, parsedVpcCidr)) {
        throw new Error(`交换机 CIDR 不在 VPC 网段内：${node.id}`);
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
      if (!(targetHost.nics ?? []).some((nic) => nic.switchId === switchNode.id)) {
        throw new Error(`DNAT 目标 ECS 未连接到交换机：${mapping.key}`);
      }
    }
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
          aclRules: node.aclRules ?? [],
          nat: {
            snatEnabled: node.nat?.snatEnabled ?? false,
            dnatMappings: node.nat?.dnatMappings ?? [],
          },
        } as SwitchNode;
      }

      const imageStrategy = node.imageStrategy ?? { mode: 'fixed' as const, imageId: node.image };
      return {
        ...node,
        initScript: node.initScript ?? '',
        dnatMappings: node.dnatMappings ?? [],
        networkInterfaces: node.networkInterfaces ?? [],
        portGroups: node.portGroups ?? [],
        imageStrategy:
          imageStrategy.mode === 'fixed' && !imageStrategy.imageId
            ? { ...imageStrategy, imageId: node.image }
            : imageStrategy,
        instanceTypeStrategy: node.instanceTypeStrategy ?? { mode: 'auto' as const },
        nics: (node.nics ?? []).map((nic) => ({
          ...nic,
          secondaryIps: nic.secondaryIps ?? [],
          securityGroupRules: nic.securityGroupRules ?? [],
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
