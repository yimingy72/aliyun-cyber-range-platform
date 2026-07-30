import { describe, expect, it } from 'vitest';

import type { TemplateEdge } from './template-editor-screen';
import type { TemplateNode } from '../../../lib/scenario-graph';
import {
  fromFlowNodes,
  readTopologyViewport,
  toFlowEdges,
  toFlowNodes,
  writeTopologyViewport,
} from './topology-flow-adapter';

const switchA: TemplateNode = {
  id: 'switch-a',
  kind: 'switch',
  label: '交换机 A',
  zoneKey: 'zone-a',
  cidr: '10.70.10.0/24',
  purpose: 'business',
  aclRules: [],
  nat: { snatEnabled: false, dnatMappings: [] },
};
const switchB: TemplateNode = {
  id: 'switch-b',
  kind: 'switch',
  label: '交换机 B',
  zoneKey: 'zone-b',
  cidr: '10.70.20.0/24',
  aclRules: [],
  nat: { snatEnabled: false, dnatMappings: [] },
};
const ecs: TemplateNode = {
  id: 'ecs-1',
  kind: 'ecs',
  label: 'ECS 1',
  zoneKey: 'zone-a',
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
};
const edgeA: TemplateEdge = {
  id: 'edge-switch-a-ecs',
  fromNodeId: 'switch-a',
  toNodeId: 'ecs-1',
  relationType: 'manual',
};
const edgeB: TemplateEdge = {
  id: 'edge-switch-b-ecs',
  fromNodeId: 'switch-b',
  toNodeId: 'ecs-1',
  relationType: 'manual',
};

