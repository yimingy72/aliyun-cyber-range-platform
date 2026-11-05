import { describe, expect, it } from 'vitest';

import type { TemplateEdge } from './template-editor-screen';
import { layoutTopology } from './topology-flow-layout';
import type { TemplateNode } from '../../../lib/scenario-graph';
import { readTopologyNetworks, topologyNodeSize } from './topology-network-model';
import { createNetworkLayoutFixture } from './topology-network.fixture';

function createTopologyNodes(): TemplateNode[] {
  return [{
    id: 'router-1',
    kind: 'router',
    label: '主路由器',
    routeRole: 'core',
    egressType: 'internet',
    bindEip: true,
  }, {
    id: 'switch-1',
    kind: 'switch',
    label: 'DMZ 交换机',
    zoneKey: 'dmz',
    cidr: '10.70.10.0/24',
    purpose: 'dmz',
  }, {
    id: 'ecs-1',
    kind: 'ecs',
    label: 'Web ECS',
    zoneKey: 'dmz',
    role: 'web',
    privateIp: '10.70.10.10',
    exposePublic: false,
    image: 'aliyun_linux_3_x64_20G_alibase',
    dnatMappings: [],
    networkInterfaces: [],
    portGroups: [],
    initScript: '',
    imageStrategy: { mode: 'fixed', imageId: 'aliyun_linux_3_x64_20G_alibase' },
    instanceTypeStrategy: { mode: 'auto' },
  }];
}

function positionsById(nodes: TemplateNode[]) {
  return Object.fromEntries(
    nodes
      .map((node) => [node.id, node.position] as const)
      .sort(([leftId], [rightId]) => leftId.localeCompare(rightId)),
  );
}

