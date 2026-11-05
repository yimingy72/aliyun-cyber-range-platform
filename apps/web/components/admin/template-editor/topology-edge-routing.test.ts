import { describe, expect, it } from 'vitest';
import { roundedRoutePath, routeTopologyConnections, segmentHitsBox } from './topology-edge-routing';
import { createLargeNetworkLayoutFixture, createNetworkLayoutFixture } from './topology-network.fixture';
import { layoutTopology } from './topology-flow-layout';
import { toFlowEdges } from './topology-flow-adapter';
import { readNetworkRegions, readTopologyNetworks, topologyNodeSize } from './topology-network-model';

describe('network-aware edge routing', () => {
  it('routes orthogonally around a blocking host instead of passing through its label', () => {
    const box = { id: 'blocked', x: 60, y: 100, width: 100, height: 100 };
    const route = routeTopologyConnections([box], [{ id: 'edge', source: { x: 110, y: 0 }, target: { x: 110, y: 300 }, sourceSide: 'bottom', targetSide: 'top' }]).get('edge');
    expect(route).toBeTruthy();expect(route!.length).toBeGreaterThan(2);
    route!.slice(1).forEach((point, index) => {
      expect(point.x === route![index]!.x || point.y === route![index]!.y).toBe(true);
      expect(segmentHitsBox(route![index]!, point, box)).toBe(false);
    });
    expect(roundedRoutePath(route!)).toContain('Q');
  });
  it.each([undefined,{width:720,height:900}])('routes every fixture connection without intersecting nodes or headings (%j)', (canvas) => {
    const { nodes, edges } = createNetworkLayoutFixture(), laid = layoutTopology(nodes, edges,canvas), model = readTopologyNetworks(laid, edges);
    const boxes = laid.map(node => ({ id: node.id, ...node.position!, ...topologyNodeSize(node, model.memberships.get(node.id)) }));
    boxes.push(...readNetworkRegions(laid, edges).map(region => ({id:`heading/${region.id}`,x:region.x+16,y:region.y+10,width:Math.min(region.width-32,region.id.startsWith('zone/')?160:320),height:40})));
    const result = toFlowEdges(laid, edges);
    expect(result).toHaveLength(edges.length);
    for (const edge of result) {
      expect(edge.data?.topologyEdge).toEqual(edges.find(original => original.id === edge.id));
      expect(edge.data?.route, edge.id).toBeTruthy();
      edge.data!.route!.slice(1).forEach((point, index) => {
        expect(boxes.filter(box => segmentHitsBox(edge.data!.route![index]!, point, box)), edge.id).toEqual([]);
      });
    }
    const again = toFlowEdges([...laid].reverse(), [...edges].reverse());
    expect(Object.fromEntries(again.map(edge => [edge.id, edge.data?.route]))).toEqual(Object.fromEntries(result.map(edge => [edge.id, edge.data?.route])));
  });
  it('keeps an 80-host multi-NIC topology routable without a long blocking layout', () => {
    const fixture = createLargeNetworkLayoutFixture(), started = performance.now();
    const laid = layoutTopology(fixture.nodes, fixture.edges), result = toFlowEdges(laid, fixture.edges);
    const elapsed = performance.now() - started;
    console.info(`80-host network layout and ${result.length} routes: ${Math.round(elapsed)}ms`);
    expect(result.every(edge => !!edge.data?.route)).toBe(true);
    expect(elapsed).toBeLessThan(5000);
  }, 15000);
});