describe('topology flow adapter', () => {
  it('为同一 ECS 的多条交换机连线分配不同且稳定的端点', () => {
    const nodes = [switchA, switchB, ecs];
    const edges = [edgeA, edgeB];

    const flowEcs = toFlowNodes(nodes, edges).find((node) => node.id === 'ecs-1');
    const flowEdges = toFlowEdges(nodes, edges);

    expect(flowEcs?.data.targetPorts).toEqual([
      { id: 'target-edge-switch-a-ecs', offset: 26 },
      { id: 'target-edge-switch-b-ecs', offset: 74 },
    ]);
    expect(flowEdges).toMatchObject([{
      id: 'edge-switch-a-ecs',
      type: 'bezier',
      sourceHandle: 'source-edge-switch-a-ecs',
      targetHandle: 'target-edge-switch-a-ecs',
    }, {
      id: 'edge-switch-b-ecs',
      type: 'bezier',
      sourceHandle: 'source-edge-switch-b-ecs',
      targetHandle: 'target-edge-switch-b-ecs',
    }]);
  });

  it('端点分配不受节点和边输入顺序影响', () => {
    const ordered = toFlowNodes([switchA, switchB, ecs], [edgeA, edgeB]);
    const reordered = toFlowNodes([ecs, switchB, switchA], [edgeB, edgeA]);

    expect(reordered.find((node) => node.id === 'ecs-1')?.data.targetPorts)
      .toEqual(ordered.find((node) => node.id === 'ecs-1')?.data.targetPorts);
  });

  it('忽略指向不存在节点的边，不为已知节点生成端点', () => {
    const nodes = [switchA, ecs];
    const edges: TemplateEdge[] = [{
      ...edgeA,
      toNodeId: 'switch-missing',
    }];

    expect(toFlowNodes(nodes, edges).map(({ data }) => ({
      sourcePorts: data.sourcePorts,
      targetPorts: data.targetPorts,
    }))).toEqual([{
      sourcePorts: [],
      targetPorts: [],
    }, {
      sourcePorts: [],
      targetPorts: [],
    }]);
    expect(toFlowEdges(nodes, edges)).toEqual([]);
  });

  it('将 router、switch 和 ecs 映射到各自的 Flow 节点类型，并保留领域节点字段与负坐标', () => {
    const nodes: TemplateNode[] = [{
      id: 'router-1',
      kind: 'router',
      label: '主路由器',
      position: { x: -480, y: 180 },
      routeRole: 'core',
      egressType: 'internet',
      bindEip: true,
    }, {
      id: 'switch-dmz',
      kind: 'switch',
      label: 'DMZ 交换机',
      position: { x: -240, y: 180 },
      zoneKey: 'dmz',
      cidr: '10.70.10.0/24',
      purpose: 'dmz',
      aclRules: [],
      nat: { snatEnabled: false, dnatMappings: [] },
    }, {
      id: 'ecs-web',
      kind: 'ecs',
      label: 'Web ECS',
      position: { x: 120, y: 420 },
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

    const flowNodes = toFlowNodes(nodes);

    expect(flowNodes.map((node) => node.type)).toEqual([
      'topology-router',
      'topology-switch',
      'topology-ecs',
    ]);
    expect(flowNodes[0]).toMatchObject({
      id: 'router-1',
      type: 'topology-router',
      position: { x: -480, y: 180 },
      data: { topologyNode: nodes[0] },
    });
    expect(flowNodes[1]).toMatchObject({
      id: 'switch-dmz',
      type: 'topology-switch',
      position: { x: -240, y: 180 },
      data: { topologyNode: nodes[1] },
    });
    expect(flowNodes[2]).toMatchObject({
      id: 'ecs-web',
      type: 'topology-ecs',
      position: { x: 120, y: 420 },
      data: { topologyNode: nodes[2] },
    });
    expect(fromFlowNodes(flowNodes)).toEqual(nodes);
  });

  it('为没有 position 的旧节点提供默认位置', () => {
    const nodes: TemplateNode[] = [{
      id: 'router-legacy',
      kind: 'router',
      label: '旧版主路由器',
      routeRole: 'core',
      egressType: 'internet',
      bindEip: false,
    }];

    expect(toFlowNodes(nodes)[0]?.position).toEqual({ x: 120, y: 180 });
  });

  it('只转换显式边，不推导额外关系', () => {
    const edges: TemplateEdge[] = [{
      id: 'edge-router-dmz',
      fromNodeId: 'router-1',
      toNodeId: 'switch-dmz',
      relationType: 'manual',
      label: 'router -> dmz',
    }];
    const nodes: TemplateNode[] = [{
      id: 'router-1',
      kind: 'router',
      label: '主路由器',
      routeRole: 'core',
      egressType: 'internet',
      bindEip: true,
    }, {
      id: 'switch-dmz',
      kind: 'switch',
      label: 'DMZ 交换机',
      zoneKey: 'dmz',
      cidr: '10.70.10.0/24',
      purpose: 'dmz',
      aclRules: [],
      nat: { snatEnabled: false, dnatMappings: [] },
    }];

    expect(toFlowEdges(nodes, edges)).toMatchObject([{
      id: 'edge-router-dmz',
      source: 'router-1',
      sourceHandle: 'source-edge-router-dmz',
      target: 'switch-dmz',
      targetHandle: 'target-edge-router-dmz',
      type: 'bezier',
      data: { topologyEdge: edges[0] },
    }]);
    expect(toFlowEdges(nodes, edges)[0]?.data.topologyEdge.label).toBe('router -> dmz');
  });

  it('只接受有限数值视口，并兼容无视口旧图', () => {
    expect(readTopologyViewport({ x: -120.5, y: 88, zoom: 1.25 })).toEqual({
      x: -120.5, y: 88, zoom: 1.25,
    });
    expect(readTopologyViewport({ x: 'bad', y: 88, zoom: 1.25 })).toBeNull();
    expect(readTopologyViewport(null)).toBeNull();
    expect(readTopologyViewport(undefined)).toBeNull();
    expect(readTopologyViewport({ x: Number.NaN, y: 88, zoom: 1.25 })).toBeNull();
    expect(readTopologyViewport({ x: Infinity, y: 88, zoom: 1.25 })).toBeNull();
    expect(readTopologyViewport({ x: -Infinity, y: 88, zoom: 1.25 })).toBeNull();
    expect(readTopologyViewport({ x: 40, y: Number.NaN, zoom: 1.25 })).toBeNull();
    expect(readTopologyViewport({ x: 40, y: Infinity, zoom: 1.25 })).toBeNull();
    expect(readTopologyViewport({ x: 40, y: -Infinity, zoom: 1.25 })).toBeNull();
    expect(readTopologyViewport({ x: 40, y: 88, zoom: Number.NaN })).toBeNull();
    expect(readTopologyViewport({ x: 40, y: 88, zoom: Infinity })).toBeNull();
    expect(readTopologyViewport({ x: 40, y: 88, zoom: -Infinity })).toBeNull();
    expect(readTopologyViewport({ x: 40, y: 88, zoom: 0 })).toBeNull();
    expect(readTopologyViewport({ x: 40, y: 88, zoom: -0.5 })).toBeNull();
    expect(writeTopologyViewport({ schemaVersion: '2.0.0', nodes: [], edges: [] }, {
      x: 40, y: -20, zoom: 0.8,
    })).toMatchObject({ viewport: { x: 40, y: -20, zoom: 0.8 } });
  });
});
