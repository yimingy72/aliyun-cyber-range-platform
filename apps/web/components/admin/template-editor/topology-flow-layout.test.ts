import { describe, expect, it } from 'vitest';

import type { TemplateEdge } from './template-editor-screen';
import { layoutTopology } from './topology-flow-layout';
import type { TemplateNode } from '../../../lib/scenario-graph';

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
});
