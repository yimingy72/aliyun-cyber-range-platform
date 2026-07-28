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
  it('保留领域节点字段与负坐标', () => {
    const nodes: TemplateNode[] = [{
      id: 'switch-dmz',
      kind: 'switch',
      label: 'DMZ 交换机',
      position: { x: -240, y: 180 },
      zoneKey: 'dmz',
      cidr: '10.70.10.0/24',
      purpose: 'dmz',
      aclRules: [],
      nat: { snatEnabled: false, dnatMappings: [] },
    }];

    const flowNodes = toFlowNodes(nodes);

    expect(flowNodes[0]).toMatchObject({
      id: 'switch-dmz',
      type: 'topology-switch',
      position: { x: -240, y: 180 },
      data: { topologyNode: nodes[0] },
    });
    expect(fromFlowNodes(flowNodes)).toEqual(nodes);
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
      data: { topologyEdge: edges[0] },
    }]);
  });

  it('只接受有限数值视口，并兼容无视口旧图', () => {
    expect(readTopologyViewport({ x: -120.5, y: 88, zoom: 1.25 })).toEqual({
      x: -120.5, y: 88, zoom: 1.25,
    });
    expect(readTopologyViewport({ x: 'bad', y: 88, zoom: 1.25 })).toBeNull();
    expect(writeTopologyViewport({ schemaVersion: '2.0.0', nodes: [], edges: [] }, {
      x: 40, y: -20, zoom: 0.8,
    })).toMatchObject({ viewport: { x: 40, y: -20, zoom: 0.8 } });
  });
});
