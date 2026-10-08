import { describe, expect, it } from 'vitest';

import type { ScenarioGraphEdge, TemplateNode } from './scenario-graph';
import { nextAvailableSwitchCidr, normalizeManualEdgePair, reconcileHostNicConnections, validateManualEdge } from './scenario-graph-linking';

const routerNode: TemplateNode = {
  id: 'router-1',
  kind: 'router',
  label: '主路由器',
  description: '根 VPC',
  routeRole: 'core',
  egressType: 'internet',
  bindEip: false,
};

const switchNode: TemplateNode = {
  id: 'switch-1',
  kind: 'switch',
  label: '业务交换机',
  zoneKey: 'core',
  cidr: '10.70.10.0/24',
  purpose: 'business-zone',
  description: '',
  aclRules: [],
  nat: {
    snatEnabled: false,
    dnatMappings: [],
  },
};

const ecsNode: TemplateNode = {
  id: 'ecs-1',
  kind: 'ecs',
  label: '业务 ECS',
  instanceName: 'ecs-1',
  hostName: 'ecs-1',
  zoneKey: 'core',
  role: 'entry',
  privateIp: '10.70.10.10',
  exposePublic: true,
  image: 'aliyun_linux_3_x64_20G_alibase',
  imageName: 'aliyun_linux_3_x64_20G_alibase',
  imageId: 'aliyun_linux_3_x64_20G_alibase',
  cpu: 2,
  memory: 4,
  description: '',
  bootPriority: 1,
  bootWaitSeconds: 0,
  dnatMappings: [],
  networkInterfaces: [{ zoneKey: 'core', privateIp: '10.70.10.10' }],
  portGroups: [],
  nics: [
    {
      id: 'nic-1',
      switchId: 'switch-1',
      privateIp: '10.70.10.10',
      secondaryIps: [],
      securityGroupRules: [],
    },
  ],
  initScript: '',
  imageStrategy: { mode: 'fixed', imageId: 'aliyun_linux_3_x64_20G_alibase' },
  instanceTypeStrategy: { mode: 'auto', preferredInstanceTypes: [] },
};

describe('validateManualEdge', () => {
  it('allows router -> switch edges', () => {
    expect(validateManualEdge({ sourceNode: routerNode, targetNode: switchNode, edges: [] })).toEqual({
      ok: true,
    });
  });

  it('allows switch -> ecs edges', () => {
    expect(validateManualEdge({ sourceNode: switchNode, targetNode: ecsNode, edges: [] })).toEqual({
      ok: true,
    });
  });

  it('allows reversed ecs -> switch and switch -> router gestures', () => {
    expect(validateManualEdge({ sourceNode: ecsNode, targetNode: switchNode, edges: [] })).toEqual({
      ok: true,
    });
    expect(validateManualEdge({ sourceNode: switchNode, targetNode: routerNode, edges: [] })).toEqual({
      ok: true,
    });
    expect(normalizeManualEdgePair(ecsNode, switchNode)).toEqual({
      fromNode: switchNode,
      toNode: ecsNode,
    });
    expect(normalizeManualEdgePair(switchNode, routerNode)).toEqual({
      fromNode: routerNode,
      toNode: switchNode,
    });
  });

  it('rejects self-links', () => {
    expect(validateManualEdge({ sourceNode: switchNode, targetNode: switchNode, edges: [] })).toEqual({
      ok: false,
      reason: '不能将节点连接到自己',
    });
  });

  it('rejects duplicate links', () => {
    const edges: ScenarioGraphEdge[] = [
      {
        id: 'edge-1',
        fromNodeId: 'router-1',
        toNodeId: 'switch-1',
        relationType: 'manual',
      },
    ];

    expect(validateManualEdge({ sourceNode: routerNode, targetNode: switchNode, edges })).toEqual({
      ok: false,
      reason: '已存在相同连线',
    });
  });

  it('rejects invalid topology links outside router->switch and switch->ecs', () => {
    expect(validateManualEdge({ sourceNode: routerNode, targetNode: ecsNode, edges: [] })).toEqual({
      ok: false,
      reason: '第一阶段仅允许 Router -> Switch 或 Switch -> ECS 连线',
    });
    expect(validateManualEdge({ sourceNode: routerNode, targetNode: routerNode, edges: [] })).toEqual({
      ok: false,
      reason: '不能将节点连接到自己',
    });
  });
});

describe('NIC connection reconciliation', () => {
  it('rebinds edges, primary placement and DNAT references together', () => {
    const oldSwitch = {...switchNode,nat:{snatEnabled:true,dnatMappings:[{key:'http',targetHostId:ecsNode.id,externalPort:80,internalPort:80,protocol:'tcp' as const}]}};
    const newSwitch = {...switchNode,id:'switch-2',zoneKey:'private',cidr:'192.168.0.0/24'};
    const previous = [routerNode,oldSwitch,newSwitch,ecsNode];
    const nextHost = {...ecsNode,nics:ecsNode.nics!.map(nic=>({...nic,switchId:newSwitch.id,privateIp:'192.168.0.10'}))};
    const oldEdges = [{id:'router-edge',fromNodeId:routerNode.id,toNodeId:oldSwitch.id,relationType:'manual' as const},{id:'host-edge',fromNodeId:oldSwitch.id,toNodeId:ecsNode.id,relationType:'manual' as const}];
    const result = reconcileHostNicConnections(previous,[routerNode,oldSwitch,newSwitch,nextHost],oldEdges,ecsNode.id);
    expect(result.edges.some(edge=>edge.fromNodeId===oldSwitch.id&&edge.toNodeId===ecsNode.id)).toBe(false);
    expect(result.edges.some(edge=>edge.fromNodeId===newSwitch.id&&edge.toNodeId===ecsNode.id)).toBe(true);
    expect((result.nodes.find(node=>node.id===ecsNode.id) as typeof ecsNode).zoneKey).toBe('private');
    expect((result.nodes.find(node=>node.id===oldSwitch.id) as typeof oldSwitch).nat.dnatMappings).toEqual([]);
  });
  it('does not infer edges during an unrelated property edit',()=>{
    const nextHost = {...ecsNode,label:'Renamed'};
    const result = reconcileHostNicConnections([switchNode,ecsNode],[switchNode,nextHost],[],ecsNode.id);
    expect(result.edges).toEqual([]);
  });
});

describe('available default subnet allocation',()=>{
  it('uses fixed ranges and skips CIDR overlaps',()=>{
    expect(nextAvailableSwitchCidr([{...switchNode,cidr:'10.0.0.0/16'}])).toBe('192.168.0.0/24');
    const nodes=[{...switchNode,cidr:'10.0.0.0/24'},{...switchNode,cidr:'192.168.0.0/24'},{...switchNode,cidr:'172.16.0.0/24'}];
    expect(nextAvailableSwitchCidr(nodes)).toBe('10.0.1.0/24');
  });
  it('reports when all fixed ranges are already occupied',()=>{
    const nodes=[{...switchNode,cidr:'10.0.0.0/16'},{...switchNode,cidr:'192.168.0.0/16'},{...switchNode,cidr:'172.16.0.0/16'}];
    expect(()=>nextAvailableSwitchCidr(nodes)).toThrow('没有可用');
  });
});
