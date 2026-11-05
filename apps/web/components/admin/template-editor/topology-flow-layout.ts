import type { TemplateEdge } from './template-editor-screen';
import type { TemplateNode } from '../../../lib/scenario-graph';

import { compareIds, readTopologyNetworks, topologyNodeSize, topologyNodeWidth, type NetworkZone } from './topology-network-model';

const gap = 48;
const zoneGap = 80;
const padding = 32;
export type TopologyLayoutSize = { width: number; height: number };

function orderNetworks(model: ReturnType<typeof readTopologyNetworks>) {
  const initial = model.zones;
  let zones = [...initial], hosts = [...model.sharedHosts];
  const links = (id: string) => model.memberships.get(id)!.map(link => link.switchId);
  const average = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
  const sortHosts = () => hosts.sort((a, b) => average(links(a.id).map(id => zones.findIndex(zone => zone.node.id === id)))
    - average(links(b.id).map(id => zones.findIndex(zone => zone.node.id === id))) || compareIds(a, b));
  const score = () => {
    const wires = hosts.flatMap((host, target) => links(host.id).map(id => ({ source: zones.findIndex(zone => zone.node.id === id), target })));
    let crossings = 0;
    for (let i = 0; i < wires.length; i++) for (let j = i + 1; j < wires.length; j++) {
      if ((wires[i]!.source - wires[j]!.source) * (wires[i]!.target - wires[j]!.target) < 0) crossings++;
    }
    return [crossings, wires.reduce((sum, wire) => sum + Math.abs(wire.source / Math.max(1, zones.length - 1) - wire.target / Math.max(1, hosts.length - 1)), 0)];
  };
  sortHosts();
  let best = { zones: [...zones], hosts: [...hosts], score: score() };
  // Barycentric sweeps bring co-attached networks together without assuming a security hierarchy.
  for (let pass = 0; pass < 6 && hosts.length; pass++) {
    const indices = new Map(hosts.map((host, index) => [host.id, index]));
    const rank = (zone: NetworkZone) => zone.sharedHosts.length
      ? average(zone.sharedHosts.map(host => indices.get(host.id)!)) / Math.max(1, hosts.length - 1)
      : initial.indexOf(zone) / Math.max(1, initial.length - 1);
    zones.sort((a, b) => rank(a) - rank(b) || initial.indexOf(a) - initial.indexOf(b));
    sortHosts();
    const next = score();
    if (next[0]! < best.score[0]! || next[0] === best.score[0] && next[1]! < best.score[1]!) best = { zones: [...zones], hosts: [...hosts], score: next };
  }
  return best;
}

