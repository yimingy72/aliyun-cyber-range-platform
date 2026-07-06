import { describe, expect, it } from 'vitest';

import type { ScenarioGraphEdge, TemplateNode } from './scenario-graph';
import { normalizeManualEdgePair, validateManualEdge } from './scenario-graph-linking';

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
