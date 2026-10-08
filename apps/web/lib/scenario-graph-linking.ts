import type { ScenarioGraphEdge, TemplateNode } from './scenario-graph';
import { defaultSwitchCidr } from '@aliyun-cyber-range/scenario-runtime';

type ValidateManualEdgeInput = {
  sourceNode: TemplateNode;
  targetNode: TemplateNode;
  edges: ScenarioGraphEdge[];
};

type ValidateManualEdgeResult =
  | { ok: true }
  | { ok: false; reason: string };

export function normalizeManualEdgePair(sourceNode: TemplateNode, targetNode: TemplateNode) {
  if (
    (sourceNode.kind === 'router' && targetNode.kind === 'switch') ||
    (sourceNode.kind === 'switch' && targetNode.kind === 'router')
  ) {
    return {
      fromNode: sourceNode.kind === 'router' ? sourceNode : targetNode,
      toNode: sourceNode.kind === 'switch' ? sourceNode : targetNode,
    };
  }

  if (
    (sourceNode.kind === 'switch' && targetNode.kind === 'ecs') ||
    (sourceNode.kind === 'ecs' && targetNode.kind === 'switch')
  ) {
    return {
      fromNode: sourceNode.kind === 'switch' ? sourceNode : targetNode,
      toNode: sourceNode.kind === 'ecs' ? sourceNode : targetNode,
    };
  }

  return null;
}

export function validateManualEdge(input: ValidateManualEdgeInput): ValidateManualEdgeResult {
  if (input.sourceNode.id === input.targetNode.id) {
    return { ok: false, reason: '不能将节点连接到自己' };
  }

  const normalized = normalizeManualEdgePair(input.sourceNode, input.targetNode);

  if (!normalized) {
    return { ok: false, reason: '第一阶段仅允许 Router -> Switch 或 Switch -> ECS 连线' };
  }

  const duplicate = input.edges.some(
    (edge) => edge.fromNodeId === normalized.fromNode.id && edge.toNodeId === normalized.toNode.id,
  );

  if (duplicate) {
    return { ok: false, reason: '已存在相同连线' };
  }

  return { ok: true };
}

export function reconcileHostNicConnections(
  previousNodes: TemplateNode[],
  nextNodes: TemplateNode[],
  edges: ScenarioGraphEdge[],
  hostId: string,
) {
  const host = nextNodes.find((node) => node.id === hostId);
  const previousHost = previousNodes.find((node) => node.id === hostId);
  if (host?.kind !== 'ecs' || previousHost?.kind !== 'ecs'
    || JSON.stringify(host.nics?.map((nic) => nic.switchId)) === JSON.stringify(previousHost.nics?.map((nic) => nic.switchId))) {
    return { nodes: nextNodes, edges };
  }
  const linkedSwitchIds = new Set((host.nics ?? []).map((nic) => nic.switchId).filter(Boolean));
  let nextEdges = edges.filter((edge) =>
    edge.toNodeId !== hostId || nextNodes.find((node) => node.id === edge.fromNodeId)?.kind !== 'switch'
    || linkedSwitchIds.has(edge.fromNodeId),
  );
  for (const switchId of linkedSwitchIds) {
    const switchNode = nextNodes.find((node) => node.id === switchId && node.kind === 'switch');
    if (switchNode && !nextEdges.some((edge) => edge.fromNodeId === switchId && edge.toNodeId === hostId)) {
      nextEdges = [...nextEdges, {
        id: `edge-${switchId}-${hostId}`, fromNodeId: switchId, toNodeId: hostId,
        relationType: 'manual', label: `${switchNode.label} -> ${host.label}`,
      }];
    }
  }
  const primarySwitch = nextNodes.find((node) => node.id === host.nics?.[0]?.switchId);
  const nodes = nextNodes.map((node): TemplateNode => {
    if (node.id === hostId && node.kind === 'ecs' && primarySwitch?.kind === 'switch') {
      return { ...node, zoneKey: primarySwitch.zoneKey };
    }
    if (node.kind === 'switch' && !linkedSwitchIds.has(node.id)) {
      return { ...node, nat: {
        snatEnabled: node.nat?.snatEnabled ?? false,
        dnatMappings: (node.nat?.dnatMappings ?? []).filter((mapping) => mapping.targetHostId !== hostId),
      } };
    }
    return node;
  });
  return { nodes, edges: nextEdges };
}

export function nextAvailableSwitchCidr(nodes: TemplateNode[]) {
  function range(cidr: string) {
    const [ip = '', prefixText = ''] = cidr.split('/');
    const octets = ip.split('.').map(Number);
    const prefix = Number(prefixText);
    if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
      || !/^\d+$/.test(prefixText) || prefix < 0 || prefix > 32) return null;
    const address = octets.reduce((value, octet) => value * 256 + octet, 0);
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    const start = (address & mask) >>> 0;
    return { start, end: start + 2 ** (32 - prefix) - 1 };
  }
  const occupied = nodes.filter((node) => node.kind === 'switch')
    .map((node) => range((node as Extract<TemplateNode, {kind:'switch'}>).cidr)).filter((item) => item !== null);
  for (let ordinal = 1; ordinal <= 768; ordinal += 1) {
    const cidr = defaultSwitchCidr(ordinal);
    const candidate = range(cidr)!;
    if (!occupied.some((item) => item.start <= candidate.end && candidate.start <= item.end)) return cidr;
  }
  throw new Error('固定 VPC 内没有可用的默认 /24 网段，请调整现有交换机。');
}