export function layoutTopology(nodes: TemplateNode[], edges: TemplateEdge[], canvas?: TopologyLayoutSize): TemplateNode[] {
  const model = readTopologyNetworks(nodes, edges);
  const { zones, hosts: sharedHosts } = orderNetworks(model);
  const positions = new Map<string, { x: number; y: number }>();
  const zoneCenters = new Map<string, number>();
  const size = (node: TemplateNode) => topologyNodeSize(node, model.memberships.get(node.id));
  const routers = nodes.filter(node => node.kind === 'router').sort(compareIds);
  const zoneTop = routers.length ? 240 : 80;
  const availableWidth = canvas && Number.isFinite(canvas.width) && canvas.width > 0 ? Math.max(320, canvas.width - 128) : 1400;
  const availableHeight = canvas && Number.isFinite(canvas.height) && canvas.height > 0 ? Math.max(240, canvas.height - 96) : 800;
  const specs = zones.map(zone => {
    const columns = Math.min(3, Math.max(1, Math.ceil(Math.sqrt(zone.localHosts.length / 2))));
    const width = padding * 2 + columns * topologyNodeWidth + (columns - 1) * gap;
    const hostHeight = Math.max(72, ...zone.localHosts.map(host => size(host).height));
    const height = zone.localHosts.length ? 208 + Math.ceil(zone.localHosts.length / columns) * (hostHeight + gap) : 168;
    return { zone, columns, width, hostHeight, height };
  });
  const bandWidth = Math.min(6, Math.ceil(Math.sqrt(model.unassignedHosts.length))) * (topologyNodeWidth + gap) + padding * 2;
  const grids = Array.from({ length: Math.max(1, Math.min(6, zones.length)) }, (_, index) => {
    const count = index + 1;
    const widths = Array.from({ length: count }, (_, column) => Math.max(0, ...specs.filter((_, i) => i % count === column).map(spec => spec.width)));
    const heights = Array.from({ length: Math.ceil(specs.length / count) }, (_, row) => Math.max(0, ...specs.slice(row * count, (row + 1) * count).map(spec => spec.height)));
    const width = Math.max(topologyNodeWidth + padding * 2, widths.reduce((sum, value) => sum + value, 0) + (count - 1) * zoneGap, bandWidth, routers.length * (topologyNodeWidth + gap));
    const networkHeight = heights.reduce((sum, value) => sum + value, 0) + Math.max(0, heights.length - 1) * zoneGap;
    const capacity = Math.max(1, Math.floor((width - padding * 2 + gap) / (topologyNodeWidth + gap)));
    const sharedHeight = sharedHosts.length ? Math.ceil(sharedHosts.length / capacity) * (Math.max(...sharedHosts.map(host => size(host).height)) + gap) + 160 : 0;
    return { count, widths, heights, width, networkHeight, score: Math.max(width / availableWidth, (zoneTop + networkHeight + sharedHeight) / availableHeight) };
  });
  const grid = grids.sort((a, b) => a.score - b.score || a.count - b.count)[0]!;
  let bottom = zoneTop + grid.networkHeight;
  specs.forEach(({ zone, columns, width, hostHeight }, index) => {
    const column = index % grid.count, row = Math.floor(index / grid.count);
    const left = 64 + grid.widths.slice(0, column).reduce((sum, value) => sum + value + zoneGap, 0) + (grid.widths[column]! - width) / 2;
    const top = zoneTop + grid.heights.slice(0, row).reduce((sum, value) => sum + value + zoneGap, 0);
    const center = left + width / 2;
    zoneCenters.set(zone.node.id, center);
    positions.set(zone.node.id, { x: center - topologyNodeWidth / 2, y: top + 64 });
    zone.localHosts.forEach((host, index) => positions.set(host.id, {
      x: left + padding + index % columns * (topologyNodeWidth + gap),
      y: top + 208 + Math.floor(index / columns) * (hostHeight + gap),
    }));
  });
  const width = grid.width;
  routers.forEach((router, index) => positions.set(router.id, {
    x: 64 + width / 2 - (routers.length * (topologyNodeWidth + gap) - gap) / 2 + index * (topologyNodeWidth + gap), y: 64,
  }));
  function placeBand(hosts: TemplateNode[], top: number, centered: boolean) {
    if (!hosts.length) return top;
    const columns = Math.max(1, Math.floor((width - padding * 2 + gap) / (topologyNodeWidth + gap)));
    const heights = Array.from({ length: columns }, () => top + 64);
    for (const host of hosts) {
      const targets = (model.memberships.get(host.id) ?? []).map(link => zoneCenters.get(link.switchId)!);
      const ideal = targets.length ? targets.reduce((sum, x) => sum + x, 0) / targets.length : 64 + width / 2;
      const candidates = heights.map((y, column) => ({ column, x: 64 + padding + column * (topologyNodeWidth + gap), y }));
      candidates.sort((a, b) => (centered ? Math.abs(a.x + topologyNodeWidth / 2 - ideal) : 0) + a.y - top
        - ((centered ? Math.abs(b.x + topologyNodeWidth / 2 - ideal) : 0) + b.y - top) || a.column - b.column);
      const spot = candidates[0]!;
      positions.set(host.id, { x: spot.x, y: spot.y });
      heights[spot.column]! += size(host).height + gap;
    }
    return Math.max(...heights);
  }
  bottom = placeBand(sharedHosts, bottom + 96, true);
  placeBand(model.unassignedHosts, bottom + 96, false);
  return nodes.map(node => ({ ...node, position: positions.get(node.id) ?? { x: 64, y: bottom + 64 } }));
}