describe('topology flow layout', () => {
  it('让 router、交换机与区内 ECS 按自上而下的网络层次排列', () => {
    const nodes: TemplateNode[] = [{
      id: 'router-1',
      kind: 'router',
      label: '主路由器',
      routeRole: 'core',
      egressType: 'internet',
      bindEip: true,
    }, {
      id: 'switch-1',
      kind: 'switch',
      label: 'DMZ 交换机',
      zoneKey: 'dmz',
      cidr: '10.70.10.0/24',
      purpose: 'dmz',
    }, {
      id: 'ecs-1',
      kind: 'ecs',
      label: 'Web ECS',
      zoneKey: 'dmz',
      role: 'web',
      privateIp: '10.70.10.10',
      exposePublic: false,
      image: 'aliyun_linux_3_x64_20G_alibase',
      dnatMappings: [],
      networkInterfaces: [],
      portGroups: [],
      initScript: '',
      imageStrategy: { mode: 'fixed', imageId: 'aliyun_linux_3_x64_20G_alibase' },
      instanceTypeStrategy: { mode: 'auto' },
    }];
    const edges: TemplateEdge[] = [{
      id: 'router-switch',
      fromNodeId: 'router-1',
      toNodeId: 'switch-1',
      relationType: 'manual',
    }, {
      id: 'switch-ecs',
      fromNodeId: 'switch-1',
      toNodeId: 'ecs-1',
      relationType: 'manual',
    }];

    const firstResult = layoutTopology(nodes, edges);
    const secondResult = layoutTopology(nodes, edges);
    const router = firstResult.find((node) => node.id === 'router-1');
    const switchNode = firstResult.find((node) => node.id === 'switch-1');
    const ecs = firstResult.find((node) => node.id === 'ecs-1');

    expect(router?.position?.y).toBeLessThan(switchNode?.position?.y ?? Number.NaN);
    expect(switchNode?.position?.y).toBeLessThan(ecs?.position?.y ?? Number.NaN);
    expect(secondResult).toEqual(firstResult);
    expect(nodes.every((node) => node.position === undefined)).toBe(true);
  });

  it('将没有网卡配置或连线的主机留在未关联区域，不凭 zoneKey 伪造归属', () => {
    const result = layoutTopology(createTopologyNodes(), []);

    expect(readTopologyNetworks(result, []).unassignedHosts.map(node => node.id)).toEqual(['ecs-1']);
    expect(result.find(node => node.id === 'ecs-1')!.position!.y).toBeGreaterThan(result.find(node => node.id === 'switch-1')!.position!.y);
  });

  it('忽略指向不存在节点的边，不影响真实节点布局', () => {
    const nodes = createTopologyNodes();
    const edges: TemplateEdge[] = [{
      id: 'router-switch',
      fromNodeId: 'router-1',
      toNodeId: 'switch-1',
      relationType: 'manual',
    }, {
      id: 'switch-ecs',
      fromNodeId: 'switch-1',
      toNodeId: 'ecs-1',
      relationType: 'manual',
    }];

    const result = layoutTopology(nodes, edges);
    const resultWithUnknownEndpoint = layoutTopology(nodes, [{
      id: 'unknown-target',
      fromNodeId: 'switch-1',
      toNodeId: 'missing-ecs',
      relationType: 'manual',
    }, ...edges]);

    expect(positionsById(resultWithUnknownEndpoint)).toEqual(positionsById(result));
  });

  it('在节点和边输入顺序不同时保持相同的 id 到 position 映射', () => {
    const nodes: TemplateNode[] = [
      ...createTopologyNodes(),
      {
        id: 'router-2',
        kind: 'router',
        label: '备用路由器',
        routeRole: 'core',
        egressType: 'internet',
        bindEip: false,
      },
      {
        id: 'switch-2',
        kind: 'switch',
        label: '办公网交换机',
        zoneKey: 'office',
        cidr: '10.70.20.0/24',
        purpose: 'office',
      },
      {
        id: 'ecs-2',
        kind: 'ecs',
        label: 'Office ECS',
        zoneKey: 'office',
        role: 'office',
        privateIp: '10.70.20.10',
        exposePublic: false,
        image: 'aliyun_linux_3_x64_20G_alibase',
        dnatMappings: [],
        networkInterfaces: [],
        portGroups: [],
        initScript: '',
        imageStrategy: { mode: 'fixed', imageId: 'aliyun_linux_3_x64_20G_alibase' },
        instanceTypeStrategy: { mode: 'auto' },
      },
    ];
    const edges: TemplateEdge[] = [{
      id: 'router-2-switch-2',
      fromNodeId: 'router-2',
      toNodeId: 'switch-2',
      relationType: 'manual',
    }, {
      id: 'switch-2-ecs-2',
      fromNodeId: 'switch-2',
      toNodeId: 'ecs-2',
      relationType: 'manual',
    }, {
      id: 'router-1-switch-1',
      fromNodeId: 'router-1',
      toNodeId: 'switch-1',
      relationType: 'manual',
    }, {
      id: 'switch-1-ecs-1',
      fromNodeId: 'switch-1',
      toNodeId: 'ecs-1',
      relationType: 'manual',
    }];

    const ordered = layoutTopology(nodes, edges);
    const reordered = layoutTopology([...nodes].reverse(), [...edges].reverse());

    expect(positionsById(reordered)).toEqual(positionsById(ordered));
  });

  it('同一交换机下的 ECS 采用不重叠的局部网格，并位于该交换机下方', () => {
    const nodes: TemplateNode[] = [{
      id: 'switch-1',
      kind: 'switch',
      label: '交换机 1',
      zoneKey: 'zone-1',
      cidr: '10.0.0.0/24',
      purpose: 'business',
    }, {
      id: 'ecs-1',
      kind: 'ecs',
      label: 'ECS 1',
      zoneKey: 'zone-1',
      role: 'web',
      privateIp: '10.0.0.11',
      exposePublic: false,
      image: 'aliyun_linux_3_x64_20G_alibase',
      dnatMappings: [],
      networkInterfaces: [],
      portGroups: [],
      initScript: '',
      imageStrategy: { mode: 'fixed', imageId: 'aliyun_linux_3_x64_20G_alibase' },
      instanceTypeStrategy: { mode: 'auto' },
    }, {
      id: 'ecs-2',
      kind: 'ecs',
      label: 'ECS 2',
      zoneKey: 'zone-1',
      role: 'web',
      privateIp: '10.0.0.12',
      exposePublic: false,
      image: 'aliyun_linux_3_x64_20G_alibase',
      dnatMappings: [],
      networkInterfaces: [],
      portGroups: [],
      initScript: '',
      imageStrategy: { mode: 'fixed', imageId: 'aliyun_linux_3_x64_20G_alibase' },
      instanceTypeStrategy: { mode: 'auto' },
    }, {
      id: 'ecs-3',
      kind: 'ecs',
      label: 'ECS 3',
      zoneKey: 'zone-1',
      role: 'web',
      privateIp: '10.0.0.13',
      exposePublic: false,
      image: 'aliyun_linux_3_x64_20G_alibase',
      dnatMappings: [],
      networkInterfaces: [],
      portGroups: [],
      initScript: '',
      imageStrategy: { mode: 'fixed', imageId: 'aliyun_linux_3_x64_20G_alibase' },
      instanceTypeStrategy: { mode: 'auto' },
    }];
    const edges: TemplateEdge[] = [{
      id: 'edge-1',
      fromNodeId: 'switch-1',
      toNodeId: 'ecs-1',
      relationType: 'manual',
    }, {
      id: 'edge-2',
      fromNodeId: 'switch-1',
      toNodeId: 'ecs-2',
      relationType: 'manual',
    }, {
      id: 'edge-3',
      fromNodeId: 'switch-1',
      toNodeId: 'ecs-3',
      relationType: 'manual',
    }];

    const result = layoutTopology(nodes, edges);
    const ecsY = ['ecs-1', 'ecs-2', 'ecs-3'].map((id) => result.find((node) => node.id === id)?.position?.y ?? Number.NaN);

    expect(ecsY.every(y => y > result[0]!.position!.y)).toBe(true);
    expect(result.find(node => node.id === 'ecs-1')!.position!.x).toBeLessThan(result.find(node => node.id === 'ecs-2')!.position!.x);
    expect(ecsY[2]).toBeGreaterThan(ecsY[0]!);
  });

  it('按真实网卡与连线分区，多网卡主机只出现一次，所有业务字段保持原样', () => {
    const { nodes, edges } = createNetworkLayoutFixture();
    const multi = nodes.find(node => node.id === 'bastion')!;
    if(multi.kind!=='ecs')throw new Error('Missing fixture host');
    multi.nics![1]!.secondaryIps=['10.0.40.21'];
    multi.nics![1]!.securityGroupRules=[{key:'keep-rule',direction:'ingress',protocol:'tcp',portRange:'3389/3389',sourceCidr:'10.0.0.0/16',policy:'accept',priority:4}];
    multi.dns={servers:['10.0.40.10'],nicIds:[multi.nics![1]!.id]};
    multi.initScript='fixture boot configuration, not executed';
    const original = structuredClone({ nodes, edges });
    const result = layoutTopology(nodes, edges), model = readTopologyNetworks(result, edges);
    expect(result).toHaveLength(nodes.length);
    expect(result.filter(node => node.id === 'bastion')).toHaveLength(1);
    expect(model.memberships.get('bastion')?.map(link => link.switchId)).toEqual(['sw-ops', 'sw-app', 'sw-storage']);
    for (const zone of model.zones) for (const host of zone.localHosts) {
      expect(host.position!.y).toBeGreaterThan(zone.node.position!.y);
    }
    const sharedTop = Math.min(...model.sharedHosts.map(host => host.position!.y));
    expect(model.zones.every(zone => zone.localHosts.every(host => host.position!.y < sharedTop))).toBe(true);
    expect(result.map(({ position, ...node }) => node)).toEqual(original.nodes.map(({ position, ...node }) => node));
    expect({ nodes, edges }).toEqual(original);
    expect(positionsById(layoutTopology([...nodes].reverse(), [...edges].reverse()))).toEqual(positionsById(result));
    expect(layoutTopology(result, edges)).toEqual(result);
    for (let i = 0; i < result.length; i++) for (let j = i + 1; j < result.length; j++) {
      const a = result[i]!, b = result[j]!, sa = topologyNodeSize(a, model.memberships.get(a.id)), sb = topologyNodeSize(b, model.memberships.get(b.id));
      expect(a.position!.x < b.position!.x + sb.width && a.position!.x + sa.width > b.position!.x
        && a.position!.y < b.position!.y + sb.height && a.position!.y + sa.height > b.position!.y).toBe(false);
    }
  });

  it('多张网卡接入同一交换机时仍属于区内主机，而不是虚假的跨区节点', () => {
    const { nodes, edges } = createNetworkLayoutFixture();
    const host = nodes.find(node => node.id === 'gitlab')!;
    if (host.kind !== 'ecs') throw new Error('Fixture host missing');
    host.nics!.push({ ...host.nics![0]!, id: 'gitlab-nic-2', privateIp: '172.16.30.20' });
    const model = readTopologyNetworks(nodes, edges);
    expect(model.sharedHosts.some(host => host.id === 'gitlab')).toBe(false);
    expect(model.zones.find(zone => zone.node.id === 'sw-dev')?.localHosts.some(host => host.id === 'gitlab')).toBe(true);
    expect(topologyNodeSize(host, model.memberships.get(host.id)).height).toBeGreaterThan(72);
  });
  it('根据窄画布分行组织分区，而不是强制将所有网段挤成横向长条',()=>{
    const {nodes,edges}=createNetworkLayoutFixture();
    const narrow=layoutTopology(nodes,edges,{width:720,height:900}),wide=layoutTopology(nodes,edges,{width:1800,height:900});
    const switchRows=(items:TemplateNode[])=>new Set(items.filter(node=>node.kind==='switch').map(node=>node.position!.y));
    expect(switchRows(narrow).size).toBeGreaterThan(1);
    expect(switchRows(wide).size).toBeLessThan(switchRows(narrow).size);
    expect(layoutTopology(narrow,edges,{width:720,height:900})).toEqual(narrow);
  });

});
