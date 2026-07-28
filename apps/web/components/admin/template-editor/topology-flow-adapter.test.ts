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

describe('topology flow adapter', () => {
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

    expect(toFlowEdges(edges)).toMatchObject([{
      id: 'edge-router-dmz',
      source: 'router-1',
      target: 'switch-dmz',
      type: 'smoothstep',
      data: { topologyEdge: edges[0] },
    }]);
    expect(toFlowEdges(edges)[0]?.data.topologyEdge.label).toBe('router -> dmz');
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
