import type { EcsTemplateNode, SwitchTemplateNode, TemplateNode } from '../../../lib/scenario-graph';
import type { TemplateEdge } from './template-editor-screen';

export const topologyNodeWidth = 208;
export const topologyNodeBaseHeight = 72;
export const networkColors = ['#2765a8', '#087d83', '#7855a6', '#a26324', '#44783b', '#a14e6e'];
export type NetworkMembership = {
  switchId: string; label: string; cidr: string; color: string; connected: boolean;
  nics: Array<{ id: string; ordinal: number; privateIp: string }>;
};
export type NetworkZone = { node: SwitchTemplateNode; color: string; localHosts: EcsTemplateNode[]; sharedHosts: EcsTemplateNode[] };

export const compareIds = (a: { id: string }, b: { id: string }) => a.id === b.id ? 0 : a.id < b.id ? -1 : 1;
const address = (cidr: string) => cidr.split('/')[0]!.split('.').reduce((value, part) => value * 256 + Number(part), 0);

export function indexTopologyEdges(edges: TemplateEdge[], endpoint: 'fromNodeId' | 'toNodeId') {
  const byNode = new Map<string, TemplateEdge[]>();
  for (const edge of edges) {
    const id = edge[endpoint];
    const bucket = byNode.get(id);
    if (bucket) bucket.push(edge);
    else byNode.set(id, [edge]);
  }
  return byNode;
}

/** NICs describe membership; graph edges remain the only rendered connections. */
export function readTopologyNetworks(nodes: TemplateNode[], edges: TemplateEdge[]) {
  const switches = nodes.filter((node): node is SwitchTemplateNode => node.kind === 'switch')
    .sort((a, b) => address(a.cidr) - address(b.cidr) || compareIds(a, b));
  const zones: NetworkZone[] = switches.map((node, index) => ({ node, color: networkColors[index % networkColors.length]!, localHosts: [], sharedHosts: [] }));
  const zonesById = new Map(zones.map(zone => [zone.node.id, zone]));
  const incoming = indexTopologyEdges(edges, 'toNodeId');
  const memberships = new Map<string, NetworkMembership[]>();
  const sharedHosts: EcsTemplateNode[] = [], unassignedHosts: EcsTemplateNode[] = [];
  for (const host of nodes.filter((node): node is EcsTemplateNode => node.kind === 'ecs').sort(compareIds)) {
    const connectedSwitches = new Set((incoming.get(host.id) ?? []).filter(edge => zonesById.has(edge.fromNodeId))
      .sort((a, b) => a.fromNodeId.localeCompare(b.fromNodeId) || compareIds(a, b)).map(edge => edge.fromNodeId));
    const ids = new Set([...(host.nics ?? []).map(nic => nic.switchId).filter(id => zonesById.has(id)), ...connectedSwitches]);
    const links = [...ids].map(id => {
      const zone = zonesById.get(id)!;
      return { switchId: id, label: zone.node.label, cidr: zone.node.cidr, color: zone.color, connected: connectedSwitches.has(id),
        nics: (host.nics ?? []).flatMap((nic, index) => nic.switchId === id ? [{ id: nic.id, ordinal: index + 1, privateIp: nic.privateIp }] : []) };
    });
    memberships.set(host.id, links);
    if (links.length > 1) {
      sharedHosts.push(host);
      links.forEach(link => zonesById.get(link.switchId)!.sharedHosts.push(host));
    } else if (links.length === 1) zonesById.get(links[0]!.switchId)!.localHosts.push(host);
    else unassignedHosts.push(host);
  }
  zones.forEach(zone => zone.localHosts.sort((a, b) => address(a.nics?.[0]?.privateIp ?? a.privateIp) - address(b.nics?.[0]?.privateIp ?? b.privateIp) || compareIds(a, b)));
  return { zones, memberships, sharedHosts, unassignedHosts };
}

export function networkRows(links: NetworkMembership[]) {
  return links.flatMap(({ nics, ...network }) => nics.length ? nics.map(nic => ({ ...network, ...nic }))
    : [{ ...network, id: network.switchId, ordinal: 0, privateIp: '' }]);
}

export function topologyNodeSize(node: TemplateNode, links: NetworkMembership[] = []) {
  const rows = node.kind === 'ecs' && (links.length > 1 || links.reduce((sum, link) => sum + link.nics.length, 0) > 1)
    ? networkRows(links).length : 0;
  return { width: topologyNodeWidth, height: topologyNodeBaseHeight + (rows ? 8 + rows * 28 : 0) };
}

export function readNetworkRegions(nodes: TemplateNode[], edges: TemplateEdge[]) {
  const model = readTopologyNetworks(nodes, edges);
  const boxesById = new Map(nodes.flatMap(node => node.position
    ? [[node.id, { ...node.position, ...topologyNodeSize(node, model.memberships.get(node.id)) }] as const] : []));
  const groups = [
    ...model.zones.map(zone => ({ id: `zone/${zone.node.id}`, title: zone.node.cidr, color: zone.color,
      description: `区内 ${zone.localHosts.length} · 跨区 ${zone.sharedHosts.length}`, nodes: [zone.node, ...zone.localHosts] as TemplateNode[] })),
    { id: 'group/multi-network', title: '跨区多网卡主机', description: '每台只显示一次 · 按网卡查看所属区域', color: '#617089', nodes: model.sharedHosts as TemplateNode[] },
    { id: 'group/unassigned', title: '未关联网络', description: '请为这些主机关联交换机', color: '#8a5d2b', nodes: model.unassignedHosts as TemplateNode[] },
  ];
  return groups.flatMap(group => {
    const boxes = group.nodes.map(node => boxesById.get(node.id)).filter(item => !!item);
    if (!boxes.length || boxes.length !== group.nodes.length) return [];
    const x = Math.min(...boxes.map(item => item.x)) - 32, y = Math.min(...boxes.map(item => item.y)) - 88;
    const width = Math.max(...boxes.map(item => item.x + item.width)) - x + 32;
    const height = Math.max(...boxes.map(item => item.y + item.height)) - y + 32;
    const ids = new Set(group.nodes.map(node => node.id));
    // A manually mixed canvas must not imply that unrelated hosts belong to this subnet.
    for (const [id, other] of boxesById) {
      if (!ids.has(id) && other.x < x + width && other.x + other.width > x && other.y < y + height && other.y + other.height > y) return [];
    }
    return [{ id: group.id, title: group.title, description: group.description, color: group.color, x, y, width, height }];
  });
}
