import { describe, expect, it } from 'vitest';

import type { TemplateEdge } from './template-editor-screen';
import { layoutTopology } from './topology-flow-layout';
import type { TemplateNode } from '../../../lib/scenario-graph';

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
  it('让 router、switch 和 ecs 按从左到右确定性排列', () => {
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

    expect(router?.position?.x).toBeLessThan(switchNode?.position?.x ?? Number.NaN);
    expect(switchNode?.position?.x).toBeLessThan(ecs?.position?.x ?? Number.NaN);
    expect(secondResult).toEqual(firstResult);
    expect(nodes.every((node) => node.position === undefined)).toBe(true);
  });

  it('将孤立 router、switch 和 ecs 固定在各自的横向列', () => {
    const result = layoutTopology(createTopologyNodes(), []);

    expect(result.map((node) => ({ kind: node.kind, x: node.position?.x }))).toEqual([
      { kind: 'router', x: 80 },
      { kind: 'switch', x: 396 },
      { kind: 'ecs', x: 712 },
    ]);
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

  it('同一交换机下的 ECS 按添加顺序从上到下排列', () => {
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

    expect(ecsY[0]).toBeLessThan(ecsY[1]);
    expect(ecsY[1]).toBeLessThan(ecsY[2]);
  });

});
