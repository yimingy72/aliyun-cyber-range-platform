import {describe,expect,it} from 'vitest';
import {readNetworkRegions,readTopologyNetworks} from './topology-network-model';
import {createNetworkLayoutFixture} from './topology-network.fixture';
import {layoutTopology} from './topology-flow-layout';

describe('network region presentation',()=>{
  it('shows exactly one region per switch and one shared multi-homed group after layout',()=>{
    const {nodes,edges}=createNetworkLayoutFixture(),laid=layoutTopology(nodes,edges),regions=readNetworkRegions(laid,edges);
    expect(regions.filter(region=>region.id.startsWith('zone/'))).toHaveLength(6);
    expect(regions.find(region=>region.id==='group/multi-network')).toMatchObject({title:'跨区多网卡主机'});
    expect(regions.find(region=>region.id==='zone/sw-storage')?.description).toBe('区内 1 · 跨区 2');
  });
  it('hides a misleading region backdrop if a manually dragged unrelated host is inside it',()=>{
    const {nodes,edges}=createNetworkLayoutFixture(),laid=layoutTopology(nodes,edges);
    const foreign=laid.find(node=>node.id==='db')!,local=laid.find(node=>node.id==='web')!;
    foreign.position={...local.position!};
    expect(readNetworkRegions(laid,edges).some(region=>region.id==='zone/sw-dmz')).toBe(false);
  });
  it('does not create a missing wire from NIC metadata or lose secondary IP/security/DNS fields',()=>{
    const {nodes,edges}=createNetworkLayoutFixture(),original=structuredClone(nodes),filtered=edges.filter(edge=>edge.id!=='dev-harbor');
    expect(readTopologyNetworks(nodes,filtered).memberships.get('harbor')?.find(link=>link.switchId==='sw-dev')?.connected).toBe(false);
    expect(nodes).toEqual(original);expect(filtered.some(edge=>edge.id==='dev-harbor')).toBe(false);
  });
});
