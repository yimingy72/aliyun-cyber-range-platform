import { describe, expect, it } from 'vitest';

import {
  createTopologyHistory,
  pushTopologySnapshot,
  redoTopology,
  undoTopology,
} from './topology-flow-history';
import type { TopologySnapshot } from './topology-flow-types';

const first: TopologySnapshot = {
  nodes: [{
    id: 'router-1',
    kind: 'router',
    label: '主路由器',
    routeRole: 'core',
    egressType: 'internet',
    bindEip: true,
  }],
  edges: [],
  viewport: null,
};

const second: TopologySnapshot = {
  ...first,
  nodes: [{
    ...first.nodes[0],
    position: { x: 120, y: 80 },
  }],
};

const third: TopologySnapshot = {
  ...first,
  nodes: [{
    ...first.nodes[0],
    position: { x: 280, y: 160 },
  }],
};

function createMutableSnapshot(): TopologySnapshot {
  return {
    nodes: [{
      id: 'switch-dmz',
      kind: 'switch',
      label: 'DMZ 交换机',
      zoneKey: 'dmz',
      cidr: '10.70.10.0/24',
      purpose: 'dmz',
      aclRules: [{
        key: 'allow-web',
        direction: 'inbound',
        protocol: 'tcp',
        portRange: '80/80',
        sourceCidr: '0.0.0.0/0',
        policy: 'allow',
        priority: 1,
        description: '初始 ACL',
      }],
      nat: {
        snatEnabled: true,
        dnatMappings: [{
          key: 'web-80',
          targetHostId: 'ecs-web',
          externalPort: 80,
          internalPort: 80,
          protocol: 'tcp',
          description: '初始 DNAT',
        }],
      },
    }],
    edges: [{
      id: 'switch-web',
      fromNodeId: 'switch-dmz',
      toNodeId: 'ecs-web',
      relationType: 'manual',
      label: '初始连线',
    }],
    viewport: { x: 40, y: -20, zoom: 0.8 },
  };
}

function readSwitch(snapshot: TopologySnapshot) {
  const node = snapshot.nodes[0];

  if (!node || node.kind !== 'switch') {
    throw new Error('预期快照首个节点为交换机');
  }

  return node;
}

describe('topology flow history', () => {
  it('记录完成动作，支持撤销和重做，并在新动作后清空重做分支', () => {
    const initial = createTopologyHistory(first);
    const moved = pushTopologySnapshot(initial, second);
    const undone = undoTopology(moved);
    const redone = redoTopology(undone);
    const branched = pushTopologySnapshot(undone, third);

    expect(moved).toEqual({
      past: [first],
      present: second,
      future: [],
    });
    expect(undone).toEqual({
      past: [],
      present: first,
      future: [second],
    });
    expect(redone).toEqual({
      past: [first],
      present: second,
      future: [],
    });
    expect(branched).toEqual({
      past: [first],
      present: third,
      future: [],
    });
  });

  it('在历史边界深克隆嵌套快照，并让撤销和重做返回相互隔离的状态', () => {
    const initial = createMutableSnapshot();
    const moved = structuredClone(initial);
    readSwitch(moved).position = { x: 240, y: 160 };

    const history = pushTopologySnapshot(createTopologyHistory(initial), moved);
    readSwitch(initial).nat?.dnatMappings.push({
      key: 'external-mutation',
      targetHostId: 'ecs-external',
      externalPort: 8080,
      internalPort: 8080,
      protocol: 'tcp',
    });
    initial.edges[0]!.label = '外部修改的初始连线';
    readSwitch(moved).aclRules?.push({
      key: 'external-acl',
      direction: 'inbound',
      protocol: 'tcp',
      portRange: '443/443',
      sourceCidr: '0.0.0.0/0',
      policy: 'allow',
      priority: 1,
    });
    moved.edges[0]!.label = '外部修改的移动连线';

    expect(readSwitch(history.past[0]!).nat?.dnatMappings).toHaveLength(1);
    expect(history.past[0]!.edges[0]!.label).toBe('初始连线');
    expect(readSwitch(history.present).aclRules).toHaveLength(1);
    expect(history.present.edges[0]!.label).toBe('初始连线');

    const undone = undoTopology(history);
    readSwitch(undone.present).nat?.dnatMappings.push({
      key: 'undo-mutation',
      targetHostId: 'ecs-undo',
      externalPort: 8081,
      internalPort: 8081,
      protocol: 'tcp',
    });

    expect(readSwitch(history.past[0]!).nat?.dnatMappings).toHaveLength(1);
    expect(readSwitch(undone.future[0]!).nat?.dnatMappings).toHaveLength(1);

    const redone = redoTopology(undone);
    readSwitch(redone.present).aclRules?.push({
      key: 'redo-mutation',
      direction: 'inbound',
      protocol: 'tcp',
      portRange: '22/22',
      sourceCidr: '0.0.0.0/0',
      policy: 'allow',
      priority: 1,
    });

    expect(readSwitch(undone.future[0]!).aclRules).toHaveLength(1);
    expect(readSwitch(redone.past[0]!).nat?.dnatMappings).toHaveLength(2);
  });
});
